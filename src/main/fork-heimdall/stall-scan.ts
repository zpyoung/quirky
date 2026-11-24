import type { StallDeviation } from '../../shared/fork-heimdall/owner/deviation'
import { clipWorkerLastMessage } from '../../shared/fork-heimdall/owner/worker-last-message'
import { HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import type {
  HeimdallOrchestrationAdapter,
  WorkerIdleObservation
} from './orchestration/orchestration-adapter'
import { recordDeviation } from './owner/deviation-ledger'
import { deviationIsDispatchScoped } from './owner/deviation-scope'
import {
  detectIdleStall,
  idleStallCandidateDispatchIds,
  type IdleStall
} from './owner/idle-worker-detector'
import { looksLikeProseQuestion } from './owner/prose-question'
import { detectStall } from './owner/stall-detector'
import type { WatcherRunnerStatusLifecycle } from './runner-status'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'
import { appendWorkerEscalation } from './worker-escalation-record'

export const WORKER_IDLE_OBSERVATION = 'worker-idle'
const PARK_EXCERPT_MAX_BYTES = 1_024

export type StallCauseInput = {
  dispatchId: string
  activity: 'waiting' | 'done'
  lastMessage: string | null
}

/** Records a shadow judgment of why a worker went idle; never awaited, never acted on. */
export type StallCauseJudgePort = {
  consider(enrollment: WatcherEnrollment, input: StallCauseInput): void
}

export type StallScanDependencies = {
  ledgerStore: RunnerLedgerStore
  orchestration: Pick<HeimdallOrchestrationAdapter, 'observeWorkerIdle'>
  dispatchLifecycle: Pick<WatcherLedgerLifecycle, 'pauseWorker'>
  statusLifecycle: Pick<WatcherRunnerStatusLifecycle, 'parkForWorkerEscalation'>
  schedule(runner: WatcherRunner, delayMs: number): void
  now(): number
  createId(): string
  stallCause?: StallCauseJudgePort
}

/**
 * Notices workers that stopped making progress: fast, for a worker idle at its prompt past the
 * grace window, and slow, for a dispatch whose mailbox stayed silent past the stall threshold.
 * Owned watchers record a stall deviation for the owner; ownerless ones park for a human when the
 * worker's last message is a question it asked in prose.
 */
export async function runStallScan(
  dependencies: StallScanDependencies,
  runner: WatcherRunner
): Promise<void> {
  runner.idleRecheckAtMs = null
  const enrollment = runner.enrollment
  const owned = enrollment.owner !== undefined
  if (enrollment.paused || (!owned && !enrollment.enabled)) {
    return
  }
  const watcherId = enrollment.watcherId
  const observations = new Map<string, WorkerIdleObservation>()
  for (const dispatchId of idleStallCandidateDispatchIds(
    dependencies.ledgerStore.read(watcherId)
  )) {
    observations.set(
      dispatchId,
      await dependencies.orchestration.observeWorkerIdle(enrollment, dispatchId)
    )
  }
  if (observations.size > 0) {
    await runner.leaseGuard?.assertHeld()
  }
  const nowMs = dependencies.now()
  const idle = detectIdleStall({
    ledger: dependencies.ledgerStore.read(watcherId),
    nowMs,
    observations
  })
  runner.idleRecheckAtMs = idle.recheckInMs === null ? null : nowMs + idle.recheckInMs
  for (const detected of idle.stalls) {
    dependencies.stallCause?.consider(enrollment, {
      dispatchId: detected.stall.dispatchId,
      activity: detected.observation.activity,
      lastMessage: detected.observation.lastMessage?.text ?? null
    })
    if (owned) {
      recordDeviation(dependencies, watcherId, detected.stall)
    } else {
      routeOwnerlessIdle(dependencies, runner, detected)
    }
  }
  if (!owned) {
    return
  }
  const silent = detectStall(dependencies.ledgerStore.read(watcherId), nowMs)
  if (silent) {
    recordDeviation(dependencies, watcherId, withLastMessage(silent, observations))
  }
}

function withLastMessage(
  stall: StallDeviation,
  observations: ReadonlyMap<string, WorkerIdleObservation>
): StallDeviation {
  const observation = observations.get(stall.dispatchId)
  const lastMessage = observation?.status === 'idle' ? observation.lastMessage : null
  return lastMessage?.text
    ? { ...stall, lastMessage: lastMessage.text, messageTruncated: lastMessage.truncated }
    : stall
}

function routeOwnerlessIdle(
  dependencies: StallScanDependencies,
  runner: WatcherRunner,
  { stall, observation }: IdleStall
): void {
  const watcherId = runner.enrollment.watcherId
  const message = observation.lastMessage?.text ?? null
  if (!message || !looksLikeProseQuestion(message)) {
    recordIdleObservation(dependencies, watcherId, stall, observation)
    return
  }
  const messageId = `prose-question:${observation.idleSinceMs}`
  const reason = `Worker asked a question in prose instead of quirky ask: ${
    clipWorkerLastMessage(message, PARK_EXCERPT_MAX_BYTES).text
  }`
  const escalationId = appendWorkerEscalation(dependencies, watcherId, {
    messageId,
    dispatchId: stall.dispatchId,
    reason
  })
  if (!escalationId) {
    return
  }
  dependencies.dispatchLifecycle.pauseWorker(watcherId, stall.dispatchId)
  if (deviationIsDispatchScoped(stall, runner, dependencies.ledgerStore.read(watcherId))) {
    return
  }
  dependencies.statusLifecycle.parkForWorkerEscalation(runner, escalationId, reason, messageId)
  dependencies.schedule(runner, HEIMDALL_RAPID_POLL_MS)
}

function recordIdleObservation(
  dependencies: StallScanDependencies,
  watcherId: string,
  stall: StallDeviation,
  observation: Extract<WorkerIdleObservation, { status: 'idle' }>
): void {
  const detail = JSON.stringify({
    dispatchId: stall.dispatchId,
    idleSinceMs: observation.idleSinceMs,
    activity: observation.activity
  })
  const recorded = dependencies.ledgerStore
    .read(watcherId)
    .entries.some(
      (entry) =>
        entry.kind === 'client-observation' &&
        entry.what === WORKER_IDLE_OBSERVATION &&
        entry.detail === detail
    )
  if (recorded) {
    return
  }
  dependencies.ledgerStore.append(watcherId, {
    eventId: dependencies.createId(),
    watcherId,
    atMs: dependencies.now(),
    origin: 'client',
    class: 'observation',
    kind: 'client-observation',
    what: WORKER_IDLE_OBSERVATION,
    detail
  })
}
