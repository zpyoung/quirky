import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { ContextMenu, ControlIcon, EmptyState, IconButton, InlineError, ListRow, NoticeLine, Tabs, ToolPanelFrame } from '@quirky/ui'
import { TASKS_VIEW, type ItemKind, type TaskNavigation, type TasksState } from '../contracts'
import { countFilters, errorMessage, filtersFromQuery, normalizedPreset, object, parseSource, parseTasksState, presetQuery, rowKey, rowTarget, tokenize, type ListItem } from './model'
import { place } from './place'
import { rowDescription, rowStatus } from './row-status'
import { queryForKind } from './search'
import { useAgentActivity } from './useAgentActivity'
import { effectiveList, useCompactList } from './useCompactList'
import { ROW_MENU_COMMAND, registerRowMenu, type RowMenuRequest } from './row-menu'
import { useReviewNavigation } from './useReviewNavigation'

type FilterLine = { label: string; count: number }


function presetChoices(kind: ItemKind): { label: string; query: string }[] {
  return kind === 'issue'
    ? [{ label: 'Open', query: presetQuery('open', kind) }, { label: 'Assigned to me', query: presetQuery('assigned', kind) }]
    : [{ label: 'Open', query: presetQuery('open', kind) }, { label: 'Mine', query: presetQuery('mine', kind) }, { label: 'Needs review', query: presetQuery('needs-review', kind) }]
}

function queryTokens(query: string, kind: ItemKind): string[] {
  let normalized = query
  try {
    normalized = queryForKind(query, kind)
  } catch {
    // an unparseable query is compared as written
  }
  return tokenize(normalized).map((token) => token.toLowerCase())
}

/**
 * What the panel's filter line says about `query`, or null when it is the default preset's query.
 * The label is the preset with the most qualifiers that are all in the query, and the count leaves
 * out the qualifiers that preset already carries.
 */
function filterLine(query: string, kind: ItemKind, defaultPreset: string): FilterLine | null {
  const tokens = queryTokens(query, kind)
  const defaults = queryTokens(presetQuery(normalizedPreset(defaultPreset, kind), kind), kind)
  if (tokens.length === defaults.length && defaults.every((token) => tokens.includes(token))) return null
  let best: { label: string; query: string; size: number } | null = null
  for (const preset of presetChoices(kind)) {
    const needed = queryTokens(preset.query, kind)
    if (needed.every((token) => tokens.includes(token)) && (!best || needed.length > best.size)) best = { ...preset, size: needed.length }
  }
  const own = best ? countFilters(filtersFromQuery(best.query), kind) : 0
  return { label: best?.label ?? 'Custom', count: Math.max(0, countFilters(filtersFromQuery(query), kind) - own) }
}

function linkedWorktree(item: ListItem): string | undefined {
  const worktree = object(item.linkedWorkspace)?.worktree
  return typeof worktree === 'string' ? worktree : undefined
}

function isOpenRow(item: ListItem, detail: TaskNavigation['detail']): boolean {
  return detail !== null && detail.worktree === item.worktree && detail.kind === item.kind && detail.number === item.number
}

function useTasksState(context: UiPluginContext) {
  const [state, setState] = useState<TasksState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const adopt = useCallback((next: TasksState) => {
    setState((previous) => !previous || next.revision >= previous.revision ? next : previous)
    setError(null)
  }, [])

  const load = async (prepare: boolean) => {
    const request = ++generation.current
    try {
      const value = prepare
        ? await context.call('quirky.tasks/prepare', {})
        : await context.call('quirky.tasks/state', {})
      const next = parseTasksState(value)
      if (!next) throw new Error('Invalid Tasks state from daemon')
      if (request === generation.current) adopt(next)
    } catch (cause) {
      if (request === generation.current) setError(errorMessage(cause))
    }
  }
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    void loadRef.current(true)
    const off = context.subscribe((event) => {
      if (event.type === 'quirky.tasks/changed' || event.type.startsWith('setting.')) void loadRef.current(false)
    })
    return () => {
      generation.current += 1
      off()
    }
  }, [context])

  const retry = () => { void load(state === null) }
  return { state, error, adopt, retry }
}

/**
 * The Tasks panel for a tool slot: a short list to glance at, with Expand for everything else.
 * It reads the same navigation as the expanded view, so Expand and Collapse keep the view,
 * the open row and the scroll position.
 */
export function CompactTasks({ context, report }: { context: UiPluginContext; report?: (state: unknown) => void }) {
  const { state, error: stateError, adopt, retry } = useTasksState(context)
  const navigation = state?.navigation ?? null
  const list = useCompactList(context, navigation)
  const activity = useAgentActivity(context)
  const [menu, setMenu] = useState<{ x: number; y: number; item: ListItem; returnFocusTo?: HTMLElement } | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const restoredKey = useRef<string | null>(null)
  const wantsFocus = useRef(false)
  const focusViewKey = useRef<string | null>(null)

  const notify = useCallback((title: string, cause: unknown) => context.toast(title, errorMessage(cause)), [context])
  const openReview = useReviewNavigation(context, useCallback((message: string) => context.toast('Could not open Review', message), [context]))

  useEffect(() => { report?.({ visible: true }) }, [report])
  useEffect(() => {
    if (place.takeFocus() === 'row') wantsFocus.current = true
  }, [])

  useEffect(() => {
    if (!menu?.returnFocusTo) return
    const trigger = menu.returnFocusTo
    const menuLabel = `Actions for #${menu.item.number}`
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      const menuRoots = [...document.querySelectorAll<HTMLElement>(`.qt-menu-anchor [role="menu"][aria-label="${menuLabel}"]`)]
      if (!trigger.contains(target) && !menuRoots.some((root) => root.contains(target))) setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') setMenu(null)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  const kind: ItemKind = list.view.mode === 'prs' ? 'pullRequest' : 'issue'
  const rows = list.result?.items.filter((item) => item.kind === kind) ?? []
  const filter = state ? filterLine(list.view.query, kind, state.preferences.defaultTaskViewPreset) : null
  const visibleRows = useRef(rows)
  visibleRows.current = rows
  useEffect(() => registerRowMenu(context, (request: RowMenuRequest) => {
    const item = visibleRows.current.find((row) => row.worktree === request.worktree && row.kind === request.kind && row.number === request.number)
    if (!item) return false
    const key = rowKey(item)
    const renderedRow = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find((row) => row.getAttribute('data-row-key') === key)
    const trigger = renderedRow?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    if (!trigger) return false
    if (request.x === undefined) {
      const bounds = trigger.getBoundingClientRect()
      setMenu({ x: bounds.right, y: bounds.bottom, item, returnFocusTo: trigger })
    } else {
      setMenu({ x: request.x, y: request.y!, item })
    }
    return true
  }), [context])

  useEffect(() => {
    const element = scroller.current
    if (!element || !list.result || restoredKey.current === list.viewKey) return
    restoredKey.current = list.viewKey
    element.scrollTop = place.scrollTop('compact', list.viewKey)
  }, [list.result, list.viewKey])

  useEffect(() => {
    const element = scroller.current
    if (!wantsFocus.current || !element) return
    if (list.viewKey !== '') {
      if (focusViewKey.current === null) focusViewKey.current = list.viewKey
      else if (focusViewKey.current !== list.viewKey) {
        focusViewKey.current = list.viewKey
        wantsFocus.current = false
        return
      }
    }
    if (list.error || (list.result && rows.length === 0)) {
      wantsFocus.current = false
      return
    }
    if (!list.result || rows.length === 0) return
    wantsFocus.current = false
    const selected = element.querySelector<HTMLElement>('.ui-list-row--selected .ui-list-row__main')
    const target = selected ?? element.querySelector<HTMLElement>('.ui-list-row__main')
    selected?.scrollIntoView?.({ block: 'nearest' })
    target?.focus({ preventScroll: true })
  }, [list.error, list.result, list.viewKey, rows.length])

  const expand = () => {
    if (!state) return
    place.requestFocus('row')
    context.openView(TASKS_VIEW, { navigation: state.navigation, revision: state.revision })
  }

  const navigate = async (patch: Record<string, unknown>): Promise<TasksState | null> => {
    try {
      const next = parseTasksState(await context.call('quirky.tasks/navigate', patch))
      if (next) adopt(next)
      return next
    } catch (cause) {
      notify('Could not update Tasks', cause)
      return null
    }
  }

  const fallsBackToList = navigation?.mode === 'projects'
  const listPatch = fallsBackToList ? { mode: list.view.mode, query: list.view.query, page: list.view.page } : {}

  const openRow = async (item: ListItem) => {
    if (!state) return
    place.requestFocus('row')
    const detail = rowTarget(item)
    try {
      const next = parseTasksState(await context.call('quirky.tasks/navigate', { ...listPatch, detail }))
      const current = next ?? { ...state, navigation: { ...state.navigation, detail } }
      if (next) adopt(next)
      context.openView(TASKS_VIEW, { navigation: current.navigation, revision: current.revision })
    } catch (cause) {
      place.takeFocus()
      notify('Could not open the task', cause)
    }
  }

  const openRowActions = (item: ListItem, point?: { x: number; y: number }) => {
    const address = { worktree: item.worktree, kind: item.kind, number: item.number }
    const args = point ? { ...address, x: point.x, y: point.y } : address
    void context.executeCommand(ROW_MENU_COMMAND, args)
  }

  const startOrResume = (item: ListItem) => {
    const resume = linkedWorktree(item) !== undefined
    void context.call('quirky.tasks/workspace', { target: rowTarget(item), action: resume ? 'resume' : 'start' })
      .catch((cause) => notify(resume ? 'Could not resume the workspace' : 'Could not start a workspace', cause))
  }

  const reviewRow = (item: ListItem) => { void openReview(rowTarget(item), 'conversation') }
  const openOnGitHub = (item: ListItem) => {
    void context.executeCommand('command:quirky.tasks/open-link', { url: item.url }).catch((cause) => notify('Could not open the link', cause))
  }
  const copyLink = (item: ListItem) => {
    void context.executeCommand('command:quirky.tasks/copy-link', { url: item.url }).catch((cause) => notify('Could not copy the link', cause))
  }
  const menuItems = (item: ListItem) => [
    { id: 'start', label: linkedWorktree(item) === undefined ? 'Start workspace' : 'Resume', onSelect: () => { menu?.returnFocusTo?.focus(); startOrResume(item) } },
    ...(item.kind === 'pullRequest' ? [{ id: 'review', label: 'Review', onSelect: () => { menu?.returnFocusTo?.focus(); reviewRow(item) } }] : []),
    { id: 'open', label: 'Open on GitHub', onSelect: () => { menu?.returnFocusTo?.focus(); openOnGitHub(item) } },
    { id: 'copy', label: 'Copy link', onSelect: () => { menu?.returnFocusTo?.focus(); copyLink(item) } }
  ]

  const changeMode = (id: string) => {
    const mode = id === 'issues' ? 'issues' : 'prs'
    const last = navigation?.lastList
    void navigate(fallsBackToList && last?.mode === mode ? { mode, query: last.query, page: last.page } : { mode })
  }

  const clearFilters = () => {
    if (!state) return
    void navigate({ ...(fallsBackToList ? { mode: list.view.mode } : {}), query: presetQuery(normalizedPreset(state.preferences.defaultTaskViewPreset, kind), kind), page: 1, scrollTop: 0 })
  }

  const openTaskSources = () => void context.call('quirky.tasks/settings', {}).catch((cause) => notify('Could not open task settings', cause))

  const sourceFailures = list.result?.failures.filter((failure) => failure.stage !== 'count') ?? []
  const noRepositories = navigation?.repoIds?.length === 0 || list.result?.repositories.length === 0
  const problem = list.error ?? (list.result && rows.length === 0 && sourceFailures.length > 0 ? sourceFailures[0]!.message : null)
  const selectedRepos = list.result ? list.result.repositories.filter((repo) => navigation?.repoIds == null || navigation.repoIds.includes(repo.id)) : []
  const noGitHubRemote = !stateError && list.result !== null && selectedRepos.length > 0 &&
    selectedRepos.length === (navigation?.repoIds?.length ?? selectedRepos.length) &&
    selectedRepos.every((repo) => parseSource(list.result!.sources[repo.id]).reason === 'missing_origin')
  const noGitHubRemoteMessage = selectedRepos.length === 1
    ? `No GitHub remote is configured for ${selectedRepos[0]!.displayName || selectedRepos[0]!.name}. Add a GitHub remote to this repository to load GitHub tasks.`
    : `No GitHub remotes are configured for the selected ${selectedRepos.length} repositories. Add a GitHub remote to each repository to load GitHub tasks.`
  const stateNotice = state !== null && stateError !== null
  const staleNotice = state && list.result && !noRepositories && list.refreshError !== null

  let body
  if (stateError && !state) {
    body = <div className="tasks-compact__problem"><InlineError message={stateError} action={{ label: 'Retry', onAction: retry }} /></div>
  } else if (!state || (list.loading && !noRepositories)) {
    body = <div role="status" aria-label="Loading tasks" className="tasks-compact__loading">
      <NoticeLine>Loading tasks…</NoticeLine>
      {[0, 1, 2, 3].map((index) => <div key={index} className="tasks-compact__skeleton" aria-hidden="true" />)}
    </div>
  } else if (noRepositories) {
    body = <div role="status" className="tasks-compact__empty"><EmptyState message="No repositories selected." action={{ label: 'Expand to select projects', onAction: expand }} /></div>
  } else if (noGitHubRemote) {
    body = <div role="status" className="tasks-compact__empty"><EmptyState message={noGitHubRemoteMessage} /></div>
  } else if (problem) {
    body = <div className="tasks-compact__problem"><InlineError message={problem} action={{ label: 'Open task sources', onAction: openTaskSources }} /></div>
  } else if (rows.length === 0) {
    body = <div role="status" className="tasks-compact__empty">
      <EmptyState
        message={`No ${filter ? 'matching' : 'open'} ${kind === 'issue' ? 'issues' : 'pull requests'}`}
        action={staleNotice ? undefined : { label: 'Expand to change filters', onAction: expand }}
      />
    </div>
  } else {
    const hasMore = list.result!.page < list.result!.totalPages
    body = <>
      {list.result!.failures.length > 0 && <div role="status" className="tasks-compact__notice"><NoticeLine>Some repositories could not be loaded.</NoticeLine></div>}
      {rows.map((item) => {
        const key = rowKey(item)
        const worktree = linkedWorktree(item)
        const resolved = rowStatus(item, { viewer: list.viewer, checks: list.checks[key], merge: list.merges[key], activity: worktree === undefined ? undefined : activity.get(worktree) })
        const primaryLabel = worktree === undefined ? 'Start workspace' : 'Resume'
        return <div
          key={key}
          className="tasks-compact__row"
          data-row-key={key}
          onContextMenu={(event) => {
            event.preventDefault()
            openRowActions(item, { x: event.clientX, y: event.clientY })
          }}
        >
          <ListRow
            title={item.title}
            mainTitle={item.title}
            description={rowDescription(item, resolved)}
            status={resolved.status}
            selected={isOpenRow(item, navigation!.detail)}
            onClick={() => void openRow(item)}
            trailing={<>
              <IconButton label={`${primaryLabel} for #${item.number}`} title={primaryLabel} onClick={() => startOrResume(item)}><ControlIcon name="play" /></IconButton>
              <IconButton
                label={`More actions for #${item.number}`}
                title="More actions"
                aria-haspopup="menu"
                onClick={() => openRowActions(item)}
              >
                <ControlIcon name="dots-three" />
              </IconButton>
            </>}
          />
        </div>
      })}
      {hasMore && <div className="tasks-compact__row"><ListRow title="More tasks" onClick={expand} /></div>}
    </>
  }

  return <div className="quirky-tasks tasks-compact">
    <ToolPanelFrame
      title="Tasks"
      tabs={navigation && <Tabs
        label="Task mode"
        items={[
          { id: 'issues', label: 'Issues', ...(list.counts.issues !== null ? { count: list.counts.issues } : {}) },
          { id: 'prs', label: 'PRs', ...(list.counts.prs !== null ? { count: list.counts.prs } : {}) }
        ]}
        value={effectiveList(navigation).mode}
        onChange={changeMode}
      />}
      actions={<IconButton label="Expand Tasks" title="Expand Tasks" disabled={!state} onClick={expand}><ControlIcon name="arrows-out" /></IconButton>}
    >
      {filter && <div className="tasks-compact__filters">
        <span className="tasks-compact__filter-label">{filter.label}</span>
        {filter.count > 0 && <span className="tasks-compact__filter-count">{` · ${filter.count} ${filter.count === 1 ? 'filter' : 'filters'}`}</span>}
        <IconButton label="Clear filters" title="Clear filters" onClick={clearFilters}><ControlIcon name="x" /></IconButton>
      </div>}
      <div
        className="tasks-compact__list"
        ref={(element) => { scroller.current = element; list.rowsRef.current = element }}
        onScroll={(event) => { if (restoredKey.current === list.viewKey) place.setScrollTop('compact', list.viewKey, event.currentTarget.scrollTop) }}
      >
        {stateNotice && <div role="status" className="tasks-compact__notice">
          <NoticeLine actions={[{ label: 'Retry', onAction: retry }]}>Couldn't refresh Tasks. Showing the last loaded tasks.</NoticeLine>
        </div>}
        {staleNotice && <div role="status" className="tasks-compact__notice">
          <NoticeLine actions={[{ label: 'Retry', onAction: list.retry }]}>Couldn't refresh. Showing the last loaded tasks.</NoticeLine>
        </div>}
        {body}
      </div>
    </ToolPanelFrame>
    {menu && <ContextMenu
      label={`Actions for #${menu.item.number}`}
      x={menu.x}
      returnFocusTo={menu.returnFocusTo}
      align={menu.returnFocusTo ? 'end' : 'start'}
      y={menu.y}
      onClose={() => setMenu(null)}
      highlightFirst={Boolean(menu.returnFocusTo)}
      items={menuItems(menu.item)}
    />}
  </div>
}
