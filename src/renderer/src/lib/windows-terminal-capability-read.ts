import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

export type WindowsTerminalCapabilityLoadTarget = RuntimeClientTarget

export async function readWindowsTerminalCapabilities(
  target: WindowsTerminalCapabilityLoadTarget,
  sshConnectionId?: string | null
): Promise<WindowsTerminalCapabilities> {
  if (sshConnectionId) {
    const remoteCapabilityPromise =
      target.kind === 'environment'
        ? callRuntimeRpc<Omit<WindowsTerminalCapabilities, 'isLoading'>>(
            target,
            'preflight.detectRemoteWindowsTerminalCapabilities',
            { connectionId: sshConnectionId },
            { timeoutMs: 15_000 }
          )
        : window.api.preflight.detectRemoteWindowsTerminalCapabilities({
            connectionId: sshConnectionId
          })
    return remoteCapabilityPromise
      .then((capabilities) => ({
        ...capabilities,
        wslDistros: capabilities.wslDistros ?? [],
        isLoading: false
      }))
      .catch(() => ({
        wslAvailable: false,
        wslDistros: [],
        pwshAvailable: false,
        gitBashAvailable: false,
        hostPlatform: null,
        isLoading: false
      }))
  }

  if (target.kind === 'local') {
    const [pwshAvailable, gitBashAvailable, runtimeStatus] = await Promise.all([
      window.api.pwsh.isAvailable().catch(() => false),
      window.api.gitBash.isAvailable().catch(() => false),
      window.api.runtime.getStatus().catch(() => null)
    ])
    return {
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable,
      gitBashAvailable,
      hostPlatform: runtimeStatus?.hostPlatform ?? null,
      isLoading: false
    }
  }

  const [gitBashAvailable, hostPlatform] = await Promise.all([
    callRuntimeRpc<boolean>(target, 'host.gitBash.isAvailable', undefined, {
      timeoutMs: 15_000
    }).catch(() => false),
    callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, { timeoutMs: 15_000 })
      .then((status) => status.hostPlatform ?? null)
      .catch(() => null)
  ])
  return {
    wslAvailable: false,
    wslDistros: [],
    pwshAvailable: false,
    gitBashAvailable,
    hostPlatform,
    isLoading: false
  }
}
