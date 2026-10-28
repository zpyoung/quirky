import type { PluginStore } from '@quirky/protocol'
import type { DispatchId, DispatchRow, MutationRequest, MutationResult, RunId, RunRow, TaskCreateParams, TaskRow } from '../contracts'
import type { SessionIdentity } from '../runtime-contracts'
import type { DurableMutationOptions, OrchestrationWorkerCore } from '../worker-integration'
import { isServiceCoordinatorEvidence } from '../worker-contracts'
import type { CoordinatorEvidence, ServiceCoordinatorEvidence, WorkerCore } from '../worker-contracts'

type InspectionCore = OrchestrationWorkerCore

/** Lane11 supplies this after kernel admission; every method enforces pluginId and owned Run. */
export interface WorkerServiceCoordinatorPort {
  requireCoordinator(caller: ServiceCoordinatorEvidence, runId?: RunId): RunRow
  createTask(input: Omit<TaskCreateParams, keyof MutationRequest>, caller: ServiceCoordinatorEvidence): TaskRow
  reserveWorkerDispatch(input: { taskId: TaskRow['id']; runId: RunId; retryOfDispatchId?: DispatchId }, caller: ServiceCoordinatorEvidence): DispatchRow
  attachWorkerAuthority(dispatchId: DispatchId, identity: SessionIdentity, caller: ServiceCoordinatorEvidence): DispatchRow
  mutateWorker<T extends object>(method: string, params: MutationRequest & object, caller: ServiceCoordinatorEvidence, operation: (store: PluginStore) => T, options?: DurableMutationOptions<T>): Promise<MutationResult<T>>
}

/** The domain core remains the sole ledger, DAG and authority owner. */
export function createWorkerCore(core: InspectionCore, service?: WorkerServiceCoordinatorPort): WorkerCore {
  const requireService = () => {
    if (!service) throw core.context.error('conflict', 'Service coordinator APIs are not registered; a plugin cannot impersonate a session.')
    return service
  }
  return {
    context: core.context,
    store: core.store,
    get nestedWorkerMaxDepth() { return core.nestedWorkerMaxDepth },
    registerFederationAuthorityValidator: core.registerFederationAuthorityValidator.bind(core),
    registerWorkerPort: core.registerWorkerPort.bind(core),
    getRun: core.getRun.bind(core),
    getTask: core.getTask.bind(core),
    getDispatch: core.getDispatch.bind(core),
    createDispatch: core.createDispatch.bind(core),
    admitDispatch: core.admitDispatch.bind(core),
    transitionTask: core.transitionTask.bind(core),
    blockTaskForWorkerStop: core.blockTaskForWorkerStop.bind(core),
    transitionDispatch: core.transitionDispatch.bind(core),
    transitionWorker: core.transitionWorker.bind(core),
    reportWorkerDone: core.reportWorkerDone.bind(core),
    preflightFederatedWorkerDone: core.preflightFederatedWorkerDone.bind(core),
    reportFederatedWorkerDone: core.reportFederatedWorkerDone.bind(core),
    recordFederatedHeartbeat: core.recordFederatedHeartbeat.bind(core),
    reportFederatedWorkerExit: core.reportFederatedWorkerExit.bind(core),
    recordHeartbeat: core.recordHeartbeat.bind(core),
    emitWorkerStatus: core.emitWorkerStatus.bind(core),
    closeWorkerQuestions: core.closeWorkerQuestions.bind(core),
    listDispatches: core.listDispatches.bind(core),
    boundRunId: core.boundRunId.bind(core),
    attentionFor: core.attentionFor.bind(core),
    requireCoordinator(caller: CoordinatorEvidence, runId?: RunId) {
      if (isServiceCoordinatorEvidence(caller)) return requireService().requireCoordinator(caller, runId)
      return core.requireCoordinator(caller, runId)
    },
    createTask(input, caller) {
      if (isServiceCoordinatorEvidence(caller)) return requireService().createTask(input, caller)
      return core.createTask(input, caller)
    },
    reserveWorkerDispatch(input, caller) {
      if (isServiceCoordinatorEvidence(caller)) return requireService().reserveWorkerDispatch(input, caller)
      return core.reserveWorkerDispatch(input, caller)
    },
    attachWorkerAuthority(dispatchId, identity, caller) {
      if (isServiceCoordinatorEvidence(caller)) return requireService().attachWorkerAuthority(dispatchId, identity, caller)
      return core.attachWorkerAuthority(dispatchId, identity, caller)
    },
    async mutateWorker(method, params, caller, operation, options) {
      if (isServiceCoordinatorEvidence(caller)) return requireService().mutateWorker(method, params, caller, operation, options)
      if (method !== 'workerStart' && method !== 'workerStop' && method !== 'workerAbandon' && method !== 'workerRelease' && method !== 'workerRetain') {
        throw core.context.error('invalid-params', `Unknown worker mutation: ${method}`)
      }
      return core.mutate(method, params as MutationRequest & Record<string, unknown>, caller, operation, options)
    },
    mutate: core.mutate.bind(core),
  }
}
