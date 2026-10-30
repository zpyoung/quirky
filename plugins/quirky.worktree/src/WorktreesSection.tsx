import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, IconButton, Popover, ToolPanelActions } from '@quirky/ui'
import type { Repo, Session, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { confirmsDelete, currentWindowId, deleteWorkspace, setWorktree, type CreateRequests, type KeptBranch, type TrustChoice, type TrustRequest } from './actions'
import { AddProjectDialog } from './AddProjectDialog'
import { BaseFallbackDialog } from './BaseFallbackDialog'
import { CreateDialog } from './CreateDialog'
import { DeleteDialog } from './DeleteDialog'
import { DeleteGroupDialog, NewGroupDialog, NewWorktreeGroupDialog, RenameGroupDialog } from './GroupDialogs'
import { ParentDialog } from './ParentDialog'
import { Notices } from './Notices'
import { ActivityFilters } from './ActivityFilters'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { RemoveProjectDialog } from './RemoveProjectDialog'
import { buildReport, buildTreeModel, isAddFlow, repoLabel, type DialogState, type GroupNode, type PendingCreate, type SeparatorReport, type TreeRow, type WorktreesReport } from './report'
import { useNow } from './StatusDot'
import { Tree } from './Tree'
import { TrustDialog } from './TrustDialog'
import { UpdateDialog } from './UpdateDialog'
import { useAutomationAvailability } from './useAutomationAvailability'
import { useSidebarActivity } from './useSidebarActivity'
import { useTree } from './useTree'
import { useLoopStatus } from './useLoopStatus'
import { CleanupDialog } from './CleanupDialog'
import { StockOptions } from './StockOptions'
import { ExternalInbox } from './ExternalInbox'
import { WorktreeBoard } from './WorktreeBoard'
import { DEFAULT_STOCK_OPTIONS, isStockWorktreeOptions, type StockWorktreeOptions, type WorktreeControl } from './control-types'
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
type Props = { context: UiPluginContext; report?(state: unknown): void; requests?: CreateRequests }

/** A trust question waiting for an answer; `resolve` hands it back to the create that asked. */
type TrustPrompt = { request: TrustRequest; resolve(choice: TrustChoice): void }
type Fallback = { worktreeId: string; message: string }

function orderedWorktrees(
  worktrees: WorktreeControl[],
  sortBy: StockWorktreeOptions['sortBy'],
  sessions: Session[] | null,
  repos: Repo[]
): WorktreeControl[] {
  const waitingIds = new Set(sessions?.filter((session) => session.status === 'waiting').map((session) => session.worktreeId) ?? [])
  const repoNames = new Map(repos.map((repo) => [repo.id, repo.displayName ?? repo.name]))
  return [...worktrees].sort((left, right) => {
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1
    if (sortBy === 'name') return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    if (sortBy === 'project') {
      const project = (repoNames.get(left.repoId) ?? left.repoId).localeCompare(repoNames.get(right.repoId) ?? right.repoId)
      if (project !== 0) return project
    }
    if (sortBy === 'recent' || sortBy === 'agent-activity' || sortBy === 'project') {
      if (sortBy === 'agent-activity') {
        const waiting = Number(waitingIds.has(right.id)) - Number(waitingIds.has(left.id))
        if (waiting !== 0) return waiting
      }
      const recent = Math.max(right.lastActivityAt, right.createdAt + CREATE_GRACE_MS) -
        Math.max(left.lastActivityAt, left.createdAt + CREATE_GRACE_MS)
      return recent || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    }
    return right.manualOrder - left.manualOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  })
}

function passesStockFilters(
  worktree: WorktreeControl,
  options: StockWorktreeOptions,
  hasAuthenticatedDesktopClient: boolean,
  otherClientByWorktree: ReadonlyMap<string, boolean | null>
): boolean {
  return (options.filterRepoIds.length === 0 || options.filterRepoIds.includes(worktree.repoId)) &&
    !(options.hideCliCreated && worktree.createdBy === 'cli') &&
    !(options.hideOtherClients && hasAuthenticatedDesktopClient && otherClientByWorktree.get(worktree.id) === true) &&
    !(options.hideDefaultBranch && worktree.isMain) &&
    !(options.hideDetached && worktree.kind === 'git' && !worktree.isMain && worktree.branch === null) &&
    !(options.hideArchived && worktree.archivedAt !== null) &&
    worktree.externalVisible !== false
}

function isSleeping(worktree: WorktreeControl): boolean {
  return worktree.sleeping
}
const CREATE_GRACE_MS = 5 * 60 * 1_000

/** The sidebar's workspace tree with its menus, dialogs, add-project form and `ui state` report. */
export function WorktreesSection({ context, report, requests }: Props) {
  const { repos, groups, worktrees, sessions, otherClientByWorktree, hasAuthenticatedDesktopClient, loaded } = useTree(context)
  const now = useNow()
  const [layout, setLayout] = useState(() => context.getLayout())
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsButton = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
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
  const [revealSleeping, setRevealSleeping] = useState(false)
  const [revealFiltered, setRevealFiltered] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [boardOpen, setBoardOpen] = useState(false)
  const [statusEditorOpen, setStatusEditorOpen] = useState(false)

  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])
  useEffect(() => {
    let active = true
    const unsubscribe = context.subscribe((event) => {
      if (!('data' in event) || typeof event.data !== 'object' || event.data === null) return
      if (event.type === 'quirky.worktree/optionsChanged') {
        const data = event.data
        if ('options' in data && isStockWorktreeOptions(data.options)) setStockOptions(data.options)
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

  const selectedId = layout.worktree ?? null
  const activity = useSidebarActivity(context, selectedId, loaded)
  const loopStatus = useLoopStatus(context, worktrees, loaded)
  const selectedInstance = worktrees.find((worktree) => worktree.id === selectedId)?.instanceId
  const activityProjection = activity.projection
  const activityIsCurrent = activityProjection !== null && (
    selectedId === null
      ? activityProjection.active === null
      : activityProjection.active?.worktreeId === selectedId &&
        (selectedInstance === undefined || activityProjection.active.instanceId === selectedInstance)
  )
  const currentProjection = activity.status === 'available' && activityIsCurrent ? activityProjection : null
  const visibleIds = useMemo(
    () => currentProjection ? new Set(currentProjection.visibleIds) : null,
    [currentProjection]
  )
  const alwaysShowPrimary = activityProjection?.preferences.alwaysShowDefaultBranchWorkspace ?? true
  const ordered = useMemo(() => orderedWorktrees(worktrees, stockOptions.sortBy, sessions, repos), [worktrees, stockOptions.sortBy, sessions, repos])
  const hiddenFilteredWorktrees = useMemo(
    () => revealFiltered ? [] : ordered.filter((worktree) =>
      !passesStockFilters(worktree, stockOptions, hasAuthenticatedDesktopClient, otherClientByWorktree)
    ),
    [ordered, revealFiltered, stockOptions, hasAuthenticatedDesktopClient, otherClientByWorktree]
  )
  const hiddenSleepingWorktrees = useMemo(
    () => stockOptions.showSleeping ? [] : ordered.filter((worktree) =>
      passesStockFilters(worktree, stockOptions, hasAuthenticatedDesktopClient, otherClientByWorktree) && isSleeping(worktree) &&
      !(worktree.isMain && alwaysShowPrimary) && (!visibleIds || visibleIds.has(worktree.id))
    ),
    [ordered, stockOptions.showSleeping, stockOptions, visibleIds, alwaysShowPrimary, hasAuthenticatedDesktopClient, otherClientByWorktree]
  )
  const treeVisibleIds = useMemo(() => {
    const result = new Set<string>()
    for (const worktree of ordered) {
      if (!revealFiltered && !passesStockFilters(worktree, stockOptions, hasAuthenticatedDesktopClient, otherClientByWorktree)) continue
      const showSleeping = !isSleeping(worktree) || stockOptions.showSleeping || revealSleeping || (worktree.isMain && alwaysShowPrimary)
      if (showSleeping && (!visibleIds || visibleIds.has(worktree.id))) result.add(worktree.id)
    }
    return result
  }, [ordered, stockOptions, revealFiltered, revealSleeping, visibleIds, alwaysShowPrimary, hasAuthenticatedDesktopClient, otherClientByWorktree])
  const orderedRepos = useMemo(() => {
    const activityByRepo = new Map<string, number>()
    for (const worktree of worktrees) {
      const activityAt = Math.max(worktree.lastActivityAt, worktree.createdAt + CREATE_GRACE_MS)
      activityByRepo.set(worktree.repoId, Math.max(activityByRepo.get(worktree.repoId) ?? 0, activityAt))
    }
    if (stockOptions.projectOrderBy === 'recent') {
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
  }, [repos, worktrees, projectOrder, stockOptions.projectOrderBy])
  const changeStockOptions = useCallback(async (patch: Partial<StockWorktreeOptions>) => {
    try {
      const next = await context.call('quirky.worktree/setOptions', patch)
      if (!isStockWorktreeOptions(next)) throw new Error('the worktree options response was incomplete')
      setStockOptions(next)
    } catch (error) {
      context.toast('Could not update workspace options', error instanceof Error ? error.message : String(error))
    }
  }, [context])
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
  useEffect(() => {
    if (stockOptions.showSleeping) setRevealSleeping(false)
  }, [stockOptions.showSleeping])
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
    () => (deleting.size === 0 ? ordered : ordered.map((worktree) => (deleting.has(worktree.id) ? { ...worktree, removing: true } : worktree))),
    [ordered, deleting]
  )
  const model = useMemo(() => buildTreeModel(orderedRepos, groups, shown, pending, treeVisibleIds), [orderedRepos, groups, shown, pending, treeVisibleIds])
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
      stockHiddenIds: hiddenSleepingWorktrees.map((worktree) => worktree.id),
      stockHiddenCount: hiddenSleepingWorktrees.length,
      stockFilteredHiddenIds: hiddenFilteredWorktrees.map((worktree) => worktree.id),
      stockFilteredHiddenCount: hiddenFilteredWorktrees.length,
      revealSleeping,
      revealFiltered,
      projectOrder,
      statusDefinitions
    }
  }, [orderedRepos, repos, groups, shown, sessions, selectedId, pending, treeVisibleIds, currentProjection, automationAvailability, activity.status, activity.error, separatorState, dropPreview, dialog, trust, fallbacks, cleanupOpen, kept, now, loopStatus, stockOptions, hiddenSleepingWorktrees, hiddenFilteredWorktrees, revealSleeping, revealFiltered, projectOrder, statusDefinitions])

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
  const allRows = useMemo(() => {
    const rowsInGroups = (nodes: GroupNode[]): TreeRow[] => {
      const rows: TreeRow[] = []
      for (const node of nodes) {
        rows.push(...node.rows, ...node.looseRows)
        for (const project of node.projects) rows.push(...project.rows)
        rows.push(...rowsInGroups(node.children))
      }
      return rows
    }
    return [...rowsInGroups(model.groups), ...model.projects.flatMap((project) => project.rows)]
  }, [model])
  const descendants =
    dialog?.kind === 'delete' && dialog.withDescendants && target
      ? (allRows.find((row) => row.worktree.id === target.id)?.descendants ?? [])
          .map((id) => worktrees.find((worktree) => worktree.id === id))
          .filter((worktree): worktree is NonNullable<typeof worktree> => worktree !== undefined)
      : undefined
  const trustRepo = trust ? repos.find((repo) => repo.id === trust.request.repoId) : undefined
  const openAddProject = () => {
    setOptionsOpen(false)
    setDialog({ kind: 'add-project' })
  }
  const openCleanup = () => {
    setOptionsOpen(false)
    setCleanupOpen(true)
  }
  const openStatusEditor = () => {
    setOptionsOpen(false)
    setStatusEditorOpen(true)
  }

  return (
    <div className="ui-stack ui-panel-content">
      <ToolPanelActions>
        <>
          <IconButton
            ref={optionsButton}
            label="Worktrees options"
            aria-expanded={optionsOpen}
            aria-haspopup="dialog"
            onClick={() => setOptionsOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="var(--ui-icon-size)" height="var(--ui-icon-size)" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16l-6.5 7.4V18l-3 1.5v-7.1L4 5Z" />
            </svg>
          </IconButton>
          <Popover open={optionsOpen} label="Worktrees options" anchor={optionsButton} onClose={() => setOptionsOpen(false)}>
            <div className="ui-stack">
              {!(loaded && repos.length === 0) && (
                <Button type="button" variant="primary" onClick={openAddProject}>
                  Add project
                </Button>
              )}
              <StockOptions
                options={stockOptions}
                repos={repos}
                projectOrder={projectOrder}
                hiddenSleepingCount={hiddenSleepingWorktrees.length}
                hiddenFilteredCount={hiddenFilteredWorktrees.length}
                revealSleeping={revealSleeping}
                revealFiltered={revealFiltered}
                changeOptions={(patch) => void changeStockOptions(patch)}
                changeProjectOrder={(ids) => void reorderProjects(ids)}
                toggleSleepingReveal={() => setRevealSleeping((current) => !current)}
                toggleFilteredReveal={() => setRevealFiltered((current) => !current)}
                openCleanup={openCleanup}
              />
              <ActivityFilters
                projection={currentProjection}
                error={activity.status === 'error' ? activity.error : null}
                loading={activity.status === 'loading'}
                setPreferences={activity.setPreferences}
              />
              <details className="ui-disclosure">
                <summary>More workspace tools</summary>
                <div className="ui-cluster ui-actions">
                  <Button type="button" aria-expanded={boardOpen} onClick={() => setBoardOpen((open) => !open)}>Workspace board</Button>
                  <Button type="button" onClick={openStatusEditor}>Edit workspace statuses</Button>
                </div>
              </details>
            </div>
          </Popover>
        </>
      </ToolPanelActions>
      {boardOpen && (
        <WorktreeBoard
          worktrees={ordered.filter((worktree) => treeVisibleIds.has(worktree.id))}
          statuses={statusDefinitions}
          open={(worktree) => {
            void currentWindowId(context).then((window) =>
              context.call('quirky.worktree/navigate', { worktree: worktree.id, window })
            ).catch((error: unknown) =>
              context.toast('Could not open workspace', error instanceof Error ? error.message : String(error))
            )
          }}
          setStatus={(worktree, status) => void setWorktree(context, worktree.id, { status })}
        />
      )}
      {!loaded && <p className="ui-text-muted" role="status">Loading projects and worktrees…</p>}
      {loaded && repos.length === 0 && (
        <EmptyState message="No projects yet." action={{ label: 'Add project', onAction: openAddProject }} />
      )}
      {loaded && repos.length > 0 && (
        <div className="ui-scroll ui-grow">
          <Tree
            context={context}
            model={model}
            groups={groups}
            sessions={sessions}
            selectedId={selectedId}
            automationExpandedId={expandedAutomationId}
            automationAvailability={automationAvailability}
            onToggleAutomationDetails={toggleAutomationDetails}
            now={now}
            separatorEnabled={separatorEnabled}
            options={stockOptions}
            statusDefinitions={statusDefinitions}
            projectIdentities={projectIdentities}
            allWorktrees={ordered}
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
