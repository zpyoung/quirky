import { describe, expect, test } from 'bun:test'
import type { FleetRow, FleetSnapshot } from '../src/control-contracts'
import type { TickTrace } from '../src/contracts'
import { acceptFleetSnapshot, groupDecisionTraces, statusPresentation } from '../src/ui-model'
import { groupFleetRows, sortFleetRows } from '../src/fleet-selectors'

function row(overrides: Partial<FleetRow> = {}): FleetRow {
  return {
    target: { watcherId: 'watcher' },
    ownerFence: { executionHostId: 'host', schedulerOwner: 'scheduler', workspaceKey: 'workspace', revision: 1 },
    enrollment: {
      watcherId: 'watcher',
      kind: 'objective',
      workspaceKey: 'workspace',
      workspacePath: '/workspace',
      executionHostId: 'host',
      schedulerOwner: 'scheduler',
      kindPayload: {},
      enabled: true,
      paused: false,
      commandRevision: 1,
      capabilities: {},
      budget: { wallClockActiveMs: 60_000, turns: 4 },
      coordinator: { handle: 'handle', paneKey: 'pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null,
      parkReason: null,
      haltReason: null
    },
    status: { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
    name: 'Watcher',
    workspaceName: 'Workspace',
    branch: 'main',
    phase: null,
    ownerContact: 'live',
    observedAtMs: 10_000,
    lastSuccessfulTickAtMs: null,
    budget: { activeMs: 0, turns: 0, exhausted: null },
    runningWorkers: 0,
    maxConcurrency: 1,
    openEscalations: [],
    pendingQuestion: false,
    ...overrides
  }
}

function trace(overrides: Partial<TickTrace> = {}): TickTrace {
  return {
    seq: 1,
    watcherId: 'watcher',
    startedAtMs: 1_000,
    durationMs: 50,
    exitPath: 'gate-held',
    pinned: false,
    fullResyncDue: false,
    snapshotReadCount: 1,
    contentIdentity: 'content-a',
    snapshot: { title: 'same' },
    decision: { action: null, reason: 'awaiting-approval' },
    declined: ['phase-a'],
    gate: { verdict: 'hold', reason: 'awaiting-approval' },
    budget: { activeMs: 0, turns: 0, exhausted: null },
    ...overrides
  }
}

describe('Heimdall UI model', () => {
  test('orders rows by urgency, successful tick recency, then name', () => {
    const rows = [
      row({ name: 'z-watch', status: { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }, lastSuccessfulTickAtMs: 99 }),
      row({ name: 'a-watch', status: { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 }, lastSuccessfulTickAtMs: 99 }),
      row({ name: 'b-never' }),
      row({ name: 'a-never' }),
      row({ name: 'held', status: { state: 'held', reason: 'awaiting-approval', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'unreachable', status: { state: 'unreachable', reason: 'contact-lost', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'tick-error', status: { state: 'held', reason: 'tick-error', nextPulseAtMs: null, consecutiveErrors: 1, consecutiveGateHolds: 0 } }),
      row({ name: 'unverifiable-watch', ownerContact: 'unverifiable' }),
      row({ name: 'parked', status: { state: 'parked', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'escalated', status: { state: 'escalated', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'acting', status: { state: 'acting', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'terminal', status: { state: 'terminal', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'disabled', status: { state: 'disabled', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } })
    ]

    expect(sortFleetRows(rows).map((item) => item.name)).toEqual([
      'escalated', 'parked', 'tick-error', 'unreachable', 'unverifiable-watch', 'held', 'acting', 'a-watch', 'z-watch', 'a-never', 'b-never', 'terminal', 'disabled'
    ])
  })

  test('assigns every row to one bucket using attention before contact and active state', () => {
    const rows = [
      row({ name: 'parked-lost', ownerContact: 'unverifiable', status: { state: 'parked', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'escalated', status: { state: 'escalated', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'held-question', pendingQuestion: true, status: { state: 'held', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'held-approval', openEscalations: [{ escalationId: 'e1', escalationKind: 'awaiting-approval', status: 'open', foldCount: 1 }], status: { state: 'held', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'unverifiable', ownerContact: 'unverifiable' }),
      row({ name: 'unreachable', status: { state: 'unreachable', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'held-active', status: { state: 'held', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'terminal', status: { state: 'terminal', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
      row({ name: 'disabled', status: { state: 'disabled', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }),
    ]

    const groups = groupFleetRows(rows)
    expect(groups.needsYou.map((item) => item.name)).toEqual(['parked-lost', 'escalated', 'held-question', 'held-approval'])
    expect(groups.lostContact.map((item) => item.name)).toEqual(['unverifiable', 'unreachable'])
    expect(groups.active.map((item) => item.name)).toEqual(['held-active'])
    expect(groups.inactive.map((item) => item.name)).toEqual(['terminal', 'disabled'])
    expect(Object.values(groups).flat()).toHaveLength(rows.length)
  })

  test('uses the same urgency, contact, approval, and inactive rules for every fleet view', () => {
    const pausedWatching = row({ name: 'paused-watching' })
    pausedWatching.enrollment.paused = true
    const rows = [
      pausedWatching,
      row({
        name: 'acting-unverifiable',
        ownerContact: 'unverifiable',
        status: { state: 'acting', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
        lastSuccessfulTickAtMs: 40
      }),
      row({
        name: 'held-tick-error',
        status: { state: 'held', reason: 'tick-error', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
        lastSuccessfulTickAtMs: 30
      }),
      row({
        name: 'held-error-count',
        status: { state: 'held', reason: 'retrying', nextPulseAtMs: null, consecutiveErrors: 1, consecutiveGateHolds: 0 },
        lastSuccessfulTickAtMs: 20
      }),
      row({
        name: 'detail-error-text',
        status: { state: 'watching', reason: 'no-action', detail: 'no errors found', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
        lastSuccessfulTickAtMs: 20
      }),
      row({
        name: 'approval-scope',
        status: { state: 'held', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
        openEscalations: [{
          escalationId: 'approval',
          escalationKind: 'review',
          status: 'open',
          foldCount: 1,
          approvalScope: { actionKind: 'edit', contentIdentity: 'source', evidenceKey: 'fingerprint' }
        }]
      }),
      row({ name: 'Z', lastSuccessfulTickAtMs: 10 }),
      row({ name: 'a', lastSuccessfulTickAtMs: 10 })
    ]

    expect(sortFleetRows(rows).map((item) => item.name)).toEqual([
      'acting-unverifiable', 'held-tick-error', 'held-error-count', 'approval-scope',
      'detail-error-text', 'Z', 'a', 'paused-watching'
    ])

    const groups = groupFleetRows(rows)
    expect(groups.needsYou.map((item) => item.name)).toEqual(['approval-scope'])
    expect(groups.lostContact.map((item) => item.name)).toEqual(['acting-unverifiable'])
    expect(groups.active.map((item) => item.name)).toEqual([
      'held-tick-error', 'held-error-count', 'detail-error-text', 'Z', 'a'
    ])
    expect(groups.inactive.map((item) => item.name)).toEqual(['paused-watching'])
  })

  test('shows tick errors and unverifiable last-confirmed age without dropping the reason', () => {
    const tickError = statusPresentation(row({
      status: { state: 'held', reason: 'tick-error', detail: 'The plan was rejected', nextPulseAtMs: null, consecutiveErrors: 1, consecutiveGateHolds: 0 }
    }), 20_000)
    const stale = statusPresentation(row({ ownerContact: 'unverifiable', observedAtMs: 8_000, status: { state: 'watching', reason: 'lease-unverifiable', detail: 'Host state not confirmed', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 } }), 20_000)

    expect(tickError).toEqual({ label: 'Error · retrying', reason: 'tick-error', detail: 'The plan was rejected' })
    expect(stale).toEqual({ label: 'Host unreachable · last confirmed 12s ago', reason: 'lease-unverifiable', detail: 'Host state not confirmed' })
  })

  test('accepts only snapshots newer than the last confirmed timestamp', () => {
    const current = { generatedAtMs: 10, rows: [], actionHistory: [], buckets: { needsYou: 0, lostContact: 0, active: 0, inactive: 0 }, activeCount: 0, attentionCount: 0 } satisfies FleetSnapshot
    const older = { ...current, generatedAtMs: 9 }
    const equal = { ...current }
    const newer = { ...current, generatedAtMs: 11 }

    expect(acceptFleetSnapshot(current, older)).toBe(current)
    expect(acceptFleetSnapshot(current, equal)).toBe(current)
    expect(acceptFleetSnapshot(current, newer)).toBe(newer)
  })

  test('collapses only adjacent identical gate-held decision traces', () => {
    const groups = groupDecisionTraces([
      trace({ seq: 19, startedAtMs: 1_900, durationMs: 30 }),
      trace({ seq: 20, startedAtMs: 2_000, durationMs: 60 }),
      trace({ seq: 21, startedAtMs: 2_100, durationMs: 80 }),
      trace({ seq: 22, contentIdentity: 'content-b', snapshot: { title: 'changed' }, decision: { action: null, reason: 'awaiting-approval' } }),
      trace({ seq: 23, exitPath: 'gate-escalated', gate: { verdict: 'escalate', reason: 'approval-required' } }),
      trace({ seq: 24, exitPath: 'gate-held' }),
      trace({ seq: 26 })
    ])

    expect(groups.map(({ firstSeq, lastSeq, count, representative }) => ({ firstSeq, lastSeq, count, reason: representative.gate?.verdict }))).toEqual([
      { firstSeq: 19, lastSeq: 21, count: 3, reason: 'hold' },
      { firstSeq: 22, lastSeq: 22, count: 1, reason: 'hold' },
      { firstSeq: 23, lastSeq: 23, count: 1, reason: 'escalate' },
      { firstSeq: 24, lastSeq: 24, count: 1, reason: 'hold' },
      { firstSeq: 26, lastSeq: 26, count: 1, reason: 'hold' }
    ])
  })
})
