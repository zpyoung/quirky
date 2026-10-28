import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type {
  CoordinatorAuthority, DispatchId, DispatchRow, MutationRequest, MutationResult, RunId,
  ServiceCoordinatorPrincipal, TaskCreateParams, TaskRow,
} from '../contracts'
import type { OrchestrationCore } from '../core'
import type { OrchestrationMessages } from '../messaging'
import type { WorkerControlResult, WorkerShowResult } from '../worker-contracts'
import type { WorkerServiceCoordinatorPort } from '../workers/core-adapter'
import type { WorkerComponents } from '../workers/register'
import type { ServiceCoordinatorPort } from './handlers'
import type { ServiceMethodResults, ServiceRunDetail, ServiceWorkerView } from './contracts'
import { fail } from '../errors'

export interface OrchestrationServiceCoordinator extends ServiceCoordinatorPort, WorkerServiceCoordinatorPort {
  bindWorkers(workers: WorkerComponents): void
}

/** Owner-scoped service facade over the existing coordinator, message and worker components. */
export function createServiceCoordinator(
  context: PluginContext,
  core: OrchestrationCore,
  messages: OrchestrationMessages
): OrchestrationServiceCoordinator {
  let workerComponents: WorkerComponents | null = null

  const workers = (): WorkerComponents => {
    if (workerComponents === null) throw new Error('worker components are not bound during orchestration activation')
    return workerComponents
  }

  const ownedDispatch = (caller: ServiceCoordinatorPrincipal, runId: RunId, dispatchId: DispatchId): DispatchRow => {
    core.requireCoordinator(caller, runId)
    const dispatch = core.getDispatch(dispatchId)
    if (dispatch.runId !== caller.runId) {
      fail(context, 'consumer_fenced', 'the Dispatch is not in the service-owned Run', { dispatchId, runId })
    }
    return dispatch
  }

  async function workersForRun(runId: RunId, caller: PluginCaller): Promise<readonly ServiceWorkerView[]> {
    const rows = core.store.all<{ id: DispatchId }>(
      `SELECT id FROM dispatches WHERE run_id = ? AND supervised = 1 ORDER BY created_at, id`,
      runId
    )
    const show = workers().methods.workerShow
    const result: ServiceWorkerView[] = []
    for (const row of rows) {
      const detail = await show({ dispatchId: row.id }, caller) as WorkerShowResult
      const state = detail.observation.status === 'live' && detail.observation.exactWorker
        ? 'live'
        : detail.observation.status === 'exited'
          ? 'exited'
          : 'unverifiable'
      const identity = detail.observation.exactWorker && detail.observation.identity
        ? detail.observation.identity
        : detail.observation.status === 'exited' && detail.worker
          ? detail.worker
          : null
      const lastHeartbeatAt = detail.dispatch.lastHeartbeatAt
      const observedAt = lastHeartbeatAt === null ? null : Date.parse(lastHeartbeatAt)
      result.push({
        dispatchId: row.id,
        sessionId: identity?.sessionId ?? null,
        processIncarnation: identity?.processIncarnation ?? null,
        state,
        lastContactAtMs: observedAt !== null && Number.isFinite(observedAt) ? observedAt : null,
        assignmentActive: (detail.dispatch.status === 'pending' || detail.dispatch.status === 'dispatched') && detail.worker !== null
      })
    }
    return result
  }

  const coordinator: OrchestrationServiceCoordinator = {
    context,

    bindWorkers(components) {
      if (workerComponents !== null) throw new Error('orchestration worker components are already bound')
      workerComponents = components
    },

    requireOwnedRun(pluginId, runId) {
      core.requireOwnedRun(pluginId, runId)
    },

    serviceRunCreate(params, pluginId) {
      return core.serviceRunCreate(params, pluginId)
    },

    async serviceRunShow(params, pluginId, caller): Promise<ServiceRunDetail> {
      core.requireOwnedRun(pluginId, params.runId)
      const run = core.getServiceRun(pluginId, params.runId)
      const workerRows = await workersForRun(params.runId, caller)
      const questions = messages.serviceQuestions(params.runId)
      return { run, workers: workerRows, questions }
    },

    serviceWorkerStart(params, principal): Promise<ServiceMethodResults['serviceWorkerStart']> {
      core.requireCoordinator(principal, params.runId)
      return workers().starter.start(params, principal)
    },

    serviceCheck(params, principal): Promise<ServiceMethodResults['serviceCheck']> {
      return messages.serviceCheck(params, principal)
    },

    serviceWorkerRelease(params, principal): Promise<MutationResult<WorkerControlResult>> {
      ownedDispatch(principal, params.runId, params.dispatchId)
      return workers().lifecycle.release(params, principal)
    },

    serviceWorkerStop(params, principal): Promise<MutationResult<WorkerControlResult>> {
      ownedDispatch(principal, params.runId, params.dispatchId)
      return workers().lifecycle.stop(params, principal)
    },

    serviceReply(params, principal) {
      return messages.replyService(params, principal)
    },

    serviceSend(params, principal) {
      return messages.sendService(params, principal)
    },

    requireCoordinator(caller, runId) {
      return core.requireCoordinator(caller, runId)
    },

    createTask(input: Omit<TaskCreateParams, keyof MutationRequest>, caller) {
      return core.createTask(input, caller)
    },

    reserveWorkerDispatch(input: { taskId: TaskRow['id']; runId: RunId; retryOfDispatchId?: DispatchId }, caller) {
      return core.reserveWorkerDispatch(input, caller)
    },

    attachWorkerAuthority(dispatchId, identity, caller) {
      return core.attachWorkerAuthority(dispatchId, identity, caller)
    },

    mutateWorker<T extends object>(
      method: string,
      params: MutationRequest & object,
      caller: CoordinatorAuthority,
      operation: (store: OrchestrationCore['store']) => T,
      options
    ) {
      return core.mutateWorker(method, params, caller, operation, options)
    }
  }
  return coordinator
}
