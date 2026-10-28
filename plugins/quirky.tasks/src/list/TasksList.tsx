import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ItemKind, ItemTarget, TaskListResult, TaskRepo, TasksSurfaceProps } from '../contracts'
import { queryForKind } from './search'
import { useReviewNavigation } from './useReviewNavigation'

export { WorkspaceComposer } from './WorkspaceComposer'
export { useReviewNavigation } from './useReviewNavigation'

type ListItem = TaskListResult['items'][number]
type ListFailure = TaskListResult['failures'][number] & { stage?: string; source?: string }
type ListData = Omit<TaskListResult, 'failures'> & { failures: ListFailure[] }
type FilterValues = {
  status: string
  author: string
  labels: string[]
  assignee: string
  reviewRequested: string
  reviewedBy: string
  draftOnly: boolean
}
type OptimisticRow = { item: ListItem; patch: Partial<ListItem>; generation: number; keepVisible: boolean }
type ListSource = { status?: string; reason?: string; message?: string; origin?: { host?: string; owner?: string; repo?: string }; issueRepository?: { host?: string; owner?: string; repo?: string }; issueSource?: string; issueSourcePreference?: string; issueSourceFellBack?: boolean; candidates?: unknown[] }
type CheckResult = { rollup: string; checks: Record<string, unknown>[]; partial: boolean; partialFailures: string[] }
type MergeMetadata = { review: Record<string, unknown>; mergeMetadataKnown: boolean; mergeQueueRequired: boolean | null; autoMergeAllowed: boolean | null; mergeEligible: boolean; queueEligible: boolean; autoMergeEnabled: boolean; autoMergeEnableEligible: boolean; directMethods: string[]; queueMethods: string[] }
type ReviewerOptions = { recentlyActive: string[]; suggestions: string[] }

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function parseItem(value: unknown): ListItem | null {
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

function parseRepo(value: unknown): TaskRepo | null {
  const raw = object(value)
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.path !== 'string' || typeof raw.kind !== 'string' || typeof raw.worktree !== 'string') return null
  return { id: raw.id, name: raw.name, path: raw.path, kind: raw.kind, worktree: raw.worktree, displayName: typeof raw.displayName === 'string' ? raw.displayName : null }
}

function parseListResult(value: unknown): ListData | null {
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

function parseIdentity(value: unknown): ListSource['origin'] {
  const raw = object(value)
  if (!raw) return undefined
  return {
    ...(typeof raw.host === 'string' ? { host: raw.host } : {}),
    ...(typeof raw.owner === 'string' ? { owner: raw.owner } : {}),
    ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {})
  }
}

function parseSource(value: unknown): ListSource {
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

function rowKey(item: Pick<ListItem, 'worktree' | 'kind' | 'number' | 'url'>): string {
  return `${item.worktree}\u0000${item.kind}\u0000${item.number}\u0000${item.url}`
}

function rowTarget(item: ListItem): ItemTarget {
  return { worktree: item.worktree, kind: item.kind, number: item.number, url: item.url }
}

function stop(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

function relativeTime(value: string | null): { label: string; absolute: string } {
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

function tokenize(query: string): string[] {
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

function qualifier(token: string): { key: string; value: string } | null {
  const separator = token.indexOf(':')
  if (separator < 0) return null
  const raw = token.slice(separator + 1)
  const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\"/gu, '"') : raw
  return { key: token.slice(0, separator).toLowerCase(), value }
}

function filtersFromQuery(query: string): FilterValues {
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

function quoteQualifier(value: string): string {
  return /\s/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value
}

function replaceFilters(query: string, kind: ItemKind, category: string, values: string[]): string {
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

function presetQuery(preset: string, kind: ItemKind): string {
  if (kind === 'issue') {
    return preset === 'assigned' ? 'assignee:@me is:issue is:open' : 'is:issue is:open'
  }
  if (preset === 'mine') return 'author:@me is:pr is:open'
  if (preset === 'needs-review') return 'review-requested:@me is:pr is:open'
  return 'is:pr is:open'
}

function normalizedPreset(preset: string, kind: ItemKind): string {
  if (kind === 'issue') return preset === 'assigned' ? 'assigned' : 'open'
  return preset === 'mine' || preset === 'needs-review' ? preset : 'open'
}

function currentPreset(preset: string, kind: ItemKind): Preset[] {
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

function filterPills(filters: FilterValues, kind: ItemKind): Array<{ category: string; label: string; value?: string }> {
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

function countFilters(filters: FilterValues, kind: ItemKind): number {
  return (filters.status ? 1 : 0) + (filters.draftOnly && kind === 'pullRequest' ? 1 : 0) + (filters.author ? 1 : 0) + filters.labels.length + (filters.assignee ? 1 : 0) + (kind === 'pullRequest' && filters.reviewRequested ? 1 : 0) + (kind === 'pullRequest' && filters.reviewedBy ? 1 : 0)
}

function pageNumbers(page: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 9) return Array.from({ length: total }, (_, index) => index + 1)
  const selected = new Set([1, total, page - 2, page - 1, page, page + 1, page + 2].filter((value) => value >= 1 && value <= total))
  const ordered = [...selected].sort((left, right) => left - right)
  const result: Array<number | 'ellipsis'> = []
  for (const [index, value] of ordered.entries()) {
    if (index > 0 && value - (ordered[index - 1] ?? value) > 1) result.push('ellipsis')
    result.push(value)
  }
  return result
}

function userLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  if (/Mac/u.test(platform)) return 'Local Mac'
  if (/Win/u.test(platform)) return 'Local Windows'
  if (/Linux/u.test(platform)) return 'Local Linux'
  return 'Local'
}

function sourceLabel(source: ListSource): string {
  const identity = source.origin
  if (!identity || !identity.owner || !identity.repo) return source.message ?? 'GitHub source unavailable'
  const repository = `${identity.owner}/${identity.repo}`
  return !identity.host || identity.host.toLowerCase() === 'github.com' ? repository : `${identity.host} · ${repository}`
}

function checkSummary(value: CheckResult | undefined, loading: boolean): { label: string; tone: string } {
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

function mergeMeta(value: unknown): MergeMetadata | null {
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

function reviewState(value: unknown): ListItem['state'] | null {
  if (typeof value !== 'string') return null
  const state = value.toLowerCase()
  return state === 'open' || state === 'closed' || state === 'merged' || state === 'draft' ? state : null
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function optionalLogins(value: unknown): string[] | null | undefined {
  if (value === null) return null
  return Array.isArray(value) ? strings(value) : undefined
}

function reviewAuthors(value: unknown): string[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value)) return undefined
  const authors = value.flatMap((entry) => {
    const review = object(entry)
    return typeof review?.author === 'string' ? [review.author] : []
  })
  return [...new Set(authors)]
}

function checkResult(value: unknown): CheckResult | null {
  const raw = object(value)
  if (!raw || !Array.isArray(raw.checks)) return null
  return {
    rollup: typeof raw.rollup === 'string' ? raw.rollup : 'unknown',
    checks: raw.checks.map(object).filter((entry): entry is Record<string, unknown> => entry !== null),
    partial: raw.partial === true,
    partialFailures: strings(raw.partialFailures)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function samePatch(item: ListItem, patch: Partial<ListItem>): boolean {
  if (patch.state !== undefined && item.state !== patch.state) return false
  if (patch.duplicateOf !== undefined && item.duplicateOf !== patch.duplicateOf) return false
  if (patch.assignees !== undefined && JSON.stringify(item.assignees) !== JSON.stringify(patch.assignees)) return false
  return true
}

function absolutePatch(item: unknown): Partial<ListItem> {
  const raw = object(item)
  if (!raw) return {}
  const patch: Partial<ListItem> = {}
  if (raw.state === 'open' || raw.state === 'closed' || raw.state === 'merged' || raw.state === 'draft' || raw.state === 'unknown') patch.state = raw.state
  if (typeof raw.stateReason === 'string') patch.stateReason = raw.stateReason
  if (typeof raw.duplicateOf === 'number') patch.duplicateOf = raw.duplicateOf
  if (Array.isArray(raw.assignees)) patch.assignees = strings(raw.assignees)
  if (Array.isArray(raw.labels)) patch.labels = strings(raw.labels)
  if (typeof raw.title === 'string') patch.title = raw.title
  if (typeof raw.updatedAt === 'string') patch.updatedAt = raw.updatedAt
  return patch
}

const quietAdoptionDelays = [500, 1000, 2000, 4000, 8000]

export function TasksList({ context, state, refresh }: TasksSurfaceProps) {
  const [result, setResult] = useState<ListData | null>(null)
  const [resultKey, setResultKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState(state.navigation.query)
  const [repoOpen, setRepoOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [statusFor, setStatusFor] = useState<string | null>(null)
  const [duplicateFor, setDuplicateFor] = useState<string | null>(null)
  const [duplicateText, setDuplicateText] = useState('')
  const [assigneesFor, setAssigneesFor] = useState<string | null>(null)
  const [assigneeChoices, setAssigneeChoices] = useState<Record<string, string[]>>({})
  const [assigneeDraft, setAssigneeDraft] = useState<string[]>([])
  const [reviewersFor, setReviewersFor] = useState<string | null>(null)
  const [reviewerText, setReviewerText] = useState('')
  const [reviewerOptions, setReviewerOptions] = useState<Record<string, ReviewerOptions>>({})
  const [mergeFor, setMergeFor] = useState<string | null>(null)
  const [mergeMetadata, setMergeMetadata] = useState<Record<string, MergeMetadata>>({})
  const [mergeLoading, setMergeLoading] = useState<Record<string, boolean>>({})
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})
  const [checks, setChecks] = useState<Record<string, CheckResult>>({})
  const [checksLoading, setChecksLoading] = useState<Record<string, boolean>>({})
  const [repoLabels, setRepoLabels] = useState<string[]>([])
  const [repoAssignees, setRepoAssignees] = useState<string[]>([])
  const [filterAuthorText, setFilterAuthorText] = useState('')
  const [filterReviewRequestedText, setFilterReviewRequestedText] = useState('')
  const [filterReviewedByText, setFilterReviewedByText] = useState('')
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticRow>>({})
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({})
  const mergeMetadataRef = useRef(mergeMetadata)
  mergeMetadataRef.current = mergeMetadata
  const fetchGeneration = useRef(0)
  const latestKey = useRef('')
  const mutationGenerations = useRef(new Map<string, number>())
  const mergeReadGenerations = useRef(new Map<string, number>())
  const mergeReadOwners = useRef(new Map<string, string>())
  const mutationInFlight = useRef(new Set<string>())
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const checkTriggered = useRef(new Set<string>())

  const navigation = state.navigation
  const mode = navigation.mode === 'prs' ? 'prs' : 'issues'
  const kind: ItemKind = mode === 'prs' ? 'pullRequest' : 'issue'
  const allRepoIds = result?.repositories.map((repo) => repo.id) ?? []
  const selectedRepoIds = navigation.repoIds === null ? allRepoIds : navigation.repoIds
  const selectedRepos = result?.repositories.filter((repo) => selectedRepoIds.includes(repo.id)) ?? []
  const filterRepoId = selectedRepos.length === 1 ? selectedRepos[0]!.id : null
  const currentKey = `${navigation.source}\u0000${mode}\u0000${navigation.repoIds === null ? '*' : navigation.repoIds.join(',')}\u0000${navigation.query}\u0000${navigation.page}`
  latestKey.current = currentKey
  const visibleResult = resultKey === currentKey ? result : null
  const filters = filtersFromQuery(navigation.query)
  const listItems = useMemo(() => {
    if (!visibleResult) return []
    const rows = visibleResult.items.map((item) => {
      const patch = optimistic[rowKey(item)]
      return patch ? { ...item, ...patch.patch } : item
    })
    for (const [key, pending] of Object.entries(optimistic)) {
      if (pending.keepVisible && !rows.some((item) => rowKey(item) === key)) rows.push({ ...pending.item, ...pending.patch })
    }
    return rows
  }, [visibleResult, optimistic])

  const fetchList = useCallback(async (noCache: boolean): Promise<ListData> => {
    const value = await context.call('quirky.tasks/list', {
      mode,
      repoIds: navigation.repoIds,
      query: navigation.query,
      page: navigation.page,
      ...(noCache ? { noCache: true } : {})
    })
    const parsed = parseListResult(value)
    if (!parsed) throw new Error('The Tasks list API returned an invalid result.')
    return parsed
  }, [context, mode, navigation.page, navigation.query, navigation.repoIds])

  const loadList = useCallback(async (noCache = false, deliberate = false) => {
    const key = currentKey
    if (navigation.mode === 'projects') return
    const generation = ++fetchGeneration.current
    if (deliberate) {
      setOptimistic((previous) => Object.fromEntries(Object.entries(previous).filter(([, pending]) => !pending.keepVisible)))
      checkTriggered.current.clear()
      setChecks({})
    }
    setLoading(true)
    if (noCache) setRefreshing(true)
    try {
      const loaded = await fetchList(noCache)
      if (generation !== fetchGeneration.current || latestKey.current !== key) return
      setResult(loaded)
      setResultKey(key)
      setError(null)
    } catch (cause) {
      if (generation !== fetchGeneration.current || latestKey.current !== key) return
      setError(errorMessage(cause))
      if (resultKey !== key) setResult(null)
    } finally {
      if (generation === fetchGeneration.current && latestKey.current === key) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [currentKey, fetchList, navigation.mode, resultKey])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    clearTimeout(searchTimer.current)
    if (navigation.mode === 'projects') return
    const kindForMode: ItemKind = navigation.mode === 'prs' ? 'pullRequest' : 'issue'
    let normalized: string
    try {
      normalized = queryForKind(navigation.query, kindForMode)
    } catch (cause) {
      setSearchDraft(navigation.query)
      setError(errorMessage(cause))
      return
    }
    setSearchDraft(normalized)
    if (normalized !== navigation.query) {
      void context.call('quirky.tasks/navigate', { query: normalized, page: 1 }).catch((cause) => setError(errorMessage(cause)))
    }
  }, [context, navigation.mode, navigation.query])

  useEffect(() => {
    if (!filtersOpen || !filterRepoId) {
      setRepoLabels([])
      setRepoAssignees([])
      return
    }
    const repo = result?.repositories.find((entry) => entry.id === filterRepoId)
    if (!repo) return
    let live = true
    void context.call('quirky.tasks/options', { repoId: repo.id, kind: 'labels' }).then((value) => {
      const labels = object(value)?.labels
      if (live && Array.isArray(labels)) setRepoLabels(labels.filter((entry): entry is string => typeof entry === 'string'))
    }).catch(() => live && setRepoLabels([]))
    void context.call('quirky.tasks/options', { repoId: repo.id, kind: 'assignees' }).then((value) => {
      const assignees = object(value)?.assignees
      if (live && Array.isArray(assignees)) setRepoAssignees(assignees.flatMap((entry) => {
        const assignee = object(entry)
        return typeof assignee?.login === 'string' ? [assignee.login] : []
      }))
    }).catch(() => live && setRepoAssignees([]))
    return () => { live = false }
  }, [context, filterRepoId, filtersOpen, result?.repositories])

  const navigate = useCallback(async (patch: Record<string, unknown>) => {
    try {
      await context.call('quirky.tasks/navigate', patch)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [context])
  const reportNavigationError = useCallback((message: string) => setError(message), [])
  const openReview = useReviewNavigation(context, reportNavigationError)

  const commitSearch = useCallback((value: string) => {
    setSearchDraft(value)
    clearTimeout(searchTimer.current)
    let next: string
    try {
      next = queryForKind(value, kind)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    if (new TextEncoder().encode(next).byteLength > 8192) {
      setError('Search query exceeds the 8192-byte limit.')
      return
    }
    if (next !== navigation.query) void navigate({ query: next, page: 1, scrollTop: 0 })
  }, [kind, navigation.query, navigate])

  const onSearchChange = (value: string) => {
    setSearchDraft(value)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => commitSearch(value), 750)
  }

  const presets = currentPreset(state.preferences.defaultTaskViewPreset, kind)
  const presetClick = (item: Preset) => commitSearch(item.query)
  const makeDefaultPreset = async (item: Preset, event: { preventDefault(): void }) => {
    event.preventDefault()
    const selected = item.id === 'open' ? (kind === 'issue' ? 'issues' : 'prs') : item.id
    try {
      await context.call('quirky.tasks/preferences', { defaultTaskViewPreset: selected })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const setFilter = (category: string, values: string[]) => {
    const query = replaceFilters(searchDraft, kind, category, values)
    commitSearch(query)
  }

  const toggleLabel = (label: string, checked: boolean) => {
    const current = filtersFromQuery(navigation.query).labels
    const next = checked ? [...new Set([...current, label])] : current.filter((entry) => entry !== label)
    setFilter('labels', next.map((entry) => `label:${entry}`))
  }

  const removeFilter = (category: string, value?: string) => {
    const current = filtersFromQuery(navigation.query)
    if (category === 'labels') setFilter('labels', current.labels.filter((label) => label !== value).map((label) => `label:${label}`))
    else if (category === 'status') setFilter('status', [])
    else if (category === 'reviews') setFilter('reviews', [])
    else setFilter(category, [])
  }

  const selectRepositories = async (ids: string[]) => {
    const unique = [...new Set(ids)]
    const allSelected = allRepoIds.length > 0 && unique.length === allRepoIds.length && allRepoIds.every((id) => unique.includes(id))
    const selection = allSelected ? null : unique
    try {
      await context.call('quirky.tasks/preferences', { defaultRepoSelection: selection })
      await navigate({ repoIds: selection, page: 1, scrollTop: 0 })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const issueSource = selectedRepos.length === 1 ? parseSource(visibleResult?.sources[selectedRepos[0]!.id]) : {}
  const openLink = (url: string) => {
    void context.executeCommand('command:quirky.tasks/open-link', { url }).catch((cause) => setError(errorMessage(cause)))
  }

  const setBusy = (key: string, value: boolean) => setBusyRows((previous) => ({ ...previous, [key]: value }))

  const updateListResult = (next: ListData, currentKeyAtCall: string) => {
    if (latestKey.current !== currentKeyAtCall) return
    setResult(next)
    setResultKey(currentKeyAtCall)
  }

  const startQuietAdoption = (item: ListItem, generation: number, patch: Partial<ListItem>, key: string) => {
    const run = async () => {
      for (const delay of quietAdoptionDelays) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, delay)
        await promise
        if (mutationGenerations.current.get(rowKey(item)) !== generation || latestKey.current !== key) return
        try {
          const fresh = await fetchList(true)
          if (mutationGenerations.current.get(rowKey(item)) !== generation || latestKey.current !== key) return
          const current = fresh.items.find((candidate) => rowKey(candidate) === rowKey(item))
          if (current && samePatch(current, patch)) {
            setOptimistic((previous) => {
              const next = { ...previous }
              delete next[rowKey(item)]
              return next
            })
            updateListResult(fresh, key)
            return
          }
          updateListResult(fresh, key)
        } catch (cause) {
          if (mutationGenerations.current.get(rowKey(item)) === generation && latestKey.current === key) setError(errorMessage(cause))
        }
      }
    }
    void run()
  }

  const mutate = async (item: ListItem, action: Record<string, unknown>, patch: Partial<ListItem>, keepVisible = false): Promise<unknown> => {
    const key = rowKey(item)
    const generation = (mutationGenerations.current.get(key) ?? 0) + 1
    mutationGenerations.current.set(key, generation)
    mergeReadGenerations.current.set(key, (mergeReadGenerations.current.get(key) ?? 0) + 1)
    mergeReadOwners.current.delete(key)
    mutationInFlight.current.add(key)
    const contextKey = currentKey
    fetchGeneration.current += 1
    setMergeLoading((previous) => ({ ...previous, [key]: false }))
    setBusy(key, true)
    setOptimistic((previous) => ({ ...previous, [key]: { item, patch, generation, keepVisible } }))
    try {
      const result = await context.call('quirky.tasks/row', { target: rowTarget(item), ...action, ...(action.action === 'merge' ? { yes: true } : {}) })
      if (mutationGenerations.current.get(key) !== generation) return result
      const response = object(result)
      const confirmedPatch = action.action === 'issueStatus'
        ? absolutePatch(response?.item)
        : action.action === 'merge' && response?.kind === 'merged'
          ? { state: 'merged' as const }
          : {}
      const finalPatch = Object.keys(confirmedPatch).length > 0 ? { ...patch, ...confirmedPatch } : patch
      setOptimistic((previous) => ({ ...previous, [key]: { item, patch: finalPatch, generation, keepVisible } }))
      if (action.action === 'merge' && response?.kind === 'merged') {
        setMergeMetadata((previous) => {
          const current = previous[key]
          if (!current) return previous
          return {
            ...previous,
            [key]: {
              ...current,
              review: { ...current.review, state: 'merged' },
              mergeEligible: false,
              queueEligible: false,
              autoMergeEnabled: false,
              autoMergeEnableEligible: false,
              directMethods: [],
              queueMethods: []
            }
          }
        })
      }
      if (action.action === 'autoMerge') {
        const enabled = object(response?.result)?.enabled
        if (typeof enabled === 'boolean') {
          setMergeMetadata((previous) => {
            const current = previous[key]
            return current ? { ...previous, [key]: { ...current, autoMergeEnabled: enabled } } : previous
          })
        }
      }
      if (action.action === 'reviewers' && object(response?.result)?.updated === true) {
        const requested = optionalLogins(mergeMetadataRef.current[key]?.review.requestedReviewers)
        const reviewerAction = action.reviewerAction
        if (requested && typeof action.reviewerText === 'string' && (reviewerAction === 'add' || reviewerAction === 'remove')) {
          const logins = [...new Set(action.reviewerText.split(/[\s,]+/u).map((login) => login.replace(/^@+/u, '')).filter(Boolean))]
          const requestedReviewers = reviewerAction === 'add'
            ? [...new Set([...requested, ...logins])]
            : requested.filter((login) => !logins.includes(login))
          setMergeMetadata((previous) => {
            const current = previous[key]
            return current ? { ...previous, [key]: { ...current, review: { ...current.review, requestedReviewers } } } : previous
          })
        }
      }
      setError(null)
      startQuietAdoption(item, generation, finalPatch, contextKey)
      void refresh().catch((cause) => setError(errorMessage(cause)))
      return result
    } catch (cause) {
      if (mutationGenerations.current.get(key) === generation) {
        setOptimistic((previous) => {
          const next = { ...previous }
          delete next[key]
          return next
        })
        setError(errorMessage(cause))
      }
      throw cause
    } finally {
      if (mutationGenerations.current.get(key) === generation) {
        mutationInFlight.current.delete(key)
        setBusy(key, false)
      }
    }
  }

  const loadChecks = useCallback(async (item: ListItem) => {
    const key = rowKey(item)
    if (checkTriggered.current.has(key)) return
    checkTriggered.current.add(key)
    setChecksLoading((previous) => ({ ...previous, [key]: true }))
    try {
      const value = await context.call('quirky.tasks/checks', { target: rowTarget(item) })
      const parsed = checkResult(value)
      if (parsed) setChecks((previous) => ({ ...previous, [key]: parsed }))
      else setChecks((previous) => ({ ...previous, [key]: { rollup: 'unknown', checks: [], partial: true, partialFailures: ['Invalid check result.'] } }))
    } catch (cause) {
      setError(errorMessage(cause))
      checkTriggered.current.delete(key)
    } finally {
      setChecksLoading((previous) => ({ ...previous, [key]: false }))
    }
  }, [context])
  const loadMergeMetadata = useCallback(async (item: ListItem) => {
    const key = rowKey(item)
    const owner = currentKey
    if (mergeMetadataRef.current[key] || mutationInFlight.current.has(key) || mergeReadOwners.current.get(key) === owner) return
    const generation = (mergeReadGenerations.current.get(key) ?? 0) + 1
    mergeReadGenerations.current.set(key, generation)
    mergeReadOwners.current.set(key, owner)
    const mutationGeneration = mutationGenerations.current.get(key) ?? 0
    const ownsRead = () => mergeReadGenerations.current.get(key) === generation
      && mergeReadOwners.current.get(key) === owner
      && latestKey.current === owner
      && (mutationGenerations.current.get(key) ?? 0) === mutationGeneration
      && !mutationInFlight.current.has(key)
    setMergeLoading((previous) => ({ ...previous, [key]: true }))
    setMergeErrors((previous) => {
      if (!previous[key]) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
    try {
      const result = mergeMeta(await context.call('quirky.tasks/mergeMetadata', { target: rowTarget(item) }))
      if (!result) throw new Error('GitHub returned no merge safety metadata.')
      if (ownsRead()) {
        setMergeMetadata((previous) => ({ ...previous, [key]: result }))
        setMergeErrors((previous) => {
          if (!previous[key]) return previous
          const next = { ...previous }
          delete next[key]
          return next
        })
      }
    } catch (cause) {
      if (ownsRead()) setMergeErrors((previous) => ({ ...previous, [key]: errorMessage(cause) }))
    } finally {
      if (mergeReadGenerations.current.get(key) === generation) {
        mergeReadOwners.current.delete(key)
        setMergeLoading((previous) => ({ ...previous, [key]: false }))
      }
    }
  }, [context, currentKey])

  useEffect(() => {
    if (mode !== 'prs') return
    for (const item of listItems.slice(0, 20)) {
      void loadChecks(item)
      void loadMergeMetadata(item)
    }
  }, [listItems, loadChecks, loadMergeMetadata, mode])

  useEffect(() => {
    if (mode !== 'prs' || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const element = entry.target
        const checkKey = element.getAttribute('data-check-key')
        const reviewKey = element.getAttribute('data-review-key')
        const key = checkKey ?? reviewKey
        const item = listItems.find((candidate) => rowKey(candidate) === key)
        if (!item) continue
        if (checkKey) void loadChecks(item)
        if (reviewKey) void loadMergeMetadata(item)
      }
    }, { rootMargin: '160px' })
    const elements = document.querySelectorAll('[data-check-key], [data-review-key]')
    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [listItems, loadChecks, loadMergeMetadata, mode])


  const toggleMergeMenu = (item: ListItem) => {
    const key = rowKey(item)
    setMergeFor((current) => current === key ? null : key)
    if (mergeFor !== key) void loadMergeMetadata(item)
  }

  const mergeItem = async (item: ListItem, method: string, mergeAction: 'direct' | 'queue') => {
    const key = rowKey(item)
    const metadata = mergeMetadata[key]
    const review = metadata?.review
    const expectedHead = typeof review?.headRefOid === 'string' ? review.headRefOid : ''
    const eligible = mergeAction === 'direct' ? metadata?.mergeEligible : metadata?.queueEligible
    if (!eligible || !expectedHead) {
      setError('GitHub has not confirmed the current merge queue or direct-merge safety metadata.')
      return
    }
    const title = mergeAction === 'queue' ? `Merge when ready PR #${item.number}?` : `Merge ${method} PR #${item.number}?`
    const confirmed = await context.confirm({
      title,
      body: `${mergeAction === 'queue' ? 'This will add the pull request to the configured GitHub merge queue.' : 'This will update the pull request on GitHub.'} ${item.url}`,
      confirmLabel: mergeAction === 'queue' ? 'Merge when ready' : method
    })
    if (!confirmed) return
    setMergeFor(null)
    try {
      const outcome = object(await mutate(item, {
        action: 'merge',
        method,
        mergeAction,
        expectedHead,
      }, {}))
      if (outcome?.kind === 'enqueued') context.toast('Merge queued', `PR #${item.number} was added to the GitHub merge queue.`)
      else if (outcome?.kind === 'pending') context.toast('Merge pending', `GitHub is still processing PR #${item.number}.`)
    } catch {
      return
    }
  }

  const toggleAutoMerge = async (item: ListItem) => {
    const key = rowKey(item)
    const metadata = mergeMetadata[key]
    const review = metadata?.review
    if (!review || typeof review.headRefOid !== 'string') {
      setError('Load current pull-request metadata before changing auto-merge.')
      return
    }
    const enabled = metadata.autoMergeEnabled
    const allowed = object(review.mergeMethods)?.allowed
    const methods = strings(allowed)
    const method = methods.includes(String(object(review.mergeMethods)?.default)) ? String(object(review.mergeMethods)?.default) : methods[0]
    if (!enabled && (!metadata.mergeMetadataKnown || metadata.mergeQueueRequired === null)) {
      setError('GitHub has not confirmed merge-queue safety metadata.')
      return
    }
    if (!enabled && metadata.autoMergeAllowed !== true) {
      setError(metadata.autoMergeAllowed === false ? 'GitHub has disabled auto-merge for this repository.' : 'GitHub auto-merge availability is unknown.')
      return
    }
    if (!enabled && (!metadata.autoMergeEnableEligible || !method)) {
      setError('GitHub metadata does not allow auto-merge for this pull request.')
      return
    }
    const confirmed = await context.confirm({
      title: enabled
        ? `Disable auto-merge for PR #${item.number}?`
        : metadata.mergeQueueRequired ? `Merge when ready PR #${item.number}?` : `Enable auto-merge for PR #${item.number}?`,
      body: enabled
        ? 'GitHub will stop automatically merging this pull request.'
        : metadata.mergeQueueRequired
          ? 'GitHub will add this pull request to the configured merge queue.'
          : 'GitHub will merge this pull request when its requirements are met.'
    })
    if (!confirmed) return
    try {
      const result = await mutate(item, {
        action: 'autoMerge',
        autoMergeAction: enabled ? 'disable' : 'enable',
        ...(enabled ? {} : { expectedHead: review.headRefOid, method })
      }, {})
      const value = object(result)?.result
      if (object(value)?.enabled === true) context.toast(metadata.mergeQueueRequired ? 'Merge queued' : 'Auto-merge enabled', `PR #${item.number}`)
      else if (object(value)?.enabled === false) context.toast('Auto-merge disabled', `PR #${item.number}`)
    } catch {
      return
    }
  }


  const toggleAssignee = (login: string, checked: boolean) => {
    setAssigneeDraft((previous) => checked ? [...new Set([...previous, login])] : previous.filter((value) => value !== login))
  }

  const openAssignees = async (item: ListItem) => {
    const key = rowKey(item)
    setAssigneesFor((current) => current === key ? null : key)
    setAssigneeDraft([...item.assignees])
    if (assigneeChoices[item.repoId]) return
    try {
      const result = object(await context.call('quirky.tasks/options', { repoId: item.repoId, kind: 'assignees' }))
      const values = Array.isArray(result?.assignees) ? result.assignees.flatMap((entry) => {
        const value = object(entry)
        return typeof value?.login === 'string' ? [value.login] : []
      }) : []
      setAssigneeChoices((previous) => ({ ...previous, [item.repoId]: values }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const saveAssignees = async (item: ListItem) => {
    try {
      await mutate(item, { action: 'assignees', assignees: assigneeDraft }, { assignees: assigneeDraft })
      setAssigneesFor(null)
    } catch {
      return
    }
  }
  const openReviewers = async (item: ListItem) => {
    const key = rowKey(item)
    const opening = reviewersFor !== key
    setReviewersFor(opening ? key : null)
    if (!opening) return
    setReviewerText('')
    if (reviewerOptions[key]) return
    if (!mergeMetadataRef.current[key]) void loadMergeMetadata(item)
    const review = mergeMetadataRef.current[key]?.review
    const recentFromReview = reviewAuthors(review?.reviews)
    const assigneesFromReview = optionalLogins(review?.assignees)
    const requested = optionalLogins(review?.requestedReviewers)
    if (recentFromReview !== undefined && assigneesFromReview !== undefined) {
      setReviewerOptions((previous) => ({
        ...previous,
        [key]: { recentlyActive: recentFromReview ?? [], suggestions: assigneesFromReview ?? [] }
      }))
      return
    }
    try {
      const result = object(await context.call('quirky.tasks/options', { kind: 'reviewers', target: rowTarget(item) }))
      setReviewerOptions((previous) => ({
        ...previous,
        [key]: {
          recentlyActive: [...new Set([...strings(result?.recentlyActive), ...(recentFromReview ?? [])])]
            .filter((login) => !requested?.includes(login)),
          suggestions: [...new Set([...strings(result?.suggestions), ...(assigneesFromReview ?? [])])]
            .filter((login) => !requested?.includes(login))
        }
      }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const addReviewerOption = (login: string) => {
    const current = reviewerText.split(/[\s,]+/u).map((value) => value.replace(/^@+/u, '')).filter(Boolean)
    const logins = [...new Set([...current, login])]
    const next = logins.join(' ')
    if (logins.length > 15) {
      setError('You can request up to 15 reviewers.')
      return
    }
    if (new TextEncoder().encode(next).byteLength > 2048) {
      setError('Reviewer input exceeds the 2048-byte limit.')
      return
    }
    setReviewerText(next)
  }


  const saveReviewers = async (item: ListItem, action: 'add' | 'remove') => {
    if (new TextEncoder().encode(reviewerText).byteLength > 2048) {
      setError('Reviewer input exceeds the 2048-byte limit.')
      return
    }
    const logins = [...new Set(reviewerText.split(/[\s,]+/u).map((value) => value.replace(/^@+/u, '')).filter(Boolean))]
    if (logins.length > 15) {
      setError('You can request up to 15 reviewers.')
      return
    }
    if (logins.length === 0) {
      setError('Enter at least one reviewer login.')
      return
    }
    try {
      await mutate(item, { action: 'reviewers', reviewerAction: action, reviewerText }, {})
      context.toast(action === 'add' ? 'Reviewers requested' : 'Reviewers removed', `PR #${item.number}`)
      setReviewersFor(null)
      setReviewerText('')
    } catch {
      return
    }
  }

  const setStatus = async (item: ListItem, nextState: 'open' | 'closed', reason?: 'completed' | 'not_planned' | 'duplicate', duplicateOf?: number) => {
    const patch: Partial<ListItem> = { state: nextState, ...(reason ? { stateReason: reason } : {}), ...(duplicateOf ? { duplicateOf } : {}) }
    const keepVisible = nextState === 'closed' && /(?:^|\s)is:open(?:\s|$)/u.test(navigation.query)
    try {
      await mutate(item, { action: 'issueStatus', state: nextState, ...(reason ? { stateReason: reason } : {}), ...(duplicateOf ? { duplicateOf } : {}) }, patch, keepVisible)
      setStatusFor(null)
      setDuplicateFor(null)
      setDuplicateText('')
    } catch {
      return
    }
  }

  const changeRepoSource = async (preference: 'origin' | 'upstream') => {
    const repo = selectedRepos[0]
    const origin = object(issueSource.origin)
    const sourceIdentity = preference === 'origin' ? origin : issueSource.candidates?.find((entry) => {
      const candidate = object(entry)
      if (!candidate || !origin) return false
      return `${String(candidate.host).toLowerCase()}/${String(candidate.owner).toLowerCase()}/${String(candidate.repo).toLowerCase()}` !== `${String(origin.host).toLowerCase()}/${String(origin.owner).toLowerCase()}/${String(origin.repo).toLowerCase()}`
    })
    const candidate = object(sourceIdentity)
    if (!repo || !candidate || typeof candidate.host !== 'string' || typeof candidate.owner !== 'string' || typeof candidate.repo !== 'string') return
    const target: ItemTarget = {
      worktree: repo.worktree,
      kind: 'issue',
      number: 1,
      url: `https://${candidate.host}/${candidate.owner}/${candidate.repo}/issues/1`
    }
    try {
      await context.call('quirky.tasks/row', { target, action: 'issueSource', preference })
      await loadList(true)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const onRow = (item: ListItem) => {
    if (item.kind === 'pullRequest') {
      void openReview(rowTarget(item), 'conversation')
      return
    }
    void navigate({ detail: rowTarget(item), page: navigation.page, scrollTop: 0 })
  }

  const goToPage = (page: number) => {
    if (page < 1 || page > (visibleResult?.totalPages ?? 1) || page === navigation.page || loading) return
    void navigate({ page, scrollTop: 0 })
  }

  const openInGitHub = (event: { stopPropagation(): void }, url: string) => {
    event.stopPropagation()
    openLink(url)
  }

  if (navigation.mode === 'projects') return null
  const selectedSet = new Set(selectedRepoIds)
  const selectedSourceValues = selectedRepos.map((repo) => parseSource(visibleResult?.sources[repo.id]))
  const repoButtonLabel = selectedRepoIds.length === allRepoIds.length && navigation.repoIds === null
    ? 'All repositories'
    : selectedRepos.length === 1 ? selectedRepos[0]!.displayName || selectedRepos[0]!.name : `${selectedRepos.length} repositories`
  const hasOneRepo = selectedRepos.length === 1
  const repoOpenIdentity = hasOneRepo ? parseSource(visibleResult?.sources[selectedRepos[0]!.id]).origin : undefined
  const repoOpenUrl = repoOpenIdentity?.host && repoOpenIdentity.owner && repoOpenIdentity.repo
    ? `https://${repoOpenIdentity.host}/${repoOpenIdentity.owner}/${repoOpenIdentity.repo}`
    : ''
  const sourceContext = selectedSourceValues.length === 1
    ? sourceLabel(selectedSourceValues[0]!)
    : navigation.repoIds === null && !visibleResult ? 'Loading selected projects…'
      : selectedRepoIds.length > 0 ? `${selectedRepoIds.length} projects` : 'No projects selected'
  const hostContext = 'GitHub'
  const selectedIssueSource = issueSource.issueSource ?? 'origin'
  const originIdentity = issueSource.origin
  const distinctIssueSources = issueSource.candidates?.some((candidate) => {
    const identity = object(candidate)
    if (!identity || !originIdentity) return false
    return `${String(identity.host).toLowerCase()}/${String(identity.owner).toLowerCase()}/${String(identity.repo).toLowerCase()}` !== `${String(originIdentity.host).toLowerCase()}/${String(originIdentity.owner).toLowerCase()}/${String(originIdentity.repo).toLowerCase()}`
  }) ?? false
  const showIssueSource = mode === 'issues' && hasOneRepo && distinctIssueSources
  const unavailableCount = selectedSourceValues.filter((source) => source.status === 'unavailable' || source.status === 'unresolved').length
  const allUnavailable = selectedRepoIds.length > 0 && unavailableCount === selectedRepoIds.length
  const partialFailureCount = visibleResult?.failures.length ?? 0
  const sourceFailureCount = visibleResult?.failures.filter((failure) => failure.stage !== 'count').length ?? 0
  const countFailureCount = visibleResult?.failures.filter((failure) => failure.stage === 'count').length ?? 0
  const filterCount = countFilters(filters, kind)
  const pills = filterPills(filters, kind)
  const page = visibleResult?.page ?? navigation.page
  const totalPages = visibleResult?.totalPages ?? 1
  const tableRows = listItems.filter((item) => item.kind === kind)
  const statusOptions = kind === 'issue' ? ['open', 'closed', 'any'] : ['open', 'closed', 'merged', 'any']
  const localError = error

  return (
    <section aria-label="GitHub tasks" style={{ display: 'grid', gap: 12, minWidth: 0, color: 'var(--text, inherit)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--border, #555)' }}>
        <span aria-label="Task source context">{hostContext} · {userLabel()} · {sourceContext}</span>
        {selectedSourceValues.length > 1 ? <span>{selectedSourceValues.length} selected sources</span> : null}
        {issueSource.issueSourcePreference === 'upstream' && issueSource.issueSourceFellBack ? <span role="status">Upstream source fell back to origin</span> : null}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <button type="button" aria-haspopup="listbox" aria-expanded={repoOpen} onClick={() => setRepoOpen((open) => !open)}>{repoButtonLabel} ▾</button>
          {repoOpen ? (
            <div role="group" aria-label="Select repositories" style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, minWidth: 240, maxHeight: 320, overflow: 'auto', padding: 10, background: 'var(--surface, #222)', border: '1px solid var(--border, #555)', boxShadow: '0 8px 24px rgba(0,0,0,.3)' }}>
              <label style={{ display: 'flex', gap: 8, padding: 5 }}>
                <input type="checkbox" checked={navigation.repoIds === null && allRepoIds.length > 0} onChange={(event) => void selectRepositories(event.currentTarget.checked ? allRepoIds : [])} />
                <span>All repositories</span>
              </label>
              {result?.repositories.filter((repo) => repo.kind === 'git' && repo.path.trim().length > 0).map((repo) => (
                <label key={repo.id} style={{ display: 'flex', gap: 8, padding: 5 }}>
                  <input type="checkbox" checked={selectedSet.has(repo.id)} onChange={(event) => void selectRepositories(event.currentTarget.checked ? [...selectedRepoIds, repo.id] : selectedRepoIds.filter((id) => id !== repo.id))} />
                  <span>{repo.displayName || repo.name}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" disabled={!repoOpenUrl || selectedRepos.length !== 1} title={selectedRepos.length === 1 ? 'Open repository in GitHub' : 'Select one project to open in GitHub'} onClick={() => repoOpenUrl && openLink(repoOpenUrl)}>Open repository in GitHub</button>
        {showIssueSource ? (
          <div role="group" aria-label="Issue source" style={{ display: 'inline-flex', gap: 4 }}>
            <button type="button" aria-pressed={selectedIssueSource === 'upstream'} onClick={() => void changeRepoSource('upstream')}>Upstream</button>
            <button type="button" aria-pressed={selectedIssueSource === 'origin'} onClick={() => void changeRepoSource('origin')}>Origin</button>
          </div>
        ) : mode === 'issues' && selectedIssueSource === 'upstream' && hasOneRepo ? <span aria-label="Issues use upstream source">Issues from upstream</span> : null}
      </div>

      {allUnavailable ? (
        <div role="alert" style={{ color: 'var(--error, #dc2626)' }}>
          {visibleResult?.failures.map((failure) => failure.message).join(' · ') || 'GitHub source is unavailable. Check that gh is installed and authenticated, then refresh.'}
        </div>
      ) : null}
      {!allUnavailable && partialFailureCount > 0 ? (
        <div role="status" style={{ color: 'var(--warning, #b45309)' }}>
          {sourceFailureCount > 0 ? `${sourceFailureCount} selected source read${sourceFailureCount === 1 ? '' : 's'} failed. Showing available GitHub work; retry to reload.` : `${countFailureCount} result count${countFailureCount === 1 ? '' : 's'} unavailable. Full pages offer a continuation.`}
        </div>
      ) : null}
      {localError ? <div role="alert" style={{ color: 'var(--error, #dc2626)' }}>{localError}{visibleResult ? ' Showing the last loaded results.' : ''}</div> : null}
      {visibleResult?.failures.map((failure, index) => (
        <div key={`${failure.repoId}:${index}`} role="status" style={{ color: 'var(--warning, #b45309)' }}>
          {failure.reason === 'missing_origin' ? `No GitHub source detected for ${failure.repoId} — it may have no GitHub remote.` : `${failure.repoId}: ${failure.message}`}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="group" aria-label="Task presets" style={{ display: 'flex', gap: 6 }}>
          {presets.map((item) => (
            <button key={item.id} type="button" onClick={() => presetClick(item)} onContextMenu={(event) => void makeDefaultPreset(item, event)} title="Right-click to make this the default">
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
          Filters{filterCount > 0 ? ` (${filterCount})` : ''}
        </button>
        <label style={{ flex: '1 1 240px', minWidth: 180 }}>
          <span className="sr-only">Search GitHub {kind === 'issue' ? 'issues' : 'pull requests'}</span>
          <input
            data-tasks-search="true"
            aria-label={`Search GitHub ${kind === 'issue' ? 'issues' : 'pull requests'}`}
            placeholder={`Search GitHub ${kind === 'issue' ? 'issues' : 'PRs'}…`}
            value={searchDraft}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitSearch(event.currentTarget.value) } }}
            style={{ width: '100%', minWidth: 180 }}
          />
        </label>
        <button type="button" aria-label="Clear search" title="Clear search" onClick={() => commitSearch(presetQuery(normalizedPreset(state.preferences.defaultTaskViewPreset, kind), kind))}>×</button>
        {kind === 'issue' ? <button type="button" aria-label="New GitHub issue" disabled={selectedRepoIds.length === 0} onClick={() => void navigate({ newIssue: true })}>＋ New GitHub issue</button> : null}
        <button type="button" aria-label={refreshing ? 'Refreshing GitHub work' : 'Refresh GitHub work'} disabled={refreshing || selectedRepoIds.length === 0} onClick={() => void loadList(true, true)}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      </div>

      {pills.length > 0 ? (
        <div aria-label="Active task filters" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {pills.map((pill, index) => <button key={`${pill.category}:${pill.value ?? index}`} type="button" aria-label={`Remove ${pill.label} filter`} onClick={() => removeFilter(pill.category, pill.value)}>{pill.label} ×</button>)}
        </div>
      ) : null}

      {filtersOpen ? (
        <div role="dialog" aria-label="GitHub task filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, padding: 12, border: '1px solid var(--border, #555)', borderRadius: 8 }}>
          <label>
            <span>Status</span>
            <select value={filters.status || 'any'} onChange={(event) => setFilter('status', event.currentTarget.value === 'any' ? [] : [`is:${event.currentTarget.value}`, ...(filters.draftOnly ? ['is:draft'] : [])])}>
              {statusOptions.map((value) => <option key={value} value={value}>{value === 'any' ? 'Any state' : value[0]!.toUpperCase() + value.slice(1)}</option>)}
            </select>
          </label>
          {kind === 'prs' ? <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={filters.draftOnly} onChange={(event) => setFilter('status', [...(filters.status ? [`is:${filters.status}`] : []), ...(event.currentTarget.checked ? ['is:open', 'is:draft'] : [])])} />Draft only</label> : null}
          <label>
            <span>Author</span>
            <input list="tasks-authors" value={filterAuthorText || filters.author} onChange={(event) => setFilterAuthorText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setFilter('author', filterAuthorText ? [`author:${filterAuthorText}`] : []) } }} onBlur={() => { if (filterAuthorText) setFilter('author', [`author:${filterAuthorText}`]) }} placeholder="Filter or type a login…" />
            <datalist id="tasks-authors"><option value="@me" />{[...new Set(tableRows.flatMap((item) => item.author ? [item.author] : []))].map((value) => <option key={value} value={value} />)}</datalist>
          </label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Labels</legend>
            <div style={{ maxHeight: 120, overflow: 'auto' }}>
              {[...new Set([...repoLabels, ...tableRows.flatMap((item) => item.labels)])].sort().map((label) => <label key={label} style={{ display: 'block' }}><input type="checkbox" checked={filters.labels.includes(label)} onChange={(event) => toggleLabel(label, event.currentTarget.checked)} />{label}</label>)}
              {repoLabels.length === 0 && tableRows.every((item) => item.labels.length === 0) ? <span>No labels loaded.</span> : null}
            </div>
          </fieldset>
          <label>
            <span>Assignee</span>
            <select value={filters.assignee} onChange={(event) => setFilter('assignee', event.currentTarget.value ? [`assignee:${event.currentTarget.value}`] : [])}>
              <option value="">Any assignee</option><option value="@me">Current user</option>
              {[...new Set([...repoAssignees, ...tableRows.flatMap((item) => item.assignees)])].sort().map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {kind === 'prs' ? (
            <>
              <label>
                <span>Review from</span>
                <input value={filterReviewRequestedText || filters.reviewRequested} onChange={(event) => setFilterReviewRequestedText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setFilter('reviewRequested', filterReviewRequestedText ? [`review-requested:${filterReviewRequestedText}`] : []) } }} onBlur={() => { if (filterReviewRequestedText) setFilter('reviewRequested', [`review-requested:${filterReviewRequestedText}`]) }} placeholder="@me or login" />
              </label>
              <label>
                <span>Reviewed by</span>
                <input value={filterReviewedByText || filters.reviewedBy} onChange={(event) => setFilterReviewedByText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setFilter('reviewedBy', filterReviewedByText ? [`reviewed-by:${filterReviewedByText}`] : []) } }} onBlur={() => { if (filterReviewedByText) setFilter('reviewedBy', [`reviewed-by:${filterReviewedByText}`]) }} placeholder="@me or login" />
              </label>
            </>
          ) : null}
          <button type="button" onClick={() => { setFilter('all', []); setFiltersOpen(false) }}>Clear all filters</button>
        </div>
      ) : null}

      {loading && !visibleResult ? (
        <div role="status" aria-label="Loading GitHub tasks">{Array.from({ length: 12 }, (_, index) => <div key={index} style={{ height: 34, marginBlock: 5, borderRadius: 4, background: 'var(--surface-raised, #333)', opacity: .55 }} />)}</div>
      ) : visibleResult?.repositories.length === 0 ? (
        <div role="status"><strong>No eligible Git repositories</strong><p>Add or select a registered Git repository with a local path to load GitHub tasks.</p></div>
      ) : selectedRepoIds.length === 0 ? (
        <div role="status"><strong>No project sources selected</strong><p>Select at least one project source so Quirky knows where to fetch GitHub tasks.</p></div>
      ) : visibleResult && tableRows.length === 0 && visibleResult.failures.every((failure) => failure.stage === 'count') ? (
        <div role="status"><strong>No matching GitHub work</strong><p>Change the query or clear it.</p></div>
      ) : tableRows.length === 0 && visibleResult?.failures.length ? (
        <div role="alert">GitHub data is temporarily unavailable. Its API may be down, rate-limited, or unreachable. Retry shortly.</div>
      ) : (
        <div style={{ overflow: 'auto', maxHeight: 'min(70vh, 900px)', border: '1px solid var(--border, #555)', borderRadius: 8 }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: kind === 'issue' ? 860 : 1120, width: '100%' }}>
            <thead>
              <tr>
                <th scope="col" style={{ position: 'sticky', top: 0, left: 0, zIndex: 5, background: 'var(--surface, #222)', textAlign: 'left' }}>ID</th>
                <th scope="col" style={{ position: 'sticky', top: 0, left: 74, zIndex: 5, background: 'var(--surface, #222)', textAlign: 'left', minWidth: 350 }}>Title / Context</th>
                {kind === 'issue' ? <><th scope="col" style={{ position: 'sticky', top: 0, background: 'var(--surface, #222)' }}>Assignees</th><th scope="col" style={{ position: 'sticky', top: 0, background: 'var(--surface, #222)' }}>Status</th></> : <><th scope="col" style={{ position: 'sticky', top: 0, background: 'var(--surface, #222)' }}>Reviewers</th><th scope="col" style={{ position: 'sticky', top: 0, background: 'var(--surface, #222)' }}>Checks</th><th scope="col" style={{ position: 'sticky', top: 0, background: 'var(--surface, #222)' }}>Merge</th></>}
                <th scope="col" style={{ position: 'sticky', top: 0, background: 'var(--surface, #222)' }}>Updated</th>
                <th scope="col" style={{ position: 'sticky', top: 0, right: 0, zIndex: 5, background: 'var(--surface, #222)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((item) => {
                const key = rowKey(item)
                const busy = busyRows[key] === true
                const when = relativeTime(item.updatedAt)
                const linked = object(item.linkedWorkspace)
                const check = checkSummary(checks[key], checksLoading[key] === true)
                const meta = mergeMetadata[key]
                const review = meta?.review
                const displayState = item.state === 'unknown' ? reviewState(review?.state) ?? item.state : item.state
                const reviewDraft = typeof review?.isDraft === 'boolean' ? review.isDraft : reviewState(review?.state) === 'draft' ? true : undefined
                const displayIsDraft = reviewDraft ?? item.isDraft
                const additions = typeof item.additions === 'number' ? item.additions : nonnegativeInteger(review?.additions)
                const deletions = typeof item.deletions === 'number' ? item.deletions : nonnegativeInteger(review?.deletions)
                const changedFiles = typeof item.changedFiles === 'number' ? item.changedFiles : nonnegativeInteger(review?.changedFiles)
                const reviewDecision = typeof item.reviewDecision === 'string'
                  ? item.reviewDecision
                  : typeof review?.reviewDecision === 'string' ? review.reviewDecision : undefined
                const requestedReviewers = optionalLogins(review?.requestedReviewers)
                const reviewHistoryAuthors = reviewAuthors(review?.reviews)
                const pullRequestAssignees = optionalLogins(review?.assignees)
                const reviewerLabel = requestedReviewers === null
                  ? 'Requested reviewers unavailable'
                  : requestedReviewers?.length
                    ? requestedReviewers.join(', ')
                    : reviewDecision && reviewDecision !== 'NONE' ? reviewDecision : 'Reviewers'
                const reviewerInfoUnknown = requestedReviewers === null || reviewHistoryAuthors === null || pullRequestAssignees === null
                const autoMergeAvailable = meta?.autoMergeEnabled === true || meta?.autoMergeEnableEligible === true
                const isStatusOpen = statusFor === key
                const isDuplicate = duplicateFor === key
                const isAssigneesOpen = assigneesFor === key
                const isReviewersOpen = reviewersFor === key
                const reviewSuggestions = reviewerOptions[key]
                const recentReviewers = [...new Set([
                  ...(reviewSuggestions?.recentlyActive ?? []),
                  ...(reviewHistoryAuthors ?? [])
                ])].filter((login) => !requestedReviewers?.includes(login))
                const suggestedReviewers = [...new Set([
                  ...(reviewSuggestions?.suggestions ?? []),
                  ...(pullRequestAssignees ?? [])
                ])].filter((login) => !recentReviewers.includes(login) && !requestedReviewers?.includes(login))
                const isMergeOpen = mergeFor === key
                const mergedSelectedCount = selectedRepoIds.length > 1
                return (
                  <tr key={key} data-review-key={kind === 'pullRequest' ? key : undefined} tabIndex={0} onMouseEnter={() => kind === 'pullRequest' && void loadMergeMetadata(item)} onFocusCapture={() => kind === 'pullRequest' && void loadMergeMetadata(item)} onClick={() => onRow(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRow(item) } }} style={{ cursor: 'pointer', borderTop: '1px solid var(--border, #444)' }}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface, #222)', whiteSpace: 'nowrap', padding: 8 }}>
                      <span aria-label={kind === 'issue' ? 'Issue' : displayIsDraft ? 'Draft pull request' : 'Pull request'}>{kind === 'issue' ? 'I' : displayIsDraft ? 'D' : 'PR'}</span> <strong>#{item.number}</strong>
                    </td>
                    <td style={{ position: 'sticky', left: 74, zIndex: 2, background: 'var(--surface, #222)', padding: 8, minWidth: 350 }}>
                      <strong>{item.title}</strong>
                      {displayState !== 'open' && !(kind === 'pullRequest' && displayIsDraft) ? <span style={{ marginInlineStart: 7, opacity: .75 }}>{displayState}</span> : null}
                      {displayIsDraft ? <span style={{ marginInlineStart: 7, opacity: .75 }}>Draft</span> : null}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: '.88em', opacity: .78, marginTop: 4 }}>
                        <span>{item.author ?? 'unknown author'}</span>
                        {mergedSelectedCount ? <span>{item.repoName}</span> : null}
                        {item.labels.slice(0, 3).map((label) => <span key={label}>#{label}</span>)}
                        {kind === 'prs' && (additions !== undefined || deletions !== undefined || changedFiles !== undefined) ? <span>{additions !== undefined ? `+${additions}` : ''}{additions !== undefined && deletions !== undefined ? ' ' : ''}{deletions !== undefined ? `−${deletions}` : ''}{(additions !== undefined || deletions !== undefined) && changedFiles !== undefined ? ' ' : ''}{changedFiles !== undefined ? `${changedFiles} files` : ''}</span> : null}
                        {linked && typeof linked.name === 'string' ? <span>▰ {linked.name}</span> : null}
                        {optimistic[key]?.keepVisible ? <span role="status">Pending refresh</span> : null}
                      </div>
                    </td>
                    {kind === 'issue' ? (
                      <>
                        <td onClick={stop} onKeyDown={stop} style={{ padding: 8 }}>
                          <button type="button" aria-haspopup="dialog" aria-expanded={isAssigneesOpen} onClick={() => void openAssignees(item)}>{item.assignees.join(', ') || 'Assign issue'}</button>
                          {isAssigneesOpen ? <div role="dialog" aria-label="Assign issue" style={{ position: 'absolute', zIndex: 20, padding: 10, background: 'var(--surface, #222)', border: '1px solid var(--border, #555)' }}>
                            <strong>Assign issue</strong>
                            <button type="button" onClick={() => void saveAssignees(item)} disabled={busy}>Save assignees</button>
                            <button type="button" onClick={() => setAssigneesFor(null)}>Cancel</button>
                          </div> : null}
                        </td>
                        <td onClick={stop} onKeyDown={stop} style={{ padding: 8 }}>
                          <button type="button" aria-haspopup="menu" aria-expanded={isStatusOpen} onClick={() => setStatusFor((current) => current === key ? null : key)}>{item.state === 'closed' ? 'Closed' : 'Open'} ▾</button>
                          {isStatusOpen ? <div role="menu" aria-label={`Issue #${item.number} status`} style={{ position: 'absolute', zIndex: 20, display: 'grid', padding: 8, background: 'var(--surface, #222)', border: '1px solid var(--border, #555)' }}>
                            <button type="button" role="menuitem" disabled={busy || item.state === 'open'} onClick={() => void setStatus(item, 'open')}>Open</button>
                            <button type="button" role="menuitem" disabled={busy || item.state === 'closed'} onClick={() => void setStatus(item, 'closed', 'completed')}>Close as completed</button>
                            <button type="button" role="menuitem" disabled={busy || item.state === 'closed'} onClick={() => void setStatus(item, 'closed', 'not_planned')}>Close as not planned</button>
                            <button type="button" role="menuitem" disabled={busy || item.state === 'closed'} onClick={() => { setDuplicateFor(key); setDuplicateText('') }}>Close as duplicate…</button>
                            {isDuplicate ? <div role="group" aria-label="Duplicate issue target">
                              <label>Search issues<input aria-label="Search issues" value={duplicateText} onChange={(event) => setDuplicateText(event.currentTarget.value)} /></label>
                              {/^\d+$/u.test(duplicateText) ? <button type="button" onClick={() => {
                                const number = Number(duplicateText)
                                if (!Number.isSafeInteger(number) || number < 1) { setError('Use a positive issue number.'); return }
                                if (number === item.number) { setError('Choose a different issue.'); return }
                                void setStatus(item, 'closed', 'duplicate', number)
                              }}>Use issue #{duplicateText}</button> : duplicateText.length > 0 ? <span role="status">Use a whole issue number.</span> : null}
                            </div> : null}
                          </div> : null}
                        </td>
                      </>
                    ) : (
                      <>
                        <td onClick={stop} onKeyDown={stop} style={{ padding: 8 }}>
                          <button type="button" aria-haspopup="dialog" aria-expanded={isReviewersOpen} onClick={() => void openReviewers(item)}>{reviewerLabel}</button>
                          {isReviewersOpen ? <div role="dialog" aria-label={`Reviewers for PR #${item.number}`} style={{ position: 'absolute', zIndex: 20, display: 'grid', gap: 6, padding: 10, background: 'var(--surface, #222)', border: '1px solid var(--border, #555)' }}>
                            {requestedReviewers === null ? <span role="status">Requested reviewers are unavailable.</span> : requestedReviewers?.length ? <span>Currently requested: {requestedReviewers.join(', ')}</span> : null}
                            {review?.reviews === null ? <span role="status">Review history is unavailable.</span> : null}
                            {review?.assignees === null ? <span role="status">Pull-request assignees are unavailable.</span> : null}
                            {review?.participantsTruncated === true ? <span role="status">Recent reviewer activity is incomplete.</span> : null}
                            {!reviewSuggestions ? <span role="status">Loading reviewer suggestions…</span> : null}
                            {recentReviewers.length > 0 ? <fieldset><legend>Recently active in this pull request</legend>{recentReviewers.map((login) => <button key={login} type="button" onClick={() => addReviewerOption(login)}>{login}</button>)}</fieldset> : null}
                            {suggestedReviewers.length > 0 ? <fieldset><legend>Suggestions</legend>{suggestedReviewers.map((login) => <button key={login} type="button" onClick={() => addReviewerOption(login)}>{login}</button>)}</fieldset> : null}
                            {reviewSuggestions && recentReviewers.length === 0 && suggestedReviewers.length === 0 && !reviewerInfoUnknown ? <span role="status">No matching reviewers.</span> : null}
                            <label><span>Everyone else</span><textarea aria-label="Type or choose a reviewer" value={reviewerText} onChange={(event) => { const value = event.currentTarget.value; if (new TextEncoder().encode(value).byteLength <= 2048) setReviewerText(value); else setError('Reviewer input exceeds the 2048-byte limit.') }} placeholder="Type or choose a user" /></label>
                            <button type="button" disabled={busy} onClick={() => void saveReviewers(item, 'add')}>Request reviewers</button>
                            <button type="button" disabled={busy} onClick={() => void saveReviewers(item, 'remove')}>Remove reviewers</button>
                            <button type="button" onClick={() => setReviewersFor(null)}>Close</button>
                          </div> : null}
                        </td>
                        <td onClick={stop} onKeyDown={stop} style={{ padding: 8 }}>
                          <button data-check-key={key} type="button" aria-label={`Checks for PR #${item.number}: ${check.label}`} onMouseEnter={() => void loadChecks(item)} onFocus={() => void loadChecks(item)} onClick={() => void openReview(rowTarget(item), 'checks')}>
                            <span data-tone={check.tone}>{check.label}</span>
                          </button>
                        </td>
                        <td onClick={stop} onKeyDown={stop} style={{ padding: 8 }}>
                          <div style={{ position: 'relative' }}>
                            <button type="button" aria-haspopup="menu" aria-expanded={isMergeOpen} aria-label={mergeErrors[key] ? `Merge metadata unavailable for PR #${item.number}` : `Merge actions for PR #${item.number}`} onClick={() => toggleMergeMenu(item)} disabled={busy}>{mergeErrors[key] ? 'Merge metadata unavailable' : displayState === 'merged' ? 'Merged' : meta?.queueEligible ? 'Merge when ready' : meta?.mergeEligible ? 'Merge' : 'Check merge safety'} ▾</button>
                            {isMergeOpen ? <div role="menu" aria-label={`Merge PR #${item.number}`} style={{ position: 'absolute', zIndex: 20, display: 'grid', minWidth: 220, padding: 8, background: 'var(--surface, #222)', border: '1px solid var(--border, #555)' }}>
                              {mergeLoading[key] ? <span role="status">Loading merge metadata…</span> : null}
                              {!mergeLoading[key] && !meta && !mergeErrors[key] ? <span role="status">Review metadata has not loaded.</span> : null}
                              {meta?.mergeQueueRequired === true && meta.queueEligible ? meta.queueMethods.map((method) => <button key={method} type="button" role="menuitem" disabled={busy} onClick={() => void mergeItem(item, method, 'queue')}>{`Merge when ready (${method})`}</button>) : null}
                              {meta?.mergeQueueRequired === false && meta.mergeEligible ? meta.directMethods.map((method) => <button key={method} type="button" role="menuitem" disabled={busy} onClick={() => void mergeItem(item, method, 'direct')}>{method === 'squash' ? 'Squash and merge' : method === 'merge' ? 'Create merge commit' : 'Rebase and merge'}</button>) : null}
                              {meta && !meta.mergeMetadataKnown ? <span>GitHub has not confirmed merge-queue safety metadata.</span> : null}
                              {meta?.mergeMetadataKnown && meta.mergeQueueRequired === null ? <span>Merge-queue requirement is unknown; refresh before merging.</span> : null}
                              {meta?.mergeQueueRequired === false && !meta.mergeEligible ? <span>Direct merge is not confirmed safe.</span> : null}
                              {meta && !meta.autoMergeEnabled && meta.autoMergeAllowed === null ? <span>Auto-merge capability is unknown.</span> : null}
                              {meta?.autoMergeAllowed === false && !meta.autoMergeEnabled ? <span>GitHub has disabled auto-merge for this repository.</span> : null}
                              {autoMergeAvailable ? <button type="button" role="menuitem" onClick={() => void toggleAutoMerge(item)}>{meta?.autoMergeEnabled ? 'Disable auto-merge' : meta?.mergeQueueRequired ? 'Merge when ready' : 'Enable auto-merge'}</button> : null}
                              <button type="button" role="menuitem" onClick={() => openLink(item.url)}>Open on GitHub</button>
                            </div> : null}
                            {mergeErrors[key] ? <span role="status">Review metadata unavailable: {mergeErrors[key]} <button type="button" onClick={() => void loadMergeMetadata(item)}>Retry</button></span> : null}
                          </div>
                        </td>
                      </>
                    )}
                    <td title={when.absolute} style={{ padding: 8, whiteSpace: 'nowrap' }}>{when.label}</td>
                    <td onClick={stop} onKeyDown={stop} style={{ position: 'sticky', right: 0, zIndex: 2, background: 'var(--surface, #222)', padding: 8, whiteSpace: 'nowrap' }}>
                      <button type="button" disabled={busy} onClick={() => void context.call('quirky.tasks/workspace', { target: rowTarget(item), action: linked ? 'resume' : 'start' }).catch((cause) => setError(errorMessage(cause)))}>{linked ? 'Resume' : 'Start'}</button>
                      {linked ? <button type="button" onClick={() => void context.call('quirky.tasks/workspace', { target: rowTarget(item), action: 'start', newWorkspace: true }).catch((cause) => setError(errorMessage(cause)))}>Start new</button> : null}
                      <button type="button" aria-label={`Open ${kind === 'issue' ? 'issue' : 'pull request'} #${item.number} on GitHub`} onClick={(event) => openInGitHub(event, item.url)}>↗</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {visibleResult && visibleResult.totalPages > 1 ? (
        <nav aria-label="GitHub task pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <button type="button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => goToPage(page - 1)}>Previous</button>
          {pageNumbers(page, totalPages).map((number, index) => number === 'ellipsis'
            ? <span key={`ellipsis-${index}`} aria-hidden="true">…</span>
            : <button key={number} type="button" aria-current={page === number ? 'page' : undefined} disabled={loading} onClick={() => goToPage(number)}>{number}</button>)}
          <button type="button" aria-label="Next page" disabled={loading || page >= totalPages} onClick={() => goToPage(page + 1)}>Next</button>
        </nav>
      ) : null}
    </section>
  )
}
