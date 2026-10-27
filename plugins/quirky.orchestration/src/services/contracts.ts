import type { PluginCaller } from '@quirky/protocol'
import type {
  CheckResult, DeliveryId, MessageType, MutationRequest, MutationResult,
  RunId, RunRow, RuntimeCallerEvidence,
} from '../contracts'
import type { WorkerControlResult, WorkerStartParams, WorkerStartReceipt } from '../worker-contracts'

/** Never a SessionAuthority. Construct only after authenticating the plugin and owned Run. */
export interface ServiceCoordinatorPrincipal {
  kind: 'service'
  pluginId: string
  runId: RunId
}
/** Session callers retain independently attested runtime evidence without a synthetic session. */
export type CoordinatorAuthority = RuntimeCallerEvidence | ServiceCoordinatorPrincipal
export interface ServiceOwner { pluginId: string; key: string }
export interface ServiceRun extends RunRow {
  coordinatorSessionId: null
  serviceOwner: ServiceOwner
}
export interface ServiceRunCreateParams extends MutationRequest { key: string; objective: string }
export interface ServiceRunShowParams { runId: RunId }
export type ServiceWorkerStartParams = Omit<WorkerStartParams, 'from' | 'terminal' | 'runId'> & { runId: RunId }
export interface ServiceCheckParams extends MutationRequest {
  runId: RunId
  ackDeliveryId?: DeliveryId
  wait?: boolean
  timeoutMs?: number
  types?: readonly MessageType[]
}
export interface ServiceWorkerReleaseParams extends MutationRequest { runId: RunId; dispatchId: string }
export interface ServiceMethodInputs {
  serviceRunCreate: ServiceRunCreateParams
  serviceRunShow: ServiceRunShowParams
  serviceWorkerStart: ServiceWorkerStartParams
  serviceCheck: ServiceCheckParams
  serviceWorkerRelease: ServiceWorkerReleaseParams
}
export interface ServiceMethodResults {
  serviceRunCreate: MutationResult<{ run: ServiceRun }>
  serviceRunShow: { run: ServiceRun }
  serviceWorkerStart: MutationResult<WorkerStartReceipt>
  serviceCheck: CheckResult
  serviceWorkerRelease: MutationResult<WorkerControlResult>
}
export type ServiceMethod = keyof ServiceMethodInputs
export type ServiceHandler<M extends ServiceMethod> = (
  params: ServiceMethodInputs[M], caller: PluginCaller,
) => Promise<ServiceMethodResults[M]> | ServiceMethodResults[M]
