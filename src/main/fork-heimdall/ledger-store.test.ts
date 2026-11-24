import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { getLatestAttempts, getUnresolvedAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { createTickTrace } from '../../shared/fork-heimdall/tick-trace'
import Database from '../sqlite/sync-database'
import { HEIMDALL_DATABASE_SCHEMA_VERSION, HeimdallDatabase } from './database'
import { HeimdallEnrollmentStore } from './enrollment-store'
import { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { HeimdallLedgerStore } from './ledger-store'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import { RETENTION_RING_CAPACITY } from './retention'

let root: string
let database: HeimdallDatabase
let ledger: HeimdallLedgerStore

function observation(index: number, watcherId = 'watcher-1'): LedgerEntry {
  return {
    kind: 'client-observation',
    eventId: `observation-${index}`,
    watcherId,
    atMs: index,
    origin: 'client',
    class: 'observation',
    what: `sample-${index}`
  }
}

function attempt(
  state: AttemptEntry['state'],
  attemptId = 'attempt-1',
  watcherId = 'watcher-1',
  effect?: AttemptEntry['effect']
): AttemptEntry {
  return {
    kind: 'attempt',
    eventId: `${attemptId}-event`,
    watcherId,
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    attemptId,
    fingerprint: `${attemptId}-fingerprint`,
    action: {
      kind: 'publish',
      capability: 'merge',
      visibility: 'external',
      contentIdentity: 'content-1',
      evidenceKey: 'evidence-1'
    },
    state,
    ...(effect === undefined ? {} : { effect })
  }
}

function unresolvedAttempt(attemptId = 'attempt-1', watcherId = 'watcher-1'): AttemptEntry {
  return attempt('settled', attemptId, watcherId, 'indeterminate')
}

function resolution(
  attemptId = 'attempt-1',
  eventId = 'resolution-1',
  effect: 'landed' | 'not-landed' = 'landed'
): LedgerEntry {
  return {
    kind: 'attempt-resolved',
    eventId,
    watcherId: 'watcher-1',
    atMs: 2,
    origin: 'owner',
    class: 'fact',
    attemptId,
    effect,
    evidence: { sha: 'abc' }
  }
}

function enrollment(watcherId = 'watcher-1'): WatcherEnrollment {
  return {
    watcherId,
    kind: 'hosted-review',
    workspaceKey: 'local::/worktree',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/worktree',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { merge: 'gated' },
    budget: { wallClockActiveMs: 60_000, turns: 2 },
    kindPayload: { pullRequest: 1 },
    coordinatorIdentity: { handle: 'heimdall-1', paneKey: 'heimdall-pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-heimdall-ledger-'))
  database = new HeimdallDatabase(root)
  ledger = new HeimdallLedgerStore(database)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('Heimdall ledger store', () => {
  it('only appends durable entries and never exposes stored rows for mutation', () => {
    ledger.append(observation(1))
    ledger.append(observation(2))

    const snapshot = ledger.read('watcher-1')
    snapshot.entries[0].eventId = 'mutated'

    expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual([
      'observation-1',
      'observation-2'
    ])
    expect(() => ledger.append(observation(1))).toThrow()
  })

  it("restricts origin 'client' to client-observation entries", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately invalid LedgerEntry (attempt entry with origin 'client') to exercise the append-time rejection.
    const forged = { ...unresolvedAttempt(), origin: 'client' } as unknown as LedgerEntry

    expect(() => ledger.append(forged)).toThrow()
    expect(ledger.read('watcher-1').entries).toEqual([])
  })

  it('rejects a second resolution for the same attempt', () => {
    ledger.append(unresolvedAttempt())
    ledger.append({
      kind: 'attempt-resolved',
      eventId: 'resolution-1',
      watcherId: 'watcher-1',
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      attemptId: 'attempt-1',
      effect: 'landed',
      evidence: { sha: 'abc' }
    })

    expect(() =>
      ledger.append({
        kind: 'attempt-resolved',
        eventId: 'resolution-2',
        watcherId: 'watcher-1',
        atMs: 3,
        origin: 'owner',
        class: 'fact',
        attemptId: 'attempt-1',
        effect: 'not-landed',
        evidence: { sha: 'def' }
      })
    ).toThrow('already resolved')
  })

  it('rejects phantom and non-indeterminate attempt resolutions without appending them', () => {
    expect(() => ledger.append(resolution('missing-attempt'))).toThrow('Unknown Heimdall attempt')

    const running = attempt('running')
    ledger.append(running)
    expect(() => ledger.append(resolution())).toThrow('not a settled indeterminate attempt')

    ledger.append({
      ...attempt('settled', 'landed-attempt', 'watcher-1', 'landed'),
      eventId: 'landed-attempt-event'
    })
    expect(() => ledger.append(resolution('landed-attempt', 'landed-attempt-resolution'))).toThrow(
      'not a settled indeterminate attempt'
    )

    expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual([
      running.eventId,
      'landed-attempt-event'
    ])
  })

  it('keeps an attempt identity immutable and rejects transitions after settlement', () => {
    const attempted = attempt('attempted')
    ledger.append(attempted)

    expect(() =>
      ledger.append({
        ...attempted,
        eventId: 'changed-fingerprint',
        fingerprint: 'different-fingerprint'
      })
    ).toThrow('immutable identity')
    expect(() =>
      ledger.append({
        ...attempted,
        eventId: 'changed-content-identity',
        action: { ...attempted.action, contentIdentity: 'content-2' }
      })
    ).toThrow('immutable identity')

    const running: AttemptEntry = {
      ...attempted,
      eventId: 'attempt-running',
      atMs: 2,
      state: 'running'
    }
    ledger.append(running)
    expect(() =>
      ledger.append({ ...running, eventId: 'attempt-regressed', state: 'attempted' })
    ).toThrow('cannot move backward')

    const settled: AttemptEntry = {
      ...running,
      eventId: 'attempt-settled',
      atMs: 3,
      state: 'settled',
      effect: 'indeterminate'
    }
    ledger.append(settled)
    expect(() =>
      ledger.append({ ...settled, eventId: 'attempt-after-settlement', atMs: 4 })
    ).toThrow('already settled')

    expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual([
      attempted.eventId,
      running.eventId,
      settled.eventId
    ])
  })

  it('does not reopen a resolved attempt id and pins a legitimate new attempt id', () => {
    ledger.append(unresolvedAttempt())
    ledger.append(resolution())

    expect(() =>
      ledger.append({
        ...unresolvedAttempt(),
        eventId: 'reopened-attempt',
        atMs: 3
      })
    ).toThrow('already resolved')

    ledger.append(unresolvedAttempt('attempt-2'))
    expect(getUnresolvedAttempts(ledger.read('watcher-1')).map((entry) => entry.attemptId)).toEqual(
      ['attempt-2']
    )
  })

  it('pins an unresolved attempt while reclaiming the observation ring', () => {
    ledger.append(unresolvedAttempt())
    for (let index = 1; index <= RETENTION_RING_CAPACITY + 1; index += 1) {
      ledger.append(observation(index))
    }

    ledger.reclaim('watcher-1')

    const retained = ledger.read('watcher-1').entries
    expect(
      retained.some((entry) => entry.kind === 'attempt' && entry.attemptId === 'attempt-1')
    ).toBe(true)
    expect(retained.filter((entry) => entry.class === 'observation')).toHaveLength(
      RETENTION_RING_CAPACITY
    )
    expect(retained.some((entry) => entry.eventId === 'observation-1')).toBe(false)
  })

  it('never reclaims fact-class entries while the watcher is enrolled', () => {
    new HeimdallEnrollmentStore(database).insert(enrollment())
    for (let index = 1; index <= RETENTION_RING_CAPACITY + 10; index += 1) {
      ledger.append({
        kind: 'evidence',
        eventId: `fact-${index}`,
        watcherId: 'watcher-1',
        atMs: index,
        origin: 'owner',
        class: 'fact',
        evidenceKind: 'fixture',
        payload: { index }
      })
      ledger.append(observation(index))
    }

    ledger.reclaim('watcher-1')

    expect(ledger.read('watcher-1').entries.filter((entry) => entry.class === 'fact')).toHaveLength(
      RETENTION_RING_CAPACITY + 10
    )
  })

  it('rolls back an observation pin release when reclaim fails', () => {
    for (let index = 1; index <= RETENTION_RING_CAPACITY + 1; index += 1) {
      ledger.append(observation(index), { resolved: false })
    }
    database.connection().exec(`
      CREATE TRIGGER fail_observation_reclaim
      BEFORE DELETE ON heimdall_ledger
      BEGIN
        SELECT RAISE(ABORT, 'forced observation reclaim failure');
      END
    `)

    expect(() => ledger.releaseRetentionPin('observation-1')).toThrow(
      'forced observation reclaim failure'
    )
    database.connection().exec('DROP TRIGGER fail_observation_reclaim')

    expect(() => ledger.releaseRetentionPin('observation-1')).not.toThrow()
    expect(
      ledger.read('watcher-1').entries.some((entry) => entry.eventId === 'observation-1')
    ).toBe(false)
  })

  it('rolls back a trace pin release when reclaim fails', () => {
    for (let seq = 1; seq <= RETENTION_RING_CAPACITY + 1; seq += 1) {
      ledger.appendTickTrace('watcher-1', {
        ...createTickTrace(seq, seq, {
          consecutiveErrors: 0,
          lastFullResyncAtMs: null,
          reconcileAgain: false
        }),
        pinned: true
      })
    }
    database.connection().exec(`
      CREATE TRIGGER fail_trace_reclaim
      BEFORE DELETE ON heimdall_tick_trace
      BEGIN
        SELECT RAISE(ABORT, 'forced trace reclaim failure');
      END
    `)

    expect(() => ledger.releaseTickTracePin('watcher-1', 1)).toThrow('forced trace reclaim failure')
    expect(ledger.readTickTraces('watcher-1')[0]).toMatchObject({ seq: 1, pinned: true })
    database.connection().exec('DROP TRIGGER fail_trace_reclaim')

    expect(() => ledger.releaseTickTracePin('watcher-1', 1)).not.toThrow()
    expect(ledger.readTickTraces('watcher-1').some((trace) => trace.seq === 1)).toBe(false)
  })

  it('serializes interval transitions across stale store instances', () => {
    const secondDatabase = new HeimdallDatabase(root)
    const staleLedger = new HeimdallLedgerStore(secondDatabase)
    try {
      ledger.append({
        kind: 'interval-open',
        eventId: 'interval-open-1',
        watcherId: 'watcher-1',
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        intervalId: 'interval-1',
        cause: 'action-in-flight'
      })
      expect(() =>
        staleLedger.append({
          kind: 'interval-open',
          eventId: 'interval-open-2',
          watcherId: 'watcher-1',
          atMs: 11,
          origin: 'owner',
          class: 'fact',
          intervalId: 'interval-2',
          cause: 'worker-dispatched'
        })
      ).toThrow('already has an open interval')

      expect(() =>
        staleLedger.append({
          kind: 'interval-checkpoint',
          eventId: 'wrong-interval-checkpoint',
          watcherId: 'watcher-1',
          atMs: 15,
          origin: 'owner',
          class: 'fact',
          intervalId: 'interval-2'
        })
      ).toThrow('is not open')
      expect(() =>
        staleLedger.append({
          kind: 'interval-close',
          eventId: 'wrong-interval-close',
          watcherId: 'watcher-1',
          atMs: 15,
          origin: 'owner',
          class: 'fact',
          intervalId: 'interval-2',
          closeReason: 'settled'
        })
      ).toThrow('is not open')

      staleLedger.append({
        kind: 'interval-checkpoint',
        eventId: 'interval-checkpoint-1',
        watcherId: 'watcher-1',
        atMs: 20,
        origin: 'owner',
        class: 'fact',
        intervalId: 'interval-1'
      })
      ledger.append({
        kind: 'interval-close',
        eventId: 'interval-close-1',
        watcherId: 'watcher-1',
        atMs: 30,
        origin: 'owner',
        class: 'fact',
        intervalId: 'interval-1',
        closeReason: 'settled'
      })

      expect(() =>
        staleLedger.append({
          kind: 'interval-checkpoint',
          eventId: 'stale-checkpoint',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          intervalId: 'interval-1'
        })
      ).toThrow('is not open')
      expect(() =>
        staleLedger.append({
          kind: 'interval-close',
          eventId: 'stale-close',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          intervalId: 'interval-1',
          closeReason: 'shutdown'
        })
      ).toThrow('is not open')
      expect(() =>
        staleLedger.append({
          kind: 'interval-open',
          eventId: 'reused-interval',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          intervalId: 'interval-1',
          cause: 'action-in-flight'
        })
      ).toThrow('already exists')

      expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual([
        'interval-open-1',
        'interval-checkpoint-1',
        'interval-close-1'
      ])
    } finally {
      secondDatabase.close()
    }
  })

  it('rejects a contact-loss close beyond the last durable checkpoint', () => {
    ledger.append({
      kind: 'interval-open',
      eventId: 'interval-open',
      watcherId: 'watcher-1',
      atMs: 10,
      origin: 'owner',
      class: 'fact',
      intervalId: 'interval-1',
      cause: 'action-in-flight'
    })
    ledger.append({
      kind: 'interval-checkpoint',
      eventId: 'interval-checkpoint',
      watcherId: 'watcher-1',
      atMs: 20,
      origin: 'owner',
      class: 'fact',
      intervalId: 'interval-1'
    })

    expect(() =>
      ledger.append({
        kind: 'interval-close',
        eventId: 'overcharged-contact-loss',
        watcherId: 'watcher-1',
        atMs: 30,
        origin: 'owner',
        class: 'fact',
        intervalId: 'interval-1',
        closeReason: 'contact-lost'
      })
    ).toThrow('must use its last checkpoint')
    expect(ledger.read('watcher-1').entries).toHaveLength(2)

    ledger.append({
      kind: 'interval-close',
      eventId: 'interval-close',
      watcherId: 'watcher-1',
      atMs: 20,
      origin: 'owner',
      class: 'fact',
      intervalId: 'interval-1',
      closeReason: 'contact-lost'
    })
  })

  it('compacts only a dismissed terminal watcher and preserves unresolved pins', () => {
    const enrollments = new HeimdallEnrollmentStore(database)
    enrollments.insert(enrollment())
    ledger.append(observation(1))
    ledger.append(observation(2), { resolved: false })
    ledger.append(unresolvedAttempt('resolved-attempt'))
    ledger.append(resolution('resolved-attempt', 'resolved-attempt-resolution'))
    ledger.append(unresolvedAttempt('pinned-attempt'))
    ledger.append({
      kind: 'evidence',
      eventId: 'durable-evidence',
      watcherId: 'watcher-1',
      atMs: 3,
      origin: 'owner',
      class: 'fact',
      evidenceKind: 'fixture',
      payload: { state: 'terminal' }
    })
    ledger.appendTickTrace('watcher-1', {
      ...createTickTrace(1, 1, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: null,
        reconcileAgain: false
      }),
      pinned: false
    })
    ledger.appendTickTrace('watcher-1', {
      ...createTickTrace(2, 2, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: null,
        reconcileAgain: false
      }),
      pinned: true
    })
    ledger.append({
      kind: 'terminal',
      eventId: 'terminal',
      watcherId: 'watcher-1',
      atMs: 4,
      origin: 'owner',
      class: 'fact',
      state: 'merged',
      reason: 'completed'
    })

    const beforeDismissal = ledger.read('watcher-1').entries.map((entry) => entry.eventId)
    expect(() =>
      ledger.compactTerminal('watcher-1', 'hosted-review', {
        activeMs: 0,
        turns: 2,
        exhausted: null
      })
    ).toThrow('has not been dismissed')
    expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual(beforeDismissal)

    enrollments.markTerminal('watcher-1', 4)
    expect(
      ledger.compactTerminal('watcher-1', 'hosted-review', {
        activeMs: 0,
        turns: 2,
        exhausted: null
      })
    ).toMatchObject({
      watcherId: 'watcher-1',
      terminalState: 'merged',
      reason: 'completed',
      totals: { activeMs: 0, turns: 2, exhausted: null }
    })
    expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual([
      'observation-2',
      'pinned-attempt-event',
      'terminal'
    ])
    expect(ledger.readTickTraces('watcher-1').map((trace) => trace.seq)).toEqual([2])

    ledger.releaseRetentionPin('observation-2')
    ledger.releaseTickTracePin('watcher-1', 2)
    expect(ledger.read('watcher-1').entries.map((entry) => entry.eventId)).toEqual([
      'pinned-attempt-event',
      'terminal'
    ])
    expect(ledger.readTickTraces('watcher-1')).toEqual([])
  })

  it('rechecks terminal compaction idempotency after acquiring the write lock', () => {
    const enrollments = new HeimdallEnrollmentStore(database)
    enrollments.insert(enrollment())
    ledger.append({
      kind: 'terminal',
      eventId: 'terminal',
      watcherId: 'watcher-1',
      atMs: 4,
      origin: 'owner',
      class: 'fact',
      state: 'merged',
      reason: 'completed'
    })
    enrollments.markTerminal('watcher-1', 4)

    const competingDatabase = new HeimdallDatabase(root)
    const competingLedger = new HeimdallLedgerStore(competingDatabase)
    competingDatabase.connection()
    const firstConnection = database.connection()
    const originalExec = Database.prototype.exec
    let raced = false
    const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (!raced && this === firstConnection && sql === 'BEGIN IMMEDIATE') {
        raced = true
        competingLedger.compactTerminal('watcher-1', 'hosted-review', {
          activeMs: 1,
          turns: 2,
          exhausted: null
        })
      }
      originalExec.call(this, sql)
    })
    try {
      expect(
        ledger.compactTerminal('watcher-1', 'hosted-review', {
          activeMs: 3,
          turns: 4,
          exhausted: null
        })
      ).toMatchObject({ totals: { activeMs: 1, turns: 2, exhausted: null } })
      expect(raced).toBe(true)
    } finally {
      exec.mockRestore()
      competingDatabase.close()
    }
  })

  it('allows one terminal entry per watcher', () => {
    ledger.append({
      kind: 'terminal',
      eventId: 'terminal-1',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      state: 'merged',
      reason: 'completed'
    })

    expect(() =>
      ledger.append({
        kind: 'terminal',
        eventId: 'terminal-2',
        watcherId: 'watcher-1',
        atMs: 2,
        origin: 'owner',
        class: 'fact',
        state: 'closed',
        reason: 'duplicate'
      })
    ).toThrow('already terminal')
  })

  it('opens a newer user_version read-only', () => {
    ledger.append(observation(1))
    database.connection().pragma(`user_version = ${HEIMDALL_DATABASE_SCHEMA_VERSION + 1}`)
    database.close()

    database = new HeimdallDatabase(root)
    ledger = new HeimdallLedgerStore(database)

    expect(database.isReadOnly()).toBe(true)
    expect(ledger.read('watcher-1').entries).toEqual([observation(1)])
    expect(() => ledger.append(observation(2))).toThrow()
  })
})

const dispatchAction = {
  kind: 'publish',
  capability: 'merge',
  visibility: 'external' as const,
  contentIdentity: 'content-1',
  evidenceKey: 'evidence-1'
}

function lifecycleFor(
  overrides: {
    dispatchWorker?: Mock<HeimdallOrchestrationAdapter['dispatchWorker']>
    recoverDispatch?: Mock<HeimdallOrchestrationAdapter['recoverDispatch']>
  } = {}
) {
  let idCounter = 0
  const adapter = {
    dispatchWorker:
      overrides.dispatchWorker ??
      vi.fn(async () => ({ status: 'dispatched' as const, dispatchId: 'dispatch-1' })),
    recoverDispatch: overrides.recoverDispatch ?? vi.fn(async () => ({ status: 'absent' as const }))
  }
  const lifecycle = new WatcherLedgerLifecycle({
    ledgerStore: {
      read: (watcherId) => ledger.read(watcherId),
      append: (watcherId, entry) => {
        if (entry.watcherId !== watcherId) {
          throw new Error('ledger watcher envelope mismatch')
        }
        ledger.append(entry)
      }
    },
    budgetClock: {
      open: vi.fn((id: string) => ({ watcherId: id, intervalId: 'interval-1' })),
      close: vi.fn(),
      current: vi.fn(() => null)
    },
    adapter,
    now: () => 100,
    createId: () => `dispatch-lifecycle-${++idCounter}`
  })
  return { lifecycle, adapter }
}

describe('Heimdall ledger durable dispatch spec retention', () => {
  it('keeps the dispatch spec on a settled-indeterminate attempt and lets recover() replay it', async () => {
    const { lifecycle, adapter } = lifecycleFor({
      dispatchWorker: vi.fn(async () => ({ status: 'indeterminate' as const, requestId: 'req-1' }))
    })

    const result = await lifecycle.dispatch({
      enrollment: enrollment(),
      action: dispatchAction,
      fingerprint: 'fingerprint-indeterminate',
      spec: 'objective: recover me'
    })
    expect(result.status).toBe('indeterminate')

    const settled = getLatestAttempts(ledger.read('watcher-1'))[0]!
    expect(settled).toMatchObject({ state: 'settled', effect: 'indeterminate' })
    expect(settled.dispatch?.spec).toBe('objective: recover me')

    adapter.recoverDispatch.mockClear()
    await lifecycle.recover(enrollment())

    expect(adapter.recoverDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ spec: 'objective: recover me' })
    )
  })

  it('keeps the dispatch spec when settleWorker settles an indeterminate effect', async () => {
    const { lifecycle } = lifecycleFor()
    await lifecycle.dispatch({
      enrollment: enrollment(),
      action: dispatchAction,
      fingerprint: 'fingerprint-mailbox-indeterminate',
      spec: 'objective: mailbox says unclear'
    })

    lifecycle.settleWorker({
      watcherId: 'watcher-1',
      dispatchId: 'dispatch-1',
      effect: 'indeterminate'
    })

    const settled = getLatestAttempts(ledger.read('watcher-1'))[0]!
    expect(settled).toMatchObject({ state: 'settled', effect: 'indeterminate' })
    expect(settled.dispatch?.spec).toBe('objective: mailbox says unclear')
  })

  it('drops the dispatch spec when settleWorker settles a determinate effect', async () => {
    const { lifecycle } = lifecycleFor()
    await lifecycle.dispatch({
      enrollment: enrollment(),
      action: dispatchAction,
      fingerprint: 'fingerprint-landed',
      spec: 'objective: land this'
    })

    lifecycle.settleWorker({ watcherId: 'watcher-1', dispatchId: 'dispatch-1', effect: 'landed' })

    const settled = getLatestAttempts(ledger.read('watcher-1'))[0]!
    expect(settled).toMatchObject({ state: 'settled', effect: 'landed' })
    expect(settled.dispatch?.spec).toBeUndefined()
    expect(settled.dispatch?.dispatchKind).toBe('child')
  })

  it('drops the dispatch spec when a fresh dispatch settles with a determinate refused result', async () => {
    const { lifecycle } = lifecycleFor({
      dispatchWorker: vi.fn(async () => ({
        status: 'refused' as const,
        reason: 'placement-unavailable' as const,
        detail: 'no capacity'
      }))
    })

    const result = await lifecycle.dispatch({
      enrollment: enrollment(),
      action: dispatchAction,
      fingerprint: 'fingerprint-refused',
      spec: 'objective: refused dispatch'
    })
    expect(result.status).toBe('refused')

    const settled = getLatestAttempts(ledger.read('watcher-1'))[0]!
    expect(settled).toMatchObject({ state: 'settled', effect: 'not-landed' })
    expect(settled.dispatch?.spec).toBeUndefined()
  })

  it('keeps the dispatch spec on the attempted and running revisions', async () => {
    const { lifecycle } = lifecycleFor()
    await lifecycle.dispatch({
      enrollment: enrollment(),
      action: dispatchAction,
      fingerprint: 'fingerprint-running',
      spec: 'objective: keep me running'
    })

    const attempts = ledger
      .read('watcher-1')
      .entries.filter((entry): entry is AttemptEntry => entry.kind === 'attempt')
    const attemptedEntry = attempts.find((entry) => entry.state === 'attempted')
    const runningEntry = attempts.find((entry) => entry.state === 'running')

    expect(attemptedEntry?.dispatch?.spec).toBe('objective: keep me running')
    expect(runningEntry?.dispatch?.spec).toBe('objective: keep me running')
  })

  it('parses a pre-existing determinate settled row that still carries a spec', () => {
    const legacyEntry: AttemptEntry = {
      ...attempt('settled', 'attempt-legacy', 'watcher-1', 'not-landed'),
      dispatch: { spec: 'objective: legacy row kept its spec', dispatchKind: 'child' }
    }

    expect(() => ledger.append(legacyEntry)).not.toThrow()
    const stored = getLatestAttempts(ledger.read('watcher-1'))[0]!
    expect(stored.dispatch?.spec).toBe('objective: legacy row kept its spec')
  })
})
