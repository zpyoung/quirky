import { useEffect, useMemo, useState } from 'react'
import type { GitChange, GitCommit, GitHistory, UiPluginContext } from '@quirky/protocol'
import { messageOf, relativeTime, shortOid } from './format'
import { Rows, type RowHandlers, type RowItem } from './Rows'

const MAX_LIMIT = 200
const NO_SELECTION: readonly string[] = []
const NO_DIRS: ReadonlySet<string> = new Set()

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
    <section className="scm-section scm-dock" data-section="history">
      <header className="scm-section-head">
        <button type="button" className="scm-section-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="scm-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="scm-section-title">Commits</span>
        </button>
      </header>
      {open && (
        <div className="scm-history">
          {error !== null && <p className="scm-error">{error}</p>}
          {history !== null && history.commits.length === 0 && <p className="muted scm-pad">No commits yet.</p>}
          <ul className="scm-rows">
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
          {history?.hasMore && (limit ?? 0) < MAX_LIMIT && (
            <button type="button" className="scm-load-more" onClick={() => setLimit(MAX_LIMIT)}>
              Load more
            </button>
          )}
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
    () => ('entries' in (files ?? {}) ? (files as { entries: GitChange[] }).entries : []).map((c) => ({ key: c.path, path: c.path, oldPath: c.oldPath, status: c.status, added: c.added, removed: c.removed })),
    [files]
  )
  const handlers = useMemo<RowHandlers>(
    () => ({
      click: (item) => {
        const change = (files as { entries: GitChange[] }).entries.find((c) => c.path === item.path)
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
    <li className="scm-commit">
      <div className="scm-row">
        <button type="button" className="icon-button" aria-label={`${expanded ? 'Collapse' : 'Expand'} commit ${shortOid(commit.oid)}`} aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '▾' : '▸'}
        </button>
        <button type="button" className="scm-row-main" title={commit.body || commit.subject} onClick={onOpen}>
          <span className="scm-row-text">
            <span className="scm-row-line">
              <span className="scm-row-name">{commit.subject}</span>
              {commit.refs.map((ref) => (
                <span key={ref} className="scm-ref">
                  {ref}
                </span>
              ))}
            </span>
            <span className="scm-row-sub">{`${shortOid(commit.oid)} · ${commit.author} · ${relativeTime(commit.authoredAt)}`}</span>
          </span>
        </button>
      </div>
      {expanded && files !== undefined && (
        'error' in files ? (
          <p className="scm-error">{files.error}</p>
        ) : (
          <Rows scope={`commit:${commit.oid}`} items={items} viewMode="list" collapsedDirs={NO_DIRS} onToggleDir={() => {}} selected={NO_SELECTION} handlers={handlers} />
        )
      )}
    </li>
  )
}
