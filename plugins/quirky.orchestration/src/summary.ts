import type {
  AgentDisplayState,
  PluginContext,
  PluginStore,
  SessionStatus,
  Worktree
} from '@quirky/protocol'
import type { DispatchStatus, TaskStatus, WorkerRow } from './contracts'
import type { TerminalResource, TerminalState } from './worker-contracts'
import type { SummaryDispatch, SummaryParams, SummaryResult, SummaryRow, SummarySession } from './summary-contracts'

const WORKTREE_LIST = 'quirky.worktree/list'
const SESSION_LIST = 'quirky.session/list'
const DASHBOARD = 'quirky.agent-status/dashboard'
const WORKER_LIST = 'quirky.orchestration/workerList'
const WORKER_PAGE_SIZE = 100

const SESSION_STATUSES: Record<string, true> = {
  starting: true, running: true, working: true, waiting: true, done: true, exited: true
}
const AGENT_DISPLAYS: Record<string, true> = {
  working: true, monitoring: true, waiting: true, permission: true, blocked: true,
  failed: true, interrupted: true, done: true, unverifiable: true, idle: true, unconfirmed: true
}
const TASK_STATUSES: Record<string, true> = {
  pending: true, ready: true, dispatched: true, completed: true, failed: true, blocked: true
}
const DISPATCH_STATUSES: Record<string, true> = {
  pending: true, dispatched: true, completed: true, failed: true, circuit_broken: true
}
const WORKER_STATES: Record<string, true> = {
  starting: true, ready: true, start_unknown: true, failed: true, succeeded: true,
  stopping: true, stop_unknown: true, stopped: true, abandoned: true
}
const TERMINAL_STATES: Record<string, true> = {
  active: true, reclaimable: true, retained: true, release_pending: true, release_unknown: true, released: true
}
const OWNERSHIP_STATES: Record<string, true> = {
  owned: true, transferred: true, user_owned: true, external: true, released: true
}
const RELEASE_STATES: Record<string, true> = {
  not_requested: true, retained: true, requested: true, releasing: true, released: true, unknown: true
}
const ARCHIVE_STATUSES: Record<string, true> = { captured: true, empty: true, unavailable: true }

type WorktreeIdentity = Pick<Worktree, 'id' | 'name' | 'path' | 'repoId'>
type SessionSource = {
  id: string
  worktreeId: string
  agent: string
  kind: SummarySession['kind']
  status: SessionStatus
}
type DashboardProjection = {
  displays: Map<string, Map<string, AgentDisplayState>>
  unavailable: string[]
}
type ResourceIdentity = Pick<TerminalResource, 'id' | 'originDispatchId' | 'ownerDispatchId' | 'worktreeId' | 'sessionId'>
type FleetRow = {
  dispatchId: string
  taskId: string
  runId: string
  taskTitle: string
  dispatchStatus: DispatchStatus
  workerState: WorkerRow['state'] | null
  currentAssignment: boolean
  terminalState: TerminalState
  agentTerminalHandle: string | null
  hostKind: 'local' | 'remote'
  workspaceId: string | null
  workspaceKind: string | null
  resource: ResourceIdentity | null
}
type RunProjection = { id: string; coordinator_session_id: string | null }
type TaskProjection = {
  id: string
  run_id: string
  created_by_session_id: string | null
  task_title: string
  status: TaskStatus
}
type DispatchProjection = {
  id: string
  run_id: string
  task_id: string
  status: DispatchStatus
  creator_session_id: string | null
  assignee_session_id: string | null
}
type StoreProjection = { runs: RunProjection[]; tasks: TaskProjection[]; dispatches: DispatchProjection[] }
type MutableRow = {
  worktree: WorktreeIdentity
  sessions: SessionSource[]
  runIds: Set<string>
  dispatches: Map<string, SummaryDispatch>
  qualifies: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isEnum(value: unknown, values: Record<string, true>): value is string {
  return typeof value === 'string' && Object.hasOwn(values, value)
}

function invalidParams(context: PluginContext): never {
  throw context.error('invalid-params', 'Summary accepts only an integer limit from 1 to 100.')
}

function invalidSource(context: PluginContext, method: string): never {
  throw context.error('conflict', `summary_source_invalid: ${method} returned an invalid response.`)
}

function parseLimit(context: PluginContext, params: unknown): number {
  if (!isRecord(params) || Object.keys(params).some((key) => key !== 'limit')) invalidParams(context)
  const value = params.limit
  if (value === undefined) return WORKER_PAGE_SIZE
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) invalidParams(context)
  return value
}

function parseWorktrees(context: PluginContext, value: unknown): WorktreeIdentity[] {
  if (!Array.isArray(value)) invalidSource(context, WORKTREE_LIST)
  const worktrees: WorktreeIdentity[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.name) ||
      !isNonEmptyString(candidate.path) || !isNonEmptyString(candidate.repoId) || ids.has(candidate.id)) {
      invalidSource(context, WORKTREE_LIST)
    }
    ids.add(candidate.id)
    worktrees.push({ id: candidate.id, name: candidate.name, path: candidate.path, repoId: candidate.repoId })
  }
  return worktrees
}

function parseSessions(context: PluginContext, value: unknown): SessionSource[] {
  if (!Array.isArray(value)) invalidSource(context, SESSION_LIST)
  const sessions: SessionSource[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.worktreeId) ||
      !isNonEmptyString(candidate.agent) || (candidate.kind !== 'terminal' && candidate.kind !== 'structured') ||
      !isEnum(candidate.status, SESSION_STATUSES) || ids.has(candidate.id)) {
      invalidSource(context, SESSION_LIST)
    }
    ids.add(candidate.id)
    sessions.push({
      id: candidate.id,
      worktreeId: candidate.worktreeId,
      agent: candidate.agent,
      kind: candidate.kind,
      status: candidate.status as SessionStatus
    })
  }
  return sessions
}

function isTerminalResource(value: unknown): value is TerminalResource {
  return isRecord(value) && isNonEmptyString(value.id) && isNonEmptyString(value.originDispatchId) &&
    isNonEmptyString(value.ownerDispatchId) && Array.isArray(value.priorOwnerDispatchIds) &&
    value.priorOwnerDispatchIds.every(isNonEmptyString) && isNonEmptyString(value.worktreeId) &&
    isNonEmptyString(value.sessionId) && isNonEmptyString(value.processIncarnation) &&
    isEnum(value.ownershipState, OWNERSHIP_STATES) && isEnum(value.releaseState, RELEASE_STATES) &&
    isNullableString(value.retainedReason) && isNullableString(value.releaseRequestedAt) &&
    isNullableString(value.releaseCompletedAt) && isNullableString(value.releaseError) &&
    Number.isSafeInteger(value.recoveryAttemptCount) && Number(value.recoveryAttemptCount) >= 0 &&
    isNullableString(value.lastRecoveryAt) && isNullableString(value.archiveSource) &&
    (value.archiveStatus === null || isEnum(value.archiveStatus, ARCHIVE_STATUSES))
}

function validResource(value: unknown): value is TerminalResource | null {
  return value === null || isTerminalResource(value)
}

function resourceIdentity(value: TerminalResource | null): ResourceIdentity | null {
  if (value === null) return null
  return {
    id: value.id,
    originDispatchId: value.originDispatchId,
    ownerDispatchId: value.ownerDispatchId,
    worktreeId: value.worktreeId,
    sessionId: value.sessionId
  }
}

function sameResource(left: TerminalResource | null, right: TerminalResource | null): boolean {
  if (left === null || right === null) return left === right
  return left.id === right.id && left.originDispatchId === right.originDispatchId &&
    left.ownerDispatchId === right.ownerDispatchId && left.worktreeId === right.worktreeId &&
    left.sessionId === right.sessionId && left.processIncarnation === right.processIncarnation &&
    left.ownershipState === right.ownershipState && left.releaseState === right.releaseState
}

function parseFleetRow(context: PluginContext, value: unknown): FleetRow {
  if (!isRecord(value) || !isNonEmptyString(value.dispatchId) || !isNonEmptyString(value.taskId) ||
    !isNonEmptyString(value.runId) || typeof value.taskTitle !== 'string' ||
    !isEnum(value.dispatchStatus, DISPATCH_STATUSES) ||
    (value.workerState !== null && !isEnum(value.workerState, WORKER_STATES)) ||
    typeof value.currentAssignment !== 'boolean' || !isEnum(value.terminalState, TERMINAL_STATES) ||
    !(value.agentTerminalHandle === null || isNonEmptyString(value.agentTerminalHandle))) {
    invalidSource(context, WORKER_LIST)
  }
  const projection = value.projection
  if (!isRecord(projection) || projection.id !== value.dispatchId || !isRecord(projection.host) ||
    (projection.host.kind !== 'local' && projection.host.kind !== 'remote') || !isNonEmptyString(projection.host.id)) {
    invalidSource(context, WORKER_LIST)
  }
  let workspaceId: string | null = null
  let workspaceKind: string | null = null
  if (projection.workspace !== null) {
    if (!isRecord(projection.workspace) || !isNonEmptyString(projection.workspace.id) ||
      !isNonEmptyString(projection.workspace.kind)) invalidSource(context, WORKER_LIST)
    workspaceId = projection.workspace.id
    workspaceKind = projection.workspace.kind
  }
  if (!validResource(value.resource) || !validResource(projection.resource) ||
    !sameResource(value.resource, projection.resource)) invalidSource(context, WORKER_LIST)
  return {
    dispatchId: value.dispatchId,
    taskId: value.taskId,
    runId: value.runId,
    taskTitle: value.taskTitle,
    dispatchStatus: value.dispatchStatus as DispatchStatus,
    workerState: value.workerState as WorkerRow['state'] | null,
    currentAssignment: value.currentAssignment,
    terminalState: value.terminalState as TerminalState,
    agentTerminalHandle: value.agentTerminalHandle,
    hostKind: projection.host.kind,
    workspaceId,
    workspaceKind,
    resource: resourceIdentity(value.resource)
  }
}

function parseWorkerPage(context: PluginContext, value: unknown): {
  rows: FleetRow[]
  snapshotId: string
  total: number
  nextCursor: string | null
} {
  if (!isRecord(value) || !Array.isArray(value.workers) || !isRecord(value.scope) ||
    value.scope.runId !== null || value.scope.source !== 'all' || !isRecord(value.page) ||
    !isNonEmptyString(value.page.snapshotId) || !Number.isSafeInteger(value.page.total) ||
    Number(value.page.total) < 0 ||
    (value.page.nextCursor !== null && !isNonEmptyString(value.page.nextCursor)) || value.workers.length > WORKER_PAGE_SIZE) {
    invalidSource(context, WORKER_LIST)
  }
  const rows = value.workers.map((row) => parseFleetRow(context, row))
  return {
    rows,
    snapshotId: value.page.snapshotId,
    total: Number(value.page.total),
    nextCursor: value.page.nextCursor as string | null
  }
}

async function readWorkerSnapshot(context: PluginContext): Promise<FleetRow[]> {
  const rows: FleetRow[] = []
  const dispatchIds = new Set<string>()
  const cursors = new Set<string>()
  let snapshotId: string | null = null
  let expectedTotal: number | null = null
  let cursor: string | undefined
  while (true) {
    const params: Record<string, unknown> = { limit: WORKER_PAGE_SIZE, includeRemote: false }
    if (cursor !== undefined) params.cursor = cursor
    const page = parseWorkerPage(context, await context.call(WORKER_LIST, params))
    if (snapshotId === null) {
      snapshotId = page.snapshotId
      expectedTotal = page.total
    } else if (page.snapshotId !== snapshotId || page.total !== expectedTotal) {
      invalidSource(context, WORKER_LIST)
    }
    for (const row of page.rows) {
      if (dispatchIds.has(row.dispatchId)) invalidSource(context, WORKER_LIST)
      dispatchIds.add(row.dispatchId)
      rows.push(row)
    }
    if (rows.length > page.total || (page.nextCursor !== null && rows.length >= page.total)) {
      invalidSource(context, WORKER_LIST)
    }
    if (page.nextCursor === null) break
    if (page.rows.length === 0 || page.nextCursor === cursor || cursors.has(page.nextCursor)) {
      invalidSource(context, WORKER_LIST)
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  if (expectedTotal === null || rows.length !== expectedTotal) invalidSource(context, WORKER_LIST)
  return rows
}


function parseDashboard(value: unknown): DashboardProjection {
  if (!isRecord(value) || !Array.isArray(value.cards) || !Array.isArray(value.unavailable) ||
    !value.unavailable.every((reason) => typeof reason === 'string') ||
    !Number.isSafeInteger(value.total) || Number(value.total) < 0 ||
    !Number.isSafeInteger(value.hiddenIdle) || Number(value.hiddenIdle) < 0) {
    throw new Error('malformed dashboard response')
  }
  const displays = new Map<string, Map<string, AgentDisplayState>>()
  for (const card of value.cards) {
    if (!isRecord(card) || !isRecord(card.thread) || !isNonEmptyString(card.thread.sessionId) ||
      !isNonEmptyString(card.thread.worktreeId) || !isEnum(card.thread.display, AGENT_DISPLAYS)) {
      throw new Error('malformed dashboard card')
    }
    let worktreeDisplays = displays.get(card.thread.worktreeId)
    if (!worktreeDisplays) {
      worktreeDisplays = new Map()
      displays.set(card.thread.worktreeId, worktreeDisplays)
    }
    if (worktreeDisplays.has(card.thread.sessionId)) throw new Error('duplicate dashboard card')
    worktreeDisplays.set(card.thread.sessionId, card.thread.display as AgentDisplayState)
  }
  return { displays, unavailable: value.unavailable as string[] }
}

async function readDashboard(context: PluginContext): Promise<DashboardProjection> {
  try {
    return parseDashboard(await context.call(DASHBOARD, { showIdle: true }))
  } catch {
    return { displays: new Map(), unavailable: ['agent-status-unavailable'] }
  }
}

function readStoreProjection(store: PluginStore): StoreProjection {
  const runs = store.all<RunProjection>('SELECT id, coordinator_session_id FROM runs')
  const tasks = store.all<TaskProjection>(
    'SELECT id, run_id, created_by_session_id, task_title, status FROM tasks'
  )
  const dispatches = store.all<DispatchProjection>(
    'SELECT id, run_id, task_id, status, creator_session_id, assignee_session_id FROM dispatches'
  )
  return { runs, tasks, dispatches }
}

function compareBinary(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function aggregate(
  worktrees: WorktreeIdentity[],
  sessions: SessionSource[],
  dashboard: DashboardProjection,
  fleetRows: FleetRow[],
  store: StoreProjection,
  limit: number
): SummaryResult {
  const rowsByWorktree = new Map<string, MutableRow>()
  for (const worktree of worktrees) {
    rowsByWorktree.set(worktree.id, {
      worktree, sessions: [], runIds: new Set(), dispatches: new Map(), qualifies: false
    })
  }
  const sessionsById = new Map<string, SessionSource>()
  for (const session of sessions) {
    sessionsById.set(session.id, session)
    const row = rowsByWorktree.get(session.worktreeId)
    if (!row) continue
    row.sessions.push(session)
    if (session.status !== 'exited') row.qualifies = true
  }
  const runsById = new Map(store.runs.map((run) => [run.id, run] as const))
  const tasksById = new Map(store.tasks.map((task) => [task.id, task] as const))
  const dispatchesById = new Map(store.dispatches.map((dispatch) => [dispatch.id, dispatch] as const))
  for (const run of store.runs) {
    if (run.coordinator_session_id === null) continue
    const session = sessionsById.get(run.coordinator_session_id)
    const row = session ? rowsByWorktree.get(session.worktreeId) : undefined
    if (!row) continue
    row.qualifies = true
    row.runIds.add(run.id)
  }
  for (const task of store.tasks) {
    if (task.created_by_session_id === null || !runsById.has(task.run_id)) continue
    const session = sessionsById.get(task.created_by_session_id)
    const row = session ? rowsByWorktree.get(session.worktreeId) : undefined
    if (!row) continue
    row.qualifies = true
    row.runIds.add(task.run_id)
  }

  let orchestrationChanged = false
  for (const fleet of fleetRows) {
    if (fleet.hostKind === 'remote') continue
    const dispatch = dispatchesById.get(fleet.dispatchId)
    const task = tasksById.get(fleet.taskId)
    const run = runsById.get(fleet.runId)
    if (!dispatch || !task || !run || dispatch.id !== fleet.dispatchId || dispatch.run_id !== fleet.runId ||
      dispatch.task_id !== fleet.taskId || dispatch.status !== fleet.dispatchStatus || task.id !== fleet.taskId ||
      task.run_id !== fleet.runId || task.task_title !== fleet.taskTitle) {
      orchestrationChanged = true
      continue
    }
    const workerSessionId = fleet.agentTerminalHandle ??
      (fleet.resource?.ownerDispatchId === fleet.dispatchId ? fleet.resource.sessionId : null)
    const summaryDispatch: SummaryDispatch = {
      id: dispatch.id,
      runId: dispatch.run_id,
      task: { id: task.id, title: task.task_title, status: task.status },
      status: dispatch.status,
      creatorSessionId: dispatch.creator_session_id,
      assigneeSessionId: dispatch.assignee_session_id,
      workerSessionId,
      currentAssignment: fleet.currentAssignment,
      workerState: fleet.workerState,
      terminalState: fleet.terminalState
    }
    const worktreeIds = new Set<string>()
    if (fleet.workspaceKind === 'worktree' && fleet.workspaceId !== null) worktreeIds.add(fleet.workspaceId)
    if (fleet.resource !== null) worktreeIds.add(fleet.resource.worktreeId)
    for (const sessionId of [dispatch.creator_session_id, dispatch.assignee_session_id, workerSessionId]) {
      if (sessionId === null) continue
      const session = sessionsById.get(sessionId)
      if (session) worktreeIds.add(session.worktreeId)
    }
    for (const worktreeId of worktreeIds) {
      const row = rowsByWorktree.get(worktreeId)
      if (!row) continue
      row.qualifies = true
      row.runIds.add(dispatch.run_id)
      row.dispatches.set(dispatch.id, summaryDispatch)
    }
  }

  const ordered = [...rowsByWorktree.values()].filter((row) => row.qualifies).sort((left, right) =>
    compareBinary(left.worktree.path, right.worktree.path) || compareBinary(left.worktree.id, right.worktree.id)
  )
  const resultRows: SummaryRow[] = ordered.slice(0, limit).map((row) => ({
    worktree: {
      id: row.worktree.id, name: row.worktree.name, path: row.worktree.path, repoId: row.worktree.repoId
    },
    sessions: row.sessions.sort((left, right) => compareBinary(left.id, right.id)).map((session) => ({
      id: session.id,
      agent: session.agent,
      kind: session.kind,
      status: session.status,
      display: dashboard.displays.get(session.worktreeId)?.get(session.id) ?? null,
      live: session.status !== 'exited'
    })),
    runIds: [...row.runIds].sort(compareBinary),
    dispatches: [...row.dispatches.values()].sort((left, right) => compareBinary(left.id, right.id))
  }))
  const unavailable = new Set(dashboard.unavailable)
  if (orchestrationChanged) unavailable.add('orchestration-changed')
  return {
    scope: 'local',
    rows: resultRows,
    total: ordered.length,
    limit,
    truncated: ordered.length > limit,
    unavailable: [...unavailable].sort(compareBinary)
  }
}

/** Aggregates local worktree, session, dashboard, fleet and store observations without changing orchestration state. */
export class OrchestrationSummary {
  constructor(private readonly context: PluginContext, private readonly store: PluginStore) {}

  async query(params: SummaryParams): Promise<SummaryResult> {
    const limit = parseLimit(this.context, params)
    const worktrees = parseWorktrees(this.context, await this.context.call(WORKTREE_LIST, {}))
    const sessions = parseSessions(this.context, await this.context.call(SESSION_LIST, {}))
    const dashboard = await readDashboard(this.context)
    const fleetRows = await readWorkerSnapshot(this.context)
    const storeProjection = readStoreProjection(this.store)
    return aggregate(worktrees, sessions, dashboard, fleetRows, storeProjection, limit)
  }
}
