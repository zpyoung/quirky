import { parkEscalationId } from '../../shared/fork-heimdall/park-escalation-id'
import { describeParkReason } from '../../shared/fork-heimdall/park-reason-description'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { FiredStopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type { WatcherParkReason } from '../../shared/fork-heimdall/watcher-types'
import { WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND } from '../../shared/fork-heimdall/worker-escalation-consumption'
import { getErrorCode } from '../git/worktree-operation-options'
import { durableWatcherBudget } from './debug-report'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

export type WatcherRunnerStatusDependencies = {
  ledgerStore: RunnerLedgerStore
  persistEnabled: (runner: WatcherRunner, enabled: boolean) => WatcherRunner['enrollment']
  persistTerminal: (
    runner: WatcherRunner,
    fired: FiredStopPredicate
  ) => Promise<WatcherRunner['enrollment']>
  now: () => number
  createId: () => string
  publish: (runner: WatcherRunner) => void
}

/** The park kinds a watcher retires on its own once the thing it halted on is no longer pending. */
export type AutoResumableParkKind = 'park-worker-question' | 'park-worker-escalation'

export function isCoordinatorSeatLost(error: unknown): boolean {
  return getErrorCode(error) === 'coordinator-seat-lost'
}
/** Owns durable stop transitions and their corresponding public status projection. */
export class WatcherRunnerStatusLifecycle {
  constructor(private readonly dependencies: WatcherRunnerStatusDependencies) {}

  park(runner: WatcherRunner, reason: WatcherParkReason): void {
    if (runner.enrollment.enabled) {
      runner.enrollment = this.dependencies.persistEnabled(runner, false)
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: parkEscalationId(runner.enrollment.watcherId, reason),
        escalationKind: `park-${reason.kind}`,
        status: 'open',
        foldCount: 1,
        reason: describeParkReason(reason)
      })
      if (reason.kind === 'stop-predicate' && reason.messageId !== undefined) {
        this.appendWorkerEscalationConsumedMarker(runner, reason.messageId)
      }
    }
    runner.status = {
      ...runner.status,
      enabled: false,
      state: 'parked',
      phase: 'parked',
      reason: describeParkReason(reason),
      parkReason: reason,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      ),
      nextPulseAtMs: null
    }
    this.dependencies.publish(runner)
  }

  parkForWorkerEscalation(
    runner: WatcherRunner,
    escalationId: string,
    reason: string,
    messageId: string
  ): void {
    const parkReason: WatcherParkReason = { kind: 'worker-escalation', escalationId, messageId }
    if (runner.enrollment.enabled) {
      runner.enrollment = this.dependencies.persistEnabled(runner, false)
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: parkEscalationId(runner.enrollment.watcherId, parkReason),
        escalationKind: 'park-worker-escalation',
        status: 'open',
        foldCount: 1,
        reason
      })
      this.appendWorkerEscalationConsumedMarker(runner, messageId)
    }
    runner.status = {
      ...runner.status,
      enabled: false,
      state: 'parked',
      phase: 'parked',
      reason,
      parkReason,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      ),
      nextPulseAtMs: null
    }
    this.dependencies.publish(runner)
  }

  configurationError(runner: WatcherRunner, reason: string): void {
    const parkReason: WatcherParkReason = { kind: 'configuration-error', reason }
    if (runner.enrollment.enabled) {
      runner.enrollment = this.dependencies.persistEnabled(runner, false)
      this.append(runner, {
        eventId: this.dependencies.createId(),
        watcherId: runner.enrollment.watcherId,
        atMs: this.dependencies.now(),
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: parkEscalationId(runner.enrollment.watcherId, parkReason),
        escalationKind: 'park-configuration-error',
        status: 'open',
        foldCount: 1,
        reason
      })
    }
    runner.status = {
      ...runner.status,
      enabled: false,
      state: 'parked',
      phase: 'configuration-error',
      reason,
      parkReason,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      ),
      nextPulseAtMs: null
    }
    this.dependencies.publish(runner)
  }

  /** Durably resumes a watcher once `parkKind`'s blocking condition is gone, folding that park. */
  readyToResume(runner: WatcherRunner, parkKind: AutoResumableParkKind): void {
    if (!runner.enrollment.enabled) {
      runner.enrollment = this.dependencies.persistEnabled(runner, true)
      const park = this.dependencies.ledgerStore
        .read(runner.enrollment.watcherId)
        .entries.findLast(
          (entry): entry is Extract<LedgerEntry, { kind: 'escalation' }> =>
            entry.kind === 'escalation' && entry.escalationKind === parkKind
        )
      if (park) {
        this.append(runner, {
          ...park,
          eventId: this.dependencies.createId(),
          atMs: this.dependencies.now(),
          status: 'resolved',
          foldCount: park.foldCount + 1
        })
      }
    }
    runner.status = {
      ...runner.status,
      enabled: true,
      state: 'watching',
      phase: 'resumed',
      reason: null,
      parkReason: null,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      )
    }
    this.dependencies.publish(runner)
  }

  async terminal(runner: WatcherRunner, fired: FiredStopPredicate): Promise<void> {
    if (fired.disposition !== 'terminal') {
      throw new Error('A park predicate cannot make a watcher terminal')
    }
    const enrollment = await this.dependencies.persistTerminal(runner, fired)
    this.finishTerminal(runner, enrollment, fired.reason, true)
  }

  workspaceRemoved(
    runner: WatcherRunner,
    persist: (runner: WatcherRunner, fired: FiredStopPredicate) => WatcherRunner['enrollment']
  ): void {
    const fired = {
      predicateId: 'workspace-removed',
      disposition: 'terminal',
      reason: 'Workspace removed from Quirky'
    } as const
    const enrollment = persist(runner, fired)
    this.finishTerminal(runner, enrollment, fired.reason, false)
  }

  private finishTerminal(
    runner: WatcherRunner,
    enrollment: WatcherRunner['enrollment'],
    reason: string,
    successfulTick: boolean
  ): void {
    runner.enrollment = enrollment
    runner.stopped = true
    const ledger = this.dependencies.ledgerStore.read(enrollment.watcherId)
    const terminalSummary = this.dependencies.ledgerStore.readTerminalSummary(enrollment.watcherId)
    runner.status = {
      ...runner.status,
      enabled: false,
      state: 'terminal',
      phase: 'terminal',
      reason,
      parkReason: null,
      budget: durableWatcherBudget(enrollment, ledger, terminalSummary),
      ...(successfulTick ? { lastSuccessfulTickAtMs: this.dependencies.now() } : {}),
      nextPulseAtMs: null
    }
    this.dependencies.publish(runner)
  }

  gate(runner: WatcherRunner, escalated: boolean, reason: string): void {
    runner.status = {
      ...runner.status,
      state: escalated ? 'escalated' : 'held',
      phase: 'gate',
      reason,
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      )
    }
    this.dependencies.publish(runner)
  }

  markSuccessful(runner: WatcherRunner, phase: string): void {
    runner.consecutiveErrors = 0
    runner.consecutiveGateHolds = 0
    runner.status = {
      ...runner.status,
      state: phase === 'acting' ? 'acting' : 'watching',
      phase,
      reason: null,
      lastSuccessfulTickAtMs: this.dependencies.now(),
      budget: deriveBudgetState(
        this.dependencies.ledgerStore.read(runner.enrollment.watcherId),
        runner.enrollment.budget
      )
    }
    this.dependencies.publish(runner)
  }

  private appendWorkerEscalationConsumedMarker(runner: WatcherRunner, messageId: string): void {
    this.append(runner, {
      eventId: this.dependencies.createId(),
      watcherId: runner.enrollment.watcherId,
      atMs: this.dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND,
      payload: { messageId }
    })
  }

  private append(runner: WatcherRunner, entry: LedgerEntry): void {
    this.dependencies.ledgerStore.append(runner.enrollment.watcherId, entry)
  }
}
