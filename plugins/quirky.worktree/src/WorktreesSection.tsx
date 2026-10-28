import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { confirmsDelete, deleteWorkspace, type CreateRequests, type KeptBranch, type TrustChoice, type TrustRequest } from './actions'
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
import { DEFAULT_STOCK_OPTIONS, isStockWorktreeOptions, type StockWorktreeOptions, type WorktreeControl } from './control-types'

import type { MembershipTarget } from './membership'

const SEPARATOR_SETTING = 'setting:quirky.sidebar-extras/sidebar-section-separators'

function readSeparatorSetting(context: UiPluginContext): boolean {
  const value = context.getSetting(SEPARATOR_SETTING)
  return typeof value === 'boolean' ? value : true
}
type Props = { context: UiPluginContext; report?(state: unknown): void; requests?: CreateRequests }

/** A trust question waiting for an answer; `resolve` hands it back to the create that asked. */
type TrustPrompt = { request: TrustRequest; resolve(choice: TrustChoice): void }
type Fallback = { worktreeId: string; message: string }

/** The worktree the open view is about: its `input.worktree`, whichever view that is. */
function selectedWorktree(layout: UiLayout): string | null {
  const input = layout.view?.input
  const id = input && typeof input === 'object' ? (input as { worktree?: unknown }).worktree : undefined
  return typeof id === 'string' ? id : null
}
function orderedWorktrees(worktrees: WorktreeControl[], sortBy: StockWorktreeOptions['sortBy']): WorktreeControl[] {
  return [...worktrees].sort((left, right) => {
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1
    if (sortBy === 'name') return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    if (sortBy === 'recent') {
      const recent = Math.max(right.lastActivityAt, right.createdAt + CREATE_GRACE_MS) -
        Math.max(left.lastActivityAt, left.createdAt + CREATE_GRACE_MS)
      return recent || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    }
    return right.manualOrder - left.manualOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  })
}

function isSleeping(worktree: WorktreeControl): boolean {
  return worktree.sleeping
}
const CREATE_GRACE_MS = 5 * 60 * 1_000

/** The sidebar's workspace tree with its menus, dialogs, add-project form and `ui state` report. */
export function WorktreesSection({ context, report, requests }: Props) {
  const { repos, groups, worktrees, sessions, loaded } = useTree(context)
  const now = useNow()
  const [layout, setLayout] = useState(() => context.getLayout())
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [pending, setPending] = useState<PendingCreate[]>([])
  const [trust, setTrust] = useState<TrustPrompt | null>(null)
  const [fallbacks, setFallbacks] = useState<Fallback[]>([])
  const [requested, setRequested] = useState<{ repoId?: string } | null>(null)
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  const [kept, setKept] = useState<KeptBranch[]>([])
  const [expandedAutomationId, setExpandedAutomationId] = useState<string | null>(null)
  const lastReport = useRef('')
  const [stockOptions, setStockOptions] = useState<StockWorktreeOptions>({ ...DEFAULT_STOCK_OPTIONS })
  const [revealSleeping, setRevealSleeping] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)

  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])
  useEffect(() => {
    let active = true
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.worktree/optionsChanged' || !('data' in event)) return
      const data = event.data
      if (typeof data !== 'object' || data === null || !('options' in data) || !isStockWorktreeOptions(data.options)) return
      setStockOptions(data.options)
    })
    void context.call('quirky.worktree/options').then((value: unknown) => {
      if (active && isStockWorktreeOptions(value)) setStockOptions(value)
    }).catch((error: unknown) => context.toast('Could not load workspace options', error instanceof Error ? error.message : String(error)))
    return () => {
      active = false
      unsubscribe()
    }
  }, [context])

  useEffect(() => requests?.attach(setRequested), [requests])

  const selectedId = selectedWorktree(layout)
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
  const ordered = useMemo(() => orderedWorktrees(worktrees, stockOptions.sortBy), [worktrees, stockOptions.sortBy])
  const hiddenSleepingWorktrees = useMemo(
    () => stockOptions.showSleeping ? [] : ordered.filter((worktree) =>
      isSleeping(worktree) && !(worktree.isMain && alwaysShowPrimary) && (!visibleIds || visibleIds.has(worktree.id))
    ),
    [ordered, stockOptions.showSleeping, visibleIds, alwaysShowPrimary]
  )
  const treeVisibleIds = useMemo(() => {
    const result = new Set<string>()
    for (const worktree of ordered) {
      const showSleeping = !isSleeping(worktree) || stockOptions.showSleeping || revealSleeping || (worktree.isMain && alwaysShowPrimary)
      if (showSleeping && (!visibleIds || visibleIds.has(worktree.id))) result.add(worktree.id)
    }
    return result
  }, [ordered, stockOptions.showSleeping, revealSleeping, visibleIds, alwaysShowPrimary])
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
  const model = useMemo(() => buildTreeModel(repos, groups, shown, pending, treeVisibleIds), [repos, groups, shown, pending, treeVisibleIds])
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
        repos,
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
      revealSleeping
    }
  }, [repos, groups, shown, sessions, selectedId, pending, treeVisibleIds, currentProjection, automationAvailability, activity.status, activity.error, separatorState, dropPreview, dialog, trust, fallbacks, cleanupOpen, kept, now, loopStatus, stockOptions, hiddenSleepingWorktrees, revealSleeping])

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

  return (
    <>
      <StockOptions
        options={stockOptions}
        hiddenSleepingCount={hiddenSleepingWorktrees.length}
        revealSleeping={revealSleeping}
        changeOptions={(patch) => void changeStockOptions(patch)}
        toggleSleepingReveal={() => setRevealSleeping((current) => !current)}
        openCleanup={() => setCleanupOpen(true)}
      />
      <ActivityFilters
        projection={currentProjection}
        error={activity.status === 'error' ? activity.error : null}
        setPreferences={activity.setPreferences}
      />
      <div className="repo-scroll">
        {repos.length === 0 && <p className="muted pad">No repositories yet.</p>}
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
          allWorktrees={ordered}
          onReorder={(ids) => void reorderWorktrees(ids)}
          openDialog={setDialog}
          requestDelete={requestDelete}
          onDropPreviewChange={changeDropPreview}
          onSeparatorStateChange={changeSeparatorState}
          loopsByWorktree={loopStatus.byWorktree}
        />
      </div>
      <Notices context={context} kept={kept} onDismiss={dismissKept} />
      <div className="add-repo">
        <button type="button" className="add-project" onClick={() => setDialog({ kind: 'add-project' })}>
          Add project
        </button>
      </div>
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
    </>
  )
}
