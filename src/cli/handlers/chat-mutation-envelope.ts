import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime/types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { readCallerHintFromEnv } from '../../shared/public-rpc/caller-hint'
import {
  ChatHistoryResultSchema,
  ChatMutationResultSchema,
  ChatPendingRequestSchema,
  ChatRequestsPieceSchema,
  ChatStatusSnapshotSchema,
  type ChatPendingRequest,
  type ChatStatusSession
} from '../../shared/public-rpc/public-methods/chat'
import type { MutationEnvelope } from '../../shared/rpc-contract/structured-agent-session-params'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../shared/structured-agent-session-mutation'

export type MutationEnvelopeValue = z.infer<typeof MutationEnvelope>
export type ChatClient = Pick<RuntimeClient, 'call' | 'stream' | 'isRemote'>

/**
 * The envelope every mutating `agentSession.*` call carries.
 *
 * `fields` are the call's params without the envelope, exactly as the host digests them for
 * `method`; the host recomputes the fingerprint over `{method, sessionId, fields}` with sorted keys
 * and refuses the call when it differs. The operation id embeds a fresh random UUID behind the
 * timestamp prefix the host's operation ledger requires, so each call is its own operation.
 */
export function buildMutationEnvelope(input: {
  method: string
  sessionId: string
  fields: Record<string, unknown>
  expectedRuntimeFence: number | null
  randomUuid?: () => string
  now?: number
}): MutationEnvelopeValue {
  return {
    sessionId: input.sessionId,
    clientOperationId: createStructuredAgentSessionOperationId(
      input.randomUuid ?? randomUUID,
      input.now
    ),
    expectedRuntimeFence: input.expectedRuntimeFence,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: input.method,
      sessionId: input.sessionId,
      fields: input.fields
    })
  }
}

/** Options that opt a call into the public contract and attribute it to the calling agent. */
export function publicCallOptions(confirm?: boolean) {
  const hint = readCallerHintFromEnv(process.env)
  return {
    publicContract: true as const,
    ...(confirm === undefined ? {} : { confirm }),
    ...(Object.keys(hint).length > 0 ? { caller: hint } : {})
  }
}

/** The fence and journal epoch a write is fenced against, read from the newest history page. */
export async function readCheckpoint(
  client: ChatClient,
  sessionId: string
): Promise<{ fence: number | null; epoch: string | null }> {
  const response = await client.call<unknown>(
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 },
    publicCallOptions()
  )
  const parsed = ChatHistoryResultSchema.safeParse(response.result)
  if (!parsed.success) {
    return { fence: null, epoch: null }
  }
  const fence = parsed.data.page.fence ?? parsed.data.fence
  return { fence: fence !== undefined && fence > 0 ? fence : null, epoch: parsed.data.page.epoch }
}

type ChatHistoryItem = z.infer<typeof ChatHistoryResultSchema>['page']['items'][number]

const TURN_LOOKUP_PAGE_SIZE = 50

async function readTailItems(client: ChatClient, sessionId: string): Promise<ChatHistoryItem[]> {
  const response = await client.call<unknown>(
    'agentSession.history',
    { sessionId, direction: 'tail', limit: TURN_LOOKUP_PAGE_SIZE },
    publicCallOptions()
  )
  const parsed = ChatHistoryResultSchema.safeParse(response.result)
  return parsed.success ? parsed.data.page.items : []
}

function turnRecord(item: ChatHistoryItem) {
  const { body } = item
  const record = body.kind === 'turn' ? body : body.turnLifecycle
  return record?.turnId === undefined
    ? null
    : { itemId: item.itemId, turnId: record.turnId, userItemId: record.userItemId }
}

/** The ids of the turns the newest journal rows record; a session with no turn yet has none. */
export async function readRecentTurnIds(
  client: ChatClient,
  sessionId: string
): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const item of await readTailItems(client, sessionId)) {
    const record = turnRecord(item)
    if (record) {
      ids.add(record.turnId)
    }
  }
  return ids
}

/**
 * The turn that answers a message, from the journal rows: the turn record that names the message
 * as its opener, or the turn the message row is scoped to (a steer joins the running turn). Null
 * until the host has opened that turn.
 */
function turnIdOfMessage(
  items: readonly ChatHistoryItem[],
  clientMessageId: string
): string | null {
  const messageKey = agentJournalSubmissionKey(clientMessageId)
  const records = items.flatMap((item) => turnRecord(item) ?? [])
  const opened = records.find((record) => record.userItemId === messageKey)
  if (opened) {
    return opened.turnId
  }
  const scope = items.find((item) => item.itemId === messageKey)?.turnScope
  return scope?.kind === 'turn'
    ? (records.find((record) => record.itemId === scope.turnItemId)?.turnId ?? null)
    : null
}

/**
 * Polls the journal until the turn that answers `clientMessageId` exists, `budgetMs` elapses or
 * `stopped` reports true. The host accepts a send before it opens the turn, so the send result
 * cannot carry the turn id. Null when none appeared: a read that fails counts as not yet, because
 * the message is already accepted and must not be sent again.
 */
export async function awaitMessageTurnId(
  client: ChatClient,
  sessionId: string,
  clientMessageId: string,
  options: { budgetMs: number; intervalMs: number; stopped?: () => boolean }
): Promise<string | null> {
  const deadline = Date.now() + options.budgetMs
  for (;;) {
    const turnId = await readTailItems(client, sessionId).then(
      (items) => turnIdOfMessage(items, clientMessageId),
      () => null
    )
    if (
      turnId !== null ||
      options.stopped?.() === true ||
      Date.now() + options.intervalMs > deadline
    ) {
      return turnId
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs))
  }
}

/**
 * Decides which turn events belong to one send. A turn it opened is matched by id once the journal
 * names it; until then any turn that was not already in the journal before the send may be it, so
 * a fast turn cannot finish unmatched. A refused send settles under its own message key.
 */
export function createSendTurnTracker(
  client: ChatClient,
  sessionId: string,
  options: { priorTurnIds: ReadonlySet<string>; budgetMs: number; intervalMs: number }
) {
  const turnIds = new Set<string>()
  let turnId: string | null = null
  let finished = false
  return {
    get turnId() {
      return turnId
    },
    /** True when an event naming `eventTurnId` settles this send; an event naming none always does. */
    accepts(eventTurnId: string | undefined): boolean {
      return (
        eventTurnId === undefined ||
        turnIds.has(eventTurnId) ||
        (turnId === null && !options.priorTurnIds.has(eventTurnId))
      )
    },
    /** Starts looking for the turn of the accepted message; stops at `finish`. */
    accepted(clientMessageId: string): void {
      turnIds.add(agentJournalSubmissionKey(clientMessageId))
      void awaitMessageTurnId(client, sessionId, clientMessageId, {
        budgetMs: options.budgetMs,
        intervalMs: options.intervalMs,
        stopped: () => finished
      }).then((found) => {
        if (found !== null) {
          turnId = found
          turnIds.add(found)
        }
      })
    },
    finish(): void {
      finished = true
    }
  }
}

const REFUSAL_CODE_TO_ERROR: Readonly<Record<string, string>> = {
  agent_session_checkpoint_stale: 'conflict',
  agent_session_conflict: 'conflict',
  agent_session_operation_conflict: 'conflict',
  agent_session_item_revision_stale: 'conflict',
  agent_session_already_resolved: 'conflict',
  execution_owner_reconciling: 'conflict',
  structured_agent_session_unsupported: 'unavailable',
  agent_session_ownership_unknown: 'unavailable',
  agent_session_journal_unreadable: 'unavailable',
  agent_session_owner_restart_failed: 'unavailable',
  agent_session_operation_capacity: 'unavailable',
  agent_session_operation_unknown: 'unavailable',
  agent_session_identity_required: 'unauthorized'
}

function refusalError(
  refusal: { code: string; message?: string; details?: { reason?: string } },
  sessionId: string
): RuntimeClientError {
  const code = Object.hasOwn(REFUSAL_CODE_TO_ERROR, refusal.code)
    ? REFUSAL_CODE_TO_ERROR[refusal.code]
    : refusal.code
  const next =
    code === 'conflict'
      ? [{ command: 'quirky chat list', why: `check ${sessionId} status, then retry` }]
      : code === 'unavailable'
        ? [{ command: 'quirky status', why: 'check that the Quirky runtime is up' }]
        : []
  return new RuntimeClientError(code, refusal.message ?? refusal.code, {
    reason: refusal.details?.reason ?? refusal.code,
    ...(next.length > 0 ? { next } : {})
  })
}

/**
 * Sends one fenced mutation and returns the settled value. A host refusal becomes a
 * `RuntimeClientError` with a stable code; a result that is not the host's `{ok, value}` wrapper is
 * returned as the value, so a server that unwraps it still works.
 */
export async function mutateSession(
  client: ChatClient,
  args: {
    method: string
    fingerprintMethod?: string
    sessionId: string
    fields: Record<string, unknown>
    /** Omitted: read from the session's newest history page. Null: the create-only "no session yet". */
    fence?: number | null
    confirm?: boolean
  }
): Promise<{ response: RuntimeRpcSuccess<unknown>; value: unknown }> {
  const envelope = buildMutationEnvelope({
    method: args.fingerprintMethod ?? args.method,
    sessionId: args.sessionId,
    fields: args.fields,
    expectedRuntimeFence:
      args.fence === undefined ? (await readCheckpoint(client, args.sessionId)).fence : args.fence
  })
  const response = await client.call<unknown>(
    args.method,
    { envelope, ...args.fields },
    publicCallOptions(args.confirm)
  )
  const parsed = ChatMutationResultSchema.safeParse(response.result)
  if (!parsed.success) {
    return { response, value: response.result }
  }
  if (!parsed.data.ok) {
    throw refusalError(parsed.data.refusal, args.sessionId)
  }
  return { response, value: parsed.data.value }
}

const STATUS_SNAPSHOT_TIMEOUT_MS = 10_000
const MAX_REQUEST_PAGES = 50
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

function invalidRuntimeResponse(message: string, reason: string): RuntimeClientError {
  return new RuntimeClientError('invalid_runtime_response', message, { reason })
}

/**
 * The sessions in the host's status snapshot; the stream is closed after its first frame. A
 * malformed snapshot or no snapshot within the timeout rejects instead of leaving the stream open.
 */
export async function readStatusSessions(client: ChatClient): Promise<ChatStatusSession[]> {
  const stop = new AbortController()
  const seen: { sessions?: ChatStatusSession[] } = {}
  let fail: (error: RuntimeClientError) => void = () => {}
  const failed = new Promise<never>((_resolve, reject) => {
    fail = (error) => {
      stop.abort()
      reject(error)
    }
  })
  const timer = setTimeout(() => {
    fail(
      new RuntimeClientError('timeout', 'The host did not send a chat status snapshot in time.', {
        reason: 'status_snapshot_timeout',
        next: [{ command: 'quirky status', why: 'check that the Quirky runtime is up' }]
      })
    )
  }, STATUS_SNAPSHOT_TIMEOUT_MS)
  try {
    await Promise.race([
      client.stream(
        'agentSession.subscribeStatus',
        {},
        (frame) => {
          if (seen.sessions !== undefined) {
            return
          }
          const parsed = ChatStatusSnapshotSchema.safeParse(frame)
          if (parsed.success) {
            seen.sessions = parsed.data.sessions
            clearTimeout(timer)
            stop.abort()
            return
          }
          // other frame types are not snapshots and are skipped
          if (isSnapshotFrame(frame)) {
            fail(
              invalidRuntimeResponse(
                'The host sent a malformed chat status snapshot.',
                'invalid_status_snapshot'
              )
            )
          }
        },
        { signal: stop.signal, ...publicCallOptions() }
      ),
      failed
    ])
  } finally {
    clearTimeout(timer)
  }
  if (seen.sessions === undefined) {
    throw new RuntimeClientError(
      'unavailable',
      'The host closed the chat status stream before sending a snapshot.',
      {
        reason: 'no_status_snapshot',
        next: [{ command: 'quirky status', why: 'check that the Quirky runtime is up' }]
      }
    )
  }
  return seen.sessions
}

function isSnapshotFrame(frame: unknown): boolean {
  return typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'snapshot'
}

/**
 * The approvals and questions a session is waiting on, reassembled from the host's pieces. Pieces
 * must advance their cursor and stay within a page and size budget, so a faulty host cannot keep
 * the read going.
 */
export async function readPendingRequests(
  client: ChatClient,
  sessionId: string
): Promise<ChatPendingRequest[]> {
  // an unknown version restarts at the host's live one, so the first read is expected to restart
  let version: string = randomUUID()
  let pages = 0
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let json = ''
    let bytes = 0
    let cursor: number | undefined
    for (;;) {
      pages += 1
      if (pages > MAX_REQUEST_PAGES) {
        throw invalidRuntimeResponse(
          `The pending requests of ${sessionId} spanned more than ${MAX_REQUEST_PAGES} pages.`,
          'requests_too_many_pages'
        )
      }
      const response = await client.call<unknown>(
        'agentSession.currentRequests',
        { sessionId, version, ...(cursor === undefined ? {} : { cursor }) },
        publicCallOptions()
      )
      const parsedPiece = ChatRequestsPieceSchema.safeParse(response.result)
      if (!parsedPiece.success) {
        throw invalidRuntimeResponse(
          'The host sent a malformed page of pending requests.',
          'invalid_requests_page'
        )
      }
      const piece = parsedPiece.data
      if (piece.restart) {
        version = piece.marker.version
        break
      }
      bytes += Buffer.byteLength(piece.json)
      if (bytes > MAX_REQUEST_BYTES) {
        throw invalidRuntimeResponse(
          `The pending requests of ${sessionId} exceeded ${MAX_REQUEST_BYTES} bytes.`,
          'requests_too_large'
        )
      }
      json += piece.json
      if (piece.nextCursor === null) {
        return parsePendingRequests(json)
      }
      if (cursor !== undefined && piece.nextCursor <= cursor) {
        throw invalidRuntimeResponse(
          'The host sent a pending-requests cursor that did not advance.',
          'requests_cursor_stalled'
        )
      }
      cursor = piece.nextCursor
    }
  }
  throw new RuntimeClientError(
    'unavailable',
    `The pending requests of ${sessionId} kept changing while they were read.`,
    {
      reason: 'requests_unstable',
      next: [{ command: `quirky chat requests ${sessionId}`, why: 'read them again' }]
    }
  )
}

function parsePendingRequests(json: string): ChatPendingRequest[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw invalidRuntimeResponse(
      'The host sent pending requests that are not valid JSON.',
      'invalid_requests_json'
    )
  }
  const parsed = z.array(ChatPendingRequestSchema).safeParse(raw)
  if (!parsed.success) {
    throw invalidRuntimeResponse(
      'The host sent malformed pending requests.',
      'invalid_requests_json'
    )
  }
  return parsed.data
}

export type PromptChoice = { decision: 'allow' | 'deny' } | { option: string } | { answer: string }

function optionIds(options: readonly { id: string }[]): string {
  return options.map((option) => option.id).join(', ') || 'none'
}

const DECISION_IDS = { allow: ['allow', 'accept'], deny: ['deny', 'decline'] }

/** The respond method and params for a pending request, or an invalid_argument naming what it offers. */
export function buildPromptResponse(request: ChatPendingRequest, choice: PromptChoice) {
  const { body } = request
  const target = { itemId: request.itemId, expectedRevision: request.revision }
  if (body.kind === 'approval') {
    if ('answer' in choice) {
      throw invalid(
        `${request.itemId} is a permission request; use --allow, --deny or --option <id>.`
      )
    }
    const { options } = body
    const picked =
      'option' in choice
        ? options.find((option) => option.id === choice.option)
        : options.find((option) => DECISION_IDS[choice.decision].includes(option.id))
    if (!picked) {
      throw invalid(
        `${request.itemId} has no such option; choose one with --option <id>: ${optionIds(options)}.`
      )
    }
    return { method: 'agentSession.respondToApproval', fields: { ...target, optionId: picked.id } }
  }
  if (body.kind !== 'question' || 'decision' in choice) {
    throw invalid(`${request.itemId} is a ${body.kind}; use --option <id> or --answer <text>.`)
  }
  const grouped = body.questions
  if (grouped !== undefined && grouped.length !== 1) {
    throw invalid(
      `${request.itemId} asks ${grouped.length} questions; answer it with \`quirky rpc agentSession.respondToQuestion\`.`
    )
  }
  const question = grouped?.[0] ?? {
    id: body.freeTextQuestionId ?? 'q1',
    options: body.options,
    freeTextQuestionId: body.freeTextQuestionId
  }
  const method = 'agentSession.respondToQuestion'
  if ('answer' in choice) {
    if (question.freeTextQuestionId === undefined) {
      throw invalid(
        `${request.itemId} takes only its listed options; use --option <id>: ${optionIds(question.options)}.`
      )
    }
    const answers = [
      { questionId: question.freeTextQuestionId, optionIds: [], other: choice.answer }
    ]
    return { method, fields: { ...target, answers } }
  }
  if (!question.options.some((option) => option.id === choice.option)) {
    throw invalid(
      `--option ${choice.option} is not an option of ${request.itemId}: ${optionIds(question.options)}.`
    )
  }
  return {
    method,
    fields:
      grouped === undefined
        ? { ...target, optionId: choice.option }
        : { ...target, answers: [{ questionId: question.id, optionIds: [choice.option] }] }
  }
}

export function invalid(message: string, data?: unknown): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message, data)
}
