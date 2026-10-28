import type { Handler, HostingEnv, Identity, Scope } from './env'
import {
  buildSearchQuery,
  ensureOutputBound,
  identityKey,
  mapWorkItem,
  positiveCount,
  pullRequestRepositories,
  record,
  safeErrorReason,
  sameIdentity,
  scopeForRepository,
  validateSearchRepo,
  utf8Length,
  type WorkItemKind,
  type WorkItemRecord
} from './item-data'

type PageInput = { page: number; limit: number; offset: number; query: string; noCache: boolean }
type PageResult = {
  items: WorkItemRecord[]
  totalCount: number | null
  hasNextPage: boolean
  truncated: boolean
  incompleteResults: boolean
}
type Failure = { reason: string; message: string }
type SelectedPage = { identity: Identity; page: PageResult }
type CachedPage = { selected: SelectedPage | null; errors: Record<string, Failure> }
type ItemCaller = Parameters<Handler>[1]

function sourceName(scope: Scope, identity: Identity): string {
  if (sameIdentity(identity, scope.origin)) return 'origin'
  if (scope.candidates.some((candidate) => sameIdentity(identity, candidate))) return 'upstream'
  return 'configured'
}

function pageFailure(error: unknown): Failure {
  const rawReason = safeErrorReason(error)
  const reason = ['rate_limited', 'not_found', 'permission_denied', 'network_error', 'validation_error', 'auth_required', 'repo_unavailable', 'too_large'].includes(rawReason)
    ? rawReason
    : 'unknown'
  const messages: Record<string, string> = {
    rate_limited: 'GitHub rate limit is currently exhausted.',
    not_found: 'The configured GitHub repository was not found.',
    permission_denied: 'GitHub denied access to the configured repository.',
    network_error: 'GitHub is unreachable right now.',
    validation_error: 'GitHub rejected the work-item query.',
    auth_required: 'GitHub authentication is unavailable.',
    repo_unavailable: 'The configured GitHub repository is unavailable.',
    too_large: 'GitHub returned an oversized work-item page.',
    unknown: 'GitHub work-item page request failed.'
  }
  return { reason, message: messages[reason] ?? messages.unknown! }
}

function countFromSearch(env: HostingEnv, value: unknown): number | null {
  const count = record(value)?.total_count ?? record(value)?.totalCount
  if (count === undefined || count === null) return null
  const normalized = positiveCount(count)
  if (normalized === null) throw env.invalid('unknown', 'GitHub returned an invalid work-item page count.')
  return normalized
}

async function loadPage(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  kind: WorkItemKind,
  query: string,
  input: PageInput
): Promise<PageResult> {
  const search = buildSearchQuery(query, identity, kind)
  const path = `search/issues?q=${encodeURIComponent(search)}&per_page=${input.limit}&page=${input.page}`
  const response = await env.rest(scopeForRepository(scope, identity), path, 'GET', undefined, { idempotent: true })
  const root = record(response)
  if (!root || !Array.isArray(root.items)) throw env.invalid('unknown', 'GitHub returned an invalid work-item page response.')
  if (root.items.length > 100) throw env.invalid('too_large', 'GitHub returned more work items than a single page can contain.')
  if (root.incomplete_results !== undefined && typeof root.incomplete_results !== 'boolean') {
    throw env.invalid('unknown', 'GitHub returned an invalid incomplete_results flag.')
  }
  const items: WorkItemRecord[] = []
  for (const value of root.items) {
    const raw = record(value)
    const isPullRequest = raw?.pull_request !== undefined || raw?.__typename === 'PullRequest'
    if ((kind === 'pullRequest') !== isPullRequest) throw env.invalid('unknown', 'GitHub returned a work item of the wrong kind for this page.')
    const item = mapWorkItem(value, { identity, kind })
    if (!item || item.kind !== kind) throw env.invalid('unknown', 'GitHub returned an invalid work-item page item.')
    items.push(item)
  }
  const totalCount = countFromSearch(env, root)
  const incompleteResults = root.incomplete_results === true
  const providerWindowEnd = Math.min(totalCount ?? Number.POSITIVE_INFINITY, 1000)
  const pageEnd = input.offset + items.length
  const hasNextPage = totalCount === null
    ? items.length >= input.limit && pageEnd < 1000
    : pageEnd < providerWindowEnd
  return {
    items,
    totalCount,
    hasNextPage,
    truncated: incompleteResults || (totalCount !== null && totalCount > 1000),
    incompleteResults
  }
}

function pageCacheKey(identities: Identity[], kind: WorkItemKind, query: string, input: PageInput): string {
  const sources = identities.map(identityKey).join('\u0001')
  return `work-item-page:${kind}:${sources}:${query}:${input.page}:${input.limit}`
}

async function loadChosenPage(
  env: HostingEnv,
  scope: Scope,
  identities: Identity[],
  kind: WorkItemKind,
  query: string,
  input: PageInput
): Promise<CachedPage> {
  const errors: Record<string, Failure> = {}
  for (const identity of identities) {
    try {
      return { selected: { identity, page: await loadPage(env, scope, identity, kind, query, input) }, errors }
    } catch (error: unknown) {
      errors[sourceName(scope, identity)] = pageFailure(error)
    }
  }
  return { selected: null, errors }
}

async function workItemPage(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<Record<string, unknown>> {
  const kind = params.kind
  if (kind !== 'issue' && kind !== 'pullRequest') throw env.invalid('validation_error', 'kind must be issue or pullRequest.')
  const pageValue = params.page
  const limitValue = params.limit
  if (typeof pageValue !== 'number' || !Number.isSafeInteger(pageValue) || pageValue < 1) {
    throw env.invalid('validation_error', 'page must be a positive safe integer.')
  }
  if (typeof limitValue !== 'number' || !Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    throw env.invalid('validation_error', 'limit must be between 1 and 100.')
  }
  const maxPage = Math.ceil(1000 / limitValue)
  const offset = (pageValue - 1) * limitValue
  if (pageValue > maxPage || !Number.isSafeInteger(offset) || offset >= 1000) {
    throw env.invalid('too_large', 'Only the first 1000 GitHub search results are available.')
  }
  const queryValue = params.query
  if (queryValue !== undefined && typeof queryValue !== 'string') throw env.invalid('validation_error', 'query must be a string.')
  const queryInput = typeof queryValue === 'string' ? queryValue : ''
  if (utf8Length(queryInput) > 8192) throw env.invalid('validation_error', 'query exceeds the 8192-byte limit.')
  const noCache = params.noCache === undefined ? false : params.noCache
  if (typeof noCache !== 'boolean') throw env.invalid('validation_error', 'noCache must be a boolean.')
  const input: PageInput = { page: pageValue, limit: limitValue, offset, query: queryInput, noCache }
  const scope = await env.resolve(params, caller)
  const query = validateSearchRepo(env, input.query, [scope.origin, scope.issueRepository, ...scope.candidates])
  const identities = kind === 'issue' ? [scope.issueRepository] : pullRequestRepositories(scope)
  if (input.noCache) env.invalidate(scope)
  const key = env.cacheKey(scope, pageCacheKey(identities, kind, query, input))
  const pageResult = await env.cache(key, 120_000, () => loadChosenPage(env, scope, identities, kind, query, input))
  const selected = pageResult.selected
  const page = selected?.page
  const identity = selected?.identity ?? null
  const errors = pageResult.errors
  const failedSources = Object.keys(errors).length > 0
  const result: Record<string, unknown> = {
    items: page?.items ?? [],
    page: input.page,
    limit: input.limit,
    totalCount: page?.totalCount ?? null,
    hasNextPage: page?.hasNextPage ?? false,
    truncated: page?.truncated ?? false,
    sources: {
      issues: kind === 'issue' && identity ? sourceName(scope, identity) : null,
      prs: kind === 'pullRequest' && identity ? sourceName(scope, identity) : null,
      originCandidate: sourceName(scope, scope.origin),
      upstreamCandidate: pullRequestRepositories(scope).find((candidate) => !sameIdentity(candidate, scope.origin)) ?? null
    },
    issueSourceFellBack: scope.issueSourceFellBack,
    partial: failedSources || page?.incompleteResults === true,
    ...(failedSources ? { errors } : {})
  }
  ensureOutputBound(env, result, 'Work-item page')
  return result
}

export function taskPageMethods(env: HostingEnv): Record<string, Handler> {
  return { workItemPage: (params, caller) => workItemPage(env, params, caller) }
}
