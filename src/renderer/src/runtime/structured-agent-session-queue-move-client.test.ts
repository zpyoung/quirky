// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('./structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  moveStructuredAgentSessionQueuedMessage,
  queuedMessageMoveFailureText
} from './structured-agent-session-queue-move-client'

const target = { kind: 'local' } as const
const request = {
  target,
  sessionId: 'session-1',
  fence: 4,
  messageId: 'queued-1',
  toIndex: 2
}

describe('moveStructuredAgentSessionQueuedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends a fenced envelope with the move and reports success', async () => {
    mocks.call.mockResolvedValue({ ok: true })
    await expect(moveStructuredAgentSessionQueuedMessage(request)).resolves.toEqual({ ok: true })
    const [calledTarget, method, params] = mocks.call.mock.calls[0]!
    expect(calledTarget).toBe(target)
    expect(method).toBe('agentSession.queuedMessageMove')
    expect(params).toMatchObject({
      messageId: 'queued-1',
      toIndex: 2,
      envelope: { sessionId: 'session-1', expectedRuntimeFence: 4 }
    })
    expect(params.envelope.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads the result inside a mutation wrapper', async () => {
    mocks.call.mockResolvedValue({ ok: true, replayed: false, fence: 4, value: { ok: true } })
    await expect(moveStructuredAgentSessionQueuedMessage(request)).resolves.toEqual({ ok: true })
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: false,
      fence: 4,
      value: { ok: false, reason: 'stale' }
    })
    await expect(moveStructuredAgentSessionQueuedMessage(request)).resolves.toEqual({
      ok: false,
      reason: 'stale'
    })
  })

  it('returns the host reason when the move is refused', async () => {
    mocks.call.mockResolvedValue({ ok: false, reason: 'sending' })
    const outcome = await moveStructuredAgentSessionQueuedMessage(request)
    expect(outcome).toEqual({ ok: false, reason: 'sending' })
    if (outcome.ok) {
      throw new Error('expected a refusal')
    }
    expect(queuedMessageMoveFailureText(outcome)).toBe('That message is already being sent.')
  })

  it('turns a thrown call into a failed outcome instead of rejecting', async () => {
    mocks.call.mockRejectedValue(new Error('offline'))
    await expect(moveStructuredAgentSessionQueuedMessage(request)).resolves.toEqual({
      ok: false,
      reason: 'failed',
      message: 'offline'
    })
  })

  it('does not call the host without a fence', async () => {
    const outcome = await moveStructuredAgentSessionQueuedMessage({ ...request, fence: null })
    expect(outcome.ok).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
