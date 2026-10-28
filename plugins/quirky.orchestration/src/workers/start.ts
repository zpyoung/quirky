import type { QuirkyEvent } from '@quirky/protocol'
import { randomUUID } from 'node:crypto'
import type { DispatchRow, DispatchStatus, JsonValue, MutationResult, RunRow, TaskRow, UtcTimestamp } from '../contracts'
import type {
  CoordinatorEvidence, FederatedWorkerStartHooks, ServiceCoordinatorEvidence, TerminalResource, TurnStart, WorkerCore, WorkerEffect,
  WorkerLifecycle, WorkerModeDecision, WorkerPlacement, WorkerRecord,
  WorkerRepository, WorkerRuntime, WorkerSetup, WorkerStartParams,
  WorkerStartReceipt, WorkerStarter,
} from '../worker-contracts'
import { buildWorkerPreamble } from './preamble'

const DEFAULT_READY_TIMEOUT_MS = 60_000
const TURN_OBSERVATION_TIMEOUT_MS = 30_000
const CLIENT_TIMEOUT_GRACE_MS = 50_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_TASK_SPEC_BYTES = 1_214_464
const LIVE_DISPATCH_STATES = new Set<DispatchStatus>(['pending', 'dispatched'])
const LIVE_WORKER_STATES = new Set(['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'])
const SETTLED_WORKER_STATES = new Set(['succeeded', 'failed', 'stopped', 'abandoned'])

type CodedError = Error & { code?: string; data?: unknown }
type StartPreflight = { run: RunRow; worktreeId: string | null; decision: WorkerModeDecision; timeoutMs: number }

function fail(code: string, message: string, data?: unknown): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  if (data !== undefined) error.data = data
  return error
}

function errorCode(cause: unknown): string | null {
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : null
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isServiceCaller(caller: CoordinatorEvidence): caller is ServiceCoordinatorEvidence {
  return 'kind' in caller && caller.kind === 'service'
}

function validateRequest(params: WorkerStartParams, caller: CoordinatorEvidence): number {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.requestId)) {
    throw fail('invalid_argument', 'requestId must be a UUID.')
  }
  const hasTask = params.taskId !== undefined
  const hasSpec = params.spec !== undefined
  if (hasTask === hasSpec) throw fail('invalid_argument', 'Provide exactly one of taskId or spec.')
  if (hasTask && (typeof params.taskId !== 'string' || params.taskId.trim().length === 0)) throw fail('invalid_argument', 'taskId must be a non-empty Task ID.')
  if (hasSpec && (typeof params.spec !== 'string' || params.spec.trim().length === 0)) throw fail('invalid_argument', 'spec must be non-empty text.')
  if (hasSpec && Buffer.byteLength(params.spec!, 'utf8') > MAX_TASK_SPEC_BYTES) {
    throw fail('worker_prompt_too_large', `Task spec exceeds ${MAX_TASK_SPEC_BYTES} UTF-8 bytes.`, {
      maxTaskSpecBytes: MAX_TASK_SPEC_BYTES,
      nextSteps: ['Shorten the Task spec or save large context in the workspace and reference it.'],
    })
  }

  const hasAgent = params.agent !== undefined
  const hasTerminal = params.terminal !== undefined
  if (hasAgent === hasTerminal) throw fail('invalid_argument', 'Provide exactly one of agent or terminal.')
  if (hasAgent && (typeof params.agent !== 'string' || params.agent.trim().length === 0 || params.agent.trim() !== params.agent || params.agent === 'shell')) {
    throw fail('agent_unconfigured', 'worker-start requires a named, launchable agent; shell is not a worker agent.')
  }
  if (hasTerminal && (typeof params.terminal !== 'string' || params.terminal.trim().length === 0)) throw fail('invalid_argument', 'terminal must be a non-empty session ID.')
  if (params.mode !== undefined && params.mode !== 'terminal' && params.mode !== 'structured') throw fail('invalid_argument', 'mode must be terminal or structured.')
  if (params.model !== undefined && (params.model.trim() !== params.model || params.model.length === 0 || params.model.length > 512)) {
    throw fail('invalid_argument', 'model must contain 1 to 512 characters with no surrounding whitespace.')
  }
  if (params.effort !== undefined && (params.effort.trim() !== params.effort || params.effort.length === 0 || params.effort.length > 512)) {
    throw fail('invalid_argument', 'effort must contain 1 to 512 characters with no surrounding whitespace.')
  }
  if (params.effort !== undefined && params.model === undefined) throw fail('invalid_argument', 'effort requires model.')
  if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1)) {
    throw fail('invalid_argument', 'timeoutMs must be a positive integer.')
  }
  const timeoutMs = params.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  if (timeoutMs + CLIENT_TIMEOUT_GRACE_MS > MAX_TIMER_DELAY_MS) {
    throw fail('invalid_argument', 'Readiness timeout plus client grace exceeds the runtime timer limit.')
  }
  if (isServiceCaller(caller)) {
    if (params.runId !== caller.runId) throw fail('consumer_fenced', 'A service worker start must name the Run owned by that service.')
    if (params.worktree === 'current' || params.worktree === 'new-child') {
      throw fail('invalid_argument', 'A service worker start requires an explicit workspace; current and new-child require a coordinator session.')
    }
  }
  if (typeof params.worktree !== 'string' || params.worktree.trim().length === 0) throw fail('invalid_argument', 'worktree must be a workspace selector.')
  return timeoutMs
}

function now(): UtcTimestamp {
  return new Date().toISOString() as UtcTimestamp
}

function initialSetup(params: WorkerStartParams): WorkerSetup {
  return {
    requested: params.setup ?? 'run',
    effective: 'not_started',
    source: 'preflight',
    hookFound: false,
    startupPolicy: 'unknown',
    state: 'not_applicable',
  }
}

function initialReceipt(
  params: WorkerStartParams,
  runId: RunRow['id'],
  taskId: TaskRow['id'],
  dispatch: DispatchRow,
  decision: WorkerModeDecision,
  timeoutMs: number,
): WorkerStartReceipt {
  return {
    runId,
    taskId,
    dispatchId: dispatch.id,
    state: 'outcome_unknown',
    stage: 'accepted',
    turnStart: 'unobserved',
    setup: initialSetup(params),
    launch: {
      requested: { agent: params.agent ?? null, model: params.model ?? null, effort: params.effort ?? null },
      effective: { agent: params.agent ?? null, model: params.model ?? null, effort: params.effort ?? null },
    },
    mode: decision,
    timeoutMs,
    effects: [],
    residualResources: [],
  }
}

function makeRecord(params: WorkerStartParams, receipt: WorkerStartReceipt, runtime: WorkerRuntime, worktreeId: string | null): WorkerRecord {
  const timestamp = now()
  return {
    dispatchId: receipt.dispatchId,
    state: 'starting',
    stage: 'accepted',
    worktreeId,
    sessionId: null,
    setupState: receipt.setup.state,
    effects: [],
    residualResources: [],
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    runtimeEpoch: runtime.epoch,
    processIncarnation: null,
    processRuntimeEpoch: null,
    mode: receipt.mode.mode,
    startOptions: params,
    receipt,
  }
}

function isWorkerEffect(value: unknown): value is WorkerEffect {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (item.kind === 'worktree' || item.kind === 'terminal' || item.kind === 'setup' || item.kind === 'dispatch_input')
    && typeof item.action === 'string'
    && (item.role === 'agent' || item.role === 'setup' || item.role === 'configured_tab' || item.role === 'recovery_shell')
    && typeof item.id === 'string'
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

function effectsFromError(cause: unknown): WorkerEffect[] {
  if (typeof cause !== 'object' || cause === null || !('data' in cause)) return []
  const data = cause.data
  if (typeof data !== 'object' || data === null || !('effects' in data) || !Array.isArray(data.effects)) return []
  return data.effects.filter(isWorkerEffect)
}

function residualsFromError(cause: unknown): JsonValue[] {
  if (typeof cause !== 'object' || cause === null || !('data' in cause)) return []
  const data = cause.data
  if (typeof data !== 'object' || data === null || !('residualResources' in data) || !Array.isArray(data.residualResources)) return []
  return data.residualResources.filter(isJsonValue)
}

function isLiveDispatch(dispatch: DispatchRow): boolean {
  return LIVE_DISPATCH_STATES.has(dispatch.status)
}

function refuseActiveTerminal(core: WorkerCore, repository: WorkerRepository, terminal: string): void {
  if (core.listDispatches().some(dispatch => dispatch.assigneeSessionId === terminal && isLiveDispatch(dispatch))) {
    throw fail('task_not_startable', `Session ${terminal} already has an active Dispatch.`)
  }
  const resource = repository.resourceBySession(terminal)
  if (resource && (resource.releaseState === 'requested' || resource.releaseState === 'releasing' || resource.releaseState === 'unknown')) {
    throw fail('task_not_startable', `Session ${terminal} has an unresolved release and cannot be reused.`)
  }
  if (resource) {
    const owner = repository.get(resource.ownerDispatchId)
    if (owner && LIVE_WORKER_STATES.has(owner.state)) throw fail('task_not_startable', `Session ${terminal} is still owned by active worker ${owner.dispatchId}.`)
  }
}

function taskForRun(core: WorkerCore, taskId: TaskRow['id'], runId: RunRow['id']): TaskRow {
  let task: TaskRow
  try {
    task = core.getTask(taskId)
  } catch (cause) {
    if (errorCode(cause) === 'task_not_found' || errorCode(cause) === 'not-found' || errorCode(cause) === 'not_found') {
      throw fail('task_not_found', `Task ${taskId} was not found in Run ${runId}.`)
    }
    throw cause
  }
  if (task.runId !== runId) throw fail('task_not_found', `Task ${taskId} was not found in Run ${runId}.`)
  return task
}


function receiptFromSettledWorker(
  receipt: WorkerStartReceipt,
  record: WorkerRecord,
  dispatch: DispatchRow,
): WorkerStartReceipt {
  const stored = record.receipt ?? receipt
  const dispatchSettled = dispatch.status === 'completed' || dispatch.status === 'failed' || dispatch.status === 'circuit_broken'
  if (record.state === 'succeeded' || (record.state === 'failed' && record.stage === 'settled' && dispatchSettled)) {
    return {
      ...stored,
      state: 'ready',
      stage: record.stage || 'settled',
      ...(record.state === 'succeeded' ? { workerOutcome: 'succeeded' } : { workerOutcome: 'failed' }),
    }
  }
  if (record.state === 'ready') return { ...stored, state: 'ready', stage: record.stage }
  if (record.state === 'failed') {
    return { ...stored, state: 'failed', stage: record.stage, ...(record.lastError ? { lastError: record.lastError } : {}) }
  }
  if (record.state === 'stopped') {
    return { ...stored, state: 'failed', stage: record.stage, warning: record.lastError ?? 'The worker was stopped before worker-start reached ready.' }
  }
  return {
    ...stored,
    state: 'outcome_unknown',
    stage: record.stage,
    ...(record.lastError ? { lastError: record.lastError } : {}),
  }
}


function workerSessionResource(
  repository: WorkerRepository,
  dispatch: DispatchRow,
  placement: WorkerPlacement,
): TerminalResource {
  const { identity } = placement
  const prior = repository.resourceBySession(identity.sessionId)
  if (prior && prior.ownerDispatchId !== dispatch.id) {
    const oldRecord = repository.get(prior.ownerDispatchId)
    if (!oldRecord || !SETTLED_WORKER_STATES.has(oldRecord.state)) {
      throw fail('task_not_startable', `Session ${identity.sessionId} still belongs to an unsettled worker.`)
    }
    if (prior.processIncarnation !== identity.processIncarnation) {
      throw fail('worker_identity_changed', `Session ${identity.sessionId} changed incarnation since its prior worker attempt.`)
    }
    if (prior.releaseState === 'requested' || prior.releaseState === 'releasing' || prior.releaseState === 'unknown' || prior.releaseState === 'released') {
      throw fail('task_not_startable', `Session ${identity.sessionId} has a release disposition that prevents custody transfer.`)
    }
    if (prior.ownershipState === 'released' || prior.ownershipState === 'transferred') {
      throw fail('task_not_startable', `Session ${identity.sessionId} no longer has transferable custody.`)
    }
  }

  const priorOwners = prior ? [...prior.priorOwnerDispatchIds] : []
  if (prior && prior.ownerDispatchId !== dispatch.id && !priorOwners.includes(prior.ownerDispatchId)) priorOwners.push(prior.ownerDispatchId)
  const ownershipState = prior?.ownershipState ?? (placement.created ? 'owned' : 'external')
  return {
    id: prior?.id ?? identity.sessionId,
    originDispatchId: prior?.originDispatchId ?? dispatch.id,
    ownerDispatchId: dispatch.id,
    priorOwnerDispatchIds: priorOwners,
    worktreeId: placement.worktreeId,
    sessionId: identity.sessionId,
    processIncarnation: identity.processIncarnation,
    ownershipState,
    releaseState: prior?.releaseState ?? 'not_requested',
    retainedReason: prior?.retainedReason ?? null,
    releaseRequestedAt: prior?.releaseRequestedAt ?? null,
    releaseCompletedAt: prior?.releaseCompletedAt ?? null,
    releaseError: prior?.releaseError ?? null,
    recoveryAttemptCount: prior?.recoveryAttemptCount ?? 0,
    lastRecoveryAt: prior?.lastRecoveryAt ?? null,
    archiveSource: prior?.archiveSource ?? null,
    archiveStatus: prior?.archiveStatus ?? null,
  }
}

function coordinatorAddress(run: RunRow, caller: CoordinatorEvidence): string {
  if (isServiceCaller(caller)) return `run:${run.id}`
  return run.coordinatorSessionId ?? caller.callerSessionId
}


function recoveryReceipt(receipt: WorkerStartReceipt, dispatchId: DispatchRow['id']): WorkerStartReceipt {
  const releaseCommand = ['orchestration', 'worker-release', '--dispatch', dispatchId]
  return {
    ...receipt,
    recovery: `This start created a worker resource that never received a proven turn. Inspect it, then release it only if it is still owned: ${releaseCommand.join(' ')}.`,
    nextCommands: [releaseCommand],
  }
}

function unknownReceipt(receipt: WorkerStartReceipt, dispatchId: DispatchRow['id'], stage = 'turn_unobserved'): WorkerStartReceipt {
  return {
    ...receipt,
    state: 'outcome_unknown',
    stage,
    nextCommands: [
      ['orchestration', 'worker-show', '--dispatch', dispatchId],
      ['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'auto'],
      ['orchestration', 'worker-abandon', '--dispatch', dispatchId],
    ],
  }
}

function isAmbiguousStart(cause: unknown, stage: string, inputMayHaveBeenAccepted = false): boolean {
  if (stage === 'retry_release') return false
  if (inputMayHaveBeenAccepted) return true
  const code = errorCode(cause)
  if (typeof cause === 'object' && cause !== null && 'data' in cause) {
    const data = cause.data
    if (typeof data === 'object' && data !== null && 'accepted' in data && data.accepted === false) return false
  }
  if (code === 'operation_unknown') return true
  if (stage === 'placing' && (code === 'runtime_timeout' || code === 'runtime_unavailable' || code === 'connection_lost' || code === 'timeout')) return true
  return stage === 'submitting' && (code === 'runtime_timeout' || code === 'runtime_unavailable' || code === 'connection_lost' || code === 'timeout')
}

function settleAfterCommitFailure(
  core: WorkerCore,
  repository: WorkerRepository,
  initial: WorkerStartReceipt,
  cause: unknown,
  stage: string,
  turnStart: TurnStart,
  effects: readonly WorkerEffect[],
  residualResources: readonly JsonValue[],
  inputMayHaveBeenAccepted: boolean,
): WorkerStartReceipt {
  const timestamp = now()
  const dispatch = core.getDispatch(initial.dispatchId)
  const existing = repository.get(initial.dispatchId)
  if (!existing) return { ...initial, state: 'outcome_unknown', stage, lastError: errorMessage(cause), effects, residualResources }
  if (existing.state !== 'starting' || dispatch.status !== 'pending') return receiptFromSettledWorker(initial, existing, dispatch)

  const unknown = isAmbiguousStart(cause, stage, inputMayHaveBeenAccepted)
  const unknownStage = stage === 'submitting' ? 'turn_unobserved' : `${stage}_unknown`
  const finalReceipt: WorkerStartReceipt = unknown
    ? { ...unknownReceipt(initial, initial.dispatchId, unknownStage), turnStart, lastError: errorMessage(cause), effects, residualResources }
    : { ...initial, state: 'failed', stage: 'start_failed', turnStart, failedStage: stage, lastError: errorMessage(cause), effects, residualResources, ...(stage === 'retry_release' ? { warning: 'Prior worker release was not confirmed; no replacement session was launched.' } : {}) }

  core.store.transaction(() => {
    const currentWorker = repository.get(initial.dispatchId)
    const currentDispatch = core.getDispatch(initial.dispatchId)
    if (!currentWorker || currentWorker.state !== 'starting' || currentDispatch.status !== 'pending') return
    if (unknown) {
      core.transitionWorker({ dispatchId: initial.dispatchId, expectedState: 'starting', nextState: 'start_unknown' })
      repository.update(initial.dispatchId, {
        state: 'start_unknown', stage: finalReceipt.stage, lastError: errorMessage(cause),
        effects, residualResources, receipt: finalReceipt,
      }, 'start_unknown')
      return
    }

    core.transitionWorker({
      dispatchId: initial.dispatchId,
      expectedState: 'starting',
      nextState: 'failed',
    })
    const nextDispatchState = dispatch.failureCount + 1 >= 3 ? 'circuit_broken' : 'failed'
    core.transitionDispatch({
      dispatchId: initial.dispatchId,
      expectedState: 'pending',
      nextState: nextDispatchState,
      failureClass: 'infrastructure',
      failureReason: errorMessage(cause),
      at: timestamp,
    })
    const afterWorker = repository.get(initial.dispatchId)
    if (afterWorker) {
      repository.update(initial.dispatchId, {
        state: 'failed', stage: 'start_failed', lastError: errorMessage(cause),
        effects, residualResources, receipt: finalReceipt,
      }, afterWorker.state)
    }
  })

  const settled = repository.get(initial.dispatchId)
  const settledDispatch = core.getDispatch(initial.dispatchId)
  if (settled && settled.state !== 'failed' && settled.state !== 'start_unknown') return receiptFromSettledWorker(initial, settled, settledDispatch)
  if (!unknown && repository.resource(initial.dispatchId)?.ownershipState === 'owned') return recoveryReceipt(finalReceipt, initial.dispatchId)
  return finalReceipt
}

async function releaseRetryResource(
  lifecycle: WorkerLifecycle,
  repository: WorkerRepository,
  params: WorkerStartParams,
  caller: CoordinatorEvidence,
  runId: RunRow['id'],
): Promise<void> {
  if (!params.retryOfDispatchId || params.terminal) return
  const resource = repository.resource(params.retryOfDispatchId)
  const previous = repository.get(params.retryOfDispatchId)
  if (!resource || !previous || previous.state !== 'failed' || resource.ownershipState !== 'owned') return
  if (resource.releaseState === 'released') return
  if (resource.releaseState === 'requested' || resource.releaseState === 'releasing' || resource.releaseState === 'unknown') {
    throw fail('operation_unknown', `Prior worker resource ${resource.sessionId} has an unresolved release.`)
  }
  const released = await lifecycle.release({
    requestId: randomUUID(),
    contractVersion: 1,
    runId,
    dispatchId: params.retryOfDispatchId,
    expectedIdentity: { sessionId: resource.sessionId, processIncarnation: resource.processIncarnation },
  }, caller)
  if (released.processAction === 'unknown' || released.state === 'release_unknown' || released.state === 'release_pending') {
    throw fail('operation_unknown', `Prior worker resource ${resource.sessionId} could not be safely released.`, { accepted: false })
  }
}

async function launchAccepted(
  core: WorkerCore,
  repository: WorkerRepository,
  runtime: WorkerRuntime,
  lifecycle: WorkerLifecycle,
  setupUnsubscribers: Set<() => void>,
  isActive: () => boolean,
  params: WorkerStartParams,
  caller: CoordinatorEvidence,
  run: RunRow,
  initial: WorkerStartReceipt,
  timeoutMs: number,
  federationHooks?: FederatedWorkerStartHooks,
): Promise<WorkerStartReceipt> {
  let stage = 'retry_release'
  let turnStart: TurnStart = 'unobserved'
  const effects: WorkerEffect[] = []
  let residualResources: JsonValue[] = []
  let inputMayHaveBeenAccepted = false
  let placement: WorkerPlacement | null = null
  let placementForFailure: WorkerPlacement | undefined
  let custodyRecorded = false

  try {
    const task = core.getTask(initial.taskId)
    const dispatch = core.getDispatch(initial.dispatchId)
    const existingRecord = repository.get(initial.dispatchId)
    if (!existingRecord) throw fail('operation_unknown', `Accepted worker ${initial.dispatchId} is unavailable after commit.`)
    if (federationHooks) await federationHooks.beforeLaunch(initial, existingRecord)
    await releaseRetryResource(lifecycle, repository, params, caller, run.id)

    stage = 'placing'
    repository.update(initial.dispatchId, { stage: params.worktree === 'new-child' || params.worktree === 'new-top-level' ? 'worktree_creating' : 'placing' }, 'starting')
    const deadline = Date.now() + timeoutMs
    placement = await runtime.place(params, task, dispatch, caller, placed => {
      if (custodyRecorded) throw fail('lifecycle_conflict', 'Worker runtime attempted to record custody more than once.')
      if (placed.identity.kind !== (initial.mode.mode === 'structured' ? 'structured' : 'terminal')) {
        throw fail('worker_identity_changed', 'The placed session kind does not match the validated worker mode.')
      }
      if (params.terminal) refuseActiveTerminal(core, repository, params.terminal)
      placementForFailure = placed
      core.store.transaction(() => {
        const current = repository.get(dispatch.id)
        if (!current || current.state !== 'starting') throw fail('lifecycle_conflict', `Worker ${dispatch.id} changed before custody was recorded.`)
        const runtimeEffects = [...placed.effects]
        const resource = workerSessionResource(repository, dispatch, placed)
        repository.putResource(resource)
        repository.update(dispatch.id, {
          stage: 'custody_recorded',
          worktreeId: placed.worktreeId,
          sessionId: placed.identity.sessionId,
          processIncarnation: placed.identity.processIncarnation,
          processRuntimeEpoch: placed.identity.runtimeEpoch,
          setupState: placed.setup.state,
          effects: runtimeEffects,
          receipt: { ...initial, stage: 'custody_recorded', setup: placed.setup, effects: runtimeEffects },
        }, 'starting')
        effects.splice(0, effects.length, ...placed.effects)
      })
      custodyRecorded = true
      const userInput = runtime.context.pty.lastUserInput(placed.identity.sessionId)
      if (userInput
        && userInput.session === placed.identity.sessionId
        && userInput.expectedIncarnation === placed.identity.processIncarnation) {
        lifecycle.userInput({ session: userInput.session, expectedIncarnation: userInput.expectedIncarnation })
      }
    })
    if (!custodyRecorded) throw fail('invalid_runtime_response', 'Worker runtime returned without invoking the custody callback.')
    const recordAfterCustody = repository.get(initial.dispatchId)
    if (!recordAfterCustody) throw fail('operation_unknown', `Worker ${initial.dispatchId} disappeared after custody attachment.`)
    if (placement.setup.startupPolicy === 'start-immediately' && placement.setup.state === 'running' && placement.setup.hookFound) {
      trackSetupCompletion(core, repository, runtime, dispatch.id, placement, setupUnsubscribers, isActive)
    }

    if (placement.setup.startupPolicy === 'start-immediately' && placement.setup.hookFound && (placement.setup.state === 'succeeded' || placement.setup.state === 'failed')) {
      core.emitWorkerStatus(
        dispatch.id,
        `Setup ${placement.setup.state} for worker ${dispatch.id}`,
        `Repository setup ${placement.setup.state} for worker ${dispatch.id}.`,
        placement.setup.state === 'failed',
      )
    }

    stage = 'readiness'
    repository.update(initial.dispatchId, { stage: 'waiting_ready' }, 'starting')
    await runtime.waitReady(placement, deadline, !placement.created)

    let currentRecord = repository.get(initial.dispatchId)
    let currentDispatch = core.getDispatch(initial.dispatchId)
    if (currentRecord && currentRecord.state !== 'starting') return receiptFromSettledWorker(initial, currentRecord, currentDispatch)
    if (currentDispatch.status !== 'pending') {
      currentRecord = repository.get(initial.dispatchId)
      return currentRecord ? receiptFromSettledWorker(initial, currentRecord, currentDispatch) : initial
    }

    stage = 'authority_attached'
    const attached = core.store.transaction(() => {
      core.requireCoordinator(caller, run.id)
      const worker = repository.get(initial.dispatchId)
      const current = core.getDispatch(initial.dispatchId)
      if (!worker || worker.state !== 'starting' || current.status !== 'pending') return current
      const exact = core.attachWorkerAuthority(initial.dispatchId, placement!.identity, caller)
      repository.update(initial.dispatchId, { stage: 'authority_attached' }, 'starting')
      return exact
    })
    currentRecord = repository.get(initial.dispatchId)
    currentDispatch = core.getDispatch(initial.dispatchId)
    if (!currentRecord || currentRecord.state !== 'starting' || currentDispatch.status !== 'pending') {
      return currentRecord ? receiptFromSettledWorker(initial, currentRecord, currentDispatch) : initial
    }
    if (attached.id !== initial.dispatchId || attached.assigneeSessionId !== placement.identity.sessionId) {
      throw fail('worker_identity_changed', 'Core attached a different worker identity than the attested placement.')
    }
    if (federationHooks) {
      const attachedWorker = repository.get(initial.dispatchId)
      if (!attachedWorker || attachedWorker.sessionId !== placement.identity.sessionId ||
        attachedWorker.processIncarnation !== placement.identity.processIncarnation ||
        attachedWorker.processRuntimeEpoch !== placement.identity.runtimeEpoch) {
        throw fail('worker_identity_changed', 'Federated worker attachment did not retain the exact process identity.')
      }
      await federationHooks.attached(attachedWorker, attached)
    }

    const prompt = buildWorkerPreamble(task, attached, placement.identity, coordinatorAddress(run, caller), core.nestedWorkerMaxDepth)
    const effectiveLaunch = {
      requested: initial.launch.requested,
      effective: {
        agent: placement.session.agent,
        model: params.model ?? null,
        effort: params.effort ?? null,
      },
    }
    const setupAtAuthority = currentRecord.receipt?.setup ?? placement.setup
    const preambleReceipt: WorkerStartReceipt = {
      ...initial,
      stage: 'authority_attached',
      setup: setupAtAuthority,
      launch: effectiveLaunch,
      effects: [...effects],
    }
    repository.update(initial.dispatchId, { stage: 'authority_attached', receipt: preambleReceipt }, 'starting')

    currentRecord = repository.get(initial.dispatchId)
    currentDispatch = core.getDispatch(initial.dispatchId)
    if (!currentRecord || currentRecord.state !== 'starting' || currentDispatch.status !== 'pending') {
      return currentRecord ? receiptFromSettledWorker(preambleReceipt, currentRecord, currentDispatch) : preambleReceipt
    }

    stage = 'submitting'
    turnStart = await runtime.submit(placement, prompt, `worker-start:${initial.dispatchId}:initial-preamble`, Date.now() + TURN_OBSERVATION_TIMEOUT_MS)
    inputMayHaveBeenAccepted = true
    const inputEffect = { kind: 'dispatch_input', action: turnStart === 'unobserved' ? 'accepted_unobserved' : 'accepted', role: 'agent', id: placement.session.id } satisfies WorkerEffect
    effects.push(inputEffect)
    repository.addObservation(initial.dispatchId, 'turn_start', { status: turnStart, operationId: `worker-start:${initial.dispatchId}:initial-preamble` })

    currentRecord = repository.get(initial.dispatchId)
    currentDispatch = core.getDispatch(initial.dispatchId)
    if (!currentRecord || currentRecord.state !== 'starting' || currentDispatch.status !== 'pending') {
      return currentRecord ? receiptFromSettledWorker(preambleReceipt, currentRecord, currentDispatch) : preambleReceipt
    }

    const finalSetup = repository.get(initial.dispatchId)?.receipt?.setup ?? placement.setup
    if (turnStart === 'unobserved') {
      const finalReceipt = unknownReceipt(preambleReceipt, initial.dispatchId)
      finalReceipt.setup = finalSetup
      finalReceipt.turnStart = turnStart
      finalReceipt.effects = [...effects]
      core.store.transaction(() => {
        const worker = repository.get(initial.dispatchId)
        const activeDispatch = core.getDispatch(initial.dispatchId)
        if (!worker || worker.state !== 'starting' || activeDispatch.status !== 'pending') return
        core.transitionWorker({ dispatchId: initial.dispatchId, expectedState: 'starting', nextState: 'start_unknown' })
        repository.update(initial.dispatchId, {
          state: 'start_unknown', stage: 'turn_unobserved', setupState: finalSetup.state,
          effects: [...effects], lastError: 'Accepted worker input had no bounded proof that a turn started.', receipt: finalReceipt,
        }, 'start_unknown')
      })
      return repository.get(initial.dispatchId)?.receipt ?? finalReceipt
    }

    const successReceipt: WorkerStartReceipt = {
      ...preambleReceipt,
      state: 'ready',
      stage: 'input_accepted',
      turnStart,
      setup: finalSetup,
      effects: [...effects],
      residualResources: [...residualResources],
    }
    return core.store.transaction(() => {
      const worker = repository.get(initial.dispatchId)
      const activeDispatch = core.getDispatch(initial.dispatchId)
      if (!worker || worker.state !== 'starting' || activeDispatch.status !== 'pending') {
        return worker ? receiptFromSettledWorker(successReceipt, worker, activeDispatch) : successReceipt
      }
      core.transitionDispatch({ dispatchId: initial.dispatchId, expectedState: 'pending', nextState: 'dispatched', at: now() })
      const currentWorker = repository.get(initial.dispatchId)
      if (currentWorker?.state === 'starting') {
        core.transitionWorker({ dispatchId: initial.dispatchId, expectedState: 'starting', nextState: 'ready' })
      }
      const updatedWorker = repository.get(initial.dispatchId)
      if (!updatedWorker || updatedWorker.state !== 'ready') {
        return updatedWorker ? receiptFromSettledWorker(successReceipt, updatedWorker, core.getDispatch(initial.dispatchId)) : successReceipt
      }
      repository.update(initial.dispatchId, {
        stage: 'input_accepted', setupState: finalSetup.state, effects: [...effects], receipt: successReceipt,
      }, 'ready')
      return successReceipt
    })
  } catch (cause) {
    const effectsFromFailure = effectsFromError(cause)
    for (const item of effectsFromFailure) if (!effects.some(existing => existing.kind === item.kind && existing.id === item.id && existing.action === item.action)) effects.push(item)
    residualResources = [...residualsFromError(cause)]
    if (stage === 'submitting' && isAmbiguousStart(cause, stage, inputMayHaveBeenAccepted) && placementForFailure && !effects.some(item => item.kind === 'dispatch_input')) {
      effects.push({ kind: 'dispatch_input', action: 'outcome_unknown', role: 'agent', id: placementForFailure.session.id })
    }
    const receipt = settleAfterCommitFailure(core, repository, initial, cause, stage, turnStart, effects, residualResources, inputMayHaveBeenAccepted)
    return receipt
  }
}

function setupExitFromEvent(event: QuirkyEvent): { id: string; exitCode: number | null } | null {
  if (event.type !== 'quirky.session/changed' || typeof event.data !== 'object' || event.data === null || !('session' in event.data)) return null
  const session = event.data.session
  if (typeof session !== 'object' || session === null || !('id' in session) || !('status' in session) || session.status !== 'exited') return null
  if (typeof session.id !== 'string') return null
  return { id: session.id, exitCode: 'exitCode' in session && typeof session.exitCode === 'number' ? session.exitCode : null }
}

function trackSetupCompletion(
  core: WorkerCore,
  repository: WorkerRepository,
  runtime: WorkerRuntime,
  dispatchId: DispatchRow['id'],
  placement: WorkerPlacement,
  watchers: Set<() => void>,
  isActive: () => boolean,
): void {
  const setupEffect = placement.effects.find(item => item.kind === 'setup' && item.action === 'started')
  if (!setupEffect) return
  let completed = false
  let unsubscribe: (() => void) | null = null
  const stopWatching = (): void => {
    const stop = unsubscribe
    unsubscribe = null
    if (stop) stop()
    watchers.delete(stopWatching)
  }
  const finish = (session: { id: string; exitCode: number | null }): void => {
    if (completed || session.id !== setupEffect.id) return
    completed = true
    stopWatching()
    if (!isActive()) return
    const state = session.exitCode === 0 ? 'succeeded' : 'failed'
    try {
      let recorded = false
      core.store.transaction(() => {
        const record = repository.get(dispatchId)
        if (!record || record.setupState !== 'running') return
        const setup = record.receipt?.setup
        if (!setup || setup.state !== 'running') return
        repository.update(dispatchId, {
          setupState: state,
          receipt: { ...record.receipt!, setup: { ...setup, state } },
        })
        recorded = true
      })
      if (!recorded) return
      core.emitWorkerStatus(
        dispatchId,
        `Setup ${state} for worker ${dispatchId}`,
        `Repository setup ${state} for worker ${dispatchId}.`,
        state === 'failed',
      )
    } catch (cause) {
      runtime.context.log(`Could not record setup completion for worker ${dispatchId}: ${errorMessage(cause)}`)
    }
  }

  try {
    const stop = runtime.context.subscribe(event => {
      if (!isActive()) {
        stopWatching()
        return
      }
      const session = setupExitFromEvent(event)
      if (session) finish(session)
    })
    unsubscribe = stop
    watchers.add(stopWatching)
    if (completed || !isActive()) stopWatching()
  } catch (cause) {
    runtime.context.log(`Could not watch setup terminal for worker ${dispatchId}: ${errorMessage(cause)}`)
    stopWatching()
    return
  }
  void runtime.context.call('quirky.session/list').then(value => {
    if (!isActive()) {
      stopWatching()
      return
    }
    if (!Array.isArray(value)) return
    const session = value.find(item => typeof item === 'object' && item !== null && 'id' in item && item.id === setupEffect.id)
    if (!session || typeof session !== 'object' || !('status' in session) || session.status !== 'exited') return
    const exitCode = 'exitCode' in session && typeof session.exitCode === 'number' ? session.exitCode : null
    finish({ id: setupEffect.id, exitCode })
  }).catch(cause => {
    if (isActive()) runtime.context.log(`Could not inspect setup terminal for worker ${dispatchId}: ${errorMessage(cause)}`)
    else stopWatching()
  })
}

export function createWorkerStarter(
  core: WorkerCore,
  repository: WorkerRepository,
  runtime: WorkerRuntime,
  lifecycle: WorkerLifecycle,
): WorkerStarter {
  if (core.store !== repository.store) throw new Error('Worker repository must use the orchestration core store.')
  let disposed = false
  const setupUnsubscribers = new Set<() => void>()

  const start = async (
    params: WorkerStartParams,
    caller: CoordinatorEvidence,
    federationHooks?: FederatedWorkerStartHooks,
  ): Promise<MutationResult<WorkerStartReceipt>> => {
    if (disposed) throw fail('runtime_inactive', 'Worker starter has been deactivated.')
    let preflight: StartPreflight | null = null
    return core.mutateWorker('workerStart', params, caller, store => {
      const admitted = preflight
      if (!admitted) throw fail('lifecycle_conflict', 'Worker acceptance ran before admission preflight.')
      if (store !== core.store || store !== repository.store) throw fail('lifecycle_conflict', 'Worker acceptance must use the core orchestration store.')
      const currentRun = core.requireCoordinator(caller, params.runId)
      if (currentRun.id !== admitted.run.id) throw fail('consumer_fenced', 'The coordinator Run changed before worker acceptance.')
      let task: TaskRow
      if (params.taskId) {
        task = taskForRun(core, params.taskId, currentRun.id)
      } else {
        task = core.createTask({
          runId: currentRun.id,
          spec: params.spec!,
          ...(params.taskTitle !== undefined ? { taskTitle: params.taskTitle } : {}),
          ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
          ...(params.dependencyTaskIds !== undefined ? { dependencyTaskIds: params.dependencyTaskIds } : {}),
          ...(params.parentTaskId !== undefined ? { parentTaskId: params.parentTaskId } : {}),
        }, caller)
      }
      const dispatch = core.reserveWorkerDispatch({
        taskId: task.id,
        runId: currentRun.id,
        ...(params.retryOfDispatchId ? { retryOfDispatchId: params.retryOfDispatchId } : {}),
      }, caller)
      const receipt = initialReceipt(params, currentRun.id, task.id, dispatch, admitted.decision, admitted.timeoutMs)
      repository.insert(makeRecord(params, receipt, runtime, admitted.worktreeId))
      const acceptedWorker = repository.get(receipt.dispatchId)
      if (!acceptedWorker) throw fail('worker_port_unavailable', `Accepted worker ${receipt.dispatchId} has no repository record.`)
      federationHooks?.accepted(receipt, acceptedWorker)
      return receipt
    }, {
      beforeAccept: async () => {
        const timeoutMs = validateRequest(params, caller)
        const run = core.requireCoordinator(caller, params.runId)
        if (isServiceCaller(caller) && run.id !== caller.runId) throw fail('consumer_fenced', 'Service coordinator does not own the requested Run.')
        if (params.terminal && run.coordinatorSessionId === params.terminal) {
          throw fail('terminal_is_coordinator', 'The Run coordinator session cannot be reused as a worker.')
        }
        if (params.taskId) taskForRun(core, params.taskId, run.id)
        const validation = await runtime.validate(params, caller)
        if (params.terminal) refuseActiveTerminal(core, repository, params.terminal)
        preflight = { run, worktreeId: validation.worktreeId, decision: validation.decision, timeoutMs }
      },
      acceptedCheckpoint: accepted => ({
        state: 'accepted',
        accepted: true,
        runId: accepted.runId,
        taskId: accepted.taskId,
        dispatchId: accepted.dispatchId,
      }),
      afterCommit: accepted => {
        const admitted = preflight
        if (!admitted) throw fail('operation_unknown', 'Worker start was accepted without its admission preflight.')
        return launchAccepted(
          core, repository, runtime, lifecycle, setupUnsubscribers, () => !disposed,
          params, caller, admitted.run, accepted, admitted.timeoutMs, federationHooks,
        )
      },
    })
  }

  const starter: WorkerStarter = {
    start(params, caller) {
      return start(params, caller)
    },
    startFederated(params, caller, federationHooks) {
      return start(params, caller, federationHooks)
    },
    dispose() {
      disposed = true
      for (const unsubscribe of setupUnsubscribers) unsubscribe()
      setupUnsubscribers.clear()
    },
  }
  return starter
}
