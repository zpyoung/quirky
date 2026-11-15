import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, IconButton, InlineError, ListRow, NoticeLine, SectionHeader } from '@quirky/ui'
import type { GitChange, GitCommit, GitHistory, UiPluginContext } from '@quirky/protocol'
import { messageOf, relativeTime, shortOid } from './format'
import { letterOf, Rows, type RowHandlers, type RowItem } from './Rows'

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

/** The collapsed-by-default "Commits" dock: recent commits from HEAD, each expandable to its files. */
export function HistoryDock({ context, worktree, open, onToggle, head, onOpenCommit, onOpenFile }: Props) {
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [files, setFiles] = useState<Readonly<Record<string, Files>>>({})
  const pendingFiles = useRef(new Set<string>())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    context
      .call('quirky.git/history', limit === null ? { worktree } : { worktree, limit })
      .then((result) => {
        if (cancelled) return
        setHistory(result as GitHistory)
        setError(null)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(messageOf(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [context, worktree, open, limit, head, retryVersion])

  const onRetryHistory = () => {
    setError(null)
    setLoading(true)
    setRetryVersion((version) => version + 1)
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

  const toggleCommit = (commit: GitCommit) => {
    const next = new Set(expanded)
    if (next.has(commit.oid)) next.delete(commit.oid)
    else {
      next.add(commit.oid)
      onLoadFiles(commit)
    }
    setExpanded(next)
  }

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
                onToggle={() => toggleCommit(commit)}
                onRetryFiles={() => onLoadFiles(commit, true)}
                onOpen={() => onOpenCommit(commit)}
                onOpenFile={(change) => onOpenFile(commit, change)}
              />
            ))}
          </ul>
          {history?.hasMore && (limit ?? 0) < MAX_LIMIT && <Button onClick={() => setLimit(MAX_LIMIT)}>Load more</Button>}
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
