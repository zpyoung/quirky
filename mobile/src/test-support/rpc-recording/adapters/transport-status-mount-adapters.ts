import type { ConnectionState } from '../../../transport/types'
import type { MountAdapter, MountContext } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'
import { hookMount } from '../hook-mount'

const HOST = 'host-1'

/**
 * The `status.get` readers the transport owns: the protocol gate hook and the retrying capability
 * probe. They agree on acceptance and disagree on what a refusal costs, which is what the
 * recordings have to show.
 */
export function transportStatusMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'transport.host-status-gates': ({ client }: MountContext) => {
      const useGates = modules.load<typeof import('../../../transport/host-status-gates')>(
        'mobile/src/transport/host-status-gates.ts'
      ).useHostStatusGates
      let connState: ConnectionState = 'connected'
      let gates: ReturnType<typeof useGates> | undefined
      const hook = hookMount(() => {
        gates = useGates({ hostId: HOST, client, connState })
      })
      return {
        action(name, args) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          if (name === 'state') {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario names one of the connection states the hook switches on.
            connState = String(args.connState ?? 'connected') as ConnectionState
            return hook.update()
          }
          throw new Error(`Unknown host-status-gates action: ${name}`)
        },
        state: () => ({
          capabilities: gates?.hostCapabilities ?? null,
          floatingWorkspace: gates?.floatingWorkspaceEnabled ?? null,
          appVersion: gates?.desktopAppVersion ?? null,
          verdict: gates?.compatVerdict ?? null,
          pending: gates?.statusPending ?? null
        }),
        dispose: hook.unmount
      }
    },
    'transport.capability-probe': ({ client }: MountContext) => {
      const start = modules.load<typeof import('../../../transport/runtime-capability-probe')>(
        'mobile/src/transport/runtime-capability-probe.ts'
      ).startRuntimeCapabilityProbe
      const published: unknown[] = []
      let stop: (() => void) | null = null
      return {
        action(name) {
          if (name === 'start') {
            stop = start(client, (capabilities) => {
              published.push([...capabilities])
            })
            return
          }
          if (name === 'stop') {
            stop?.()
            stop = null
            return
          }
          throw new Error(`Unknown capability-probe action: ${name}`)
        },
        state: () => ({ published }),
        dispose: () => stop?.()
      }
    }
  }
}
