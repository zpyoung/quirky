import { expect, it, vi } from 'vitest'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { structuredAgentSessionCompactBody } from './structured-agent-session-command-turn'

it('answers a rewind while an earlier message is queued behind compact', async () => {
  {
    const { host, dispatch } = hostTestState()
    const compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
    host.deps.adapter.compact = compact
    host.deps.adapter.rewindSupport = () => ({ supported: true })
    await attach()
    const body = structuredAgentSessionCompactBody()
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
    const queued = hostTestMessage('After compact')
    expect(
      await host.send(CALLER, {
        envelope: envelope('agentSession.send', { body: queued }),
        body: queued
      })
    ).toMatchObject({ ok: true })
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    const itemId = 'codex:thread-1:turn-1:1'
    const result = host.rewind(CALLER, {
      envelope: envelope('agentSession.rewind', { itemId, expectedEpoch }),
      itemId,
      expectedEpoch
    })
    let settled = false
    void result.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(settled).toBe(true))
    expect(await result).toMatchObject({ ok: false, refusal: { rewindReason: 'busy' } })
    expect(dispatch).not.toHaveBeenCalled()
    expect((await host.journalSnapshot(SESSION)).submissions.at(-1)?.dispatchState).toBe('pending')
  }
})
