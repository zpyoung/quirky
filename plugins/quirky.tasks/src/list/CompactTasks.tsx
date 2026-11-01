import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { ContextMenu, ControlIcon, EmptyState, IconButton, ListRow, Menu, Tabs, ToolPanelFrame } from '@quirky/ui'
import { TASKS_VIEW, type ItemKind, type TaskNavigation, type TasksState } from '../contracts'
import { countFilters, errorMessage, filtersFromQuery, normalizedPreset, object, presetQuery, rowKey, rowTarget, tokenize, type ListItem } from './model'
import { place } from './place'
import { rowDescription, rowStatus } from './row-status'
import { queryForKind } from './search'
import { useAgentActivity } from './useAgentActivity'
import { ROW_KEY_ATTRIBUTE, effectiveList, useCompactList } from './useCompactList'
import { useReviewNavigation } from './useReviewNavigation'

type RowAction = { id: string; label: string; run(): void }
type FilterLine = { label: string; count: number }

function parseState(value: unknown): TasksState | null {
  const raw = object(value)
  const navigation = object(raw?.navigation)
  if (!raw || !navigation || !object(navigation.lastList) || !object(raw.preferences) || typeof raw.revision !== 'number') return null
  return value as TasksState
}

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

  const refresh = useCallback(async (method: 'quirky.tasks/prepare' | 'quirky.tasks/state') => {
    const request = ++generation.current
    try {
      const next = parseState(await context.call(method, {}))
      if (!next) throw new Error('Invalid Tasks state from daemon')
      if (request === generation.current) adopt(next)
    } catch (cause) {
      if (request === generation.current) setError(errorMessage(cause))
    }
  }, [context, adopt])

  useEffect(() => {
    void refresh('quirky.tasks/prepare')
    const off = context.subscribe((event) => {
      if (event.type === 'quirky.tasks/changed' || event.type.startsWith('setting.')) void refresh('quirky.tasks/state')
    })
    return () => {
      generation.current += 1
      off()
    }
  }, [context, refresh])

  return { state, error, adopt, retry: () => void refresh('quirky.tasks/prepare') }
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
  const [menu, setMenu] = useState<{ x: number; y: number; item: ListItem } | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const restoredKey = useRef<string | null>(null)
  const wantsFocus = useRef(false)

  const notify = useCallback((title: string, cause: unknown) => context.toast(title, errorMessage(cause)), [context])
  const openReview = useReviewNavigation(context, useCallback((message: string) => context.toast('Could not open Review', message), [context]))

  useEffect(() => { report?.({ visible: true }) }, [report])
  useEffect(() => {
    if (place.takeFocus() === 'row') wantsFocus.current = true
  }, [])

  const kind: ItemKind = list.view.mode === 'prs' ? 'pullRequest' : 'issue'
  const rows = list.result?.items.filter((item) => item.kind === kind) ?? []
  const filter = state ? filterLine(list.view.query, kind, state.preferences.defaultTaskViewPreset) : null

  useEffect(() => {
    const element = scroller.current
    if (!element || !list.result || restoredKey.current === list.viewKey) return
    restoredKey.current = list.viewKey
    element.scrollTop = place.scrollTop('compact', list.viewKey)
  }, [list.result, list.viewKey])

  useEffect(() => {
    const element = scroller.current
    if (!wantsFocus.current || !element || rows.length === 0) return
    wantsFocus.current = false
    const target = element.querySelector<HTMLElement>('.ui-list-row--selected .ui-list-row__main') ?? element.querySelector<HTMLElement>('.ui-list-row__main')
    target?.scrollIntoView?.({ block: 'nearest' })
    target?.focus({ preventScroll: true })
  }, [rows.length, list.viewKey])

  const expand = () => {
    if (!state) return
    place.requestFocus('row')
    context.openView(TASKS_VIEW, { navigation: state.navigation, revision: state.revision })
  }

  const navigate = async (patch: Record<string, unknown>): Promise<TasksState | null> => {
    try {
      const next = parseState(await context.call('quirky.tasks/navigate', patch))
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
      const next = parseState(await context.call('quirky.tasks/navigate', { ...listPatch, detail }))
      const current = next ?? { ...state, navigation: { ...state.navigation, detail } }
      if (next) adopt(next)
      context.openView(TASKS_VIEW, { navigation: current.navigation, revision: current.revision })
    } catch (cause) {
      place.takeFocus()
      notify('Could not open the task', cause)
    }
  }

  const actionsFor = (item: ListItem): RowAction[] => {
    const target = rowTarget(item)
    const linked = linkedWorktree(item) !== undefined
    const run = (title: string, work: () => Promise<unknown>) => void work().catch((cause) => notify(title, cause))
    return [
      { id: linked ? 'resume' : 'start', label: linked ? 'Resume' : 'Start workspace', run: () => run(linked ? 'Could not resume the workspace' : 'Could not start a workspace', () => context.call('quirky.tasks/workspace', { target, action: linked ? 'resume' : 'start' })) },
      ...(item.kind === 'pullRequest' ? [{ id: 'review', label: 'Review', run: () => void openReview(target, 'conversation') }] : []),
      { id: 'open', label: 'Open on GitHub', run: () => run('Could not open the link', () => context.executeCommand('command:quirky.tasks/open-link', { url: item.url })) },
      { id: 'copy', label: 'Copy link', run: () => run('Could not copy the link', () => context.executeCommand('command:quirky.tasks/copy-link', { url: item.url })) }
    ]
  }

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
  const problem = stateError ?? list.error ?? (list.result && rows.length === 0 && sourceFailures.length > 0 ? sourceFailures[0]!.message : null)

  let body
  if (stateError && !state) {
    body = <div role="alert" className="tasks-compact__problem"><EmptyState message={stateError} action={{ label: 'Retry', onAction: retry }} /></div>
  } else if (!state || (list.loading && !noRepositories)) {
    body = <div role="status" aria-label="Loading tasks" className="tasks-compact__loading">{[0, 1, 2, 3].map((index) => <div key={index} className="tasks-compact__skeleton" aria-hidden="true" />)}</div>
  } else if (noRepositories) {
    body = <div role="status" className="tasks-compact__empty"><EmptyState message="No repositories selected." action={{ label: 'Expand to select projects', onAction: expand }} /></div>
  } else if (problem) {
    body = <div role="alert" className="tasks-compact__problem"><EmptyState message={problem} action={{ label: 'Open task sources', onAction: openTaskSources }} /></div>
  } else if (rows.length === 0) {
    body = <div role="status" className="tasks-compact__empty"><EmptyState message={`No ${filter ? 'matching' : 'open'} ${kind === 'issue' ? 'issues' : 'pull requests'}`} action={{ label: 'Expand to change filters', onAction: expand }} /></div>
  } else {
    const hasMore = list.result!.page < list.result!.totalPages
    body = <>
      {list.result!.failures.length > 0 && <p role="status" className="tasks-compact__notice">Some repositories could not be loaded.</p>}
      {rows.map((item) => {
        const key = rowKey(item)
        const worktree = linkedWorktree(item)
        const resolved = rowStatus(item, { viewer: list.viewer, checks: list.checks[key], merge: list.merges[key], activity: worktree === undefined ? undefined : activity.get(worktree) })
        const actions = actionsFor(item)
        const primary = actions[0]!
        return <div key={key} className="tasks-compact__row" {...{ [ROW_KEY_ATTRIBUTE]: key }} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, item }) }}>
          <ListRow
            title={item.title}
            mainTitle={item.title}
            description={rowDescription(item, resolved)}
            status={resolved.status}
            selected={isOpenRow(item, navigation!.detail)}
            onClick={() => void openRow(item)}
            trailing={<>
              <IconButton label={`${primary.label} for #${item.number}`} title={primary.label} onClick={primary.run}><span aria-hidden="true">▶</span></IconButton>
              <Menu label={`More actions for #${item.number}`} trigger={<ControlIcon name="dots-three" />} items={actions.map((action) => ({ id: action.id, label: action.label, onAction: action.run }))} />
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
        {body}
      </div>
    </ToolPanelFrame>
    {menu && <ContextMenu
      label={`Actions for #${menu.item.number}`}
      x={menu.x}
      y={menu.y}
      onClose={() => setMenu(null)}
      items={actionsFor(menu.item).map((action) => ({ id: action.id, label: action.label, onSelect: action.run }))}
    />}
  </div>
}
