import type { LoopService } from '../../../../fork-loops/loop-service'
import { LoopStoreError } from '../../../../fork-loops/loop-database'
import type { RuntimeConstructionServices } from '../../../construction/runtime-construction-services'

// keyed by the root runtime class so mixin layers below QuirkyRuntimeService can look it up
const loopServices = new WeakMap<RuntimeConstructionServices, LoopService>()

export function bindLoopService(runtime: RuntimeConstructionServices, service: LoopService): void {
  loopServices.set(runtime, service)
}

export function requireLoopService(runtime: RuntimeConstructionServices): LoopService {
  const service = loopServices.get(runtime)
  if (!service) {
    throw new LoopStoreError('loop_runtime_unavailable', 'Loops are unavailable on this runtime')
  }
  return service
}
