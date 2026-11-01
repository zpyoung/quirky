import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ContextMenu, Dialog, EmptyState, IconButton } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { GitBusyOp, GitChange, GitCommit, GitStatus, GitStatusEntry, UiPluginContext } from '@quirky/protocol'
import { CommitSparkle } from '../ai/CommitSparkle'
import type { FixButtonProps } from '../ai/FixSplitButton'
import { LaunchDialog } from '../ai/LaunchDialog'
import type { FixAction } from '../ai/types'
import { useAiFix } from '../ai/useAiFix'
import { NotesShelf } from '../notes/NotesShelf'
import { noteViewInput } from '../notes/open-note'
import { noteCounts, useNotes, type Note } from '../notes/useNotes'
import { PANEL_ID, type DiffViewInput } from '../shared/view-input'
import { discardText } from '../shared/discard-text'
import type { ScmReport } from '../scm'
import { BlockedCard, CleanState, CompareUnavailable, HugeBanner, OperationCard } from './Cards'
import { ChangeBaseDialog } from './ChangeBaseDialog'
import { CommitArea } from './CommitArea'
import { GitHubReviewStatus, readGitHubReview, useGitHubReview } from './GitHubReview'
import { useCompare, useSettings, useStatus, useWorktreePath } from './data'
import { ConfirmDialog } from './Dialog'
import { applyFilter, matchesFilter } from './filter'
import {
  commitTitle,
  dataOf,
  hasMoreDetail,
  manyDiscardText,
  messageOf,
  reasonOf,
  splitPath,
  splitQuestion
} from './format'
import { BranchRow, Header } from './Header'
import { HistoryDock } from './HistoryDock'
import { commitDisabledReason, menuItems, primaryAction, type LadderState, type MenuItemId } from './ladder'
import type { Notice } from './Notices'
import { registerPanel } from './registry'
import { toastFor, type RemoteAction } from './remote-messages'
import { displayPaths, Rows, type ClickKind, type Expansion, type RowButton, type RowHandlers, type RowItem } from './Rows'
import { openHostedDiff } from '../view/hosted-tabs'
import { isRecord } from '../daemon/validation'
import type { PushTargetResult } from '../daemon/push-target'
import { SectionFrame } from './SectionFrame'
import {
  actionPaths,
  entryActions,
  groupSections,
  sectionButtons,
  uncommittedBadge,
  type ActionContext,
  type Section
} from './sections'
import { EMPTY_SELECTION, reduceSelection, type SelectionAction, type SelectionState } from './selection'

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
const OWN_BUTTON: ReadonlySet<GitBusyOp> = new Set(['switch', 'push', 'force-push', 'pull', 'sync'])
const RETRY_MS = 10_000
const MESSAGE_REQUIRED = 'Enter a commit message to commit'

type Blocked = { pill: 'Lint' | 'Hook' | 'Failed'; summary: string; output: string }
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

type MutationVerb = 'stage' | 'unstage' | 'discard' | 'delete'

type Mutation = {
  method: 'quirky.git/stage' | 'quirky.git/unstage' | 'quirky.git/discard'
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

const rowKey = (entry: GitStatusEntry): string => `${entry.area}:${entry.path}`

type NoteCounts = ReadonlyMap<string, number>

const toItem = (entry: GitStatusEntry, notes?: NoteCounts): RowItem => ({
  key: rowKey(entry),
  path: entry.path,
  oldPath: entry.oldPath,
  status: entry.status,
  added: entry.added,
  removed: entry.removed,
  entry,
  notes: notes?.get(entry.path)
})

const changeToItem = (change: GitChange, notes?: NoteCounts): RowItem => ({
  key: `branch:${change.path}`,
  path: change.path,
  oldPath: change.oldPath,
  status: change.status,
  added: change.added,
  removed: change.removed,
  notes: notes?.get(change.path)
})

/** Everything the Source Control panel shows and does for one worktree. */
export function WorktreePanel({ context, worktree, report, notify, drafts, offered }: PanelProps) {
  const root = useRef<HTMLDivElement>(null)
  const [settings, setViewMode] = useSettings(context)
  const data = useStatus(context, worktree)
  const { status: polled, markersGone } = data
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
  const notes = useNotes(context, worktree)
  const counts = useMemo(() => noteCounts(notes), [notes])

  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [selection, setSelectionState] = useState<SelectionState>(EMPTY_SELECTION)
  const selectionRef = useRef(selection)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notesCollapsed, setNotesCollapsed] = useState(false)
  const [notesReveal, setNotesReveal] = useState(0)
  const [message, setMessageState] = useState(() => drafts.get(worktree))
  const [committing, setCommitting] = useState(false)
  const edits = useRef(0)
  const aiFix = useAiFix(context, worktree)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [commitBlocked, setCommitBlocked] = useState<Blocked | null>(null)
  const [pushBlocked, setPushBlocked] = useState<Blocked | null>(null)
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
  const [createReviewError, setCreateReviewError] = useState<string | null>(null)
  useEffect(() => {
    activeCreateIntent.current = null
    setCreatingReview(false)
    setCreateReviewError(null)
    return () => {
      createIntent.current += 1
      activeCreateIntent.current = null
    }
  }, [worktree])

  const viewMode = settings.viewMode
  const filtering = applyFilter([], filter).state !== 'inactive'
  const query = filter.trim()
  const entries = status?.entries ?? []
  const actionContext: ActionContext = useMemo(() => ({ markersGone }), [markersGone])

  const setSelection = useCallback((next: SelectionState) => {
    selectionRef.current = next
    setSelectionState(next)
  }, [])
  const dispatchSelection = useCallback(
    (action: SelectionAction): string | null => {
      const result = reduceSelection(selectionRef.current, action)
      if (result.state !== selectionRef.current) setSelection(result.state)
      return result.open
    },
    [setSelection]
  )

  const setMessage = (text: string) => {
    edits.current += 1
    setMessageState(text)
    drafts.set(worktree, text)
  }

  const refreshAll = useCallback(async () => {
    await Promise.all([data.refresh(), compareData.refresh()])
  }, [data.refresh, compareData.refresh])

  const recoverPanelFocus = useCallback((opener: Element | null) => {
    const active = document.activeElement
    const activeIsValid = active !== null && active !== document.body && active.isConnected && !active.hasAttribute('disabled')
    if (activeIsValid && active !== opener) return
    const panel = root.current
    const target = panel?.querySelector<HTMLButtonElement>('[data-base-ref]:not(:disabled)')
      ?? panel?.querySelector<HTMLButtonElement>('[aria-label="More commit and remote actions"]:not(:disabled)')
    target?.focus()
  }, [])
  const requestFocusRecovery = useCallback((opener: Element | null = null) => {
    setFocusRecovery((request) => ({ revision: request.revision + 1, opener }))
  }, [])
  useEffect(() => {
    if (focusRecovery.revision > 0) recoverPanelFocus(focusRecovery.opener)
  }, [focusRecovery, recoverPanelFocus])
  useEffect(() => {
    const baseDialogOpen = dialog?.kind === 'base'
    if (baseDialogWasOpen.current && !baseDialogOpen) recoverPanelFocus(null)
    baseDialogWasOpen.current = baseDialogOpen
  }, [dialog?.kind, recoverPanelFocus])

  const sections = useMemo(() => groupSections(entries, settings.groupOrder), [entries, settings.groupOrder])
  const visibleEntries = useCallback(
    (section: Section): GitStatusEntry[] => (query === '' ? section.entries : section.entries.filter((e) => matchesFilter(e.path, query))),
    [query]
  )
  const compareReady = compare?.status === 'ready'
  const branchItems = useMemo(
    () => (compareReady ? compare.entries.filter((c) => query === '' || matchesFilter(c.path, query)).map((c) => changeToItem(c, counts)) : []),
    [compare, compareReady, query, counts]
  )
  const tooLarge = applyFilter([], filter).state === 'too-large'

  const order = useMemo(() => {
    if (tooLarge) return []
    return sections.flatMap((s) => displayPaths(visibleEntries(s).map((e) => toItem(e)), viewMode, s.id, collapsed))
  }, [sections, visibleEntries, viewMode, collapsed, tooLarge])
  const orderKey = order.join('\n')

  useEffect(() => {
    dispatchSelection({ type: 'prune', order })
    // order is covered by its joined key
  }, [orderKey, dispatchSelection])

  useEffect(() => {
    dispatchSelection({ type: 'reset' })
  }, [viewMode, dispatchSelection])

  const compareRef = useRef(compareData.refresh)
  compareRef.current = compareData.refresh

  useEffect(
    () =>
      registerPanel({
        setFilter: (q) => {
          setFilter(q)
          setFilterOpen(q !== '')
        },
        select: (paths) => setSelection(paths.length === 0 ? EMPTY_SELECTION : { selected: paths, anchor: paths[paths.length - 1] ?? null }),
        toggleHistory: (open) => setHistoryOpen((prev) => open ?? !prev),
        refreshCompare: () => void compareRef.current()
      }),
    [setSelection]
  )
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) dispatchSelection({ type: 'escape' })
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [dispatchSelection])

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

  const reviewGate: LadderState['reviewGate'] =
    githubReview.kind === 'loading' || githubReview.kind === 'waiting' ? 'loading'
      : githubReview.kind === 'unavailable' ? 'unavailable'
        : githubReview.kind === 'found' && githubReview.review.state === 'merged' ? 'merged'
          : githubReview.kind === 'found' ? 'linked'
            : undefined
  const ladder: LadderState = {
    status,
    message,
    committing,
    base: compare?.base ?? null,
    ...(reviewGate === undefined ? {} : { reviewGate })
  }
  const primary = primaryAction(ladder)
  const menuRows = menuItems(ladder)
  const unresolved = entries.filter((e) => e.conflict?.state === 'unresolved').length
  const operation = status?.operation ?? 'none'
  const aiEnabled = settings.aiEnabled
  const stagedCount = entries.filter((e) => e.area === 'staged').length
  const fixFor = (action: FixButtonProps['action']): FixButtonProps | undefined =>
    aiEnabled ? { action, busy: aiFix.busy, onFix: () => void aiFix.start(action), onCustomize: () => setLaunch(action) } : undefined

  const open = (input: Omit<DiffViewInput, 'worktree'>) => {
    void openHostedDiff(context, { worktree, ...input }).catch((error: unknown) =>
      context.toast('Could not open diff', messageOf(error))
    )
  }

  const toggleSubmodule = (item: RowItem) => {
    const signature = JSON.stringify(item.entry?.submodule)
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

  const openRow = (item: RowItem, options: { permanent?: boolean; split?: boolean } = {}) => {
    if (item.entry?.submodule) return toggleSubmodule(item)
    const placement = options.split ? { split: true, preview: false } : { preview: options.permanent !== true }
    const area = item.entry?.area
    const oldPath = item.oldPath === undefined ? {} : { oldPath: item.oldPath }
    if (area === 'conflicts') return open({ mode: 'conflict-file', path: item.path, ...placement })
    const source = area === undefined ? 'branch' : area === 'staged' ? 'staged' : 'unstaged'
    open({ mode: 'file', source, path: item.path, ...placement, ...oldPath })
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
      if (mutation.verb === 'delete') requestFocusRecovery()
    }
  }

  const notifyMutationFailure = (mutation: Mutation, error: unknown) => {
    const retry = { label: 'Retry', run: () => void runMutation(mutation), expiresMs: RETRY_MS }
    if (!mutation.bulk) {
      const path = mutation.paths[0] ?? ''
      notify({ id: 'source-control-entry-mutation', worktree, title: `Failed to ${mutation.verb} “${path}”`, body: messageOf(error), actions: [retry] })
      return
    }
    const failures = Array.isArray(dataOf(error).failures) ? (dataOf(error).failures as Array<{ path: string; message: string }>) : []
    if (mutation.verb === 'discard' || mutation.verb === 'delete') {
      const first = failures[0]?.message ?? messageOf(error)
      const sample = failures.slice(0, 3).map((f) => f.path).join(', ')
      notify({
        id: 'source-control-bulk',
        worktree,
        title: `Failed to discard ${failures.length || mutation.paths.length} file(s)`,
        body: sample === '' ? first : `${first} ${sample}`,
        actions: [retry]
      })
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

  const stageAll = () => {
    if (status?.capped) return stageScope('all')
    const paths = [...new Set(actionPaths(entries, 'stage', actionContext))]
    return stagePaths(paths, true)
  }

  const discard = async (text: { title: string; body: string; confirm: string }, mutation: Mutation) => {
    const active = document.activeElement
    const opener = mutation.verb === 'delete'
      && active instanceof HTMLElement
      && active.getAttribute('aria-label')?.startsWith('Delete untracked file ') === true
      ? active
      : null
    if (!(await ask({ ...text, danger: true }))) return
    if (mutation.verb === 'delete') requestFocusRecovery(opener)
    if (await runMutation(mutation)) dispatchSelection({ type: 'reset' })
  }

  const discardRow = (entry: GitStatusEntry) =>
    discard(discardText({ kind: 'file', path: entry.path, area: entry.area, status: entry.status }), {
      method: 'quirky.git/discard',
      params: { paths: actionPaths([entry], 'discard', actionContext), yes: true },
      verb: entry.area === 'untracked' ? 'delete' : 'discard',
      paths: [entry.path],
      bulk: false
    })

  const discardSection = (section: Section) =>
    discard(discardText({ kind: 'section', area: section.id as 'staged' | 'unstaged' | 'untracked', count: section.entries.length }), {
      method: 'quirky.git/discard',
      params: { area: section.id, yes: true },
      verb: 'discard',
      paths: section.entries.map((e) => e.path),
      bulk: true
    })

  const discardMany = (list: GitStatusEntry[]) => {
    const paths = actionPaths(list, 'discard', actionContext)
    return discard(manyDiscardText(list.filter((e) => entryActions(e, actionContext).discard !== null)), {
      method: 'quirky.git/discard',
      params: { paths, yes: true },
      verb: 'discard',
      paths,
      bulk: true
    })
  }

  const rowButtons = (item: RowItem): RowButton[] => {
    const entry = item.entry
    if (!entry) return []
    const actions = entryActions(entry, actionContext)
    const buttons: RowButton[] = []
    if (actions.discard !== null) {
      const label = actions.discard === 'delete' ? 'Delete untracked file' : actions.discard === 'restore' ? 'Restore file' : 'Discard changes'
      buttons.push({ label, glyph: actions.discard === 'delete' ? '×' : '↶', destructive: true, run: () => void discardRow(entry) })
    }
    if (actions.stage) buttons.push({ label: 'Stage', glyph: '+', run: () => void stagePaths([entry.path], false) })
    if (actions.unstage) buttons.push({ label: 'Unstage', glyph: '−', run: () => void unstagePaths(actionPaths([entry], 'unstage'), false) })
    return buttons
  }

  const folderButtons = (items: RowItem[]): RowButton[] => {
    const list = items.flatMap((i) => (i.entry ? [i.entry] : []))
    const buttons: RowButton[] = []
    if (actionPaths(list, 'discard', actionContext).length > 0) {
      const untracked = list.every((e) => e.area === 'untracked')
      buttons.push({
        label: untracked ? 'Delete untracked in folder' : 'Discard folder',
        glyph: untracked ? '×' : '↶',
        destructive: true,
        run: () => void discardMany(list)
      })
    }
    const stage = actionPaths(list, 'stage', actionContext)
    if (stage.length > 0) buttons.push({ label: 'Stage folder', glyph: '+', run: () => void stagePaths(stage, true) })
    const unstage = actionPaths(list, 'unstage')
    if (unstage.length > 0) buttons.push({ label: 'Unstage folder', glyph: '−', run: () => void unstagePaths(unstage, true) })
    return buttons
  }

  const absolute = (path: string): string => (worktreePath === null ? path : `${worktreePath.replace(/\/$/, '')}/${path}`)

  const handlers: RowHandlers = {
    click: (item, kind: ClickKind, permanent) => {
      if (kind === 'split') return openRow(item, { split: true })
      if (item.entry === undefined) return openRow(item, { permanent })
      const type = kind === 'mod' ? 'mod-click' : kind === 'shift' ? 'shift-click' : 'click'
      const action: SelectionAction = type === 'shift-click' ? { type, path: item.path, order } : { type, path: item.path }
      if (dispatchSelection(action) !== null) {
        setOpenedPath(item.path)
        openRow(item, { permanent })
      }
    },
    contextMenu: (item, x, y) => {
      if (item.entry) dispatchSelection({ type: 'context-click', path: item.path })
      setMenu({ x, y, item })
    },
    buttons: rowButtons,
    folderButtons,
    dragText: (item) => absolute(item.path),
    expansion: (item): Expansion | null => {
      if (!item.entry?.submodule) return null
      const state = submodules[item.path]
      return { open: state?.open ?? false, entries: state?.entries ?? null, failed: state?.failed ?? false }
    },
    toggleExpansion: toggleSubmodule
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (e) {
      context.toast('Could not copy', messageOf(e))
    }
  }

  const menuEntries = (item: RowItem): ContextMenuItem[] => [
    { label: 'View', onSelect: () => openRow(item) },
    { label: 'Copy Path', onSelect: () => void copy(absolute(item.path)) },
    { label: 'Copy Relative Path', onSelect: () => void copy(item.path) },
    {
      label: 'Reveal in Finder',
      onSelect: () => {
        context.call('quirky.git/reveal', { worktree, path: item.path }).catch((e: unknown) => context.toast('Could not reveal', messageOf(e)))
      }
    }
  ]

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
        const text = githubReview.kind === 'unavailable'
          ? githubReview.message
          : 'GitHub pull-request state is still being checked. Retry before pushing.'
        setRemoteError(text)
        context.toast('Push target unavailable', text)
        return false
      }
      if (action === 'sync' && purpose === 'review') {
        const text = 'Sync cannot safely choose a linked pull-request destination. Pull or push to the validated PR target separately.'
        setRemoteError(text)
        context.toast('Sync unavailable for linked pull request', text)
        return false
      }
    }
    setRemoteError(null)
    setPushBlocked(null)
    setLocalBusy(action)
    try {
      await context.call(REMOTE_METHODS[action], { worktree, ...params, ...(purpose === undefined ? {} : { purpose }) })
      return true
    } catch (e) {
      const reason = reasonOf(e)
      const text = messageOf(e)
      const data = dataOf(e)
      if ((reason === 'hook' || reason === 'lint') && PUSH_ACTIONS.has(action)) {
        setPushBlocked({ pill: reason === 'lint' ? 'Lint' : 'Hook', summary: asText(data.summary) ?? text, output: asText(data.output) ?? '' })
      } else {
        setRemoteError(text)
        const copyText = toastFor(action, reason, text, operation === 'none' ? undefined : operation)
        if (copyText) context.toast(copyText.title, copyText.body)
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
        context.toast('Force push failed', messageOf(error))
        return null
      }
      if (!target || target.ready === false || target.headOid === undefined) {
        const message = target?.ready === false
          ? target.message
          : 'The linked pull-request push target is unavailable.'
        context.toast('Force push unavailable', message)
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
      context.toast('Force push unavailable', message)
      return null
    }
    let text: string
    try {
      text = (await context.call('quirky.git/describeForcePush', { worktree })) as string
    } catch (e) {
      context.toast('Force push failed', messageOf(e))
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

  const doCommit = async (): Promise<boolean> => {
    setCommitting(true)
    setCommitBlocked(null)
    requestFocusRecovery()
    try {
      await context.call('quirky.git/commit', { worktree, message: message.trim() })
      setMessage('')
      return true
    } catch (e) {
      const reason = reasonOf(e)
      const data = dataOf(e)
      if (reason === 'hook' || reason === 'lint') {
        setCommitBlocked({ pill: reason === 'lint' ? 'Lint' : 'Hook', summary: asText(data.summary) ?? messageOf(e), output: asText(data.output) ?? '' })
      } else if (data.reason === 'failed') {
        setCommitBlocked({ pill: 'Failed', summary: asText(data.summary) ?? messageOf(e), output: asText(data.output) ?? '' })
      } else {
        context.toast('Commit failed', messageOf(e))
      }
      return false
    } finally {
      setCommitting(false)
      await refreshAll()
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

  const lease = menuRows.find((r) => r.id === 'commit-push')?.label === 'Commit & Force Push'

  const runMenu = async (id: MenuItemId) => {
    switch (id) {
      case 'commit':
        return void (await doCommit())
      case 'commit-push':
        if (lease) {
          const confirmation = await confirmForcePush()
          if (!confirmation) return
          if (await doCommit()) {
            await remote('force-push', forcePushParams(confirmation.expected), confirmation.purpose)
          }
        } else if (await doCommit()) await remote('push')
        return
      case 'commit-sync':
        if (githubReview.kind === 'found' || githubReview.kind === 'loading' || githubReview.kind === 'waiting' || githubReview.kind === 'unavailable') {
          return void (await remote('sync'))
        }
        if (await doCommit()) await remote('sync')
        return
      case 'push':
      case 'publish':
        return void (await remote('push'))
      case 'force-push':
        return forcePush()
      case 'pull':
        return void (await remote('pull'))
      case 'fast-forward':
        return void (await remote('fast-forward'))
      case 'sync':
        return void (await remote('sync'))
      case 'rebase':
        return void (await remote('rebase'))
      case 'fetch':
        return void (await remote('fetch'))
      case 'abort':
        return abort()
    }
  }
  const cancelCreateReview = () => {
    createIntent.current += 1
    activeCreateIntent.current = null
    setCreatingReview(false)
    setCreateReviewError('The remaining Create PR steps were cancelled. Any commit or push already running may still finish on this worktree.')
  }

  const exactStatus = async (target: string, expectedBranch: string, expectedHead?: string): Promise<GitStatus> => {
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
      throw new Error('The branch or HEAD changed during the Create PR chain. Start the action again for the current branch.')
    }
    return resolved
  }

  const createReview = async () => {
    if (activeCreateIntent.current !== null || !status || !status.branch || !status.head) return
    if (githubReview.kind !== 'no-review' || githubReview.target.worktree !== worktree ||
      githubReview.target.branch !== status.branch || githubReview.target.head !== status.head) return
    const target = worktree
    const branch = status.branch
    const initialHead = status.head
    const intent = ++createIntent.current
    activeCreateIntent.current = intent
    const stillCurrent = () => createIntent.current === intent && activeWorktree.current === target
    setCreatingReview(true)
    setCreateReviewError(null)
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
        if (message.trim() === '') throw new Error(MESSAGE_REQUIRED)
        if (fresh.entries.some((entry) => entry.area === 'unstaged' || entry.area === 'untracked')) {
          if (!(await stageAll())) return
          if (!stillCurrent()) return
          fresh = await exactStatus(target, branch, initialHead)
          if (fresh.entries.some((entry) => entry.area !== 'staged')) {
            throw new Error('New or unresolved changes appeared while staging. Review Source Control and try again.')
          }
        }
        fresh = await exactStatus(target, branch, initialHead)
        if (fresh.entries.length === 0 || fresh.entries.some((entry) => entry.area !== 'staged')) {
          throw new Error('Stage the intended changes before committing and creating a pull request.')
        }
        if (!stillCurrent()) return
        if (!(await doCommit())) return
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
        setCreateReviewError(text)
        context.toast('Could not create pull request', text)
      }
    } finally {
      if (activeCreateIntent.current === intent) {
        activeCreateIntent.current = null
        setCreatingReview(false)
      }
    }
  }

  const onPrimary = () => {
    switch (primary.kind) {
      case 'commit':
        return void doCommit()
      case 'stage':
        return void stageAll()
      case 'push':
      case 'publish':
        return void remote('push')
      case 'force-push':
        return void forcePush()
      case 'pull':
        return void remote('pull')
      case 'sync':
        return void remote('sync')
    }
  }

  const busy = status?.busy ?? null
  const spinner = committing ? 'primary' : busy === null ? null : OWN_BUTTON.has(busy) ? 'primary' : 'chevron'
  const reason = commitDisabledReason(ladder)
  const locked = committing || busy !== null || creatingReview || (reason !== null && reason !== MESSAGE_REQUIRED)
  const reviewNeedsPush = status !== null && (!status.upstreamStatus.hasUpstream || status.upstreamStatus.ahead > 0)
  const reviewBlocker = status === null ? 'Wait for Source Control status.'
    : !status.branch ? 'Check out a branch before creating a pull request.'
      : !status.head ? 'Create a commit before creating a pull request.'
        : unresolved > 0 || entries.some((entry) => entry.area === 'conflicts') ? 'Resolve conflicts before creating a pull request.'
          : entries.length > 0 && message.trim() === '' ? MESSAGE_REQUIRED
            : githubReview.kind === 'loading' ? 'Wait for GitHub review lookup before creating a pull request.'
              : githubReview.kind === 'unavailable' ? 'GitHub review lookup is unavailable. Do not create a duplicate pull request.'
                : githubReview.kind === 'found' ? `Pull request #${githubReview.review.number} is already linked to this branch.`
                  : githubReview.kind === 'unsupported' ? 'Pull request creation requires a GitHub repository.'
                    : null
  const reviewActionDisabled = creatingReview || committing || busy !== null || githubReview.kind !== 'no-review' || reviewBlocker !== null
  const showReviewAction = githubReview.kind !== 'found' && githubReview.kind !== 'unsupported'
  const reviewActionLabel = creatingReview ? 'Preparing pull request…'
    : entries.length > 0 ? 'Commit, push & Create PR'
      : reviewNeedsPush ? 'Push & Create PR'
        : 'Create PR'
  const panelPrimary = creatingReview ? { ...primary, enabled: false, title: 'Create PR is in progress.' } : primary
  const panelMenu = creatingReview ? menuRows.map((item) => ({ ...item, enabled: false, title: 'Create PR is in progress.' })) : menuRows

  const selected = selection.selected
  const selectedEntries = entries.filter((e) => selected.includes(e.path))
  const bulkStage = selectedEntries.filter((e) => entryActions(e, actionContext).stage)
  const bulkUnstage = selectedEntries.filter((e) => entryActions(e).unstage)

  const sectionToggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const viewAll = (section: Section) =>
    section.id === 'conflicts' ? open({ mode: 'conflicts' }) : open({ mode: 'combined', area: section.id })

  const sectionButtonsFor = (section: Section): RowButton[] => {
    const wanted = sectionButtons(section, { markersGone, capped: status?.capped, filtering })
    const buttons: RowButton[] = []
    if (wanted.discardAll) {
      buttons.push({
        label: wanted.discardAll.label,
        glyph: section.id === 'untracked' ? '×' : '↶',
        destructive: true,
        run: () => void (section.id === 'conflicts' ? undefined : discardSection(section))
      })
    }
    if (wanted.stageAll) {
      buttons.push({
        label: 'Stage all',
        glyph: '+',
        run: () => void (section.id === 'unstaged' && status?.capped ? stageScope('tracked') : stagePaths(actionPaths(section.entries, 'stage', actionContext), true))
      })
    }
    if (wanted.unstageAll) {
      buttons.push({ label: 'Unstage all', glyph: '−', run: () => void unstagePaths(actionPaths(section.entries, 'unstage'), true) })
    }
    if (wanted.viewAll) buttons.push({ label: 'View all', glyph: '↗', run: () => viewAll(section) })
    return buttons
  }

  const openNote = (note: Note) => {
    if (note.source === 'markdown') {
      void context.call('quirky.editor/open', {
        worktree: `id:${note.worktreeId}`,
        path: note.path,
        mode: 'source',
        line: note.startLine,
        focus: true
      }).catch((error: unknown) => context.toast('Failed to open Markdown note', messageOf(error)))
      return
    }
    open(noteViewInput(note.path, note.id, entries, compare))
  }

  const openCommit = (commit: GitCommit) => open({ mode: 'combined', commit: commit.oid, title: commitTitle(commit.oid, commit.subject) })
  const openCommitFile = (commit: GitCommit, change: GitChange) =>
    open({ mode: 'file', source: 'commit', commit: commit.oid, path: change.path, ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }) })

  const branchHandlers: RowHandlers = { ...handlers, buttons: () => [], folderButtons: () => [] }

  const visibleSections = tooLarge
    ? []
    : sections.map((s) => ({ section: s, rows: visibleEntries(s) })).filter(({ rows }) => rows.length > 0 || query === '')
  const reportJson = JSON.stringify({
    worktree,
    branch: status?.branch ?? null,
    base: compare?.base ?? null,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    operation,
    busy,
    capped,
    sections: [
      ...visibleSections.map(({ section, rows }) => ({ id: section.id, count: rows.length })),
      ...(branchItems.length > 0 ? [{ id: 'branch', count: branchItems.length }] : [])
    ],
    primary: status === null ? null : { label: primary.label, enabled: primary.enabled, title: primary.title },
    selection: selected,
    filter,
    viewMode,
    historyOpen
  })
  useEffect(() => {
    report(JSON.parse(reportJson) as ScmReport)
  }, [reportJson, report])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') dispatchSelection({ type: 'escape' })
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && primary.kind === 'commit' && primary.enabled) {
      event.preventDefault()
      void doCommit()
    }
  }
  const openTerminal = () => {
    void context.executeCommand('command:quirky.session/new-shell').catch((error: unknown) => context.toast('Could not open terminal', messageOf(error)))
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
  const clean = status !== null && nothingUncommitted && compareReady && compare.entries.length === 0
  const base = compare?.base ?? null

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
        onRefreshCompare={() => void compareData.refresh()}
        notes={notes.length}
        onNotes={() => {
          setNotesCollapsed(false)
          setNotesReveal((n) => n + 1)
        }}
      />
      {status && <BranchRow status={status} compare={compare} onChangeBase={() => setDialog({ kind: 'base' })} />}
      {notes.length > 0 && (
        <NotesShelf
          context={context}
          worktree={worktree}
          notes={notes}
          collapsed={notesCollapsed}
          onToggle={() => setNotesCollapsed((collapsed) => !collapsed)}
          revealTick={notesReveal}
          onOpenNote={openNote}
          ask={ask}
        />
      )}
      {data.error && (
        <div className="ui-cluster" role="alert" style={{ color: 'var(--ui-failing)' }}>
          <span>{data.error}</span>
          <Button onClick={() => void data.refresh()}>Retry</Button>
        </div>
      )}
      <div className="ui-stack" data-git-content style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {status === null && data.error === null && <EmptyState message="Loading…" />}
        {status && operation !== 'none' && (
          <OperationCard
            operation={operation}
            unresolved={unresolved}
            busy={busy !== null}
            onReview={() => open({ mode: 'conflicts' })}
            onContinue={() => void remote('continue')}
            onAbort={() => void abort()}
            fix={fixFor('resolveConflicts')}
          />
        )}
        {status?.capped && (
          <HugeBanner
            onStageAll={() => void stageScope('all')}
            onRetry={async () => {
              if ((await data.refresh()) === null) context.toast('Could not refresh Source Control', 'Try again.')
            }}
          />
        )}
        {status && operation === 'none' && (
          <CommitArea
            message={message}
            onMessage={setMessage}
            locked={locked}
            primary={panelPrimary}
            menu={panelMenu}
            spinner={spinner}
            remoteError={remoteError}
            onPrimary={onPrimary}
            onMenu={(id) => void runMenu(id)}
            sparkle={
              aiEnabled ? (
                <CommitSparkle
                  context={context}
                  worktree={worktree}
                  staged={stagedCount}
                  message={message}
                  committing={committing}
                  edits={edits}
                  onResult={setMessage}
                />
              ) : undefined
            }
          >
            {commitBlocked && (
              <BlockedCard
                title="Commit blocked"
                pill={commitBlocked.pill}
                summary={commitBlocked.summary}
                onDetails={hasMoreDetail(commitBlocked.summary, commitBlocked.output) ? () => setDialog({ kind: 'details', title: 'Commit Failed', output: commitBlocked.output }) : null}
                fix={fixFor('fixCommitFailure')}
              />
            )}
            {pushBlocked && (
              <BlockedCard
                title="Push blocked"
                pill={pushBlocked.pill}
                summary={pushBlocked.summary}
                onDetails={hasMoreDetail(pushBlocked.summary, pushBlocked.output) ? () => setDialog({ kind: 'details', title: 'Push Failed', output: pushBlocked.output }) : null}
                fix={fixFor('fixPushFailure')}
              />
            )}
            <div className="ui-stack" data-git-create-review>
              <GitHubReviewStatus
                context={context}
                lookup={githubReview}
                aiEnabled={aiEnabled}
                busy={aiFix.busy}
                onLaunch={(action) => setLaunch(action)}
              />
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
              {showReviewAction && (
                <Button variant="primary" disabled={reviewActionDisabled} title={reviewBlocker ?? undefined} onClick={() => void createReview()}>
                  {reviewActionLabel}
                </Button>
              )}
              {creatingReview && <Button onClick={cancelCreateReview}>Cancel remaining steps</Button>}
              {creatingReview && <small className="ui-text-muted">Commit and push finish only on this worktree; the composer opens after both succeed.</small>}
              {createReviewError && <p role="alert" style={{ color: 'var(--ui-failing)' }}>{createReviewError}</p>}
            </div>
          </CommitArea>
        )}
        {tooLarge && (
          <div className="ui-stack">
            <EmptyState message="Search text is too large" />
            <p className="ui-text-muted">Use a shorter file filter.</p>
          </div>
        )}
        {visibleSections.map(({ section, rows }) => {
          const conflictCount = section.entries.filter((e) => e.conflict?.state === 'unresolved').length
          return (
            <SectionFrame
              key={section.id}
              id={section.id}
              heading={section.heading}
              count={rows.length}
              note={section.id === 'conflicts' && conflictCount > 0 ? `${conflictCount} conflict(s)` : undefined}
              collapsed={collapsed.has(section.id)}
              onToggle={() => sectionToggle(section.id)}
              buttons={sectionButtonsFor(section)}
            >
              <Rows
                scope={section.id}
                items={rows.map((row) => toItem(row, counts))}
                viewMode={viewMode}
                collapsedDirs={collapsed}
                onToggleDir={sectionToggle}
                selected={selected.length === 0 && openedPath !== null ? [openedPath] : selected}
                handlers={handlers}
              />
            </SectionFrame>
          )
        })}
        {filtering && !tooLarge && visibleSections.length === 0 && branchItems.length === 0 && <p className="ui-text-muted">No files match the filter.</p>}
        {status && compareMessage !== null && !tooLarge && (
          <CompareUnavailable
            message={compareMessage}
            standalone={nothingUncommitted}
            onChangeBase={() => setDialog({ kind: 'base' })}
            onRetry={() => void compareData.refresh()}
          />
        )}
        {clean && !filtering && <CleanState onOpenTerminal={openTerminal} />}
        {branchItems.length > 0 && !tooLarge && (
          <SectionFrame
            id="branch"
            heading="Committed on Branch"
            count={branchItems.length}
            title={`${branchItems.length} file${branchItems.length === 1 ? '' : 's'} changed vs ${base}`}
            collapsed={collapsed.has('branch')}
            onToggle={() => sectionToggle('branch')}
            buttons={filtering ? [] : [{ label: 'View all', glyph: '↗', run: () => open({ mode: 'combined', area: 'branch' }) }]}
          >
            <Rows scope="branch" items={branchItems} viewMode={viewMode} collapsedDirs={collapsed} onToggleDir={sectionToggle} selected={[]} handlers={branchHandlers} />
          </SectionFrame>
        )}
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
      {selected.length > 0 && (
        <div className="ui-cluster" role="toolbar" aria-label="Selection actions">
          <span>{`${selected.length} selected`}</span>
          {!filtering && bulkStage.length > 0 && (
            <Button onClick={() => void stagePaths(actionPaths(selectedEntries, 'stage', actionContext), true)}>{`Stage (${bulkStage.length})`}</Button>
          )}
          {!filtering && bulkUnstage.length > 0 && (
            <Button onClick={() => void unstagePaths(actionPaths(selectedEntries, 'unstage'), true)}>{`Unstage (${bulkUnstage.length})`}</Button>
          )}
          <IconButton label="Clear selection" title="Clear selection" onClick={() => dispatchSelection({ type: 'reset' })}>
            {'×'}
          </IconButton>
        </div>
      )}
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
        <ChangeBaseDialog context={context} worktree={worktree} current={base} onClose={() => setDialog(null)} onChanged={refreshAll} />
      )}
    </div>
  )
}
