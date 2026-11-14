import type { ObjectivePayload } from './contract'
import type { Criterion, PlannerReport } from './plan'
import type {
  CheckRecord,
  DraftRejection,
  LandingRecord,
  OverrunRecord,
  RevisionRepair,
  VerdictRecord
} from './store'

export type ObjectiveCapability = 'off' | 'gated' | 'on'
type ObjectiveRole = 'planner' | 'implementer' | 'reviewer' | 'integrator'
type ReviewRole = 'reviewer' | 'integrator'

export interface ObjectiveWorld {
  planMode: ObjectiveCapability
  contract?: ObjectivePayload
  capabilities?: Partial<Record<'plan' | 'implement' | 'review' | 'check' | 'land', ObjectiveCapability>>
  contentIdentity?: string
  observedAtMs?: number
  git?: { branch: string | null; headSha: string | null }
  revision: null | {
    number: number
    digest: string
    tasks: {
      taskKey: string
      deps: string[]
      criteriaCount: number
      criteria?: Criterion[]
    }[]
    plan?: PlannerReport
  }
  reports: {
    attemptId: string
    role: ObjectiveRole
    taskKey: string | null
    digest: string
    summary?: string
    filesModified?: string[]
  }[]
  issued: {
    attemptId: string
    role: ObjectiveRole
    revision: number | null
    taskKey: string | null
    plannerMode?: 'initial' | 'repair'
    contentIdentity?: string | null
  }[]
  checks?: CheckRecord[]
  verdicts?: VerdictRecord[]
  landings?: LandingRecord[]
  rejectedDrafts?: DraftRejection[]
  overruns?: OverrunRecord[]
  repairs?: RevisionRepair[]
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
  contentIdentity?: string
  plannerMode?: 'initial' | 'repair'
  repairEpisode?: number
  criterionIndex?: number
  command?: string
  gateName?: string
  timeoutSeconds?: number
  branch?: string
  headSha?: string
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
      plannerMode: 'initial' | 'repair'
      revision?: number
      repairEpisode?: number
      approvalRequired?: boolean
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
      kind: 'apply-plan-repair'
      capability: 'plan'
      visibility: 'local'
      recovery: 'replay-safe'
      evidenceKey: string
      revision: number
      repairEpisode: number
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
      repairEpisode: number
    }
  | {
      kind: 'run-check'
      capability: 'check'
      visibility: 'local'
      evidenceKey: string
      revision: number
      taskKey: string
      criterionIndex: number
      command: string
      contentIdentity: string
    }
  | {
      kind: 'run-gate'
      capability: 'check'
      visibility: 'local'
      evidenceKey: string
      revision: number
      gateName: string
      command: string
      timeoutSeconds: number
      contentIdentity: string
    }
  | {
      kind: 'dispatch-reviewer' | 'dispatch-integrator'
      capability: 'review'
      visibility: 'local'
      evidenceKey: string
      revision: number
      contentIdentity: string
      ordinal: number
    }
  | {
      kind: 'record-landing'
      capability: 'check' | 'land'
      visibility: 'local'
      recovery: 'replay-safe'
      evidenceKey: string
      revision: number
      contentIdentity: string
    }
  | {
      kind: 'commit-local-branch'
      capability: 'land'
      visibility: 'local'
      recovery: 'replay-safe'
      evidenceKey: string
      revision: number
      contentIdentity: string
      branch: string
      headSha: string
    }

export interface ObjectiveProgress {
  draft: null | {
    plannerAttemptId: string
    digest: string
    kind: 'initial' | 'repair'
    repairEpisode?: number
  }
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

export type ObjectiveOwnerDeviation = {
  kind: 'gate-held' | 'retry-exhausted' | 'plan-failed' | 'landing-failed'
  naturalKey: string
  detail: string
}

export type ObjectiveStopResult = {
  kind: 'terminal'
  state: 'landed'
  reason: string
} | {
  kind: 'park'
  reason: 'stop-predicate'
  detail: string
  deviation: ObjectiveOwnerDeviation
} | null

export type ObjectivePacing = 'rapid' | 'active' | 'idle'

const MAX_ATTEMPTS = 3
const MAX_REPAIR_EPISODES = 3
const MAX_STALE_EVIDENCE_RETRIES = 3
const MAX_DRAFT_REJECTIONS = 3
const REPAIR_ESCALATION_REJECTED_PATCH_THRESHOLD = 2

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

function issueFor(world: ObjectiveWorld, attemptId: string) {
  return world.issued.find((candidate) => candidate.attemptId === attemptId) ?? null
}

function matchingReport(
  world: ObjectiveWorld,
  attemptId: string,
  role: 'planner' | 'implementer',
  revision: number | null,
  taskKey: string | null
): ObjectiveWorld['reports'][number] | null {
  const issued = issueFor(world, attemptId)
  if (
    !issued ||
    issued.role !== role ||
    issued.revision !== revision ||
    issued.taskKey !== taskKey
  ) return null
  return world.reports.find((candidate) =>
    candidate.attemptId === attemptId &&
    candidate.role === role &&
    candidate.taskKey === taskKey
  ) ?? null
}

function repairsFor(world: ObjectiveWorld, revision: number): RevisionRepair[] {
  return (world.repairs ?? []).filter((repair) => repair.revision === revision)
}

function latestRepair(world: ObjectiveWorld, revision: number): RevisionRepair | null {
  let latest: RevisionRepair | null = null
  for (const repair of repairsFor(world, revision)) {
    if (!latest || repair.appliedAtMs > latest.appliedAtMs ||
      (repair.appliedAtMs === latest.appliedAtMs && repair.ordinal > latest.ordinal)) latest = repair
  }
  return latest
}

function nextRepairEpisode(world: ObjectiveWorld, revision: number): number {
  let latestOrdinal = 0
  for (const repair of repairsFor(world, revision)) latestOrdinal = Math.max(latestOrdinal, repair.ordinal)
  return latestOrdinal + 1
}

function taskRepairEpisode(world: ObjectiveWorld, revision: number, taskKey: string): number {
  let latestOrdinal = 0
  for (const repair of repairsFor(world, revision)) {
    if (repair.touchedTaskKeys.includes(taskKey)) latestOrdinal = Math.max(latestOrdinal, repair.ordinal)
  }
  return latestOrdinal
}

function plannerModeFor(world: ObjectiveWorld, entry: ObjectiveJournalEntry): 'initial' | 'repair' {
  if (entry.action?.plannerMode) return entry.action.plannerMode
  const issue = typeof entry.attemptId === 'string' ? issueFor(world, entry.attemptId) : null
  if (issue?.plannerMode) return issue.plannerMode
  return issue?.revision === null || entry.action?.revision === undefined ? 'initial' : 'repair'
}

function plannerEpisodeFor(
  world: ObjectiveWorld,
  entry: ObjectiveJournalEntry,
  fallbackEpisode: number
): number {
  if (typeof entry.action?.repairEpisode === 'number') return entry.action.repairEpisode
  if (plannerModeFor(world, entry) === 'repair') return fallbackEpisode
  return 0
}

function rejectedDraft(world: ObjectiveWorld, attemptId: string, digest: string): boolean {
  return (world.rejectedDrafts ?? []).some((row) => row.attemptId === attemptId && row.digest === digest)
}

function plannerDraft(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[]
): ObjectiveProgress['draft'] {
  const revision = world.revision
  const mode = revision === null ? 'initial' : 'repair'
  const episode = revision === null ? 0 : nextRepairEpisode(world, revision.number)
  let latest: { seq: number; plannerAttemptId: string; digest: string } | null = null

  for (const entry of attempts) {
    if (
      entry.action?.kind !== 'dispatch-planner' ||
      plannerModeFor(world, entry) !== mode ||
      entry.state !== 'settled' ||
      entry.effect !== 'landed' ||
      typeof entry.attemptId !== 'string'
    ) continue
    if (mode === 'repair' && (
      entry.action.revision !== revision?.number ||
      plannerEpisodeFor(world, entry, episode) !== episode
    )) continue

    const report = matchingReport(
      world,
      entry.attemptId,
      'planner',
      mode === 'initial' ? null : revision!.number,
      null
    )
    if (!report || rejectedDraft(world, entry.attemptId, report.digest)) continue
    if (!latest || latest.seq <= entry.seq) {
      latest = { seq: entry.seq, plannerAttemptId: entry.attemptId, digest: report.digest }
    }
  }

  return latest === null
    ? null
    : {
        plannerAttemptId: latest.plannerAttemptId,
        digest: latest.digest,
        kind: mode,
        ...(mode === 'repair' ? { repairEpisode: episode } : {})
      }
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

  const repairEpisode = taskRepairEpisode(world, revision.number, task.taskKey)
  const attempts = journalAttempts.filter((entry) =>
    entry.action?.kind === 'dispatch-node' &&
    entry.action.revision === revision.number &&
    entry.action.taskKey === task.taskKey &&
    (repairEpisode === 0
      ? entry.action.repairEpisode === undefined || entry.action.repairEpisode === 0
      : entry.action.repairEpisode === repairEpisode)
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

function capability(
  world: ObjectiveWorld,
  name: 'plan' | 'implement' | 'review' | 'check' | 'land'
): ObjectiveCapability {
  return world.capabilities?.[name] ?? (name === 'plan' ? world.planMode : 'on')
}

function currentIdentity(world: ObjectiveWorld): string | null {
  return typeof world.contentIdentity === 'string' && world.contentIdentity.length > 0
    ? world.contentIdentity
    : null
}

function contentIdentityFrom(snapshot: ObjectiveSnapshot): ObjectiveWorld {
  return {
    ...snapshot.world,
    contentIdentity: snapshot.contentIdentity,
    observedAtMs: snapshot.observedAtMs
  }
}

function initialPlannerAttempts(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[]
): ObjectiveJournalEntry[] {
  return attempts.filter((entry) =>
    entry.action?.kind === 'dispatch-planner' &&
    plannerModeFor(world, entry) === 'initial'
  )
}

function repairPlannerAttempts(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  episode: number
): ObjectiveJournalEntry[] {
  return attempts.filter((entry) =>
    entry.action?.kind === 'dispatch-planner' &&
    plannerModeFor(world, entry) === 'repair' &&
    entry.action.revision === revision &&
    plannerEpisodeFor(world, entry, episode) === episode
  )
}

function countDraftRejections(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  mode: 'initial' | 'repair',
  episode: number
): number {
  const attemptsById = new Map(
    attempts.filter((entry): entry is ObjectiveJournalEntry & { attemptId: string } =>
      typeof entry.attemptId === 'string'
    ).map((entry) => [entry.attemptId, entry])
  )
  let count = 0
  for (const rejection of world.rejectedDrafts ?? []) {
    const issued = issueFor(world, rejection.attemptId)
    const entry = attemptsById.get(rejection.attemptId)
    if (!issued || issued.role !== 'planner') continue
    const entryMode = entry ? plannerModeFor(world, entry) : issued.plannerMode ?? (issued.revision === null ? 'initial' : 'repair')
    if (entryMode !== mode) continue
    if (mode === 'initial') {
      if (issued.revision !== null) continue
    } else if (
      issued.revision !== world.revision?.number ||
      !entry ||
      plannerEpisodeFor(world, entry, episode) !== episode
    ) continue
    count++
  }
  return count
}

function draftStage(world: ObjectiveWorld): string {
  return world.revision === null
    ? 'initial'
    : `repair:${world.revision.number}:${nextRepairEpisode(world, world.revision.number)}`
}

function initialPlanStep(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[]
): ObjectiveStep {
  const plannerAttempts = initialPlannerAttempts(world, attempts)
  if (plannerAttempts.some(unresolved)) return { action: null, reason: 'planner-in-flight' }
  if (capability(world, 'plan') === 'off') return { action: null, reason: 'plan-off-without-usable-plan' }

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

  if (countDraftRejections(world, attempts, 'initial', 0) >= MAX_DRAFT_REJECTIONS) {
    return { action: null, reason: 'draft-rejections-exhausted' }
  }
  if (plannerAttempts.length >= MAX_ATTEMPTS) return { action: null, reason: 'planner-retry-exhausted' }
  const ordinal = plannerAttempts.length + 1
  return {
    action: {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      evidenceKey: `plan:${ordinal}`,
      ordinal,
      plannerMode: 'initial'
    }
  }
}

function repairPlanStep(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number
): ObjectiveStep {
  const episode = nextRepairEpisode(world, revision)
  if (episode > MAX_REPAIR_EPISODES) return { action: null, reason: 'repair-episodes-exhausted' }

  const plannerAttempts = repairPlannerAttempts(world, attempts, revision, episode)
  if (plannerAttempts.some(unresolved)) return { action: null, reason: 'repair-planner-in-flight' }

  const draft = plannerDraft(world, attempts)
  if (draft?.kind === 'repair') {
    return {
      action: {
        kind: 'apply-plan-repair',
        capability: 'plan',
        visibility: 'local',
        recovery: 'replay-safe',
        evidenceKey: `apply-repair:${revision}:${episode}:${draft.plannerAttemptId}`,
        revision,
        repairEpisode: episode,
        plannerAttemptId: draft.plannerAttemptId,
        digest: draft.digest
      }
    }
  }

  if (countDraftRejections(world, attempts, 'repair', episode) >= MAX_DRAFT_REJECTIONS) {
    return { action: null, reason: 'draft-rejections-exhausted' }
  }
  if (plannerAttempts.length >= MAX_ATTEMPTS) {
    return { action: null, reason: 'repair-planner-retry-exhausted' }
  }

  const ordinal = plannerAttempts.length + 1
  return {
    action: {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      evidenceKey: `plan-repair:${revision}:${episode}:${ordinal}`,
      ordinal,
      plannerMode: 'repair',
      revision,
      repairEpisode: episode,
      ...(ordinal > REPAIR_ESCALATION_REJECTED_PATCH_THRESHOLD ? { approvalRequired: true } : {})
    }
  }
}

function taskCriteria(
  world: ObjectiveWorld,
  task: { taskKey: string; criteria?: Criterion[] }
): Criterion[] {
  if (task.criteria) return task.criteria
  return world.revision?.plan?.plan.tasks.find((planned) => planned.taskKey === task.taskKey)?.criteria ?? []
}

function checkEvidenceIsCurrent(
  recordAttemptId: string,
  recordedAtMs: number,
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number
): boolean {
  const repair = latestRepair(world, revision)
  if (!repair) return true
  if (recordedAtMs > repair.appliedAtMs) return true
  const attempt = attempts.find((entry) => entry.attemptId === recordAttemptId)
  const evidenceKey = attempt?.action?.evidenceKey
  const marker = `:r${repair.ordinal}`
  return typeof evidenceKey === 'string' &&
    (evidenceKey.endsWith(marker) || evidenceKey.includes(`${marker}#`))
}

function currentChecks(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  kind: CheckRecord['kind'],
  targetKey: string,
  command: string,
  contentIdentity: string
): CheckRecord[] {
  return (world.checks ?? []).filter((row) =>
    row.revision === revision &&
    row.kind === kind &&
    row.targetKey === targetKey &&
    row.command === command &&
    row.contentIdentity === contentIdentity &&
    checkEvidenceIsCurrent(row.attemptId, row.checkedAtMs, world, attempts, revision)
  )
}

function checkAction(
  world: ObjectiveWorld,
  revision: number,
  kind: CheckRecord['kind'],
  targetKey: string,
  contentIdentity: string,
  command: string,
  retryCount: number,
  taskKey?: string,
  criterionIndex?: number,
  gateName?: string,
  timeoutSeconds?: number
): ObjectiveAction {
  const repair = latestRepair(world, revision)
  const marker = repair ? `:r${repair.ordinal}` : ''
  const base = kind === 'criterion'
    ? `check:${revision}:${taskKey}:${criterionIndex}:${contentIdentity}${marker}`
    : `gate:${revision}:${gateName}:${contentIdentity}${marker}`
  const evidenceKey = `${base}${retryCount > 0 ? `#stale-${retryCount}` : ''}`
  return kind === 'criterion'
    ? {
        kind: 'run-check',
        capability: 'check',
        visibility: 'local',
        evidenceKey,
        revision,
        taskKey: taskKey!,
        criterionIndex: criterionIndex!,
        command,
        contentIdentity
      }
    : {
        kind: 'run-gate',
        capability: 'check',
        visibility: 'local',
        evidenceKey,
        revision,
        gateName: gateName!,
        command,
        timeoutSeconds: timeoutSeconds ?? 1_800,
        contentIdentity
      }
}

function verificationAction(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  contentIdentity: string
): ObjectiveStep | null {
  const observedAtMs = world.observedAtMs
  for (const task of world.revision!.tasks) {
    const criteria = taskCriteria(world, task)
    for (let criterionIndex = 0; criterionIndex < criteria.length; criterionIndex++) {
      const criterion = criteria[criterionIndex]!
      if (!criterion.shellCheckable || !criterion.checkCommand) continue

      const targetKey = `${task.taskKey}:${criterionIndex}`
      const rows = currentChecks(world, attempts, revision, 'criterion', targetKey, criterion.checkCommand, contentIdentity)
      if (rows.some((row) => row.status === 'passed')) continue
      if (capability(world, 'check') === 'off') return { action: null, reason: 'check-capability-off' }
      if (rows.some((row) => row.status === 'failed')) return repairPlanStep(world, attempts, revision)

      const stale = rows.filter((row) => row.status === 'stale').sort((a, b) => a.checkedAtMs - b.checkedAtMs)
      const latestStale = stale.at(-1)
      if (latestStale && typeof observedAtMs === 'number' && latestStale.checkedAtMs > observedAtMs) {
        return { action: null, reason: 'workspace-changed' }
      }
      if (stale.length > MAX_STALE_EVIDENCE_RETRIES) return repairPlanStep(world, attempts, revision)
      return {
        action: checkAction(
          world,
          revision,
          'criterion',
          targetKey,
          contentIdentity,
          criterion.checkCommand,
          stale.length,
          task.taskKey,
          criterionIndex
        )
      }
    }
  }

  for (const gate of world.contract?.gates ?? []) {
    const rows = currentChecks(world, attempts, revision, 'gate', gate.name, gate.command, contentIdentity)
    if (rows.some((row) => row.status === 'passed')) continue
    if (capability(world, 'check') === 'off') return { action: null, reason: 'check-capability-off' }
    if (rows.some((row) => row.status === 'failed')) return repairPlanStep(world, attempts, revision)

    const stale = rows.filter((row) => row.status === 'stale').sort((a, b) => a.checkedAtMs - b.checkedAtMs)
    const latestStale = stale.at(-1)
    if (latestStale && typeof observedAtMs === 'number' && latestStale.checkedAtMs > observedAtMs) {
      return { action: null, reason: 'workspace-changed' }
    }
    if (stale.length > MAX_STALE_EVIDENCE_RETRIES) return repairPlanStep(world, attempts, revision)
    return {
      action: checkAction(
        world,
        revision,
        'gate',
        gate.name,
        contentIdentity,
        gate.command,
        stale.length,
        undefined,
        undefined,
        gate.name,
        gate.timeoutSeconds
      )
    }
  }
  return null
}

function currentOverrun(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number
): OverrunRecord | null {
  const repair = latestRepair(world, revision)
  for (const overrun of world.overruns ?? []) {
    if (
      overrun.revision !== revision ||
      (overrun.code !== 'observed-change-outside-write-territory' && overrun.code !== 'reviewer-modified-workspace') ||
      (repair && overrun.recordedAtMs <= repair.appliedAtMs)
    ) continue
    const attempt = attempts.find((entry) => entry.attemptId === overrun.attemptId)
    if (
      attempt?.state === 'settled' &&
      attempt.effect === 'not-landed' &&
      (attempt.action?.kind === 'dispatch-node' ||
        attempt.action?.kind === 'dispatch-reviewer' ||
        attempt.action?.kind === 'dispatch-integrator')
    ) return overrun
  }
  return null
}

function currentVerdicts(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  role: ReviewRole,
  contentIdentity: string
): VerdictRecord[] {
  const repair = latestRepair(world, revision)
  const actionKind = role === 'reviewer' ? 'dispatch-reviewer' : 'dispatch-integrator'
  return (world.verdicts ?? []).filter((verdict) => {
    if (
      verdict.revision !== revision ||
      verdict.role !== role ||
      verdict.contentIdentity !== contentIdentity ||
      (repair && verdict.acceptedAtMs <= repair.appliedAtMs)
    ) return false
    const issued = issueFor(world, verdict.attemptId)
    if (
      !issued ||
      issued.role !== role ||
      issued.revision !== revision ||
      issued.contentIdentity !== contentIdentity
    ) return false
    const attempt = attempts.find((entry) => entry.attemptId === verdict.attemptId)
    return attempt?.state === 'settled' &&
      attempt.effect === 'landed' &&
      attempt.dispatchId === verdict.dispatchId &&
      attempt.action?.kind === actionKind &&
      attempt.action.revision === revision &&
      attempt.action.contentIdentity === contentIdentity
  })
}

function reviewStep(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  role: ReviewRole,
  contentIdentity: string
): ObjectiveStep {
  const kind = role === 'reviewer' ? 'dispatch-reviewer' : 'dispatch-integrator'
  const roleAttempts = attempts.filter((entry) =>
    entry.action?.kind === kind &&
    entry.action.revision === revision &&
    entry.action.contentIdentity === contentIdentity
  )
  if (roleAttempts.some(unresolved)) return { action: null, reason: 'reviewer-in-flight' }
  if (capability(world, 'review') === 'off') return { action: null, reason: 'review-capability-off' }
  if (roleAttempts.length >= MAX_ATTEMPTS) return { action: null, reason: 'reviewer-retry-exhausted' }

  const ordinal = roleAttempts.length + 1
  return {
    action: {
      kind,
      capability: 'review',
      visibility: 'local',
      evidenceKey: `review:${revision}:${role}:${contentIdentity}:${ordinal}`,
      revision,
      contentIdentity,
      ordinal
    }
  }
}

function validReviewVerdict(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  role: ReviewRole,
  contentIdentity: string
): 'approved' | 'blocked' | 'missing' {
  const rows = currentVerdicts(world, attempts, revision, role, contentIdentity)
  if (rows.some((row) => row.verdict === 'block')) return 'blocked'
  return rows.some((row) => row.verdict === 'approve') ? 'approved' : 'missing'
}

function currentNodeAttempts(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number
): ObjectiveJournalEntry[] {
  const taskEpisodes = new Map<string, number>()
  for (const task of world.revision!.tasks) {
    taskEpisodes.set(task.taskKey, taskRepairEpisode(world, revision, task.taskKey))
  }
  return attempts.filter((entry) => {
    if (
      entry.action?.kind !== 'dispatch-node' ||
      entry.action.revision !== revision ||
      typeof entry.action.taskKey !== 'string'
    ) return false
    const episode = taskEpisodes.get(entry.action.taskKey)
    if (episode === undefined) return false
    return episode === 0
      ? entry.action.repairEpisode === undefined || entry.action.repairEpisode === 0
      : entry.action.repairEpisode === episode
  })
}

function landingBar(world: ObjectiveWorld): 'files-on-disk' | 'committed-local-branch' {
  return world.contract?.landingBar === 'committed-local-branch'
    ? 'committed-local-branch'
    : 'files-on-disk'
}

function hasLanding(
  world: ObjectiveWorld,
  rung: LandingRecord['rung'],
  contentIdentity: string
): boolean {
  return (world.landings ?? []).some((landing) =>
    landing.rung === rung && landing.contentIdentity === contentIdentity
  )
}

function commitAttempts(
  attempts: ObjectiveJournalEntry[],
  revision: number,
  contentIdentity: string,
  branch: string,
  headSha: string
): ObjectiveJournalEntry[] {
  return attempts.filter((entry) =>
    entry.action?.kind === 'commit-local-branch' &&
    entry.action.revision === revision &&
    entry.action.contentIdentity === contentIdentity &&
    entry.action.branch === branch &&
    entry.action.headSha === headSha
  )
}

export function nextStep(world: ObjectiveWorld, journal: ObjectiveJournalEntry[]): ObjectiveStep {
  const attempts = latestAttempts(journal)
  const identity = currentIdentity(world)
  if (identity && hasLanding(world, landingBar(world), identity)) {
    return { action: null, reason: 'objective-bar-reached' }
  }

  const revision = world.revision
  if (revision === null) return initialPlanStep(world, attempts)

  const progress = deriveProgress(world, journal)
  const activeNodeAttempts = currentNodeAttempts(world, attempts, revision.number)
  if (activeNodeAttempts.some(unresolved)) return { action: null, reason: 'node-in-flight' }
  if (progress.tasks.some((task) => task.state === 'exhausted')) {
    return repairPlanStep(world, attempts, revision.number)
  }
  if (currentOverrun(world, attempts, revision.number)) {
    return repairPlanStep(world, attempts, revision.number)
  }

  const progressByKey = new Map(progress.tasks.map((task) => [task.taskKey, task]))
  for (const task of revision.tasks) {
    const state = progressByKey.get(task.taskKey)
    if (!state || state.state === 'succeeded') continue
    if (!task.deps.every((dep) => progressByKey.get(dep)?.state === 'succeeded')) continue
    const repairEpisode = taskRepairEpisode(world, revision.number, task.taskKey)
    const ordinal = state.attempts + 1
    return {
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        evidenceKey: repairEpisode === 0
          ? `node:${revision.number}:${task.taskKey}:${ordinal}`
          : `node:${revision.number}:${task.taskKey}:r${repairEpisode}:${ordinal}`,
        revision: revision.number,
        taskKey: task.taskKey,
        ordinal,
        repairEpisode
      }
    }
  }

  if (!progress.tasks.every((task) => task.state === 'succeeded')) {
    return { action: null, reason: 'node-in-flight' }
  }
  if (!identity) return { action: null, reason: 'content-identity-unavailable' }

  const checkStep = verificationAction(world, attempts, revision.number, identity)
  if (checkStep) return checkStep

  const tier = world.contract?.tier ?? 'express'
  if (tier === 'standard' || tier === 'full') {
    const reviewer = validReviewVerdict(world, attempts, revision.number, 'reviewer', identity)
    if (reviewer === 'blocked') return repairPlanStep(world, attempts, revision.number)
    if (reviewer !== 'approved') return reviewStep(world, attempts, revision.number, 'reviewer', identity)
  }
  if (tier === 'full') {
    const integrator = validReviewVerdict(world, attempts, revision.number, 'integrator', identity)
    if (integrator === 'blocked') return repairPlanStep(world, attempts, revision.number)
    if (integrator !== 'approved') return reviewStep(world, attempts, revision.number, 'integrator', identity)
  }

  if (capability(world, 'land') === 'off') return { action: null, reason: 'land-capability-off' }
  const bar = landingBar(world)
  if (!hasLanding(world, 'files-on-disk', identity)) {
    return {
      action: {
        kind: 'record-landing',
        capability: bar === 'files-on-disk' ? 'land' : 'check',
        visibility: 'local',
        recovery: 'replay-safe',
        evidenceKey: `files-on-disk:${identity}`,
        revision: revision.number,
        contentIdentity: identity
      }
    }
  }

  if (bar === 'files-on-disk') return { action: null, reason: 'objective-bar-reached' }
  const branch = world.git?.branch ?? null
  if (branch === null) return { action: null, reason: 'branch-not-attached' }
  const headSha = world.git?.headSha ?? null
  if (headSha === null) return { action: null, reason: 'head-unavailable' }

  const commits = commitAttempts(attempts, revision.number, identity, branch, headSha)
  if (commits.some(unresolved)) return { action: null, reason: 'landing-in-flight' }
  const failedCommitCount = commits.filter((entry) =>
    entry.state === 'settled' && entry.effect === 'not-landed'
  ).length
  if (failedCommitCount >= MAX_ATTEMPTS) {
    return { action: null, reason: 'landing-retry-exhausted' }
  }
  const retrySuffix = failedCommitCount === 0 ? '' : `#retry-${failedCommitCount}`
  return {
    action: {
      kind: 'commit-local-branch',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      evidenceKey: `committed-local-branch:${identity}:${branch}:${headSha}${retrySuffix}`,
      revision: revision.number,
      contentIdentity: identity,
      branch,
      headSha
    }
  }
}

export function decideObjective(snapshot: ObjectiveSnapshot, journal: ObjectiveJournalEntry[]): ObjectiveDecision {
  const step = nextStep(contentIdentityFrom(snapshot), journal)
  return step.action === null
    ? { action: null, ...(step.reason === undefined ? {} : { reason: step.reason }) }
    : { action: { ...step.action, contentIdentity: snapshot.contentIdentity } }
}

function park(
  kind: ObjectiveOwnerDeviation['kind'],
  naturalKey: string,
  detail: string
): ObjectiveStopResult {
  return {
    kind: 'park',
    reason: 'stop-predicate',
    detail,
    deviation: { kind, naturalKey, detail }
  }
}

function reviewRoleNeedingApproval(
  world: ObjectiveWorld,
  attempts: ObjectiveJournalEntry[],
  revision: number,
  identity: string
): ReviewRole {
  if (world.contract?.tier !== 'full') return 'reviewer'
  return validReviewVerdict(world, attempts, revision, 'reviewer', identity) === 'approved'
    ? 'integrator'
    : 'reviewer'
}

export function stopObjective(
  snapshot: ObjectiveSnapshot,
  journal: ObjectiveJournalEntry[]
): ObjectiveStopResult {
  const world = contentIdentityFrom(snapshot)
  const step = nextStep(world, journal)
  if (step.reason === 'objective-bar-reached') {
    const rung = landingBar(world)
    return { kind: 'terminal', state: 'landed', reason: `${rung} landing bar reached` }
  }
  if (step.action !== null) return null

  switch (step.reason) {
    case 'planner-retry-exhausted': {
      const detail = 'The planner failed 3 times without an accepted plan.'
      return park('plan-failed', 'planner-retry-exhausted', detail)
    }
    case 'draft-rejections-exhausted': {
      const detail = 'Draft rejected 3 times without an accepted plan.'
      return park('plan-failed', `draft-rejections-exhausted:${draftStage(world)}`, detail)
    }
    case 'plan-off-without-usable-plan': {
      const detail = 'Plan is off and this watcher has no approved plan. Enroll it again with --cap plan=gated or --cap plan=on.'
      return park('gate-held', 'plan-capability-off', detail)
    }
    case 'check-capability-off': {
      const detail = 'Check capability is off while shell criteria or gates remain unverified.'
      return park('gate-held', 'check-capability-off', detail)
    }
    case 'review-capability-off': {
      const detail = 'Review capability is off for a standard/full tier objective.'
      return park('gate-held', 'review-capability-off', detail)
    }
    case 'land-capability-off': {
      const bar = landingBar(world)
      const detail = `Land capability is off so the objective cannot reach ${bar}.`
      return park('gate-held', 'land-capability-off', detail)
    }
    case 'repair-episodes-exhausted': {
      const revision = world.revision?.number
      if (revision === undefined) return null
      const detail = `Repair limit of 3 episodes reached for revision ${revision}.`
      return park('retry-exhausted', `repair-episodes-exhausted:${revision}`, detail)
    }
    case 'repair-planner-retry-exhausted': {
      const revision = world.revision?.number
      if (revision === undefined) return null
      const episode = nextRepairEpisode(world, revision)
      const detail = 'Repair planner failed 3 times without an accepted repair patch.'
      return park('plan-failed', `repair-planner-retry-exhausted:${revision}:${episode}`, detail)
    }
    case 'reviewer-retry-exhausted': {
      const revision = world.revision?.number
      const identity = currentIdentity(world)
      if (revision === undefined || !identity) return null
      const role = reviewRoleNeedingApproval(world, latestAttempts(journal), revision, identity)
      const detail = `Review dispatch failed 3 times for revision ${revision}, role ${role}, and content identity ${identity}.`
      return park('retry-exhausted', `reviewer-retry-exhausted:${revision}:${role}:${identity}`, detail)
    }
    case 'landing-retry-exhausted': {
      const identity = currentIdentity(world)
      if (!identity) return null
      const detail = 'Local branch commit failed 3 times for the current workspace state.'
      return park('landing-failed', `landing-retry-exhausted:${identity}`, detail)
    }
    default:
      return null
  }
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
  const step = nextStep(contentIdentityFrom(snapshot), journal)
  if (step.action !== null || step.reason === 'workspace-changed') return 'rapid'
  return 'idle'
}
