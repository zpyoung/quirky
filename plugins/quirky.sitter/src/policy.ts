export const UNOBSERVED_EFFECT_MS = 600_000
export const RETRY_LIMIT = 3
export const RETRY_DELAY_MS = 120_000

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type CapabilityMode = 'off' | 'gated' | 'on'
export type PacingTier = 'rapid' | 'active' | 'idle' | 'stopped'
export type ParkReason = 'budget' | 'stop-predicate' | 'worker-question' | 'worker-escalation' | 'coordinator-seat-lost' | 'configuration-error' | 'owner-escalation'
export type OwnerDeviationKind =
  | 'report-rejected' | 'node-failed' | 'retry-exhausted' | 'worker-question' | 'worker-escalation'
  | 'worker-unverifiable' | 'worker-exited' | 'check-failed' | 'review-blocked' | 'landing-failed'
  | 'plan-failed' | 'gate-held' | 'stall'
export interface OwnerDeviation {
  kind: OwnerDeviationKind
  naturalKey: string
  detail: string
  dispatchId?: string
  messageId?: string
  trigger?: 'idle' | 'silent'
}
export interface Snapshot<W = Json> {
  freshness: 'live' | 'cached'
  contentIdentity: string
  observedAtMs: number
  world: W
}
export interface KernelAction {
  kind: string
  capability: string
  visibility: 'external' | 'local'
  contentIdentity: string
  evidenceKey: string
  recovery?: 'replay-safe'
  expectedState?: { target: string; before: Json }
  approvalRequired?: boolean
  [key: string]: unknown
}
export interface JournalEntry {
  seq: number
  eventId: string
  watcherId: string
  atMs: number
  class: 'fact' | 'observation'
  origin: 'owner' | 'client'
  kind: string
  resolved: boolean
  [key: string]: unknown
}
export type ExecuteResult = {
  effect: 'landed' | 'not-landed' | 'indeterminate'
  reason?: string
  expectedAfter?: Json
  failureClass?: string
}
export interface Attempt extends JournalEntry {
  kind: 'attempt'
  attemptId: string
  fingerprint: string
  action: KernelAction
  state: 'attempted' | 'running' | 'settled'
  effect?: ExecuteResult['effect']
  reason?: string
  workerRequest?: { spec: string; worktree: string; agent?: string; mode?: 'terminal' | 'structured'; taskTitle?: string; [key: string]: unknown }
  requestId?: string
  dispatchId?: string
  generation?: string
}
export type Decision<A extends KernelAction = KernelAction> =
  | { action: A; considered?: string[] }
  | { action: null; reason: string; detail?: string; considered?: string[]; deviation?: undefined }
  | { action: null; deviation: OwnerDeviation; reason?: string; detail?: string; considered?: string[] }
export type StopResult =
  | { kind: 'terminal'; state: string; reason: string }
  | { kind: 'park'; reason: ParkReason; detail: string; deviation?: OwnerDeviation }
  | null

export type SitterPayload = {
  worktreeId: string
  branch: string
  headRefName: string
  provider: 'github'
  reviewNumber: number
  reviewUrl: string
  repository: { host: string; owner: string; repo: string }
  branchUpdateMode: 'merge-base-update'
  mergeMethod: 'merge' | 'squash' | 'rebase' | null
  mergeCheckScope: 'all'
}
export type CheckState = 'passed' | 'pending' | 'failed' | 'unknown'
export type SitterCheck = {
  name: string
  kind: 'check_run' | 'status' | 'approval'
  state: CheckState
  observation: string
  rerunTarget: string | null
  workflowRunId: number | null
}
export type SitterWorld = {
  reviewNumber: number
  reviewUrl: string
  lifecycle: 'open' | 'merged' | 'closed'
  draft: boolean
  headSha: string
  baseSha: string
  headRefName: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  reviewDecision: string
  mergeQueueRequired: boolean | null
  mergeMetadataKnown: boolean
  defaultMergeMethod: 'merge' | 'squash' | 'rebase' | null
  allowedMergeMethods: string[]
  checksComplete: boolean
  checks: SitterCheck[]
}
type RerunCheckAction = KernelAction & { kind: 'rerun-check'; head: string; observations: string[]; checkNames: string[]; ordinal: number }
type UpdateBranchAction = KernelAction & { kind: 'update-branch'; head: string; base: string; ordinal: number }
type MergeAction = KernelAction & { kind: 'merge'; head: string; method: 'merge' | 'squash' | 'rebase'; ordinal: number }
export type SitterAction = RerunCheckAction | UpdateBranchAction | MergeAction
export type SitterEnrollment = { capabilities: Record<string, CapabilityMode>; kindPayload: SitterPayload }

const CHECK_RUN_FAILURES: Record<string, true> = {
  failure: true, timed_out: true, action_required: true, startup_failure: true, stale: true, error: true, cancelled: true
}

const CHECK_RUN_RERUN_FAILURES: Record<string, true> = {
  failure: true, timed_out: true, startup_failure: true, cancelled: true
}
const CHECK_RUN_PENDING: Record<string, true> = {
  queued: true, in_progress: true, requested: true, waiting: true, pending: true, expected: true
}
const RESET_EVIDENCE: Record<string, true> = { 'operator-resume': true, 'budget-generation': true }

type RecordValue = Record<string, unknown>
type RetryState = { failures: Attempt[]; failuresAfterReset: Attempt[]; ordinal: number }

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isMergeMethod(value: unknown): value is 'merge' | 'squash' | 'rebase' {
  return value === 'merge' || value === 'squash' || value === 'rebase'
}

function checkState(kind: SitterCheck['kind'], status: string, conclusion: string): CheckState {
  if (kind === 'approval') return 'pending'
  if (kind === 'status') {
    if (status === 'success') return 'passed'
    if (status === 'failure' || status === 'error') return 'failed'
    if (status === 'pending' || status === 'expected') return 'pending'
    return 'unknown'
  }
  if (status !== 'completed') return Object.hasOwn(CHECK_RUN_PENDING, status) ? 'pending' : 'unknown'
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return 'passed'
  if (Object.hasOwn(CHECK_RUN_FAILURES, conclusion)) return 'failed'
  return 'unknown'
}

function mapCheck(value: unknown): SitterCheck | null {
  if (!isRecord(value)) return null
  const kind = value.kind === 'check_run' || value.kind === 'approval' ? value.kind : 'status'
  const name = asString(value.name, 'Unnamed check')
  const status = asString(value.status)
  const conclusion = asString(value.conclusion)
  const checkRunId = nullableNumber(value.checkRunId)
  const workflowRunId = nullableNumber(value.workflowRunId)
  const state = checkState(kind, status, conclusion)
  const rerunTarget = kind === 'check_run' &&
    (state !== 'failed' || Object.hasOwn(CHECK_RUN_RERUN_FAILURES, conclusion))
    ? workflowRunId !== null ? `workflow:${workflowRunId}` : checkRunId !== null ? `check:${checkRunId}` : null
    : null
  return {
    name,
    kind,
    state,
    observation: `${kind}:${checkRunId ?? ''}:${workflowRunId ?? ''}:${status}:${conclusion}`,
    rerunTarget,
    workflowRunId
  }
}

export function worldFromHosting(review: unknown, checks: unknown | null, payload: SitterPayload): SitterWorld {
  const rawReview = isRecord(review) ? review : {}
  const state = asString(rawReview.state)
  const lifecycle = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : state === 'open' || state === 'draft' ? 'open' : 'closed'
  const headRefOid = asString(rawReview.headRefOid)
  const mergeMethods = isRecord(rawReview.mergeMethods) ? rawReview.mergeMethods : {}
  const allowedRaw = Array.isArray(mergeMethods.allowed) ? mergeMethods.allowed : []
  const allowedMergeMethods = allowedRaw.filter(isMergeMethod)
  const defaultMergeMethod = isMergeMethod(mergeMethods.default) ? mergeMethods.default : null
  const rawChecks = isRecord(checks) ? checks : null
  const checkRows = rawChecks !== null && Array.isArray(rawChecks.checks) ? rawChecks.checks : []
  const mappedChecks = checkRows.map(mapCheck).filter((value): value is SitterCheck => value !== null)

  const checksComplete = checks === null || (
    rawChecks !== null &&
    Array.isArray(rawChecks.checks) &&
    mappedChecks.length === checkRows.length &&
    rawChecks.partial !== true &&
    rawChecks.headSha === headRefOid
  )
  const mergeable = rawReview.mergeable === 'MERGEABLE' || rawReview.mergeable === 'CONFLICTING' || rawReview.mergeable === 'UNKNOWN'
    ? rawReview.mergeable
    : 'UNKNOWN'
  const mergeQueueRequired = typeof rawReview.mergeQueueRequired === 'boolean' || rawReview.mergeQueueRequired === null
    ? rawReview.mergeQueueRequired
    : null
  return {
    reviewNumber: asNumber(rawReview.number, payload.reviewNumber),
    reviewUrl: asString(rawReview.url, payload.reviewUrl),
    lifecycle,
    draft: state === 'draft' || rawReview.draft === true || rawReview.isDraft === true,
    headSha: headRefOid,
    baseSha: asString(rawReview.baseRefOid),
    headRefName: asString(rawReview.headRefName, payload.headRefName),
    mergeable,
    mergeStateStatus: asString(rawReview.mergeStateStatus, 'UNKNOWN'),
    reviewDecision: asString(rawReview.reviewDecision, 'UNKNOWN'),
    mergeQueueRequired,
    mergeMetadataKnown: rawReview.mergeMetadataKnown === true,
    defaultMergeMethod,
    allowedMergeMethods,
    checksComplete,
    checks: mappedChecks
  }
}

export function contentIdentity(world: SitterWorld): string {
  return JSON.stringify([world.headSha, world.baseSha])
}

function actionIdentity(action: KernelAction): string | null {
  if (action.kind === 'rerun-check') {
    const candidate = action as RerunCheckAction
    return JSON.stringify(['rerun-check', candidate.head, candidate.checkNames])
  }
  if (action.kind === 'update-branch') {
    const candidate = action as UpdateBranchAction
    return JSON.stringify(['update-branch', candidate.head, candidate.base])
  }
  if (action.kind === 'merge') {
    const candidate = action as MergeAction
    return JSON.stringify(['merge', candidate.head, candidate.method])
  }
  return null
}

function latestAttempts(journal: JournalEntry[]): Attempt[] {
  const byId = new Map<string, Attempt>()
  for (const entry of [...journal].sort((left, right) => left.seq - right.seq)) {
    if (entry.kind !== 'attempt' || typeof entry.attemptId !== 'string' || !isRecord(entry.action)) continue
    const previous = byId.get(entry.attemptId)
    if (!previous || entry.seq >= previous.seq) byId.set(entry.attemptId, entry as Attempt)
  }
  return [...byId.values()].sort((left, right) => left.seq - right.seq)
}

function retryState(action: SitterAction, journal: JournalEntry[]): RetryState {
  const identity = actionIdentity(action)
  const failures = latestAttempts(journal).filter((attempt) =>
    attempt.state === 'settled' && attempt.effect === 'not-landed' &&
    identity !== null && actionIdentity(attempt.action) === identity
  )
  const latestResetSeq = journal.reduce((latest, entry) => {
    if (entry.kind === 'evidence' && typeof entry.evidenceKind === 'string' && Object.hasOwn(RESET_EVIDENCE, entry.evidenceKind)) {
      return Math.max(latest, entry.seq)
    }
    return latest
  }, -1)
  const failuresAfterReset = failures.filter((attempt) => attempt.seq > latestResetSeq)
  return { failures, failuresAfterReset, ordinal: failures.length + 1 }
}

function failureDetail(action: SitterAction, failed: Attempt, count: number): string {
  const name = action.kind
  const reason = typeof failed.reason === 'string' && failed.reason.length > 0 ? failed.reason : 'unknown failure'
  return `${name} failed ${count} times on ${action.head.slice(0, 12)}: ${reason}`
}

function retryDetail(action: SitterAction, retry: RetryState): string | undefined {
  const latestFailure = retry.failures.at(-1)
  return latestFailure
    ? `${action.kind} attempt ${retry.ordinal} after ${new Date(latestFailure.atMs + RETRY_DELAY_MS).toISOString()}`
    : undefined
}

function noAction(reason: string, considered: string[], detail?: string): Decision<SitterAction> {
  return {
    action: null,
    reason,
    ...(detail === undefined ? {} : { detail }),
    considered
  }
}

function makeActionBase(kind: SitterAction['kind'], world: SitterWorld, capability: string, fields: Record<string, unknown>): KernelAction {
  return {
    kind,
    capability,
    visibility: 'external',
    contentIdentity: contentIdentity(world),
    evidenceKey: '',
    ...fields
  }
}

function withOrdinal(action: SitterAction, ordinal: number): SitterAction {
  let evidenceKey: string
  if (action.kind === 'rerun-check') evidenceKey = JSON.stringify(['rerun-check', action.head, action.checkNames, ordinal])
  else if (action.kind === 'update-branch') evidenceKey = JSON.stringify(['update-branch', action.head, action.base, ordinal])
  else evidenceKey = JSON.stringify(['merge', action.head, action.method, ordinal])
  return { ...action, ordinal, evidenceKey }
}

function buildRerunAction(world: SitterWorld, checks: SitterCheck[], journal: JournalEntry[]): SitterAction {
  const ordered = [...checks].sort((left, right) => left.name.localeCompare(right.name) || left.observation.localeCompare(right.observation))
  const checkNames = [...new Set(ordered.map((value) => value.name))]
  const action = makeActionBase('rerun-check', world, 'fixChecks', {
    head: world.headSha,
    observations: [...new Set(ordered.map((value) => value.observation))],
    checkNames,
    ordinal: 1,
    expectedState: { target: `${world.reviewUrl}#checks`, before: world.headSha }
  }) as SitterAction
  return withOrdinal(action, retryState(action, journal).ordinal)
}

function buildUpdateAction(world: SitterWorld, journal: JournalEntry[]): SitterAction {
  const action = makeActionBase('update-branch', world, 'updateBranch', {
    head: world.headSha,
    base: world.baseSha,
    ordinal: 1,
    expectedState: { target: `${world.reviewUrl}#head`, before: world.headSha }
  }) as SitterAction
  return withOrdinal(action, retryState(action, journal).ordinal)
}

function buildMergeAction(world: SitterWorld, method: 'merge' | 'squash' | 'rebase', journal: JournalEntry[]): SitterAction {
  const action = makeActionBase('merge', world, 'merge', {
    head: world.headSha,
    method,
    ordinal: 1,
    expectedState: { target: world.reviewUrl, before: world.headSha }
  }) as SitterAction
  return withOrdinal(action, retryState(action, journal).ordinal)
}

function matchingAttempts(action: SitterAction, journal: JournalEntry[]): Attempt[] {
  const identity = actionIdentity(action)
  return latestAttempts(journal).filter((attempt) => identity !== null && actionIdentity(attempt.action) === identity)
}

function blockForRerun(world: SitterWorld, journal: JournalEntry[], candidateNames: string[]): string | null {
  const relevant = latestAttempts(journal).filter((attempt) => {
    if (attempt.action.kind !== 'rerun-check') return false
    const action = attempt.action as RerunCheckAction
    return action.head === world.headSha && action.checkNames.some((name) => candidateNames.includes(name))
  })
  if (relevant.some((attempt) => attempt.state !== 'settled' || attempt.effect === 'indeterminate')) return 'rerun-in-flight'
  if (relevant.some((attempt) => attempt.effect === 'landed' &&
    (attempt.action as RerunCheckAction).observations
      .some((observation) => world.checks.some((check) => check.state === 'failed' && check.observation === observation)))) {
    return 'awaiting-rerun-result'
  }
  return null
}

function landedRerunNames(world: SitterWorld, journal: JournalEntry[]): Set<string> {
  const result = new Set<string>()
  for (const attempt of latestAttempts(journal)) {
    if (attempt.action.kind !== 'rerun-check' || attempt.state !== 'settled' || attempt.effect !== 'landed') continue
    const action = attempt.action as RerunCheckAction
    if (action.head === world.headSha) for (const name of action.checkNames) result.add(name)
  }
  return result
}

function latestAttemptFor(action: SitterAction, journal: JournalEntry[]): Attempt | null {
  return matchingAttempts(action, journal).at(-1) ?? null
}

function mergeGates(world: SitterWorld, enrollment: SitterEnrollment): string[] {
  const failed: string[] = []
  if (enrollment.capabilities.merge !== 'on' && enrollment.capabilities.merge !== 'gated') failed.push('capability')
  if (world.draft) failed.push('draft')
  if (world.mergeable !== 'MERGEABLE') failed.push('conflicts')
  if (!world.checksComplete || world.checks.some((check) => check.state !== 'passed')) failed.push('checks')
  if (world.reviewDecision !== 'APPROVED' && world.reviewDecision !== 'NONE') failed.push('approvals')
  if (world.mergeStateStatus !== 'CLEAN') failed.push('readiness')
  if (world.mergeQueueRequired !== false || world.mergeMetadataKnown !== true) failed.push('merge-queue')
  const method = enrollment.kindPayload.mergeMethod ?? world.defaultMergeMethod
  if (method === null || !world.allowedMergeMethods.includes(method)) failed.push('merge-method')
  return failed
}

function plan(snapshot: Snapshot<SitterWorld>, journal: JournalEntry[], enrollment: SitterEnrollment): Decision<SitterAction> {
  const world = snapshot.world
  const considered = ['lifecycle']
  if (world.lifecycle !== 'open') return noAction('review-not-open', considered)

  considered.push('conflicts')
  if (world.mergeable === 'CONFLICTING' || world.mergeStateStatus === 'DIRTY') {
    return noAction('conflicts-present', considered)
  }

  considered.push('fix-checks')
  const failedChecks = world.checks.filter((check) => check.state === 'failed')
  const runnableChecks = failedChecks.filter((check) => check.kind === 'check_run' && check.rerunTarget !== null)
  const rerunNames = [...new Set(runnableChecks.map((check) => check.name))].sort((left, right) => left.localeCompare(right))
  if (runnableChecks.length > 0 && !world.checksComplete) {
    considered[considered.length - 1] = 'fix-checks: checks-incomplete'
    return noAction('checks-incomplete', considered)
  }
  if (runnableChecks.length > 0) {
    const workflows = new Set(runnableChecks.flatMap((check) => check.workflowRunId === null ? [] : [check.workflowRunId]))
    if (world.checks.some((check) => check.state === 'pending' && check.workflowRunId !== null && workflows.has(check.workflowRunId))) {
      considered[considered.length - 1] = 'fix-checks: awaiting-workflow-run'
      return noAction('awaiting-workflow-run', considered)
    }
    const rerunBlock = blockForRerun(world, journal, rerunNames)
    if (rerunBlock !== null) {
      considered[considered.length - 1] = `fix-checks: ${rerunBlock}`
      return noAction(rerunBlock, considered)
    }
    const alreadyRerun = landedRerunNames(world, journal)
    const remainingChecks = runnableChecks.filter((check) => !alreadyRerun.has(check.name))
    if (remainingChecks.length > 0 && enrollment.capabilities.fixChecks !== 'off') {
      return { action: buildRerunAction(world, remainingChecks, journal), considered }
    }
    if (remainingChecks.length > 0) considered[considered.length - 1] = 'fix-checks: capability-off'
    else considered[considered.length - 1] = 'fix-checks: failure-persisted-after-rerun'
  } else if (failedChecks.length > 0) {
    considered[considered.length - 1] = 'fix-checks: check-rerun-unavailable'
  } else {
    considered[considered.length - 1] = 'fix-checks: no-failed-checks'
  }

  considered.push('update-branch')
  if (world.mergeStateStatus === 'BEHIND') {
    if (world.draft) {
      considered[considered.length - 1] = 'update-branch: draft'
    } else if (world.checks.some((check) => check.state === 'pending')) {
      considered[considered.length - 1] = 'update-branch: awaiting-checks'
      return noAction('awaiting-checks', considered)
    } else if (!world.checksComplete) {
      considered[considered.length - 1] = 'update-branch: checks-incomplete'
      return noAction('checks-incomplete', considered)
    } else if (enrollment.capabilities.updateBranch === 'off') {
      considered[considered.length - 1] = 'update-branch: capability-off'
    } else {
      const action = buildUpdateAction(world, journal)
      const previous = latestAttemptFor(action, journal)
      if (previous && (previous.state !== 'settled' || previous.effect === 'indeterminate' ||
        (previous.effect === 'landed' && previous.action.kind === 'update-branch' && previous.action.head === world.headSha))) {
        considered[considered.length - 1] = 'update-branch: awaiting-branch-update'
        return noAction('awaiting-branch-update', considered)
      }
      return { action, considered }
    }
  } else {
    considered[considered.length - 1] = 'update-branch: not-behind'
  }

  considered.push('merge-gates')
  const failedGates = mergeGates(world, enrollment)
  if (failedGates.length > 0) return noAction('merge-gates-unsatisfied', considered, failedGates.join(','))

  considered.push('merge')
  const method = enrollment.kindPayload.mergeMethod ?? world.defaultMergeMethod
  if (method === null || !isMergeMethod(method)) return noAction('merge-gates-unsatisfied', considered, 'merge-method')
  const action = buildMergeAction(world, method, journal)
  const previous = latestAttemptFor(action, journal)
  if (previous && (previous.state !== 'settled' || previous.effect === 'indeterminate' ||
    (previous.effect === 'landed' && previous.action.kind === 'merge' && previous.action.head === world.headSha))) {
    return noAction('awaiting-merge-state', considered)
  }
  return { action, considered }
}

export function decide(snapshot: Snapshot<SitterWorld>, journal: JournalEntry[], enrollment: SitterEnrollment): Decision<SitterAction> {
  const planned = plan(snapshot, journal, enrollment)
  if (planned.action === null) return planned
  const retry = retryState(planned.action, journal)
  if (retry.failuresAfterReset.length >= RETRY_LIMIT) {
    const lastFailure = retry.failuresAfterReset.at(-1)!
    const detail = failureDetail(planned.action, lastFailure, retry.failuresAfterReset.length)
    return noAction('retries-exhausted', planned.considered ?? [], detail)
  }
  const waitDetail = retryDetail(planned.action, retry)
  if (waitDetail !== undefined && snapshot.observedAtMs < retry.failures.at(-1)!.atMs + RETRY_DELAY_MS) {
    return noAction('retry-waiting', planned.considered ?? [], waitDetail)
  }
  return { action: withOrdinal(planned.action, retry.ordinal), considered: planned.considered }
}

export function stop(snapshot: Snapshot<SitterWorld>, journal: JournalEntry[], enrollment: SitterEnrollment): StopResult {
  const world = snapshot.world
  if (world.lifecycle !== 'open') {
    return {
      kind: 'terminal',
      state: world.lifecycle,
      reason: world.lifecycle === 'merged' ? 'review merged' : 'review closed'
    }
  }
  const planned = plan(snapshot, journal, enrollment)
  if (planned.action === null) return null
  const retry = retryState(planned.action, journal)
  if (retry.failuresAfterReset.length < RETRY_LIMIT) return null
  const lastFailure = retry.failuresAfterReset.at(-1)!
  return {
    kind: 'park',
    reason: 'stop-predicate',
    detail: failureDetail(planned.action, lastFailure, retry.failuresAfterReset.length)
  }
}

export function resolveOutcome(attempt: Attempt, snapshot: Snapshot<SitterWorld>): ExecuteResult | null {
  const action = attempt.action
  const world = snapshot.world
  const age = snapshot.observedAtMs - attempt.atMs
  if (action.kind === 'merge') {
    const merge = action as MergeAction
    if (world.lifecycle === 'merged') return { effect: 'landed' }
    if (world.lifecycle === 'open' && world.headSha !== merge.head) return { effect: 'not-landed', reason: 'head-moved' }
    if (age >= UNOBSERVED_EFFECT_MS) return { effect: 'not-landed', reason: 'no-merge-observed' }
    return null
  }
  if (action.kind === 'update-branch') {
    const update = action as UpdateBranchAction
    if (world.headSha !== update.head) {
      return { effect: 'landed', expectedAfter: { head: world.headSha } }
    }
    if (age >= UNOBSERVED_EFFECT_MS) return { effect: 'not-landed', reason: 'no-update-observed' }
    return null
  }
  if (action.kind === 'rerun-check') {
    const rerun = action as RerunCheckAction
    if (world.headSha !== rerun.head) return { effect: 'not-landed', reason: 'head-moved' }
    if (rerun.observations.some((observation) => !world.checks.some((check) => check.observation === observation))) {
      return { effect: 'landed' }
    }
    if (age >= UNOBSERVED_EFFECT_MS) return { effect: 'not-landed', reason: 'no-rerun-observed' }
  }
  return null
}

function retryIsWaiting(snapshot: Snapshot<SitterWorld>, journal: JournalEntry[]): boolean {
  return latestAttempts(journal).some((attempt) =>
    attempt.state === 'settled' && attempt.effect === 'not-landed' &&
    attempt.action.head === snapshot.world.headSha &&
    (attempt.action.kind !== 'update-branch' || attempt.action.base === snapshot.world.baseSha) &&
    snapshot.observedAtMs < attempt.atMs + RETRY_DELAY_MS
  )
}

export function pace(snapshot: Snapshot<SitterWorld>, journal: JournalEntry[]): PacingTier {
  const world = snapshot.world
  if (world.lifecycle !== 'open') return 'stopped'
  const attempts = latestAttempts(journal)
  if (attempts.some((attempt) => attempt.state !== 'settled' || attempt.effect === 'indeterminate')) return 'rapid'
  if (world.checks.some((check) => check.state === 'pending')) return 'rapid'
  for (const attempt of attempts) {
    if (attempt.effect !== 'landed' || attempt.state !== 'settled') continue
    const action = attempt.action
    if (action.kind === 'rerun-check') {
      const rerun = action as RerunCheckAction
      if (rerun.head === world.headSha && world.checks.some((check) =>
        check.state === 'failed' && rerun.observations.includes(check.observation))) return 'rapid'
    }
    if ((action.kind === 'update-branch' || action.kind === 'merge') &&
      (action as UpdateBranchAction | MergeAction).head === world.headSha) return 'rapid'
  }
  if (world.mergeable === 'CONFLICTING' || world.mergeStateStatus === 'DIRTY' ||
    world.checks.some((check) => check.state === 'failed') || world.mergeStateStatus === 'BEHIND' ||
    retryIsWaiting(snapshot, journal)) return 'active'
  return 'idle'
}
