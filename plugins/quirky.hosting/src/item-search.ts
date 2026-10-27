import type { Handler, HostingEnv, Identity, Scope } from './env'
import {
  array,
  buildSearchQuery,
  ensureOutputBound,
  graphqlSearch,
  identityKey,
  isRecord,
  mapWorkItem,
  pageInput,
  positiveCount,
  pullRequestRepositories,
  record,
  safeErrorReason,
  utf8Length,
  sameIdentity,
  scopeForRepository,
  validateSearchRepo,
  type WorkItemKind,
  type WorkItemRecord
} from './item-data'

type ItemCaller = Parameters<Handler>[1]

const SEARCH_QUERY = `query WorkItemSearch($search: String!, $first: Int!, $after: String) {
  search(type: ISSUE, query: $search, first: $first, after: $after) {
    issueCount
    pageInfo { endCursor hasNextPage }
    nodes {
      __typename
      ... on Issue {
        number title body issueState: state url createdAt updatedAt
        author { login }
        labels(first: 20) { nodes { name } }
        assignees(first: 20) { nodes { login } }
      }
      ... on PullRequest {
        number title body pullRequestState: state url createdAt updatedAt isDraft
        headRefName baseRefName headRefOid baseRefOid reviewDecision mergeStateStatus
        author { login }
        labels(first: 20) { nodes { name } }
        assignees(first: 20) { nodes { login } }
      }
    }
  }
  rateLimit { cost }
}`

const PR_FIELDS = 'number,title,body,state,url,createdAt,updatedAt,author,isDraft,labels,assignees,headRefName,baseRefName,headRefOid,baseRefOid,reviewDecision,mergeStateStatus'

export type ItemSourcePage = {
  items: WorkItemRecord[]
  totalCount: number | null
  hasNextPage: boolean
  repository: Identity
  failure?: { reason: string; message: string }
}

function sourceName(scope: Scope, identity: Identity): string {
  if (sameIdentity(identity, scope.origin)) return 'origin'
  if (scope.candidates.some((candidate) => sameIdentity(identity, candidate))) return 'upstream'
  return 'configured'
}

function searchFailure(error: unknown): { reason: string; message: string } {
  const rawReason = safeErrorReason(error)
  const reason = ['rate_limited', 'not_found', 'permission_denied', 'network_error', 'validation_error', 'auth_required', 'repo_unavailable'].includes(rawReason)
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
    unknown: 'GitHub work-item search failed.'
  }
  return { reason, message: messages[reason] ?? 'GitHub work-item search failed.' }
}

function countFromGraphql(value: unknown): number | null {
  const search = graphqlSearch(value)
  return search?.issueCount ?? null
}

async function graphqlPage(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  search: string,
  after: string | null
): Promise<{ items: WorkItemRecord[]; totalCount: number | null; endCursor: string | null; hasNextPage: boolean }> {
  const result = await env.graphql(scopeForRepository(scope, identity), SEARCH_QUERY, {
    search,
    first: 100,
    after
  }, { idempotent: true })
  const page = graphqlSearch(result)
  if (!page) throw env.invalid('unknown', 'GitHub returned an invalid work-item search response.')
  const items: WorkItemRecord[] = []
  for (const node of page.nodes) {
    const item = mapWorkItem(node, { identity })
    if (item === null) throw env.invalid('unknown', 'GitHub returned an invalid work-item search item.')
    items.push(item)
  }
  return { items, totalCount: page.issueCount, endCursor: page.endCursor, hasNextPage: page.hasNextPage }
}

async function fetchGraphqlSearch(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  query: string,
  kind: WorkItemKind,
  needed: number
): Promise<ItemSourcePage> {
  const search = buildSearchQuery(query, identity, kind)
  const blockCount = Math.max(1, Math.ceil(needed / 100))
  let cursor: string | null = null
  let totalCount: number | null = null
  let hasNextPage = false
  const items: WorkItemRecord[] = []
  for (let block = 0; block < blockCount; block += 1) {
    const result = await graphqlPage(env, scope, identity, search, cursor)
    items.push(...result.items)
    if (totalCount === null) totalCount = result.totalCount
    cursor = result.endCursor
    hasNextPage = result.hasNextPage
    if (!result.hasNextPage || cursor === null) break
  }
  return { items: items.slice(0, needed), totalCount, hasNextPage, repository: identity }
}

function restSearchResult(env: HostingEnv, value: unknown, identity: Identity): { items: WorkItemRecord[]; totalCount: number | null; hasNextPage: boolean } {
  const root = record(value)
  let rawItems: unknown[]
  if (Array.isArray(value)) rawItems = array(value)
  else if (Array.isArray(root?.items)) rawItems = array(root?.items)
  else throw env.invalid('unknown', 'GitHub returned an invalid work-item search response.')
  const items: WorkItemRecord[] = []
  for (const raw of rawItems) {
    const item = mapWorkItem(raw, { identity })
    if (item === null) throw env.invalid('unknown', 'GitHub returned an invalid work-item search item.')
    if (item.kind === 'issue') items.push(item)
  }
  const declaredCount = root?.total_count ?? root?.totalCount
  const totalCount = declaredCount === undefined
    ? rawItems.length >= 100 ? null : items.length
    : positiveCount(declaredCount)
  if (declaredCount !== undefined && totalCount === null) throw env.invalid('unknown', 'GitHub returned an invalid work-item search count.')
  return { items, totalCount, hasNextPage: totalCount === null ? rawItems.length === 100 : totalCount > items.length }
}

async function fetchRestIssuePage(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  query: string,
  needed: number
): Promise<ItemSourcePage> {
  const safeQuery = buildSearchQuery(query, identity, 'issue')
  const output: WorkItemRecord[] = []
  let totalCount: number | null = null
  let hasNextPage = false
  const pages = Math.max(1, Math.ceil(needed / 100))
  for (let page = 1; page <= pages; page += 1) {
    const path = `search/issues?q=${encodeURIComponent(safeQuery)}&sort=created&order=desc&per_page=100&page=${page}`
    const response = await env.rest(scopeForRepository(scope, identity), path, 'GET', undefined, { idempotent: true })
    const result = restSearchResult(env, response, identity)
    output.push(...result.items)
    totalCount = result.totalCount
    hasNextPage = result.hasNextPage
    if (result.items.length < 100) break
  }
  return { items: output.slice(0, needed), totalCount, hasNextPage, repository: identity }
}

async function fetchRecentIssues(
  env: HostingEnv,
  scope: Scope,
  identity: Identity,
  needed: number
): Promise<ItemSourcePage> {
  const output: WorkItemRecord[] = []
  const pages = Math.max(1, Math.ceil(needed / 100))
  let hasNextPage = false
  for (let page = 1; page <= pages; page += 1) {
    const path = `repos/${identity.owner}/${identity.repo}/issues?per_page=100&state=all&sort=updated&direction=desc&page=${page}`
    const response = await env.rest(scopeForRepository(scope, identity), path, 'GET', undefined, { idempotent: true })
    if (!Array.isArray(response)) throw env.invalid('unknown', 'GitHub returned an invalid recent issue list.')
    const values = array(response)
    const items: WorkItemRecord[] = []
    for (const raw of values) {
      const entry = record(raw)
      const item = mapWorkItem(raw, { identity, kind: 'issue' })
      if (!entry || item === null) throw env.invalid('unknown', 'GitHub returned an invalid recent issue item.')
      if (item.kind === 'issue') items.push(item)
    }
    output.push(...items)
    hasNextPage = values.length === 100
    if (values.length < 100) break
  }
  const result = output.slice(0, needed)
  return { items: result, totalCount: result.length < needed ? result.length : null, hasNextPage, repository: identity }
}

async function fetchIssueSource(
  env: HostingEnv,
  scope: Scope,
  query: string,
  needed: number,
  noCache: boolean
): Promise<ItemSourcePage> {
  const identity = scope.issueRepository
  const key = env.cacheKey(scope, `work-items:issues:${identityKey(identity)}:${query}:${needed}`)
  const page = await (noCache
    ? loadIssuePage(env, scope, identity, query, needed)
    : env.cache(key, 120_000, () => loadIssuePage(env, scope, identity, query, needed)))
  return { ...page, repository: identity }
}

async function loadIssuePage(env: HostingEnv, scope: Scope, identity: Identity, query: string, needed: number): Promise<ItemSourcePage> {
  if (query.length > 0) {
    if (identity.host === 'github.com') {
      try {
        return await fetchGraphqlSearch(env, scope, identity, query, 'issue', needed)
      } catch {
        return fetchRestIssuePage(env, scope, identity, query, needed)
      }
    }
    return fetchRestIssuePage(env, scope, identity, query, needed)
  }
  return fetchRecentIssues(env, scope, identity, needed)
}


async function fetchPRSource(
  env: HostingEnv,
  scope: Scope,
  query: string,
  needed: number,
  noCache: boolean
): Promise<ItemSourcePage> {
  const repositories = pullRequestRepositories(scope)
  const failures: unknown[] = []
  for (const identity of repositories) {
    try {
      const key = env.cacheKey(scope, `work-items:prs:${identityKey(identity)}:${query}:${needed}`)
      const page = await (noCache
        ? loadPRPage(env, scope, identity, query, needed)
        : env.cache(key, 120_000, () => loadPRPage(env, scope, identity, query, needed)))
      return { ...page, repository: identity }
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  throw failures[failures.length - 1] ?? env.invalid('unknown', 'GitHub pull request search failed.')
}

async function loadPRPage(env: HostingEnv, scope: Scope, identity: Identity, query: string, needed: number): Promise<ItemSourcePage> {
  const limit = Math.max(1, Math.min(1000, needed))
  const args = ['pr', 'list', '--limit', String(limit), '--state', 'all', '--json', PR_FIELDS, '--repo', `${identity.owner}/${identity.repo}`]
  const searchQuery = query.length > 0 ? buildSearchQuery(query, identity, 'pullRequest') : ''
  if (searchQuery.length > 0) args.push('--search', searchQuery)
  const requestScope = scopeForRepository(scope, identity)
  const [response, searchCount] = await Promise.all([
    env.json(requestScope, args, { idempotent: true }),
    countForRepository(env, scope, identity, query, 'pullRequest').catch(() => null)
  ])
  if (!Array.isArray(response)) throw env.invalid('unknown', 'GitHub returned an invalid pull request list.')
  const rawItems = array(response)
  const items: WorkItemRecord[] = []
  for (const raw of rawItems) {
    const item = mapWorkItem(raw, { identity, kind: 'pullRequest' })
    if (item === null) throw env.invalid('unknown', 'GitHub returned an invalid pull request list item.')
    items.push(item)
  }
  const totalCount = searchCount ?? (items.length < limit ? items.length : null)
  return { items: items.slice(0, needed), totalCount, hasNextPage: totalCount !== null ? totalCount > needed : items.length >= needed, repository: identity }
}

function compareItems(left: WorkItemRecord, right: WorkItemRecord): number {
  const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? '')
  const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? '')
  const safeLeft = Number.isNaN(leftTime) ? 0 : leftTime
  const safeRight = Number.isNaN(rightTime) ? 0 : rightTime
  if (safeLeft !== safeRight) return safeRight - safeLeft
  if (left.number !== right.number) return right.number - left.number
  return left.kind.localeCompare(right.kind)
}

function listResultSource(scope: Scope, value: ItemSourcePage | null): string | null {
  return value === null ? null : sourceName(scope, value.repository)
}

export async function listWorkItems(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<Record<string, unknown>> {
  const page = pageInput(env, params)
  const scope = await env.resolve(params, caller)
  const query = validateSearchRepo(env, page.query, [scope.origin, scope.issueRepository, ...scope.candidates])
  const required = page.offset + page.limit
  const [issueResult, prResult] = await Promise.allSettled([
    fetchIssueSource(env, scope, query, required, page.noCache),
    fetchPRSource(env, scope, query, required, page.noCache)
  ])
  const issues = issueResult.status === 'fulfilled' ? issueResult.value : null
  const prs = prResult.status === 'fulfilled' ? prResult.value : null
  const errors: Record<string, unknown> = {}
  if (issueResult.status === 'rejected') errors.issues = searchFailure(issueResult.reason)
  if (prResult.status === 'rejected') errors.prs = searchFailure(prResult.reason)

  if (prs === null && query.length === 0 && issueResult.status === 'fulfilled') {
    const failure = searchFailure(prResult.status === 'rejected' ? prResult.reason : undefined)
    throw env.invalid(failure.reason, failure.message)
  }
  if (issues === null && prs === null) {
    const issueError = issueResult.status === 'rejected' ? issueResult.reason : undefined
    const prError = prResult.status === 'rejected' ? prResult.reason : undefined
    const issueFailure = searchFailure(issueError)
    const prFailure = searchFailure(prError)
    if (issueFailure.reason === prFailure.reason) throw env.invalid(issueFailure.reason, issueFailure.message)
  }

  const allItems = [...(issues?.items ?? []), ...(prs?.items ?? [])].sort(compareItems)
  const selected = allItems.slice(page.offset, page.offset + page.limit)
  const totalCount = issues?.totalCount !== null && issues?.totalCount !== undefined && prs?.totalCount !== null && prs?.totalCount !== undefined
    ? issues.totalCount + prs.totalCount
    : null
  const hasNextPage = totalCount !== null
    ? page.offset + selected.length < totalCount
    : (issues?.hasNextPage === true || prs?.hasNextPage === true || allItems.length > page.offset + page.limit)
  const fellBack = scope.issueSourceFellBack
  const result: Record<string, unknown> = {
    items: selected,
    page: page.page,
    limit: page.limit,
    totalCount,
    hasNextPage,
    truncated: totalCount !== null && totalCount > 1000,
    sources: {
      issues: listResultSource(scope, issues),
      prs: listResultSource(scope, prs),
      originCandidate: sourceName(scope, scope.origin),
      upstreamCandidate: pullRequestRepositories(scope).find((candidate) => !sameIdentity(candidate, scope.origin)) ?? null
    },
    issueSourceFellBack: fellBack,
    partial: Object.keys(errors).length > 0,
    ...(Object.keys(errors).length > 0 ? { errors } : {})
  }
  ensureOutputBound(env, result, 'Work-item search')
  return result
}

async function assertSearchBudget(env: HostingEnv, scope: Scope, identity: Identity): Promise<void> {
  if (identity.host.toLowerCase() !== 'github.com') return
  const snapshot = await env.rateLimit(scope).catch(() => null)
  if (snapshot === null) return
  const search = snapshot.search
  if (search.limit > 0 && search.resetAt > Date.now() && search.remaining < 2) {
    throw env.invalid('rate_limited', 'GitHub search rate limit is below the safe request floor.')
  }
}

async function countForRepository(env: HostingEnv, scope: Scope, identity: Identity, query: string, kind: WorkItemKind): Promise<number> {
  const search = buildSearchQuery(query, identity, kind)
  const requestScope = scopeForRepository(scope, identity)
  await assertSearchBudget(env, requestScope, identity)
  if (identity.host.toLowerCase() === 'github.com') {
    try {
      const raw = await env.graphql(requestScope, SEARCH_QUERY, { search, first: 1, after: null }, { idempotent: true })
      const count = countFromGraphql(raw)
      if (count !== null) return count
    } catch {
      // Search REST is the same-repository fallback for unavailable GitHub.com GraphQL.
    }
  }
  const path = `search/issues?q=${encodeURIComponent(search)}&per_page=1`
  const raw = await env.rest(requestScope, path, 'GET', undefined, { idempotent: true })
  const root = record(raw)
  const count = positiveCount(root?.total_count) ?? positiveCount(root?.totalCount)
  if (count === null) throw env.invalid('unknown', 'GitHub returned an invalid work-item count.')
  return count
}

async function countSource(
  env: HostingEnv,
  scope: Scope,
  query: string,
  kind: WorkItemKind
): Promise<{ count: number; identity: Identity }> {
  const identities = kind === 'issue' ? [scope.issueRepository] : pullRequestRepositories(scope)
  let lastError: unknown
  for (const identity of identities) {
    try {
      return { count: await countForRepository(env, scope, identity, query, kind), identity }
    } catch (error: unknown) {
      lastError = error
    }
  }
  throw lastError ?? env.invalid('unknown', 'GitHub work-item count failed.')
}

export async function countWorkItems(env: HostingEnv, params: Record<string, unknown>, caller: ItemCaller): Promise<Record<string, unknown>> {
  const query = typeof params.query === 'string' ? params.query : ''
  if (typeof params.query !== 'undefined' && typeof params.query !== 'string') throw env.invalid('validation_error', 'query must be a string.')
  if (utf8Length(query) > 8192) throw env.invalid('validation_error', 'query exceeds the 8192-byte limit.')
  const scope = await env.resolve(params, caller)
  const safeQuery = validateSearchRepo(env, query, [scope.origin, scope.issueRepository, ...scope.candidates])
  const [issues, prs] = await Promise.allSettled([
    countSource(env, scope, safeQuery, 'issue'),
    countSource(env, scope, safeQuery, 'pullRequest')
  ])
  const partialFailures: Record<string, unknown>[] = []
  const issueCount = issues.status === 'fulfilled' ? issues.value.count : 0
  const prCount = prs.status === 'fulfilled' ? prs.value.count : 0
  if (issues.status === 'rejected') partialFailures.push({ source: 'issues', ...searchFailure(issues.reason) })
  if (prs.status === 'rejected') partialFailures.push({ source: 'prs', ...searchFailure(prs.reason) })
  return {
    count: issueCount + prCount,
    partial: partialFailures.length > 0,
    partialFailures,
    issueSourceFellBack: scope.issueSourceFellBack
  }
}

export function itemSearchMethods(env: HostingEnv): Record<string, Handler> {
  return {
    listWorkItems: (params, caller) => listWorkItems(env, params, caller),
    countWorkItems: (params, caller) => countWorkItems(env, params, caller)
  }
}
