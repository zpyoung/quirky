import type { Handler, HostingEnv, Scope } from './env'
import { isRecord, nonEmptyString, parseBranch, parseOid, parsePositiveInteger, parseIdentity, sameIdentity, providerReason, type IdentityValue } from './pr-data'
import { reviewParticipants, type ReviewParticipants } from './review-participants'

const LOOKUP_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'url', 'isDraft', 'updatedAt', 'mergeable', 'reviewDecision', 'mergeStateStatus',
  'autoMergeRequest', 'baseRefName', 'headRefName', 'baseRefOid', 'headRefOid', 'headRepositoryOwner', 'headRepository', 'statusCheckRollup',
  'additions', 'deletions', 'changedFiles', 'reviewRequests', 'reviews', 'assignees'
].join(',')
const FOUND_TTL = 120_000
const ACTIVE_TTL = 60_000
const ABSENT_TTL = 15 * 60_000
const MERGED_TTL = 6 * 60 * 60_000
const CACHE_CAPACITY = 500

const PROVIDER_FAILURE_MESSAGES: Record<string, string> = {
  not_found: 'The GitHub pull request was not found in the configured repository.',
  repo_unavailable: 'The GitHub repository is unavailable or cannot be resolved.',
  repository_unavailable: 'The GitHub repository is unavailable or inaccessible.',
  rate_limited: 'GitHub rate limits prevent this pull request lookup.',
  auth_required: 'GitHub authentication is unavailable. Check your gh login.',
  not_authenticated: 'GitHub authentication is unavailable. Check your gh login.',
  permission_denied: 'GitHub did not allow access to this pull request.',
  network_error: 'GitHub is unreachable right now. Check your network and try again.',
  gh_unavailable: 'GitHub CLI is unavailable.',
  server_error: 'GitHub is temporarily unavailable.',
  timeout: 'The GitHub request timed out.',
  output_limit: 'The GitHub response exceeded the configured output limit.',
  cancelled: 'The GitHub request was cancelled.',
  validation_error: 'GitHub rejected the requested operation.',
  schema_drift: 'GitHub returned an unsupported API schema.',
  scope_missing: 'The authenticated GitHub account lacks the required API scopes.',
  body_too_long: 'GitHub rejected the request because its body is too long.',
  already_exists: 'A matching GitHub item already exists.',
  head_changed: 'The pull request head changed. Refresh and review the new commit before trying again.',
  upstream_error: 'The GitHub request failed.',
  upstream_unavailable: 'GitHub pull request lookup is unavailable.'
}
export type ReviewState = 'open' | 'draft' | 'closed' | 'merged'
export type CheckState = 'neutral' | 'pending' | 'success' | 'failure'
export type Review = {
  provider: 'github'
  number: number
  url: string
  title: string
  body: string
  updatedAt: string | null
  state: ReviewState
  headRefName: string
  baseRefName: string
  headRefOid: string
  baseRefOid: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  checksStatus: CheckState
  reviewDecision: string
  mergeStateStatus: string
  autoMergeRequest: unknown
  stack: unknown
  mergeMethods: unknown
  mergeQueueRequired: boolean | null
  autoMergeAllowed: boolean | null
  mergeMetadataKnown: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  headRepositoryOwner?: { login: string }
  headRepository?: { name: string; owner?: { login: string } }
} & ReviewParticipants

export type Lookup =
  | { kind: 'found'; review: Review; fetchedAt: number }
  | { kind: 'no-review'; fetchedAt: number }
  | { kind: 'unavailable'; reason: string; message: string; fetchedAt: number; retryDisabledUntil?: number; nextAutoRetryAt?: number }

export type PRMergeMetadata = {
  known: boolean
  defaultBranch: string | null
  mergeQueueRequired: boolean | null
  autoMergeAllowed: boolean | null
  mergeMethods: { default: string | null; allowed: string[] }
  rules: unknown[]
}

export type PRRead = { scope: Scope; repository: IdentityValue; raw: Record<string, unknown>; review: Review; metadata: PRMergeMetadata; stackKnown: boolean }
export type PRStackSummary = {
  number: number
  position: number
  size: number
  base: { ref: string; sha: string }
}

export function isPRStackSummary(value: unknown): value is PRStackSummary {
  if (!isRecord(value) || !isRecord(value.base)) return false
  const number = parsePositiveInteger(value.number)
  const position = parsePositiveInteger(value.position)
  const size = parsePositiveInteger(value.size)
  return number !== undefined && position !== undefined && size !== undefined &&
    position <= size && parseBranch(value.base.ref) !== undefined && parseOid(value.base.sha) !== undefined
}


type CachedLookup = { expiresAt: number; value: Lookup }
export type PRLookup = {
  forBranch(params: Record<string, unknown>, caller: Parameters<Handler>[1], options?: { noCache?: boolean }): Promise<Lookup>
  review(params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<Lookup>
  readFresh(params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<PRRead | null>
  invalidate(scope: Scope, data?: Record<string, unknown>): void
}

function inputError(env: HostingEnv, message: string): never {
  throw env.invalid('validation_error', message)
}

function identityLabel(identity: IdentityValue): string {
  return `${identity.host}/${identity.owner}/${identity.repo}`
}

function repoArg(identity: IdentityValue): string {
  return `${identity.owner}/${identity.repo}`
}

function identityCandidates(scope: Scope): IdentityValue[] {
  const candidates: IdentityValue[] = []
  for (const value of [...(scope.candidates ?? []), scope.repository, scope.origin]) {
    const identity = parseIdentity(value)
    if (identity && !candidates.some((item) => sameIdentity(item, identity))) candidates.push(identity)
  }
  return candidates
}

function selectRepositories(env: HostingEnv, scope: Scope, supplied: unknown): IdentityValue[] {
  const candidates = identityCandidates(scope)
  if (supplied === undefined) return candidates
  const requested = parseIdentity(supplied)
  if (!requested) inputError(env, 'prRepo must identify a configured GitHub repository.')
  if (!candidates.some((candidate) => sameIdentity(candidate, requested))) {
    throw env.invalid('repository_mismatch', 'The requested pull request repository is not configured for this worktree.')
  }
  return candidates.filter((candidate) => sameIdentity(candidate, requested))
}

function parseArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stateOf(raw: Record<string, unknown>): ReviewState | undefined {
  const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : ''
  if (state === 'MERGED' || raw.merged === true) return 'merged'
  if (state === 'CLOSED') return 'closed'
  if (raw.isDraft === true || raw.draft === true || state === 'DRAFT') return 'draft'
  if (state === 'OPEN') return 'open'
  return undefined
}

function checksStatus(raw: Record<string, unknown>): CheckState {
  const rollup = parseArray(raw.statusCheckRollup)
  let passed = false
  for (const item of rollup) {
    if (!isRecord(item)) continue
    const status = String(item.status ?? item.state ?? '').toUpperCase()
    const conclusion = String(item.conclusion ?? '').toUpperCase()
    if (['FAILURE', 'ERROR', 'STARTUP_FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(conclusion)) return 'failure'
    if (conclusion === 'PENDING' || !['COMPLETED', 'SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(status)) return 'pending'
    if (['SUCCESS', 'SKIPPED'].includes(conclusion) || status === 'SUCCESS') passed = true
  }
  return passed ? 'success' : 'neutral'
}

function mergeability(raw: Record<string, unknown>): Review['mergeable'] {
  const mergeable = raw.mergeable
  const mergeState = String(raw.mergeStateStatus ?? raw.mergeable_state ?? '').toUpperCase()
  if (mergeable === false || mergeable === 'CONFLICTING' || mergeState === 'DIRTY') return 'CONFLICTING'
  if (mergeable === true || mergeable === 'MERGEABLE' || mergeState === 'CLEAN') return 'MERGEABLE'
  return 'UNKNOWN'
}

function reviewFromRaw(raw: Record<string, unknown>, repository: IdentityValue, metadata: PRMergeMetadata, stack: unknown): Review | undefined {
  const number = parsePositiveInteger(raw.number)
  const suppliedUrl = nonEmptyString(raw.url)
  const title = typeof raw.title === 'string' ? raw.title : undefined
  const body = typeof raw.body === 'string' ? raw.body : ''
  const state = stateOf(raw)
  const headRefName = parseBranch(raw.headRefName)
  const baseRefName = parseBranch(raw.baseRefName)
  const headRefOid = parseOid(raw.headRefOid)
  const baseRefOid = parseOid(raw.baseRefOid)
  if (!number || !suppliedUrl || title === undefined || !state || !headRefName || !baseRefName || !headRefOid || !baseRefOid) return undefined
  let parsedUrl: URL
  try {
    parsedUrl = new URL(suppliedUrl)
  } catch {
    return undefined
  }
  const expectedPath = `/${repository.owner}/${repository.repo}/pull/${number}`
  if ((parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') || parsedUrl.host.toLowerCase() !== repository.host.toLowerCase() ||
    parsedUrl.pathname.toLowerCase() !== expectedPath.toLowerCase()) return undefined
  const url = `${parsedUrl.origin}${expectedPath}`

  const providerUpdatedAt = raw.updatedAt ?? raw.updated_at
  const review: Review = {
    ...reviewParticipants(raw),
    provider: 'github', number, url, title, body, state, headRefName, baseRefName, headRefOid, baseRefOid,
    updatedAt: typeof providerUpdatedAt === 'string' && Number.isFinite(Date.parse(providerUpdatedAt)) ? providerUpdatedAt : null,
    mergeable: mergeability(raw), checksStatus: checksStatus(raw),
    reviewDecision: Object.hasOwn(raw, 'reviewDecision') && (
      raw.reviewDecision === null ||
      (typeof raw.reviewDecision === 'string' && raw.reviewDecision.trim().length === 0)
    ) ? 'NONE' : typeof raw.reviewDecision === 'string' ? raw.reviewDecision : 'UNKNOWN',
    mergeStateStatus: typeof raw.mergeStateStatus === 'string' ? raw.mergeStateStatus : 'UNKNOWN',
    autoMergeRequest: raw.autoMergeRequest ?? null,
    stack,
    mergeMethods: metadata.mergeMethods,
    mergeQueueRequired: metadata.mergeQueueRequired,
    autoMergeAllowed: metadata.autoMergeAllowed,
    mergeMetadataKnown: metadata.known
  }
  for (const key of ['additions', 'deletions', 'changedFiles'] as const) {
    const count = raw[key]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) review[key] = count
  }
  if (isRecord(raw.headRepositoryOwner) && typeof raw.headRepositoryOwner.login === 'string') {
    review.headRepositoryOwner = { login: raw.headRepositoryOwner.login }
  }
  if (isRecord(raw.headRepository) && typeof raw.headRepository.name === 'string') {
    const repositoryValue: { name: string; owner?: { login: string } } = { name: raw.headRepository.name }
    if (isRecord(raw.headRepository.owner) && typeof raw.headRepository.owner.login === 'string') {
      repositoryValue.owner = { login: raw.headRepository.owner.login }
    }
    review.headRepository = repositoryValue
  }
  return review
}

function errorFields(error: unknown): { message: string; reason?: string; retryDisabledUntil?: number; nextAutoRetryAt?: number } {
  const reportedReason = providerReason(error)
  const reason = reportedReason && Object.hasOwn(PROVIDER_FAILURE_MESSAGES, reportedReason) ? reportedReason : 'upstream_unavailable'
  let retryDisabledUntil: number | undefined
  let nextAutoRetryAt: number | undefined
  if (isRecord(error) && isRecord(error.data)) {
    if (typeof error.data.retryDisabledUntil === 'number' && Number.isFinite(error.data.retryDisabledUntil)) retryDisabledUntil = error.data.retryDisabledUntil
    if (typeof error.data.nextAutoRetryAt === 'number' && Number.isFinite(error.data.nextAutoRetryAt)) nextAutoRetryAt = error.data.nextAutoRetryAt
  }
  return {
    message: PROVIDER_FAILURE_MESSAGES[reason] ?? PROVIDER_FAILURE_MESSAGES.upstream_unavailable!,
    reason,
    ...(retryDisabledUntil !== undefined ? { retryDisabledUntil } : {}),
    ...(nextAutoRetryAt !== undefined ? { nextAutoRetryAt } : {})
  }
}

function isMissing(error: unknown): boolean {
  return errorFields(error).reason === 'not_found'
}

function metadataFromResponse(value: unknown): PRMergeMetadata {
  const root = isRecord(value) && isRecord(value.data) ? value.data : value
  const repository = isRecord(root) && isRecord(root.repository) ? root.repository : undefined
  if (!repository) {
    return { known: false, defaultBranch: null, mergeQueueRequired: null, autoMergeAllowed: null, mergeMethods: { default: null, allowed: [] }, rules: [] }
  }
  const defaultBranch = isRecord(repository.defaultBranchRef) && typeof repository.defaultBranchRef.name === 'string'
    ? repository.defaultBranchRef.name
    : null
  const queue = repository.mergeQueue
  const rulesData = isRecord(repository.ref) && isRecord(repository.ref.rules) ? repository.ref.rules.nodes : undefined
  const rules = parseArray(rulesData)
  const ruleRequiresQueue = rules.some((rule) => isRecord(rule) && rule.type === 'MERGE_QUEUE')
  const queueRequired = queue === null || queue === undefined ? ruleRequiresQueue : isRecord(queue)
  const allowed: string[] = []
  if (repository.squashMergeAllowed === true) allowed.push('squash')
  if (repository.mergeCommitAllowed === true) allowed.push('merge')
  if (repository.rebaseMergeAllowed === true) allowed.push('rebase')
  const defaultMethod = typeof repository.viewerDefaultMergeMethod === 'string'
    ? repository.viewerDefaultMergeMethod.toLowerCase().replace('_', '')
    : allowed[0] ?? null
  const known = typeof repository.squashMergeAllowed === 'boolean' && typeof repository.mergeCommitAllowed === 'boolean' &&
    typeof repository.rebaseMergeAllowed === 'boolean' && (queue === null || isRecord(queue)) && Array.isArray(rulesData)
  return {
    known,
    defaultBranch,
    mergeQueueRequired: queue === null || isRecord(queue) ? queueRequired : null,
    autoMergeAllowed: typeof repository.autoMergeAllowed === 'boolean' ? repository.autoMergeAllowed : null,
    mergeMethods: { default: defaultMethod, allowed },
    rules
  }
}

function graphqlMetadataQuery(): string {
  return 'query HostingPRMergeMetadata($owner:String!,$name:String!,$branch:String!,$qualifiedBranch:String!){repository(owner:$owner,name:$name){viewerDefaultMergeMethod mergeCommitAllowed rebaseMergeAllowed squashMergeAllowed autoMergeAllowed defaultBranchRef{name} mergeQueue(branch:$branch){id} ref(qualifiedName:$qualifiedBranch){rules(first:50){nodes{type parameters{... on PullRequestParameters{requiredApprovingReviewCount}}}}}}}'
}

async function readMetadata(env: HostingEnv, scope: Scope, repository: IdentityValue, branch: string, fresh = false): Promise<PRMergeMetadata> {
  const key = env.cacheKey(scope, `pr-merge-metadata:${identityLabel(repository)}:${branch}`)
  const load = async (): Promise<PRMergeMetadata> => {
    const response = await env.graphql(scope, graphqlMetadataQuery(), {
      owner: repository.owner,
      name: repository.repo,
      branch,
      qualifiedBranch: `refs/heads/${branch}`
    }, { idempotent: true })
    return metadataFromResponse(response)
  }
  try {
    return fresh ? await load() : await env.cache(key, 10 * 60_000, load)
  } catch {
    return { known: false, defaultBranch: null, mergeQueueRequired: null, autoMergeAllowed: null, mergeMethods: { default: null, allowed: [] }, rules: [] }
  }
}

function normalizeRestPull(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const head = isRecord(raw.head) ? raw.head : undefined
  const base = isRecord(raw.base) ? raw.base : undefined
  const headRefName = head ? parseBranch(head.ref) : undefined
  const baseRefName = base ? parseBranch(base.ref) : undefined
  const headRefOid = head ? parseOid(head.sha) : undefined
  const baseRefOid = base ? parseOid(base.sha) : undefined
  const url = nonEmptyString(raw.html_url) ?? nonEmptyString(raw.url)
  if (!head || !base || !headRefName || !baseRefName || !headRefOid || !baseRefOid || !url) return undefined
  const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : ''
  const mergeStateStatus = typeof raw.mergeStateStatus === 'string'
    ? raw.mergeStateStatus
    : typeof raw.mergeable_state === 'string' ? raw.mergeable_state.toUpperCase() : undefined
  return {
    ...raw,
    url,
    state: raw.merged === true || typeof raw.merged_at === 'string' ? 'MERGED' : state,
    isDraft: raw.draft === true,
    headRefName,
    headRefOid,
    baseRefName,
    baseRefOid,
    ...(head.repo !== undefined ? { headRepository: head.repo } : {}),
    ...(isRecord(head.repo) && isRecord(head.repo.owner) ? { headRepositoryOwner: head.repo.owner } : {}),
    ...(mergeStateStatus !== undefined ? { mergeStateStatus } : {})
  }
}

function isValidRestPullDetail(value: unknown, repository: IdentityValue, number: number): value is Record<string, unknown> {
  if (!isRecord(value) || parsePositiveInteger(value.number) !== number) return false
  const head = isRecord(value.head) ? value.head : undefined
  const base = isRecord(value.base) ? value.base : undefined
  const url = nonEmptyString(value.html_url)
  const state = typeof value.state === 'string' ? value.state.toUpperCase() : ''
  if (!head || !base || typeof value.title !== 'string' || !['OPEN', 'CLOSED'].includes(state) || !url ||
    !parseBranch(head.ref) || !parseBranch(base.ref) || !parseOid(head.sha) || !parseOid(base.sha)) return false
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return false
  }
  const expectedPath = `/${repository.owner}/${repository.repo}/pull/${number}`
  return (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') &&
    parsedUrl.host.toLowerCase() === repository.host.toLowerCase() &&
    parsedUrl.pathname.toLowerCase() === expectedPath.toLowerCase()
}


async function rawByNumber(env: HostingEnv, scope: Scope, repository: IdentityValue, number: number): Promise<Record<string, unknown> | null> {
  let viewError: unknown
  try {
    const value = await env.json(scope, ['pr', 'view', String(number), '--repo', repoArg(repository), '--json', LOOKUP_FIELDS], { idempotent: true })
    if (isRecord(value) && parsePositiveInteger(value.number) === number) return value
    viewError = env.invalid('upstream_unavailable', 'GitHub returned an invalid pull request response.')
  } catch (error) {
    if (isMissing(error)) return null
    viewError = error
  }
  try {
    const value = await env.rest(scope, `repos/${repository.owner}/${repository.repo}/pulls/${number}`, 'GET', undefined, { idempotent: true })
    if (isRecord(value) && parsePositiveInteger(value.number) === number) {
      const normalized = normalizeRestPull(value)
      if (normalized) return normalized
    }
  } catch (error) {
    if (isMissing(error)) return null
    if (viewError === undefined) viewError = error
  }
  if (viewError !== undefined) throw viewError
  throw env.invalid('upstream_unavailable', 'GitHub returned an invalid pull request response.')
}

async function enrichRead(env: HostingEnv, scope: Scope, repository: IdentityValue, raw: Record<string, unknown>, fresh = false): Promise<PRRead> {
  const number = parsePositiveInteger(raw.number)
  const headRefName = parseBranch(raw.headRefName)
  if (!number || !headRefName) throw env.invalid('upstream_unavailable', 'GitHub returned incomplete pull request details.')
  let stack: unknown
  let stackKnown = false
  try {
    const detail = await env.rest(scope, `repos/${repository.owner}/${repository.repo}/pulls/${number}`, 'GET', undefined, { idempotent: true })
    if (isValidRestPullDetail(detail, repository, number)) {
      if (!Object.hasOwn(detail, 'stack') || detail.stack === null) {
        stack = null
        stackKnown = true
      } else {
        stack = detail.stack
        stackKnown = isPRStackSummary(detail.stack)
      }
    }
  } catch {
    // A normal review lookup remains available when optional stack metadata cannot be read.
  }
  const metadata = await readMetadata(env, scope, repository, nonEmptyString(raw.baseRefName) ?? '', fresh)
  const review = reviewFromRaw({ ...raw, stack }, repository, metadata, stack)
  if (!review) throw env.invalid('upstream_unavailable', 'GitHub returned incomplete pull request details.')
  return { scope, repository, raw, review, metadata, stackKnown }
}
async function warmRateLimit(env: HostingEnv, scope: Scope, repository: IdentityValue): Promise<void> {
  if (repository.host.toLowerCase() !== 'github.com') return
  await env.rateLimit({ ...scope, repository }).catch(() => undefined)
}

async function readCandidate(env: HostingEnv, scope: Scope, repository: IdentityValue, number: number, fresh = false): Promise<PRRead | null> {
  const selectedScope: Scope = { ...scope, repository }
  await warmRateLimit(env, selectedScope, repository)
  const raw = await rawByNumber(env, selectedScope, repository, number)
  return raw ? enrichRead(env, selectedScope, repository, raw, fresh) : null
}

function restHeadMatchesOrigin(scope: Scope, raw: Record<string, unknown>, branch: string): boolean {
  const head = isRecord(raw.head) ? raw.head : undefined
  const repository = head && isRecord(head.repo) ? head.repo : undefined
  if (!head || !repository) return false
  const owner = nestedLogin(repository.owner)
  const name = nonEmptyString(repository.name)
  return parseBranch(head.ref) === branch &&
    owner?.toLowerCase() === scope.origin.owner.toLowerCase() &&
    name?.toLowerCase() === scope.origin.repo.toLowerCase()
}

async function branchCandidates(env: HostingEnv, scope: Scope, repository: IdentityValue, branch: string): Promise<PRRead[]> {
  const selectedScope: Scope = { ...scope, repository }
  await warmRateLimit(env, selectedScope, repository)
  const head = encodeURIComponent(`${scope.origin.owner}:${branch}`)
  const value = await env.rest(selectedScope,
    `repos/${repository.owner}/${repository.repo}/pulls?head=${head}&state=all&per_page=100`,
    'GET', undefined, { idempotent: true })
  if (!Array.isArray(value)) throw env.invalid('upstream_unavailable', 'GitHub returned an invalid pull request list.')
  const results: PRRead[] = []
  for (const raw of value) {
    if (!isRecord(raw) || !restHeadMatchesOrigin(scope, raw, branch)) continue
    const number = parsePositiveInteger(raw.number)
    if (!number) continue
    const hydrated = await readCandidate(env, scope, repository, number)
    if (hydrated) results.push(hydrated)
  }
  return results
}

function nestedLogin(value: unknown): string | undefined {
  return isRecord(value) ? nonEmptyString(value.login) : undefined
}

function nestedStringValue(value: unknown, field: string): string | undefined {
  return isRecord(value) ? nonEmptyString(value[field]) : undefined
}
function headMatchesOrigin(scope: Scope, read: PRRead): boolean {
  const headOwner = nestedLogin(read.raw.headRepositoryOwner)
  const headName = nestedStringValue(read.raw.headRepository, 'name')
  return headOwner !== undefined && headName !== undefined &&
    headOwner.toLowerCase() === scope.origin.owner.toLowerCase() &&
    headName.toLowerCase() === scope.origin.repo.toLowerCase()
}

function parseRefPair(value: string): { remote: string; branch: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { remote: value.slice(0, slash), branch: value.slice(slash + 1) }
}

async function trackedBranch(env: HostingEnv, scope: Scope, branch: string): Promise<string | undefined> {
  try {
    const value = await env.git(scope, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)', `refs/heads/${branch}`])
    const row = value.split(/\r?\n/u).find((line) => line.startsWith(`${branch}\0`))
    if (!row) return undefined
    const upstream = row.slice(row.indexOf('\0') + 1).trim()
    return parseRefPair(upstream)?.branch
  } catch {
    return undefined
  }
}

async function currentHead(env: HostingEnv, scope: Scope, supplied: unknown): Promise<string | undefined> {
  const provided = typeof supplied === 'string' ? supplied : undefined
  if (provided) return provided
  try {
    return nonEmptyString(await env.git(scope, ['rev-parse', 'HEAD']))
  } catch {
    return undefined
  }
}

async function isAncestor(env: HostingEnv, scope: Scope, oid: string): Promise<boolean> {
  try {
    await env.git(scope, ['merge-base', '--is-ancestor', oid, 'HEAD'])
    return true
  } catch {
    return false
  }
}
async function containsReviewCommit(env: HostingEnv, read: PRRead, localHead: string | undefined): Promise<boolean> {
  const oid = parseOid(localHead)
  if (!oid) return false
  const key = env.cacheKey(read.scope, `pr-merged-membership:${identityLabel(read.repository)}:${read.review.number}:${oid}`)
  try {
    return await env.cache(key, 6 * 60 * 60_000, async () => {
      for (let page = 1; page <= 5; page += 1) {
        const value = await env.rest(read.scope,
          `repos/${read.repository.owner}/${read.repository.repo}/commits/${oid}/pulls?per_page=100&page=${page}`,
          'GET',
          undefined,
          { idempotent: true })
        if (!Array.isArray(value)) return false
        if (value.some((item) => isRecord(item) && parsePositiveInteger(item.number) === read.review.number)) return true
        if (value.length < 100) return false
      }
      return false
    })
  } catch {
    return false
  }
}

async function defaultBranchFor(env: HostingEnv, scope: Scope, repository: IdentityValue, metadata?: PRMergeMetadata): Promise<string | undefined> {
  if (metadata?.defaultBranch) return metadata.defaultBranch
  try {
    const value = await env.json({ ...scope, repository }, ['repo', 'view', '--repo', repoArg(repository), '--json', 'defaultBranchRef'], { idempotent: true })
    if (isRecord(value) && isRecord(value.defaultBranchRef)) return nonEmptyString(value.defaultBranchRef.name)
  } catch {
    return undefined
  }
  return undefined
}

async function hideImplicit(env: HostingEnv, scope: Scope, read: PRRead, branch: string, headOid: unknown): Promise<boolean> {
  const localHead = await currentHead(env, scope, headOid)
  const localMetadata = sameIdentity(read.repository, scope.origin) ? read.metadata : undefined
  const defaultBranch = await defaultBranchFor(env, scope, scope.origin, localMetadata)
  if (read.review.state !== 'open' && read.review.state !== 'draft' && defaultBranch === branch) return true
  const headOwner = nestedLogin(read.raw.headRepositoryOwner)
  const headName = nestedStringValue(read.raw.headRepository, 'name')
  const headIdentity = headOwner && headName ? { host: scope.origin.host, owner: headOwner, repo: headName } : undefined
  const trustedHead = headIdentity && identityCandidates(scope).some((identity) => sameIdentity(identity, headIdentity))
    ? headIdentity
    : undefined
  const headMetadata = trustedHead && sameIdentity(trustedHead, read.repository) ? read.metadata : undefined
  const headDefaultBranch = trustedHead ? await defaultBranchFor(env, scope, trustedHead, headMetadata) : defaultBranch
  if (headDefaultBranch && read.review.headRefName === headDefaultBranch) return true
  if (read.review.state === 'merged' && localHead !== read.review.headRefOid &&
    !(await isAncestor(env, scope, read.review.headRefOid)) && !(await containsReviewCommit(env, read, localHead))) return true
  return false
}

function cacheTtl(result: Lookup, active: boolean): number {
  if (result.kind === 'no-review') return active ? ACTIVE_TTL : ABSENT_TTL
  if (result.kind === 'unavailable') return 5_000
  if (result.review.state === 'merged') return result.review.checksStatus === 'pending' ? ACTIVE_TTL : MERGED_TTL
  if (result.review.state === 'closed') return ABSENT_TTL
  return active ? ACTIVE_TTL : FOUND_TTL
}

export function createPRLookup(env: HostingEnv): PRLookup {
  const resultCache = new Map<string, CachedLookup>()
  let cacheGeneration = 0

  const invalidate = (scope: Scope, data?: Record<string, unknown>) => {
    cacheGeneration += 1
    resultCache.clear()
    env.changed(scope, data)
  }
  const resolveExact = async (scope: Scope, repositories: IdentityValue[], number: number, fresh = false): Promise<PRRead | null> => {
    let firstError: unknown
    for (const repository of repositories) {
      try {
        const found = await readCandidate(env, scope, repository, number, fresh)
        if (found) return found
      } catch (error) {
        if (!isMissing(error) && firstError === undefined) firstError = error
      }
    }
    if (firstError !== undefined) throw firstError
    return null
  }

  const lookupFresh = async (params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<Lookup> => {
    const fetchedAt = Date.now()
    const scope = await env.resolve(params, caller)
    const branch = params.branch === '' || params.branch === undefined ? undefined : parseBranch(params.branch)
    if (params.branch !== undefined && params.branch !== '' && !branch) inputError(env, 'branch must be a valid branch name.')
    const linked = params.number === undefined ? undefined : parsePositiveInteger(params.number)
    if (params.number !== undefined && !linked) inputError(env, 'number must be a positive integer.')
    const fallback = params.fallbackPRNumber === undefined ? undefined : parsePositiveInteger(params.fallbackPRNumber)
    if (params.fallbackPRNumber !== undefined && !fallback) inputError(env, 'fallbackPRNumber must be a positive integer.')
    const headOid = params.headOid
    const repositories = selectRepositories(env, scope, params.prRepo)
    if (repositories.length === 0) return { kind: 'unavailable', reason: 'repo_unavailable', message: 'No configured GitHub repository is available for this worktree.', fetchedAt }
    if (linked) {
      try {
        const read = await resolveExact(scope, repositories, linked)
        return read && (!branch || headMatchesOrigin(scope, read))
          ? { kind: 'found', review: read.review, fetchedAt }
          : { kind: 'no-review', fetchedAt }
      } catch (error) {
        const safe = errorFields(error)
        return { kind: 'unavailable', reason: safe.reason ?? 'upstream_unavailable', message: safe.message, fetchedAt,
          ...(safe.retryDisabledUntil !== undefined ? { retryDisabledUntil: safe.retryDisabledUntil } : {}),
          ...(safe.nextAutoRetryAt !== undefined ? { nextAutoRetryAt: safe.nextAutoRetryAt } : {}) }
      }
    }
    if (!branch) return { kind: 'no-review', fetchedAt }
    let firstError: unknown
    for (const repository of repositories) {
      try {
        const found = await branchCandidates(env, scope, repository, branch)
        for (const read of found) {
          if (!(await hideImplicit(env, scope, read, branch, headOid))) return { kind: 'found', review: read.review, fetchedAt }
        }
      } catch (error) {
        if (firstError === undefined) firstError = error
      }
    }
    if (firstError !== undefined) {
      const safe = errorFields(firstError)
      return { kind: 'unavailable', reason: safe.reason ?? 'upstream_unavailable', message: safe.message, fetchedAt,
        ...(safe.retryDisabledUntil !== undefined ? { retryDisabledUntil: safe.retryDisabledUntil } : {}),
        ...(safe.nextAutoRetryAt !== undefined ? { nextAutoRetryAt: safe.nextAutoRetryAt } : {}) }
    }
    const tracked = await trackedBranch(env, scope, branch)
    if (tracked && tracked !== branch) {
      for (const repository of repositories) {
        try {
          const found = await branchCandidates(env, scope, repository, tracked)
          for (const read of found) {
            if (!(await hideImplicit(env, scope, read, branch, headOid))) return { kind: 'found', review: read.review, fetchedAt }
          }
        } catch (error) {
          const safe = errorFields(error)
          return { kind: 'unavailable', reason: safe.reason ?? 'upstream_unavailable', message: safe.message, fetchedAt,
            ...(safe.retryDisabledUntil !== undefined ? { retryDisabledUntil: safe.retryDisabledUntil } : {}),
            ...(safe.nextAutoRetryAt !== undefined ? { nextAutoRetryAt: safe.nextAutoRetryAt } : {}) }
        }
      }
    }
    if (fallback) {
      try {
        const read = await resolveExact(scope, repositories, fallback)
        if (read && headMatchesOrigin(scope, read) && !(await hideImplicit(env, scope, read, branch, headOid))) {
          return { kind: 'found', review: read.review, fetchedAt }
        }
      } catch (error) {
        const safe = errorFields(error)
        return { kind: 'unavailable', reason: safe.reason ?? 'upstream_unavailable', message: safe.message, fetchedAt,
          ...(safe.retryDisabledUntil !== undefined ? { retryDisabledUntil: safe.retryDisabledUntil } : {}),
          ...(safe.nextAutoRetryAt !== undefined ? { nextAutoRetryAt: safe.nextAutoRetryAt } : {}) }
      }
    }
    return { kind: 'no-review', fetchedAt }
  }

  const forBranch = async (
    params: Record<string, unknown>,
    caller: Parameters<Handler>[1],
    options?: { noCache?: boolean }
  ): Promise<Lookup> => {
    const scope = await env.resolve(params, caller)
    const branch = params.branch === '' || params.branch === undefined ? undefined : parseBranch(params.branch)
    if (params.branch !== undefined && params.branch !== '' && !branch) inputError(env, 'branch must be a valid branch name.')
    const number = params.number === undefined ? undefined : parsePositiveInteger(params.number)
    if (params.number !== undefined && !number) inputError(env, 'number must be a positive integer.')
    const fallback = params.fallbackPRNumber === undefined ? undefined : parsePositiveInteger(params.fallbackPRNumber)
    if (params.fallbackPRNumber !== undefined && !fallback) inputError(env, 'fallbackPRNumber must be a positive integer.')
    const headOid = params.headOid === undefined ? scope.worktree.head : parseOid(params.headOid)
    if (params.headOid !== undefined && !headOid) inputError(env, 'headOid must be a 40- or 64-character hexadecimal commit SHA.')
    const normalizedParams = { ...params, branch: branch ?? '', ...(headOid ? { headOid } : {}) }
    const supplied = params.prRepo === undefined ? '' : JSON.stringify(params.prRepo)
    const rawKey = `pr-lookup:${scope.worktree.repoId}:${scope.origin.host}/${scope.origin.owner}/${scope.origin.repo}:${branch ?? ''}:${number ?? ''}:${fallback ?? ''}:${headOid ?? ''}:${supplied}`
    const key = env.cacheKey(scope, rawKey)
    const active = params.active === true
    if (options?.noCache === true) return lookupFresh(normalizedParams, caller)
    const cached = resultCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    if (cached) resultCache.delete(key)
    const generation = cacheGeneration
    const value = await env.cache(key, 60_000, () => lookupFresh(normalizedParams, caller))
    if (generation === cacheGeneration) {
      resultCache.set(key, { expiresAt: Date.now() + cacheTtl(value, active), value })
      if (resultCache.size > CACHE_CAPACITY) resultCache.delete(resultCache.keys().next().value!)
    }
    return value
  }

  const review = async (params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<Lookup> => {
    const number = parsePositiveInteger(params.number)
    if (!number) inputError(env, 'number must be a positive integer.')
    return lookupFresh({ ...params, number }, caller)
  }

  const readFresh = async (params: Record<string, unknown>, caller: Parameters<Handler>[1]): Promise<PRRead | null> => {
    const number = parsePositiveInteger(params.number)
    if (!number) inputError(env, 'number must be a positive integer.')
    const scope = await env.resolve(params, caller)
    const repositories = selectRepositories(env, scope, params.prRepo)
    return resolveExact(scope, repositories, number, true)
  }

  return { forBranch, review, readFresh, invalidate }
}
