import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitDiff, GitStatus } from '@quirky/protocol'
import { useConnection } from '../context'
import { keepSelection, reuseDiff, type DiffSelection } from '../lib/diffRefresh'
import { splitFiles } from '../lib/scm'
import { CommitBox } from './CommitBox'
import { DiffView } from './DiffView'
import { FileList, fileKey } from './FileList'

const POLL_MS = 3000

/** Source control for one worktree: polls `git.status` while mounted and shows a diff for the chosen file. */
export function SourceControl({ worktreeId }: { worktreeId: string }) {
  const connection = useConnection()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await connection.call('git.status', { worktreeId }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [connection, worktreeId])

  useEffect(() => {
    setStatus(null)
    setSelection(null)
    setDiff(null)
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const { staged, unstaged } = useMemo(() => splitFiles(status?.files ?? []), [status])

  const selectionPath = selection?.path
  const selectionStaged = selection?.staged

  useEffect(() => {
    if (status && selection && !keepSelection(selection, staged, unstaged)) setSelection(null)
  }, [status, selection, staged, unstaged])

  useEffect(() => {
    if (selectionPath === undefined || selectionStaged === undefined) {
      setDiff(null)
      return
    }
    let cancelled = false
    connection
      .call('git.diff', { worktreeId, path: selectionPath, staged: selectionStaged })
      .then((result) => {
        if (!cancelled) setDiff((prev) => reuseDiff(prev, result))
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [connection, worktreeId, selectionPath, selectionStaged, status])

  const toggle = (method: 'git.stage' | 'git.unstage') => async (paths: string[]) => {
    await connection.attempt(method, { worktreeId, paths }, 'Git failed')
    await refresh()
  }

  const commit = async (message: string): Promise<boolean> => {
    const result = await connection.attempt('git.commit', { worktreeId, message }, 'Commit failed')
    await refresh()
    return result !== undefined
  }

  const selectedKey = selection ? fileKey(selection.path, selection.staged) : null

  return (
    <div className="scm">
      <div className="scm-header">
        <strong>Source control</strong>
        {status && (
          <span className="muted">
            {status.branch ?? 'detached'}
            {status.ahead > 0 && ` ↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
      </div>
      {error && <div className="scm-error">{error}</div>}
      <div className="scm-files">
        <FileList
          title="Staged"
          files={staged}
          staged
          selectedKey={selectedKey}
          onSelect={(file) => setSelection({ path: file.path, staged: true })}
          onToggle={toggle('git.unstage')}
        />
        <FileList
          title="Changes"
          files={unstaged}
          staged={false}
          selectedKey={selectedKey}
          onSelect={(file) => setSelection({ path: file.path, staged: false })}
          onToggle={toggle('git.stage')}
        />
        {status && status.files.length === 0 && <p className="muted pad">No changes.</p>}
      </div>
      <CommitBox canCommit={staged.length > 0} onCommit={commit} />
      <div className="scm-diff">
        {diff ? <DiffView diff={diff} /> : <p className="muted pad">Select a file to see its diff.</p>}
      </div>
    </div>
  )
}
