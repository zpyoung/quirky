import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('./structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  forkStructuredAgentSession,
  readStructuredAgentSessionTurnDiff
} from './structured-agent-session-v1-chat-client'

const target = { kind: 'local' } as const

describe('forkStructuredAgentSession', () => {
  beforeEach(() => {
    mocks.call.mockReset()
  })

  it('fences the write to the fence the host serves and unwraps the mutation reply', async () => {
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.history'
        ? { ok: true, page: { fence: 7 } }
        : { ok: true, replayed: false, fence: 7, value: { ok: true, sessionId: 'forked' } }
    )
    await expect(forkStructuredAgentSession(target, 's1', { fromItemId: 'i1' })).resolves.toEqual({
      ok: true,
      sessionId: 'forked'
    })
    const [, , params] = mocks.call.mock.calls[1] ?? []
    expect(params).toMatchObject({
      fromItemId: 'i1',
      envelope: { sessionId: 's1', expectedRuntimeFence: 7 }
    })
    expect(params.envelope.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads a refusal or a thrown error as a failure the caller can word', async () => {
    mocks.call.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'agentSession.history') {
        return { ok: true, page: { fence: 1 } }
      }
      return { ok: true, replayed: false, fence: 1, value: { ok: false, reason: 'busy' } }
    })
    await expect(forkStructuredAgentSession(target, 's1')).resolves.toEqual({
      ok: false,
      reason: 'busy'
    })
    mocks.call.mockRejectedValue(new Error('offline'))
    await expect(forkStructuredAgentSession(target, 's1')).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })
})

describe('readStructuredAgentSessionTurnDiff', () => {
  it('passes the host reason through and degrades an unreadable reply to failed', async () => {
    mocks.call.mockResolvedValueOnce({ ok: false, reason: 'gone' })
    await expect(readStructuredAgentSessionTurnDiff(target, 's1', 't1', 'a.ts')).resolves.toEqual({
      ok: false,
      reason: 'gone'
    })
    mocks.call.mockResolvedValueOnce({ nonsense: true })
    await expect(readStructuredAgentSessionTurnDiff(target, 's1', 't1', 'a.ts')).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })
})
