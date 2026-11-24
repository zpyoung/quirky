import { describe, expect, it } from 'vitest'
import type {
  AttemptEntry,
  EscalationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { createTickTrace } from '../../shared/fork-heimdall/tick-trace'
import { WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND } from '../../shared/fork-heimdall/worker-escalation-consumption'
import type {
  WatcherEnrollment,
  WatcherTerminalSummary
} from '../../shared/fork-heimdall/watcher-types'
import {
  DEBUG_REPORT_TRACE_LIMIT,
  HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION,
  buildHeimdallDebugReport,
  describeDebugSnapshot,
  dormantWatcherStatus,
  type HeimdallDebugReportInput
} from './debug-report'

const HOME = '/Users/someone'
const TERMINAL_SUMMARY: WatcherTerminalSummary = {
  watcherId: 'watcher-1',
  kind: 'hosted-review',
  terminalState: 'completed',
  reason: 'objective-complete',
  totals: { activeMs: 12_000, turns: 3, exhausted: null },
  atMs: 250
}

function enrollment(overrides: Partial<WatcherEnrollment> = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/Users/someone/work/quirky',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: `${HOME}/work/quirky`,
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { write: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 4 },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'tab:leaf' },
    orchestrationRunId: null,
    createdAtMs: 100,
    terminalAtMs: null,
    ...overrides
  }
}

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

function escalation(
  escalationKind: string,
  overrides: Partial<EscalationEntry> = {}
): EscalationEntry {
  return {
    eventId: `event-${escalationKind}`,
    watcherId: 'watcher-1',
    atMs: 200,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: `${escalationKind}:watcher-1`,
    escalationKind,
    status: 'open',
    foldCount: 1,
    ...overrides
  }
}

function attemptEntry(overrides: Partial<AttemptEntry> = {}): AttemptEntry {
  return {
    eventId: 'attempt-1',
    watcherId: 'watcher-1',
    atMs: 210,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: 'fingerprint-1',
    action: {
      kind: 'apply-review-fix',
      capability: 'write',
      visibility: 'external',
      contentIdentity: 'revision-1',
      evidenceKey: 'review:revision-1'
    },
    state: 'attempted',
    ...overrides
  }
}

function reportInput(overrides: Partial<HeimdallDebugReportInput> = {}): HeimdallDebugReportInput {
  const watcher = enrollment()
  const watcherLedger = ledger()
  return {
    enrollment: watcher,
    status: dormantWatcherStatus(watcher, watcherLedger),
    ledger: watcherLedger,
    terminalSummary: null,
    traces: [],
    runner: null,
    generatedAtMs: 300,
    appVersion: '1.4.204',
    platform: 'darwin',
    homeDirectory: HOME,
    budgetClock: { openIntervalId: null },
    malformedPayload: false,
    pendingControlOperation: false,
    workers: [],
    workersError: null,
    pointers: [],
    ...overrides
  }
}

describe('dormant Heimdall watcher status', () => {
  it('gives a terminal ledger fact precedence over pause and park state', () => {
    const watcher = enrollment({ enabled: false, paused: true, terminalAtMs: 250 })
    const compactedLedger = ledger([
      {
        eventId: 'terminal',
        watcherId: 'watcher-1',
        atMs: 250,
        origin: 'owner',
        class: 'fact',
        kind: 'terminal',
        state: 'completed',
        reason: 'objective-complete'
      }
    ])
    const status = dormantWatcherStatus(watcher, compactedLedger, TERMINAL_SUMMARY)

    expect(status).toMatchObject({
      state: 'terminal',
      phase: 'terminal',
      reason: 'objective-complete',
      budget: TERMINAL_SUMMARY.totals
    })
  })

  it('reconstructs a worker-question park from the latest open escalation', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('worker-question', {
          escalationId: 'worker-question:dispatch-1:message-7',
          atMs: 199
        }),
        escalation('park-worker-question', {
          escalationId: 'park:watcher-1:worker-question:message-7'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      parkReason: { kind: 'worker-question', messageId: 'message-7' }
    })
  })

  it('reconstructs a durable worker escalation as operator-visible attention', () => {
    const status = dormantWatcherStatus(
      enrollment(),
      ledger([
        escalation('worker-escalation', {
          escalationId: 'worker-escalation:dispatch-1:message-8',
          reason: 'Blocked: credentials are required'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'escalated',
      phase: 'gate',
      reason: 'Blocked: credentials are required',
      parkReason: null
    })
  })

  it('uses encoded and legacy reason detail for stop-predicate parks', () => {
    const watcher = enrollment({ enabled: false })
    const encoded = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-stop-predicate', {
          escalationId: 'park:watcher-1:stop-predicate:review%2Dmerged',
          reason: 'The review merged'
        })
      ])
    )
    const legacy = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-stop-predicate', {
          escalationId: 'legacy-park-row',
          reason: 'legacy-predicate'
        })
      ])
    )

    expect(encoded.parkReason).toEqual({
      kind: 'stop-predicate',
      predicateId: 'review-merged',
      reason: 'The review merged'
    })
    expect(legacy.parkReason).toEqual({
      kind: 'stop-predicate',
      predicateId: 'legacy-predicate',
      reason: 'legacy-predicate'
    })
  })

  // Originally this kept `parkReason` untyped (null) so an old reader's compiled union never had
  // to learn a new discriminant. It is typed now — `park-reason-wire.ts`'s capability gate degrades
  // it back to null on the wire for a reader that has not negotiated
  // `heimdall.watcher-park-reason.v2`, so the in-process value this function returns can stay
  // honest without reopening the compatibility risk this test used to guard by omission. A revert
  // to null belongs here, not in the wire projection, if that trade is ever taken back.
  it('keeps a persisted configuration failure operator-visible with a typed, capability-gated park reason', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-configuration-error', {
          escalationId: 'park:watcher-1:configuration-error',
          reason: 'Resolved Git authority changed after Heimdall enrollment'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      reason: 'Resolved Git authority changed after Heimdall enrollment',
      parkReason: {
        kind: 'configuration-error',
        reason: 'Resolved Git authority changed after Heimdall enrollment'
      }
    })
  })

  it('keeps a persisted worker escalation operator-visible with its original reason text', () => {
    const watcher = enrollment({ enabled: false })
    const originalEscalationId = 'worker-escalation:dispatch-1:message-1'
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-worker-escalation', {
          escalationId: `park:watcher-1:worker-escalation:${encodeURIComponent(originalEscalationId)}`,
          reason: 'Blocked: credentials are required'
        }),
        {
          eventId: 'consumed-1',
          watcherId: 'watcher-1',
          atMs: 201,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND,
          payload: { messageId: 'message-1' }
        }
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      reason: 'Blocked: credentials are required',
      parkReason: {
        kind: 'worker-escalation',
        escalationId: originalEscalationId,
        messageId: 'message-1'
      }
    })
  })

  it('uses the persisted reason for a stop-predicate park instead of the bare kind', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-stop-predicate', {
          escalationId: 'park:watcher-1:stop-predicate:review%2Dmerged',
          reason: 'The review merged'
        })
      ])
    )

    expect(status.reason).toBe('The review merged')
  })

  it('reconstructs a persisted owner escalation park with its original reason text', () => {
    const watcher = enrollment({ enabled: false })
    const originalEscalationId = 'owner-escalation:dispatch-1'
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-owner-escalation', {
          escalationId: `park:watcher-1:owner-escalation:${encodeURIComponent(originalEscalationId)}`,
          reason: 'The owner must resolve this before the watcher can continue'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      reason: 'The owner must resolve this before the watcher can continue',
      parkReason: {
        kind: 'owner-escalation',
        escalationId: originalEscalationId,
        reason: 'The owner must resolve this before the watcher can continue'
      }
    })
  })

  it('falls back to the bare kind for a worker-question park', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('worker-question', {
          escalationId: 'worker-question:dispatch-1:message-7',
          atMs: 199
        }),
        escalation('park-worker-question', {
          escalationId: 'park:watcher-1:worker-question:message-7'
        })
      ])
    )

    expect(status.reason).toBe('worker-question')
  })

  it('keeps an automatic park visible even when its persisted reason cannot be reconstructed', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-budget', {
          escalationId: 'park:watcher-1:budget:unknown-exhaustion'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      reason: 'ready-to-resume',
      parkReason: null
    })
  })

  it('distinguishes enabled and manually disabled dormant watchers', () => {
    expect(dormantWatcherStatus(enrollment(), ledger())).toMatchObject({ state: 'watching' })
    expect(dormantWatcherStatus(enrollment({ enabled: false }), ledger())).toMatchObject({
      state: 'disabled',
      parkReason: null
    })
  })
})

describe('Heimdall debug report', () => {
  it('stamps the current schema version', () => {
    expect(HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION).toBe(3)
    expect(buildHeimdallDebugReport(reportInput()).schemaVersion).toBe(3)
  })

  it('emits schema 3, sanitizes free text, and leaves pointer paths authoritative', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const failingTrace = createTickTrace(1, 100, {
      consecutiveErrors: 1,
      lastFullResyncAtMs: null,
      reconcileAgain: false
    })
    failingTrace.error = { message: `token=${secret} at ${HOME}/work/quirky` }
    const report = buildHeimdallDebugReport(
      reportInput({
        ledger: ledger([
          escalation('awaiting-approval', {
            reason: `token=${secret} at ${HOME}/work/quirky`
          })
        ]),
        traces: [failingTrace],
        workersError: `worker failed with token=${secret}`,
        pointers: [
          {
            role: 'workspace',
            host: 'local',
            path: `${HOME}/work/quirky`,
            status: 'resolved'
          }
        ]
      })
    )

    expect(report.schemaVersion).toBe(3)
    expect(report.ledger.entries[0]).not.toMatchObject({ reason: expect.stringContaining(secret) })
    expect(report.traces[0]?.error?.message).not.toContain(secret)
    expect(report.workersError).not.toContain(secret)
    expect(report.pointers[0]?.path).toBe(`${HOME}/work/quirky`)
  })

  it('reports preserved terminal budget totals after ledger compaction', () => {
    const watcher = enrollment({ enabled: false, terminalAtMs: 250 })
    const compactedLedger = ledger([
      {
        eventId: 'terminal',
        watcherId: 'watcher-1',
        atMs: 250,
        origin: 'owner',
        class: 'fact',
        kind: 'terminal',
        state: 'completed',
        reason: 'objective-complete'
      }
    ])
    const report = buildHeimdallDebugReport(
      reportInput({
        enrollment: watcher,
        status: dormantWatcherStatus(watcher, compactedLedger, TERMINAL_SUMMARY),
        ledger: compactedLedger,
        terminalSummary: TERMINAL_SUMMARY
      })
    )

    expect(report.status.budget).toEqual(TERMINAL_SUMMARY.totals)
    expect(report.budget).toEqual(TERMINAL_SUMMARY.totals)
  })

  it('collapses only local enrollment paths against the reporting kernel home', () => {
    const local = buildHeimdallDebugReport(reportInput())
    const remoteEnrollment = enrollment({
      executionHostId: 'ssh:build-host',
      workspaceKey: 'ssh:build-host::/Users/someone/work/quirky'
    })
    const remote = buildHeimdallDebugReport(reportInput({ enrollment: remoteEnrollment }))

    expect(local.enrollment.workspacePath).toBe('~/work/quirky')
    expect(remote.enrollment.workspacePath).toBe(`${HOME}/work/quirky`)
  })

  it('retains snapshot envelope diagnostics when a kind description throws', () => {
    const snapshot: Snapshot<unknown> = {
      freshness: 'cached',
      observedAtMs: 123,
      contentIdentity: 'content-1',
      world: { sensitive: 'not returned' }
    }

    expect(
      describeDebugSnapshot(snapshot, () => {
        throw new Error('description failed')
      })
    ).toEqual({
      freshness: 'cached',
      observedAtMs: 123,
      contentIdentity: 'content-1',
      summary: null
    })
  })
  it('keeps only the newest full-detail trace window', () => {
    const total = DEBUG_REPORT_TRACE_LIMIT + 3
    const traces = Array.from({ length: total }, (_unused, index) =>
      createTickTrace(index + 1, index + 1, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: null,
        reconcileAgain: false
      })
    )

    const report = buildHeimdallDebugReport(reportInput({ traces }))

    expect(report.traces).toHaveLength(DEBUG_REPORT_TRACE_LIMIT)
    expect(report.traces.map((trace) => trace.seq)).toEqual(
      Array.from({ length: DEBUG_REPORT_TRACE_LIMIT }, (_unused, index) => total - index)
    )
  })

  it('returns every trace when there are fewer than the full-detail window', () => {
    const total = DEBUG_REPORT_TRACE_LIMIT - 2
    const traces = Array.from({ length: total }, (_unused, index) =>
      createTickTrace(index + 1, index + 1, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: null,
        reconcileAgain: false
      })
    )

    const report = buildHeimdallDebugReport(reportInput({ traces }))

    expect(report.traces).toHaveLength(total)
    expect(report.traces.map((trace) => trace.seq)).toEqual(
      Array.from({ length: total }, (_unused, index) => total - index)
    )
  })

  it('truncates a dispatch spec that exceeds the report budget', () => {
    const oversizedSpec = 'x'.repeat(5_000)
    const report = buildHeimdallDebugReport(
      reportInput({
        ledger: ledger([attemptEntry({ dispatch: { spec: oversizedSpec, dispatchKind: 'child' } })])
      })
    )

    const entry = report.ledger.entries[0]
    expect(entry?.kind).toBe('attempt')
    expect(entry?.kind === 'attempt' ? entry.dispatch?.spec : undefined).toBe(
      `${'x'.repeat(4_000)}...`
    )
  })

  it('leaves a dispatch spec under the report budget byte-identical', () => {
    const spec = 'role: implementer\nobjective: fix the flaky test'
    const report = buildHeimdallDebugReport(
      reportInput({
        ledger: ledger([attemptEntry({ dispatch: { spec, dispatchKind: 'child' } })])
      })
    )

    const entry = report.ledger.entries[0]
    expect(entry?.kind === 'attempt' ? entry.dispatch?.spec : undefined).toBe(spec)
  })

  it('leaves an attempt entry with no dispatch untouched', () => {
    const report = buildHeimdallDebugReport(reportInput({ ledger: ledger([attemptEntry()]) }))

    expect(report.ledger.entries[0]).toEqual(attemptEntry())
  })

  it('builds a version-3 report from version-2-shaped ledger entries, traces, and runner state', () => {
    const legacyAttempt = attemptEntry()
    expect('failureClass' in legacyAttempt).toBe(false)
    const legacyTrace = createTickTrace(1, 100, {
      consecutiveErrors: 0,
      lastFullResyncAtMs: null,
      reconcileAgain: false
    })
    legacyTrace.pacing = {
      tier: 'idle',
      delayMs: 300_000,
      stateDelayMs: 300_000,
      errorBackoffMs: null,
      fullResyncDue: false,
      nextFullResyncInMs: 900_000
    }
    expect('gateHoldBackoffMs' in legacyTrace.pacing).toBe(false)
    const legacyRunner: NonNullable<HeimdallDebugReportInput['runner']> = {
      kindId: 'hosted-review',
      consecutiveErrors: 0,
      lastFullResyncAtMs: null,
      tickQueued: false,
      reconcileAgain: false,
      timerArmed: true,
      actionInFlight: false,
      leaseEpoch: 1,
      stopped: false,
      suspended: false,
      controlPending: null,
      recovered: false,
      forceFresh: false,
      traceSequence: 1,
      leaseRenewalArmed: true,
      snapshot: null
    }

    const report = buildHeimdallDebugReport(
      reportInput({
        ledger: ledger([legacyAttempt]),
        traces: [legacyTrace],
        runner: legacyRunner
      })
    )

    expect(report.schemaVersion).toBe(3)
    expect(report.ledger.entries[0]).toEqual(legacyAttempt)
    expect(report.traces[0]?.pacing).toEqual(legacyTrace.pacing)
    expect(report.runner).toEqual(legacyRunner)
  })
})
