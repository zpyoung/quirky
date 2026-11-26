import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import {
  CancelParams,
  ConversationCommandParams,
  CreateIntentParams,
  RespondParams,
  RespondToQuestionParams,
  RewindParams,
  SendParams,
  SetOptionParams
} from '../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import { CHAT_HANDLERS } from './chat'

const SESSION = 'claude_0b1c2d3e_4f5a_4b6c_8d7e_9f0a1b2c3d4e'
const OTHER_SESSION = 'codex_11112222_3333_4444_5555_666677778888'
const FENCE = 7
const EPOCH = 'epoch-1'

type Handlers = Record<string, (params: Record<string, unknown>) => unknown>
type StreamFn = (
  method: string,
  params: unknown,
  onFrame: (frame: unknown) => void,
  options?: { signal?: AbortSignal }
) => Promise<void>

function mutationOk(value: unknown) {
  return { ok: true, replayed: false, fence: FENCE, cursor: { epoch: EPOCH, sequence: 1 }, value }
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function fakeClient(options: { remote?: boolean; handlers?: Handlers; stream?: StreamFn } = {}) {
  const handlers: Handlers = {
    'agentSession.history': () => ({
      ok: true,
      page: { epoch: EPOCH, fence: FENCE, items: [], hasOlder: false, window: {} }
    }),
    ...options.handlers
  }
  const call = vi.fn(async (method: string, params?: unknown, _options?: unknown) => {
    const handler = handlers[method]
    if (!handler) {
      throw new Error(`unexpected call to ${method}`)
    }
    const record = typeof params === 'object' && params !== null ? { ...params } : {}
    return { id: 'req-1', ok: true as const, result: handler(record), _meta: { runtimeId: 'rt-1' } }
  })
  const stream = vi.fn<StreamFn>(options.stream ?? (async () => {}))
  return { isRemote: options.remote ?? false, call, stream }
}

function context(
  client: ReturnType<typeof fakeClient>,
  flags: Record<string, string | boolean>,
  json = true
): HandlerContext {
  // SAFETY: the handlers read only flags, cwd, json and the client calls this fake implements
  return {
    flags: new Map(Object.entries(flags)),
    client,
    cwd: '/',
    json
  } as unknown as HandlerContext
}

function callsTo(client: ReturnType<typeof fakeClient>, method: string) {
  return client.call.mock.calls.filter(([name]) => name === method)
}

function lastParams(
  client: ReturnType<typeof fakeClient>,
  method: string
): Record<string, unknown> {
  const [params] = callsTo(client, method).at(-1)?.slice(1) ?? []
  if (typeof params !== 'object' || params === null) {
    throw new Error(`${method} was not called with params`)
  }
  return { ...params }
}

function lastOptions(client: ReturnType<typeof fakeClient>, method: string): unknown {
  return callsTo(client, method).at(-1)?.[2]
}

function expectValid(schema: z.ZodType, params: unknown) {
  const parsed = schema.safeParse(params)
  expect(parsed.error?.issues ?? []).toEqual([])
}

function approvalRequest(itemId: string, options: { id: string; label: string }[]) {
  return {
    itemId,
    revision: 3,
    body: { kind: 'approval', title: 'Run rm -rf build', detail: null, options }
  }
}

const CLAUDE_APPROVAL = approvalRequest('item-1', [
  { id: 'allow', label: 'Allow' },
  { id: 'allowForSession', label: 'Allow for this session' },
  { id: 'deny', label: 'Deny' }
])

const CODEX_APPROVAL = approvalRequest('item-2', [
  { id: 'accept', label: 'Accept' },
  { id: 'acceptForSession', label: 'Accept for this session' },
  { id: 'decline', label: 'Decline' },
  { id: 'cancel', label: 'Cancel' }
])

const SINGLE_QUESTION = {
  itemId: 'item-3',
  revision: 2,
  body: {
    kind: 'question',
    question: 'Which database?',
    options: [
      { id: 'pg', label: 'Postgres' },
      { id: 'sqlite', label: 'SQLite' }
    ],
    freeTextQuestionId: 'db'
  }
}

const CHOICE_ONLY_QUESTION = {
  itemId: 'item-4',
  revision: 5,
  body: {
    kind: 'question',
    question: 'Proceed?',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' }
    ]
  }
}

const GROUPED_QUESTION = {
  itemId: 'item-5',
  revision: 1,
  body: {
    kind: 'question',
    question: 'Two things',
    options: [],
    questions: [
      { id: 'a', question: 'First?', options: [{ id: 'a1', label: 'One' }] },
      { id: 'b', question: 'Second?', options: [{ id: 'b1', label: 'Two' }] }
    ]
  }
}

const PENDING = [
  CLAUDE_APPROVAL,
  CODEX_APPROVAL,
  SINGLE_QUESTION,
  CHOICE_ONLY_QUESTION,
  GROUPED_QUESTION
]

/** Answers like the host: an unknown version restarts at the live marker, which is then read. */
function currentRequests(items: unknown[]): Handlers[string] {
  return (params) =>
    params.version === 'marker-1'
      ? { marker: { version: 'marker-1' }, json: JSON.stringify(items), nextCursor: null }
      : { marker: { version: 'marker-1' }, json: '', nextCursor: 0, restart: true }
}

function respondingClient(
  extra: Handlers = {},
  options: { remote?: boolean } = {}
): ReturnType<typeof fakeClient> {
  return fakeClient({
    ...options,
    handlers: {
      'agentSession.currentRequests': currentRequests(PENDING),
      'agentSession.respondToApproval': () =>
        mutationOk({
          itemId: 'item-1',
          revision: 4,
          resolution: { state: 'resolved', selectedOptionId: 'allow' }
        }),
      'agentSession.respondToQuestion': () =>
        mutationOk({
          itemId: 'item-3',
          revision: 3,
          resolution: { state: 'resolved', selectedOptionId: 'pg' }
        }),
      ...extra
    }
  })
}

let output: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  output = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

function printedResult(): Record<string, unknown> {
  const text = output.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
  const parsed: unknown = JSON.parse(text)
  const result =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'result') : null
  if (typeof result !== 'object' || result === null) {
    throw new Error(`no result printed: ${text}`)
  }
  return { ...result }
}

function printedText(): string {
  return output.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')
}

describe('chat respond', () => {
  async function respond(
    client: ReturnType<typeof fakeClient>,
    request: string,
    flags: Record<string, string | boolean>
  ) {
    await CHAT_HANDLERS['chat respond'](
      context(client, { session: SESSION, request, yes: true, ...flags })
    )
  }

  it('maps --allow to the allow option and reports the resolution', async () => {
    const client = respondingClient()
    await respond(client, 'item-1', { allow: true })

    const params = lastParams(client, 'agentSession.respondToApproval')
    expect(params).toMatchObject({ itemId: 'item-1', expectedRevision: 3, optionId: 'allow' })
    expectValid(RespondParams, params)
    expect(printedResult()).toMatchObject({
      sessionId: SESSION,
      requestId: 'item-1',
      status: 'resolved',
      selectedOptionId: 'allow'
    })
  })

  it('maps --deny to the deny option', async () => {
    const client = respondingClient()
    await respond(client, 'item-1', { deny: true })
    expect(lastParams(client, 'agentSession.respondToApproval')).toMatchObject({
      optionId: 'deny'
    })
  })

  it('maps --allow and --deny onto a Codex approval, never the for-session variant', async () => {
    const allowed = respondingClient()
    await respond(allowed, 'item-2', { allow: true })
    expect(lastParams(allowed, 'agentSession.respondToApproval')).toMatchObject({
      itemId: 'item-2',
      optionId: 'accept'
    })

    const denied = respondingClient()
    await respond(denied, 'item-2', { deny: true })
    expect(lastParams(denied, 'agentSession.respondToApproval')).toMatchObject({
      optionId: 'decline'
    })
  })

  it('takes --option on an approval only when the request offers it', async () => {
    const client = respondingClient()
    await respond(client, 'item-1', { option: 'allowForSession' })
    expect(lastParams(client, 'agentSession.respondToApproval')).toMatchObject({
      optionId: 'allowForSession'
    })
    await expect(respond(client, 'item-1', { option: 'maybe' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('carries the envelope, fingerprint and the public-contract options', async () => {
    const client = respondingClient()
    await respond(client, 'item-1', { allow: true })

    const params = lastParams(client, 'agentSession.respondToApproval')
    expect(params.envelope).toMatchObject({
      sessionId: SESSION,
      expectedRuntimeFence: FENCE,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.respondTo:approval',
        sessionId: SESSION,
        fields: { itemId: 'item-1', expectedRevision: 3, optionId: 'allow' }
      })
    })
    expect(lastOptions(client, 'agentSession.respondToApproval')).toMatchObject({
      publicContract: true,
      confirm: true
    })
  })

  it('answers a single question with its option id', async () => {
    const client = respondingClient()
    await respond(client, 'item-3', { option: 'pg' })

    const params = lastParams(client, 'agentSession.respondToQuestion')
    expect(params).toMatchObject({ itemId: 'item-3', expectedRevision: 2, optionId: 'pg' })
    expect(params).not.toHaveProperty('answers')
    expectValid(RespondToQuestionParams, params)
    expect(callsTo(client, 'agentSession.respondToApproval')).toHaveLength(0)
  })

  it('answers a free-text question through the question id the request names', async () => {
    const client = respondingClient()
    await respond(client, 'item-3', { answer: 'use postgres' })

    const params = lastParams(client, 'agentSession.respondToQuestion')
    expect(params).toMatchObject({
      itemId: 'item-3',
      answers: [{ questionId: 'db', optionIds: [], other: 'use postgres' }]
    })
    expect(params).not.toHaveProperty('optionId')
    expectValid(RespondToQuestionParams, params)
    expect(params.envelope).toMatchObject({
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.respondTo:question',
        sessionId: SESSION,
        fields: {
          itemId: 'item-3',
          expectedRevision: 2,
          answers: [{ questionId: 'db', optionIds: [], other: 'use postgres' }]
        }
      })
    })
  })

  it('refuses a typed answer to a question that takes only its listed options', async () => {
    const client = respondingClient()
    await expect(respond(client, 'item-4', { answer: 'maybe' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callsTo(client, 'agentSession.respondToQuestion')).toHaveLength(0)
  })

  it('wraps the chosen option of a one-question group as a structured answer', async () => {
    const grouped = {
      ...GROUPED_QUESTION,
      body: { ...GROUPED_QUESTION.body, questions: [GROUPED_QUESTION.body.questions[0]] }
    }
    const client = respondingClient({ 'agentSession.currentRequests': currentRequests([grouped]) })
    await respond(client, 'item-5', { option: 'a1' })
    expect(lastParams(client, 'agentSession.respondToQuestion')).toMatchObject({
      answers: [{ questionId: 'a', optionIds: ['a1'] }]
    })
  })

  it('sends a question with several parts to `quirky rpc` instead of guessing', async () => {
    const client = respondingClient()
    await expect(respond(client, 'item-5', { option: 'a1' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('refuses the wrong kind of answer for the request', async () => {
    const client = respondingClient()
    await expect(respond(client, 'item-1', { answer: 'ok' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(respond(client, 'item-3', { allow: true })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('answers not_found, pointing at help and the pending list, for an unknown request', async () => {
    const client = respondingClient()
    const failure = await respond(client, 'item-404', { allow: true }).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(RuntimeClientError)
    expect(failure).toMatchObject({
      code: 'not_found',
      data: {
        reason: 'request_not_found',
        next: [
          { command: 'quirky chat respond --help' },
          { command: `quirky chat requests ${SESSION}` }
        ]
      }
    })
    expect(callsTo(client, 'agentSession.respondToApproval')).toHaveLength(0)
  })

  it('reads a request list that arrives in several pieces', async () => {
    const json = JSON.stringify([CLAUDE_APPROVAL])
    const client = respondingClient({
      'agentSession.currentRequests': (params) => {
        if (params.version !== 'marker-1') {
          return { marker: { version: 'marker-1' }, json: '', nextCursor: 0, restart: true }
        }
        return params.cursor === undefined
          ? { marker: { version: 'marker-1' }, json: json.slice(0, 20), nextCursor: 20 }
          : { marker: { version: 'marker-1' }, json: json.slice(20), nextCursor: null }
      }
    })
    await respond(client, 'item-1', { allow: true })
    expect(lastParams(client, 'agentSession.respondToApproval')).toMatchObject({
      optionId: 'allow'
    })
  })

  it('requires exactly one answer flag before it builds a client', async () => {
    const ctx = context(respondingClient(), { session: SESSION, request: 'item-1' })
    Object.defineProperty(ctx, 'client', {
      get() {
        throw new Error('client constructed')
      }
    })
    for (const flags of [{}, { allow: true, deny: true }, { allow: true, option: 'pg' }]) {
      const withFlags = new Map<string, string | boolean>([
        ['session', SESSION],
        ['request', 'item-1'],
        ...Object.entries(flags)
      ])
      Object.defineProperty(ctx, 'flags', { value: withFlags })
      await expect(CHAT_HANDLERS['chat respond'](ctx)).rejects.toMatchObject({
        code: 'invalid_argument'
      })
    }
  })

  it('rejects an --allow that swallowed a positional', async () => {
    const client = respondingClient()
    await expect(respond(client, 'item-1', { allow: 'item-1' })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('hands the confirmation to the server on a local host', async () => {
    const client = respondingClient()
    await CHAT_HANDLERS['chat respond'](
      context(client, { session: SESSION, request: 'item-1', allow: true })
    )
    expect(lastOptions(client, 'agentSession.respondToApproval')).toMatchObject({
      publicContract: true,
      confirm: false
    })
  })

  it('holds a remote answer for --yes because a remote call cannot carry the gate', async () => {
    const client = respondingClient({}, { remote: true })
    await expect(
      CHAT_HANDLERS['chat respond'](
        context(client, { session: SESSION, request: 'item-1', allow: true })
      )
    ).rejects.toMatchObject({ code: 'needs_confirmation' })
    expect(client.call).not.toHaveBeenCalled()
  })

  it('surfaces a host refusal as a conflict with a next step', async () => {
    const client = respondingClient({
      'agentSession.respondToApproval': () => ({
        ok: false,
        refusal: {
          code: 'agent_session_item_revision_stale',
          message: 'The request changed.',
          details: { reason: 'revisionStale' }
        }
      })
    })
    await expect(respond(client, 'item-1', { allow: true })).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'revisionStale' }
    })
  })
})

describe('chat requests', () => {
  it('lists each pending request with its option ids', async () => {
    const client = respondingClient()
    await CHAT_HANDLERS['chat requests'](context(client, { session: SESSION }))
    const result = printedResult()
    expect(result.requests).toEqual([
      expect.objectContaining({ id: 'item-1', kind: 'approval', prompt: 'Run rm -rf build' }),
      expect.objectContaining({ id: 'item-2', kind: 'approval' }),
      expect.objectContaining({ id: 'item-3', kind: 'question', prompt: 'Which database?' }),
      expect.objectContaining({ id: 'item-4', kind: 'question' }),
      expect.objectContaining({ id: 'item-5', kind: 'question', prompt: 'Two things' })
    ])
  })
})

describe('chat send', () => {
  const SEND_VALUE = { clientMessageId: 'op-1', submission: { clientMessageId: 'op-1' } }

  function waitingClient(events: unknown[], sessions: unknown[] = []) {
    return fakeClient({
      handlers: { 'agentSession.send': () => mutationOk(SEND_VALUE) },
      stream: async (method, _params, onFrame, options) => {
        if (method === 'events.subscribe') {
          onFrame({ type: 'ready', subscriptionId: 's', cursor: 1 })
          for (const event of events) {
            onFrame(event)
          }
        } else {
          onFrame({ type: 'snapshot', sessions })
        }
        await untilAborted(options?.signal)
      }
    })
  }

  function chatEvent(type: string, data: Record<string, unknown>, seq = 2) {
    return { seq, at: 1000 + seq, topic: 'chat', type, data }
  }

  const SESSION_ROW = {
    sessionId: SESSION,
    workspaceId: 'wt-1',
    agent: 'claude',
    status: 'idle',
    lastAssistantMessage: 'All done: 3 files changed.'
  }

  it('returns as soon as the host accepts the message, without opening an event stream', async () => {
    const client = fakeClient({ handlers: { 'agentSession.send': () => mutationOk(SEND_VALUE) } })
    await CHAT_HANDLERS['chat send'](context(client, { session: SESSION, text: 'run the tests' }))

    expect(client.stream).not.toHaveBeenCalled()
    expect(printedResult()).toMatchObject({
      sessionId: SESSION,
      clientMessageId: 'op-1',
      turnId: null
    })
    const params = lastParams(client, 'agentSession.send')
    expect(params.body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'run the tests' }]
    })
    expectValid(SendParams, params)
    expect(params.envelope).toMatchObject({ sessionId: SESSION, expectedRuntimeFence: FENCE })
    expect(lastOptions(client, 'agentSession.send')).toMatchObject({ publicContract: true })
  })

  it('refuses an empty message before it builds a client', async () => {
    const ctx = context(fakeClient(), { session: SESSION, text: '   ' })
    Object.defineProperty(ctx, 'client', {
      get() {
        throw new Error('client constructed')
      }
    })
    await expect(CHAT_HANDLERS['chat send'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('--wait returns on turn.finished with the final assistant message from a fresh snapshot', async () => {
    const client = waitingClient(
      [
        chatEvent('turn.started', { sessionId: SESSION, turnId: 't1' }),
        chatEvent('turn.finished', { sessionId: OTHER_SESSION, turnId: 'other' }, 3),
        chatEvent('turn.finished', { sessionId: SESSION, turnId: 't1' }, 4)
      ],
      [
        { ...SESSION_ROW, sessionId: OTHER_SESSION, lastAssistantMessage: 'wrong chat' },
        SESSION_ROW
      ]
    )
    await CHAT_HANDLERS['chat send'](
      context(client, { session: SESSION, text: 'summarize the diff', wait: true, timeout: '5000' })
    )

    const [eventsCall] = client.stream.mock.calls
    expect(eventsCall[0]).toBe('events.subscribe')
    expect(eventsCall[1]).toEqual({ topics: ['chat'] })
    expect(client.stream.mock.calls.map(([method]) => method)).toEqual([
      'events.subscribe',
      'agentSession.subscribeStatus'
    ])
    expect(callsTo(client, 'agentSession.send')).toHaveLength(1)
    expect(printedResult()).toMatchObject({
      sessionId: SESSION,
      clientMessageId: 'op-1',
      turnId: 't1',
      status: 'finished',
      lastAssistantMessage: 'All done: 3 files changed.'
    })
  })

  it('--wait settles on turn.failed and on turn.needs-input with the request id', async () => {
    const failed = waitingClient(
      [chatEvent('turn.failed', { sessionId: SESSION, turnId: 't2' })],
      [SESSION_ROW]
    )
    await CHAT_HANDLERS['chat send'](context(failed, { session: SESSION, text: 'go', wait: true }))
    expect(printedResult()).toMatchObject({ status: 'failed', turnId: 't2' })

    output.mockClear()
    const needsInput = waitingClient(
      [chatEvent('turn.needs-input', { sessionId: SESSION, turnId: 't3', requestId: 'item-1' })],
      [SESSION_ROW]
    )
    await CHAT_HANDLERS['chat send'](
      context(needsInput, { session: SESSION, text: 'go', wait: true })
    )
    expect(printedResult()).toMatchObject({
      status: 'needs-input',
      requestId: 'item-1',
      turnId: 't3'
    })
  })

  it('--wait prints the status and the message as text', async () => {
    const client = waitingClient(
      [chatEvent('turn.finished', { sessionId: SESSION, turnId: 't1' })],
      [SESSION_ROW]
    )
    await CHAT_HANDLERS['chat send'](
      context(client, { session: SESSION, text: 'go', wait: true }, false)
    )
    const text = printedText()
    expect(text).toContain('status: finished')
    expect(text).toContain('All done: 3 files changed.')
  })

  it('--wait times out with exit code 6 semantics when no turn event arrives', async () => {
    const client = waitingClient([], [SESSION_ROW])
    await expect(
      CHAT_HANDLERS['chat send'](
        context(client, { session: SESSION, text: 'go', wait: true, timeout: '20' })
      )
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('chat list', () => {
  const SNAPSHOT = {
    type: 'snapshot',
    sessions: [
      {
        sessionId: SESSION,
        workspaceId: 'wt-1',
        agent: 'claude',
        status: 'working',
        model: 'opus',
        conversationName: 'Fix flaky test'
      },
      { sessionId: OTHER_SESSION, workspaceId: 'wt-2', agent: 'codex', status: null }
    ]
  }

  function listingClient() {
    return fakeClient({
      stream: async (_method, _params, onFrame, options) => {
        onFrame({ type: 'ready' })
        onFrame(SNAPSHOT)
        onFrame({ type: 'status', session: SNAPSHOT.sessions[0] })
        await untilAborted(options?.signal)
      }
    })
  }

  it('prints the sessions from the first snapshot frame and closes the stream', async () => {
    const client = listingClient()
    await CHAT_HANDLERS['chat list'](context(client, {}))

    expect(client.stream).toHaveBeenCalledTimes(1)
    const [method, , , options] = client.stream.mock.calls[0]
    expect(method).toBe('agentSession.subscribeStatus')
    expect(options?.signal?.aborted).toBe(true)
    expect(options).toMatchObject({ publicContract: true })
    expect(printedResult().sessions).toEqual([
      {
        sessionId: SESSION,
        agent: 'claude',
        status: 'working',
        workspace: 'wt-1',
        model: 'opus',
        name: 'Fix flaky test'
      },
      {
        sessionId: OTHER_SESSION,
        agent: 'codex',
        status: null,
        workspace: 'wt-2',
        model: null,
        name: null
      }
    ])
  })

  it('narrows to one workspace', async () => {
    const client = listingClient()
    await CHAT_HANDLERS['chat list'](context(client, { workspace: 'id:wt-2' }))
    expect(printedResult().sessions).toEqual([
      expect.objectContaining({ sessionId: OTHER_SESSION })
    ])
  })

  it('prints a table in text mode', async () => {
    await CHAT_HANDLERS['chat list'](context(listingClient(), {}, false))
    const lines = printedText().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(new RegExp(`^${SESSION}\\s+claude\\s+working\\s+wt-1\\s+opus$`))
    expect(lines[1]).toMatch(new RegExp(`^${OTHER_SESSION}\\s+codex\\s+-\\s+wt-2\\s+-$`))
  })

  it('fails as unavailable when the stream ends without a snapshot', async () => {
    const client = fakeClient({ stream: async () => {} })
    await expect(CHAT_HANDLERS['chat list'](context(client, {}))).rejects.toMatchObject({
      code: 'unavailable'
    })
  })
})

describe('chat create and resume', () => {
  const CREATE_VALUE = { sessionId: 'ignored', fence: 1, tabId: 'tab-9' }

  function statusWith(capabilities: string[]): Handlers {
    return { 'status.get': () => ({ capabilities }) }
  }

  it('creates a chat with no fence and the intent the host fingerprints', async () => {
    const client = fakeClient({
      handlers: { 'agentSession.create': () => mutationOk(CREATE_VALUE) }
    })
    await CHAT_HANDLERS['chat create'](context(client, { workspace: 'id:wt-1', agent: 'claude' }))

    const params = lastParams(client, 'agentSession.create')
    expect(params).toMatchObject({ worktree: 'id:wt-1', agent: 'claude' })
    expectValid(CreateIntentParams, params)
    const envelope = params.envelope
    expect(envelope).toMatchObject({ expectedRuntimeFence: null })
    const sessionId = Reflect.get(Object(envelope), 'sessionId')
    expect(sessionId).toMatch(/^claude_[0-9a-f_]+$/)
    expect(Reflect.get(Object(envelope), 'payloadFingerprint')).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields: { worktree: 'id:wt-1', agent: 'claude' }
      })
    )
    expect(callsTo(client, 'status.get')).toHaveLength(0)
    expect(printedResult()).toMatchObject({ sessionId, agent: 'claude', tabId: 'tab-9' })
  })

  it('puts --message and --model in the create when the host takes them', async () => {
    const client = fakeClient({
      handlers: {
        ...statusWith(['agentSession.create.message.v1']),
        'agentSession.create': () => mutationOk(CREATE_VALUE)
      }
    })
    await CHAT_HANDLERS['chat create'](
      context(client, {
        workspace: 'id:wt-1',
        agent: 'codex',
        message: 'run the tests',
        model: 'gpt-5'
      })
    )
    const params = lastParams(client, 'agentSession.create')
    expect(params).toMatchObject({
      options: { model: 'gpt-5' },
      firstMessage: { body: { blocks: [{ type: 'text', text: 'run the tests' }] } }
    })
    expectValid(CreateIntentParams, params)
    expect(callsTo(client, 'agentSession.send')).toHaveLength(0)
  })

  it('creates, then sets the model and sends, on a host without the create extras', async () => {
    const client = fakeClient({
      handlers: {
        ...statusWith([]),
        'agentSession.create': () => mutationOk(CREATE_VALUE),
        'agentSession.setOption': () => mutationOk({ key: 'model', value: 'gpt-5' }),
        'agentSession.send': () => mutationOk({ clientMessageId: 'op-1' })
      }
    })
    await CHAT_HANDLERS['chat create'](
      context(client, {
        workspace: 'id:wt-1',
        agent: 'codex',
        message: 'run the tests',
        model: 'gpt-5'
      })
    )
    const created = lastParams(client, 'agentSession.create')
    expect(created).not.toHaveProperty('firstMessage')
    expect(created).not.toHaveProperty('options')
    expect(lastParams(client, 'agentSession.setOption')).toMatchObject({
      key: 'model',
      value: 'gpt-5'
    })
    expectValid(SetOptionParams, lastParams(client, 'agentSession.setOption'))
    expectValid(SendParams, lastParams(client, 'agentSession.send'))
    const order = client.call.mock.calls.map(([method]) => method)
    expect(order.indexOf('agentSession.create')).toBeLessThan(
      order.indexOf('agentSession.setOption')
    )
    expect(order.indexOf('agentSession.setOption')).toBeLessThan(order.indexOf('agentSession.send'))
  })

  it('refuses a bad agent name before it builds a client', async () => {
    const ctx = context(fakeClient(), { workspace: 'id:wt-1', agent: 'not an agent' })
    Object.defineProperty(ctx, 'client', {
      get() {
        throw new Error('client constructed')
      }
    })
    await expect(CHAT_HANDLERS['chat create'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('resumes a listed chat from its own agent conversation', async () => {
    const client = fakeClient({
      handlers: { 'agentSession.create': () => mutationOk(CREATE_VALUE) },
      stream: async (_method, _params, onFrame, options) => {
        onFrame({
          type: 'snapshot',
          sessions: [
            {
              sessionId: SESSION,
              workspaceId: 'wt-1',
              agent: 'claude',
              status: 'idle',
              providerSession: { key: 'session_id', id: 'provider-77' }
            }
          ]
        })
        await untilAborted(options?.signal)
      }
    })
    await CHAT_HANDLERS['chat resume'](context(client, { session: SESSION, workspace: 'id:wt-2' }))

    const params = lastParams(client, 'agentSession.create')
    expect(params).toMatchObject({
      worktree: 'id:wt-2',
      agent: 'claude',
      resumeFrom: { providerSessionId: 'provider-77' }
    })
    expectValid(CreateIntentParams, params)
  })

  it('resumes a bare agent conversation id only when --agent names the agent', async () => {
    const stream: StreamFn = async (_method, _params, onFrame, options) => {
      onFrame({ type: 'snapshot', sessions: [] })
      await untilAborted(options?.signal)
    }
    const client = fakeClient({
      handlers: { 'agentSession.create': () => mutationOk(CREATE_VALUE) },
      stream
    })
    await CHAT_HANDLERS['chat resume'](
      context(client, { session: 'thread-123', workspace: 'id:wt-2', agent: 'codex' })
    )
    expect(lastParams(client, 'agentSession.create')).toMatchObject({
      agent: 'codex',
      resumeFrom: { providerSessionId: 'thread-123' }
    })

    const bare = fakeClient({ stream })
    await expect(
      CHAT_HANDLERS['chat resume'](context(bare, { session: 'thread-123', workspace: 'id:wt-2' }))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('chat cancel, rewind and clear', () => {
  it('cancels, naming the turn when given', async () => {
    const client = fakeClient({
      handlers: { 'agentSession.cancel': () => mutationOk({ cancelled: true, turnId: 't1' }) }
    })
    await CHAT_HANDLERS['chat cancel'](context(client, { session: SESSION, turn: 't1' }))
    const params = lastParams(client, 'agentSession.cancel')
    expect(params).toMatchObject({ turnId: 't1' })
    expectValid(CancelParams, params)
    expect(printedResult()).toMatchObject({ sessionId: SESSION, cancelled: true, turnId: 't1' })
  })

  it('rewinds against the epoch read from the session and passes --yes as confirm', async () => {
    const client = fakeClient({
      handlers: { 'agentSession.rewind': () => mutationOk({ itemId: 'item-9', epoch: 'epoch-2' }) }
    })
    await CHAT_HANDLERS['chat rewind'](
      context(client, { session: SESSION, to: 'item-9', yes: true })
    )
    const params = lastParams(client, 'agentSession.rewind')
    expect(params).toMatchObject({ itemId: 'item-9', expectedEpoch: EPOCH })
    expectValid(RewindParams, params)
    expect(params.envelope).toMatchObject({
      expectedRuntimeFence: FENCE,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: SESSION,
        fields: { itemId: 'item-9', expectedEpoch: EPOCH }
      })
    })
    expect(lastOptions(client, 'agentSession.rewind')).toMatchObject({
      publicContract: true,
      confirm: true
    })
    expect(printedResult()).toMatchObject({ itemId: 'item-9', epoch: 'epoch-2' })
  })

  it('leaves the rewind to the server gate when --yes is missing', async () => {
    const client = fakeClient({
      handlers: {
        'agentSession.rewind': () => {
          throw new RuntimeClientError('needs_confirmation', 'Rewind discards messages.')
        }
      }
    })
    await expect(
      CHAT_HANDLERS['chat rewind'](context(client, { session: SESSION, to: 'item-9' }))
    ).rejects.toMatchObject({ code: 'needs_confirmation' })
    expect(lastOptions(client, 'agentSession.rewind')).toMatchObject({
      publicContract: true,
      confirm: false
    })
  })

  it('holds a remote rewind and clear for --yes', async () => {
    const client = fakeClient({ remote: true })
    await expect(
      CHAT_HANDLERS['chat rewind'](context(client, { session: SESSION, to: 'item-9' }))
    ).rejects.toMatchObject({ code: 'needs_confirmation' })
    await expect(
      CHAT_HANDLERS['chat clear'](context(client, { session: SESSION }))
    ).rejects.toMatchObject({ code: 'needs_confirmation' })
    expect(client.call).not.toHaveBeenCalled()
  })

  it('clears through the conversation command with the destructive confirm', async () => {
    const client = fakeClient({
      handlers: { 'agentSession.conversationCommand': () => mutationOk({ clientMessageId: 'op' }) }
    })
    await CHAT_HANDLERS['chat clear'](context(client, { session: SESSION, yes: true }))
    const params = lastParams(client, 'agentSession.conversationCommand')
    expect(params).toMatchObject({ command: 'clear' })
    expectValid(ConversationCommandParams, params)
    expect(lastOptions(client, 'agentSession.conversationCommand')).toMatchObject({
      publicContract: true,
      confirm: true
    })
  })
})

describe('chat history and options', () => {
  const PAGE = {
    ok: true,
    page: {
      epoch: EPOCH,
      fence: FENCE,
      hasOlder: true,
      window: { oldest: { epoch: EPOCH, sequence: 12 } },
      items: [
        {
          itemId: 'item-1',
          sequence: 12,
          revision: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
        },
        {
          itemId: 'item-2',
          sequence: 13,
          revision: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] }
        }
      ]
    }
  }

  it('reads the newest page and offers a cursor for older messages', async () => {
    const client = fakeClient({ handlers: { 'agentSession.history': () => PAGE } })
    await CHAT_HANDLERS['chat history'](context(client, { session: SESSION, limit: '2' }))

    expect(lastParams(client, 'agentSession.history')).toEqual({
      sessionId: SESSION,
      direction: 'tail',
      limit: 2
    })
    expect(printedResult()).toMatchObject({
      hasOlder: true,
      nextBefore: `${EPOCH}:12`,
      items: [
        { itemId: 'item-1', kind: 'message', role: 'user', text: 'hello' },
        { itemId: 'item-2', kind: 'message', role: 'assistant', text: 'hi' }
      ]
    })
  })

  it('pages backwards from --before', async () => {
    const client = fakeClient({ handlers: { 'agentSession.history': () => PAGE } })
    await CHAT_HANDLERS['chat history'](
      context(client, { session: SESSION, before: `${EPOCH}:12` })
    )
    expect(lastParams(client, 'agentSession.history')).toEqual({
      sessionId: SESSION,
      direction: 'before',
      cursor: { epoch: EPOCH, sequence: 12 }
    })
    await expect(
      CHAT_HANDLERS['chat history'](context(client, { session: SESSION, before: 'nonsense' }))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('shows the options a session offers', async () => {
    const client = fakeClient({
      handlers: {
        'agentSession.options': () => ({
          current: { model: 'opus', effort: 'high' },
          models: [{ id: 'opus' }, { id: 'sonnet' }]
        })
      }
    })
    await CHAT_HANDLERS['chat options get'](context(client, { session: SESSION }))
    expect(lastParams(client, 'agentSession.options')).toEqual({ sessionId: SESSION })
    expect(printedResult()).toMatchObject({
      current: { model: 'opus', effort: 'high' },
      models: [{ id: 'opus' }, { id: 'sonnet' }]
    })
  })

  it('sets an option with a fenced envelope', async () => {
    const client = fakeClient({
      handlers: { 'agentSession.setOption': () => mutationOk({ key: 'model', value: 'sonnet' }) }
    })
    await CHAT_HANDLERS['chat options set'](
      context(client, { session: SESSION, key: 'model', value: 'sonnet' })
    )
    const params = lastParams(client, 'agentSession.setOption')
    expect(params).toMatchObject({ key: 'model', value: 'sonnet' })
    expectValid(SetOptionParams, params)
    expect(params.envelope).toMatchObject({ expectedRuntimeFence: FENCE })
    expect(printedResult()).toMatchObject({ sessionId: SESSION, key: 'model', value: 'sonnet' })
  })
})
