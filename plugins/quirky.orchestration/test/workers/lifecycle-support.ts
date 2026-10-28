import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PluginContext, PluginStore, StoreValue } from '@quirky/protocol'
import type {
  DispatchId, DispatchRow, DispatchTransitionInput, MutationRequest, RunRow, RuntimeCallerEvidence,
  TaskId, TaskRow, TaskTransitionInput, UtcTimestamp, WorkerDoneReportInput,
  WorkerHeartbeatInput, WorkerReportResult, WorkerTransitionInput,
} from '../../src/contracts'
import type {
  CoordinatorEvidence, TerminalResource, WorkerArchive, WorkerCore, WorkerLifecycle, WorkerObservation,
  WorkerOutput, WorkerRecord, WorkerRepository, WorkerRuntime,
} from '../../src/worker-contracts'
import type { SessionIdentity } from '../../src/runtime-contracts'
import type { DurableMutationOptions } from '../../src/worker-integration'
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
  const core: WorkerCore = {
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
    registerFederationAuthorityValidator() {
      throw new Error('Federated authority is unsupported by the local lifecycle fixture')
    },
    requireCoordinator(_caller: CoordinatorEvidence, scopedRunId?: string) {
      if (scopedRunId !== undefined && scopedRunId !== runId) throw new Error('coordinator Run mismatch')
      return {
        id: runId,
        objective: 'Lifecycle test',
        coordinatorSessionId: null,
        coordinatorHistory: [],
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
    admitDispatch: () => ({ admitted: true, depth: 0, failureCount: 0, retryOfDispatchId: null }),
    createDispatch: () => { throw new Error('not used by lifecycle tests') },
    createTask: () => { throw new Error('not used by lifecycle tests') },
    reserveWorkerDispatch: () => { throw new Error('not used by lifecycle tests') },
    attachWorkerAuthority: () => { throw new Error('not used by lifecycle tests') },
    transitionTask(input: TaskTransitionInput) {
      const current = tasks.get(input.taskId)
      if (!current || current.status !== input.expectedState) throw new Error('task state compare-and-set failed')
      if (current.status !== input.nextState && registeredPort?.hasLiveForTask(store, input.taskId)) {
        throw Object.assign(new Error('Task has a live supervised worker'), { code: 'task_not_startable' })
      }
      const next: TaskRow = {
        ...current,
        status: input.nextState,
        result: input.result === undefined ? current.result : input.result,
        completedAt: input.nextState === 'completed' ? input.at : null,
      }
      tasks.set(input.taskId, next)
      return next
    },
    blockTaskForWorkerStop({ taskId, dispatchId, at }: { taskId: TaskId; dispatchId: DispatchId; at: UtcTimestamp }) {
      const task = tasks.get(taskId)
      const activeDispatch = dispatches.get(dispatchId)
      const currentWorker = repo.get(dispatchId)
      if (!task || !activeDispatch || task.runId !== activeDispatch.runId || activeDispatch.taskId !== taskId ||
        (activeDispatch.status !== 'pending' && activeDispatch.status !== 'dispatched') ||
        !currentWorker || (currentWorker.state !== 'stopping' &&
          !(currentWorker.state === 'stop_unknown' && currentWorker.stage === 'stopping'))) {
        throw new Error('task_not_startable: Task has no exact active worker stop fence')
      }
      const hasIdentity = currentWorker.sessionId !== null || currentWorker.processIncarnation !== null ||
        currentWorker.processRuntimeEpoch !== null || activeDispatch.assigneeSessionId !== null
      if (hasIdentity && (!currentWorker.sessionId || !currentWorker.processIncarnation || !currentWorker.processRuntimeEpoch ||
        activeDispatch.assigneeSessionId !== currentWorker.sessionId)) {
        throw new Error('task_not_startable: Worker identity is not exactly attached to the Dispatch')
      }
      if ([...dispatches.values()].some(candidate => candidate.id !== dispatchId && candidate.taskId === taskId &&
        (candidate.status === 'pending' || candidate.status === 'dispatched'))) {
        throw new Error('task_not_startable: Task has another active attempt')
      }
      if (task.status === 'blocked') return task
      if (task.status !== 'dispatched') throw new Error('task_not_startable: Task is no longer dispatched')
      const updated: TaskRow = { ...task, status: 'blocked' }
      tasks.set(taskId, updated)
      return updated
    },
    transitionDispatch(input: DispatchTransitionInput) {
      const current = dispatches.get(input.dispatchId)
      if (!current || current.status !== input.expectedState) throw new Error('dispatch state compare-and-set failed')
      const failureClass = 'failureClass' in input ? input.failureClass : null
      const next: DispatchRow = {
        ...current,
        status: input.nextState,
        failureCount: failureClass === 'infrastructure' ? current.failureCount + 1 : current.failureCount,
        lastFailure: 'failureReason' in input ? input.failureReason ?? current.lastFailure : current.lastFailure,
        dispatchedAt: input.nextState === 'dispatched' ? input.at : current.dispatchedAt,
        completedAt: input.nextState === 'dispatched' ? null : input.at
      }
      dispatches.set(input.dispatchId, next)
      registeredPort?.settleDispatch(store, input.dispatchId, next.status, input.at)
      return next
    },
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
    async mutateWorker<T extends object>(
      _method: string,
      params: MutationRequest & object,
      _caller: CoordinatorEvidence,
      operation: (store: PluginStore) => T,
      options?: DurableMutationOptions<T>
    ) {
      await options?.beforeAccept?.()
      const accepted = store.transaction(() => {
        const value = operation(store)
        options?.acceptedCheckpoint?.(value)
        return value
      })
      const result = options?.afterCommit ? await options.afterCommit(accepted) : accepted
      return { ...result, mutation: { requestId: params.requestId, replayed: false } }
    },
    mutate: (method, params, caller, operation, options) =>
      core.mutateWorker(method, params, caller, operation, options),
    emitWorkerStatus(dispatchId: DispatchId, subject: string, body: string, high: boolean) {
      statusEmissions.push({ dispatchId, subject, body, high })
    },
    closeWorkerQuestions(dispatchId: DispatchId) { closeQuestionCalls.push(dispatchId) },
    reportWorkerDone(input: WorkerDoneReportInput, reportCaller: RuntimeCallerEvidence): WorkerReportResult {
      return store.transaction(() => {
        const currentDispatch = dispatches.get(input.dispatchId)
        if (!currentDispatch) return { status: 'rejected', reason: 'unknown_dispatch', audited: true }
        const currentTask = tasks.get(input.taskId)
        if (!currentTask) return { status: 'rejected', reason: 'unknown_task', audited: true }
        if (currentDispatch.taskId !== input.taskId) return { status: 'rejected', reason: 'task_dispatch_mismatch', audited: true }
        if (currentDispatch.assigneeSessionId === null || reportCaller.callerSessionId !== currentDispatch.assigneeSessionId) {
          return { status: 'rejected', reason: 'sender_not_assignee', audited: true }
        }
        const currentWorker = repo.get(currentDispatch.id)
        if (reportCaller.runtimeSessionId !== currentDispatch.assigneeSessionId || !currentWorker ||
          currentWorker.processIncarnation !== reportCaller.attestation.processIncarnation ||
          currentWorker.processRuntimeEpoch !== reportCaller.attestation.runtimeEpoch) {
          return { status: 'rejected', reason: 'worker_identity_changed', audited: true }
        }
        const latest = [...dispatches.values()]
          .filter(candidate => candidate.taskId === currentDispatch.taskId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
          .at(-1)
        if (latest?.id !== currentDispatch.id) return { status: 'rejected', reason: 'stale_dispatch', audited: true }
        if (currentDispatch.status === 'completed' || currentDispatch.status === 'failed' || currentDispatch.status === 'circuit_broken') {
          const priorResult = currentTask.result
          if (priorResult?.kind === 'worker_report' && priorResult.dispatchId === currentDispatch.id && priorResult.outcome === input.outcome) {
            return { status: 'duplicate', task: currentTask, dispatch: currentDispatch, worker: repo.get(currentDispatch.id) }
          }
          return { status: 'rejected', reason: 'inactive_dispatch', audited: true }
        }
        if (currentDispatch.status !== 'pending' && currentDispatch.status !== 'dispatched') {
          return { status: 'rejected', reason: 'dispatch_inactive', audited: true }
        }
        if (currentTask.status !== 'dispatched' && currentTask.status !== 'blocked') {
          return { status: 'rejected', reason: 'inactive_dispatch', audited: true }
        }
        if (!registeredPort) throw new Error('worker lifecycle port is not registered')
        if (currentWorker.state === 'stopping' || (currentWorker.state === 'stop_unknown' && currentWorker.stage === 'stopping') ||
          currentWorker.state === 'stopped' || currentWorker.state === 'abandoned') {
          return { status: 'rejected', reason: 'dispatch_inactive', audited: true }
        }
        const accepted = registeredPort.acceptReport(store, {
          dispatchId: input.dispatchId,
          outcome: input.outcome,
          caller: reportCaller,
          at: now
        })
        if (!accepted) return { status: 'rejected', reason: 'worker_identity_changed', audited: true }
        const reportResult: NonNullable<TaskRow['result']> = {
          kind: 'worker_report',
          outcome: input.outcome,
          messageId: input.messageId,
          dispatchId: input.dispatchId,
          reportedBy: reportCaller.runtimeSessionId,
          subject: input.subject,
          body: input.body,
          completedBy: reportCaller.runtimeSessionId,
          filesModified: [...(input.filesModified ?? [])],
          reportPath: input.reportPath ?? null,
          completedAt: now
        }
        const nextState = input.outcome === 'succeeded' ? 'completed' : 'failed'
        const settledDispatch = currentDispatch.status === 'pending'
          ? input.outcome === 'succeeded'
            ? this.transitionDispatch({ dispatchId: currentDispatch.id, expectedState: 'pending', nextState: 'completed', at: now })
            : this.transitionDispatch({ dispatchId: currentDispatch.id, expectedState: 'pending', nextState: 'failed', failureClass: 'worker_report', failureReason: 'worker_report', at: now })
          : input.outcome === 'succeeded'
            ? this.transitionDispatch({ dispatchId: currentDispatch.id, expectedState: 'dispatched', nextState: 'completed', at: now })
            : this.transitionDispatch({ dispatchId: currentDispatch.id, expectedState: 'dispatched', nextState: 'failed', failureClass: 'worker_report', failureReason: 'worker_report', at: now })
        const settledTask = this.transitionTask({
          taskId: currentTask.id,
          expectedState: currentTask.status,
          nextState: nextState === 'completed' ? 'completed' : 'failed',
          result: reportResult,
          at: now
        })
        return { status: 'accepted', task: settledTask, dispatch: settledDispatch, worker: accepted }
      })
    },
    recordHeartbeat(_input: WorkerHeartbeatInput, _heartbeatCaller: RuntimeCallerEvidence) {
      return { status: 'accepted', lastHeartbeatAt: now }
    },
    preflightFederatedWorkerDone() { return { status: 'rejected', reason: 'worker_identity_changed', audited: true } },
    reportFederatedWorkerDone() { return { status: 'rejected', reason: 'worker_identity_changed', audited: true } },
    recordFederatedHeartbeat() { return { status: 'rejected', reason: 'worker_identity_changed', lastHeartbeatAt: null } },
    reportFederatedWorkerExit() { return { status: 'rejected', reason: 'worker_identity_changed', audited: true } },
  }

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

