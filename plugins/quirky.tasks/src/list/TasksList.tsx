import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ControlIcon, EmptyState, FormRow, IconButton, ListRow, Menu, TextField, type MenuItem } from '@quirky/ui'
import type { ItemKind, ItemTarget, TasksSurfaceProps } from '../contracts'
import { IssueSurface } from '../issue/IssueSurface'
import { PrDetail, type ReviewerOptions } from './PrDetail'
import { place } from './place'
import { rowStatus } from './row-status'
import { queryForKind } from './search'
import { useAgentActivity } from './useAgentActivity'
import {
  checkResult, checkSummary, countFilters, currentPreset, errorMessage, filterPills, filtersFromQuery, mergeMeta,
  listViewKey, normalizedPreset, object, optionalLogins, parseListResult, parseSource, presetQuery, relativeTime, replaceFilters, reviewAuthors,
  reviewState, rowKey, rowTarget, strings,
  type CheckResult, type ListData, type ListItem, type ListSource, type MergeMetadata, type Preset
} from './model'
import { useReviewNavigation } from './useReviewNavigation'

export { WorkspaceComposer } from './WorkspaceComposer'
export { useReviewNavigation } from './useReviewNavigation'

type OptimisticRow = { item: ListItem; patch: Partial<ListItem>; generation: number; keepVisible: boolean }

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

/** Matches the row the detail column shows; the worktree, kind and number identify it across pages. */
function isOpenRow(item: ListItem, detail: ItemTarget | null): boolean {
  return detail !== null && detail.worktree === item.worktree && detail.kind === item.kind && detail.number === item.number
}

function linkedName(item: ListItem): string | null {
  const name = object(item.linkedWorkspace)?.name
  return typeof name === 'string' ? name : null
}

function linkedWorktree(item: ListItem): string | undefined {
  const worktree = object(item.linkedWorkspace)?.worktree
  return typeof worktree === 'string' ? worktree : undefined
}

/**
 * The expanded Tasks list: a list column beside a detail column that shows the open issue or pull request.
 * `initialFocus` says whether the mount that created this view asked for focus on a row; left undefined,
 * the list asks the place memory itself.
 */
export function TasksList({ context, state, refresh, initialFocus, onDataChanged }: TasksSurfaceProps & { initialFocus?: boolean; onDataChanged?: () => void }) {
  const navigation = state.navigation
  const mode = navigation.mode === 'prs' ? 'prs' : 'issues'
  const currentKey = listViewKey({ source: navigation.source, mode, repoIds: navigation.repoIds, query: navigation.query, page: navigation.page })
  const [seed] = useState(() => place.listSnapshot(currentKey))
  const [result, setResult] = useState<ListData | null>(seed?.list ?? null)
  const [resultKey, setResultKey] = useState<string | null>(seed ? currentKey : null)
  const [loading, setLoading] = useState(seed === null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState(state.navigation.query)
  const [repoOpen, setRepoOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [reviewersFor, setReviewersFor] = useState<string | null>(null)
  const [reviewerText, setReviewerText] = useState('')
  const [reviewerOptions, setReviewerOptions] = useState<Record<string, ReviewerOptions>>({})
  const [mergeFor, setMergeFor] = useState<string | null>(null)
  const [mergeMetadata, setMergeMetadata] = useState<Record<string, MergeMetadata>>({ ...seed?.merge })
  const [mergeLoading, setMergeLoading] = useState<Record<string, boolean>>({})
  const [mergeErrors, setMergeErrors] = useState<Record<string, string>>({})
  const [checks, setChecks] = useState<Record<string, CheckResult>>({ ...seed?.checks })
  const [checksLoading, setChecksLoading] = useState<Record<string, boolean>>({})
  const [repoLabels, setRepoLabels] = useState<string[]>([])
  const [repoAssignees, setRepoAssignees] = useState<string[]>([])
  const [filterAuthorText, setFilterAuthorText] = useState('')
  const [filterReviewRequestedText, setFilterReviewRequestedText] = useState('')
  const [filterReviewedByText, setFilterReviewedByText] = useState('')
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticRow>>({})
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({})
  const [viewer, setViewer] = useState<string | null>(null)
  const mergeMetadataRef = useRef(mergeMetadata)
  mergeMetadataRef.current = mergeMetadata
  const seededMergeKeys = useRef(new Set(Object.keys(seed?.merge ?? {})))
  const checksOwner = useRef(currentKey)
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
  const listScroll = useRef<HTMLDivElement | null>(null)
  const restoredScroll = useRef<string | null>(null)
  const wantsFocus = useRef(false)
  const viewerRequested = useRef(false)
  const activity = useAgentActivity(context)

  const kind: ItemKind = mode === 'prs' ? 'pullRequest' : 'issue'
  const allRepoIds = result?.repositories.map((repo) => repo.id) ?? []
  const selectedRepoIds = navigation.repoIds === null ? allRepoIds : navigation.repoIds
  const selectedRepos = result?.repositories.filter((repo) => selectedRepoIds.includes(repo.id)) ?? []
  const filterRepoId = selectedRepos.length === 1 ? selectedRepos[0]!.id : null
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
    setChecksLoading({})
    setMergeLoading({})
    if (checksOwner.current === currentKey) return
    checksOwner.current = currentKey
    setChecks({})
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

  const copyLink = (url: string) => {
    void context.executeCommand('command:quirky.tasks/copy-link', { url }).catch((cause) => setError(errorMessage(cause)))
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
    if ((mergeMetadataRef.current[key] && !seededMergeKeys.current.has(key)) || mutationInFlight.current.has(key) || mergeReadOwners.current.get(key) === owner) return
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
        seededMergeKeys.current.delete(key)
        setMergeMetadata((previous) => ({ ...previous, [key]: result }))
        setMergeErrors((previous) => {
          if (!previous[key]) return previous
          const next = { ...previous }
          delete next[key]
          return next
        })
      }
    } catch (cause) {
      if (ownsRead()) {
        if (seededMergeKeys.current.delete(key)) setMergeMetadata((previous) => Object.fromEntries(Object.entries(previous).filter(([entry]) => entry !== key)))
        setMergeErrors((previous) => ({ ...previous, [key]: errorMessage(cause) }))
      }
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
    if (seededMergeKeys.current.has(key)) {
      setError('Merge metadata is refreshing. Try again in a moment.')
      return
    }
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
    if (seededMergeKeys.current.has(key)) {
      setError('Merge metadata is refreshing. Try again in a moment.')
      return
    }
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
    try {
      await context.call('quirky.tasks/row', { target, action: 'issueSource', preference })
      invalidateViewGeneration()
      await loadList(true)
    } catch (cause) {
      invalidateViewGeneration()
      await loadList(true)
      setError(errorMessage(cause))
    }
  }

  const onRow = (item: ListItem) => {
    if (listScroll.current) place.setScrollTop('expanded', currentKey, listScroll.current.scrollTop)
    void navigate({ detail: rowTarget(item) })
  }

  const goToPage = (page: number) => {
    if (page < 1 || page > (visibleResult?.totalPages ?? 1) || page === navigation.page || loading) return
    void navigate({ page, scrollTop: 0 })
  }

  const detail = navigation.detail
  const hasDetail = detail !== null
  const rows = listItems.filter((item) => item.kind === kind)
  const offPageRepo = detail ? result?.repositories.find((repo) => repo.worktree === detail.worktree) : undefined
  const selectedPr: ListItem | null = detail?.kind === 'pullRequest'
    ? listItems.find((item) => isOpenRow(item, detail)) ?? {
        kind: 'pullRequest',
        number: detail.number,
        title: '',
        body: '',
        state: reviewState(mergeMetadata[rowKey({ worktree: detail.worktree, kind: 'pullRequest', number: detail.number, url: detail.url ?? '' })]?.review.state) ?? 'unknown',
        url: detail.url ?? '',
        createdAt: null,
        updatedAt: null,
        author: null,
        labels: [],
        assignees: [],
        isDraft: false,
        worktree: detail.worktree,
        repoId: offPageRepo?.id ?? '',
        repoName: offPageRepo?.name ?? ''
      }
    : null
  const selectedPrKey = selectedPr ? rowKey(selectedPr) : null
  const selectedPrRef = useRef(selectedPr)
  selectedPrRef.current = selectedPr

  useEffect(() => {
    const item = selectedPrRef.current
    if (!item) return
    void loadChecks(item)
    void loadMergeMetadata(item)
  }, [selectedPrKey, loadChecks, loadMergeMetadata])

  useEffect(() => {
    if (viewerRequested.current || !result) return
    const worktree = selectedRepos[0]?.worktree
    if (!worktree) return
    viewerRequested.current = true
    void (async () => {
      try {
        const login = object(await context.call('quirky.hosting/viewer', { worktree }))?.login
        setViewer(typeof login === 'string' && login !== '' ? login : null)
      } catch {
        setViewer(null)
      }
    })()
  }, [context, result])

  useEffect(() => {
    if (initialFocus === undefined ? place.takeFocus() === 'row' : initialFocus) wantsFocus.current = true
  }, [])

  useEffect(() => {
    if (!visibleResult) return
    const rowKeys = new Set(visibleResult.items.map(rowKey))
    const only = <T,>(source: Record<string, T>) => Object.fromEntries(Object.entries(source).filter(([key]) => rowKeys.has(key)))
    place.setListSnapshot(currentKey, { list: visibleResult, checks: only(checks), merge: only(mergeMetadata) })
  }, [visibleResult, checks, mergeMetadata, currentKey])

  const hasLoadedRows = visibleResult !== null
  useEffect(() => {
    const element = listScroll.current
    if (!element || !hasLoadedRows) return
    restoredScroll.current = currentKey
    element.scrollTop = place.scrollTop('expanded', currentKey)
  }, [currentKey, hasLoadedRows, hasDetail])

  useEffect(() => {
    const element = listScroll.current
    if (!wantsFocus.current || !element || rows.length === 0) return
    wantsFocus.current = false
    const selected = element.querySelector<HTMLElement>('.ui-list-row--selected .ui-list-row__main')
    const target = selected ?? element.querySelector<HTMLElement>('.ui-list-row__main')
    if (selected) selected.scrollIntoView?.({ block: 'nearest' })
    target?.focus({ preventScroll: true })
  }, [rows.length, currentKey])

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
  const statusOptions = kind === 'issue' ? ['open', 'closed', 'any'] : ['open', 'closed', 'merged', 'any']
  const localError = error

  const changeReviewerText = (value: string) => {
    if (new TextEncoder().encode(value).byteLength <= 2048) setReviewerText(value)
    else setError('Reviewer input exceeds the 2048-byte limit.')
  }
  const startWorkspace = (item: ListItem, action: 'start' | 'resume', newWorkspace = false) => {
    void context.call('quirky.tasks/workspace', { target: rowTarget(item), action, ...(newWorkspace ? { newWorkspace: true } : {}) }).catch((cause) => setError(errorMessage(cause)))
  }
  const toolbarItems: MenuItem[] = [
    { id: 'settings', label: 'Task settings', onAction: () => void context.call('quirky.tasks/settings', {}).catch((cause) => context.toast('Could not open task settings', errorMessage(cause))) },
    ...(!noGitHubRemote ? [{
      id: 'repository',
      label: 'Open repository in GitHub',
      disabled: !repoOpenUrl || selectedRepos.length !== 1,
      onAction: () => { if (repoOpenUrl) openLink(repoOpenUrl) }
    }] : []),
    ...(showIssueSource ? (['upstream', 'origin'] as const).map((id) => ({
      id,
      label: id === 'upstream' ? 'Upstream' : 'Origin',
      checked: selectedIssueSource === id,
      onAction: () => void changeRepoSource(id)
    })) : [])
  ]

  const renderRow = (item: ListItem) => {
    const key = rowKey(item)
    const check = checkSummary(checks[key], checksLoading[key] === true && checks[key] === undefined)
    const when = relativeTime(item.updatedAt)
    const worktree = linkedWorktree(item)
    const resolved = rowStatus(item, { viewer, checks: checks[key], merge: mergeMetadata[key], activity: worktree === undefined ? undefined : activity.get(worktree) })
    return (
      <div
        key={key}
        className="tasks-list__row"
        data-review-key={kind === 'pullRequest' ? key : undefined}
        data-check-key={kind === 'pullRequest' ? key : undefined}
        onMouseEnter={() => kind === 'pullRequest' && void loadMergeMetadata(item)}
        onFocusCapture={() => kind === 'pullRequest' && void loadMergeMetadata(item)}
      >
        <ListRow
          title={item.title}
          mainTitle={item.title}
          description={`#${item.number} · ${item.repoName} · ${item.author ?? 'unknown author'}`}
          status={resolved.status}
          statusLabel={resolved.detail}
          selected={isOpenRow(item, detail)}
          onClick={() => onRow(item)}
          trailing={<>
            {kind === 'pullRequest' && checks[key] ? <span className={`tasks-list__checks tasks-list__checks--${check.tone}`}>{check.label}</span> : null}
            {kind === 'issue' && item.assignees.length > 0 ? <span className="tasks-list__assignees">{item.assignees.join(', ')}</span> : null}
            <span className="tasks-list__age" title={when.absolute}>{when.label}</span>
          </>}
        />
      </div>
    )
  }

  let listBody
  if (loading && !visibleResult) {
    listBody = <div role="status" aria-label="Loading GitHub tasks" className="tasks-list__loading">{Array.from({ length: 12 }, (_, index) => <div key={index} className="tasks-list__skeleton-row" />)}</div>
  } else if (visibleResult?.repositories.length === 0) {
    listBody = <div role="status" className="tasks-list__empty"><EmptyState message="No eligible Git repositories. Add or select a registered Git repository with a local path to load GitHub tasks." /></div>
  } else if (selectedRepoIds.length === 0) {
    listBody = <div role="status" className="tasks-list__empty"><EmptyState message="No project sources selected. Select at least one project source so Quirky knows where to fetch GitHub tasks." action={{ label: 'Select projects', onAction: () => setRepoOpen(true) }} /></div>
  } else if (visibleResult && rows.length === 0 && visibleResult.failures.every((failure) => failure.stage === 'count')) {
    listBody = <div role="status" className="tasks-list__empty"><EmptyState message="No matching GitHub work. Change the query or clear it." action={{ label: 'Reset query', onAction: () => commitSearch(presetQuery(normalizedPreset(state.preferences.defaultTaskViewPreset, kind), kind)) }} /></div>
  } else if (rows.length === 0 && visibleResult?.failures.length) {
    listBody = <div role="alert" className="tasks-list__notice tasks-list__notice--error">GitHub data is temporarily unavailable. Its API may be down, rate-limited, or unreachable. Retry shortly.</div>
  } else {
    listBody = rows.map(renderRow)
  }

  const refreshWithList = async () => {
    await refresh()
    void loadList(true)
  }
  const prKey = selectedPrKey
  const detailBody = detail === null
    ? <div role="status" className="tasks-list__prompt"><EmptyState message="Select a task" /></div>
    : detail.kind === 'issue'
      ? <IssueSurface context={context} state={state} refresh={refreshWithList} />
      : selectedPr && prKey ? (
        <PrDetail
          item={selectedPr}
          onPage={listItems.some((item) => rowKey(item) === prKey)}
          metadata={mergeMetadata[prKey]}
          metadataLoading={mergeLoading[prKey] === true}
          metadataError={mergeErrors[prKey]}
          check={checkSummary(checks[prKey], checksLoading[prKey] === true && checks[prKey] === undefined)}
          busy={busyRows[prKey] === true}
          linkedName={linkedName(selectedPr)}
          merge={{
            open: mergeFor === prKey,
            onToggle: () => toggleMergeMenu(selectedPr),
            onClose: () => setMergeFor(null),
            onMerge: (method, action) => void mergeItem(selectedPr, method, action),
            onToggleAutoMerge: () => void toggleAutoMerge(selectedPr)
          }}
          reviewers={{
            open: reviewersFor === prKey,
            text: reviewerText,
            options: reviewerOptions[prKey],
            onToggle: () => void openReviewers(selectedPr),
            onTextChange: changeReviewerText,
            onAddOption: addReviewerOption,
            onSave: (action) => void saveReviewers(selectedPr, action),
            onClose: () => setReviewersFor(null)
          }}
          onReview={(tab) => void openReview(rowTarget(selectedPr), tab)}
          onLoadChecks={() => void loadChecks(selectedPr)}
          onRetryMetadata={() => void loadMergeMetadata(selectedPr)}
          onWorkspace={(action, newWorkspace) => startWorkspace(selectedPr, action, newWorkspace)}
          onOpenLink={openLink}
          onCopyLink={copyLink}
        />
      ) : null

  return (
    <section className="tasks-list" data-kind={kind} aria-label="GitHub tasks">
      <div className="tasks-list__controls">
        {noGitHubRemote ? (
          <div role="status" className="tasks-list__empty"><EmptyState message={noGitHubRemoteMessage} /></div>
        ) : null}
        <div className="tasks-list__source">
          <div className="tasks-list__context">
            <span aria-label="Task source context">{hostContext} · {userLabel()} · {sourceContext}</span>
            {selectedSourceValues.length > 1 ? <span>{selectedSourceValues.length} selected sources</span> : null}
            {issueSource.issueSourcePreference === 'upstream' && issueSource.issueSourceFellBack ? <span role="status">Upstream source fell back to origin</span> : null}
            {!showIssueSource && mode === 'issues' && selectedIssueSource === 'upstream' && hasOneRepo ? <span aria-label="Issues use upstream source">Issues from upstream</span> : null}
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
          </div>
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
          <Button type="button" aria-label={refreshing ? 'Refreshing GitHub work' : 'Refresh GitHub work'} disabled={refreshing || selectedRepoIds.length === 0} onClick={() => { void loadList(true, true); onDataChanged?.() }}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
          <Menu label="Tasks options" trigger={<ControlIcon name="dots-three" />} items={toolbarItems} />
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
                    <datalist id="tasks-authors"><option value="@me" />{[...new Set(rows.flatMap((item) => item.author ? [item.author] : []))].map((value) => <option key={value} value={value} />)}</datalist>
                  </>
                </FormRow>
                <fieldset className="tasks-list__labels-filter">
                  <legend>Labels</legend>
                  <div className="tasks-list__label-options">
                    {[...new Set([...repoLabels, ...rows.flatMap((item) => item.labels)])].sort().map((label) => <label key={label} className="tasks-list__check-option"><input type="checkbox" checked={filters.labels.includes(label)} onChange={(event) => toggleLabel(label, event.currentTarget.checked)} />{label}</label>)}
                    {repoLabels.length === 0 && rows.every((item) => item.labels.length === 0) ? <span>No labels loaded.</span> : null}
                  </div>
                </fieldset>
                <FormRow label="Assignee" htmlFor="tasks-list-assignee-filter">
                  <select id="tasks-list-assignee-filter" className="ui-text-field__input" value={filters.assignee} onChange={(event) => setFilter('assignee', event.currentTarget.value ? [`assignee:${event.currentTarget.value}`] : [])}>
                    <option value="">Any assignee</option><option value="@me">Current user</option>
                    {[...new Set([...repoAssignees, ...rows.flatMap((item) => item.assignees)])].sort().map((value) => <option key={value} value={value}>{value}</option>)}
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
      </div>

      {noGitHubRemote ? null : (
        <div className="tasks-list__body" data-has-detail={hasDetail ? 'true' : 'false'}>
          <div className="tasks-list__list">
            <div
              className="tasks-list__rows"
              ref={listScroll}
              onScroll={(event) => { if (restoredScroll.current === currentKey) place.setScrollTop('expanded', currentKey, event.currentTarget.scrollTop) }}
            >
              {listBody}
            </div>
            {visibleResult && visibleResult.totalPages > 1 ? (
              <nav aria-label="GitHub task pagination" className="tasks-list__pagination">
                <Button type="button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => goToPage(page - 1)}>Previous</Button>
                {pageNumbers(page, totalPages).map((number, index) => number === 'ellipsis'
                  ? <span key={`ellipsis-${index}`} aria-hidden="true">…</span>
                  : <Button key={number} variant={page === number ? 'primary' : 'secondary'} type="button" aria-current={page === number ? 'page' : undefined} disabled={loading} onClick={() => goToPage(number)}>{number}</Button>)}
                <Button type="button" aria-label="Next page" disabled={loading || page >= totalPages} onClick={() => goToPage(page + 1)}>Next</Button>
              </nav>
            ) : null}
          </div>
          <div className="tasks-list__detail" aria-label="Task detail">
            {hasDetail ? (
              <Button type="button" className="tasks-list__back" aria-label={`Back to ${mode === 'prs' ? 'PRs' : 'Issues'}`} onClick={() => void navigate({ detail: null })}>
                <ControlIcon name="caret-left" />{mode === 'prs' ? 'PRs' : 'Issues'}
              </Button>
            ) : null}
            {detailBody}
          </div>
        </div>
      )}
    </section>
  )
}
