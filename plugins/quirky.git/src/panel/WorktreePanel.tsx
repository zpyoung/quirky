import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, ContextMenu, Dialog, EmptyState, InlineError, NoticeLine } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { GitBusyOp, GitChange, GitCommit, GitStatus, GitStatusEntry, ReviewFile, UiPluginContext } from '@quirky/protocol'
import { CommitSparkle } from '../ai/CommitSparkle'
import { FixSplitButton, type FixButtonProps } from '../ai/FixSplitButton'
import { LaunchDialog } from '../ai/LaunchDialog'
import { AI_SETTINGS_VIEW_ID, type FixAction } from '../ai/types'
import { useAiFix } from '../ai/useAiFix'
import { openReview } from '../review/open'
import { reviewOrder } from '../review/order'
import { onSelectedPath, selectedPath, selectPath } from '../review/selection'
import { setReviewMark, useReview } from '../review/useReview'
import { PANEL_ID, type DiffViewInput } from '../shared/view-input'
import type { ScmReport } from '../scm'
import { newGitUiGeneration, requestGitUiControl, useGitUiControl } from '../ui-control'
import type { GitUiControl } from '../ui-control'
import { CompareUnavailable, HugeBanner, OperationCard } from './Cards'
import { ChangeBaseDialog } from './ChangeBaseDialog'
import { PR_AI_ACTIONS, readGitHubReview, useGitHubReview } from './GitHubReview'
import { useCompare, useSettings, useStatus, useWorktreePath } from './data'
import { ConfirmDialog } from './Dialog'
import { applyFilter, matchesFilter } from './filter'
import { dataOf, hasMoreDetail, messageOf, reasonOf, splitPath, splitQuestion } from './format'
import { BranchRow, CountLine, Header } from './Header'
import { HistoryDock } from './HistoryDock'
import { shouldForcePushWithLease } from './ladder'
import { displayOrder, ReviewList, toRowItem } from './list'
import type { Notice } from './Notices'
import { registerPanel } from './registry'
import { errorLineFor, type RemoteAction } from './remote-messages'
import { applyRevert, revertInOrder, revertPlan, shownHash, type Revertable } from './revert'
import type { Expansion, RowButton, RowHandlers, RowItem } from './Rows'
import { openHostedDiff } from '../view/hosted-tabs'
import { isRecord } from '../daemon/validation'
import type { PushTargetResult } from '../daemon/push-target'
import { CARET_LABEL, ShipBar, ShipErrorLine, shipMenuEntries, type ShipErrorView } from './ShipBar'
import { isBaseBranch, nextStep, shipMenu, type ShipMenuId, type ShipState, type ShipStepKind } from './ship'
import { actionPaths, uncommittedBadge, type ActionContext } from './sections'
import { advanceAfterMark, keyIntent } from './selection'

const REMOTE_METHODS: Readonly<Record<RemoteAction, string>> = {
  push: 'quirky.git/push',
  'force-push': 'quirky.git/forcePush',
  pull: 'quirky.git/pull',
  'fast-forward': 'quirky.git/fastForward',
  fetch: 'quirky.git/fetch',
  sync: 'quirky.git/sync',
  rebase: 'quirky.git/rebaseFromBase',
  continue: 'quirky.git/continue',
  abort: 'quirky.git/abort'
}

const PUSH_ACTIONS: ReadonlySet<RemoteAction> = new Set(['push', 'force-push', 'sync'])
const RETRY_MS = 10_000
const EMPTY_MESSAGE = 'Write a commit message, or click ✦'
const BUSY_LABELS: Readonly<Record<GitBusyOp, string>> = {
  push: 'Push',
  'force-push': 'Force push',
  switch: 'Switch branch',
  pull: 'Pull',
  'fast-forward': 'Fast-forward',
  fetch: 'Fetch',
  sync: 'Sync',
  rebase: 'Rebase',
  continue: 'Continue',
  abort: 'Abort'
}

/** A failed ship step, as the error line shows it: the wording and the one next action worth offering. */
type ShipFailure = {
  identity: string
  owner: string
  message: string
  retry?: () => void
  pull?: boolean
  fetch?: boolean
  details?: { title: 'Commit Failed' | 'Push Failed'; output: string }
  fix?: 'fixCommitFailure' | 'fixPushFailure'
  emptyMessage?: true
}
type PushTargetPurpose = 'review' | 'creation'
type ReviewPushTarget =
  | { key: string; state: 'loading' }
  | { key: string; state: 'error'; message: string }
  | { key: string; state: 'unavailable'; message: string }
  | { key: string; state: 'ready'; target: Extract<PushTargetResult, { ready: true }> }
type ForceConfirmation = {
  purpose?: PushTargetPurpose
  expected?: string
  target?: Extract<PushTargetResult, { ready: true }>
  reviewKey?: string
  branch: string | null
  head: string | null
  upstreamSha?: string | null
}
type Owner = { worktree: string; branch: string | null; generation: string }
type MenuPosition = { x: number; y: number }
type HeaderMenuSession = { owner: string; generation: string; position: MenuPosition }
type RowMenuSession = HeaderMenuSession & { path: string; signature: string }
type ShipMenuSession = HeaderMenuSession
type LaunchSession = { owner: string; generation: string; action: FixAction }
type ConfirmSession = {
  kind: 'confirm'
  owner: string
  generation: string
  title: string
  body: string
  confirm: string
  danger: boolean
  validate(): boolean
  resolve(ok: boolean): void
}
type DetailsSession = {
  kind: 'details'
  owner: string
  generation: string
  title: 'Commit Failed' | 'Push Failed'
  output: string
  fix: FixAction
}
type BaseSession = { kind: 'base'; owner: string; generation: string }
type DialogState = ConfirmSession | DetailsSession | BaseSession
const PUSH_TARGET_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

function pushTargetResult(value: unknown): PushTargetResult | undefined {
  if (!isRecord(value)) return undefined
  if (value.ready === false) {
    return typeof value.reason === 'string' && typeof value.message === 'string' && value.message !== ''
      ? { ready: false, reason: value.reason, message: value.message }
      : undefined
  }
  if (value.ready !== true || !isRecord(value.repository)) return undefined

  const repository = value.repository
  const { remote, branch, localBranch, localHead, headOid, number, fork } = value
  if (typeof remote !== 'string' || remote.length === 0 ||
    typeof branch !== 'string' || branch.length === 0 ||
    typeof localBranch !== 'string' || localBranch.length === 0 ||
    typeof localHead !== 'string' || !PUSH_TARGET_OID.test(localHead) ||
    (headOid !== undefined && (typeof headOid !== 'string' || !PUSH_TARGET_OID.test(headOid))) ||
    (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)) ||
    typeof fork !== 'boolean' ||
    typeof repository.host !== 'string' || repository.host.length === 0 ||
    typeof repository.owner !== 'string' || repository.owner.length === 0 ||
    typeof repository.repo !== 'string' || repository.repo.length === 0) return undefined

  return {
    ready: true,
    remote,
    branch,
    localBranch,
    localHead,
    ...(typeof headOid === 'string' ? { headOid } : {}),
    ...(typeof number === 'number' ? { number } : {}),
    fork,
    repository: { host: repository.host, owner: repository.owner, repo: repository.repo }
  }
}
const REVERT_MUTATIONS: ReadonlySet<string> = new Set(['quirky.git/unstage', 'quirky.git/discard', 'quirky.editor/mutate', 'quirky.git/save'])
const REVERT_CANCELLED = 'The revert target is no longer current.'

function fencedRevertContext(context: UiPluginContext, ownerCurrent: () => boolean, targetCurrent: () => boolean, unavailable: string): UiPluginContext {
  const fenced = Object.create(context) as UiPluginContext
  let mutationStarted = false
  fenced.call = (method, params) => {
    if (!ownerCurrent() || (!mutationStarted && !targetCurrent())) return Promise.reject(new Error(unavailable))
    const result = context.call(method, params)
    if (REVERT_MUTATIONS.has(method)) mutationStarted = true
    return result
  }
  return fenced
}


type MutationVerb = 'stage' | 'unstage'

type Mutation = {
  method: 'quirky.git/stage' | 'quirky.git/unstage'
  params: Record<string, unknown>
  verb: MutationVerb
  /** The paths involved, for the failure notice. */
  paths: string[]
  targets?: string[]
  bulk: boolean
}

type DraftStore = { get(worktree: string): string; set(worktree: string, text: string): void }

export type PanelProps = {
  context: UiPluginContext
  worktree: string
  report(state: ScmReport): void
  notify(notice: Notice): void
  drafts: DraftStore
  /** Worktrees that were already offered a .gitignore suggestion in this window. */
  offered: Set<string>
}

/** What the panel knows of a dirty submodule row: whether it is open and what its last read returned. */
type SubmoduleState = { open: boolean; entries: readonly GitStatusEntry[] | null; failed: boolean; signature: string }

const asText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const NO_FILES: readonly ReviewFile[] = []
const NO_DIRS: ReadonlySet<string> = new Set()
const NO_ENTRIES: readonly GitStatusEntry[] = []
const AREA_ORDER = ['conflicts', 'unstaged', 'staged', 'untracked'] as const

/** Everything the Changes panel shows and does for one worktree. */
export function WorktreePanel({ context, worktree, report, notify, drafts, offered }: PanelProps) {
  const root = useRef<HTMLDivElement>(null)
  const [settings, setViewMode] = useSettings(context)
  const data = useStatus(context, worktree)
  const { status: polled, markersGone, unreadableConflicts } = data
  const [localBusy, setLocalBusy] = useState<GitBusyOp | null>(null)
  const localBusyTokenRef = useRef<object | null>(null)
  const localBusyOwnerRef = useRef<string | null>(null)
  const status = useMemo<GitStatus | null>(() => (polled === null ? null : { ...polled, busy: polled.busy ?? localBusy }), [polled, localBusy])
  const ownerRef = useRef<Owner | null>(null)
  if (ownerRef.current === null || ownerRef.current.worktree !== worktree ||
      (polled !== null && ownerRef.current.branch !== polled.branch)) {
    ownerRef.current = { worktree, branch: polled?.branch ?? null, generation: newGitUiGeneration() }
  }
  const owner = ownerRef.current
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const pending = dialogRef.current
      if (pending?.kind === 'confirm') pending.resolve(false)
      dialogRef.current = null
      headerMenuRef.current = null
      rowMenuRef.current = null
      shipMenuRef.current = null
      launchRef.current = null
      reservationsRef.current.clear()
    }
  }, [])
  const githubReview = useGitHubReview(context, worktree, status)
  const [reviewPushTarget, setReviewPushTarget] = useState<ReviewPushTarget | null>(null)
  const [reviewPushAttempt, setReviewPushAttempt] = useState(0)
  const reviewPushKey = githubReview.kind === 'found'
    ? `${githubReview.target.worktree}\\0${githubReview.target.branch}\\0${githubReview.target.head}\\0${githubReview.review.number}\\0${githubReview.review.state}`
    : null
  const statusRef = useRef(status)
  statusRef.current = status
  const reviewPushKeyRef = useRef(reviewPushKey)
  reviewPushKeyRef.current = reviewPushKey
  useEffect(() => {
    if (githubReview.kind !== 'found' || reviewPushKey === null) {
      setReviewPushTarget(null)
      return
    }
    const generation = owner.generation
    let alive = true
    const current = () => alive && mountedRef.current && ownerRef.current?.generation === generation
    setReviewPushTarget({ key: reviewPushKey, state: 'loading' })
    void context.call('quirky.git/pushTarget', { worktree, purpose: 'review' }).then((raw: unknown) => {
      if (!current()) return
      const target = pushTargetResult(raw)
      if (target?.ready === true) {
        setReviewPushTarget({ key: reviewPushKey, state: 'ready', target })
      } else if (target?.ready === false) {
        setReviewPushTarget({ key: reviewPushKey, state: 'unavailable', message: target.message })
      } else {
        setReviewPushTarget({ key: reviewPushKey, state: 'error', message: 'Git returned an invalid push destination.' })
      }
    }).catch((error: unknown) => {
      if (current()) setReviewPushTarget({ key: reviewPushKey, state: 'error', message: messageOf(error) })
    })
    return () => {
      alive = false
    }
  }, [context, worktree, reviewPushKey, reviewPushAttempt, owner.generation])
  const compareTrigger = `${polled?.head ?? ''}|${polled?.upstreamStatus.sha ?? ''}|${settings.compareBase}`
  const compareData = useCompare(context, worktree, compareTrigger, polled !== null)
  const { compare } = compareData
  const worktreePath = useWorktreePath(context, worktree)
  const review = useReview(context, worktree)
  const model = review.model
  const files = useMemo(() => model?.files ?? NO_FILES, [model])
  const refreshReview = useCallback(function refreshReview(): void {
    try {
      review.refresh()
    } catch {
    }
  }, [review.refresh])

  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => selectedPath(worktree))
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(NO_DIRS)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [message, setMessageState] = useState(() => drafts.get(worktree))
  const draftTextRef = useRef(message)
  const [committing, setCommitting] = useState(false)
  const commitTokenRef = useRef<object | null>(null)
  const commitOwnerRef = useRef<string | null>(null)
  const edits = useRef(0)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const [writtenBy, setWrittenBy] = useState<string | null>(null)
  const [ticks, setTicks] = useState<ReadonlySet<string> | null>(null)
  const ticksRef = useRef(ticks)
  ticksRef.current = ticks
  const aiFix = useAiFix(context, worktree)
  const [shipError, setShipErrorState] = useState<ShipFailure | null>(null)
  const shipErrorRef = useRef<ShipFailure | null>(null)
  const setShipError = (update: ShipFailure | null | ((previous: ShipFailure | null) => ShipFailure | null)) => {
    const next = typeof update === 'function' ? update(shipErrorRef.current) : update
    shipErrorRef.current = next
    setShipErrorState(next)
  }
  const [dialog, setDialogState] = useState<DialogState | null>(null)
  const dialogRef = useRef<DialogState | null>(null)
  const setDialog = (next: DialogState | null) => {
    const previous = dialogRef.current
    if (previous !== next && previous?.kind === 'confirm') previous.resolve(false)
    dialogRef.current = next
    setDialogState(next)
  }
  const settleDialog = (session: DialogState, accepted: boolean) => {
    if (dialogRef.current !== session) return false
    dialogRef.current = null
    setDialogState(null)
    if (session.kind === 'confirm') session.resolve(accepted)
    return true
  }
  const [focusRecovery, setFocusRecovery] = useState<{ revision: number; opener: Element | null; owner: string }>(() => ({ revision: 0, opener: null, owner: owner.generation }))
  const baseDialogWasOpen = useRef(false)
  const [launch, setLaunchState] = useState<LaunchSession | null>(null)
  const launchRef = useRef<LaunchSession | null>(null)
  const setLaunch = (next: LaunchSession | null) => {
    launchRef.current = next
    setLaunchState(next)
  }
  const [headerMenu, setHeaderMenuState] = useState<HeaderMenuSession | null>(null)
  const headerMenuRef = useRef<HeaderMenuSession | null>(null)
  const setHeaderMenu = (next: HeaderMenuSession | null) => {
    headerMenuRef.current = next
    setHeaderMenuState(next)
  }
  const [menu, setMenuState] = useState<RowMenuSession | null>(null)
  const rowMenuRef = useRef<RowMenuSession | null>(null)
  const setMenu = (next: RowMenuSession | null) => {
    rowMenuRef.current = next
    setMenuState(next)
  }
  const [shipMenuAt, setShipMenuAtState] = useState<ShipMenuSession | null>(null)
  const shipMenuRef = useRef<ShipMenuSession | null>(null)
  const setShipMenuAt = (next: ShipMenuSession | null) => {
    shipMenuRef.current = next
    setShipMenuAtState(next)
  }
  const headerMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const headerMenuChoice = useRef<string | null>(null)
  const rowMenuChoice = useRef<string | null>(null)
  const shipMenuChoice = useRef<string | null>(null)
  useEffect(() => {
    if (headerMenuRef.current?.owner !== owner.generation && headerMenuRef.current !== null) setHeaderMenu(null)
    if (rowMenuRef.current?.owner !== owner.generation && rowMenuRef.current !== null) setMenu(null)
    if (shipMenuRef.current?.owner !== owner.generation && shipMenuRef.current !== null) setShipMenuAt(null)
    if (dialogRef.current?.owner !== owner.generation && dialogRef.current !== null) setDialog(null)
    if (launchRef.current?.owner !== owner.generation && launchRef.current !== null) setLaunch(null)
    if (localBusyOwnerRef.current !== null && localBusyOwnerRef.current !== owner.generation) {
      localBusyTokenRef.current = null
      localBusyOwnerRef.current = null
      setLocalBusy(null)
    }
    if (commitOwnerRef.current !== null && commitOwnerRef.current !== owner.generation) {
      commitTokenRef.current = null
      commitOwnerRef.current = null
      setCommitting(false)
    }
    if (activeCreateIntent.current !== null) {
      createIntent.current += 1
      activeCreateIntent.current = null
      setCreatingReview(false)
    }
    reservationsRef.current.clear()
    statusRefreshRef.current = null
    headerMenuChoice.current = null
    rowMenuChoice.current = null
    shipMenuChoice.current = null
    setShipError(null)
  }, [owner.generation])
  const isCurrentOwner = (generation: string) =>
    mountedRef.current && ownerRef.current?.generation === generation
  const reservationsRef = useRef(new Map<string, object>())
  const startReserved = (key: string, operation: () => unknown): boolean => {
    if (reservationsRef.current.has(key)) return false
    const token = {}
    reservationsRef.current.set(key, token)
    let result: unknown
    try {
      result = operation()
    } catch (error) {
      reservationsRef.current.delete(key)
      if (isCurrentOwner(owner.generation)) context.toast('Could not complete Source Control action', messageOf(error), { kind: 'error' })
      return true
    }
    void Promise.resolve(result).catch((error: unknown) => {
      if (isCurrentOwner(owner.generation)) context.toast('Could not complete Source Control action', messageOf(error), { kind: 'error' })
    }).finally(() => {
      if (reservationsRef.current.get(key) === token) reservationsRef.current.delete(key)
    })
    return true
  }
  const controlUnavailable = 'The source control action is no longer available.'
  const deliverLocalControl = async function deliverLocalControl(control: GitUiControl, current: () => boolean): Promise<void> {
    try {
      const result = await requestGitUiControl(context, control)
      if (!result.delivered) throw new Error(controlUnavailable)
    } catch (error) {
      if (current()) context.toast('Could not run Source Control action', messageOf(error), { kind: 'error' })
    }
  }
  const postLocalControl = (control: GitUiControl, current: () => boolean): void => {
    void deliverLocalControl(control, current)
  }
  const postMainControl = (action: string, data?: Record<string, unknown>): void => {
    const generation = owner.generation
    postLocalControl({
      surface: PANEL_ID,
      target: `worktree:${worktree}`,
      generation,
      action,
      ...(data === undefined ? {} : { data })
    }, () => isCurrentOwner(generation))
  }
  const postShipErrorControl = (action: string): void => {
    const failure = shipError
    if (failure === null) return
    postLocalControl({
      surface: PANEL_ID,
      target: `ship-error:${worktree}`,
      generation: failure.identity,
      action
    }, () => isCurrentOwner(failure.owner) && shipErrorRef.current === failure)
  }
  const [submodules, setSubmodules] = useState<Record<string, SubmoduleState>>({})
  const createIntent = useRef(0)
  const activeCreateIntent = useRef<number | null>(null)
  const activeWorktree = useRef(worktree)
  if (activeWorktree.current !== worktree) {
    activeWorktree.current = worktree
    createIntent.current += 1
  }
  const [creatingReview, setCreatingReview] = useState(false)
  useEffect(() => {
    activeCreateIntent.current = null
    setCreatingReview(false)
    setShipError(null)
    return () => {
      createIntent.current += 1
      activeCreateIntent.current = null
    }
  }, [worktree])

  useEffect(() => {
    setSelected(selectedPath(worktree))
    return onSelectedPath(worktree, (path, origin) => {
      setSelected(path)
      if (origin === 'review' && path !== null) {
        setCollapsedDirs((prev) => {
          const hiding = [...prev].filter((dir) => path.startsWith(`${dir}/`))
          if (hiding.length === 0) return prev
          return new Set([...prev].filter((dir) => !hiding.includes(dir)))
        })
      }
    })
  }, [worktree])

  const viewMode = settings.viewMode
  const filtering = applyFilter([], filter).state !== 'inactive'
  const query = filter.trim()
  const tooLarge = applyFilter([], filter).state === 'too-large'
  const entries = status?.entries ?? NO_ENTRIES
  const actionContext: ActionContext = useMemo(() => ({ markersGone, unreadableConflicts }), [markersGone, unreadableConflicts])

  const visibleFiles = useMemo(
    () => (tooLarge ? NO_FILES : query === '' ? files : files.filter((file) => matchesFilter(file.path, query))),
    [files, query, tooLarge]
  )
  const shown = useMemo(() => displayOrder(visibleFiles, viewMode, collapsedDirs), [visibleFiles, viewMode, collapsedDirs])
  const directoryPaths = useMemo(() => {
    const result = new Set<string>()
    for (const file of visibleFiles) {
      let boundary = file.path.indexOf('/')
      while (boundary !== -1) {
        result.add(file.path.slice(0, boundary))
        boundary = file.path.indexOf('/', boundary + 1)
      }
    }
    return result
  }, [visibleFiles])

  const dropEmptyMessageError = () => {
    if (!isCurrentOwner(owner.generation)) return
    setShipError((previous) => (previous?.emptyMessage ? null : previous))
  }

  const setMessage = (text: string) => {
    if (!isCurrentOwner(owner.generation)) return
    edits.current += 1
    draftTextRef.current = text
    setMessageState(text)
    drafts.set(worktree, text)
    if (text.trim() !== '') dropEmptyMessageError()
  }

  const refreshAll = useMemo(() => {
    async function refreshAll(): Promise<void> {
      await Promise.all([data.refresh(), compareData.refresh()])
    }
    return refreshAll
  }, [data.refresh, compareData.refresh])

  const focusPanel = useCallback(() => {
    const panel = root.current
    const target = panel?.querySelector<HTMLButtonElement>('[data-base-ref]:not(:disabled)')
      ?? panel?.querySelector<HTMLButtonElement>('[aria-label="More commit and remote actions"]:not(:disabled)')
      ?? (panel?.closest('[data-ui-tool-panel-frame]') ?? panel)?.querySelector<HTMLButtonElement>('[aria-label="More source control actions"]:not(:disabled)')
    target?.focus()
  }, [])
  const recoverPanelFocus = useCallback((opener: Element | null) => {
    const active = document.activeElement
    const activeIsValid = active !== null && active !== document.body && active.isConnected && !active.hasAttribute('disabled')
    if (activeIsValid && active !== opener) return
    focusPanel()
  }, [focusPanel])
  const requestFocusRecovery = useCallback((opener: Element | null = null, generation = owner.generation) => {
    setFocusRecovery((request) => ({ revision: request.revision + 1, opener, owner: generation }))
  }, [owner.generation])
  useEffect(() => {
    if (focusRecovery.revision > 0 && isCurrentOwner(focusRecovery.owner)) recoverPanelFocus(focusRecovery.opener)
  }, [focusRecovery, recoverPanelFocus])
  useEffect(() => {
    const baseDialogOpen = dialog?.kind === 'base' && dialog.owner === owner.generation
    if (baseDialogWasOpen.current && dialog === null) focusPanel()
    baseDialogWasOpen.current = baseDialogOpen
  }, [dialog, focusPanel, owner.generation])

  const compareRef = useRef(compareData.refresh)
  compareRef.current = compareData.refresh
  const reviewRefresh = useRef(refreshReview)
  reviewRefresh.current = refreshReview

  useEffect(
    () =>
      registerPanel({
        setFilter: (q) => {
          setFilter(q)
          setFilterOpen(q !== '')
        },
        select: (paths) => selectPath(worktree, paths[0] ?? null, 'panel'),
        toggleHistory: (open) => setHistoryOpen((prev) => open ?? !prev),
        refreshCompare: () => {
          void compareRef.current()
          reviewRefresh.current()
        }
      }),
    [worktree]
  )

  const badge = useMemo(() => (status === null ? null : uncommittedBadge(status.entries, status.capped)), [status])
  useEffect(() => {
    if (data.unavailable !== null) context.setPanelBadge(PANEL_ID, null)
    else if (status !== null) context.setPanelBadge(PANEL_ID, badge?.count ?? null, badge?.title)
  }, [context, status === null, data.unavailable, badge?.count, badge?.title])

  const capped = status?.capped ?? false
  useEffect(() => {
    if (!capped || offered.has(worktree)) return
    const generation = owner.generation
    let alive = true
    const current = () => alive && mountedRef.current && ownerRef.current?.generation === generation
    offered.add(worktree)
    context
      .call('quirky.git/hugeFolders', { worktree })
      .then((result) => {
        if (!current()) return
        const folder = (result as { folders: string[] }).folders[0]
        if (folder === undefined) return
        const available = () => current()
        notify({
          id: `huge-folder:${worktree}`,
          worktree,
          title: `This repository has too many active changes. Add "${folder}" to .gitignore?`,
          actions: [
            {
              label: 'Add to .gitignore',
              available,
              run: () => {
                if (!available()) return
                void context.call('quirky.git/ignoreFolder', { worktree, folder }).then(() => {
                  if (available()) return refreshAll()
                }).catch((error: unknown) => {
                  if (available()) context.toast('Could not update .gitignore', messageOf(error), { kind: 'error' })
                })
              }
            }
          ]
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [capped, worktree, context, offered, notify, refreshAll, owner.generation])

  const unresolved = entries.filter((e) => e.conflict?.state === 'unresolved').length
  const operation = status?.operation ?? 'none'
  const aiEnabled = settings.aiEnabled
  const stagedCount = entries.filter((e) => e.area === 'staged').length
  const uncommittedPaths = useMemo(() => [...new Set(entries.map((entry) => entry.path))], [entries])
  const busyLabel = committing ? 'Commit' : creatingReview ? 'Create PR' : status?.busy ? BUSY_LABELS[status.busy] : null
  const shipState: ShipState = {
    review: model,
    status,
    github: githubReview,
    message,
    busy: busyLabel,
    selected: ticks,
    isBaseBranch: model?.base.isCurrentBranch === true || (status !== null && model !== null && isBaseBranch(model.base.name, status.branch))
  }
  const step = model === null ? null : nextStep(shipState)
  const shipItems = shipMenu(shipState)
  const shipBarPossible = status !== null && operation === 'none'
  const [shipCaretShown, setShipCaretShown] = useState<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    setShipCaretShown(shipMenuAt === null ? null : root.current?.querySelector<HTMLButtonElement>(`[aria-label="${CARET_LABEL}"]`) ?? null)
  })
  useEffect(() => {
    if (!shipBarPossible) setShipMenuAt(null)
  }, [shipBarPossible])
  const fixFor = (action: FixButtonProps['action']): FixButtonProps | undefined =>
    aiEnabled ? {
      action,
      busy: aiFix.busy,
      onFix: () => postMainControl('ai-fix', { action }),
      onCustomize: () => postMainControl('ai-customize', { action })
    } : undefined

  useEffect(() => {
    if (ticks !== null && uncommittedPaths.length === 0) setTicks(null)
  }, [ticks, uncommittedPaths.length])

  const open = (input: Omit<DiffViewInput, 'worktree'>) => {
    const generation = owner.generation
    void openHostedDiff(context, { worktree, ...input }).catch((error: unknown) => {
      if (isCurrentOwner(generation)) context.toast('Could not open diff', messageOf(error), { kind: 'error' })
    })
  }

  const toggleSubmodule = (item: RowItem) => {
    const file = fileOf(item.path)
    if (!file?.submodule) return
    const signature = JSON.stringify(file.submodule)
    const generation = owner.generation
    const current = submodules[item.path]
    setSubmodules((prev) => ({ ...prev, [item.path]: { ...(prev[item.path] ?? { entries: null, signature, failed: false }), open: !current?.open } }))
    if (current?.open || (current?.entries && current.signature === signature)) return
    const isCurrent = () => isCurrentOwner(generation) && JSON.stringify(fileOf(item.path)?.submodule) === signature
    void context.call('quirky.git/submoduleStatus', { worktree, path: item.path }).then((result) => {
      if (!isCurrent()) return
      const entries = (result as { entries: GitStatusEntry[] }).entries
      setSubmodules((prev) => ({ ...prev, [item.path]: { open: prev[item.path]?.open ?? true, entries, signature, failed: false } }))
    }).catch(() => {
      if (isCurrent()) setSubmodules((prev) => ({ ...prev, [item.path]: { open: prev[item.path]?.open ?? true, entries: null, signature, failed: true } }))
    })
  }

  const ask = (spec: { title: string; body: string; confirm: string; danger?: boolean; validate(): boolean }): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const generation = owner.generation
    setDialog({
      kind: 'confirm',
      owner: generation,
      generation: newGitUiGeneration(),
      danger: false,
      ...spec,
      validate: () => isCurrentOwner(generation) && spec.validate(),
      resolve
    })
    return promise
  }

  const resolveMutation = (mutation: Mutation): Mutation | null => {
    if (mutation.bulk) {
      if (status === null || operation !== 'none' || busyLabel !== null) return null
      if (mutation.params.scope === 'all' && status.capped !== true) return null
      return mutation
    }
    const targets = mutation.targets ?? mutation.paths.filter((path) => shown.some((file) => file.path === path))
    if (targets.length === 0) return null
    const paths: string[] = []
    for (const path of targets) {
      if (!shown.some((file) => file.path === path)) return null
      const allowed = actionPaths(rowEntries(path), mutation.verb, actionContext)
      if (allowed.length === 0) return null
      paths.push(...allowed)
    }
    const resolvedPaths = [...new Set(paths)]
    return resolvedPaths.length === 0
      ? null
      : { ...mutation, targets, paths: resolvedPaths, params: { paths: resolvedPaths } }
  }

  const runMutation = async (mutation: Mutation): Promise<boolean> => {
    const generation = owner.generation
    const current = resolveMutation(mutation)
    if (current === null) return false
    try {
      await context.call(current.method, { worktree, ...current.params })
      return true
    } catch (error) {
      if (isCurrentOwner(generation)) notifyMutationFailure(current, error)
      return false
    } finally {
      if (isCurrentOwner(generation)) {
        await refreshAll()
        if (isCurrentOwner(generation)) refreshReview()
      }
    }
  }

  const retryNotice = (run: () => void, available: () => boolean = () => true) => ({
    label: 'Retry',
    run: () => {
      if (isCurrentOwner(owner.generation) && available()) run()
    },
    expiresMs: RETRY_MS,
    available: () => isCurrentOwner(owner.generation) && available()
  })

  const notifyMutationFailure = (mutation: Mutation, error: unknown) => {
    const available = () => resolveMutation(mutation) !== null
    const key = `mutation:${mutation.verb}:${(mutation.targets ?? mutation.paths).join('\\0')}:${String(mutation.params.scope ?? '')}`
    const retry = retryNotice(() => {
      startReserved(key, () => runMutation(mutation))
    }, available)
    if (!mutation.bulk) {
      const path = mutation.targets?.[0] ?? mutation.paths[0] ?? ''
      notify({ id: 'source-control-entry-mutation', worktree, title: `Failed to ${mutation.verb} “${path}”`, body: messageOf(error), status: 'failing', actions: [retry] })
      return
    }
    notify({ id: 'source-control-bulk', worktree, title: `Bulk ${mutation.verb} failed`, body: messageOf(error), status: 'failing', actions: [retry] })
  }

  const stagePaths = (paths: string[], bulk: boolean, targets?: string[]) =>
    runMutation({ method: 'quirky.git/stage', params: { paths }, verb: 'stage', paths, ...(targets === undefined ? {} : { targets }), bulk })
  const unstagePaths = (paths: string[], bulk: boolean, targets?: string[]) =>
    runMutation({ method: 'quirky.git/unstage', params: { paths }, verb: 'unstage', paths, ...(targets === undefined ? {} : { targets }), bulk })
  const stageScope = (scope: 'all' | 'tracked') =>
    runMutation({ method: 'quirky.git/stage', params: { scope }, verb: 'stage', paths: [], bulk: true })

  const fileOf = (path: string): ReviewFile | undefined => files.find((file) => file.path === path)
  const rowEntries = (path: string): GitStatusEntry[] => entries.filter((entry) => entry.path === path)
  const baseName = model?.base.name ?? compare?.base ?? 'the base'
  const rowItemFor = (path: string): RowItem | undefined => {
    const file = shown.find((candidate) => candidate.path === path)
    return file === undefined ? undefined : toRowItem(file)
  }
  const rowSignature = (path: string): string | null => {
    const file = shown.find((candidate) => candidate.path === path)
    if (!file) return null
    const rows = rowEntries(path)
    return JSON.stringify([
      file,
      rows,
      baseName,
      actionPaths(rows, 'stage', actionContext),
      actionPaths(rows, 'unstage'),
      revertPlan(file, entries, baseName),
      ticks !== null && ticks.has(path)
    ])
  }
  const isCurrentRowMenu = (session: RowMenuSession): boolean =>
    rowMenuRef.current === session && isCurrentOwner(session.owner) && rowSignature(session.path) === session.signature
  const postSessionControl = (
    target: string,
    session: { owner: string; generation: string },
    action: string,
    data: Record<string, unknown> | undefined,
    current: () => boolean
  ) => {
    if (!current()) return
    postLocalControl({
      surface: PANEL_ID,
      target,
      generation: session.generation,
      action,
      ...(data === undefined ? {} : { data })
    }, current)
  }
  const postMenuChoice = (
    marker: { current: string | null },
    target: string,
    session: HeaderMenuSession,
    action: string,
    data: Record<string, unknown> | undefined,
    current: () => boolean
  ) => {
    if (!current()) return
    marker.current = session.generation
    queueMicrotask(() => {
      if (marker.current === session.generation) marker.current = null
    })
    postSessionControl(target, session, action, data, current)
  }
  const postMenuClose = (
    marker: { current: string | null },
    target: string,
    session: HeaderMenuSession,
    current: () => boolean
  ) => {
    queueMicrotask(() => {
      if (marker.current === session.generation) {
        marker.current = null
        return
      }
      postSessionControl(target, session, 'close', undefined, current)
    })
  }
  const currentHeaderMenu = (session: HeaderMenuSession) =>
    headerMenuRef.current === session && isCurrentOwner(session.owner)
  const currentShipMenu = (session: ShipMenuSession) =>
    shipMenuRef.current === session && isCurrentOwner(session.owner)
  const postHeaderMenuAction = (action: string, data?: Record<string, unknown>) => {
    const session = headerMenuRef.current
    if (session !== null) postMenuChoice(headerMenuChoice, `header-menu:${worktree}`, session, action, data, () => currentHeaderMenu(session))
  }
  const postHeaderMenuClose = () => {
    const session = headerMenuRef.current
    if (session !== null) postMenuClose(headerMenuChoice, `header-menu:${worktree}`, session, () => currentHeaderMenu(session))
  }
  const onFilterControl = (action: 'filter-open' | 'filter-close') => postMainControl(action)
  const onMenuOpen = (position: { x: number; y: number }) => postMainControl('header-menu-open', position)
  const onMenuAction = (action: string, data?: Record<string, unknown>) => postHeaderMenuAction(action, data)
  const postRowMenuAction = (session: RowMenuSession, action: string, data?: Record<string, unknown>) =>
    postMenuChoice(rowMenuChoice, `row-menu:${worktree}:${session.path}`, session, action, data, () => isCurrentRowMenu(session))
  const postRowMenuClose = (session: RowMenuSession) =>
    postMenuClose(rowMenuChoice, `row-menu:${worktree}:${session.path}`, session, () => isCurrentRowMenu(session))
  const postShipMenuAction = (session: ShipMenuSession, action: string, data?: Record<string, unknown>) =>
    postMenuChoice(shipMenuChoice, `ship-menu:${worktree}`, session, action, data, () => currentShipMenu(session))
  const postShipMenuClose = (session: ShipMenuSession) =>
    postMenuClose(shipMenuChoice, `ship-menu:${worktree}`, session, () => currentShipMenu(session))
  const postDialogAction = (session: DialogState, action: string) => {
    const target = session.kind === 'confirm'
      ? `confirm-dialog:${worktree}`
      : session.kind === 'details'
        ? `details-dialog:${worktree}`
        : `base-dialog:${worktree}`
    postSessionControl(target, session, action, undefined, () => dialogRef.current === session && isCurrentOwner(session.owner))
  }
  const postLaunchClose = (session: LaunchSession) =>
    postSessionControl(`launch-dialog:${worktree}`, session, 'close', undefined, () => launchRef.current === session && isCurrentOwner(session.owner))
  const positionFor = (
    data: Record<string, unknown> | undefined,
    fallback: () => MenuPosition | null
  ): MenuPosition | null => {
    const hasX = data !== undefined && Object.hasOwn(data, 'x')
    const hasY = data !== undefined && Object.hasOwn(data, 'y')
    if (!hasX && !hasY) return fallback()
    if (!hasX || !hasY || typeof data?.x !== 'number' || !Number.isFinite(data.x) ||
        typeof data.y !== 'number' || !Number.isFinite(data.y)) return null
    return { x: data.x, y: data.y }
  }
  const headerMenuPosition = (): MenuPosition | null => {
    const frame = root.current?.closest('[data-ui-tool-panel-frame]')
    const trigger = frame?.querySelector<HTMLButtonElement>('[aria-label="More source control actions"]')
    if (!trigger) return null
    const bounds = trigger.getBoundingClientRect()
    return Number.isFinite(bounds.right) && Number.isFinite(bounds.bottom) ? { x: bounds.right, y: bounds.bottom } : null
  }
  const shipMenuPosition = (): MenuPosition | null => {
    const trigger = root.current?.querySelector<HTMLButtonElement>(`[aria-label="${CARET_LABEL}"]`)
    if (!trigger) return null
    const bounds = trigger.getBoundingClientRect()
    return Number.isFinite(bounds.right) && Number.isFinite(bounds.bottom) ? { x: bounds.right, y: bounds.bottom } : null
  }
  const rowMenuPosition = (path: string): MenuPosition | null => {
    const rows = root.current?.querySelectorAll<HTMLElement>('[data-row-path]')
    const trigger = rows === undefined ? undefined : [...rows].find((row) => row.dataset.rowPath === path)
    if (!trigger) return null
    const bounds = trigger.getBoundingClientRect()
    return Number.isFinite(bounds.right) && Number.isFinite(bounds.bottom) ? { x: bounds.right, y: bounds.bottom } : null
  }
  const rowSignatureRef = useRef(rowSignature)
  rowSignatureRef.current = rowSignature
  const currentRevertPlan = (path: string): Revertable | null => {
    const file = shown.find((candidate) => candidate.path === path)
    if (!file) return null
    const plan = revertPlan(file, entries, baseName)
    return plan.kind === 'blocked' ? null : plan
  }
  const currentRevertPlanRef = useRef(currentRevertPlan)
  currentRevertPlanRef.current = currentRevertPlan
  const currentRevertSignature = (path: string): string | null => {
    const plan = currentRevertPlan(path)
    return plan === null ? null : JSON.stringify([rowSignature(path), plan])
  }
  const currentRevertSignatureRef = useRef(currentRevertSignature)
  currentRevertSignatureRef.current = currentRevertSignature

  const openInReview = (path: string) => {
    if (rowItemFor(path) === undefined) return
    selectPath(worktree, path, 'panel')
    if (fileOf(path)?.conflict !== undefined || rowEntries(path).some((entry) => entry.conflict !== undefined)) {
      return open({ mode: 'conflict-file', path })
    }
    const generation = owner.generation
    void openReview(context, { worktree, reveal: path }).catch((error: unknown) => {
      if (isCurrentOwner(generation)) context.toast('Could not open diff', messageOf(error), { kind: 'error' })
    })
  }

  const openFile = (path: string) => {
    const item = rowItemFor(path)
    if (item === undefined || item.letter === 'D') return
    const generation = owner.generation
    void context.call('quirky.editor/open', { worktree, path, focus: true }).catch((error: unknown) => {
      if (isCurrentOwner(generation)) context.toast('Could not open file', messageOf(error), { kind: 'error' })
    })
  }

  const toggleMark = async (path: string, desired?: boolean): Promise<void> => {
    const generation = owner.generation
    const file = shown.find((candidate) => candidate.path === path)
    if (!file || file.mark === undefined || file.conflict !== undefined || rowEntries(path).some((entry) => entry.conflict !== undefined)) return
    const currentReviewed = file.mark === 'reviewed'
    const reviewed = desired ?? !currentReviewed
    if (desired !== undefined && desired === currentReviewed) return
    const signature = rowSignature(path)
    const eligible = () => {
      const current = shown.find((candidate) => candidate.path === path)
      return isCurrentOwner(generation) && signature !== null && rowSignature(path) === signature &&
        current !== undefined && current.mark !== undefined && current.conflict === undefined &&
        !rowEntries(path).some((entry) => entry.conflict !== undefined)
    }
    try {
      const expected = reviewed ? await shownHash(context, worktree, path) : undefined
      if (!eligible()) return
      const result = await setReviewMark(context, { worktree, path, reviewed, ...(expected !== undefined && { expected }) })
      if (!isCurrentOwner(generation)) return
      refreshReview()
      if (result === 'ok' && reviewed) {
        const next = advanceAfterMark(files, viewMode, path)
        if (next !== null && isCurrentOwner(generation)) selectPath(worktree, next, 'panel')
      }
    } catch (error) {
      if (!eligible()) return
      const retry = retryNotice(() => {
        startReserved(`mark:${path}`, () => toggleMark(path, reviewed))
      }, eligible)
      notify({
        id: 'source-control-entry-mutation',
        worktree,
        title: `Failed to ${reviewed ? 'mark' : 'unmark'} “${path}”${reviewed ? ' reviewed' : ''}`,
        body: messageOf(error),
        status: 'failing',
        actions: [retry]
      })
    }
  }

  const failureText = (error: unknown): string => {
    const failures = dataOf(error).failures
    const first = Array.isArray(failures) ? (failures[0] as { message?: unknown } | undefined)?.message : undefined
    return typeof first === 'string' && first !== '' ? first : messageOf(error)
  }

  const runRevert = async (path: string, generation: string, signature: string): Promise<void> => {
    if (!isCurrentOwner(generation) || currentRevertSignatureRef.current(path) !== signature) return
    const plan = currentRevertPlanRef.current(path)
    if (plan === null) return
    const targetCurrent = () => currentRevertSignatureRef.current(path) === signature
    const guarded = fencedRevertContext(context, () => isCurrentOwner(generation), targetCurrent, controlUnavailable)
    try {
      await applyRevert(guarded, worktree, plan)
    } catch (error) {
      if (isCurrentOwner(generation)) {
        const available = () => isCurrentOwner(generation) && currentRevertPlanRef.current(path) !== null
        const retry = retryNotice(() => {
          const freshSignature = currentRevertSignatureRef.current(path)
          if (freshSignature !== null) startReserved(`revert:${path}`, () => runRevert(path, generation, freshSignature))
        }, available)
        notify({
          id: 'source-control-entry-mutation',
          worktree,
          title: `Failed to revert “${path}”`,
          body: failureText(error),
          status: 'failing',
          actions: [retry]
        })
      }
    } finally {
      if (isCurrentOwner(generation)) {
        await refreshAll()
        if (isCurrentOwner(generation)) refreshReview()
      }
    }
  }

  const startRevert = async (path: string): Promise<void> => {
    const file = shown.find((candidate) => candidate.path === path)
    if (!file) return
    const plan = revertPlan(file, entries, baseName)
    if (plan.kind === 'blocked') {
      context.toast(`Can’t revert “${splitPath(path).name}”`, plan.reason)
      return
    }
    const generation = owner.generation
    const signature = currentRevertSignatureRef.current(path)
    if (signature === null) return
    const active = document.activeElement
    const opener = active instanceof HTMLElement && active.closest('.git-row__actions') !== null ? active : null
    const confirmed = await ask({
      ...plan.text,
      danger: true,
      validate: () => currentRevertSignatureRef.current(path) === signature
    })
    if (!confirmed || !isCurrentOwner(generation) || currentRevertSignatureRef.current(path) !== signature) return
    requestFocusRecovery(opener, generation)
    await runRevert(path, generation, signature)
  }

  const { revertable, unrevertable } = useMemo(() => {
    const ready: Array<{ file: ReviewFile; plan: Revertable }> = []
    const blocked: Array<{ path: string; reason: string }> = []
    for (const file of reviewOrder(visibleFiles, 'list')) {
      const plan = revertPlan(file, entries, baseName)
      if (plan.kind === 'blocked') blocked.push({ path: file.path, reason: plan.reason })
      else ready.push({ file, plan })
    }
    return { revertable: ready, unrevertable: blocked }
  }, [visibleFiles, entries, baseName])
  const revertableRef = useRef(revertable)
  revertableRef.current = revertable
  const unrevertableRef = useRef(unrevertable)
  unrevertableRef.current = unrevertable
  const visibleFilesRef = useRef(visibleFiles)
  visibleFilesRef.current = visibleFiles
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const baseNameRef = useRef(baseName)
  baseNameRef.current = baseName
  const currentModelPlan = (path: string): Revertable | null => {
    const file = visibleFilesRef.current.find((candidate) => candidate.path === path)
    if (!file) return null
    const current = revertPlan(file, entriesRef.current, baseNameRef.current)
    return current.kind === 'blocked' ? null : current
  }
  const batchSignature = (batch: typeof revertable): string =>
    JSON.stringify(batch.map(({ file, plan }) => [file.path, plan]))
  const runRevertBatch = async (batch: typeof revertable, total: number, generation: string): Promise<void> => {
    const { done, failure } = await revertInOrder(
      batch.map(({ file, plan }) => ({
        path: file.path,
        run: async () => {
          if (!isCurrentOwner(generation)) throw new Error(REVERT_CANCELLED)
          const currentPlan = currentModelPlan(file.path)
          if (currentPlan === null || JSON.stringify(currentPlan) !== JSON.stringify(plan)) throw new Error(REVERT_CANCELLED)
          const signature = JSON.stringify(currentPlan)
          const targetCurrent = () => JSON.stringify(currentModelPlan(file.path)) === signature
          const guarded = fencedRevertContext(context, () => isCurrentOwner(generation), targetCurrent, controlUnavailable)
          await applyRevert(guarded, worktree, currentPlan)
        }
      }))
    )
    if (!isCurrentOwner(generation)) return
    await refreshAll()
    if (!isCurrentOwner(generation)) return
    refreshReview()
    if (failure === null || failure.message === REVERT_CANCELLED) return
    const remaining = batch.slice(done)
    const available = () => isCurrentOwner(generation) && remaining.every(({ file }) => currentModelPlan(file.path) !== null)
    const retry = retryNotice(() => {
      const fresh: typeof remaining = []
      for (const { file } of remaining) {
        const plan = currentModelPlan(file.path)
        if (plan === null) return
        fresh.push({ file, plan })
      }
      startReserved('revert-all', () => runRevertBatch(fresh, total, generation))
    }, available)
    const left = remaining.length
    notify({
      id: 'source-control-bulk',
      worktree,
      title: `Revert all stopped at “${failure.path}”`,
      body: `${failure.message.replace(/\.$/u, '')}. ${left} of ${total} ${total === 1 ? 'file' : 'files'} left.`,
      status: 'failing',
      actions: [retry]
    })
  }

  const revertAll = async (): Promise<void> => {
    const batch = revertableRef.current
    if (batch.length === 0) return
    const generation = owner.generation
    const signature = JSON.stringify([batchSignature(batch), unrevertableRef.current])
    const n = batch.length
    const skipped = unrevertableRef.current
    const skippedNote =
      skipped.length === 0 ? '' : ` ${skipped.length} ${skipped.length === 1 ? 'file' : 'files'} can’t be reverted here and will be listed afterwards.`
    const confirmed = await ask({
      title: `Revert all ${n} ${n === 1 ? 'file' : 'files'}?`,
      body: `Every file in the list goes back to its version on ${baseName}: uncommitted changes are discarded and new files are deleted. It stops at the first file that fails. This cannot be undone.${skippedNote}`,
      confirm: 'Revert all',
      danger: true,
      validate: () => JSON.stringify([batchSignature(revertableRef.current), unrevertableRef.current]) === signature
    })
    if (!confirmed || !isCurrentOwner(generation) || JSON.stringify([batchSignature(revertableRef.current), unrevertableRef.current]) !== signature) return
    requestFocusRecovery(null, generation)
    await runRevertBatch(batch, n, generation)
    if (isCurrentOwner(generation) && skipped.length > 0) {
      context.toast(
        `Revert all left ${skipped.length} ${skipped.length === 1 ? 'file' : 'files'} unchanged`,
        skipped.map(({ path, reason }) => `${path}: ${reason}`).join('\n')
      )
    }
  }

  const absolute = (path: string): string => (worktreePath === null ? path : `${worktreePath.replace(/\/$/, '')}/${path}`)

  const rowButtons = (item: RowItem): RowButton[] => {
    const buttons: RowButton[] = [{
      label: 'Revert',
      glyph: '↶',
      destructive: true,
      run: () => postMainControl('row-revert', { path: item.path })
    }]
    if (item.letter !== 'D') buttons.push({ label: 'Open', glyph: '↗', run: () => postMainControl('row-open-file', { path: item.path }) })
    return buttons
  }

  const handlers: RowHandlers = {
    click: (item) => postMainControl(item.submodule ? 'row-toggle-submodule' : 'row-open', { path: item.path }),
    contextMenu: (item, x, y) => postMainControl('row-menu-open', { path: item.path, x, y }),
    buttons: rowButtons,
    dragText: (item) => absolute(item.path),
    expansion: (item): Expansion | null => {
      if (!item.submodule) return null
      const state = submodules[item.path]
      return { open: state?.open ?? false, entries: state?.entries ?? null, failed: state?.failed ?? false }
    },
    toggleExpansion: (item) => postMainControl('row-toggle-submodule', { path: item.path }),
    check: (item) => (ticks === null || item.uncommitted !== true ? null : ticks.has(item.path)),
    toggleCheck: (item) => postMainControl('row-toggle-check', { path: item.path })
  }

  const copy = async (path: string, relative: boolean): Promise<void> => {
    if (rowItemFor(path) === undefined) return
    const generation = owner.generation
    try {
      await navigator.clipboard.writeText(relative ? path : absolute(path))
    } catch (error) {
      if (isCurrentOwner(generation)) context.toast('Could not copy', messageOf(error), { kind: 'error' })
    }
  }

  const reveal = async (path: string): Promise<void> => {
    if (rowItemFor(path) === undefined) return
    const generation = owner.generation
    try {
      await context.call('quirky.git/reveal', { worktree, path })
    } catch (error) {
      if (isCurrentOwner(generation)) context.toast('Could not reveal', messageOf(error), { kind: 'error' })
    }
  }

  const menuEntries = (session: RowMenuSession): ContextMenuItem[] => {
    const item = rowItemFor(session.path)
    if (item === undefined || rowSignature(session.path) !== session.signature) return []
    const rows = rowEntries(item.path)
    const stageable = actionPaths(rows, 'stage', actionContext)
    const unstageable = actionPaths(rows, 'unstage')
    const unstaging = stageable.length === 0 && unstageable.length > 0
    const plan = revertPlan(fileOf(item.path)!, entries, baseName)
    return [
      { label: 'Open in Review', onSelect: () => postRowMenuAction(session, 'open-review') },
      { label: 'Open file', enabled: item.letter !== 'D', onSelect: () => postRowMenuAction(session, 'open-file') },
      {
        label: item.mark === 'reviewed' ? 'Unmark' : 'Mark reviewed',
        enabled: item.conflict === undefined && item.mark !== undefined && !rows.some((entry) => entry.conflict !== undefined),
        onSelect: () => postRowMenuAction(session, 'toggle-mark')
      },
      {
        label: 'Revert file…',
        enabled: plan.kind !== 'blocked',
        title: plan.kind === 'blocked' ? plan.reason : undefined,
        onSelect: () => postRowMenuAction(session, 'revert')
      },
      {
        label: unstaging ? 'Unstage' : 'Stage',
        enabled: unstaging || stageable.length > 0,
        title: unstaging || stageable.length > 0 ? undefined : item.submodule ? 'Stage inside the submodule' : 'Nothing to stage',
        onSelect: () => postRowMenuAction(session, unstaging ? 'unstage' : 'stage')
      },
      { label: 'Copy path', separatorBefore: true, onSelect: () => postRowMenuAction(session, 'copy-path') },
      { label: 'Copy relative path', onSelect: () => postRowMenuAction(session, 'copy-relative-path') },
      { label: 'Reveal in Finder', onSelect: () => postRowMenuAction(session, 'reveal') }
    ]
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const onButton = (event.target as HTMLElement).closest('button') !== null
    if (onButton && event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return
    if (ticks !== null && event.key === 'Escape') return
    if (ticks !== null && event.key === ' ' && selected !== null && uncommittedPaths.includes(selected)) {
      event.preventDefault()
      postMainControl('row-toggle-check', { path: selected })
      return
    }
    const intent = keyIntent(shown, selected, event.key)
    if (intent === null) return
    event.preventDefault()
    switch (intent.type) {
      case 'select':
        return selectPath(worktree, intent.path, 'panel')
      case 'open':
        return postMainControl('row-open', { path: intent.path })
      case 'toggle-mark':
        return postMainControl('row-toggle-mark', { path: intent.path })
      case 'revert':
        return postMainControl('row-revert', { path: intent.path })
    }
  }

  const toggleTick = (path: string) => {
    if (ticks === null || !uncommittedPaths.includes(path) || !shown.some((file) => file.path === path)) return
    setTicks((previous) => {
      if (previous === null) return previous
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleDir = (path: string) => {
    if (viewMode !== 'tree' || !directoryPaths.has(path)) return
    setCollapsedDirs((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const failWith = (failure: Omit<ShipFailure, 'identity' | 'owner'>) => {
    if (!isCurrentOwner(owner.generation)) return
    setShipError({ ...failure, owner: owner.generation, identity: newGitUiGeneration() })
  }

  const remote = async (
    action: RemoteAction,
    params: Record<string, unknown> = {},
    requestedPurpose?: PushTargetPurpose
  ): Promise<boolean> => {
    const generation = owner.generation
    let purpose = requestedPurpose
    if (PUSH_ACTIONS.has(action)) {
      if (purpose === undefined && githubReview.kind === 'found') purpose = 'review'
      if (purpose === undefined && (
        githubReview.kind === 'loading' || githubReview.kind === 'waiting' || githubReview.kind === 'unavailable'
      )) {
        failWith({
          message: githubReview.kind === 'unavailable'
            ? githubReview.message
            : 'GitHub pull-request state is still being checked. Retry before pushing.',
          retry: () => {
            if (isCurrentOwner(generation)) startReserved('ship', () => remote(action, params, requestedPurpose))
          }
        })
        return false
      }
      if (action === 'sync' && purpose === 'review') {
        failWith({ message: 'Sync cannot safely choose a linked pull-request destination. Pull or push to the validated PR target separately.' })
        return false
      }
    }
    if (!isCurrentOwner(generation)) return false
    setShipError(null)
    const busyToken = {}
    localBusyTokenRef.current = busyToken
    localBusyOwnerRef.current = generation
    setLocalBusy(action)
    try {
      await context.call(REMOTE_METHODS[action], { worktree, ...params, ...(purpose === undefined ? {} : { purpose }) })
      return isCurrentOwner(generation)
    } catch (error) {
      if (!isCurrentOwner(generation)) return false
      const reason = reasonOf(error)
      const text = messageOf(error)
      const data = dataOf(error)
      if ((reason === 'hook' || reason === 'lint') && PUSH_ACTIONS.has(action)) {
        const summary = asText(data.summary) ?? text
        const output = asText(data.output) ?? ''
        failWith({
          message: summary,
          ...(hasMoreDetail(summary, output) ? { details: { title: 'Push Failed' as const, output } } : {}),
          fix: 'fixPushFailure'
        })
      } else {
        const line = errorLineFor(action, reason, text, operation === 'none' ? undefined : operation)
        failWith({
          message: line?.text ?? text,
          ...(line?.next === 'pull' ? { pull: true } : {}),
          ...(line?.next === 'fetch' ? { fetch: true } : {}),
          ...(line?.next === 'retry' ? { retry: () => {
            if (isCurrentOwner(generation)) startReserved('ship', () => remote(action, params, requestedPurpose))
          } } : {})
        })
      }
      if (action === 'push' && reason === 'non-fast-forward' && isCurrentOwner(generation)) {
        await context.call('quirky.git/fetch', { worktree }).catch(() => {})
      }
      return false
    } finally {
      if (localBusyTokenRef.current === busyToken) {
        localBusyTokenRef.current = null
        localBusyOwnerRef.current = null
        if (isCurrentOwner(generation)) setLocalBusy(null)
      }
      if (isCurrentOwner(generation)) {
        await refreshAll()
        if (isCurrentOwner(generation)) refreshReview()
      }
    }
  }

  const confirmForcePush = async (): Promise<ForceConfirmation | null> => {
    const generation = owner.generation
    const statusAtStart = statusRef.current
    const branch = statusAtStart?.branch ?? null
    const head = statusAtStart?.head ?? null
    const upstreamSha = statusAtStart?.upstreamStatus.sha
    const reviewKey = reviewPushKeyRef.current
    if (githubReview.kind === 'found') {
      if (reviewKey === null) return null
      let target: PushTargetResult | undefined
      try {
        target = pushTargetResult(await context.call('quirky.git/pushTarget', { worktree, purpose: 'review' }))
      } catch (error) {
        if (isCurrentOwner(generation) && reviewPushKeyRef.current === reviewKey) failWith({ message: `Force push failed: ${messageOf(error)}` })
        return null
      }
      if (!isCurrentOwner(generation) || reviewPushKeyRef.current !== reviewKey) return null
      if (!target || target.ready === false || target.headOid === undefined) {
        const message = target?.ready === false
          ? target.message
          : 'The linked pull-request push target is unavailable.'
        failWith({ message: `Force push unavailable: ${message}` })
        return null
      }
      if (branch !== target.localBranch || head !== target.localHead) {
        failWith({ message: 'The linked pull-request push target does not match the current branch head. Retry before force pushing.' })
        return null
      }
      const currentTarget = () =>
        isCurrentOwner(generation) && reviewPushKeyRef.current === reviewKey &&
        statusRef.current?.branch === branch && statusRef.current?.head === head
      const body = `Force push ${target.localBranch} to ${target.remote}/${target.branch} (${target.repository.host}/${target.repository.owner}/${target.repository.repo}) at ${target.headOid}? The push uses an exact lease on this pull-request head.`
      const confirmed = await ask({
        title: 'Force push linked pull request?',
        body,
        confirm: 'Force Push',
        danger: true,
        validate: currentTarget
      })
      if (!confirmed || !currentTarget()) return null
      return { purpose: 'review', expected: target.headOid, target, reviewKey, branch, head, upstreamSha }
    }
    if (githubReview.kind === 'loading' || githubReview.kind === 'waiting' || githubReview.kind === 'unavailable') {
      const message = githubReview.kind === 'unavailable'
        ? githubReview.message
        : 'GitHub pull-request state is still being checked. Retry before force pushing.'
      failWith({ message: `Force push unavailable: ${message}` })
      return null
    }
    if (statusAtStart === null) return null
    let text: string
    try {
      text = (await context.call('quirky.git/describeForcePush', { worktree })) as string
    } catch (error) {
      if (isCurrentOwner(generation) && reviewPushKeyRef.current === reviewKey) failWith({ message: `Force push failed: ${messageOf(error)}` })
      return null
    }
    const currentTarget = () => {
      const current = statusRef.current
      return isCurrentOwner(generation) && reviewPushKeyRef.current === reviewKey && current !== null &&
        current.branch === branch && current.head === head && current.upstreamStatus.sha === upstreamSha
    }
    if (!currentTarget()) return null
    const { title, body } = splitQuestion(text)
    const confirmed = await ask({
      title,
      body,
      confirm: 'Force Push',
      danger: true,
      validate: currentTarget
    })
    return confirmed && currentTarget() ? { branch, head, upstreamSha } : null
  }

  const forcePushParams = (confirmation: ForceConfirmation): Record<string, unknown> => {
    if (confirmation.expected !== undefined) return { yes: true, expected: confirmation.expected }
    return confirmation.upstreamSha ? { yes: true, expected: confirmation.upstreamSha } : { yes: true }
  }

  const runApprovedForcePush = async (confirmation: ForceConfirmation, expectedLocalHead: string | null): Promise<boolean> => {
    const generation = owner.generation
    if (!isCurrentOwner(generation)) return false
    if (confirmation.purpose === 'review') {
      const approved = confirmation.target
      if (approved === undefined || confirmation.reviewKey === undefined) return false
      let reread: PushTargetResult | undefined
      try {
        reread = pushTargetResult(await context.call('quirky.git/pushTarget', { worktree, purpose: 'review' }))
      } catch (error) {
        if (isCurrentOwner(generation) && reviewPushKeyRef.current === confirmation.reviewKey) failWith({ message: `Force push failed: ${messageOf(error)}` })
        return false
      }
      if (!isCurrentOwner(generation) || reviewPushKeyRef.current !== confirmation.reviewKey) return false
      if (!reread || reread.ready !== true) {
        failWith({ message: 'The pull-request push destination changed after confirmation. Confirm the current target before force pushing.' })
        return false
      }
      const sameDestination = reread.localBranch === approved.localBranch &&
        reread.remote === approved.remote &&
        reread.branch === approved.branch &&
        reread.repository.host === approved.repository.host &&
        reread.repository.owner === approved.repository.owner &&
        reread.repository.repo === approved.repository.repo &&
        reread.headOid === approved.headOid &&
        reread.number === approved.number &&
        reread.fork === approved.fork
      if (!sameDestination) {
        failWith({ message: 'The pull-request push destination or lease changed after confirmation. Confirm the updated target before force pushing.' })
        return false
      }
      let fresh: GitStatus
      try {
        fresh = await exactStatus(worktree, confirmation.branch, expectedLocalHead ?? undefined)
      } catch (error) {
        if (isCurrentOwner(generation)) failWith({ message: `Force push unavailable: ${messageOf(error)}` })
        return false
      }
      if (!isCurrentOwner(generation) || reviewPushKeyRef.current !== confirmation.reviewKey) return false
      if (fresh.head !== expectedLocalHead || reread.localHead !== fresh.head || fresh.branch !== approved.localBranch) {
        failWith({ message: 'The local branch head changed after force-push confirmation. Confirm the current target before pushing.' })
        return false
      }
    } else {
      let fresh: GitStatus
      try {
        fresh = await exactStatus(worktree, confirmation.branch, expectedLocalHead ?? undefined)
      } catch (error) {
        if (isCurrentOwner(generation)) failWith({ message: `Force push unavailable: ${messageOf(error)}` })
        return false
      }
      if (!isCurrentOwner(generation)) return false
      if (fresh.upstreamStatus.sha !== confirmation.upstreamSha) {
        failWith({ message: 'The force-push destination changed after confirmation. Confirm the current target before pushing.' })
        return false
      }
    }
    return remote('force-push', forcePushParams(confirmation), confirmation.purpose)
  }

  const forcePush = async (): Promise<void> => {
    const generation = owner.generation
    const confirmation = await confirmForcePush()
    if (!confirmation || !isCurrentOwner(generation)) return
    await runApprovedForcePush(confirmation, confirmation.head)
  }

  const exactStatus = async (target: string, expectedBranch: string | null, expectedHead?: string): Promise<GitStatus> => {
    const value = await context.call('quirky.git/status', { worktree: target })
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Git returned an invalid worktree status.')
    const candidate = value as Record<string, unknown>
    const upstream = candidate.upstreamStatus
    if ((candidate.branch !== null && typeof candidate.branch !== 'string') ||
      (candidate.head !== null && typeof candidate.head !== 'string') || !Array.isArray(candidate.entries) ||
      !candidate.entries.every((entry: unknown) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).path === 'string' &&
        ['conflicts', 'staged', 'unstaged', 'untracked'].includes(String((entry as Record<string, unknown>).area))) ||
      (candidate.operation !== 'none' && candidate.operation !== 'merge' && candidate.operation !== 'rebase' && candidate.operation !== 'cherry-pick') ||
      typeof candidate.capped !== 'boolean' ||
      typeof upstream !== 'object' || upstream === null || Array.isArray(upstream)) {
      throw new Error('Git returned an incomplete worktree status.')
    }
    const upstreamStatus = upstream as Record<string, unknown>
    if (typeof upstreamStatus.hasUpstream !== 'boolean' || !Number.isSafeInteger(upstreamStatus.ahead) ||
      !Number.isSafeInteger(upstreamStatus.behind)) throw new Error('Git returned an incomplete upstream status.')
    const resolved = candidate as unknown as GitStatus
    if (resolved.branch !== expectedBranch || (expectedHead !== undefined && resolved.head !== expectedHead)) {
      throw new Error('The branch or HEAD changed while this step was running. Start the action again for the current branch.')
    }
    return resolved
  }

  const focusMessage = () => messageRef.current?.focus()

  /**
   * Commits with the current message. `staged` commits the index as is, `all` stages everything
   * first, `selected` stages exactly the ticked files and unstages any other staged one. Status
   * is re-read and validated before the step and refreshed after it. An empty message sets the
   * error line and focuses the box instead of committing. Inside the Create PR chain, `chain`
   * pins the HEAD the chain started from and lets a cancel stop it before the commit starts.
   */
  const commitWith = async (
    mode: 'staged' | 'all' | 'selected',
    chain?: { head: string; stillCurrent: () => boolean; committedHead?: { value: string | null } },
    messageOverride?: string
  ): Promise<boolean> => {
    const generation = owner.generation
    const draftAtStart = message
    const editAtStart = edits.current
    const chosenTicks = ticksRef.current
    const text = (messageOverride ?? draftAtStart).trim()
    if (text === '') {
      if (isCurrentOwner(generation)) {
        failWith({ message: EMPTY_MESSAGE, emptyMessage: true })
        focusMessage()
      }
      return false
    }
    if (!isCurrentOwner(generation)) return false
    setShipError(null)
    const token = {}
    commitTokenRef.current = token
    commitOwnerRef.current = generation
    setCommitting(true)
    requestFocusRecovery(null, generation)
    try {
      const statusAtStart = statusRef.current
      if (statusAtStart === null) return false
      const branch = statusAtStart.branch
      const expectedHead = chain?.head ?? statusAtStart.head ?? undefined
      const fresh = await exactStatus(worktree, branch, expectedHead)
      if (!isCurrentOwner(generation) || (chain && !chain.stillCurrent())) return false
      if (mode === 'all') {
        await context.call('quirky.git/stage', { worktree, scope: 'all' })
        if (!isCurrentOwner(generation) || (chain && !chain.stillCurrent())) return false
      } else if (mode === 'selected') {
        const keep = new Set(chosenTicks ?? [])
        const toStage = [...new Set(fresh.entries.filter((entry) => keep.has(entry.path)).map((entry) => entry.path))]
        const toUnstage = [...new Set(fresh.entries.filter((entry) => entry.area === 'staged' && !keep.has(entry.path)).map((entry) => entry.path))]
        if (toStage.length > 0) {
          await context.call('quirky.git/stage', { worktree, paths: toStage })
          if (!isCurrentOwner(generation) || (chain && !chain.stillCurrent())) return false
        }
        if (toUnstage.length > 0) {
          await context.call('quirky.git/unstage', { worktree, paths: toUnstage })
          if (!isCurrentOwner(generation) || (chain && !chain.stillCurrent())) return false
        }
      }
      if (mode !== 'staged') {
        const staged = await exactStatus(worktree, branch, expectedHead)
        if (!isCurrentOwner(generation) || (chain && !chain.stillCurrent())) return false
        if (mode === 'all' && staged.entries.some((entry) => entry.area !== 'staged')) {
          throw new Error('New or unresolved changes appeared while staging. Review Source Control and try again.')
        }
        if (chain && mode === 'all' && staged.entries.length === 0) {
          throw new Error('Stage the intended changes before committing and creating a pull request.')
        }
      }
      if (!isCurrentOwner(generation) || (chain && !chain.stillCurrent())) return false
      const result = await context.call('quirky.git/commit', { worktree, message: text })
      if (!isCurrentOwner(generation)) return false
      if (chain?.committedHead && isRecord(result) && typeof result.sha === 'string') chain.committedHead.value = result.sha
      const clearDraft = edits.current === editAtStart && message === draftAtStart &&
        (messageOverride === undefined || messageOverride.trim() === draftAtStart.trim())
      if (clearDraft) {
        setMessage('')
        setWrittenBy(null)
      }
      if (mode === 'selected' && chosenTicks !== null && ticksRef.current === chosenTicks) setTicks(null)
      return true
    } catch (error) {
      if (isCurrentOwner(generation)) {
        const reason = reasonOf(error)
        const data = dataOf(error)
        if (reason === 'hook' || reason === 'lint' || data.reason === 'failed') {
          const summary = asText(data.summary) ?? messageOf(error)
          const output = asText(data.output) ?? ''
          failWith({
            message: summary,
            ...(hasMoreDetail(summary, output) ? { details: { title: 'Commit Failed' as const, output } } : {}),
            fix: 'fixCommitFailure'
          })
        } else {
          failWith({
            message: messageOf(error),
            retry: () => {
              if (isCurrentOwner(generation)) startReserved('ship', () => commitWith(mode, undefined, messageOverride))
            }
          })
        }
      }
      return false
    } finally {
      if (commitTokenRef.current === token) {
        commitTokenRef.current = null
        commitOwnerRef.current = null
        if (isCurrentOwner(generation)) setCommitting(false)
      }
      if (isCurrentOwner(generation)) {
        await refreshAll()
        if (isCurrentOwner(generation)) refreshReview()
      }
    }
  }

  const abort = async (): Promise<void> => {
    const generation = owner.generation
    const name = operation
    if (name === 'none' || name === 'cherry-pick' || busyLabel !== null) return
    const validate = () =>
      isCurrentOwner(generation) &&
      statusRef.current?.operation === name &&
      statusRef.current.busy === null &&
      localBusyOwnerRef.current !== generation &&
      commitOwnerRef.current !== generation
    const confirmed = await ask({
      title: `Abort ${name}?`,
      body: `This cancels the ${name} in progress and can discard conflict resolutions made during this ${name}.`,
      confirm: `Abort ${name}`,
      danger: true,
      validate
    })
    if (confirmed && validate()) await remote('abort', { yes: true })
  }
  const cancelCreateReview = () => {
    if (activeCreateIntent.current === null) return
    createIntent.current += 1
    activeCreateIntent.current = null
    setCreatingReview(false)
    failWith({ message: 'The remaining Create PR steps were cancelled. Any commit or push already running may still finish on this worktree.' })
  }

  const createReview = async (): Promise<void> => {
    if (activeCreateIntent.current !== null || !status || !status.branch || !status.head) return
    if (githubReview.kind === 'unavailable') {
      failWith({ message: `Could not confirm that this branch has no pull request. ${githubReview.message}` })
      return
    }
    if (githubReview.kind !== 'no-review' || githubReview.target.worktree !== worktree ||
      githubReview.target.branch !== status.branch || githubReview.target.head !== status.head) return
    const generation = owner.generation
    const target = worktree
    const branch = status.branch
    const initialHead = status.head
    const intent = ++createIntent.current
    activeCreateIntent.current = intent
    const stillCurrent = () =>
      createIntent.current === intent && activeCreateIntent.current === intent &&
      activeWorktree.current === target && isCurrentOwner(generation)
    setCreatingReview(true)
    setShipError(null)
    try {
      if (unresolved > 0 || entries.some((entry) => entry.area === 'conflicts')) {
        throw new Error('Resolve conflicts before creating a pull request.')
      }
      let fresh = await exactStatus(target, branch, initialHead)
      if (!stillCurrent()) return
      if (fresh.operation !== 'none') throw new Error('Finish the active Git operation before creating a pull request.')
      let committed = false
      let expectedHead = initialHead
      if (fresh.entries.length > 0) {
        if (draftTextRef.current.trim() === '') throw new Error(EMPTY_MESSAGE)
        const committedHead = { value: null as string | null }
        if (!(await commitWith('all', { head: initialHead, stillCurrent, committedHead }))) return
        if (!stillCurrent()) return
        committed = true
        fresh = await exactStatus(target, branch, committedHead.value ?? undefined)
        if (!stillCurrent()) return
        if (fresh.head === null) throw new Error('The branch head is unavailable after the commit.')
        expectedHead = fresh.head
        if (fresh.entries.length > 0) throw new Error('New changes appeared after the commit. Review Source Control before creating a pull request.')
      }

      let needsPush = committed || !fresh.upstreamStatus.hasUpstream || fresh.upstreamStatus.ahead > 0
      if (fresh.upstreamStatus.behind > 0) throw new Error('Sync this branch with its upstream before creating a pull request.')
      if (needsPush) {
        fresh = await exactStatus(target, branch, expectedHead)
        if (!stillCurrent()) return
        if (fresh.entries.length > 0) throw new Error('Commit or stage the current changes before pushing this branch.')
        if (!(await remote('push', {}, 'creation'))) return
        if (!stillCurrent()) return
        fresh = await exactStatus(target, branch, expectedHead)
        if (!stillCurrent()) return
        if (fresh.entries.length > 0) throw new Error('New changes appeared after pushing. Review Source Control before creating a pull request.')
        if (!fresh.upstreamStatus.hasUpstream || fresh.upstreamStatus.ahead > 0) {
          throw new Error('The branch is still not fully pushed. Resolve the push state before creating a pull request.')
        }
        needsPush = false
      }
      if (!stillCurrent()) return
      fresh = await exactStatus(target, branch, expectedHead)
      if (!stillCurrent()) return
      if (fresh.entries.length > 0) throw new Error('Commit or discard local changes before creating a pull request.')
      if (fresh.upstreamStatus.behind > 0) throw new Error('Sync this branch with its upstream before creating a pull request.')
      if (needsPush || fresh.upstreamStatus.ahead > 0 || !fresh.upstreamStatus.hasUpstream) {
        throw new Error('Push this branch before creating a pull request.')
      }
      if (!stillCurrent()) return
      const latestReview = await readGitHubReview(context, { worktree: target, branch, head: expectedHead })
      if (!stillCurrent()) return
      if (latestReview.kind === 'found') {
        throw new Error(`Pull request #${latestReview.review.number} is already linked to this branch.`)
      }
      if (latestReview.kind !== 'no-review') {
        const detail = latestReview.kind === 'unavailable' ? ` ${latestReview.message}` : ''
        throw new Error(`Could not confirm that this branch has no pull request.${detail}`)
      }
      if (!stillCurrent()) return
      await context.call('quirky.reviews/createOpen', { worktree: target })
    } catch (error) {
      if (stillCurrent()) {
        const text = messageOf(error)
        failWith(text === EMPTY_MESSAGE ? { message: text, emptyMessage: true } : { message: text })
        if (text === EMPTY_MESSAGE) focusMessage()
      }
    } finally {
      if (activeCreateIntent.current === intent) {
        activeCreateIntent.current = null
        if (isCurrentOwner(generation)) setCreatingReview(false)
      }
    }
  }

  const viewReview = async (): Promise<void> => {
    if (githubReview.kind !== 'found') return
    const generation = owner.generation
    try {
      await context.call('quirky.reviews/openLink', { url: githubReview.review.url })
    } catch (error) {
      if (isCurrentOwner(generation)) failWith({ message: `Could not open pull request: ${messageOf(error)}` })
    }
  }

  const commitMode = stagedCount > 0 ? 'staged' : 'all'

  const runMenu = async function runMenu(id: ShipMenuId): Promise<void> {
    const offered = shipItems.find((item) => item.id === id)
    if (!offered?.enabled) return
    const generation = owner.generation
    setShipError(null)
    switch (id) {
      case 'commit-all':
        await commitWith('all')
        return
      case 'commit-selected':
        if (isCurrentOwner(generation)) setTicks(new Set(uncommittedPaths))
        return
      case 'commit-push':
        if (status && shouldForcePushWithLease(status.upstreamStatus)) {
          const confirmation = await confirmForcePush()
          if (!confirmation || !isCurrentOwner(generation) || confirmation.head === null) return
          const committedHead = { value: null as string | null }
          const chain = {
            head: confirmation.head,
            stillCurrent: () => isCurrentOwner(generation) && statusRef.current?.branch === confirmation.branch,
            committedHead
          }
          if (!(await commitWith(commitMode, chain)) || !isCurrentOwner(generation)) return
          let fresh: GitStatus
          try {
            fresh = await exactStatus(worktree, confirmation.branch, committedHead.value ?? undefined)
          } catch (error) {
            if (isCurrentOwner(generation)) failWith({ message: `Force push unavailable: ${messageOf(error)}` })
            return
          }
          if (!isCurrentOwner(generation) || fresh.head === null) return
          await runApprovedForcePush(confirmation, fresh.head)
        } else if (await commitWith(commitMode) && isCurrentOwner(generation)) {
          await remote('push')
        }
        return
      case 'commit-push-pr':
        await createReview()
        return
      case 'pull':
        await remote('pull')
        return
      case 'fast-forward':
        await remote('fast-forward')
        return
      case 'sync':
        await remote('sync')
        return
      case 'push':
      case 'publish':
        await remote('push')
        return
      case 'force-push':
        await forcePush()
        return
      case 'rebase':
        await remote('rebase')
        return
      case 'fetch':
        await remote('fetch')
        return
      case 'create-pr':
        await createReview()
        return
      case 'view-pr':
        await viewReview()
        return
    }
  }

  const runStep = (kind: ShipStepKind, messageOverride?: string): void => {
    if (step === null || step.kind !== kind || !step.enabled) return
    setShipError(null)
    switch (kind) {
      case 'commit-staged':
        void commitWith('staged', undefined, messageOverride)
        return
      case 'commit-all':
        void commitWith('all', undefined, messageOverride)
        return
      case 'commit-selected':
        void commitWith('selected', undefined, messageOverride)
        return
      case 'pull':
        void remote('pull')
        return
      case 'sync':
        void remote('sync')
        return
      case 'publish':
        void remote('push')
        return
      case 'push':
        if (status && shouldForcePushWithLease(status.upstreamStatus)) void forcePush()
        else void remote('push')
        return
      case 'create-pr':
        void createReview()
        return
      case 'view-pr':
        void viewReview()
        return
      case 'up-to-date':
        return
    }
  }
  const openCommit = (commit: GitCommit) => postMainControl('history-open-commit', { commit: commit.oid })
  const openCommitFile = (commit: GitCommit, change: GitChange) =>
    postMainControl('history-open-file', { commit: commit.oid, path: change.path })
  const openHistoryCommit = async function openHistoryCommit(commit: string): Promise<void> {
    const generation = owner.generation
    try {
      const result = await context.call('quirky.git/history', { worktree, limit: 200 })
      if (!isCurrentOwner(generation)) return
      if (!isRecord(result) || !Array.isArray(result.commits) ||
          !result.commits.some((item) => isRecord(item) && item.oid === commit)) {
        throw new Error('The selected commit is no longer available in this worktree.')
      }
      if (!isCurrentOwner(generation)) return
      await openReview(context, { worktree, commit })
    } catch (error) {
      if (isCurrentOwner(generation)) context.toast('Could not open diff', messageOf(error), { kind: 'error' })
    }
  }
  const openHistoryFile = async function openHistoryFile(commit: string, path: string): Promise<void> {
    const generation = owner.generation
    try {
      const result = await context.call('quirky.git/commitFiles', { worktree, commit })
      if (!isCurrentOwner(generation)) return
      if (!isRecord(result) || !Array.isArray(result.entries) ||
          !result.entries.some((entry) => isRecord(entry) && entry.path === path)) {
        throw new Error('The selected file is no longer part of this commit.')
      }
      if (!isCurrentOwner(generation)) return
      await openReview(context, { worktree, commit, reveal: path })
    } catch (error) {
      if (isCurrentOwner(generation)) context.toast('Could not open diff', messageOf(error), { kind: 'error' })
    }
  }
  const statusRefreshRef = useRef<Promise<GitStatus | null> | null>(null)
  const beginStatusRefresh = (): Promise<GitStatus | null> => {
    if (statusRefreshRef.current !== null) return statusRefreshRef.current
    const pending = data.refresh()
    statusRefreshRef.current = pending
    void pending.then(() => {
      if (statusRefreshRef.current === pending) statusRefreshRef.current = null
    }, () => {
      if (statusRefreshRef.current === pending) statusRefreshRef.current = null
    })
    return pending
  }
  const refreshPanel = function refreshPanel(): void {
    const generation = owner.generation
    void refreshAll().then(() => {
      if (isCurrentOwner(generation)) refreshReview()
    })
  }
  const retryCappedStatus = async function retryCappedStatus(): Promise<void> {
    const generation = owner.generation
    if (!isCurrentOwner(generation)) return
    if ((await beginStatusRefresh()) === null && isCurrentOwner(generation)) {
      context.toast('Could not refresh Source Control', 'Try again.', { kind: 'error' })
    }
  }

  const currentShipError = shipError?.owner === owner.generation ? shipError : null
  const currentPrActions = aiEnabled && githubReview.kind === 'found' &&
    githubReview.review.state !== 'closed' && githubReview.review.state !== 'merged'
    ? PR_AI_ACTIONS
    : []
  const customizeActions = [...new Set<FixAction>([
    ...(aiEnabled ? ['branchSummary' as const] : []),
    ...currentPrActions.map(({ action }) => action),
    ...(aiEnabled && currentShipError?.fix ? [currentShipError.fix] : []),
    ...(aiEnabled && operation !== 'none' && unresolved > 0 ? ['resolveConflicts' as const] : [])
  ])]
  const quickFixActions = [...new Set<FixAction>([
    ...(aiEnabled && currentShipError?.fix ? [currentShipError.fix] : []),
    ...(aiEnabled && operation !== 'none' && unresolved > 0 ? ['resolveConflicts' as const] : [])
  ])]
  const isOfferedFixAction = (value: unknown): value is FixAction =>
    typeof value === 'string' && customizeActions.includes(value as FixAction)
  const hasShipErrorAction = currentShipError !== null &&
    (currentShipError.pull || currentShipError.fetch || currentShipError.details !== undefined || currentShipError.retry !== undefined)
  const headerMenuActionNames = [
    'close',
    'view-mode',
    'change-base',
    'refresh',
    ...(aiEnabled && (currentPrActions.length > 0 || customizeActions.includes('branchSummary')) ? ['ai-customize'] : []),
    'ai-settings',
    ...(revertable.length > 0 ? ['revert-all'] : [])
  ]
  const rowMenuActionNames = menu !== null && isCurrentRowMenu(menu) ? (() => {
    const item = rowItemFor(menu.path)
    if (!item) return []
    const rows = rowEntries(menu.path)
    const stageable = actionPaths(rows, 'stage', actionContext)
    const unstageable = actionPaths(rows, 'unstage')
    const plan = revertPlan(fileOf(menu.path)!, entries, baseName)
    return [
      'close',
      'open-review',
      ...(item.letter === 'D' ? [] : ['open-file']),
      ...(item.mark !== undefined && item.conflict === undefined && !rows.some((entry) => entry.conflict !== undefined) ? ['toggle-mark'] : []),
      ...(plan.kind === 'blocked' ? [] : ['revert']),
      ...(stageable.length > 0 ? ['stage'] : unstageable.length > 0 ? ['unstage'] : []),
      'copy-path',
      'copy-relative-path',
      'reveal'
    ]
  })() : []
  const shipMenuActionNames = shipMenuAt !== null && currentShipMenu(shipMenuAt)
    ? ['close', ...(shipItems.some((item) => item.enabled) ? ['choose'] : [])]
    : []
  const headerVisible = data.unavailable === null
  const mainActions: string[] = []
  const addMainActions = (...actions: string[]) => mainActions.push(...actions)
  if (headerVisible) {
    addMainActions('filter-open', 'filter-close', 'view-mode', 'header-menu-open', 'change-base', 'refresh', 'ai-settings')
  }
  if (data.error !== null || data.unavailable !== null || capped) addMainActions('refresh-status')
  if (review.error !== null) addMainActions('refresh-review')
  if (compareData.error !== null || (compare !== null && compare.status !== 'ready')) addMainActions('refresh-compare')
  if (reviewPushTarget?.key === reviewPushKey && reviewPushTarget.state === 'error') addMainActions('retry-push-target')
  if (revertable.length > 0 && headerVisible) addMainActions('revert-all')
  if (viewMode === 'tree' && directoryPaths.size > 0) addMainActions('toggle-directory')
  if (shown.length > 0) addMainActions('row-menu-open', 'row-revert')
  if (shown.some((file) => file.submodule !== undefined)) addMainActions('row-toggle-submodule')
  if (shown.some((file) => file.status !== 'D')) addMainActions('row-open-file')
  if (shown.some((file) => file.conflict === undefined && file.mark !== undefined)) addMainActions('row-toggle-mark')
  if (shown.some((file) => !file.submodule)) addMainActions('row-open')
  if (ticks !== null && shown.some((file) => file.uncommitted === true)) addMainActions('row-toggle-check')
  if (ticks !== null) addMainActions('cancel-selection')
  if (status !== null && !filtering) addMainActions('history-toggle')
  if (historyOpen && status !== null && !filtering) addMainActions('history-open-commit', 'history-open-file')
  if (step?.enabled) addMainActions('ship-step')
  if (shipBarPossible && step !== null) addMainActions('ship-menu-open')
  if (activeCreateIntent.current !== null) addMainActions('cancel-create-review')
  if (operation !== 'none' && unresolved > 0) addMainActions('review-conflicts')
  if (operation !== 'none' && unresolved === 0 && busyLabel === null) addMainActions('continue-operation')
  if ((operation === 'merge' || operation === 'rebase') && busyLabel === null) addMainActions('abort-operation')
  if (capped && operation === 'none' && busyLabel === null) addMainActions('stage-all')
  if (aiEnabled && quickFixActions.length > 0 && !aiFix.busy) addMainActions('ai-fix')
  if (aiEnabled && customizeActions.length > 0) addMainActions('ai-customize')
  const dialogAddress = dialog !== null && dialog.owner === owner.generation
    ? {
        surface: PANEL_ID,
        target: dialog.kind === 'confirm' ? `confirm-dialog:${worktree}` : dialog.kind === 'details' ? `details-dialog:${worktree}` : `base-dialog:${worktree}`,
        generation: dialog.generation,
        actions: dialog.kind === 'confirm'
          ? ['confirm', 'cancel']
          : dialog.kind === 'details'
            ? ['close', ...(aiEnabled && !aiFix.busy ? ['fix'] : [])]
            : ['close']
      }
    : null
  const launchAddress = launch !== null && launch.owner === owner.generation
    ? { surface: PANEL_ID, target: `launch-dialog:${worktree}`, generation: launch.generation, actions: ['close'] }
    : null
  const mainAddress = mainActions.length === 0
    ? null
    : { surface: PANEL_ID, target: `worktree:${worktree}`, generation: owner.generation, actions: mainActions }
  const headerAddress = headerMenu !== null && currentHeaderMenu(headerMenu)
    ? { surface: PANEL_ID, target: `header-menu:${worktree}`, generation: headerMenu.generation, actions: headerMenuActionNames }
    : null
  const rowAddress = menu !== null && rowMenuActionNames.length > 0
    ? { surface: PANEL_ID, target: `row-menu:${worktree}:${menu.path}`, generation: menu.generation, actions: rowMenuActionNames }
    : null
  const shipMenuAddress = shipMenuAt !== null && shipMenuActionNames.length > 0
    ? { surface: PANEL_ID, target: `ship-menu:${worktree}`, generation: shipMenuAt.generation, actions: shipMenuActionNames }
    : null
  const shipErrorAddress = currentShipError === null ? null : {
    surface: PANEL_ID,
    target: `ship-error:${worktree}`,
    generation: currentShipError.identity,
    actions: ['ship-error-dismiss', ...(hasShipErrorAction && busyLabel === null ? ['ship-error-action'] : [])]
  }

  const openBaseDialog = () => setDialog({ kind: 'base', owner: owner.generation, generation: newGitUiGeneration() })
  const openLaunchDialog = (action: FixAction) => {
    if (!aiEnabled || !isOfferedFixAction(action)) return false
    setLaunch({ owner: owner.generation, generation: newGitUiGeneration(), action })
    return true
  }
  const openAiSettings = async function openAiSettings(): Promise<void> {
    const generation = owner.generation
    try {
      await context.openView(AI_SETTINGS_VIEW_ID, { worktree })
    } catch (error) {
      if (isCurrentOwner(generation)) context.toast('Could not open AI settings', messageOf(error), { kind: 'error' })
    }
  }
  const handlePanelAction = (action: string, data?: Record<string, unknown>): boolean => {
    const emptyData = data === undefined || Object.keys(data).length === 0
    const only = (keys: readonly string[]) => data === undefined || Object.keys(data).every((key) => keys.includes(key))
    switch (action) {
      case 'filter-open':
        if (!emptyData || !headerVisible) return false
        setFilterOpen(true)
        return true
      case 'filter-close':
        if (!emptyData || !headerVisible) return false
        setFilter('')
        setFilterOpen(false)
        return true
      case 'view-mode': {
        if (!only(['mode']) || (data?.mode !== 'list' && data?.mode !== 'tree') || !headerVisible) return false
        setViewMode(data.mode, () => isCurrentOwner(owner.generation))
        return true
      }
      case 'header-menu-open': {
        if (!only(['x', 'y']) || !headerVisible) return false
        const position = positionFor(data, headerMenuPosition)
        if (position === null) return false
        setHeaderMenu({ owner: owner.generation, generation: newGitUiGeneration(), position })
        return true
      }
      case 'change-base':
        if (!emptyData || !headerVisible) return false
        openBaseDialog()
        return true
      case 'refresh':
        if (!emptyData || !headerVisible) return false
        refreshPanel()
        return true
      case 'refresh-status':
        if (!emptyData || statusRefreshRef.current !== null) return false
        return startReserved('refresh-status', () => beginStatusRefresh())
      case 'refresh-compare':
        if (!emptyData || (compareData.error === null && (compare === null || compare.status === 'ready'))) return false
        return startReserved('refresh-compare', () => compareData.refresh())
      case 'refresh-review':
        if (!emptyData || review.error === null) return false
        refreshReview()
        return true
      case 'retry-push-target':
        if (!emptyData || reviewPushTarget?.state !== 'error' || reviewPushTarget.key !== reviewPushKey || githubReview.kind !== 'found') return false
        setReviewPushAttempt((attempt) => attempt + 1)
        return true
      case 'revert-all':
        if (!emptyData || revertableRef.current.length === 0) return false
        return startReserved('revert-all', () => revertAll())
      case 'toggle-directory': {
        if (!only(['path']) || typeof data?.path !== 'string' || viewMode !== 'tree' || !directoryPaths.has(data.path)) return false
        toggleDir(data.path)
        return true
      }
      case 'row-open': {
        if (!only(['path']) || typeof data?.path !== 'string') return false
        const item = rowItemFor(data.path)
        if (!item || item.submodule !== undefined) return false
        openInReview(item.path)
        return true
      }
      case 'row-menu-open': {
        if (!only(['path', 'x', 'y']) || typeof data?.path !== 'string') return false
        const path = data.path
        if (rowItemFor(path) === undefined) return false
        const signature = rowSignature(path)
        const position = positionFor(data, () => rowMenuPosition(path))
        if (signature === null || position === null) return false
        selectPath(worktree, path, 'panel')
        setMenu({ owner: owner.generation, generation: newGitUiGeneration(), position, path, signature })
        return true
      }
      case 'row-open-file': {
        if (!only(['path']) || typeof data?.path !== 'string') return false
        const item = rowItemFor(data.path)
        if (!item || item.letter === 'D') return false
        openFile(item.path)
        return true
      }
      case 'row-revert': {
        if (!only(['path']) || typeof data?.path !== 'string' || rowItemFor(data.path) === undefined) return false
        const path = data.path
        return startReserved(`revert:${path}`, () => startRevert(path))
      }
      case 'row-toggle-mark': {
        if (!only(['path']) || typeof data?.path !== 'string') return false
        const path = data.path
        const file = shown.find((candidate) => candidate.path === path)
        if (!file || file.mark === undefined || file.conflict !== undefined || rowEntries(path).some((entry) => entry.conflict !== undefined)) return false
        return startReserved(`mark:${path}`, () => toggleMark(path))
      }
      case 'row-toggle-submodule': {
        if (!only(['path']) || typeof data?.path !== 'string') return false
        const item = rowItemFor(data.path)
        if (!item || item.submodule === undefined) return false
        selectPath(worktree, item.path, 'panel')
        toggleSubmodule(item)
        return true
      }
      case 'row-toggle-check': {
        if (!only(['path']) || typeof data?.path !== 'string' || ticks === null || !uncommittedPaths.includes(data.path)) return false
        const item = rowItemFor(data.path)
        if (!item || item.uncommitted !== true) return false
        toggleTick(data.path)
        return true
      }
      case 'cancel-selection':
        if (!emptyData || ticks === null) return false
        setTicks(null)
        return true
      case 'history-toggle': {
        if (!only(['open']) || status === null || filtering ||
            (data !== undefined && Object.hasOwn(data, 'open') && typeof data.open !== 'boolean')) return false
        if (data !== undefined && Object.hasOwn(data, 'open')) setHistoryOpen(data.open as boolean)
        else setHistoryOpen((previous) => !previous)
        return true
      }
      case 'history-open-commit': {
        if (!only(['commit']) || typeof data?.commit !== 'string' || !PUSH_TARGET_OID.test(data.commit) ||
            !historyOpen || status === null || filtering) return false
        return startReserved(`history:${data.commit}`, () => openHistoryCommit(data.commit as string))
      }
      case 'history-open-file': {
        if (!only(['commit', 'path']) || typeof data?.commit !== 'string' || !PUSH_TARGET_OID.test(data.commit) ||
            typeof data.path !== 'string' || data.path.trim() === '' || !historyOpen || status === null || filtering) return false
        return startReserved(`history-file:${data.commit}:${data.path}`, () => openHistoryFile(data.commit as string, data.path as string))
      }
      case 'ship-step': {
        if (!only(['kind', 'message']) || typeof data?.kind !== 'string' || step === null ||
            !step.enabled || data.kind !== step.kind ||
            (data !== undefined && Object.hasOwn(data, 'message') && typeof data.message !== 'string') ||
            (data !== undefined && Object.hasOwn(data, 'message') && !step.kind.startsWith('commit-'))) return false
        const messageOverride = data !== undefined && Object.hasOwn(data, 'message') ? data.message as string : undefined
        return startReserved('ship', () => runStep(step.kind, messageOverride))
      }
      case 'ship-menu-open': {
        if (!only(['x', 'y']) || !shipBarPossible || step === null) return false
        const position = positionFor(data, shipMenuPosition)
        if (position === null) return false
        setShipMenuAt({ owner: owner.generation, generation: newGitUiGeneration(), position })
        return true
      }
      case 'cancel-create-review':
        if (!emptyData || activeCreateIntent.current === null) return false
        cancelCreateReview()
        return true
      case 'review-conflicts':
        if (!emptyData || operation === 'none' || unresolved === 0) return false
        open({ mode: 'conflicts' })
        return true
      case 'continue-operation':
        if (!emptyData || operation === 'none' || unresolved !== 0 || busyLabel !== null) return false
        return startReserved('ship', () => remote('continue'))
      case 'abort-operation':
        if (!emptyData || (operation !== 'merge' && operation !== 'rebase') || busyLabel !== null) return false
        return startReserved('ship', () => abort())
      case 'stage-all':
        if (!emptyData || !capped || operation !== 'none' || busyLabel !== null) return false
        return startReserved('mutation:stage::all', () => stageScope('all'))
      case 'ai-fix': {
        if (!only(['action']) || !aiEnabled || aiFix.busy) return false
        let action: FixAction | undefined
        if (data !== undefined && Object.hasOwn(data, 'action')) {
          if (typeof data.action !== 'string' || !quickFixActions.includes(data.action as FixAction)) return false
          action = data.action as FixAction
        } else if (quickFixActions.length === 1) action = quickFixActions[0]
        if (action === undefined) return false
        return startReserved('ai', () => aiFix.start(action))
      }
      case 'ai-customize': {
        if (!only(['action']) || !aiEnabled || typeof data?.action !== 'string' || !isOfferedFixAction(data.action)) return false
        return openLaunchDialog(data.action)
      }
      case 'ai-settings':
        if (!emptyData || !headerVisible) return false
        return startReserved('ai-settings', () => openAiSettings())
      default:
        return false
    }
  }

  const handleWorktreeControl = (control: GitUiControl): boolean => {
    if (control.surface !== PANEL_ID || control.target !== `worktree:${worktree}` ||
        control.generation !== owner.generation || !isCurrentOwner(control.generation)) return false
    return handlePanelAction(control.action, control.data)
  }
  const handleHeaderMenuControl = (control: GitUiControl): boolean => {
    const session = headerMenuRef.current
    if (!session || !currentHeaderMenu(session) || control.generation !== session.generation ||
        control.target !== `header-menu:${worktree}`) return false
    if (control.action === 'close') {
      if (control.data !== undefined && Object.keys(control.data).length !== 0) return false
      setHeaderMenu(null)
      return true
    }
    if (!headerMenuActionNames.includes(control.action)) return false
    if (!handlePanelAction(control.action, control.data)) return false
    if (headerMenuRef.current === session) setHeaderMenu(null)
    return true
  }
  const handleRowMenuControl = (control: GitUiControl): boolean => {
    const session = rowMenuRef.current
    if (!session || !isCurrentRowMenu(session) || control.generation !== session.generation ||
        control.target !== `row-menu:${worktree}:${session.path}`) return false
    const data = control.data
    if (data !== undefined && Object.keys(data).length !== 0) return false
    if (control.action === 'close') {
      setMenu(null)
      return true
    }
    if (!rowMenuActionNames.includes(control.action)) return false
    const item = rowItemFor(session.path)
    if (!item) return false
    const path = item.path
    const rows = rowEntries(path)
    const stageable = actionPaths(rows, 'stage', actionContext)
    const unstageable = actionPaths(rows, 'unstage')
    switch (control.action) {
      case 'open-review':
        setMenu(null)
        openInReview(path)
        return true
      case 'open-file':
        if (item.letter === 'D') return false
        setMenu(null)
        openFile(path)
        return true
      case 'toggle-mark':
        if (item.mark === undefined || item.conflict !== undefined || rows.some((entry) => entry.conflict !== undefined)) return false
        return startReserved(`mark:${path}`, () => {
          setMenu(null)
          return toggleMark(path)
        })
      case 'revert':
        if (revertPlan(fileOf(path)!, entries, baseName).kind === 'blocked') return false
        return startReserved(`revert:${path}`, () => {
          setMenu(null)
          return startRevert(path)
        })
      case 'stage':
        if (stageable.length === 0) return false
        return startReserved(`mutation:stage:${path}:`, () => {
          setMenu(null)
          return stagePaths(stageable, false, [path])
        })
      case 'unstage':
        if (unstageable.length === 0 || stageable.length > 0) return false
        return startReserved(`mutation:unstage:${path}:`, () => {
          setMenu(null)
          return unstagePaths(unstageable, false, [path])
        })
      case 'copy-path':
      case 'copy-relative-path':
        return startReserved(`copy:${path}:${control.action}`, () => {
          setMenu(null)
          return copy(path, control.action === 'copy-relative-path')
        })
      case 'reveal':
        return startReserved(`reveal:${path}`, () => {
          setMenu(null)
          return reveal(path)
        })
      default:
        return false
    }
  }
  const handleShipMenuControl = (control: GitUiControl): boolean => {
    const session = shipMenuRef.current
    if (!session || !currentShipMenu(session) || control.generation !== session.generation ||
        control.target !== `ship-menu:${worktree}`) return false
    if (control.action === 'close') {
      if (control.data !== undefined && Object.keys(control.data).length !== 0) return false
      setShipMenuAt(null)
      return true
    }
    if (control.action !== 'choose' || control.data === undefined ||
        Object.keys(control.data).some((key) => key !== 'id') || typeof control.data.id !== 'string') return false
    const item = shipItems.find((candidate) => candidate.id === control.data!.id)
    if (!item?.enabled) return false
    return startReserved('ship', () => {
      setShipMenuAt(null)
      shipCaretShown?.focus()
      return runMenu(item.id)
    })
  }
  const handleDialogControl = (control: GitUiControl): boolean => {
    const session = dialogRef.current
    if (!session || session.generation !== control.generation || session.owner !== owner.generation ||
        !isCurrentOwner(session.owner)) return false
    if (control.data !== undefined && Object.keys(control.data).length !== 0) return false
    if (session.kind === 'confirm') {
      if (control.action === 'confirm') {
        if (!session.validate()) return false
        return settleDialog(session, true)
      }
      if (control.action === 'cancel') return settleDialog(session, false)
      return false
    }
    if (session.kind === 'base') {
      if (control.action !== 'close') return false
      return settleDialog(session, false)
    }
    if (control.action === 'close') return settleDialog(session, false)
    if (control.action !== 'fix' || !aiEnabled || aiFix.busy || reservationsRef.current.has('ai')) return false
    return startReserved('ai', () => {
      if (!settleDialog(session, false)) throw new Error(controlUnavailable)
      return aiFix.start(session.fix)
    })
  }
  const handleLaunchControl = (control: GitUiControl): boolean => {
    const session = launchRef.current
    if (!session || session.generation !== control.generation || session.owner !== owner.generation ||
        !isCurrentOwner(session.owner) || control.action !== 'close' ||
        (control.data !== undefined && Object.keys(control.data).length !== 0)) return false
    setLaunch(null)
    return true
  }
  const handleShipErrorControl = (control: GitUiControl): boolean => {
    const failure = shipErrorRef.current
    if (failure === null || failure !== currentShipError || failure.identity !== control.generation ||
        failure.owner !== owner.generation || !isCurrentOwner(failure.owner) ||
        control.target !== `ship-error:${worktree}` ||
        (control.data !== undefined && Object.keys(control.data).length !== 0)) return false
    if (control.action === 'ship-error-dismiss') {
      setShipError(null)
      return true
    }
    if (control.action !== 'ship-error-action' || busyLabel !== null) return false
    if (failure.pull) return startReserved('ship', () => runMenu('pull'))
    if (failure.fetch) return startReserved('ship', () => runMenu('fetch'))
    if (failure.details !== undefined) {
      setDialog({
        kind: 'details',
        owner: owner.generation,
        generation: newGitUiGeneration(),
        title: failure.details.title,
        output: failure.details.output,
        fix: failure.fix ?? (failure.details.title === 'Commit Failed' ? 'fixCommitFailure' : 'fixPushFailure')
      })
      return true
    }
    if (failure.retry !== undefined) {
      failure.retry()
      return true
    }
    return false
  }
  useGitUiControl(context, mainAddress, handleWorktreeControl)
  useGitUiControl(context, headerAddress, handleHeaderMenuControl)
  useGitUiControl(context, rowAddress, handleRowMenuControl)
  useGitUiControl(context, shipMenuAddress, handleShipMenuControl)
  useGitUiControl(context, dialogAddress, handleDialogControl)
  useGitUiControl(context, launchAddress, handleLaunchControl)
  useGitUiControl(context, shipErrorAddress, handleShipErrorControl)
  const areaSections = AREA_ORDER.map((area) => ({
    id: area,
    count: entries.filter((entry) => entry.area === area && (query === '' || matchesFilter(entry.path, query))).length
  })).filter((section) => section.count > 0)
  const committedOnly = visibleFiles.filter((file) => !file.uncommitted).length
  const busy = status?.busy ?? null
  const reportJson = JSON.stringify({
    worktree,
    branch: status?.branch ?? null,
    base: compare?.base ?? null,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    operation,
    busy,
    capped,
    sections: tooLarge ? [] : [...areaSections, ...(committedOnly > 0 ? [{ id: 'branch', count: committedOnly }] : [])],
    primary: status === null || step === null ? null : { label: step.label, enabled: step.enabled, title: step.reason ?? '' },
    selection: selected === null ? [] : [selected],
    filter,
    viewMode,
    historyOpen
  })
  useEffect(() => {
    report(JSON.parse(reportJson) as ScmReport)
  }, [reportJson, report])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && ticks !== null) {
      event.preventDefault()
      postMainControl('cancel-selection')
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && step?.kind.startsWith('commit') && step.enabled) {
      event.preventDefault()
      postMainControl('ship-step', { kind: step.kind })
    }
  }

  const compareMessage = compareData.error === null && compare !== null && compare.status !== 'ready'
    ? (compare.message ?? 'Branch compare is unavailable.')
    : null
  const nothingUncommitted = status !== null && entries.length === 0
  const clean = status !== null && model !== null && step === null
  const baseShown = compare !== null && compare.base === null ? null : model?.base.name ?? compare?.base ?? null
  const cleanUpstream = status !== null && status.upstreamStatus.hasUpstream
    ? status.upstreamStatus.name ?? status.upstream
    : null
  const cleanMessage = `Nothing changed against ${baseShown ?? 'the base'}${cleanUpstream === null ? '' : ` · up to date with ${cleanUpstream}`}`
  const branchName = model?.branch ?? status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch')
  const loading = (status === null && data.error === null) || (model === null && review.error === null)
  const marks = model === null ? 0 : model.counts.reviewed + model.counts.changed
  const baseSession = dialog?.kind === 'base' ? dialog : null
  function startLaunch(session: LaunchSession, params: Parameters<typeof aiFix.start>[1]): Promise<string | null> {
    if (launchRef.current !== session || !isCurrentOwner(session.owner)) return Promise.resolve(controlUnavailable)
    return aiFix.start(session.action, params)
  }
  async function onBaseChanged(): Promise<void> {
    if (baseSession === null || dialogRef.current !== baseSession || !isCurrentOwner(baseSession.owner)) return
    await refreshAll()
    if (dialogRef.current === baseSession && isCurrentOwner(baseSession.owner)) refreshReview()
  }
  const errorView: ShipErrorView | null = currentShipError === null ? null : {
    message: currentShipError.message,
    ...(currentShipError.pull
      ? { action: { label: 'Pull first', onAction: () => postShipErrorControl('ship-error-action') } }
      : currentShipError.fetch
        ? { action: { label: 'Fetch first', onAction: () => postShipErrorControl('ship-error-action') } }
        : currentShipError.details
          ? { action: { label: 'Details', onAction: () => postShipErrorControl('ship-error-action') } }
          : currentShipError.retry
            ? { action: { label: 'Retry', onAction: () => postShipErrorControl('ship-error-action') } }
            : {}),
    ...(currentShipError.fix !== undefined && fixFor(currentShipError.fix) ? { extra: <FixSplitButton {...fixFor(currentShipError.fix)!} /> } : {})
  }

  if (data.unavailable !== null) {
    return (
      <div className="ui-stack" data-git-panel ref={root} onKeyDown={onKeyDown} style={{ height: '100%', minHeight: 0, gap: 0 }}>
        <EmptyState message={data.unavailable} action={{ label: 'Retry', onAction: () => postMainControl('refresh-status') }} />
      </div>
    )
  }

  return (
    <div className="ui-stack" data-git-panel ref={root} onKeyDown={onKeyDown} style={{ height: '100%', minHeight: 0, gap: 0 }}>
      <Header
        filter={filter}
        filterOpen={filterOpen}
        onFilterControl={onFilterControl}
        onFilter={setFilter}
        viewMode={viewMode}
        menuGeneration={headerMenu?.generation ?? null}
        menuPosition={headerMenu?.position ?? null}
        onMenuOpen={onMenuOpen}
        onMenuClose={postHeaderMenuClose}
        onMenuAction={onMenuAction}
        summarize={aiEnabled}
        prActions={currentPrActions}
        aiSettings
        revertable={revertable.length}
      />
      {status && (
        <BranchRow branch={branchName} base={baseShown} totals={model?.totals ?? null} onChangeBase={() => postMainControl('change-base')} />
      )}
      {model !== null && model.counts.files > 0 && <CountLine counts={model.counts} />}
      {(data.error !== null || review.error !== null || compareData.error !== null) && (
        <div className="ui-stack">
          {data.error !== null && (
            <InlineError message={data.error} action={{ label: 'Retry', onAction: () => postMainControl('refresh-status') }} />
          )}
          {review.error !== null && (
            <InlineError message={review.error} action={{ label: 'Retry', onAction: () => postMainControl('refresh-review') }} />
          )}
          {compareData.error !== null && (
            <InlineError message={compareData.error} action={{ label: 'Retry', onAction: () => postMainControl('refresh-compare') }} />
          )}
        </div>
      )}
      <div className="ui-stack" data-git-content style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {loading && <div role="status"><NoticeLine>Loading…</NoticeLine></div>}
        {status?.capped && (
          <HugeBanner onStageAll={() => postMainControl('stage-all')} onRetry={retryCappedStatus} />
        )}
        {tooLarge && (
          <div className="ui-stack">
            <InlineError message="Search text is too large" />
            <p className="ui-text-muted">Use a shorter file filter.</p>
          </div>
        )}
        {visibleFiles.length > 0 && (
          <ReviewList
            label="Changed files"
            files={visibleFiles}
            viewMode={viewMode}
            collapsed={collapsedDirs}
            onToggleDir={(path) => postMainControl('toggle-directory', { path })}
            selected={selected}
            handlers={handlers}
            onKeyDown={onListKeyDown}
          />
        )}
        {filtering && !tooLarge && model !== null && visibleFiles.length === 0 && <EmptyState message="No files match the filter." />}
        {status && compareMessage !== null && !tooLarge && (
          <CompareUnavailable
            message={compareMessage}
            standalone={nothingUncommitted}
            onChangeBase={() => postMainControl('change-base')}
            onRetry={() => postMainControl('refresh-compare')}
          />
        )}
        {clean && !filtering && (
          <div role="status" data-git-clean>
            <EmptyState message={cleanMessage} />
          </div>
        )}
        {status && !filtering && (
          <HistoryDock
            context={context}
            worktree={worktree}
            open={historyOpen}
            onToggle={() => postMainControl('history-toggle', { open: !historyOpen })}
            head={status.head}
            onOpenCommit={openCommit}
            onOpenFile={openCommitFile}
          />
        )}
      </div>
      <div className="ui-stack" data-git-ship>
        {status && operation !== 'none' && (
          <>
            {errorView && <ShipErrorLine error={errorView} onDismiss={() => postShipErrorControl('ship-error-dismiss')} />}
            <OperationCard
              operation={operation}
              unresolved={unresolved}
              busy={busy !== null}
              onReview={() => postMainControl('review-conflicts')}
              onContinue={() => postMainControl('continue-operation')}
              onAbort={() => postMainControl('abort-operation')}
              fix={fixFor('resolveConflicts')}
            />
          </>
        )}
        {status && operation === 'none' && step !== null && (
          <ShipBar
            context={context}
            worktree={worktree}
            step={step}
            busy={busyLabel !== null}
            onStep={() => postMainControl('ship-step', { kind: step.kind })}
            menuOpen={shipMenuAt !== null}
            onOpenMenu={(position) => postMainControl('ship-menu-open', position)}
            showMessage={uncommittedPaths.length > 0}
            message={message}
            onMessage={(text) => {
              setWrittenBy(null)
              setMessage(text)
            }}
            messageRef={messageRef}
            locked={committing}
            sparkle={
              aiEnabled ? (
                <CommitSparkle
                  context={context}
                  worktree={worktree}
                  scope={stagedCount > 0 ? 'staged' : 'all'}
                  files={uncommittedPaths.length}
                  message={message}
                  committing={committing}
                  edits={edits}
                  onResult={(text, agent) => {
                    if (!isCurrentOwner(owner.generation)) return
                    setMessage(text)
                    setWrittenBy(agent)
                  }}
                  onError={(text) => failWith({ message: text })}
                  onGenerateStart={dropEmptyMessageError}
                />
              ) : undefined
            }
            writtenBy={writtenBy}
            error={errorView}
            onDismissError={() => postShipErrorControl('ship-error-dismiss')}
            selecting={ticks !== null}
            aside={
              <>
                {githubReview.kind === 'found' && reviewPushTarget?.key === reviewPushKey && (
                  reviewPushTarget.state === 'loading' ? (
                    <div role="status" data-git-push-target>
                      <NoticeLine>Checking the configured push destination for this pull request…</NoticeLine>
                    </div>
                  ) : reviewPushTarget.state === 'error' ? (
                    <div data-git-push-target>
                      <InlineError
                        message={reviewPushTarget.message}
                        action={{ label: 'Retry', onAction: () => postMainControl('retry-push-target') }}
                      />
                    </div>
                  ) : reviewPushTarget.state === 'unavailable' ? (
                    <p role="status" data-git-push-target>{reviewPushTarget.message}</p>
                  ) : (
                    <p role="status" data-git-push-target>
                      <strong>{reviewPushTarget.target.fork ? 'Fork destination' : 'Push destination'}:</strong>{' '}
                      <code>{reviewPushTarget.target.remote}/{reviewPushTarget.target.branch}</code>
                      {' · '}{reviewPushTarget.target.repository.host}/{reviewPushTarget.target.repository.owner}/{reviewPushTarget.target.repository.repo}
                    </p>
                  )
                )}
                {creatingReview && <Button onClick={() => postMainControl('cancel-create-review')}>Cancel remaining steps</Button>}
              </>
            }
          />
        )}
      </div>
      {menu !== null && isCurrentRowMenu(menu) && (
        <ContextMenu
          key={menu.generation}
          x={menu.position.x}
          y={menu.position.y}
          label={`Actions for ${splitPath(menu.path).name}`}
          items={menuEntries(menu)}
          onClose={() => postRowMenuClose(menu)}
        />
      )}
      {shipMenuAt !== null && shipBarPossible && (
        <ContextMenu
          key={shipMenuAt.generation}
          x={shipMenuAt.position.x}
          y={shipMenuAt.position.y}
          align="end"
          label={CARET_LABEL}
          items={shipMenuEntries(shipItems, (id) => postMenuChoice(
            shipMenuChoice,
            `ship-menu:${worktree}`,
            shipMenuAt,
            'choose',
            { id },
            () => currentShipMenu(shipMenuAt)
          ))}
          returnFocusTo={shipCaretShown ?? undefined}
          onClose={() => postShipMenuClose(shipMenuAt)}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          key={dialog.generation}
          title={dialog.title}
          body={dialog.body}
          confirm={dialog.confirm}
          danger={dialog.danger}
          onConfirm={() => postDialogAction(dialog, 'confirm')}
          onCancel={() => postDialogAction(dialog, 'cancel')}
        />
      )}
      {dialog?.kind === 'details' && (
        <Dialog
          key={dialog.generation}
          open
          title={dialog.title}
          onClose={() => postDialogAction(dialog, 'close')}
          actions={
            <div className="ui-cluster" style={{ justifyContent: 'flex-end' }}>
              {aiEnabled && (
                <Button
                  variant="primary"
                  disabled={aiFix.busy}
                  onClick={() => postDialogAction(dialog, 'fix')}
                >
                  Fix with AI
                </Button>
              )}
              <Button onClick={() => postDialogAction(dialog, 'close')}>Close</Button>
            </div>
          }
        >
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{dialog.output}</pre>
        </Dialog>
      )}
      {launch !== null && aiEnabled && (
        <LaunchDialog
          key={launch.generation}
          context={context}
          worktree={worktree}
          action={launch.action}
          onClose={() => postLaunchClose(launch)}
          start={(params) => startLaunch(launch, params)}
        />
      )}
      {baseSession !== null && (
        <ChangeBaseDialog
          key={baseSession.generation}
          context={context}
          worktree={worktree}
          current={baseShown}
          marks={marks}
          onClose={() => postDialogAction(baseSession, 'close')}
          onChanged={onBaseChanged}
        />
      )}
    </div>
  )
}
