import type { QuirkyRuntimeService } from '../../../../runtime/quirky-runtime'
import type { HeimdallKernelService } from '../../../../fork-heimdall/kernel-service'
import type { HeimdallFleetTransport } from '../../../../fork-heimdall/fleet-transport'
import { bindOrchestrationSubmissionPreflight } from '../../../../fork-heimdall/orchestration/submission-preflight'

const kernels = new WeakMap<QuirkyRuntimeService, HeimdallKernelService>()
const transports = new WeakMap<QuirkyRuntimeService, HeimdallFleetTransport>()

export function bindHeimdallKernel(
  runtime: QuirkyRuntimeService,
  kernel: HeimdallKernelService
): void {
  kernels.set(runtime, kernel)
  bindOrchestrationSubmissionPreflight(runtime, (submission) =>
    kernel.preflightSubmission(submission)
  )
}
export function bindHeimdallTransport(
  runtime: QuirkyRuntimeService,
  transport: HeimdallFleetTransport
): void {
  transports.set(runtime, transport)
}

export function requireHeimdallTransport(runtime: QuirkyRuntimeService): HeimdallFleetTransport {
  const transport = transports.get(runtime)
  if (!transport) {
    throw new Error('Heimdall fleet transport is unavailable on this runtime')
  }
  return transport
}

export function requireHeimdallKernel(runtime: QuirkyRuntimeService): HeimdallKernelService {
  const kernel = kernels.get(runtime)
  if (!kernel) {
    throw new Error('Heimdall is unavailable on this runtime: owner-not-executable')
  }
  return kernel
}
