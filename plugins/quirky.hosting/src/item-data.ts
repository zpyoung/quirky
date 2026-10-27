import type { HostingEnv, Identity, Scope } from './env'

export type WorkItemKind = 'issue' | 'pullRequest'
export type WorkItemState = 'open' | 'closed' | 'merged' | 'draft' | 'unknown'
export type WorkItemRecord = {
  kind: WorkItemKind
  number: number
  title: string
  body: string
  state: WorkItemState
  url: string
  createdAt: string | null
  updatedAt: string | null
  author: string | null
  labels: string[]
  assignees: string[]
  isDraft: boolean
  headRefName?: string
  baseRefName?: string
  headRefOid?: string
  baseRefOid?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  issueType?: { id: string; name: string }
  stateReason?: 'completed' | 'not_planned' | 'unknown'
  duplicateOf?: number
  mergeStateStatus?: string
  reviewDecision?: string
  partial?: boolean
}

export type PageInput = { page: number; limit: number; offset: number; query: string; noCache: boolean }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
export function requiredList(env: HostingEnv, value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return array(value)
  throw env.invalid('unknown', `GitHub returned an invalid ${label} list.`)
}

export function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function nonEmptyString(value: unknown): string | null {
  const result = string(value)
  return result !== null && result.trim().length > 0 ? result.trim() : null
}

export function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export function positiveInteger(value: unknown): number | null {
  const result = safeInteger(value)
  return result !== null && result > 0 ? result : null
}

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function ensureOutputBound(env: HostingEnv, value: unknown, label: string): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || utf8Length(serialized) > 10 * 1024 * 1024) {
    throw env.invalid('too_large', `${label} exceeds the 10 MiB output limit.`)
  }
}

export function validation(env: HostingEnv, message: string): Error {
  return env.invalid('validation_error', message)
}

export function boundedText(
  env: HostingEnv,
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxBytes: number }
): string | undefined {
  const value = params[key]
  if (value === undefined && !options.required) return undefined
  if (typeof value !== 'string' || (options.required && value.trim().length === 0)) {
    throw validation(env, `${key} must be a ${options.required ? 'non-empty ' : ''}string.`)
  }
  if (utf8Length(value) > options.maxBytes) throw validation(env, `${key} exceeds the ${options.maxBytes}-byte limit.`)
  return value
}

export function positiveParam(env: HostingEnv, params: Record<string, unknown>, key: string, required = true): number | undefined {
  const value = params[key]
  if (value === undefined && !required) return undefined
  const result = positiveInteger(value)
  if (result === null) throw validation(env, `${key} must be a positive safe integer.`)
  return result
}

export function pageInput(env: HostingEnv, params: Record<string, unknown>, defaultLimit = 24): PageInput {
  const rawPage = params.page === undefined ? 1 : safeInteger(params.page)
  const rawLimit = params.limit === undefined ? defaultLimit : safeInteger(params.limit)
  if (rawPage === null || rawPage < 1) throw validation(env, 'page must be a positive safe integer.')
  if (rawLimit === null || rawLimit < 1 || rawLimit > 100) throw validation(env, 'limit must be between 1 and 100.')
  const offset = (rawPage - 1) * rawLimit
  if (!Number.isSafeInteger(offset) || offset + rawLimit > 1000) {
    throw env.invalid('too_large', 'Only the first 1000 search results are available.')
  }
  const query = boundedText(env, params, 'query', { maxBytes: 8192 }) ?? ''
  const noCache = params.noCache === undefined ? false : params.noCache
  if (typeof noCache !== 'boolean') throw validation(env, 'noCache must be a boolean.')
  return { page: rawPage, limit: rawLimit, offset, query, noCache }
}

export function identityKey(identity: Identity): string {
  return `${identity.host.toLowerCase()}\u0000${identity.owner.toLowerCase()}\u0000${identity.repo.toLowerCase()}`
}

export function sameIdentity(left: Identity, right: Identity): boolean {
  return identityKey(left) === identityKey(right)
}

export function scopeForRepository(scope: Scope, repository: Identity): Scope {
  return { ...scope, repository }
}

export function configuredRepositories(scope: Scope): Identity[] {
  const identities = [scope.origin, scope.repository, scope.issueRepository, ...scope.candidates]
  const seen = new Set<string>()
  return identities.filter((identity) => {
    const key = identityKey(identity)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
export function pullRequestRepositories(scope: Scope): Identity[] {
  const upstreams = [...scope.candidates, scope.repository]
    .filter((identity) => !sameIdentity(identity, scope.origin))
  const identities = [...upstreams, scope.origin]
  const seen = new Set<string>()
  return identities.filter((identity) => {
    const key = identityKey(identity)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}


export function validateSearchRepo(env: HostingEnv, query: string, allowed: readonly Identity[]): string {
  const repoFilters = [...query.matchAll(/(?:^|\s)repo:([^\s]+)/gi)].map((match) => match[1] ?? '')
  if (repoFilters.length === 0) return query
  const allowedNames = new Set(allowed.map((identity) => `${identity.owner}/${identity.repo}`.toLowerCase()))
  for (const repo of repoFilters) {
    const normalized = repo.replace(/^github\.com\//i, '').toLowerCase()
    if (!allowedNames.has(normalized)) throw validation(env, 'Search repository must match a configured remote.')
  }
  return query.replace(/(?:^|\s)repo:[^\s]+/gi, ' ').trim()
}

export function buildSearchQuery(query: string, identity: Identity, kind: 'issue' | 'pullRequest'): string {
  const typeFilter = kind === 'issue' ? 'is:issue' : 'is:pr'
  const normalized = query.trim()
  return [`repo:${identity.owner}/${identity.repo}`, typeFilter, normalized, 'sort:updated-desc'].filter(Boolean).join(' ')
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function namesFromConnection(value: unknown): string[] {
  const direct = array(value)
  if (direct.every((item) => typeof item === 'string')) return direct.filter((item): item is string => typeof item === 'string')
  const connection = record(value)
  const nodes = Array.isArray(value) ? direct : array(connection?.nodes)
  return nodes.flatMap((node) => {
    const item = record(node)
    const name = nonEmptyString(item?.name) ?? nonEmptyString(item?.login)
    return name === null ? [] : [name]
  })
}

function stateValueFromRaw(raw: Record<string, unknown>): unknown {
  if (raw.__typename === 'Issue' && raw.issueState !== undefined) return raw.issueState
  if (raw.__typename === 'PullRequest' && raw.pullRequestState !== undefined) return raw.pullRequestState
  return raw.state
}

function stateFromRaw(raw: Record<string, unknown>, isPullRequest: boolean, isDraft: boolean, stateValue: unknown = raw.state): WorkItemState {
  if (isDraft) return 'draft'
  const state = typeof stateValue === 'string' ? stateValue.toLowerCase() : ''
  if (state === 'merged' || raw.merged === true || (typeof raw.mergedAt === 'string' && raw.mergedAt.length > 0)) return 'merged'
  if (state === 'open' || state === 'opened') return 'open'
  if (state === 'closed') return 'closed'
  if (isPullRequest && state === 'draft') return 'draft'
  return 'unknown'
}

export function canonicalWorkItemState(value: unknown, isPullRequest?: boolean, isDraft?: boolean): WorkItemState {
  const raw = record(value)
  if (!raw) return 'unknown'
  const pullRequest = isPullRequest ?? (isRecord(raw.pull_request) || raw.__typename === 'PullRequest')
  const draft = isDraft ?? (
    raw.isDraft === true ||
    raw.is_draft === true ||
    (pullRequest && String(stateValueFromRaw(raw) ?? '').toLowerCase() === 'draft')
  )
  return stateFromRaw(raw, pullRequest, draft, stateValueFromRaw(raw))
}

export function mapWorkItem(value: unknown, fallback: { identity: Identity; kind?: WorkItemKind }): WorkItemRecord | null {
  const raw = record(value)
  if (!raw) return null
  const number = positiveInteger(raw.number)
  if (number === null) return null
  const pullRequest = isRecord(raw.pull_request) || raw.__typename === 'PullRequest' || fallback.kind === 'pullRequest'
  const kind: WorkItemKind = pullRequest ? 'pullRequest' : 'issue'
  const title = textOrEmpty(raw.title)
  const stateValue = stateValueFromRaw(raw)
  const isDraft = raw.isDraft === true || raw.is_draft === true || (kind === 'pullRequest' && String(stateValue ?? '').toLowerCase() === 'draft')
  const url = nonEmptyString(raw.html_url) ?? nonEmptyString(raw.url) ?? `https://${fallback.identity.host}/${fallback.identity.owner}/${fallback.identity.repo}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`
  const authorObject = record(raw.author) ?? record(raw.user) ?? record(raw.creator)
  const author = nonEmptyString(authorObject?.login) ?? nonEmptyString(raw.author)
  const result: WorkItemRecord = {
    kind,
    number,
    title,
    body: textOrEmpty(raw.body),
    state: stateFromRaw(raw, kind === 'pullRequest', isDraft, stateValue),
    url,
    createdAt: string(raw.createdAt) ?? string(raw.created_at),
    updatedAt: string(raw.updatedAt) ?? string(raw.updated_at),
    author,
    labels: namesFromConnection(raw.labels),
    assignees: namesFromConnection(raw.assignees),
    isDraft
  }
  const issueType = record(raw.issueType) ?? record(raw.issue_type)
  const issueTypeId = nonEmptyString(issueType?.id) ?? (safeInteger(issueType?.id) === null ? null : String(issueType?.id))
  const issueTypeName = nonEmptyString(issueType?.name)
  if (issueTypeId !== null && issueTypeName !== null) result.issueType = { id: issueTypeId, name: issueTypeName }
  const headRefName = nonEmptyString(raw.headRefName) ?? nonEmptyString(record(raw.head)?.ref)
  const baseRefName = nonEmptyString(raw.baseRefName) ?? nonEmptyString(record(raw.base)?.ref)
  const headRefOid = nonEmptyString(raw.headRefOid) ?? nonEmptyString(record(raw.headRef)?.oid)
  const baseRefOid = nonEmptyString(raw.baseRefOid) ?? nonEmptyString(record(raw.baseRef)?.oid)
  if (headRefName !== null) result.headRefName = headRefName
  if (baseRefName !== null) result.baseRefName = baseRefName
  if (headRefOid !== null) result.headRefOid = headRefOid
  if (baseRefOid !== null) result.baseRefOid = baseRefOid
  const stateReason = string(raw.state_reason) ?? string(raw.stateReason)
  if (stateReason !== null) {
    const normalizedReason = stateReason.toLowerCase().replace(/ /g, '_')
    result.stateReason = normalizedReason === 'completed' || normalizedReason === 'not_planned' ? normalizedReason : 'unknown'
  }
  const duplicateOf = positiveInteger(raw.duplicate_of) ?? positiveInteger(raw.duplicateOf)
  if (duplicateOf !== null) result.duplicateOf = duplicateOf
  for (const key of ['additions', 'deletions', 'changedFiles'] as const) {
    const numberValue = safeInteger(raw[key])
    if (numberValue !== null) result[key] = numberValue
  }
  const reviewDecision = string(raw.reviewDecision)
  const mergeStateStatus = string(raw.mergeStateStatus)
  if (reviewDecision !== null) result.reviewDecision = reviewDecision
  if (mergeStateStatus !== null) result.mergeStateStatus = mergeStateStatus
  return result
}

export function graphqlData(value: unknown): Record<string, unknown> | null {
  const root = record(value)
  const data = record(root?.data)
  return data ?? root
}

export function graphqlSearch(value: unknown): { issueCount: number; nodes: unknown[]; endCursor: string | null; hasNextPage: boolean } | null {
  const data = graphqlData(value)
  const search = record(data?.search)
  if (!search) return null
  const issueCount = positiveCount(search.issueCount)
  const pageInfo = record(search.pageInfo)
  const hasNextPage = pageInfo?.hasNextPage
  const endCursor = pageInfo?.endCursor
  if (
    issueCount === null ||
    !Array.isArray(search.nodes) ||
    !pageInfo ||
    typeof hasNextPage !== 'boolean' ||
    (endCursor !== undefined && endCursor !== null && typeof endCursor !== 'string') ||
    (hasNextPage && (typeof endCursor !== 'string' || endCursor.length === 0))
  ) return null
  return {
    issueCount,
    nodes: search.nodes,
    endCursor: typeof endCursor === 'string' ? endCursor : null,
    hasNextPage
  }
}

export function safeErrorReason(error: unknown): string {
  const value = record(error)
  const data = record(value?.data)
  const reason = nonEmptyString(data?.reason)
  return reason ?? 'unknown'
}

export function safeErrorMessage(error: unknown): string {
  const value = record(error)
  const message = nonEmptyString(value?.message)
  return message ?? 'GitHub operation failed.'
}

export function isBodyTooLarge(error: unknown): boolean {
  const reason = safeErrorReason(error).toLowerCase()
  const message = safeErrorMessage(error).toLowerCase()
  return reason === 'too_large' || reason === 'body_too_long' || ((message.includes('body') || message.includes('description')) && /(too long|too large|maximum length|exceeds.*limit)/.test(message))
}


export function ensureStringArray(env: HostingEnv, value: unknown, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw validation(env, `${key} must be an array of up to 100 non-empty strings.`)
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || utf8Length(item) > 256) {
      throw validation(env, `${key} must be an array of up to 100 non-empty strings.`)
    }
    result.push(item.trim())
  }
  return result
}


export function positiveCount(value: unknown): number | null {
  const result = safeInteger(value)
  return result !== null && result >= 0 ? result : null
}

export function listConnection(value: unknown): { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount: number | null } {
  const connection = record(value)
  const pageInfo = record(connection?.pageInfo) ?? {}
  return {
    nodes: array(connection?.nodes),
    pageInfo,
    totalCount: positiveCount(connection?.totalCount)
  }
}

