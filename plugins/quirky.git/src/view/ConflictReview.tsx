import { useEffect, useRef, useState } from 'react'
import type { GitConflictKind, GitStatus } from '@quirky/protocol'
import { DIFF_VIEW_ID, PANEL_ID } from '../shared/view-input'
import { messageOf } from './data'
import { ErrorNotice } from './Fallbacks'
import type { ModeProps } from './types'

/** How a snapshotted conflict stands now. */
export type ReviewState = 'unresolved' | 'resolved' | 'gone'

type Row = { path: string; kind: GitConflictKind; state: ReviewState }

const BADGE: Record<ReviewState, string> = { unresolved: 'Unresolved', resolved: 'Resolved', gone: 'Gone' }

type Status = Pick<GitStatus, 'entries'>

/** The conflicted paths in `status`, as the review's snapshot. */
export function snapshotOf(status: Status): Array<{ path: string; kind: GitConflictKind }> {
  return status.entries
    .filter((entry) => entry.area === 'conflicts' && entry.conflict)
    .map((entry) => ({ path: entry.path, kind: entry.conflict!.kind }))
}

/**
 * How each snapshotted path stands in `status`: unresolved while git still lists it as an
 * unresolved conflict, resolved once it is listed as resolved locally or has any other change,
 * gone when it was removed. A path with no row at all is asked about with `onDisk`.
 */
export async function reviewStates(
  snapshot: ReadonlyArray<{ path: string; kind: GitConflictKind }>,
  status: Status,
  onDisk: (path: string) => Promise<boolean>
): Promise<Row[]> {
  return Promise.all(
    snapshot.map(async ({ path, kind }): Promise<Row> => {
      const rows = status.entries.filter((entry) => entry.path === path)
      if (rows.some((row) => row.area === 'conflicts' && row.conflict?.state === 'unresolved')) {
        return { path, kind, state: 'unresolved' }
      }
      if (rows.some((row) => row.area === 'conflicts')) return { path, kind, state: 'resolved' }
      if (rows.some((row) => row.status === 'deleted')) return { path, kind, state: 'gone' }
      if (rows.length > 0) return { path, kind, state: 'resolved' }
      return { path, kind, state: (await onDisk(path)) ? 'resolved' : 'gone' }
    })
  )
}

/**
 * The conflict review: a snapshot of the conflicts at open, with a Resolved / Gone badge as they
 * are dealt with. Refresh re-reads git; nothing here changes the repository.
 */
export function ConflictReview({ context, input, report, bind, close }: ModeProps) {
  const worktree = input.worktree
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [capturedAt, setCapturedAt] = useState<Date | null>(null)
  const snapshot = useRef<Array<{ path: string; kind: GitConflictKind }> | null>(null)

  const readStatus = async () => (await context.call('quirky.git/status', { worktree })) as GitStatus

  const onDisk = async (path: string): Promise<boolean> => {
    try {
      const file = (await context.call('quirky.git/conflictFile', { worktree, path })) as { content: string | null }
      return file.content !== null
    } catch {
      return true
    }
  }

  const refresh = async () => {
    try {
      const status = await readStatus()
      if (snapshot.current === null) {
        snapshot.current = snapshotOf(status)
        setCapturedAt(new Date())
      }
      setRows(await reviewStates(snapshot.current, status, onDisk))
      setError(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  bind({})

  const unresolved = rows?.filter((row) => row.state === 'unresolved').length ?? 0
  useEffect(() => {
    report({
      mode: 'conflicts',
      source: null,
      path: null,
      area: null,
      commit: null,
      changes: 0,
      currentChange: null,
      dirty: false,
      stale: false,
      tooLarge: false,
      conflicts: unresolved,
      currentConflict: null
    })
  }, [unresolved, report])

  const allResolved = rows !== null && rows.length > 0 && unresolved === 0
  return (
    <div className="qgv-review">
      <header className="qgv-bar">
        <strong className="qgv-title">Conflict review</strong>
        <span className="qgv-spacer" />
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
        <button type="button" aria-label="Close" title="Close" onClick={close}>
          ✕
        </button>
      </header>
      <div className="qgv-split">
        <nav className="qgv-tree qgv-review-files" aria-label="Files">
          <h3>Files</h3>
          {rows !== null && rows.length === 0 && <p className="qgv-muted">No conflicts in this snapshot.</p>}
          {rows?.map((row) => (
            <div key={row.path} className="qgv-review-row">
              <span className="qgv-path" title={row.path}>
                {row.path}
              </span>
              <span className={`qgv-badge qgv-badge-${row.state}`}>{BADGE[row.state]}</span>
              {row.state === 'unresolved' && (
                <button
                  type="button"
                  onClick={() => context.openView(DIFF_VIEW_ID, { worktree, mode: 'conflict-file', path: row.path })}
                >
                  Open
                </button>
              )}
            </div>
          ))}
        </nav>
        <div className="qgv-scroll qgv-pad">
          {error !== null && <ErrorNotice message={error} subject="conflicts" />}
          {rows === null && error === null && <p className="qgv-muted">Loading conflicts...</p>}
          {rows !== null && !allResolved && (
            <p>
              {`${unresolved} unresolved conflict${unresolved === 1 ? '' : 's'}`}
              {capturedAt && ` · Snapshot captured at ${capturedAt.toLocaleTimeString()}.`}
            </p>
          )}
          {allResolved && (
            <div className="qgv-notice">
              <strong>All conflicts resolved</strong>
              <p>This review snapshot no longer has any live unresolved conflicts.</p>
              <button type="button" onClick={() => context.togglePanel(PANEL_ID, true)}>
                Source Control
              </button>
              <button type="button" onClick={close}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
