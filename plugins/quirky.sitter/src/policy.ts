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
  agent?: string
}
export type CheckState = 'passed' | 'pending' | 'failed' | 'unknown'
export type SitterCheck = {
  name: string
  kind: 'check_run' | 'status' | 'approval'
  state: CheckState
  observation: string
  rerunTarget: string | null
  workflowRunId: number | null
  checkRunId: number | null
  failureSignature: string | null
  failureExcerpt: string | null
}
export type PreparedCommitKind = 'fix' | 'conflict-resolution'
export type PreparedCommitInfo = {
  sha: string
  parentCount: number
  primaryParentSha: string | null
  attemptTrailer: string | null
  dirty: boolean
  policyViolation: string | null
}
export type SitterWorld = {
  reviewNumber: number
  reviewUrl: string
  lifecycle: 'open' | 'merged' | 'closed'
  draft: boolean
  headSha: string
  baseSha: string
  baseRefName: string
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
  localHeadSha: string | null
  localDirty: boolean
  localPrepared: PreparedCommitInfo | null
}
export type FailedCheckInfo = {
  key: string
  name: string
  failureSignature: string
  failureExcerpt: string
}
type RerunCheckAction = KernelAction & { kind: 'rerun-check'; head: string; observations: string[]; checkNames: string[]; ordinal: number }
type UpdateBranchAction = KernelAction & { kind: 'update-branch'; head: string; base: string; ordinal: number }
type MergeAction = KernelAction & { kind: 'merge'; head: string; method: 'merge' | 'squash' | 'rebase'; ordinal: number }
type PrepareFixAction = KernelAction & { kind: 'prepare-fix'; expectedHeadSha: string; failedChecks: FailedCheckInfo[] }
type PublishFixAction = KernelAction & { kind: 'publish-fix'; expectedHeadSha: string; preparedCommitSha: string; prepareFingerprint: string }
type PrepareConflictAction = KernelAction & { kind: 'prepare-conflict-resolution'; expectedHeadSha: string; baseSha: string; baseRefName: string }
type PublishConflictAction = KernelAction & { kind: 'publish-conflict-resolution'; expectedHeadSha: string; preparedCommitSha: string; prepareFingerprint: string }
export type SitterAction =
  | RerunCheckAction | UpdateBranchAction | MergeAction
  | PrepareFixAction | PublishFixAction | PrepareConflictAction | PublishConflictAction
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
    workflowRunId,
    checkRunId,
    failureSignature: null,
    failureExcerpt: null
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
    baseRefName: asString(rawReview.baseRefName),
    headRefName: asString(rawReview.headRefName, payload.headRefName),
    mergeable,
    mergeStateStatus: asString(rawReview.mergeStateStatus, 'UNKNOWN'),
    reviewDecision: asString(rawReview.reviewDecision, 'UNKNOWN'),
    mergeQueueRequired,
    mergeMetadataKnown: rawReview.mergeMetadataKnown === true,
    defaultMergeMethod,
    allowedMergeMethods,
    checksComplete,
    checks: mappedChecks,
    localHeadSha: null,
    localDirty: false,
    localPrepared: null
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
  const head = typeof action.head === 'string' ? action.head : asString(action.expectedHeadSha)
  const reason = typeof failed.reason === 'string' && failed.reason.length > 0 ? failed.reason : 'unknown failure'
  return `${name} failed ${count} times on ${head.slice(0, 12)}: ${reason}`
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
  else if (action.kind === 'merge') evidenceKey = JSON.stringify(['merge', action.head, action.method, ordinal])
  else return action
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

export function checkKey(check: Pick<SitterCheck, 'kind' | 'name'>): string {
  return JSON.stringify([check.kind, check.name])
}

type FailureSetEntry =
  | Pick<SitterCheck, 'kind' | 'name' | 'failureSignature'>
  | Pick<FailedCheckInfo, 'key' | 'failureSignature'>

export function failureSetKey(checks: readonly FailureSetEntry[]): string {
  return JSON.stringify(checks
    .map((check) => ['key' in check ? check.key : checkKey(check), check.failureSignature] as const)
    .sort((left, right) => {
      const [leftKey, leftSignature] = left
      const [rightKey, rightSignature] = right
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
      if (leftSignature === rightSignature) return 0
      if (leftSignature === null) return -1
      if (rightSignature === null) return 1
      return leftSignature < rightSignature ? -1 : 1
    }))
}

const MAX_FAILURE_EXCERPT_LINES = 400
const MAX_FAILURE_EXCERPT_CHARS = 16_000

function boundedFailureExcerpt(value: string | null): string {
  const excerpt = (value ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0)
    .slice(-MAX_FAILURE_EXCERPT_LINES).join('\n')
  return excerpt.length <= MAX_FAILURE_EXCERPT_CHARS
    ? excerpt
    : excerpt.slice(-MAX_FAILURE_EXCERPT_CHARS)
}

function enabled(capability: CapabilityMode | undefined): boolean {
  return capability === 'on' || capability === 'gated'
}

function failedCheckInfo(checks: SitterCheck[]): FailedCheckInfo[] {
  return checks.map((check) => ({
    key: checkKey(check),
    name: check.name,
    failureSignature: check.failureSignature!,
    failureExcerpt: boundedFailureExcerpt(check.failureExcerpt)
  })).sort((left, right) => {
    if (left.key !== right.key) return left.key < right.key ? -1 : 1
    if (left.failureSignature === right.failureSignature) return 0
    return left.failureSignature < right.failureSignature ? -1 : 1
  })
}

function newActionIdentity(action: KernelAction): string | null {
  if (action.kind === 'prepare-fix') {
    const candidate = action as PrepareFixAction
    return Array.isArray(candidate.failedChecks)
      ? JSON.stringify([candidate.kind, candidate.expectedHeadSha, failureSetKey(candidate.failedChecks)])
      : null
  }
  if (action.kind === 'prepare-conflict-resolution') {
    const candidate = action as PrepareConflictAction
    return JSON.stringify([candidate.kind, candidate.expectedHeadSha, candidate.baseSha, candidate.baseRefName])
  }
  if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
    const candidate = action as PublishFixAction | PublishConflictAction
    return JSON.stringify([candidate.kind, candidate.expectedHeadSha, candidate.preparedCommitSha, candidate.prepareFingerprint])
  }
  return null
}

function matchingNewAttempts(action: KernelAction, journal: JournalEntry[]): Attempt[] {
  const identity = newActionIdentity(action)
  return identity === null ? [] : latestAttempts(journal).filter((attempt) => newActionIdentity(attempt.action) === identity)
}


function prepareFixAction(world: SitterWorld, checks: SitterCheck[]): PrepareFixAction {
  const failedChecks = failedCheckInfo(checks)
  const key = failureSetKey(failedChecks)
  return {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: `fix-checks:${key}`,
    evidenceKey: `${world.headSha}:${key}`,
    expectedHeadSha: world.headSha,
    failedChecks
  }
}

function prepareConflictAction(world: SitterWorld): PrepareConflictAction {
  return {
    kind: 'prepare-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: `resolve-conflicts:${world.baseSha}`,
    evidenceKey: `${world.headSha}:${world.baseSha}`,
    expectedHeadSha: world.headSha,
    baseSha: world.baseSha,
    baseRefName: world.baseRefName
  }
}

function validPreparedCommit(world: SitterWorld, attempt: Attempt, kind: PreparedCommitKind): boolean {
  const prepared = world.localPrepared
  if (!prepared || !attempt.fingerprint || prepared.attemptTrailer !== attempt.fingerprint ||
    prepared.sha === world.headSha || world.localHeadSha !== prepared.sha ||
    world.localDirty || prepared.dirty || prepared.primaryParentSha !== world.headSha ||
    prepared.policyViolation !== null) return false
  return kind === 'fix' ? prepared.parentCount === 1 : prepared.parentCount === 1 || prepared.parentCount === 2
}

function publishAction(
  world: SitterWorld,
  kind: 'publish-fix' | 'publish-conflict-resolution',
  attempt: Attempt
): PublishFixAction | PublishConflictAction | null {
  const prepared = world.localPrepared
  if (!prepared || !validPreparedCommit(world, attempt, kind === 'publish-fix' ? 'fix' : 'conflict-resolution')) return null
  const capability = kind === 'publish-fix' ? 'fixChecks' : 'resolveConflicts'
  return {
    kind,
    capability,
    visibility: 'external',
    recovery: 'replay-safe',
    contentIdentity: `${kind}:${prepared.sha}`,
    evidenceKey: world.headSha,
    preparedCommitSha: prepared.sha,
    expectedHeadSha: world.headSha,
    prepareFingerprint: attempt.fingerprint
  }
}

function persistedFailures(world: SitterWorld, journal: JournalEntry[], checks: SitterCheck[]): SitterCheck[] {
  const rerunByName = new Map<string, RerunCheckAction>()
  for (const attempt of latestAttempts(journal)) {
    if (attempt.action.kind !== 'rerun-check' || attempt.state !== 'settled' || attempt.effect !== 'landed') continue
    const rerun = attempt.action as RerunCheckAction
    if (rerun.head !== world.headSha) continue
    for (const name of rerun.checkNames) rerunByName.set(name, rerun)
  }
  return checks.filter((check) => {
    const rerun = rerunByName.get(check.name)
    return rerun !== undefined && !rerun.observations.includes(check.observation)
  })
}

function park(reason: string, predicate: string, deviationKind: OwnerDeviationKind, naturalKey: string): StopResult {
  const detail = `${predicate}: ${reason}`
  return {
    kind: 'park',
    reason: 'stop-predicate',
    detail,
    deviation: { kind: deviationKind, naturalKey, detail }
  }
}

function isApprovalReady(world: SitterWorld): boolean {
  return world.reviewDecision === 'APPROVED' || world.reviewDecision === 'NONE'
}

function hasCleanPrepareWorkspace(world: SitterWorld): boolean {
  return world.localHeadSha === world.headSha && !world.localDirty && world.localPrepared === null
}


function prepareIsBlocked(attempts: Attempt[]): boolean {
  return attempts.some((attempt) =>
    attempt.state !== 'settled' || attempt.effect === 'indeterminate' || attempt.resolved === false
  )
}
function newActionHoldReason(action: KernelAction, journal: JournalEntry[]): string | null {
  const attempts = matchingNewAttempts(action, journal)
  if (attempts.some((attempt) =>
    attempt.state !== 'settled' || attempt.effect === 'indeterminate' || attempt.resolved === false
  )) return 'action-in-flight'
  return attempts.at(-1)?.effect === 'landed' ? 'awaiting-action-state' : null
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
    if (world.mergeable !== 'CONFLICTING' || !enabled(enrollment.capabilities.resolveConflicts) ||
      snapshot.freshness !== 'live' || world.draft || !world.mergeMetadataKnown || !isApprovalReady(world)) {
      return noAction('conflicts-present', considered)
    }
    const prepare = prepareConflictAction(world)
    const attempts = matchingNewAttempts(prepare, journal)
    if (prepareIsBlocked(attempts)) return noAction('prepare-in-flight', considered)
    const previous = attempts.at(-1)
    if (previous?.state === 'settled' && previous.effect === 'landed') {
      if (world.localPrepared?.policyViolation) return noAction('diff-policy-violation', considered)
      const publish = publishAction(world, 'publish-conflict-resolution', previous)
      if (!publish) return noAction('unverified-prepared-commit', considered)
      const held = newActionHoldReason(publish, journal)
      if (held !== null) return noAction('publish-in-flight', considered)
      return { action: publish, considered }
    }
    if (previous?.reason === 'worker-failed' || !hasCleanPrepareWorkspace(world)) {
      return noAction('conflicts-present', considered)
    }
    return { action: prepare, considered }
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

    if (snapshot.freshness === 'live' && enabled(enrollment.capabilities.fixChecks) && !world.draft && world.mergeMetadataKnown &&
      isApprovalReady(world) && runnableChecks.every((check) => Boolean(check.failureSignature))) {
      const prepare = prepareFixAction(world, runnableChecks)
      const prepareAttempts = matchingNewAttempts(prepare, journal)
      if (prepareIsBlocked(prepareAttempts)) return noAction('prepare-in-flight', considered)
      const previous = prepareAttempts.at(-1)
      if (previous?.state === 'settled' && previous.effect === 'landed') {
        if (world.localPrepared?.policyViolation) return noAction('diff-policy-violation', considered)
        const publish = publishAction(world, 'publish-fix', previous)
        if (!publish) return noAction('unverified-prepared-commit', considered)
        if (newActionHoldReason(publish, journal) !== null) return noAction('publish-in-flight', considered)
        return { action: publish, considered }
      }
      if (previous?.reason === 'worker-failed') return noAction('prepare-failed', considered)
    }

    const persisted = persistedFailures(world, journal, runnableChecks)
    if (persisted.length > 0) {
      considered[considered.length - 1] = 'fix-checks: failure-persisted-after-rerun'
      if (!enabled(enrollment.capabilities.fixChecks)) return noAction('failure-persisted-after-rerun', considered)
      if (persisted.some((check) => !check.failureSignature)) {
        return noAction('unverifiable-reproduced-failure', considered)
      }
      if (snapshot.freshness === 'live' && !world.draft && world.mergeMetadataKnown && isApprovalReady(world)) {
        const prepare = prepareFixAction(world, persisted)
        const attempts = matchingNewAttempts(prepare, journal)
        if (prepareIsBlocked(attempts)) return noAction('prepare-in-flight', considered)
        const previous = attempts.at(-1)
        if (previous?.state === 'settled' && previous.effect === 'landed') {
          if (world.localPrepared?.policyViolation) return noAction('diff-policy-violation', considered)
          const publish = publishAction(world, 'publish-fix', previous)
          if (!publish) return noAction('unverified-prepared-commit', considered)
          const held = newActionHoldReason(publish, journal)
          if (held !== null) return noAction('publish-in-flight', considered)
          return { action: publish, considered }
        }
        if (previous?.reason === 'worker-failed' || !hasCleanPrepareWorkspace(world)) {
          return noAction('failure-persisted-after-rerun', considered)
        }
        return { action: prepare, considered }
      }
      return noAction('failure-persisted-after-rerun', considered)
    }

    const alreadyRerun = landedRerunNames(world, journal)
    const remainingChecks = runnableChecks.filter((check) => !alreadyRerun.has(check.name))
    if (remainingChecks.length > 0 && enabled(enrollment.capabilities.fixChecks)) {
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
  if (planned.action === null || !['rerun-check', 'update-branch', 'merge'].includes(planned.action.kind)) return planned
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
  if (world.localPrepared && world.localPrepared.policyViolation !== null) {
    return park(
      world.localPrepared.policyViolation,
      'diff-policy-violation',
      'report-rejected',
      `diff-policy-violation:${world.localPrepared.sha}`
    )
  }

  const attempts = latestAttempts(journal)
  const prepareByIdentity = new Map<string, Attempt>()
  for (const attempt of attempts) {
    if (attempt.action.kind !== 'prepare-fix' && attempt.action.kind !== 'prepare-conflict-resolution') continue
    const identity = newActionIdentity(attempt.action)
    if (identity !== null) prepareByIdentity.set(identity, attempt)
  }
  for (const attempt of attempts) {
    if (attempt.action.kind !== 'publish-fix' || attempt.state !== 'settled' || attempt.effect !== 'landed') continue
    const publish = attempt.action as PublishFixAction
    if (publish.preparedCommitSha !== world.headSha) continue
    const latestPublish = matchingNewAttempts(publish, journal).at(-1)
    if (!latestPublish || latestPublish.state !== 'settled' || latestPublish.effect !== 'landed') continue
    const sameFailure = world.checks.some((check) =>
      check.state === 'failed' && [...prepareByIdentity.values()].some((entry) => {
        if (entry.state !== 'settled' || entry.effect !== 'landed' || entry.fingerprint !== publish.prepareFingerprint) return false
        const prepare = entry.action as PrepareFixAction
        return prepare.expectedHeadSha === publish.expectedHeadSha &&
          Array.isArray(prepare.failedChecks) &&
          prepare.failedChecks.some((failed) => failed.key === checkKey(check) && failed.failureSignature === check.failureSignature)
      })
    )
    if (sameFailure) {
      return park(
        `the same check failure returned on ${world.headSha}`,
        'repeated-failure-after-own-fix',
        'check-failed',
        `repeated-failure-after-own-fix:${world.headSha}`
      )
    }
  }

  for (const attempt of prepareByIdentity.values()) {
    if (attempt.action.expectedHeadSha !== world.headSha) continue
    if (attempt.state === 'settled' && attempt.effect === 'not-landed' && attempt.reason === 'worker-failed') {
      return park(
        attempt.reason,
        'unverified-prepared-commit',
        'report-rejected',
        `unverified-prepared-commit:${world.headSha}`
      )
    }
    if (attempt.state === 'settled' && attempt.effect === 'landed') {
      const kind = attempt.action.kind === 'prepare-fix' ? 'fix' : 'conflict-resolution'
      if (!validPreparedCommit(world, attempt, kind)) {
        return park(
          'prepare did not produce a clean commit with the expected parent and attempt trailer',
          'unverified-prepared-commit',
          'report-rejected',
          `unverified-prepared-commit:${world.headSha}`
        )
      }
    }
  }

  const conflicting = world.mergeable === 'CONFLICTING' || world.mergeStateStatus === 'DIRTY'
  if (conflicting && !enabled(enrollment.capabilities.resolveConflicts)) {
    return park('merge conflicts are present', 'conflicts-present', 'landing-failed', `conflicts-present:${world.headSha}`)
  }
  const runnable = world.checks.filter((check) =>
    check.state === 'failed' && check.kind === 'check_run' && check.rerunTarget !== null
  )
  const persisted = world.checksComplete ? persistedFailures(world, journal, runnable) : []
  if (persisted.length > 0 && !enabled(enrollment.capabilities.fixChecks)) {
    return park(
      'checks remain failed after rerun',
      'failure-persisted-after-rerun',
      'check-failed',
      `failure-persisted-after-rerun:${world.headSha}`
    )
  }
  if (persisted.some((check) => !check.failureSignature)) {
    return park(
      'persisted check failure has no verifiable signature',
      'unverifiable-reproduced-failure',
      'check-failed',
      `unverifiable-reproduced-failure:${world.headSha}`
    )
  }

  const planned = plan(snapshot, journal, enrollment)
  if (planned.action === null || !['rerun-check', 'update-branch', 'merge'].includes(planned.action.kind)) return null
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
  if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
    if (snapshot.freshness !== 'live') return null
    const publish = action as PublishFixAction | PublishConflictAction
    if (world.headSha === publish.preparedCommitSha) return { effect: 'landed' }
    if (world.headSha !== publish.expectedHeadSha) return { effect: 'not-landed', reason: 'head-moved' }
    return null
  }
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
