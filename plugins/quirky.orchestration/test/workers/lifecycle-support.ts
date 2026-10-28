import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PluginContext, PluginStore, StoreValue } from '@quirky/protocol'
import type {
  DispatchId, DispatchRow, DispatchTransitionInput, RunRow, RuntimeCallerEvidence,
  TaskId, TaskRow, TaskTransitionInput, UtcTimestamp, WorkerDoneReportInput,
  WorkerHeartbeatInput, WorkerReportResult, WorkerTransitionInput,
} from '../../src/contracts'
import type {
  CoordinatorEvidence, TerminalResource, WorkerArchive, WorkerCore, WorkerLifecycle, WorkerObservation,
  WorkerOutput, WorkerRecord, WorkerRepository, WorkerRuntime,
} from '../../src/worker-contracts'
import type { SessionIdentity } from '../../src/runtime-contracts'
import { createWorkerLifecycle } from '../../src/workers/lifecycle'
import { createWorkerStore, workerMigrations } from '../../src/workers/store'

export type LifecycleFixture = {
  store: PluginStore
  repo: WorkerRepository
  core: WorkerCore
  lifecycle: WorkerLifecycle
  worker: WorkerRecord
  dispatch: DispatchRow
  task: TaskRow
  caller: RuntimeCallerEvidence
  events: string[]
  closed: TerminalResource[]
  statusEmissions: { dispatchId: DispatchId; subject: string; body: string; high: boolean }[]
  closeQuestionCalls: DispatchId[]
  captureCount(): number
  setObservation(observation: Partial<WorkerObservation>): void
  setCaptureHandler(handler: (dispatchId: DispatchId) => Promise<WorkerArchive>): void
  setCloseHandler(handler: (resource: TerminalResource) => Promise<void> | void): void
  observationCount(dispatchId: DispatchId, facet: string): number
  close(): void
}

type FixtureOptions = {
  state?: WorkerRecord['state']
  runtimeEpoch?: string
  workerRuntimeEpoch?: string
  processIncarnation?: string | null
  dispatchStatus?: DispatchRow['status']
  taskStatus?: TaskRow['status']
  closeResult?: { closed: boolean; reason?: string }
}

export function createLifecycleFixture(options: FixtureOptions = {}): LifecycleFixture {
  const root = mkdtempSync(join(tmpdir(), 'quirky-worker-lifecycle-'))
  const db = new Database(join(root, 'store.sqlite'))
  let depth = 0
  let savepointSequence = 0
  const store: PluginStore = {
    get version() { return 0 },
    run(sql: string, ...params: StoreValue[]) {
      const result = db.query(sql).run(...params)
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T | null {
      return (db.query(sql).get(...params) as T | undefined) ?? null
    },
    all<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T[] {
      return db.query(sql).all(...params) as T[]
    },
    exec(sql: string) { db.exec(sql) },
    transaction<T>(work: () => T): T {
      const nested = depth > 0
      const savepoint = `worker_test_${++savepointSequence}`
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      depth += 1
      try {
        const result = work()
        if (result !== null && typeof result === 'object' && 'then' in result) {
          throw new TypeError('PluginStore transactions must be synchronous')
        }
        db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK')
        if (nested) db.exec(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      } finally {
        depth -= 1
      }
    }
  }
  store.transaction(() => {
    for (const migration of workerMigrations) {
      if (typeof migration === 'string') store.exec(migration)
      else migration(store)
    }
  })
  const repo = createWorkerStore(store)

  const now: UtcTimestamp = '2026-10-27T00:00:00.000Z'
  const runId = 'run_test' as TaskRow['runId']
  const taskId = 'task_test' as TaskId
  const dispatchId = 'ctx_test' as DispatchId
  const workerSession = 'worker-session'
  const epoch = options.runtimeEpoch ?? 'epoch-1'
  const processEpoch = 'kernel-epoch-1'
  const incarnation = options.processIncarnation === undefined ? 'incarnation-1' : options.processIncarnation
  const defaultState = options.state ?? 'ready'
  const dispatchStatus = options.dispatchStatus ?? (
    defaultState === 'succeeded' ? 'completed' : defaultState === 'failed' ? 'failed' : 'dispatched'
  )
  const taskStatus = options.taskStatus ?? (
    defaultState === 'succeeded' ? 'completed' : defaultState === 'failed' ? 'failed' : 'dispatched'
  )
  const task: TaskRow = {
    id: taskId,
    runId,
    parentTaskId: null,
    dependencyTaskIds: [],
    createdBySessionId: 'coordinator-session',
    taskTitle: 'Lifecycle test task',
    displayName: 'Lifecycle task',
    spec: 'Exercise worker lifecycle',
    status: taskStatus,
    result: null,
    createdAt: now,
    completedAt: null
  }
  const dispatch: DispatchRow = {
    id: dispatchId,
    runId,
    taskId,
    contractVersion: 1,
    status: dispatchStatus,
    assigneeSessionId: workerSession,
    creatorSessionId: 'coordinator-session',
    creatorDispatchId: null,
    retryOfDispatchId: null,
    depth: 0,
    failureCount: 0,
    lastFailure: null,
    terminationReason: null,
    consumerGeneration: 1,
    createdAt: now,
    dispatchedAt: dispatchStatus === 'dispatched' ? now : null,
    completedAt: dispatchStatus === 'completed' || dispatchStatus === 'failed' ? now : null,
    lastHeartbeatAt: null
  }
  const worker: WorkerRecord = {
    dispatchId,
    state: defaultState,
    stage: defaultState,
    worktreeId: 'worktree-worker',
    sessionId: workerSession,
    setupState: 'ready',
    effects: [],
    residualResources: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
    runtimeEpoch: options.workerRuntimeEpoch ?? epoch,
    processIncarnation: incarnation,
    processRuntimeEpoch: processEpoch,
    mode: 'terminal',
    startOptions: { requestId: 'request-start', contractVersion: 1, taskId, worktree: 'current' },
    receipt: null
  }
  const resource: TerminalResource = {
    id: 'terminal-resource-1',
    originDispatchId: dispatchId,
    ownerDispatchId: dispatchId,
    priorOwnerDispatchIds: [],
    worktreeId: worker.worktreeId!,
    sessionId: workerSession,
    processIncarnation: incarnation ?? 'incarnation-1',
    ownershipState: 'owned',
    releaseState: 'not_requested',
    retainedReason: null,
    releaseRequestedAt: null,
    releaseCompletedAt: null,
    releaseError: null,
    recoveryAttemptCount: 0,
    lastRecoveryAt: null,
    archiveSource: null,
    archiveStatus: null
  }
  repo.insert(worker)
  repo.putResource(resource)

  const tasks = new Map<TaskId, TaskRow>([[taskId, task]])
  const dispatches = new Map<DispatchId, DispatchRow>([[dispatchId, dispatch]])
  const events: string[] = []
  const closed: TerminalResource[] = []
  const statusEmissions: { dispatchId: DispatchId; subject: string; body: string; high: boolean }[] = []
  const closeQuestionCalls: DispatchId[] = []
  let registeredPort: Parameters<WorkerCore['registerWorkerPort']>[0] | null = null
  let registrationCount = 0
  const transitionDispatch = (input: DispatchTransitionInput): DispatchRow => {
    const current = dispatches.get(input.dispatchId)
    if (!current || current.status !== input.expectedState) throw new Error('dispatch state compare-and-set failed')
    const failureClass = 'failureClass' in input ? input.failureClass : null
    const next: DispatchRow = {
      ...current,
      status: input.nextState,
      failureCount: failureClass === 'infrastructure' ? current.failureCount + 1 : current.failureCount,
      lastFailure: 'failureReason' in input ? input.failureReason ?? current.lastFailure : current.lastFailure,
      completedAt: input.nextState === 'dispatched' ? null : input.at
    }
    dispatches.set(input.dispatchId, next)
    registeredPort?.settleDispatch(store, input.dispatchId, next.status, input.at)
    return next
  }
  const identityFor = (record: WorkerRecord): SessionIdentity | null =>
    record.processIncarnation === null || record.sessionId === null || record.processRuntimeEpoch === null ? null : ({
      sessionId: record.sessionId,
      live: true,
      runtimeEpoch: record.processRuntimeEpoch,
      processIncarnation: record.processIncarnation,
      source: 'terminal_launch',
      kind: 'terminal',
      providerId: null,
      worktreeId: record.worktreeId ?? 'worktree-worker'
    })
  const caller: RuntimeCallerEvidence = {
    callerSessionId: workerSession,
    runtimeSessionId: workerSession,
    runtimeOwned: true,
    live: true,
    attestation: {
      source: 'terminal_launch',
      runtimeEpoch: processEpoch,
      processIncarnation: incarnation ?? 'incarnation-1'
    }
  }
  const core = {
    context: {
      error: (_kind: string, message: string) => new Error(message)
    } as unknown as PluginContext,
    store,
    nestedWorkerMaxDepth: 1,
    registerWorkerPort(port: Parameters<WorkerCore['registerWorkerPort']>[0]) {
      registrationCount += 1
      if (registrationCount > 1) throw new Error('worker port registered more than once')
      registeredPort = port
    },
    requireCoordinator(_caller: CoordinatorEvidence, scopedRunId?: string) {
      if (scopedRunId !== undefined && scopedRunId !== runId) throw new Error('coordinator Run mismatch')
      return {
        id: runId,
        objective: 'Lifecycle test',
        coordinatorSessionId: 'coordinator-session',
        coordinatorHistory: ['coordinator-session'],
        consumerGeneration: 1,
        createdAt: now,
        updatedAt: now
      } as RunRow
    },
    getRun: () => { throw new Error('not used by lifecycle tests') },
    getTask(id: TaskId) {
      const row = tasks.get(id)
      if (!row) throw new Error(`unknown task ${id}`)
      return row
    },
    getDispatch(id: DispatchId) {
      const row = dispatches.get(id)
      if (!row) throw new Error(`unknown dispatch ${id}`)
      return row
    },
    listDispatches() { return [...dispatches.values()] },
    boundRunId: () => runId,
    attentionFor: () => ({ guidance: false, input: false, approval: false, rootCompletion: false }),
    createDispatch: () => { throw new Error('not used by lifecycle tests') },
    createTask: () => { throw new Error('not used by lifecycle tests') },
    reserveWorkerDispatch: () => { throw new Error('not used by lifecycle tests') },
    attachWorkerAuthority: () => { throw new Error('not used by lifecycle tests') },
    transitionTask(input: TaskTransitionInput) {
      const current = tasks.get(input.taskId)
      if (!current || current.status !== input.expectedState) throw new Error('task state compare-and-set failed')
      const next = { ...current, status: input.nextState, result: input.result ?? current.result, updatedAt: input.at } as TaskRow
      tasks.set(input.taskId, next)
      return next
    },
    transitionDispatch,
    transitionWorker(input: WorkerTransitionInput) {
      if (!registeredPort) throw new Error('worker lifecycle port is not registered')
      const workerRow = registeredPort.transitionWorker(store, input)
      if (input.nextState === 'stopping') {
        const dispatch = dispatches.get(input.dispatchId)
        if (dispatch) dispatches.set(input.dispatchId, { ...dispatch, consumerGeneration: dispatch.consumerGeneration + 1 })
        closeQuestionCalls.push(input.dispatchId)
      }
      return workerRow
    },
    mutateWorker<T extends object>(
      _method: string,
      params: { requestId: string },
      _caller: CoordinatorEvidence,
      operation: (store: PluginStore) => T,
      options?: { afterCommit?: (accepted: T) => T | Promise<T> }
    ) {
      const accepted = store.transaction(() => operation(store))
      const completed = options?.afterCommit ? options.afterCommit(accepted) : accepted
      return Promise.resolve(completed).then((result) => ({
        ...result,
        mutation: { requestId: params.requestId, replayed: false }
      }))
    },
    emitWorkerStatus(dispatchId: DispatchId, subject: string, body: string, high: boolean) {
      statusEmissions.push({ dispatchId, subject, body, high })
    },
    closeWorkerQuestions(dispatchId: DispatchId) { closeQuestionCalls.push(dispatchId) },
    reportWorkerDone(input: WorkerDoneReportInput, reportCaller: RuntimeCallerEvidence): WorkerReportResult {
      const currentDispatch = dispatches.get(input.dispatchId)
      const currentTask = tasks.get(input.taskId)
      if (!currentDispatch || !currentTask || !registeredPort) return { status: 'rejected', reason: 'unknown_dispatch', audited: true }
      if (currentDispatch.taskId !== input.taskId) return { status: 'rejected', reason: 'task_dispatch_mismatch', audited: true }
      if (currentDispatch.status !== 'dispatched' || currentTask.status !== 'dispatched') return { status: 'rejected', reason: 'inactive_dispatch', audited: true }
      const accepted = registeredPort.acceptReport(store, {
        dispatchId: input.dispatchId,
        outcome: input.outcome,
        caller: reportCaller,
        at: now
      })
      if (!accepted) return { status: 'rejected', reason: 'worker_identity_changed', audited: true }
      const reportResult: TaskRow['result'] = {
        kind: 'worker_report',
        outcome: input.outcome,
        messageId: input.messageId,
        dispatchId: input.dispatchId,
        reportedBy: reportCaller.callerSessionId,
        subject: input.subject,
        body: input.body,
        completedBy: reportCaller.callerSessionId,
        filesModified: input.filesModified ?? [],
        reportPath: input.reportPath ?? null,
        completedAt: now
      }
      const nextStatus = input.outcome === 'succeeded' ? 'completed' : 'failed'
      const transition = {
        dispatchId: input.dispatchId,
        expectedState: 'dispatched' as const,
        nextState: nextStatus,
        ...(input.outcome === 'failed' ? { failureClass: 'worker_report' as const } : {}),
        at: now
      } as DispatchTransitionInput
      transitionDispatch(transition)
      const updatedTask: TaskRow = {
        ...currentTask,
        status: input.outcome === 'succeeded' ? 'completed' : 'failed',
        result: reportResult,
        completedAt: now
      }
      tasks.set(input.taskId, updatedTask)
      return { status: 'accepted', task: updatedTask, dispatch: dispatches.get(input.dispatchId)!, worker: accepted }
    },
    recordHeartbeat(_input: WorkerHeartbeatInput, _heartbeatCaller: RuntimeCallerEvidence) {
      return { status: 'accepted', lastHeartbeatAt: now }
    }
  } as unknown as WorkerCore

  let observationOverride: Partial<WorkerObservation> = {}
  let captureHandler: ((id: DispatchId) => Promise<WorkerArchive>) | null = null
  let closeHandler: ((resource: TerminalResource) => Promise<void> | void) | null = null
  let captures = 0
  const identity = identityFor(worker)
  const context = {
    pty: {
      onExit: (_listener: (...args: unknown[]) => void) => () => {}
    }
  } as unknown as PluginContext
  const runtime = {
    context,
    epoch,
    observe: async (record: WorkerRecord) => ({
      status: 'live',
      exactWorker: true,
      reason: null,
      identity,
      session: null,
      ...observationOverride
    } as WorkerObservation),
    close: async (target: TerminalResource) => {
      closed.push(target)
      events.push(`close:${target.id}`)
      if (closeHandler) await closeHandler(target)
      return options.closeResult ?? { closed: true }
    },
    dispose() {}
  } as unknown as WorkerRuntime
  const output = {
    read: async () => { throw new Error('read is not used by lifecycle tests') },
    capture: async (id: DispatchId) => {
      captures += 1
      events.push(`capture:${id}`)
      if (captureHandler) return captureHandler(id)
      return {
        dispatchId: id,
        resourceId: resource.id,
        kind: 'terminal_tail',
        content: 'captured output',
        sourceIdentity: `${workerSession}:${incarnation ?? 'none'}`,
        status: 'captured',
        createdAt: now
      }
    }
  } as unknown as WorkerOutput
  const lifecycle = createWorkerLifecycle(core, repo, runtime, output)

  return {
    store,
    repo,
    core,
    lifecycle,
    worker,
    dispatch,
    task,
    caller,
    events,
    closed,
    statusEmissions,
    closeQuestionCalls,
    captureCount: () => captures,
    setObservation(observation) { observationOverride = observation },
    setCaptureHandler(handler) { captureHandler = handler },
    setCloseHandler(handler) { closeHandler = handler },
    observationCount(id, facet) {
      return store.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM worker_observations WHERE dispatch_id = ? AND facet = ?', id, facet
      )?.count ?? 0
    },
    close() {
      lifecycle.dispose()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

export function controlParams(dispatchId: DispatchId, requestId: string) {
  return { dispatchId, requestId, contractVersion: 1 as const }
}

export function exactCaller(record: WorkerRecord): RuntimeCallerEvidence {
  if (!record.sessionId || !record.processIncarnation || !record.processRuntimeEpoch) throw new Error('fixture worker has no exact identity')
  return {
    callerSessionId: record.sessionId,
    runtimeSessionId: record.sessionId,
    runtimeOwned: true,
    live: true,
    attestation: {
      source: 'terminal_launch',
      runtimeEpoch: record.processRuntimeEpoch,
      processIncarnation: record.processIncarnation
    }
  }
}

