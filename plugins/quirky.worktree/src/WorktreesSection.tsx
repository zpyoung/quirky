import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { Tree, type TreeProps } from './Tree'
import { TagsPopover } from './TagsPopover'
import { activityMark, buildTree, type ChecksState } from './view-model'
import { allSpecFromStock, ACTIVITY_WINDOWS, DEFAULT_ACTIVITY_PREFERENCES, DEFAULT_VIEWS_STATE, GROUP_BYS, ROW_FACTS, SORT_BYS, type ActivityPreferences, type ActivityMarkState, type RowFact, type ViewDisplay, type ViewFilter, type ViewId, type ViewSpec, type ViewsState } from './view-types'
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
import { registerUiControlScope, requestUiControl, type ScopedUiControlArgs } from './ui-control'

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
  const result = new Map<string, WorktreeProjectIdentity>()
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
    result.set(row.repoId, {
      displayName: fields.displayName,
      icon: fields.icon,
      color: fields.color,
      trackerProject: fields.trackerProject
    })
  }
  return Object.fromEntries(result)
}
type Props = { context: UiPluginContext; report?(state: unknown): void; requests?: CreateRequests; addProjectRequests?: CreateRequests }

/** A trust question waiting for an answer; `resolve` hands it back to the create that asked. */
type TrustPrompt = { request: TrustRequest; resolve(choice: TrustChoice): void; session: number }
type Fallback = { worktreeId: string; message: string; session: number }

const specKey = (spec: ViewSpec) => JSON.stringify(spec)

/** Resolves a command's destination independently of the last rendered view. */
function viewBaseSpec(id: ViewId, state: ViewsState, all: ViewSpec): ViewSpec {
  for (const view of state.views) if (view.id === id) return view.spec
  return all
}
const INVALID_SECTION_CONTROL = 'Invalid worktrees-section control.'
const SECTION_SCOPE = 'worktrees-section'
const SECTION_TARGET = 'worktrees'
const VALID_GROUPS: readonly string[] = GROUP_BYS
const VALID_SORTS: readonly string[] = SORT_BYS
const VALID_ACTIVITY_WINDOWS: readonly string[] = ACTIVITY_WINDOWS
const VALID_ROW_FACTS: readonly string[] = ROW_FACTS

function invalidSectionControl(): never {
  throw new Error(INVALID_SECTION_CONTROL)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isSafeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('input, textarea, select')) return true
  const host = target.closest<HTMLElement>('[contenteditable]')
  return host !== null && host.getAttribute('contenteditable')?.toLowerCase() !== 'false'
}

function controlPayload(
  args: ScopedUiControlArgs,
  required: readonly string[],
  optional: readonly string[] = [],
  guards: readonly string[] = []
): Record<string, unknown> {
  const payload = args.payload
  if (!isRecord(payload)) return invalidSectionControl()
  const allowed = ['owner', ...guards, ...required, ...optional]
  if (Object.keys(payload).some((key) => !allowed.includes(key))) return invalidSectionControl()
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(payload, key))) return invalidSectionControl()
  if ('owner' in payload && (typeof payload.owner !== 'string' || payload.owner.trim() === '')) return invalidSectionControl()
  if ('session' in payload && (!guards.includes('session') || !isSafeCounter(payload.session))) return invalidSectionControl()
  if ('revision' in payload && (!guards.includes('revision') || !isSafeCounter(payload.revision))) return invalidSectionControl()
  return payload
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isActivityPreferences(value: unknown): value is ActivityPreferences {
  if (!isRecord(value) || !hasExactKeys(value, [
    'workspaceActivityWindow',
    'workspaceActivityCustomDays',
    'alwaysShowDefaultBranchWorkspace',
    'workspaceActivityWindowBeforeLiveOnly',
    'hideCompletedReviewWorkspaces',
    'hidePassingCheckWorkspaces',
    'hideAutomationCreated'
  ])) return false
  return typeof value.workspaceActivityWindow === 'string' && VALID_ACTIVITY_WINDOWS.includes(value.workspaceActivityWindow) &&
    typeof value.workspaceActivityWindowBeforeLiveOnly === 'string' &&
    VALID_ACTIVITY_WINDOWS.includes(value.workspaceActivityWindowBeforeLiveOnly) &&
    value.workspaceActivityWindowBeforeLiveOnly !== 'live-only' &&
    isSafeCounter(value.workspaceActivityCustomDays) && value.workspaceActivityCustomDays > 0 &&
    typeof value.alwaysShowDefaultBranchWorkspace === 'boolean' &&
    typeof value.hideCompletedReviewWorkspaces === 'boolean' &&
    typeof value.hidePassingCheckWorkspaces === 'boolean' &&
    typeof value.hideAutomationCreated === 'boolean'
}

function isViewFilter(value: unknown): value is ViewFilter {
  if (!isRecord(value) || !hasExactKeys(value, [
    'tagIds', 'sectionIds', 'repoIds', 'statuses', 'hideCliCreated', 'hideOtherDesktopClients',
    'hideDefaultBranch', 'hideDetachedHead', 'hideArchived', 'activity'
  ])) return false
  return isStringList(value.tagIds) &&
    isStringList(value.sectionIds) &&
    isStringList(value.repoIds) &&
    isStringList(value.statuses) &&
    typeof value.hideCliCreated === 'boolean' &&
    typeof value.hideOtherDesktopClients === 'boolean' &&
    typeof value.hideDefaultBranch === 'boolean' &&
    typeof value.hideDetachedHead === 'boolean' &&
    typeof value.hideArchived === 'boolean' &&
    isActivityPreferences(value.activity)
}

function isViewDisplayPatch(value: unknown): value is Partial<ViewDisplay> {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  const allowed = ['groupBy', 'sortBy', 'projectOrder', 'showAsleep', 'showNested']
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false
  return (!('groupBy' in value) || (typeof value.groupBy === 'string' && VALID_GROUPS.includes(value.groupBy))) &&
    (!('sortBy' in value) || (typeof value.sortBy === 'string' && VALID_SORTS.includes(value.sortBy))) &&
    (!('projectOrder' in value) || value.projectOrder === 'manual' || value.projectOrder === 'recent') &&
    (!('showAsleep' in value) || typeof value.showAsleep === 'boolean') &&
    (!('showNested' in value) || typeof value.showNested === 'boolean')
}

function parseDialogState(value: unknown): DialogState {
  if (!isRecord(value) || typeof value.kind !== 'string') return invalidSectionControl()
  const matches = (required: readonly string[]) => hasExactKeys(value, required)
  switch (value.kind) {
    case 'create':
      if (!matches(['kind', 'repoId']) || typeof value.repoId !== 'string') return invalidSectionControl()
      return value as unknown as DialogState
    case 'update':
    case 'parent':
    case 'base-fallback':
      if (!matches(['kind', 'worktreeId']) || typeof value.worktreeId !== 'string') return invalidSectionControl()
      return value as unknown as DialogState
    case 'delete':
      if (!matches(['kind', 'worktreeId', 'withDescendants']) || typeof value.worktreeId !== 'string' || typeof value.withDescendants !== 'boolean') return invalidSectionControl()
      return value as unknown as DialogState
    case 'trust':
      if (!matches(['kind', 'repoId']) || typeof value.repoId !== 'string') return invalidSectionControl()
      return value as unknown as DialogState
    case 'cleanup':
    case 'add-project':
      if (!matches(['kind'])) return invalidSectionControl()
      return value as unknown as DialogState
    case 'project-settings':
    case 'remove-project':
      if (!matches(['kind', 'repoId']) || typeof value.repoId !== 'string') return invalidSectionControl()
      return value as unknown as DialogState
    case 'import':
    case 'open-as-folder':
      if (!matches(['kind', 'path']) || typeof value.path !== 'string') return invalidSectionControl()
      return value as unknown as DialogState
    case 'group':
      if (typeof value.action !== 'string') return invalidSectionControl()
      if (value.action === 'new-section') {
        if (!matches(['kind', 'action'])) return invalidSectionControl()
      } else if (value.action === 'new') {
        if (!matches(['kind', 'action', 'repoId']) || typeof value.repoId !== 'string') return invalidSectionControl()
      } else if (value.action === 'new-worktree') {
        if (
          !matches(['kind', 'action', 'worktreeId', 'initialName', 'expectedInstanceId', 'expectedProjectGroupId']) ||
          typeof value.worktreeId !== 'string' || typeof value.initialName !== 'string' ||
          typeof value.expectedInstanceId !== 'string' ||
          (value.expectedProjectGroupId !== null && typeof value.expectedProjectGroupId !== 'string')
        ) return invalidSectionControl()
      } else if (value.action === 'rename' || value.action === 'delete') {
        if (!matches(['kind', 'action', 'groupId']) || typeof value.groupId !== 'string') return invalidSectionControl()
      } else return invalidSectionControl()
      return value as unknown as DialogState
    default:
      return invalidSectionControl()
  }
}

async function sendSectionControl(
  context: UiPluginContext,
  owner: string,
  operation: string,
  payload: Record<string, unknown>,
  isCurrent: () => boolean
): Promise<number> {
  const args: ScopedUiControlArgs = {
    action: 'control',
    scope: SECTION_SCOPE,
    target: SECTION_TARGET,
    operation,
    payload: { ...payload, owner }
  }
  try {
    const reply: unknown = await requestUiControl(context, args)
    if (!isCurrent()) return 0
    if (!isRecord(reply) || reply.action !== 'control' || reply.scope !== SECTION_SCOPE ||
      reply.target !== SECTION_TARGET || reply.operation !== operation || !isRecord(reply.payload) ||
      typeof reply.delivered !== 'number' || !Number.isSafeInteger(reply.delivered) || reply.delivered < 0) {
      throw new Error('The window returned no UI control result.')
    }
    if (reply.delivered === 0) context.log(`worktree: ${operation} reached no mounted target`)
    return reply.delivered
  } catch (error) {
    if (!isCurrent()) return 0
    context.toast('Could not update worktree section', error instanceof Error ? error.message : String(error))
    return 0
  }
}

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
  const busyRef = useRef(false)
  const trimmed = name.trim()
  return (
    <Dialog open title="New section" onClose={onClose}>
      <form
        className="ui-stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (!trimmed || busyRef.current) return
          busyRef.current = true
          setBusy(true)
          void changeGroup(context, 'Could not create section', () => context.call('quirky.repo/groupCreate', { name: trimmed })).then((ok) => {
            busyRef.current = false
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
  const owner = useMemo(() => crypto.randomUUID(), [context])
  const ownerRef = useRef<string>(owner)
  useLayoutEffect(() => {
    ownerRef.current = owner
  }, [owner])
  const registrationActiveRef = useRef(false)
  const registrationEpochRef = useRef(0)
  function requestSectionControl(
    requestContext: UiPluginContext,
    requestOwner: string,
    operation: string,
    payload: Record<string, unknown> = {}
  ): Promise<number> {
    const requestEpoch = registrationEpochRef.current
    const isCurrent = () =>
      registrationActiveRef.current &&
      registrationEpochRef.current === requestEpoch &&
      ownerRef.current === requestOwner &&
      context === requestContext
    if (!isCurrent()) return Promise.resolve(0)
    return sendSectionControl(requestContext, requestOwner, operation, payload, isCurrent)
  }
  const sessionCounterRef = useRef(0)
  const newSession = () => ++sessionCounterRef.current
  const closePendingRef = useRef(new Map<string, number>())
  const sectionControlHandlerRef = useRef<(args: ScopedUiControlArgs, registeredOwner: string, epoch: number) => boolean>(() => false)
  const [layout, setLayout] = useState(() => context.getLayout())
  const [menu, setMenu] = useState<'display' | 'filter' | 'more' | null>(null)
  const menuRef = useRef(menu)
  const [menuSession, setMenuSession] = useState<number | null>(null)
  const [menuRenderVersion, setMenuRenderVersion] = useState(0)
  const menuSessionRef = useRef<number | null>(null)
  const menuIntentRef = useRef(0)
  const menuIntentTargetRef = useRef<'display' | 'filter' | 'more' | null | undefined>(undefined)
  const menuCloseTargetRef = useRef<number | null>(null)
  const displayButton = useRef<HTMLButtonElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const bulkRoot = useRef<HTMLDivElement>(null)
  const [bulkMenu, setBulkMenu] = useState<'section' | 'status' | null>(null)
  const bulkMenuRef = useRef(bulkMenu)
  const [bulkMenuSession, setBulkMenuSession] = useState<number | null>(null)
  const [bulkMenuRenderVersion, setBulkMenuRenderVersion] = useState(0)
  const bulkMenuSessionRef = useRef<number | null>(null)
  const sectionRoot = useRef<HTMLDivElement>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const dialogRef = useRef(dialog)
  const [dialogSession, setDialogSession] = useState<number | null>(null)
  const dialogSessionRef = useRef<number | null>(null)
  const previousDialog = useRef<DialogState | null>(null)
  const [pending, setPending] = useState<PendingCreate[]>([])
  const [trust, setTrust] = useState<TrustPrompt | null>(null)
  const trustRef = useRef(trust)
  const [fallbacks, setFallbacks] = useState<Fallback[]>([])
  const fallbacksRef = useRef(fallbacks)
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
  const viewsStateRef = useRef(viewsState)
  const viewsLoaded = useRef(false)
  const [activeViewId, setActiveViewId] = useState<ViewId>('all')
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ViewSpec>>(() => new Map())
  const draftsRef = useRef(drafts)
  const viewRevisionRef = useRef(0)
  const [saveOpen, setSaveOpen] = useState(false)
  const saveOpenRef = useRef(saveOpen)
  const [saveSession, setSaveSession] = useState<number | null>(null)
  const saveSessionRef = useRef<number | null>(null)
  const [saveOrigin, setSaveOrigin] = useState<{ viewId: ViewId; revision: number; spec: ViewSpec; draft?: ViewSpec } | null>(null)
  const saveOriginRef = useRef(saveOrigin)
  const [savingView, setSavingView] = useState(false)
  const viewWriteBusyRef = useRef(false)
  const [cleanupCount, setCleanupCount] = useState(0)
  const activeSeq = useRef(0)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const cleanupOpenRef = useRef(cleanupOpen)
  const [cleanupSession, setCleanupSession] = useState<number | null>(null)
  const cleanupSessionRef = useRef<number | null>(null)
  const [boardOpen, setBoardOpen] = useState(false)
  const [statusEditorOpen, setStatusEditorOpen] = useState(false)
  const statusEditorRef = useRef(statusEditorOpen)
  const [statusSession, setStatusSession] = useState<number | null>(null)
  const statusSessionRef = useRef<number | null>(null)
  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(() => new Set())
  const multiSelectedRef = useRef(multiSelected)
  const selectionRevisionRef = useRef(0)
  const selectionAnchor = useRef<string | null>(null)
  const visibleOrder = useRef<string[]>([])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [tagsTarget, setTagsTarget] = useState<{ ids: string[]; anchor: HTMLElement } | null>(null)
  const tagsTargetRef = useRef(tagsTarget)
  const [tagsSession, setTagsSession] = useState<number | null>(null)
  const tagsSessionRef = useRef<number | null>(null)
  const pendingTagsAnchorRef = useRef<{ ids: string[]; anchor: HTMLElement; revision: number } | null>(null)
  const activeIdRef = useRef<ViewId>('all')
  useLayoutEffect(() => {
    const epoch = registrationEpochRef.current + 1
    registrationEpochRef.current = epoch
    registrationActiveRef.current = true
    const unregister = registerUiControlScope(context, SECTION_SCOPE, (args) => {
      if (!registrationActiveRef.current || registrationEpochRef.current !== epoch || ownerRef.current !== owner) return false
      if (args.target !== SECTION_TARGET) return false
      const suppliedOwner = args.payload.owner
      if (typeof suppliedOwner === 'string' && suppliedOwner.trim() !== '' && suppliedOwner !== owner) return false
      return sectionControlHandlerRef.current(args, owner, epoch)
    })
    return () => {
      if (registrationEpochRef.current === epoch) {
        registrationActiveRef.current = false
        registrationEpochRef.current++
      }
      if (ownerRef.current === owner) ownerRef.current = ''
      unregister()
    }
  }, [context, owner])
  const setHeaderMenu = (next: 'display' | 'filter' | 'more' | null) => {
    if (next === null) {
      menuRef.current = null
      menuSessionRef.current = null
      menuIntentTargetRef.current = undefined
      menuCloseTargetRef.current = null
      setMenu(null)
      setMenuSession(null)
      return
    }
    const closingSession = closePendingRef.current.get('menu')
    if (menuRef.current !== next || menuSessionRef.current === null || closingSession === menuSessionRef.current) {
      const session = newSession()
      menuSessionRef.current = session
      setMenuSession(session)
      closePendingRef.current.delete('menu')
    }
    menuRef.current = next
    menuIntentTargetRef.current = undefined
    menuCloseTargetRef.current = null
    setMenu(next)
  }
  const setBulkMenuState = (next: 'section' | 'status' | null) => {
    if (next === null) {
      bulkMenuRef.current = null
      bulkMenuSessionRef.current = null
      setBulkMenu(null)
      setBulkMenuSession(null)
      return
    }
    const closingSession = closePendingRef.current.get('bulk-menu')
    if (bulkMenuRef.current !== next || bulkMenuSessionRef.current === null || closingSession === bulkMenuSessionRef.current) {
      const session = newSession()
      bulkMenuSessionRef.current = session
      setBulkMenuSession(session)
      closePendingRef.current.delete('bulk-menu')
    }
    bulkMenuRef.current = next
    setBulkMenu(next)
  }
  const setDialogState = (next: DialogState | null, preserveSession = false) => {
    if (next === null) {
      dialogRef.current = null
      dialogSessionRef.current = null
      setDialog(null)
      setDialogSession(null)
      return
    }
    if (!preserveSession || dialogSessionRef.current === null) {
      const session = newSession()
      dialogSessionRef.current = session
      setDialogSession(session)
    }
    dialogRef.current = next
    setDialog(next)
  }
  const setCleanupState = (open: boolean) => {
    if (open) {
      if (cleanupOpenRef.current && closePendingRef.current.get('cleanup') !== cleanupSessionRef.current) return
      const session = newSession()
      cleanupSessionRef.current = session
      setCleanupSession(session)
      closePendingRef.current.delete('cleanup')
    } else {
      cleanupSessionRef.current = null
      setCleanupSession(null)
    }
    cleanupOpenRef.current = open
    setCleanupOpen(open)
  }
  const setStatusEditorState = (open: boolean) => {
    if (open) {
      if (statusEditorRef.current && closePendingRef.current.get('statuses') !== statusSessionRef.current) return
      const session = newSession()
      statusSessionRef.current = session
      setStatusSession(session)
      closePendingRef.current.delete('statuses')
    } else {
      statusSessionRef.current = null
      setStatusSession(null)
    }
    statusEditorRef.current = open
    setStatusEditorOpen(open)
  }
  const setSaveState = (open: boolean, origin?: { viewId: ViewId; revision: number; spec: ViewSpec; draft?: ViewSpec }) => {
    if (open) {
      if (saveOpenRef.current && closePendingRef.current.get('save') !== saveSessionRef.current) return
      const session = newSession()
      saveSessionRef.current = session
      setSaveSession(session)
      closePendingRef.current.delete('save')
      saveOriginRef.current = origin ?? null
      setSaveOrigin(origin ?? null)
    } else {
      saveSessionRef.current = null
      setSaveSession(null)
      saveOriginRef.current = null
      setSaveOrigin(null)
    }
    saveOpenRef.current = open
    setSaveOpen(open)
  }
  const setTagsState = (next: { ids: string[]; anchor: HTMLElement } | null) => {
    if (next === null) {
      tagsTargetRef.current = null
      tagsSessionRef.current = null
      setTagsTarget(null)
      setTagsSession(null)
      return
    }
    const previous = tagsTargetRef.current
    const closingSession = closePendingRef.current.get('tags')
    if (previous === null || tagsSessionRef.current === null || closingSession === tagsSessionRef.current ||
      previous.anchor !== next.anchor || previous.ids.length !== next.ids.length ||
      previous.ids.some((id, index) => id !== next.ids[index])) {
      const session = newSession()
      tagsSessionRef.current = session
      setTagsSession(session)
      closePendingRef.current.delete('tags')
    }
    tagsTargetRef.current = next
    setTagsTarget(next)
  }
  useEffect(() => {
    setHeaderMenu(null)
    setBulkMenuState(null)
    setDialogState(null)
    setSaveState(false)
    setCleanupState(false)
    setStatusEditorState(false)
    setTagsState(null)
    setRequested(null)
    setPending([])
    pendingTagsAnchorRef.current = null
    closePendingRef.current.clear()
    const prompt = trustRef.current
    trustRef.current = null
    setTrust(null)
    prompt?.resolve('cancel')
    fallbacksRef.current = []
    setFallbacks([])
  }, [owner])

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
  function navigateWorkspace(action: { kind: 'back' | 'forward' } | { kind: 'move'; direction: 'previous' | 'next' } | { kind: 'index'; index: number }) {
    void currentWindowId(context).then((window) => {
      switch (action.kind) {
        case 'back':
          return context.call('quirky.worktree/navigationBack', { window })
        case 'forward':
          return context.call('quirky.worktree/navigationForward', { window })
        case 'move':
          return context.call('quirky.worktree/navigationMove', { window, direction: action.direction })
        case 'index':
          return context.call('quirky.worktree/navigationIndex', { window, index: action.index })
      }
    }).catch((error: unknown) =>
      context.toast('Could not navigate workspaces', error instanceof Error ? error.message : String(error))
    )
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      let action: { kind: 'back' | 'forward' } | { kind: 'move'; direction: 'previous' | 'next' } | { kind: 'index'; index: number } | null = null
      if (event.altKey && !event.shiftKey && event.key === 'ArrowLeft') action = { kind: 'back' }
      else if (event.altKey && !event.shiftKey && event.key === 'ArrowRight') action = { kind: 'forward' }
      else if (event.shiftKey && !event.altKey && event.key === 'ArrowUp') action = { kind: 'move', direction: 'previous' }
      else if (event.shiftKey && !event.altKey && event.key === 'ArrowDown') action = { kind: 'move', direction: 'next' }
      else if (!event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) action = { kind: 'index', index: Number(event.key) }
      if (!action) return
      event.preventDefault()
      navigateWorkspace(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [context])

  useEffect(() => requests?.attach(({ repoId }) => {
    void requestSectionControl(context, owner, 'new-worktree', repoId === undefined ? {} : { repoId })
  }), [requests, context, owner])
  useEffect(() => addProjectRequests?.attach(() => {
    void requestSectionControl(context, owner, 'open-dialog', { dialog: { kind: 'add-project' } })
  }), [addProjectRequests, context, owner])

  const selectedId = layout.worktree ?? null
  const activeView = viewsState.views.find((view) => view.id === activeViewId)
  const activeId: ViewId = activeViewId === 'all' || activeViewId === 'needs-you' ? (activeViewId === 'needs-you' && viewsState.needsYouHidden ? 'all' : activeViewId) : activeView ? activeViewId : 'all'
  const renderedViewId = activeId
  const renderedViewRevision = viewRevisionRef.current
  const renderedSelectionRevision = selectionRevisionRef.current
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
  const allSpecRef = useRef(allSpec)
  const baseSpec = activeView ? activeView.spec : allSpec
  const draft = drafts.get(activeId)
  const spec = draft ?? baseSpec
  const changed = draft !== undefined
  const alwaysShowPrimary = spec.filter.activity.alwaysShowDefaultBranchWorkspace
  const canShowSleeping = (worktree: Worktree) =>
    spec.display.showAsleep || revealHidden || (worktree.isMain && alwaysShowPrimary)
  const editSpec = useCallback((edit: (current: ViewSpec) => ViewSpec, expectedView?: ViewId, expectedRevision?: number) => {
    if (expectedView !== undefined &&
      (activeIdRef.current !== expectedView || viewRevisionRef.current !== expectedRevision)) return
    const id = activeIdRef.current
    const base = viewBaseSpec(id, viewsStateRef.current, allSpecRef.current)
    const previous = draftsRef.current
    const current = previous.get(id) ?? base
    const edited = edit(current)
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
    if (specKey(next) === specKey(current)) return
    const rest = new Map(previous)
    if (specKey(next) === specKey(base)) rest.delete(id)
    else rest.set(id, next)
    draftsRef.current = rest
    viewRevisionRef.current++
    setDrafts(rest)
  }, [])
  const changeDisplay = useCallback((patch: Partial<ViewDisplay>) => editSpec((current) => ({ ...current, display: { ...current.display, ...patch } })), [editSpec])
  const changeFilter = useCallback(
    (filter: ViewFilter) => {
      if (ownerRef.current !== owner) return
      editSpec((current) => ({ ...current, filter }), renderedViewId, renderedViewRevision)
    },
    [editSpec, owner, renderedViewId, renderedViewRevision]
  )
  const clearFilters = useCallback(() => {
    setRevealHidden(false)
    editSpec((current) => ({ ...current, filter: clearedFilter(current.filter) }))
  }, [editSpec])
  const revertDraft = useCallback(() => {
    setRevealHidden(false)
    const id = activeIdRef.current
    const previous = draftsRef.current
    if (!previous.has(id)) return
    const rest = new Map(previous)
    rest.delete(id)
    draftsRef.current = rest
    viewRevisionRef.current++
    setDrafts(rest)
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
  async function reorderWorktrees(ids: string[]) {
    if (!registrationActiveRef.current || ownerRef.current !== owner) return
    try {
      await context.call('quirky.worktree/reorder', { worktrees: ids })
    } catch (error) {
      if (ownerRef.current === owner) context.toast('Could not reorder workspaces', error instanceof Error ? error.message : String(error))
    }
  }
  async function reorderProjects(ids: string[]) {
    if (!registrationActiveRef.current || ownerRef.current !== owner) return
    const operationEpoch = registrationEpochRef.current
    try {
      await context.call('quirky.worktree/reorderProjects', { projects: ids })
      if (registrationActiveRef.current && ownerRef.current === owner && registrationEpochRef.current === operationEpoch) setProjectOrder(ids)
    } catch (error) {
      if (ownerRef.current === owner) context.toast('Could not reorder projects', error instanceof Error ? error.message : String(error))
    }
  }
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
    if (ownerRef.current !== owner) return
    setDropPreview((previous) =>
      previous?.kind === target?.kind && previous?.id === target?.id ? previous : target
    )
  }, [owner])
  const changeSeparatorState = useCallback((next: SeparatorReport) => {
    if (ownerRef.current !== owner) return
    setSeparatorState((previous) =>
      previous.enabled === next.enabled &&
      previous.eligibleBoundaries.length === next.eligibleBoundaries.length &&
      previous.eligibleBoundaries.every((key, index) => key === next.eligibleBoundaries[index])
        ? previous
        : next
    )
  }, [owner])

  useEffect(() => {
    if (!requested || !loaded) return
    if (requested.repoId !== undefined && !repos.some((repo) => repo.id === requested.repoId)) {
      setRequested(null)
      return
    }
    const open = worktrees.find((worktree) => worktree.id === selectedId)?.repoId
    const repoId = requested.repoId ?? (repos.some((repo) => repo.id === open) ? open : repos[0]?.id)
    setRequested(null)
    if (repoId) setDialogState({ kind: 'create', repoId })
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
  const renderedVisibleOrder = useMemo(() => [...treeVisibleIds], [treeVisibleIds])
  const selectToggle = useCallback((id: string, mode: 'toggle' | 'range', rendered?: readonly string[]) => {
    if (ownerRef.current !== owner) return
    const previous = multiSelectedRef.current
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
    if (next.size === previous.size && [...next].every((item) => previous.has(item))) return
    multiSelectedRef.current = next
    selectionRevisionRef.current++
    setMultiSelected(next)
    if (next.size < 2) setBulkMenuState(null)
  }, [selectedId, owner])
  const clearSelection = useCallback(() => {
    if (ownerRef.current !== owner) return
    selectionAnchor.current = null
    selectionRevisionRef.current++
    setBulkMenuState(null)
    if (multiSelectedRef.current.size === 0) return
    const next = new Set<string>()
    multiSelectedRef.current = next
    setMultiSelected(next)
  }, [owner])
  const toggleCollapsed = (key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  useEffect(() => {
    viewsLoaded.current = false
    viewWriteBusyRef.current = false
    setSavingView(false)
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
          viewsStateRef.current = next
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
        if (!active || ticket !== activeSeq.current || typeof id !== 'string') return
        if (activeIdRef.current !== id) viewRevisionRef.current++
        activeIdRef.current = id
        setActiveViewId(id)
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
      activeSeq.current++
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
    const selectionOwner = owner
    const selectionEpoch = registrationEpochRef.current
    const selectionTicket = ++activeSeq.current
    const isCurrentSelection = () =>
      registrationActiveRef.current &&
      ownerRef.current === selectionOwner &&
      registrationEpochRef.current === selectionEpoch &&
      activeSeq.current === selectionTicket
    activeIdRef.current = id
    viewRevisionRef.current++
    setActiveViewId(id)
    setRevealHidden(false)
    clearSelection()
    void selectView(context, id).then((ok) => {
      if (ok || !isCurrentSelection()) return
      const refreshTicket = ++activeSeq.current
      void fetchActiveView(context).then((current) => {
        if (!registrationActiveRef.current || ownerRef.current !== selectionOwner ||
          registrationEpochRef.current !== selectionEpoch || activeSeq.current !== refreshTicket) return
        if (activeIdRef.current !== current) viewRevisionRef.current++
        activeIdRef.current = current
        setActiveViewId(current)
      }).catch(() => {})
    }).catch((error: unknown) => {
      if (isCurrentSelection()) context.log(`could not switch view: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [context, clearSelection, owner])
  const viewsReady = useCallback((): boolean => {
    if (!viewsLoaded.current) context.toast('Views are still loading', 'Try again in a moment.')
    return viewsLoaded.current
  }, [context])
  async function saveViewsWithLease(next: ViewsState): Promise<ViewsState | null> {
    if (viewWriteBusyRef.current || !viewsReady()) return null
    viewWriteBusyRef.current = true
    setSavingView(true)
    const writeOwner = owner
    const writeEpoch = registrationEpochRef.current
    try {
      const saved = await saveViews(context, next)
      if (!registrationActiveRef.current || ownerRef.current !== writeOwner || registrationEpochRef.current !== writeEpoch) return null
      if (saved) {
        viewsStateRef.current = saved
        setViewsState(saved)
      }
      return saved
    } catch (error) {
      if (!registrationActiveRef.current || ownerRef.current !== writeOwner || registrationEpochRef.current !== writeEpoch) return null
      context.toast('Could not save views', error instanceof Error ? error.message : String(error))
      return null
    } finally {
      if (registrationActiveRef.current && ownerRef.current === writeOwner && registrationEpochRef.current === writeEpoch) {
        viewWriteBusyRef.current = false
        setSavingView(false)
      }
    }
  }
  const catalog = useMemo<FilterCatalog>(() => ({
    tags,
    sections: groups,
    repos: orderedRepos,
    statuses: statusDefinitions
  }), [tags, groups, orderedRepos, statusDefinitions])
  const chips = useMemo(() => filterChips(spec.filter, catalog), [spec.filter, catalog])
  const filtering = activeId !== 'needs-you' && chips.length > 0
  async function saveDraftNow(viewId: string, submittedDraft: ViewSpec): Promise<void> {
    if (!viewsLoaded.current) {
      viewsReady()
      return
    }
    if (viewWriteBusyRef.current) return
    const currentState = viewsStateRef.current
    const saved = await saveViewsWithLease({
      ...currentState,
      views: currentState.views.map((view) => view.id === viewId ? { ...view, spec: submittedDraft } : view)
    })
    if (!saved) return
    const currentDraft = draftsRef.current.get(viewId)
    if (!currentDraft || specKey(currentDraft) !== specKey(submittedDraft)) return
    const rest = new Map(draftsRef.current)
    rest.delete(viewId)
    draftsRef.current = rest
    if (activeIdRef.current === viewId) viewRevisionRef.current++
    setDrafts(rest)
  }
  function clearUnchangedDraft(viewId: string, submittedDraft: ViewSpec | undefined) {
    if (!submittedDraft) return
    const currentDraft = draftsRef.current.get(viewId)
    if (!currentDraft || specKey(currentDraft) !== specKey(submittedDraft)) return
    const rest = new Map(draftsRef.current)
    rest.delete(viewId)
    draftsRef.current = rest
    if (activeIdRef.current === viewId) viewRevisionRef.current++
    setDrafts(rest)
  }
  async function saveNewView(
    viewId: ViewId,
    name: string,
    starred: boolean,
    submittedSpec: ViewSpec,
    submittedDraft: ViewSpec | undefined,
    revision: number,
    session?: number
  ): Promise<void> {
    if (!viewsLoaded.current) {
      viewsReady()
      return
    }
    if (viewWriteBusyRef.current) return
    const originOwner = owner
    const originEpoch = registrationEpochRef.current
    const id = newViewId()
    const currentState = viewsStateRef.current
    const saved = await saveViewsWithLease({
      ...currentState,
      views: [...currentState.views, { id, name: name.trim(), starred, spec: submittedSpec }]
    })
    if (!saved || !registrationActiveRef.current || ownerRef.current !== originOwner || registrationEpochRef.current !== originEpoch) return
    const canSwitchToSaved = session !== undefined &&
      saveOpenRef.current &&
      saveSessionRef.current === session &&
      activeIdRef.current === viewId &&
      viewRevisionRef.current === revision
    clearUnchangedDraft(String(viewId), submittedDraft)
    if (canSwitchToSaved) {
      setSaveState(false)
      switchView(id)
    }
  }
  const hideNeedsYou = (hidden: boolean) => {
    if (!registrationActiveRef.current || ownerRef.current !== owner || viewWriteBusyRef.current || !viewsReady()) return
    const currentState = viewsStateRef.current
    if (currentState.needsYouHidden === hidden) return
    if (hidden && activeIdRef.current === 'needs-you') switchView('all')
    void saveViewsWithLease({ ...currentState, needsYouHidden: hidden })
  }
  const starView = (id: string, starred: boolean) => {
    if (!registrationActiveRef.current || ownerRef.current !== owner || viewWriteBusyRef.current || !viewsReady()) return
    const currentState = viewsStateRef.current
    const currentView = currentState.views.find((view) => view.id === id)
    if (!currentView || currentView.starred === starred) return
    void saveViewsWithLease({
      ...currentState,
      views: currentState.views.map((view) => view.id === id ? { ...view, starred } : view)
    })
  }
  const deleteView = (id: string) => {
    if (!registrationActiveRef.current || ownerRef.current !== owner || viewWriteBusyRef.current || !viewsReady()) return
    const currentState = viewsStateRef.current
    if (!currentState.views.some((view) => view.id === id)) return
    if (activeIdRef.current === id) switchView('all')
    const nextDrafts = new Map(draftsRef.current)
    nextDrafts.delete(id)
    if (nextDrafts.size !== draftsRef.current.size) {
      draftsRef.current = nextDrafts
      viewRevisionRef.current++
      setDrafts(nextDrafts)
    }
    void saveViewsWithLease({ ...currentState, views: currentState.views.filter((view) => view.id !== id) })
  }
  const changeRowFact = (fact: RowFact) => {
    if (!registrationActiveRef.current || ownerRef.current !== owner || viewWriteBusyRef.current || !viewsReady()) return
    const currentState = viewsStateRef.current
    if (currentState.rowFact === fact) return
    void saveViewsWithLease({ ...currentState, rowFact: fact })
  }
  const changedIds = useMemo<ReadonlySet<ViewId>>(() => new Set(drafts.keys()), [drafts])

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (isEditableTarget(event.target) || (event.target instanceof HTMLElement && event.target.closest('[role="menu"], [role="dialog"]'))) return
      if (document.querySelector('[role="menu"], [role="dialog"]')) return
      if (menuRef.current !== null || dialogRef.current !== null || cleanupOpenRef.current || saveOpenRef.current ||
        statusEditorRef.current || trustRef.current !== null || fallbacksRef.current.length > 0 ||
        tagsTargetRef.current !== null || bulkMenuRef.current !== null) return
      if (multiSelectedRef.current.size > 0) {
        void requestSectionControl(context, owner, 'clear-selection', { revision: selectionRevisionRef.current })
      } else if (filtering) {
        void requestSectionControl(context, owner, 'clear-filters', {
          viewId: activeIdRef.current,
          revision: viewRevisionRef.current
        })
      } else if (activeIdRef.current !== 'all') {
        void requestSectionControl(context, owner, 'select-view', {
          id: 'all',
          revision: viewRevisionRef.current
        })
      }
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [context, owner, filtering])
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

  function requestCloseOverlay(overlay: 'dialog' | 'cleanup' | 'statuses' | 'save' | 'tags', session: number | null) {
    if (session !== null) closePendingRef.current.set(overlay, session)
    void requestSectionControl(context, owner, 'close-overlay', {
      overlay,
      ...(session === null ? {} : { session })
    }).then(() => {
      if (session !== null && closePendingRef.current.get(overlay) === session) closePendingRef.current.delete(overlay)
    })
  }
  const closeDialog = () => requestCloseOverlay('dialog', dialogSession)
  const closeCleanup = () => requestCloseOverlay('cleanup', cleanupSession)
  const trackPending = useCallback((repoId: string, name: string) => {
    const pendingOwner = owner
    const pendingEpoch = registrationEpochRef.current
    if (ownerRef.current !== pendingOwner) return () => {}
    const create = { repoId, name }
    setPending((previous) => [...previous, create])
    return () => {
      if (ownerRef.current === pendingOwner && registrationEpochRef.current === pendingEpoch) {
        setPending((previous) => previous.filter((entry) => entry !== create))
      }
    }
  }, [owner])

  const createHooks = useMemo(
    () => ({
      askTrust: (request: TrustRequest) => {
        if (!registrationActiveRef.current || ownerRef.current !== owner) return Promise.resolve('cancel' as TrustChoice)
        const { promise, resolve } = Promise.withResolvers<TrustChoice>()
        const prompt: TrustPrompt = { request, resolve, session: newSession() }
        trustRef.current = prompt
        setTrust(prompt)
        return promise
      },
      showFallback: (worktreeId: string, message: string) => {
        if (!registrationActiveRef.current || ownerRef.current !== owner) return
        const next = [...fallbacksRef.current, { worktreeId, message, session: newSession() }]
        fallbacksRef.current = next
        setFallbacks(next)
      }
    }),
    [owner]
  )
  const answerTrust = (choice: TrustChoice) => {
    if (!trust) return
    void requestSectionControl(context, owner, 'answer-trust', {
      repoId: trust.request.repoId,
      choice,
      session: trust.session
    })
  }

  async function runDelete(worktree: Worktree, options: { withDescendants?: boolean; dontAskAgain?: boolean }): Promise<void> {
    if (!registrationActiveRef.current || ownerRef.current !== owner) return
    const deleteOwner = owner
    const deleteEpoch = registrationEpochRef.current
    setDeleting((previous) => new Set(previous).add(worktree.id))
    const left = await deleteWorkspace(context, worktree, options)
    if (!registrationActiveRef.current || ownerRef.current !== deleteOwner || registrationEpochRef.current !== deleteEpoch) return
    setDeleting((previous) => {
      const next = new Set(previous)
      next.delete(worktree.id)
      return next
    })
    if (left) setKept((previous) => [...previous.filter((entry) => entry.repoId !== left.repoId || entry.branch !== left.branch), left])
  }
  function openDialogFromTree(next: DialogState) {
    void requestSectionControl(context, owner, 'open-dialog', { dialog: next })
  }
  function requestDeleteFromTree(worktree: Worktree, descendants: number) {
    void requestSectionControl(context, owner, 'request-delete', {
      worktreeId: worktree.id,
      descendants,
      instanceId: worktree.instanceId
    })
  }
  function dismissKept(entry: KeptBranch) {
    void requestSectionControl(context, owner, 'dismiss-kept', {
      repoId: entry.repoId,
      branch: entry.branch,
      head: entry.head
    })
  }

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
  function openAddProject() {
    void requestSectionControl(context, owner, 'open-dialog', { dialog: { kind: 'add-project' } })
  }
  function openCleanup() {
    void requestSectionControl(context, owner, 'open-cleanup')
  }
  function openStatusEditor() {
    void requestSectionControl(context, owner, 'open-statuses')
  }
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
  function handleSectionControl(args: ScopedUiControlArgs, registeredOwner: string, epoch: number): boolean {
    if (!registrationActiveRef.current || registrationEpochRef.current !== epoch || ownerRef.current !== registeredOwner) return false
    if (args.target !== SECTION_TARGET) return false
    const suppliedOwner = args.payload.owner
    if (typeof suppliedOwner === 'string' && suppliedOwner.trim() !== '' && suppliedOwner !== registeredOwner) return false
    const isCurrentRevision = (payload: Record<string, unknown>) =>
      payload.revision === undefined || payload.revision === viewRevisionRef.current
    const isCurrentSelectionRevision = (payload: Record<string, unknown>) =>
      payload.revision === undefined || payload.revision === selectionRevisionRef.current
    const isCurrentSession = (payload: Record<string, unknown>, current: number | null) =>
      payload.session === undefined || payload.session === current
    const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

    switch (args.operation) {
      case 'set-menu': {
        const payload = controlPayload(args, ['menu'], [], ['session'])
        if (payload.menu !== null && payload.menu !== 'display' && payload.menu !== 'filter' && payload.menu !== 'more') return invalidSectionControl()
        if (payload.menu === null) {
          if (payload.session === undefined) {
            const nextIntent = menuIntentRef.current + 1
            if (!Number.isSafeInteger(nextIntent)) return false
            menuIntentRef.current = nextIntent
            menuIntentTargetRef.current = null
            menuCloseTargetRef.current = menuSessionRef.current
          } else if (payload.session !== menuIntentRef.current ||
            menuCloseTargetRef.current === null || menuCloseTargetRef.current !== menuSessionRef.current) return false
          if (menuRef.current === null) return false
          setHeaderMenu(null)
          return true
        }
        if (payload.session === undefined) {
          const nextIntent = menuIntentRef.current + 1
          if (!Number.isSafeInteger(nextIntent)) return false
          menuIntentRef.current = nextIntent
          menuIntentTargetRef.current = undefined
        } else if (payload.session !== menuIntentRef.current || menuIntentTargetRef.current !== payload.menu) return false
        if (payload.menu === 'filter' && activeIdRef.current === 'needs-you') return false
        setHeaderMenu(payload.menu)
        return true
      }
      case 'new-worktree': {
        const payload = controlPayload(args, [], ['repoId'])
        if ('repoId' in payload && !validId(payload.repoId)) return invalidSectionControl()
        if (loaded && typeof payload.repoId === 'string' && !repos.some((repo) => repo.id === payload.repoId)) return false
        setRequested(typeof payload.repoId === 'string' ? { repoId: payload.repoId } : {})
        return true
      }
      case 'open-dialog': {
        const payload = controlPayload(args, ['dialog'])
        const next = parseDialogState(payload.dialog)
        if (next.kind === 'add-project') {
          setDialogState(next)
          return true
        }
        if (next.kind === 'create') {
          if (!loaded || !repos.some((repo) => repo.id === next.repoId)) return false
        } else if (next.kind === 'update' || next.kind === 'parent' || next.kind === 'delete') {
          const worktree = worktrees.find((entry) => entry.id === next.worktreeId)
          if (!loaded || !worktree) return false
          if (next.kind === 'delete' && next.withDescendants !== ((descendantIds.get(worktree.id)?.length ?? 0) > 0)) return false
        } else if (next.kind === 'project-settings' || next.kind === 'remove-project') {
          if (!loaded || !repos.some((repo) => repo.id === next.repoId)) return false
        } else if (next.kind === 'group') {
          if (next.action === 'new-section') {
            setDialogState(next)
            return true
          }
          if (next.action === 'new') {
            if (!loaded || !repos.some((repo) => repo.id === next.repoId)) return false
          } else if (next.action === 'new-worktree') {
            const worktree = worktrees.find((entry) => entry.id === next.worktreeId)
            if (!loaded || !worktree || worktree.instanceId !== next.expectedInstanceId ||
              (worktree.projectGroupId ?? null) !== next.expectedProjectGroupId) return false
          } else if (!loaded || !groups.some((group) => group.id === next.groupId)) return false
        } else return false
        setDialogState(next)
        return true
      }
      case 'request-delete': {
        const payload = controlPayload(args, ['worktreeId', 'descendants'], ['instanceId'])
        if (!validId(payload.worktreeId) || !isSafeCounter(payload.descendants)) return invalidSectionControl()
        if ('instanceId' in payload && !validId(payload.instanceId)) return invalidSectionControl()
        const worktree = worktrees.find((entry) => entry.id === payload.worktreeId)
        if (!loaded || !worktree || (payload.instanceId !== undefined && payload.instanceId !== worktree.instanceId)) return false
        if (payload.descendants !== (descendantIds.get(worktree.id)?.length ?? 0)) return false
        if (confirmsDelete(context)) {
          setDialogState({ kind: 'delete', worktreeId: worktree.id, withDescendants: payload.descendants > 0 })
        } else {
          void runDelete(worktree, { withDescendants: payload.descendants > 0 })
        }
        return true
      }
      case 'set-board': {
        const payload = controlPayload(args, ['open'])
        if (typeof payload.open !== 'boolean') return invalidSectionControl()
        setBoardOpen(payload.open)
        return true
      }
      case 'open-cleanup': {
        controlPayload(args, [])
        setCleanupState(true)
        return true
      }
      case 'open-statuses': {
        controlPayload(args, [])
        setStatusEditorState(true)
        return true
      }
      case 'open-save': {
        const payload = controlPayload(args, ['viewId'], [], ['revision'])
        if (!validId(payload.viewId)) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        const id = payload.viewId as ViewId
        const capturedDraft = draftsRef.current.get(id)
        const origin = {
          viewId: id,
          revision: viewRevisionRef.current,
          spec: capturedDraft ?? viewBaseSpec(id, viewsStateRef.current, allSpecRef.current),
          ...(capturedDraft === undefined ? {} : { draft: capturedDraft })
        }
        const existing = saveOriginRef.current
        if (saveOpenRef.current) {
          const closePending = closePendingRef.current.get('save') === saveSessionRef.current
          if (!closePending && existing?.viewId === origin.viewId && existing.revision === origin.revision) return true
          setSaveState(false)
        }
        setSaveState(true, origin)
        return true
      }
      case 'close-overlay': {
        const payload = controlPayload(args, ['overlay'], [], ['session'])
        if (payload.overlay !== 'dialog' && payload.overlay !== 'cleanup' && payload.overlay !== 'statuses' &&
          payload.overlay !== 'save' && payload.overlay !== 'tags') return invalidSectionControl()
        if (payload.overlay === 'dialog') {
          if (dialogRef.current === null || !isCurrentSession(payload, dialogSessionRef.current)) return false
          setDialogState(null)
        } else if (payload.overlay === 'cleanup') {
          if (!cleanupOpenRef.current || !isCurrentSession(payload, cleanupSessionRef.current)) return false
          setCleanupState(false)
        } else if (payload.overlay === 'statuses') {
          if (!statusEditorRef.current || !isCurrentSession(payload, statusSessionRef.current)) return false
          setStatusEditorState(false)
        } else if (payload.overlay === 'save') {
          if (!saveOpenRef.current || !isCurrentSession(payload, saveSessionRef.current)) return false
          setSaveState(false)
        } else {
          if (tagsTargetRef.current === null || !isCurrentSession(payload, tagsSessionRef.current)) return false
          setTagsState(null)
        }
        return true
      }
      case 'select-view': {
        const payload = controlPayload(args, ['id'], [], ['revision'])
        if (!validId(payload.id)) return invalidSectionControl()
        if (!isCurrentRevision(payload)) return false
        const id = payload.id
        if (id !== 'all' && !(id === 'needs-you' && !viewsStateRef.current.needsYouHidden) &&
          !viewsStateRef.current.views.some((view) => view.id === id)) return false
        switchView(id)
        return true
      }
      case 'set-display': {
        const payload = controlPayload(args, ['viewId', 'patch'], [], ['revision'])
        if (!validId(payload.viewId) || !isViewDisplayPatch(payload.patch)) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        changeDisplay(payload.patch)
        return true
      }
      case 'set-filter': {
        const payload = controlPayload(args, ['viewId', 'filter'], [], ['revision'])
        if (!validId(payload.viewId) || !isViewFilter(payload.filter)) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current || activeIdRef.current === 'needs-you') return false
        if (!payload.filter.statuses.every((status) => statusDefinitions.some((definition) => definition.id === status))) return false
        const filter = payload.filter
        editSpec((current) => ({ ...current, filter }))
        return true
      }
      case 'set-row-fact': {
        const payload = controlPayload(args, ['fact'])
        if (typeof payload.fact !== 'string' || !VALID_ROW_FACTS.includes(payload.fact)) return invalidSectionControl()
        if (viewWriteBusyRef.current) return false
        if (!viewsLoaded.current) {
          viewsReady()
          return true
        }
        changeRowFact(payload.fact as RowFact)
        return true
      }
      case 'hide-needs-you': {
        const payload = controlPayload(args, ['hidden'])
        if (typeof payload.hidden !== 'boolean') return invalidSectionControl()
        if (viewWriteBusyRef.current) return false
        if (!viewsLoaded.current) {
          viewsReady()
          return true
        }
        hideNeedsYou(payload.hidden)
        return true
      }
      case 'star-view': {
        const payload = controlPayload(args, ['id', 'starred'])
        if (!validId(payload.id) || typeof payload.starred !== 'boolean') return invalidSectionControl()
        if (viewWriteBusyRef.current) return false
        if (!viewsLoaded.current) {
          viewsReady()
          return true
        }
        if (!viewsStateRef.current.views.some((view) => view.id === payload.id)) return false
        starView(payload.id, payload.starred)
        return true
      }
      case 'delete-view': {
        const payload = controlPayload(args, ['id'])
        if (!validId(payload.id)) return invalidSectionControl()
        if (viewWriteBusyRef.current) return false
        if (!viewsLoaded.current) {
          viewsReady()
          return true
        }
        if (!viewsStateRef.current.views.some((view) => view.id === payload.id)) return false
        deleteView(payload.id)
        return true
      }
      case 'save-draft': {
        const payload = controlPayload(args, ['viewId'], [], ['revision'])
        if (!validId(payload.viewId)) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        if (viewWriteBusyRef.current) return false
        if (!viewsLoaded.current) {
          viewsReady()
          return true
        }
        const savedView = viewsStateRef.current.views.find((view) => view.id === payload.viewId)
        const submittedDraft = draftsRef.current.get(payload.viewId)
        if (!savedView || !submittedDraft) return false
        void saveDraftNow(payload.viewId, submittedDraft)
        return true
      }
      case 'save-new': {
        const payload = controlPayload(args, ['viewId', 'name', 'starred'], [], ['session', 'revision'])
        if (!validId(payload.viewId) || typeof payload.name !== 'string' || typeof payload.starred !== 'boolean') return invalidSectionControl()
        const name = payload.name.trim()
        if (name.length === 0 || name.length > 60) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        if (payload.session !== undefined) {
          const origin = saveOriginRef.current
          if (!saveOpenRef.current || saveSessionRef.current !== payload.session ||
            !origin || origin.viewId !== payload.viewId || origin.revision !== viewRevisionRef.current ||
            (payload.revision !== undefined && payload.revision !== origin.revision)) return false
        }
        if (viewWriteBusyRef.current) return false
        if (!viewsLoaded.current) {
          viewsReady()
          return true
        }
        const origin = payload.session === undefined ? null : saveOriginRef.current
        const submittedDraft = origin?.draft ?? draftsRef.current.get(payload.viewId)
        const submittedSpec = origin?.spec ?? submittedDraft ?? viewBaseSpec(payload.viewId, viewsStateRef.current, allSpecRef.current)
        const session = typeof payload.session === 'number' ? payload.session : undefined
        const revision = typeof payload.revision === 'number' ? payload.revision : viewRevisionRef.current
        void saveNewView(
          payload.viewId as ViewId,
          name,
          payload.starred,
          submittedSpec,
          submittedDraft,
          revision,
          session
        )
        return true
      }
      case 'revert-draft': {
        const payload = controlPayload(args, ['viewId'], [], ['revision'])
        if (!validId(payload.viewId)) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        revertDraft()
        return true
      }
      case 'clear-filters': {
        const payload = controlPayload(args, ['viewId'], [], ['revision'])
        if (!validId(payload.viewId)) return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current || activeIdRef.current === 'needs-you') return false
        clearFilters()
        return true
      }
      case 'remove-filter': {
        const payload = controlPayload(args, ['viewId', 'key'], [], ['revision'])
        if (!validId(payload.viewId) || typeof payload.key !== 'string') return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        const currentFilter = draftsRef.current.get(payload.viewId)?.filter ?? viewBaseSpec(payload.viewId, viewsStateRef.current, allSpecRef.current).filter
        const chip = filterChips(currentFilter, catalog).find((entry) => entry.key === payload.key)
        if (!chip) return false
        editSpec((current) => ({ ...current, filter: chip.remove(current.filter) }))
        return true
      }
      case 'set-reveal-hidden': {
        const payload = controlPayload(args, ['viewId', 'show'], [], ['revision'])
        if (!validId(payload.viewId) || typeof payload.show !== 'boolean') return invalidSectionControl()
        if (!isCurrentRevision(payload) || payload.viewId !== activeIdRef.current) return false
        setRevealHidden(payload.show)
        return true
      }
      case 'set-selection': {
        const payload = controlPayload(args, ['worktreeIds'], [], ['revision'])
        if (!isStringList(payload.worktreeIds)) return invalidSectionControl()
        if (!isCurrentSelectionRevision(payload)) return false
        const unique = [...new Set(payload.worktreeIds)]
        if (unique.some((id) => !worktrees.some((worktree) => worktree.id === id))) return false
        selectionAnchor.current = null
        selectionRevisionRef.current++
        const next = new Set(unique)
        if (next.size !== multiSelectedRef.current.size || [...next].some((id) => !multiSelectedRef.current.has(id))) {
          multiSelectedRef.current = next
          setMultiSelected(next)
        }
        if (unique.length < 2) setBulkMenuState(null)
        return true
      }
      case 'clear-selection': {
        const payload = controlPayload(args, [], [], ['revision'])
        if (!isCurrentSelectionRevision(payload)) return false
        clearSelection()
        return true
      }
      case 'open-bulk-menu': {
        const payload = controlPayload(args, ['kind'], [], ['revision'])
        if (payload.kind !== 'section' && payload.kind !== 'status') return invalidSectionControl()
        if (!isCurrentSelectionRevision(payload)) return false
        const liveSelected = [...multiSelectedRef.current].filter((id) => worktrees.some((worktree) => worktree.id === id))
        if (liveSelected.length < 2 || !bulkRoot.current?.isConnected) return false
        setBulkMenuState(payload.kind)
        return true
      }
      case 'close-bulk-menu': {
        const payload = controlPayload(args, [], [], ['session'])
        if (bulkMenuRef.current === null || !isCurrentSession(payload, bulkMenuSessionRef.current)) return false
        setBulkMenuState(null)
        return true
      }
      case 'open-tags': {
        const payload = controlPayload(args, ['worktreeIds'], [], ['revision'])
        if (!isStringList(payload.worktreeIds) || payload.worktreeIds.length === 0) return invalidSectionControl()
        if (!isCurrentSelectionRevision(payload)) return false
        const ids = [...new Set(payload.worktreeIds)]
        if (ids.some((id) => !worktrees.some((worktree) => worktree.id === id))) return false
        const pendingAnchor = pendingTagsAnchorRef.current
        let anchor = pendingAnchor && pendingAnchor.revision === selectionRevisionRef.current &&
          pendingAnchor.ids.length === ids.length && pendingAnchor.ids.every((id, index) => id === ids[index]) &&
          pendingAnchor.anchor.isConnected
          ? pendingAnchor.anchor
          : null
        const selectedIds = [...multiSelectedRef.current].filter((id) => worktrees.some((worktree) => worktree.id === id))
        if (!anchor && bulkRoot.current?.isConnected &&
          selectedIds.length === ids.length && ids.every((id) => multiSelectedRef.current.has(id))) anchor = bulkRoot.current
        if (!anchor) {
          for (const row of sectionRoot.current?.querySelectorAll<HTMLElement>('[data-worktree-id]') ?? []) {
            if (row.dataset.worktreeId === ids[0] && row.isConnected) {
              anchor = row
              break
            }
          }
        }
        if (!anchor) return false
        pendingTagsAnchorRef.current = null
        setTagsState({ ids, anchor })
        return true
      }
      case 'toggle-fold': {
        const payload = controlPayload(args, ['key'])
        if (typeof payload.key !== 'string') return invalidSectionControl()
        const key = payload.key
        const validGroup = tree.groups.some((group) => group.key === key && group.kind !== 'flat')
        const validProject = repos.some((repo) => key === `project:${repo.id}`)
        const validPinned = key === 'pinned' && tree.groups.some((group) => group.key === 'pinned' && group.kind === 'pinned')
        const validWorktree = treeVisibleIds.has(key) && (descendantIds.get(key)?.length ?? 0) > 0
        if (!validGroup && !validProject && !validPinned && !validWorktree) return false
        toggleCollapsed(key)
        return true
      }
      case 'toggle-automation-details': {
        const payload = controlPayload(args, ['worktreeId'])
        if (!validId(payload.worktreeId)) return invalidSectionControl()
        const worktree = worktrees.find((entry) => entry.id === payload.worktreeId)
        if (!worktree || !treeVisibleIds.has(worktree.id) || worktree.automationProvenance?.kind !== 'created-by-automation') return false
        toggleAutomationDetails(worktree.id)
        return true
      }
      case 'answer-trust': {
        const payload = controlPayload(args, ['repoId', 'choice'], [], ['session'])
        if (!validId(payload.repoId) ||
          (payload.choice !== 'run' && payload.choice !== 'skip' && payload.choice !== 'always' && payload.choice !== 'cancel')) return invalidSectionControl()
        const prompt = trustRef.current
        if (!prompt || prompt.request.repoId !== payload.repoId || !isCurrentSession(payload, prompt.session)) return false
        trustRef.current = null
        setTrust(null)
        prompt.resolve(payload.choice)
        return true
      }
      case 'dismiss-fallback': {
        const payload = controlPayload(args, ['worktreeId'], [], ['session'])
        if (!validId(payload.worktreeId)) return invalidSectionControl()
        const front = fallbacksRef.current[0]
        if (!front || front.worktreeId !== payload.worktreeId || !isCurrentSession(payload, front.session)) return false
        const next = fallbacksRef.current.slice(1)
        fallbacksRef.current = next
        setFallbacks(next)
        return true
      }
      case 'dismiss-kept': {
        const payload = controlPayload(args, ['repoId', 'branch'], ['head'])
        if (!validId(payload.repoId) || !validId(payload.branch) || ('head' in payload && typeof payload.head !== 'string')) return invalidSectionControl()
        const found = kept.find((entry) => entry.repoId === payload.repoId && entry.branch === payload.branch &&
          (payload.head === undefined || entry.head === payload.head))
        if (!found) return false
        setKept((previous) => previous.filter((entry) => entry !== found))
        return true
      }
      default:
        return invalidSectionControl()
    }
  }
  useLayoutEffect(() => {
    sectionControlHandlerRef.current = handleSectionControl
    menuRef.current = menu
    bulkMenuRef.current = bulkMenu
    dialogRef.current = dialog
    trustRef.current = trust
    fallbacksRef.current = fallbacks
    viewsStateRef.current = viewsState
    draftsRef.current = drafts
    activeIdRef.current = activeId
    allSpecRef.current = allSpec
    saveOpenRef.current = saveOpen
    saveOriginRef.current = saveOrigin
    cleanupOpenRef.current = cleanupOpen
    statusEditorRef.current = statusEditorOpen
    multiSelectedRef.current = multiSelected
    tagsTargetRef.current = tagsTarget
    visibleOrder.current = renderedVisibleOrder
  })
  function nextMenuIntent(): number | null {
    const next = menuIntentRef.current + 1
    if (!Number.isSafeInteger(next)) return null
    menuIntentRef.current = next
    return next
  }
  function toggleHeaderMenu(kind: 'display' | 'filter' | 'more') {
    const currentTarget = menuIntentTargetRef.current === undefined ? menuRef.current : menuIntentTargetRef.current
    const closing = currentTarget === kind
    const intent = nextMenuIntent()
    if (intent === null) return
    if (closing) {
      const session = menuRef.current === kind ? menuSessionRef.current : null
      menuIntentTargetRef.current = null
      menuCloseTargetRef.current = session
      if (session !== null) closePendingRef.current.set('menu', session)
      void requestSectionControl(context, owner, 'set-menu', { menu: null, session: intent }).then((delivered) => {
        if (session !== null && closePendingRef.current.get('menu') === session) closePendingRef.current.delete('menu')
        if (menuIntentRef.current !== intent) return
        if (delivered === 0) {
          menuIntentTargetRef.current = undefined
          menuCloseTargetRef.current = null
          if (session !== null && menuRef.current !== 'filter' && menuSessionRef.current === session && menuRef.current !== null) {
            setMenuRenderVersion((version) => version + 1)
          }
        }
      })
      return
    }
    menuIntentTargetRef.current = kind
    menuCloseTargetRef.current = null
    void requestSectionControl(context, owner, 'set-menu', { menu: kind, session: intent }).then((delivered) => {
      if (menuIntentRef.current === intent && delivered === 0 && menuIntentTargetRef.current === kind) {
        menuIntentTargetRef.current = undefined
      }
    })
  }
  function closeHeaderMenu(session: number | null) {
    if (session === null || menuRef.current === null || menuSessionRef.current !== session) return
    if (menuIntentTargetRef.current !== undefined && menuIntentTargetRef.current !== menuRef.current) return
    const intent = nextMenuIntent()
    if (intent === null) return
    menuIntentTargetRef.current = null
    menuCloseTargetRef.current = session
    closePendingRef.current.set('menu', session)
    void requestSectionControl(context, owner, 'set-menu', { menu: null, session: intent }).then((delivered) => {
      if (closePendingRef.current.get('menu') === session) closePendingRef.current.delete('menu')
      if (menuIntentRef.current !== intent) return
      if (delivered === 0) {
        menuIntentTargetRef.current = undefined
        menuCloseTargetRef.current = null
        if (registrationActiveRef.current && ownerRef.current === owner &&
          menuRef.current !== 'filter' && menuSessionRef.current === session && menuRef.current !== null) {
          setMenuRenderVersion((version) => version + 1)
        }
      }
    })
  }
  function requestNewWorktree() {
    const selectedRepo = loaded ? worktrees.find((worktree) => worktree.id === selectedId)?.repoId : undefined
    const repoId = selectedRepo && repos.some((repo) => repo.id === selectedRepo) ? selectedRepo : loaded ? repos[0]?.id : undefined
    void requestSectionControl(context, owner, 'new-worktree', repoId === undefined ? {} : { repoId })
  }
  function changeDisplayFromMenu(patch: Partial<ViewDisplay>) {
    void requestSectionControl(context, owner, 'set-display', {
      viewId: renderedViewId,
      patch,
      revision: renderedViewRevision
    })
  }
  function changeRowFactFromMenu(fact: RowFact) {
    void requestSectionControl(context, owner, 'set-row-fact', { fact })
  }
  function openSaveView() {
    void requestSectionControl(context, owner, 'open-save', {
      viewId: renderedViewId,
      revision: renderedViewRevision
    })
  }
  function saveDraftFromNotice() {
    void requestSectionControl(context, owner, 'save-draft', {
      viewId: renderedViewId,
      revision: renderedViewRevision
    })
  }
  function saveNewFromDialog(name: string, starred: boolean) {
    if (saveOrigin === null || saveSession === null) return
    void requestSectionControl(context, owner, 'save-new', {
      viewId: saveOrigin.viewId,
      name,
      starred,
      session: saveSession,
      revision: saveOrigin.revision
    })
  }
  function revertFromNotice() {
    void requestSectionControl(context, owner, 'revert-draft', {
      viewId: renderedViewId,
      revision: renderedViewRevision
    })
  }
  function clearFiltersFromNotice() {
    void requestSectionControl(context, owner, 'clear-filters', {
      viewId: renderedViewId,
      revision: renderedViewRevision
    })
  }
  function removeFilterFromNotice(key: string) {
    void requestSectionControl(context, owner, 'remove-filter', {
      viewId: renderedViewId,
      key,
      revision: renderedViewRevision
    })
  }
  function setHiddenWorktrees(show: boolean) {
    void requestSectionControl(context, owner, 'set-reveal-hidden', {
      viewId: renderedViewId,
      show,
      revision: renderedViewRevision
    })
  }
  function clearSelectionFromTree() {
    void requestSectionControl(context, owner, 'clear-selection', { revision: renderedSelectionRevision })
  }
  function toggleFoldFromTree(key: string) {
    void requestSectionControl(context, owner, 'toggle-fold', { key })
  }
  function toggleAutomationFromTree(worktreeId: string) {
    void requestSectionControl(context, owner, 'toggle-automation-details', { worktreeId })
  }
  function openBulkMenuFromBar(kind: 'section' | 'status') {
    void requestSectionControl(context, owner, 'open-bulk-menu', {
      kind,
      revision: renderedSelectionRevision
    })
  }
  function closeBulkMenuFromPopup(session: number | null) {
    if (session === null) return
    closePendingRef.current.set('bulk-menu', session)
    void requestSectionControl(context, owner, 'close-bulk-menu', { session }).then((delivered) => {
      if (closePendingRef.current.get('bulk-menu') === session) closePendingRef.current.delete('bulk-menu')
      if (delivered === 0 && registrationActiveRef.current && ownerRef.current === owner &&
        bulkMenuSessionRef.current === session && bulkMenuRef.current !== null) {
        setBulkMenuRenderVersion((version) => version + 1)
      }
    })
  }
  function closeTagsPopover(session: number | null) {
    if (session === null) return
    closePendingRef.current.set('tags', session)
    void requestSectionControl(context, owner, 'close-overlay', { overlay: 'tags', session }).then(() => {
      if (closePendingRef.current.get('tags') === session) closePendingRef.current.delete('tags')
    })
  }
  function openBulkTags() {
    if (!bulkRoot.current) return
    const ids = [...bulkIds]
    pendingTagsAnchorRef.current = { ids, anchor: bulkRoot.current, revision: renderedSelectionRevision }
    void requestSectionControl(context, owner, 'open-tags', {
      worktreeIds: ids,
      revision: renderedSelectionRevision
    })
  }
  function openTagsFromTree(ids: string[], anchor: HTMLElement) {
    pendingTagsAnchorRef.current = { ids: [...ids], anchor, revision: renderedSelectionRevision }
    void requestSectionControl(context, owner, 'open-tags', {
      worktreeIds: ids,
      revision: renderedSelectionRevision
    })
  }
  function showAllWorktrees() {
    void requestSectionControl(context, owner, 'select-view', {
      id: 'all',
      revision: renderedViewRevision
    })
  }
  function selectViewFromTabs(id: ViewId) {
    void requestSectionControl(context, owner, 'select-view', {
      id,
      revision: renderedViewRevision
    })
  }
  function hideNeedsYouFromTabs(hidden: boolean) {
    void requestSectionControl(context, owner, 'hide-needs-you', { hidden })
  }
  function starViewFromTabs(id: string, starred: boolean) {
    void requestSectionControl(context, owner, 'star-view', { id, starred })
  }
  function deleteViewFromTabs(id: string) {
    void requestSectionControl(context, owner, 'delete-view', { id })
  }
  function openBoardWorktree(worktree: Worktree) {
    if (!registrationActiveRef.current || ownerRef.current !== owner) return
    const navigationOwner = owner
    const navigationEpoch = registrationEpochRef.current
    void currentWindowId(context).then((window) => {
      if (!registrationActiveRef.current || ownerRef.current !== navigationOwner ||
        registrationEpochRef.current !== navigationEpoch) return
      return context.call('quirky.worktree/navigate', { worktree: worktree.id, window })
    }).catch((error: unknown) => {
      if (ownerRef.current === navigationOwner) {
        context.toast('Could not open workspace', error instanceof Error ? error.message : String(error))
      }
    })
  }
  function setBoardWorktreeStatus(worktree: Worktree, status: string) {
    if (!registrationActiveRef.current || ownerRef.current !== owner) return
    void setWorktree(context, worktree.id, { status: status as Worktree['status'] })
  }
  function confirmDelete(options: { withDescendants?: boolean; dontAskAgain?: boolean }) {
    if (!target || dialog?.kind !== 'delete' || ownerRef.current !== owner ||
      dialogSession === null || dialogSessionRef.current !== dialogSession) return
    const worktree = target
    const session = dialogSession
    const withDescendants = dialog.withDescendants
    void requestSectionControl(context, owner, 'close-overlay', { overlay: 'dialog', session }).then((delivered) => {
      if (delivered === 1 && registrationActiveRef.current && ownerRef.current === owner &&
        dialogSessionRef.current !== session) {
        void runDelete(worktree, { ...options, withDescendants })
      }
    })
  }
  function saveStatuses(statuses: WorktreeStatusDefinition[]) {
    if (!registrationActiveRef.current || statusSession === null ||
      statusSessionRef.current !== statusSession || ownerRef.current !== owner) return
    setStatusDefinitions(statuses)
    setStatusEditorState(false)
  }
  function dismissFallbackFromDialog(fallback: Fallback) {
    void requestSectionControl(context, owner, 'dismiss-fallback', {
      worktreeId: fallback.worktreeId,
      session: fallback.session
    })
  }
  const treeNotificationProps: Pick<TreeProps, 'onDropPreviewChange' | 'onSeparatorStateChange'> = {
    onDropPreviewChange: changeDropPreview,
    onSeparatorStateChange: changeSeparatorState
  }
  const createNotificationProps: { onPending(repoId: string, name: string): () => void } = {
    onPending: trackPending
  }
  const addProjectNotificationProps: { onStep(next: DialogState): void } = {
    onStep: (next) => {
      if (!registrationActiveRef.current || ownerRef.current !== owner ||
        dialogSession === null || dialogSessionRef.current !== dialogSession) return
      setDialogState(next, true)
    }
  }
  const statusNotificationProps: { onSaved(statuses: WorktreeStatusDefinition[]): void } = {
    onSaved: saveStatuses
  }

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
            onClick={() => toggleHeaderMenu('display')}
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
            onClick={() => toggleHeaderMenu('filter')}
          >
            <ControlIcon name="funnel" />
            {filtering ? <span className="worktree-tree-header-button__count" aria-hidden="true">{chips.length}</span> : null}
          </IconButton>
          <IconButton
            className="worktree-tree-header-button"
            label="New worktree"
            onClick={requestNewWorktree}
          >
            <ControlIcon name="plus" />
          </IconButton>
          <IconButton
            ref={moreButton}
            className="worktree-tree-header-button"
            label="More"
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
            onClick={() => toggleHeaderMenu('more')}
          >
            <ControlIcon name="dots-three" />
          </IconButton>
        </>
      </ToolPanelActions>
      {menu === 'display' && displayButton.current && (
        <DisplayMenu
          key={`display:${menuSession}:${menuRenderVersion}`}
          anchor={displayButton.current}
          display={spec.display}
          rowFact={viewsState.rowFact}
          writeBusy={savingView}
          onDisplay={changeDisplayFromMenu}
          onRowFact={changeRowFactFromMenu}
          onSaveAsView={openSaveView}
          onClose={() => closeHeaderMenu(menuSession)}
        />
      )}
      {menu === 'filter' && (
        <FilterMenu
          key={`filter:${menuSession}`}
          anchor={filterButton}
          filter={spec.filter}
          activityError={activity.status === 'error' ? activity.error : null}
          tags={catalog.tags}
          sections={catalog.sections}
          repos={catalog.repos}
          statuses={catalog.statuses}
          onChange={changeFilter}
          onClear={clearFiltersFromNotice}
          onClose={() => closeHeaderMenu(menuSession)}
        />
      )}
      {menu === 'more' && moreButton.current && (
        <PopupMenu
          key={`more:${menuSession}:${menuRenderVersion}`}
          anchor={moreButton.current}
          title="Worktrees"
          items={[
            { label: 'Add project', onSelect: openAddProject },
            { label: 'Workspace board', checked: boardOpen, onSelect: () => void requestSectionControl(context, owner, 'set-board', { open: !boardOpen }) },
            { label: 'Edit statuses', onSelect: openStatusEditor },
            { label: 'Review cleanup', badge: cleanupCount > 0 ? cleanupCount : undefined, onSelect: openCleanup }
          ]}
          onClose={() => closeHeaderMenu(menuSession)}
        />
      )}
      <ViewTabs
        context={context}
        writeBusy={savingView}
        views={viewsState.views}
        needsYouHidden={viewsState.needsYouHidden}
        needsYouCount={tree.needsYouCount}
        needsYouErrored={tree.erroredCount > 0}
        activeId={activeId}
        changedIds={changedIds}
        onSelect={selectViewFromTabs}
        onHideNeedsYou={hideNeedsYouFromTabs}
        onStar={starViewFromTabs}
        onDelete={deleteViewFromTabs}
      />
      {changed && (
        <NoticeLine
          actions={[
            ...(activeView && !savingView ? [{ label: 'Save', onAction: saveDraftFromNotice }] : []),
            { label: 'Save as new', onAction: openSaveView },
            { label: 'Revert', onAction: revertFromNotice }
          ]}
        >
          Changed: {changeLabels.join(', ')}
        </NoticeLine>
      )}
      {filtering && (
        <NoticeLine actions={[{ label: 'Clear', onAction: clearFiltersFromNotice }]}>
          Filtered:{' '}
          {chips.map((chip) => (
            <span className="worktree-tree-filter-chip" key={chip.key}>
              {chip.label}
              <button
                type="button"
                className="worktree-tree-filter-chip__remove"
                aria-label={`Remove filter ${chip.label}`}
                onClick={() => removeFilterFromNotice(chip.key)}
              >
                ×
              </button>
            </span>
          ))}
        </NoticeLine>
      )}
      {hiddenLine && loaded && (
        <NoticeLine actions={[{ label: hiddenLine.action, onAction: () => setHiddenWorktrees(!revealHidden) }]}>
          {hiddenLine.text}
        </NoticeLine>
      )}
      {boardOpen && (
        <div className="worktree-tree-board-scroll ui-scroll">
          <WorktreeBoard
            worktrees={shown.filter((worktree) => treeVisibleIds.has(worktree.id))}
            statuses={statusDefinitions}
            repos={repos}
            open={openBoardWorktree}
            setStatus={setBoardWorktreeStatus}
          />
        </div>
      )}
      {!loaded && <div role="status"><NoticeLine>Loading projects and worktrees…</NoticeLine></div>}
      {loaded && repos.length === 0 && (
        <EmptyState message="No projects yet." action={{ label: 'Add project', onAction: openAddProject }} />
      )}
      {loaded && repos.length > 0 && activeId === 'needs-you' && tree.groups.length === 0 && (
        <EmptyState message="Nothing needs you." action={{ label: 'Show all worktrees', onAction: showAllWorktrees }} />
      )}
      {loaded && repos.length > 0 && !(activeId === 'needs-you' && tree.groups.length === 0) && (
        <div className="ui-scroll ui-grow">
          <Tree
            context={context}
            {...treeNotificationProps}
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
            onOpen={clearSelectionFromTree}
            onSelectToggle={selectToggle}
            onTagsOpen={openTagsFromTree}
            collapsed={collapsed}
            onToggleCollapsed={toggleFoldFromTree}
            projectOrder={orderedRepos.map((repo) => repo.id)}
            onReorderProjects={reorderProjects}
            automationExpandedId={expandedAutomationId}
            automationAvailability={automationAvailability}
            onToggleAutomationDetails={toggleAutomationFromTree}
            now={now}
            separatorEnabled={separatorEnabled}
            options={treeOptions}
            canShowSleeping={canShowSleeping}
            statusDefinitions={statusDefinitions}
            projectIdentities={projectIdentities}
            allWorktrees={shown}
            onReorder={reorderWorktrees}
            openDialog={openDialogFromTree}
            requestDelete={requestDeleteFromTree}
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
              { label: 'Tag', onAction: openBulkTags },
              { label: 'Section', onAction: () => openBulkMenuFromBar('section') },
              { label: 'Status', onAction: () => openBulkMenuFromBar('status') },
              { label: 'Sleep', onAction: () => void sleepSelected() }
            ]}
            onClear={clearSelectionFromTree}
          />
          {bulkMenu && bulkRoot.current && (
            <PopupMenu
              key={`bulk:${bulkMenuSession}:${bulkMenuRenderVersion}`}
              anchor={bulkRoot.current}
              title={bulkMenu === 'section' ? 'Move to section' : 'Move to status'}
              items={bulkItems(bulkMenu)}
              onClose={() => closeBulkMenuFromPopup(bulkMenuSession)}
            />
          )}
        </div>
      )}
      {saveOpen && (
        <SaveViewDialog
          summary={`Saves the filter, grouping and sort you're looking at: grouped by ${GROUP_LABELS[spec.display.groupBy]}, sorted by ${SORT_LABELS[spec.display.sortBy]}${chips.length > 0 ? `, filtered by ${chips.map((chip) => chip.label).join(', ')}` : ''}.`}
          busy={savingView}
          onSave={saveNewFromDialog}
          onClose={() => requestCloseOverlay('save', saveSession)}
        />
      )}
      {dialog?.kind === 'create' && repos.length > 0 && (
        <CreateDialog
          context={context}
          {...createNotificationProps}
          repos={repos}
          worktrees={worktrees}
          repoId={dialog.repoId}
          onRepoChange={(repoId) => openDialogFromTree({ kind: 'create', repoId })}
          onClose={closeDialog}
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
          onConfirm={confirmDelete}
        />
      )}
      {isAddFlow(dialog) && (
        <AddProjectDialog context={context} onClose={closeDialog} {...addProjectNotificationProps} />
      )}
      {dialog?.kind === 'project-settings' && dialogRepo && <ProjectSettingsDialog context={context} repo={dialogRepo} onClose={closeDialog} />}
      {dialog?.kind === 'remove-project' && dialogRepo && (
        <RemoveProjectDialog context={context} repo={dialogRepo} worktrees={worktrees} sessions={sessions} onClose={closeDialog} />
      )}
      {dialog?.kind === 'group' && dialog.action === 'new' && dialogRepo && (
        <NewGroupDialog context={context} repo={dialogRepo} onClose={closeDialog} />
      )}
      {dialog?.kind === 'group' && dialog.action === 'new-section' && <NewSectionDialog context={context} onClose={closeDialog} />}
      {tagsTarget && (
        <TagsPopover
          key={`tags:${tagsSession}`}
          context={context}
          worktreeIds={tagsTarget.ids}
          anchor={tagsTarget.anchor}
          onClose={() => closeTagsPopover(tagsSession)}
        />
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
      {fallbacks[0] && <BaseFallbackDialog message={fallbacks[0].message} onClose={() => dismissFallbackFromDialog(fallbacks[0]!)} />}
      {cleanupOpen && <CleanupDialog context={context} onClose={closeCleanup} />}
      {statusEditorOpen && <StatusSettingsDialog
        context={context}
        statuses={statusDefinitions}
        onClose={() => requestCloseOverlay('statuses', statusSession)}
        {...statusNotificationProps}
      />}
    </div>
  )
}
