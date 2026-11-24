import type { QuirkyRuntimeService } from '../../../../runtime/quirky-runtime'
import type { ObjectiveStore } from '../../../../fork-heimdall-objective/objective-store'

const stores = new WeakMap<QuirkyRuntimeService, ObjectiveStore>()

export function bindHeimdallObjectiveStore(
  runtime: QuirkyRuntimeService,
  store: ObjectiveStore
): void {
  stores.set(runtime, store)
}

export function requireHeimdallObjectiveStore(runtime: QuirkyRuntimeService): ObjectiveStore {
  const store = stores.get(runtime)
  if (!store) {
    throw new Error('Heimdall objective store is unavailable on this runtime')
  }
  return store
}
