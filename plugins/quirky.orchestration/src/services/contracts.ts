import type { PluginCaller } from '@quirky/protocol'
import type {
  CheckResult, DeliveryId, MessageType, MutationRequest, MutationResult,
  QuestionThreadRow, ReplyResult, RunId, RunRow, RuntimeCallerEvidence,
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
/** Exact worker incarnation is exposed only after the service Run ownership check. */
export interface ServiceWorkerView {
  dispatchId: string
  sessionId: string | null
  processIncarnation: string | null
  state: 'live' | 'exited' | 'unverifiable'
  lastContactAtMs: number | null
}
export interface ServiceQuestionView extends QuestionThreadRow { body: string }
/** Non-consuming projection: no delivery acknowledgement or consumer-generation mutation. */
export interface ServiceRunDetail {
  run: ServiceRun
  workers: readonly ServiceWorkerView[]
  questions: readonly ServiceQuestionView[]
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
export interface ServiceWorkerStopParams extends ServiceWorkerReleaseParams {
  expectedIdentity: { sessionId: string; processIncarnation: string }
}
export interface ServiceReplyParams extends MutationRequest { runId: RunId; messageId: string; body: string }
export interface ServiceMethodInputs {
  serviceRunCreate: ServiceRunCreateParams
  serviceRunShow: ServiceRunShowParams
  serviceWorkerStart: ServiceWorkerStartParams
  serviceCheck: ServiceCheckParams
  serviceWorkerRelease: ServiceWorkerReleaseParams
  serviceWorkerStop: ServiceWorkerStopParams
  serviceReply: ServiceReplyParams
}
export interface ServiceMethodResults {
  serviceRunCreate: MutationResult<{ run: ServiceRun }>
  serviceRunShow: ServiceRunDetail
  serviceWorkerStart: MutationResult<WorkerStartReceipt>
  serviceCheck: CheckResult & { questions: readonly ServiceQuestionView[] }
  serviceWorkerRelease: MutationResult<WorkerControlResult>
  serviceWorkerStop: MutationResult<WorkerControlResult>
  serviceReply: ReplyResult
}
export type ServiceMethod = keyof ServiceMethodInputs
export type ServiceHandler<M extends ServiceMethod> = (
  params: ServiceMethodInputs[M], caller: PluginCaller,
) => Promise<ServiceMethodResults[M]> | ServiceMethodResults[M]
