import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationEnvelope } from '../../shared/rpc-contract/structured-agent-session-params'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { PublicEvent } from '../../shared/public-rpc/public-events'
import {
  awaitMessageTurnId,
  buildMutationEnvelope,
  createSendTurnTracker,
  readPendingRequests,
  readRecentTurnIds,
  readStatusSessions,
  type ChatClient
} from './chat-mutation-envelope'

const SESSION_ID = 'claude_0b1c2d3e_4f5a_4b6c_8d7e_9f0a1b2c3d4e'

function build(fields: Record<string, unknown>, method = 'agentSession.setOption') {
  return buildMutationEnvelope({
    method,
    sessionId: SESSION_ID,
    fields,
    expectedRuntimeFence: 4
  })
}

describe('buildMutationEnvelope', () => {
  it('produces an envelope the host schema accepts', () => {
    expect(MutationEnvelope.safeParse(build({ key: 'model', value: 'opus' })).success).toBe(true)
    expect(
      MutationEnvelope.safeParse(
        buildMutationEnvelope({
          method: 'agentSession.create',
          sessionId: SESSION_ID,
          fields: {},
          expectedRuntimeFence: null
        })
      ).success
    ).toBe(true)
  })

  it('fingerprints the sorted-key JSON of the method, session and fields', () => {
    const expected = createHash('sha256')
      .update(
        `{"fields":{"key":"model","value":"opus"},"method":"agentSession.setOption","sessionId":"${SESSION_ID}"}`
      )
      .digest('hex')
    expect(build({ key: 'model', value: 'opus' }).payloadFingerprint).toBe(expected)
  })

  it('gives the same fingerprint however the keys are ordered, at every depth', () => {
    const first = build({ body: { kind: 'message', blocks: [{ type: 'text', text: 'hi' }] }, a: 1 })
    const second = build({
      a: 1,
      body: { blocks: [{ text: 'hi', type: 'text' }], kind: 'message' }
    })
    expect(first.payloadFingerprint).toBe(second.payloadFingerprint)
  })

  it('ignores fields that are undefined', () => {
    expect(build({ itemId: 'i1', optionId: undefined }).payloadFingerprint).toBe(
      build({ itemId: 'i1' }).payloadFingerprint
    )
  })

  it('changes the fingerprint when a value or the method changes', () => {
    const base = build({ key: 'model', value: 'opus' }).payloadFingerprint
    expect(build({ key: 'model', value: 'sonnet' }).payloadFingerprint).not.toBe(base)
    expect(build({ key: 'model', value: 'opus' }, 'agentSession.send').payloadFingerprint).not.toBe(
      base
    )
  })

  it('mints a new operation id on every call', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => build({ key: 'model', value: 'opus' }).clientOperationId)
    )
    expect(ids.size).toBe(20)
    for (const id of ids) {
      expect(id).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    }
  })

  it('embeds the uuid it is given in the operation id', () => {
    const envelope = buildMutationEnvelope({
      method: 'agentSession.cancel',
      sessionId: SESSION_ID,
      fields: {},
      expectedRuntimeFence: 1,
      randomUuid: () => '123e4567-e89b-42d3-a456-426614174000',
      now: 1_790_000_000_000
    })
    expect(envelope.clientOperationId).toBe('1790000000000-123e4567e89b42d3a456426614174000')
  })

  it('carries the fence it is given, null included', () => {
    expect(build({}).expectedRuntimeFence).toBe(4)
    expect(
      buildMutationEnvelope({
        method: 'agentSession.cancel',
        sessionId: SESSION_ID,
        fields: {},
        expectedRuntimeFence: null
      }).expectedRuntimeFence
    ).toBeNull()
  })
})

type StreamHandler = (
  onFrame: (frame: unknown) => void,
  signal: AbortSignal
) => Promise<void> | void

function streamClient(handler: StreamHandler): ChatClient {
  const stream = async (
    _method: string,
    _params: unknown,
    onFrame: (frame: unknown) => void,
    options?: { signal?: AbortSignal }
  ) => {
    const signal = options?.signal ?? new AbortController().signal
    await handler(onFrame, signal)
  }
  // SAFETY: readStatusSessions touches only stream on the client
  return { stream } as unknown as ChatClient
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // the handler aborts synchronously inside onFrame, before the stub gets to wait
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

describe('readStatusSessions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the first snapshot and closes the stream', async () => {
    let aborted = false
    const client = streamClient(async (onFrame, signal) => {
      onFrame({
        type: 'snapshot',
        sessions: [{ sessionId: 's1', workspaceId: 'w1', agent: 'claude' }]
      })
      await untilAborted(signal)
      aborted = signal.aborted
    })
    await expect(readStatusSessions(client)).resolves.toMatchObject([{ sessionId: 's1' }])
    expect(aborted).toBe(true)
  })

  it('skips frames that are not snapshots', async () => {
    const client = streamClient(async (onFrame, signal) => {
      onFrame({ type: 'update', sessionId: 's1' })
      onFrame({ type: 'snapshot', sessions: [] })
      await untilAborted(signal)
    })
    await expect(readStatusSessions(client)).resolves.toEqual([])
  })

  it('rejects a malformed snapshot as invalid_runtime_response and closes the stream', async () => {
    let aborted = false
    const client = streamClient(async (onFrame, signal) => {
      onFrame({
        type: 'snapshot',
        sessions: [{ sessionId: 's', agent: 'claude', workspaceId: 42 }]
      })
      await untilAborted(signal)
      aborted = true
    })
    await expect(readStatusSessions(client)).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
    expect(aborted).toBe(true)
  })

  it('rejects with timeout and closes the stream when no snapshot arrives', async () => {
    vi.useFakeTimers()
    let aborted = false
    const client = streamClient(async (_onFrame, signal) => {
      await untilAborted(signal)
      aborted = true
    })
    const attempt = readStatusSessions(client)
    const assertion = expect(attempt).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(aborted).toBe(true)
  })

  it('reports unavailable when the stream ends without a snapshot', async () => {
    const client = streamClient(() => undefined)
    await expect(readStatusSessions(client)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('readPendingRequests', () => {
  const REQUEST = {
    itemId: 'i1',
    revision: 1,
    body: { kind: 'approval', options: [{ id: 'allow' }] }
  }

  function pagedClient(pieces: (call: number, params: Record<string, unknown>) => unknown) {
    let calls = 0
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      calls += 1
      return { result: pieces(calls, params) }
    })
    // SAFETY: readPendingRequests touches only call on the client
    return { client: { call } as unknown as ChatClient, call }
  }

  it('reassembles pieces after the version restart', async () => {
    const text = JSON.stringify([REQUEST])
    const { client } = pagedClient((n) => {
      if (n === 1) {
        return { marker: { version: 'v1' }, json: '', nextCursor: null, restart: true }
      }
      return n === 2
        ? { marker: { version: 'v1' }, json: text.slice(0, 5), nextCursor: 5 }
        : { marker: { version: 'v1' }, json: text.slice(5), nextCursor: null }
    })
    await expect(readPendingRequests(client, 's1')).resolves.toMatchObject([{ itemId: 'i1' }])
  })

  it('rejects a cursor that does not advance', async () => {
    const { client, call } = pagedClient(() => ({
      marker: { version: 'v' },
      json: '',
      nextCursor: 0
    }))
    await expect(readPendingRequests(client, 's1')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
    expect(call.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('rejects a response that spans more than 50 pages', async () => {
    const { client, call } = pagedClient((n) => ({
      marker: { version: 'v' },
      json: '',
      nextCursor: n
    }))
    await expect(readPendingRequests(client, 's1')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
    expect(call).toHaveBeenCalledTimes(50)
  })

  it('rejects a response larger than 4 MiB', async () => {
    const { client } = pagedClient((n) => ({
      marker: { version: 'v' },
      json: 'x'.repeat(1024 * 1024),
      nextCursor: n
    }))
    await expect(readPendingRequests(client, 's1')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
  })

  it('rejects a malformed page', async () => {
    const { client } = pagedClient(() => ({ marker: {}, json: 3 }))
    await expect(readPendingRequests(client, 's1')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
  })

  it('rejects assembled text that is not a list of requests', async () => {
    const { client } = pagedClient(() => ({
      marker: { version: 'v' },
      json: '{"a":1}',
      nextCursor: null
    }))
    await expect(readPendingRequests(client, 's1')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
  })
})

describe('turn lookup from the journal', () => {
  const OPENER = agentJournalSubmissionKey('msg-1')

  function historyClient(pages: unknown[][]) {
    let reads = 0
    const call = vi.fn(async () => {
      const items = pages[Math.min(reads, pages.length - 1)]
      reads += 1
      return {
        id: 'r',
        ok: true as const,
        result: { page: { epoch: 'e', items, hasOlder: false } },
        _meta: { runtimeId: 'rt' }
      }
    })
    // SAFETY: the lookup calls only `call`
    return { client: { call } as unknown as ChatClient, call }
  }

  const NO_WAIT = { budgetMs: 0, intervalMs: 10 }

  it('finds the turn whose record names the message as its opener', async () => {
    const { client } = historyClient([
      [
        { itemId: 'turn-a', body: { kind: 'turn', turnId: 't-old', userItemId: 'other' } },
        { itemId: 'turn-b', body: { kind: 'turn', turnId: 't-new', userItemId: OPENER } }
      ]
    ])
    await expect(awaitMessageTurnId(client, 's1', 'msg-1', NO_WAIT)).resolves.toBe('t-new')
  })

  it("reads the turn from an older host's lifecycle status row", async () => {
    const { client } = historyClient([
      [
        {
          itemId: 'status-1',
          body: { kind: 'status', turnLifecycle: { turnId: 't-legacy', userItemId: OPENER } }
        }
      ]
    ])
    await expect(awaitMessageTurnId(client, 's1', 'msg-1', NO_WAIT)).resolves.toBe('t-legacy')
  })

  it('finds the running turn a steered message joined through its row scope', async () => {
    const { client } = historyClient([
      [
        { itemId: 'turn-run', body: { kind: 'turn', turnId: 't-running' } },
        {
          itemId: OPENER,
          body: { kind: 'message', role: 'user' },
          turnScope: { kind: 'turn', turnItemId: 'turn-run' }
        }
      ]
    ])
    await expect(awaitMessageTurnId(client, 's1', 'msg-1', NO_WAIT)).resolves.toBe('t-running')
  })

  it('ignores a turn another message opened', async () => {
    const { client } = historyClient([
      [{ itemId: 'turn-a', body: { kind: 'turn', turnId: 't-old', userItemId: 'other' } }]
    ])
    await expect(awaitMessageTurnId(client, 's1', 'msg-1', NO_WAIT)).resolves.toBeNull()
  })

  it('polls until the host opens the turn', async () => {
    vi.useFakeTimers()
    const { client, call } = historyClient([
      [],
      [{ itemId: 'turn-b', body: { kind: 'turn', turnId: 't-new', userItemId: OPENER } }]
    ])
    const found = awaitMessageTurnId(client, 's1', 'msg-1', { budgetMs: 1000, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(found).resolves.toBe('t-new')
    expect(call).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('treats an unreadable journal as not yet opened', async () => {
    const call = vi.fn(async () => {
      throw new Error('down')
    })
    // SAFETY: the lookup calls only `call`
    const client = { call } as unknown as ChatClient
    await expect(awaitMessageTurnId(client, 's1', 'msg-1', NO_WAIT)).resolves.toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('ends after one read when the caller has already stopped the lookup', async () => {
    const { client, call } = historyClient([[]])
    await expect(
      awaitMessageTurnId(client, 's1', 'msg-1', {
        budgetMs: 5000,
        intervalMs: 100,
        signal: AbortSignal.abort()
      })
    ).resolves.toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('lists the ids of the turns already in the journal', async () => {
    const { client } = historyClient([
      [
        { itemId: 'turn-a', body: { kind: 'turn', turnId: 't-1' } },
        { itemId: 'm', body: { kind: 'message', role: 'user' } }
      ]
    ])
    await expect(readRecentTurnIds(client, 's1')).resolves.toEqual(new Set(['t-1']))
  })
})

describe('awaitMessageTurnId', () => {
  /** A host whose history request never answers; like the runtime client it rejects once aborted. */
  function silentHost() {
    const requests: { signal?: AbortSignal; timeoutMs?: number }[] = []
    const call = vi.fn(
      (_method: string, _params: unknown, options: { signal?: AbortSignal; timeoutMs?: number }) =>
        new Promise<never>((_resolve, reject) => {
          requests.push(options)
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    // SAFETY: the lookup calls only `call`
    return { client: { call } as unknown as ChatClient, requests }
  }

  it('gives up within the budget and cancels the history request still in flight', async () => {
    const { client, requests } = silentHost()
    const started = Date.now()

    await expect(
      awaitMessageTurnId(client, 's1', 'msg-1', { budgetMs: 30, intervalMs: 5 })
    ).resolves.toBeNull()

    expect(Date.now() - started).toBeLessThan(1000)
    expect(requests[0].signal?.aborted).toBe(true)
    expect(requests[0].timeoutMs).toBeLessThanOrEqual(30)
  })

  it('cancels the history request in flight when the caller aborts the lookup', async () => {
    const { client, requests } = silentHost()
    const stop = new AbortController()

    const found = awaitMessageTurnId(client, 's1', 'msg-1', {
      budgetMs: 5000,
      intervalMs: 5,
      signal: stop.signal
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    stop.abort()

    await expect(found).resolves.toBeNull()
    expect(requests[0].signal?.aborted).toBe(true)
  })
})

describe('createSendTurnTracker', () => {
  const OPENER = agentJournalSubmissionKey('msg-1')

  function event(type: string, seq: number, turnId?: string): PublicEvent {
    return {
      seq,
      at: seq,
      topic: 'chat',
      type,
      data: { sessionId: 's1', ...(turnId === undefined ? {} : { turnId }) }
    }
  }

  const JOURNAL_OF_MINE = [
    { itemId: 'turn-b', body: { kind: 'turn', turnId: 't-mine', userItemId: OPENER } }
  ]

  /** A tracker whose redelivered events are judged by `offer` again, as the caller's event loop does. */
  function tracker(items: unknown[], priorTurnIds: string[] = ['t-earlier'], lookupHangs = false) {
    const settled: number[] = []
    const call = vi.fn(() =>
      lookupHangs
        ? new Promise<never>(() => {})
        : Promise.resolve({
            id: 'r',
            ok: true as const,
            result: { page: { epoch: 'e', items, hasOlder: false } },
            _meta: { runtimeId: 'rt' }
          })
    )
    // SAFETY: the tracker calls only `call`
    const client = { call } as unknown as ChatClient
    const own = createSendTurnTracker(client, 's1', {
      priorTurnIds: new Set(priorTurnIds),
      budgetMs: lookupHangs ? 1000 : 60,
      intervalMs: 10,
      redeliver: (replayed) => {
        if (own.offer(replayed)) {
          settled.push(replayed.seq)
        }
      }
    })
    return { own, settled }
  }

  it('holds every turn event while the lookup is pending', () => {
    const { own } = tracker([], ['t-old'], true)
    own.accepted('msg-1')

    expect(own.offer(event('turn.finished', 1))).toBe(false)
    expect(own.offer(event('turn.finished', 2, 't-other'))).toBe(false)
    expect(own.offer(event('turn.needs-input', 3))).toBe(false)
    expect(own.offer(event('turn.finished', 4, 't-old'))).toBe(false)
    own.finish()
  })

  it('settles a refused send under its own message key without waiting for the lookup', () => {
    const { own } = tracker([], ['t-old'], true)
    own.accepted('msg-1')

    expect(own.offer(event('turn.failed', 1, OPENER))).toBe(true)
    own.finish()
  })

  it('replays the held event of the turn the lookup finds and drops the others', async () => {
    const { own, settled } = tracker(JOURNAL_OF_MINE)
    own.offer(event('turn.finished', 1, 't-stray'))
    own.offer(event('turn.finished', 2, 't-mine'))
    own.accepted('msg-1')

    await vi.waitFor(() => expect(settled).toEqual([2]))
    own.finish()
  })

  it('takes an event naming no turn only when no turn was found, including one held before the send reply', async () => {
    const { own, settled } = tracker([])
    own.offer(event('turn.finished', 1))
    own.accepted('msg-1')
    own.offer(event('turn.finished', 2))
    await vi.waitFor(() => expect(settled).toEqual([1, 2]))
    own.finish()

    const found = tracker(JOURNAL_OF_MINE)
    found.own.accepted('msg-1')
    await vi.waitFor(() => expect(found.own.turnId).toBe('t-mine'))
    expect(found.own.offer(event('turn.finished', 4))).toBe(false)
    found.own.finish()
  })

  it('settles on a needs-input event naming no turn, also one that arrived before the send reply', async () => {
    const { own, settled } = tracker(JOURNAL_OF_MINE)
    expect(own.offer(event('turn.needs-input', 1))).toBe(false)
    own.accepted('msg-1')
    own.offer(event('turn.needs-input', 2))

    await vi.waitFor(() => expect(settled).toEqual([1, 2]))
    own.finish()
  })

  it('drops a finish naming no turn that arrived before the send reply once the lookup finds the turn', async () => {
    const { own, settled } = tracker(JOURNAL_OF_MINE)
    own.offer(event('turn.finished', 1))
    own.offer(event('turn.needs-input', 2))
    own.accepted('msg-1')

    await vi.waitFor(() => expect(settled).toEqual([2]))
    own.finish()
  })

  it('settles on a turn event that arrived before the send reply once the send is accepted', async () => {
    const { own, settled } = tracker(JOURNAL_OF_MINE)
    own.offer(event('turn.finished', 1, 't-mine'))
    own.accepted('msg-1')

    await vi.waitFor(() => expect(settled).toEqual([1]))
    own.finish()
  })

  it('accepts a turn that was not in the journal before the send once no turn is found', async () => {
    const { own, settled } = tracker([])
    own.accepted('msg-1')
    own.offer(event('turn.finished', 1, 't-earlier'))
    own.offer(event('turn.finished', 2, 't-new'))

    await vi.waitFor(() => expect(settled).toEqual([2]))
    own.finish()
  })

  it('judges a live event directly once the lookup has ended', async () => {
    const { own } = tracker([])
    own.accepted('msg-1')
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(own.offer(event('turn.finished', 1, 't-earlier'))).toBe(false)
    expect(own.offer(event('turn.finished', 2, 't-new'))).toBe(true)
    own.finish()
  })

  it('follows a steered send into the running turn it joined, though that turn predates it', async () => {
    const { own } = tracker(
      [
        { itemId: 'turn-run', body: { kind: 'turn', turnId: 't-earlier' } },
        {
          itemId: OPENER,
          body: { kind: 'message', role: 'user' },
          turnScope: { kind: 'turn', turnItemId: 'turn-run' }
        }
      ],
      ['t-earlier']
    )
    own.accepted('msg-1')
    await vi.waitFor(() => expect(own.turnId).toBe('t-earlier'))
    own.finish()
    expect(own.offer(event('turn.finished', 1, 't-earlier'))).toBe(true)
  })
})
