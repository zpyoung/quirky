import { basename, join } from 'node:path'
import type {
  ControlPlane,
  DebugReport,
  FleetRow,
  FleetAction,
  FleetSnapshot,
  KernelControlHost,
  OpenEscalation,
  OwnerFence,
  WatcherDetail,
  WatcherTarget,
  WatcherWorker
} from './control-contracts'
import type { Enrollment, Inspection, JournalEntry, RunnerStatus, TickTrace } from './contracts'
import { fleetBucket, sortFleetRows } from './fleet-selectors'

const JOURNAL_LIMIT = 200
const TRACE_LIMIT = 20

type Observation = {
  ownerContact: FleetRow['ownerContact']
  status: RunnerStatus
  openEscalations: OpenEscalation[]
}

type NotificationEvent = {
  watcherId: string
  worktreeId?: string | null
} & (
  | { kind: 'approval-requested'; actionKind: string }
  | { kind: 'terminal'; state: string; reason: string }
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized === '') return path
  return basename(normalized)
}
type WorkspaceMetadata = { name: string; branch: string | null }

async function workspaceMetadata(host: KernelControlHost, enrollment: Enrollment): Promise<WorkspaceMetadata> {
  const fallback = { name: workspaceName(enrollment.workspacePath), branch: null }
  if (!enrollment.worktreeId) return fallback
  try {
    const value = await host.context.call('quirky.worktree/resolve', { selector: enrollment.worktreeId })
    if (!isRecord(value) || value.id !== enrollment.worktreeId) return fallback
    const name = nonEmptyString(value.name)
    if (name === null) return fallback
    return { name, branch: nonEmptyString(value.branch) }
  } catch {
    return fallback
  }
}

function payloadString(enrollment: Enrollment, keys: string[]): string | null {
  if (!isRecord(enrollment.kindPayload)) return null
  for (const key of keys) {
    const value = nonEmptyString(enrollment.kindPayload[key])
    if (value !== null) return value
  }
  return null
}

function nameOf(enrollment: Enrollment): string {
  return payloadString(enrollment, ['name', 'objectiveText', 'title']) ?? enrollment.kind
}

function phaseOf(inspection: Inspection): string | null {
  const latest = inspection.traces[inspection.traces.length - 1]
  if (!latest || !isRecord(latest.snapshot)) return null
  return nonEmptyString(latest.snapshot.phase)
}

function maxConcurrencyOf(enrollment: Enrollment): number | null {
  if (!isRecord(enrollment.kindPayload)) return null
  const value = enrollment.kindPayload.maxConcurrency
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null
}

function ownerFence(enrollment: Enrollment): OwnerFence {
  return {
    executionHostId: enrollment.executionHostId,
    schedulerOwner: enrollment.schedulerOwner,
    workspaceKey: enrollment.workspaceKey,
    revision: enrollment.commandRevision
  }
}

function latestOpenEscalations(journal: JournalEntry[]): OpenEscalation[] {
  const latest = new Map<string, JournalEntry>()
  for (const entry of journal) {
    if (entry.kind !== 'escalation') continue
    const escalationId = nonEmptyString(entry.escalationId)
    if (escalationId === null) continue
    const previous = latest.get(escalationId)
    if (!previous || previous.seq <= entry.seq) latest.set(escalationId, entry)
  }
  const result: OpenEscalation[] = []
  for (const [escalationId, entry] of latest) {
    const escalationKind = nonEmptyString(entry.escalationKind)
    const status = nonEmptyString(entry.status)
    const foldCount = entry.foldCount
    if (status !== 'open' || escalationKind === null || typeof foldCount !== 'number' || !Number.isInteger(foldCount)) continue
    result.push({
      ...entry,
      escalationId,
      escalationKind,
      status,
      foldCount,
      ...(nonEmptyString(entry.reason) === null ? {} : { reason: nonEmptyString(entry.reason)! }),
      ...(nonEmptyString(entry.detail) === null ? {} : { detail: nonEmptyString(entry.detail)! })
    } as OpenEscalation)
  }
  return result
}

function pendingQuestion(workers: WatcherWorker[]): boolean {
  return workers.some((worker) => worker.question !== undefined && worker.question.answered !== true)
}

function lastSuccessfulTick(traces: TickTrace[]): number | null {
  let last: number | null = null
  for (const trace of traces) {
    if (trace.exitPath === 'error' || trace.exitPath === 'lease-refused' || trace.exitPath === 'lease-unverifiable') continue
    if (last === null || trace.startedAtMs > last) last = trace.startedAtMs
  }
  return last
}

function latestAttemptActions(enrollment: Enrollment, journal: JournalEntry[], watcherName: string): FleetAction[] {
  const latest = new Map<string, { seq: number; action: FleetAction }>()
  for (const entry of journal) {
    const attemptId = nonEmptyString(entry.attemptId)
    if (attemptId === null) continue
    const previous = latest.get(attemptId)
    if (entry.kind === 'attempt') {
      const action = isRecord(entry.action) ? nonEmptyString(entry.action.kind) : null
      const state = entry.state
      if (
        action === null ||
        (state !== 'attempted' && state !== 'running' && state !== 'settled') ||
        (previous !== undefined && previous.seq >= entry.seq)
      ) continue
      const effect = entry.effect === 'landed' || entry.effect === 'not-landed' || entry.effect === 'indeterminate' ? entry.effect : undefined
      const reason = nonEmptyString(entry.reason)
      latest.set(attemptId, {
        seq: entry.seq,
        action: {
          watcherId: enrollment.watcherId,
          watcherName,
          attemptId,
          atMs: entry.atMs,
          actionKind: action,
          state,
          ...(effect === undefined ? {} : { effect }),
          ...(reason === null ? {} : { reason })
        }
      })
    } else if (entry.kind === 'attempt-resolved' && previous !== undefined && previous.seq < entry.seq) {
      const effect = entry.effect === 'landed' || entry.effect === 'not-landed' ? entry.effect : undefined
      if (effect === undefined) continue
      const reason = nonEmptyString(entry.reason) ?? previous.action.reason
      latest.set(attemptId, {
        seq: entry.seq,
        action: {
          ...previous.action,
          atMs: entry.atMs,
          state: 'settled',
          effect,
          ...(reason === undefined ? {} : { reason })
        }
      })
    }
  }
  return [...latest.values()].map((revision) => revision.action)
}

function isUnverifiable(status: RunnerStatus): boolean {
  return status.state === 'unreachable' || status.reason === 'lease-unverifiable'
}

function rowFrom(inspection: Inspection, workers: WatcherWorker[], workspace: WorkspaceMetadata, observedAtMs: number): FleetRow {
  const enrollment = inspection.enrollment
  const status = inspection.status ?? fallbackStatus(enrollment, inspection)
  return {
    target: { watcherId: enrollment.watcherId },
    ownerFence: ownerFence(enrollment),
    enrollment,
    status,
    name: nameOf(enrollment),
    workspaceName: workspace.name,
    branch: workspace.branch,
    phase: phaseOf(inspection),
    ownerContact: isUnverifiable(status) ? 'unverifiable' : 'live',
    observedAtMs,
    lastSuccessfulTickAtMs: lastSuccessfulTick(inspection.traces),
    budget: inspection.budget,
    runningWorkers: workers.reduce((count, worker) => count + (worker.state === 'live' ? 1 : 0), 0),
    maxConcurrency: maxConcurrencyOf(enrollment),
    openEscalations: latestOpenEscalations(inspection.journal),
    pendingQuestion: pendingQuestion(workers)
  }
}

function fallbackStatus(enrollment: Enrollment, inspection: Inspection): RunnerStatus {
  const summary = inspection.summary
  const terminalReason = summary?.reason ?? enrollment.haltReason
  if (summary !== null || enrollment.terminalAtMs !== null) {
    return {
      state: 'terminal',
      ...(terminalReason === null ? {} : { reason: terminalReason }),
      nextPulseAtMs: null,
      consecutiveErrors: 0,
      consecutiveGateHolds: 0
    }
  }
  if (enrollment.malformed) {
    return { state: 'malformed', reason: 'malformed-enrollment', detail: enrollment.malformed, nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }
  }
  if (enrollment.parkReason !== null) {
    return { state: 'parked', reason: enrollment.parkReason, nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }
  }
  if (!enrollment.enabled) {
    return {
      state: 'disabled',
      ...(enrollment.haltReason === null ? {} : { reason: enrollment.haltReason }),
      nextPulseAtMs: null,
      consecutiveErrors: 0,
      consecutiveGateHolds: 0
    }
  }
  if (enrollment.paused) {
    return { state: 'held', reason: 'paused', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }
  }
  return { state: 'unreachable', reason: 'runner-state-unavailable', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }
}

function nameOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function observation(row: FleetRow): Observation {
  return { ownerContact: row.ownerContact, status: row.status, openEscalations: row.openEscalations }
}

function worktreePart(enrollment: Enrollment): Pick<NotificationEvent, 'worktreeId'> {
  return enrollment.worktreeId === undefined ? {} : { worktreeId: enrollment.worktreeId }
}

function transitionEvents(row: FleetRow, previous: Observation | undefined, summary: Inspection['summary']): NotificationEvent[] {
  if (!previous || previous.ownerContact !== 'live' || row.ownerContact !== 'live') return []
  const events: NotificationEvent[] = []
  for (const escalation of row.openEscalations) {
    const actionKind = nonEmptyString(escalation.approvalScope?.actionKind)
    if (
      escalation.status === 'open' && escalation.foldCount === 1 && actionKind !== null &&
      (escalation.escalationKind === 'awaiting-approval' || escalation.reason === 'awaiting-approval') &&
      !previous.openEscalations.some((candidate) => candidate.escalationId === escalation.escalationId && candidate.status === 'open')
    ) {
      events.push({ watcherId: row.target.watcherId, ...worktreePart(row.enrollment), kind: 'approval-requested', actionKind })
    }
  }
  if (previous.status.state !== 'terminal' && row.status.state === 'terminal') {
    const state = nonEmptyString(summary?.state) ?? 'terminal'
    const reason = summary?.reason ?? row.status.reason ?? row.enrollment.haltReason ?? ''
    events.push({
      watcherId: row.target.watcherId,
      ...worktreePart(row.enrollment),
      kind: 'terminal',
      state,
      reason
    })
  }
  return events
}

function openInterval(journal: JournalEntry[]): JournalEntry | null {
  let current: JournalEntry | null = null
  for (const entry of journal) {
    if (entry.kind === 'interval-open') {
      current = entry
    } else if (entry.kind === 'interval-close' && current !== null && entry.seq > current.seq) {
      const openedId = current.intervalId
      const closedId = entry.intervalId
      if (openedId === undefined || closedId === undefined || openedId === closedId) current = null
    }
  }
  return current
}

function localTarget(target: WatcherTarget): boolean {
  return (target.connectionId === undefined || target.connectionId === null) &&
    (target.pairingRevision === undefined || target.pairingRevision === null)
}

function snapshotTime(host: KernelControlHost, previous: number): number {
  const now = host.now?.() ?? Date.now()
  return Math.max(now, previous + 1)
}

function emitSafely(host: KernelControlHost, event: string, data: unknown): void {
  try {
    host.context.emit(event, data)
  } catch (error) {
    host.context.log(`could not emit ${event}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function createFleetService(host: KernelControlHost, controls: ControlPlane): FleetService {
  let generatedAtMs = -1
  let publicationRevision = 0
  let readTail: Promise<void> = Promise.resolve()
  let disposed = false
  const observations = new Map<string, Observation>()

  type CollectedFleet = {
    rows: FleetRow[]
    actionHistory: FleetAction[]
    observed: Map<string, Observation>
    summaries: Map<string, Inspection['summary']>
  }

  const inspect = async (watcherId: string): Promise<Inspection | null> => host.inspect(watcherId)
  const workersOf = async (enrollment: Enrollment): Promise<WatcherWorker[]> => host.workers(enrollment)
  const pendingOf = (watcherId: string): string[] => [...controls.pending(watcherId)]
  const queueRead = <T>(read: () => Promise<T>): Promise<T> => {
    const queued = readTail.then(read)
    readTail = queued.then(() => undefined, () => undefined)
    return queued
  }
  const stableRead = async <T>(read: () => Promise<T>): Promise<{ revision: number; value: T }> => {
    while (true) {
      if (disposed) throw new Error('Heimdall fleet service is disposed')
      const revision = publicationRevision
      try {
        const value = await queueRead(read)
        if (revision === publicationRevision) return { revision, value }
      } catch (error) {
        if (revision === publicationRevision) throw error
      }
    }
  }

  const detail = async (target: WatcherTarget): Promise<WatcherDetail | null> => {
    if (!localTarget(target)) throw host.context.error('invalid-params', 'remote Heimdall targets are not supported')
    while (true) {
      const settled = await stableRead(async () => {
        const current = await inspect(target.watcherId)
        if (current === null) return null
        return {
          current,
          workers: await workersOf(current.enrollment),
          workspace: await workspaceMetadata(host, current.enrollment),
          pendingControls: pendingOf(target.watcherId)
        }
      })
      if (settled.revision !== publicationRevision) continue
      if (settled.value === null) return null
      const { current, workers, workspace, pendingControls } = settled.value
      const row = rowFrom(current, workers, workspace, host.now?.() ?? Date.now())
      return {
        ...current,
        journal: current.journal.slice(-JOURNAL_LIMIT),
        traces: current.traces.slice(-TRACE_LIMIT),
        target: { watcherId: current.enrollment.watcherId },
        ownerFence: ownerFence(current.enrollment),
        ownerContact: row.ownerContact,
        observedAtMs: row.observedAtMs,
        name: row.name,
        workers,
        openEscalations: row.openEscalations,
        pendingControls
      }
    }
  }

  const debugReport = async (target: WatcherTarget): Promise<DebugReport | null> => {
    if (!localTarget(target)) throw host.context.error('invalid-params', 'remote Heimdall targets are not supported')
    while (true) {
      const settled = await stableRead(async () => {
        const current = await inspect(target.watcherId)
        if (current === null) return null
        return {
          current,
          workers: await workersOf(current.enrollment),
          pendingControls: pendingOf(target.watcherId)
        }
      })
      if (settled.revision !== publicationRevision) continue
      if (settled.value === null) return null
      const { current, workers, pendingControls } = settled.value
      generatedAtMs = snapshotTime(host, generatedAtMs)
      return {
        schemaVersion: 2,
        generatedAtMs,
        enrollment: current.enrollment,
        status: current.status,
        budget: current.budget,
        openInterval: openInterval(current.journal),
        ledger: current.journal.slice(-JOURNAL_LIMIT),
        traces: current.traces.slice(-TRACE_LIMIT),
        pendingControls,
        malformed: current.enrollment.malformed ?? null,
        workers,
        runner: current.status,
        pointers: {
          database: join(host.context.dataDir, 'store.db'),
          workspace: current.enrollment.workspacePath,
          leaseHolder: null
        }
      }
    }
  }

  const collectFleet = async (): Promise<CollectedFleet> => {
    const rows: FleetRow[] = []
    const actionHistory: FleetAction[] = []
    const observed = new Map<string, Observation>()
    const summaries = new Map<string, Inspection['summary']>()
    for (const enrollment of host.store.list()) {
      const current = await inspect(enrollment.watcherId)
      if (current === null) continue
      const workers = await workersOf(current.enrollment)
      const workspace = await workspaceMetadata(host, current.enrollment)
      const row = rowFrom(current, workers, workspace, host.now?.() ?? Date.now())
      rows.push(row)
      actionHistory.push(...latestAttemptActions(current.enrollment, current.journal, row.name))
      observed.set(row.target.watcherId, observation(row))
      summaries.set(row.target.watcherId, current.summary)
    }
    return { rows, actionHistory, observed, summaries }
  }

  const readFleet = async (): Promise<FleetSnapshot> => {
    while (true) {
      let settled: { revision: number; value: CollectedFleet }
      try {
        settled = await stableRead(collectFleet)
      } catch (error) {
        observations.clear()
        throw error
      }
      if (settled.revision !== publicationRevision) continue
      const { rows, actionHistory, observed, summaries } = settled.value
      for (const watcherId of observations.keys()) {
        if (!observed.has(watcherId)) observations.delete(watcherId)
      }
      const sorted = sortFleetRows(rows)
      const sortedActionHistory = actionHistory.sort((left, right) =>
        right.atMs - left.atMs ||
        nameOrder(left.watcherName, right.watcherName) ||
        nameOrder(left.watcherId, right.watcherId) ||
        nameOrder(left.attemptId, right.attemptId)
      )
      sortedActionHistory.length = Math.min(30, sortedActionHistory.length)
      const buckets = { needsYou: 0, lostContact: 0, active: 0, inactive: 0 }
      let activeCount = 0
      const events: NotificationEvent[] = []
      for (const row of sorted) {
        buckets[fleetBucket(row)]++
        if (
          row.enrollment.enabled && !row.enrollment.paused &&
          row.status.state !== 'parked' && row.status.state !== 'terminal' && row.status.state !== 'disabled'
        ) activeCount++
        events.push(...transitionEvents(row, observations.get(row.target.watcherId), summaries.get(row.target.watcherId) ?? null))
      }
      observations.clear()
      for (const [watcherId, current] of observed) observations.set(watcherId, current)
      generatedAtMs = snapshotTime(host, generatedAtMs)
      const snapshot = {
        generatedAtMs,
        rows: sorted,
        buckets,
        actionHistory: sortedActionHistory,
        activeCount,
        attentionCount: buckets.needsYou
      }
      for (const event of events) emitSafely(host, 'notification', event)
      return snapshot
    }
  }

  return {
    fleet: readFleet,
    detail,
    debugReport,
    async publish(_watcherId?: string) {
      if (disposed) return
      const ticket = ++publicationRevision
      try {
        const snapshot = await readFleet()
        if (!disposed && ticket === publicationRevision) emitSafely(host, 'fleetChanged', snapshot)
      } catch (error) {
        if (ticket === publicationRevision) {
          host.context.log(`Heimdall fleet publish failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
    dispose() {
      disposed = true
      publicationRevision++
      observations.clear()
    }
  }
}
