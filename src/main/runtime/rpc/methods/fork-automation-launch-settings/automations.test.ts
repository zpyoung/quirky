import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { QuirkyRuntimeService } from '../../../quirky-runtime'
import { AUTOMATION_METHODS } from '../automations'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('automation launch settings RPC', () => {
  it('accepts bounded launch overrides and strips unknown sibling keys', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every runtime method these RPC cases reach.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: vi.fn().mockResolvedValue({ id: 'auto-1' }),
      updateAutomation: vi.fn().mockResolvedValue({ id: 'auto-1' })
    } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('automation.create', {
        name: 'Nightly review',
        prompt: 'Review changes',
        agentId: 'claude',
        repo: 'repo-1',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1,
        launchOverrides: {
          model: 'sonnet',
          optionValues: { effort: 'high', fastMode: true },
          agentArgs: '--verbose',
          futureField: 'ignored'
        }
      })
    )
    await dispatcher.dispatch(
      makeRequest('automation.update', {
        id: 'auto-1',
        updates: { launchOverrides: null }
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        launchOverrides: {
          model: 'sonnet',
          optionValues: { effort: 'high', fastMode: true },
          agentArgs: '--verbose'
        }
      })
    )
    expect(runtime.updateAutomation).toHaveBeenCalledWith(
      'auto-1',
      { launchOverrides: null },
      expect.anything()
    )
  })

  it('rejects launch override values outside the wire bounds', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every runtime method these RPC cases reach.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAutomation: vi.fn()
    } as unknown as QuirkyRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('automation.create', {
        name: 'Nightly review',
        prompt: 'Review changes',
        agentId: 'claude',
        repo: 'repo-1',
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        dtstart: 1,
        launchOverrides: { model: 'm'.repeat(129) }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createAutomation).not.toHaveBeenCalled()
  })
})
