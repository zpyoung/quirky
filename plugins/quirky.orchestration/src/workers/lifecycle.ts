import type { DispatchId, DispatchRow, DispatchStatus, DispatchTransitionInput, JsonValue, MutationCheckpoint, ResetMode, RuntimeCallerEvidence, TaskRow, UtcTimestamp, WorkerRow, WorkerState, WorkerTransitionInput } from '../contracts'
import type { PluginStore } from '@quirky/protocol'
import type {
  CoordinatorEvidence, ServiceCoordinatorEvidence, TerminalResource, WorkerArchive, WorkerControlParams, WorkerControlResult, WorkerCore,
  WorkerLifecycle, WorkerObservation, WorkerOutput, WorkerRecord, WorkerRepository, WorkerRuntime,
  WorkerUserInputParams
} from '../worker-contracts'
import type { SessionIdentity } from '../runtime-contracts'
import type { WorkerLifecyclePort } from '../worker-integration'

const FAILURE_BUDGET = 3
const ACTIVE_WORKER_STATES = new Set<WorkerState>(['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'])
const TERMINAL_WORKER_STATES = new Set<WorkerState>(['failed', 'succeeded', 'stopped', 'abandoned'])
const lifecycleByCore = new WeakMap<object, WorkerLifecycle>()

const utcNow = (): UtcTimestamp => new Date().toISOString()


function isExactIdentity(record: WorkerRecord, identity: SessionIdentity | null): identity is SessionIdentity {
  return identity !== null && record.sessionId !== null && record.processIncarnation !== null &&
    record.processRuntimeEpoch !== null &&
    identity.sessionId === record.sessionId &&
    identity.runtimeEpoch === record.processRuntimeEpoch &&
    identity.processIncarnation === record.processIncarnation
}

function resourceMatchesWorker(resource: TerminalResource, worker: WorkerRecord): boolean {
  return worker.sessionId !== null && worker.processIncarnation !== null &&
    resource.sessionId === worker.sessionId && resource.processIncarnation === worker.processIncarnation
}

function isExactCaller(record: WorkerRecord, dispatch: DispatchRow, caller: RuntimeCallerEvidence): boolean {
  return caller.runtimeOwned === true && caller.live === true && record.processRuntimeEpoch !== null &&
    caller.callerSessionId === record.sessionId &&
    caller.runtimeSessionId === record.sessionId &&
    caller.runtimeSessionId === dispatch.assigneeSessionId &&
    caller.attestation.runtimeEpoch === record.processRuntimeEpoch &&
    caller.attestation.processIncarnation === record.processIncarnation
}

function isServiceCoordinator(caller: CoordinatorEvidence): caller is ServiceCoordinatorEvidence {
  return 'kind' in caller && caller.kind === 'service'
}
function observationEvidence(observation: WorkerObservation): JsonValue {
  return {
    status: observation.status,
    exactWorker: observation.exactWorker,
    reason: observation.reason,
    identity: observation.identity ? {
      sessionId: observation.identity.sessionId,
      runtimeEpoch: observation.identity.runtimeEpoch,
      processIncarnation: observation.identity.processIncarnation,
      source: observation.identity.source,
      kind: observation.identity.kind,
      worktreeId: observation.identity.worktreeId,
      providerId: observation.identity.providerId
    } : null,
    ...(observation.agentWait === undefined ? {} : { agentWait: observation.agentWait })
  }
}


function canChangeWorkerState(state: WorkerState, nextState: WorkerState): boolean {
  if (state === 'starting') return ['ready', 'start_unknown', 'failed', 'stopping', 'stopped', 'abandoned'].includes(nextState)
  if (state === 'start_unknown') return ['ready', 'failed', 'stopping', 'stopped', 'abandoned'].includes(nextState)
  if (state === 'ready') return ['succeeded', 'failed', 'stopping', 'stopped', 'abandoned'].includes(nextState)
  if (state === 'stopping') return ['stopped', 'stop_unknown', 'ready', 'failed', 'abandoned'].includes(nextState)
  if (state === 'stop_unknown') return ['ready', 'failed', 'stopped', 'abandoned'].includes(nextState)
  return false
}

function finalDispatchStatus(status: DispatchStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'circuit_broken'
}

function isDeliberateExit(reason: string): boolean {
  return reason === 'operator_close' || reason === 'killed'
}

function releaseStateName(resource: TerminalResource): WorkerControlResult['state'] {
  if (resource.releaseState === 'released' || resource.ownershipState === 'released') return 'released'
  if (resource.releaseState === 'unknown') return 'release_unknown'
  if (resource.releaseState === 'requested' || resource.releaseState === 'releasing') return 'release_pending'
  return 'retained'
}
function workerRowFromRecord(record: WorkerRecord): WorkerRow {
  return {
    dispatchId: record.dispatchId,
    state: record.state,
    stage: record.stage,
    worktreeId: record.worktreeId,
    sessionId: record.sessionId,
    setupState: record.setupState,
    effects: record.effects,
    residualResources: record.residualResources,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

type ReleasePreparation =
  | { kind: 'result'; result: WorkerControlResult }
  | { kind: 'plan'; worker: WorkerRecord; dispatch: DispatchRow; resource: TerminalResource }


export function createWorkerLifecycle(
  core: WorkerCore,
  repo: WorkerRepository,
  runtime: WorkerRuntime,
  output: WorkerOutput
): WorkerLifecycle {
  const existing = lifecycleByCore.get(core)
  if (existing) return existing
  if (repo.store !== core.store) throw new Error('Worker lifecycle must use the core PluginStore')

  const stopFlights = new Map<DispatchId, Promise<WorkerControlResult>>()
  const releaseFlights = new Map<DispatchId, Promise<WorkerControlResult>>()
  let disposed = false
  let unregisterExit: (() => void) | null = null

  const assertStore = (store: WorkerRepository['store']): void => {
    if (store !== repo.store || store !== core.store) throw new Error('Worker lifecycle received a different PluginStore')
  }
  const recordRuntimeObservation = (dispatchId: DispatchId, facet: string, observation: WorkerObservation): void => {
    core.store.transaction(() => repo.addObservation(dispatchId, facet, observationEvidence(observation)))
  }
  const authorizeControl = (params: WorkerControlParams, caller: CoordinatorEvidence, dispatch: DispatchRow): void => {
    if (params.runId !== undefined && params.runId !== dispatch.runId) {
      throw core.context.error('conflict', 'The requested Run does not own this Dispatch.')
    }
    core.requireCoordinator(caller, dispatch.runId)
  }
  const acceptedWorkerControlCheckpoint = (dispatchId: DispatchId): MutationCheckpoint => {
    const dispatch = core.getDispatch(dispatchId)
    return {
      state: 'accepted',
      accepted: true,
      runId: dispatch.runId,
      taskId: dispatch.taskId,
      dispatchId: dispatch.id,
    }
  }

  const updateState = (dispatchId: DispatchId, expectedState: WorkerState, nextState: WorkerState): WorkerRecord => {
    if (!canChangeWorkerState(expectedState, nextState)) {
      throw new Error(`Unsupported worker transition ${expectedState} -> ${nextState}`)
    }
    core.transitionWorker({ dispatchId, expectedState, nextState } as WorkerTransitionInput)
    const after = repo.get(dispatchId)
    if (!after || after.state !== nextState) throw new Error(`Core did not persist worker transition ${dispatchId} to ${nextState}`)
    return after
  }

  const updateStage = (dispatchId: DispatchId, expectedState: WorkerState, patch: Partial<WorkerRecord>): WorkerRecord => {
    const current = repo.get(dispatchId)
    if (!current || current.state !== expectedState) throw new Error(`Worker ${dispatchId} changed before lifecycle stage update`)
    return repo.update(dispatchId, { ...patch, updatedAt: utcNow() }, expectedState)
  }

  const transitionDispatchFailure = (
    dispatch: DispatchRow,
    failureClass: 'infrastructure' | 'worker_report',
    failureReason: string,
    circuitBroken = false,
    terminationReason?: NonNullable<DispatchRow['terminationReason']>
  ): DispatchRow => {
    if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') return dispatch
    return core.transitionDispatch({
      dispatchId: dispatch.id,
      expectedState: dispatch.status,
      nextState: circuitBroken ? 'circuit_broken' : 'failed',
      failureClass,
      failureReason,
      ...(terminationReason === undefined ? {} : { terminationReason }),
      at: utcNow()
    } as DispatchTransitionInput)
  }

  const otherActiveAttempt = (taskId: TaskRow['id'], dispatchId: DispatchId): boolean =>
    core.listDispatches().some((candidate) =>
      candidate.taskId === taskId && candidate.id !== dispatchId &&
      (candidate.status === 'pending' || candidate.status === 'dispatched')
    )

  const setTaskAfterFence = (dispatch: DispatchRow, blockedWhenAlone: boolean): void => {
    const task = core.getTask(dispatch.taskId)
    const nextState = otherActiveAttempt(task.id, dispatch.id)
      ? 'dispatched'
      : blockedWhenAlone ? 'blocked' : 'ready'
    if (task.status !== nextState) core.transitionTask({ taskId: task.id, expectedState: task.status, nextState, at: utcNow() })
  }

  const setTaskAfterStopFence = (dispatch: DispatchRow): void => {
    const task = core.getTask(dispatch.taskId)
    const nextState = otherActiveAttempt(task.id, dispatch.id) ? 'dispatched' : 'blocked'
    if (task.status === nextState) return
    if (nextState === 'blocked') {
      core.blockTaskForWorkerStop({ taskId: task.id, dispatchId: dispatch.id, at: utcNow() })
    } else {
      core.transitionTask({ taskId: task.id, expectedState: task.status, nextState, at: utcNow() })
    }
  }

  const setControlDispatchFence = (dispatch: DispatchRow, reason: 'stopped' | 'abandoned'): void => {
    transitionDispatchFailure(dispatch, 'worker_report', reason)
    setTaskAfterFence(dispatch, true)
    core.closeWorkerQuestions(dispatch.id, utcNow())
  }
  const finishStopDispatch = (dispatchId: DispatchId): void => {
    const dispatch = core.getDispatch(dispatchId)
    transitionDispatchFailure(dispatch, 'worker_report', 'stopped', false, 'operator_close')
    setTaskAfterFence(core.getDispatch(dispatchId), true)
  }

  const settleStopped = (dispatchId: DispatchId, expected: 'stopping' | 'stop_unknown'): WorkerRecord | null => {
    const current = repo.get(dispatchId)
    if (!current || current.state === 'stopped') return current
    if (current.state !== expected) return current
    const transitioned = updateState(dispatchId, expected, 'stopped')
    return updateStage(dispatchId, 'stopped', { stage: 'stopped', lastError: null, updatedAt: transitioned.updatedAt })
  }

  const settleStopUnknown = (dispatchId: DispatchId, reason: string): WorkerRecord | null => {
    const current = repo.get(dispatchId)
    if (!current) return null
    if (current.state === 'stopping') updateState(dispatchId, 'stopping', 'stop_unknown')
    const latest = repo.get(dispatchId)
    if (!latest || latest.state !== 'stop_unknown') return latest
    return updateStage(dispatchId, 'stop_unknown', { stage: 'stop_unknown', lastError: reason })
  }

  const controlResult = (
    dispatchId: DispatchId,
    state: string,
    processAction: WorkerControlResult['processAction'],
    extra: Partial<WorkerControlResult> = {}
  ): WorkerControlResult => ({ dispatchId, state, processAction, ...extra })

  const markResourceRetained = (resource: TerminalResource, reason: string): TerminalResource => {
    if (resource.ownershipState !== 'owned' || resource.releaseState === 'releasing' || resource.releaseState === 'released') return resource
    const retained = {
      ...resource,
      releaseState: 'retained' as const,
      retainedReason: reason,
      releaseError: null
    }
    repo.putResource(retained)
    return retained
  }

  const makeContextOnlyFence = (dispatchId: DispatchId, reason: 'stopped' | 'abandoned'): WorkerControlResult => {
    const dispatch = core.getDispatch(dispatchId)
    if (dispatch.status === 'pending' || dispatch.status === 'dispatched') {
      setControlDispatchFence(dispatch, reason)
    }
    return controlResult(dispatchId, reason, 'none', {
      alreadySettled: finalDispatchStatus(dispatch.status),
      ...(reason === 'abandoned' ? { warning: 'Possibly-live resources were retained; no process was stopped or deleted.' } : {})
    })
  }

  const finishRelease = (dispatchId: DispatchId, expectedResourceId: string, alreadyExited: boolean): WorkerControlResult => {
    const current = repo.resource(dispatchId)
    const worker = repo.get(dispatchId)
    const identityMatches = current !== null && worker !== null && resourceMatchesWorker(current, worker)
    if (!current || current.id !== expectedResourceId || current.ownerDispatchId !== dispatchId ||
      current.ownershipState !== 'owned' || current.releaseState !== 'releasing' || !repo.archive(dispatchId) ||
      !identityMatches) {
      const reason = 'Release custody or process identity changed before completion.'
      if (current && current.id === expectedResourceId && current.ownerDispatchId === dispatchId &&
        current.ownershipState === 'owned' && current.releaseState === 'releasing' && !identityMatches) {
        repo.putResource({ ...current, releaseState: 'unknown', releaseError: reason })
        return controlResult(dispatchId, 'release_unknown', 'unknown', { lastError: reason })
      }
      return controlResult(dispatchId, current ? releaseStateName(current) : 'release_unknown', 'none', {
        lastError: 'Release custody changed before completion; the terminal was not closed.'
      })
    }
    const at = utcNow()
    repo.putResource({
      ...current,
      ownershipState: 'released',
      releaseState: 'released',
      releaseCompletedAt: at,
      releaseError: null,
      retainedReason: null
    })
    const archive = repo.archive(dispatchId)!
    return controlResult(dispatchId, 'released', alreadyExited ? 'none' : 'closed_agent_terminal', {
      archive: { source: archive.kind, status: archive.status }
    })
  }

  const releaseFailure = (
    resource: TerminalResource,
    state: 'requested' | 'releasing',
    status: 'release_pending' | 'release_unknown',
    reason: string
  ): WorkerControlResult => {
    const current = repo.resource(resource.ownerDispatchId)
    if (current?.id === resource.id && (current.releaseState === 'released' || current.ownershipState === 'released')) {
      return controlResult(resource.ownerDispatchId, 'already_released', 'none', { alreadySettled: true })
    }
    if (current?.id === resource.id && (current.ownerDispatchId !== resource.ownerDispatchId || current.ownershipState !== 'owned')) {
      return controlResult(resource.ownerDispatchId, 'retained', 'none', {
        warning: current.retainedReason ?? `Resource ownership is ${current.ownershipState}.`
      })
    }
    if (current?.id === resource.id && current.ownerDispatchId === resource.ownerDispatchId &&
      current.ownershipState === 'owned' &&
      (current.releaseState === state || current.releaseState === 'requested' || current.releaseState === 'releasing')) {
      repo.putResource({
        ...current,
        ...(status === 'release_unknown' ? { releaseState: 'unknown' as const } : {}),
        releaseError: reason
      })
    }
    return controlResult(resource.ownerDispatchId, status, status === 'release_unknown' ? 'unknown' : 'none', {
      lastError: reason,
      ...(status === 'release_unknown' ? { warning: 'Inspect with worker-show and retry with a fresh request ID; do not close the terminal directly.' } : {})
    })
  }

  const exactObservation = (record: WorkerRecord, observation: WorkerObservation): boolean =>
    observation.exactWorker === true && isExactIdentity(record, observation.identity)

  const prepareRelease = (
    dispatchId: DispatchId,
    recovery: boolean,
    params?: WorkerControlParams,
    caller?: CoordinatorEvidence
  ): ReleasePreparation => core.store.transaction(() => {
    const worker = repo.get(dispatchId)
    const dispatch = core.getDispatch(dispatchId)
    if (!recovery) {
      if (!params || !caller) throw new Error('A user release requires its coordinator request.')
      authorizeControl(params, caller, dispatch)
    }
    const resource = repo.resource(dispatchId)
    if (!worker || !resource) {
      return { kind: 'result', result: controlResult(dispatchId, 'retained', 'none', { lastError: 'No owned terminal resource is available.' }) }
    }
    if (resource.releaseState === 'released' || resource.ownershipState === 'released') {
      return { kind: 'result', result: controlResult(dispatchId, 'already_released', 'none', { alreadySettled: true }) }
    }
    if (worker.state === 'stopped' || worker.state === 'abandoned') {
      const retained = markResourceRetained(resource, 'identity_unproven')
      return { kind: 'result', result: controlResult(dispatchId, 'retained', 'none', { warning: retained.retainedReason ?? 'identity_unproven' }) }
    }
    if (worker.state !== 'succeeded' && worker.state !== 'failed') {
      if (recovery) {
        return { kind: 'result', result: controlResult(dispatchId, 'release_pending', 'none', { lastError: 'The worker has not reached an accepted outcome.' }) }
      }
      throw core.context.error('conflict', 'Worker release requires an accepted succeeded or failed outcome.')
    }
    if (!finalDispatchStatus(dispatch.status)) {
      if (recovery) return { kind: 'result', result: controlResult(dispatchId, 'release_pending', 'none', { lastError: 'The Dispatch is not settled.' }) }
      throw core.context.error('conflict', 'Worker release requires a settled Dispatch.')
    }
    if (resource.ownershipState !== 'owned' || resource.ownerDispatchId !== dispatchId) {
      return { kind: 'result', result: controlResult(dispatchId, 'retained', 'none', { warning: resource.retainedReason ?? `Resource ownership is ${resource.ownershipState}.` }) }
    }
    if (!resourceMatchesWorker(resource, worker)) {
      const reason = 'The terminal resource no longer matches the worker process incarnation.'
      repo.putResource({
        ...resource,
        releaseState: 'unknown',
        releaseRequestedAt: resource.releaseRequestedAt ?? utcNow(),
        releaseError: reason
      })
      return { kind: 'result', result: controlResult(dispatchId, 'release_unknown', 'unknown', { lastError: reason }) }
    }
    if (resource.releaseState === 'retained') {
      return { kind: 'result', result: controlResult(dispatchId, 'retained', 'none', { warning: resource.retainedReason ?? 'The resource was retained.' }) }
    }
    if (resource.releaseState !== 'requested' && !(resource.releaseState === 'releasing' && repo.archive(dispatchId))) {
      const requested = {
        ...resource,
        releaseState: 'requested' as const,
        releaseRequestedAt: utcNow(),
        releaseError: null
      }
      repo.putResource(requested)
      return { kind: 'plan', worker, dispatch, resource: requested }
    }
    return { kind: 'plan', worker, dispatch, resource }
  })

  const completeRelease = async (plan: Extract<ReleasePreparation, { kind: 'plan' }>): Promise<WorkerControlResult> => {
    if (disposed) return controlResult(plan.worker.dispatchId, 'release_pending', 'none', { lastError: 'Lifecycle disposed before the requested release could complete.' })
    let { worker, dispatch, resource } = plan

    let observation: WorkerObservation
    try {
      observation = await runtime.observe(worker, dispatch)
      if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: 'Lifecycle disposed before release identity could be persisted.' })
      recordRuntimeObservation(worker.dispatchId, 'release_identity', observation)
    } catch (error) {
      if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: errorMessage(error) })
      return releaseFailure(resource, resource.releaseState === 'releasing' ? 'releasing' : 'requested', 'release_pending', errorMessage(error))
    }
    if (!exactObservation(worker, observation)) {
      const changed = observation.status === 'identity_changed' || observation.status === 'missing' || observation.status === 'exited'
      const state = resource.releaseState === 'releasing' ? 'releasing' : 'requested'
      return releaseFailure(resource, state, changed ? 'release_unknown' : 'release_pending', observation.reason ?? 'The exact worker incarnation could not be proven.')
    }
    if (observation.status !== 'live' && observation.status !== 'exited') {
      const state = resource.releaseState === 'releasing' ? 'releasing' : 'requested'
      return releaseFailure(resource, state, 'release_pending', observation.reason ?? 'The exact worker process is not currently verifiable.')
    }

    let archive = repo.archive(worker.dispatchId)
    if (archive && archive.resourceId !== resource.id) {
      return releaseFailure(resource, resource.releaseState === 'releasing' ? 'releasing' : 'requested', 'release_unknown', 'The frozen archive belongs to a different terminal resource.')
    }
    if (!archive) {
      try {
        archive = await output.capture(worker.dispatchId)
        if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: 'Lifecycle disposed during output capture; the resource remains open.' })
      } catch (error) {
        if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: errorMessage(error) })
        return releaseFailure(resource, 'requested', 'release_pending', errorMessage(error))
      }
      if (archive.dispatchId !== worker.dispatchId || archive.resourceId !== resource.id || archive.sourceIdentity.length === 0 ||
        (archive.status === 'captured' && archive.content.length === 0)) {
        return releaseFailure(resource, 'requested', 'release_unknown', 'Output capture did not prove non-empty output for the exact worker resource.')
      }
    }

    try {
      core.store.transaction(() => {
        const current = repo.resource(worker.dispatchId)
        if (!current || current.id !== resource.id || current.ownerDispatchId !== worker.dispatchId ||
          current.ownershipState !== 'owned' || !resourceMatchesWorker(current, worker) ||
          current.releaseState === 'retained' || current.releaseState === 'released') {
          throw new Error('Worker terminal custody changed while output was being archived')
        }
        repo.putArchive(archive!)
        repo.putResource({
          ...current,
          releaseState: 'releasing',
          releaseError: null,
          archiveSource: archive!.kind,
          archiveStatus: archive!.status
        })
      })
    } catch (error) {
      const latest = repo.resource(worker.dispatchId)
      if (latest?.ownershipState === 'user_owned' || latest?.releaseState === 'retained') {
        return controlResult(worker.dispatchId, 'retained', 'none', { warning: latest.retainedReason ?? 'The resource was retained during release.' })
      }
      return releaseFailure(resource, 'requested', 'release_unknown', errorMessage(error))
    }

    worker = repo.get(worker.dispatchId)!
    dispatch = core.getDispatch(worker.dispatchId)
    resource = repo.resource(worker.dispatchId)!
    try {
      observation = await runtime.observe(worker, dispatch)
      if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: 'Lifecycle disposed before the final identity check.' })
      recordRuntimeObservation(worker.dispatchId, 'release_preclose', observation)
    } catch (error) {
      if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: errorMessage(error) })
      return releaseFailure(resource, 'releasing', 'release_pending', errorMessage(error))
    }
    if (!exactObservation(worker, observation)) {
      const changed = observation.status === 'identity_changed' || observation.status === 'missing' || observation.status === 'exited'
      return releaseFailure(resource, 'releasing', changed ? 'release_unknown' : 'release_pending', observation.reason ?? 'The exact worker incarnation changed before close.')
    }
    if (observation.status === 'exited') return finishRelease(worker.dispatchId, resource.id, true)
    if (observation.status !== 'live') {
      return releaseFailure(resource, 'releasing', 'release_pending', observation.reason ?? 'The exact worker process is not live enough to close safely.')
    }

    const current = repo.resource(worker.dispatchId)
    if (!current || current.id !== resource.id || current.ownerDispatchId !== worker.dispatchId ||
      current.ownershipState !== 'owned' || !resourceMatchesWorker(current, worker) || current.releaseState !== 'releasing') {
      return controlResult(worker.dispatchId, 'retained', 'none', { warning: current?.retainedReason ?? 'Terminal custody changed before close.' })
    }
    try {
      if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'none', { lastError: 'Lifecycle disposed before terminal close.' })
      const closed = await runtime.close(current)
      if (disposed) {
        return controlResult(worker.dispatchId, 'release_pending', closed.closed ? 'closed_agent_terminal' : 'unknown', {
          lastError: 'Lifecycle disposed before release completion could be recorded.'
        })
      }
      core.store.transaction(() => repo.addObservation(worker.dispatchId, 'release_close', {
        resourceId: current.id,
        processIncarnation: current.processIncarnation,
        confirmed: closed.closed,
        reason: closed.reason ?? null
      }))
      if (!closed.closed) {
        const uncertain = /identity|incarnation|changed|missing|unproven|ownership|not owned/i.test(closed.reason ?? '')
        return releaseFailure(current, 'releasing', uncertain ? 'release_unknown' : 'release_pending', closed.reason ?? 'The terminal close was not confirmed.')
      }
    } catch (error) {
      if (disposed) return controlResult(worker.dispatchId, 'release_pending', 'unknown', { lastError: errorMessage(error) })
      core.store.transaction(() => repo.addObservation(worker.dispatchId, 'release_close', {
        resourceId: current.id,
        processIncarnation: current.processIncarnation,
        confirmed: false,
        reason: errorMessage(error)
      }))
      return releaseFailure(current, 'releasing', 'release_pending', errorMessage(error))
    }
    return finishRelease(worker.dispatchId, resource.id, false)
  }

  const coalesceReleaseEffect = (plan: Extract<ReleasePreparation, { kind: 'plan' }>): Promise<WorkerControlResult> => {
    const dispatchId = plan.worker.dispatchId
    const active = releaseFlights.get(dispatchId)
    if (active) return active
    const operation = completeRelease(plan)
    releaseFlights.set(dispatchId, operation)
    void operation.then(
      () => { if (releaseFlights.get(dispatchId) === operation) releaseFlights.delete(dispatchId) },
      () => { if (releaseFlights.get(dispatchId) === operation) releaseFlights.delete(dispatchId) }
    )
    return operation
  }

  const prepareStop = (params: WorkerControlParams, caller: CoordinatorEvidence): { shouldAttempt: boolean; result: WorkerControlResult } =>
    core.store.transaction(() => {
      const dispatch = core.getDispatch(params.dispatchId)
      authorizeControl(params, caller, dispatch)
      const resource = repo.resource(params.dispatchId)
      const serviceCaller = isServiceCoordinator(caller)
      if (serviceCaller && !params.expectedIdentity) {
        throw core.context.error('invalid-params', 'Service worker-stop requires the exact expected terminal identity.')
      }
      if (params.expectedIdentity && (!resource ||
        resource.sessionId !== params.expectedIdentity.sessionId ||
        resource.processIncarnation !== params.expectedIdentity.processIncarnation)) {
        throw core.context.error('conflict', 'The expected worker terminal incarnation no longer matches this Dispatch.')
      }
      if (serviceCaller && (!resource || resource.ownerDispatchId !== params.dispatchId)) {
        throw core.context.error('conflict', 'The service stop request does not own this terminal resource.')
      }
      const worker = repo.get(params.dispatchId)
      if (!worker) {
        if (finalDispatchStatus(dispatch.status)) {
          return { shouldAttempt: false, result: controlResult(params.dispatchId, 'failed', 'none', { alreadySettled: true }) }
        }
        setControlDispatchFence(dispatch, 'stopped')
        return {
          shouldAttempt: false,
          result: controlResult(params.dispatchId, 'stopped', 'none', { warning: 'This Dispatch has no supervised process; no terminal was touched.' })
        }
      }
      if (finalDispatchStatus(dispatch.status)) {
        if (ACTIVE_WORKER_STATES.has(worker.state)) {
          updateState(params.dispatchId, worker.state, 'abandoned')
          updateStage(params.dispatchId, 'abandoned', {
            stage: 'assignment_settled',
            lastError: 'The Dispatch settled before the worker lifecycle could stop it.'
          })
          const settledResource = repo.resource(params.dispatchId)
          if (settledResource && settledResource.ownerDispatchId === params.dispatchId) {
            markResourceRetained(settledResource, 'assignment_settled')
          }
        }
        return {
          shouldAttempt: false,
          result: controlResult(params.dispatchId, repo.get(params.dispatchId)?.state ?? worker.state, 'none', { alreadySettled: true })
        }
      }
      if (TERMINAL_WORKER_STATES.has(worker.state)) {
        return { shouldAttempt: false, result: controlResult(params.dispatchId, worker.state, 'none', { alreadySettled: true }) }
      }
      let current = worker
      if (current.state === 'starting' || current.state === 'ready' || current.state === 'start_unknown') {
        current = updateState(params.dispatchId, current.state, 'stopping')
        current = updateStage(params.dispatchId, 'stopping', {
          stage: 'stopping', runtimeEpoch: runtime.epoch, lastError: null
        })
      } else if (current.state === 'stop_unknown') {
        current = repo.update(params.dispatchId, { runtimeEpoch: runtime.epoch, stage: 'stopping', updatedAt: utcNow() }, 'stop_unknown')
      }
      setTaskAfterStopFence(dispatch)
      return {
        shouldAttempt: true,
        result: controlResult(params.dispatchId, current.state, 'unknown')
      }
    })

  const completeStop = async (dispatchId: DispatchId): Promise<WorkerControlResult> => {
    if (disposed) return controlResult(dispatchId, 'stop_unknown', 'unknown', { lastError: 'Lifecycle disposed before stop could inspect the exact target.' })
    const worker = repo.get(dispatchId)
    const dispatch = core.getDispatch(dispatchId)
    const resource = repo.resource(dispatchId)
    if (!worker || !resource || worker.processIncarnation === null || worker.sessionId === null ||
      resource.ownerDispatchId !== dispatchId || resource.ownershipState !== 'owned' ||
      resource.sessionId !== worker.sessionId || resource.processIncarnation !== worker.processIncarnation) {
      const reason = 'The exact owned worker terminal incarnation is unavailable; no terminal was closed.'
      const unknown = core.store.transaction(() => {
        const result = settleStopUnknown(dispatchId, reason)
        return result
      })
      return controlResult(dispatchId, unknown?.state ?? 'stop_unknown', 'unknown', { lastError: reason })
    }

    let observation: WorkerObservation
    try {
      observation = await runtime.observe(worker, dispatch)
      if (disposed) return controlResult(dispatchId, 'stop_unknown', 'unknown', { lastError: 'Lifecycle disposed before stop identity could be persisted.' })
      recordRuntimeObservation(dispatchId, 'stop_identity', observation)
    } catch (error) {
      if (disposed) return controlResult(dispatchId, 'stop_unknown', 'unknown', { lastError: errorMessage(error) })
      const reason = errorMessage(error)
      const unknown = core.store.transaction(() => {
        const result = settleStopUnknown(dispatchId, reason)
        return result
      })
      return controlResult(dispatchId, unknown?.state ?? 'stop_unknown', 'unknown', { lastError: reason })
    }
    if (!exactObservation(worker, observation) ||
      (observation.status !== 'live' && observation.status !== 'unverifiable' &&
        !(worker.mode === 'structured' && observation.status === 'exited'))) {
      const reason = observation.reason ?? (observation.status === 'exited'
        ? 'The recorded worker process is exited; no terminal was closed.'
        : 'The exact worker process could not be proven; no terminal was closed.')
      const unknown = core.store.transaction(() => {
        const result = settleStopUnknown(dispatchId, reason)
        return result
      })
      return controlResult(dispatchId, unknown?.state ?? 'stop_unknown', 'unknown', { lastError: reason })
    }

    const current = repo.resource(dispatchId)
    if (!current || current.id !== resource.id || current.ownerDispatchId !== dispatchId ||
      current.ownershipState !== 'owned' || current.processIncarnation !== worker.processIncarnation) {
      const reason = 'Terminal custody changed before close; no terminal was closed.'
      const unknown = core.store.transaction(() => {
        const result = settleStopUnknown(dispatchId, reason)
        return result
      })
      return controlResult(dispatchId, unknown?.state ?? 'stop_unknown', 'unknown', { lastError: reason })
    }
    try {
      if (disposed) return controlResult(dispatchId, 'stop_unknown', 'unknown', { lastError: 'Lifecycle disposed before terminal close.' })
      const result = await runtime.close(current)
      if (disposed) {
        return controlResult(dispatchId, 'stop_unknown', result.closed ? 'closed_agent_terminal' : 'unknown', {
          lastError: 'Lifecycle disposed before stop completion could be recorded.'
        })
      }
      core.store.transaction(() => repo.addObservation(dispatchId, 'stop_close', {
        resourceId: current.id,
        processIncarnation: current.processIncarnation,
        confirmed: result.closed,
        reason: result.reason ?? null
      }))
      if (!result.closed) {
        const updated = repo.get(dispatchId)
        if (updated?.state === 'stopped') return controlResult(dispatchId, 'stopped', 'closed_agent_terminal')
        const reason = result.reason ?? 'The runtime did not confirm that the worker terminal was killed.'
        const unknown = core.store.transaction(() => {
          const settled = settleStopUnknown(dispatchId, reason)
          return settled
        })
        return controlResult(dispatchId, unknown?.state ?? 'stop_unknown', 'unknown', { lastError: reason })
      }
    } catch (error) {
      if (disposed) return controlResult(dispatchId, 'stop_unknown', 'unknown', { lastError: errorMessage(error) })
      core.store.transaction(() => repo.addObservation(dispatchId, 'stop_close', {
        resourceId: current.id,
        processIncarnation: current.processIncarnation,
        confirmed: false,
        reason: errorMessage(error)
      }))
      const updated = repo.get(dispatchId)
      if (updated?.state === 'stopped') return controlResult(dispatchId, 'stopped', 'closed_agent_terminal')
      const reason = errorMessage(error)
      const unknown = core.store.transaction(() => {
        const settled = settleStopUnknown(dispatchId, reason)
        return settled
      })
      return controlResult(dispatchId, unknown?.state ?? 'stop_unknown', 'unknown', { lastError: reason })
    }

    const stopped = core.store.transaction(() => {
      const latest = repo.get(dispatchId)
      if (latest?.state === 'stopping') settleStopped(dispatchId, 'stopping')
      else if (latest?.state === 'stop_unknown') settleStopped(dispatchId, 'stop_unknown')
      finishStopDispatch(dispatchId)
      return repo.get(dispatchId)
    })
    if (stopped?.state === 'stopped') return controlResult(dispatchId, 'stopped', 'closed_agent_terminal')
    return controlResult(dispatchId, stopped?.state ?? 'stop_unknown', 'unknown', {
      lastError: stopped?.lastError ?? 'The worker state changed before close confirmation was recorded.'
    })
  }
  const coalesceStopEffect = (dispatchId: DispatchId): Promise<WorkerControlResult> => {
    const active = stopFlights.get(dispatchId)
    if (active) return active
    const operation = completeStop(dispatchId)
    stopFlights.set(dispatchId, operation)
    void operation.then(
      () => { if (stopFlights.get(dispatchId) === operation) stopFlights.delete(dispatchId) },
      () => { if (stopFlights.get(dispatchId) === operation) stopFlights.delete(dispatchId) }
    )
    return operation
  }

  const abandonInternal = (params: WorkerControlParams, caller: CoordinatorEvidence): WorkerControlResult =>
    core.store.transaction(() => {
      const dispatch = core.getDispatch(params.dispatchId)
      authorizeControl(params, caller, dispatch)
      const worker = repo.get(params.dispatchId)
      if (!worker) return makeContextOnlyFence(params.dispatchId, 'abandoned')
      if (worker.runtimeEpoch === runtime.epoch &&
        (worker.state === 'stopping' || (worker.state === 'stop_unknown' && worker.stage === 'stopping'))) {
        throw core.context.error('conflict', 'Cannot abandon while this runtime is stopping the worker.')
      }
      if (TERMINAL_WORKER_STATES.has(worker.state)) {
        return controlResult(params.dispatchId, worker.state, 'none', { alreadySettled: true })
      }
      if (finalDispatchStatus(dispatch.status)) {
        updateState(params.dispatchId, worker.state, 'abandoned')
        updateStage(params.dispatchId, 'abandoned', {
          stage: 'assignment_settled',
          lastError: 'The Dispatch settled before the worker could be abandoned.'
        })
        const settledResource = repo.resource(params.dispatchId)
        if (settledResource && settledResource.ownerDispatchId === params.dispatchId) {
          markResourceRetained(settledResource, 'assignment_settled')
        }
        return controlResult(params.dispatchId, 'abandoned', 'none', { alreadySettled: true })
      }
      updateState(params.dispatchId, worker.state, 'abandoned')
      updateStage(params.dispatchId, 'abandoned', {
        stage: 'abandoned',
        lastError: `${worker.lastError ? `${worker.lastError}\\n` : ''}Abandoned by ${isServiceCoordinator(caller) ? caller.pluginId : caller.callerSessionId}.`
      })
      setControlDispatchFence(dispatch, 'abandoned')
      const resource = repo.resource(params.dispatchId)
      if (resource && resource.ownerDispatchId === params.dispatchId) markResourceRetained(resource, 'abandoned')
      return controlResult(params.dispatchId, 'abandoned', 'none', {
        warning: 'Possibly-live resources were retained; no process was stopped or deleted.'
      })
    })

  const hasLiveForTask = (store: PluginStore, taskId: TaskRow['id']): boolean => {
    assertStore(store)
    return core.listDispatches().some((dispatch) => {
      if (dispatch.taskId !== taskId || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) return false
      const worker = repo.get(dispatch.id)
      return worker !== null && ACTIVE_WORKER_STATES.has(worker.state)
    })
  }

  const stateForDispatch = (store: WorkerRepository['store'], dispatchId: DispatchId): WorkerState | null => {
    assertStore(store)
    return repo.get(dispatchId)?.state ?? null
  }
  const workerForDispatch = (store: PluginStore, dispatchId: DispatchId): WorkerRow | null => {
    assertStore(store)
    const worker = repo.get(dispatchId)
    return worker ? workerRowFromRecord(worker) : null
  }

  const transitionWorkerHook = (store: PluginStore, input: WorkerTransitionInput): WorkerRow => {
    assertStore(store)
    const worker = repo.get(input.dispatchId)
    if (!worker || worker.state !== input.expectedState) {
      throw core.context.error('conflict', `Worker ${input.dispatchId} no longer has state ${input.expectedState}.`)
    }
    if (input.expectedState === 'failed') {
      const dispatch = core.getDispatch(input.dispatchId)
      if (input.nextState !== 'succeeded' || input.correction !== 'unobserved_prompt_report' ||
        worker.stage !== 'turn_unobserved' || input.report.dispatchId !== input.dispatchId ||
        input.report.taskId !== dispatch.taskId || input.report.outcome !== 'succeeded' ||
        !isExactCaller(worker, dispatch, input.caller)) {
        throw core.context.error('conflict', 'Only an exact unobserved-prompt report can correct this failed worker.')
      }
    } else if (!canChangeWorkerState(input.expectedState, input.nextState)) {
      throw core.context.error('conflict', `Unsupported worker transition ${input.expectedState} to ${input.nextState}.`)
    }
    const patch: Partial<WorkerRecord> = { state: input.nextState, updatedAt: utcNow() }
    if (input.expectedState === 'failed') {
      patch.stage = 'succeeded'
      patch.lastError = null
    }
    const updated = repo.update(input.dispatchId, patch, input.expectedState)
    return workerRowFromRecord(updated)
  }

  const reset = (store: PluginStore, mode: ResetMode, _at: UtcTimestamp): void => {
    assertStore(store)
    if (mode === 'messages') return
    store.run('DELETE FROM worker_observations')
    store.run('DELETE FROM worker_terminal_archives')
    store.run('DELETE FROM worker_terminal_resources')
    store.run('DELETE FROM worker_dispatches')
  }


  const settleDispatch = (
    store: WorkerRepository['store'],
    dispatchId: DispatchId,
    status: DispatchStatus,
    at: UtcTimestamp
  ): void => {
    assertStore(store)
    if (!finalDispatchStatus(status)) return
    const dispatch = core.getDispatch(dispatchId)
    if (dispatch.status !== status) return
    const worker = repo.get(dispatchId)
    if (!worker || !ACTIVE_WORKER_STATES.has(worker.state)) return
    if (worker.state === 'stopping') return
    const outcome = status === 'completed' ? 'succeeded' : 'failed'
    let current = worker
    if (current.state === 'starting' || current.state === 'start_unknown') {
      current = updateState(dispatchId, current.state, 'ready')
    }
    if (current.state === 'ready') updateState(dispatchId, 'ready', outcome)
    const settled = repo.get(dispatchId)
    if (settled && settled.state === outcome) {
      updateStage(dispatchId, outcome, {
        stage: outcome,
        updatedAt: at,
        ...(status === 'completed' || dispatch.lastFailure === 'worker_report' ? { lastError: null } : {})
      })
    }
  }

  const acceptReport: WorkerLifecyclePort['acceptReport'] = (store, input) => {
    assertStore(store)
    let dispatch: DispatchRow
    try {
      dispatch = core.getDispatch(input.dispatchId)
    } catch {
      return null
    }
    const worker = repo.get(input.dispatchId)
    if (!worker || !isExactCaller(worker, dispatch, input.caller)) return null
    if (worker.state === 'stopping' || (worker.state === 'stop_unknown' && worker.stage === 'stopping') ||
      worker.state === 'stopped' || worker.state === 'abandoned') return null

    let current = worker
    if (current.state === 'starting' || current.state === 'start_unknown' || current.state === 'stop_unknown') {
      current = updateState(dispatch.id, current.state, 'ready')
    }
    if (current.state === 'ready') {
      current = updateState(dispatch.id, 'ready', input.outcome)
      const receipt = current.receipt ? {
        ...current.receipt,
        state: 'ready' as const,
        stage: 'settled',
        workerOutcome: input.outcome,
      } : null
      current = updateStage(dispatch.id, input.outcome, { stage: 'settled', lastError: null, receipt })
    } else if (current.state !== input.outcome) {
      return null
    }

    repo.addObservation(dispatch.id, 'completion_report', {
      outcome: input.outcome,
      at: input.at,
      processIncarnation: current.processIncarnation
    })
    return current
  }

  const recordHeartbeat: WorkerLifecyclePort['recordHeartbeat'] = (store, input) => {
    assertStore(store)
    const worker = repo.get(input.dispatchId)
    if (!worker || worker.state !== 'ready' || !worker.sessionId || !worker.processIncarnation) return
    let dispatch: DispatchRow
    try {
      dispatch = core.getDispatch(input.dispatchId)
      if (dispatch.status !== 'dispatched' || !isExactCaller(worker, dispatch, input.caller)) return
    } catch {
      return
    }
    core.store.transaction(() => {
      const current = repo.get(input.dispatchId)
      if (!current || current.state !== 'ready' || current.processIncarnation !== worker.processIncarnation ||
        current.runtimeEpoch !== worker.runtimeEpoch) return
      repo.addObservation(input.dispatchId, 'heartbeat', { at: input.at })
    })
  }

  const onExit = (sessionId: string, incarnation: string | null, reason: string, exitCode: number | null): void => {
    if (disposed || incarnation === null) return
    const worker = repo.list().find((candidate) => candidate.sessionId === sessionId && candidate.processIncarnation === incarnation)
    if (!worker) return
    const resource = repo.resource(worker.dispatchId)
    if (resource && resource.processIncarnation !== incarnation) return

    core.store.transaction(() => {
      const current = repo.get(worker.dispatchId)
      if (!current || current.sessionId !== sessionId || current.processIncarnation !== incarnation ||
        TERMINAL_WORKER_STATES.has(current.state)) return
      const dispatch = core.getDispatch(current.dispatchId)
      const stopInThisRuntime = current.runtimeEpoch === runtime.epoch &&
        (current.state === 'stopping' || (current.state === 'stop_unknown' && current.stage === 'stopping') ||
          stopFlights.has(current.dispatchId))
      if (stopInThisRuntime && (current.state === 'stopping' || current.state === 'stop_unknown')) {
        repo.addObservation(current.dispatchId, 'process_exit', {
          sessionId,
          incarnation,
          reason,
          exitCode,
          runtimeEpoch: current.runtimeEpoch
        })
        settleStopped(current.dispatchId, current.state)
        finishStopDispatch(current.dispatchId)
        return
      }
      if (finalDispatchStatus(dispatch.status)) return
      repo.addObservation(current.dispatchId, 'process_exit', {
        sessionId,
        incarnation,
        reason,
        exitCode,
        runtimeEpoch: current.runtimeEpoch
      })
      const task = core.getTask(dispatch.taskId)
      const failure = `Worker process exited (${reason}) with exit code ${exitCode === null ? 'unknown' : exitCode}.`
      if (current.state !== 'failed') {
        updateState(current.dispatchId, current.state, 'failed')
        updateStage(current.dispatchId, 'failed', { stage: 'process_exited', lastError: failure })
      }
      const circuitBroken = dispatch.failureCount + 1 >= FAILURE_BUDGET
      const terminationReason = reason === 'operator_close' || reason === 'killed' ? 'operator_close'
        : reason === 'signaled' ? 'signaled' : reason === 'exited' ? 'exited' : 'unknown'
      const settledDispatch = transitionDispatchFailure(dispatch, 'infrastructure', 'process_exited', circuitBroken, terminationReason)
      const nextTaskState = otherActiveAttempt(task.id, dispatch.id)
        ? 'dispatched'
        : settledDispatch.status === 'circuit_broken' ? 'failed' : 'ready'
      const latestTask = core.getTask(task.id)
      if (latestTask.status !== nextTaskState) {
        core.transitionTask({ taskId: task.id, expectedState: latestTask.status, nextState: nextTaskState, at: utcNow() })
      }
      core.closeWorkerQuestions(dispatch.id, utcNow())
      if (!isDeliberateExit(reason)) {
        const title = task.displayName.trim() || task.taskTitle.trim() || task.id
        const disposition = settledDispatch.status === 'circuit_broken'
          ? 'The task failed too many times and will not be retried automatically.'
          : 'The task is ready to be dispatched again.'
        core.emitWorkerStatus(
          dispatch.id,
          `Agent exited unexpectedly (${reason})`,
          `Worker ${sessionId} stopped while running task "${title}" (${task.id}). ${reason}. ${disposition}`,
          true,
          'escalation',
          { taskId: task.id, dispatchId: dispatch.id, exitCode, exitCause: reason, handle: sessionId }
        )
      }
    })
  }

  const userInput = (params: WorkerUserInputParams): { takenOver: boolean } => {
    if (disposed) return { takenOver: false }
    return core.store.transaction(() => {
      const resource = repo.resourceBySession(params.session)
      if (!resource || resource.sessionId !== params.session || resource.processIncarnation !== params.expectedIncarnation) return { takenOver: false }
      const worker = repo.get(resource.ownerDispatchId)
      if (!worker || worker.sessionId !== params.session || worker.processIncarnation !== params.expectedIncarnation ||
        worker.state === 'stopping' || (worker.state === 'stop_unknown' && worker.stage === 'stopping')) {
        return { takenOver: false }
      }
      if (resource.ownershipState === 'user_owned' && resource.releaseState === 'retained' && resource.retainedReason === 'user_takeover') {
        return { takenOver: true }
      }
      if (resource.ownershipState !== 'owned' || resource.releaseState === 'releasing' ||
        resource.releaseState === 'released') return { takenOver: false }
      repo.putResource({
        ...resource,
        ownershipState: 'user_owned',
        releaseState: 'retained',
        retainedReason: 'user_takeover',
        releaseError: null
      })
      repo.addObservation(resource.ownerDispatchId, 'user_takeover', {
        sessionId: params.session,
        processIncarnation: params.expectedIncarnation
      })
      for (const dispatchId of new Set([resource.ownerDispatchId, resource.originDispatchId, ...resource.priorOwnerDispatchIds])) {
        repo.deleteArchive(dispatchId)
      }
      return { takenOver: true }
    })
  }

  const stop = (params: WorkerControlParams, caller: CoordinatorEvidence) => {
    if (disposed) return Promise.reject(new Error('Worker lifecycle is disposed'))
    const attempt = { shouldAttempt: false }
    return Promise.resolve().then(() => core.mutateWorker(
      'workerStop',
      params,
      caller,
      (store) => {
        assertStore(store)
        const prepared = prepareStop(params, caller)
        attempt.shouldAttempt = prepared.shouldAttempt
        return prepared.result
      },
      {
        acceptedCheckpoint: accepted => acceptedWorkerControlCheckpoint(accepted.dispatchId),
        afterCommit: (accepted) => attempt.shouldAttempt ? coalesceStopEffect(params.dispatchId) : accepted
      }
    ))
  }

  const abandon = (params: WorkerControlParams, caller: CoordinatorEvidence) => {
    if (disposed) return Promise.reject(new Error('Worker lifecycle is disposed'))
    return core.mutateWorker('workerAbandon', params, caller, (store) => {
      assertStore(store)
      return abandonInternal(params, caller)
    })
  }

  const release = (params: WorkerControlParams, caller: CoordinatorEvidence) => {
    if (disposed) return Promise.reject(new Error('Worker lifecycle is disposed'))
    const attempt: { preparation?: ReleasePreparation } = {}
    return Promise.resolve().then(() => core.mutateWorker(
      'workerRelease',
      params,
      caller,
      (store) => {
        assertStore(store)
        const preparation = prepareRelease(params.dispatchId, false, params, caller)
        attempt.preparation = preparation
        return preparation.kind === 'result'
          ? preparation.result
          : controlResult(params.dispatchId, 'release_pending', 'none')
      },
      {
        acceptedCheckpoint: accepted => acceptedWorkerControlCheckpoint(accepted.dispatchId),
        afterCommit: (accepted) => {
          const preparation = attempt.preparation
          if (!preparation) return accepted
          return preparation.kind === 'result' ? preparation.result : coalesceReleaseEffect(preparation)
        }
      }
    ))
  }

  const retain = (params: WorkerControlParams, caller: CoordinatorEvidence) => {
    if (disposed) return Promise.reject(new Error('Worker lifecycle is disposed'))
    return core.mutateWorker(
      'workerRetain',
      params,
      caller,
      (store) => {
        assertStore(store)
        return core.store.transaction(() => {
          const dispatch = core.getDispatch(params.dispatchId)
          authorizeControl(params, caller, dispatch)
          const worker = repo.get(params.dispatchId)
          const resource = repo.resource(params.dispatchId)
          if (!worker || !resource) return controlResult(params.dispatchId, 'retained', 'none')
          if (resource.releaseState === 'released' || resource.ownershipState === 'released' || resource.releaseState === 'releasing') {
            return controlResult(params.dispatchId, releaseStateName(resource) === 'released' ? 'released' : 'releasing', 'none', {
              alreadySettled: resource.releaseState === 'released' || resource.ownershipState === 'released'
            })
          }
          if (resource.ownerDispatchId === params.dispatchId && resource.ownershipState === 'owned') {
            repo.putResource({ ...resource, releaseState: 'retained', retainedReason: 'user_requested', releaseError: null })
          }
          return controlResult(params.dispatchId, 'retained', 'none')
        })
      }
    )
  }

  const recoverReleases = async (): Promise<void> => {
    if (disposed) return
    for (const worker of repo.list()) {
      if (disposed) return
      const resource = repo.resource(worker.dispatchId)
      if (!resource || resource.ownerDispatchId !== worker.dispatchId ||
        (resource.releaseState !== 'requested' && resource.releaseState !== 'releasing')) continue
      try {
        const preparation = prepareRelease(worker.dispatchId, true)
        if (preparation.kind === 'plan') await coalesceReleaseEffect(preparation)
      } catch {
        // Recovery never retries a process action unless the current inventory proves the exact incarnation.
      }
    }
  }

  const lifecycle: WorkerLifecycle = {
    hasLiveForTask,
    stateForDispatch,
    workerForDispatch,
    settleDispatch,
    transitionWorker: transitionWorkerHook,
    reset,
    acceptReport,
    recordHeartbeat,
    stop,
    abandon,
    release,
    retain,
    userInput,
    recoverReleases,
    onExit,
    dispose() {
      if (disposed) return
      disposed = true
      unregisterExit?.()
      unregisterExit = null
    }
  }

  repo.store.transaction(() => repo.reconcile(runtime.epoch))
  core.registerWorkerPort(lifecycle)
  lifecycleByCore.set(core, lifecycle)

  core.store.transaction(() => {
    for (const dispatch of core.listDispatches()) {
      const worker = repo.get(dispatch.id)
      if (!worker || !ACTIVE_WORKER_STATES.has(worker.state) || !finalDispatchStatus(dispatch.status)) continue
      updateState(dispatch.id, worker.state, 'abandoned')
      updateStage(dispatch.id, 'abandoned', {
        stage: 'assignment_settled',
        lastError: 'The Dispatch settled before the worker lifecycle reconciled.'
      })
      const resource = repo.resource(dispatch.id)
      if (resource && resource.ownerDispatchId === dispatch.id) markResourceRetained(resource, 'assignment_settled')
    }
  })

  unregisterExit = runtime.context.pty.onExit((sessionId, exitCode, event) => {
    if (disposed) return
    for (const worker of repo.list()) {
      if (worker.sessionId !== sessionId || worker.processIncarnation === null || !ACTIVE_WORKER_STATES.has(worker.state)) continue
      let dispatch: DispatchRow
      try {
        dispatch = core.getDispatch(worker.dispatchId)
      } catch {
        continue
      }
      void runtime.observe(worker, dispatch).then((observation) => {
        if (disposed || observation.status !== 'exited' || !isExactIdentity(worker, observation.identity)) return
        const reason = event.exitCause === 'killed' ? 'operator_close' : event.exitSignal ? 'signaled'
          : event.exitCause === 'exited' ? 'exited' : 'unknown'
        onExit(sessionId, worker.processIncarnation, reason, exitCode)
      }).catch(() => {})
    }
  })

  return lifecycle
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
