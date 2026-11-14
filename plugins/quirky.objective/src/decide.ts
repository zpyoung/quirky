export interface ObjectiveWorld {
  planMode: 'off' | 'gated' | 'on'
  revision: null | {
    number: number
    digest: string
    tasks: { taskKey: string; deps: string[]; criteriaCount: number }[]
  }
  reports: {
    attemptId: string
    role: 'planner' | 'implementer'
    taskKey: string | null
    digest: string
    summary?: string
  }[]
  issued: {
    attemptId: string
    role: 'planner' | 'implementer'
    revision: number | null
    taskKey: string | null
  }[]
}

export interface ObjectiveSnapshot {
  freshness: 'live' | 'cached'
  contentIdentity: string
  observedAtMs: number
  world: ObjectiveWorld
}

export interface ObjectiveJournalAction {
  kind: string
  revision?: number
  taskKey?: string
  evidenceKey?: string
  ordinal?: number
  capability?: string
  visibility?: 'local' | 'external'
}

export interface ObjectiveApprovalScope {
  actionKind: string
  contentIdentity: string
  evidenceKey: string
}

export interface ObjectiveJournalEntry {
  seq: number
  kind: string
  attemptId?: string
  action?: ObjectiveJournalAction
  state?: 'attempted' | 'running' | 'settled'
  effect?: 'landed' | 'not-landed' | 'indeterminate'
  dispatchId?: string
  status?: string
  escalationId?: string
  escalationKind?: string
  approvalScope?: ObjectiveApprovalScope
  scope?: ObjectiveApprovalScope
  reason?: string
  [key: string]: unknown
}

export type ObjectiveAction =
  | {
      kind: 'dispatch-planner'
      capability: 'plan'
      visibility: 'local'
      evidenceKey: string
      ordinal: number
    }
  | {
      kind: 'activate-plan'
      capability: 'plan'
      visibility: 'local'
      recovery: 'replay-safe'
      evidenceKey: string
      plannerAttemptId: string
      digest: string
    }
  | {
      kind: 'dispatch-node'
      capability: 'implement'
      visibility: 'local'
      evidenceKey: string
      revision: number
      taskKey: string
      ordinal: number
    }

export interface ObjectiveProgress {
  draft: null | { plannerAttemptId: string; digest: string }
  tasks: {
    taskKey: string
    state: 'pending' | 'in-flight' | 'succeeded' | 'failed' | 'exhausted'
    attempts: number
    successfulAttemptId: string | null
    summary: string | null
  }[]
}

export interface ObjectiveStep {
  action: ObjectiveAction | null
  reason?: string
}

export interface ObjectiveDecision {
  action: (ObjectiveAction & { contentIdentity: string }) | null
  reason?: string
}

export type ObjectiveStopResult = {
  kind: 'park'
  reason: 'stop-predicate'
  detail: string
} | null

export type ObjectivePacing = 'rapid' | 'active' | 'idle'

const MAX_ATTEMPTS = 3

function latestAttempts(journal: ObjectiveJournalEntry[]): ObjectiveJournalEntry[] {
  const latest = new Map<string, ObjectiveJournalEntry>()
  for (const entry of journal) {
    if (entry.kind !== 'attempt' || typeof entry.attemptId !== 'string') continue
    const previous = latest.get(entry.attemptId)
    if (!previous || previous.seq <= entry.seq) latest.set(entry.attemptId, entry)
  }
  return [...latest.values()]
}

function latestEscalations(journal: ObjectiveJournalEntry[]): ObjectiveJournalEntry[] {
  const latest = new Map<string, ObjectiveJournalEntry>()
  for (const entry of journal) {
    if (entry.kind !== 'escalation' || typeof entry.escalationId !== 'string') continue
    const previous = latest.get(entry.escalationId)
    if (!previous || previous.seq <= entry.seq) latest.set(entry.escalationId, entry)
  }
  return [...latest.values()]
}

function unresolved(entry: ObjectiveJournalEntry): boolean {
  return entry.state !== 'settled' || entry.effect === 'indeterminate'
}

function matchingReport(
  world: ObjectiveWorld,
  attemptId: string,
  role: 'planner' | 'implementer',
  revision: number | null,
  taskKey: string | null
): ObjectiveWorld['reports'][number] | null {
  const issued = world.issued.some((candidate) =>
    candidate.attemptId === attemptId &&
    candidate.role === role &&
    candidate.revision === revision &&
    candidate.taskKey === taskKey
  )
  if (!issued) return null
  return world.reports.find((candidate) =>
    candidate.attemptId === attemptId &&
    candidate.role === role &&
    candidate.taskKey === taskKey
  ) ?? null
}

function plannerDraft(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[]
): ObjectiveProgress['draft'] {
  let latest: { seq: number; plannerAttemptId: string; digest: string } | null = null
  for (const entry of attempts) {
    if (
      entry.action?.kind !== 'dispatch-planner' ||
      entry.state !== 'settled' ||
      entry.effect !== 'landed' ||
      typeof entry.attemptId !== 'string'
    ) continue
    const report = matchingReport(world, entry.attemptId, 'planner', null, null)
    if (!report) continue
    if (!latest || latest.seq <= entry.seq) {
      latest = { seq: entry.seq, plannerAttemptId: entry.attemptId, digest: report.digest }
    }
  }
  return latest === null
    ? null
    : { plannerAttemptId: latest.plannerAttemptId, digest: latest.digest }
}

function taskProgress(
  world: ObjectiveWorld,
  journalAttempts: ObjectiveJournalEntry[],
  task: { taskKey: string; deps: string[]; criteriaCount: number }
): ObjectiveProgress['tasks'][number] {
  const revision = world.revision
  if (!revision) {
    return {
      taskKey: task.taskKey,
      state: 'pending',
      attempts: 0,
      successfulAttemptId: null,
      summary: null
    }
  }

  const attempts = journalAttempts.filter((entry) =>
    entry.action?.kind === 'dispatch-node' &&
    entry.action.revision === revision.number &&
    entry.action.taskKey === task.taskKey
  )
  if (attempts.some(unresolved)) {
    return {
      taskKey: task.taskKey,
      state: 'in-flight',
      attempts: attempts.length,
      successfulAttemptId: null,
      summary: null
    }
  }

  let success: { seq: number; attemptId: string; summary: string | null } | null = null
  for (const entry of attempts) {
    if (entry.state !== 'settled' || entry.effect !== 'landed' || typeof entry.attemptId !== 'string') continue
    const report = matchingReport(world, entry.attemptId, 'implementer', revision.number, task.taskKey)
    if (!report || (success && success.seq > entry.seq)) continue
    success = { seq: entry.seq, attemptId: entry.attemptId, summary: report.summary ?? null }
  }
  if (success) {
    return {
      taskKey: task.taskKey,
      state: 'succeeded',
      attempts: attempts.length,
      successfulAttemptId: success.attemptId,
      summary: success.summary
    }
  }
  if (attempts.length === 0) {
    return {
      taskKey: task.taskKey,
      state: 'pending',
      attempts: 0,
      successfulAttemptId: null,
      summary: null
    }
  }
  return {
    taskKey: task.taskKey,
    state: attempts.length >= MAX_ATTEMPTS ? 'exhausted' : 'failed',
    attempts: attempts.length,
    successfulAttemptId: null,
    summary: null
  }
}

export function deriveProgress(world: ObjectiveWorld, journal: ObjectiveJournalEntry[]): ObjectiveProgress {
  const attempts = latestAttempts(journal)
  return {
    draft: plannerDraft(world, attempts),
    tasks: world.revision === null
      ? []
      : world.revision.tasks.map((task) => taskProgress(world, attempts, task))
  }
}


export function nextStep(world: ObjectiveWorld, journal: ObjectiveJournalEntry[]): ObjectiveStep {
  const attempts = latestAttempts(journal)
  const revision = world.revision
  if (revision === null) {
    const plannerAttempts = attempts.filter((entry) => entry.action?.kind === 'dispatch-planner')
    if (plannerAttempts.some(unresolved)) return { action: null, reason: 'planner-in-flight' }
    if (world.planMode === 'off') return { action: null, reason: 'plan-off-without-usable-plan' }

    const draft = plannerDraft(world, attempts)
    if (draft) {
      return {
        action: {
          kind: 'activate-plan',
          capability: 'plan',
          visibility: 'local',
          recovery: 'replay-safe',
          evidenceKey: `activate-plan:${draft.plannerAttemptId}`,
          plannerAttemptId: draft.plannerAttemptId,
          digest: draft.digest
        }
      }
    }
    if (plannerAttempts.length >= MAX_ATTEMPTS) return { action: null, reason: 'planner-retry-exhausted' }
    const ordinal = plannerAttempts.length + 1
    return {
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        evidenceKey: `plan:${ordinal}`,
        ordinal
      }
    }
  }

  const nodeAttempts = attempts.filter((entry) =>
    entry.action?.kind === 'dispatch-node' && entry.action.revision === revision.number
  )
  if (nodeAttempts.some(unresolved)) return { action: null, reason: 'node-in-flight' }

  const progress = deriveProgress(world, journal)
  const progressByKey = new Map(progress.tasks.map((task) => [task.taskKey, task]))
  if (progress.tasks.some((task) => task.state === 'exhausted')) {
    return { action: null, reason: 'node-retry-exhausted' }
  }
  for (const task of revision.tasks) {
    const state = progressByKey.get(task.taskKey)
    if (!state || state.state === 'succeeded') continue
    if (!task.deps.every((dep) => progressByKey.get(dep)?.state === 'succeeded')) continue
    return {
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        evidenceKey: `node:${revision.number}:${task.taskKey}:${state.attempts + 1}`,
        revision: revision.number,
        taskKey: task.taskKey,
        ordinal: state.attempts + 1
      }
    }
  }
  if (progress.tasks.every((task) => task.state === 'succeeded')) {
    return { action: null, reason: 'verification-unavailable' }
  }
  return { action: null, reason: 'node-in-flight' }
}

export function decideObjective(snapshot: ObjectiveSnapshot, journal: ObjectiveJournalEntry[]): ObjectiveDecision {
  const step = nextStep(snapshot.world, journal)
  return step.action === null
    ? { action: null, ...(step.reason === undefined ? {} : { reason: step.reason }) }
    : { action: { ...step.action, contentIdentity: snapshot.contentIdentity } }
}

export function stopObjective(
  snapshot: ObjectiveSnapshot,
  journal: ObjectiveJournalEntry[]
): ObjectiveStopResult {
  const step = nextStep(snapshot.world, journal)
  if (step.action !== null) return null
  if (step.reason === 'planner-retry-exhausted') {
    return {
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'The planner failed 3 times without an accepted plan.'
    }
  }
  if (step.reason === 'plan-off-without-usable-plan') {
    return {
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'Plan is off and this watcher has no approved plan. Enroll it again with --cap plan=gated or --cap plan=on.'
    }
  }
  if (step.reason === 'verification-unavailable') {
    const count = snapshot.world.revision?.tasks.length ?? 0
    return {
      kind: 'park',
      reason: 'stop-predicate',
      detail: `All ${count} plan tasks succeeded. Acceptance checks, review and landing are not available in this Quirky version.`
    }
  }
  if (step.reason === 'node-retry-exhausted') {
    const exhausted = deriveProgress(snapshot.world, journal).tasks.find((task) => task.state === 'exhausted')
    if (!exhausted) return null
    return {
      kind: 'park',
      reason: 'stop-predicate',
      detail: `Task ${exhausted.taskKey} failed 3 times.`
    }
  }
  return null
}

function hasOpenAwaitingApproval(journal: ObjectiveJournalEntry[]): boolean {
  return latestEscalations(journal).some((entry) =>
    entry.status === 'open' &&
    (entry.escalationKind === 'awaiting-approval' || entry.reason === 'awaiting-approval')
  )
}

export function paceObjective(snapshot: ObjectiveSnapshot, journal: ObjectiveJournalEntry[]): ObjectivePacing {
  const attempts = latestAttempts(journal)
  if (attempts.some((entry) =>
    (entry.state === 'running' && typeof entry.dispatchId === 'string' && entry.dispatchId.length > 0) ||
    entry.effect === 'indeterminate'
  )) return 'active'
  if (hasOpenAwaitingApproval(journal)) return 'idle'
  return nextStep(snapshot.world, journal).action === null ? 'idle' : 'rapid'
}
