import { describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { reconcileRetainedCodexHookHomes } from './retained-codex-hook-state'

function status(state: 'installed' | 'not_installed' | 'error'): AgentHookInstallStatus {
  return {
    agent: 'codex',
    state,
    configPath: '/runtime/hooks.json',
    managedHooksPresent: state === 'installed',
    detail: state === 'error' ? 'failed' : null
  }
}

describe('retained Codex hook state', () => {
  it('repairs Quirky hooks before a retained shell can launch Codex', async () => {
    const install = vi.fn(() => status('installed'))
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    await reconcileRetainedCodexHookHomes({
      hookService: { install, refreshRuntimeUserHooks },
      hooksEnabled: true,
      runtimeHomePaths: ['/quirky/shared-home', '/quirky/account-home']
    })

    expect(install).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenNthCalledWith(1, '/quirky/shared-home')
    expect(install).toHaveBeenNthCalledWith(2, '/quirky/account-home')
    expect(refreshRuntimeUserHooks).not.toHaveBeenCalled()
  })

  it('removes only Quirky hooks from retained homes when hooks are disabled', async () => {
    const install = vi.fn(() => status('installed'))
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    await reconcileRetainedCodexHookHomes({
      hookService: { install, refreshRuntimeUserHooks },
      hooksEnabled: false,
      runtimeHomePaths: ['/quirky/shared-home']
    })

    expect(refreshRuntimeUserHooks).toHaveBeenCalledWith('/quirky/shared-home')
    expect(install).not.toHaveBeenCalled()
  })
})
