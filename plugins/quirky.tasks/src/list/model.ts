import type { ItemKind, ItemTarget, TaskListResult, TaskRepo } from '../contracts'
import { queryForKind } from './search'

/**
 * Pure parsing, query-filter and row helpers for the Tasks list.
 * Shared by the compact panel and the expanded view; nothing here touches the daemon or React.
 */

export type ListItem = TaskListResult['items'][number]
export type ListFailure = TaskListResult['failures'][number] & { stage?: string; source?: string }
export type ListData = Omit<TaskListResult, 'failures'> & { failures: ListFailure[] }
export type FilterValues = {
  status: string
  author: string
  labels: string[]
  assignee: string
  reviewRequested: string
  reviewedBy: string
  draftOnly: boolean
}
export type ListSource = { status?: string; reason?: string; message?: string; origin?: { host?: string; owner?: string; repo?: string }; issueRepository?: { host?: string; owner?: string; repo?: string }; issueSource?: string; issueSourcePreference?: string; issueSourceFellBack?: boolean; candidates?: unknown[] }
export type CheckResult = { rollup: string; checks: Record<string, unknown>[]; partial: boolean; partialFailures: string[] }
export type MergeMetadata = { review: Record<string, unknown>; mergeMetadataKnown: boolean; mergeQueueRequired: boolean | null; autoMergeAllowed: boolean | null; mergeEligible: boolean; queueEligible: boolean; autoMergeEnabled: boolean; autoMergeEnableEligible: boolean; directMethods: string[]; queueMethods: string[] }
export type Preset = { id: string; label: string; query: string }
export function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function parseItem(value: unknown): ListItem | null {
  const raw = object(value)
  if (!raw || (raw.kind !== 'issue' && raw.kind !== 'pullRequest') || typeof raw.number !== 'number' || !Number.isSafeInteger(raw.number)) return null
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || typeof raw.url !== 'string' || typeof raw.worktree !== 'string' || typeof raw.repoId !== 'string' || typeof raw.repoName !== 'string') return null
  const state = raw.state === 'open' || raw.state === 'closed' || raw.state === 'merged' || raw.state === 'draft' ? raw.state : 'unknown'
  const item: ListItem = {
    kind: raw.kind,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state,
    url: raw.url,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    author: typeof raw.author === 'string' ? raw.author : null,
    labels: strings(raw.labels),
    assignees: strings(raw.assignees),
    isDraft: raw.isDraft === true,
    worktree: raw.worktree,
    repoId: raw.repoId,
    repoName: raw.repoName
  }
  for (const key of ['headRefName', 'baseRefName', 'headRefOid', 'mergeStateStatus', 'reviewDecision', 'stateReason'] as const) {
    if (typeof raw[key] === 'string') item[key] = raw[key]
  }
  for (const key of ['additions', 'deletions', 'changedFiles', 'duplicateOf'] as const) {
    if (typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0) item[key] = raw[key]
  }
  if (object(raw.linkedWorkspace)) item.linkedWorkspace = raw.linkedWorkspace
  return item
}

export function parseRepo(value: unknown): TaskRepo | null {
  const raw = object(value)
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.path !== 'string' || typeof raw.kind !== 'string' || typeof raw.worktree !== 'string') return null
  return { id: raw.id, name: raw.name, path: raw.path, kind: raw.kind, worktree: raw.worktree, displayName: typeof raw.displayName === 'string' ? raw.displayName : null }
}

export function parseListResult(value: unknown): ListData | null {
  const raw = object(value)
  if (!raw || !Array.isArray(raw.items) || !Array.isArray(raw.repositories) || !Array.isArray(raw.failures)) return null
  const items = raw.items.map(parseItem).filter((item): item is ListItem => item !== null)
  const repositories = raw.repositories.map(parseRepo).filter((repo): repo is TaskRepo => repo !== null)
  const failures = raw.failures.flatMap((entry) => {
    const failure = object(entry)
    if (!failure || typeof failure.repoId !== 'string' || typeof failure.message !== 'string') return []
    return [{
      repoId: failure.repoId,
      message: failure.message,
      ...(typeof failure.reason === 'string' ? { reason: failure.reason } : {}),
      ...(typeof failure.stage === 'string' ? { stage: failure.stage } : {}),
      ...(typeof failure.source === 'string' ? { source: failure.source } : {})
    }]
  })
  const page = typeof raw.page === 'number' && Number.isSafeInteger(raw.page) ? raw.page : 1
  const totalPages = typeof raw.totalPages === 'number' && Number.isSafeInteger(raw.totalPages) ? raw.totalPages : 1
  const perRepo = typeof raw.perRepo === 'number' && Number.isSafeInteger(raw.perRepo) ? raw.perRepo : 0
  const sources = object(raw.sources) ?? {}
  return { items, repositories, page, totalPages, perRepo, failures, sources }
}

export function parseIdentity(value: unknown): ListSource['origin'] {
  const raw = object(value)
  if (!raw) return undefined
  return {
    ...(typeof raw.host === 'string' ? { host: raw.host } : {}),
    ...(typeof raw.owner === 'string' ? { owner: raw.owner } : {}),
    ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {})
  }
}

export function parseSource(value: unknown): ListSource {
  const raw = object(value)
  if (!raw) return {}
  const origin = parseIdentity(raw.origin)
  const issueRepository = parseIdentity(raw.issueRepository)
  return {
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(origin ? { origin } : {}),
    ...(issueRepository ? { issueRepository } : {}),
    ...(typeof raw.issueSource === 'string' ? { issueSource: raw.issueSource } : {}),
    ...(typeof raw.issueSourcePreference === 'string' ? { issueSourcePreference: raw.issueSourcePreference } : {}),
    ...(typeof raw.issueSourceFellBack === 'boolean' ? { issueSourceFellBack: raw.issueSourceFellBack } : {}),
    ...(Array.isArray(raw.candidates) ? { candidates: raw.candidates } : {})
  }
}

/**
 * The key of one list view. The compact panel and the expanded list both build it here, so the
 * same view has the same place memory and snapshot in either form.
 */
export function listViewKey(view: { source: string; mode: string; repoIds: readonly string[] | null; query: string; page: number }): string {
  return `${view.source}\u0000${view.mode}\u0000${view.repoIds === null ? '*' : view.repoIds.join(',')}\u0000${view.query}\u0000${view.page}`
}

export function rowKey(item: Pick<ListItem, 'worktree' | 'kind' | 'number' | 'url'>): string {
  return `${item.worktree}\u0000${item.kind}\u0000${item.number}\u0000${item.url}`
}

export function rowTarget(item: ListItem): ItemTarget {
  return { worktree: item.worktree, kind: item.kind, number: item.number, url: item.url }
}
export function relativeTime(value: string | null): { label: string; absolute: string } {
  if (!value) return { label: 'unknown', absolute: 'Unknown update time' }
  const date = new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time)) return { label: 'unknown', absolute: 'Unknown update time' }
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  let label = 'just now'
  if (seconds >= 60) label = `${Math.floor(seconds / 60)}m ago`
  if (seconds >= 3600) label = `${Math.floor(seconds / 3600)}h ago`
  if (seconds >= 86_400) label = `${Math.floor(seconds / 86_400)}d ago`
  return { label, absolute: date.toLocaleString() }
}

export function tokenize(query: string): string[] {
  const tokens: string[] = []
  let start = -1
  let quote = false
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]!
    if (start < 0) {
      if (/\s/u.test(character)) continue
      start = index
    }
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '"') quote = !quote
    if (!quote && /\s/u.test(character)) {
      tokens.push(query.slice(start, index))
      start = -1
    }
  }
  if (start >= 0) tokens.push(query.slice(start))
  return tokens
}

export function qualifier(token: string): { key: string; value: string } | null {
  const separator = token.indexOf(':')
  if (separator < 0) return null
  const raw = token.slice(separator + 1)
  const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\"/gu, '"') : raw
  return { key: token.slice(0, separator).toLowerCase(), value }
}

export function filtersFromQuery(query: string): FilterValues {
  const filters: FilterValues = { status: '', author: '', labels: [], assignee: '', reviewRequested: '', reviewedBy: '', draftOnly: false }
  for (const token of tokenize(query)) {
    const parsed = qualifier(token)
    if (!parsed) continue
    if (parsed.key === 'is' && ['open', 'closed', 'merged'].includes(parsed.value)) filters.status = parsed.value
    if (parsed.key === 'is' && parsed.value === 'draft') filters.draftOnly = true
    if (parsed.key === 'author') filters.author = parsed.value
    if (parsed.key === 'label') filters.labels.push(parsed.value)
    if (parsed.key === 'assignee') filters.assignee = parsed.value
    if (parsed.key === 'review-requested') filters.reviewRequested = parsed.value
    if (parsed.key === 'reviewed-by') filters.reviewedBy = parsed.value
  }
  return filters
}

export function quoteQualifier(value: string): string {
  return /\s/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value
}

export function replaceFilters(query: string, kind: ItemKind, category: string, values: string[]): string {
  const tokens = tokenize(query).filter((token) => {
    const parsed = qualifier(token)
    if (!parsed) return true
    if (parsed.key === 'is' && ['issue', 'pr'].includes(parsed.value)) return false
    if (category === 'status' && parsed.key === 'is' && ['open', 'closed', 'merged', 'draft'].includes(parsed.value)) return false
    if (category === 'author' && parsed.key === 'author') return false
    if (category === 'labels' && parsed.key === 'label') return false
    if (category === 'assignee' && parsed.key === 'assignee') return false
    if (category === 'reviewRequested' && parsed.key === 'review-requested') return false
    if (category === 'reviewedBy' && parsed.key === 'reviewed-by') return false
    if (category === 'reviews' && ['review-requested', 'reviewed-by'].includes(parsed.key)) return false
    if (category === 'all' && ['is', 'author', 'label', 'assignee', 'review-requested', 'reviewed-by'].includes(parsed.key)) return false
    return true
  })
  const additions = values.map((value) => {
    if (value.startsWith('is:')) return value
    const separator = value.indexOf(':')
    return separator < 0 ? value : `${value.slice(0, separator)}:${quoteQualifier(value.slice(separator + 1))}`
  })
  return queryForKind([...tokens, ...additions].join(' '), kind)
}

export function presetQuery(preset: string, kind: ItemKind): string {
  if (kind === 'issue') {
    return preset === 'assigned' ? 'assignee:@me is:issue is:open' : 'is:issue is:open'
  }
  if (preset === 'mine') return 'author:@me is:pr is:open'
  if (preset === 'needs-review') return 'review-requested:@me is:pr is:open'
  return 'is:pr is:open'
}

export function normalizedPreset(preset: string, kind: ItemKind): string {
  if (kind === 'issue') return preset === 'assigned' ? 'assigned' : 'open'
  return preset === 'mine' || preset === 'needs-review' ? preset : 'open'
}

export function currentPreset(preset: string, kind: ItemKind): Preset[] {
  const choices: Preset[] = kind === 'issue'
    ? [
        { id: 'open', label: 'Open', query: 'is:issue is:open' },
        { id: 'assigned', label: 'Assigned to me', query: 'assignee:@me is:issue is:open' }
      ]
    : [
        { id: 'open', label: 'Open', query: 'is:pr is:open' },
        { id: 'mine', label: 'Mine', query: 'author:@me is:pr is:open' },
        { id: 'needs-review', label: 'Needs review', query: 'review-requested:@me is:pr is:open' }
      ]
  const selected = kind === 'issue'
    ? preset === 'assigned' ? 'assigned' : preset === 'issues' || preset === 'all' ? 'open' : null
    : preset === 'mine' || preset === 'needs-review' ? preset : preset === 'prs' ? 'open' : null
  return choices.map((item) => item.id === selected ? { ...item, label: `${item.label} · default` } : item)
}

export function filterPills(filters: FilterValues, kind: ItemKind): Array<{ category: string; label: string; value?: string }> {
  const values: Array<{ category: string; label: string; value?: string }> = []
  if (filters.status) values.push({ category: 'status', label: `Status: ${filters.status}` })
  if (filters.draftOnly && kind === 'pullRequest') values.push({ category: 'status', label: 'Draft only' })
  if (filters.author) values.push({ category: 'author', label: `Author: ${filters.author}` })
  for (const label of filters.labels) values.push({ category: 'labels', label: `Label: ${label}`, value: label })
  if (filters.assignee) values.push({ category: 'assignee', label: `Assignee: ${filters.assignee}` })
  if (filters.reviewRequested && kind === 'pullRequest') values.push({ category: 'reviewRequested', label: `Review from: ${filters.reviewRequested}` })
  if (filters.reviewedBy && kind === 'pullRequest') values.push({ category: 'reviewedBy', label: `Reviewed by: ${filters.reviewedBy}` })
  return values
}

export function countFilters(filters: FilterValues, kind: ItemKind): number {
  return (filters.status ? 1 : 0) + (filters.draftOnly && kind === 'pullRequest' ? 1 : 0) + (filters.author ? 1 : 0) + filters.labels.length + (filters.assignee ? 1 : 0) + (kind === 'pullRequest' && filters.reviewRequested ? 1 : 0) + (kind === 'pullRequest' && filters.reviewedBy ? 1 : 0)
}

export function checkSummary(value: CheckResult | undefined, loading: boolean): { label: string; tone: string } {
  if (loading) return { label: 'Loading checks…', tone: 'neutral' }
  if (!value) return { label: 'Checks not loaded', tone: 'neutral' }
  if (value.checks.length === 0 && !value.partial && value.rollup === 'neutral') return { label: 'No checks', tone: 'neutral' }
  const failures = value.checks.filter((check) => ['failure', 'failed', 'error', 'action_required', 'timed_out', 'cancelled'].includes(String(check.conclusion ?? check.status ?? '').toLowerCase())).length
  if (failures > 0 || value.rollup === 'failure') return { label: `${failures || 1} failing`, tone: 'danger' }
  const pending = value.checks.filter((check) => ['pending', 'in_progress', 'queued', 'waiting'].includes(String(check.status ?? '').toLowerCase()) || ['pending', 'in_progress'].includes(String(check.conclusion ?? '').toLowerCase())).length
  if (pending > 0 || value.rollup === 'pending') return { label: `${pending || 1} pending`, tone: 'warning' }
  if (value.rollup === 'success') return { label: value.checks.length === 0 ? 'Checks passed' : `${value.checks.length}/${value.checks.length} passed`, tone: 'success' }
  if (value.rollup === 'unknown' || value.partial || value.checks.length === 0 || value.rollup === 'neutral') return { label: 'Unresolved checks', tone: 'neutral' }
  return { label: 'Unresolved checks', tone: 'neutral' }
}

export function mergeMeta(value: unknown): MergeMetadata | null {
  const raw = object(value)
  const review = object(raw?.review)
  if (!raw || !review) return null
  return {
    review,
    mergeMetadataKnown: raw.mergeMetadataKnown === true,
    mergeQueueRequired: typeof raw.mergeQueueRequired === 'boolean' ? raw.mergeQueueRequired : null,
    autoMergeAllowed: typeof raw.autoMergeAllowed === 'boolean' ? raw.autoMergeAllowed : null,
    mergeEligible: raw.mergeEligible === true,
    queueEligible: raw.queueEligible === true,
    autoMergeEnabled: raw.autoMergeEnabled === true,
    autoMergeEnableEligible: raw.autoMergeEnableEligible === true,
    directMethods: strings(raw.directMethods),
    queueMethods: strings(raw.queueMethods)
  }
}

export function reviewState(value: unknown): ListItem['state'] | null {
  if (typeof value !== 'string') return null
  const state = value.toLowerCase()
  return state === 'open' || state === 'closed' || state === 'merged' || state === 'draft' ? state : null
}

export function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function optionalLogins(value: unknown): string[] | null | undefined {
  if (value === null) return null
  return Array.isArray(value) ? strings(value) : undefined
}

export function reviewAuthors(value: unknown): string[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value)) return undefined
  const authors = value.flatMap((entry) => {
    const review = object(entry)
    return typeof review?.author === 'string' ? [review.author] : []
  })
  return [...new Set(authors)]
}

export function checkResult(value: unknown): CheckResult | null {
  const raw = object(value)
  if (!raw || !Array.isArray(raw.checks)) return null
  return {
    rollup: typeof raw.rollup === 'string' ? raw.rollup : 'unknown',
    checks: raw.checks.map(object).filter((entry): entry is Record<string, unknown> => entry !== null),
    partial: raw.partial === true,
    partialFailures: strings(raw.partialFailures)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
