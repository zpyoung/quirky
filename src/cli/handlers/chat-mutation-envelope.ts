import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime/types'
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

/** The sessions in the host's status snapshot; the stream is closed after its first frame. */
export async function readStatusSessions(client: ChatClient): Promise<ChatStatusSession[]> {
  const stop = new AbortController()
  const seen: { sessions?: ChatStatusSession[] } = {}
  await client.stream(
    'agentSession.subscribeStatus',
    {},
    (frame) => {
      const parsed = ChatStatusSnapshotSchema.safeParse(frame)
      if (seen.sessions === undefined && parsed.success) {
        seen.sessions = parsed.data.sessions
        stop.abort()
      }
    },
    { signal: stop.signal, ...publicCallOptions() }
  )
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

/** The approvals and questions a session is waiting on, reassembled from the host's pieces. */
export async function readPendingRequests(
  client: ChatClient,
  sessionId: string
): Promise<ChatPendingRequest[]> {
  // an unknown version restarts at the host's live one, so the first read is expected to restart
  let version: string = randomUUID()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let json = ''
    let cursor: number | undefined
    for (;;) {
      const response = await client.call<unknown>(
        'agentSession.currentRequests',
        { sessionId, version, ...(cursor === undefined ? {} : { cursor }) },
        publicCallOptions()
      )
      const piece = ChatRequestsPieceSchema.parse(response.result)
      if (piece.restart) {
        version = piece.marker.version
        break
      }
      json += piece.json
      if (piece.nextCursor === null) {
        return z.array(ChatPendingRequestSchema).parse(JSON.parse(json))
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
