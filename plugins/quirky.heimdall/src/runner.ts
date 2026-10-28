import { createHash, randomUUID } from 'node:crypto'
import type {
  Attempt,
  BudgetUsage,
  Decision,
  DispatchResult,
  Enrollment,
  ExecuteContext,
  ExecuteResult,
  GateVerdict,
  JournalAppend,
  JournalEntry,
  Json,
  KernelAction,
  KernelWorkerObservation,
  OrchestrationPort,
  ParkReason,
  PacingTier,
  Runner,
  RunnerOptions,
  RunnerStatus,
  Snapshot,
  StopResult,
  TerminalSummary,
  TickTrace,
  WatcherKind,
  WorkerMessage,
  WorkerRequest
} from './contracts'
import { ACTIVE_TIME_CHECKPOINT_MS, ACTIVE_TIME_SAMPLE_MS, budgetGeneration, budgetUsage, openBudgetIntervals, type OpenBudgetInterval } from './budget'
import { actionFingerprint, gateAction } from './gate'
import { FULL_RESYNC_INTERVAL_MS, pacingDelay } from './pacing'
import { isCoordinatorSeatLostError } from './worker-evidence'

const MAX_ACTIONS_PER_TICK = 32
const DEFAULT_SHUTDOWN_MS = 1_500

type Timer = ReturnType<typeof setTimeout>
type IntervalTimer = ReturnType<typeof setInterval>
type WorkerDispatchState = { result: DispatchResult; requestId: string; request: WorkerRequest }
type LiveWorkerObservation = KernelWorkerObservation & {
  state: 'live'
  sessionId: string
  processIncarnation: string
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
function hasLiveWorkerIdentity(
  observation: KernelWorkerObservation | null | undefined
): observation is LiveWorkerObservation {
  return observation?.state === 'live' &&
    typeof observation.sessionId === 'string' && observation.sessionId.length > 0 &&
    typeof observation.processIncarnation === 'string' && observation.processIncarnation.length > 0
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function latestAttempts(journal: JournalEntry[]): Attempt[] {
  const byId = new Map<string, Attempt>()
  for (const entry of journal) {
    if (entry.kind === 'attempt' && typeof entry.attemptId === 'string') byId.set(entry.attemptId, entry as Attempt)
  }
  return [...byId.values()]
}

function unresolvedAttempt(attempt: Attempt): boolean {
  return attempt.state !== 'settled' || attempt.effect === 'indeterminate'
}

function hasUnresolvedAttempts(journal: JournalEntry[]): boolean {
  return latestAttempts(journal).some(unresolvedAttempt)
}
function hasUnresolvedExternalAttempt(journal: JournalEntry[], ignoreAttemptId?: string): boolean {
  return latestAttempts(journal).some((attempt) =>
    attempt.attemptId !== ignoreAttemptId &&
    attempt.action.visibility === 'external' &&
    unresolvedAttempt(attempt)
  )
}


function currentStatus(enrollment: Enrollment | null, nextPulseAtMs: number | null): RunnerStatus {
  const common = { nextPulseAtMs, consecutiveErrors: 0, consecutiveGateHolds: 0 }
  if (!enrollment) return { ...common, state: 'disabled', reason: 'not-current' }
  if (enrollment.malformed) return { ...common, state: 'malformed', reason: 'malformed', detail: enrollment.malformed }
  if (enrollment.terminalAtMs !== null) return { ...common, state: 'terminal', reason: enrollment.haltReason ?? 'terminal' }
  if (enrollment.parkReason !== null) return { ...common, state: 'parked', reason: enrollment.parkReason, detail: enrollment.haltReason ?? undefined }
  if (!enrollment.enabled) return { ...common, state: 'disabled', reason: enrollment.haltReason ?? 'disabled' }
  if (enrollment.paused) return { ...common, state: 'held', reason: 'paused' }
  return { ...common, state: 'watching' }
}

function latestByEventId(journal: JournalEntry[], eventId: string): JournalEntry | undefined {
  return journal.find((entry) => entry.eventId === eventId)
}

function latestEscalation(journal: JournalEntry[], escalationId: string): JournalEntry | undefined {
  for (let index = journal.length - 1; index >= 0; index--) {
    const entry = journal[index]!
    if (entry.kind === 'escalation' && entry.escalationId === escalationId) return entry
  }
  return undefined
}

function budgetWithPolicy(enrollment: Enrollment, journal: JournalEntry[], nowMs: number): BudgetUsage {
  return budgetUsage(journal, nowMs, enrollment.budget)
}

function workerRequestId(fingerprint: string): string {
  const digest = createHash('sha256').update(`heimdall-dispatch-v1\0${fingerprint}`).digest()
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createRunner(options: RunnerOptions): Runner & { withControl<T>(operation: () => Promise<T>, drain?: boolean): Promise<T> } {
  const { store, registry, orchestration } = options
  const watcherId = options.enrollment.watcherId
  const now = options.now ?? Date.now
  let enrollment: Enrollment | null = store.get(watcherId) ?? options.enrollment
  let statusValue = currentStatus(enrollment, null)
  let timer: Timer | null = null
  let budgetTimer: IntervalTimer | null = null
  let activePulse: Promise<void> | null = null
  let pulseAgain = false
  let stopped = false
  let suspended = false
  let lifecycleVersion = 0
  let recoveryPending = true
  let controlGeneration = 0
  let tickControlGeneration: number | null = null
  let controlPendingCount = 0
  let controlTail: Promise<void> = Promise.resolve()
  let forceFullResync = true
  let lastLiveReadAtMs: number | null = null
  let consecutiveErrors = 0
  let consecutiveGateHolds = 0
  let activeAbort: AbortController | null = null
  let recoveringThisTick = false
  const lastWorkerProofAtMs = new Map<string, number>()

  function changed(): void {
    try { options.onChanged?.(watcherId) } catch { /* Observers cannot change runner outcomes. */ }
  }

  function isCurrent(version: number): boolean {
    return !stopped && !suspended && version === lifecycleVersion &&
      (tickControlGeneration === null || tickControlGeneration === controlGeneration)
  }

  function isTickCurrent(version: number): boolean {
    return isCurrent(version)
  }

  function withControl<T>(operation: () => Promise<T>, drain = true): Promise<T> {
    if (stopped || store.readOnly) return Promise.reject(new Error('Runner is shut down or read-only.'))
    controlPendingCount += 1
    clearScheduledTimer()
    if (!drain) controlGeneration += 1
    const run = controlTail.then(async () => {
      try {
        if (drain) await activePulse?.catch(() => undefined)
        if (stopped) throw new Error('Runner is shut down.')
        return await operation()
      } finally {
        controlPendingCount -= 1
        controlGeneration += 1
        if (controlPendingCount === 0) schedule(0)
      }
    })
    controlTail = run.then(() => undefined, () => undefined)
    return run
  }


  function updateStatus(state: RunnerStatus['state'], reason?: string, detail?: string): void {
    statusValue = {
      state,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
      nextPulseAtMs: statusValue.nextPulseAtMs,
      consecutiveErrors,
      consecutiveGateHolds
    }
    changed()
  }

  function clearScheduledTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    statusValue = { ...statusValue, nextPulseAtMs: null }
  }

  function clearBudgetTimer(): void {
    if (budgetTimer !== null) clearInterval(budgetTimer)
    budgetTimer = null
  }

  function schedule(delayMs: number): void {
    if (stopped || suspended || store.readOnly || controlPendingCount > 0 || statusValue.state === 'terminal') return
    clearScheduledTimer()
    const delay = Math.max(0, delayMs)
    const nextPulseAtMs = now() + delay
    statusValue = { ...statusValue, nextPulseAtMs }
    timer = setTimeout(() => {
      timer = null
      void pulse()
    }, delay)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    changed()
  }

  function appendEntry(
    entry: JournalAppend,
    version: number,
    options: { allowFenced?: boolean; idempotent?: boolean } = {}
  ): JournalEntry | null {
    if (store.readOnly || (!options.allowFenced && !isTickCurrent(version))) return null
    if (!options.allowFenced) {
      const current = store.get(watcherId)
      if (!current || (current.terminalAtMs !== null && entry.kind !== 'terminal')) return null
    }
    const journal = store.journal(watcherId)
    if (options.idempotent && entry.eventId && latestByEventId(journal, entry.eventId)) {
      return latestByEventId(journal, entry.eventId) ?? null
    }
    const saved = store.append(watcherId, { ...entry, atMs: entry.atMs ?? now() })
    changed()
    return saved
  }

  function attemptRevision(
    previous: Attempt | undefined,
    values: {
      attemptId: string
      fingerprint: string
      action: KernelAction
      state: Attempt['state']
      generation: string
      eventId: string
      resolved: boolean
      effect?: ExecuteResult['effect']
      reason?: string
      workerRequest?: WorkerRequest
      requestId?: string
      dispatchId?: string
      clearEffect?: boolean
      clearReason?: boolean
      [key: string]: unknown
    },
    version: number
  ): Attempt | null {
    const retained = previous ? {
      ...(previous.effect !== undefined && values.clearEffect !== true ? { effect: previous.effect } : {}),
      ...(previous.reason !== undefined && values.clearReason !== true ? { reason: previous.reason } : {}),
      ...(previous.workerRequest !== undefined ? { workerRequest: previous.workerRequest } : {}),
      ...(previous.requestId !== undefined ? { requestId: previous.requestId } : {}),
      ...(previous.dispatchId !== undefined ? { dispatchId: previous.dispatchId } : {}),
      ...(previous.failureClass !== undefined ? { failureClass: previous.failureClass } : {}),
      ...(previous.expectedAfter !== undefined ? { expectedAfter: previous.expectedAfter } : {})
    } : {}
    const payload = { ...retained, ...values }
    const saved = appendEntry({
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: values.resolved,
      eventId: values.eventId,
      atMs: now(),
      attemptId: values.attemptId,
      fingerprint: values.fingerprint,
      action: values.action,
      state: values.state,
      generation: values.generation,
      ...(payload.effect !== undefined ? { effect: payload.effect } : {}),
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      ...(payload.workerRequest !== undefined ? { workerRequest: payload.workerRequest } : {}),
      ...(payload.requestId !== undefined ? { requestId: payload.requestId } : {}),
      ...(payload.dispatchId !== undefined ? { dispatchId: payload.dispatchId } : {}),
      ...(payload.failureClass !== undefined ? { failureClass: payload.failureClass } : {}),
      ...(payload.expectedAfter !== undefined ? { expectedAfter: payload.expectedAfter } : {}),
      ...(typeof payload.replayCount === 'number' ? { replayCount: payload.replayCount } : {})
    }, version, { idempotent: true })
    return saved as Attempt | null
  }

  function openInterval(cause: string, version: number, attemptId?: string): string | null {
    const intervalId = randomUUID()
    const journal = store.journal(watcherId)
    const generation = budgetGeneration(journal, watcherId)
    const saved = appendEntry({
      kind: 'interval-open',
      class: 'fact',
      origin: 'owner',
      resolved: true,
      eventId: `interval-open:${intervalId}`,
      intervalId,
      cause,
      generation,
      ...(attemptId ? { attemptId } : {})
    }, version)
    if (!saved) return null
    ensureBudgetTimer()
    return intervalId
  }

  function closeInterval(intervalId: string, reason: string, checkpointAtMs: number, version: number, allowFenced = false): void {
    const journal = store.journal(watcherId)
    const opened = openBudgetIntervals(journal).find((interval) => interval.intervalId === intervalId)
    if (!opened) return
    const saved = appendEntry({
      kind: 'interval-close',
      class: 'fact',
      origin: 'owner',
      resolved: true,
      eventId: `interval-close:${intervalId}`,
      intervalId,
      generation: opened.generation,
      reason,
      checkpointAtMs: Math.max(opened.openedAtMs, checkpointAtMs)
    }, version, { allowFenced, idempotent: true })
    if (saved) lastWorkerProofAtMs.delete(intervalId)
  }

  function closeAttemptIntervals(attemptId: string, reason: string, atMs: number, version: number): void {
    const journal = store.journal(watcherId)
    const open = openBudgetIntervals(journal)
    for (const interval of open) {
      if (interval.attemptId === attemptId) closeInterval(interval.intervalId, reason, atMs, version)
    }
  }

  function checkpointIntervals(force: boolean, version: number, closeReason?: string, closeAtMs?: number, allowFenced = false): void {
    if (store.readOnly || (!allowFenced && !isCurrent(version))) return
    const currentTime = closeAtMs ?? now()
    const journal = store.journal(watcherId)
    for (const interval of openBudgetIntervals(journal)) {
      if (closeReason) {
        const checkpointAtMs = closeReason === 'contact-lost'
          ? interval.cause === 'worker-dispatched'
            ? Math.max(interval.checkpointAtMs, lastWorkerProofAtMs.get(interval.intervalId) ?? interval.checkpointAtMs)
            : interval.checkpointAtMs
          : currentTime
        closeInterval(interval.intervalId, closeReason, checkpointAtMs, version, allowFenced)
        continue
      }
      if (interval.cause === 'worker-dispatched') {
        if (!force && currentTime - interval.checkpointAtMs < ACTIVE_TIME_CHECKPOINT_MS) continue
        if (currentTime <= interval.checkpointAtMs) continue
        const lastPositiveAtMs = lastWorkerProofAtMs.get(interval.intervalId) ?? interval.checkpointAtMs
        checkpointWorkerInterval(
          interval.intervalId,
          interval.generation,
          interval.checkpointAtMs,
          Math.min(currentTime, lastPositiveAtMs),
          version,
          allowFenced
        )
        continue
      }
      if (!force && currentTime - interval.checkpointAtMs < ACTIVE_TIME_CHECKPOINT_MS) continue
      if (currentTime <= interval.checkpointAtMs) continue
      appendEntry({
        kind: 'interval-checkpoint',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: `interval-checkpoint:${interval.intervalId}:${currentTime}`,
        intervalId: interval.intervalId,
        generation: interval.generation,
        checkpointAtMs: currentTime
      }, version, { allowFenced, idempotent: true })
    }
    if (openBudgetIntervals(store.journal(watcherId)).length === 0) clearBudgetTimer()
  }

  function ensureBudgetTimer(): void {
    if (budgetTimer !== null || stopped || suspended) return
    budgetTimer = setInterval(() => {
      try {
        checkpointIntervals(false, lifecycleVersion)
      } catch (error) {
        if (!stopped && !suspended) {
          recoveryPending = true
          consecutiveErrors += 1
          updateStatus('held', 'tick-error', errorText(error))
          schedule(pacingDelay({
            tier: 'idle',
            nowMs: now(),
            lastLiveReadAtMs,
            consecutiveErrors,
            consecutiveGateHolds
          }) ?? 30_000)
        }
      }
    }, ACTIVE_TIME_SAMPLE_MS)
    ;(budgetTimer as unknown as { unref?: () => void }).unref?.()
  }

  function appendResolution(attempt: Attempt, result: ExecuteResult, evidence: Record<string, unknown>, version: number): void {
    if (!isCurrent(version)) return
    const journal = store.journal(watcherId)
    const latest = latestAttempts(journal).find((entry) => entry.attemptId === attempt.attemptId) ?? attempt
    const saved = attemptRevision(latest, {
      attemptId: attempt.attemptId,
      fingerprint: attempt.fingerprint,
      action: attempt.action,
      state: 'settled',
      generation: typeof latest.generation === 'string' ? latest.generation : budgetGeneration(journal, watcherId),
      eventId: `attempt:${attempt.attemptId}:settled:${result.effect}`,
      resolved: result.effect !== 'indeterminate',
      effect: result.effect,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.expectedAfter !== undefined ? { expectedAfter: result.expectedAfter } : {}),
      ...(result.failureClass ? { failureClass: result.failureClass } : {})
    }, version)
    if (!saved) return
    const resolutionEvidence = latest.effect === 'indeterminate' ||
      evidence.source === 'kind-live-resolution' ||
      evidence.source === 'worker-mailbox' ||
      evidence.source === 'local-replay'
    if (result.effect === 'indeterminate' || !resolutionEvidence) return
    appendEntry({
      kind: 'attempt-resolved',
      class: 'fact',
      origin: 'owner',
      resolved: true,
      eventId: `attempt-resolved:${attempt.attemptId}`,
      attemptId: attempt.attemptId,
      fingerprint: attempt.fingerprint,
      effect: result.effect,
      ...evidence
    }, version, { idempotent: true })
  }

  function recordTurn(attempt: Attempt, dispatchId: string, version: number): void {
    const eventId = `turn:${watcherId}:${dispatchId}`
    if (latestByEventId(store.journal(watcherId), eventId)) return
    appendEntry({
      kind: 'turn',
      class: 'fact',
      origin: 'owner',
      resolved: true,
      eventId,
      dispatchId,
      attemptId: attempt.attemptId,
      generation: typeof attempt.generation === 'string' ? attempt.generation : budgetGeneration(store.journal(watcherId), watcherId)
    }, version)
  }


  function noteWorkerIntervalProof(intervalId: string, observedAtMs: number): void {
    const previous = lastWorkerProofAtMs.get(intervalId)
    if (previous === undefined || observedAtMs > previous) lastWorkerProofAtMs.set(intervalId, observedAtMs)
  }

  function checkpointWorkerInterval(
    intervalId: string,
    generation: string,
    previousCheckpointAtMs: number,
    checkpointAtMs: number,
    version: number,
    allowFenced = false
  ): void {
    if (checkpointAtMs <= previousCheckpointAtMs) return
    appendEntry({
      kind: 'interval-checkpoint',
      class: 'fact',
      origin: 'owner',
      resolved: true,
      eventId: `interval-checkpoint:${intervalId}:${checkpointAtMs}`,
      intervalId,
      generation,
      checkpointAtMs
    }, version, { allowFenced, idempotent: true })
  }

  function reconcileWorkerObservations(observations: KernelWorkerObservation[], version: number): void {
    if (!isCurrent(version) || store.readOnly) return
    const journal = store.journal(watcherId)
    const workerIntervalsByAttempt = new Map<string, OpenBudgetInterval[]>()
    for (const interval of openBudgetIntervals(journal)) {
      if (interval.cause !== 'worker-dispatched' || !interval.attemptId) continue
      const intervals = workerIntervalsByAttempt.get(interval.attemptId)
      if (intervals) intervals.push(interval)
      else workerIntervalsByAttempt.set(interval.attemptId, [interval])
    }
    const byDispatchId = new Map<string, KernelWorkerObservation | null>()
    for (const observation of observations) {
      if (byDispatchId.has(observation.dispatchId)) {
        byDispatchId.set(observation.dispatchId, null)
      } else {
        byDispatchId.set(observation.dispatchId, observation)
      }
    }
    const generation = budgetGeneration(journal, watcherId)
    const contactProblems: string[] = []
    const inactiveAssignments: string[] = []
    for (const attempt of latestAttempts(journal).filter((candidate) =>
      candidate.state === 'running' && candidate.dispatchId && unresolvedAttempt(candidate)
    )) {
      if (!isCurrent(version)) return
      const dispatchId = attempt.dispatchId
      if (!dispatchId) continue
      const observation = byDispatchId.get(dispatchId)
      const intervals = workerIntervalsByAttempt.get(attempt.attemptId) ?? []
      const liveObservation = hasLiveWorkerIdentity(observation) ? observation : null
      if (liveObservation?.assignmentActive === true) {
        const currentInterval = intervals.find((interval) => interval.generation === generation)
        for (const interval of intervals) {
          if (interval === currentInterval) continue
          closeInterval(
            interval.intervalId,
            interval.generation === generation ? 'worker-interval-superseded' : 'generation-reset',
            interval.checkpointAtMs,
            version
          )
        }
        const observedAtMs = now()
        if (currentInterval) {
          noteWorkerIntervalProof(currentInterval.intervalId, observedAtMs)
        } else {
          const intervalId = openInterval('worker-dispatched', version, attempt.attemptId)
          if (intervalId) noteWorkerIntervalProof(intervalId, observedAtMs)
        }
        continue
      }

      const assignmentInactive = liveObservation?.assignmentActive === false
      const state = assignmentInactive
        ? 'assignment-inactive'
        : observation === undefined ? 'missing' : observation === null ? 'duplicate' : observation.state
      if (assignmentInactive) inactiveAssignments.push(dispatchId)
      else contactProblems.push(dispatchId)
      for (const interval of intervals) {
        const lastPositiveAtMs = Math.max(
          interval.checkpointAtMs,
          lastWorkerProofAtMs.get(interval.intervalId) ?? interval.checkpointAtMs
        )
        closeInterval(
          interval.intervalId,
          assignmentInactive ? 'worker-assignment-inactive' : state === 'exited' ? 'worker-exited' : 'contact-lost',
          lastPositiveAtMs,
          version
        )
      }
      const evidenceKind = assignmentInactive ? 'worker-assignment-inactive' : 'worker-contact-unverifiable'
      appendEntry({
        kind: 'evidence',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: `${evidenceKind}:${attempt.attemptId}:${dispatchId}:${state}`,
        evidenceKind,
        payload: {
          attemptId: attempt.attemptId,
          dispatchId,
          state: observation === undefined ? 'missing' : observation === null ? 'duplicate' : observation.state,
          assignmentActive: observation?.assignmentActive ?? null,
          observedAtMs: now()
        }
      }, version, { idempotent: true })


    }
    if (!isCurrent(version)) return
    const current = store.get(watcherId)
    if (contactProblems.length > 0) {
      if (current?.enabled && !current.paused && current.parkReason === null) {
        updateStatus(
          'held',
          'worker-contact-unverifiable',
          `Current liveness is not verifiable for dispatches: ${contactProblems.join(', ')}.`
        )
      }
    } else if (inactiveAssignments.length > 0) {
      if (current?.enabled && !current.paused && current.parkReason === null) {
        updateStatus(
          'held',
          'worker-assignment-inactive',
          `Live workers are no longer active supervised assignments: ${inactiveAssignments.join(', ')}.`
        )
      }
    } else if (
      (statusValue.reason === 'worker-contact-unverifiable' || statusValue.reason === 'worker-assignment-inactive') &&
      current
    ) {
      statusValue = latestStatusFromJournal(current, store.journal(watcherId))
      changed()
    }
  }

  function applyDispatchResult(attempt: Attempt, result: DispatchResult, version: number, recovery: boolean): Attempt | null {
    if (!isCurrent(version)) return null
    const latest = latestAttempts(store.journal(watcherId)).find((entry) => entry.attemptId === attempt.attemptId) ?? attempt
    if (result.kind === 'dispatched') {
      const atMs = now()
      const dispatched = attemptRevision(latest, {
        attemptId: latest.attemptId,
        fingerprint: latest.fingerprint,
        action: latest.action,
        state: 'running',
        generation: typeof latest.generation === 'string' ? latest.generation : budgetGeneration(store.journal(watcherId), watcherId),
        eventId: `attempt:${latest.attemptId}:dispatch:${result.dispatchId}`,
        resolved: false,
        requestId: latest.requestId,
        workerRequest: latest.workerRequest,
        dispatchId: result.dispatchId,
        clearEffect: true,
        clearReason: true
      }, version)
      if (!dispatched) return null
      if (!recovery) {
        const actionInterval = openBudgetIntervals(store.journal(watcherId)).find((interval) =>
          interval.attemptId === latest.attemptId && interval.cause === 'action-in-flight'
        )
        if (actionInterval) closeInterval(actionInterval.intervalId, 'settled', atMs, version)
      }
      recordTurn(dispatched, result.dispatchId, version)
      return latestAttempts(store.journal(watcherId)).find((entry) => entry.attemptId === latest.attemptId) ?? dispatched
    }
    if (result.kind === 'refused') {
      appendResolution(latest, { effect: 'not-landed', reason: result.reason }, { source: 'orchestration-refused' }, version)
      closeAttemptIntervals(latest.attemptId, 'settled', now(), version)
      return latestAttempts(store.journal(watcherId)).find((entry) => entry.attemptId === latest.attemptId) ?? null
    }
    return latest
  }

  function park(
    _current: Enrollment,
    reason: ParkReason,
    detail: string,
    version: number,
    source?: { escalationId: string; messageId: string }
  ): Enrollment | null {
    if (!isTickCurrent(version) || store.readOnly || controlPendingCount > 0) return null
    const latest = store.get(watcherId)
    if (!latest || latest.terminalAtMs !== null) return null
    if (!latest.enabled && latest.parkReason === reason && latest.haltReason === detail) {
      updateStatus('parked', reason, detail)
      return latest
    }
    const escalationId = `park-${reason}`
    const journal = store.journal(watcherId)
    const prior = latestEscalation(journal, escalationId)
    const foldCount = typeof prior?.foldCount === 'number' ? prior.foldCount + 1 : 1
    const next: Enrollment = {
      ...latest,
      enabled: false,
      parkReason: reason,
      haltReason: detail
    }
    store.transaction(() => {
      store.save(next)
      const eventId = `park-escalation:${watcherId}:${escalationId}:${foldCount}`
      if (!latestByEventId(store.journal(watcherId), eventId)) {
        store.append(watcherId, {
          kind: 'escalation',
          class: 'fact',
          origin: 'owner',
          resolved: false,
          eventId,
          atMs: now(),
          escalationId,
          escalationKind: reason,
          status: 'open',
          foldCount,
          reason,
          detail,
          ...(source ? { sourceEscalationId: source.escalationId, sourceMessageId: source.messageId } : {})
        })
      }
    })
    enrollment = next
    updateStatus('parked', reason, detail)
    return next
  }

  function parkCoordinatorSeatLost(detail: string, version: number): void {
    if (!isCurrent(version) || store.readOnly) return
    recoveryPending = true
    try {
      checkpointIntervals(true, version, 'contact-lost')
    } catch (error) {
      options.context.log(`active-time close failed during coordinator seat loss: ${errorText(error)}`)
    }
    const current = store.get(watcherId)
    if (!current) return
    for (const attempt of latestAttempts(store.journal(watcherId)).filter((candidate) =>
      candidate.action.visibility === 'external' && unresolvedAttempt(candidate)
    )) {
      try {
        appendResolution(attempt, { effect: 'indeterminate', reason: detail }, { source: 'orchestration-unknown' }, version)
      } catch (error) {
        options.context.log(`could not persist coordinator-fenced attempt uncertainty: ${errorText(error)}`)
      }
    }
    park(current, 'coordinator-seat-lost', detail, version)
  }

  function approvalEscalation(action: KernelAction, detail: string | undefined, version: number): void {
    const scope = {
      actionKind: action.kind,
      contentIdentity: action.contentIdentity,
      evidenceKey: action.evidenceKey,
      ...(typeof action.preparedCommitSha === 'string' ? { preparedCommitSha: action.preparedCommitSha } : {})
    }
    const escalationId = `approval:${hash(JSON.stringify(scope))}`
    const journal = store.journal(watcherId)
    const previous = latestEscalation(journal, escalationId)
    const foldCount = typeof previous?.foldCount === 'number' ? previous.foldCount + 1 : 1
    const eventId = `approval-escalation:${watcherId}:${hash(JSON.stringify(scope))}:${foldCount}`
    if (latestByEventId(journal, eventId)) return
    appendEntry({
      kind: 'escalation',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId,
      escalationId,
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount,
      approvalScope: scope,
      reason: 'awaiting-approval',
      ...(detail ? { detail } : {})
    }, version)
  }

  function abandon(
    action: KernelAction,
    reason: string,
    detail: string | undefined,
    version: number,
    extra: Record<string, unknown> = {}
  ): void {
    const fingerprint = actionFingerprint(action)
    const eventId = `attempt-abandoned:${watcherId}:${hash(fingerprint)}:${reason}`
    appendEntry({
      kind: 'attempt-abandoned',
      class: 'observation',
      origin: 'owner',
      resolved: true,
      eventId,
      fingerprint,
      reason,
      ...(detail ? { detail } : {}),
      ...extra
    }, version, { idempotent: true })
  }

  async function recordGate(
    action: KernelAction,
    verdict: GateVerdict,
    version: number,
    trace: TickTrace
  ): Promise<void> {
    trace.gate = verdict
    if (verdict.verdict === 'allow') return
    const detail = verdict.verdict === 'allow' ? undefined : verdict.detail
    abandon(action, 'gate-hold', detail ?? verdict.reason, version, {
      gateReason: verdict.reason,
      ...(detail ? { gateDetail: detail } : {})
    })
    if (verdict.reason === 'awaiting-approval') approvalEscalation(action, detail, version)
    const fingerprint = actionFingerprint(action)
    appendEntry({
      kind: 'evidence',
      class: 'fact',
      origin: 'owner',
      resolved: true,
      eventId: `action-gate:${watcherId}:${hash(fingerprint)}:${hash(verdict.reason)}`,
      evidenceKind: 'action-gate',
      payload: {
        fingerprint,
        verdict: verdict.verdict,
        reason: verdict.reason,
        ...(detail ? { detail } : {})
      }
    }, version, { idempotent: true })
    consecutiveGateHolds += 1
    if (verdict.verdict === 'escalate' || verdict.reason === 'awaiting-approval') {
      updateStatus('escalated', verdict.reason, detail)
      trace.exitPath = 'gate-escalated'
    } else {
      const pendingAttemptGate = verdict.reason === 'attempt-in-flight' || verdict.reason === 'unresolved-attempt'
      const workerEvidenceHold = statusValue.state === 'held' &&
        (statusValue.reason === 'worker-contact-unverifiable' || statusValue.reason === 'worker-assignment-inactive')
      if (!(pendingAttemptGate && workerEvidenceHold)) updateStatus('held', verdict.reason, detail)
      trace.exitPath = 'gate-held'
    }
  }


  function commitGate(
    action: KernelAction,
    snapshot: Snapshot,
    stopFired: boolean,
    version: number,
    ignoreAttemptId?: string
  ): { enrollment: Enrollment; journal: JournalEntry[]; budget: BudgetUsage; verdict: GateVerdict } | null {
    if (!isCurrent(version) || controlPendingCount > 0 || store.readOnly) return null
    const latest = store.get(watcherId)
    if (!latest || latest.terminalAtMs !== null) return null
    const journal = store.journal(watcherId)
    const budget = budgetWithPolicy(latest, journal, now())
    const verdict = gateAction({ action, snapshot, enrollment: latest, journal, budget, stopPredicateFired: stopFired, ignoreAttemptId })
    return { enrollment: latest, journal, budget, verdict }
  }


  function saveTerminal(_current: Enrollment, result: Extract<StopResult, { kind: 'terminal' }>, trace: TickTrace, version: number): TerminalSummary | null {
    if (!isTickCurrent(version) || controlPendingCount > 0 || store.readOnly) return null
    const latest = store.get(watcherId)
    if (!latest || latest.terminalAtMs !== null) return null
    const atMs = now()
    const next = { ...latest, enabled: false, terminalAtMs: atMs, haltReason: result.reason }
    store.transaction(() => {
      store.save(next)
      appendEntry({
        kind: 'terminal',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: `terminal:${watcherId}`,
        state: result.state,
        reason: result.reason
      }, version)
    })
    enrollment = next
    trace.exitPath = 'lifecycle-terminal'
    trace.decision = { action: null, reason: result.reason, detail: result.state }
    updateStatus('terminal', result.state, result.reason)
    return {
      watcherId,
      kind: next.kind,
      state: result.state,
      reason: result.reason,
      atMs,
      budget: budgetWithPolicy(next, store.journal(watcherId), atMs)
    }
  }

  function updateLiveContact(snapshot: Snapshot): void {
    if (snapshot.freshness === 'live') {
      lastLiveReadAtMs = now()
      forceFullResync = false
    }
  }

  async function readSnapshot(
    kind: WatcherKind,
    current: Enrollment,
    trace: TickTrace,
    version: number,
    fresh: boolean
  ): Promise<Snapshot | null> {
    if (!isCurrent(version)) return null
    trace.snapshotReadCount += 1
    const snapshot = await kind.read(current, { fresh })
    if (!isCurrent(version)) return null
    updateLiveContact(snapshot)
    trace.contentIdentity = snapshot.contentIdentity
    const summary = kind.describeSnapshot ? await kind.describeSnapshot(snapshot) : snapshot.world
    if (!isCurrent(version)) return null
    trace.snapshot = summary as Json
    return snapshot
  }

  async function evaluateStop(
    kind: WatcherKind,
    snapshot: Snapshot,
    current: Enrollment,
    version: number
  ): Promise<StopResult> {
    if (!kind.stop) return null
    return await kind.stop(snapshot, store.journal(watcherId), current)
  }

  async function applyResolvedOutcome(
    kind: WatcherKind,
    snapshot: Snapshot,
    version: number
  ): Promise<void> {
    if (snapshot.freshness !== 'live' || !kind.resolveOutcome || !isCurrent(version)) return
    const unresolved = latestAttempts(store.journal(watcherId)).filter(unresolvedAttempt)
    for (const attempt of unresolved) {
      if (!isCurrent(version)) return
      const latest = store.get(watcherId)
      if (!latest || latest.terminalAtMs !== null) return
      const journal = store.journal(watcherId)
      const currentAttempt = latestAttempts(journal).find((entry) => entry.attemptId === attempt.attemptId)
      if (!currentAttempt || !unresolvedAttempt(currentAttempt)) continue
      const outcome = await kind.resolveOutcome(currentAttempt, snapshot, journal, latest)
      if (!isCurrent(version) || outcome === null || outcome.effect === 'indeterminate') continue
      appendResolution(currentAttempt, outcome, {
        source: 'kind-live-resolution',
        contentIdentity: snapshot.contentIdentity,
        observedAtMs: snapshot.observedAtMs
      }, version)
      closeAttemptIntervals(currentAttempt.attemptId, 'settled', now(), version)
    }
  }

  async function recoverDispatches(version: number): Promise<boolean> {
    const attempts = latestAttempts(store.journal(watcherId)).filter((attempt) =>
      attempt.requestId && attempt.workerRequest && !attempt.dispatchId && unresolvedAttempt(attempt)
    )
    for (const attempt of attempts) {
      if (!isCurrent(version)) return false
      const latestEnrollment = store.get(watcherId)
      if (!latestEnrollment || latestEnrollment.terminalAtMs !== null) return false
      const latestAttempt = latestAttempts(store.journal(watcherId)).find((candidate) => candidate.attemptId === attempt.attemptId)
      if (!latestAttempt || !unresolvedAttempt(latestAttempt)) continue
      const result = await orchestration.recover(latestEnrollment, latestAttempt)
      if (!isCurrent(version) || result === null) continue
      if (result.kind === 'indeterminate' && result.reason === 'coordinator-seat-lost') {
        parkCoordinatorSeatLost(result.detail ?? 'The coordinator no longer owns the requested orchestration Run.', version)
        return true
      }
      applyDispatchResult(latestAttempt, result, version, true)
    }
    return false
  }

  function resumeAfterResolution(_current: Enrollment, reason: ParkReason, version: number): Enrollment | null {
    if (!isCurrent(version) || controlPendingCount > 0 || store.readOnly) return null
    const latest = store.get(watcherId)
    if (!latest || latest.terminalAtMs !== null || latest.parkReason !== reason || latest.enabled) return null
    const journal = store.journal(watcherId)
    const parkEntry = latestEscalation(journal, `park-${reason}`)
    const sourceId = typeof parkEntry?.sourceEscalationId === 'string' ? parkEntry.sourceEscalationId : undefined
    const sourceIds = new Set(
      journal
        .filter((entry) => entry.kind === 'escalation' && entry.escalationKind === reason && entry.escalationId !== `park-${reason}`)
        .map((entry) => entry.escalationId)
        .filter((id): id is string => typeof id === 'string')
    )
    if (sourceId) sourceIds.add(sourceId)
    if (sourceIds.size === 0) return null
    const sources = [...sourceIds].map((id) => latestEscalation(journal, id))
    const resolved = sources.every((entry) =>
      entry !== undefined &&
      (entry.status === 'resolved' || (reason === 'worker-escalation' && entry.status === 'acknowledged'))
    )
    if (!resolved) return null
    const next = { ...latest, enabled: true, parkReason: null, haltReason: null }
    store.save(next)
    enrollment = next
    forceFullResync = true
    updateStatus('watching')
    schedule(0)
    return next
  }

  function reconcileParkedFromJournal(version: number): void {
    const current = store.get(watcherId)
    if (current?.parkReason === 'worker-question' || current?.parkReason === 'worker-escalation') {
      resumeAfterResolution(current, current.parkReason, version)
    }
  }

  async function resolveWorkerMessage(message: WorkerMessage, version: number): Promise<boolean> {
    if (!isCurrent(version)) return false
    const journal = store.journal(watcherId)
    const seenEventId = `mailbox:${message.id}`
    if (message.type === 'worker_done') {
      if (!message.dispatchId || (message.outcome !== 'succeeded' && message.outcome !== 'failed')) {
        appendEntry({
          kind: 'evidence',
          class: 'fact',
          origin: 'owner',
          resolved: true,
          eventId: seenEventId,
          evidenceKind: 'worker-outcome-unverified',
          payload: {
            messageId: message.id,
            ...(message.dispatchId ? { dispatchId: message.dispatchId } : {}),
            detail: 'Worker completion did not contain a verifiable dispatch outcome.'
          }
        }, version, { idempotent: true })
        return false
      }
      const attempt = latestAttempts(journal).find((candidate) => candidate.dispatchId === message.dispatchId)
      if (!attempt) {
        appendEntry({
          kind: 'evidence',
          class: 'fact',
          origin: 'owner',
          resolved: true,
          eventId: seenEventId,
          evidenceKind: 'worker-done-unmatched',
          payload: { messageId: message.id, dispatchId: message.dispatchId, outcome: message.outcome }
        }, version, { idempotent: true })
        return false
      }
      const effect = message.outcome === 'succeeded' ? 'landed' : 'not-landed'
      if (unresolvedAttempt(attempt)) {
        appendResolution(attempt, { effect, reason: `worker-${message.outcome}` }, {
          source: 'worker-mailbox',
          messageId: message.id,
          dispatchId: message.dispatchId
        }, version)
        closeAttemptIntervals(attempt.attemptId, 'settled', now(), version)
      }
      const settled = latestAttempts(store.journal(watcherId)).find((candidate) => candidate.attemptId === attempt.attemptId)
      const latestEnrollment = store.get(watcherId)
      if (settled?.state === 'settled' && settled.effect === effect && latestEnrollment && isCurrent(version)) {
        await orchestration.release(latestEnrollment, message.dispatchId)
      }
      return true
    }

    if (message.type !== 'question' && message.type !== 'escalation') {
      appendEntry({
        kind: 'evidence',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: seenEventId,
        evidenceKind: 'mailbox-observed',
        payload: { messageType: message.type, messageId: message.id, body: message.body }
      }, version, { idempotent: true })
      return true
    }

    const correlated = message.dispatchId !== undefined &&
      latestAttempts(journal).some((attempt) => attempt.dispatchId === message.dispatchId)
    if (!correlated) {
      appendEntry({
        kind: 'evidence',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: `mailbox-unmatched:${message.id}`,
        evidenceKind: 'worker-message-unmatched',
        payload: {
          messageId: message.id,
          messageType: message.type,
          ...(message.dispatchId ? { dispatchId: message.dispatchId } : {}),
          body: message.body
        }
      }, version, { idempotent: true })
      return false
    }

    const reason: ParkReason = message.type === 'question' ? 'worker-question' : 'worker-escalation'
    const escalationId = `${reason}:${message.id}`
    const existing = latestEscalation(journal, escalationId)
    if (message.type === 'question' && message.resolved === true) {
      appendEntry({
        kind: 'escalation',
        class: 'fact',
        origin: 'owner',
        resolved: true,
        eventId: `mailbox-resolution:${message.id}`,
        escalationId,
        escalationKind: reason,
        status: 'resolved',
        foldCount: typeof existing?.foldCount === 'number' ? existing.foldCount : 1,
        messageId: message.id,
        body: message.body
      }, version, { idempotent: true })
      const current = store.get(watcherId)
      if (current?.parkReason === reason) resumeAfterResolution(current, reason, version)
      return true
    }

    if (!existing) {
      appendEntry({
        kind: 'escalation',
        class: 'fact',
        origin: 'owner',
        resolved: false,
        eventId: `mailbox-escalation:${message.id}`,
        escalationId,
        escalationKind: reason,
        status: 'open',
        foldCount: 1,
        messageId: message.id,
        dispatchId: message.dispatchId,
        body: message.body
      }, version, { idempotent: true })
    }
    const current = store.get(watcherId)
    if (current && current.parkReason !== reason) {
      park(current, reason, message.body, version, { escalationId, messageId: message.id })
    }
    return true
  }

  async function drainMailbox(current: Enrollment, version: number): Promise<void> {
    if (!isCurrent(version)) return
    const messages = await orchestration.mailbox(current)
    if (!isCurrent(version) || messages.length === 0) return
    const handledMessages: WorkerMessage[] = []
    for (const message of messages) {
      if (!isCurrent(version)) return
      const handled = await resolveWorkerMessage(message, version)
      if (!isCurrent(version)) return
      if (handled) handledMessages.push(message)
    }
    const latest = store.get(watcherId)
    if (latest && isCurrent(version) && handledMessages.length > 0) {
      await orchestration.acknowledge(latest, handledMessages)
    }
  }

  function latestStatusFromJournal(current: Enrollment, journal: JournalEntry[]): RunnerStatus {
    if (current.malformed) return { ...statusValue, state: 'malformed', reason: 'malformed', detail: current.malformed }
    if (current.terminalAtMs !== null) return { ...statusValue, state: 'terminal', reason: current.haltReason ?? 'terminal' }
    if (current.parkReason !== null) return { ...statusValue, state: 'parked', reason: current.parkReason, detail: current.haltReason ?? undefined }
    if (!current.enabled) return { ...statusValue, state: 'disabled', reason: current.haltReason ?? 'disabled' }
    if (current.paused) return { ...statusValue, state: 'held', reason: 'paused' }
    const attempts = latestAttempts(journal)
    if (attempts.some((attempt) => attempt.state === 'running' && attempt.dispatchId)) {
      return { ...statusValue, state: 'acting' }
    }
    if (attempts.some((attempt) => attempt.effect === 'indeterminate')) {
      return { ...statusValue, state: 'held', reason: 'unresolved-attempt' }
    }
    return { ...statusValue, state: 'watching', reason: undefined, detail: undefined }
  }

  async function kindTier(kind: WatcherKind, snapshot: Snapshot, currentJournal: JournalEntry[]): Promise<PacingTier> {
    return kind.pace ? await kind.pace(snapshot, currentJournal) : 'idle'
  }

  function makeTrace(startedAtMs: number): TickTrace {
    const fullResyncDue = forceFullResync || lastLiveReadAtMs === null || now() - lastLiveReadAtMs >= FULL_RESYNC_INTERVAL_MS
    return {
      seq: store.nextTraceSeq(watcherId),
      watcherId,
      startedAtMs,
      durationMs: 0,
      exitPath: 'watching',
      pinned: false,
      fullResyncDue,
      snapshotReadCount: 0,
      declined: [],
      runner: { ...statusValue }
    }
  }

  function recordConsidered(trace: TickTrace, considered: string[] | undefined): void {
    if (!considered) return
    for (const reason of considered) if (!trace.declined.includes(reason)) trace.declined.push(reason)
  }

  function canSchedule(current: Enrollment | null, journal: JournalEntry[]): boolean {
    return !stopped && !suspended && controlPendingCount === 0 && statusValue.state !== 'terminal' &&
      current?.malformed === undefined && (current?.enabled === true || hasUnresolvedAttempts(journal))
  }

  async function runTick(): Promise<void> {
    if (stopped || suspended || controlPendingCount > 0 || store.readOnly) return
    clearScheduledTimer()
    const version = lifecycleVersion
    const controlVersion = controlGeneration
    tickControlGeneration = controlVersion
    recoveringThisTick = recoveryPending
    const startedAtMs = now()
    const trace = makeTrace(startedAtMs)
    let current: Enrollment | null = null
    let kind: WatcherKind | undefined
    let snapshot: Snapshot | null = null
    let tier: PacingTier = 'idle'
    let immediateRetick = false
    let gateHeld = false
    let actionCompleted = false
    let failed = false
    let terminalSummary: TerminalSummary | null = null
    let stopPredicateFired = false
    try {
      current = store.get(watcherId)
      if (!current || current.terminalAtMs !== null) {
        const terminal = current !== null && current.terminalAtMs !== null
        trace.exitPath = terminal ? 'lifecycle-terminal' : 'not-current'
        updateStatus(terminal ? 'terminal' : 'disabled', terminal ? 'terminal' : 'not-current')
        return
      }
      enrollment = current
      if (current.malformed) {
        trace.exitPath = 'malformed'
        updateStatus('malformed', 'malformed', current.malformed)
        return
      }
      kind = registry.get(current.kind)
      if (!kind) {
        trace.exitPath = 'kind-unavailable'
        updateStatus('unreachable', 'kind-unavailable', current.kind)
        tier = 'idle'
        return
      }

      if (recoveryPending) {
        const open = openBudgetIntervals(store.journal(watcherId))
        for (const interval of open) closeInterval(interval.intervalId, 'contact-lost', interval.checkpointAtMs, version)
      }

      const coordinatorFenced = await recoverDispatches(version)
      if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }
      if (coordinatorFenced) {
        trace.decision = {
          action: null,
          reason: 'coordinator-seat-lost',
          detail: store.get(watcherId)?.haltReason ?? undefined
        }
        trace.exitPath = 'parked'
        return
      }
      recoveryPending = false

      current = store.get(watcherId)
      if (!current || !isCurrent(version)) { trace.exitPath = 'not-current'; return }
      
      const fullResyncDue = trace.fullResyncDue
      snapshot = await readSnapshot(kind, current, trace, version, fullResyncDue)
      if (!snapshot || !isCurrent(version)) { trace.exitPath = 'suspended'; return }

      current = store.get(watcherId)
      if (!current || !isCurrent(version)) { trace.exitPath = 'not-current'; return }
      await drainMailbox(current, version)
      if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }
      current = store.get(watcherId)
      if (!current) { trace.exitPath = 'not-current'; return }
      reconcileParkedFromJournal(version)
      current = store.get(watcherId)
      if (!current) { trace.exitPath = 'not-current'; return }

      if (kind.reconcile && await kind.reconcile(current, snapshot, store.journal(watcherId))) {
        if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }
        current = store.get(watcherId)
        if (!current) { trace.exitPath = 'not-current'; return }
        snapshot = await readSnapshot(kind, current, trace, version, true)
        if (!snapshot || !isCurrent(version)) { trace.exitPath = 'suspended'; return }
      }
      reconcileParkedFromJournal(version)
      current = store.get(watcherId)
      if (!current) { trace.exitPath = 'not-current'; return }
      await applyResolvedOutcome(kind, snapshot, version)
      if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }

      current = store.get(watcherId)
      if (!current) { trace.exitPath = 'not-current'; return }
      const workerObservations = current.orchestrationRunId === null
        ? []
        : await orchestration.observeWorkers(current)
      if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }
      current = store.get(watcherId)
      if (!current) { trace.exitPath = 'not-current'; return }
      reconcileWorkerObservations(workerObservations, version)

      current = store.get(watcherId)
      if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }
      if (!current) { trace.exitPath = 'not-current'; return }
      if (current.parkReason === 'coordinator-seat-lost') {
        trace.decision = {
          action: null,
          reason: 'coordinator-seat-lost',
          detail: current.haltReason ?? undefined
        }
        trace.exitPath = 'parked'
        updateStatus('parked', 'coordinator-seat-lost', current.haltReason ?? undefined)
        return
      }
      let journal = store.journal(watcherId)
      let stopResult = await evaluateStop(kind, snapshot, current, version)
      if (!isCurrent(version)) { trace.exitPath = 'suspended'; return }
      if (stopResult?.kind === 'terminal') {
        if (hasUnresolvedAttempts(journal)) {
          stopPredicateFired = true
          trace.decision = { action: null, reason: 'stop-predicate-deferred', detail: `${stopResult.state}: ${stopResult.reason}` }
          trace.exitPath = 'gate-held'
          consecutiveGateHolds += 1
          gateHeld = true
          updateStatus('held', 'stop-predicate-deferred', `${stopResult.state}: ${stopResult.reason}`)
        } else {
          terminalSummary = saveTerminal(current, stopResult, trace, version)
          if (!terminalSummary) trace.exitPath = 'not-current'
          return
        }
      } else if (stopResult?.kind === 'park') {
        park(current, stopResult.reason, stopResult.detail, version)
        trace.decision = { action: null, reason: stopResult.reason, detail: stopResult.detail }
        trace.exitPath = 'parked'
        return
      }

      current = store.get(watcherId)
      if (!current || !isCurrent(version)) { trace.exitPath = 'not-current'; return }
      journal = store.journal(watcherId)
      let budget = budgetWithPolicy(current, journal, now())
      trace.budget = budget
      if (budget.exhausted !== null) {
        const hasPending = hasUnresolvedAttempts(journal)
        if (kind.concurrency?.drainOnBudget !== true || !hasPending) {
          park(current, 'budget', budget.exhausted, version)
          trace.decision = { action: null, reason: 'budget-exhausted', detail: budget.exhausted }
          trace.exitPath = 'budget-exhausted'
          return
        }
        trace.decision = { action: null, reason: 'budget-draining', detail: 'Existing work may finish; no new action is dispatched.' }
        trace.exitPath = 'budget-exhausted'
        updateStatus('acting', 'budget-draining')
        return
      }
      // Owner-step integration belongs after stop/budget checks and before disabled/paused gating.

      if (!current.enabled || current.paused) {
        trace.decision = { action: null, reason: current.paused ? 'paused' : 'disabled', detail: current.haltReason ?? undefined }
        trace.exitPath = current.paused ? 'gate-held' : 'disabled'
        updateStatus(current.paused ? 'held' : 'disabled', current.paused ? 'paused' : current.haltReason ?? 'disabled')
        return
      }

      let actionCount = 0
      while (actionCount < MAX_ACTIONS_PER_TICK && isCurrent(version)) {
        current = store.get(watcherId)
        if (!current || current.terminalAtMs !== null) { trace.exitPath = 'not-current'; break }
        journal = store.journal(watcherId)
        budget = budgetWithPolicy(current, journal, now())
        trace.budget = budget
        const decision: Decision = await kind.decide(snapshot, journal, current)
        if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }
        trace.decision = decision
        recordConsidered(trace, decision.considered)
        if (!decision.action) {
          trace.exitPath = actionCount > 0 ? 'acted' : 'watching'
          if (decision.deviation) {
            trace.gate = { verdict: 'hold', reason: decision.deviation.kind, detail: decision.deviation.detail }
            appendEntry({
              kind: 'evidence',
              class: 'fact',
              origin: 'owner',
              resolved: true,
              eventId: `deviation:${watcherId}:${trace.seq}:${hash(JSON.stringify(decision.deviation))}`,
              evidenceKind: 'decision-deviation',
              payload: {
                kind: decision.deviation.kind,
                ...(decision.deviation.detail ? { detail: decision.deviation.detail } : {})
              }
            }, version, { idempotent: true })
            trace.exitPath = 'gate-held'
            consecutiveGateHolds += 1
            gateHeld = true
            updateStatus('held', decision.deviation.kind, decision.deviation.detail)
          }
          break
        }

        let selectedAction = decision.action
        let fingerprint = actionFingerprint(selectedAction)
        let matchingAttempt = latestAttempts(journal).filter((attempt) => attempt.fingerprint === fingerprint).sort((left, right) => right.seq - left.seq)[0]
        const localReplay = recoveringThisTick && actionCount === 0 && selectedAction.visibility === 'local' && selectedAction.recovery === 'replay-safe' && matchingAttempt !== undefined && unresolvedAttempt(matchingAttempt)
        const ignoreAttemptId = localReplay ? matchingAttempt?.attemptId : undefined
        let gateState = commitGate(selectedAction, snapshot, stopPredicateFired, version, ignoreAttemptId)
        if (!gateState) { trace.exitPath = 'suspended'; break }
        let verdict = gateState.verdict
        if (verdict.verdict === 'allow' && kind.preflight) {
          verdict = await kind.preflight(selectedAction, snapshot, gateState.journal, gateState.enrollment)
          if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }
        }
        trace.gate = verdict
        if (verdict.verdict !== 'allow') {
          await recordGate(selectedAction, verdict, version, trace)
          gateHeld = true
          break
        }

        if (selectedAction.visibility === 'external' && snapshot.freshness === 'cached') {
          const freshSnapshot = await readSnapshot(kind, gateState.enrollment, trace, version, true)
          if (!freshSnapshot || !isCurrent(version)) { trace.exitPath = 'suspended'; break }
          const freshDecision = await kind.decide(freshSnapshot, store.journal(watcherId), store.get(watcherId) ?? gateState.enrollment)
          if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }
          if (!freshDecision.action || actionFingerprint(freshDecision.action) !== fingerprint || freshSnapshot.freshness !== 'live') {
            abandon(selectedAction, 'workspace-moved', 'Cached external decision did not survive a live redecision.', version)
            trace.decision = freshDecision
            recordConsidered(trace, freshDecision.considered)
            trace.gate = { verdict: 'hold', reason: 'workspace-moved' }
            trace.exitPath = 'workspace-moved'
            immediateRetick = true
            consecutiveGateHolds += 1
            gateHeld = true
            break
          }
          trace.decision = freshDecision
          recordConsidered(trace, freshDecision.considered)
          selectedAction = freshDecision.action
          fingerprint = actionFingerprint(selectedAction)
          snapshot = freshSnapshot
          current = store.get(watcherId)
          if (!current) { trace.exitPath = 'not-current'; break }
          journal = store.journal(watcherId)
          gateState = commitGate(selectedAction, snapshot, stopPredicateFired, version, ignoreAttemptId)
          if (!gateState) { trace.exitPath = 'suspended'; break }
          verdict = gateState.verdict
          if (verdict.verdict === 'allow' && kind.preflight) {
            verdict = await kind.preflight(selectedAction, snapshot, gateState.journal, gateState.enrollment)
            if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }
          }
          trace.gate = verdict
          if (verdict.verdict !== 'allow') {
            await recordGate(selectedAction, verdict, version, trace)
            gateHeld = true
            break
          }
        }

        const beforeEffect = commitGate(selectedAction, snapshot, stopPredicateFired, version, ignoreAttemptId)
        if (!beforeEffect) { trace.exitPath = 'suspended'; break }
        trace.gate = beforeEffect.verdict
        if (beforeEffect.verdict.verdict !== 'allow') {
          await recordGate(selectedAction, beforeEffect.verdict, version, trace)
          gateHeld = true
          break
        }
        current = beforeEffect.enrollment
        const attemptId = randomUUID()
        const generation = budgetGeneration(beforeEffect.journal, watcherId)
        const initialAttempt = localReplay && matchingAttempt
          ? attemptRevision(undefined, {
            attemptId,
            fingerprint,
            action: selectedAction,
            state: 'attempted',
            generation,
            eventId: `attempt:${attemptId}:replay`,
            resolved: false,
            replayCount: (typeof matchingAttempt.replayCount === 'number' ? matchingAttempt.replayCount : 0) + 1,
            replayOfAttemptId: matchingAttempt.attemptId
          }, version)
          : attemptRevision(undefined, {
            attemptId,
            fingerprint,
            action: selectedAction,
            state: 'attempted',
            generation,
            eventId: `attempt:${attemptId}:attempted`,
            resolved: false
          }, version)
        if (!initialAttempt) { trace.exitPath = 'not-current'; break }
        const actionIntervalId = openInterval('action-in-flight', version, attemptId)
        if (!actionIntervalId) { trace.exitPath = 'not-current'; break }
        actionCount += 1
        updateStatus('acting')
        const controller = new AbortController()
        activeAbort = controller
        let workerState: WorkerDispatchState | null = null
        let workerRequestValue: WorkerRequest | null = null
        let workerPromise: Promise<DispatchResult> | null = null
        const dispatchWorker = (request: WorkerRequest): Promise<DispatchResult> => {
          if (workerPromise) {
            if (workerRequestValue === request) return workerPromise
            return Promise.resolve({ kind: 'refused', reason: 'multiple-worker-requests', detail: 'One action may dispatch one worker request.' })
          }
          workerRequestValue = request
          workerPromise = (async () => {
            const requestId = workerRequestId(fingerprint)
            const commit = commitGate(selectedAction, snapshot as Snapshot, stopPredicateFired, version, attemptId)
            if (!commit || commit.verdict.verdict !== 'allow') {
              const reason = commit?.verdict.verdict === 'allow' ? 'runner-stopped' : commit?.verdict.reason ?? 'runner-stopped'
              const detail = commit && commit.verdict.verdict !== 'allow' ? commit.verdict.detail : undefined
              const refused: DispatchResult = { kind: 'refused', reason, ...(detail ? { detail } : {}) }
              workerState = { result: refused, requestId, request }
              return refused
            }
            if (hasUnresolvedExternalAttempt(commit.journal, attemptId)) {
              const refused: DispatchResult = {
                kind: 'refused',
                reason: 'unresolved-attempt',
                detail: 'Another external attempt remains unresolved.'
              }
              workerState = { result: refused, requestId, request }
              return refused
            }
            const prepared = attemptRevision(
              latestAttempts(commit.journal).find((candidate) => candidate.attemptId === attemptId),
              {
                attemptId,
                fingerprint,
                action: selectedAction,
                state: 'running',
                generation,
                eventId: `dispatch-prepared:${attemptId}:${requestId}`,
                resolved: false,
                requestId,
                workerRequest: request
              },
              version
            )
            if (!prepared || !isCurrent(version)) {
              const unknown: DispatchResult = { kind: 'indeterminate', requestId, detail: 'Runner was fenced before dispatch.' }
              workerState = { result: unknown, requestId, request }
              return unknown
            }
            const finalCommit = commitGate(selectedAction, snapshot as Snapshot, stopPredicateFired, version, attemptId)
            if (!finalCommit || finalCommit.verdict.verdict !== 'allow' ||
              hasUnresolvedExternalAttempt(finalCommit.journal, attemptId)) {
              const reason = finalCommit?.verdict.verdict === 'allow'
                ? 'unresolved-attempt'
                : finalCommit?.verdict.reason ?? 'runner-stopped'
              const detail = finalCommit?.verdict.verdict === 'allow'
                ? 'Another external attempt remains unresolved.'
                : finalCommit?.verdict.detail
              const refused: DispatchResult = { kind: 'refused', reason, ...(detail ? { detail } : {}) }
              workerState = { result: refused, requestId, request }
              return refused
            }
            const latestEnrollment = store.get(watcherId)
            if (!latestEnrollment || latestEnrollment.terminalAtMs !== null) {
              const refused: DispatchResult = { kind: 'refused', reason: 'runner-stopped' }
              workerState = { result: refused, requestId, request }
              return refused
            }
            let dispatchResult: DispatchResult
            try {
              dispatchResult = await orchestration.dispatch(latestEnrollment, prepared, request)
            } catch (error) {
              dispatchResult = {
                kind: 'indeterminate',
                requestId,
                detail: errorText(error),
                ...(isCoordinatorSeatLostError(error) ? { reason: 'coordinator-seat-lost' } : {})
              }
            }
            workerState = { result: dispatchResult, requestId, request }
            if (!isCurrent(version)) return dispatchResult
            if (dispatchResult.kind === 'dispatched') {
              const latest = latestAttempts(store.journal(watcherId)).find((candidate) => candidate.attemptId === attemptId) ?? prepared
              applyDispatchResult(latest, dispatchResult, version, false)
            }
            return dispatchResult
          })()
          return workerPromise
        }
        const executeContext: ExecuteContext = {
          enrollment: current,
          attemptId,
          fingerprint,
          signal: controller.signal,
          dispatchWorker
        }

        let result: ExecuteResult | undefined
        let executionError: unknown
        let executeFailed = false
        try {
          result = await kind.execute(selectedAction, executeContext)
        } catch (error) {
          executeFailed = true
          executionError = error
        } finally {
          if (activeAbort === controller) activeAbort = null
        }
        if (workerPromise) {
          try {
            await workerPromise
          } catch (error) {
            if (!executeFailed) {
              executeFailed = true
              executionError = error
            }
          }
        }
        if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }

        if (workerState?.result.kind === 'indeterminate' && workerState.result.reason === 'coordinator-seat-lost') {
          const detail = workerState.result.detail ?? 'The coordinator no longer owns the requested orchestration Run.'
          parkCoordinatorSeatLost(detail, version)
          trace.decision = { action: null, reason: 'coordinator-seat-lost', detail }
          trace.exitPath = 'parked'
          return
        }

        if (executeFailed) {
          if (workerState?.result.kind !== 'dispatched') {
            let failure: { effect?: unknown; failureClass?: unknown; noEffect?: unknown } = {}
            if (typeof executionError === 'object' && executionError !== null) {
              failure = executionError as { effect?: unknown; failureClass?: unknown; noEffect?: unknown }
            }
            const positiveNoEffect = failure.effect === 'not-landed' || failure.failureClass === 'not-landed' || failure.noEffect === true
            const effect: ExecuteResult['effect'] = workerState?.result.kind === 'refused'
              ? 'not-landed'
              : positiveNoEffect ? 'not-landed' : 'indeterminate'
            const reason = workerState?.result.kind === 'refused'
              ? workerState.result.reason
              : errorText(executionError)
            const latest = latestAttempts(store.journal(watcherId)).find((candidate) => candidate.attemptId === attemptId) ?? initialAttempt
            appendResolution(latest, {
              effect,
              reason,
              ...(typeof failure.failureClass === 'string' ? { failureClass: failure.failureClass } : {})
            }, { source: 'executor-exception' }, version)
            closeInterval(actionIntervalId, 'settled', now(), version)
          }
          throw executionError
        }
        if (!result) throw new Error('Executor returned no result.')

        const latestAfterExecute = latestAttempts(store.journal(watcherId)).find((candidate) => candidate.attemptId === attemptId) ?? initialAttempt
        if (workerState?.result.kind === 'dispatched' || (latestAfterExecute.state === 'running' && latestAfterExecute.dispatchId)) {
          actionCompleted = true
          trace.exitPath = 'acted'
          current = store.get(watcherId)
          if (current) statusValue = latestStatusFromJournal(current, store.journal(watcherId))
          const postDispatchStop = await evaluateStop(kind, snapshot, current ?? beforeEffect.enrollment, version)
          if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }
          if (postDispatchStop?.kind === 'terminal') {
            stopPredicateFired = true
            trace.decision = { action: null, reason: 'stop-predicate-deferred', detail: `${postDispatchStop.state}: ${postDispatchStop.reason}` }
            consecutiveGateHolds += 1
            gateHeld = true
            updateStatus('held', 'stop-predicate-deferred', postDispatchStop.reason)
          } else if (postDispatchStop?.kind === 'park') {
            park(current ?? beforeEffect.enrollment, postDispatchStop.reason, postDispatchStop.detail, version)
            trace.decision = { action: null, reason: postDispatchStop.reason, detail: postDispatchStop.detail }
            trace.exitPath = 'parked'
          }
          break
        }

        const settledEffect = workerState?.result.kind === 'refused'
          ? 'not-landed'
          : workerState?.result.kind === 'indeterminate' ? 'indeterminate' : result.effect
        const settledReason = workerState?.result.kind === 'refused'
          ? workerState.result.reason
          : workerState?.result.kind === 'indeterminate' ? workerState.result.detail : result.reason
        const currentJournal = store.journal(watcherId)
        const currentAttempt = latestAttempts(currentJournal).find((candidate) => candidate.attemptId === attemptId) ?? initialAttempt
        if (settledEffect === 'indeterminate') {
          const reason = settledReason ??
            (workerState?.result.kind === 'indeterminate' ? workerState.result.detail : undefined) ??
            'Executor outcome is indeterminate'
          appendResolution(currentAttempt, { effect: 'indeterminate', reason }, {
            source: workerState?.result.kind === 'indeterminate' ? 'orchestration-unknown' : 'executor-result'
          }, version)
          closeInterval(actionIntervalId, 'settled', now(), version)
          trace.error = reason
          throw new Error(reason)
        }
        appendResolution(currentAttempt, {
          effect: settledEffect,
          ...(settledReason ? { reason: settledReason } : {}),
          ...(result.expectedAfter !== undefined ? { expectedAfter: result.expectedAfter } : {}),
          ...(result.failureClass ? { failureClass: result.failureClass } : {})
        }, { source: 'executor-result' }, version)
        if (localReplay && matchingAttempt) {
          appendResolution(matchingAttempt, {
            effect: settledEffect,
            ...(settledReason ? { reason: settledReason } : {})
          }, { source: 'local-replay', replayAttemptId: attemptId }, version)
        }
        closeInterval(actionIntervalId, 'settled', now(), version)
        trace.exitPath = 'acted'
        actionCompleted = true

        current = store.get(watcherId)
        if (!current) { trace.exitPath = 'not-current'; break }
        stopResult = await evaluateStop(kind, snapshot, current, version)
        if (!isCurrent(version)) { trace.exitPath = 'suspended'; break }
        journal = store.journal(watcherId)
        if (stopResult?.kind === 'terminal') {
          if (hasUnresolvedAttempts(journal)) {
            stopPredicateFired = true
            trace.decision = { action: null, reason: 'stop-predicate-deferred', detail: `${stopResult.state}: ${stopResult.reason}` }
            consecutiveGateHolds += 1
            gateHeld = true
            updateStatus('held', 'stop-predicate-deferred', `${stopResult.state}: ${stopResult.reason}`)
            break
          }
          terminalSummary = saveTerminal(current, stopResult, trace, version)
          break
        }
        if (stopResult?.kind === 'park') {
          park(current, stopResult.reason, stopResult.detail, version)
          trace.decision = { action: null, reason: stopResult.reason, detail: stopResult.detail }
          trace.exitPath = 'parked'
          break
        }
      }
      if (actionCount === MAX_ACTIONS_PER_TICK && trace.exitPath === 'acted') {
        trace.decision = { action: null, reason: 'action-limit', detail: `Tick stopped after ${MAX_ACTIONS_PER_TICK} actions.` }
      }
      current = store.get(watcherId)
      if (current && statusValue.state !== 'held' && statusValue.state !== 'escalated' && statusValue.state !== 'parked') {
        statusValue = latestStatusFromJournal(current, store.journal(watcherId))
      }
      if (!gateHeld) consecutiveGateHolds = 0
      consecutiveErrors = 0
      statusValue = { ...statusValue, consecutiveErrors, consecutiveGateHolds }
      
    } catch (error) {
      if (!isCurrent(version)) {
        trace.exitPath = 'suspended'
        return
      }
      trace.error = errorText(error)
      if (isCoordinatorSeatLostError(error)) {
        failed = true
        parkCoordinatorSeatLost(trace.error, version)
        trace.decision = { action: null, reason: 'coordinator-seat-lost', detail: trace.error }
        trace.exitPath = 'parked'
      } else {
        failed = true
        recoveryPending = true
        consecutiveErrors += 1
        try {
          checkpointIntervals(true, version, 'contact-lost')
        } catch (closeError) {
          trace.error += `; active-time close failed: ${errorText(closeError)}`
          options.context.log(trace.error)
        }
        trace.exitPath = 'error'
        updateStatus('held', 'tick-error', trace.error)
        statusValue = { ...statusValue, consecutiveErrors, consecutiveGateHolds }
      }
    } finally {
      if (!isCurrent(version)) {
        if (tickControlGeneration === controlVersion) tickControlGeneration = null
        return
      }
      trace.durationMs = Math.max(0, now() - startedAtMs)
      const currentNow = store.get(watcherId)
      const journalNow = store.journal(watcherId)
      trace.pinned = hasUnresolvedAttempts(journalNow)
      trace.budget = currentNow ? budgetWithPolicy(currentNow, journalNow, now()) : trace.budget
      if (!terminalSummary && !failed && snapshot && kind) {
        try {
          tier = await kindTier(kind, snapshot, journalNow)
        } catch (error) {
          trace.error = errorText(error)
          trace.exitPath = 'error'
          failed = true
          recoveryPending = true
          consecutiveErrors += 1
          updateStatus('held', 'tick-error', trace.error)
        }
      }
      if (terminalSummary) tier = 'stopped'
      if (actionCompleted && !failed && tier !== 'stopped') immediateRetick = true
      const delayMs = pacingDelay({ tier, nowMs: now(), lastLiveReadAtMs, consecutiveErrors, consecutiveGateHolds })
      let scheduledDelay = immediateRetick ? 0 : delayMs
      trace.pacing = { tier, delayMs: scheduledDelay }
      trace.runner = {
        ...statusValue,
        nextPulseAtMs: scheduledDelay === null ? null : now() + scheduledDelay,
        consecutiveErrors,
        consecutiveGateHolds
      }
      if (isCurrent(version) && !store.readOnly) {
        try {
          store.trace(watcherId, trace)
          store.retain(watcherId)
        } catch (error) {
          if (!trace.error) trace.error = errorText(error)
          failed = true
          recoveryPending = true
          consecutiveErrors += 1
          updateStatus('held', 'tick-error', trace.error)
          scheduledDelay = pacingDelay({ tier, nowMs: now(), lastLiveReadAtMs, consecutiveErrors, consecutiveGateHolds })
        }
      }
      if (terminalSummary && currentNow) {
        try {
          store.terminal(currentNow, terminalSummary)
        } catch (error) {
          if (!trace.error) trace.error = errorText(error)
        }
        stopped = true
        clearScheduledTimer()
        clearBudgetTimer()
        statusValue = { ...statusValue, state: 'terminal', nextPulseAtMs: null }
      } else if (isCurrent(version) && canSchedule(currentNow, journalNow) && scheduledDelay !== null) {
        schedule(scheduledDelay)
      } else {
        clearScheduledTimer()
      }
      statusValue = { ...statusValue, consecutiveErrors, consecutiveGateHolds }
      if (tickControlGeneration === controlVersion) tickControlGeneration = null
    }
  }

  function pulse(): Promise<void> {
    if (stopped || suspended || store.readOnly) return Promise.resolve()
    if (activePulse) {
      if (controlPendingCount === 0) pulseAgain = true
      return activePulse
    }
    if (controlPendingCount > 0) return Promise.resolve()
    clearScheduledTimer()
    const { promise, resolve } = Promise.withResolvers<void>()
    activePulse = promise
    void (async () => {
      try {
        while (true) {
          pulseAgain = false
          await runTick()
          await Promise.resolve()
          if (!pulseAgain || stopped || suspended) break
        }
      } catch (error) {
        if (!stopped && !suspended) {
          consecutiveErrors += 1
          updateStatus('held', 'tick-error', errorText(error))
          schedule(pacingDelay({
            tier: 'idle',
            nowMs: now(),
            lastLiveReadAtMs,
            consecutiveErrors,
            consecutiveGateHolds
          }) ?? 30_000)
        }
      }
      if (activePulse === promise) activePulse = null
      resolve()
    })()
    return promise
  }

  function closeIntervalsForLifecycle(reason: string, closeAtMs: number): void {
    if (store.readOnly) return
    try {
      checkpointIntervals(true, lifecycleVersion, undefined, closeAtMs, true)
      checkpointIntervals(false, lifecycleVersion, reason, closeAtMs, true)
    } catch { /* The next live tick recovers any interval still open. */ }
  }

  function suspend(): void {
    if (stopped || suspended) return
    suspended = true
    lifecycleVersion += 1
    activeAbort?.abort()
    clearScheduledTimer()
    clearBudgetTimer()
    closeIntervalsForLifecycle('contact-lost', now())
    statusValue = { ...statusValue, state: 'held', reason: 'suspended', nextPulseAtMs: null }
    changed()
  }

  function resume(): void {
    if (stopped || !suspended) return
    suspended = false
    lifecycleVersion += 1
    recoveryPending = true
    forceFullResync = true
    statusValue = { ...statusValue, state: 'watching', reason: undefined, detail: undefined, nextPulseAtMs: null }
    changed()
    schedule(0)
  }

  async function shutdown(deadlineMs = DEFAULT_SHUTDOWN_MS): Promise<void> {
    if (stopped) return
    stopped = true
    suspended = false
    lifecycleVersion += 1
    activeAbort?.abort()
    clearScheduledTimer()
    clearBudgetTimer()
    closeIntervalsForLifecycle('shutdown', now())
    statusValue = { ...statusValue, state: 'disabled', reason: 'shutdown', nextPulseAtMs: null }
    const active = activePulse?.catch(() => undefined) ?? Promise.resolve()
    const pending = Promise.all([active, controlTail]).then(() => undefined)
    const waitMs = Math.max(0, deadlineMs)
    if ((!activePulse && controlPendingCount === 0) || waitMs === 0) return
    const { promise, resolve } = Promise.withResolvers<void>()
    const timeout = setTimeout(resolve, waitMs)
    try {
      await Promise.race([pending.catch(() => undefined), promise])
    } finally {
      clearTimeout(timeout)
    }
  }

  const runner: Runner & { withControl<T>(operation: () => Promise<T>, drain?: boolean): Promise<T> } = {
    watcherId,
    status: () => ({ ...statusValue }),
    pulse,
    schedule,
    suspend,
    resume,
    shutdown,
    withControl
  }
  return runner
}
