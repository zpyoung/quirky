import type { PluginContext, PluginStore, QuirkyEvent, Session } from '@quirky/protocol'
import type {
  DispatchId, DispatchRow, DispatchStatus, MutationRequest, RunId, RunRow,
  RuntimeCallerEvidence, TaskId, TaskRow, TaskStatus, UtcTimestamp, WorkerOutcome,
} from '../../src/contracts'
import type {
  CoordinatorEvidence, ServiceCoordinatorEvidence, TerminalResource, WorkerCore, WorkerLifecycle,
  WorkerPlacement, WorkerRecord, WorkerRepository, WorkerRuntime, WorkerSetup, WorkerStartParams, WorkerStarter,
  WorkerStartReceipt, WorkerUserInputParams, TurnStart,
} from '../../src/worker-contracts'
import type { DurableMutationOptions, WorkerLifecyclePort } from '../../src/worker-integration'
import type { SessionIdentity } from '../../src/runtime-contracts'
import { createWorkerStarter } from '../../src/workers/start'

const RUN_ID = 'run_test' as RunId
const COORDINATOR_ID = 'session_coordinator'
const WORKTREE_ID = 'worktree_main'
const COORDINATOR_INCARNATION = 'coordinator-incarnation'
const NOW = '2026-10-27T12:00:00.000Z' as UtcTimestamp

function error(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function isServiceCoordinator(evidence: CoordinatorEvidence): evidence is ServiceCoordinatorEvidence {
  return 'kind' in evidence && evidence.kind === 'service'
}

function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
  return new Map([...map].map(([key, value]) => [key, structuredClone(value)]))
}

export interface StatefulRuntime extends WorkerRuntime {
  readonly events: string[]
  validateCalls: number
  placeCalls: number
  waitReadyCalls: number
  submitCalls: number
  submittedOperations: string[]
  submitResult: TurnStart
  placement: WorkerPlacement
  afterCustody?: (dispatchId: DispatchId) => void
  beforeSubmit?: (dispatchId: DispatchId) => void | Promise<void>
  readyError?: Error
  placeError?: Error
  validateError?: Error
}

export interface WorkerStartHarness {
  core: WorkerCore
  repository: WorkerRepository
  runtime: StatefulRuntime
  lifecycle: WorkerLifecycle
  starter: WorkerStarter
  tasks: Map<TaskId, TaskRow>
  dispatches: Map<DispatchId, DispatchRow>
  records: Map<DispatchId, WorkerRecord>
  resources: Map<DispatchId, TerminalResource>
  setupStatuses: { dispatchId: DispatchId; subject: string; body: string; high: boolean }[]
  run: RunRow
  caller: RuntimeCallerEvidence
  reportFromWorker(dispatchId: DispatchId, outcome: WorkerOutcome): void
  simulateUserInput(sessionId: string, expectedIncarnation: string): void
  emitSetupExit(sessionId: string, exitCode: number): void
}

export function workerStartParams(overrides: Partial<WorkerStartParams> = {}): WorkerStartParams {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    contractVersion: 1,
    spec: 'Implement the assigned task safely.',
    worktree: 'current',
    agent: 'claude',
    ...overrides,
  }
}

export function makeWorkerStartHarness(): WorkerStartHarness {
  const tasks = new Map<TaskId, TaskRow>()
  const dispatches = new Map<DispatchId, DispatchRow>()
  const records = new Map<DispatchId, WorkerRecord>()
  const resources = new Map<DispatchId, TerminalResource>()
  const setupSessions = new Map<string, Session>()
  const setupListeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const setupStatuses: WorkerStartHarness['setupStatuses'] = []
  let latestPhysicalInput: { session: string; expectedIncarnation: string; at: number } | null = null
  const archives = new Map<DispatchId, never>()
  const receipts = new Map<string, { fingerprint: string; state: 'pending' | 'completed'; result?: object; checkpoint?: unknown }>()
  let sequence = 0
  let workerPort: WorkerLifecyclePort | null = null
  let repository: WorkerRepository
  let core: WorkerCore

  const pluginContext = {
    getSetting: () => undefined,
    log: () => undefined,
    call: async (method: string) => method === 'quirky.session/list' ? [...setupSessions.values()] : undefined,
    pty: {
      lastUserInput: (sessionId: string) => latestPhysicalInput?.session === sessionId ? latestPhysicalInput : null,
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      setupListeners.add(listener)
      return () => { setupListeners.delete(listener) }
    },
  } as unknown as PluginContext
  const run: RunRow = {
    id: RUN_ID,
    objective: 'Run worker start acceptance tests.',
    coordinatorSessionId: COORDINATOR_ID,
    coordinatorHistory: [],
    consumerGeneration: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
  const caller: RuntimeCallerEvidence = {
    callerSessionId: COORDINATOR_ID,
    runtimeSessionId: COORDINATOR_ID,
    runtimeOwned: true,
    live: true,
    attestation: { source: 'terminal_launch', runtimeEpoch: 'epoch_1', processIncarnation: COORDINATOR_INCARNATION },
  }

  const store: PluginStore = {
    version: 1,
    run: () => ({ changes: 1, lastInsertRowid: 1 }),
    get: () => null,
    all: () => [],
    exec: () => undefined,
    transaction<T>(work: () => T): T {
      const taskSnapshot = cloneMap(tasks)
      const dispatchSnapshot = cloneMap(dispatches)
      const recordSnapshot = cloneMap(records)
      const resourceSnapshot = cloneMap(resources)
      try {
        return work()
      } catch (cause) {
        tasks.clear(); for (const [key, value] of taskSnapshot) tasks.set(key, value)
        dispatches.clear(); for (const [key, value] of dispatchSnapshot) dispatches.set(key, value)
        records.clear(); for (const [key, value] of recordSnapshot) records.set(key, value)
        resources.clear(); for (const [key, value] of resourceSnapshot) resources.set(key, value)
        throw cause
      }
    },
  }

  repository = {
    store,
    get: dispatchId => records.get(dispatchId) ?? null,
    insert: record => {
      if (records.has(record.dispatchId)) throw error('lifecycle_conflict', `Worker ${record.dispatchId} already exists`)
      records.set(record.dispatchId, structuredClone(record))
    },
    update: (dispatchId, patch, expectedState) => {
      const current = records.get(dispatchId)
      if (!current) throw error('lifecycle_not_found', `Worker ${dispatchId} was not found`)
      if (expectedState && current.state !== expectedState) throw error('lifecycle_conflict', `Worker ${dispatchId} is ${current.state}`)
      const updated = { ...current, ...structuredClone(patch), updatedAt: NOW }
      records.set(dispatchId, updated)
      return structuredClone(updated)
    },
    list: () => [...records.values()].map(record => structuredClone(record)),
    resource: dispatchId => resources.get(dispatchId) ?? null,
    resourceBySession: sessionId => [...resources.values()].find(resource => resource.sessionId === sessionId) ?? null,
    putResource: resource => resources.set(resource.ownerDispatchId, structuredClone(resource)),
    archive: dispatchId => (archives.get(dispatchId) ?? null) as never,
    putArchive: () => undefined,
    deleteArchive: () => undefined,
    addObservation: () => undefined,
    reconcile: runtimeEpoch => {
      for (const record of records.values()) {
        if (record.state === 'starting' && record.runtimeEpoch !== runtimeEpoch) {
          repository.update(record.dispatchId, { state: 'start_unknown', stage: 'runtime_restarted', lastError: 'The runtime restarted before worker-start reached a terminal receipt.' }, 'starting')
        }
      }
    },
  }

  const requireCoordinator = (evidence: CoordinatorEvidence, requestedRunId?: RunId): RunRow => {
    if (isServiceCoordinator(evidence)) {
      if (evidence.runId !== run.id || (requestedRunId && requestedRunId !== run.id)) throw error('consumer_fenced', 'service is not bound to this Run')
      return run
    }
    if (!evidence.runtimeOwned || !evidence.live || evidence.callerSessionId !== run.coordinatorSessionId || (requestedRunId && requestedRunId !== run.id)) {
      throw error('consumer_fenced', 'worker-start requires the coordinator terminal currently bound to the Task Run.')
    }
    return run
  }

  const transitionTask = (input: { taskId: TaskId; expectedState: TaskStatus; nextState: TaskStatus; at: UtcTimestamp; result?: TaskRow['result'] }): TaskRow => {
    const current = tasks.get(input.taskId)
    if (!current) throw error('lifecycle_not_found', `Task ${input.taskId} was not found`)
    if (current.status !== input.expectedState) throw error('lifecycle_conflict', `Task ${input.taskId} is ${current.status}`)
    const updated: TaskRow = { ...current, status: input.nextState, result: input.result ?? current.result }
    tasks.set(input.taskId, updated)
    return updated
  }

  const transitionDispatch = (input: { dispatchId: DispatchId; expectedState: DispatchStatus; nextState: DispatchStatus; at: UtcTimestamp }): DispatchRow => {
    const current = dispatches.get(input.dispatchId)
    if (!current) throw error('lifecycle_not_found', `Dispatch ${input.dispatchId} was not found`)
    if (current.status !== input.expectedState) throw error('lifecycle_conflict', `Dispatch ${input.dispatchId} is ${current.status}`)
    const updated = { ...current, status: input.nextState, dispatchedAt: input.nextState === 'dispatched' ? input.at : current.dispatchedAt, completedAt: input.nextState === 'completed' || input.nextState === 'failed' ? input.at : current.completedAt }
    dispatches.set(input.dispatchId, updated)
    return updated
  }
  const blockTaskForWorkerStop = ({ taskId, dispatchId, at }: { taskId: TaskId; dispatchId: DispatchId; at: UtcTimestamp }): TaskRow => {
    const task = tasks.get(taskId)
    const dispatch = dispatches.get(dispatchId)
    const worker = repository.get(dispatchId)
    if (!task || !dispatch || task.runId !== dispatch.runId || dispatch.taskId !== taskId ||
      (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
      !worker || (worker.state !== 'stopping' && !(worker.state === 'stop_unknown' && worker.stage === 'stopping'))) {
      throw error('task_not_startable', 'The Task does not have the exact active worker stop fence.')
    }
    const hasIdentity = worker.sessionId !== null || worker.processIncarnation !== null ||
      worker.processRuntimeEpoch !== null || dispatch.assigneeSessionId !== null
    if (hasIdentity && (!worker.sessionId || !worker.processIncarnation || !worker.processRuntimeEpoch ||
      dispatch.assigneeSessionId !== worker.sessionId)) {
      throw error('task_not_startable', 'The active worker stop fence no longer matches its process identity.')
    }
    const activeSibling = [...dispatches.values()].some(candidate =>
      candidate.id !== dispatchId && candidate.taskId === taskId &&
      (candidate.status === 'pending' || candidate.status === 'dispatched')
    )
    if (activeSibling || (task.status !== 'dispatched' && task.status !== 'blocked')) {
      throw error('task_not_startable', 'The Task has another active attempt or is no longer dispatched.')
    }
    if (task.status === 'blocked') return task
    const updated: TaskRow = { ...task, status: 'blocked' }
    tasks.set(taskId, updated)
    return updated
  }

  core = {
    context: pluginContext,
    store,
    registerWorkerPort: port => { workerPort = port },
    requireCoordinator,
    getRun: runId => runId === run.id ? run : (() => { throw error('run_not_found', `Run ${runId} was not found`) })(),
    getTask: taskId => tasks.get(taskId) ?? (() => { throw error('task_not_found', `Task ${taskId} was not found`) })(),
    getDispatch: dispatchId => dispatches.get(dispatchId) ?? (() => { throw error('dispatch_not_found', `Dispatch ${dispatchId} was not found`) })(),
    createDispatch: input => {
      const dispatchId = `ctx_test_${++sequence}` as DispatchId
      const dispatch: DispatchRow = {
        id: dispatchId, runId: input.runId ?? run.id, taskId: input.taskId, contractVersion: 1,
        status: 'pending', assigneeSessionId: input.assigneeSessionId, creatorSessionId: caller.callerSessionId,
        creatorDispatchId: null, retryOfDispatchId: input.retryOfDispatchId ?? null, depth: 0, failureCount: 0,
        lastFailure: null, terminationReason: null, consumerGeneration: 1, createdAt: NOW, dispatchedAt: null,
        completedAt: null, lastHeartbeatAt: null,
      }
      dispatches.set(dispatchId, dispatch)
      return dispatch
    },
    createTask: (input, evidence) => {
      requireCoordinator(evidence, input.runId)
      const id = `task_test_${++sequence}` as TaskId
      const title = input.taskTitle?.trim() || 'New worker task'
      const task: TaskRow = {
        id, runId: input.runId ?? run.id, parentTaskId: input.parentTaskId ?? null,
        dependencyTaskIds: input.dependencyTaskIds ?? [], createdBySessionId: isServiceCoordinator(evidence) ? null : evidence.callerSessionId,
        taskTitle: title, displayName: input.displayName?.trim() || title, spec: input.spec,
        status: 'ready', result: null, createdAt: NOW, completedAt: null,
      }
      tasks.set(id, task)
      return task
    },
    reserveWorkerDispatch: (input, evidence) => {
      requireCoordinator(evidence, input.runId)
      const task = tasks.get(input.taskId)
      if (!task || task.runId !== input.runId) throw error('task_not_found', `Task ${input.taskId} was not found in Run ${input.runId}`)
      const lineage = [...dispatches.values()].filter(dispatch => dispatch.taskId === task.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      if (input.retryOfDispatchId) {
        const prior = lineage.at(-1)
        const priorWorker = prior ? records.get(prior.id) : null
        if (!prior || prior.id !== input.retryOfDispatchId || prior.status !== 'failed' || !priorWorker || !['failed', 'stopped', 'abandoned'].includes(priorWorker.state) || !['failed', 'blocked'].includes(task.status)) {
          throw error('task_not_startable', `Task ${task.id} is not eligible for retry`)
        }
      } else if (task.status !== 'ready') {
        throw error('task_not_startable', `Task ${task.id} is ${task.status}`)
      }
      if (lineage.some(dispatch => dispatch.status === 'pending' || dispatch.status === 'dispatched')) throw error('task_not_startable', `Task ${task.id} already has a live attempt`)
      const dispatchId = `ctx_test_${++sequence}` as DispatchId
      const dispatch: DispatchRow = {
        id: dispatchId, runId: input.runId, taskId: input.taskId, contractVersion: 1, status: 'pending',
        assigneeSessionId: null, creatorSessionId: isServiceCoordinator(evidence) ? null : evidence.callerSessionId,
        creatorDispatchId: null, retryOfDispatchId: input.retryOfDispatchId ?? null, depth: 0,
        failureCount: lineage.at(-1)?.failureCount ?? 0, lastFailure: null, terminationReason: null,
        consumerGeneration: 1, createdAt: NOW, dispatchedAt: null, completedAt: null, lastHeartbeatAt: null,
      }
      dispatches.set(dispatchId, dispatch)
      tasks.set(task.id, { ...task, status: 'dispatched' })
      return dispatch
    },
    attachWorkerAuthority: (dispatchId, identity, evidence) => {
      requireCoordinator(evidence)
      const current = dispatches.get(dispatchId)
      const worker = repository.get(dispatchId)
      if (!worker || worker.processIncarnation !== identity.processIncarnation || worker.processRuntimeEpoch !== identity.runtimeEpoch) {
        throw error('worker_identity_changed', `Dispatch ${dispatchId} identity does not match its custody record`)
      }
      if (!current || current.status !== 'pending') throw error('lifecycle_conflict', `Dispatch ${dispatchId} cannot attach`)
      const updated = { ...current, assigneeSessionId: identity.sessionId, consumerGeneration: current.consumerGeneration + 1 }
      dispatches.set(dispatchId, updated)
      return updated
    },
    mutateWorker: async <T extends object>(
      _method: string,
      params: MutationRequest & object,
      _evidence: CoordinatorEvidence,
      operation: (store: PluginStore) => T,
      options?: DurableMutationOptions<T>,
    ) => {
      const key = `${params.requestId}`
      const fingerprint = JSON.stringify(params)
      const prior = receipts.get(key)
      if (prior && prior.fingerprint !== fingerprint) throw error('request_mismatch', `Request ${key} changed payload`)
      if (prior?.state === 'pending') throw error('operation_unknown', `Request ${key} is unresolved`)
      if (prior?.state === 'completed') return { ...structuredClone(prior.result as T), mutation: { requestId: params.requestId, replayed: true } }
      receipts.set(key, { fingerprint, state: 'pending' })
      try {
        await options?.beforeAccept?.()
        const accepted = store.transaction(() => {
          const value = operation(store)
          const checkpoint = options?.acceptedCheckpoint?.(value)
          receipts.set(key, { fingerprint, state: 'pending', checkpoint })
          return value
        })
        const result = options?.afterCommit ? await options.afterCommit(accepted) : accepted
        receipts.set(key, { fingerprint, state: 'completed', result: structuredClone(result) })
        return { ...result, mutation: { requestId: params.requestId, replayed: false } }
      } catch (cause) {
        receipts.delete(key)
        throw cause
      }
    },
    mutate: (method, params, evidence, operation, options) =>
      core.mutateWorker(method, params, evidence, operation, options),
    emitWorkerStatus: (dispatchId, subject, body, high) => { setupStatuses.push({ dispatchId, subject, body, high }) },
    closeWorkerQuestions: () => undefined,
    listDispatches: () => [...dispatches.values()],
    boundRunId: evidence => evidence.callerSessionId === run.coordinatorSessionId ? run.id : null,
    attentionFor: () => ({ guidance: false, input: false, approval: false, rootCompletion: false }),
    admitDispatch: () => ({ admitted: true, depth: 0, failureCount: 0, retryOfDispatchId: null }),
    transitionTask,
    blockTaskForWorkerStop,
    transitionDispatch,
    transitionWorker: input => {
      const record = repository.get(input.dispatchId)
      if (!record || record.state !== input.expectedState) throw error('lifecycle_conflict', `Worker ${input.dispatchId} changed`)
      return repository.update(input.dispatchId, { state: input.nextState }, input.expectedState)
    },
    reportWorkerDone: (input, evidence) => {
      const dispatch = dispatches.get(input.dispatchId)
      if (!dispatch || dispatch.taskId !== input.taskId) throw error('task_dispatch_mismatch', 'Report does not match its Dispatch')
      if (dispatch.assigneeSessionId !== evidence.runtimeSessionId) throw error('worker_identity_changed', 'Report identity changed')
      const worker = repository.get(input.dispatchId)
      if (!worker || worker.processIncarnation !== evidence.attestation.processIncarnation || worker.processRuntimeEpoch !== evidence.attestation.runtimeEpoch) {
        throw error('worker_identity_changed', 'Report process or runtime epoch changed')
      }
      const task = tasks.get(dispatch.taskId)
      if (!task || !['dispatched', 'blocked'].includes(task.status)) throw error('dispatch_inactive', 'Task is not active')
      const accepted = workerPort?.acceptReport(store, { dispatchId: input.dispatchId, outcome: input.outcome, caller: evidence, at: NOW })
      if (!accepted) throw error('dispatch_inactive', 'Worker report was not accepted')
      if (dispatch.status === 'pending') transitionDispatch({ dispatchId: dispatch.id, expectedState: 'pending', nextState: input.outcome === 'succeeded' ? 'completed' : 'failed', at: NOW })
      else if (dispatch.status === 'dispatched') transitionDispatch({ dispatchId: dispatch.id, expectedState: 'dispatched', nextState: input.outcome === 'succeeded' ? 'completed' : 'failed', at: NOW })
      const reportedTask = transitionTask({ taskId: task.id, expectedState: task.status, nextState: input.outcome === 'succeeded' ? 'completed' : 'failed', at: NOW })
      return { status: 'accepted', task: reportedTask, dispatch: dispatches.get(dispatch.id)!, worker: accepted }
    },
    recordHeartbeat: () => ({ status: 'accepted', lastHeartbeatAt: NOW }),
  }

  const lifecycle = {
    hasLiveForTask: (_store: PluginStore, taskId: TaskId) => [...records.values()].some(record => dispatches.get(record.dispatchId)?.taskId === taskId && ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'].includes(record.state)),
    stateForDispatch: (_store: PluginStore, dispatchId: DispatchId) => records.get(dispatchId)?.state ?? null,
    settleDispatch: (_store: PluginStore, dispatchId: DispatchId, status: DispatchStatus) => {
      const record = records.get(dispatchId)
      if (record && status !== 'pending' && status !== 'dispatched') repository.update(dispatchId, { state: status === 'completed' ? 'succeeded' : 'failed', stage: 'settled' })
    },
    acceptReport: (_store: PluginStore, input: { dispatchId: DispatchId; outcome: WorkerOutcome }) => {
      const record = records.get(input.dispatchId)
      if (!record || !['starting', 'start_unknown', 'ready', 'failed'].includes(record.state)) return null
      return repository.update(input.dispatchId, { state: input.outcome === 'succeeded' ? 'succeeded' : 'failed', stage: 'settled', receipt: record.receipt ? { ...record.receipt, state: 'ready', stage: 'settled', workerOutcome: input.outcome } : null }) as WorkerRecord
    },
    recordHeartbeat: () => undefined,
    stop: async () => ({} as never),
    abandon: async () => ({} as never),
    release: async () => ({} as never),
    retain: async () => ({} as never),
    userInput: (input: WorkerUserInputParams) => {
      const resource = repository.resourceBySession(input.session)
      if (!resource || resource.processIncarnation !== input.expectedIncarnation) return { takenOver: false }
      repository.putResource({ ...resource, ownershipState: 'user_owned', releaseState: 'retained', retainedReason: 'user_takeover' })
      return { takenOver: true }
    },
    recoverReleases: async () => undefined,
    onExit: () => undefined,
    dispose: () => undefined,
  } as unknown as WorkerLifecycle
  core.registerWorkerPort(lifecycle)

  const events: string[] = []
  const setup: WorkerSetup = { requested: 'run', effective: 'run', source: 'repo_policy', hookFound: false, startupPolicy: 'start-immediately', state: 'not_configured' }
  const session = {
    id: 'session_worker', kind: 'terminal', agent: 'claude', worktreeId: WORKTREE_ID,
    cwd: '/tmp/worker-worktree', title: 'Worker: Implement durable worker starts', status: 'running',
    createdAt: Date.now(), lastActivityAt: Date.now(), exitCode: null, exitSignal: null,
    exitCause: null, restorable: false,
  } as Session
  const identity: SessionIdentity = {
    sessionId: session.id, live: true, runtimeEpoch: 'kernel_epoch_1', processIncarnation: 'worker-incarnation-1',
    source: 'terminal_launch', kind: 'terminal', providerId: null, worktreeId: WORKTREE_ID,
  }
  const placement: WorkerPlacement = {
    worktreeId: WORKTREE_ID, session, identity, created: true,
    effects: [{ kind: 'terminal', action: 'created', role: 'agent', id: session.id }], setup,
  }
  const runtime: StatefulRuntime = {
    context: pluginContext,
    epoch: 'supervisor_epoch_1',
    events,
    validateCalls: 0,
    placeCalls: 0,
    waitReadyCalls: 0,
    submitCalls: 0,
    submittedOperations: [],
    submitResult: 'observed',
    placement,
    async validate() {
      if (this.validateError) throw this.validateError
      this.validateCalls += 1
      return { worktreeId: WORKTREE_ID, decision: { mode: 'terminal', preferred: 'terminal', reason: 'default', detail: 'Terminal mode requested.' } }
    },
    async place(_params, _task, dispatch, _evidence, onCustody) {
      this.placeCalls += 1
      events.push('place')
      if (this.placeError) throw this.placeError
      for (const item of this.placement.effects) {
        if (item.kind === 'setup') {
          setupSessions.set(item.id, { ...session, id: item.id, kind: 'terminal', agent: 'shell', title: 'Setup', status: 'running', exitCode: null })
        }
      }
      onCustody(this.placement)
      events.push('custody')
      this.afterCustody?.(dispatch.id)
      return this.placement
    },
    async waitReady() {
      this.waitReadyCalls += 1
      events.push('ready')
      if (this.readyError) throw this.readyError
    },
    async submit(_placement, _text, operationId) {
      this.submitCalls += 1
      this.submittedOperations.push(operationId)
      events.push('submit')
      await this.beforeSubmit?.([...dispatches.values()].at(-1)!.id)
      return this.submitResult
    },
    async observe() {
      return { status: 'live', exactWorker: true, reason: null, identity, session }
    },
    async close() {
      return { closed: false, reason: 'fixture does not close sessions' }
    },
    dispose() {
      events.push('dispose')
    },
  }
  const starter = createWorkerStarter(core, repository, runtime, lifecycle)

  return {
    core, repository, runtime, lifecycle, starter, tasks, dispatches, records, resources, setupStatuses, run, caller,
    reportFromWorker(dispatchId, outcome) {
      const dispatch = dispatches.get(dispatchId)
      if (!dispatch) throw error('dispatch_not_found', `Dispatch ${dispatchId} was not found`)
      const workerIdentity = identity
      core.reportWorkerDone({
        taskId: dispatch.taskId, dispatchId, outcome, messageId: `msg_${dispatchId}` as never,
        subject: `Worker ${outcome}`, body: 'Completed the assigned task.',
      }, {
        callerSessionId: workerIdentity.sessionId,
        runtimeSessionId: workerIdentity.sessionId,
        runtimeOwned: true,
        live: true,
        attestation: { source: workerIdentity.source, runtimeEpoch: workerIdentity.runtimeEpoch, processIncarnation: workerIdentity.processIncarnation },
      })
    },
    emitSetupExit(sessionId, exitCode) {
      const setupSession = { ...session, id: sessionId, kind: 'terminal', agent: 'shell', title: 'Setup', status: 'exited', exitCode } as Session
      setupSessions.set(sessionId, setupSession)
      const event: QuirkyEvent = { type: 'quirky.session/changed', data: { session: setupSession } }
      for (const listener of setupListeners) void listener(event)
    },
    simulateUserInput(sessionId, expectedIncarnation) {
      latestPhysicalInput = { session: sessionId, expectedIncarnation, at: Date.now() }
    },
  }
}
