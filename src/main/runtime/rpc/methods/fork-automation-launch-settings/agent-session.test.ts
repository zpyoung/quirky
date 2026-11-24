import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../../shared/protocol-version'
import type { QuirkyRuntimeService } from '../../../quirky-runtime'
import type { RpcRequest } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import { AGENT_SESSION_METHODS } from '../agent-session'

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}

function runtimeStub() {
  const terminal = { handle: 'term_1', worktreeId: 'worktree-1', title: null }
  return {
    getRuntimeId: () => 'runtime-1',
    createAgentSession: vi.fn().mockResolvedValue({ terminal, disposition: 'created' })
  }
}

describe('agent session launch settings RPC', () => {
  it('accepts bounded general launch option values', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every runtime method these RPC cases reach.
      runtime: runtime as unknown as QuirkyRuntimeService,
      methods: AGENT_SESSION_METHODS
    })

    const response = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'cursor',
        launchPreferences: {
          model: 'claude-opus-4-8',
          effort: 'high',
          optionValues: { thinking: true, fastMode: false }
        }
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        launchPreferences: {
          model: 'claude-opus-4-8',
          effort: 'high',
          optionValues: { thinking: true, fastMode: false }
        }
      }),
      {}
    )
  })

  it('rejects an oversized general launch option record', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every runtime method these RPC cases reach.
      runtime: runtime as unknown as QuirkyRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
    const optionValues = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`option-${index}`, true])
    )

    const response = await dispatcher.dispatch(
      request('terminal.createAgentSession', {
        clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef',
        worktree: 'id:worktree-1',
        agent: 'cursor',
        launchPreferences: { optionValues }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('advertises the launch-overrides capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY)
  })
})
