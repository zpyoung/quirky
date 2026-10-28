import { randomUUID } from 'node:crypto'
import type { Session } from '@quirky/protocol'
import type { DispatchId, DispatchRow, RunId, RuntimeCallerEvidence, TaskRow } from '../contracts'
import type {
  TerminalResource, TerminalState, WorkerCore, WorkerFleet, WorkerFleetRow, WorkerLiveness,
  WorkerObservation, WorkerProjection, WorkerRecord, WorkerRepository, WorkerRuntime, WorkerShowParams,
  WorkerShowResult, WorkerListParams, WorkerListResult
} from '../worker-contracts'
import type { SessionIdentity } from '../runtime-contracts'

const FLEET_CURSOR_PREFIX = 'owf1_'
const MAX_CURSOR_CHARS = 2_048
const MAX_PAGE_SIZE = 100
const LEGACY_MAX_ROWS = 5_000
const MAX_SNAPSHOTS = 8
const SNAPSHOT_TTL_MS = 5 * 60 * 1_000
const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1_000
const FUTURE_STATUS_TOLERANCE_MS = 5_000
const OBSERVATION_CONCURRENCY = 12

const LOCAL_GAP_REASONS: Record<string, true> = { missing_status: true, host_unavailable: true, capability_unsupported: true }
const ACTIONABLE_ATTENTION: Record<string, true> = {
  guidance: true, input: true, approval: true, failure: true, interruption: true, unverifiable: true
}

type FleetScope = WorkerListResult['scope']
type FleetFilter = {
  runId: RunId | null
  source: FleetScope['source']
  terminalState: TerminalState | null
  includeRemote: boolean
}
type FleetCursor = { version: 1; snapshotId: string; offset: number }
type FleetSnapshot = {
  id: string
  filter: FleetFilter
  scope: FleetScope
  rows: readonly WorkerFleetRow[]
  createdAt: number
  expiresAt: number
}
type AgentEvidence = {
  durable: boolean
  liveStatus: WorkerProjection['evidence']['liveStatus']
  lastObservedAt: string | null
  reason: string | null
  state: string | null
  display: string | null
  label: string | null
  detail: string | null
}
type FleetCandidate = {
  dispatch: DispatchRow
  task: TaskRow
  coordinatorSessionId: string | null
  worker: WorkerRecord | null
  resource: TerminalResource | null
  attention: ReturnType<WorkerCore['attentionFor']>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTerminalState(value: unknown): value is TerminalState {
  return value === 'active' || value === 'reclaimable' || value === 'retained'
    || value === 'release_pending' || value === 'release_unknown' || value === 'released'
}

function parseFleetCursor(value: string, runtime: WorkerRuntime): FleetCursor {
  if (value.length > MAX_CURSOR_CHARS || !value.startsWith(FLEET_CURSOR_PREFIX)) {
    throw runtime.context.error('invalid-params', 'cursor_invalid')
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(FLEET_CURSOR_PREFIX.length), 'base64url').toString('utf8'))
    if (!isRecord(decoded) || decoded.version !== 1 || typeof decoded.snapshotId !== 'string') throw new Error('invalid cursor')
    if (typeof decoded.offset !== 'number' || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error('invalid cursor')
    return { version: 1, snapshotId: decoded.snapshotId, offset: decoded.offset }
  } catch {
    throw runtime.context.error('invalid-params', 'cursor_invalid')
  }
}

function makeFleetCursor(snapshotId: string, offset: number): string {
  return `${FLEET_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ version: 1, snapshotId, offset }), 'utf8').toString('base64url')}`
}

function cloneResource(resource: TerminalResource | null): TerminalResource | null {
  return resource ? { ...resource, priorOwnerDispatchIds: [...resource.priorOwnerDispatchIds] } : null
}

function cloneWorker(record: WorkerRecord | null): WorkerRecord | null {
  return record ? {
    ...record,
    effects: [...record.effects],
    residualResources: [...record.residualResources],
    startOptions: { ...record.startOptions },
    receipt: record.receipt ? { ...record.receipt, effects: [...record.receipt.effects], residualResources: [...record.receipt.residualResources] } : null
  } : null
}

function cloneTask(task: TaskRow): TaskRow {
  return { ...task, dependencyTaskIds: [...task.dependencyTaskIds], result: task.result ? { ...task.result } : null }
}

function cloneDispatch(dispatch: DispatchRow): DispatchRow {
  return { ...dispatch }
}

function exactObservation(record: WorkerRecord | null, resource: TerminalResource | null, observation: WorkerObservation): observation is WorkerObservation & { identity: SessionIdentity } {
  if (!record || !resource || !observation.exactWorker || !observation.identity) return false
  const identity = observation.identity
  return resource.ownerDispatchId === record.dispatchId
    && (resource.ownershipState === 'owned' || resource.ownershipState === 'user_owned' || resource.ownershipState === 'external')
    && resource.releaseState !== 'released' && record.sessionId === resource.sessionId
    && record.processIncarnation === resource.processIncarnation && record.worktreeId === resource.worktreeId
    && identity.sessionId === resource.sessionId && identity.processIncarnation === resource.processIncarnation
    && identity.sessionId.length > 0 && identity.processIncarnation.length > 0 && identity.runtimeEpoch.length > 0
    && record.processRuntimeEpoch !== null && record.processRuntimeEpoch.length > 0 && identity.runtimeEpoch === record.processRuntimeEpoch
    && identity.kind === (record.mode === 'structured' ? 'structured' : 'terminal')
    && (!observation.session || (observation.session.id === identity.sessionId
      && observation.session.kind === identity.kind && observation.session.worktreeId === identity.worktreeId
      && (identity.providerId === null || observation.session.agent === identity.providerId)))
}

function uncertainObservation(status: WorkerObservation['status'], reason: string | null): WorkerObservation {
  return { status, exactWorker: false, reason, identity: null, session: null }
}
function observationAfterEvidence(observation: WorkerObservation, evidence: AgentEvidence): WorkerObservation {
  return evidence.reason === 'peer_changed' ? uncertainObservation('identity_changed', 'peer_changed') : observation
}


async function observeCandidate(runtime: WorkerRuntime, candidate: FleetCandidate): Promise<WorkerObservation> {
  const { dispatch, worker, resource } = candidate
  if (resource && (
    resource.ownerDispatchId !== dispatch.id
    || resource.ownershipState === 'transferred'
    || resource.ownershipState === 'released'
    || resource.releaseState === 'released'
  )) {
    if (resource.releaseState === 'released' || resource.ownershipState === 'released') return uncertainObservation('exited', 'resource_released')
    return uncertainObservation('identity_changed', 'identity_changed')
  }
  try {
    const observation = await runtime.observe(worker, dispatch)
    if (exactObservation(worker, resource, observation)) return observation
    if (observation.status === 'identity_changed') return uncertainObservation('identity_changed', observation.reason ?? 'identity_changed')
    if (observation.status === 'missing' || observation.status === 'unattached' || observation.status === 'unverifiable') {
      return uncertainObservation(observation.status, observation.reason ?? 'missing_status')
    }
    return uncertainObservation('unverifiable', observation.reason ?? 'identity_unproven')
  } catch {
    return uncertainObservation('unverifiable', 'host_unavailable')
  }
}

function sessionStatusRow(value: unknown, sessionId: string, now: number): AgentEvidence {
  if (!isRecord(value) || value.sessionId !== sessionId || typeof value.evidenceAt !== 'number' || !Number.isFinite(value.evidenceAt) || (value.restoredUnconfirmed !== undefined && typeof value.restoredUnconfirmed !== 'boolean')) {
    return { durable: false, liveStatus: 'unavailable', lastObservedAt: null, reason: 'missing_status', state: null, display: null, label: null, detail: null }
  }
  const evidenceAt = value.evidenceAt
  const validDate = evidenceAt >= 0 && evidenceAt <= 8.64e15
  const lastObservedAt = validDate ? new Date(evidenceAt).toISOString() : null
  const state = typeof value.state === 'string' ? value.state : null
  const display = typeof value.display === 'string' ? value.display : null
  const label = typeof value.label === 'string' ? value.label : null
  const detail = typeof value.detail === 'string' ? value.detail : null
  if (value.restoredUnconfirmed) {
    return { durable: true, liveStatus: 'redacted_restore', lastObservedAt, reason: 'restored_unconfirmed', state, display, label, detail }
  }
  if (evidenceAt < 0) {
    return { durable: true, liveStatus: 'stale', lastObservedAt, reason: 'stale_status', state, display, label, detail }
  }
  if (evidenceAt > now + FUTURE_STATUS_TOLERANCE_MS || evidenceAt > 8.64e15) {
    return { durable: true, liveStatus: 'stale', lastObservedAt, reason: 'future_status', state, display, label, detail }
  }
  if (now - evidenceAt > AGENT_STATUS_STALE_AFTER_MS) {
    return { durable: true, liveStatus: 'stale', lastObservedAt, reason: 'stale_status', state, display, label, detail }
  }
  return { durable: true, liveStatus: 'fresh', lastObservedAt, reason: null, state, display, label, detail }
}

async function readAgentEvidence(runtime: WorkerRuntime, dispatch: DispatchRow, record: WorkerRecord | null, resource: TerminalResource | null, observation: WorkerObservation): Promise<AgentEvidence> {
  if (!record || !resource || !exactObservation(record, resource, observation)) {
    return { durable: false, liveStatus: 'unavailable', lastObservedAt: null, reason: 'missing_status', state: null, display: null, label: null, detail: null }
  }
  let evidence: AgentEvidence
  try {
    const status = await runtime.context.call('quirky.agent-status/get', { session: resource.sessionId })
    evidence = sessionStatusRow(status, resource.sessionId, Date.now())
  } catch {
    evidence = { durable: false, liveStatus: 'unavailable', lastObservedAt: null, reason: 'missing_status', state: null, display: null, label: null, detail: null }
  }
  try {
    const current = await runtime.observe(record, dispatch)
    if (!exactObservation(record, resource, current)) return { ...evidence, liveStatus: 'unavailable', reason: 'peer_changed' }
  } catch {
    return { ...evidence, liveStatus: 'unavailable', reason: 'host_unavailable' }
  }
  return evidence
}

function livenessFor(candidate: FleetCandidate, observation: WorkerObservation, evidence: AgentEvidence): WorkerLiveness {
  const { dispatch, worker, resource } = candidate
  if (resource?.releaseState === 'released' || resource?.ownershipState === 'released' || worker?.state === 'stopped') {
    return { status: 'exited', reason: null }
  }
  if (dispatch.terminationReason === 'exited' || dispatch.terminationReason === 'signaled' || dispatch.terminationReason === 'operator_close'
    || (observation.status === 'exited' && observation.exactWorker)) {
    return { status: 'exited', reason: null }
  }
  if (evidence.liveStatus === 'fresh') return { status: 'live', reason: null }
  if (evidence.reason && LOCAL_GAP_REASONS[evidence.reason] === true && observation.exactWorker) {
    if (observation.status === 'live') return { status: 'live', reason: null }
    if (observation.status === 'exited') return { status: 'exited', reason: null }
  }
  return { status: 'unverifiable', reason: evidence.reason ?? observation.reason ?? 'missing_status' }
}

function resolveOutcome(dispatch: DispatchRow, task: TaskRow, worker: WorkerRecord | null): WorkerProjection['outcome'] {
  if (task.result?.kind === 'worker_report' && task.result.dispatchId === dispatch.id) return task.result.outcome
  if (worker?.state === 'succeeded') return 'succeeded'
  if (worker?.state === 'failed') return 'failed'
  if (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') return 'failed'
  if (worker?.state === 'abandoned' || worker?.state === 'start_unknown' || worker?.state === 'stop_unknown') return 'outcome_unknown'
  if (worker?.state === 'stopped' || dispatch.status === 'completed') return 'finished_unverified'
  return 'in_progress'
}

function terminalStateFor(candidate: FleetCandidate, liveness: WorkerLiveness): TerminalState {
  const { dispatch, worker, resource } = candidate
  if (!resource) {
    if (!worker) return 'released'
    if (worker.state === 'stop_unknown' || worker.state === 'start_unknown') return 'release_unknown'
    if (worker.state === 'starting' || worker.state === 'ready' || worker.state === 'stopping') return 'active'
    return 'released'
  }
  if (resource.releaseState === 'released' || resource.ownershipState === 'released') return 'released'
  if (resource.releaseState === 'requested' || resource.releaseState === 'releasing') return 'release_pending'
  if (resource.releaseState === 'unknown') return 'release_unknown'
  if (resource.releaseState === 'retained' || resource.ownershipState === 'transferred' || resource.ownershipState === 'user_owned' || resource.ownershipState === 'external' || resource.ownerDispatchId !== dispatch.id) return 'retained'
  if (liveness.status === 'exited' || worker?.state === 'succeeded' || worker?.state === 'failed') return 'reclaimable'
  if (liveness.status === 'unverifiable') return 'release_unknown'
  return 'active'
}

function attentionCategories(candidate: FleetCandidate, evidence: AgentEvidence, liveness: WorkerLiveness, outcome: WorkerProjection['outcome']): string[] {
  const categories: string[] = []
  if (candidate.attention.guidance) categories.push('guidance')
  if (candidate.attention.input) categories.push('input')
  if (candidate.attention.approval) categories.push('approval')
  if (outcome === 'failed') categories.push('failure')
  if (candidate.worker?.state === 'abandoned' || candidate.dispatch.terminationReason === 'operator_close' || candidate.dispatch.terminationReason === 'signaled') {
    categories.push('interruption')
  }
  if (evidence.liveStatus === 'stale') categories.push('stale')
  if (liveness.status === 'unverifiable') categories.push('unverifiable')
  if (candidate.attention.rootCompletion) categories.push('root_completion')
  return categories
}

function requiresAction(categories: readonly string[]): boolean {
  return categories.some((category) => ACTIONABLE_ATTENTION[category] === true)
}

function activityFor(
  candidate: FleetCandidate,
  evidence: AgentEvidence,
  liveness: WorkerLiveness,
  outcome: WorkerProjection['outcome'],
  observation: WorkerObservation
): WorkerProjection['stage']['activity'] {
  const display = evidence.display?.toLowerCase()
  if (display === 'permission' || display === 'blocked' || candidate.attention.approval) return 'blocked'
  if (observation.agentWait?.waiting || display === 'waiting' || display === 'idle' || display === 'unconfirmed' || candidate.attention.input) return 'waiting'
  if (display === 'done' || display === 'failed' || display === 'interrupted' || outcome === 'succeeded' || outcome === 'failed' || outcome === 'finished_unverified') return 'done'
  if (liveness.status === 'live') return 'working'
  return 'unknown'
}

function nextActionFor(
  candidate: FleetCandidate,
  terminalState: TerminalState,
  liveness: WorkerLiveness,
  outcome: WorkerProjection['outcome'],
  categories: readonly string[]
): WorkerProjection['nextAction'] {
  const { dispatch, worker } = candidate
  if (liveness.status === 'unverifiable' || terminalState === 'released') return { kind: 'none', argv: [] }
  if (liveness.status === 'exited' && worker !== null && outcome !== 'succeeded' && outcome !== 'failed') {
    return { kind: 'recover', argv: ['worker-read', '--dispatch', dispatch.id] }
  }
  if (terminalState === 'reclaimable') return { kind: 'release', argv: ['worker-release', '--dispatch', dispatch.id] }
  if (worker === null && (dispatch.status === 'completed' || dispatch.status === 'failed' || dispatch.status === 'circuit_broken')) {
    return { kind: 'none', argv: [] }
  }
  if (requiresAction(categories) || categories.includes('stale') || outcome === 'failed' || outcome === 'finished_unverified') {
    return { kind: 'inspect', argv: ['worker-show', '--dispatch', dispatch.id] }
  }
  return { kind: 'none', argv: [] }
}

function cloneFleetRow(row: WorkerFleetRow): WorkerFleetRow {
  const resource = cloneResource(row.resource)
  return {
    ...row,
    resource,
    projection: {
      ...row.projection,
      parent: row.projection.parent ? { ...row.projection.parent } : null,
      provider: row.projection.provider ? { ...row.projection.provider } : null,
      host: { ...row.projection.host },
      workspace: row.projection.workspace ? { ...row.projection.workspace } : null,
      stage: { ...row.projection.stage },
      liveness: { ...row.projection.liveness },
      evidence: { ...row.projection.evidence },
      resource: cloneResource(row.projection.resource),
      nextAction: { ...row.projection.nextAction, argv: [...row.projection.nextAction.argv] },
      attention: { ...row.projection.attention, categories: [...row.projection.attention.categories] }
    }
  }
}

function makeFleetRow(
  candidate: FleetCandidate,
  observation: WorkerObservation,
  evidence: AgentEvidence,
  liveness: WorkerLiveness
): WorkerFleetRow {
  const { dispatch, task, worker, resource } = candidate
  const outcome = resolveOutcome(dispatch, task, worker)
  const terminalState = terminalStateFor(candidate, liveness)
  const categories = attentionCategories(candidate, evidence, liveness, outcome)
  const identity = exactObservation(worker, resource, observation) ? observation.identity : null
  const currentAssignment = identity !== null && resource?.ownerDispatchId === dispatch.id
  const session = identity ? observation.session : null
  const providerId = identity?.providerId ?? session?.agent ?? null
  const modelValue = session?.launchSettings?.options.model?.value
  const model = typeof modelValue === 'string' ? modelValue : null
  const workspaceId = worker?.worktreeId ?? identity?.worktreeId ?? null
  const stageDetail = evidence.detail ?? worker?.lastError ?? task.displayName
  const projection: WorkerProjection = {
    id: dispatch.id,
    role: 'worker',
    parent: task.parentTaskId ? { taskId: task.parentTaskId } : null,
    provider: providerId ? { id: providerId, model } : null,
    host: { kind: 'local', id: 'local' },
    workspace: workspaceId ? { id: workspaceId, kind: 'worktree' } : null,
    stage: {
      worker: worker?.stage ?? null,
      dispatch: dispatch.status,
      detail: stageDetail,
      activity: activityFor(candidate, evidence, liveness, outcome, observation)
    },
    outcome,
    liveness,
    evidence: { durable: evidence.durable, liveStatus: evidence.liveStatus, lastObservedAt: evidence.lastObservedAt },
    resource: cloneResource(resource),
    nextAction: nextActionFor(candidate, terminalState, liveness, outcome, categories),
    attention: { categories, requiresAction: requiresAction(categories) }
  }
  return {
    dispatchId: dispatch.id,
    taskId: task.id,
    runId: dispatch.runId,
    workerState: worker?.state ?? null,
    currentAssignment,
    taskTitle: task.taskTitle,
    displayName: task.displayName,
    coordinatorSessionId: candidate.coordinatorSessionId,
    parentSessionId: dispatch.creatorSessionId,
    dispatchStatus: dispatch.status,
    agentTerminalHandle: resource?.ownerDispatchId === dispatch.id ? resource.sessionId : worker?.sessionId ?? null,
    terminalState,
    resource: cloneResource(resource),
    projection
  }
}

function scopeFor(core: WorkerCore, params: WorkerListParams, caller: RuntimeCallerEvidence | null): FleetScope {
  if (params.runId !== undefined) {
    core.getRun(params.runId)
    return { runId: params.runId, source: 'flag' }
  }
  if (caller) {
    const boundRunId = core.boundRunId(caller)
    if (boundRunId !== null) return { runId: boundRunId, source: 'bound' }
  }
  return { runId: null, source: 'all' }
}

function sameFilter(left: FleetFilter, right: FleetFilter): boolean {
  return left.runId === right.runId && left.source === right.source
    && left.terminalState === right.terminalState && left.includeRemote === right.includeRemote
}

function snapshotCandidates(core: WorkerCore, repo: WorkerRepository, filter: FleetFilter): FleetCandidate[] {
  const records = new Map<DispatchId, WorkerRecord | null>()
  for (const record of repo.list()) records.set(record.dispatchId, cloneWorker(record))
  const candidates: FleetCandidate[] = []
  for (const row of core.listDispatches(filter.runId ?? undefined)) {
    if (filter.runId !== null && row.runId !== filter.runId) continue
    const dispatch = cloneDispatch(row)
    const task = cloneTask(core.getTask(dispatch.taskId))
    const run = core.getRun(dispatch.runId)
    candidates.push({
      dispatch,
      task,
      coordinatorSessionId: run.coordinatorSessionId,
      worker: records.get(dispatch.id) ?? null,
      resource: cloneResource(repo.resource(dispatch.id)),
      attention: { ...core.attentionFor(dispatch.id) }
    })
  }
  candidates.sort((left, right) => right.dispatch.createdAt.localeCompare(left.dispatch.createdAt)
    || right.dispatch.id.localeCompare(left.dispatch.id))
  return candidates
}

async function projectCandidate(runtime: WorkerRuntime, candidate: FleetCandidate): Promise<WorkerFleetRow> {
  const initialObservation = await observeCandidate(runtime, candidate)
  const evidence = await readAgentEvidence(runtime, candidate.dispatch, candidate.worker, candidate.resource, initialObservation)
  const observation = observationAfterEvidence(initialObservation, evidence)
  const liveness = livenessFor(candidate, observation, evidence)
  return makeFleetRow(candidate, observation, evidence, liveness)
}

async function projectCandidates(runtime: WorkerRuntime, candidates: readonly FleetCandidate[]): Promise<WorkerFleetRow[]> {
  const rows = new Array<WorkerFleetRow>(candidates.length)
  let next = 0
  async function projectBatch(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= candidates.length) return
      rows[index] = await projectCandidate(runtime, candidates[index])
    }
  }
  const batches = Math.min(OBSERVATION_CONCURRENCY, candidates.length)
  await Promise.all(Array.from({ length: batches }, () => projectBatch()))
  return rows
}

function partialHostErrors(includeRemote: boolean): WorkerListResult['partialHostErrors'] {
  return includeRemote ? [{ host: 'remote', reason: 'capability_unsupported' }] : []
}

export function createWorkerFleet(core: WorkerCore, repo: WorkerRepository, runtime: WorkerRuntime): WorkerFleet {
  const snapshots = new Map<string, FleetSnapshot>()
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  function pruneExpired(now = Date.now()): void {
    for (const [id, snapshot] of snapshots) {
      if (snapshot.expiresAt <= now) snapshots.delete(id)
    }
  }

  function scheduleExpiry(): void {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
    if (snapshots.size === 0) return
    let expiresAt = Number.POSITIVE_INFINITY
    for (const snapshot of snapshots.values()) expiresAt = Math.min(expiresAt, snapshot.expiresAt)
    expiryTimer = setTimeout(() => {
      expiryTimer = null
      pruneExpired()
      scheduleExpiry()
    }, Math.max(0, expiresAt - Date.now()))
  }

  function storeSnapshot(snapshot: FleetSnapshot): void {
    pruneExpired()
    if (snapshots.size >= MAX_SNAPSHOTS) {
      let oldest: FleetSnapshot | null = null
      for (const existing of snapshots.values()) {
        if (!oldest || existing.createdAt < oldest.createdAt) oldest = existing
      }
      if (oldest) snapshots.delete(oldest.id)
    }
    snapshots.set(snapshot.id, snapshot)
    scheduleExpiry()
  }

  function pageResult(snapshot: FleetSnapshot, offset: number, limit: number, includeRemote: boolean): WorkerListResult {
    const end = Math.min(snapshot.rows.length, offset + limit)
    const nextCursor = end < snapshot.rows.length ? makeFleetCursor(snapshot.id, end) : null
    return {
      workers: snapshot.rows.slice(offset, end).map(cloneFleetRow),
      scope: { ...snapshot.scope },
      page: { nextCursor, snapshotId: snapshot.id, total: snapshot.rows.length },
      partialHostErrors: partialHostErrors(includeRemote)
    }
  }

  async function show(params: WorkerShowParams): Promise<WorkerShowResult> {
    const dispatch = cloneDispatch(core.getDispatch(params.dispatchId))
    const task = cloneTask(core.getTask(dispatch.taskId))
    const worker = cloneWorker(repo.get(dispatch.id))
    const resource = cloneResource(repo.resource(dispatch.id))
    const candidate: FleetCandidate = { dispatch, task, worker, resource, attention: { ...core.attentionFor(dispatch.id) } }
    const initialObservation = await observeCandidate(runtime, candidate)
    const evidence = await readAgentEvidence(runtime, dispatch, worker, resource, initialObservation)
    const observation = observationAfterEvidence(initialObservation, evidence)
    const liveness = livenessFor(candidate, observation, evidence)
    const row = makeFleetRow(candidate, observation, evidence, liveness)
    return {
      dispatch,
      worker,
      projection: row.projection,
      terminal: exactObservation(worker, resource, observation) ? observation.session : null,
      observation,
      terminalResource: cloneResource(resource)
    }
  }

  async function list(params: WorkerListParams, caller: RuntimeCallerEvidence | null): Promise<WorkerListResult> {
    if (params.terminalState !== undefined && !isTerminalState(params.terminalState)) {
      throw runtime.context.error('invalid-params', 'invalid_terminal_state')
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
      throw runtime.context.error('invalid-params', 'invalid_limit')
    }
    const scope = scopeFor(core, params, caller)
    const filter: FleetFilter = {
      runId: scope.runId,
      source: scope.source,
      terminalState: params.terminalState ?? null,
      includeRemote: params.includeRemote === true
    }
    const pageSize = params.limit === undefined ? MAX_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, params.limit)
    const partial = partialHostErrors(filter.includeRemote)
    if (params.cursor !== undefined) {
      const cursor = parseFleetCursor(params.cursor, runtime)
      pruneExpired()
      const snapshot = snapshots.get(cursor.snapshotId)
      if (!snapshot) throw runtime.context.error('invalid-params', 'worker_list_cursor_expired')
      if (!sameFilter(snapshot.filter, filter)) throw runtime.context.error('invalid-params', 'cursor_invalid')
      if (cursor.offset >= snapshot.rows.length) throw runtime.context.error('invalid-params', 'cursor_invalid')
      return pageResult(snapshot, cursor.offset, pageSize, filter.includeRemote)
    }

    const legacy = params.limit === undefined
    const candidates = snapshotCandidates(core, repo, filter)
    if (legacy && filter.terminalState === null && candidates.length > LEGACY_MAX_ROWS) {
      throw runtime.context.error('invalid-params', 'worker_list_snapshot_too_large')
    }
    const projected = await projectCandidates(runtime, candidates)
    const rows = filter.terminalState === null ? projected : projected.filter((row) => row.terminalState === filter.terminalState)
    if (legacy && rows.length > LEGACY_MAX_ROWS) throw runtime.context.error('invalid-params', 'worker_list_snapshot_too_large')
    const id = randomUUID()
    if (legacy) {
      return {
        workers: rows.map(cloneFleetRow),
        scope,
        page: { nextCursor: null, snapshotId: id, total: rows.length },
        partialHostErrors: partial
      }
    }
    const snapshot: FleetSnapshot = {
      id,
      filter,
      scope,
      rows,
      createdAt: Date.now(),
      expiresAt: Date.now() + SNAPSHOT_TTL_MS
    }
    if (rows.length > pageSize) storeSnapshot(snapshot)
    return pageResult(snapshot, 0, pageSize, filter.includeRemote)
  }

  function dispose(): void {
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    expiryTimer = null
    snapshots.clear()
  }

  return { show, list, dispose }
}
