import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, EmptyState, IconButton, ListRow, SectionHeader } from '@quirky/ui'
import type { GitChange, GitCommit, GitHistory, UiPluginContext } from '@quirky/protocol'
import { messageOf, relativeTime, shortOid } from './format'
import { Rows, type RowHandlers, type RowItem } from './Rows'

const MAX_LIMIT = 200
const NO_SELECTION: readonly string[] = []
const NO_DIRS: ReadonlySet<string> = new Set()
const ROW_STYLE = { gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 } as const

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

type Files = { entries: GitChange[] } | { error: string }

/** The collapsed-by-default "Commits" dock: recent commits from HEAD, each expandable to its files. */
export function HistoryDock({ context, worktree, open, onToggle, head, onOpenCommit, onOpenFile }: Props) {
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [files, setFiles] = useState<Readonly<Record<string, Files>>>({})

  useEffect(() => {
    if (!open) return
    let cancelled = false
    context
      .call('quirky.git/history', limit === null ? { worktree } : { worktree, limit })
      .then((result) => {
        if (cancelled) return
        setHistory(result as GitHistory)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageOf(e))
      })
    return () => {
      cancelled = true
    }
  }, [context, worktree, open, limit, head])

  const toggleCommit = (commit: GitCommit) => {
    const next = new Set(expanded)
    if (next.has(commit.oid)) next.delete(commit.oid)
    else {
      next.add(commit.oid)
      if (!files[commit.oid]) {
        context
          .call('quirky.git/commitFiles', { worktree, commit: commit.oid })
          .then((result) => setFiles((prev) => ({ ...prev, [commit.oid]: { entries: (result as { entries: GitChange[] }).entries } })))
          .catch((e: unknown) => setFiles((prev) => ({ ...prev, [commit.oid]: { error: messageOf(e) } })))
      }
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
          {error !== null && <p role="alert" style={{ color: 'var(--ui-failing)' }}>{error}</p>}
          {history !== null && history.commits.length === 0 && <EmptyState message="No commits yet." />}
          <ul className="ui-stack" style={ROW_STYLE}>
            {history?.commits.map((commit) => (
              <CommitRow
                key={commit.oid}
                commit={commit}
                expanded={expanded.has(commit.oid)}
                files={files[commit.oid]}
                onToggle={() => toggleCommit(commit)}
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
  onOpen(): void
  onOpenFile(change: GitChange): void
}

function CommitRow({ commit, expanded, files, onToggle, onOpen, onOpenFile }: CommitRowProps) {
  const items = useMemo<RowItem[]>(
    () => ('entries' in (files ?? {}) ? (files as { entries: GitChange[] }).entries : []).map((change) => ({ key: change.path, path: change.path, oldPath: change.oldPath, status: change.status, added: change.added, removed: change.removed })),
    [files]
  )
  const handlers = useMemo<RowHandlers>(
    () => ({
      click: (item) => {
        const change = (files as { entries: GitChange[] }).entries.find((entry) => entry.path === item.path)
        if (change) onOpenFile(change)
      },
      contextMenu: () => {},
      buttons: () => [],
      folderButtons: () => [],
      dragText: (item) => item.path
    }),
    [files, onOpenFile]
  )
  return (
    <li data-commit-row title={commit.body || commit.subject}>
      <ListRow
        title={
          <span className="ui-cluster" style={{ flexWrap: 'nowrap' }}>
            <span>{commit.subject}</span>
            {commit.refs.map((ref) => <Badge key={ref} tone="accent" label={`Commit ref ${ref}`}>{ref}</Badge>)}
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
      {expanded && files !== undefined && (
        'error' in files ? (
          <p role="alert" style={{ color: 'var(--ui-failing)' }}>{files.error}</p>
        ) : (
          <Rows scope={`commit:${commit.oid}`} items={items} viewMode="list" collapsedDirs={NO_DIRS} onToggleDir={() => {}} selected={NO_SELECTION} handlers={handlers} />
        )
      )}
    </li>
  )
}
