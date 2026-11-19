import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, IconButton, InlineError, ListRow, NoticeLine, SectionHeader } from '@quirky/ui'
import type { GitChange, GitCommit, GitHistory, UiPluginContext } from '@quirky/protocol'
import { messageOf, relativeTime, shortOid } from './format'
import { letterOf, Rows, type RowHandlers, type RowItem } from './Rows'
import { newGitUiGeneration, requestGitUiControl, useGitUiControl } from '../ui-control'
import type { GitUiControl, GitUiControlAddress } from '../ui-control'

const MAX_LIMIT = 200
const NO_SELECTION: readonly string[] = []
const ROW_STYLE = { gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 } as const
const COMMIT_TITLE_STYLE = { alignItems: 'stretch', width: '100%' } as const
const COMMIT_SUBJECT_STYLE = { minWidth: 0, width: '100%' } as const
const COMMIT_REFS_STYLE = { flexWrap: 'wrap', maxWidth: '100%', minWidth: 0, width: '100%' } as const
const COMMIT_REF_STYLE = {
  background: 'var(--ui-selected)',
  boxSizing: 'border-box',
  color: 'var(--ui-text)',
  flex: '0 0 auto',
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden'
} as const
const COMMIT_REF_LABEL_STYLE = {
  display: 'block',
  flex: '1 1 auto',
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
} as const

type Props = {
  context: UiPluginContext
  worktree: string
  open: boolean
  onToggle(): void
  /** HEAD of the worktree; the list reloads when it moves. */
  head: string | null
  onOpenCommit(commit: GitCommit): void
  onOpenFile(commit: GitCommit, change: GitChange): void
}

type Files = { loading: true } | { entries: GitChange[] } | { error: string }
type HistoryAction = 'toggle-commit' | 'load-more'

function readHistory(
  context: UiPluginContext,
  worktree: string,
  limit: number | null,
  requestSequence: { current: number },
  setLoading: (loading: boolean) => void,
  setHistory: (history: GitHistory) => void,
  setError: (error: string | null) => void
) {
  const request = ++requestSequence.current
  setLoading(true)
  void context
    .call('quirky.git/history', limit === null ? { worktree } : { worktree, limit })
    .then((result) => {
      if (request !== requestSequence.current) return
      setHistory(result as GitHistory)
      setError(null)
      setLoading(false)
    })
    .catch((e: unknown) => {
      if (request !== requestSequence.current) return
      setError(messageOf(e))
      setLoading(false)
    })
}

/** The collapsed-by-default "Commits" dock: recent commits from HEAD, each expandable to its files. */
export function HistoryDock({ context, worktree, open, onToggle, head, onOpenCommit, onOpenFile }: Props) {
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [files, setFiles] = useState<Readonly<Record<string, Files>>>({})
  const historyRead = useRef(0)
  const pendingFiles = useRef(new Set<string>())
  const reservations = useRef(new Set<string>())
  const session = useRef<{ worktree: string; open: boolean; generation: string } | null>(null)
  if (session.current === null || session.current.worktree !== worktree || session.current.open !== open) {
    session.current = { worktree, open, generation: newGitUiGeneration() }
  }
  const generation = session.current.generation
  const mounted = useRef(false)
  const activeGeneration = useRef<string | null>(null)
  activeGeneration.current = open ? generation : null

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeGeneration.current = null
      historyRead.current++
    }
  }, [])

  useEffect(() => {
    if (!open) return
    readHistory(context, worktree, limit, historyRead, setLoading, setHistory, setError)
    return () => {
      historyRead.current++
    }
  }, [context, worktree, open, limit, head])

  const onRetryHistory = () => {
    setError(null)
    readHistory(context, worktree, limit, historyRead, setLoading, setHistory, setError)
  }

  const onLoadFiles = (commit: GitCommit, retry = false) => {
    const oid = commit.oid
    if (pendingFiles.current.has(oid) || (!retry && files[oid] !== undefined)) return
    pendingFiles.current.add(oid)
    setFiles((previous) => ({ ...previous, [oid]: { loading: true } }))
    void context
      .call('quirky.git/commitFiles', { worktree, commit: oid })
      .then((result) => setFiles((previous) => ({ ...previous, [oid]: { entries: (result as { entries: GitChange[] }).entries } })))
      .catch((e: unknown) => setFiles((previous) => ({ ...previous, [oid]: { error: messageOf(e) } })))
      .finally(() => pendingFiles.current.delete(oid))
  }

  const reserve = (key: string) => {
    if (reservations.current.has(key)) return false
    reservations.current.add(key)
    queueMicrotask(() => reservations.current.delete(key))
    return true
  }

  const onDispatchHistoryControl = (control: GitUiControl): boolean => {
    if (!open || control.surface !== 'panel:quirky.git/source-control' ||
        control.target !== `history:${worktree}` || control.generation !== generation) return false
    const data = control.data ?? {}
    if (control.action === 'load-more') {
      if (Object.keys(data).length > 0 || !history?.hasMore || (limit ?? 0) >= MAX_LIMIT || !reserve('load-more')) return false
      setLimit(MAX_LIMIT)
      return true
    }
    if (control.action !== 'toggle-commit' || Object.keys(data).some((key) => key !== 'commit' && key !== 'open')) return false
    const commitId = data.commit
    const hasOpen = Object.hasOwn(data, 'open')
    const openValue = data.open
    if (typeof commitId !== 'string' || (hasOpen && typeof openValue !== 'boolean')) return false
    const commit = history?.commits.find((current) => current.oid === commitId)
    if (!commit || !reserve(`toggle-commit:${commit.oid}`)) return false
    const shouldOpen = hasOpen ? openValue === true : !expanded.has(commit.oid)
    setExpanded((previous) => {
      if (previous.has(commit.oid) === shouldOpen) return previous
      const next = new Set(previous)
      if (shouldOpen) next.add(commit.oid)
      else next.delete(commit.oid)
      return next
    })
    if (shouldOpen) onLoadFiles(commit)
    return true
  }

  const actions: HistoryAction[] = []
  if ((history?.commits.length ?? 0) > 0) actions.push('toggle-commit')
  if (history?.hasMore && (limit ?? 0) < MAX_LIMIT) actions.push('load-more')
  const address: GitUiControlAddress | null = !open || actions.length === 0 ? null : {
    surface: 'panel:quirky.git/source-control',
    target: `history:${worktree}`,
    generation,
    actions
  }
  useGitUiControl(context, address, onDispatchHistoryControl)

  const onRequestHistoryControl = (action: HistoryAction, data?: Record<string, unknown>) => {
    const requestGeneration = generation
    const control: GitUiControl = {
      surface: 'panel:quirky.git/source-control',
      target: `history:${worktree}`,
      generation: requestGeneration,
      action,
      ...(data === undefined ? {} : { data })
    }
    const delivery = requestGitUiControl(context, control)
    void delivery.then((result) => {
      if (!result.delivered) throw new Error('The source control action is no longer available.')
    }).catch((cause: unknown) => {
      if (mounted.current && activeGeneration.current === requestGeneration) {
        context.toast('Could not run Source Control action', messageOf(cause), { kind: 'error' })
      }
    })
  }

  const onToggleCommit = (commit: GitCommit) => {
    onRequestHistoryControl('toggle-commit', { commit: commit.oid, open: !expanded.has(commit.oid) })
  }
  const onLoadMore = () => onRequestHistoryControl('load-more')

  return (
    <section className="ui-stack" data-section="history" style={{ gap: 'var(--ui-space-4)' }}>
      <SectionHeader
        title="Commits"
        actions={
          <IconButton label={`${open ? 'Collapse' : 'Expand'} Commits`} aria-expanded={open} onClick={onToggle}>
            {open ? '▾' : '▸'}
          </IconButton>
        }
      />
      {open && (
        <div className="ui-stack" data-history-content>
          {error !== null && <InlineError message={error} action={{ label: 'Retry', onAction: onRetryHistory }} />}
          {loading && history === null && error === null && <NoticeLine>Loading commits…</NoticeLine>}
          {history !== null && history.commits.length === 0 && <EmptyState message="No commits yet." />}
          <ul className="ui-stack" style={ROW_STYLE}>
            {history?.commits.map((commit) => (
              <CommitRow
                key={commit.oid}
                commit={commit}
                expanded={expanded.has(commit.oid)}
                files={files[commit.oid]}
                onToggle={() => onToggleCommit(commit)}
                onRetryFiles={() => onLoadFiles(commit, true)}
                onOpen={() => onOpenCommit(commit)}
                onOpenFile={(change) => onOpenFile(commit, change)}
              />
            ))}
          </ul>
          {history?.hasMore && (limit ?? 0) < MAX_LIMIT && <Button onClick={onLoadMore}>Load more</Button>}
        </div>
      )}
    </section>
  )
}

type CommitRowProps = {
  commit: GitCommit
  expanded: boolean
  files: Files | undefined
  onToggle(): void
  onRetryFiles(): void
  onOpen(): void
  onOpenFile(change: GitChange): void
}

function CommitRow({ commit, expanded, files, onToggle, onRetryFiles, onOpen, onOpenFile }: CommitRowProps) {
  const items = useMemo<RowItem[]>(() => {
    if (!files || !('entries' in files)) return []
    return files.entries.map((change) => ({ key: change.path, path: change.path, oldPath: change.oldPath, letter: letterOf(change.status), added: change.added, removed: change.removed }))
  }, [files])
  const handlers = useMemo<RowHandlers>(
    () => ({
      click: (item) => {
        if (!files || !('entries' in files)) return
        const change = files.entries.find((entry) => entry.path === item.path)
        if (change) onOpenFile(change)
      },
      contextMenu: () => {},
      buttons: () => [],
      dragText: (item) => item.path
    }),
    [files, onOpenFile]
  )
  return (
    <li data-commit-row title={commit.body || commit.subject}>
      <ListRow
        title={
          <span className="ui-stack" style={COMMIT_TITLE_STYLE}>
            <span style={COMMIT_SUBJECT_STYLE}>{commit.subject}</span>
            {commit.refs.length > 0 && (
              <span className="ui-cluster" style={COMMIT_REFS_STYLE}>
                {commit.refs.map((ref) => (
                  <span
                    key={ref}
                    className="ui-badge"
                    role="img"
                    aria-label={`Commit ref ${ref}`}
                    title={ref}
                    style={COMMIT_REF_STYLE}
                  >
                    <span style={COMMIT_REF_LABEL_STYLE}>{ref}</span>
                  </span>
                ))}
              </span>
            )}
          </span>
        }
        description={`${shortOid(commit.oid)} · ${commit.author} · ${relativeTime(commit.authoredAt)}`}
        status="done"
        statusLabel="Commit"
        trailing={
          <IconButton
            label={`${expanded ? 'Collapse' : 'Expand'} commit ${shortOid(commit.oid)}`}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? '▾' : '▸'}
          </IconButton>
        }
        onClick={onOpen}
      />
      {expanded && (
        files === undefined || 'loading' in files ? (
          <NoticeLine>Loading files…</NoticeLine>
        ) : 'error' in files ? (
          <InlineError message={files.error} action={{ label: 'Retry', onAction: onRetryFiles }} />
        ) : files.entries.length === 0 ? (
          <EmptyState message="No files changed in this commit." />
        ) : (
          <Rows items={items} selected={NO_SELECTION} handlers={handlers} />
        )
      )}
    </li>
  )
}
