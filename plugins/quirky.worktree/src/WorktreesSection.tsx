import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BulkBar, Button, ControlIcon, Dialog, EmptyState, IconButton, NoticeLine, PopupMenu, TextField, ToolPanelActions, type PopupItem } from '@quirky/ui'
import type { Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { changeGroup, confirmsDelete, currentWindowId, deleteWorkspace, fetchActiveView, fetchViews, saveViews, selectView, setWorkspaceSleeping, setWorktree, type CreateRequests, type KeptBranch, type TrustChoice, type TrustRequest } from './actions'
import { AddProjectDialog } from './AddProjectDialog'
import { BaseFallbackDialog } from './BaseFallbackDialog'
import { CreateDialog } from './CreateDialog'
import { DeleteDialog } from './DeleteDialog'
import { DeleteGroupDialog, NewGroupDialog, NewWorktreeGroupDialog, RenameGroupDialog } from './GroupDialogs'
import { ParentDialog } from './ParentDialog'
import { Notices } from './Notices'
import { DisplayMenu } from './DisplayMenu'
import { clearedFilter, filterChips, FilterMenu, type FilterCatalog } from './FilterMenu'
import { SaveViewDialog } from './SaveViewDialog'
import { ViewTabs } from './ViewTabs'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { RemoveProjectDialog } from './RemoveProjectDialog'
import { buildReport, canonicalDescendants, isAddFlow, repoLabel, type DialogState, type PendingCreate, type SeparatorReport, type WorktreesReport } from './report'
import { useNow } from './StatusDot'
import { Tree } from './Tree'
import { TagsPopover } from './TagsPopover'
import { activityMark, buildTree, type ChecksState } from './view-model'
import { allSpecFromStock, DEFAULT_ACTIVITY_PREFERENCES, DEFAULT_VIEWS_STATE, type ActivityMarkState, type RowFact, type ViewDisplay, type ViewFilter, type ViewId, type ViewSpec, type ViewsState } from './view-types'
import { useWorktreeAttention } from './useWorktreeAttention'
import { TrustDialog } from './TrustDialog'
import { UpdateDialog } from './UpdateDialog'
import { useAutomationAvailability } from './useAutomationAvailability'
import { projectionForSelection, useSidebarActivity } from './useSidebarActivity'
import { useTree } from './useTree'
import { useLoopStatus } from './useLoopStatus'
import { CleanupDialog } from './CleanupDialog'
import { ExternalInbox } from './ExternalInbox'
import { WorktreeBoard } from './WorktreeBoard'
import { DEFAULT_STOCK_OPTIONS, isStockWorktreeOptions, type StockWorktreeOptions } from './control-types'
import { StatusSettingsDialog } from './StatusSettingsDialog'
import { DEFAULT_WORKTREE_STATUSES } from './daemon/statuses'
import type { WorktreeProjectIdentity, WorktreeStatusDefinition } from './parity-types'

import type { MembershipTarget } from './membership'

const SEPARATOR_SETTING = 'setting:quirky.sidebar-extras/sidebar-section-separators'

function readSeparatorSetting(context: UiPluginContext): boolean {
  try {
    const value = context.getSetting(SEPARATOR_SETTING)
    return typeof value === 'boolean' ? value : true
  } catch (error) {
    if (error instanceof Error && error.message === `no setting ${SEPARATOR_SETTING}`) return true
    throw error
  }
}
function projectIdentitiesOf(value: unknown): Record<string, WorktreeProjectIdentity> | null {
  if (!Array.isArray(value)) return null
  const result: Record<string, WorktreeProjectIdentity> = {}
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    const identity = row.identity
    if (typeof row.repoId !== 'string' || typeof identity !== 'object' || identity === null || Array.isArray(identity)) return null
    const fields = identity as Record<string, unknown>
    if (
      (fields.displayName !== null && typeof fields.displayName !== 'string') ||
      (fields.icon !== null && typeof fields.icon !== 'string') ||
      (fields.color !== null && typeof fields.color !== 'string') ||
      (fields.trackerProject !== null && typeof fields.trackerProject !== 'string')
    ) return null
    result[row.repoId] = {
      displayName: fields.displayName,
      icon: fields.icon,
      color: fields.color,
      trackerProject: fields.trackerProject
    }
  }
  return result
}
type Props = { context: UiPluginContext; report?(state: unknown): void; requests?: CreateRequests; addProjectRequests?: CreateRequests }

/** A trust question waiting for an answer; `resolve` hands it back to the create that asked. */
type TrustPrompt = { request: TrustRequest; resolve(choice: TrustChoice): void }
type Fallback = { worktreeId: string; message: string }

const specKey = (spec: ViewSpec) => JSON.stringify(spec)

const GROUP_LABELS: Record<ViewDisplay['groupBy'], string> = {
  'section-project': 'section and project',
  project: 'project',
  status: 'status',
  tag: 'tag',
  'pull-request': 'pull request',
  none: 'nothing'
}
const SORT_LABELS: Record<ViewDisplay['sortBy'], string> = {
  recent: 'recent',
  'agent-activity': 'agent activity',
  name: 'name',
  project: 'project',
  manual: 'manual order'
}

/** The parts of `draft` that differ from `base`, as short phrases for the changed line. */
function changedParts(base: ViewSpec, draft: ViewSpec): string[] {
  const parts: string[] = []
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  if (base.display.groupBy !== draft.display.groupBy) parts.push('grouping')
  if (base.display.sortBy !== draft.display.sortBy) parts.push('sort')
  if (base.display.projectOrder !== draft.display.projectOrder) parts.push('project order')
  if (base.display.showAsleep !== draft.display.showAsleep) parts.push('asleep')
  if (base.display.showNested !== draft.display.showNested) parts.push('nesting')
  const before = base.filter
  const after = draft.filter
  if (!same(before.tagIds, after.tagIds)) parts.push('tags')
  if (!same(before.sectionIds, after.sectionIds)) parts.push('sections')
  if (!same(before.repoIds, after.repoIds)) parts.push('projects')
  if (!same(before.statuses, after.statuses)) parts.push('status')
  if (!same(before.activity, after.activity)) parts.push('activity')
  const hides: Array<keyof ViewFilter> = ['hideCliCreated', 'hideOtherDesktopClients', 'hideDefaultBranch', 'hideDetachedHead', 'hideArchived']
  if (hides.some((key) => before[key] !== after[key])) parts.push('hidden worktrees')
  return parts
}

function newViewId(): string {
  return `view_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

const CREATE_GRACE_MS = 5 * 60 * 1_000
const NO_SESSIONS: Session[] = []
const CLEANUP_REFRESH_MS = 10_000
const VIEWS_RETRY_MS = 3_000

/** Creates an empty section; worktrees and projects join it from their menus or by dragging. */
function NewSectionDialog({ context, onClose }: { context: UiPluginContext; onClose(): void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  return (
    <Dialog open title="New section" onClose={onClose}>
      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (!trimmed) return
          setBusy(true)
          void changeGroup(context, 'Could not create section', () => context.call('quirky.repo/groupCreate', { name: trimmed })).then((ok) => {
            setBusy(false)
            if (ok) onClose()
          })
        }}
      >
        <TextField type="text" label="Section name" id="worktree-section-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !trimmed}>Create</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** The sidebar's workspace tree with its menus, dialogs, add-project form and `ui state` report. */
export function WorktreesSection({ context, report, requests, addProjectRequests }: Props) {
  const { repos, groups, worktrees, sessions, sessionsSettled, tags, otherClientByWorktree, hasAuthenticatedDesktopClient, loaded } = useTree(context)
  const pendingAsks = useWorktreeAttention(context)
  const now = useNow()
  const [layout, setLayout] = useState(() => context.getLayout())
  const [menu, setMenu] = useState<'display' | 'filter' | 'more' | null>(null)
  const displayButton = useRef<HTMLButtonElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const bulkRoot = useRef<HTMLDivElement>(null)
  const [bulkMenu, setBulkMenu] = useState<'section' | 'status' | null>(null)
  const sectionRoot = useRef<HTMLDivElement>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const previousDialog = useRef<DialogState | null>(null)
  const [pending, setPending] = useState<PendingCreate[]>([])
  const [trust, setTrust] = useState<TrustPrompt | null>(null)
  const [fallbacks, setFallbacks] = useState<Fallback[]>([])
  const [requested, setRequested] = useState<{ repoId?: string } | null>(null)
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  const [kept, setKept] = useState<KeptBranch[]>([])
  const [expandedAutomationId, setExpandedAutomationId] = useState<string | null>(null)
  const lastReport = useRef('')
  const [stockOptions, setStockOptions] = useState<StockWorktreeOptions>(() => ({
    ...DEFAULT_STOCK_OPTIONS,
    filterRepoIds: [],
    showProperties: [...DEFAULT_STOCK_OPTIONS.showProperties]
  }))
  const [projectOrder, setProjectOrder] = useState<string[]>([])
  const [statusDefinitions, setStatusDefinitions] = useState<WorktreeStatusDefinition[]>(() => DEFAULT_WORKTREE_STATUSES.map((status) => ({ ...status })))
  const [projectIdentities, setProjectIdentities] = useState<Record<string, WorktreeProjectIdentity>>({})
  const [revealHidden, setRevealHidden] = useState(false)
  const [viewsState, setViewsState] = useState<ViewsState>(DEFAULT_VIEWS_STATE)
  const viewsLoaded = useRef(false)
  const [activeViewId, setActiveViewId] = useState<ViewId>('all')
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ViewSpec>>(() => new Map())
  const [saveOpen, setSaveOpen] = useState(false)
  const [savingView, setSavingView] = useState(false)
  const [cleanupCount, setCleanupCount] = useState(0)
  const activeSeq = useRef(0)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [boardOpen, setBoardOpen] = useState(false)
  const [statusEditorOpen, setStatusEditorOpen] = useState(false)
  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(() => new Set())
  const selectionAnchor = useRef<string | null>(null)
  const visibleOrder = useRef<string[]>([])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [tagsTarget, setTagsTarget] = useState<{ ids: string[]; anchor: HTMLElement } | null>(null)

  useEffect(() => {
    const previous = previousDialog.current
    previousDialog.current = dialog
    if (
      dialog !== null ||
      (previous?.kind !== 'update' && previous?.kind !== 'delete')
    ) return

    let row: HTMLElement | null = null
    for (const item of sectionRoot.current?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? []) {
      if (item.dataset.worktreeId === previous.worktreeId) {
        row = item
        break
      }
    }
    const actions = row?.querySelector<HTMLButtonElement>('.worktree-menu')
    if (actions?.isConnected) actions.focus()
  }, [dialog])
  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])
  useEffect(() => {
    let active = true
    const unsubscribe = context.subscribe((event) => {
      if (!('data' in event) || typeof event.data !== 'object' || event.data === null) return
      if (event.type === 'quirky.worktree/optionsChanged' || event.type === 'quirky.repo/changed') {
        if (event.type === 'quirky.worktree/optionsChanged' && 'options' in event.data && isStockWorktreeOptions(event.data.options)) {
          setStockOptions(event.data.options)
        }
        void context.call('quirky.worktree/projectOrder').then((value: unknown) => {
          if (active && Array.isArray(value) && value.every((id) => typeof id === 'string')) setProjectOrder(value)
        }).catch((error: unknown) => context.log(`could not reload project order: ${error instanceof Error ? error.message : String(error)}`))
      }
      if (event.type === 'quirky.worktree/statusDefinitionsChanged' && 'statuses' in event.data) {
        const value = event.data.statuses
        if (Array.isArray(value)) setStatusDefinitions(value as WorktreeStatusDefinition[])
      }
    })
    void context.call('quirky.worktree/options').then((value: unknown) => {
      if (active && isStockWorktreeOptions(value)) setStockOptions(value)
    }).catch((error: unknown) => context.toast('Could not load workspace options', error instanceof Error ? error.message : String(error)))
    void context.call('quirky.worktree/projectOrder').then((value: unknown) => {
      if (active && Array.isArray(value) && value.every((id) => typeof id === 'string')) setProjectOrder(value)
    }).catch((error: unknown) => context.log(`could not load project order: ${error instanceof Error ? error.message : String(error)}`))
    void context.call('quirky.worktree/statusDefinitions').then((value: unknown) => {
      if (active && Array.isArray(value)) setStatusDefinitions(value as WorktreeStatusDefinition[])
    }).catch((error: unknown) => context.log(`could not load workspace statuses: ${error instanceof Error ? error.message : String(error)}`))
    return () => {
      active = false
      unsubscribe()
    }
  }, [context])
  useEffect(() => {
    let active = true
    const load = () => {
      void context.call('quirky.worktree/projectMetadataList').then((value: unknown) => {
        const identities = projectIdentitiesOf(value)
        if (active && identities !== null) setProjectIdentities(identities)
      }).catch((error: unknown) => context.log(`could not load project identity: ${error instanceof Error ? error.message : String(error)}`))
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.repo/changed' || event.type === 'quirky.worktree/projectMetadataChanged') load()
    })
    load()
    return () => {
      active = false
      unsubscribe()
    }
  }, [context])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.defaultPrevented) return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      let method: string | null = null
      let params: Record<string, unknown> = {}
      if (event.altKey && !event.shiftKey && event.key === 'ArrowLeft') method = 'quirky.worktree/navigationBack'
      else if (event.altKey && !event.shiftKey && event.key === 'ArrowRight') method = 'quirky.worktree/navigationForward'
      else if (event.shiftKey && !event.altKey && event.key === 'ArrowUp') {
        method = 'quirky.worktree/navigationMove'
        params = { direction: 'previous' }
      } else if (event.shiftKey && !event.altKey && event.key === 'ArrowDown') {
        method = 'quirky.worktree/navigationMove'
        params = { direction: 'next' }
      } else if (!event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        method = 'quirky.worktree/navigationIndex'
        params = { index: Number(event.key) }
      }
      if (!method) return
      event.preventDefault()
      const navigationMethod = method
      void currentWindowId(context).then((window) => context.call(navigationMethod, { ...params, window })).catch((error: unknown) =>
        context.toast('Could not navigate workspaces', error instanceof Error ? error.message : String(error))
      )
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [context])

  useEffect(() => requests?.attach(setRequested), [requests])
  useEffect(() => addProjectRequests?.attach(() => setDialog({ kind: 'add-project' })), [addProjectRequests])

  const selectedId = layout.worktree ?? null
  const activeView = viewsState.views.find((view) => view.id === activeViewId)
  const activeId: ViewId = activeViewId === 'all' || activeViewId === 'needs-you' ? (activeViewId === 'needs-you' && viewsState.needsYouHidden ? 'all' : activeViewId) : activeView ? activeViewId : 'all'
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const viewActivity = drafts.get(activeId)?.filter.activity ?? activeView?.spec.filter.activity ?? null
  const selectedInstance = worktrees.find((worktree) => worktree.id === selectedId)?.instanceId
  const activity = useSidebarActivity(context, selectedId, loaded, viewActivity, selectedInstance)
  const loopStatus = useLoopStatus(context, worktrees, loaded)
  const activityProjection = activity.projection
  const currentProjection = useMemo(
    () => activity.status === 'available' && activityProjection !== null
      ? projectionForSelection(activityProjection, selectedId, selectedInstance)
      : null,
    [activity.status, activityProjection, selectedId, selectedInstance]
  )
  const visibleIds = useMemo(
    () => currentProjection ? new Set(currentProjection.visibleIds) : null,
    [currentProjection]
  )
  const allSpec = useMemo(
    () => allSpecFromStock(stockOptions, activity.stored ?? DEFAULT_ACTIVITY_PREFERENCES),
    [stockOptions, activity.stored]
  )
  const baseSpec = activeView ? activeView.spec : allSpec
  const baseSpecRef = useRef(baseSpec)
  baseSpecRef.current = baseSpec
  const draft = drafts.get(activeId)
  const spec = draft ?? baseSpec
  const changed = draft !== undefined
  const alwaysShowPrimary = spec.filter.activity.alwaysShowDefaultBranchWorkspace
  const canShowSleeping = (worktree: Worktree) =>
    spec.display.showAsleep || revealHidden || (worktree.isMain && alwaysShowPrimary)
  const editSpec = useCallback((edit: (current: ViewSpec) => ViewSpec) => {
    setDrafts((previous) => {
      const id = activeIdRef.current
      const base = baseSpecRef.current
      const edited = edit(previous.get(id) ?? base)
      const activity = edited.filter.activity
      const window = activity.workspaceActivityWindow
      const next: ViewSpec = {
        ...edited,
        filter: {
          ...edited.filter,
          activity: {
            ...activity,
            ...(window === 'custom' ? {} : { workspaceActivityCustomDays: base.filter.activity.workspaceActivityCustomDays }),
            ...(window === 'live-only' ? {} : { workspaceActivityWindowBeforeLiveOnly: window })
          }
        }
      }
      const rest = new Map(previous)
      if (specKey(next) === specKey(base)) rest.delete(id)
      else rest.set(id, next)
      return rest
    })
  }, [])
  const changeDisplay = useCallback((patch: Partial<ViewDisplay>) => editSpec((current) => ({ ...current, display: { ...current.display, ...patch } })), [editSpec])
  const changeFilter = useCallback((filter: ViewFilter) => editSpec((current) => ({ ...current, filter })), [editSpec])
  const clearFilters = useCallback(() => {
    setRevealHidden(false)
    editSpec((current) => ({ ...current, filter: clearedFilter(current.filter) }))
  }, [editSpec])
  const revertDraft = useCallback(() => {
    setRevealHidden(false)
    setDrafts((previous) => {
      const rest = new Map(previous)
      rest.delete(activeIdRef.current)
      return rest
    })
  }, [])
  const orderedRepos = useMemo(() => {
    const activityByRepo = new Map<string, number>()
    for (const worktree of worktrees) {
      const activityAt = Math.max(worktree.lastActivityAt, worktree.createdAt + CREATE_GRACE_MS)
      activityByRepo.set(worktree.repoId, Math.max(activityByRepo.get(worktree.repoId) ?? 0, activityAt))
    }
    if (spec.display.projectOrder === 'recent') {
      return [...repos].sort((left, right) =>
        (activityByRepo.get(right.id) ?? 0) - (activityByRepo.get(left.id) ?? 0) ||
        repoLabel(left).localeCompare(repoLabel(right)) || left.id.localeCompare(right.id)
      )
    }
    const order = new Map(projectOrder.map((id, index) => [id, index]))
    return [...repos].sort((left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      repoLabel(left).localeCompare(repoLabel(right)) || left.id.localeCompare(right.id)
    )
  }, [repos, worktrees, projectOrder, spec.display.projectOrder])
  const reorderWorktrees = useCallback(async (ids: string[]) => {
    try {
      await context.call('quirky.worktree/reorder', { worktrees: ids })
    } catch (error) {
      context.toast('Could not reorder workspaces', error instanceof Error ? error.message : String(error))
    }
  }, [context])
  const reorderProjects = useCallback(async (ids: string[]) => {
    try {
      await context.call('quirky.worktree/reorderProjects', { projects: ids })
      setProjectOrder(ids)
    } catch (error) {
      context.toast('Could not reorder projects', error instanceof Error ? error.message : String(error))
    }
  }, [context])
  const automationDetailWorktreeId = expandedAutomationId !== null &&
    (visibleIds === null || visibleIds.has(expandedAutomationId))
      ? expandedAutomationId
      : null
  const expandedAutomationWorktree = automationDetailWorktreeId === null
    ? null
    : worktrees.find((worktree) => worktree.id === automationDetailWorktreeId) ?? null
  const automationAvailability = useAutomationAvailability(context, expandedAutomationWorktree)
  useEffect(() => {
    if (!loaded || expandedAutomationId === null) return
    const expanded = worktrees.find((worktree) => worktree.id === expandedAutomationId)
    if (
      expanded?.automationProvenance?.kind !== 'created-by-automation' ||
      (visibleIds !== null && !visibleIds.has(expandedAutomationId))
    ) setExpandedAutomationId(null)
  }, [expandedAutomationId, loaded, worktrees, visibleIds])
  const toggleAutomationDetails = useCallback((worktreeId: string) => {
    setExpandedAutomationId((current) => current === worktreeId ? null : worktreeId)
  }, [])
  const [dropPreview, setDropPreview] = useState<MembershipTarget | null>(null)
  const [separatorState, setSeparatorState] = useState<SeparatorReport>(() => ({
    enabled: readSeparatorSetting(context),
    eligibleBoundaries: []
  }))
  const separatorEnabled = separatorState.enabled

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'plugin.changed' &&
        !event.type.startsWith('setting.') &&
        !event.type.startsWith('setting/') &&
        !event.type.startsWith('settings/')) return
      const enabled = readSeparatorSetting(context)
      setSeparatorState((previous) => previous.enabled === enabled ? previous : { ...previous, enabled })
    })
    return unsubscribe
  }, [context])

  const changeDropPreview = useCallback((target: MembershipTarget | null) => {
    setDropPreview((previous) =>
      previous?.kind === target?.kind && previous?.id === target?.id ? previous : target
    )
  }, [])
  const changeSeparatorState = useCallback((next: SeparatorReport) => {
    setSeparatorState((previous) =>
      previous.enabled === next.enabled &&
      previous.eligibleBoundaries.length === next.eligibleBoundaries.length &&
      previous.eligibleBoundaries.every((key, index) => key === next.eligibleBoundaries[index])
        ? previous
        : next
    )
  }, [])

  // the command's project: the one named, else the open worktree's, else the first
  useEffect(() => {
    if (!requested || !loaded) return
    const open = worktrees.find((w) => w.id === selectedId)?.repoId
    const repoId = requested.repoId ?? (repos.some((r) => r.id === open) ? open : repos[0]?.id)
    setRequested(null)
    if (repoId) setDialog({ kind: 'create', repoId })
    else context.toast('Could not create worktree', 'Add a project first.')
  }, [requested, loaded, repos, worktrees, selectedId, context])

  // a delete the window has sent shows as deleting before the daemon's own flag arrives
  const shown = useMemo(
    () => (deleting.size === 0 ? worktrees : worktrees.map((worktree) => (deleting.has(worktree.id) ? { ...worktree, removing: true } : worktree))),
    [worktrees, deleting]
  )
  const markSessions = sessions ?? (sessionsSettled ? NO_SESSIONS : null)
  const marks = useMemo(() => {
    const result = new Map<string, ActivityMarkState>()
    for (const worktree of shown) result.set(worktree.id, activityMark(worktree, markSessions, pendingAsks, now))
    return result
  }, [shown, markSessions, pendingAsks, now])
  const checks = useMemo(() => {
    const result = new Map<string, ChecksState | null>()
    for (const entry of activityProjection?.workspaces ?? []) {
      result.set(entry.worktreeId, entry.checks ?? null)
    }
    return result
  }, [activityProjection])
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const tree = useMemo(
    () => buildTree({
      worktrees: shown,
      repos,
      groups,
      tags,
      spec,
      viewId: activeId,
      projection: revealHidden ? null : currentProjection,
      marks,
      checks,
      projectOrder,
      sessions,
      otherClients: { authenticated: hasAuthenticatedDesktopClient, byWorktree: otherClientByWorktree },
      statuses: statusDefinitions,
      reveal: { filtered: revealHidden, asleep: revealHidden }
    }),
    [shown, repos, groups, tags, spec, activeId, currentProjection, marks, checks, projectOrder, sessions, hasAuthenticatedDesktopClient, otherClientByWorktree, statusDefinitions, revealHidden]
  )
  const treeOptions = useMemo(
    () => ({ ...stockOptions, sortBy: spec.display.sortBy, projectOrderBy: spec.display.projectOrder }),
    [stockOptions, spec.display.sortBy, spec.display.projectOrder]
  )
  const treeVisibleIds = useMemo(
    () => new Set(tree.groups.flatMap((group) => group.rows.map((row) => row.worktree.id))),
    [tree]
  )
  visibleOrder.current = useMemo(() => [...treeVisibleIds], [treeVisibleIds])
  const selectToggle = useCallback((id: string, mode: 'toggle' | 'range', rendered?: readonly string[]) => {
    setMultiSelected((previous) => {
      const next = new Set(previous)
      const order = rendered ?? visibleOrder.current
      const anchor = selectionAnchor.current ?? selectedId
      const from = anchor === null ? -1 : order.indexOf(anchor)
      const to = order.indexOf(id)
      if (mode === 'range' && from >= 0 && to >= 0) {
        for (const item of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(item)
      } else {
        if (!next.delete(id)) next.add(id)
        selectionAnchor.current = id
      }
      return next
    })
  }, [selectedId])
  const clearSelection = useCallback(() => {
    selectionAnchor.current = null
    setMultiSelected((previous) => (previous.size === 0 ? previous : new Set()))
  }, [])
  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  useEffect(() => {
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const loadViews = () => {
      clearTimeout(retry)
      const failed = () => {
        if (!active || viewsLoaded.current) return
        retry = setTimeout(loadViews, VIEWS_RETRY_MS)
      }
      void fetchViews(context).then((next) => {
        if (!active) return
        if (next && Array.isArray(next.views)) {
          viewsLoaded.current = true
          setViewsState(next)
        } else failed()
      }).catch((error: unknown) => {
        context.log(`could not load views: ${error instanceof Error ? error.message : String(error)}`)
        failed()
      })
    }
    const loadActive = () => {
      const ticket = ++activeSeq.current
      void fetchActiveView(context).then((id) => {
        if (active && ticket === activeSeq.current && typeof id === 'string') setActiveViewId(id)
      }).catch((error: unknown) => context.log(`could not load the active view: ${error instanceof Error ? error.message : String(error)}`))
    }
    loadViews()
    loadActive()
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.worktree/viewsChanged') return
      loadViews()
      loadActive()
    })
    const stopConnection = context.onConnection((status) => {
      if (status !== 'connected') return
      loadViews()
      loadActive()
    })
    return () => {
      active = false
      clearTimeout(retry)
      unsubscribe()
      stopConnection()
    }
  }, [context])
  useEffect(() => {
    if (!loaded || cleanupOpen) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      void context.call('quirky.worktree/cleanupPreview').then((value: unknown) => {
        const candidates = (value as { candidates?: Array<{ eligible?: boolean; ignored?: boolean }> } | null)?.candidates
        if (active && Array.isArray(candidates)) setCleanupCount(candidates.filter((candidate) => candidate.eligible === true && candidate.ignored !== true).length)
      }).catch((error: unknown) => context.log(`could not load cleanup candidates: ${error instanceof Error ? error.message : String(error)}`))
    }
    load()
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.worktree/changed' && event.type !== 'quirky.repo/changed') return
      clearTimeout(timer)
      timer = setTimeout(load, CLEANUP_REFRESH_MS)
    })
    return () => {
      active = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [context, loaded, cleanupOpen])

  const switchView = useCallback((id: ViewId) => {
    activeSeq.current++
    setActiveViewId(id)
    setRevealHidden(false)
    clearSelection()
    void selectView(context, id).then((ok) => {
      if (ok) return
      const ticket = ++activeSeq.current
      void fetchActiveView(context).then((current) => {
        if (ticket === activeSeq.current) setActiveViewId(current)
      }).catch(() => {})
    })
  }, [context, clearSelection])
  const viewsReady = useCallback((): boolean => {
    if (!viewsLoaded.current) context.toast('Views are still loading', 'Try again in a moment.')
    return viewsLoaded.current
  }, [context])
  const updateViews = useCallback(async (next: ViewsState): Promise<boolean> => {
    if (!viewsReady()) return false
    const saved = await saveViews(context, next)
    if (saved) setViewsState(saved)
    return saved !== null
  }, [context, viewsReady])
  const catalog = useMemo<FilterCatalog>(() => ({
    tags,
    sections: groups,
    repos: orderedRepos,
    statuses: statusDefinitions
  }), [tags, groups, orderedRepos, statusDefinitions])
  const chips = useMemo(() => filterChips(spec.filter, catalog), [spec.filter, catalog])
  const filtering = activeId !== 'needs-you' && chips.length > 0
  const saveDraft = async () => {
    if (!activeView || !draft) return
    const id = activeView.id
    const saved = await updateViews({ ...viewsState, views: viewsState.views.map((view) => (view.id === id ? { ...view, spec: draft } : view)) })
    if (saved) setDrafts((previous) => {
      const rest = new Map(previous)
      rest.delete(id)
      return rest
    })
  }
  const saveAsNew = async (name: string, starred: boolean) => {
    const origin = activeIdRef.current
    const id = newViewId()
    setSavingView(true)
    const saved = await updateViews({ ...viewsState, views: [...viewsState.views, { id, name, starred, spec }] })
    setSavingView(false)
    if (!saved) return
    setSaveOpen(false)
    setDrafts((previous) => {
      const rest = new Map(previous)
      rest.delete(origin)
      return rest
    })
    switchView(id)
  }
  const hideNeedsYou = (hidden: boolean) => {
    if (!viewsReady()) return
    if (hidden && activeId === 'needs-you') switchView('all')
    void updateViews({ ...viewsState, needsYouHidden: hidden })
  }
  const starView = (id: string, starred: boolean) =>
    void updateViews({ ...viewsState, views: viewsState.views.map((view) => (view.id === id ? { ...view, starred } : view)) })
  const deleteView = (id: string) => {
    if (!viewsReady()) return
    if (activeId === id) switchView('all')
    setDrafts((previous) => {
      const rest = new Map(previous)
      rest.delete(id)
      return rest
    })
    void updateViews({ ...viewsState, views: viewsState.views.filter((view) => view.id !== id) })
  }
  const changeRowFact = (fact: RowFact) => void updateViews({ ...viewsState, rowFact: fact })
  const changedIds = useMemo<ReadonlySet<ViewId>>(() => new Set(drafts.keys()), [drafts])

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [role="menu"], [role="dialog"]')) return
      if (document.querySelector('[role="menu"]')) return
      if (menu !== null || dialog !== null || cleanupOpen || saveOpen || statusEditorOpen || trust !== null || fallbacks.length > 0) return
      if (multiSelected.size > 0) clearSelection()
      else if (filtering) clearFilters()
      else if (activeId !== 'all') switchView('all')
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [multiSelected, clearSelection, filtering, clearFilters, activeId, switchView, menu, dialog, cleanupOpen, saveOpen, statusEditorOpen, trust, fallbacks])
  const hiddenAsleep = useMemo(
    () => shown.filter((worktree) => !treeVisibleIds.has(worktree.id) && worktree.sleeping),
    [shown, treeVisibleIds]
  )
  const hiddenOther = useMemo(
    () => shown.filter((worktree) => !treeVisibleIds.has(worktree.id) && !worktree.sleeping),
    [shown, treeVisibleIds]
  )
  const state: WorktreesReport = useMemo(() => {
    // a stacked question is what the person is looking at, so it is what `ui state` reports
    const front: DialogState | null = trust
      ? { kind: 'trust', repoId: trust.request.repoId }
      : fallbacks[0]
        ? { kind: 'base-fallback', worktreeId: fallbacks[0].worktreeId }
        : cleanupOpen
          ? { kind: 'cleanup' }
          : dialog
    return {
      ...buildReport({
        repos: orderedRepos,
        groups,
        worktrees: shown,
        sessions,
        selectedId,
        pending,
        visibleIds: treeVisibleIds,
        activity: currentProjection,
        automationAvailability,
        activityStatus: activity.status,
        activityError: activity.error,
        separators: separatorState,
        dropPreview,
        now,
        dialog: front,
        loopStatus,
        notices: kept.map((item) => ({ kind: 'kept-branch', branch: item.branch, repoId: item.repoId }))
      }),
      stockOptions,
      stockHiddenIds: hiddenAsleep.map((worktree) => worktree.id),
      stockHiddenCount: hiddenAsleep.length,
      stockFilteredHiddenIds: hiddenOther.map((worktree) => worktree.id),
      stockFilteredHiddenCount: hiddenOther.length,
      revealSleeping: revealHidden,
      revealFiltered: revealHidden,
      projectOrder,
      statusDefinitions
    }
  }, [orderedRepos, repos, groups, shown, sessions, selectedId, pending, treeVisibleIds, currentProjection, automationAvailability, activity.status, activity.error, separatorState, dropPreview, dialog, trust, fallbacks, cleanupOpen, kept, now, loopStatus, stockOptions, hiddenAsleep, hiddenOther, revealHidden, projectOrder, statusDefinitions])

  useEffect(() => {
    if (!loaded) return
    const text = JSON.stringify(state)
    if (text === lastReport.current) return
    lastReport.current = text
    report?.(state)
  }, [loaded, state, report])

  const closeDialog = useCallback(() => setDialog(null), [])
  const closeCleanup = useCallback(() => setCleanupOpen(false), [])
  const trackPending = useCallback((repoId: string, name: string) => {
    const create = { repoId, name }
    setPending((prev) => [...prev, create])
    return () => setPending((prev) => prev.filter((p) => p !== create))
  }, [])

  const createHooks = useMemo(
    () => ({
      askTrust: (request: TrustRequest) => new Promise<TrustChoice>((resolve) => setTrust({ request, resolve })),
      showFallback: (worktreeId: string, message: string) => setFallbacks((prev) => [...prev, { worktreeId, message }])
    }),
    []
  )
  const answerTrust = (choice: TrustChoice) => {
    trust?.resolve(choice)
    setTrust(null)
  }

  const runDelete = useCallback(
    async (worktree: Worktree, options: { withDescendants?: boolean; dontAskAgain?: boolean }) => {
      setDeleting((prev) => new Set(prev).add(worktree.id))
      const left = await deleteWorkspace(context, worktree, options)
      setDeleting((prev) => {
        const next = new Set(prev)
        next.delete(worktree.id)
        return next
      })
      if (left) setKept((prev) => [...prev.filter((k) => k.repoId !== left.repoId || k.branch !== left.branch), left])
    },
    [context]
  )
  const requestDelete = useCallback(
    (worktree: Worktree, descendants: number) => {
      if (confirmsDelete(context)) setDialog({ kind: 'delete', worktreeId: worktree.id, withDescendants: descendants > 0 })
      else void runDelete(worktree, { withDescendants: descendants > 0 })
    },
    [context, runDelete]
  )
  const dismissKept = useCallback(
    (entry: KeptBranch) => setKept((prev) => prev.filter((k) => k.repoId !== entry.repoId || k.branch !== entry.branch)),
    []
  )

  const target: Worktree | undefined =
    dialog?.kind === 'update' || dialog?.kind === 'parent' || dialog?.kind === 'delete'
      ? worktrees.find((w) => w.id === dialog.worktreeId)
      : undefined
  const dialogRepo = dialog && 'repoId' in dialog ? repos.find((repo) => repo.id === dialog.repoId) : undefined
  const dialogGroup = dialog?.kind === 'group' && (dialog.action === 'rename' || dialog.action === 'delete')
    ? groups.find((group) => group.id === dialog.groupId)
    : undefined
  const descendantIds = useMemo(() => canonicalDescendants(worktrees), [worktrees])
  const descendants =
    dialog?.kind === 'delete' && dialog.withDescendants && target
      ? (descendantIds.get(target.id) ?? [])
          .map((id) => worktrees.find((worktree) => worktree.id === id))
          .filter((worktree): worktree is NonNullable<typeof worktree> => worktree !== undefined)
      : undefined
  const trustRepo = trust ? repos.find((repo) => repo.id === trust.request.repoId) : undefined
  const openAddProject = () => setDialog({ kind: 'add-project' })
  const openCleanup = () => setCleanupOpen(true)
  const openStatusEditor = () => setStatusEditorOpen(true)
  const bulkIds = useMemo(() => [...multiSelected].filter((id) => shown.some((worktree) => worktree.id === id)), [multiSelected, shown])
  const bulkWorktrees = useMemo(() => shown.filter((worktree) => multiSelected.has(worktree.id)), [shown, multiSelected])
  const moveToSection = async (groupId: string | null) => {
    const reposById = new Map(repos.map((repo) => [repo.id, repo]))
    const projects = new Set<string>()
    for (const worktree of bulkWorktrees) {
      const repo = reposById.get(worktree.repoId)
      if (worktree.kind === 'git' && repo?.kind === 'git') {
        if (worktree.projectGroupId === groupId) continue
        await changeGroup(context, 'Could not change worktree section', () =>
          context.call('quirky.worktree/set', {
            worktree: worktree.id,
            projectGroupId: groupId,
            expectedInstanceId: worktree.instanceId,
            expectedProjectGroupId: worktree.projectGroupId
          })
        )
      } else if (repo && !projects.has(repo.id) && (groupId ?? null) !== repo.groupId) {
        projects.add(repo.id)
        await changeGroup(context, 'Could not move project', () =>
          groupId === null
            ? context.call('quirky.repo/groupRemove', { group: repo.groupId, repo: repo.id })
            : context.call('quirky.repo/groupAdd', { group: groupId, repo: repo.id })
        )
      }
    }
  }
  const sleepSelected = async () => {
    for (const worktree of bulkWorktrees) if (!worktree.sleeping) await setWorkspaceSleeping(context, worktree.id, true)
  }
  const bulkItems = (kind: 'section' | 'status'): PopupItem[] => kind === 'section'
    ? [
        ...groups.map((group) => ({ label: group.name, onSelect: () => void moveToSection(group.id) })),
        { label: 'Remove from section', separatorBefore: groups.length > 0, onSelect: () => void moveToSection(null) }
      ]
    : statusDefinitions.map((status) => ({
        label: status.label,
        onSelect: () => void Promise.all(bulkIds.map((id) => setWorktree(context, id, { status: status.id as Worktree['status'] })))
      }))
  const hiddenLine = revealHidden
    ? { text: 'Showing hidden worktrees', action: 'Hide' }
    : tree.hidden.count > 0
      ? { text: `${tree.hidden.count} hidden: ${tree.hidden.reasons.join(', ')}`, action: 'Show' }
      : null
  const changeLabels = draft ? changedParts(baseSpec, draft) : []

  return (
    <div ref={sectionRoot} className="ui-stack ui-panel-content worktree-tree-section">
      <ToolPanelActions>
        <>
          <IconButton
            ref={displayButton}
            className="worktree-tree-header-button"
            label="Display"
            title="Display"
            aria-haspopup="menu"
            aria-expanded={menu === 'display'}
            onClick={() => setMenu((current) => (current === 'display' ? null : 'display'))}
          >
            <ControlIcon name="squares-four" />
          </IconButton>
          <IconButton
            ref={filterButton}
            className={`worktree-tree-header-button${filtering ? ' worktree-tree-header-button--counted' : ''}`}
            label="Filter"
            aria-haspopup="dialog"
            aria-expanded={menu === 'filter'}
            disabled={activeId === 'needs-you'}
            title={activeId === 'needs-you' ? 'Needs you has its own filter' : filtering ? `Filter: ${chips.length} active` : 'Filter'}
            onClick={() => setMenu((current) => (current === 'filter' ? null : 'filter'))}
          >
            <ControlIcon name="funnel" />
            {filtering ? <span className="worktree-tree-header-button__count" aria-hidden="true">{chips.length}</span> : null}
          </IconButton>
          <IconButton
            className="worktree-tree-header-button"
            label="New worktree"
            onClick={() => setRequested({})}
          >
            <ControlIcon name="plus" />
          </IconButton>
          <IconButton
            ref={moreButton}
            className="worktree-tree-header-button"
            label="More"
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
            onClick={() => setMenu((current) => (current === 'more' ? null : 'more'))}
          >
            <ControlIcon name="dots-three" />
          </IconButton>
        </>
      </ToolPanelActions>
      {menu === 'display' && displayButton.current && (
        <DisplayMenu
          anchor={displayButton.current}
          display={spec.display}
          rowFact={viewsState.rowFact}
          onDisplay={changeDisplay}
          onRowFact={changeRowFact}
          onSaveAsView={() => setSaveOpen(true)}
          onClose={() => setMenu(null)}
        />
      )}
      {menu === 'filter' && (
        <FilterMenu
          anchor={filterButton}
          filter={spec.filter}
          activityError={activity.status === 'error' ? activity.error : null}
          {...catalog}
          onChange={changeFilter}
          onClear={clearFilters}
          onClose={() => setMenu(null)}
        />
      )}
      {menu === 'more' && moreButton.current && (
        <PopupMenu
          anchor={moreButton.current}
          title="Worktrees"
          items={[
            { label: 'Add project', onSelect: openAddProject },
            { label: 'Workspace board', checked: boardOpen, onSelect: () => setBoardOpen((open) => !open) },
            { label: 'Edit statuses', onSelect: openStatusEditor },
            { label: 'Review cleanup', badge: cleanupCount > 0 ? cleanupCount : undefined, onSelect: openCleanup }
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      <ViewTabs
        views={viewsState.views}
        needsYouHidden={viewsState.needsYouHidden}
        needsYouCount={tree.needsYouCount}
        needsYouErrored={tree.erroredCount > 0}
        activeId={activeId}
        changedIds={changedIds}
        onSelect={switchView}
        onHideNeedsYou={hideNeedsYou}
        onStar={starView}
        onDelete={deleteView}
      />
      {changed && (
        <NoticeLine
          actions={[
            ...(activeView ? [{ label: 'Save', onAction: () => void saveDraft() }] : []),
            { label: 'Save as new', onAction: () => setSaveOpen(true) },
            { label: 'Revert', onAction: revertDraft }
          ]}
        >
          Changed: {changeLabels.join(', ')}
        </NoticeLine>
      )}
      {filtering && (
        <NoticeLine actions={[{ label: 'Clear', onAction: clearFilters }]}>
          Filtered:{' '}
          {chips.map((chip) => (
            <span className="worktree-tree-filter-chip" key={chip.key}>
              {chip.label}
              <button
                type="button"
                className="worktree-tree-filter-chip__remove"
                aria-label={`Remove filter ${chip.label}`}
                onClick={() => changeFilter(chip.remove(spec.filter))}
              >
                ×
              </button>
            </span>
          ))}
        </NoticeLine>
      )}
      {hiddenLine && loaded && (
        <NoticeLine actions={[{ label: hiddenLine.action, onAction: () => setRevealHidden((current) => !current) }]}>
          {hiddenLine.text}
        </NoticeLine>
      )}
      {boardOpen && (
        <div className="worktree-tree-board-scroll ui-scroll">
          <WorktreeBoard
            worktrees={shown.filter((worktree) => treeVisibleIds.has(worktree.id))}
            statuses={statusDefinitions}
            repos={repos}
            open={(worktree) => {
              void currentWindowId(context).then((window) =>
                context.call('quirky.worktree/navigate', { worktree: worktree.id, window })
              ).catch((error: unknown) =>
                context.toast('Could not open workspace', error instanceof Error ? error.message : String(error))
              )
            }}
            setStatus={(worktree, status) => void setWorktree(context, worktree.id, { status })}
          />
        </div>
      )}
      {!loaded && <p className="ui-text-muted" role="status">Loading projects and worktrees…</p>}
      {loaded && repos.length === 0 && (
        <EmptyState message="No projects yet." action={{ label: 'Add project', onAction: openAddProject }} />
      )}
      {loaded && repos.length > 0 && activeId === 'needs-you' && tree.groups.length === 0 && (
        <EmptyState message="Nothing needs you." action={{ label: 'Show all worktrees', onAction: () => switchView('all') }} />
      )}
      {loaded && repos.length > 0 && !(activeId === 'needs-you' && tree.groups.length === 0) && (
        <div className="ui-scroll ui-grow">
          <Tree
            context={context}
            model={tree}
            tagsById={tagsById}
            rowFact={viewsState.rowFact}
            repos={repos}
            groups={groups}
            sessions={sessions}
            selectedId={selectedId}
            multiSelected={multiSelected}
            pendingAsks={pendingAsks}
            checks={checks}
            pending={pending}
            groupBy={activeId === 'needs-you' ? 'section-project' : spec.display.groupBy}
            emptyProjects={tree.hidden.count === 0}
            onOpen={clearSelection}
            onSelectToggle={selectToggle}
            onTagsOpen={(ids, anchor) => setTagsTarget({ ids, anchor })}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            projectOrder={orderedRepos.map((repo) => repo.id)}
            onReorderProjects={(ids) => void reorderProjects(ids)}
            automationExpandedId={expandedAutomationId}
            automationAvailability={automationAvailability}
            onToggleAutomationDetails={toggleAutomationDetails}
            now={now}
            separatorEnabled={separatorEnabled}
            options={treeOptions}
            canShowSleeping={canShowSleeping}
            statusDefinitions={statusDefinitions}
            projectIdentities={projectIdentities}
            allWorktrees={shown}
            onReorder={(ids) => void reorderWorktrees(ids)}
            openDialog={setDialog}
            requestDelete={requestDelete}
            onDropPreviewChange={changeDropPreview}
            onSeparatorStateChange={changeSeparatorState}
            loopsByWorktree={loopStatus.byWorktree}
          />
        </div>
      )}
      {loaded && <ExternalInbox context={context} repos={repos} worktrees={worktrees} />}
      <Notices context={context} kept={kept} onDismiss={dismissKept} />
      {loaded && cleanupCount > 0 && (
        <NoticeLine actions={[{ label: 'Review', onAction: openCleanup }]}>
          {cleanupCount} archived {cleanupCount === 1 ? 'worktree' : 'worktrees'} can be deleted
        </NoticeLine>
      )}
      {bulkIds.length >= 2 && (
        <div ref={bulkRoot} className="worktree-tree-bulk">
          <BulkBar
            count={bulkIds.length}
            actions={[
              { label: 'Tag', onAction: () => bulkRoot.current && setTagsTarget({ ids: bulkIds, anchor: bulkRoot.current }) },
              { label: 'Section', onAction: () => setBulkMenu('section') },
              { label: 'Status', onAction: () => setBulkMenu('status') },
              { label: 'Sleep', onAction: () => void sleepSelected() }
            ]}
            onClear={clearSelection}
          />
          {bulkMenu && bulkRoot.current && (
            <PopupMenu anchor={bulkRoot.current} title={bulkMenu === 'section' ? 'Move to section' : 'Move to status'} items={bulkItems(bulkMenu)} onClose={() => setBulkMenu(null)} />
          )}
        </div>
      )}
      {saveOpen && (
        <SaveViewDialog
          summary={`Saves the filter, grouping and sort you're looking at: grouped by ${GROUP_LABELS[spec.display.groupBy]}, sorted by ${SORT_LABELS[spec.display.sortBy]}${chips.length > 0 ? `, filtered by ${chips.map((chip) => chip.label).join(', ')}` : ''}.`}
          busy={savingView}
          onSave={(name, starred) => void saveAsNew(name, starred)}
          onClose={() => setSaveOpen(false)}
        />
      )}
      {dialog?.kind === 'create' && repos.length > 0 && (
        <CreateDialog
          context={context}
          repos={repos}
          worktrees={worktrees}
          repoId={dialog.repoId}
          onRepoChange={(repoId) => setDialog({ kind: 'create', repoId })}
          onClose={closeDialog}
          onPending={trackPending}
          hooks={createHooks}
        />
      )}
      {dialog?.kind === 'update' && target && <UpdateDialog context={context} worktree={target} onClose={closeDialog} />}
      {dialog?.kind === 'parent' && target && (
        <ParentDialog context={context} worktree={target} worktrees={worktrees} repos={repos} onClose={closeDialog} />
      )}
      {dialog?.kind === 'delete' && target && (
        <DeleteDialog
          context={context}
          worktree={target}
          sessions={sessions}
          descendants={descendants}
          onClose={closeDialog}
          onConfirm={(options) => {
            closeDialog()
            void runDelete(target, { ...options, withDescendants: dialog.withDescendants })
          }}
        />
      )}
      {isAddFlow(dialog) && (
        <AddProjectDialog context={context} onClose={closeDialog} onStep={setDialog} />
      )}
      {dialog?.kind === 'project-settings' && dialogRepo && <ProjectSettingsDialog context={context} repo={dialogRepo} onClose={closeDialog} />}
      {dialog?.kind === 'remove-project' && dialogRepo && (
        <RemoveProjectDialog context={context} repo={dialogRepo} worktrees={worktrees} sessions={sessions} onClose={closeDialog} />
      )}
      {dialog?.kind === 'group' && dialog.action === 'new' && dialogRepo && (
        <NewGroupDialog context={context} repo={dialogRepo} onClose={closeDialog} />
      )}
      {dialog?.kind === 'group' && dialog.action === 'new-section' && <NewSectionDialog context={context} onClose={closeDialog} />}
      {tagsTarget && <TagsPopover context={context} worktreeIds={tagsTarget.ids} anchor={tagsTarget.anchor} onClose={() => setTagsTarget(null)} />}
      {dialog?.kind === 'group' && dialog.action === 'new-worktree' && (
        <NewWorktreeGroupDialog
          context={context}
          worktreeId={dialog.worktreeId}
          initialName={dialog.initialName}
          expectedInstanceId={dialog.expectedInstanceId}
          expectedProjectGroupId={dialog.expectedProjectGroupId}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'group' && dialog.action === 'rename' && dialogGroup && <RenameGroupDialog context={context} group={dialogGroup} onClose={closeDialog} />}
      {dialog?.kind === 'group' && dialog.action === 'delete' && dialogGroup && <DeleteGroupDialog context={context} group={dialogGroup} onClose={closeDialog} />}
      {trust && <TrustDialog request={trust.request} project={trustRepo ? repoLabel(trustRepo) : trust.request.repoId} onChoose={answerTrust} />}
      {fallbacks[0] && <BaseFallbackDialog message={fallbacks[0].message} onClose={() => setFallbacks((prev) => prev.slice(1))} />}
      {cleanupOpen && <CleanupDialog context={context} onClose={closeCleanup} />}
      {statusEditorOpen && <StatusSettingsDialog
        context={context}
        statuses={statusDefinitions}
        onClose={() => setStatusEditorOpen(false)}
        onSaved={(statuses) => {
          setStatusDefinitions(statuses)
          setStatusEditorOpen(false)
        }}
      />}
    </div>
  )
}
