import { describe, expect, test } from 'bun:test'
import type { ApprovalScope, BudgetPolicy, Enrollment, Inspection, JournalAppend, JournalEntry, KernelStore, RunnerStatus } from '../src/contracts'
import type { CommandRequest, KernelControlHost, WatcherCommand, WatcherWorker, WorkerIdentity } from '../src/control-contracts'
import { createControlPlane } from '../src/control-plane'

const WATCHER_ID = 'watcher-1'
const OWNER = { executionHostId: 'host-1', schedulerOwner: 'kernel-1', workspaceKey: 'host-1::/workspace', revision: 0 }
const UNLIMITED: BudgetPolicy = { wallClockActiveMs: null, turns: null }

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    watcherId: WATCHER_ID,
    kind: 'objective',
    workspaceKey: OWNER.workspaceKey,
    workspacePath: '/workspace',
    executionHostId: OWNER.executionHostId,
    schedulerOwner: OWNER.schedulerOwner,
    enabled: true,
    paused: false,
    commandRevision: OWNER.revision,
    capabilities: {},
    budget: UNLIMITED,
    kindPayload: { maxConcurrency: 3 },
    coordinator: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: 'run-1',
    createdAtMs: 1,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    repoId: 'repo-1',
    ...overrides,
  }
}

function escalation(id: string, overrides: Record<string, unknown> = {}): JournalAppend {
  return {
    kind: 'escalation',
    class: 'fact',
    origin: 'owner',
    resolved: false,
    escalationId: id,
    escalationKind: 'awaiting-approval',
    status: 'open',
    foldCount: 1,
    ...overrides,
  }
}

function approvalScope(overrides: Partial<ApprovalScope> = {}): ApprovalScope {
  return {
    actionKind: 'write-file',
    contentIdentity: 'content-v1',
    evidenceKey: 'evidence-v1',
    ...overrides,
  }
}

function identity(overrides: Partial<WorkerIdentity> = {}): WorkerIdentity {
  return {
    dispatchId: 'dispatch-1',
    sessionId: 'session-1',
    processIncarnation: 'process-instance-1',
    pid: 42,
    startTime: '2026-10-27T12:00:00.000Z',
    terminalHandle: 'terminal-1',
    ...overrides,
  }
}

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

function fixture(options: {
  enrollment?: Partial<Enrollment>
  workers?: WatcherWorker[]
  status?: RunnerStatus | null
  activeMs?: number
  turns?: number
  now?: number
} = {}) {
  let readOnly = false
  let clock = options.now ?? 100
  const rows = new Map<string, Enrollment>([[WATCHER_ID, structuredClone(enrollment(options.enrollment))]])
  const journalRows = new Map<string, JournalEntry[]>([[WATCHER_ID, []]])
  const traceRows = new Map<string, Inspection['traces']>([[WATCHER_ID, []]])
  const workerRows = new Map<string, WatcherWorker[]>([[WATCHER_ID, structuredClone(options.workers ?? [])]])
  const budgetUsage = new Map<string, { activeMs: number; turns: number }>([[WATCHER_ID, { activeMs: options.activeMs ?? 0, turns: options.turns ?? 0 }]])
  const statuses = new Map<string, RunnerStatus | null>([[WATCHER_ID, options.status === undefined ? {
    state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0,
  } : options.status]])
  const calls = {
    withControl: [] as Array<{ watcherId: string; drain: boolean }>,
    changed: [] as string[],
    reconcile: [] as string[],
    reconcileInsideControl: [] as boolean[],
    removed: [] as string[],
    escalationAnswers: [] as Array<{ escalationId: string; body: string }>,
    stops: [] as WorkerIdentity[],
  }
  const activeControls = new Set<string>()
  const currentTicks = new Map<string, Promise<void>>()
  let barrierEntered = deferred<{ watcherId: string; drain: boolean }>()

  const store: KernelStore = {
    get readOnly() { return readOnly },
    list: () => [...rows.values()].map(value => structuredClone(value)),
    get: id => {
      const value = rows.get(id)
      return value ? structuredClone(value) : null
    },
    live: workspaceKey => {
      const value = [...rows.values()].find(row => row.workspaceKey === workspaceKey && row.enabled)
      return value ? structuredClone(value) : null
    },
    save: value => { rows.set(value.watcherId, structuredClone(value)) },
    transaction: work => work(),
    journal: id => (journalRows.get(id) ?? []).map(value => structuredClone(value)),
    append: (id, entry) => {
      const entries = journalRows.get(id) ?? []
      const seq = entries.reduce((max, value) => Math.max(max, value.seq), 0) + 1
      const row: JournalEntry = {
        ...entry,
        seq,
        eventId: entry.eventId ?? `event-${id}-${seq}`,
        watcherId: id,
        atMs: entry.atMs ?? clock,
      }
      journalRows.set(id, [...entries, row])
      return structuredClone(row)
    },
    traces: id => (traceRows.get(id) ?? []).map(value => structuredClone(value)),
    trace: (id, trace) => { traceRows.set(id, [...(traceRows.get(id) ?? []), structuredClone(trace)]) },
    nextTraceSeq: id => (traceRows.get(id) ?? []).reduce((max, trace) => Math.max(max, trace.seq), 0) + 1,
    retain: () => undefined,
    terminal: () => undefined,
    summary: () => null,
    registrations: () => [],
    saveRegistration: () => undefined,
    close: () => undefined,
  }

  const inspection = (id: string): Inspection | null => {
    const current = rows.get(id)
    if (!current) return null
    const usage = budgetUsage.get(id) ?? { activeMs: 0, turns: 0 }
    const exhausted = current.budget.wallClockActiveMs !== null && usage.activeMs >= current.budget.wallClockActiveMs
      ? 'budget-wall-clock'
      : current.budget.turns !== null && usage.turns >= current.budget.turns
        ? 'budget-turns'
        : null
    return {
      readOnly,
      enrollment: structuredClone(current),
      status: statuses.get(id) ?? null,
      journal: store.journal(id),
      traces: store.traces(id),
      summary: null,
      budget: { ...usage, exhausted },
    }
  }

  const host: KernelControlHost = {
    context: {} as KernelControlHost['context'],
    store,
    inspect: id => inspection(id),
    withControl: async (watcherId, drain, operation) => {
      calls.withControl.push({ watcherId, drain })
      activeControls.add(watcherId)
      barrierEntered.resolve({ watcherId, drain })
      try {
        if (drain) await currentTicks.get(watcherId)
        return await operation()
      } finally {
        activeControls.delete(watcherId)
      }
    },
    changed: watcherId => { calls.changed.push(watcherId) },
    reconcile: watcherId => {
      calls.reconcile.push(watcherId)
      calls.reconcileInsideControl.push(activeControls.has(watcherId))
    },
    remove: watcherId => {
      calls.removed.push(watcherId)
      rows.delete(watcherId)
      journalRows.delete(watcherId)
      traceRows.delete(watcherId)
    },
    workers: async current => structuredClone((workerRows.get(current.watcherId) ?? []).map(worker => {
      const visible: WatcherWorker = { ...worker }
      if (visible.question?.answered) delete visible.question
      return visible
    })),
    answerQuestion: async (_current, messageId, body) => {
      const found = (workerRows.get(WATCHER_ID) ?? []).find(worker => worker.question?.messageId === messageId)
      if (!found?.question) return { kind: 'refused', reason: 'invalid-state', detail: 'Question no longer exists.' }
      if (found.question.answered) return { kind: 'refused', reason: 'question-already-answered', detail: 'Question was already answered.' }
      found.question.answered = true
      return { kind: 'applied', appliedAtMs: clock }
    },
    answerEscalation: async (_current, escalationId, body) => {
      const latest = latestEscalationRows(store.journal(WATCHER_ID)).get(escalationId)
      if (!latest || !isOpen(latest)) return { kind: 'refused', reason: 'invalid-state', detail: 'Escalation is not open.' }
      calls.escalationAnswers.push({ escalationId, body })
      return { kind: 'applied', appliedAtMs: clock }
    },
    stopWorker: async (_current, requested) => {
      const found = (workerRows.get(WATCHER_ID) ?? []).find(worker => sameIdentity(worker.identity, requested))
      if (!found || found.state !== 'live') return { kind: 'refused', reason: 'worker-unverifiable', detail: 'Worker identity is not live and verifiable.' }
      found.state = 'exited'
      calls.stops.push(structuredClone(requested))
      return { kind: 'applied', appliedAtMs: clock }
    },
    now: () => clock,
  }

  return {
    host,
    store,
    calls,
    setReadOnly(value: boolean) { readOnly = value },
    setEnrollment(next: Enrollment) { rows.set(next.watcherId, structuredClone(next)) },
    setWorkers(next: WatcherWorker[]) { workerRows.set(WATCHER_ID, structuredClone(next)) },
    setParkReasonRuntime(value: string) {
      const current = rows.get(WATCHER_ID)
      if (current) Reflect.set(current, 'parkReason', value)
    },
    setBudgetUsage(activeMs: number, turns: number) { budgetUsage.set(WATCHER_ID, { activeMs, turns }) },
    holdTick() {
      const tick = deferred<void>()
      currentTicks.set(WATCHER_ID, tick.promise)
      barrierEntered = deferred<{ watcherId: string; drain: boolean }>()
      return { release: () => tick.resolve(), entered: barrierEntered.promise }
    },
    mayStartEffect() { return !activeControls.has(WATCHER_ID) },
    advanceClock(ms: number) { clock += ms },
  }
}

function latestEscalationRows(entries: JournalEntry[]): Map<string, JournalEntry> {
  const latest = new Map<string, JournalEntry>()
  for (const entry of entries) {
    if (entry.kind !== 'escalation' || typeof entry.escalationId !== 'string') continue
    const previous = latest.get(entry.escalationId)
    if (!previous || entry.seq >= previous.seq) latest.set(entry.escalationId, entry)
  }
  return latest
}

function isOpen(entry: JournalEntry): boolean {
  return entry.status === 'open' || entry.status === 'escalated'
}

function sameIdentity(left: WorkerIdentity, right: WorkerIdentity): boolean {
  return left.dispatchId === right.dispatchId
    && left.sessionId === right.sessionId
    && left.processIncarnation === right.processIncarnation
    && left.pid === right.pid
    && left.startTime === right.startTime
    && left.terminalHandle === right.terminalHandle
}

function request(harness: ReturnType<typeof fixture>, command: WatcherCommand, overrides: Partial<CommandRequest> = {}): CommandRequest {
  const current = harness.store.get(WATCHER_ID)!
  return {
    target: { watcherId: WATCHER_ID },
    expectedOwner: {
      executionHostId: current.executionHostId,
      schedulerOwner: current.schedulerOwner,
      workspaceKey: current.workspaceKey,
      revision: current.commandRevision,
    },
    command,
    ...overrides,
  }
}

describe('Heimdall control plane', () => {
  test('pause fences new effects and drains the current tick before persisting', async () => {
    const h = fixture()
    const control = createControlPlane(h.host)
    const tick = h.holdTick()
    const resultPromise = control.command(request(h, { kind: 'pause' }))
    expect(await tick.entered).toEqual({ watcherId: WATCHER_ID, drain: true })
    expect(h.mayStartEffect()).toBe(false)
    expect(h.store.get(WATCHER_ID)?.paused).toBe(false)
    expect(control.pending(WATCHER_ID)).toEqual(['pause'])
    const exposedPending = control.pending(WATCHER_ID)
    exposedPending.push('delete')
    expect(control.pending(WATCHER_ID)).toEqual(['pause'])

    tick.release()
    expect(await resultPromise).toMatchObject({ kind: 'applied', appliedAtMs: 100 })
    expect(h.store.get(WATCHER_ID)?.paused).toBe(true)
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
    expect(h.store.journal(WATCHER_ID).some(entry => entry.evidenceKind === 'operator-pause')).toBe(true)
    expect(h.calls.changed).toEqual([WATCHER_ID])
    expect(control.pending(WATCHER_ID)).toEqual([])
  })

  test('a non-draining budget edit preserves kernel fields committed while inspection is awaiting', async () => {
    const h = fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const inspect = h.host.inspect
    h.host.inspect = async id => {
      const observed = await inspect(id)
      entered.resolve()
      await release.promise
      return observed
    }
    const control = createControlPlane(h.host)
    const editing = control.command(request(h, { kind: 'adjust-budget', budget: { wallClockActiveMs: null, turns: 5 } }))
    await entered.promise
    const latest = h.store.get(WATCHER_ID)!
    h.store.save({ ...latest, orchestrationRunId: 'run-owned-by-watcher' })
    release.resolve()
    expect(await editing).toMatchObject({ kind: 'applied' })
    expect(h.store.get(WATCHER_ID)).toMatchObject({ orchestrationRunId: 'run-owned-by-watcher', budget: { turns: 5 }, commandRevision: 1 })
  })

  test('serializes watcher commands and checks the queued command revision at execution time', async () => {
    const h = fixture({ enrollment: { enabled: false, parkReason: 'budget', budget: { wallClockActiveMs: null, turns: 2 } }, turns: 1 })
    const control = createControlPlane(h.host)
    const first = request(h, { kind: 'adjust-budget', budget: { wallClockActiveMs: null, turns: 5 } })
    const stale = request(h, { kind: 'resume' })

    const [adjusted, resumed] = await Promise.all([control.command(first), control.command(stale)])
    expect(adjusted.kind).toBe('applied')
    expect(resumed).toMatchObject({ kind: 'refused', reason: 'stale-revision' })
    expect(h.store.get(WATCHER_ID)?.budget.turns).toBe(5)
    expect(h.store.get(WATCHER_ID)?.enabled).toBe(false)
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
    expect(h.calls.withControl).toHaveLength(2)
    expect(h.calls.withControl.every(call => call.watcherId === WATCHER_ID)).toBe(true)
  })

  test('disarm acknowledges the latest open escalation revisions and cannot be undone by resume', async () => {
    const h = fixture()
    h.store.append(WATCHER_ID, escalation('approval-1', { foldCount: 1, reason: 'awaiting-approval' }))
    h.store.append(WATCHER_ID, escalation('approval-1', { foldCount: 2, reason: 'awaiting-approval', detail: 'folded twice' }))
    h.store.append(WATCHER_ID, escalation('already-done', { status: 'resolved' }))
    const control = createControlPlane(h.host)

    expect(await control.command(request(h, { kind: 'disarm' }))).toMatchObject({ kind: 'applied' })
    const latest = latestEscalationRows(h.store.journal(WATCHER_ID))
    expect(latest.get('approval-1')).toMatchObject({ status: 'acknowledged', foldCount: 2, detail: 'folded twice' })
    expect(latest.get('already-done')?.status).toBe('resolved')
    expect(h.store.get(WATCHER_ID)).toMatchObject({ enabled: false, paused: false, parkReason: null, commandRevision: 1 })

    const result = await control.command(request(h, { kind: 'resume' }))
    expect(result).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
  })

  test('approves only the current exact scope, acknowledges it, and reconciles outside the control barrier', async () => {
    const h = fixture()
    const scope = approvalScope({ preparedCommitSha: 'commit-1' })
    h.store.append(WATCHER_ID, escalation('approval-1', { approvalScope: scope, foldCount: 3 }))
    const control = createControlPlane(h.host)

    const refused = await control.command(request(h, {
      kind: 'approve', escalationId: 'approval-1', scope: { ...scope, evidenceKey: 'changed' },
    }))
    expect(refused).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)
    expect(h.store.journal(WATCHER_ID).some(entry => entry.kind === 'approval')).toBe(false)
    const answeredAsEscalation = await control.command(request(h, {
      kind: 'answer-escalation', escalationId: 'approval-1', body: 'Approve this action.',
    }))
    expect(answeredAsEscalation).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.calls.escalationAnswers).toEqual([])
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)

    expect(await control.command(request(h, { kind: 'approve', escalationId: 'approval-1', scope }))).toMatchObject({ kind: 'applied' })
    expect(h.store.journal(WATCHER_ID).filter(entry => entry.kind === 'approval')).toHaveLength(1)
    expect(h.store.journal(WATCHER_ID).find(entry => entry.kind === 'approval')).toMatchObject({ status: 'approved', scope })
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('approval-1')?.status).toBe('acknowledged')
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
    expect(h.calls.reconcile).toEqual([WATCHER_ID])
    expect(h.calls.reconcileInsideControl).toEqual([false])
  })

  test('refuses exhausted resume without mutation, accepts zero and unlimited budget edits, then resumes', async () => {
    const h = fixture({
      enrollment: { enabled: false, parkReason: 'budget', budget: { wallClockActiveMs: null, turns: 2 } },
      turns: 2,
    })
    const control = createControlPlane(h.host)

    const refused = await control.command(request(h, { kind: 'resume' }))
    expect(refused).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)

    expect(await control.command(request(h, { kind: 'adjust-budget', budget: { wallClockActiveMs: 0, turns: null } }))).toMatchObject({ kind: 'applied' })
    expect(h.store.get(WATCHER_ID)?.budget).toEqual({ wallClockActiveMs: 0, turns: null })
    expect(h.store.get(WATCHER_ID)?.enabled).toBe(false)
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)

    expect(await control.command(request(h, { kind: 'adjust-budget', budget: { wallClockActiveMs: null, turns: 5 } }))).toMatchObject({ kind: 'applied' })
    expect(h.store.get(WATCHER_ID)?.budget).toEqual({ wallClockActiveMs: null, turns: 5 })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(2)
    expect(await control.command(request(h, { kind: 'resume' }))).toMatchObject({ kind: 'applied' })
    expect(h.store.get(WATCHER_ID)).toMatchObject({ enabled: true, paused: false, parkReason: null, commandRevision: 3 })
  })

  test('refuses invalid limits, unsupported caps, and folder concurrency above one', async () => {
    const h = fixture()
    const control = createControlPlane(h.host)
    const badBudget = { kind: 'adjust-budget', budget: { wallClockActiveMs: -1, turns: 2 } } as unknown as WatcherCommand
    expect(await control.command(request(h, badBudget))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)
    for (const budget of [
      { wallClockActiveMs: Number.NaN, turns: 2 },
      { wallClockActiveMs: null, turns: Number.POSITIVE_INFINITY },
      { wallClockActiveMs: null, turns: 1.5 },
    ]) {
      const invalid = { kind: 'adjust-budget', budget } as unknown as WatcherCommand
      expect(await control.command(request(h, invalid))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    }
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)


    expect(await control.command(request(h, { kind: 'set-concurrency', maxConcurrency: 0 }))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    expect(await control.command(request(h, { kind: 'set-concurrency', maxConcurrency: 1025 }))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    expect(await control.command(request(h, { kind: 'set-concurrency', maxConcurrency: Number.POSITIVE_INFINITY }))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    const nonObjective = fixture({ enrollment: { kind: 'hosted-review', kindPayload: {} } })
    expect(await createControlPlane(nonObjective.host).command(request(nonObjective, { kind: 'set-concurrency', maxConcurrency: 2 }))).toMatchObject({ kind: 'refused', reason: 'unsupported-capability' })
    const folder = fixture({ enrollment: { repoId: null, kindPayload: { maxConcurrency: 1 } } })
    expect(await createControlPlane(folder.host).command(request(folder, { kind: 'set-concurrency', maxConcurrency: 2 }))).toMatchObject({ kind: 'refused', reason: 'unsupported-capability' })
    expect(folder.store.get(WATCHER_ID)?.commandRevision).toBe(0)
  })

  test('folder workspaces with a group identity cannot raise concurrency above one', async () => {
    const h = fixture({ enrollment: { repoId: 'group:isolated-folders', kindPayload: { workspaceKind: 'folder', maxConcurrency: 1 } } })
    const result = await createControlPlane(h.host).command(request(h, { kind: 'set-concurrency', maxConcurrency: 2 }))
    expect(result).toMatchObject({ kind: 'refused', reason: 'unsupported-capability' })
    expect(h.store.get(WATCHER_ID)).toMatchObject({ commandRevision: 0, kindPayload: { maxConcurrency: 1 } })
  })

  test('lowering objective concurrency drains the tick before changing the payload', async () => {
    const h = fixture()
    const control = createControlPlane(h.host)
    const tick = h.holdTick()
    const resultPromise = control.command(request(h, { kind: 'set-concurrency', maxConcurrency: 1 }))
    expect(await tick.entered).toEqual({ watcherId: WATCHER_ID, drain: true })
    expect(h.store.get(WATCHER_ID)?.kindPayload).toEqual({ maxConcurrency: 3 })
    tick.release()
    expect(await resultPromise).toMatchObject({ kind: 'applied' })
    expect(h.store.get(WATCHER_ID)?.kindPayload).toEqual({ maxConcurrency: 1 })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
  })

  test('answer-question resolves only the pending worker question, records the effect, and duplicate answer refuses', async () => {
    const worker: WatcherWorker = {
      identity: identity(),
      state: 'live',
      assignmentActive: true,
      question: { messageId: 'question-1', body: 'Continue?' },
    }
    const h = fixture({ enrollment: { enabled: false, parkReason: 'worker-question' }, workers: [worker] })
    h.store.append(WATCHER_ID, escalation('worker-question:question-1', {
      escalationKind: 'worker-question', messageId: 'question-1', status: 'open',
    }))
    h.store.append(WATCHER_ID, escalation('park-question', {
      escalationKind: 'park-worker-question', sourceMessageId: 'question-1', sourceEscalationId: 'worker-question:question-1',
    }))
    const control = createControlPlane(h.host)

    const blockedResume = await control.command(request(h, { kind: 'resume' }))
    expect(blockedResume).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)

    expect(await control.command(request(h, { kind: 'answer-question', messageId: 'question-1', body: 'Continue.' }))).toMatchObject({ kind: 'applied', appliedAtMs: 100 })
    expect(h.store.get(WATCHER_ID)).toMatchObject({ enabled: true, paused: false, parkReason: null, commandRevision: 1 })
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('worker-question:question-1')?.status).toBe('resolved')
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('park-question')?.status).toBe('resolved')
    expect(h.store.journal(WATCHER_ID).some(entry => entry.evidenceKind === 'worker-question-answered')).toBe(true)

    const duplicate = await control.command(request(h, { kind: 'answer-question', messageId: 'question-1', body: 'Again.' }))
    expect(duplicate).toMatchObject({ kind: 'refused', reason: 'question-already-answered' })
    const missing = await control.command(request(h, { kind: 'answer-question', messageId: 'missing-question', body: 'Answer.' }))
    expect(missing).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
  })

  test('answer-escalation resolves the exact open escalation and does not rewrite unrelated revisions', async () => {
    const h = fixture({ enrollment: { enabled: false, parkReason: 'worker-escalation' } })
    h.store.append(WATCHER_ID, escalation('worker-escalation-1', { escalationKind: 'worker-escalation', foldCount: 2 }))
    h.store.append(WATCHER_ID, escalation('park-escalation', { escalationKind: 'park-worker-escalation', sourceEscalationId: 'worker-escalation-1' }))
    h.store.append(WATCHER_ID, escalation('owner-deviation-1', { escalationKind: 'stall', status: 'open' }))
    const control = createControlPlane(h.host)

    expect(await control.command(request(h, { kind: 'answer-escalation', escalationId: 'worker-escalation-1', body: 'Proceed.' }))).toMatchObject({ kind: 'applied' })
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('worker-escalation-1')).toMatchObject({ status: 'resolved', humanReply: 'Proceed.', foldCount: 2 })
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('park-escalation')?.status).toBe('resolved')
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('owner-deviation-1')?.status).toBe('open')
    expect(h.store.get(WATCHER_ID)).toMatchObject({ enabled: true, paused: false, parkReason: null, commandRevision: 1 })

    const closed = await control.command(request(h, { kind: 'answer-escalation', escalationId: 'worker-escalation-1', body: 'Again.' }))
    expect(closed).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
  })

  test('owner escalation parks cannot be resumed and only their answer un-parks them', async () => {
    const h = fixture({ enrollment: { enabled: false } })
    h.setParkReasonRuntime('owner-escalation')
    h.store.append(WATCHER_ID, escalation('owner-deviation-1', { escalationKind: 'owner-escalation', status: 'escalated' }))
    h.store.append(WATCHER_ID, escalation('unrelated-deviation', { escalationKind: 'stall', status: 'escalated' }))
    const control = createControlPlane(h.host)

    const resumed = await control.command(request(h, { kind: 'resume' }))
    expect(resumed).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    const unrelated = await control.command(request(h, { kind: 'answer-escalation', escalationId: 'unrelated-deviation', body: 'Wrong target.' }))
    expect(unrelated).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect(h.calls.escalationAnswers).toEqual([])
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)

    expect(await control.command(request(h, { kind: 'answer-escalation', escalationId: 'owner-deviation-1', body: 'Addressed.' }))).toMatchObject({ kind: 'applied' })
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('owner-deviation-1')).toMatchObject({ status: 'resolved', humanReply: 'Addressed.' })
    expect(h.store.get(WATCHER_ID)).toMatchObject({ enabled: true, parkReason: null, commandRevision: 1 })
    expect(latestEscalationRows(h.store.journal(WATCHER_ID)).get('unrelated-deviation')?.status).toBe('escalated')
  })

  test('stop-worker requires the exact live session and process incarnation, never just a PID', async () => {
    const actual = identity()
    const h = fixture({ workers: [{ identity: actual, state: 'live', assignmentActive: true }] })
    const control = createControlPlane(h.host)
    const pidOnly = identity({ sessionId: undefined, processIncarnation: undefined })
    const wrongIncarnation = identity({ processIncarnation: 'different-process' })

    expect(await control.command(request(h, { kind: 'stop-worker', identity: pidOnly }))).toMatchObject({ kind: 'refused', reason: 'worker-unverifiable' })
    expect(await control.command(request(h, { kind: 'stop-worker', identity: wrongIncarnation }))).toMatchObject({ kind: 'refused', reason: 'worker-unverifiable' })
    expect(h.calls.stops).toHaveLength(0)
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)

    expect(await control.command(request(h, { kind: 'stop-worker', identity: actual }))).toMatchObject({ kind: 'applied' })
    expect(h.calls.stops).toEqual([actual])
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
    expect(h.store.journal(WATCHER_ID).some(entry => entry.evidenceKind === 'worker-stop-requested')).toBe(true)
    expect(h.store.journal(WATCHER_ID).some(entry => entry.kind === 'attempt-resolved')).toBe(false)
  })

  test('delete removes watcher history without stopping worker terminals', async () => {
    const h = fixture({ workers: [{ identity: identity(), state: 'live', assignmentActive: true }] })
    h.store.append(WATCHER_ID, escalation('approval-1'))
    const control = createControlPlane(h.host)

    expect(await control.command(request(h, { kind: 'delete' }))).toMatchObject({ kind: 'applied' })
    expect(h.store.get(WATCHER_ID)).toBeNull()
    expect(h.store.journal(WATCHER_ID)).toEqual([])
    expect(h.calls.removed).toEqual([WATCHER_ID])
    expect((await h.host.workers(enrollment()))[0]?.state).toBe('live')
    expect(h.calls.stops).toHaveLength(0)
  })

  test('fails closed for missing, foreign, malformed, read-only, and invalid requests', async () => {
    const h = fixture()
    const control = createControlPlane(h.host)
    const missing = request(h, { kind: 'pause' }, { target: { watcherId: 'missing' } })
    expect(await control.command(missing)).toMatchObject({ kind: 'refused', reason: 'watcher-not-found' })

    const foreignTarget = request(h, { kind: 'pause' }, { target: { watcherId: WATCHER_ID, connectionId: 'paired-runtime' } })
    expect(await control.command(foreignTarget)).toMatchObject({ kind: 'refused', reason: 'owner-unreachable' })
    const foreignOwner = request(h, { kind: 'pause' }, { expectedOwner: { ...OWNER, executionHostId: 'other-host' } })
    expect(await control.command(foreignOwner)).toMatchObject({ kind: 'refused', reason: 'owner-conflict' })
    const stale = request(h, { kind: 'pause' }, { expectedOwner: { ...OWNER, revision: 9 } })
    expect(await control.command(stale)).toMatchObject({ kind: 'refused', reason: 'stale-revision' })

    h.setEnrollment(enrollment({ malformed: 'Invalid kind payload.' }))
    expect(await control.command(request(h, { kind: 'pause' }))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    h.setEnrollment(enrollment())
    h.setReadOnly(true)
    expect(await control.command(request(h, { kind: 'pause' }))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    h.setReadOnly(false)

    const invalid = { kind: 'pause', unexpected: true } as unknown as WatcherCommand
    expect(await control.command(request(h, invalid))).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)
  })

  test('returns a confirmed stop without waiting for the following watcher cycle', async () => {
    const workerIdentity = identity()
    const h = fixture({ workers: [{ identity: workerIdentity, state: 'live', assignmentActive: true }] })
    const nextCycle = deferred<void>()
    h.host.reconcile = () => nextCycle.promise
    const control = createControlPlane(h.host)
    const stopped = control.command(request(h, { kind: 'stop-worker', identity: workerIdentity }))
    try {
      const result = await Promise.race([
        stopped,
        new Promise<'still-waiting'>(resolve => setImmediate(() => resolve('still-waiting')))
      ])
      expect(result).toMatchObject({ kind: 'applied' })
      expect((await h.host.workers(h.store.get(WATCHER_ID)!))[0]?.state).toBe('exited')
      expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(1)
      expect(control.pending(WATCHER_ID)).toEqual([])
    } finally {
      nextCycle.resolve()
      await stopped
    }
  })

  test('does not fall back to an unbarriered control operation', async () => {
    const h = fixture()
    const control = createControlPlane(h.host)
    ;(h.host as unknown as { withControl?: KernelControlHost['withControl'] }).withControl = undefined
    expect(await control.command(request(h, { kind: 'pause' }))).toMatchObject({ kind: 'refused', reason: 'owner-unreachable' })
    expect(h.store.get(WATCHER_ID)?.paused).toBe(false)
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)
  })

  test('reports an indeterminate answer when authority dispatch throws without a confirmed outcome', async () => {
    const h = fixture({ workers: [{ identity: identity(), state: 'live', assignmentActive: true, question: { messageId: 'question-1', body: 'Continue?' } }] })
    const originalAnswer = h.host.answerQuestion
    h.host.answerQuestion = async () => {
      await originalAnswer(enrollment(), 'question-1', 'Possibly sent.')
      throw new Error('connection lost after dispatch')
    }
    const control = createControlPlane(h.host)

    expect(await control.command(request(h, { kind: 'answer-question', messageId: 'question-1', body: 'Continue.' }))).toMatchObject({ kind: 'indeterminate' })
    expect(h.store.get(WATCHER_ID)?.commandRevision).toBe(0)
    expect(h.store.journal(WATCHER_ID)).toEqual([])
    expect(h.store.get(WATCHER_ID)?.enabled).toBe(true)
  })
})
