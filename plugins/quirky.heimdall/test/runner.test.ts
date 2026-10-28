import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { budgetUsage } from '../src/budget'
import { createOrchestrationAdapter, orchestrationRequestIdForAttemptFingerprint } from '../src/orchestration'
import { actionFingerprint, gateAction } from '../src/gate'
import { createRunner } from '../src/runner'
import { createKernelStore } from '../src/store'
import { backoffMs, pacingDelay, tierDelayMs } from '../src/pacing'
import type {
  Attempt,
  Decision,
  Enrollment,
  JournalEntry,
  KernelAction,
  KernelStore,
  KernelWorkerObservation,
  KindRegistry,
  OrchestrationPort,
  RunnerOptions,
  Snapshot,
  WatcherKind,
  WorkerMessage,
  WorkerRequest
} from '../src/contracts'

const roots: string[] = []
const databaseClosers: Array<() => void> = []

afterEach(() => {
  for (const close of databaseClosers.splice(0)) close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type World = { revision: string }
const action: KernelAction = {
  kind: 'publish',
  capability: 'publish',
  visibility: 'external',
  contentIdentity: 'tree-1',
  evidenceKey: 'evidence-1',
  expectedState: { target: 'revision', before: 'tree-1' }
}

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'test-kind',
    workspaceKey: 'local::/workspace',
    workspacePath: '/workspace',
    executionHostId: 'local',
    schedulerOwner: 'local',
    repoId: null,
    worktreeId: null,
    kindPayload: null,
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { publish: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    coordinator: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 0,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    ...overrides
  }
}

function journalEntry(seq: number, kind: string, atMs: number, extra: Record<string, unknown> = {}): JournalEntry {
  return {
    seq,
    eventId: `event-${seq}`,
    watcherId: 'watcher-1',
    atMs,
    class: 'fact',
    origin: 'owner',
    kind,
    resolved: true,
    ...extra
  }
}
interface TestStorage {
  context: PluginContext
  readonly store: KernelStore
  restart(): void
}

function storage(): TestStorage {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-runner-'))
  roots.push(root)
  const home = join(root, 'home')
  const handles: Array<() => void> = []
  const context = {
    pluginId: 'quirky.heimdall',
    dir: root,
    dataDir: join(home, 'plugin-data', 'quirky.heimdall'),
    home,
    openStore(migrations: string[]) {
      const handle = openPluginStore({ home, pluginId: 'quirky.heimdall', migrations, isActive: () => true })
      handles.push(handle.close)
      databaseClosers.push(handle.close)
      return handle.store
    }
  } as unknown as PluginContext
  let store = createKernelStore(context)
  return {
    context,
    get store() { return store },
    restart() {
      store.close()
      for (const close of handles.splice(0)) {
        close()
        const index = databaseClosers.indexOf(close)
        if (index !== -1) databaseClosers.splice(index, 1)
      }
      store = createKernelStore(context)
    }
  }
}

function kind(overrides: Partial<WatcherKind<World>> = {}): WatcherKind<World> {
  return {
    id: 'test-kind',
    displayName: 'Test kind',
    enrollmentPayloadSchema: {} as WatcherKind['enrollmentPayloadSchema'],
    authorizeEnrollment: async () => { throw new Error('unused') },
    read: async () => ({
      freshness: 'live',
      contentIdentity: 'tree-1',
      observedAtMs: 0,
      world: { revision: 'tree-1' }
    }),
    decide: () => ({ action: null, reason: 'settled' }),
    execute: async () => ({ effect: 'landed' }),
    ...overrides
  }
}

function registry(watcherKind: WatcherKind<World>): KindRegistry {
  return {
    get: (id: string) => id === watcherKind.id ? watcherKind : undefined,
    register: () => undefined,
    registerDescriptor: () => undefined,
    descriptors: () => []
  }
}

function orchestration(overrides: Partial<OrchestrationPort> = {}): OrchestrationPort {
  return {
    dispatch: async () => ({ kind: 'indeterminate', requestId: 'request-1' }),
    recover: async () => null,
    observeWorkers: async () => [],
    mailbox: async () => [],
    acknowledge: async () => undefined,
    release: async () => undefined,
    dispose: () => undefined,
    ...overrides
  }
}

function runnerOptions(
  stored: TestStorage,
  watcherKind: WatcherKind<World>,
  overrides: Partial<RunnerOptions> = {}
): RunnerOptions {
  const current = enrollment()
  stored.store.save(current)
  return {
    context: stored.context,
    store: stored.store,
    registry: registry(watcherKind),
    orchestration: orchestration(),
    enrollment: current,
    now: () => 1_000,
    ...overrides
  }
}

function currentAttempt(entries: JournalEntry[]): Attempt | undefined {
  return entries.filter((entry): entry is Attempt => entry.kind === 'attempt').at(-1)
}
function seedWorkerPark(
  stored: TestStorage,
  reason: 'worker-question' | 'worker-escalation',
  messageId: string
): void {
  const current = stored.store.get('watcher-1')
  if (!current) throw new Error('Test watcher must be stored before seeding a park.')
  const sourceEscalationId = `${reason}:${messageId}`
  stored.store.save({ ...current, enabled: false, parkReason: reason, haltReason: 'awaiting worker response' })
  stored.store.append('watcher-1', {
    kind: 'escalation',
    class: 'fact',
    origin: 'owner',
    resolved: false,
    eventId: `test-open:${sourceEscalationId}`,
    escalationId: sourceEscalationId,
    escalationKind: reason,
    status: 'open',
    foldCount: 1,
    messageId
  })
  stored.store.append('watcher-1', {
    kind: 'escalation',
    class: 'fact',
    origin: 'owner',
    resolved: false,
    eventId: `test-park:${sourceEscalationId}`,
    escalationId: `park-${reason}`,
    escalationKind: reason,
    status: 'open',
    foldCount: 1,
    sourceEscalationId,
    sourceMessageId: messageId
  })
}


describe('Heimdall runner gate and budget behavior', () => {
  test('fingerprints exactly the content identity, action kind, and evidence key', () => {
    expect(actionFingerprint(action)).toBe(JSON.stringify(['tree-1', 'publish', 'evidence-1']))
    expect(actionFingerprint({ ...action, expectedState: { target: 'revision', before: 'other' } })).toBe(actionFingerprint(action))
  })
  test('pacing uses fixed tiers, capped exponential backoff, and the forced resync boundary', () => {
    expect(['rapid', 'active', 'idle', 'stopped'].map((tier) => tierDelayMs(tier as 'rapid' | 'active' | 'idle' | 'stopped'))).toEqual([15_000, 60_000, 300_000, null])
    expect([1, 2, 6, 20].map(backoffMs)).toEqual([30_000, 60_000, 900_000, 900_000])
    expect(pacingDelay({ tier: 'idle', nowMs: 880_000, lastLiveReadAtMs: 0, consecutiveErrors: 0, consecutiveGateHolds: 0 })).toBe(20_000)
  })

  test('gate precedence selects disabled before parked, budget, and stop predicates', () => {
    const verdict = gateAction({
      action,
      snapshot: { freshness: 'live', contentIdentity: 'tree-1', observedAtMs: 0, world: { revision: 'tree-1' } },
      enrollment: enrollment({ enabled: false, parkReason: 'budget' }),
      journal: [],
      budget: { activeMs: 0, turns: 0, exhausted: 'budget-wall-clock' },
      stopPredicateFired: true
    })
    expect(verdict).toEqual({ verdict: 'hold', reason: 'disabled' })
  })
  test('wall-clock budget gate precedes a fired stop predicate', () => {
    const verdict = gateAction({
      action,
      snapshot: { freshness: 'live', contentIdentity: 'tree-1', observedAtMs: 0, world: { revision: 'tree-1' } },
      enrollment: enrollment(),
      journal: [],
      budget: { activeMs: 0, turns: 0, exhausted: 'budget-wall-clock' },
      stopPredicateFired: true
    })
    expect(verdict).toEqual({ verdict: 'hold', reason: 'budget-wall-clock' })
  })
  test('approval is scoped to the exact action kind, content, and evidence', () => {
    const snapshot = { freshness: 'live' as const, contentIdentity: 'tree-1', observedAtMs: 0, world: { revision: 'tree-1' } }
    const gatedEnrollment = enrollment({ capabilities: { publish: 'gated' } })
    const input = { action, snapshot, enrollment: gatedEnrollment, budget: { activeMs: 0, turns: 0, exhausted: null }, stopPredicateFired: false }
    expect(gateAction({ ...input, journal: [] })).toEqual({ verdict: 'hold', reason: 'awaiting-approval' })
    const approval = journalEntry(1, 'approval', 1, {
      status: 'approved',
      approvalScope: { actionKind: 'publish', contentIdentity: 'tree-1', evidenceKey: 'evidence-1' }
    })
    expect(gateAction({ ...input, journal: [approval] })).toEqual({ verdict: 'allow' })
    expect(gateAction({ ...input, action: { ...action, evidenceKey: 'new-evidence' }, journal: [approval] })).toEqual({
      verdict: 'hold',
      reason: 'awaiting-approval'
    })
  })


  test('any unresolved external attempt blocks a different external fingerprint', () => {
    const pendingAction = { ...action, evidenceKey: 'older-evidence' }
    const pending = journalEntry(1, 'attempt', 0, {
      attemptId: 'pending-external',
      fingerprint: actionFingerprint(pendingAction),
      action: pendingAction,
      state: 'settled',
      effect: 'indeterminate'
    })
    const verdict = gateAction({
      action: { ...action, evidenceKey: 'new-evidence' },
      snapshot: { freshness: 'live', contentIdentity: 'tree-1', observedAtMs: 0, world: { revision: 'tree-1' } },
      enrollment: enrollment(),
      journal: [pending],
      budget: { activeMs: 0, turns: 0, exhausted: null }
    })
    expect(verdict).toEqual({ verdict: 'hold', reason: 'unresolved-attempt' })
  })

  test('active budget unions overlapping intervals and counts distinct dispatch turns', () => {
    const journal = [
      journalEntry(1, 'interval-open', 0, { intervalId: 'a', generation: 'initial:watcher-1' }),
      journalEntry(2, 'interval-close', 100, { intervalId: 'a', generation: 'initial:watcher-1', reason: 'settled' }),
      journalEntry(3, 'interval-open', 50, { intervalId: 'b', generation: 'initial:watcher-1' }),
      journalEntry(4, 'interval-close', 150, { intervalId: 'b', generation: 'initial:watcher-1', reason: 'settled' }),
      journalEntry(5, 'turn', 160, { dispatchId: 'd1', generation: 'initial:watcher-1' }),
      journalEntry(6, 'turn', 161, { dispatchId: 'd1', generation: 'initial:watcher-1' }),
      journalEntry(7, 'turn', 162, { dispatchId: 'd2', generation: 'initial:watcher-1' })
    ]
    expect(budgetUsage(journal, 200)).toEqual({ activeMs: 150, turns: 2, exhausted: null })
  })

  test('budget generation excludes prior intervals and late turns from older attempts', () => {
    const journal = [
      journalEntry(1, 'interval-open', 0, { intervalId: 'old', generation: 'g0' }),
      journalEntry(2, 'interval-close', 100, { intervalId: 'old', generation: 'g0', reason: 'settled' }),
      journalEntry(3, 'turn', 110, { dispatchId: 'old-turn', generation: 'g0' }),
      journalEntry(4, 'evidence', 120, { evidenceKind: 'budget-generation', generation: 'g1' }),
      journalEntry(5, 'turn', 130, { dispatchId: 'late-old-turn', generation: 'g0' }),
      journalEntry(6, 'turn', 140, { dispatchId: 'new-turn', generation: 'g1' })
    ]
    expect(budgetUsage(journal, 200)).toEqual({ activeMs: 0, turns: 1, exhausted: null })
  })

  test('budget policy reports zero exhaustion and checks wall-clock before turns', () => {
    expect(budgetUsage([], 0)).toEqual({ activeMs: 0, turns: 0, exhausted: null })
    expect(budgetUsage([], 0, { wallClockActiveMs: 0, turns: 0 })).toEqual({
      activeMs: 0,
      turns: 0,
      exhausted: 'budget-wall-clock'
    })
    expect(budgetUsage([], 0, { wallClockActiveMs: null, turns: 0 })).toEqual({
      activeMs: 0,
      turns: 0,
      exhausted: 'budget-turns'
    })
  })


  test('a failed tick closes active time at its last confirmed checkpoint', async () => {
    const stored = storage()
    let nowMs = 1_000
    let unavailable = false
    const watcherKind = kind({
      read: async () => {
        if (unavailable) throw new Error('world read lost contact')
        return { freshness:'live',contentIdentity:'tree-1',observedAtMs:nowMs,world:{ revision:'tree-1' } }
      }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind, { now:() => nowMs }))
    try {
      await runner.pulse()
      stored.store.append('watcher-1', {
        kind:'interval-open',class:'fact',origin:'owner',resolved:true,
        intervalId:'contact-work',cause:'worker-dispatched',generation:'initial:watcher-1',atMs:1_000
      })
      stored.store.append('watcher-1', {
        kind:'interval-checkpoint',class:'fact',origin:'owner',resolved:true,
        intervalId:'contact-work',generation:'initial:watcher-1',checkpointAtMs:2_000,atMs:2_000
      })
      nowMs = 9_000
      unavailable = true
      await runner.pulse()
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(1_000)
      expect(stored.store.journal('watcher-1').find((entry) => entry.kind === 'interval-close' && entry.intervalId === 'contact-work'))
        .toMatchObject({ reason:'contact-lost',checkpointAtMs:2_000 })
      expect(runner.status()).toMatchObject({ state:'held',reason:'tick-error' })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('live redecision abandons a cached external action when its fingerprint changes', async () => {
    const stored = storage()
    let readCount = 0
    let executeCount = 0
    const watcherKind = kind({
      read: async (_enrollment, _options): Promise<Snapshot<World>> => {
        readCount += 1
        const live = readCount > 1
        return {
          freshness: live ? 'live' : 'cached',
          contentIdentity: live ? 'tree-2' : 'tree-1',
          observedAtMs: readCount,
          world: { revision: live ? 'tree-2' : 'tree-1' }
        }
      },
      decide: (snapshot) => ({ action: { ...action, contentIdentity: snapshot.contentIdentity, evidenceKey: snapshot.contentIdentity } }),
      execute: async () => { executeCount += 1; return { effect: 'landed' } }
    })
    const options = runnerOptions(stored, watcherKind)
    const runner = createRunner(options)
    try {
      await runner.pulse()
      expect(executeCount).toBe(0)
      expect(stored.store.journal('watcher-1').some((entry) => entry.kind === 'attempt-abandoned' && entry.reason === 'workspace-moved')).toBe(true)
    } finally {
      await runner.shutdown(0)
    }
  })

  test('write-ahead attempt is visible before execute and an ambiguous throw stays unresolved', async () => {
    const stored = storage()
    let executeCount = 0
    const watcherKind = kind({
      decide: (() => {
        let decided = false
        return () => decided ? { action: null, reason: 'waiting' } : (decided = true, { action })
      })(),
      execute: async () => {
        executeCount += 1
        expect(currentAttempt(stored.store.journal('watcher-1'))?.state).toBe('attempted')
        throw new Error('lost reply')
      }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    try {
      await runner.pulse()
      const attempt = currentAttempt(stored.store.journal('watcher-1'))
      expect(executeCount).toBe(1)
      expect(attempt?.state).toBe('settled')
      expect(attempt?.effect).toBe('indeterminate')
    } finally {
      await runner.shutdown(0)
    }
  })
  test('a confirmed worker dispatch stays running and records one durable turn', async () => {
    const stored = storage()
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    let dispatches = 0
    let executions = 0
    const port = orchestration({
      dispatch: async (_current, attempt, request) => {
        dispatches += 1
        expect(attempt.state).toBe('running')
        expect(attempt.workerRequest).toEqual(workerRequest)
        expect(attempt.requestId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
        expect(request).toEqual(workerRequest)
        return { kind: 'dispatched', dispatchId: 'dispatch-1' }
      }
    })
    const watcherKind = kind({
      decide: () => ({ action }),
      execute: async (_action, context) => {
        executions += 1
        const result = await context.dispatchWorker(workerRequest)
        if (result.kind === 'dispatched') return { effect: 'landed' }
        if (result.kind === 'refused') return { effect: 'not-landed', reason: result.reason }
        return { effect: 'indeterminate', reason: result.detail }
      }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind, { orchestration: port }))
    try {
      await runner.pulse()
      await runner.pulse()
      const journal = stored.store.journal('watcher-1')
      expect(dispatches).toBe(1)
      expect(executions).toBe(1)
      expect(currentAttempt(journal)).toMatchObject({ state: 'running', dispatchId: 'dispatch-1' })
      expect(journal.filter((entry) => entry.kind === 'turn')).toHaveLength(1)
      expect(budgetUsage(journal, 1_000).turns).toBe(1)
    } finally {
      await runner.shutdown(0)
    }
  })

  test('worker billing follows confirmed contact, excludes unknown gaps, and worker_done settles and releases', async () => {
    const stored = storage()
    let nowMs = 1_000
    let observations: KernelWorkerObservation[] = []
    let messages: WorkerMessage[] = []
    let releases = 0
    let recoveries = 0
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      recover: async () => { recoveries += 1; return null },
      dispatch: async () => ({ kind: 'dispatched', dispatchId: 'dispatch-1' }),
      observeWorkers: async () => observations,
      mailbox: async () => messages,
      release: async () => { releases += 1 }
    })
    const watcherKind = kind({
      decide: () => ({ action }),
      execute: async (_action, context) => {
        const result = await context.dispatchWorker(workerRequest)
        return result.kind === 'dispatched' ? { effect: 'landed' } : { effect: 'indeterminate' }
      }
    })
    const options = runnerOptions(stored, watcherKind, { orchestration: port, now: () => nowMs })
    const current = { ...options.enrollment, orchestrationRunId: 'run_worker' }
    stored.store.save(current)
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      expect(currentAttempt(stored.store.journal('watcher-1'))).toMatchObject({ state: 'running', dispatchId: 'dispatch-1' })
      expect(stored.store.journal('watcher-1').filter((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )).toHaveLength(0)

      nowMs = 2_000
      observations = [{
        dispatchId: 'dispatch-1',
        sessionId: 'session-worker',
        processIncarnation: 'process-worker',
        state: 'live',
        assignmentActive: true,
        lastContactAtMs: nowMs
      }]
      await runner.pulse()
      const firstInterval = stored.store.journal('watcher-1').find((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )
      expect(firstInterval).toMatchObject({ class: 'fact', atMs: 2_000 })
      if (!firstInterval || typeof firstInterval.intervalId !== 'string') throw new Error('live worker interval was not opened')
      stored.store.append('watcher-1', {
        kind: 'interval-checkpoint',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: 'worker-checkpoint-before-contact-loss',
        intervalId: firstInterval.intervalId,
        generation: firstInterval.generation as string,
        checkpointAtMs: 2_500,
        atMs: 2_500
      })

      nowMs = 8_000
      observations = []
      await runner.pulse()
      const closed = stored.store.journal('watcher-1').find((entry) =>
        entry.kind === 'interval-close' && entry.intervalId === firstInterval.intervalId
      )
      expect(closed).toMatchObject({ reason: 'contact-lost', checkpointAtMs: 2_500 })
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(500)
      expect(currentAttempt(stored.store.journal('watcher-1'))).toMatchObject({ state: 'running', dispatchId: 'dispatch-1' })
      expect(runner.status()).toMatchObject({ state: 'held', reason: 'worker-contact-unverifiable' })

      nowMs = 9_000
      observations = [{
        dispatchId: 'dispatch-1',
        sessionId: 'session-worker',
        processIncarnation: 'process-worker',
        state: 'live',
        assignmentActive: true,
        lastContactAtMs: nowMs
      }]
      await runner.pulse()
      const workerIntervals = stored.store.journal('watcher-1').filter((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )
      expect(workerIntervals).toHaveLength(2)
      expect(workerIntervals[1]).toMatchObject({ class: 'fact', atMs: 9_000 })
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(500)

      nowMs = 10_000
      await runner.pulse()
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(1_500)

      nowMs = 11_000
      messages = [{
        id: 'worker-done-1',
        type: 'worker_done',
        dispatchId: 'dispatch-1',
        body: 'completed',
        outcome: 'succeeded'
      }]
      await runner.pulse()
      expect(currentAttempt(stored.store.journal('watcher-1'))).toMatchObject({ state: 'settled', effect: 'landed' })
      expect(releases).toBe(1)
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(2_500)
      expect(runner.status()).not.toMatchObject({ reason: 'worker-contact-unverifiable' })
      expect(recoveries).toBe(0)
    } finally {
      await runner.shutdown(0)
    }
  })

  test('a live worker without an active supervised assignment stops billing but remains unresolved', async () => {
    const stored = storage()
    let nowMs = 1_000
    let assignmentActive = true
    let executions = 0
    let releases = 0
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      dispatch: async () => ({ kind: 'dispatched', dispatchId: 'dispatch-inactive' }),
      observeWorkers: async () => [{
        dispatchId: 'dispatch-inactive',
        sessionId: 'session-inactive',
        processIncarnation: 'process-inactive',
        state: 'live',
        assignmentActive,
        lastContactAtMs: nowMs
      }],
      release: async () => { releases += 1 }
    })
    const watcherKind = kind({
      decide: () => ({ action }),
      execute: async (_action, context) => {
        executions += 1
        await context.dispatchWorker(workerRequest)
        return { effect: 'landed' }
      },
      pace: () => 'stopped'
    })
    const options = runnerOptions(stored, watcherKind, { orchestration: port, now: () => nowMs })
    const current = { ...options.enrollment, orchestrationRunId: 'run-inactive' }
    stored.store.save(current)
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      nowMs = 2_000
      await runner.pulse()
      nowMs = 2_500
      await runner.pulse()

      assignmentActive = false
      nowMs = 8_000
      await runner.pulse()

      const journal = stored.store.journal('watcher-1')
      const interval = journal.find((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )
      if (!interval || typeof interval.intervalId !== 'string') throw new Error('active assignment interval was not opened')
      expect(journal.find((entry) =>
        entry.kind === 'interval-close' && entry.intervalId === interval.intervalId
      )).toMatchObject({ reason: 'worker-assignment-inactive', checkpointAtMs: 2_500 })
      expect(budgetUsage(journal, nowMs).activeMs).toBe(500)
      expect(currentAttempt(journal)).toMatchObject({ state: 'running', dispatchId: 'dispatch-inactive' })
      expect(currentAttempt(journal)?.effect).toBeUndefined()
      expect(journal.some((entry) => entry.evidenceKind === 'worker-assignment-inactive')).toBe(true)
      expect(runner.status()).toMatchObject({ state: 'held', reason: 'worker-assignment-inactive' })
      expect(executions).toBe(1)
      expect(releases).toBe(0)
    } finally {
      await runner.shutdown(0)
    }
  })


  test('the runner refuses to bill a live worker without a complete identity tuple', async () => {
    const stored = storage()
    let nowMs = 1_000
    let observation: KernelWorkerObservation = {
      dispatchId: 'dispatch-identity',
      sessionId: 'session-identity',
      processIncarnation: 'process-identity',
      state: 'live',
      assignmentActive: true,
      lastContactAtMs: nowMs
    }
    let releases = 0
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      observeWorkers: async () => [observation],
      release: async () => { releases += 1 }
    })
    const watcherKind = kind({
      decide: () => ({ action }),
      pace: () => 'stopped'
    })
    const options = runnerOptions(stored, watcherKind, { orchestration: port, now: () => nowMs })
    const current = { ...options.enrollment, orchestrationRunId: 'run-identity' }
    stored.store.save(current)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt-live-identity',
      attemptId: 'attempt-live-identity',
      fingerprint: 'fingerprint-live-identity',
      action,
      state: 'running',
      requestId: 'request-live-identity',
      workerRequest,
      dispatchId: 'dispatch-identity'
    })
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      nowMs = 1_500
      await runner.pulse()
      observation = { ...observation, sessionId: null, lastContactAtMs: nowMs }
      nowMs = 2_000
      await runner.pulse()

      const journal = stored.store.journal('watcher-1')
      const interval = journal.find((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )
      if (!interval || typeof interval.intervalId !== 'string') throw new Error('valid live proof did not open an interval')
      expect(journal.find((entry) =>
        entry.kind === 'interval-close' && entry.intervalId === interval.intervalId
      )).toMatchObject({ reason: 'contact-lost', checkpointAtMs: 1_500 })
      expect(budgetUsage(journal, nowMs).activeMs).toBe(500)
      expect(currentAttempt(journal)).toMatchObject({ state: 'running', dispatchId: 'dispatch-identity' })
      expect(currentAttempt(journal)?.effect).toBeUndefined()
      expect(runner.status()).toMatchObject({ state: 'held', reason: 'worker-contact-unverifiable' })
      expect(releases).toBe(0)
    } finally {
      await runner.shutdown(0)
    }
  })

  test('the service adapter rejects live evidence without a complete identity before billing', async () => {
    const stored = storage()
    let nowMs = 1_000
    let runShows = 0
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const fingerprint = 'fingerprint-adapter-live-identity'
    const requestId = orchestrationRequestIdForAttemptFingerprint(fingerprint)
    const current = enrollment({ orchestrationRunId: 'run-adapter-identity' })
    stored.store.save(current)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt-adapter-live-identity',
      attemptId: 'attempt-adapter-live-identity',
      fingerprint,
      action,
      state: 'running',
      requestId,
      workerRequest,
      dispatchId: 'dispatch-adapter-identity',
      generation: 'initial:watcher-1'
    })
    const context = {
      ...stored.context,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'quirky.orchestration/serviceWorkerStart') {
          return {
            runId: 'run-adapter-identity',
            dispatchId: 'dispatch-adapter-identity',
            state: 'ready',
            mutation: { requestId: params.requestId, replayed: true }
          }
        }
        if (method === 'quirky.orchestration/serviceCheck') {
          return {
            mode: 'consume',
            runId: 'run-adapter-identity',
            messages: [],
            questions: [],
            count: 0,
            acknowledged: null,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            deliveryId: null,
            replayed: false,
            mutation: { requestId: params.requestId, replayed: false }
          }
        }
        if (method === 'quirky.orchestration/serviceRunShow') {
          runShows += 1
          return {
            run: { id: 'run-adapter-identity' },
            workers: [{
              dispatchId: 'dispatch-adapter-identity',
              sessionId: null,
              processIncarnation: 'process-fixture',
              state: 'live',
              assignmentActive: true,
              lastContactAtMs: nowMs
            }],
            questions: []
          }
        }
        throw new Error(`unexpected method ${method}`)
      },
      subscribe: () => () => {},
      log: () => {}
    } as unknown as PluginContext
    const adapter = createOrchestrationAdapter(context, stored.store, () => {})
    const watcherKind = kind({
      decide: () => ({ action: null, reason: 'waiting' }),
      pace: () => 'stopped'
    })
    const runner = createRunner({
      context,
      store: stored.store,
      registry: registry(watcherKind),
      orchestration: adapter,
      enrollment: current,
      now: () => nowMs
    })
    try {
      await runner.pulse()
      const journal = stored.store.journal('watcher-1')
      expect(runShows).toBe(1)
      expect(journal.some((entry) => entry.kind === 'interval-open' && entry.cause === 'worker-dispatched')).toBe(false)
      expect(budgetUsage(journal, nowMs).activeMs).toBe(0)
      expect(currentAttempt(journal)).toMatchObject({ state: 'running', dispatchId: 'dispatch-adapter-identity' })
      expect(currentAttempt(journal)?.effect).toBeUndefined()
      expect(runner.status().state).toBe('held')
      expect(runner.status().reason).toBe('tick-error')
      expect(runner.status().detail?.includes('complete process identity')).toBe(true)
    } finally {
      await runner.shutdown(0)
      adapter.dispose()
    }
  })

  test('unknown worker replies replay the stable request before pending mailbox messages are acknowledged', async () => {
    const stored = storage()
    const fingerprint = 'fingerprint-replayed-worker'
    const requestId = orchestrationRequestIdForAttemptFingerprint(fingerprint)
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const messages: WorkerMessage[] = [
      {
        id: 'status-before-recovery',
        type: 'status',
        body: 'Worker status'
      },
      {
        id: 'done-before-recovery',
        type: 'worker_done',
        dispatchId: 'dispatch-recovered',
        body: 'completed',
        outcome: 'succeeded'
      },
      {
        id: 'question-before-recovery',
        type: 'question',
        dispatchId: 'dispatch-recovered',
        body: 'Need approval?'
      },
      {
        id: 'escalation-before-recovery',
        type: 'escalation',
        dispatchId: 'dispatch-recovered',
        body: 'Worker needs help.'
      }
    ]
    let recoveryReady = false
    let releases = 0
    const calls: string[] = []
    const acknowledged: string[] = []
    const acknowledgeBatches: string[][] = []
    const port = orchestration({
      recover: async (_enrollment, attempt) => {
        calls.push('recover')
        expect(attempt.requestId).toBe(requestId)
        expect(attempt.dispatchId).toBeUndefined()
        return recoveryReady
          ? { kind: 'dispatched', dispatchId: 'dispatch-recovered' }
          : { kind: 'indeterminate', requestId, detail: 'worker start is still unknown' }
      },
      mailbox: async () => {
        calls.push('mailbox')
        return messages
      },
      acknowledge: async (_enrollment, handled) => {
        calls.push('acknowledge')
        const ids = handled.map((message) => message.id)
        acknowledgeBatches.push(ids)
        if (ids.length === messages.length) acknowledged.push(...ids)
      },
      release: async () => {
        calls.push('release')
        releases += 1
      }
    })
    const options = runnerOptions(stored, kind({
      decide: () => ({ action: null, reason: 'waiting' }),
      pace: () => 'stopped'
    }), { orchestration: port })
    const current = { ...options.enrollment, orchestrationRunId: 'run-replay' }
    stored.store.save(current)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt-before-ready-receipt',
      attemptId: 'attempt-before-ready-receipt',
      fingerprint,
      action,
      state: 'settled',
      effect: 'indeterminate',
      reason: 'worker start reply was lost',
      requestId,
      workerRequest,
      generation: 'initial:watcher-1'
    })
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      expect(acknowledged).toEqual([])
      expect(acknowledgeBatches).toEqual([['status-before-recovery']])
      expect(releases).toBe(0)
      expect(calls).toEqual(['recover', 'mailbox', 'acknowledge'])
      expect(currentAttempt(stored.store.journal('watcher-1'))).toMatchObject({
        state: 'settled',
        effect: 'indeterminate',
        requestId
      })

      recoveryReady = true
      await runner.pulse()

      expect(calls).toEqual([
        'recover', 'mailbox', 'acknowledge',
        'recover', 'mailbox', 'release', 'acknowledge'
      ])
      expect(acknowledgeBatches[1]).toEqual(messages.map((message) => message.id))
      expect(acknowledged).toEqual(messages.map((message) => message.id))
      expect(currentAttempt(stored.store.journal('watcher-1'))).toMatchObject({
        state: 'settled',
        effect: 'landed',
        dispatchId: 'dispatch-recovered',
        requestId
      })
      expect(stored.store.get('watcher-1')).toMatchObject({ enabled: false, parkReason: 'worker-escalation' })
    } finally {
      await runner.shutdown(0)
    }
  })
  test('a live worker observation reopens billing in the current budget generation', async () => {
    const stored = storage()
    let nowMs = 1_000
    let recoveries = 0
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      recover: async () => {
        recoveries += 1
        return { kind: 'dispatched', dispatchId: 'dispatch-generation' }
      },
      observeWorkers: async () => [{
        dispatchId: 'dispatch-generation',
        sessionId: 'session-generation',
        processIncarnation: 'process-generation',
        state: 'live',
        assignmentActive: true,
        lastContactAtMs: nowMs
      }]
    })
    const options = runnerOptions(stored, kind(), { orchestration: port, now: () => nowMs })
    const current = { ...options.enrollment, orchestrationRunId: 'run_generation' }
    stored.store.save(current)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt-generation-worker',
      attemptId: 'attempt-generation-worker',
      fingerprint: 'fingerprint-generation-worker',
      action,
      state: 'running',
      requestId: 'request-generation-worker',
      workerRequest,
      generation: 'initial:watcher-1'
    })
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      expect(recoveries).toBe(1)
      const initialIntervals = stored.store.journal('watcher-1').filter((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )
      expect(initialIntervals).toHaveLength(1)
      expect(initialIntervals[0]?.generation).toBe('initial:watcher-1')
      expect(initialIntervals[0]?.atMs).toBe(1_000)

      stored.store.append('watcher-1', {
        kind: 'evidence',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: 'generation-after-worker-start',
        evidenceKind: 'budget-generation',
        generation: 'generation-after-worker-start'
      })
      nowMs = 2_000
      await runner.pulse()

      const journal = stored.store.journal('watcher-1')
      const oldInterval = journal.find((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched' &&
        entry.generation === 'initial:watcher-1'
      )
      if (!oldInterval || typeof oldInterval.intervalId !== 'string') throw new Error('old generation interval was not opened')
      expect(journal.find((entry) =>
        entry.kind === 'interval-close' && entry.intervalId === oldInterval.intervalId
      )).toMatchObject({ reason: 'generation-reset', checkpointAtMs: 1_000 })
      const currentIntervals = journal.filter((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched' &&
        entry.generation === 'generation-after-worker-start'
      )
      expect(currentIntervals).toHaveLength(1)
      expect(currentIntervals[0]?.atMs).toBe(2_000)
      const turns = journal.filter((entry) => entry.kind === 'turn')
      expect(turns).toHaveLength(1)
      expect(turns[0]?.dispatchId).toBe('dispatch-generation')
      expect(turns[0]?.generation).toBe('initial:watcher-1')
      expect(budgetUsage(journal, nowMs).activeMs).toBe(0)
      expect(budgetUsage(journal, nowMs).turns).toBe(0)

      nowMs = 3_000
      await runner.pulse()
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs)).toMatchObject({ activeMs: 1_000, turns: 0 })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('an explicit coordinator fence parks without resolving or repeating an action', async () => {
    const stored = storage()
    let executions = 0
    let dispatches = 0
    let releases = 0
    const fence = Object.assign(
      new Error('consumer_fenced: service caller does not own the requested Run'),
      { data: { reason: 'consumer_fenced', runId: 'run_owner' } }
    )
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      dispatch: async () => { dispatches += 1; throw fence },
      release: async () => { releases += 1 }
    })
    const watcherKind = kind({
      decide: () => ({ action }),
      execute: async (_action, context) => {
        executions += 1
        const result = await context.dispatchWorker(workerRequest)
        expect(result).toMatchObject({ kind: 'indeterminate', reason: 'coordinator-seat-lost' })
        return { effect: 'not-landed', reason: 'the caller must not settle a fenced request' }
      }
    })
    const options = runnerOptions(stored, watcherKind, { orchestration: port })
    const current = { ...options.enrollment, orchestrationRunId: 'run_owner' }
    stored.store.save(current)
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      await runner.pulse()
      const journal = stored.store.journal('watcher-1')
      const parked = stored.store.get('watcher-1')
      expect(parked?.enabled).toBe(false)
      expect(parked?.parkReason).toBe('coordinator-seat-lost')
      expect(parked?.haltReason?.startsWith('consumer_fenced:')).toBe(true)
      expect(runner.status().state).toBe('parked')
      expect(runner.status().reason).toBe('coordinator-seat-lost')
      expect(journal.some((entry) =>
        entry.kind === 'escalation' && entry.escalationId === 'park-coordinator-seat-lost' &&
        entry.reason === 'coordinator-seat-lost'
      )).toBe(true)
      expect(currentAttempt(journal)).toMatchObject({ state: 'settled', effect: 'indeterminate' })
      expect(currentAttempt(journal)?.effect).not.toBe('not-landed')
      expect(journal.some((entry) => entry.kind === 'attempt-resolved')).toBe(false)
      expect(executions).toBe(1)
      expect(dispatches).toBe(1)
      expect(releases).toBe(0)
    } finally {
      await runner.shutdown(0)
    }
  })

  test('a recovery fence persists an indeterminate attempt and coordinator park', async () => {
    const stored = storage()
    let recoveries = 0
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      recover: async () => {
        recoveries += 1
        return {
          kind: 'indeterminate',
          requestId: 'request-recovery',
          reason: 'coordinator-seat-lost',
          detail: 'consumer_fenced: service caller does not own the requested Run'
        }
      }
    })
    const options = runnerOptions(stored, kind(), { orchestration: port })
    const current = { ...options.enrollment, orchestrationRunId: 'run_owner' }
    stored.store.save(current)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt-before-recovery-fence',
      attemptId: 'attempt-recovery-fence',
      fingerprint: 'fingerprint-recovery-fence',
      action,
      state: 'running',
      requestId: 'request-recovery',
      workerRequest
    })
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      const journal = stored.store.journal('watcher-1')
      expect(recoveries).toBe(1)
      expect(stored.store.get('watcher-1')).toMatchObject({
        enabled: false,
        parkReason: 'coordinator-seat-lost'
      })
      expect(currentAttempt(journal)).toMatchObject({ state: 'settled', effect: 'indeterminate', resolved: false })
      expect(journal.some((entry) => entry.kind === 'attempt-resolved')).toBe(false)
    } finally {
      await runner.shutdown(0)
    }
  })

  test('an observation fence closes work at its checkpoint and keeps the attempt unresolved', async () => {
    const stored = storage()
    let nowMs = 1_000
    let observations = 0
    let fenceObservation = false
    let releases = 0
    const fence = Object.assign(new Error('owner denied this request'), {
      data: { reason: 'consumer_fenced', runId: 'run_owner' }
    })
    const workerRequest: WorkerRequest = { spec: 'worker task', worktree: '/workspace' }
    const port = orchestration({
      observeWorkers: async () => {
        observations += 1
        if (fenceObservation) throw fence
        return [{
          dispatchId: 'dispatch-observation',
          sessionId: 'session-observation',
          processIncarnation: 'process-observation',
          state: 'live',
          assignmentActive: true,
          lastContactAtMs: nowMs
        }]
      },
      release: async () => { releases += 1 }
    })
    const options = runnerOptions(stored, kind(), { orchestration: port, now: () => nowMs })
    const current = { ...options.enrollment, orchestrationRunId: 'run_owner' }
    stored.store.save(current)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'attempt-before-observation-fence',
      attemptId: 'attempt-observation-fence',
      fingerprint: 'fingerprint-observation-fence',
      action,
      state: 'running',
      requestId: 'request-observation',
      workerRequest,
      dispatchId: 'dispatch-observation'
    })
    const runner = createRunner({ ...options, enrollment: current })
    try {
      await runner.pulse()
      nowMs = 2_000
      await runner.pulse()
      fenceObservation = true
      nowMs = 9_000
      await runner.pulse()
      const journal = stored.store.journal('watcher-1')
      expect(observations).toBe(3)
      expect(stored.store.get('watcher-1')).toMatchObject({
        enabled: false,
        parkReason: 'coordinator-seat-lost'
      })
      const workerInterval = journal.find((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched'
      )
      if (!workerInterval || typeof workerInterval.intervalId !== 'string') throw new Error('live worker interval was not opened')
      expect(journal.find((entry) =>
        entry.kind === 'interval-close' && entry.intervalId === workerInterval.intervalId
      )).toMatchObject({ reason: 'contact-lost', checkpointAtMs: 2_000 })
      expect(budgetUsage(journal, nowMs).activeMs).toBe(1_000)
      expect(currentAttempt(journal)).toMatchObject({ state: 'settled', effect: 'indeterminate', resolved: false })
      expect(journal.some((entry) => entry.kind === 'attempt-resolved')).toBe(false)
      expect(releases).toBe(0)
    } finally {
      await runner.shutdown(0)
    }
  })


  test('restart resolves uncertainty from a live snapshot and never blindly replays an external attempt', async () => {
    const stored = storage()
    let executions = 0
    const firstKind = kind({
      decide: () => ({ action }),
      execute: async () => { executions += 1; throw new Error('reply lost') }
    })
    const first = createRunner(runnerOptions(stored, firstKind))
    await first.pulse()
    await first.shutdown(0)

    stored.restart()
    let resolutions = 0
    const secondKind = kind({
      decide: () => ({ action }),
      resolveOutcome: async (_attempt, snapshot) => {
        expect(snapshot.freshness).toBe('live')
        resolutions += 1
        return null
      }
    })
    const second = createRunner({ ...runnerOptions(stored, secondKind), enrollment: enrollment() })
    try {
      await second.pulse()
      expect(resolutions).toBe(1)
      expect(executions).toBe(1)
      expect(currentAttempt(stored.store.journal('watcher-1'))?.effect).toBe('indeterminate')
    } finally {
      await second.shutdown(0)
    }
  })
  test('action loop stops after 32 successful actions in one tick', async () => {
    const stored = storage()
    let actions = 0
    let executions = 0
    const watcherKind = kind({
      decide: () => ({ action: { ...action, evidenceKey: `evidence-${actions++}` } }),
      execute: async () => { executions += 1; return { effect: 'landed' } }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    try {
      await runner.pulse()
      expect(executions).toBe(32)
      expect(stored.store.traces('watcher-1').at(-1)?.decision).toMatchObject({ reason: 'action-limit' })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('retention does not erase already consumed active-work budget', async () => {
    const stored = storage()
    let nowMs = 1_000
    let evidence = 0
    const watcherKind = kind({
      decide: () => ({ action:{ ...action,evidenceKey:`budget-${evidence++}` } }),
      execute: async () => { nowMs += 10; return { effect:'landed' } }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind, { now:() => nowMs }))
    try {
      await runner.pulse()
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(320)
      stored.store.retain('watcher-1')
      expect(budgetUsage(stored.store.journal('watcher-1'), nowMs).activeMs).toBe(320)
    } finally {
      await runner.shutdown(0)
    }
  })


  test('zero budget parks on the first tick without executing an action', async () => {
    const stored = storage()
    let executions = 0
    const watcherKind = kind({
      decide: () => ({ action }),
      execute: async () => { executions += 1; return { effect: 'landed' } }
    })
    const options = runnerOptions(stored, watcherKind, {
      enrollment: enrollment({ budget: { wallClockActiveMs: 0, turns: null } })
    })
    stored.store.save(options.enrollment)
    const runner = createRunner(options)
    try {
      await runner.pulse()
      expect(executions).toBe(0)
      expect(stored.store.get('watcher-1')).toMatchObject({ enabled: false, parkReason: 'budget' })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('positive question answer proof resumes a parked worker question', async () => {
    const stored = storage()
    const messageId = 'question-1'
    const options = runnerOptions(stored, kind())
    stored.store.save({ ...options.enrollment, orchestrationRunId: 'run-question' })
    stored.store.append('watcher-1', {
      kind: 'attempt', class: 'fact', origin: 'owner', resolved: false,
      attemptId: 'question-attempt', fingerprint: actionFingerprint(action), action,
      state: 'running', dispatchId: 'dispatch-question', generation: 'initial:watcher-1'
    })
    seedWorkerPark(stored, 'worker-question', messageId)
    const runner = createRunner({
      ...options,
      enrollment: stored.store.get('watcher-1') ?? options.enrollment,
      orchestration: orchestration({
        mailbox: async () => [{ id: messageId, type: 'question', dispatchId: 'dispatch-question', body: 'answered', resolved: true }],
        observeWorkers: async () => [{
          dispatchId: 'dispatch-question', sessionId: 'question-worker', processIncarnation: 'question-process',
          state: 'live', assignmentActive: true, lastContactAtMs: 1_000
        }]
      })
    })
    try {
      await runner.pulse()
      expect(stored.store.get('watcher-1')).toMatchObject({ enabled: true, parkReason: null })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('worker escalation resumes only after a local resolved or acknowledged journal revision', async () => {
    const stored = storage()
    const messageId = 'escalation-1'
    const sourceEscalationId = `worker-escalation:${messageId}`
    const options = runnerOptions(stored, kind())
    seedWorkerPark(stored, 'worker-escalation', messageId)
    const runner = createRunner({
      ...options,
      enrollment: stored.store.get('watcher-1') ?? options.enrollment,
      orchestration: orchestration({
        mailbox: async () => [{ id: messageId, type: 'escalation', body: 'unverified resolution', resolved: true }]
      })
    })
    try {
      await runner.pulse()
      expect(stored.store.get('watcher-1')).toMatchObject({ enabled: false, parkReason: 'worker-escalation' })
      stored.store.append('watcher-1', {
        kind: 'escalation',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: 'local-escalation-answer',
        escalationId: sourceEscalationId,
        escalationKind: 'worker-escalation',
        status: 'acknowledged',
        foldCount: 1,
        messageId
      })
      await runner.pulse()
      expect(stored.store.get('watcher-1')).toMatchObject({ enabled: true, parkReason: null })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('terminal stop is deferred while an external attempt is unresolved', async () => {
    const stored = storage()
    let resolved = false
    const watcherKind = kind({
      decide: () => ({ action }),
      stop: () => ({ kind: 'terminal', state: 'complete', reason: 'target reached' }),
      resolveOutcome: async () => resolved ? { effect:'landed' } : null
    })
    const options = runnerOptions(stored, watcherKind)
    stored.store.append('watcher-1', {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'pending-attempt',
      atMs: 500,
      attemptId: 'pending-attempt',
      fingerprint: actionFingerprint(action),
      action,
      state: 'settled',
      effect: 'indeterminate',
      reason: 'lost reply',
      generation: 'initial:watcher-1'
    })
    const runner = createRunner(options)
    try {
      await runner.pulse()
      expect(stored.store.get('watcher-1')?.terminalAtMs).toBeNull()
      expect(stored.store.journal('watcher-1').some((entry) => entry.kind === 'terminal')).toBe(false)
      expect(currentAttempt(stored.store.journal('watcher-1'))?.effect).toBe('indeterminate')
      resolved = true
      await runner.pulse()
      expect(stored.store.get('watcher-1')?.terminalAtMs).toBe(1_000)
      expect(stored.store.summary('watcher-1')).toMatchObject({ state:'complete' })
    } finally {
      await runner.shutdown(0)
    }
  })

  test('concurrent pulses coalesce into one follow-up serialized tick and all callers await it', async () => {
    const stored = storage()
    let reads = 0
    let activeReads = 0
    let maxActiveReads = 0
    const readGate = Promise.withResolvers<void>()
    const blocked = readGate.promise
    const watcherKind = kind({
      read: async () => {
        reads += 1
        activeReads += 1
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        if (reads === 1) await blocked
        activeReads -= 1
        return { freshness: 'live', contentIdentity: 'tree-1', observedAtMs: reads, world: { revision: 'tree-1' } }
      }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    const first = runner.pulse()
    const second = runner.pulse()
    const third = runner.pulse()
    readGate.resolve()
    try {
      await Promise.all([first, second, third])
      expect(reads).toBe(2)
      expect(maxActiveReads).toBe(1)
    } finally {
      await runner.shutdown(0)
    }
  })
  test('control fences a proposal from a tick it drains before committing its mutation', async () => {
    const stored = storage()
    const readStarted = Promise.withResolvers<void>()
    const readGate = Promise.withResolvers<void>()
    const watcherKind = kind({
      read: async () => {
        readStarted.resolve()
        await readGate.promise
        return { freshness: 'live', contentIdentity: 'tree-1', observedAtMs: 0, world: { revision: 'tree-1' } }
      },
      decide: () => ({ action }),
      execute: async () => { throw new Error('control must fence this proposal') }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    const pulse = runner.pulse()
    await readStarted.promise
    const control = runner.withControl(async () => {
      const latest = stored.store.get('watcher-1')
      if (latest) stored.store.save({ ...latest, enabled: false, commandRevision: latest.commandRevision + 1 })
    }, true)
    readGate.resolve()
    try {
      await control
      await pulse
      expect(stored.store.journal('watcher-1').some((entry) => entry.kind === 'attempt')).toBe(false)
      expect(stored.store.get('watcher-1')?.enabled).toBe(false)
    } finally {
      await runner.shutdown(0)
    }
  })


  test('non-draining control fences a blocked decision before mutating enrollment', async () => {
    const stored = storage()
    const decideStarted = Promise.withResolvers<void>()
    const decisionReady = Promise.withResolvers<void>()
    const watcherKind = kind({
      decide: async () => {
        decideStarted.resolve()
        await decisionReady.promise
        return { action }
      },
      execute: async () => { throw new Error('non-draining control must fence this decision') }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    const pulse = runner.pulse()
    await decideStarted.promise
    try {
      await runner.withControl(async () => {
        const latest = stored.store.get('watcher-1')
        if (latest) stored.store.save({ ...latest, enabled: false, commandRevision: latest.commandRevision + 1 })
      }, false)
      decisionReady.resolve()
      await pulse
      expect(stored.store.journal('watcher-1').some((entry) => entry.kind === 'attempt')).toBe(false)
      expect(stored.store.get('watcher-1')?.enabled).toBe(false)
    } finally {
      decisionReady.resolve()
      await runner.shutdown(0)
    }
  })

  test('suspend fences an in-flight decision from committing or executing', async () => {
    const stored = storage()
    let decide!: (snapshot: Snapshot<World>) => Decision
    const decisionReady = Promise.withResolvers<void>()
    const decideStarted = Promise.withResolvers<void>()
    const watcherKind = kind({
      decide: async (snapshot) => {
        decideStarted.resolve()
        await decisionReady.promise
        return decide(snapshot)
      },
      execute: async () => { throw new Error('must not execute after suspend') }
    })
    decide = () => ({ action })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    const pulse = runner.pulse()
    await decideStarted.promise
    runner.suspend()
    decisionReady.resolve()
    try {
      await pulse
      expect(stored.store.journal('watcher-1').some((entry) => entry.kind === 'attempt')).toBe(false)
    } finally {
      await runner.shutdown(0)
    }
  })
  test('wake forces a live reconciliation after suspend', async () => {
    const stored = storage()
    const readStarted = Promise.withResolvers<void>()
    const freshness: boolean[] = []
    const watcherKind = kind({
      read: async (_enrollment, options) => {
        freshness.push(options.fresh)
        readStarted.resolve()
        return { freshness: 'live', contentIdentity: 'tree-1', observedAtMs: 0, world: { revision: 'tree-1' } }
      }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    try {
      runner.suspend()
      await runner.pulse()
      expect(freshness).toEqual([])
      runner.resume()
      await readStarted.promise
      await runner.pulse()
      expect(freshness[0]).toBe(true)
    } finally {
      await runner.shutdown(0)
    }
  })


  test('shutdown returns by its deadline and fences late executor completion from writing', async () => {
    const stored = storage()
    const executorGate = Promise.withResolvers<void>()
    const watcherKind = kind({
      decide: () => ({ action }),
      execute: async () => { await executorGate.promise; return { effect: 'landed' } }
    })
    const runner = createRunner(runnerOptions(stored, watcherKind))
    const pulse = runner.pulse()
    while (!stored.store.journal('watcher-1').some((entry) => entry.kind === 'attempt')) await Promise.resolve()
    await runner.shutdown(0)
    const journalLength = stored.store.journal('watcher-1').length
    executorGate.resolve()
    await pulse
    await Promise.resolve()
    expect(stored.store.journal('watcher-1')).toHaveLength(journalLength)
    expect(currentAttempt(stored.store.journal('watcher-1'))?.state).toBe('attempted')
  })
})
