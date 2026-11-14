import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { PluginContext, PluginStore, StoreMigration, StoreValue } from '@quirky/protocol'
import { migrations as orchestrationMigrations } from '../src/store'
import { workerMigrations } from '../src/workers/store'
import { OrchestrationSummary } from '../src/summary'
import type { SummaryResult } from '../src/summary-contracts'

type WorktreeInput = { id: string; name: string; path: string; repoId: string }
type WorkerPage = { response: unknown }
type CallMethod = 'quirky.worktree/list' | 'quirky.session/list' | 'quirky.agent-status/dashboard' | 'quirky.orchestration/workerList'
type HarnessOptions = {
  worktrees?: unknown
  sessions?: unknown
  dashboard?: unknown
  pages?: WorkerPage[]
  failures?: Partial<Record<CallMethod, Error>>
  onWorkerSnapshot?: () => void
}
type RecordedCall = { method: string; params: Record<string, unknown> }

type TestStore = {
  store: PluginStore
  db: Database
  readonly writes: number
  readonly transactions: number
  readonly queries: readonly string[]
  resetCounters(): void
  failReads(error: Error | null): void
}

type SummaryHarness = TestStore & {
  summary: OrchestrationSummary
  calls: RecordedCall[]
  get forwarded(): number
  close(): void
}

function makeWorktree(id: string, path: string, name = id, repoId = `repo_${id}`): WorktreeInput {
  return { id, name, path, repoId }
}

function makeSession(
  id: string,
  worktreeId: string,
  status = 'working',
  kind: 'terminal' | 'structured' = 'structured',
  agent = kind === 'terminal' ? 'shell' : 'claude'
): Record<string, unknown> {
  return {
    id, worktreeId, status, kind, agent, cwd: `/session/${id}`, title: id,
    createdAt: 1, lastActivityAt: 2, exitCode: status === 'exited' ? 0 : null,
    exitSignal: null, exitCause: null, restorable: true
  }
}

function makeDashboardCard(sessionId: string, worktreeId: string, display: string, live = true) {
  return {
    bucket: 'working',
    thread: {
      sessionId, worktreeId, worktreeName: worktreeId, sessionName: sessionId,
      agent: 'claude', turn: `turn_${sessionId}`, turnStartedAt: 1, updatedAt: 2,
      display, label: display, prompt: 'private prompt', detail: 'private detail',
      children: [], unread: false, live
    }
  }
}

function makeDashboard(cards: unknown[] = [], unavailable: string[] = []) {
  return { cards, total: cards.length, hiddenIdle: 0, unavailable }
}

function makeResource(dispatchId: string, worktreeId: string, sessionId: string) {
  return {
    id: `resource_${dispatchId}`, originDispatchId: dispatchId, ownerDispatchId: dispatchId,
    priorOwnerDispatchIds: [], worktreeId, sessionId, processIncarnation: `inc_${dispatchId}`,
    ownershipState: 'owned', releaseState: 'not_requested', retainedReason: null,
    releaseRequestedAt: null, releaseCompletedAt: null, releaseError: null,
    recoveryAttemptCount: 0, lastRecoveryAt: null, archiveSource: null, archiveStatus: null
  }
}

type WorkerInput = {
  dispatchId: string
  taskId: string
  runId: string
  taskTitle: string
  dispatchStatus?: string
  workerState?: string | null
  terminalState?: string
  currentAssignment?: boolean
  workspaceId?: string | null
  hostKind?: string
  resource?: unknown
}

function makeWorker(options: WorkerInput) {
  const {
    dispatchId, taskId, runId, taskTitle, dispatchStatus = 'dispatched',
    workerState = 'ready', terminalState = 'active', currentAssignment = true,
    workspaceId = null, hostKind = 'local', resource = null
  } = options
  const workspace = workspaceId === null ? null : { id: workspaceId, kind: 'worktree' }
  const agentTerminalHandle = resource && typeof resource === 'object' && 'sessionId' in resource && typeof resource.sessionId === 'string'
    ? resource.sessionId : null
  return {
    dispatchId, taskId, runId, workerState, taskTitle, displayName: taskTitle,
    coordinatorSessionId: null, parentSessionId: null, currentAssignment,
    dispatchStatus, agentTerminalHandle, terminalState, resource,
    projection: {
      id: dispatchId, role: 'worker', parent: null, provider: null,
      host: { kind: hostKind, id: hostKind === 'remote' ? 'host_remote' : 'local' },
      workspace,
      stage: { worker: workerState, dispatch: dispatchStatus, detail: 'working', activity: 'working' },
      outcome: 'in_progress', liveness: { status: 'live', reason: null },
      evidence: { durable: true, liveStatus: 'fresh', lastObservedAt: '2026-11-01T00:00:00.000Z' },
      resource,
      nextAction: { kind: 'none', argv: [] }, attention: { categories: [], requiresAction: false }
    }
  }
}

function makePage(
  workers: unknown[],
  options: { nextCursor?: string | null; snapshotId?: string; total?: number; scope?: unknown } = {}
) {
  return {
    workers,
    scope: options.scope ?? { runId: null, source: 'all' },
    page: {
      nextCursor: options.nextCursor ?? null,
      snapshotId: options.snapshotId ?? 'snapshot_a',
      total: options.total ?? workers.length
    },
    partialHostErrors: []
  }
}

function createTestStore(): TestStore & { close(): void } {
  const db = new Database(':memory:')
  let transactionDepth = 0
  let savepointSequence = 0
  let writeCount = 0
  let transactionCount = 0
  let readError: Error | null = null
  const reads: string[] = []
  const store = {
    get version() { return 0 },
    get readOnly() { return false },
    run(sql: string, ...params: StoreValue[]) {
      writeCount += 1
      const result = db.query(sql).run(...params)
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T | null {
      reads.push(sql)
      if (readError) throw readError
      return (db.query(sql).get(...params) as T | undefined) ?? null
    },
    all<T = Record<string, unknown>>(sql: string, ...params: StoreValue[]): T[] {
      reads.push(sql)
      if (readError) throw readError
      return db.query(sql).all(...params) as T[]
    },
    exec(sql: string) {
      writeCount += 1
      db.exec(sql)
    },
    transaction<T>(work: () => T): T {
      transactionCount += 1
      const nested = transactionDepth > 0
      const savepoint = `summary_test_${++savepointSequence}`
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
      transactionDepth += 1
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
        transactionDepth -= 1
      }
    }
  } as unknown as PluginStore
  store.transaction(() => {
    for (const migration of [...orchestrationMigrations, ...workerMigrations] as StoreMigration[]) {
      if (typeof migration === 'string') store.exec(migration)
      else migration(store)
    }
  })
  writeCount = 0
  transactionCount = 0
  return {
    store, db,
    get writes() { return writeCount },
    get transactions() { return transactionCount },
    get queries() { return [...reads] },
    resetCounters() { writeCount = 0; transactionCount = 0; reads.length = 0 },
    failReads(error) { readError = error },
    close() { db.close() }
  }
}

function createHarness(options: HarnessOptions = {}): SummaryHarness {
  const testStore = createTestStore()
  const calls: RecordedCall[] = []
  let forwardCount = 0
  let pageIndex = 0
  let snapshotCallbackUsed = false
  const pages = options.pages ?? [{ response: makePage([]) }]
  const failures = options.failures ?? {}
  const context = {
    pluginId: 'quirky.orchestration',
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind }),
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params: { ...params } })
      const failure = failures[method as CallMethod]
      if (failure) throw failure
      if (method === 'quirky.worktree/list') return options.worktrees ?? []
      if (method === 'quirky.session/list') return options.sessions ?? []
      if (method === 'quirky.agent-status/dashboard') return options.dashboard ?? makeDashboard()
      if (method === 'quirky.orchestration/workerList') {
        const page = pages[pageIndex++]
        if (!page) throw new Error('unexpected workerList page request')
        if (pageIndex === pages.length && !snapshotCallbackUsed) {
          snapshotCallbackUsed = true
          options.onWorkerSnapshot?.()
        }
        return page.response
      }
      throw new Error(`disallowed public call: ${method}`)
    },
    forward: async () => {
      forwardCount += 1
      throw new Error('summary must not forward caller identity')
    }
  } as unknown as PluginContext
  const summary = new OrchestrationSummary(context, testStore.store)
  const closeStore = testStore.close
  return Object.assign(testStore, {
    summary, calls,
    get forwarded() { return forwardCount },
    close() { closeStore() }
  })
}

function seedRun(store: PluginStore, id: string, coordinatorSessionId: string | null = null, coordinatorHistory = '[]') {
  store.run(
    `INSERT INTO runs(id, objective, coordinator_session_id, coordinator_history_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, `objective ${id}`, coordinatorSessionId, coordinatorHistory, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
  )
}

function seedTask(
  store: PluginStore,
  id: string,
  runId: string,
  title: string,
  status = 'dispatched',
  creatorSessionId = `unlisted_creator_${id}`
) {
  store.run(
    `INSERT INTO tasks(id, run_id, created_by_session_id, task_title, display_name, spec, status, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, runId, creatorSessionId, title, title, 'sensitive task specification', status, '{"private":"result"}', '2026-11-01T00:00:00.000Z'
  )
}

function seedDispatch(
  store: PluginStore,
  id: string,
  taskId: string,
  runId: string,
  status = 'dispatched',
  creatorSessionId: string | null = null,
  assigneeSessionId: string | null = null
) {
  const assignee = assigneeSessionId ?? (status === 'dispatched' ? `s_fixture_${id}` : null)
  const supervisedIdentity = assignee === null ? [null, null] : [`runtime_${id}`, `incarnation_${id}`]
  store.run(
    `INSERT INTO dispatches(
       id, run_id, task_id, status, assignee_session_id, creator_session_id, depth,
       runtime_epoch, process_incarnation, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    id, runId, taskId, status, assignee, creatorSessionId,
    supervisedIdentity[0], supervisedIdentity[1], '2026-11-01T00:00:00.000Z'
  )
}

function seedDispatchBundle(
  store: PluginStore,
  values: { id: string; taskId: string; runId: string; title: string; dispatchStatus?: string; taskStatus?: string; creator?: string | null; assignee?: string | null }
) {
  seedTask(store, values.taskId, values.runId, values.title, values.taskStatus ?? 'dispatched', values.creator ?? `unlisted_creator_${values.taskId}`)
  seedDispatch(store, values.id, values.taskId, values.runId, values.dispatchStatus ?? 'dispatched', values.creator ?? null, values.assignee ?? null)
}

function rowFor(result: SummaryResult, worktreeId: string) {
  const row = result.rows.find((candidate) => candidate.worktree.id === worktreeId)
  if (!row) throw new Error(`missing summary row ${worktreeId}`)
  return row
}

function expectReadOnlyCalls(harness: SummaryHarness) {
  const allowed = new Set<CallMethod>([
    'quirky.worktree/list', 'quirky.session/list', 'quirky.agent-status/dashboard',
    'quirky.orchestration/workerList'
  ])
  expect(harness.calls.every((call) => allowed.has(call.method as CallMethod))).toBe(true)
  expect(harness.forwarded).toBe(0)
}

test('accepts the empty public name of a root folder workspace', async () => {
  const harness = createHarness({
    worktrees: [makeWorktree('wt_root', '/', '', 'repo_root')],
    sessions: [makeSession('s_root', 'wt_root')]
  })
  try {
    const result = await harness.summary.query({})
    expect(rowFor(result, 'wt_root').worktree).toEqual({
      id: 'wt_root', name: '', path: '/', repoId: 'repo_root'
    })
  } finally {
    harness.close()
  }
})

test('groups listed sessions and a supervised dispatch by exact worktree identity', async () => {
  const harness = createHarness({
    worktrees: [makeWorktree('wt_a', '/fixture/a', 'Alpha', 'repo_a'), makeWorktree('wt_b', '/fixture/b', 'Beta', 'repo_b'), makeWorktree('wt_empty', '/fixture/empty')],
    sessions: [makeSession('s_a', 'wt_a', 'working'), makeSession('s_shell', 'wt_a', 'running', 'terminal', 'shell'), makeSession('s_b', 'wt_b', 'waiting')],
    dashboard: makeDashboard([makeDashboardCard('s_a', 'wt_a', 'working')]),
    pages: [{ response: makePage([
      makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'Build summary', workspaceId: 'wt_a', resource: makeResource('ctx_a', 'wt_a', 's_a') })
    ]) }]
  })
  try {
    seedRun(harness.store, 'run_a', 's_a')
    seedTask(harness.store, 'task_a', 'run_a', 'Build summary', 'dispatched', 's_a')
    seedDispatch(harness.store, 'ctx_a', 'task_a', 'run_a', 'dispatched', 's_a', 's_a')
    seedRun(harness.store, 'run_b', 's_b')
    harness.resetCounters()

    const result = await harness.summary.query({})

    expect(result.scope).toBe('local')
    expect(result.rows.map((row) => row.worktree.id)).toEqual(['wt_a', 'wt_b'])
    expect(rowFor(result, 'wt_a')).toEqual({
      worktree: { id: 'wt_a', name: 'Alpha', path: '/fixture/a', repoId: 'repo_a' },
      sessions: [
        { id: 's_a', agent: 'claude', kind: 'structured', status: 'working', display: 'working', live: true },
        { id: 's_shell', agent: 'shell', kind: 'terminal', status: 'running', display: null, live: true }
      ],
      runIds: ['run_a'],
      dispatches: [{
        id: 'ctx_a', runId: 'run_a', task: { id: 'task_a', title: 'Build summary', status: 'dispatched' },
        status: 'dispatched', creatorSessionId: 's_a', assigneeSessionId: 's_a', workerSessionId: 's_a',
        currentAssignment: true, workerState: 'ready', terminalState: 'active'
      }]
    })
    expect(rowFor(result, 'wt_b').sessions[0]?.id).toBe('s_b')
    expect(result.rows.some((row) => row.worktree.id === 'wt_empty')).toBe(false)
    expect(result.unavailable).toEqual([])
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('associates every dispatch attempt once under creator and assignee worktrees', async () => {
  const harness = createHarness({
    worktrees: [makeWorktree('wt_a', '/fixture/a'), makeWorktree('wt_b', '/fixture/b')],
    sessions: [makeSession('s_coordinator', 'wt_a'), makeSession('s_target', 'wt_b', 'running', 'terminal', 'shell')],
    pages: [{ response: makePage([
      makeWorker({ dispatchId: 'ctx_old', taskId: 'task_context', runId: 'run_context', taskTitle: 'Context task', dispatchStatus: 'completed', workerState: 'succeeded', terminalState: 'released', currentAssignment: false }),
      makeWorker({ dispatchId: 'ctx_context', taskId: 'task_context', runId: 'run_context', taskTitle: 'Context task', workerState: null, terminalState: 'released', currentAssignment: false })
    ]) }]
  })
  try {
    seedRun(harness.store, 'run_context', 's_coordinator')
    seedTask(harness.store, 'task_context', 'run_context', 'Context task', 'dispatched', 's_coordinator')
    seedDispatch(harness.store, 'ctx_old', 'task_context', 'run_context', 'completed', 's_coordinator', 's_target')
    seedDispatch(harness.store, 'ctx_context', 'task_context', 'run_context', 'dispatched', 's_coordinator', 's_target')
    harness.resetCounters()

    const result = await harness.summary.query({})
    const expectedIds = ['ctx_context', 'ctx_old']
    for (const worktreeId of ['wt_a', 'wt_b']) {
      const row = rowFor(result, worktreeId)
      expect(row.dispatches.map((dispatch) => dispatch.id)).toEqual(expectedIds)
      expect(row.runIds).toEqual(['run_context'])
      for (const dispatch of row.dispatches) {
        expect(dispatch.creatorSessionId).toBe('s_coordinator')
        expect(dispatch.assigneeSessionId).toBe('s_target')
        expect(dispatch.workerSessionId).toBeNull()
        expect(dispatch.workerState).toBe(dispatch.id === 'ctx_old' ? 'succeeded' : null)
      }
    }
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('retains coordinator and task-creator history without inventing worker sessions', async () => {
  const harness = createHarness({
    worktrees: [
      makeWorktree('wt_history', '/fixture/history'), makeWorktree('wt_task', '/fixture/task'),
      makeWorktree('wt_worker', '/fixture/worker'), makeWorktree('wt_orphan', '/fixture/orphan'),
      makeWorktree('wt_historical', '/fixture/historical')
    ],
    sessions: [
      makeSession('s_history', 'wt_history', 'exited'), makeSession('s_history_extra', 'wt_history', 'exited', 'terminal', 'shell'),
      makeSession('s_task_creator', 'wt_task', 'exited'), makeSession('s_orphan', 'wt_orphan', 'exited', 'terminal', 'shell'),
      makeSession('s_historical_only', 'wt_historical', 'exited')
    ],
    pages: [{ response: makePage([
      makeWorker({
        dispatchId: 'ctx_stopped', taskId: 'task_stopped', runId: 'run_stopped', taskTitle: 'Stopped work',
        dispatchStatus: 'completed', workerState: 'stopped', terminalState: 'released', currentAssignment: false,
        resource: makeResource('ctx_stopped', 'wt_worker', 's_gone')
      })
    ]) }]
  })
  try {
    seedRun(harness.store, 'run_history', 's_history', '["s_historical_only"]')
    seedRun(harness.store, 'run_task', null)
    seedTask(harness.store, 'task_before_dispatch', 'run_task', 'Created before dispatch', 'ready', 's_task_creator')
    seedRun(harness.store, 'run_stopped', null)
    seedTask(harness.store, 'task_stopped', 'run_stopped', 'Stopped work', 'completed')
    seedDispatch(harness.store, 'ctx_stopped', 'task_stopped', 'run_stopped', 'completed', null, 's_gone')
    harness.resetCounters()

    const result = await harness.summary.query({})
    expect(rowFor(result, 'wt_history').runIds).toEqual(['run_history'])
    expect(rowFor(result, 'wt_history').sessions.map((session) => [session.id, session.live])).toEqual([
      ['s_history', false], ['s_history_extra', false]
    ])
    expect(rowFor(result, 'wt_task').runIds).toEqual(['run_task'])
    expect(rowFor(result, 'wt_worker').dispatches[0]).toMatchObject({
      id: 'ctx_stopped', workerSessionId: 's_gone', workerState: 'stopped', terminalState: 'released'
    })
    expect(rowFor(result, 'wt_worker').sessions).toEqual([])
    expect(result.rows.map((row) => row.worktree.id)).not.toContain('wt_orphan')
    expect(result.rows.map((row) => row.worktree.id)).not.toContain('wt_historical')
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('uses all-Runs local worker pages and filters remote ID collisions before joins', async () => {
  const local = makeWorker({ dispatchId: 'ctx_local', taskId: 'task_local', runId: 'run_a', taskTitle: 'Local A', workspaceId: 'wt_a' })
  const remoteCollision = makeWorker({
    dispatchId: 'ctx_remote_collision', taskId: 'task_remote', runId: 'run_a', taskTitle: 'Remote placeholder',
    workspaceId: 'wt_a', hostKind: 'remote', resource: makeResource('ctx_remote_collision', 'wt_a', 's_caller')
  })
  const hostLocal = makeWorker({ dispatchId: 'ctx_host_local', taskId: 'task_host_local', runId: 'run_b', taskTitle: 'Host-side local', workspaceId: 'wt_b' })
  const harness = createHarness({
    worktrees: [makeWorktree('wt_a', '/fixture/a'), makeWorktree('wt_b', '/fixture/b')],
    sessions: [makeSession('s_caller', 'wt_a'), makeSession('s_local', 'wt_b')],
    pages: [{ response: makePage([local, remoteCollision, hostLocal]) }]
  })
  try {
    seedRun(harness.store, 'run_a', 's_caller')
    seedTask(harness.store, 'task_local', 'run_a', 'Local A')
    seedDispatch(harness.store, 'ctx_local', 'task_local', 'run_a')
    seedTask(harness.store, 'task_remote', 'run_a', 'Remote placeholder')
    seedDispatch(harness.store, 'ctx_remote_collision', 'task_remote', 'run_a')
    seedRun(harness.store, 'run_b', 's_local')
    seedTask(harness.store, 'task_host_local', 'run_b', 'Host-side local')
    seedDispatch(harness.store, 'ctx_host_local', 'task_host_local', 'run_b')
    harness.resetCounters()

    const result = await harness.summary.query({})
    expect(result.scope).toBe('local')
    expect(rowFor(result, 'wt_a').dispatches.map((dispatch) => dispatch.id)).toEqual(['ctx_local'])
    expect(rowFor(result, 'wt_b').dispatches.map((dispatch) => dispatch.id)).toEqual(['ctx_host_local'])
    expect(result.rows.flatMap((row) => row.dispatches).some((dispatch) => dispatch.id === 'ctx_remote_collision')).toBe(false)
    expect(harness.calls.filter((call) => call.method === 'quirky.worktree/list')).toEqual([
      { method: 'quirky.worktree/list', params: {} }
    ])
    expect(harness.calls.filter((call) => call.method === 'quirky.session/list')).toEqual([
      { method: 'quirky.session/list', params: {} }
    ])
    expect(harness.calls.filter((call) => call.method === 'quirky.agent-status/dashboard')).toEqual([
      { method: 'quirky.agent-status/dashboard', params: { showIdle: true } }
    ])
    expect(harness.calls.filter((call) => call.method === 'quirky.orchestration/workerList').map((call) => call.params)).toEqual([
      { limit: 100, includeRemote: false }
    ])
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('consumes every fleet page before sorting and capping worktree rows', async () => {
  const worktrees = [makeWorktree('wt_a', '/fixture/a'), makeWorktree('wt_b', '/fixture/b'), makeWorktree('wt_c', '/fixture/c')]
  const workers = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index).padStart(3, '0')
    const worktreeId = index < 99 ? 'wt_a' : 'wt_b'
    return makeWorker({
      dispatchId: `ctx_${suffix}`, taskId: `task_${suffix}`, runId: 'run_page',
      taskTitle: `Task ${suffix}`, workspaceId: worktreeId
    })
  })
  const harness = createHarness({
    worktrees, sessions: [makeSession('s_c', 'wt_c')],
    pages: [
      { response: makePage(workers.slice(0, 100), { nextCursor: 'cursor_1', total: 101, snapshotId: 'snapshot_page' }) },
      { response: makePage(workers.slice(100), { total: 101, snapshotId: 'snapshot_page' }) }
    ]
  })
  try {
    seedRun(harness.store, 'run_page')
    for (let index = 0; index < workers.length; index += 1) {
      const suffix = String(index).padStart(3, '0')
      seedDispatchBundle(harness.store, {
        id: `ctx_${suffix}`, taskId: `task_${suffix}`, runId: 'run_page', title: `Task ${suffix}`
      })
    }
    harness.resetCounters()

    const result = await harness.summary.query({ limit: 2 })
    expect(result.rows.map((row) => row.worktree.path)).toEqual(['/fixture/a', '/fixture/b'])
    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.limit).toBe(2)
    expect(rowFor(result, 'wt_b').dispatches.map((dispatch) => dispatch.id)).toEqual(['ctx_099', 'ctx_100'])
    expect(harness.calls.filter((call) => call.method === 'quirky.orchestration/workerList').map((call) => call.params)).toEqual([
      { limit: 100, includeRemote: false }, { limit: 100, includeRemote: false, cursor: 'cursor_1' }
    ])
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('defaults to 100 rows, returns an exact empty shape, and rejects invalid direct limits', async () => {
  const empty = createHarness()
  try {
    expect(await empty.summary.query({})).toEqual({
      scope: 'local', rows: [], total: 0, limit: 100, truncated: false, unavailable: []
    })
  } finally {
    empty.close()
  }

  for (const limit of [1, 100]) {
    const valid = createHarness()
    try {
      expect((await valid.summary.query({ limit })).limit).toBe(limit)
    } finally {
      valid.close()
    }
  }
  for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    const harness = createHarness()
    try {
      await expect(harness.summary.query({ limit } as never)).rejects.toThrow()
      expect(harness.calls).toEqual([])
    } finally {
      harness.close()
    }
  }
})

test('rejects inconsistent fleet pagination instead of looping or dropping workers', async () => {
  const emptyPage = (options: Parameters<typeof makePage>[1] = {}) => makePage([], options)
  const malformedChains: Array<{ name: string; pages: WorkerPage[] }> = [
    { name: 'repeated cursor', pages: [
      { response: makePage([makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { nextCursor: 'cursor_a', total: 2 }) },
      { response: makePage([makeWorker({ dispatchId: 'ctx_b', taskId: 'task_b', runId: 'run_b', taskTitle: 'B' })], { nextCursor: 'cursor_a', total: 2 }) }
    ] },
    { name: 'snapshot change', pages: [
      { response: makePage([makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { nextCursor: 'cursor_a', total: 2, snapshotId: 'snapshot_a' }) },
      { response: makePage([makeWorker({ dispatchId: 'ctx_b', taskId: 'task_b', runId: 'run_b', taskTitle: 'B' })], { total: 2, snapshotId: 'snapshot_b' }) }
    ] },
    { name: 'total change', pages: [
      { response: makePage([makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { nextCursor: 'cursor_a', total: 2 }) },
      { response: makePage([makeWorker({ dispatchId: 'ctx_b', taskId: 'task_b', runId: 'run_b', taskTitle: 'B' })], { total: 3 }) }
    ] },
    { name: 'scope change', pages: [
      { response: makePage([makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { nextCursor: 'cursor_a', total: 2 }) },
      { response: makePage([makeWorker({ dispatchId: 'ctx_b', taskId: 'task_b', runId: 'run_b', taskTitle: 'B' })], { total: 2, scope: { runId: 'run_a', source: 'flag' } }) }
    ] },
    { name: 'duplicate dispatch ID', pages: [
      { response: makePage([makeWorker({ dispatchId: 'ctx_duplicate', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { nextCursor: 'cursor_a', total: 2 }) },
      { response: makePage([makeWorker({ dispatchId: 'ctx_duplicate', taskId: 'task_b', runId: 'run_b', taskTitle: 'B' })], { total: 2 }) }
    ] },
    { name: 'collected count differs from total', pages: [
      { response: makePage([makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { total: 2 }) }
    ] },
    { name: 'empty nonterminal page', pages: [
      { response: emptyPage({ nextCursor: 'cursor_a', total: 2 }) },
      { response: makePage([makeWorker({ dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'A' })], { total: 2 }) }
    ] }
  ]
  for (const { name, pages } of malformedChains) {
    const harness = createHarness({ pages })
    try {
      await expect(harness.summary.query({})).rejects.toThrow('summary_source_invalid: quirky.orchestration/workerList returned an invalid response.')
      if (name === 'empty nonterminal page') {
        expect(harness.calls.filter((call) => call.method === 'quirky.orchestration/workerList')).toHaveLength(1)
      }
    } catch (error) {
      throw new Error(`pagination case ${name} did not fail as an invalid workerList response`, { cause: error })
    } finally {
      harness.close()
    }
  }
})

test('matches dashboard cards by both IDs and keeps observed session liveness authoritative', async () => {
  const harness = createHarness({
    worktrees: [makeWorktree('wt_a', '/fixture/a')],
    sessions: [
      makeSession('s_live', 'wt_a', 'working'), makeSession('s_exited', 'wt_a', 'exited'),
      makeSession('s_missing', 'wt_a', 'running', 'terminal', 'shell')
    ],
    dashboard: makeDashboard([
      makeDashboardCard('s_live', 'wt_a', 'working', false),
      makeDashboardCard('s_live', 'wt_other', 'failed'),
      makeDashboardCard('s_exited', 'wt_a', 'done', true)
    ], ['z-dashboard-warning', 'a-dashboard-warning', 'z-dashboard-warning'])
  })
  try {
    const result = await harness.summary.query({})
    expect(rowFor(result, 'wt_a').sessions).toEqual([
      { id: 's_exited', agent: 'claude', kind: 'structured', status: 'exited', display: 'done', live: false },
      { id: 's_live', agent: 'claude', kind: 'structured', status: 'working', display: 'working', live: true },
      { id: 's_missing', agent: 'shell', kind: 'terminal', status: 'running', display: null, live: true }
    ])
    expect(result.unavailable).toEqual(['a-dashboard-warning', 'z-dashboard-warning'])
    expect(harness.calls.find((call) => call.method === 'quirky.agent-status/dashboard')?.params).toEqual({ showIdle: true })
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('degrades only dashboard display when its request rejects or response is malformed', async () => {
  const dashboardError = new Error('secret dashboard token and prompt')
  for (const options of [
    { failures: { 'quirky.agent-status/dashboard': dashboardError } },
    { dashboard: { cards: [makeDashboardCard('s_a', 'wt_a', 'working'), { thread: { sessionId: 5, worktreeId: 'wt_a', display: 'working' } }], total: 2, hiddenIdle: 0, unavailable: [] } }
  ] satisfies HarnessOptions[]) {
    const harness = createHarness({
      worktrees: [makeWorktree('wt_a', '/fixture/a')], sessions: [makeSession('s_a', 'wt_a'), makeSession('s_b', 'wt_a')], ...options
    })
    try {
      const result = await harness.summary.query({})
      expect(rowFor(result, 'wt_a').sessions.map((session) => session.display)).toEqual([null, null])
      expect(result.unavailable).toEqual(['agent-status-unavailable'])
      expect(JSON.stringify(result)).not.toContain('secret dashboard token and prompt')
      expectReadOnlyCalls(harness)
    } finally {
      harness.close()
    }
  }
})

test('fails closed on required-source errors and malformed join fields', async () => {
  const requiredMethods: CallMethod[] = [
    'quirky.worktree/list', 'quirky.session/list', 'quirky.orchestration/workerList'
  ]
  for (const method of requiredMethods) {
    const underlying = new Error(`underlying ${method} failure`)
    const harness = createHarness({ failures: { [method]: underlying } })
    try {
      await expect(harness.summary.query({})).rejects.toBe(underlying)
    } finally {
      harness.close()
    }
  }

  const malformedSources: Array<{ method: CallMethod; options: HarnessOptions }> = [
    { method: 'quirky.worktree/list', options: { worktrees: [{ id: 'wt_missing_fields', path: '/fixture/a', name: 'A' }] } },
    { method: 'quirky.session/list', options: { worktrees: [makeWorktree('wt_a', '/fixture/a')], sessions: [makeSession('s_bad', 'wt_a', 'unknown')] } },
    { method: 'quirky.orchestration/workerList', options: { pages: [{ response: makePage([{
      ...makeWorker({ dispatchId: 'ctx_bad', taskId: 'task_bad', runId: 'run_bad', taskTitle: 'Bad' }),
      projection: { ...makeWorker({ dispatchId: 'ctx_bad', taskId: 'task_bad', runId: 'run_bad', taskTitle: 'Bad' }).projection, host: { kind: 'other', id: 'host' } }
    }]) }] } },
    { method: 'quirky.orchestration/workerList', options: { pages: [{ response: makePage([{
      ...makeWorker({ dispatchId: 'ctx_bad', taskId: 'task_bad', runId: 'run_bad', taskTitle: 'Bad' }),
      projection: { ...makeWorker({ dispatchId: 'ctx_bad', taskId: 'task_bad', runId: 'run_bad', taskTitle: 'Bad' }).projection, workspace: { id: 5, kind: 'worktree' } }
    }]) }] } },
    { method: 'quirky.orchestration/workerList', options: { pages: [{ response: makePage([{
      ...makeWorker({ dispatchId: 'ctx_bad', taskId: 'task_bad', runId: 'run_bad', taskTitle: 'Bad' }),
      resource: { worktreeId: 5 }
    }]) }] } },
    { method: 'quirky.orchestration/workerList', options: { pages: [{ response: makePage([{
      ...makeWorker({ dispatchId: 'ctx_bad', taskId: 'task_bad', runId: 'run_bad', taskTitle: 'Bad' }), taskId: null
    }]) }] } }
  ]
  for (const { method, options } of malformedSources) {
    const harness = createHarness(options)
    try {
      await expect(harness.summary.query({})).rejects.toThrow(`summary_source_invalid: ${method} returned an invalid response.`)
    } finally {
      harness.close()
    }
  }

  const storeError = new Error('store read unavailable')
  const storeFailure = createHarness()
  try {
    storeFailure.failReads(storeError)
    await expect(storeFailure.summary.query({})).rejects.toBe(storeError)
  } finally {
    storeFailure.close()
  }
})

test('reads only local orchestration projections without changing stored records', async () => {
  const harness = createHarness({
    worktrees: [makeWorktree('wt_a', '/fixture/a')],
    sessions: [makeSession('s_a', 'wt_a')],
    pages: [{ response: makePage([makeWorker({
      dispatchId: 'ctx_a', taskId: 'task_a', runId: 'run_a', taskTitle: 'Safe projection', workspaceId: 'wt_a'
    })]) }]
  })
  try {
    seedRun(harness.store, 'run_a', 's_a')
    seedTask(harness.store, 'task_a', 'run_a', 'Safe projection', 'dispatched', 's_a')
    seedDispatch(harness.store, 'ctx_a', 'task_a', 'run_a')
    harness.resetCounters()
    const before = ['runs', 'tasks', 'dispatches', 'mutation_receipts'].map((table) =>
      Number(harness.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count)
    )

    const result = await harness.summary.query({})

    expect(result.rows).toHaveLength(1)
    expect(harness.writes).toBe(0)
    expect(harness.transactions).toBe(0)
    expect(harness.queries.length).toBeGreaterThan(0)
    for (const sql of harness.queries) {
      expect(sql).toMatch(/^\s*SELECT\b/i)
      expect(sql).not.toMatch(/\bSELECT\s+\*/i)
      expect(sql).not.toMatch(/\b(?:spec|result_json|body|archive|receipt|start_options)\b/i)
      expect(sql).toMatch(/\b(?:FROM|JOIN)\s+(?:runs|tasks|dispatches)\b/i)
      expect(sql).not.toMatch(/\b(?:messages|worker_terminal_archives|mutation_receipts|worker_dispatches)\b/i)
    }
    const after = ['runs', 'tasks', 'dispatches', 'mutation_receipts'].map((table) =>
      Number(harness.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count)
    )
    expect(after).toEqual(before)
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('does not fabricate unlisted worktrees or floating-session associations', async () => {
  const harness = createHarness({
    worktrees: [makeWorktree('wt_listed', '/fixture/listed'), makeWorktree('wt_unrelated', '/fixture/unrelated')],
    sessions: [makeSession('s_floating', 'wt_floating')],
    dashboard: makeDashboard([makeDashboardCard('s_floating', 'wt_floating', 'working')]),
    pages: [{ response: makePage([makeWorker({
      dispatchId: 'ctx_deleted', taskId: 'task_deleted', runId: 'run_deleted', taskTitle: 'Deleted workspace',
      workspaceId: 'wt_deleted', resource: makeResource('ctx_deleted', 'wt_deleted', 's_deleted')
    })]) }]
  })
  try {
    seedRun(harness.store, 'run_deleted')
    seedTask(harness.store, 'task_deleted', 'run_deleted', 'Deleted workspace')
    seedDispatch(harness.store, 'ctx_deleted', 'task_deleted', 'run_deleted')
    harness.resetCounters()

    const result = await harness.summary.query({})
    expect(result.rows).toEqual([])
    expect(result.total).toBe(0)
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})

test('omits fleet rows invalidated by a concurrent reset or a changed association', async () => {
  const ids = [
    ['ctx_dispatch_gone', 'task_dispatch_gone', 'run_dispatch_gone'],
    ['ctx_task_gone', 'task_gone', 'run_task_gone'],
    ['ctx_run_gone', 'task_run_gone', 'run_gone'],
    ['ctx_status_changed', 'task_status_changed', 'run_status_changed'],
    ['ctx_association_changed', 'task_association_changed', 'run_association_changed'],
    ['ctx_good', 'task_good', 'run_good']
  ] as const
  const workers = ids.map(([dispatchId, taskId, runId]) => makeWorker({
    dispatchId, taskId, runId, taskTitle: dispatchId, workspaceId: 'wt_a'
  }))
  const snapshotDatabase: { current: Database | null } = { current: null }
  const harness = createHarness({
    worktrees: [makeWorktree('wt_a', '/fixture/a')], pages: [{
      response: makePage(workers),
    }],
    onWorkerSnapshot() {
      if (!snapshotDatabase.current) throw new Error('snapshot database is not initialized')
      snapshotDatabase.current.exec(`
        DELETE FROM dispatches WHERE id = 'ctx_dispatch_gone';
        DELETE FROM tasks WHERE id = 'task_gone';
        DELETE FROM runs WHERE id = 'run_gone';
        UPDATE dispatches SET status = 'completed' WHERE id = 'ctx_status_changed';
        UPDATE dispatches SET run_id = 'run_good' WHERE id = 'ctx_association_changed';
      `)
    }
  })
  snapshotDatabase.current = harness.db
  try {
    for (const [dispatchId, taskId, runId] of ids) {
      seedRun(harness.store, runId)
      seedTask(harness.store, taskId, runId, dispatchId)
      seedDispatch(harness.store, dispatchId, taskId, runId)
    }
    harness.resetCounters()

    const result = await harness.summary.query({})
    expect(rowFor(result, 'wt_a').dispatches.map((dispatch) => dispatch.id)).toEqual(['ctx_good'])
    expect(rowFor(result, 'wt_a').runIds).toEqual(['run_good'])
    expect(result.unavailable).toEqual(['orchestration-changed'])
    expect(harness.writes).toBe(0)
    expectReadOnlyCalls(harness)
  } finally {
    harness.close()
  }
})
