import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationEnvelope } from '../../shared/rpc-contract/structured-agent-session-params'
import {
  buildMutationEnvelope,
  readPendingRequests,
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
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve()))
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
