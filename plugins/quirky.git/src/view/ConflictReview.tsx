import { useEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState, IconButton, ListRow, SectionHeader } from '@quirky/ui'
import type { GitConflictKind, GitStatus } from '@quirky/protocol'
import { DIFF_VIEW_ID, PANEL_ID, diffViewKey, type ReviewSnapshot } from '../shared/view-input'
import { messageOf } from './data'
import { openHostedDiff } from './hosted-tabs'
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
      if (rows.some((row) => row.area !== 'conflicts' && row.status === 'deleted')) return { path, kind, state: 'gone' }
      if (rows.some((row) => row.area === 'conflicts')) return { path, kind, state: 'resolved' }
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
  const [capturedAt, setCapturedAt] = useState<Date | null>(input.review ? new Date(input.review.capturedAt) : null)
  const snapshot = useRef<ReviewSnapshot['entries'] | null>(input.review?.entries ?? null)

  const readStatus = async () => (await context.call('quirky.git/status', { worktree })) as GitStatus

  const onDisk = async (path: string): Promise<boolean> => {
    try {
      const file = (await context.call('quirky.git/conflictFile', { worktree, path, peek: true })) as { content: string | null }
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

  const openConflictFile = async (path: string) => {
    const review: ReviewSnapshot = { entries: snapshot.current ?? [], capturedAt: capturedAt?.getTime() ?? Date.now() }
    try {
      if (input.groupId && input.tabId) {
        const { workspace } = (await context.call('quirky.terminal/workspace', {
          workspace: `id:${worktree}`
        })) as { workspace: { revision: number } }
        await context.call('quirky.terminal/rekeyViewTabs', {
          workspace: `id:${worktree}`,
          viewId: DIFF_VIEW_ID,
          changes: [{
            tab: input.tabId,
            key: diffViewKey(input),
            input: { ...input, review } as unknown as Record<string, unknown>
          }],
          revision: workspace.revision
        })
      }
      await openHostedDiff(context, {
        worktree, mode: 'conflict-file', path, groupId: input.groupId, preview: false, review
      })
    } catch (error) {
      context.toast('Could not open diff', messageOf(error))
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
    <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <SectionHeader
        title="Conflict review"
        actions={
          <div className="ui-cluster">
            <Button onClick={() => void refresh()}>Refresh</Button>
            <IconButton label="Close" title="Close" onClick={close}>×</IconButton>
          </div>
        }
      />
      <div className="ui-cluster" style={{ alignItems: 'stretch', flexWrap: 'nowrap', flex: 1, minHeight: 0, minWidth: 0 }}>
        <nav aria-label="Files" className="ui-stack" style={{ flex: '0 0 22%', minHeight: 0, overflow: 'auto', padding: 'var(--ui-space-8)' }}>
          <SectionHeader title="Files" />
          {rows !== null && rows.length === 0 && <EmptyState message="No conflicts in this snapshot." />}
          {rows?.map((row) => (
            <div key={row.path} data-path={row.path}>
              <ListRow
                title={row.path}
                status={row.state === 'unresolved' ? 'needs-you' : row.state === 'resolved' ? 'done' : 'idle'}
                trailing={
                  <div className="ui-cluster">
                    <Badge tone={row.state === 'unresolved' ? 'needs-you' : row.state === 'resolved' ? 'accent' : 'neutral'}>{BADGE[row.state]}</Badge>
                    {row.state === 'unresolved' && (
                      <Button
                        onClick={() => void openConflictFile(row.path)}
                      >
                        Open
                      </Button>
                    )}
                  </div>
                }
              />
            </div>
          ))}
        </nav>
        <div className="ui-stack" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', padding: 'var(--ui-space-12)' }}>
          {error !== null && <ErrorNotice message={error} subject="conflicts" />}
          {rows === null && error === null && <p className="ui-text-muted">Loading conflicts...</p>}
          {rows !== null && !allResolved && (
            <p>
              {`${unresolved} unresolved conflict${unresolved === 1 ? '' : 's'}`}
              {capturedAt && ` · Snapshot captured at ${capturedAt.toLocaleTimeString()}.`}
            </p>
          )}
          {allResolved && (
            <section className="ui-stack" role="region" aria-label="All conflicts resolved">
              <Badge tone="accent">All conflicts resolved</Badge>
              <p>This review snapshot no longer has any live unresolved conflicts.</p>
              <div className="ui-cluster">
                <Button onClick={() => context.togglePanel(PANEL_ID, true)}>Source Control</Button>
                <Button onClick={close}>Dismiss</Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
