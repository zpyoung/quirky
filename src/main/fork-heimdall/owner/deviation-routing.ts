import type { GateVerdict } from '../../../shared/fork-heimdall/gate'
import type { KernelAction } from '../../../shared/fork-heimdall/kind-contract'
import { OWNER_INTERVENTION_CAPABILITY } from '../../../shared/fork-heimdall/owner/owner-capability'
import {
  InterventionSchema,
  type KindAgnosticIntervention
} from '../../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type {
  WatcherEnrollment,
  WatcherParkReason,
  WorkspaceKey
} from '../../../shared/fork-heimdall/watcher-types'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import {
  buildOwnerBrief,
  buildOwnerPromptText,
  ownerInterventionVocabulary,
  OWNER_BRIEF_MAX_STATE_BYTES
} from './owner-brief'
import { deliverOwnerAnswer } from './owner-answer-delivery'
import {
  decodeOwnerDeviation,
  deviationRetriesExhausted,
  escalateDeviationToHuman,
  findOldestOpenOwnerDeviation,
  markOwnerTurnSent,
  ownerInterventionAcceptedAtMs,
  ownerDeviationWakeToken,
  ownerTurnAwaitingSend,
  reRaiseDeviation,
  resolveDeviation,
  type DeviationRecordDependencies,
  type OwnerDeviationEscalation
} from './deviation-ledger'
import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import { deviationIsDispatchScoped } from './deviation-scope'
import { evaluateOwnerReachability } from './owner-failure'
import { evaluateOwnerIntervention } from './owner-intervention'
import { applyOwnerWorkerMessage } from './owner-worker-message'
import { applyOwnerWorkerStop } from './owner-worker-stop'
import { issueOwnerReportPath, ownerReportPathForWake, readOwnerReport } from './owner-report-io'
import { resolveOwnerReportLocation, type OwnerReportLocation } from './owner-report-location'
import { ensureOwnerSession, sendOwnerTurn } from './owner-session'
import { workspaceRuntimeId } from '../orchestration/orchestration-adapter'
import type { WatcherQuestionState } from '../orchestration/orchestration-contract'
import type { BudgetClock } from '../budget-clock'
import type { LeaseWorkspaceTarget } from '../lease-store'
import type { WatcherRunner } from '../runner-state'
import type { WatcherRunnerActions } from '../runner-actions'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import { gateRunnerAction } from '../runner-gating'

// `current` is optional here because the runner loop's own `RunnerBudgetClock` declares it
// optional too; every call site already guards with `?.`.
type OwnerBudgetClock = {
  open: BudgetClock['open']
  close: BudgetClock['close']
  current?: BudgetClock['current']
}

/**
 * The runtime handles owner support needs beyond what a kernel-agnostic `WatcherRunnerDependencies`
 * already carries. Absent entirely, `driveOwnerDeviation` never activates — the enforcement point
 * for "owner absent means unchanged behaviour" is one level up, in `WatcherRunnerDependencies.owner`
 * being undefined, not anything in here.
 */
export type OwnerRuntimeDependencies = {
  runtime: QuirkyRuntimeService
  resolveWorkspaceTarget: (workspaceKey: WorkspaceKey) => Promise<LeaseWorkspaceTarget>
  ensureRun: (enrollment: WatcherEnrollment) => Promise<{ runId: string }>
}

export type DeviationRoutingDependencies = {
  owner: OwnerRuntimeDependencies
  actions: Pick<WatcherRunnerActions, 'execute' | 'recordGateRejection'>
  budgetClock: OwnerBudgetClock
  ledgerRecord: DeviationRecordDependencies
  answerWorkerQuestion(messageId: string, answer: string): Promise<void>
  readWorkerQuestion(messageId: string): Promise<WatcherQuestionState>
  stopWorker(dispatchId: string): Promise<WatcherCommandResult>
  /** Throws `WorkerPromptUndeliverableError` when the worker cannot safely receive it. */
  messageWorker(dispatchId: string, message: string): Promise<void>
  park(reason: WatcherParkReason): void
}

export type DriveOwnerDeviationOutcome = 'idle' | 'handled'

type CachedOwnerSubmissionRejection = {
  escalationId: string
  reason: string
}

const rejectedOwnerSubmissions = new WeakMap<WatcherRunner, CachedOwnerSubmissionRejection>()

/** Keeps a rejected, non-durable preflight diagnostic for this escalation's next applicable prompt. */
export function rememberOwnerSubmissionRejection(
  runner: WatcherRunner,
  pending: OwnerDeviationEscalation,
  reason: string
): void {
  rejectedOwnerSubmissions.set(runner, {
    escalationId: pending.escalationId,
    reason
  })
}

/** A corrected ready submission supersedes any earlier invalid-input diagnostic for this turn. */
export function clearOwnerSubmissionRejection(
  runner: WatcherRunner,
  pending: OwnerDeviationEscalation
): void {
  const cached = rejectedOwnerSubmissions.get(runner)
  if (cached?.escalationId === pending.escalationId) {
    rejectedOwnerSubmissions.delete(runner)
  }
}

/**
 * Advances the current owner deviation one step: sends the brief if it hasn't gone out yet, polls
 * and applies the reply if one is waiting, or applies the bounded-re-wake / escalate-to-human
 * decision once the owner has gone quiet. Never falls back to automatic replan.
 */
export async function driveOwnerDeviation(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>
): Promise<DriveOwnerDeviationOutcome> {
  const enrollment = runner.enrollment
  if (!enrollment.owner || enrollment.paused) {
    return 'idle'
  }
  const owner = runner.kind.owner
  if (!owner) {
    return 'idle'
  }
  const ledger = deps.ledgerRecord.ledgerStore.read(enrollment.watcherId)
  const pending = findOldestOpenOwnerDeviation(ledger)
  if (!pending) {
    return 'idle'
  }
  const deviation = decodeOwnerDeviation(pending)
  if (!deviation) {
    escalateDeviationToHuman(
      deps.ledgerRecord,
      enrollment.watcherId,
      pending,
      'undecodable-deviation-record'
    )
    deps.park({
      kind: 'owner-escalation',
      escalationId: pending.escalationId,
      reason: 'A recorded deviation could not be decoded; escalated for a human to inspect.'
    })
    return 'handled'
  }

  const target = await deps.owner.resolveWorkspaceTarget(enrollment.workspaceKey)
  const location = await resolveOwnerReportLocation(target)

  if (ownerTurnAwaitingSend(pending)) {
    const failure = await sendOwnerBrief(
      deps,
      runner,
      snapshot,
      ledger,
      deviation,
      pending,
      location
    )
    if (failure) {
      return handOwnerDeviationToHuman(deps, runner, ledger, deviation, pending, failure)
    }
    openOwnerInterval(deps.budgetClock, runner)
    markOwnerTurnSent(deps.ledgerRecord, enrollment.watcherId, pending)
    return 'handled'
  }
  const acceptedAtMs = ownerInterventionAcceptedAtMs(ledger, enrollment.watcherId, pending)
  if (acceptedAtMs === null) {
    return handleUnreachable(deps, runner, snapshot, ledger, deviation, pending, location)
  }

  const wakeToken = ownerDeviationWakeToken(pending)
  const expectedPath = ownerReportPathForWake(location, wakeToken)
  const read = await readOwnerReport(location, expectedPath, undefined, InterventionSchema)
  if (!read.ok && read.reason === 'missing') {
    return handleUnreachable(deps, runner, snapshot, ledger, deviation, pending, location)
  }

  const outcome = evaluateOwnerIntervention({
    read,
    owner,
    snapshot,
    ledger,
    enrollment,
    deviation
  })

  if (outcome.status === 'malformed' || outcome.status === 'rejected') {
    const reason =
      outcome.status === 'malformed' ? outcome.reason : `${outcome.gate}: ${outcome.reason}`
    return handleRejection(deps, runner, snapshot, ledger, deviation, pending, location, reason)
  }

  if (outcome.status === 'agnostic') {
    const move = outcome.move
    if (move.kind === 'answer-worker') {
      const delivery = await deliverOwnerAnswer({
        deviation,
        move,
        acceptedAtMs,
        nowMs: deps.ledgerRecord.now(),
        readQuestion: deps.readWorkerQuestion,
        answerQuestion: deps.answerWorkerQuestion
      })
      if (delivery.status === 'refuse') {
        return handleRejection(
          deps,
          runner,
          snapshot,
          ledger,
          deviation,
          pending,
          location,
          delivery.reason
        )
      }
      if (delivery.status === 'undeliverable') {
        return handOwnerDeviationToHuman(deps, runner, ledger, deviation, pending, delivery.reason)
      }
      if (delivery.status === 'delivered') {
        closeOwnerInterval(deps.budgetClock, runner)
        resolveDeviation(deps.ledgerRecord, enrollment.watcherId, pending)
      }
      return 'handled'
    }
    closeOwnerInterval(deps.budgetClock, runner)
    await applyAgnosticMove(deps, runner, pending, move)
    return 'handled'
  }

  closeOwnerInterval(deps.budgetClock, runner)

  // An owner intervention needs both the adapter action's native permission and owner authority.
  // Gate the untouched adapter action first so owner-intervention:on cannot bypass e.g. plan:off.
  const nativeVerdict = gateRunnerAction(runner, outcome.action, snapshot, ledger)
  if (nativeVerdict.verdict !== 'allow') {
    return handleActionGate(
      deps,
      runner,
      snapshot,
      ledger,
      deviation,
      pending,
      location,
      outcome.action,
      nativeVerdict
    )
  }

  const ownerAction = { ...outcome.action, capability: OWNER_INTERVENTION_CAPABILITY }
  const ownerVerdict = gateRunnerAction(runner, ownerAction, snapshot, ledger)
  if (ownerVerdict.verdict !== 'allow') {
    return handleActionGate(
      deps,
      runner,
      snapshot,
      ledger,
      deviation,
      pending,
      location,
      ownerAction,
      ownerVerdict
    )
  }

  const applied = await deps.actions.execute(runner, snapshot, ownerAction)
  if (applied) {
    resolveDeviation(deps.ledgerRecord, enrollment.watcherId, pending)
  }
  return 'handled'
}

async function handleUnreachable(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger,
  deviation: Deviation,
  pending: OwnerDeviationEscalation,
  location: OwnerReportLocation
): Promise<DriveOwnerDeviationOutcome> {
  const enrollment = runner.enrollment
  const decision = evaluateOwnerReachability({
    deviation: pending,
    ownerWokeAtMs: pending.atMs,
    nowMs: deps.ledgerRecord.now()
  })
  if (decision.action === 'wait') {
    return 'handled'
  }
  if (decision.action === 're-wake') {
    const rewoken = reRaiseDeviation(
      deps.ledgerRecord,
      enrollment.watcherId,
      pending,
      're-woken: no reply'
    )
    const failure = await sendOwnerBrief(
      deps,
      runner,
      snapshot,
      ledger,
      deviation,
      rewoken,
      location
    )
    if (failure) {
      return handOwnerDeviationToHuman(deps, runner, ledger, deviation, rewoken, failure)
    }
    markOwnerTurnSent(deps.ledgerRecord, enrollment.watcherId, rewoken)
    return 'handled'
  }
  closeOwnerInterval(deps.budgetClock, runner)
  escalateDeviationToHuman(deps.ledgerRecord, enrollment.watcherId, pending, decision.reason)
  if (!deviationIsDispatchScoped(deviation, runner, ledger)) {
    deps.park({
      kind: 'owner-escalation',
      escalationId: pending.escalationId,
      reason: decision.reason
    })
  }
  return 'handled'
}

async function handleActionGate(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger,
  deviation: Deviation,
  pending: OwnerDeviationEscalation,
  location: OwnerReportLocation,
  action: KernelAction,
  verdict: Exclude<GateVerdict, { verdict: 'allow' }>
): Promise<DriveOwnerDeviationOutcome> {
  if (verdict.verdict === 'hold' && verdict.reason === 'awaiting-approval' && verdict.escalation) {
    // The submitted report is the durable replay source. Persist/notify the ordinary scoped gate
    // hold, leave the deviation open, and keep the owner budget closed until that scope is approved.
    deps.actions.recordGateRejection(runner, action, verdict)
    return 'handled'
  }
  openOwnerInterval(deps.budgetClock, runner)
  return handleRejection(
    deps,
    runner,
    snapshot,
    ledger,
    deviation,
    pending,
    location,
    verdict.reason
  )
}

/** A rejected or malformed reply is re-raised once, then escalated — never looped. */
async function handleRejection(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger,
  deviation: Deviation,
  pending: OwnerDeviationEscalation,
  location: OwnerReportLocation,
  reason: string
): Promise<DriveOwnerDeviationOutcome> {
  const enrollment = runner.enrollment
  if (deviationRetriesExhausted(pending)) {
    closeOwnerInterval(deps.budgetClock, runner)
    escalateDeviationToHuman(deps.ledgerRecord, enrollment.watcherId, pending, reason)
    if (!deviationIsDispatchScoped(deviation, runner, ledger)) {
      deps.park({ kind: 'owner-escalation', escalationId: pending.escalationId, reason })
    }
    return 'handled'
  }
  const rewoken = reRaiseDeviation(deps.ledgerRecord, enrollment.watcherId, pending, reason)
  const failure = await sendOwnerBrief(
    deps,
    runner,
    snapshot,
    ledger,
    deviation,
    rewoken,
    location,
    reason
  )
  if (failure) {
    return handOwnerDeviationToHuman(deps, runner, ledger, deviation, rewoken, failure)
  }
  markOwnerTurnSent(deps.ledgerRecord, enrollment.watcherId, rewoken)
  return 'handled'
}

function handOwnerDeviationToHuman(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  ledger: WatcherLedger,
  deviation: Deviation,
  current: OwnerDeviationEscalation,
  reason: string
): DriveOwnerDeviationOutcome {
  const watcherId = runner.enrollment.watcherId
  closeOwnerInterval(deps.budgetClock, runner)
  clearOwnerSubmissionRejection(runner, current)
  escalateDeviationToHuman(deps.ledgerRecord, watcherId, current, reason)
  if (!deviationIsDispatchScoped(deviation, runner, ledger)) {
    deps.park({ kind: 'owner-escalation', escalationId: current.escalationId, reason })
  }
  return 'handled'
}

async function sendOwnerBrief(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger,
  deviation: Deviation,
  current: OwnerDeviationEscalation,
  location: OwnerReportLocation,
  rejectionReason?: string
): Promise<string | null> {
  const enrollment = runner.enrollment
  const owner = runner.kind.owner
  if (!owner || !enrollment.owner) {
    return null
  }
  const cachedRejection = rejectedOwnerSubmissions.get(runner)
  const previousSubmissionRejection =
    rejectionReason ??
    (cachedRejection?.escalationId === current.escalationId ? cachedRejection.reason : undefined)
  const brief = buildOwnerBrief({
    contentIdentity: snapshot.contentIdentity,
    snapshot,
    ledger,
    deviation,
    owner,
    ...(previousSubmissionRejection === undefined ? {} : { previousSubmissionRejection }),
    ...(current.humanReply === undefined ? {} : { operatorAnswer: current.humanReply.body })
  })
  if (!brief.fitsStateBudget) {
    return (
      `The owner brief was not sent because its minimum complete state envelope is ` +
      `${brief.serializedBytes} UTF-8 bytes, exceeding the ${OWNER_BRIEF_MAX_STATE_BYTES}-byte ` +
      'limit after all safe completed history was omitted. No oversized or incomplete reasoning request was dispatched.'
    )
  }
  const wakeToken = ownerDeviationWakeToken(current)
  const reportPath = await issueOwnerReportPath(location, wakeToken)
  const { runId } = await deps.owner.ensureRun(enrollment)
  const promptText = buildOwnerPromptText({
    watcherId: enrollment.watcherId,
    wakeToken,
    runId,
    interventionVocabulary: ownerInterventionVocabulary(deviation, owner),
    reportPath,
    brief
  })
  const session = await ensureOwnerSession({
    runtime: deps.owner.runtime,
    watcherId: enrollment.watcherId,
    worktreeId: workspaceRuntimeId(enrollment),
    owner: enrollment.owner,
    onJournalActivity: () => {}
  })
  await sendOwnerTurn({ session, turnText: promptText })
  if (cachedRejection?.escalationId === current.escalationId) {
    rejectedOwnerSubmissions.delete(runner)
  }
  return null
}

async function applyAgnosticMove(
  deps: DeviationRoutingDependencies,
  runner: WatcherRunner,
  pending: OwnerDeviationEscalation,
  move: Exclude<KindAgnosticIntervention, { kind: 'answer-worker' }>
): Promise<void> {
  const enrollment = runner.enrollment
  if (move.kind === 'stop-worker') {
    if (!runner.leaseGuard) {
      throw new Error('Owner worker stop reached a durable outcome without a lease')
    }
    await applyOwnerWorkerStop({
      watcherId: enrollment.watcherId,
      pending,
      move,
      ledgerRecord: deps.ledgerRecord,
      lease: runner.leaseGuard,
      stopWorker: deps.stopWorker
    })
    return
  }
  if (move.kind === 'continue') {
    resolveDeviation(deps.ledgerRecord, enrollment.watcherId, pending)
    return
  }
  let reason: string
  if (move.kind === 'message-worker') {
    const refusal = await applyOwnerWorkerMessage(deps, enrollment.watcherId, pending, move)
    if (refusal === null) {
      return
    }
    reason = refusal
  } else {
    reason = move.kind === 'ask-human' ? move.question : move.rationale
  }
  escalateDeviationToHuman(deps.ledgerRecord, enrollment.watcherId, pending, reason)
  const deviation = decodeOwnerDeviation(pending)
  const ledger = deps.ledgerRecord.ledgerStore.read(enrollment.watcherId)
  if (!deviation || !deviationIsDispatchScoped(deviation, runner, ledger)) {
    deps.park({ kind: 'owner-escalation', escalationId: pending.escalationId, reason })
  }
}

function openOwnerInterval(budgetClock: OwnerBudgetClock, runner: WatcherRunner): void {
  if (runner.ownerBudgetInterval) {
    return
  }
  runner.ownerBudgetInterval = budgetClock.open(runner.enrollment.watcherId, 'owner-in-flight')
}

function closeOwnerInterval(budgetClock: OwnerBudgetClock, runner: WatcherRunner): void {
  const current = runner.ownerBudgetInterval
  if (!current) {
    return
  }
  budgetClock.close(current, 'settled')
  runner.ownerBudgetInterval = null
}
