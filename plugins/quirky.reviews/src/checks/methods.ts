import type { PluginCaller, Schema, Worktree } from '@quirky/protocol'
import { isRecord } from './data'
import {
  REVIEW_VIEW,
  type ChecksState,
  type DetailState,
  type JsonRecord,
  type MethodSpec,
  type ReviewData,
  type ReviewMethodTable,
  type ReviewsEnv,
  type ReviewsState
} from '../contracts'

const MIN_HEIGHT = 160
const MAX_HEIGHT = 800
const MAX_TITLE_LENGTH = 256
const MAX_PROMPT_LENGTH = 32_000
const MAX_AGENT_ARGS_LENGTH = 2_000
const MAX_CHECKS = 100

type RepoIdentity = { host: string; owner: string; repo: string }
type LookupResult = { kind: 'found' | 'no-review' | 'unavailable'; review?: ReviewData; record: JsonRecord }
type GitStatus = {
  branch: string | null
  head: string | null
  detached: boolean
  operation: 'none' | 'merge' | 'rebase' | 'cherry-pick'
  entries: JsonRecord[]
  files: JsonRecord[]
  upstreamStatus: JsonRecord
  busy: string | null
  capped: boolean
}
type ReplyTarget = { commentId: number; queuedKeys: Set<string> }
type ThreadTarget = { threadId: string; queuedKeys: Set<string> }
type CommentTargets = { threads: ThreadTarget[]; replies: ReplyTarget[]; unsupported: string[]; selected: number }
type AgentContext = {
  surface: 'checks' | 'detail'
  worktree: string
  number: number
  headOid: string
  prRepo: RepoIdentity
  review: ReviewData
  comments: JsonRecord | null
  queuedComments: string[]
  checks: JsonRecord | null
  conflicts: JsonRecord | null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function repoFromUrl(env: ReviewsEnv, value: unknown, number: number): RepoIdentity {
  if (!validWebUrl(value)) throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid review URL.')
  const url = new URL(value)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 4 || parts[2]?.toLowerCase() !== 'pull' || Number(parts[3]) !== number || !parts[0] || !parts[1]) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned a review URL without a valid repository identity.')
  }
  return { host: url.host, owner: parts[0], repo: parts[1] }
}

function repoIdentity(env: ReviewsEnv, value: unknown): RepoIdentity {
  if (!isRecord(value) || !nonEmptyString(value.host) || !nonEmptyString(value.owner) || !nonEmptyString(value.repo)) {
    throw env.invalid('invalid_input', 'prRepo must include a host, owner, and repository name.')
  }
  return { host: value.host, owner: value.owner, repo: value.repo }
}

function reviewStackSummary(env: ReviewsEnv, value: unknown): JsonRecord | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || !positiveInteger(value.number) || !positiveInteger(value.position) || !positiveInteger(value.size) ||
      value.position > value.size || !isRecord(value.base) || !nonEmptyString(value.base.ref) || !nonEmptyString(value.base.sha)) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned invalid stack summary metadata.')
  }
  if (value.available !== undefined && typeof value.available !== 'boolean') throw env.invalid('invalid_hosting_response', 'The stack availability flag is invalid.')
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw env.invalid('invalid_hosting_response', 'The stack truncation flag is invalid.')
  if (value.entries !== undefined && (!Array.isArray(value.entries) || !value.entries.every(isRecord))) {
    throw env.invalid('invalid_hosting_response', 'The stack member list is invalid.')
  }
  return { ...value, base: { ref: value.base.ref, sha: value.base.sha } }
}

function reviewData(env: ReviewsEnv, value: unknown): { review: ReviewData; prRepo: RepoIdentity } {
  if (!isRecord(value)) throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid review.')
  const number = positiveInteger(value.number) ? value.number : null
  const state = value.state
  const mergeable = value.mergeable
  const checksStatus = value.checksStatus
  if (value.provider !== 'github' || number === null || !validWebUrl(value.url) || typeof value.title !== 'string' ||
      typeof value.body !== 'string' || (state !== 'open' && state !== 'draft' && state !== 'closed' && state !== 'merged') ||
      !nonEmptyString(value.headRefName) || !nonEmptyString(value.baseRefName) || !nonEmptyString(value.headRefOid) ||
      !nonEmptyString(value.baseRefOid) || (mergeable !== 'MERGEABLE' && mergeable !== 'CONFLICTING' && mergeable !== 'UNKNOWN') ||
      (checksStatus !== 'neutral' && checksStatus !== 'pending' && checksStatus !== 'success' && checksStatus !== 'failure') ||
      typeof value.reviewDecision !== 'string' || typeof value.mergeStateStatus !== 'string') {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned incomplete or unsupported pull request details.')
  }
  const prRepo = repoFromUrl(env, value.url, number)
  const review: ReviewData = {
    provider: 'github',
    number,
    url: value.url,
    title: value.title,
    body: value.body,
    state,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    headRefOid: value.headRefOid,
    baseRefOid: value.baseRefOid,
    mergeable,
    checksStatus,
    reviewDecision: value.reviewDecision,
    mergeStateStatus: value.mergeStateStatus,
    autoMergeRequest: value.autoMergeRequest ?? null,
    stack: reviewStackSummary(env, value.stack),
    mergeMethods: value.mergeMethods ?? null,
    prRepo
  }
  if (typeof value.mergeQueueRequired === 'boolean' || value.mergeQueueRequired === null) review.mergeQueueRequired = value.mergeQueueRequired
  if (typeof value.autoMergeAllowed === 'boolean' || value.autoMergeAllowed === null) review.autoMergeAllowed = value.autoMergeAllowed
  if (typeof value.mergeMetadataKnown === 'boolean') review.mergeMetadataKnown = value.mergeMetadataKnown
  return { review, prRepo }
}
function reviewStackData(env: ReviewsEnv, value: unknown, review: ReviewData): JsonRecord | null {
  if (!isRecord(value) || value.number !== review.number || typeof value.available !== 'boolean' || typeof value.truncated !== 'boolean') {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid PR stack result.')
  }
  const fallback = reviewStackSummary(env, review.stack)
  if (!value.available) {
    if (value.reason !== 'stack_unavailable' && value.reason !== 'stack_mismatch') {
      throw env.invalid('invalid_hosting_response', 'The hosting provider returned an unsupported stack-unavailable reason.')
    }
    return {
      ...(fallback ?? {}),
      available: false,
      truncated: value.truncated,
      reason: value.reason,
      message: value.reason === 'stack_mismatch'
        ? 'The hosting provider stack did not contain this pull request; no other stack nodes are shown.'
        : 'The hosting provider could not load this pull request stack.'
    }
  }
  if (value.stack === null) {
    return fallback
      ? { ...fallback, available: false, truncated: value.truncated, reason: 'stack_mismatch', message: 'The stack summary and member list disagree; no other stack nodes are shown.' }
      : null
  }
  if (!isRecord(value.stack) || !positiveInteger(value.stack.number) || !positiveInteger(value.stack.position) ||
      !positiveInteger(value.stack.size) || value.stack.position > value.stack.size || !isRecord(value.stack.base) ||
      !nonEmptyString(value.stack.base.ref) || !nonEmptyString(value.stack.base.sha) || !Array.isArray(value.stack.entries)) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned incomplete stack details.')
  }
  const entries: JsonRecord[] = []
  for (const entry of value.stack.entries) {
    if (!isRecord(entry) || !positiveInteger(entry.position) || !positiveInteger(entry.number) ||
        typeof entry.title !== 'string' || !validWebUrl(entry.url) ||
        (entry.state !== 'open' && entry.state !== 'draft' && entry.state !== 'closed' && entry.state !== 'merged') ||
        !(typeof entry.checksStatus === 'string' || entry.checksStatus === null) ||
        !(typeof entry.mergeable === 'string' || entry.mergeable === null) ||
        !(typeof entry.updatedAt === 'string' || entry.updatedAt === null) ||
        !(typeof entry.headRefName === 'string' || entry.headRefName === null) ||
        !(typeof entry.headRefOid === 'string' || entry.headRefOid === null) ||
        !(typeof entry.reviewDecision === 'string' || entry.reviewDecision === null) ||
        !(typeof entry.mergeStateStatus === 'string' || entry.mergeStateStatus === null)) {
      throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid stack member.')
    }
    entries.push({ ...entry })
  }
  if (!entries.some((entry) => entry.number === review.number)) {
    return {
      ...(fallback ?? {}),
      available: false,
      truncated: value.truncated,
      reason: 'stack_mismatch',
      message: 'The stack response did not contain the selected pull request; no other stack nodes are shown.'
    }
  }
  entries.sort((left, right) => Number(left.position) - Number(right.position))
  return {
    number: value.stack.number,
    position: value.stack.position,
    size: value.stack.size,
    base: { ref: value.stack.base.ref, sha: value.stack.base.sha },
    available: true,
    truncated: value.truncated || entries.length > 100,
    entries: entries.slice(0, 100)
  }
}

function lookupResult(env: ReviewsEnv, value: unknown): LookupResult {
  if (!isRecord(value) || (value.kind !== 'found' && value.kind !== 'no-review' && value.kind !== 'unavailable') ||
      typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid review lookup result.')
  }
  if (value.kind === 'found') {
    const parsed = reviewData(env, value.review)
    return { kind: 'found', review: parsed.review, record: { ...value, review: parsed.review, prRepo: parsed.prRepo } }
  }
  if (value.kind === 'unavailable' && (!nonEmptyString(value.reason) || !nonEmptyString(value.message))) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an incomplete unavailable lookup result.')
  }
  return { kind: value.kind, record: { ...value } }
}

function gitStatus(env: ReviewsEnv, value: unknown): GitStatus {
  if (!isRecord(value)) throw env.invalid('invalid_git_response', 'Git status returned an invalid result.')
  const branch = typeof value.branch === 'string' ? value.branch : value.branch === null ? null : undefined
  const head = typeof value.head === 'string' ? value.head : value.head === null ? null : undefined
  const operation = value.operation
  const upstreamStatus = value.upstreamStatus
  if (branch === undefined || head === undefined || typeof value.detached !== 'boolean' ||
      (operation !== 'none' && operation !== 'merge' && operation !== 'rebase' && operation !== 'cherry-pick') ||
      !Array.isArray(value.entries) || !Array.isArray(value.files) || !isRecord(upstreamStatus) ||
      typeof value.busy !== 'string' && value.busy !== null || typeof value.capped !== 'boolean') {
    throw env.invalid('invalid_git_response', 'Git status returned incomplete worktree status.')
  }
  const entries: JsonRecord[] = []
  for (const entry of value.entries) {
    if (!isRecord(entry) || !nonEmptyString(entry.path) || !nonEmptyString(entry.area) || !nonEmptyString(entry.status)) {
      throw env.invalid('invalid_git_response', 'Git status returned an invalid changed-file entry.')
    }
    entries.push({ ...entry })
  }
  const files: JsonRecord[] = []
  for (const file of value.files) {
    if (!isRecord(file)) throw env.invalid('invalid_git_response', 'Git status returned an invalid file summary.')
    files.push({ ...file })
  }
  return { branch, head, detached: value.detached, operation, entries, files, upstreamStatus: { ...upstreamStatus }, busy: typeof value.busy === 'string' ? value.busy : null, capped: value.capped }
}

function eligibility(env: ReviewsEnv, value: unknown, worktree: Worktree, headOid: string | null, expectedBranch: string | null): JsonRecord {
  if (!isRecord(value) || typeof value.eligible !== 'boolean' ||
      !(typeof value.head === 'string' || value.head === null) ||
      !(typeof value.defaultBase === 'string' || value.defaultBase === null) ||
      typeof value.title !== 'string' || typeof value.body !== 'string' || !Array.isArray(value.blockers)) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned incomplete pull request eligibility.')
  }
  if (value.head !== expectedBranch) {
    throw env.invalid('stale_eligibility', 'The workspace branch changed while creation eligibility was being checked.')
  }
  const blockers: JsonRecord[] = []
  for (const blocker of value.blockers) {
    if (!isRecord(blocker) || !nonEmptyString(blocker.reason) || !nonEmptyString(blocker.nextAction) || !nonEmptyString(blocker.message)) {
      throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid eligibility blocker.')
    }
    blockers.push({ ...blocker })
  }
  const result: JsonRecord = {
    ...value,
    blockers,
    confirmedAt: Date.now(),
    worktree: worktree.id,
    headOid
  }
  if (value.review !== undefined && value.review !== null) result.review = reviewData(env, value.review).review
  return result
}

function checksData(env: ReviewsEnv, value: unknown, number: number, headOid: string): JsonRecord {
  if (!isRecord(value) || value.number !== number ||
      (value.rollup !== 'neutral' && value.rollup !== 'pending' && value.rollup !== 'success' && value.rollup !== 'failure' && value.rollup !== 'unknown') ||
      typeof value.partial !== 'boolean' || !Array.isArray(value.checks) || !Array.isArray(value.partialFailures)) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid checks summary.')
  }
  if (typeof value.headSha === 'string' && value.headSha.toLowerCase() !== headOid.toLowerCase()) {
    throw env.invalid('stale_head', 'The hosting provider returned checks for a different pull request head.')
  }
  const rows: JsonRecord[] = []
  for (const item of value.checks) {
    if (!isRecord(item) || (item.kind !== 'check_run' && item.kind !== 'status' && item.kind !== 'approval') ||
        !nonEmptyString(item.name) || !nonEmptyString(item.status) ||
        !(typeof item.conclusion === 'string' || item.conclusion === null)) {
      throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid check row.')
    }
    rows.push({ ...item })
  }
  const partialFailures = value.partialFailures.filter((item): item is string => typeof item === 'string')
  if (partialFailures.length !== value.partialFailures.length) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid checks failure list.')
  }
  return {
    ...value,
    checks: rows.slice(0, MAX_CHECKS),
    partialFailures,
    truncated: rows.length > MAX_CHECKS || partialFailures.some((item) => item.includes('truncated') || item.includes('100-entry'))
  }
}

function commentsData(env: ReviewsEnv, value: unknown, number: number): JsonRecord {
  if (!isRecord(value) || value.number !== number || !Array.isArray(value.comments) || typeof value.partial !== 'boolean' ||
      !Array.isArray(value.partialFailures)) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid comments result.')
  }
  const comments: JsonRecord[] = []
  for (const item of value.comments) {
    if (!isRecord(item) || !(typeof item.id === 'string' || typeof item.id === 'number') ||
        (item.kind !== 'issue_comment' && item.kind !== 'review' && item.kind !== 'review_comment') || typeof item.body !== 'string') {
      throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid review comment.')
    }
    comments.push({ ...item })
  }
  const partialFailures = value.partialFailures.filter((item): item is string => typeof item === 'string')
  if (partialFailures.length !== value.partialFailures.length) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned an invalid comments failure list.')
  }
  return {
    ...value,
    comments: comments.slice(0, MAX_CHECKS),
    partialFailures,
    truncated: comments.length > MAX_CHECKS || partialFailures.some((item) => item.includes('truncated') || item.includes('100-record'))
  }
}

function selector(env: ReviewsEnv, params: Record<string, unknown>): string | undefined {
  if (params.worktree === undefined) return undefined
  if (!nonEmptyString(params.worktree)) throw env.invalid('invalid_input', 'worktree must be a non-empty selector.')
  return params.worktree
}

function ownerIsCurrent(env: ReviewsEnv, worktree: string, generation: number): boolean {
  const checks = env.read().checks
  return checks.worktree === worktree && checks.generation === generation
}
function shouldClearChecksDialog(dialog: unknown): boolean {
  return !isRecord(dialog) || dialog.surface !== 'detail'
}

function updateIfCurrent(env: ReviewsEnv, worktree: string, generation: number, change: (checks: ChecksState) => void): boolean {
  if (!ownerIsCurrent(env, worktree, generation)) return false
  env.update((state) => {
    if (state.checks.worktree === worktree && state.checks.generation === generation) change(state.checks)
  })
  return ownerIsCurrent(env, worktree, generation)
}

function failure(env: ReviewsEnv, worktree: string, generation: number, error: unknown, fallback: string): JsonRecord {
  const message = errorMessage(error, fallback)
  updateIfCurrent(env, worktree, generation, (checks) => {
    checks.loading = false
    checks.error = message
  })
  return { ok: false, worktree, error: message, stale: !ownerIsCurrent(env, worktree, generation) }
}


function localConflicts(status: GitStatus): JsonRecord[] {
  return status.entries.filter((entry) => entry.area === 'conflicts')
}

function conflictState(status: GitStatus, review: ReviewData | null, preview?: JsonRecord | null): JsonRecord {
  const local = localConflicts(status)
  const hostedConflict = review?.mergeable === 'CONFLICTING' || review?.mergeStateStatus === 'DIRTY'
  if (hostedConflict) {
    if (preview === undefined) {
      return { status: 'loading', source: 'git', base: review.baseRefOid, head: review.headRefOid }
    }
    if (preview === null || preview.available !== true) {
      return {
        status: 'unavailable',
        source: 'git',
        reason: isRecord(preview) && nonEmptyString(preview.reason) ? preview.reason : 'preview-unavailable',
        message: isRecord(preview) && nonEmptyString(preview.message)
          ? preview.message
          : 'The public Git merge preview could not determine conflicting paths without changing the workspace.',
        ...(local.length > 0 ? { localFiles: local, localOperation: status.operation } : {})
      }
    }
    return {
      ...preview,
      status: 'ready',
      source: 'git',
      ...(local.length > 0 ? { localFiles: local, localOperation: status.operation } : {})
    }
  }
  if (local.length > 0) return { status: 'ready', source: 'git', files: local, operation: status.operation, truncated: status.capped }
  return { status: 'ready', source: 'git', files: [], operation: status.operation, truncated: status.capped }
}

function mergePreviewData(env: ReviewsEnv, value: unknown, review: ReviewData): JsonRecord {
  if (!isRecord(value) || value.base !== review.baseRefOid || value.head !== review.headRefOid ||
      typeof value.available !== 'boolean' || typeof value.conflicting !== 'boolean' || !Array.isArray(value.files)) {
    throw env.invalid('invalid_git_response', 'Git merge preview returned an invalid result for this review head.')
  }
  const files = value.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
  if (files.length !== value.files.length) throw env.invalid('invalid_git_response', 'Git merge preview returned an invalid conflict path.')
  if (!value.available) {
    const reason = value.reason
    if (reason !== 'objects-unavailable' && reason !== 'custom-merge-driver' && reason !== 'preview-unavailable') {
      throw env.invalid('invalid_git_response', 'Git merge preview returned an unsupported unavailable reason.')
    }
    const message = reason === 'objects-unavailable'
      ? 'The review base or head objects are not available in this workspace, so conflict paths could not be computed without fetching.'
      : reason === 'custom-merge-driver'
        ? 'The merge requires a custom merge driver that Quirky cannot safely run for a read-only preview.'
        : 'Git could not safely compute a read-only merge preview for this review.'
    return { available: false, reason, message }
  }
  return { available: true, conflicting: value.conflicting, base: value.base, head: value.head, files: value.conflicting ? files.slice(0, MAX_CHECKS) : [], truncated: value.conflicting && files.length > MAX_CHECKS }
}

function attachedReview(env: ReviewsEnv, value: unknown): { number: number; url: string; prRepo: RepoIdentity } | null {
  if (!isRecord(value) || !positiveInteger(value.number) || !validWebUrl(value.url)) return null
  return { number: value.number, url: value.url, prRepo: repoFromUrl(env, value.url, value.number) }
}

function commentsForAgent(value: unknown, queued: readonly string[]): CommentTargets {
  if (!isRecord(value) || !Array.isArray(value.comments)) return { threads: [], replies: [], unsupported: [], selected: 0 }
  const selected = new Set(queued)
  const threads = new Map<string, Set<string>>()
  const replies = new Map<number, Set<string>>()
  const unsupported = new Set<string>()
  let selectedCount = 0
  for (const item of value.comments) {
    if (!isRecord(item) || !(typeof item.id === 'string' || typeof item.id === 'number')) continue
    const commentKey = String(item.id)
    const threadId = nonEmptyString(item.threadId) ? item.threadId : null
    const selectedByKey = selected.has(commentKey)
    const selectedByThread = threadId !== null && selected.has(threadId)
    if (!selectedByKey && !selectedByThread) continue
    if (item.isResolved === true) continue
    selectedCount += 1
    const queueKeys = new Set<string>()
    if (selectedByKey) queueKeys.add(commentKey)
    if (selectedByThread) queueKeys.add(threadId!)
    if (threadId !== null) {
      let keys = threads.get(threadId)
      if (!keys) {
        keys = new Set<string>()
        threads.set(threadId, keys)
      }
      for (const key of queueKeys) keys.add(key)
    } else if (item.kind === 'review_comment' && positiveInteger(Number(item.id))) {
      const commentId = Number(item.id)
      let keys = replies.get(commentId)
      if (!keys) {
        keys = new Set<string>()
        replies.set(commentId, keys)
      }
      for (const key of queueKeys) keys.add(key)
    } else {
      unsupported.add(commentKey)
    }
  }
  return {
    threads: [...threads].map(([threadId, queuedKeys]) => ({ threadId, queuedKeys })),
    replies: [...replies].map(([commentId, queuedKeys]) => ({ commentId, queuedKeys })),
    unsupported: [...unsupported],
    selected: selectedCount
  }
}

function agentSelection(env: ReviewsEnv, value: unknown, requested: string | undefined): string {
  if (!isRecord(value) || !Array.isArray(value.agents) || !nonEmptyString(value.defaultAgent)) {
    throw env.invalid('invalid_agent_catalog', 'Quirky returned an invalid agent catalog.')
  }
  const agents = value.agents.filter(isRecord)
  const defaultEntry = agents.find((agent) => agent.isDefault === true && agent.enabled === true && agent.installed === true)
  const firstUsable = agents.find((agent) => agent.enabled === true && agent.installed === true)
  const fallback = value.defaultAgent !== 'auto' && value.defaultAgent !== 'shell'
    ? value.defaultAgent
    : typeof defaultEntry?.id === 'string' ? defaultEntry.id : typeof firstUsable?.id === 'string' ? firstUsable.id : undefined
  const selected = requested ?? fallback
  if (!nonEmptyString(selected)) throw env.invalid('agent_unavailable', 'No enabled real agent is available to start.')
  const entry = agents.find((agent) => agent.id === selected)
  if (!entry || entry.enabled !== true || entry.installed !== true) {
    throw env.invalid('agent_unavailable', `The selected agent ${selected} is unavailable or disabled.`)
  }
  return selected
}


async function resolveWorktree(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<Worktree> {
  const target = selector(env, params)
  return env.resolve(target ? { worktree: target } : {}, caller)
}

async function callLookup(env: ReviewsEnv, method: 'forBranch' | 'review', params: JsonRecord): Promise<LookupResult> {
  const value = await env.call(`quirky.hosting/${method}`, params)
  return lookupResult(env, value)
}

async function callEligibility(env: ReviewsEnv, worktree: Worktree, headOid: string | null, branch: string | null): Promise<JsonRecord> {
  const value = await env.call('quirky.hosting/creationEligibility', { worktree: worktree.id })
  return eligibility(env, value, worktree, headOid, branch)
}
const AUTH_FAILURES: Record<string, true> = {
  auth_required: true,
  authentication_required: true,
  not_authenticated: true,
  permission_denied: true,
  scope_missing: true,
  gh_unavailable: true
}

function hasAuthFailure(value: unknown): value is string {
  return typeof value === 'string' && AUTH_FAILURES[value] === true
}

function eligibilityHasAuthFailure(value: JsonRecord): boolean {
  if (hasAuthFailure(value.reason)) return true
  if (!Array.isArray(value.blockers)) return false
  return value.blockers.some((blocker) => isRecord(blocker) && hasAuthFailure(blocker.reason))
}
function eligibilityLookupUnavailable(value: JsonRecord): boolean {
  if (value.reason === 'lookup_unavailable') return true
  return Array.isArray(value.blockers) && value.blockers.some((blocker) => isRecord(blocker) && blocker.reason === 'lookup_unavailable')
}

function eligibilityNeedsDiagnostics(value: JsonRecord): boolean {
  return eligibilityHasAuthFailure(value) || eligibilityLookupUnavailable(value)
}

function eligibilityMessage(value: JsonRecord): string {
  const blocker = Array.isArray(value.blockers) ? value.blockers.find((item) => isRecord(item) && typeof item.message === 'string') : undefined
  if (isRecord(blocker) && typeof blocker.message === 'string') return blocker.message
  return typeof value.message === 'string' ? value.message : 'The provider could not confirm pull request eligibility.'
}

async function authDiagnostics(env: ReviewsEnv, worktree: Worktree): Promise<JsonRecord> {
  const value = await env.call('quirky.hosting/diagnoseAuth', { worktree: worktree.id })
  if (!isRecord(value) || typeof value.ghAvailable !== 'boolean' || !Array.isArray(value.accounts) ||
      typeof value.envTokenInProcess !== 'boolean' || !Array.isArray(value.missingScopes) ||
      !Array.isArray(value.requiredScopes) || typeof value.hasKeyringFallback !== 'boolean' ||
      typeof value.requiredHostAuthenticated !== 'boolean') {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned invalid authentication diagnostics.')
  }
  const accounts = value.accounts.filter(isRecord)
  const missingScopes = value.missingScopes.filter((scope): scope is string => typeof scope === 'string')
  const requiredScopes = value.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
  if (accounts.length !== value.accounts.length || missingScopes.length !== value.missingScopes.length || requiredScopes.length !== value.requiredScopes.length) {
    throw env.invalid('invalid_hosting_response', 'The hosting provider returned malformed authentication diagnostic entries.')
  }
  return { ...value, accounts, missingScopes, requiredScopes }
}

function staleResult(worktree: string): JsonRecord {
  return { ok: false, stale: true, worktree, error: 'The workspace changed while this refresh was in flight.' }
}

function replaceReviewData(env: ReviewsEnv, worktree: string, generation: number, lookup: JsonRecord, review: ReviewData | null, status: GitStatus): boolean {
  return updateIfCurrent(env, worktree, generation, (checks) => {
    const previousHead = checks.review?.headRefOid
    const nextHead = review?.headRefOid
    checks.lookup = lookup
    checks.review = review
    checks.conflicts = conflictState(status, review)
    checks.eligibility = null
    checks.error = null
    if (previousHead !== nextHead) {
      checks.checks = null
      checks.comments = null
      checks.expandedChecks = []
      checks.queuedComments = []
      checks.commentDraft = ''
      checks.titleDraft = null
      if (shouldClearChecksDialog(checks.agentDialog)) checks.agentDialog = null
      checks.fetchedAt = 0
    }
  })
}

async function refreshChecks(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<JsonRecord> {
  const force = params.force === true
  if (params.force !== undefined && typeof params.force !== 'boolean') {
    throw env.invalid('invalid_input', 'force must be a boolean.')
  }
  const requestedWorktree = selector(env, params)
  const generation = env.read().checks.generation + 1
  env.update((state) => {
    const previous = state.checks
    state.checks = {
      ...previous,
      generation,
      loading: true,
      error: null
    }
    if (requestedWorktree && previous.worktree !== requestedWorktree) {
      state.checks.worktree = requestedWorktree
      state.checks.lookup = null
      state.checks.eligibility = null
      state.checks.review = null
      state.checks.checks = null
      state.checks.comments = null
      state.checks.conflicts = null
      state.checks.expandedChecks = []
      state.checks.queuedComments = []
      state.checks.commentDraft = ''
      state.checks.titleDraft = null
      if (shouldClearChecksDialog(state.checks.agentDialog)) state.checks.agentDialog = null
      state.checks.fetchedAt = 0
    }
  })

  let worktree: Worktree
  try {
    worktree = await resolveWorktree(env, params, caller)
  } catch (error) {
    const message = errorMessage(error, 'Could not resolve the active workspace.')
    env.update((state) => {
      if (state.checks.generation === generation) {
        state.checks.loading = false
        state.checks.error = message
      }
    })
    return { ok: false, worktree: env.read().checks.worktree ?? '', error: message }
  }
  if (env.read().checks.generation !== generation) return staleResult(worktree.id)

  const previous = env.read().checks
  const sameWorktree = previous.worktree === worktree.id
  env.update((state) => {
    if (state.checks.generation !== generation) return
    state.checks.worktree = worktree.id
    if (!sameWorktree) {
      state.checks.lookup = null
      state.checks.eligibility = null
      state.checks.review = null
      state.checks.checks = null
      state.checks.comments = null
      state.checks.conflicts = null
      state.checks.expandedChecks = []
      state.checks.queuedComments = []
      state.checks.commentDraft = ''
      state.checks.titleDraft = null
      if (shouldClearChecksDialog(state.checks.agentDialog)) state.checks.agentDialog = null
      state.checks.fetchedAt = 0
    }
  })
  if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)

  if (worktree.kind !== 'git') {
    updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.lookup = { kind: 'folder' }
      checks.eligibility = null
      checks.review = null
      checks.checks = null
      checks.comments = null
      checks.conflicts = null
      checks.loading = false
      checks.error = null
    })
    return { ok: true, worktree: worktree.id, kind: 'folder' }
  }

  const state = env.read()
  const suppressed = state.suppressed[worktree.id]
  if (suppressed) {
    const target = attachedReview(env, suppressed)
    if (!target) return failure(env, worktree.id, generation, env.invalid('invalid_saved_link', 'The saved suppressed review identity is invalid.'), 'The saved review link is invalid.')
    updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.lookup = { kind: 'suppressed', number: target.number, url: target.url, prRepo: target.prRepo }
      checks.eligibility = null
      checks.review = null
      checks.checks = null
      checks.comments = null
      checks.conflicts = null
      checks.loading = false
      checks.error = null
      checks.expandedChecks = []
      checks.queuedComments = []
      checks.commentDraft = ''
      checks.titleDraft = null
      if (shouldClearChecksDialog(checks.agentDialog)) checks.agentDialog = null
      checks.fetchedAt = Date.now()
    })
    return { ok: true, worktree: worktree.id, kind: 'suppressed', number: target.number }
  }

  let status: GitStatus
  try {
    status = gitStatus(env, await env.call('quirky.git/status', { worktree: worktree.id }))
  } catch (error) {
    return failure(env, worktree.id, generation, error, 'Git status could not be loaded.')
  }
  if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)

  const explicitLink = state.links[worktree.id]
  if (status.operation !== 'none' && explicitLink === undefined) {
    const local = localConflicts(status)
    updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.lookup = {
        kind: 'blocked',
        reason: 'git_operation',
        operation: status.operation,
        status: { branch: status.branch, head: status.head, detached: status.detached }
      }
      checks.eligibility = null
      checks.review = null
      checks.checks = null
      checks.comments = null
      checks.conflicts = { status: 'ready', source: 'git', operation: status.operation, files: local }
      checks.loading = false
      checks.error = null
      checks.fetchedAt = Date.now()
    })
    return { ok: true, worktree: worktree.id, kind: 'git-operation', operation: status.operation }
  }

  const gitContext: JsonRecord = {
    branch: status.branch,
    head: status.head,
    detached: status.detached,
    operation: status.operation,
    upstreamStatus: status.upstreamStatus,
    busy: status.busy,
    files: status.files,
    entries: status.entries
  }
  let lookup: LookupResult
  let explicitRepo: RepoIdentity | undefined
  let forcedEligibility: JsonRecord | null = null
  try {
    if (explicitLink !== undefined) {
      const target = attachedReview(env, explicitLink)
      if (!target) throw env.invalid('invalid_saved_link', 'The saved review link identity is invalid.')
      explicitRepo = target.prRepo
      lookup = await callLookup(env, 'review', {
        worktree: worktree.id,
        number: target.number,
        prRepo: target.prRepo
      })
    } else if (status.branch === null || status.detached) {
      lookup = { kind: 'no-review', record: { kind: 'blocked', reason: status.detached ? 'detached_head' : 'no_current_branch' } }
    } else if (force && state.checks.worktree === worktree.id && state.checks.review?.headRefName === status.branch) {
      const previous = attachedReview(env, state.checks.review)
      if (!previous) throw env.invalid('invalid_saved_link', 'The current review identity is invalid.')
      explicitRepo = previous.prRepo
      lookup = await callLookup(env, 'review', { worktree: worktree.id, number: previous.number, prRepo: previous.prRepo })
    } else if (force) {
      forcedEligibility = await callEligibility(env, worktree, status.head, status.branch)
      const existing = isRecord(forcedEligibility.review) && forcedEligibility.review !== null
        ? reviewData(env, forcedEligibility.review).review
        : null
      lookup = existing
        ? { kind: 'found', review: existing, record: { kind: 'found', review: existing, fetchedAt: Date.now() } }
        : eligibilityLookupUnavailable(forcedEligibility)
          ? { kind: 'unavailable', record: { kind: 'unavailable', reason: 'upstream_unavailable', message: eligibilityMessage(forcedEligibility), fetchedAt: Date.now() } }
          : { kind: 'no-review', record: { kind: 'no-review', fetchedAt: Date.now() } }
    } else {
      lookup = await callLookup(env, 'forBranch', {
        worktree: worktree.id,
        branch: status.branch,
        ...(status.head ? { headOid: status.head } : {})
      })
    }
  } catch (error) {
    return failure(env, worktree.id, generation, error, 'The hosted review lookup failed.')
  }
  if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)

  const lookupRecord: JsonRecord = { ...lookup.record, gitStatus: gitContext }
  if (lookup.kind === 'unavailable') {
    let eligibilityValue: JsonRecord | null = forcedEligibility
    if (eligibilityValue === null) {
      try {
        eligibilityValue = await callEligibility(env, worktree, status.head, status.branch)
      } catch {
        // The unavailable lookup below remains authoritative; failed eligibility is not an empty result.
      }
    }
    if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)
    if (hasAuthFailure(lookup.record.reason) || (eligibilityValue !== null && eligibilityNeedsDiagnostics(eligibilityValue))) {
      try {
        lookupRecord.authDiagnostics = await authDiagnostics(env, worktree)
      } catch (error) {
        lookupRecord.authDiagnosticsError = errorMessage(error, 'Canonical GitHub authentication diagnostics could not be loaded.')
      }
    }
    const existing = isRecord(eligibilityValue?.review) && eligibilityValue.review !== null
      ? reviewData(env, eligibilityValue.review).review
      : null
    if (existing !== null) {
      const existingLookup: JsonRecord = { kind: 'found', review: existing, fetchedAt: Date.now(), gitStatus: gitContext, prRepo: existing.prRepo }
      if (!replaceReviewData(env, worktree.id, generation, existingLookup, existing, status)) return staleResult(worktree.id)
      return loadReviewDetails(env, worktree, generation, existing, force, status)
    }
    updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.lookup = lookupRecord
      checks.eligibility = eligibilityValue
      checks.conflicts = conflictState(status, checks.review)
      checks.loading = false
      checks.error = nonEmptyString(lookup.record.message) ? lookup.record.message : 'The hosted review could not be refreshed.'
      checks.fetchedAt = Date.now()
    })
    return { ok: false, worktree: worktree.id, kind: 'unavailable', error: nonEmptyString(lookup.record.message) ? lookup.record.message : 'The hosted review could not be refreshed.' }
  }

  if (lookup.kind === 'no-review') {
    let eligibilityRecord: JsonRecord
    try {
      eligibilityRecord = forcedEligibility ?? await callEligibility(env, worktree, status.head, status.branch)
    } catch (error) {
      return failure(env, worktree.id, generation, error, 'Creation eligibility could not be confirmed.')
    }
    if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)
    let currentStatus: GitStatus
    try {
      currentStatus = gitStatus(env, await env.call('quirky.git/status', { worktree: worktree.id }))
    } catch (error) {
      return failure(env, worktree.id, generation, error, 'The workspace could not be rechecked after checking review eligibility.')
    }
    if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)
    if (currentStatus.branch !== status.branch || currentStatus.head !== status.head || currentStatus.operation !== status.operation) {
      const message = 'The workspace branch or head changed while creation eligibility was being checked. Refresh before opening the composer.'
      updateIfCurrent(env, worktree.id, generation, (checks) => {
        checks.lookup = { kind: 'unavailable', reason: 'workspace_changed', message, fetchedAt: Date.now(), gitStatus: gitContext }
        checks.eligibility = null
        checks.loading = false
        checks.error = message
        checks.fetchedAt = Date.now()
      })
      return { ok: false, stale: true, worktree: worktree.id, kind: 'workspace_changed', error: message }
    }
    if (eligibilityLookupUnavailable(eligibilityRecord)) {
      if (eligibilityNeedsDiagnostics(eligibilityRecord)) {
        try {
          eligibilityRecord.authDiagnostics = await authDiagnostics(env, worktree)
        } catch (error) {
          eligibilityRecord.authDiagnosticsError = errorMessage(error, 'Canonical GitHub authentication diagnostics could not be loaded.')
        }
      }
      const message = eligibilityMessage(eligibilityRecord)
      updateIfCurrent(env, worktree.id, generation, (checks) => {
        checks.lookup = { kind: 'unavailable', reason: 'upstream_unavailable', message, fetchedAt: Date.now(), gitStatus: gitContext }
        checks.eligibility = eligibilityRecord
        checks.review = null
        checks.checks = null
        checks.comments = null
        checks.conflicts = conflictState(status, null)
        checks.loading = false
        checks.error = message
        checks.fetchedAt = Date.now()
      })
      return { ok: false, worktree: worktree.id, kind: 'unavailable', error: message }
    }
    if (eligibilityHasAuthFailure(eligibilityRecord)) {
      try {
        eligibilityRecord.authDiagnostics = await authDiagnostics(env, worktree)
      } catch (error) {
        eligibilityRecord.authDiagnosticsError = errorMessage(error, 'Canonical GitHub authentication diagnostics could not be loaded.')
      }
    }
    if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)
    const existing = isRecord(eligibilityRecord.review) ? reviewData(env, eligibilityRecord.review).review : null
    if (existing !== null) {
      const existingLookup: JsonRecord = { kind: 'found', review: existing, fetchedAt: Date.now(), gitStatus: gitContext, prRepo: existing.prRepo }
      if (!replaceReviewData(env, worktree.id, generation, existingLookup, existing, status)) return staleResult(worktree.id)
      return loadReviewDetails(env, worktree, generation, existing, force, status)
    }
    updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.lookup = lookupRecord
      checks.eligibility = eligibilityRecord
      checks.review = null
      checks.checks = null
      checks.comments = null
      checks.conflicts = conflictState(status, null)
      checks.loading = false
      checks.error = null
      checks.fetchedAt = Date.now()
      checks.expandedChecks = []
      checks.queuedComments = []
      checks.commentDraft = ''
      checks.titleDraft = null
      if (shouldClearChecksDialog(checks.agentDialog)) checks.agentDialog = null
    })
    return { ok: true, worktree: worktree.id, kind: 'no-review', eligible: eligibilityRecord.eligible === true }
  }

  const found = lookup.review
  if (!found) return failure(env, worktree.id, generation, env.invalid('invalid_hosting_response', 'The found review result did not include a review.'), 'The hosting provider returned incomplete review data.')
  if (explicitRepo && JSON.stringify(explicitRepo) !== JSON.stringify(found.prRepo)) {
    return failure(env, worktree.id, generation, env.invalid('repository_mismatch', 'The linked review resolved to a different repository identity.'), 'The linked review repository changed.')
  }
  if (!replaceReviewData(env, worktree.id, generation, lookupRecord, found, status)) return staleResult(worktree.id)
  return loadReviewDetails(env, worktree, generation, found, force, status)
}

async function loadReviewDetails(
  env: ReviewsEnv,
  worktree: Worktree,
  generation: number,
  review: ReviewData,
  force: boolean,
  status: GitStatus
): Promise<JsonRecord> {
  const prRepo = repoIdentity(env, review.prRepo)
  const params: JsonRecord = { worktree: worktree.id, number: review.number, prRepo, ...(force ? { noCache: true } : {}) }
  const hasHostedConflict = review.mergeable === 'CONFLICTING' || review.mergeStateStatus === 'DIRTY'
  const [checksResult, commentsResult, previewResult, stackResult] = await Promise.allSettled([
    env.call('quirky.hosting/checks', params),
    env.call('quirky.hosting/comments', params),
    hasHostedConflict
      ? env.call('quirky.git/mergePreview', { worktree: worktree.id, base: review.baseRefOid, head: review.headRefOid })
      : Promise.resolve(null),
    env.call('quirky.hosting/reviewStack', { worktree: worktree.id, number: review.number, prRepo, ...(force ? { noCache: true } : {}) })
  ])
  if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)
  const errors: string[] = []
  let nextChecks: JsonRecord | null = null
  let nextComments: JsonRecord | null = null
  let nextPreview: JsonRecord | null = null
  let nextReview = review
  if (stackResult.status === 'fulfilled') {
    try {
      nextReview = { ...review, stack: reviewStackData(env, stackResult.value, review) }
    } catch (error) {
      const message = errorMessage(error, 'The PR stack response could not be validated.')
      errors.push(message)
      nextReview = { ...review, stack: { available: false, truncated: false, reason: 'stack_unavailable', message } }
    }
  } else {
    nextReview = {
      ...review,
      stack: {
        available: false,
        truncated: false,
        reason: 'stack_unavailable',
        message: errorMessage(stackResult.reason, 'Stack membership is unavailable.')
      }
    }
  }
  if (checksResult.status === 'fulfilled') {
    try {
      nextChecks = checksData(env, checksResult.value, review.number, review.headRefOid)
    } catch (error) {
      errors.push(errorMessage(error, 'The checks response could not be validated.'))
    }
  } else {
    errors.push(errorMessage(checksResult.reason, 'Checks could not be loaded.'))
  }
  if (commentsResult.status === 'fulfilled') {
    try {
      nextComments = commentsData(env, commentsResult.value, review.number)
    } catch (error) {
      errors.push(errorMessage(error, 'The comments response could not be validated.'))
    }
  } else {
    errors.push(errorMessage(commentsResult.reason, 'Comments could not be loaded.'))
  }
  if (hasHostedConflict && previewResult.status === 'fulfilled') {
    try {
      nextPreview = mergePreviewData(env, previewResult.value, review)
    } catch (error) {
      const message = errorMessage(error, 'The Git merge preview could not be validated.')
      errors.push(message)
      nextPreview = { available: false, reason: 'preview-unavailable', message }
    }
  } else if (hasHostedConflict) {
    nextPreview = {
      available: false,
      reason: 'preview-unavailable',
      message: errorMessage(previewResult.status === 'rejected' ? previewResult.reason : undefined, 'Git could not compute a read-only merge preview.')
    }
  }

  let currentStatus: GitStatus
  try {
    currentStatus = gitStatus(env, await env.call('quirky.git/status', { worktree: worktree.id }))
  } catch (error) {
    return failure(env, worktree.id, generation, error, 'The workspace status could not be rechecked after loading review details.')
  }
  if (!ownerIsCurrent(env, worktree.id, generation)) return staleResult(worktree.id)
  if (currentStatus.branch !== status.branch || currentStatus.head !== status.head || currentStatus.operation !== status.operation) {
    const message = 'The workspace branch or head changed while review details were loading. Refresh before using this data.'
    updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.loading = false
      checks.error = message
      checks.eligibility = null
    })
    return { ok: false, stale: true, worktree: worktree.id, error: message }
  }
  updateIfCurrent(env, worktree.id, generation, (checks) => {
    checks.review = nextReview
    if (isRecord(checks.lookup) && isRecord(checks.lookup.review)) checks.lookup = { ...checks.lookup, review: nextReview }
    if (nextChecks !== null) checks.checks = nextChecks
    if (nextComments !== null) checks.comments = nextComments
    checks.conflicts = conflictState(status, nextReview, nextPreview)
    checks.loading = false
    checks.error = errors.length > 0 ? errors.join(' ') : null
    checks.fetchedAt = nextChecks !== null || nextComments !== null ? Date.now() : checks.fetchedAt
  })
  return {
    ok: errors.length === 0,
    worktree: worktree.id,
    kind: 'found',
    number: review.number,
    ...(errors.length > 0 ? { error: errors.join(' ') } : {})
  }
}

function currentReview(env: ReviewsEnv, worktree: string, number?: number): { checks: ChecksState; review: ReviewData; prRepo: RepoIdentity } {
  const checks = env.read().checks
  if (checks.worktree !== worktree || checks.review === null || (number !== undefined && checks.review.number !== number)) {
    throw env.invalid('stale_review_target', 'The active checks state no longer belongs to this review. Refresh the panel before acting.')
  }
  return { checks, review: checks.review, prRepo: repoIdentity(env, checks.review.prRepo) }
}

async function linkReview(env: ReviewsEnv, worktree: Worktree, number: number, suppliedRepo: RepoIdentity | undefined, caller: PluginCaller): Promise<JsonRecord> {
  const lookup = await callLookup(env, 'review', {
    worktree: worktree.id,
    number,
    ...(suppliedRepo ? { prRepo: suppliedRepo } : {})
  })
  if (lookup.kind !== 'found' || lookup.review === undefined) {
    const message = lookup.kind === 'unavailable' && nonEmptyString(lookup.record.message)
      ? lookup.record.message
      : `Pull request #${number} was not found for this workspace.`
    throw env.invalid(lookup.kind === 'unavailable' ? 'upstream_unavailable' : 'not_found', message)
  }
  const confirmed = lookup.review
  env.update((state) => {
    state.links[worktree.id] = { number: confirmed.number, url: confirmed.url }
    delete state.suppressed[worktree.id]
  })
  const refresh = await refreshChecks(env, { worktree: worktree.id, force: true }, caller)
  return { linked: true, number: confirmed.number, url: confirmed.url, refreshed: refresh.ok === true }
}

async function unlinkReview(env: ReviewsEnv, worktree: Worktree): Promise<JsonRecord> {
  const state = env.read()
  const explicit = state.links[worktree.id]
  const active = state.checks.worktree === worktree.id ? attachedReview(env, state.checks.review) : null
  const target = explicit ? attachedReview(env, explicit) : active
  if (!target) throw env.invalid('no_linked_review', 'There is no review linked to this workspace to unlink.')
  env.update((next) => {
    next.suppressed[worktree.id] = { number: target.number, url: target.url }
    delete next.links[worktree.id]
    if (next.checks.worktree === worktree.id) {
      next.checks.generation += 1
      next.checks.lookup = { kind: 'suppressed', number: target.number, url: target.url, prRepo: target.prRepo }
      next.checks.eligibility = null
      next.checks.review = null
      next.checks.checks = null
      next.checks.comments = null
      next.checks.conflicts = null
      next.checks.loading = false
      next.checks.error = null
      next.checks.expandedChecks = []
      next.checks.queuedComments = []
      next.checks.commentDraft = ''
      next.checks.titleDraft = null
      if (shouldClearChecksDialog(next.checks.agentDialog)) next.checks.agentDialog = null
    }
  })
  return { unlinked: true, worktree: worktree.id, number: target.number }
}

async function relinkReview(env: ReviewsEnv, worktree: Worktree, caller: PluginCaller): Promise<JsonRecord> {
  const target = attachedReview(env, env.read().suppressed[worktree.id])
  if (!target) throw env.invalid('no_suppressed_review', 'This workspace has no suppressed review to restore.')
  return linkReview(env, worktree, target.number, target.prRepo, caller)
}

function textField(env: ReviewsEnv, params: Record<string, unknown>, key: string, max: number): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length > max) throw env.invalid('invalid_input', `${key} must be text of at most ${max} characters.`)
  return value
}
function agentContext(env: ReviewsEnv, surface: 'checks' | 'detail', params: Record<string, unknown>): AgentContext {
  const state = env.read()
  let worktree: string | null
  let number: number
  let reviewValue: unknown
  let comments: JsonRecord | null
  let queuedComments: string[]
  let checksDataValue: JsonRecord | null
  let conflicts: JsonRecord | null
  let targetRepo: unknown
  if (surface === 'checks') {
    worktree = state.checks.worktree
    if (!worktree || !state.checks.review) throw env.invalid('stale_review_target', 'The Checks panel has no active hosted review.')
    number = state.checks.review.number
    reviewValue = state.checks.review
    comments = state.checks.comments
    queuedComments = state.checks.queuedComments
    checksDataValue = state.checks.checks
    conflicts = state.checks.conflicts
    targetRepo = state.checks.review.prRepo
  } else {
    const target = state.detail.target
    if (!target || !state.detail.review) throw env.invalid('stale_review_target', 'The review page has no active hosted review.')
    worktree = target.worktree
    number = target.number
    reviewValue = state.detail.review
    comments = state.detail.comments
    queuedComments = state.detail.queuedComments
    checksDataValue = state.detail.checks
    conflicts = null
    targetRepo = isRecord(target) ? target.prRepo : undefined
  }
  if (params.worktree !== undefined && params.worktree !== worktree) {
    throw env.invalid('stale_review_target', 'The agent dialog target does not match the selected workspace.')
  }
  if (params.number !== undefined && params.number !== number) {
    throw env.invalid('stale_review_target', 'The agent dialog target does not match the selected pull request.')
  }
  const parsed = reviewData(env, reviewValue)
  if (parsed.review.number !== number) throw env.invalid('stale_review_target', 'The current review number changed.')
  if (targetRepo !== undefined && JSON.stringify(repoIdentity(env, targetRepo)) !== JSON.stringify(parsed.prRepo)) {
    throw env.invalid('repository_mismatch', 'The review page repository does not match the canonical review URL.')
  }
  if (params.prRepo !== undefined && JSON.stringify(repoIdentity(env, params.prRepo)) !== JSON.stringify(parsed.prRepo)) {
    throw env.invalid('repository_mismatch', 'The agent request repository does not match the selected review.')
  }
  return {
    surface,
    worktree,
    number,
    headOid: parsed.review.headRefOid,
    prRepo: parsed.prRepo,
    review: parsed.review,
    comments,
    queuedComments,
    checks: checksDataValue,
    conflicts
  }
}

function defaultAgentPrompt(env: ReviewsEnv, context: AgentContext, action: 'fix' | 'conflicts' | 'comments'): string {
  const title = `PR #${context.number}: ${context.review.title}`
  const header = `Review ${action} for ${title}\nWorkspace: ${context.worktree}\nHead: ${context.headOid}`
  if (action === 'fix') {
    const rows = isRecord(context.checks) && Array.isArray(context.checks.checks) ? context.checks.checks : []
    const failed = rows.filter((row) => {
      if (!isRecord(row)) return false
      const status = typeof row.status === 'string' ? row.status.toLowerCase() : ''
      const conclusion = typeof row.conclusion === 'string' ? row.conclusion.toLowerCase() : ''
      return ['failure', 'error', 'startup_failure', 'timed_out', 'cancelled', 'action_required'].includes(conclusion) || status === 'failure' || status === 'error'
    })
    if (failed.length === 0) throw env.invalid('no_failed_checks', 'There are no failed checks to send to an agent.')
    const details = failed.slice(0, MAX_CHECKS).map((row) => {
      const name = isRecord(row) && nonEmptyString(row.name) ? row.name : 'Unnamed check'
      const status = isRecord(row) && typeof row.status === 'string' ? row.status : 'unknown status'
      const conclusion = isRecord(row) && typeof row.conclusion === 'string' ? row.conclusion : 'unknown conclusion'
      return `- ${name}: ${status} (${conclusion})`
    })
    return `${header}\nFix only the failures below. Inspect their logs and make the smallest correct change.\n${details.join('\n')}`
  }
  if (action === 'conflicts') {
    const conflicts = context.conflicts
    const files = conflicts && Array.isArray(conflicts.files) ? conflicts.files.filter(isRecord) : []
    const paths = files.flatMap((file) => nonEmptyString(file.path) ? [file.path] : [])
    const detail = conflicts && nonEmptyString(conflicts.message) ? conflicts.message : ''
    const pathsText = paths.length > 0 ? `\nConflicting paths:\n${paths.map((path) => `- ${path}`).join('\n')}` : '\nThe public merge preview did not provide conflict paths.'
    return `${header}\nResolve the reported merge conflicts in this workspace. Do not commit or push unless the user requests it.${pathsText}${detail ? `\n${detail}` : ''}`
  }
  const selected = commentsForAgent(context.comments, context.queuedComments)
  if (selected.selected === 0) throw env.invalid('no_queued_comments', 'Select at least one unresolved comment before asking an agent to resolve comments.')
  const selectedIds = new Set(context.queuedComments)
  const records = isRecord(context.comments) && Array.isArray(context.comments.comments) ? context.comments.comments : []
  const bodies = records.flatMap((item) => {
    if (!isRecord(item) || !(typeof item.id === 'string' || typeof item.id === 'number')) return []
    const key = String(item.id)
    const threadId = nonEmptyString(item.threadId) ? item.threadId : null
    if (!selectedIds.has(key) && (threadId === null || !selectedIds.has(threadId))) return []
    const author = nonEmptyString(item.author) ? item.author : 'unknown author'
    const label = threadId === null ? `comment ${key}` : `thread ${threadId}`
    return [`- ${label} by ${author}: ${String(item.body ?? '').slice(0, 4_000)}`]
  })
  return `${header}\nAddress only the selected review comments. Make code changes where appropriate, then report what you changed. Do not resolve unrelated threads.\n${bodies.join('\n')}`.slice(0, MAX_PROMPT_LENGTH)
}

function sameAgentTarget(env: ReviewsEnv, value: unknown, context: AgentContext, action: string): value is JsonRecord {
  if (!isRecord(value) || value.action !== action || value.surface !== context.surface || value.headOid !== context.headOid ||
      !isRecord(value.target) || value.target.worktree !== context.worktree || value.target.number !== context.number) return false
  try {
    const repository = repoIdentity(env, value.target.prRepo)
    return repository.host === context.prRepo.host && repository.owner === context.prRepo.owner && repository.repo === context.prRepo.repo
  } catch {
    return false
  }
}
function agentSurfaceIsCurrent(state: ReviewsState, context: AgentContext): boolean {
  if (context.surface === 'checks') {
    const checks = state.checks
    return checks.worktree === context.worktree && checks.review?.number === context.number &&
      checks.review.headRefOid === context.headOid && checks.review.url === context.review.url
  }
  const detail = state.detail
  return detail.target?.worktree === context.worktree && detail.target.number === context.number &&
    detail.review?.number === context.number && detail.review.headRefOid === context.headOid &&
    detail.review.url === context.review.url
}

function updateAgentSurface(env: ReviewsEnv, context: AgentContext, change: (surface: ChecksState | DetailState) => void): boolean {
  let applied = false
  env.update((state) => {
    if (!agentSurfaceIsCurrent(state, context)) return
    change(context.surface === 'checks' ? state.checks : state.detail)
    applied = true
  })
  return applied
}

function setAgentDialog(env: ReviewsEnv, params: Record<string, unknown>): JsonRecord {
  const action = params.action
  if (action === 'clear') {
    env.update((state) => { state.checks.agentDialog = null })
    return { agentDialog: null }
  }
  const surface = params.surface === undefined ? 'checks' : params.surface
  if (surface !== 'checks' && surface !== 'detail') throw env.invalid('invalid_input', 'surface must be checks or detail.')
  if (action === 'hide') {
    env.update((state) => {
      const current = state.checks.agentDialog
      if (!current || !isRecord(current)) return
      const currentSurface = current.surface === 'detail' ? 'detail' : 'checks'
      if (currentSurface === surface) state.checks.agentDialog = { ...current, visible: false }
    })
    return { agentDialog: env.read().checks.agentDialog }
  }
  if (action !== 'fix' && action !== 'conflicts' && action !== 'comments') {
    throw env.invalid('invalid_input', 'action must be fix, conflicts, comments, hide, or clear.')
  }
  const context = agentContext(env, surface, params)
  const previous = env.read().checks.agentDialog
  const reusable = sameAgentTarget(env, previous, context, action)
  const prompt = params.prompt === undefined
    ? reusable && typeof previous.prompt === 'string' ? previous.prompt : defaultAgentPrompt(env, context, action)
    : textField(env, params, 'prompt', MAX_PROMPT_LENGTH)
  const requestedAgent = params.agent
  const requestedArgs = params.args
  if (requestedAgent !== undefined && (typeof requestedAgent !== 'string' || requestedAgent.length > 128)) {
    throw env.invalid('invalid_input', 'agent must be a name of at most 128 characters.')
  }
  if (requestedArgs !== undefined && (typeof requestedArgs !== 'string' || requestedArgs.length > MAX_AGENT_ARGS_LENGTH)) {
    throw env.invalid('invalid_input', `args must be text of at most ${MAX_AGENT_ARGS_LENGTH} characters.`)
  }
  const agent = typeof requestedAgent === 'string' ? requestedAgent : reusable && typeof previous.agent === 'string' ? previous.agent : undefined
  const args = typeof requestedArgs === 'string' ? requestedArgs : reusable && typeof previous.args === 'string' ? previous.args : undefined
  const dialog: NonNullable<ChecksState['agentDialog']> = {
    action,
    prompt,
    surface,
    target: { worktree: context.worktree, number: context.number, prRepo: context.prRepo },
    headOid: context.headOid,
    visible: true,
    ...(agent !== undefined && agent !== '' ? { agent } : {}),
    ...(args !== undefined ? { args } : {})
  }
  env.update((state) => { state.checks.agentDialog = dialog })
  return { agentDialog: dialog }
}

async function launchAgent(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<JsonRecord> {
  const worktree = await resolveWorktree(env, params, caller)
  const rawDialog = env.read().checks.agentDialog
  if (!isRecord(rawDialog) || (rawDialog.action !== 'fix' && rawDialog.action !== 'conflicts' && rawDialog.action !== 'comments')) {
    throw env.invalid('no_agent_dialog', 'Open a review-agent dialog before starting an agent.')
  }
  const surface = rawDialog.surface === 'detail' ? 'detail' : rawDialog.surface === 'checks' || rawDialog.surface === undefined ? 'checks' : null
  if (surface === null || !isRecord(rawDialog.target) || typeof rawDialog.target.worktree !== 'string' ||
      !positiveInteger(rawDialog.target.number) || !nonEmptyString(rawDialog.headOid)) {
    throw env.invalid('invalid_agent_dialog', 'The review-agent dialog has no valid, exact review target.')
  }
  if (rawDialog.target.worktree !== worktree.id) {
    throw env.invalid('stale_review_target', 'The agent dialog belongs to a different workspace.')
  }
  const context = agentContext(env, surface, {
    worktree: rawDialog.target.worktree,
    number: rawDialog.target.number,
    prRepo: rawDialog.target.prRepo
  })
  if (context.headOid !== rawDialog.headOid) {
    throw env.invalid('stale_review_target', 'The review head changed while the agent dialog was open.')
  }
  if (typeof rawDialog.prompt !== 'string' || rawDialog.prompt.trim() === '') {
    throw env.invalid('empty_prompt', 'Enter an agent prompt before starting the review action.')
  }
  if (rawDialog.prompt.length > MAX_PROMPT_LENGTH) throw env.invalid('invalid_input', 'The agent prompt exceeds the safe size limit.')
  const commentTargets = rawDialog.action === 'comments'
    ? commentsForAgent(context.comments, context.queuedComments)
    : { threads: [], replies: [], unsupported: [], selected: 0 }
  if (rawDialog.action === 'comments' && commentTargets.selected === 0) {
    throw env.invalid('no_queued_comments', 'Select at least one unresolved review comment before asking an agent to resolve comments.')
  }
  const requestedAgent = typeof params.agent === 'string' && params.agent !== ''
    ? params.agent
    : typeof rawDialog.agent === 'string' ? rawDialog.agent : undefined
  const args = typeof params.args === 'string' ? params.args : typeof rawDialog.args === 'string' ? rawDialog.args : undefined
  if (params.agent !== undefined && typeof params.agent !== 'string') throw env.invalid('invalid_input', 'agent must be text.')
  if (params.args !== undefined && typeof params.args !== 'string') throw env.invalid('invalid_input', 'args must be text.')
  if (args !== undefined && args.length > MAX_AGENT_ARGS_LENGTH) throw env.invalid('invalid_input', `args must be at most ${MAX_AGENT_ARGS_LENGTH} characters.`)

  try {
    const catalog = await env.call('quirky.agents/list')
    const agent = agentSelection(env, catalog, requestedAgent)
    if (!agentSurfaceIsCurrent(env.read(), context)) throw env.invalid('stale_review_target', 'The selected review changed before the agent could be started.')
    const createdValue = await env.call('quirky.session/create', {
      worktree: context.worktree,
      agent,
      title: `Review ${rawDialog.action} · PR #${context.number}`,
      ...(args ? { extraArgs: args } : {})
    })
    if (!isRecord(createdValue) || !nonEmptyString(createdValue.id) || createdValue.agent !== agent) {
      throw env.invalid('invalid_session_response', 'The agent session did not report the selected review agent.')
    }
    if (!agentSurfaceIsCurrent(env.read(), context)) {
      const message = 'The selected review changed before prompt delivery. The new session is open, but no prompt was sent.'
      updateAgentSurface(env, context, (state) => { state.error = message })
      return { delivered: false, sessionId: createdValue.id, agent, error: message }
    }
    const deliveryValue = await env.call('quirky.agents/deliver', {
      sessionId: createdValue.id,
      agent,
      text: rawDialog.prompt,
      submit: true
    })
    if (!isRecord(deliveryValue) || (deliveryValue.delivery !== 'pasted' && deliveryValue.delivery !== 'unconfirmed' && deliveryValue.delivery !== 'not-delivered')) {
      throw env.invalid('invalid_agent_delivery', 'The agent prompt delivery returned an invalid result.')
    }
    if (deliveryValue.delivery !== 'pasted') {
      const message = deliveryValue.delivery === 'unconfirmed'
        ? 'The agent did not confirm that it received the prompt; queued review comments remain unchanged.'
        : 'The agent prompt was not delivered; queued review comments remain unchanged.'
      updateAgentSurface(env, context, (state) => { state.error = message })
      return { delivered: false, sessionId: createdValue.id, agent, error: message }
    }

    const resolved: string[] = []
    const replied: string[] = []
    const failures: string[] = commentTargets.unsupported.map((key) =>
      `Comment ${key} is a top-level conversation comment with no supported resolve or reply route; it remains queued.`)
    if (rawDialog.action === 'comments') {
      for (const targetThread of commentTargets.threads) {
        if (!agentSurfaceIsCurrent(env.read(), context)) {
          failures.push('The review context changed after delivery; remaining threads were left unresolved.')
          break
        }
        try {
          const outcome = await env.call('quirky.hosting/resolveThread', {
            worktree: context.worktree,
            number: context.number,
            prRepo: context.prRepo,
            threadId: targetThread.threadId,
            action: 'resolve'
          })
          if (!isRecord(outcome) || outcome.resolved !== true) throw env.invalid('thread_not_resolved', `Review thread ${targetThread.threadId} was not confirmed resolved.`)
          resolved.push(targetThread.threadId)
          updateAgentSurface(env, context, (state) => {
            if (isRecord(state.comments) && Array.isArray(state.comments.comments)) {
              state.comments = {
                ...state.comments,
                comments: state.comments.comments.map((item) =>
                  isRecord(item) && item.threadId === targetThread.threadId ? { ...item, isResolved: true } : item)
              }
            }
            state.queuedComments = state.queuedComments.filter((key) => !targetThread.queuedKeys.has(key))
          })
        } catch (error) {
          failures.push(errorMessage(error, `Could not resolve review thread ${targetThread.threadId}.`))
        }
      }
      for (const targetReply of commentTargets.replies) {
        if (!agentSurfaceIsCurrent(env.read(), context)) {
          failures.push('The review context changed after delivery; remaining comments were left queued.')
          break
        }
        try {
          const body = `An AI agent was started to address this review comment. Session: ${createdValue.id}.`
          const outcome = await env.call('quirky.hosting/reviewComment', {
            worktree: context.worktree,
            number: context.number,
            prRepo: context.prRepo,
            action: 'reply',
            replyToId: targetReply.commentId,
            body
          })
          const reply = isRecord(outcome) && isRecord(outcome.comment) ? outcome.comment : null
          if (!isRecord(outcome) || outcome.action !== 'reply' || !reply || !positiveInteger(reply.id) || typeof reply.body !== 'string') {
            throw env.invalid('reply_not_confirmed', `The reply to review comment ${targetReply.commentId} was not confirmed.`)
          }
          replied.push(String(targetReply.commentId))
          updateAgentSurface(env, context, (state) => {
            if (isRecord(state.comments) && Array.isArray(state.comments.comments)) {
              state.comments = {
                ...state.comments,
                comments: [...state.comments.comments, {
                  kind: 'review_comment',
                  id: reply.id,
                  author: null,
                  body: reply.body,
                  createdAt: null,
                  state: null,
                  path: null,
                  line: null,
                  startLine: null,
                  threadId: null,
                  isResolved: null,
                  isOutdated: null,
                  reactionSubjectId: null,
                  reactions: []
                }]
              }
            }
            state.queuedComments = state.queuedComments.filter((key) => !targetReply.queuedKeys.has(key))
          })
        } catch (error) {
          failures.push(errorMessage(error, `Could not reply to review comment ${targetReply.commentId}.`))
        }
      }
    }
    const partialMessage = failures.length > 0
      ? `The prompt was delivered, but some selected comments were not handled: ${failures.join(' ')}`
      : null
    env.update((state) => {
      if (!agentSurfaceIsCurrent(state, context)) return
      const currentDialog = state.checks.agentDialog
      if (sameAgentTarget(env, currentDialog, context, rawDialog.action)) state.checks.agentDialog = null
      if (context.surface === 'checks') state.checks.error = partialMessage
      else state.detail.error = partialMessage
    })
    return {
      delivered: true,
      sessionId: createdValue.id,
      agent,
      resolved,
      replied,
      unresolved: failures,
      ...(partialMessage ? { error: partialMessage } : {})
    }
  } catch (error) {
    const message = errorMessage(error, 'The review agent could not be started or did not receive the prompt.')
    updateAgentSurface(env, context, (state) => { state.error = message })
    return { delivered: false, error: message }
  }
}

async function saveTitle(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<JsonRecord> {
  const worktree = await resolveWorktree(env, params, caller)
  const number = params.number
  if (!positiveInteger(number)) throw env.invalid('invalid_input', 'number must be a positive pull request number.')
  const title = textField(env, params, 'title', MAX_TITLE_LENGTH).trim()
  if (title.length === 0) throw env.invalid('invalid_title', 'Enter a non-empty pull request title.')
  const expectedHead = params.expectedHead
  if (!nonEmptyString(expectedHead)) throw env.invalid('invalid_input', 'expectedHead must be the currently reviewed commit SHA.')
  const { checks, review, prRepo } = currentReview(env, worktree.id, number)
  if (review.headRefOid !== expectedHead) throw env.invalid('head_changed', 'The pull request head changed. Refresh before saving the title.')
  const priorGeneration = checks.generation
  const generation = priorGeneration + 1
  let started = false
  env.update((state) => {
    if (state.checks.worktree !== worktree.id || state.checks.generation !== priorGeneration ||
        state.checks.review?.number !== number || state.checks.review.headRefOid !== expectedHead) return
    state.checks.generation = generation
    state.checks.loading = true
    state.checks.error = null
    state.checks.titleDraft = title
    started = true
  })
  if (!started) return { updated: false, number, title, stale: true, error: 'The review changed before the title could be saved.' }
  try {
    const response = await env.call('quirky.hosting/updateReview', {
      worktree: worktree.id,
      number,
      prRepo,
      action: 'edit',
      title
    })
    if (!isRecord(response) || response.updated !== true) throw env.invalid('title_update_failed', 'The hosting provider did not confirm the title update.')
    const readback = await env.call('quirky.hosting/review', { worktree: worktree.id, number, prRepo })
    const found = lookupResult(env, readback)
    if (found.kind !== 'found' || !found.review || found.review.title !== title) {
      throw env.invalid('title_readback_mismatch', 'The title update was accepted, but the provider did not confirm the saved title.')
    }
    const applied = updateIfCurrent(env, worktree.id, generation, (next) => {
      next.review = found.review ?? null
      next.titleDraft = null
      next.loading = false
      next.error = null
    })
    return { updated: true, number, title, ...(applied ? {} : { stale: true }) }
  } catch (error) {
    const message = errorMessage(error, 'The pull request title could not be confirmed.')
    updateIfCurrent(env, worktree.id, generation, (next) => {
      next.loading = false
      next.error = message
      next.titleDraft = title
    })
    return { updated: false, number, title, error: message }
  }
}

async function runGitAction(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<JsonRecord> {
  const action = params.action
  if (action !== 'publish' && action !== 'push' && action !== 'sync') throw env.invalid('invalid_input', 'action must be publish, push, or sync.')
  const worktree = await resolveWorktree(env, params, caller)
  const current = env.read().checks
  const generation = current.worktree === worktree.id ? current.generation : null
  try {
    const method = action === 'sync' ? 'quirky.git/sync' : 'quirky.git/push'
    const result = await env.call(method, { worktree: worktree.id })
    if (!isRecord(result)) throw env.invalid('invalid_git_response', `Git ${action} returned an invalid result.`)
    const refreshed = await refreshChecks(env, { worktree: worktree.id, force: true }, caller)
    return { ok: true, action, worktree: worktree.id, refreshed: refreshed.ok === true }
  } catch (error) {
    const message = errorMessage(error, `Git ${action} failed.`)
    if (generation !== null) updateIfCurrent(env, worktree.id, generation, (checks) => {
      checks.loading = false
      checks.error = message
    })
    return { ok: false, action, worktree: worktree.id, error: message }
  }
}

async function openReview(env: ReviewsEnv, params: Record<string, unknown>, caller: PluginCaller): Promise<JsonRecord> {
  const worktree = await resolveWorktree(env, params, caller)
  const number = params.number
  if (!positiveInteger(number)) throw env.invalid('invalid_input', 'number must be a positive pull request number.')
  const tab = params.tab ?? 'conversation'
  if (tab !== 'conversation' && tab !== 'checks' && tab !== 'files') throw env.invalid('invalid_input', 'tab must be conversation, checks, or files.')
  let review: ReviewData
  const current = env.read().checks
  if (current.worktree === worktree.id && current.review?.number === number) {
    review = current.review
  } else {
    const link = env.read().links[worktree.id]
    const repo = link && link.number === number ? repoFromUrl(env, link.url, number) : undefined
    const result = await callLookup(env, 'review', { worktree: worktree.id, number, ...(repo ? { prRepo: repo } : {}) })
    if (result.kind !== 'found' || !result.review) throw env.invalid(result.kind === 'unavailable' ? 'upstream_unavailable' : 'not_found', 'The selected review is not available for this workspace.')
    review = result.review
  }
  await env.openView(REVIEW_VIEW, {
    worktree: worktree.id,
    number,
    tab,
    prRepo: repoIdentity(env, review.prRepo)
  })
  return { opened: true, worktree: worktree.id, number, tab, prRepo: review.prRepo }
}

const objectSchema = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false
})
const stringSchema: Schema = { type: 'string' }
const worktreeProperty: Schema = { type: 'string', description: 'Worktree selector (ID, name, branch, or path); omitted to resolve the caller workspace.' }
const repoSchema = objectSchema({ host: stringSchema, owner: stringSchema, repo: stringSchema }, ['host', 'owner', 'repo'])

export const checksSpecs: MethodSpec[] = [
  {
    id: 'checksGet',
    readOnly: true,
    description: 'Read the active-workspace checks state and its current review target.',
    params: objectSchema({}),
    result: objectSchema({ checks: { type: 'object', additionalProperties: true } }, ['checks'])
  },
  {
    id: 'checksRefresh',
    description: 'Refresh the exact workspace review, checks, comments and creation eligibility without accepting stale results.',
    params: objectSchema({ worktree: worktreeProperty, force: { type: 'boolean', description: 'Bypass provider caches for a manual or visibility-entry refresh.' } }),
    result: objectSchema({ ok: { type: 'boolean' }, worktree: stringSchema, kind: stringSchema, number: { type: 'integer' }, eligible: { type: 'boolean' }, operation: stringSchema, error: stringSchema, stale: { type: 'boolean' } }, ['ok'])
  },
  {
    id: 'checksInvalidate',
    description: 'Invalidate an in-flight Checks refresh when its panel is hidden or unmounted without making provider calls.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Exact workspace whose pending Checks refresh is no longer visible.' } }, ['worktree']),
    result: objectSchema({ invalidated: { type: 'boolean' }, worktree: stringSchema }, ['invalidated', 'worktree'])
  },
  {
    id: 'checksLink',
    description: 'Link a canonical GitHub pull request to a registered workspace.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace to link.' }, number: { type: 'integer', minimum: 1 }, prRepo: repoSchema }, ['worktree', 'number']),
    result: objectSchema({ linked: { type: 'boolean' }, number: { type: 'integer' }, url: stringSchema, refreshed: { type: 'boolean' } }, ['linked', 'number', 'url', 'refreshed'])
  },
  {
    id: 'checksUnlink',
    description: 'Hide a workspace review and suppress its automatic rediscovery until it is relinked.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace whose current review will be suppressed.' } }, ['worktree']),
    result: objectSchema({ unlinked: { type: 'boolean' }, worktree: stringSchema, number: { type: 'integer' } }, ['unlinked', 'worktree', 'number'])
  },
  {
    id: 'checksRelink',
    description: 'Restore the exact review previously suppressed for a workspace after canonical validation.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace whose suppressed review will be restored.' } }, ['worktree']),
    result: objectSchema({ linked: { type: 'boolean' }, number: { type: 'integer' }, url: stringSchema, refreshed: { type: 'boolean' } }, ['linked', 'number', 'url', 'refreshed'])
  },
  {
    id: 'checksSetHeight',
    description: 'Set the compact Checks panel height within the pane bounds.',
    params: objectSchema({ height: { type: 'integer', description: `Clamped between ${MIN_HEIGHT} and ${MAX_HEIGHT} pixels.` } }, ['height']),
    result: objectSchema({ height: { type: 'integer' } }, ['height'])
  },
  {
    id: 'checksSetTitleDraft',
    description: 'Set the bounded inline pull request title draft for an exact review target.',
    params: objectSchema({ worktree: worktreeProperty, number: { type: 'integer', minimum: 1 }, title: { type: 'string', description: `At most ${MAX_TITLE_LENGTH} characters.` } }, ['worktree', 'number', 'title']),
    result: objectSchema({ titleDraft: stringSchema }, ['titleDraft'])
  },
  {
    id: 'checksCancelTitle',
    description: 'Discard the inline title draft for the exact review target without changing the hosted review.',
    params: objectSchema({ worktree: worktreeProperty, number: { type: 'integer', minimum: 1 } }, ['worktree', 'number']),
    result: objectSchema({ titleDraft: { type: 'null' } }, ['titleDraft'])
  },
  {
    id: 'checksSaveTitle',
    description: 'Save and read back a review title for the exact current PR head.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace containing the active review.' }, number: { type: 'integer', minimum: 1 }, expectedHead: stringSchema, title: { type: 'string', description: `At most ${MAX_TITLE_LENGTH} characters.` } }, ['worktree', 'number', 'expectedHead', 'title']),
    result: objectSchema({ updated: { type: 'boolean' }, number: { type: 'integer' }, title: stringSchema, stale: { type: 'boolean' }, error: stringSchema }, ['updated', 'number', 'title'])
  },
  {
    id: 'checksSetAgentDialog',
    description: 'Set or clear the editable Checks triage-agent dialog.',
    params: objectSchema({
      action: { type: 'string', enum: ['fix', 'conflicts', 'comments', 'hide', 'clear'] },
      surface: { type: 'string', enum: ['checks', 'detail'] },
      worktree: worktreeProperty,
      number: { type: 'integer', minimum: 1 },
      prRepo: repoSchema,
      prompt: { type: 'string', description: `At most ${MAX_PROMPT_LENGTH} characters.` },
      agent: { type: 'string', description: 'At most 128 characters.' },
      args: { type: 'string', description: `At most ${MAX_AGENT_ARGS_LENGTH} characters.` }
    }, ['action']),
    result: objectSchema({ agentDialog: { description: 'An agent dialog object or null.' } }, ['agentDialog'])
  },
  {
    id: 'checksLaunchAgent',
    description: 'Start the selected/default real agent, deliver the edited triage prompt once after readiness, and only then resolve selected supported threads.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace containing the review.' }, agent: stringSchema, args: { type: 'string', description: `At most ${MAX_AGENT_ARGS_LENGTH} characters.` } }, ['worktree']),
    result: objectSchema({ delivered: { type: 'boolean' }, sessionId: stringSchema, agent: stringSchema, resolved: { type: 'array', items: stringSchema }, replied: { type: 'array', items: stringSchema }, unresolved: { type: 'array', items: stringSchema }, error: stringSchema }, ['delivered'])
  },
  {
    id: 'checksGitAction',
    description: 'Publish, push or sync the exact workspace through quirky.git and then refresh its hosting eligibility.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace whose branch will be pushed or synchronized.' }, action: { type: 'string', enum: ['publish', 'push', 'sync'] } }, ['worktree', 'action']),
    result: objectSchema({ ok: { type: 'boolean' }, action: stringSchema, worktree: stringSchema, refreshed: { type: 'boolean' }, error: stringSchema }, ['ok', 'action', 'worktree'])
  },
  {
    id: 'checksOpenReview',
    description: 'Open the current canonical review in the conversation, checks or files tab.',
    params: objectSchema({ worktree: { ...worktreeProperty, description: 'Workspace containing the review.' }, number: { type: 'integer', minimum: 1 }, tab: { type: 'string', enum: ['conversation', 'checks', 'files'] } }, ['worktree', 'number']),
    result: objectSchema({ opened: { type: 'boolean' }, worktree: stringSchema, number: { type: 'integer' }, tab: stringSchema, prRepo: repoSchema }, ['opened', 'worktree', 'number', 'tab', 'prRepo'])
  }
]

export function checksMethods(env: ReviewsEnv): ReviewMethodTable {
  return {
    checksGet: () => ({ checks: env.read().checks }),
    checksRefresh: (params, caller) => refreshChecks(env, params, caller),
    checksInvalidate: (params) => {
      const worktree = selector(env, params)
      if (!worktree) throw env.invalid('invalid_input', 'worktree is required to invalidate a hidden Checks refresh.')
      const checks = env.read().checks
      if (checks.worktree !== worktree || !checks.loading || checks.titleDraft !== null) return { invalidated: false, worktree }
      let invalidated = false
      env.update((state) => {
        if (state.checks.worktree === worktree && state.checks.loading && state.checks.titleDraft === null) {
          state.checks.generation += 1
          state.checks.loading = false
          invalidated = true
        }
      })
      return { invalidated, worktree }
    },
    checksLink: async (params, caller) => {
      const worktree = await resolveWorktree(env, params, caller)
      if (worktree.kind !== 'git') throw env.invalid('worktree_not_git', 'Hosted reviews can only be linked to a Git workspace.')
      if (!positiveInteger(params.number)) throw env.invalid('invalid_input', 'number must be a positive pull request number.')
      const prRepo = params.prRepo === undefined ? undefined : repoIdentity(env, params.prRepo)
      return linkReview(env, worktree, params.number, prRepo, caller)
    },
    checksUnlink: async (params, caller) => {
      const worktree = await resolveWorktree(env, params, caller)
      return unlinkReview(env, worktree)
    },
    checksRelink: async (params, caller) => {
      const worktree = await resolveWorktree(env, params, caller)
      return relinkReview(env, worktree, caller)
    },
    checksSetHeight: (params) => {
      const height = params.height
      if (typeof height !== 'number' || !Number.isFinite(height)) throw env.invalid('invalid_input', 'height must be a finite number.')
      const bounded = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
      env.update((state) => { state.checks.height = bounded })
      return { height: bounded }
    },
    checksSetTitleDraft: async (params, caller) => {
      const worktree = await resolveWorktree(env, params, caller)
      if (!positiveInteger(params.number)) throw env.invalid('invalid_input', 'number must be a positive pull request number.')
      const title = textField(env, params, 'title', MAX_TITLE_LENGTH)
      currentReview(env, worktree.id, params.number)
      env.update((state) => {
        if (state.checks.worktree === worktree.id && state.checks.review?.number === params.number) state.checks.titleDraft = title
      })
      return { titleDraft: title }
    },
    checksCancelTitle: async (params, caller) => {
      const worktree = await resolveWorktree(env, params, caller)
      if (!positiveInteger(params.number)) throw env.invalid('invalid_input', 'number must be a positive pull request number.')
      currentReview(env, worktree.id, params.number)
      env.update((state) => {
        if (state.checks.worktree === worktree.id && state.checks.review?.number === params.number) state.checks.titleDraft = null
      })
      return { titleDraft: null }
    },
    checksSaveTitle: (params, caller) => saveTitle(env, params, caller),
    checksSetAgentDialog: (params) => setAgentDialog(env, params),
    checksLaunchAgent: (params, caller) => launchAgent(env, params, caller),
    checksGitAction: (params, caller) => runGitAction(env, params, caller),
    checksOpenReview: (params, caller) => openReview(env, params, caller)
  }
}
