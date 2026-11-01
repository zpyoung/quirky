import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, EmptyState, FormRow, IconButton, Tabs, TextField } from '@quirky/ui'
import type { ItemKind, ItemTarget, TasksSurfaceProps } from '../contracts'
import { queryForKind } from './search'
import {
  checkResult, checkSummary, countFilters, currentPreset, errorMessage, filterPills, filtersFromQuery, mergeMeta, nonnegativeInteger,
  normalizedPreset, object, optionalLogins, parseListResult, parseSource, presetQuery, relativeTime, replaceFilters, reviewAuthors,
  reviewState, rowKey, rowTarget, strings,
  type CheckResult, type ListData, type ListItem, type ListSource, type MergeMetadata, type Preset
} from './model'
import { useReviewNavigation } from './useReviewNavigation'

export { WorkspaceComposer } from './WorkspaceComposer'
export { useReviewNavigation } from './useReviewNavigation'

type OptimisticRow = { item: ListItem; patch: Partial<ListItem>; generation: number; keepVisible: boolean }
type ReviewerOptions = { recentlyActive: string[]; suggestions: string[] }

function assigneeChoiceKey(item: ListItem, source: ListSource): string {
  const identity = source.issueRepository
  if (!identity?.host || !identity.owner || !identity.repo) return `${item.repoId}\u0000${item.url}`
  return `${item.repoId}\u0000${identity.host.toLowerCase()}/${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}`
}

function stop(event: { stopPropagation(): void }): void {
  event.stopPropagation()
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
  const viewKey = useRef('')
  const viewGeneration = useRef(0)
  const checkReadGenerations = useRef(new Map<string, number>())
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
  if (viewKey.current !== currentKey) {
    viewKey.current = currentKey
    viewGeneration.current += 1
  }
  const currentViewGeneration = viewGeneration.current
  const invalidateViewGeneration = () => {
    viewKey.current = currentKey
    viewGeneration.current += 1
  }
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
    const ownerGeneration = viewGeneration.current
    const ownsRequest = () => generation === fetchGeneration.current && latestKey.current === key && viewGeneration.current === ownerGeneration
    if (deliberate) {
      setOptimistic((previous) => Object.fromEntries(Object.entries(previous).filter(([, pending]) => !pending.keepVisible)))
      checkTriggered.current.clear()
      setChecks({})
    }
    setLoading(true)
    if (noCache) setRefreshing(true)
    try {
      const loaded = await fetchList(noCache)
      if (!ownsRequest()) return
      setResult(loaded)
      setResultKey(key)
      setError(null)
    } catch (cause) {
      if (!ownsRequest()) return
      setError(errorMessage(cause))
      if (resultKey !== key) setResult(null)
    } finally {
      if (ownsRequest()) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [currentKey, fetchList, navigation.mode, resultKey])

  useEffect(() => {
    void loadList()
  }, [loadList])
  useEffect(() => {
    checkTriggered.current.clear()
    setChecks({})
    setChecksLoading({})
    setMergeLoading({})
  }, [currentKey])

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

  const startQuietAdoption = (item: ListItem, generation: number, patch: Partial<ListItem>, key: string, ownerGeneration: number) => {
    const ownsView = () => viewGeneration.current === ownerGeneration && latestKey.current === key
    const ownsMutation = () => mutationGenerations.current.get(rowKey(item)) === generation && ownsView()
    const run = async () => {
      for (const delay of quietAdoptionDelays) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, delay)
        await promise
        if (!ownsMutation()) return
        try {
          const fresh = await fetchList(true)
          if (!ownsMutation()) return
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
          if (ownsMutation()) setError(errorMessage(cause))
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
    const ownerGeneration = currentViewGeneration
    const prior = optimistic[key]
    const baseItem = prior?.item ?? item
    const cumulativePatch = { ...(prior?.patch ?? {}), ...patch }
    const cumulativeKeepVisible = keepVisible || prior?.keepVisible === true
    const ownsView = () => viewGeneration.current === ownerGeneration && latestKey.current === contextKey
    fetchGeneration.current += 1
    setMergeLoading((previous) => ({ ...previous, [key]: false }))
    setBusy(key, true)
    setOptimistic((previous) => {
      const current = previous[key]
      return {
        ...previous,
        [key]: {
          item: current?.item ?? baseItem,
          patch: { ...(current?.patch ?? prior?.patch ?? {}), ...patch },
          generation,
          keepVisible: keepVisible || current?.keepVisible === true || prior?.keepVisible === true
        }
      }
    })
    try {
      const result = await context.call('quirky.tasks/row', { target: rowTarget(item), ...action, ...(action.action === 'merge' ? { yes: true } : {}) })
      if (mutationGenerations.current.get(key) !== generation || !ownsView()) return result
      const response = object(result)
      const confirmedPatch = action.action === 'issueStatus'
        ? absolutePatch(response?.item)
        : action.action === 'merge' && response?.kind === 'merged'
          ? { state: 'merged' as const }
          : {}
      const finalPatch = { ...cumulativePatch, ...confirmedPatch }
      setOptimistic((previous) => {
        const current = previous[key]
        return {
          ...previous,
          [key]: {
            item: current?.item ?? baseItem,
            patch: { ...(current?.patch ?? cumulativePatch), ...confirmedPatch },
            generation,
            keepVisible: current?.keepVisible === true || cumulativeKeepVisible
          }
        }
      })
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
      startQuietAdoption(baseItem, generation, finalPatch, contextKey, ownerGeneration)
      void refresh().catch((cause) => { if (ownsView()) setError(errorMessage(cause)) })
      return result
    } catch (cause) {
      if (mutationGenerations.current.get(key) === generation && ownsView()) {
        if (prior && Object.keys(prior.patch).length > 0) {
          setOptimistic((previous) => {
            if (previous[key]?.generation !== generation) return previous
            return { ...previous, [key]: { ...prior, generation } }
          })
          startQuietAdoption(prior.item, generation, prior.patch, contextKey, ownerGeneration)
        } else {
          setOptimistic((previous) => {
            if (previous[key]?.generation !== generation) return previous
            const next = { ...previous }
            delete next[key]
            return next
          })
        }
        setError(errorMessage(cause))
      }
      throw cause
    } finally {
      if (mutationGenerations.current.get(key) === generation) {
        mutationInFlight.current.delete(key)
        setBusy(key, false)
        if (!ownsView()) {
          setOptimistic((previous) => {
            if (previous[key]?.generation !== generation) return previous
            const next = { ...previous }
            delete next[key]
            return next
          })
        }
      }
    }
  }


  const loadChecks = useCallback(async (item: ListItem) => {
    const key = rowKey(item)
    if (checkTriggered.current.has(key)) return
    checkTriggered.current.add(key)
    const owner = currentKey
    const ownerGeneration = currentViewGeneration
    const requestGeneration = (checkReadGenerations.current.get(key) ?? 0) + 1
    checkReadGenerations.current.set(key, requestGeneration)
    const ownsRead = () => checkReadGenerations.current.get(key) === requestGeneration
      && viewGeneration.current === ownerGeneration
      && latestKey.current === owner
    setChecksLoading((previous) => ({ ...previous, [key]: true }))
    try {
      const value = await context.call('quirky.tasks/checks', { target: rowTarget(item) })
      if (!ownsRead()) return
      const parsed = checkResult(value)
      if (parsed) setChecks((previous) => ({ ...previous, [key]: parsed }))
      else setChecks((previous) => ({ ...previous, [key]: { rollup: 'unknown', checks: [], partial: true, partialFailures: ['Invalid check result.'] } }))
    } catch (cause) {
      if (ownsRead()) {
        setError(errorMessage(cause))
        checkTriggered.current.delete(key)
      }
    } finally {
      if (ownsRead()) setChecksLoading((previous) => ({ ...previous, [key]: false }))
    }
  }, [context, currentKey, currentViewGeneration])
  const loadMergeMetadata = useCallback(async (item: ListItem) => {
    const key = rowKey(item)
    const owner = `${currentViewGeneration}\u0000${currentKey}`
    if (mergeMetadataRef.current[key] || mutationInFlight.current.has(key) || mergeReadOwners.current.get(key) === owner) return
    const generation = (mergeReadGenerations.current.get(key) ?? 0) + 1
    mergeReadGenerations.current.set(key, generation)
    mergeReadOwners.current.set(key, owner)
    const mutationGeneration = mutationGenerations.current.get(key) ?? 0
    const ownsRead = () => mergeReadGenerations.current.get(key) === generation
      && mergeReadOwners.current.get(key) === owner
      && viewGeneration.current === currentViewGeneration
      && latestKey.current === currentKey
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
        if (viewGeneration.current === currentViewGeneration && latestKey.current === currentKey) {
          setMergeLoading((previous) => ({ ...previous, [key]: false }))
        }
      }
    }
  }, [context, currentKey, currentViewGeneration])

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
    const choicesKey = assigneeChoiceKey(item, parseSource(visibleResult?.sources[item.repoId]))
    setAssigneesFor((current) => current === key ? null : key)
    setAssigneeDraft([...item.assignees])
    if (Object.hasOwn(assigneeChoices, choicesKey)) return
    const ownerKey = currentKey
    const ownerGeneration = viewGeneration.current
    const ownsRead = () => viewGeneration.current === ownerGeneration && latestKey.current === ownerKey
    try {
      const result = object(await context.call('quirky.tasks/options', { repoId: item.repoId, kind: 'assignees' }))
      if (!ownsRead()) return
      const values = Array.isArray(result?.assignees) ? result.assignees.flatMap((entry) => {
        const value = object(entry)
        return typeof value?.login === 'string' ? [value.login] : []
      }) : []
      setAssigneeChoices((previous) => ({ ...previous, [choicesKey]: values }))
    } catch (cause) {
      if (!ownsRead()) return
      setAssigneeChoices((previous) => ({ ...previous, [choicesKey]: [] }))
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
    const ownerKey = currentKey
    const ownerGeneration = viewGeneration.current
    const ownsRead = () => viewGeneration.current === ownerGeneration && latestKey.current === ownerKey
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
      if (!ownsRead()) return
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
      if (ownsRead()) setError(errorMessage(cause))
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
    invalidateViewGeneration()
    setAssigneeChoices({})
    try {
      await context.call('quirky.tasks/row', { target, action: 'issueSource', preference })
      invalidateViewGeneration()
      setAssigneeChoices({})
      await loadList(true)
    } catch (cause) {
      invalidateViewGeneration()
      setAssigneeChoices({})
      await loadList(true)
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
  const noGitHubRemote = selectedRepoIds.length > 0 &&
    selectedRepos.length === selectedRepoIds.length &&
    selectedSourceValues.every((source) => source.reason === 'missing_origin')
  const repoButtonLabel = selectedRepoIds.length === allRepoIds.length && navigation.repoIds === null
    ? 'All repositories'
    : selectedRepos.length === 1 ? selectedRepos[0]!.displayName || selectedRepos[0]!.name : `${selectedRepos.length} repositories`
  const hasOneRepo = selectedRepos.length === 1
  const repoOpenIdentity = hasOneRepo ? parseSource(visibleResult?.sources[selectedRepos[0]!.id]).origin : undefined
  const repoOpenUrl = repoOpenIdentity?.host && repoOpenIdentity.owner && repoOpenIdentity.repo
    ? `https://${repoOpenIdentity.host}/${repoOpenIdentity.owner}/${repoOpenIdentity.repo}`
    : ''
  const sourceContext = noGitHubRemote
    ? selectedRepos.map((repo) => repo.displayName || repo.name).join(', ')
    : selectedSourceValues.length === 1
      ? sourceLabel(selectedSourceValues[0]!)
      : navigation.repoIds === null && !visibleResult ? 'Loading selected projects…'
        : selectedRepoIds.length > 0 ? `${selectedRepoIds.length} projects` : 'No projects selected'
  const hostContext = 'GitHub'
  const noGitHubRemoteMessage = selectedRepos.length === 1
    ? `No GitHub remote is configured for ${selectedRepos[0]!.displayName || selectedRepos[0]!.name}. Add a GitHub remote to this repository to load GitHub tasks.`
    : `No GitHub remotes are configured for the selected ${selectedRepos.length} repositories. Add a GitHub remote to each repository to load GitHub tasks.`
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
    <section className="tasks-list" data-kind={kind} aria-label="GitHub tasks">
      {noGitHubRemote ? (
        <div role="status" className="tasks-list__empty"><EmptyState message={noGitHubRemoteMessage} /></div>
      ) : null}
      <div className="tasks-list__context">
        <span aria-label="Task source context">{hostContext} · {userLabel()} · {sourceContext}</span>
        {selectedSourceValues.length > 1 ? <span>{selectedSourceValues.length} selected sources</span> : null}
        {issueSource.issueSourcePreference === 'upstream' && issueSource.issueSourceFellBack ? <span role="status">Upstream source fell back to origin</span> : null}
      </div>

      <div className="tasks-list__repository-controls">
        <div className="tasks-list__repo-picker">
          <Button type="button" aria-haspopup="listbox" aria-expanded={repoOpen} onClick={() => setRepoOpen((open) => !open)}>{repoButtonLabel} ▾</Button>
          {repoOpen ? (
            <div role="group" aria-label="Select repositories" className="tasks-list__repo-menu">
              <label className="tasks-list__check-option">
                <input type="checkbox" checked={navigation.repoIds === null && allRepoIds.length > 0} onChange={(event) => void selectRepositories(event.currentTarget.checked ? allRepoIds : [])} />
                <span>All repositories</span>
              </label>
              {result?.repositories.filter((repo) => repo.kind === 'git' && repo.path.trim().length > 0).map((repo) => (
                <label key={repo.id} className="tasks-list__check-option">
                  <input type="checkbox" checked={selectedSet.has(repo.id)} onChange={(event) => void selectRepositories(event.currentTarget.checked ? [...selectedRepoIds, repo.id] : selectedRepoIds.filter((id) => id !== repo.id))} />
                  <span>{repo.displayName || repo.name}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
        {!noGitHubRemote ? <Button type="button" disabled={!repoOpenUrl || selectedRepos.length !== 1} title={selectedRepos.length === 1 ? 'Open repository in GitHub' : 'Select one project to open in GitHub'} onClick={() => repoOpenUrl && openLink(repoOpenUrl)}>Open repository in GitHub</Button> : null}
        {showIssueSource ? (
          <Tabs
            label="Issue source"
            items={[{ id: 'upstream', label: 'Upstream' }, { id: 'origin', label: 'Origin' }]}
            value={selectedIssueSource}
            onChange={(id) => { if (id === 'upstream' || id === 'origin') void changeRepoSource(id) }}
          />
        ) : mode === 'issues' && selectedIssueSource === 'upstream' && hasOneRepo ? <span aria-label="Issues use upstream source">Issues from upstream</span> : null}
      </div>

      {allUnavailable && !noGitHubRemote ? (
        <div role="alert" className="tasks-list__notice tasks-list__notice--error">
          {visibleResult?.failures.map((failure) => failure.message).join(' · ') || 'GitHub source is unavailable. Check that gh is installed and authenticated, then refresh.'}
        </div>
      ) : null}
      {!noGitHubRemote && !allUnavailable && partialFailureCount > 0 ? (
        <div role="status" className="tasks-list__notice tasks-list__notice--warning">
          {sourceFailureCount > 0 ? `${sourceFailureCount} selected source read${sourceFailureCount === 1 ? '' : 's'} failed. Showing available GitHub work; retry to reload.` : `${countFailureCount} result count${countFailureCount === 1 ? '' : 's'} unavailable. Full pages offer a continuation.`}
        </div>
      ) : null}
      {localError ? <div role="alert" className="tasks-list__notice tasks-list__notice--error">{localError}{visibleResult ? ' Showing the last loaded results.' : ''}</div> : null}
      {!noGitHubRemote ? visibleResult?.failures.map((failure, index) => (
        <div key={`${failure.repoId}:${index}`} role="status" className="tasks-list__notice tasks-list__notice--warning">
          {failure.reason === 'missing_origin' ? `No GitHub source detected for ${failure.repoId} — it may have no GitHub remote.` : `${failure.repoId}: ${failure.message}`}
        </div>
      )) : null}

      <div className="tasks-list__toolbar">
        {!noGitHubRemote ? (
          <>
            <div role="group" aria-label="Task presets" className="tasks-list__presets">
              {presets.map((item) => (
                <Button key={item.id} type="button" onClick={() => presetClick(item)} onContextMenu={(event) => void makeDefaultPreset(item, event)} title="Right-click to make this the default">{item.label}</Button>
              ))}
            </div>
            <Button type="button" aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
              Filters{filterCount > 0 ? ` (${filterCount})` : ''}</Button>
            <TextField
              label={`Search GitHub ${kind === 'issue' ? 'issues' : 'pull requests'}`}
              data-tasks-search="true"
              aria-label={`Search GitHub ${kind === 'issue' ? 'issues' : 'pull requests'}`}
              placeholder={`Search GitHub ${kind === 'issue' ? 'issues' : 'PRs'}…`}
              value={searchDraft}
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitSearch(event.currentTarget.value) } }}
              className="tasks-list__search-input"
            />
            <IconButton type="button" label="Clear search" title="Clear search" onClick={() => commitSearch(presetQuery(normalizedPreset(state.preferences.defaultTaskViewPreset, kind), kind))}>×</IconButton>
            {kind === 'issue' ? <Button variant="primary" type="button" aria-label="New GitHub issue" disabled={selectedRepoIds.length === 0} onClick={() => void navigate({ newIssue: true })}>＋ New GitHub issue</Button> : null}
          </>
        ) : null}
        <Button type="button" aria-label={refreshing ? 'Refreshing GitHub work' : 'Refresh GitHub work'} disabled={refreshing || selectedRepoIds.length === 0} onClick={() => void loadList(true, true)}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
      </div>

      {!noGitHubRemote ? (
        <>
          {pills.length > 0 ? (
            <div aria-label="Active task filters" className="tasks-list__filter-pills">
              {pills.map((pill, index) => <Button key={`${pill.category}:${pill.value ?? index}`} type="button" aria-label={`Remove ${pill.label} filter`} onClick={() => removeFilter(pill.category, pill.value)}>{pill.label} ×</Button>)}
            </div>
          ) : null}

          {filtersOpen ? (
            <div role="dialog" aria-label="GitHub task filters" className="tasks-list__filters">
              <FormRow label="Status" htmlFor="tasks-list-status-filter">
                <select id="tasks-list-status-filter" className="ui-text-field__input" value={filters.status || 'any'} onChange={(event) => setFilter('status', event.currentTarget.value === 'any' ? [] : [`is:${event.currentTarget.value}`, ...(filters.draftOnly ? ['is:draft'] : [])])}>
                  {statusOptions.map((value) => <option key={value} value={value}>{value === 'any' ? 'Any state' : value[0]!.toUpperCase() + value.slice(1)}</option>)}
                </select>
              </FormRow>
              {kind === 'pullRequest' ? <label className="tasks-list__check-option"><input type="checkbox" checked={filters.draftOnly} onChange={(event) => setFilter('status', [...(filters.status ? [`is:${filters.status}`] : []), ...(event.currentTarget.checked ? ['is:open', 'is:draft'] : [])])} />Draft only</label> : null}
              <FormRow label="Author" htmlFor="tasks-list-author-filter">
                <>
                  <input id="tasks-list-author-filter" className="ui-text-field__input" list="tasks-authors" value={filterAuthorText || filters.author} onChange={(event) => setFilterAuthorText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setFilter('author', filterAuthorText ? [`author:${filterAuthorText}`] : []) } }} onBlur={() => { if (filterAuthorText) setFilter('author', [`author:${filterAuthorText}`]) }} placeholder="Filter or type a login…" />
                  <datalist id="tasks-authors"><option value="@me" />{[...new Set(tableRows.flatMap((item) => item.author ? [item.author] : []))].map((value) => <option key={value} value={value} />)}</datalist>
                </>
              </FormRow>
              <fieldset className="tasks-list__labels-filter">
                <legend>Labels</legend>
                <div className="tasks-list__label-options">
                  {[...new Set([...repoLabels, ...tableRows.flatMap((item) => item.labels)])].sort().map((label) => <label key={label} className="tasks-list__check-option"><input type="checkbox" checked={filters.labels.includes(label)} onChange={(event) => toggleLabel(label, event.currentTarget.checked)} />{label}</label>)}
                  {repoLabels.length === 0 && tableRows.every((item) => item.labels.length === 0) ? <span>No labels loaded.</span> : null}
                </div>
              </fieldset>
              <FormRow label="Assignee" htmlFor="tasks-list-assignee-filter">
                <select id="tasks-list-assignee-filter" className="ui-text-field__input" value={filters.assignee} onChange={(event) => setFilter('assignee', event.currentTarget.value ? [`assignee:${event.currentTarget.value}`] : [])}>
                  <option value="">Any assignee</option><option value="@me">Current user</option>
                  {[...new Set([...repoAssignees, ...tableRows.flatMap((item) => item.assignees)])].sort().map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </FormRow>
              {kind === 'pullRequest' ? (
                <>
                  <FormRow label="Review from" htmlFor="tasks-list-review-requested-filter">
                    <input id="tasks-list-review-requested-filter" className="ui-text-field__input" value={filterReviewRequestedText || filters.reviewRequested} onChange={(event) => setFilterReviewRequestedText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setFilter('reviewRequested', filterReviewRequestedText ? [`review-requested:${filterReviewRequestedText}`] : []) } }} onBlur={() => { if (filterReviewRequestedText) setFilter('reviewRequested', [`review-requested:${filterReviewRequestedText}`]) }} placeholder="@me or login" />
                  </FormRow>
                  <FormRow label="Reviewed by" htmlFor="tasks-list-reviewed-by-filter">
                    <input id="tasks-list-reviewed-by-filter" className="ui-text-field__input" value={filterReviewedByText || filters.reviewedBy} onChange={(event) => setFilterReviewedByText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setFilter('reviewedBy', filterReviewedByText ? [`reviewed-by:${filterReviewedByText}`] : []) } }} onBlur={() => { if (filterReviewedByText) setFilter('reviewedBy', [`reviewed-by:${filterReviewedByText}`]) }} placeholder="@me or login" />
                  </FormRow>
                </>
              ) : null}
              <Button type="button" onClick={() => { setFilter('all', []); setFiltersOpen(false) }}>Clear all filters</Button>
            </div>
          ) : null}
        </>
      ) : null}

      {loading && !visibleResult ? (
        <div role="status" aria-label="Loading GitHub tasks" className="tasks-list__loading">{Array.from({ length: 12 }, (_, index) => <div key={index} className="tasks-list__skeleton-row" />)}</div>
      ) : visibleResult?.repositories.length === 0 ? (
        <div role="status" className="tasks-list__empty"><EmptyState message="No eligible Git repositories. Add or select a registered Git repository with a local path to load GitHub tasks." /></div>
      ) : selectedRepoIds.length === 0 ? (
        <div role="status" className="tasks-list__empty"><EmptyState message="No project sources selected. Select at least one project source so Quirky knows where to fetch GitHub tasks." action={{ label: 'Select projects', onAction: () => setRepoOpen(true) }} /></div>
      ) : noGitHubRemote ? null : visibleResult && tableRows.length === 0 && visibleResult.failures.every((failure) => failure.stage === 'count') ? (
        <div role="status" className="tasks-list__empty"><EmptyState message="No matching GitHub work. Change the query or clear it." action={{ label: 'Reset query', onAction: () => commitSearch(presetQuery(normalizedPreset(state.preferences.defaultTaskViewPreset, kind), kind)) }} /></div>
      ) : tableRows.length === 0 && visibleResult?.failures.length ? (
        <div role="alert" className="tasks-list__notice tasks-list__notice--error">GitHub data is temporarily unavailable. Its API may be down, rate-limited, or unreachable. Retry shortly.</div>
      ) : (
        <div className="tasks-body tasks-list__table-scroll">
          <table className="tasks-list__table">
            <thead>
              <tr>
                <th scope="col" className="tasks-list__header-cell tasks-list__header-cell--id">ID</th>
                <th scope="col" className="tasks-list__header-cell tasks-list__header-cell--title">Title / Context</th>
                {kind === 'issue' ? <><th scope="col" className="tasks-list__header-cell">Assignees</th><th scope="col" className="tasks-list__header-cell">Status</th></> : <><th scope="col" className="tasks-list__header-cell">Reviewers</th><th scope="col" className="tasks-list__header-cell">Checks</th><th scope="col" className="tasks-list__header-cell">Merge</th></>}
                <th scope="col" className="tasks-list__header-cell">Updated</th>
                <th scope="col" className="tasks-list__header-cell tasks-list__header-cell--actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((item) => {
                const key = rowKey(item)
                const assigneeSourceKey = assigneeChoiceKey(item, parseSource(visibleResult?.sources[item.repoId]))
                const busy = busyRows[key] === true
                const when = relativeTime(item.updatedAt)
                const linked = object(item.linkedWorkspace)
                const check = checkSummary(checks[key], checksLoading[key] === true)
                const checkTone = check.tone === 'danger' ? 'failing' : check.tone === 'warning' ? 'needs-you' : check.tone === 'success' ? 'working' : 'neutral'
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
                  <tr className="tasks-row tasks-list__row" key={key} data-review-key={kind === 'pullRequest' ? key : undefined} tabIndex={0} onMouseEnter={() => kind === 'pullRequest' && void loadMergeMetadata(item)} onFocusCapture={() => kind === 'pullRequest' && void loadMergeMetadata(item)} onClick={() => onRow(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRow(item) } }}>
                    <td className="tasks-list__id-cell">
                      <span aria-label={kind === 'issue' ? 'Issue' : displayIsDraft ? 'Draft pull request' : 'Pull request'}>{kind === 'issue' ? 'I' : displayIsDraft ? 'D' : 'PR'}</span> <strong>#{item.number}</strong>
                    </td>
                    <td className="tasks-list__title-cell">
                      <strong>{item.title}</strong>
                      {displayState !== 'open' && !(kind === 'pullRequest' && displayIsDraft) ? <Badge tone={displayState === 'closed' ? 'neutral' : 'accent'}>{displayState}</Badge> : null}
                      {displayIsDraft ? <Badge>Draft</Badge> : null}
                      <div className="tasks-list__metadata">
                        <span>{item.author ?? 'unknown author'}</span>
                        {mergedSelectedCount ? <span>{item.repoName}</span> : null}
                        {item.labels.slice(0, 3).map((label) => <Badge key={label}>{label}</Badge>)}
                        {kind === 'pullRequest' && (additions !== undefined || deletions !== undefined || changedFiles !== undefined) ? <span>{additions !== undefined ? `+${additions}` : ''}{additions !== undefined && deletions !== undefined ? ' ' : ''}{deletions !== undefined ? `−${deletions}` : ''}{(additions !== undefined || deletions !== undefined) && changedFiles !== undefined ? ' ' : ''}{changedFiles !== undefined ? `${changedFiles} files` : ''}</span> : null}
                        {linked && typeof linked.name === 'string' ? <span>▰ {linked.name}</span> : null}
                        {optimistic[key]?.keepVisible ? <Badge tone="needs-you">Pending refresh</Badge> : null}
                      </div>
                    </td>
                    {kind === 'issue' ? (
                      <>
                        <td className="tasks-list__action-cell" onClick={stop} onKeyDown={stop}><Button type="button" aria-haspopup="dialog" aria-expanded={isAssigneesOpen} onClick={() => void openAssignees(item)}>{item.assignees.join(', ') || 'Assign issue'}</Button>
                        {isAssigneesOpen ? <div role="dialog" aria-label="Assign issue" >
                          <strong>Assign issue</strong>
                          {!Object.hasOwn(assigneeChoices, assigneeSourceKey) ? <span role="status">Loading assignable users…</span> : null}
                          {[...new Set([...item.assignees, ...(assigneeChoices[assigneeSourceKey] ?? [])])].map((login) => <label key={login} >
                            <input type="checkbox" checked={assigneeDraft.includes(login)} disabled={busy} onChange={(event) => toggleAssignee(login, event.currentTarget.checked)} />
                            {login}
                          </label>)}
                          {Object.hasOwn(assigneeChoices, assigneeSourceKey) && assigneeChoices[assigneeSourceKey]?.length === 0 && item.assignees.length === 0 ? <span role="status">No assignable users.</span> : null}
                          <Button type="button" onClick={() => void saveAssignees(item)} disabled={busy}>Save assignees</Button>
                          <Button type="button" onClick={() => setAssigneesFor(null)}>Cancel</Button>
                        </div> : null}</td>
                        <td className="tasks-list__action-cell" onClick={stop} onKeyDown={stop}><Button type="button" aria-haspopup="menu" aria-expanded={isStatusOpen} onClick={() => setStatusFor((current) => current === key ? null : key)}>{item.state === 'closed' ? 'Closed' : 'Open'} ▾</Button>
                        {isStatusOpen ? <div role="menu" aria-label={`Issue #${item.number} status`} >
                          <Button type="button" role="menuitem" disabled={busy || item.state === 'open'} onClick={() => void setStatus(item, 'open')}>Open</Button>
                          <Button type="button" role="menuitem" disabled={busy || item.state === 'closed'} onClick={() => void setStatus(item, 'closed', 'completed')}>Close as completed</Button>
                          <Button type="button" role="menuitem" disabled={busy || item.state === 'closed'} onClick={() => void setStatus(item, 'closed', 'not_planned')}>Close as not planned</Button>
                          <Button type="button" role="menuitem" disabled={busy || item.state === 'closed'} onClick={() => { setDuplicateFor(key); setDuplicateText('') }}>Close as duplicate…</Button>
                          {isDuplicate ? <div role="group" aria-label="Duplicate issue target">
                            <FormRow label="Search issues" htmlFor={`tasks-list-duplicate-${item.number}`}>
                              <input id={`tasks-list-duplicate-${item.number}`} className="ui-text-field__input" aria-label="Search issues" value={duplicateText} onChange={(event) => setDuplicateText(event.currentTarget.value)} />
                            </FormRow>
                            {/^\d+$/u.test(duplicateText) ? <Button type="button" onClick={() => {
                              const number = Number(duplicateText)
                              if (!Number.isSafeInteger(number) || number < 1) { setError('Use a positive issue number.'); return }
                              if (number === item.number) { setError('Choose a different issue.'); return }
                              void setStatus(item, 'closed', 'duplicate', number)
                            }}>Use issue #{duplicateText}</Button> : duplicateText.length > 0 ? <span role="status">Use a whole issue number.</span> : null}
                          </div> : null}
                        </div> : null}</td>
                      </>
                    ) : (
                      <>
                        <td className="tasks-list__action-cell" onClick={stop} onKeyDown={stop}><Button type="button" aria-haspopup="dialog" aria-expanded={isReviewersOpen} onClick={() => void openReviewers(item)}>{reviewerLabel}</Button>
                        {isReviewersOpen ? <div role="dialog" aria-label={`Reviewers for PR #${item.number}`} >
                          {requestedReviewers === null ? <span role="status">Requested reviewers are unavailable.</span> : requestedReviewers?.length ? <span>Currently requested: {requestedReviewers.join(', ')}</span> : null}
                          {review?.reviews === null ? <span role="status">Review history is unavailable.</span> : null}
                          {review?.assignees === null ? <span role="status">Pull-request assignees are unavailable.</span> : null}
                          {review?.participantsTruncated === true ? <span role="status">Recent reviewer activity is incomplete.</span> : null}
                          {!reviewSuggestions ? <span role="status">Loading reviewer suggestions…</span> : null}
                          {recentReviewers.length > 0 ? <fieldset><legend>Recently active in this pull request</legend>{recentReviewers.map((login) => <Button key={login} type="button" onClick={() => addReviewerOption(login)}>{login}</Button>)}</fieldset> : null}
                          {suggestedReviewers.length > 0 ? <fieldset><legend>Suggestions</legend>{suggestedReviewers.map((login) => <Button key={login} type="button" onClick={() => addReviewerOption(login)}>{login}</Button>)}</fieldset> : null}
                          {reviewSuggestions && recentReviewers.length === 0 && suggestedReviewers.length === 0 && !reviewerInfoUnknown ? <span role="status">No matching reviewers.</span> : null}
                          <FormRow label="Everyone else" htmlFor={`tasks-list-reviewer-text-${item.number}`}>
                            <textarea id={`tasks-list-reviewer-text-${item.number}`} className="ui-text-field__input tasks-list__reviewer-input" aria-label="Type or choose a reviewer" value={reviewerText} onChange={(event) => { const value = event.currentTarget.value; if (new TextEncoder().encode(value).byteLength <= 2048) setReviewerText(value); else setError('Reviewer input exceeds the 2048-byte limit.') }} placeholder="Type or choose a user" />
                          </FormRow>
                          <Button type="button" disabled={busy} onClick={() => void saveReviewers(item, 'add')}>Request reviewers</Button>
                          <Button type="button" disabled={busy} onClick={() => void saveReviewers(item, 'remove')}>Remove reviewers</Button>
                          <Button type="button" onClick={() => setReviewersFor(null)}>Close</Button>
                        </div> : null}</td>
                        <td className="tasks-list__action-cell" onClick={stop} onKeyDown={stop}><Button className="tasks-list__check-trigger" data-check-key={key} type="button" aria-label={`Checks for PR #${item.number}: ${check.label}`} onMouseEnter={() => void loadChecks(item)} onFocus={() => void loadChecks(item)} onClick={() => void openReview(rowTarget(item), 'checks')}><Badge tone={checkTone}>{check.label}</Badge></Button></td>
                        <td className="tasks-list__action-cell" onClick={stop} onKeyDown={stop}><div  >
                          <Button type="button" aria-haspopup="menu" aria-expanded={isMergeOpen} aria-label={mergeErrors[key] ? `Merge metadata unavailable for PR #${item.number}` : `Merge actions for PR #${item.number}`} onClick={() => toggleMergeMenu(item)} disabled={busy}>{mergeErrors[key] ? 'Merge metadata unavailable' : displayState === 'merged' ? 'Merged' : meta?.queueEligible ? 'Merge when ready' : meta?.mergeEligible ? 'Merge' : 'Check merge safety'} ▾</Button>
                          {isMergeOpen ? <div role="menu" aria-label={`Merge PR #${item.number}`} >
                            {mergeLoading[key] ? <span role="status">Loading merge metadata…</span> : null}
                            {!mergeLoading[key] && !meta && !mergeErrors[key] ? <span role="status">Review metadata has not loaded.</span> : null}
                            {meta?.mergeQueueRequired === true && meta.queueEligible ? meta.queueMethods.map((method) => <Button key={method} type="button" role="menuitem" disabled={busy} onClick={() => void mergeItem(item, method, 'queue')}>{`Merge when ready (${method})`}</Button>) : null}
                            {meta?.mergeQueueRequired === false && meta.mergeEligible ? meta.directMethods.map((method) => <Button key={method} type="button" role="menuitem" disabled={busy} onClick={() => void mergeItem(item, method, 'direct')}>{method === 'squash' ? 'Squash and merge' : method === 'merge' ? 'Create merge commit' : 'Rebase and merge'}</Button>) : null}
                            {meta && !meta.mergeMetadataKnown ? <span>GitHub has not confirmed merge-queue safety metadata.</span> : null}
                            {meta?.mergeMetadataKnown && meta.mergeQueueRequired === null ? <span>Merge-queue requirement is unknown; refresh before merging.</span> : null}
                            {meta?.mergeQueueRequired === false && !meta.mergeEligible ? <span>Direct merge is not confirmed safe.</span> : null}
                            {meta && !meta.autoMergeEnabled && meta.autoMergeAllowed === null ? <span>Auto-merge capability is unknown.</span> : null}
                            {meta?.autoMergeAllowed === false && !meta.autoMergeEnabled ? <span>GitHub has disabled auto-merge for this repository.</span> : null}
                            {autoMergeAvailable ? <Button type="button" role="menuitem" onClick={() => void toggleAutoMerge(item)}>{meta?.autoMergeEnabled ? 'Disable auto-merge' : meta?.mergeQueueRequired ? 'Merge when ready' : 'Enable auto-merge'}</Button> : null}
                            <Button type="button" role="menuitem" onClick={() => openLink(item.url)}>Open on GitHub</Button>
                          </div> : null}
                          {mergeErrors[key] ? <span role="status">Review metadata unavailable: {mergeErrors[key]} <Button type="button" onClick={() => void loadMergeMetadata(item)}>Retry</Button></span> : null}
                        </div></td>
                      </>
                    )}
                    <td title={when.absolute} >{when.label}</td>
                    <td className="tasks-list__actions-cell" onClick={stop} onKeyDown={stop}>
                      <Button type="button" disabled={busy} onClick={() => void context.call('quirky.tasks/workspace', { target: rowTarget(item), action: linked ? 'resume' : 'start' }).catch((cause) => setError(errorMessage(cause)))}>{linked ? 'Resume' : 'Start'}</Button>
                      {linked ? <Button type="button" onClick={() => void context.call('quirky.tasks/workspace', { target: rowTarget(item), action: 'start', newWorkspace: true }).catch((cause) => setError(errorMessage(cause)))}>Start new</Button> : null}
                      <IconButton type="button" label={`Open ${kind === 'issue' ? 'issue' : 'pull request'} #${item.number} on GitHub`} onClick={(event) => openInGitHub(event, item.url)}>↗</IconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {visibleResult && visibleResult.totalPages > 1 ? (
        <nav aria-label="GitHub task pagination" className="tasks-list__pagination">
          <Button type="button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => goToPage(page - 1)}>Previous</Button>
          {pageNumbers(page, totalPages).map((number, index) => number === 'ellipsis'
            ? <span key={`ellipsis-${index}`} aria-hidden="true">…</span>
            : <Button key={number} variant={page === number ? 'primary' : 'secondary'} type="button" aria-current={page === number ? 'page' : undefined} disabled={loading} onClick={() => goToPage(number)}>{number}</Button>)}
          <Button type="button" aria-label="Next page" disabled={loading || page >= totalPages} onClick={() => goToPage(page + 1)}>Next</Button>
        </nav>
      ) : null}
    </section>
  )
}
