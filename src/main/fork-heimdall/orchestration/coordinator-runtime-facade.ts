import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { RuntimeTerminalShow } from '../../../shared/runtime-types'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'

export function coordinatorRuntimeFacade(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment,
  workspaceId: string
): QuirkyRuntimeService {
  const identity = enrollment.coordinatorIdentity
  const boundMethods = new Map<PropertyKey, { source: object; bound: object }>()
  const syntheticShow = async (handle: string) => {
    if (handle === identity.handle) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker-start reads only worktreeId from the coordinator seat's synthetic show.
      return { worktreeId: workspaceId } as RuntimeTerminalShow
    }
    return runtime.showTerminal(handle)
  }
  const syntheticPaneKey = (handle: string) =>
    handle === identity.handle ? identity.paneKey : runtime.getTerminalPaneKey(handle)

  // The two exact-handle overrides expose only the authority worker-start needs. Every other
  // method stays bound to the real runtime, so private fields and runtime state cannot land on
  // the facade.
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'showTerminal') {
        return syntheticShow
      }
      if (property === 'getTerminalPaneKey') {
        return syntheticPaneKey
      }
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy trap forwards arbitrary keys; there is no named property to read.
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') {
        return value
      }
      const cached = boundMethods.get(property)
      if (cached && cached.source === value) {
        return cached.bound
      }
      const bound: object = value.bind(target)
      boundMethods.set(property, { source: value, bound })
      return bound
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    }
  })
}
