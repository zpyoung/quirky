import { describe, expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import type { ControlPlane, FleetRow, FleetSnapshot, KernelControlHost, OpenEscalation, WatcherWorker } from '../src/control-contracts'
import type { Enrollment, Inspection, JournalEntry, KernelStore, RunnerStatus, TickTrace } from '../src/contracts'
import { createFleetService, fleetBucket, sortFleetRows } from '../src/fleet'

const status = (state: RunnerStatus['state'], reason?: string): RunnerStatus => ({
  state,
  ...(reason === undefined ? {} : { reason }),
  nextPulseAtMs: null,
  consecutiveErrors: 0,
  consecutiveGateHolds: 0
})

function enrollment(watcherId: string, overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    watcherId,
    kind: 'objective',
    workspaceKey: `host::/work/${watcherId}`,
    workspacePath: `/work/${watcherId}`,
    executionHostId: 'host',
    schedulerOwner: 'local',
    kindPayload: { name: watcherId },
    enabled: true,
    paused: false,
    commandRevision: 3,
    capabilities: {},
    budget: { wallClockActiveMs: 60_000, turns: 4 },
    coordinator: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    ...overrides
  }
}

function journalEntry(watcherId: string, seq: number, fields: Record<string, unknown> = {}): JournalEntry {
  return {
    seq,
    eventId: `${watcherId}:${seq}`,
    watcherId,
    atMs: seq,
    class: 'fact',
    origin: 'owner',
    kind: 'evidence',
    resolved: false,
    ...fields
  }
}

function trace(watcherId: string, seq: number, exitPath = 'watching'): TickTrace {
  return {
    seq,
    watcherId,
    startedAtMs: seq * 10,
    durationMs: 1,
    exitPath,
    pinned: false,
    fullResyncDue: false,
    snapshotReadCount: 1,
    declined: []
  }
}

function inspection(
  row: Enrollment,
  state: RunnerStatus['state'] = 'watching',
  options: { journal?: JournalEntry[]; traces?: TickTrace[]; reason?: string } = {}
): Inspection {
  return {
    readOnly: false,
    enrollment: row,
    status: status(state, options.reason),
    journal: options.journal ?? [],
    traces: options.traces ?? [],
    summary: null,
    budget: { activeMs: 120, turns: 2, exhausted: null }
  }
}

function harness(initial: Array<{ enrollment: Enrollment; inspection: Inspection }>) {
  const enrollments = new Map(initial.map(({ enrollment: row }) => [row.watcherId, row]))
  const inspections = new Map(initial.map(({ enrollment: row, inspection: view }) => [row.watcherId, view]))
  const workers = new Map<string, WatcherWorker[]>()
  const worktreeViews = new Map<string, unknown>()
  const pending = new Map<string, string[]>()
  const failures = new Set<string>()
  const emitted: { event: string; data: unknown }[] = []
  const inspectionGates = new Map<string, () => Promise<void>>()
  let time = 100
  const context = {
    dataDir: '/home/plugin-data/quirky.heimdall',
    log: () => {},
    emit: (event: string, data?: unknown) => {
      emitted.push({ event, data })
      return true
    },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'quirky.worktree/resolve' && typeof params.selector === 'string') {
        return worktreeViews.get(params.selector) ?? null
      }
      return null
    }
  } as unknown as PluginContext
  const store = {
    readOnly: false,
    list: () => [...enrollments.values()]
  } as unknown as KernelStore
  const host = {
    context,
    store,
    inspect: async (watcherId: string) => {
      if (failures.has(watcherId)) throw new Error(`inspection failed for ${watcherId}`)
      const captured = inspections.get(watcherId) ?? null
      const gate = inspectionGates.get(watcherId)
      if (gate) {
        inspectionGates.delete(watcherId)
        await gate()
      }
      return captured
    },
    workers: async (row: Enrollment) => workers.get(row.watcherId) ?? [],
    now: () => time
  } as unknown as KernelControlHost
  const controls: ControlPlane = {
    command: async () => { throw new Error('Fleet projection must not dispatch controls') },
    pending: (watcherId) => pending.get(watcherId) ?? []
  }
  return {
    service: createFleetService(host, controls),
    enrollments,
    inspections,
    workers,
    pending,
    failures,
    worktreeViews,
    emitted,
    setTime(value: number) { time = value },
    delayNextInspection(watcherId: string, gate: () => Promise<void>) { inspectionGates.set(watcherId, gate) }
  }
}

function rowFor(
  id: string,
  state: RunnerStatus['state'],
  options: { enabled?: boolean; paused?: boolean; reason?: string; tick?: number; openEscalations?: OpenEscalation[]; pendingQuestion?: boolean } = {}
): FleetRow {
  const entry = enrollment(id, {
    enabled: options.enabled ?? true,
    paused: options.paused ?? false
  })
  return {
    target: { watcherId: id },
    ownerFence: { executionHostId: entry.executionHostId, schedulerOwner: entry.schedulerOwner, workspaceKey: entry.workspaceKey, revision: entry.commandRevision },
    enrollment: entry,
    status: status(state, options.reason),
    name: id,
    workspaceName: id,
    branch: null,
    phase: null,
    ownerContact: state === 'unreachable' ? 'unverifiable' : 'live',
    observedAtMs: 1,
    lastSuccessfulTickAtMs: options.tick ?? null,
    budget: { activeMs: 0, turns: 0, exhausted: null },
    runningWorkers: 0,
    maxConcurrency: null,
    openEscalations: options.openEscalations ?? [],
    pendingQuestion: options.pendingQuestion ?? false
  }
}

describe('Heimdall fleet projection', () => {
  test('sorts rows by urgency, then successful tick and name, and assigns one source bucket', () => {
    const heldForApproval = {
      escalationId: 'approval', escalationKind: 'awaiting-approval', status: 'open', foldCount: 1, reason: 'awaiting-approval'
    }
    const rows = [
      rowFor('watching-old', 'watching', { tick: 10 }),
      rowFor('disabled', 'disabled', { enabled: false }),
      rowFor('terminal', 'terminal'),
      rowFor('watching-new', 'watching', { tick: 20 }),
      rowFor('acting', 'acting'),
      rowFor('held', 'held'),
      rowFor('tick-error', 'held', { reason: 'tick-error' }),
      rowFor('unreachable', 'unreachable'),
      rowFor('parked', 'parked'),
      rowFor('escalated', 'escalated'),
      rowFor('approval', 'held', { openEscalations: [heldForApproval] }),
      rowFor('question', 'held', { pendingQuestion: true })
    ]

    expect(sortFleetRows(rows).map((row) => row.target.watcherId)).toEqual([
      'escalated', 'parked', 'tick-error', 'unreachable', 'approval', 'held', 'question', 'acting',
      'watching-new', 'watching-old', 'terminal', 'disabled'
    ])
    expect(rows.map(fleetBucket)).toEqual([
      'active', 'inactive', 'inactive', 'active', 'active', 'active', 'lostContact', 'lostContact',
      'needsYou', 'needsYou', 'needsYou', 'needsYou'
    ])
  })

  test('builds truthful counters and keeps generatedAtMs strictly monotonic', async () => {
    const row = enrollment('watcher')
    const h = harness([{ enrollment: row, inspection: inspection(row, 'watching') }])

    const first = await h.service.fleet()
    h.setTime(99)
    const second = await h.service.fleet()

    expect(first.generatedAtMs).toBe(100)
    expect(second.generatedAtMs).toBeGreaterThan(first.generatedAtMs)
    expect(second.rows).toHaveLength(1)
    expect(second.activeCount).toBe(1)
    expect(second.attentionCount).toBe(0)
    expect(second.buckets).toEqual({ needsYou: 0, lostContact: 0, active: 1, inactive: 0 })
  })

  test('uses public worktree metadata for the workspace name and branch', async () => {
    const row = enrollment('watcher', { worktreeId: 'wt_1' })
    const h = harness([{ enrollment: row, inspection: inspection(row, 'watching') }])
    h.worktreeViews.set('wt_1', { id: 'wt_1', name: 'Feature workspace', branch: 'feature/api' })

    const snapshot = await h.service.fleet()

    expect(snapshot.rows[0]?.workspaceName).toBe('Feature workspace')
    expect(snapshot.rows[0]?.branch).toBe('feature/api')
  })
  test('counts enabled unreachable rows as active while bucketing paused and terminal rows inactive', async () => {
    const watching = enrollment('watching')
    const unreachable = enrollment('unreachable')
    const parked = enrollment('parked', { enabled: false, parkReason: 'budget' })
    const paused = enrollment('paused', { paused: true })
    const terminal = enrollment('terminal', { terminalAtMs: 300, haltReason: 'complete' })
    const disabled = enrollment('disabled', { enabled: false })
    const h = harness([
      { enrollment: watching, inspection: inspection(watching, 'watching') },
      { enrollment: unreachable, inspection: inspection(unreachable, 'unreachable') },
      { enrollment: parked, inspection: inspection(parked, 'parked') },
      { enrollment: paused, inspection: inspection(paused, 'held') },
      { enrollment: terminal, inspection: inspection(terminal, 'terminal') },
      { enrollment: disabled, inspection: inspection(disabled, 'disabled') }
    ])

    const snapshot = await h.service.fleet()

    expect(snapshot.activeCount).toBe(2)
    expect(snapshot.attentionCount).toBe(1)
    expect(snapshot.buckets).toEqual({ needsYou: 1, lostContact: 1, active: 1, inactive: 3 })
  })

  test('bounds detail and debug journals and traces while preserving real pending and malformed data', async () => {
    const row = enrollment('watcher', { malformed: 'invalid objective payload' })
    const journal = Array.from({ length: 205 }, (_, i) => journalEntry('watcher', i + 1, { kind: i === 204 ? 'interval-open' : 'evidence' }))
    const traces = Array.from({ length: 25 }, (_, i) => trace('watcher', i + 1))
    const h = harness([{ enrollment: row, inspection: inspection(row, 'malformed', { journal, traces }) }])
    h.pending.set('watcher', ['pause'])
    h.workers.set('watcher', [{ identity: { dispatchId: 'dispatch-1' }, state: 'live' }])

    const detail = await h.service.detail({ watcherId: 'watcher' })
    const report = await h.service.debugReport({ watcherId: 'watcher' })

    expect(detail?.journal).toHaveLength(200)
    expect(detail?.traces).toHaveLength(20)
    expect(detail?.pendingControls).toEqual(['pause'])
    expect(detail?.workers).toEqual([{ identity: { dispatchId: 'dispatch-1' }, state: 'live' }])
    expect(report?.ledger).toHaveLength(200)
    expect(report?.traces).toHaveLength(20)
    expect(report?.malformed).toBe('invalid objective payload')
    expect(report?.openInterval?.seq).toBe(205)
  })
  test('projects the latest persisted attempt revision and bounds fleet history to the newest 30', async () => {
    const row = enrollment('watcher', { kindPayload: { name: 'Watcher name' } })
    const journal = [
      journalEntry('watcher', 1, { kind: 'attempt', attemptId: 'attempt-1', action: { kind: 'build' }, state: 'attempted' }),
      journalEntry('watcher', 2, { kind: 'attempt', attemptId: 'attempt-1', action: { kind: 'build' }, state: 'running' }),
      journalEntry('watcher', 3, { kind: 'attempt', attemptId: 'attempt-1', action: { kind: 'build' }, state: 'settled', effect: 'indeterminate', reason: 'reply lost' }),
      journalEntry('watcher', 4, { kind: 'attempt-resolved', attemptId: 'attempt-1', atMs: 100, effect: 'landed', reason: 'outcome confirmed' }),
      ...Array.from({ length: 35 }, (_, index) => journalEntry('watcher', index + 5, {
        kind: 'attempt',
        attemptId: `attempt-${index + 2}`,
        action: { kind: 'test' },
        state: 'settled',
        effect: 'landed'
      }))
    ]
    const h = harness([{ enrollment: row, inspection: inspection(row, 'watching', { journal }) }])

    const snapshot = await h.service.fleet()

    expect(snapshot.actionHistory).toHaveLength(30)
    expect(snapshot.actionHistory[0]).toEqual({
      watcherId: 'watcher',
      watcherName: 'Watcher name',
      attemptId: 'attempt-1',
      atMs: 100,
      actionKind: 'build',
      state: 'settled',
      effect: 'landed',
      reason: 'outcome confirmed'
    })
    expect(snapshot.actionHistory[29]?.atMs).toBe(11)
  })


  test('publishes fleet snapshots and emits one approval-request event only for a new live fold one', async () => {
    const row = enrollment('watcher', { worktreeId: 'worktree-1' })
    const initial = inspection(row, 'watching')
    const h = harness([{ enrollment: row, inspection: initial }])

    await h.service.publish()
    const escalation = journalEntry('watcher', 1, {
      kind: 'escalation',
      escalationId: 'escalation-1',
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount: 1,
      reason: 'awaiting-approval',
      approvalScope: { actionKind: 'merge', contentIdentity: 'sha:one', evidenceKey: 'checks:green' }
    })
    h.inspections.set('watcher', { ...initial, journal: [escalation] })

    await h.service.publish('watcher')
    await h.service.publish('watcher')

    expect(h.emitted.filter((event) => event.event === 'fleetChanged')).toHaveLength(3)
    expect(h.emitted.filter((event) => event.event === 'notification').map((event) => event.data)).toEqual([{
      watcherId: 'watcher',
      worktreeId: 'worktree-1',
      kind: 'approval-requested',
      actionKind: 'merge'
    }])
  })

  test('emits terminal transition events only across successive live observations', async () => {
    const row = enrollment('watcher')
    const initial = inspection(row, 'watching')
    const h = harness([{ enrollment: row, inspection: initial }])

    await h.service.publish()
    h.inspections.set('watcher', {
      ...initial,
      enrollment: { ...row, terminalAtMs: 200, haltReason: 'objective-complete' },
      status: status('terminal'),
      summary: { watcherId: 'watcher', kind: 'objective', state: 'complete', reason: 'objective-complete', atMs: 200, budget: initial.budget }
    })
    h.enrollments.set('watcher', { ...row, terminalAtMs: 200, haltReason: 'objective-complete' })

    await h.service.publish()

    expect(h.emitted.filter((event) => event.event === 'notification').map((event) => event.data)).toEqual([{
      watcherId: 'watcher',
      kind: 'terminal',
      state: 'complete',
      reason: 'objective-complete'
    }])
  })

  test('does not infer a transition across an inspection failure', async () => {
    const row = enrollment('watcher')
    const initial = inspection(row, 'watching')
    const h = harness([{ enrollment: row, inspection: initial }])

    await h.service.publish()
    h.failures.add('watcher')
    await h.service.publish()
    h.failures.delete('watcher')
    h.inspections.set('watcher', { ...initial, status: status('terminal') })

    await h.service.publish()

    expect(h.emitted.filter((event) => event.event === 'notification')).toHaveLength(0)
  })
  test('discards stale publish and detail reads after a newer mutation', async () => {
    const row = enrollment('watcher')
    const initial = inspection(row, 'watching')
    const h = harness([{ enrollment: row, inspection: initial }])
    const blocked = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<void>()
    h.delayNextInspection('watcher', async () => {
      reading.resolve()
      await blocked.promise
    })

    const olderPublish = h.service.publish()
    await reading.promise
    const terminalEnrollment = { ...row, terminalAtMs: 200, haltReason: 'objective-complete' }
    h.enrollments.set('watcher', terminalEnrollment)
    h.inspections.set('watcher', {
      ...initial,
      enrollment: terminalEnrollment,
      status: status('terminal'),
      summary: { watcherId: 'watcher', kind: 'objective', state: 'complete', reason: 'objective-complete', atMs: 200, budget: initial.budget }
    })
    const newerPublish = h.service.publish()
    blocked.resolve()
    await Promise.all([olderPublish, newerPublish])

    const snapshots = h.emitted.filter((event) => event.event === 'fleetChanged').map((event) => event.data as FleetSnapshot)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.rows[0]?.status.state).toBe('terminal')

    const detailBlocked = Promise.withResolvers<void>()
    const detailReading = Promise.withResolvers<void>()
    h.inspections.set('watcher', initial)
    h.enrollments.set('watcher', row)
    h.delayNextInspection('watcher', async () => {
      detailReading.resolve()
      await detailBlocked.promise
    })
    const oldDetail = h.service.detail({ watcherId: 'watcher' })
    await detailReading.promise
    h.inspections.set('watcher', { ...initial, enrollment: terminalEnrollment, status: status('terminal') })
    h.enrollments.set('watcher', terminalEnrollment)
    const publishAfterDetailChange = h.service.publish()
    detailBlocked.resolve()
    const [detail] = await Promise.all([oldDetail, publishAfterDetailChange])
    expect(detail?.status?.state).toBe('terminal')
  })
})
