import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostingEnv } from '../env'
import type { SnapshotRecorder, SnapshotResult } from '../pr-review'
import { aheadBehind, normalizeBase, projectDefaultBase, remoteBaseExists, upstreamRef } from '../pr-create'
import { isRecord, nonEmptyString, parseBranch, parsePositiveInteger, parseOid, providerReason } from '../pr-data'
import { gitlabError, type GitLabClient, type GitLabResponse } from './api'
import type { GitLabHandler, GitLabReview, GitLabScope } from './types'
import type { GitLabToken } from './token'

type Project = { id: string | number; defaultBranch?: string }
type ReviewLookup =
  | { kind: 'found'; review: GitLabReview; fetchedAt: number }
  | { kind: 'no-review'; fetchedAt: number }
  | { kind: 'unavailable'; reason: string; message: string; fetchedAt: number; retryDisabledUntil?: number; nextAutoRetryAt?: number }
type ReviewState = 'open' | 'draft' | 'closed' | 'merged'
type ApprovalSummary = { reviewDecision: string; reviews: { author: string | null; state: string }[] | null }
type ValidMergeRequest = {
  raw: Record<string, unknown>
  state: 'opened' | 'closed' | 'merged'
  title: string
  draft: boolean
  description: string | null
}

const REVIEW_CACHE_MS = 15_000
const PROJECT_CACHE_MS = 10 * 60_000
const UNKNOWN_COMPLETION_MESSAGE = 'GitLab may have created the merge request. Refresh before retrying.'
const AUTH_REQUIRED_MESSAGE = 'GitLab authentication is unavailable. Set GITLAB_TOKEN or run glab auth login.'
const UNAVAILABLE_MESSAGES: Record<string, string> = {
  auth_required: AUTH_REQUIRED_MESSAGE,
  permission_denied: 'GitLab denied access to the merge request.',
  not_found: 'GitLab could not find the requested merge request.',
  already_exists: 'A merge request already exists for this branch.',
  validation_error: 'GitLab rejected the merge request request.',
  rate_limited: 'GitLab API rate limit exceeded.',
  server_error: 'GitLab is temporarily unavailable.',
  redirect_refused: 'GitLab redirected the request; the redirect was refused.',
  network_error: 'Could not reach GitLab.',
  timeout: 'GitLab did not respond before the request deadline.',
  output_limit: 'GitLab returned too much data.',
  schema_drift: 'GitLab returned an unexpected response.'
}

function projectPath(scope: GitLabScope): string {
  return `/projects/${scope.projectId}`
}

function mergeRequestsPath(scope: GitLabScope): string {
  return `${projectPath(scope)}/merge_requests`
}

function mergeRequestPath(scope: GitLabScope, number: number): string {
  return `${mergeRequestsPath(scope)}/${number}`
}

function validationError(env: HostingEnv, message: string): never {
  throw env.invalid('validation_error', message)
}

function isReason(error: unknown, reason: string): boolean {
  return providerReason(error) === reason
}

function reasonOf(error: unknown): string {
  return providerReason(error) ?? 'server_error'
}

function safeMessage(reason: string): string {
  return UNAVAILABLE_MESSAGES[reason] ?? 'GitLab request failed.'
}

function errorRetryDisabledUntil(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.data)) return undefined
  const value = error.data.retryDisabledUntil
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function statusReason(status: number): string {
  if (status === 401) return 'auth_required'
  if (status === 403) return 'permission_denied'
  if (status === 404) return 'not_found'
  if (status === 409) return 'already_exists'
  if (status === 400 || status === 422) return 'validation_error'
  if (status === 429) return 'rate_limited'
  if (status >= 300 && status < 400) return 'redirect_refused'
  if (status >= 500) return 'server_error'
  return 'server_error'
}

function statusError(env: HostingEnv, response: GitLabResponse): Error {
  const reason = statusReason(response.status)
  const retryDisabledUntil = response.retryAfterMs === null ? undefined : Date.now() + Math.max(0, response.retryAfterMs)
  return gitlabError(env, reason, safeMessage(reason), retryDisabledUntil === undefined ? undefined : { retryDisabledUntil })
}

function requireSuccess(env: HostingEnv, response: GitLabResponse): void {
  if (response.status < 200 || response.status >= 300) throw statusError(env, response)
}

function unavailable(error: unknown, fetchedAt: number): ReviewLookup {
  const reason = reasonOf(error)
  const retryDisabledUntil = errorRetryDisabledUntil(error)
  return {
    kind: 'unavailable',
    reason,
    message: safeMessage(reason),
    fetchedAt,
    ...(retryDisabledUntil === undefined ? {} : { retryDisabledUntil })
  }
}
async function recordReviewSnapshot(recorder: SnapshotRecorder | undefined, result: ReviewLookup): Promise<void> {
  if (!recorder) return
  let projection: SnapshotResult
  if (result.kind === 'found') {
    projection = {
      kind: 'found',
      review: {
        number: result.review.number,
        url: result.review.url,
        state: result.review.state,
        checksStatus: result.review.checksStatus,
        headRefName: result.review.headRefName,
        headRefOid: result.review.headRefOid
      },
      fetchedAt: result.fetchedAt
    }
  } else if (result.kind === 'no-review') {
    projection = { kind: 'no-review', fetchedAt: result.fetchedAt }
  } else {
    projection = { kind: 'unavailable', message: result.message, fetchedAt: result.fetchedAt }
  }
  try {
    await recorder(projection)
  } catch {
    return
  }
}

function noReview(fetchedAt: number): ReviewLookup {
  return { kind: 'no-review', fetchedAt }
}

function found(review: GitLabReview, fetchedAt: number): ReviewLookup {
  return { kind: 'found', review, fetchedAt }
}

function asProject(value: unknown, env: HostingEnv): Project {
  if (!isRecord(value) || (typeof value.id !== 'number' && typeof value.id !== 'string')) {
    throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  }
  const defaultBranch = nonEmptyString(value.default_branch)
  return { id: value.id, ...(defaultBranch === undefined ? {} : { defaultBranch }) }
}

async function getProject(env: HostingEnv, scope: GitLabScope, client: GitLabClient): Promise<Project> {
  return env.cache(env.cacheKey(scope, 'gitlab:project'), PROJECT_CACHE_MS, async () => {
    const response = await client.request(scope, { method: 'GET', path: projectPath(scope) })
    requireSuccess(env, response)
    return asProject(response.json, env)
  })
}

async function requireAuth(env: HostingEnv, scope: GitLabScope, client: GitLabClient): Promise<void> {
  const credentials = await client.token(scope)
  if (!credentials.token) throw gitlabError(env, 'auth_required', AUTH_REQUIRED_MESSAGE)
}


function parseReviewNumber(env: HostingEnv, value: unknown): number {
  const number = parsePositiveInteger(value)
  if (number === undefined) validationError(env, 'number must be a positive integer.')
  return number
}

function sameProject(value: unknown, projectId: string | number): boolean {
  return (typeof value === 'number' || typeof value === 'string') && String(value) === String(projectId)
}

function isOpen(raw: Record<string, unknown>): boolean {
  return raw.state === 'opened' || raw.state === 'open'
}

function isDraft(raw: Record<string, unknown>): boolean {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  return raw.draft === true || raw.work_in_progress === true || /^(?:draft:|\[draft\]|\(draft\))/iu.test(title)
}

function stripDraftPrefix(title: string): string {
  return title.replace(/^(?:draft:|\[draft\]|\(draft\))\s*/iu, '').trim()
}

function titleWithDraftPrefix(title: string): string {
  const clean = stripDraftPrefix(title)
  return clean.length === 0 ? 'Draft' : `Draft: ${clean}`
}

function reviewState(raw: Record<string, unknown>): ReviewState {
  if (raw.state === 'merged') return 'merged'
  if (raw.state === 'closed') return 'closed'
  return isDraft(raw) ? 'draft' : 'open'
}

function mergeState(raw: Record<string, unknown>): { mergeable: GitLabReview['mergeable']; mergeStateStatus: string } {
  const status = typeof raw.detailed_merge_status === 'string' ? raw.detailed_merge_status.toLowerCase() : ''
  if (raw.has_conflicts === true || status === 'conflict') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
  if (status === 'mergeable') return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
  if (status === 'need_rebase') return { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' }
  if (status === 'draft_status') return { mergeable: 'UNKNOWN', mergeStateStatus: 'DRAFT' }
  if (status === 'checking' || status === 'unchecked' || status === 'preparing') return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
  return { mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED' }
}

function checksStatus(raw: Record<string, unknown>): GitLabReview['checksStatus'] {
  if (!isRecord(raw.head_pipeline) || typeof raw.head_pipeline.status !== 'string') return 'neutral'
  const status = raw.head_pipeline.status.toLowerCase()
  if (status === 'success') return 'success'
  if (status === 'failed' || status === 'canceled') return 'failure'
  if (['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'].includes(status)) return 'pending'
  return 'neutral'
}

function participantNames(value: unknown): { values: string[] | null; truncated: boolean } {
  if (!Array.isArray(value)) return { values: null, truncated: false }
  const values: string[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, 100)) {
    const name = typeof item === 'string' ? item : isRecord(item) ? item.username ?? item.login : undefined
    if (typeof name !== 'string' || name.length === 0 || name.length > 256) return { values: null, truncated: value.length > 100 }
    if (!seen.has(name)) {
      seen.add(name)
      values.push(name)
    }
  }
  return { values, truncated: value.length > 100 }
}

function projectWebUrl(scope: GitLabScope, number: number): string {
  const origin = new URL(scope.apiBase).origin
  return `${origin}/${scope.origin.owner}/${scope.origin.repo}/-/merge_requests/${number}`
}

async function approvalSummary(
  env: HostingEnv,
  scope: GitLabScope,
  number: number,
  client: GitLabClient
): Promise<ApprovalSummary> {
  let response: GitLabResponse
  try {
    response = await client.request(scope, { method: 'GET', path: `${mergeRequestPath(scope, number)}/approvals` })
  } catch (error) {
    if (isReason(error, 'permission_denied') || isReason(error, 'not_found')) return { reviewDecision: '', reviews: null }
    throw error
  }
  if (response.status === 403 || response.status === 404) return { reviewDecision: '', reviews: null }
  requireSuccess(env, response)
  if (!isRecord(response.json)) throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))

  const approvedBy = Array.isArray(response.json.approved_by) ? response.json.approved_by : []
  const reviews = approvedBy.map((entry) => {
    const user = isRecord(entry) && isRecord(entry.user) ? entry.user : undefined
    const author = user && typeof user.username === 'string' ? user.username : null
    return { author, state: 'APPROVED' }
  })
  const approved = response.json.approved === true && approvedBy.length > 0
  const approvalsLeft = typeof response.json.approvals_left === 'number' ? response.json.approvals_left : 0
  return {
    reviewDecision: approved ? 'APPROVED' : approvalsLeft > 0 ? 'REVIEW_REQUIRED' : '',
    reviews
  }
}

async function normalizeReview(
  env: HostingEnv,
  scope: GitLabScope,
  raw: Record<string, unknown>,
  client: GitLabClient
): Promise<GitLabReview | undefined> {
  if (raw.diff_refs === null || raw.diff_refs === undefined) return undefined
  if (!isRecord(raw.diff_refs)) throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  const number = parsePositiveInteger(raw.iid)
  const sourceBranch = parseBranch(raw.source_branch)
  const targetBranch = parseBranch(raw.target_branch)
  const headOid = parseOid(raw.sha) ?? parseOid(raw.diff_refs.head_sha)
  const baseOid = parseOid(raw.diff_refs.start_sha)
  if (!number || !sourceBranch || !targetBranch || !headOid || !baseOid) {
    throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  }

  const approvals = await approvalSummary(env, scope, number, client)
  const reviewers = participantNames(raw.reviewers)
  const assignees = participantNames(raw.assignees)
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title.length === 0) throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  const status = typeof raw.detailed_merge_status === 'string' ? raw.detailed_merge_status : ''
  const merge = mergeState(raw)
  return {
    provider: 'gitlab',
    number,
    url: projectWebUrl(scope, number),
    title: isDraft(raw) ? stripDraftPrefix(title) : title,
    body: typeof raw.description === 'string' ? raw.description : '',
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    state: reviewState(raw),
    headRefName: sourceBranch,
    baseRefName: targetBranch,
    headRefOid: headOid,
    baseRefOid: baseOid,
    mergeable: merge.mergeable,
    mergeStateStatus: merge.mergeStateStatus,
    detailedMergeStatus: status,
    checksStatus: checksStatus(raw),
    reviewDecision: approvals.reviewDecision,
    reviews: approvals.reviews,
    requestedReviewers: reviewers.values,
    assignees: assignees.values,
    participantsTruncated: reviewers.truncated || assignees.truncated,
    autoMergeRequest: null,
    stack: null,
    mergeMethods: { default: null, allowed: [] },
    mergeQueueRequired: false,
    inMergeQueue: false,
    mergeQueueEntry: null,
    autoMergeAllowed: null,
    mergeMetadataKnown: false,
    repository: scope.repository
  }
}

function diffPending(fetchedAt: number): ReviewLookup {
  return {
    kind: 'unavailable',
    reason: 'diff_pending',
    message: 'GitLab is still preparing this merge request.',
    fetchedAt,
    nextAutoRetryAt: fetchedAt + 5_000
  }
}

async function lookupByNumber(
  env: HostingEnv,
  scope: GitLabScope,
  project: Project,
  number: number,
  fetchedAt: number,
  client: GitLabClient,
  expected?: { branch: string; head?: string }
): Promise<ReviewLookup> {
  let response: GitLabResponse
  try {
    response = await client.request(scope, { method: 'GET', path: mergeRequestPath(scope, number) })
  } catch (error) {
    if (isReason(error, 'not_found')) return noReview(fetchedAt)
    throw error
  }
  if (response.status === 404) return noReview(fetchedAt)
  requireSuccess(env, response)
  if (!isRecord(response.json)) throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  if (expected) {
    if (!sameProject(response.json.project_id, project.id)
        || !sameProject(response.json.source_project_id, project.id)
        || parseBranch(response.json.source_branch) !== expected.branch
        || ((response.json.state === 'closed' || response.json.state === 'merged') && response.json.sha !== scope.worktree.head)
        || (expected.head !== undefined && response.json.sha !== expected.head)) {
      return noReview(fetchedAt)
    }
  } else if (response.json.project_id !== undefined && !sameProject(response.json.project_id, project.id)) {
    throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  }
  const review = await normalizeReview(env, scope, response.json, client)
  return review ? found(review, fetchedAt) : diffPending(fetchedAt)
}

function openedRows(items: unknown[], projectId: string | number, branch: string): Record<string, unknown>[] {
  return items.filter((item): item is Record<string, unknown> => isRecord(item)
    && sameProject(item.project_id, projectId)
    && sameProject(item.source_project_id, projectId)
    && parseBranch(item.source_branch) === branch)
}

function listedNumber(env: HostingEnv, row: Record<string, unknown>): number {
  const number = parsePositiveInteger(row.iid)
  if (!number) throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  return number
}

function newestFirst(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => Date.parse(typeof right.updated_at === 'string' ? right.updated_at : '')
    - Date.parse(typeof left.updated_at === 'string' ? left.updated_at : ''))
}

async function listMergeRequests(
  scope: GitLabScope,
  branch: string,
  client: GitLabClient
): Promise<unknown[]> {
  const result = await client.pages(scope, {
    method: 'GET',
    path: mergeRequestsPath(scope),
    query: { source_branch: branch, state: 'all', order_by: 'updated_at', sort: 'desc', per_page: 100 }
  }, 5)
  return result.items
}

async function lookupBranch(
  env: HostingEnv,
  scope: GitLabScope,
  project: Project,
  branch: string,
  fresh: boolean,
  params: Record<string, unknown>,
  client: GitLabClient
): Promise<ReviewLookup> {
  const fetchedAt = Date.now()
  if (params.number !== undefined) return lookupByNumber(env, scope, project, parseReviewNumber(env, params.number), fetchedAt, client)

  const items = await listMergeRequests(scope, branch, client)
  const rows = openedRows(items, project.id, branch)
  const opened = rows.filter(isOpen)
  if (opened.length > 1 && fresh) {
    return { kind: 'unavailable', reason: 'ambiguous_head', message: 'More than one merge request is open for this branch.', fetchedAt }
  }
  const open = newestFirst(opened)[0]
  if (open) {
    return lookupByNumber(env, scope, project, listedNumber(env, open), fetchedAt, client, { branch })
  }

  const head = scope.worktree.head
  const terminal = newestFirst(rows.filter((row) => (row.state === 'merged' || row.state === 'closed') && typeof head === 'string' && row.sha === head))[0]
  if (terminal) {
    return lookupByNumber(env, scope, project, listedNumber(env, terminal), fetchedAt, client, { branch, head })
  }

  const fallbackNumber = params.fallbackPRNumber === undefined ? undefined : parseReviewNumber(env, params.fallbackPRNumber)
  if (fallbackNumber !== undefined) return lookupByNumber(env, scope, project, fallbackNumber, fetchedAt, client)
  return noReview(fetchedAt)
}

async function cachedLookup(
  env: HostingEnv,
  scope: GitLabScope,
  cacheName: string,
  fresh: boolean,
  load: () => Promise<ReviewLookup>
): Promise<ReviewLookup> {
  if (fresh) return load()
  return env.cache(env.cacheKey(scope, cacheName), REVIEW_CACHE_MS, load)
}

function branchName(env: HostingEnv, scope: GitLabScope, params: Record<string, unknown>): string {
  const branch = parseBranch(params.branch === undefined ? scope.worktree.branch : params.branch)
  if (!branch) validationError(env, 'A valid branch is required to look up a merge request.')
  return branch
}

function eligibilityBlock(
  reason: string,
  nextAction: string,
  message: string,
  defaultBase: string | null,
  head: string | null,
  title: string,
  body: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const blocker = { reason, nextAction, message }
  return { eligible: false, defaultBase, head, title, body, blockers: [blocker], reason, nextAction, ...extra }
}

function eligibilityText(params: Record<string, unknown>, key: string): string {
  return typeof params[key] === 'string' ? params[key] as string : ''
}

async function selectedBase(
  env: HostingEnv,
  scope: GitLabScope,
  params: Record<string, unknown>,
  project: Project
): Promise<{ base?: string; defaultBase?: string }> {
  const requested = params.base === undefined ? undefined : nonEmptyString(params.base)
  if (params.base !== undefined && requested === undefined) validationError(env, 'base must be a non-empty string.')
  const worktreeBase = nonEmptyString(scope.worktree.baseRef)
  const saved = await projectDefaultBase(env, scope)
  const detected = project.defaultBranch
  const selected = requested ?? worktreeBase ?? saved ?? detected
  if (!selected) return {}
  const base = normalizeBase(selected)
  return { base, defaultBase: base }
}

async function gitlabEligibility(
  env: HostingEnv,
  scope: GitLabScope,
  params: Record<string, unknown>,
  client: GitLabClient
): Promise<Record<string, unknown>> {
  const title = eligibilityText(params, 'title')
  const body = eligibilityText(params, 'body')
  const branch = parseBranch(scope.worktree.branch)
  if (!branch) return eligibilityBlock('detached_head', 'checkout_branch', 'Check out a branch before creating a merge request.', null, null, title, body)

  let credentials: GitLabToken
  try {
    credentials = await client.token(scope)
  } catch {
    credentials = { token: null, source: null, glabAvailable: null }
  }
  if (!credentials.token) {
    return eligibilityBlock('authentication_required', 'authenticate', AUTH_REQUIRED_MESSAGE, null, branch, title, body)
  }

  let project: Project
  try {
    project = await getProject(env, scope, client)
  } catch {
    return eligibilityBlock('lookup_unavailable', 'retry_lookup', 'Could not verify whether this branch already has a merge request.', null, branch, title, body)
  }
  let lookup: ReviewLookup
  try {
    lookup = await lookupBranch(env, scope, project, branch, true, {}, client)
  } catch {
    lookup = { kind: 'unavailable', reason: 'server_error', message: safeMessage('server_error'), fetchedAt: Date.now() }
  }
  if (lookup.kind === 'found') {
    return eligibilityBlock('existing_review', 'open_existing_review', 'This branch already has a merge request.', null, branch, title, body, { review: lookup.review })
  }
  if (lookup.kind === 'unavailable') {
    return eligibilityBlock('lookup_unavailable', 'retry_lookup', 'Could not verify whether this branch already has a merge request.', null, branch, title, body)
  }

  let baseSelection: { base?: string; defaultBase?: string }
  try {
    baseSelection = await selectedBase(env, scope, params, project)
  } catch (error) {
    if (providerReason(error) === 'validation_error') throw error
    baseSelection = {}
  }
  const base = baseSelection.base
  if (!base) return eligibilityBlock('missing_remote_base', 'fetch_base', 'Could not determine a base branch for this repository.', null, branch, title, body)
  const defaultBranch = project.defaultBranch ? normalizeBase(project.defaultBranch) : base
  if (branch.toLowerCase() === defaultBranch.toLowerCase() || branch.toLowerCase() === base.toLowerCase()) {
    return eligibilityBlock('default_branch', 'create_new_branch', 'A merge request cannot be created from the repository default branch.', baseSelection.defaultBase ?? base, branch, title, body)
  }

  let status = ''
  try {
    status = await env.git(scope, ['status', '--porcelain', '--untracked-files=all'])
  } catch {
    status = '?'
  }
  if (status.trim().length > 0) {
    return eligibilityBlock('dirty_tree', 'commit_changes', 'Commit or discard local changes before creating a merge request.', baseSelection.defaultBase ?? base, branch, title, body)
  }

  const upstream = await upstreamRef(env, scope, branch)
  if (!upstream) return eligibilityBlock('no_upstream', 'publish_branch', 'Publish this branch and configure its upstream before creating a merge request.', baseSelection.defaultBase ?? base, branch, title, body)
  const divergence = await aheadBehind(env, scope, upstream)
  if (!divergence) return eligibilityBlock('no_upstream', 'configure_upstream', 'Could not verify the branch upstream.', baseSelection.defaultBase ?? base, branch, title, body)
  if (divergence.behind > 0) return eligibilityBlock('branch_behind', 'sync_branch', 'Sync this branch with its upstream before creating a merge request.', baseSelection.defaultBase ?? base, branch, title, body)
  if (divergence.ahead > 0) return eligibilityBlock('branch_ahead', 'push_branch', 'Push local commits to the configured upstream before creating a merge request.', baseSelection.defaultBase ?? base, branch, title, body)
  if (!(await remoteBaseExists(env, scope, base))) {
    return eligibilityBlock('missing_remote_base', 'fetch_base', `The base branch ${base} is not present on a configured remote.`, baseSelection.defaultBase ?? base, branch, title, body)
  }

  return { eligible: true, defaultBase: baseSelection.defaultBase ?? base, head: branch, title, body, blockers: [] }
}

async function templateBody(scope: GitLabScope, supplied: string | undefined, useTemplate: boolean): Promise<string> {
  if (!useTemplate || (supplied !== undefined && supplied.trim().length > 0)) return supplied ?? ''
  const path = join(scope.worktree.path, '.gitlab', 'merge_request_templates', 'Default.md')
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 64 * 1024) return ''
    const body = await readFile(path)
    if (body.byteLength > 64 * 1024) return ''
    return body.toString('utf8')
  } catch {
    return ''
  }
}

function currentBranch(env: HostingEnv, scope: GitLabScope): string {
  const branch = parseBranch(scope.worktree.branch)
  if (!branch) validationError(env, 'Check out a branch before creating a merge request.')
  return branch
}

function requestedCreateTitle(env: HostingEnv, params: Record<string, unknown>): string {
  const title = params.title
  if (typeof title !== 'string' || title.trim().length === 0 || /\u0000/u.test(title)) {
    validationError(env, 'title must be a non-empty string.')
  }
  return title.trim()
}

function requestedCreateBody(env: HostingEnv, params: Record<string, unknown>): string | undefined {
  const body = params.body
  if (body === undefined) return undefined
  if (typeof body !== 'string' || /\u0000/u.test(body)) validationError(env, 'body must be a string.')
  return body
}

function requestedCreateBranch(env: HostingEnv, params: Record<string, unknown>, branch: string): string {
  if (params.head === undefined) return branch
  const requested = parseBranch(params.head)
  if (!requested || requested !== branch) validationError(env, 'head must be the current branch.')
  return branch
}

function createdResult(scope: GitLabScope, raw: unknown): { number: number; url: string; existing: boolean } | undefined {
  if (!isRecord(raw)) return undefined
  const number = parsePositiveInteger(raw.iid)
  if (!number) return undefined
  return { number, url: projectWebUrl(scope, number), existing: false }
}

function mrTitle(raw: Record<string, unknown>): string {
  return typeof raw.title === 'string' ? raw.title.trim() : ''
}

async function createCandidates(
  scope: GitLabScope,
  projectId: string | number,
  branch: string,
  base: string,
  title: string,
  client: GitLabClient
): Promise<Record<string, unknown>[]> {
  const items = await listMergeRequests(scope, branch, client)
  return items.filter((item): item is Record<string, unknown> => isRecord(item)
    && isOpen(item)
    && sameProject(item.project_id, projectId)
    && sameProject(item.source_project_id, projectId)
    && parseBranch(item.source_branch) === branch
    && parseBranch(item.target_branch) === base
    && (title === '' || mrTitle(item) === title))
}

function unknownCompletion(env: HostingEnv): Error {
  return gitlabError(env, 'unknown_completion', UNKNOWN_COMPLETION_MESSAGE)
}

async function reconcileCreate(
  env: HostingEnv,
  scope: GitLabScope,
  projectId: string | number,
  branch: string,
  base: string,
  title: string,
  client: GitLabClient,
  onConflict: boolean
): Promise<{ number: number; url: string; existing: boolean } | undefined> {
  const candidates = await createCandidates(scope, projectId, branch, base, onConflict ? '' : title, client)
  if (candidates.length !== 1) return undefined
  const number = parsePositiveInteger(candidates[0]?.iid)
  if (!number) return undefined
  return { number, url: projectWebUrl(scope, number), existing: onConflict }
}

async function createMergeRequest(
  env: HostingEnv,
  scope: GitLabScope,
  params: Record<string, unknown>,
  client: GitLabClient
): Promise<Record<string, unknown>> {
  if (Object.hasOwn(params, 'expected')) {
    throw env.invalid('unsupported_provider', 'GitLab hosting does not support pinned merge-request creation.')
  }
  const title = requestedCreateTitle(env, params)
  const branch = currentBranch(env, scope)
  requestedCreateBranch(env, params, branch)
  const suppliedBody = requestedCreateBody(env, params)
  const eligibility = await gitlabEligibility(env, scope, params, client)
  if (eligibility.reason === 'existing_review' && isRecord(eligibility.review)) {
    const existingNumber = parsePositiveInteger(eligibility.review.number)
    if (existingNumber) return { number: existingNumber, url: projectWebUrl(scope, existingNumber), existing: true }
  }
  if (eligibility.eligible !== true) {
    const blocker = Array.isArray(eligibility.blockers) && isRecord(eligibility.blockers[0])
      ? eligibility.blockers[0]
      : undefined
    const reason = blocker && typeof blocker.reason === 'string' ? blocker.reason : 'lookup_unavailable'
    const message = blocker && typeof blocker.message === 'string'
      ? blocker.message
      : 'Could not verify whether this branch already has a merge request.'
    throw env.invalid(reason, message)
  }

  const project = await getProject(env, scope, client)
  const base = nonEmptyString(eligibility.defaultBase)
  if (!base) throw env.invalid('missing_remote_base', 'Could not determine a base branch for this repository.')
  const requestTitle = params.draft === true ? titleWithDraftPrefix(title) : title
  const description = await templateBody(scope, suppliedBody, params.useTemplate === true)
  const request = { source_branch: branch, target_branch: base, title: requestTitle, description }
  let response: GitLabResponse
  try {
    response = await client.request(scope, { method: 'POST', path: mergeRequestsPath(scope), body: request })
  } catch (error) {
    const reason = reasonOf(error)
    if (reason === 'already_exists') {
      const existing = await reconcileCreate(env, scope, project.id, branch, base, requestTitle, client, true)
      if (existing) return existing
      throw error
    }
    if (!['network_error', 'timeout', 'server_error', 'output_limit', 'schema_drift'].includes(reason)) throw error
    let recovered: { number: number; url: string; existing: boolean } | undefined
    try {
      recovered = await reconcileCreate(env, scope, project.id, branch, base, requestTitle, client, false)
    } catch {
      recovered = undefined
    }
    env.changed(scope)
    if (recovered) return recovered
    throw unknownCompletion(env)
  }

  if (response.status === 409) {
    const existing = await reconcileCreate(env, scope, project.id, branch, base, requestTitle, client, true)
    if (existing) return existing
    throw statusError(env, response)
  }
  try {
    requireSuccess(env, response)
  } catch (error) {
    const reason = reasonOf(error)
    if (!['network_error', 'timeout', 'server_error', 'output_limit', 'schema_drift'].includes(reason)) throw error
    let recovered: { number: number; url: string; existing: boolean } | undefined
    try {
      recovered = await reconcileCreate(env, scope, project.id, branch, base, requestTitle, client, false)
    } catch {
      recovered = undefined
    }
    env.changed(scope)
    if (recovered) return recovered
    throw unknownCompletion(env)
  }

  const created = createdResult(scope, response.json)
  if (!created) {
    let recovered: { number: number; url: string; existing: boolean } | undefined
    try {
      recovered = await reconcileCreate(env, scope, project.id, branch, base, requestTitle, client, false)
    } catch {
      recovered = undefined
    }
    env.changed(scope)
    if (recovered) return recovered
    throw unknownCompletion(env)
  }
  env.changed(scope)
  return created
}

function validateUpdateAction(env: HostingEnv, action: unknown): asserts action is 'edit' | 'close' | 'reopen' | 'ready' | 'draft' {
  if (action !== 'edit' && action !== 'close' && action !== 'reopen' && action !== 'ready' && action !== 'draft') {
    validationError(env, 'action must be edit, close, reopen, ready, or draft.')
  }
}

function validateEditParams(env: HostingEnv, params: Record<string, unknown>): { title?: string; body?: string } {
  const edit: { title?: string; body?: string } = {}
  if (params.title !== undefined) {
    if (typeof params.title !== 'string' || params.title.trim().length === 0 || /\u0000/u.test(params.title)) {
      validationError(env, 'title must be a non-empty string.')
    }
    edit.title = params.title.trim()
  }
  if (params.body !== undefined) {
    if (typeof params.body !== 'string' || /\u0000/u.test(params.body)) validationError(env, 'body must be a string.')
    edit.body = params.body
  }
  if (edit.title === undefined && edit.body === undefined) validationError(env, 'Provide a title or body to edit.')
  return edit
}

function draftOf(raw: Record<string, unknown>, title: string): boolean {
  return raw.draft === true || raw.work_in_progress === true || /^(?:draft:|\[draft\]|\(draft\))/iu.test(title)
}

function validMergeRequest(raw: unknown, number: number, projectId: string | number): ValidMergeRequest | undefined {
  if (!isRecord(raw) || parsePositiveInteger(raw.iid) !== number || !sameProject(raw.project_id, projectId)) return undefined
  if (raw.state !== 'opened' && raw.state !== 'closed' && raw.state !== 'merged') return undefined
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) return undefined
  if (raw.draft !== undefined && typeof raw.draft !== 'boolean') return undefined
  if (raw.work_in_progress !== undefined && typeof raw.work_in_progress !== 'boolean') return undefined
  const title = raw.title.trim()
  return {
    raw,
    state: raw.state,
    title,
    draft: draftOf(raw, title),
    description: typeof raw.description === 'string' ? raw.description : null
  }
}

function stateOf(mr: ValidMergeRequest): ReviewState {
  if (mr.state === 'merged' || mr.state === 'closed') return mr.state
  return mr.draft ? 'draft' : 'open'
}

function confirmsUpdate(
  mr: ValidMergeRequest,
  action: 'edit' | 'close' | 'reopen' | 'ready' | 'draft',
  sent: Record<string, unknown>
): boolean {
  if (action === 'ready') return !mr.draft
  if (action === 'draft') return mr.draft
  if (action === 'close') return mr.state === 'closed'
  if (action === 'reopen') return mr.state === 'opened'
  if (sent.title !== undefined && mr.title !== sent.title) return false
  if (typeof sent.description === 'string'
    && mr.description?.replace(/\r\n/gu, '\n') !== sent.description.replace(/\r\n/gu, '\n')) return false
  return true
}

async function readCurrent(
  env: HostingEnv,
  scope: GitLabScope,
  number: number,
  client: GitLabClient,
  projectId: string | number
): Promise<ValidMergeRequest> {
  const response = await client.request(scope, { method: 'GET', path: mergeRequestPath(scope, number) })
  if (response.status === 404) throw gitlabError(env, 'not_found', safeMessage('not_found'))
  requireSuccess(env, response)
  const current = validMergeRequest(response.json, number, projectId)
  if (!current) throw gitlabError(env, 'schema_drift', safeMessage('schema_drift'))
  return current
}


async function updateMergeRequest(
  env: HostingEnv,
  scope: GitLabScope,
  params: Record<string, unknown>,
  client: GitLabClient
): Promise<Record<string, unknown>> {
  const number = parseReviewNumber(env, params.number)
  validateUpdateAction(env, params.action)
  const action = params.action
  const edit = action === 'edit' ? validateEditParams(env, params) : undefined
  await requireAuth(env, scope, client)
  const project = await getProject(env, scope, client)
  const current = await readCurrent(env, scope, number, client, project.id)
  if ((action === 'close' || action === 'reopen') && current.state === 'merged') {
    throw env.invalid('invalid_state', `GitLab cannot ${action} a merged merge request.`)
  }
  if ((action === 'close' && current.state === 'closed') || (action === 'reopen' && current.state === 'opened')) {
    return { number, updated: false, state: stateOf(current) }
  }
  let body: Record<string, unknown>

  if (action === 'ready') {
    if (!current.draft) return { number, updated: false, state: stateOf(current) }
    body = { title: stripDraftPrefix(current.title) }
  } else if (action === 'draft') {
    if (current.draft) return { number, updated: false, state: stateOf(current) }
    body = { title: titleWithDraftPrefix(current.title) }
  } else if (action === 'edit') {
    body = {
      ...(edit?.title === undefined ? {} : { title: current.draft ? titleWithDraftPrefix(edit.title) : stripDraftPrefix(edit.title) }),
      ...(edit?.body === undefined ? {} : { description: edit.body })
    }
  } else {
    body = { state_event: action }
  }

  let confirmed: ValidMergeRequest | undefined
  try {
    const response = await client.request(scope, { method: 'PUT', path: mergeRequestPath(scope, number), body })
    requireSuccess(env, response)
    const updated = validMergeRequest(response.json, number, project.id)
    if (updated && confirmsUpdate(updated, action, body)) confirmed = updated
  } catch (error) {
    if (!isReason(error, 'schema_drift') && !isReason(error, 'output_limit')) throw error
  }
  if (!confirmed) {
    try {
      const readback = await readCurrent(env, scope, number, client, project.id)
      if (confirmsUpdate(readback, action, body)) confirmed = readback
    } catch {
      confirmed = undefined
    }
  }
  env.changed(scope)
  if (!confirmed) {
    throw gitlabError(env, 'unknown_completion', 'GitLab did not confirm the merge request update. Refresh before retrying.')
  }
  return { number, updated: true, state: stateOf(confirmed) }
}

export function createGitLabReviewHandlers(env: HostingEnv, client: GitLabClient): Record<string, GitLabHandler> {
  const forBranch: GitLabHandler = async (scope, params, caller, beginSnapshot) => {
    const branch = branchName(env, scope, params)
    if (params.number !== undefined) parseReviewNumber(env, params.number)
    if (params.fallbackPRNumber !== undefined) parseReviewNumber(env, params.fallbackPRNumber)
    if (params.fresh !== undefined && typeof params.fresh !== 'boolean') {
      validationError(env, 'fresh must be a boolean.')
    }
    const recorder = caller && beginSnapshot ? await beginSnapshot(scope, params, caller, 'branch') : undefined
    try {
      await requireAuth(env, scope, client)
    } catch (error) {
      await recordReviewSnapshot(recorder, unavailable(error, Date.now()))
      throw error
    }
    const fresh = params.fresh === true
    const cacheName = `gitlab:for-branch:${branch}:${params.number ?? ''}:${params.fallbackPRNumber ?? ''}`
    const result = await cachedLookup(env, scope, cacheName, fresh, async () => {
      const fetchedAt = Date.now()
      try {
        const project = await getProject(env, scope, client)
        return await lookupBranch(env, scope, project, branch, fresh, params, client)
      } catch (error) {
        return unavailable(error, fetchedAt)
      }
    })
    await recordReviewSnapshot(recorder, result)
    return result
  }

  const review: GitLabHandler = async (scope, params, caller, beginSnapshot) => {
    const number = parseReviewNumber(env, params.number)
    if (params.fresh !== undefined && typeof params.fresh !== 'boolean') {
      validationError(env, 'fresh must be a boolean.')
    }
    const recorder = caller && beginSnapshot ? await beginSnapshot(scope, params, caller, 'review') : undefined
    try {
      await requireAuth(env, scope, client)
    } catch (error) {
      await recordReviewSnapshot(recorder, unavailable(error, Date.now()))
      throw error
    }
    const result = await cachedLookup(env, scope, `gitlab:review:${number}`, params.fresh === true, async () => {
      const fetchedAt = Date.now()
      try {
        const project = await getProject(env, scope, client)
        return await lookupByNumber(env, scope, project, number, fetchedAt, client)
      } catch (error) {
        if (isReason(error, 'not_found')) return noReview(fetchedAt)
        return unavailable(error, fetchedAt)
      }
    })
    await recordReviewSnapshot(recorder, result)
    return result
  }

  const creationEligibility: GitLabHandler = async (scope, params) => gitlabEligibility(env, scope, params, client)
  const create: GitLabHandler = async (scope, params) => createMergeRequest(env, scope, params, client)
  const updateReview: GitLabHandler = async (scope, params) => updateMergeRequest(env, scope, params, client)

  return { forBranch, review, creationEligibility, create, updateReview }
}
