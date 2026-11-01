import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { TaskNavigation, TaskListView } from '../contracts'
import { place } from './place'
import { checkResult, errorMessage, listViewKey, mergeMeta, object, parseListResult, rowKey, rowTarget, type CheckResult, type ListData, type ListItem, type MergeMetadata } from './model'

/** Attribute that lets the observer map a rendered row back to its item. */
export const ROW_KEY_ATTRIBUTE = 'data-row-key'

const EAGER_ROWS = 20
const NO_DETAILS: Record<string, never> = {}
const IDLE_VIEW: TaskListView = { mode: 'issues', query: '', page: 1 }

export type CompactCounts = { issues: number | null; prs: number | null }

export type CompactList = {
  /** The list the panel shows, which is `navigation`'s own unless Projects is selected. */
  view: TaskListView
  /** Matches the expanded view's `currentKey`, so both forms key place memory the same way. */
  viewKey: string
  /** Rows loaded for the current view; null until they arrive. */
  result: ListData | null
  loading: boolean
  /** The read's error while no rows are available for the current view. */
  error: string | null
  checks: Readonly<Record<string, CheckResult>>
  merges: Readonly<Record<string, MergeMetadata>>
  /** The signed-in GitHub login, or null when unknown. */
  viewer: string | null
  counts: CompactCounts
  /** Attach to the scrolling element that holds the rows so offscreen rows load their details on approach. */
  rowsRef: RefObject<HTMLElement | null>
}

/**
 * Adds one row's detail to the details held for `viewKey`. A view that has no details yet starts
 * from its snapshot, so a result that arrives first doesn't hide the rest of what was seeded.
 */
function withDetails<K extends 'checks' | 'merges'>(
  previous: { key: string; checks: Record<string, CheckResult>; merges: Record<string, MergeMetadata> } | null,
  viewKey: string,
  field: K,
  rowId: string,
  value: K extends 'checks' ? CheckResult : MergeMetadata
) {
  const saved = place.listSnapshot(viewKey)
  const base = previous?.key === viewKey ? previous : { key: viewKey, checks: { ...saved?.checks }, merges: { ...saved?.merge } }
  return { ...base, [field]: { ...base[field], [rowId]: value } }
}

/** The list a compact panel shows: Projects has no compact form, so it falls back to the last list. */
export function effectiveList(navigation: Pick<TaskNavigation, 'mode' | 'query' | 'page' | 'lastList'>): TaskListView {
  if (navigation.mode === 'projects') return navigation.lastList
  return { mode: navigation.mode, query: navigation.query, page: navigation.page }
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Loads the compact panel's rows, checks, merge metadata, viewer login and tab counts for the
 * effective view. The first rows load their details at once and the rest as they approach the
 * viewport. Generation counters drop any result that belongs to a view the panel has left, the
 * way the expanded list does with `fetchGeneration` and `viewGeneration`.
 */
export function useCompactList(
  context: UiPluginContext,
  navigation: Pick<TaskNavigation, 'source' | 'mode' | 'query' | 'page' | 'lastList' | 'repoIds'> | null
): CompactList {
  const view = navigation ? effectiveList(navigation) : IDLE_VIEW
  const repoIds = navigation?.repoIds ?? null
  const viewKey = navigation === null ? '' : listViewKey({ source: navigation.source, mode: view.mode, repoIds, query: view.query, page: view.page })
  const [loaded, setLoaded] = useState<{ key: string; result: ListData } | null>(null)
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null)
  const [details, setDetails] = useState<{ key: string; checks: Record<string, CheckResult>; merges: Record<string, MergeMetadata> } | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)
  const [counts, setCounts] = useState<CompactCounts>({ issues: null, prs: null })
  const rowsRef = useRef<HTMLElement | null>(null)
  const latestKey = useRef(viewKey)
  const fetchGeneration = useRef(0)
  const viewGeneration = useRef(0)
  const countsGeneration = useRef(0)
  const viewerRequested = useRef(false)
  const checkRequested = useRef(new Set<string>())
  const mergeRequested = useRef(new Set<string>())

  if (latestKey.current !== viewKey) {
    latestKey.current = viewKey
    viewGeneration.current += 1
  }

  const idle = navigation === null
  const snapshot = idle ? null : place.listSnapshot(viewKey)
  const result = idle ? null : loaded?.key === viewKey ? loaded.result : snapshot?.list ?? null
  const ownDetails = details?.key === viewKey ? details : null
  const checks: Record<string, CheckResult> = ownDetails?.checks ?? snapshot?.checks ?? NO_DETAILS
  const merges: Record<string, MergeMetadata> = ownDetails?.merges ?? snapshot?.merge ?? NO_DETAILS
  const error = !idle && result === null && failed?.key === viewKey ? failed.message : null
  const loading = result === null && error === null

  useEffect(() => {
    if (idle) return
    const generation = ++fetchGeneration.current
    const owner = viewGeneration.current
    const owns = () => generation === fetchGeneration.current && viewGeneration.current === owner
    void (async () => {
      try {
        const parsed = parseListResult(await context.call('quirky.tasks/list', { mode: view.mode, repoIds, query: view.query, page: view.page }))
        if (!parsed) throw new Error('The Tasks list API returned an invalid result.')
        if (owns()) { setLoaded({ key: viewKey, result: parsed }); setFailed(null) }
      } catch (cause) {
        if (owns()) setFailed({ key: viewKey, message: errorMessage(cause) })
      }
    })()
    return () => { fetchGeneration.current += 1 }
  }, [context, viewKey, idle])

  useEffect(() => {
    if (idle) return
    const generation = ++countsGeneration.current
    void (async () => {
      let next: CompactCounts = { issues: null, prs: null }
      try {
        const value = object(await context.call('quirky.tasks/counts', { mode: view.mode, query: view.query, repoIds }))
        if (value) next = { issues: countOf(value.issues), prs: countOf(value.prs) }
      } catch {
        // an unreadable count is shown as no number
      }
      if (generation === countsGeneration.current) setCounts(next)
    })()
    return () => { countsGeneration.current += 1 }
  }, [context, viewKey, idle])

  useEffect(() => {
    checkRequested.current.clear()
    mergeRequested.current.clear()
  }, [viewKey])

  useEffect(() => {
    if (result) place.setListSnapshot(viewKey, { list: result, checks, merge: merges })
  }, [viewKey, result, checks, merges])

  useEffect(() => {
    if (viewerRequested.current || !result) return
    const selected = result.repositories.filter((repo) => repoIds === null || repoIds.includes(repo.id))
    const worktree = selected[0]?.worktree
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

  const loadChecks = useCallback(async (item: ListItem) => {
    const key = rowKey(item)
    if (checkRequested.current.has(key)) return
    checkRequested.current.add(key)
    const owner = viewGeneration.current
    try {
      const value = await context.call('quirky.tasks/checks', { target: rowTarget(item) })
      if (viewGeneration.current !== owner) return
      const parsed = checkResult(value) ?? { rollup: 'unknown', checks: [], partial: true, partialFailures: ['Invalid check result.'] }
      setDetails((previous) => withDetails(previous, latestKey.current, 'checks', key, parsed))
    } catch {
      if (viewGeneration.current === owner) checkRequested.current.delete(key)
    }
  }, [context])

  const loadMerge = useCallback(async (item: ListItem) => {
    const key = rowKey(item)
    if (mergeRequested.current.has(key)) return
    mergeRequested.current.add(key)
    const owner = viewGeneration.current
    try {
      const parsed = mergeMeta(await context.call('quirky.tasks/mergeMetadata', { target: rowTarget(item) }))
      if (viewGeneration.current !== owner) return
      if (parsed) setDetails((previous) => withDetails(previous, latestKey.current, 'merges', key, parsed))
    } catch {
      if (viewGeneration.current === owner) mergeRequested.current.delete(key)
    }
  }, [context])

  const items = useMemo(
    () => result && view.mode === 'prs' ? result.items.filter((item) => item.kind === 'pullRequest') : null,
    [result, view.mode]
  )

  useEffect(() => {
    if (!items) return
    for (const item of items.slice(0, EAGER_ROWS)) {
      void loadChecks(item)
      void loadMerge(item)
    }
  }, [items, loadChecks, loadMerge])

  useEffect(() => {
    const container = rowsRef.current
    if (!items || !container || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const key = entry.target.getAttribute(ROW_KEY_ATTRIBUTE)
        const item = items.find((candidate) => rowKey(candidate) === key)
        if (!item) continue
        void loadChecks(item)
        void loadMerge(item)
      }
    }, { rootMargin: '160px' })
    container.querySelectorAll(`[${ROW_KEY_ATTRIBUTE}]`).forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [items, loadChecks, loadMerge])

  return { view, viewKey, result, loading, error, checks, merges, viewer, counts, rowsRef }
}
