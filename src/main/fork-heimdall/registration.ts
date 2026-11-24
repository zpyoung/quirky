import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  bindHeimdallKernel,
  bindHeimdallTransport
} from '../runtime/rpc/methods/fork-heimdall/kernel-binding'
import { bindHeimdallObjectiveStore } from '../runtime/rpc/methods/fork-heimdall-objective/objective-binding'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { registerHostedReviewKind } from '../fork-hosted-review-sitter/kind'
import { registerHostedReviewAgentIpcHandlers } from '../fork-hosted-review-sitter/registration'
import { registerObjectiveKind } from '../fork-heimdall-objective/registration'
import { HeimdallKernelServiceImpl, type HeimdallKernelService } from './kernel-service'
import { HeimdallFleetTransport } from './fleet-transport'

export function startHeimdall(
  runtime: QuirkyRuntimeService,
  store: Store,
  isServeMode: boolean
): HeimdallKernelService {
  const storageAuthority = isServeMode ? 'runtime' : 'desktop'
  const kernel = new HeimdallKernelServiceImpl({ runtime, store, storageAuthority })
  registerHostedReviewKind(kernel, runtime, store, storageAuthority)
  const objective = registerObjectiveKind(
    kernel,
    runtime,
    store,
    storageAuthority,
    kernel.judgmentPersistence()
  )
  bindHeimdallObjectiveStore(runtime, objective.store)
  registerHostedReviewAgentIpcHandlers(runtime, store)
  bindHeimdallKernel(runtime, kernel)
  const transport = new HeimdallFleetTransport({
    kernel,
    store,
    userDataPath: getCanonicalUserDataPath
  })
  bindHeimdallTransport(runtime, transport)
  kernel.onShutdown(() => transport.dispose())
  kernel.onShutdown(() => objective.dispose(), 'drained')
  return kernel
}
