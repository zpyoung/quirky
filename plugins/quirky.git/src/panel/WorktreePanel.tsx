import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ContextMenu, Dialog, EmptyState } from '@quirky/ui'
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
import { CleanState, CompareUnavailable, HugeBanner, OperationCard } from './Cards'
import { ChangeBaseDialog } from './ChangeBaseDialog'
import { PR_AI_ACTIONS, readGitHubReview, useGitHubReview } from './GitHubReview'
import { useCompare, useSettings, useStatus, useWorktreePath } from './data'
import { ConfirmDialog } from './Dialog'
import { applyFilter, matchesFilter } from './filter'
import { dataOf, hasMoreDetail, messageOf, reasonOf, splitPath, splitQuestion } from './format'
import { BranchRow, CountLine, Header } from './Header'
import { HistoryDock } from './HistoryDock'
import { shouldForcePushWithLease } from './ladder'
import { displayOrder, ReviewList } from './list'
import type { Notice } from './Notices'
import { registerPanel } from './registry'
import { errorLineFor, type RemoteAction } from './remote-messages'
import { applyRevert, revertInOrder, revertPlan, shownHash, type Revertable } from './revert'
import type { Expansion, RowButton, RowHandlers, RowItem } from './Rows'
import { openHostedDiff } from '../view/hosted-tabs'
import { isRecord } from '../daemon/validation'
import type { PushTargetResult } from '../daemon/push-target'
import { ShipBar, ShipErrorLine, type ShipErrorView } from './ShipBar'
import { isBaseBranch, nextStep, shipMenu, type ShipMenuId, type ShipState } from './ship'
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
  message: string
  retry?: () => void
  pull?: boolean
  fetch?: boolean
  details?: { title: 'Commit Failed' | 'Push Failed'; output: string }
  fix?: 'fixCommitFailure' | 'fixPushFailure'
  /** The line asks for a commit message, so typing one or starting ✦ takes it away. */
  emptyMessage?: true
}
type PushTargetPurpose = 'review' | 'creation'
type ReviewPushTarget =
  | { key: string; state: 'loading' }
  | { key: string; state: 'unavailable'; message: string }
  | {
      key: string
      state: 'ready'
      remote: string
      branch: string
      fork: boolean
      repository: { host: string; owner: string; repo: string }
    }
type ForceConfirmation = { purpose?: PushTargetPurpose; expected?: string }
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


type DialogState =
  | { kind: 'confirm'; title: string; body: string; confirm: string; danger: boolean; resolve(ok: boolean): void }
  | { kind: 'details'; title: 'Commit Failed' | 'Push Failed'; output: string }
  | { kind: 'base' }

type MutationVerb = 'stage' | 'unstage'

type Mutation = {
  method: 'quirky.git/stage' | 'quirky.git/unstage'
  params: Record<string, unknown>
  verb: MutationVerb
  /** The paths involved, for the failure notice. */
  paths: string[]
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
  const status = useMemo<GitStatus | null>(() => (polled === null ? null : { ...polled, busy: polled.busy ?? localBusy }), [polled, localBusy])
  const githubReview = useGitHubReview(context, worktree, status)
  const [reviewPushTarget, setReviewPushTarget] = useState<ReviewPushTarget | null>(null)
  const reviewPushKey = githubReview.kind === 'found'
    ? `${githubReview.target.worktree}\\0${githubReview.target.branch}\\0${githubReview.target.head}\\0${githubReview.review.number}\\0${githubReview.review.state}`
    : null
  useEffect(() => {
    if (githubReview.kind !== 'found' || reviewPushKey === null) {
      setReviewPushTarget(null)
      return
    }
    let alive = true
    setReviewPushTarget({ key: reviewPushKey, state: 'loading' })
    void context.call('quirky.git/pushTarget', { worktree, purpose: 'review' }).then((raw: unknown) => {
      if (!alive) return
      const target = pushTargetResult(raw)
      if (target && target.ready === true) {
        setReviewPushTarget({
          key: reviewPushKey,
          state: 'ready',
          remote: target.remote,
          branch: target.branch,
          fork: target.fork,
          repository: target.repository
        })
      } else {
        setReviewPushTarget({
          key: reviewPushKey,
          state: 'unavailable',
          message: target?.ready === false ? target.message : 'The linked pull-request push target is unavailable.'
        })
      }
    }).catch((error: unknown) => {
      if (alive) setReviewPushTarget({ key: reviewPushKey, state: 'unavailable', message: messageOf(error) })
    })
    return () => {
      alive = false
    }
  }, [context, worktree, reviewPushKey])
  const compareTrigger = `${polled?.head ?? ''}|${polled?.upstreamStatus.sha ?? ''}|${settings.compareBase}`
  const compareData = useCompare(context, worktree, compareTrigger, polled !== null)
  const { compare } = compareData
  const worktreePath = useWorktreePath(context, worktree)
  const review = useReview(context, worktree)
  const model = review.model
  const files = useMemo(() => model?.files ?? NO_FILES, [model])
  const refreshReview = () => {
    try {
      review.refresh()
    } catch {
      // the plugin can be deactivated while an action is still settling
    }
  }

  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => selectedPath(worktree))
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(NO_DIRS)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [message, setMessageState] = useState(() => drafts.get(worktree))
  const [committing, setCommitting] = useState(false)
  const edits = useRef(0)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const [writtenBy, setWrittenBy] = useState<string | null>(null)
  const [ticks, setTicks] = useState<ReadonlySet<string> | null>(null)
  const aiFix = useAiFix(context, worktree)
  const [shipError, setShipError] = useState<ShipFailure | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [focusRecovery, setFocusRecovery] = useState<{ revision: number; opener: Element | null }>({ revision: 0, opener: null })
  const baseDialogWasOpen = useRef(false)
  const [launch, setLaunch] = useState<FixAction | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; item: RowItem } | null>(null)
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

  const dropEmptyMessageError = () => setShipError((prev) => (prev?.emptyMessage ? null : prev))

  const setMessage = (text: string) => {
    edits.current += 1
    setMessageState(text)
    drafts.set(worktree, text)
    if (text.trim() !== '') dropEmptyMessageError()
  }

  const refreshAll = useCallback(async () => {
    await Promise.all([data.refresh(), compareData.refresh()])
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
  const requestFocusRecovery = useCallback((opener: Element | null = null) => {
    setFocusRecovery((request) => ({ revision: request.revision + 1, opener }))
  }, [])
  useEffect(() => {
    if (focusRecovery.revision > 0) recoverPanelFocus(focusRecovery.opener)
  }, [focusRecovery, recoverPanelFocus])
  useEffect(() => {
    const baseDialogOpen = dialog?.kind === 'base'
    if (baseDialogWasOpen.current && dialog === null) focusPanel()
    baseDialogWasOpen.current = baseDialogOpen
  }, [dialog, focusPanel])

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
    offered.add(worktree)
    context
      .call('quirky.git/hugeFolders', { worktree })
      .then((result) => {
        const folder = (result as { folders: string[] }).folders[0]
        if (folder === undefined) return
        notify({
          id: `huge-folder:${worktree}`,
          worktree,
          title: `This repository has too many active changes. Add "${folder}" to .gitignore?`,
          actions: [
            {
              label: 'Add to .gitignore',
              run: () => {
                context
                  .call('quirky.git/ignoreFolder', { worktree, folder })
                  .then(() => refreshAll())
                  .catch((e: unknown) => context.toast('Could not update .gitignore', messageOf(e)))
              }
            }
          ]
        })
      })
      .catch(() => {})
  }, [capped, worktree, context, offered, notify, refreshAll])

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
  const fixFor = (action: FixButtonProps['action']): FixButtonProps | undefined =>
    aiEnabled ? { action, busy: aiFix.busy, onFix: () => void aiFix.start(action), onCustomize: () => setLaunch(action) } : undefined

  useEffect(() => {
    if (ticks !== null && uncommittedPaths.length === 0) setTicks(null)
  }, [ticks, uncommittedPaths.length])

  const open = (input: Omit<DiffViewInput, 'worktree'>) => {
    void openHostedDiff(context, { worktree, ...input }).catch((error: unknown) =>
      context.toast('Could not open diff', messageOf(error))
    )
  }

  const toggleSubmodule = (item: RowItem) => {
    const signature = JSON.stringify(item.submodule)
    const current = submodules[item.path]
    setSubmodules((prev) => ({ ...prev, [item.path]: { ...(prev[item.path] ?? { entries: null, signature, failed: false }), open: !current?.open } }))
    if (current?.open || (current?.entries && current.signature === signature)) return
    context
      .call('quirky.git/submoduleStatus', { worktree, path: item.path })
      .then((result) => {
        const entries = (result as { entries: GitStatusEntry[] }).entries
        setSubmodules((prev) => ({ ...prev, [item.path]: { open: prev[item.path]?.open ?? true, entries, signature, failed: false } }))
      })
      .catch(() => setSubmodules((prev) => ({ ...prev, [item.path]: { open: prev[item.path]?.open ?? true, entries: null, signature, failed: true } })))
  }

  const ask = (spec: { title: string; body: string; confirm: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', danger: false, ...spec, resolve }))

  const runMutation = async (mutation: Mutation): Promise<boolean> => {
    try {
      await context.call(mutation.method, { worktree, ...mutation.params })
      return true
    } catch (e) {
      notifyMutationFailure(mutation, e)
      return false
    } finally {
      await refreshAll()
      refreshReview()
    }
  }

  const retryNotice = (run: () => void) => ({ label: 'Retry', run, expiresMs: RETRY_MS })

  const notifyMutationFailure = (mutation: Mutation, error: unknown) => {
    const retry = retryNotice(() => void runMutation(mutation))
    if (!mutation.bulk) {
      const path = mutation.paths[0] ?? ''
      notify({ id: 'source-control-entry-mutation', worktree, title: `Failed to ${mutation.verb} “${path}”`, body: messageOf(error), actions: [retry] })
      return
    }
    notify({ id: 'source-control-bulk', worktree, title: `Bulk ${mutation.verb} failed`, body: messageOf(error), actions: [retry] })
  }

  const stagePaths = (paths: string[], bulk: boolean) =>
    runMutation({ method: 'quirky.git/stage', params: { paths }, verb: 'stage', paths, bulk })
  const unstagePaths = (paths: string[], bulk: boolean) =>
    runMutation({ method: 'quirky.git/unstage', params: { paths }, verb: 'unstage', paths, bulk })
  const stageScope = (scope: 'all' | 'tracked') =>
    runMutation({ method: 'quirky.git/stage', params: { scope }, verb: 'stage', paths: [], bulk: true })

  const fileOf = (path: string): ReviewFile | undefined => files.find((file) => file.path === path)
  const rowEntries = (path: string): GitStatusEntry[] => entries.filter((entry) => entry.path === path)
  const baseName = model?.base.name ?? compare?.base ?? 'the base'

  const openInReview = (path: string) => {
    selectPath(worktree, path, 'panel')
    if (fileOf(path)?.conflict !== undefined || rowEntries(path).some((entry) => entry.conflict !== undefined)) {
      return open({ mode: 'conflict-file', path })
    }
    void openReview(context, { worktree, reveal: path }).catch((error: unknown) => context.toast('Could not open diff', messageOf(error)))
  }

  const openFile = (path: string) => {
    void context
      .call('quirky.editor/open', { worktree, path, focus: true })
      .catch((error: unknown) => context.toast('Could not open file', messageOf(error)))
  }

  const toggleMark = async (path: string) => {
    const file = fileOf(path)
    if (!file) return
    const reviewed = file.mark !== 'reviewed'
    try {
      const expected = reviewed ? await shownHash(context, worktree, path) : undefined
      const result = await setReviewMark(context, { worktree, path, reviewed, ...(expected !== undefined && { expected }) })
      refreshReview()
      if (result === 'ok' && reviewed) {
        const next = advanceAfterMark(files, viewMode, path)
        if (next !== null) selectPath(worktree, next, 'panel')
      }
    } catch (error) {
      notify({
        id: 'source-control-entry-mutation',
        worktree,
        title: `Failed to ${reviewed ? 'mark' : 'unmark'} “${path}”${reviewed ? ' reviewed' : ''}`,
        body: messageOf(error),
        actions: [retryNotice(() => void toggleMark(path))]
      })
    }
  }

  const failureText = (error: unknown): string => {
    const failures = dataOf(error).failures
    const first = Array.isArray(failures) ? (failures[0] as { message?: unknown } | undefined)?.message : undefined
    return typeof first === 'string' && first !== '' ? first : messageOf(error)
  }

  const runRevert = async (path: string, plan: Revertable): Promise<void> => {
    try {
      await applyRevert(context, worktree, plan)
    } catch (error) {
      notify({
        id: 'source-control-entry-mutation',
        worktree,
        title: `Failed to revert “${path}”`,
        body: failureText(error),
        actions: [retryNotice(() => void runRevert(path, plan))]
      })
    } finally {
      await refreshAll()
      refreshReview()
    }
  }

  const startRevert = async (path: string) => {
    const file = fileOf(path)
    if (!file) return
    const plan = revertPlan(file, entries, baseName)
    if (plan.kind === 'blocked') {
      context.toast(`Can’t revert “${splitPath(path).name}”`, plan.reason)
      return
    }
    const active = document.activeElement
    const opener = active instanceof HTMLElement && active.closest('.git-row__actions') !== null ? active : null
    if (!(await ask({ ...plan.text, danger: true }))) return
    requestFocusRecovery(opener)
    await runRevert(path, plan)
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

  const runRevertBatch = async (batch: typeof revertable, total: number): Promise<void> => {
    const { done, failure } = await revertInOrder(
      batch.map(({ file, plan }) => ({ path: file.path, run: () => applyRevert(context, worktree, plan) }))
    )
    await refreshAll()
    refreshReview()
    if (failure === null) return
    const left = batch.length - done
    notify({
      id: 'source-control-bulk',
      worktree,
      title: `Revert all stopped at “${failure.path}”`,
      body: `${failure.message.replace(/\.$/u, '')}. ${left} of ${total} ${total === 1 ? 'file' : 'files'} left.`,
      actions: [retryNotice(() => void runRevertBatch(batch.slice(done), total))]
    })
  }

  const revertAll = async () => {
    const batch = revertable
    if (batch.length === 0) return
    const n = batch.length
    const skipped = unrevertable
    const skippedNote =
      skipped.length === 0 ? '' : ` ${skipped.length} ${skipped.length === 1 ? 'file' : 'files'} can’t be reverted here and will be listed afterwards.`
    const ok = await ask({
      title: `Revert all ${n} ${n === 1 ? 'file' : 'files'}?`,
      body: `Every file in the list goes back to its version on ${baseName}: uncommitted changes are discarded and new files are deleted. It stops at the first file that fails. This cannot be undone.${skippedNote}`,
      confirm: 'Revert all',
      danger: true
    })
    if (!ok) return
    requestFocusRecovery()
    await runRevertBatch(batch, n)
    if (skipped.length > 0) {
      context.toast(
        `Revert all left ${skipped.length} ${skipped.length === 1 ? 'file' : 'files'} unchanged`,
        skipped.map(({ path, reason }) => `${path}: ${reason}`).join('\n')
      )
    }
  }

  const absolute = (path: string): string => (worktreePath === null ? path : `${worktreePath.replace(/\/$/, '')}/${path}`)

  const rowButtons = (item: RowItem): RowButton[] => {
    const buttons: RowButton[] = [{ label: 'Revert', glyph: '↶', destructive: true, run: () => void startRevert(item.path) }]
    if (item.letter !== 'D') buttons.push({ label: 'Open', glyph: '↗', run: () => openFile(item.path) })
    return buttons
  }

  const handlers: RowHandlers = {
    click: (item) => {
      if (item.submodule) {
        selectPath(worktree, item.path, 'panel')
        return toggleSubmodule(item)
      }
      openInReview(item.path)
    },
    contextMenu: (item, x, y) => {
      selectPath(worktree, item.path, 'panel')
      setMenu({ x, y, item })
    },
    buttons: rowButtons,
    dragText: (item) => absolute(item.path),
    expansion: (item): Expansion | null => {
      if (!item.submodule) return null
      const state = submodules[item.path]
      return { open: state?.open ?? false, entries: state?.entries ?? null, failed: state?.failed ?? false }
    },
    toggleExpansion: toggleSubmodule,
    check: (item) => (ticks === null || item.uncommitted !== true ? null : ticks.has(item.path)),
    toggleCheck: (item) => toggleTick(item.path)
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (e) {
      context.toast('Could not copy', messageOf(e))
    }
  }

  const menuEntries = (item: RowItem): ContextMenuItem[] => {
    const file = fileOf(item.path)
    const rows = rowEntries(item.path)
    const stageable = actionPaths(rows, 'stage', actionContext)
    const unstageable = actionPaths(rows, 'unstage')
    const unstaging = stageable.length === 0 && unstageable.length > 0
    const plan = file ? revertPlan(file, entries, baseName) : null
    return [
      { label: 'Open in Review', onSelect: () => openInReview(item.path) },
      { label: 'Open file', enabled: item.letter !== 'D', onSelect: () => openFile(item.path) },
      { label: item.mark === 'reviewed' ? 'Unmark' : 'Mark reviewed', enabled: item.conflict === undefined, onSelect: () => void toggleMark(item.path) },
      {
        label: 'Revert file…',
        enabled: plan !== null && plan.kind !== 'blocked',
        title: plan?.kind === 'blocked' ? plan.reason : undefined,
        onSelect: () => void startRevert(item.path)
      },
      {
        label: unstaging ? 'Unstage' : 'Stage',
        enabled: unstaging ? true : stageable.length > 0,
        title: unstaging || stageable.length > 0 ? undefined : item.submodule ? 'Stage inside the submodule' : 'Nothing to stage',
        onSelect: () => void (unstaging ? unstagePaths(unstageable, false) : stagePaths(stageable, false))
      },
      { label: 'Copy path', separatorBefore: true, onSelect: () => void copy(absolute(item.path)) },
      { label: 'Copy relative path', onSelect: () => void copy(item.path) },
      {
        label: 'Reveal in Finder',
        onSelect: () => {
          context.call('quirky.git/reveal', { worktree, path: item.path }).catch((e: unknown) => context.toast('Could not reveal', messageOf(e)))
        }
      }
    ]
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const onButton = (event.target as HTMLElement).closest('button') !== null
    if (onButton && event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return
    if (ticks !== null && event.key === 'Escape') return
    if (ticks !== null && event.key === ' ' && selected !== null && uncommittedPaths.includes(selected)) {
      event.preventDefault()
      return toggleTick(selected)
    }
    const intent = keyIntent(shown, selected, event.key)
    if (intent === null) return
    event.preventDefault()
    switch (intent.type) {
      case 'select':
        return selectPath(worktree, intent.path, 'panel')
      case 'open':
        return openInReview(intent.path)
      case 'toggle-mark':
        return void toggleMark(intent.path)
      case 'revert':
        return void startRevert(intent.path)
    }
  }

  const toggleTick = (path: string) =>
    setTicks((prev) => {
      if (prev === null) return prev
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const toggleDir = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const failWith = (failure: ShipFailure) => setShipError(failure)

  const remote = async (
    action: RemoteAction,
    params: Record<string, unknown> = {},
    requestedPurpose?: PushTargetPurpose
  ): Promise<boolean> => {
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
          retry: () => void remote(action, params, requestedPurpose)
        })
        return false
      }
      if (action === 'sync' && purpose === 'review') {
        failWith({ message: 'Sync cannot safely choose a linked pull-request destination. Pull or push to the validated PR target separately.' })
        return false
      }
    }
    setShipError(null)
    setLocalBusy(action)
    try {
      await context.call(REMOTE_METHODS[action], { worktree, ...params, ...(purpose === undefined ? {} : { purpose }) })
      return true
    } catch (e) {
      const reason = reasonOf(e)
      const text = messageOf(e)
      const data = dataOf(e)
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
          ...(line?.next === 'retry' ? { retry: () => void remote(action, params, requestedPurpose) } : {})
        })
      }
      if (action === 'push' && reason === 'non-fast-forward') await context.call('quirky.git/fetch', { worktree }).catch(() => {})
      return false
    } finally {
      setLocalBusy(null)
      await refreshAll()
    }
  }

  const confirmForcePush = async (): Promise<ForceConfirmation | null> => {
    if (githubReview.kind === 'found') {
      let target: PushTargetResult | undefined
      try {
        target = pushTargetResult(await context.call('quirky.git/pushTarget', { worktree, purpose: 'review' }))
      } catch (error) {
        failWith({ message: `Force push failed: ${messageOf(error)}` })
        return null
      }
      if (!target || target.ready === false || target.headOid === undefined) {
        const message = target?.ready === false
          ? target.message
          : 'The linked pull-request push target is unavailable.'
        failWith({ message: `Force push unavailable: ${message}` })
        return null
      }
      const body = `Force push ${target.localBranch} to ${target.remote}/${target.branch} (${target.repository.host}/${target.repository.owner}/${target.repository.repo}) at ${target.headOid}? The push uses an exact lease on this pull-request head.`
      const ok = await ask({ title: 'Force push linked pull request?', body, confirm: 'Force Push', danger: true })
      return ok ? { purpose: 'review', expected: target.headOid } : null
    }
    if (githubReview.kind === 'loading' || githubReview.kind === 'waiting' || githubReview.kind === 'unavailable') {
      const message = githubReview.kind === 'unavailable'
        ? githubReview.message
        : 'GitHub pull-request state is still being checked. Retry before force pushing.'
      failWith({ message: `Force push unavailable: ${message}` })
      return null
    }
    let text: string
    try {
      text = (await context.call('quirky.git/describeForcePush', { worktree })) as string
    } catch (e) {
      failWith({ message: `Force push failed: ${messageOf(e)}` })
      return null
    }
    const { title, body } = splitQuestion(text)
    const ok = await ask({ title, body, confirm: 'Force Push', danger: true })
    return ok ? {} : null
  }

  const forcePushParams = (expected?: string): Record<string, unknown> => {
    if (expected !== undefined) return { yes: true, expected }
    const sha = status?.upstreamStatus.sha
    return sha ? { yes: true, expected: sha } : { yes: true }
  }

  const forcePush = async () => {
    const confirmation = await confirmForcePush()
    if (confirmation) {
      await remote('force-push', forcePushParams(confirmation.expected), confirmation.purpose)
    }
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
  const commitWith = async (mode: 'staged' | 'all' | 'selected', chain?: { head: string; stillCurrent: () => boolean }): Promise<boolean> => {
    const text = message.trim()
    if (text === '') {
      failWith({ message: EMPTY_MESSAGE, emptyMessage: true })
      focusMessage()
      return false
    }
    setShipError(null)
    setCommitting(true)
    requestFocusRecovery()
    try {
      const branch = status?.branch ?? null
      const fresh = await exactStatus(worktree, branch, chain?.head)
      if (mode === 'all') {
        await context.call('quirky.git/stage', { worktree, scope: 'all' })
        if (chain && !chain.stillCurrent()) return false
      } else if (mode === 'selected') {
        const keep = new Set(ticks ?? [])
        const toStage = [...new Set(fresh.entries.filter((entry) => keep.has(entry.path)).map((entry) => entry.path))]
        const toUnstage = [...new Set(fresh.entries.filter((entry) => entry.area === 'staged' && !keep.has(entry.path)).map((entry) => entry.path))]
        if (toStage.length > 0) await context.call('quirky.git/stage', { worktree, paths: toStage })
        if (toUnstage.length > 0) await context.call('quirky.git/unstage', { worktree, paths: toUnstage })
      }
      if (mode !== 'staged') {
        const staged = await exactStatus(worktree, branch, chain?.head)
        if (mode === 'all' && staged.entries.some((entry) => entry.area !== 'staged')) {
          throw new Error('New or unresolved changes appeared while staging. Review Source Control and try again.')
        }
        if (chain) {
          if (mode === 'all' && staged.entries.length === 0) throw new Error('Stage the intended changes before committing and creating a pull request.')
          if (!chain.stillCurrent()) return false
        }
      }
      await context.call('quirky.git/commit', { worktree, message: text })
      setMessage('')
      setWrittenBy(null)
      if (mode === 'selected') setTicks(null)
      return true
    } catch (e) {
      const reason = reasonOf(e)
      const data = dataOf(e)
      if (reason === 'hook' || reason === 'lint' || data.reason === 'failed') {
        const summary = asText(data.summary) ?? messageOf(e)
        const output = asText(data.output) ?? ''
        failWith({
          message: summary,
          ...(hasMoreDetail(summary, output) ? { details: { title: 'Commit Failed' as const, output } } : {}),
          fix: 'fixCommitFailure'
        })
      } else {
        failWith({ message: messageOf(e), retry: () => void commitWith(mode) })
      }
      return false
    } finally {
      setCommitting(false)
      await refreshAll()
      refreshReview()
    }
  }

  const abort = async () => {
    if (operation === 'none') return
    const name = operation
    const ok = await ask({
      title: `Abort ${name}?`,
      body: `This cancels the ${name} in progress and can discard conflict resolutions made during this ${name}.`,
      confirm: `Abort ${name}`,
      danger: true
    })
    if (ok) await remote('abort', { yes: true })
  }

  const cancelCreateReview = () => {
    createIntent.current += 1
    activeCreateIntent.current = null
    setCreatingReview(false)
    failWith({ message: 'The remaining Create PR steps were cancelled. Any commit or push already running may still finish on this worktree.' })
  }

  const createReview = async () => {
    if (activeCreateIntent.current !== null || !status || !status.branch || !status.head) return
    if (githubReview.kind === 'unavailable') {
      failWith({ message: `Could not confirm that this branch has no pull request. ${githubReview.message}` })
      return
    }
    if (githubReview.kind !== 'no-review' || githubReview.target.worktree !== worktree ||
      githubReview.target.branch !== status.branch || githubReview.target.head !== status.head) return
    const target = worktree
    const branch = status.branch
    const initialHead = status.head
    const intent = ++createIntent.current
    activeCreateIntent.current = intent
    const stillCurrent = () => createIntent.current === intent && activeWorktree.current === target
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
        if (message.trim() === '') throw new Error(EMPTY_MESSAGE)
        if (!stillCurrent()) return
        if (!(await commitWith('all', { head: initialHead, stillCurrent }))) return
        if (!stillCurrent()) return
        committed = true
        fresh = await exactStatus(target, branch)
        if (fresh.head === null) throw new Error('The branch head is unavailable after the commit.')
        expectedHead = fresh.head
        if (fresh.entries.length > 0) throw new Error('New changes appeared after the commit. Review Source Control before creating a pull request.')
      }

      let needsPush = committed || !fresh.upstreamStatus.hasUpstream || fresh.upstreamStatus.ahead > 0
      if (fresh.upstreamStatus.behind > 0) throw new Error('Sync this branch with its upstream before creating a pull request.')
      if (needsPush) {
        fresh = await exactStatus(target, branch, expectedHead)
        if (fresh.entries.length > 0) throw new Error('Commit or stage the current changes before pushing this branch.')
        if (!stillCurrent()) return
        if (!(await remote('push', {}, 'creation'))) return
        if (!stillCurrent()) return
        fresh = await exactStatus(target, branch, expectedHead)
        if (fresh.entries.length > 0) throw new Error('New changes appeared after pushing. Review Source Control before creating a pull request.')
        if (!fresh.upstreamStatus.hasUpstream || fresh.upstreamStatus.ahead > 0) {
          throw new Error('The branch is still not fully pushed. Resolve the push state before creating a pull request.')
        }
        needsPush = false
      }
      if (!stillCurrent()) return
      fresh = await exactStatus(target, branch, expectedHead)
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
        setCreatingReview(false)
      }
    }
  }

  const viewReview = async () => {
    if (githubReview.kind !== 'found') return
    try {
      await context.call('quirky.reviews/openLink', { url: githubReview.review.url })
    } catch (error) {
      failWith({ message: `Could not open pull request: ${messageOf(error)}` })
    }
  }

  const commitMode = stagedCount > 0 ? 'staged' : 'all'

  const runMenu = async (id: ShipMenuId) => {
    setShipError(null)
    switch (id) {
      case 'commit-all':
        return void (await commitWith('all'))
      case 'commit-selected':
        setTicks(new Set(uncommittedPaths))
        return
      case 'commit-push':
        if (status && shouldForcePushWithLease(status.upstreamStatus)) {
          const confirmation = await confirmForcePush()
          if (!confirmation) return
          if (await commitWith(commitMode)) {
            await remote('force-push', forcePushParams(confirmation.expected), confirmation.purpose)
          }
        } else if (await commitWith(commitMode)) await remote('push')
        return
      case 'commit-push-pr':
        return void (await createReview())
      case 'pull':
        return void (await remote('pull'))
      case 'fast-forward':
        return void (await remote('fast-forward'))
      case 'sync':
        return void (await remote('sync'))
      case 'push':
      case 'publish':
        return void (await remote('push'))
      case 'force-push':
        return forcePush()
      case 'rebase':
        return void (await remote('rebase'))
      case 'fetch':
        return void (await remote('fetch'))
      case 'create-pr':
        return void (await createReview())
      case 'view-pr':
        return viewReview()
    }
  }

  const runStep = () => {
    if (step === null) return
    setShipError(null)
    switch (step.kind) {
      case 'commit-staged':
        return void commitWith('staged')
      case 'commit-all':
        return void commitWith('all')
      case 'commit-selected':
        return void commitWith('selected')
      case 'pull':
        return void remote('pull')
      case 'sync':
        return void remote('sync')
      case 'publish':
        return void remote('push')
      case 'push':
        return void (status && shouldForcePushWithLease(status.upstreamStatus) ? forcePush() : remote('push'))
      case 'create-pr':
        return void createReview()
      case 'view-pr':
        return void viewReview()
      case 'up-to-date':
        return
    }
  }

  const openCommit = (commit: GitCommit) =>
    void openReview(context, { worktree, commit: commit.oid }).catch((error: unknown) => context.toast('Could not open diff', messageOf(error)))
  const openCommitFile = (commit: GitCommit, change: GitChange) =>
    void openReview(context, { worktree, commit: commit.oid, reveal: change.path }).catch((error: unknown) =>
      context.toast('Could not open diff', messageOf(error))
    )

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
      setTicks(null)
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && step?.kind.startsWith('commit') && step.enabled) {
      event.preventDefault()
      runStep()
    }
  }

  if (data.unavailable !== null) {
    return (
      <div className="ui-stack" data-git-panel ref={root} onKeyDown={onKeyDown} style={{ height: '100%', minHeight: 0, gap: 0 }}>
        <EmptyState message={data.unavailable} action={{ label: 'Retry', onAction: () => void data.refresh() }} />
      </div>
    )
  }

  const compareMessage = compare && compare.status !== 'ready' ? (compare.message ?? 'Branch compare is unavailable.') : compareData.error
  const nothingUncommitted = status !== null && entries.length === 0
  const clean = status !== null && model !== null && step === null
  const baseShown = compare !== null && compare.base === null ? null : model?.base.name ?? compare?.base ?? null
  const branchName = model?.branch ?? status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch')
  const loading = (status === null && data.error === null) || (model === null && review.error === null)
  const marks = model === null ? 0 : model.counts.reviewed + model.counts.changed

  const errorView: ShipErrorView | null = shipError === null ? null : {
    message: shipError.message,
    ...(shipError.pull
      ? { action: { label: 'Pull first', onAction: () => void runMenu('pull') } }
      : shipError.fetch
        ? { action: { label: 'Fetch first', onAction: () => void runMenu('fetch') } }
        : shipError.details
          ? { action: { label: 'Details', onAction: () => setDialog({ kind: 'details', ...shipError.details! }) } }
          : shipError.retry
            ? { action: { label: 'Retry', onAction: () => shipError.retry!() } }
            : {}),
    ...(shipError.fix !== undefined && fixFor(shipError.fix) ? { extra: <FixSplitButton {...fixFor(shipError.fix)!} /> } : {})
  }

  return (
    <div className="ui-stack" data-git-panel ref={root} onKeyDown={onKeyDown} style={{ height: '100%', minHeight: 0, gap: 0 }}>
      <Header
        filter={filter}
        filterOpen={filterOpen}
        onFilterOpen={setFilterOpen}
        onFilter={setFilter}
        viewMode={viewMode}
        onViewMode={setViewMode}
        onChangeBase={() => setDialog({ kind: 'base' })}
        onRefresh={() => void refreshAll().then(refreshReview)}
        onAiSettings={() => context.openView(AI_SETTINGS_VIEW_ID, { worktree })}
        onSummarize={aiEnabled ? () => setLaunch('branchSummary') : undefined}
        prActions={aiEnabled && githubReview.kind === 'found' && githubReview.review.state !== 'closed' && githubReview.review.state !== 'merged' ? PR_AI_ACTIONS.map(({ action, label }) => ({ label, onSelect: () => setLaunch(action) })) : []}
        revertable={revertable.length}
        onRevertAll={() => void revertAll()}
      />
      {status && (
        <BranchRow branch={branchName} base={baseShown} totals={model?.totals ?? null} onChangeBase={() => setDialog({ kind: 'base' })} />
      )}
      {model !== null && model.counts.files > 0 && <CountLine counts={model.counts} />}
      {(data.error || (review.error && model === null)) && (
        <div className="ui-cluster" role="alert" style={{ color: 'var(--ui-failing)' }}>
          <span>{data.error ?? review.error}</span>
          <Button onClick={() => void refreshAll()}>Retry</Button>
        </div>
      )}
      <div className="ui-stack" data-git-content style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {loading && <EmptyState message="Loading…" />}
        {status?.capped && (
          <HugeBanner
            onStageAll={() => void stageScope('all')}
            onRetry={async () => {
              if ((await data.refresh()) === null) context.toast('Could not refresh Source Control', 'Try again.')
            }}
          />
        )}
        {tooLarge && (
          <div className="ui-stack">
            <EmptyState message="Search text is too large" />
            <p className="ui-text-muted">Use a shorter file filter.</p>
          </div>
        )}
        {visibleFiles.length > 0 && (
          <ReviewList
            label="Changed files"
            files={visibleFiles}
            viewMode={viewMode}
            collapsed={collapsedDirs}
            onToggleDir={toggleDir}
            selected={selected}
            handlers={handlers}
            onKeyDown={onListKeyDown}
          />
        )}
        {filtering && !tooLarge && model !== null && visibleFiles.length === 0 && <p className="ui-text-muted">No files match the filter.</p>}
        {status && compareMessage !== null && !tooLarge && (
          <CompareUnavailable
            message={compareMessage}
            standalone={nothingUncommitted}
            onChangeBase={() => setDialog({ kind: 'base' })}
            onRetry={() => void compareData.refresh()}
          />
        )}
        {clean && !filtering && <CleanState base={baseShown ?? 'the base'} upstream={status.upstreamStatus.hasUpstream ? status.upstreamStatus.name ?? status.upstream : null} />}
        {status && !filtering && (
          <HistoryDock
            context={context}
            worktree={worktree}
            open={historyOpen}
            onToggle={() => setHistoryOpen((prev) => !prev)}
            head={status.head}
            onOpenCommit={openCommit}
            onOpenFile={openCommitFile}
          />
        )}
      </div>
      <div className="ui-stack" data-git-ship>
        {status && operation !== 'none' && (
          <>
            {errorView && <ShipErrorLine error={errorView} onDismiss={() => setShipError(null)} />}
            <OperationCard
              operation={operation}
              unresolved={unresolved}
              busy={busy !== null}
              onReview={() => open({ mode: 'conflicts' })}
              onContinue={() => void remote('continue')}
              onAbort={() => void abort()}
              fix={fixFor('resolveConflicts')}
            />
          </>
        )}
        {status && operation === 'none' && step !== null && (
          <ShipBar
            context={context}
            worktree={worktree}
            step={step}
            items={shipItems}
            busy={busyLabel !== null}
            onStep={runStep}
            onChoose={(id) => void runMenu(id)}
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
                    setMessage(text)
                    setWrittenBy(agent)
                  }}
                  onError={(text) => failWith({ message: text })}
                />
              ) : undefined
            }
            onGenerate={dropEmptyMessageError}
            writtenBy={writtenBy}
            error={errorView}
            onDismissError={() => setShipError(null)}
            selecting={ticks !== null}
            aside={
              <>
                {githubReview.kind === 'found' && reviewPushTarget?.key === reviewPushKey && (
                  reviewPushTarget.state === 'loading' ? (
                    <p className="ui-text-muted" role="status" data-git-push-target>Checking the configured push destination for this pull request…</p>
                  ) : reviewPushTarget.state === 'unavailable' ? (
                    <p role="alert" data-git-push-target style={{ color: 'var(--ui-failing)' }}>{reviewPushTarget.message}</p>
                  ) : (
                    <p role="status" data-git-push-target>
                      <strong>{reviewPushTarget.fork ? 'Fork destination' : 'Push destination'}:</strong>{' '}
                      <code>{reviewPushTarget.remote}/{reviewPushTarget.branch}</code>
                      {' · '}{reviewPushTarget.repository.host}/{reviewPushTarget.repository.owner}/{reviewPushTarget.repository.repo}
                    </p>
                  )
                )}
                {creatingReview && <Button onClick={cancelCreateReview}>Cancel remaining steps</Button>}
              </>
            }
          />
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${splitPath(menu.item.path).name}`} items={menuEntries(menu.item)} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirm={dialog.confirm}
          danger={dialog.danger}
          onConfirm={() => {
            setDialog(null)
            dialog.resolve(true)
          }}
          onCancel={() => {
            setDialog(null)
            dialog.resolve(false)
          }}
        />
      )}
      {dialog?.kind === 'details' && (
        <Dialog
          open
          title={dialog.title}
          onClose={() => setDialog(null)}
          actions={
            <div className="ui-cluster" style={{ justifyContent: 'flex-end' }}>
              {aiEnabled && (
                <Button
                  variant="primary"
                  disabled={aiFix.busy}
                  onClick={() => {
                    setDialog(null)
                    void aiFix.start(dialog.title === 'Commit Failed' ? 'fixCommitFailure' : 'fixPushFailure')
                  }}
                >
                  Fix with AI
                </Button>
              )}
              <Button onClick={() => setDialog(null)}>Close</Button>
            </div>
          }
        >
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{dialog.output}</pre>
        </Dialog>
      )}
      {launch !== null && aiEnabled && (
        <LaunchDialog context={context} worktree={worktree} action={launch} onClose={() => setLaunch(null)} start={(params) => aiFix.start(launch, params)} />
      )}
      {dialog?.kind === 'base' && (
        <ChangeBaseDialog context={context} worktree={worktree} current={baseShown} marks={marks} onClose={() => setDialog(null)} onChanged={async () => {
            await refreshAll()
            refreshReview()
          }} />
      )}
    </div>
  )
}
