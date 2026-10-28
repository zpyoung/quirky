import type {
  ApprovalScope,
  Attempt,
  BudgetUsage,
  Enrollment,
  GateVerdict,
  JournalEntry,
  KernelAction,
  Snapshot
} from './contracts'

export interface GateActionInput {
  action: KernelAction
  snapshot: Snapshot
  enrollment: Enrollment
  journal: JournalEntry[]
  budget: BudgetUsage
  stopPredicateFired?: boolean
  ignoreAttemptId?: string
}

export function actionFingerprint(action: KernelAction): string {
  return JSON.stringify([action.contentIdentity, action.kind, action.evidenceKey])
}

function latestAttempts(journal: JournalEntry[], ignoreAttemptId?: string): Attempt[] {
  const byId = new Map<string, Attempt>()
  for (const entry of [...journal].sort((left, right) => left.seq - right.seq)) {
    if (entry.kind !== 'attempt' || typeof entry.attemptId !== 'string') continue
    byId.set(entry.attemptId, entry as Attempt)
  }
  return [...byId.values()].filter((attempt) => attempt.attemptId !== ignoreAttemptId)
}

function approvalScope(entry: JournalEntry): ApprovalScope | null {
  const scope = entry.approvalScope ?? entry.scope ?? entry
  if (typeof scope !== 'object' || scope === null) return null
  const candidate = scope as Partial<ApprovalScope>
  if (
    typeof candidate.actionKind !== 'string' ||
    typeof candidate.contentIdentity !== 'string' ||
    typeof candidate.evidenceKey !== 'string'
  ) return null
  return candidate as ApprovalScope
}

function hasExactApproval(action: KernelAction, journal: JournalEntry[]): boolean {
  return journal.some((entry) => {
    if (entry.kind !== 'approval' || entry.status !== 'approved') return false
    const scope = approvalScope(entry)
    if (!scope) return false
    return scope.actionKind === action.kind &&
      scope.contentIdentity === action.contentIdentity &&
      scope.evidenceKey === action.evidenceKey &&
      scope.preparedCommitSha === action.preparedCommitSha
  })
}

function unresolvedExternalAttempt(journal: JournalEntry[], ignoreAttemptId?: string): boolean {
  return latestAttempts(journal, ignoreAttemptId).some((attempt) =>
    attempt.action?.visibility === 'external' &&
    (attempt.state !== 'settled' || attempt.effect === 'indeterminate')
  )
}

export function gateAction(input: GateActionInput): GateVerdict {
  const { action, snapshot, enrollment, journal, budget, stopPredicateFired = false, ignoreAttemptId } = input
  if (!enrollment.enabled) return { verdict: 'hold', reason: 'disabled' }
  if (enrollment.paused) return { verdict: 'hold', reason: 'paused' }
  if (enrollment.parkReason !== null) return { verdict: 'hold', reason: 'parked' }
  if (budget.exhausted !== null) return { verdict: 'hold', reason: budget.exhausted }
  if (stopPredicateFired) return { verdict: 'hold', reason: 'stop-predicate-fired' }

  const fingerprint = actionFingerprint(action)
  const matchingAttempt = latestAttempts(journal, ignoreAttemptId)
    .filter((attempt) => attempt.fingerprint === fingerprint)
    .sort((left, right) => right.seq - left.seq)[0]
  if (matchingAttempt?.state === 'settled' && matchingAttempt.effect === 'landed') {
    return { verdict: 'hold', reason: 'attempt-completed' }
  }
  if (matchingAttempt && (matchingAttempt.state === 'attempted' || matchingAttempt.state === 'running')) {
    return { verdict: 'hold', reason: 'attempt-in-flight' }
  }
  if (matchingAttempt?.state === 'settled' && matchingAttempt.effect === 'not-landed') {
    return { verdict: 'hold', reason: 'retry-needs-new-evidence' }
  }
  if (matchingAttempt?.state === 'settled' && matchingAttempt.effect === 'indeterminate' && action.visibility === 'local') {
    return { verdict: 'hold', reason: 'attempt-in-flight' }
  }
  if (action.visibility === 'external' && unresolvedExternalAttempt(journal, ignoreAttemptId)) {
    return { verdict: 'hold', reason: 'unresolved-attempt' }
  }
  if (action.contentIdentity !== snapshot.contentIdentity) {
    return { verdict: 'hold', reason: 'stale-evidence' }
  }
  if (action.visibility === 'external' && action.expectedState == null) {
    return { verdict: 'hold', reason: 'missing-expected-state' }
  }

  const capability = Object.hasOwn(enrollment.capabilities, action.capability) ? enrollment.capabilities[action.capability] : undefined
  if (capability !== 'on' && capability !== 'gated') {
    return { verdict: 'hold', reason: 'capability-off' }
  }
  if ((capability === 'gated' || action.approvalRequired === true) && !hasExactApproval(action, journal)) {
    return { verdict: 'hold', reason: 'awaiting-approval' }
  }
  return { verdict: 'allow' }
}
