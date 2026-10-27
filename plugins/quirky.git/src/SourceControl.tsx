import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitDiffPair, GitStatusSummary, UiPluginContext } from '@quirky/protocol'
import { keepSelection, reuseDiff, type DiffSelection } from './diffRefresh'
import { scmReport, splitFiles, worktreeOf, type ScmReport } from './scm'
import { CommitBox } from './CommitBox'
import { DiffView } from './DiffView'
import { FileList, fileKey } from './FileList'

const POLL_MS = 3000

type Props = { context: UiPluginContext; report: (state: ScmReport) => void }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const isFolderRefusal = (error: unknown): boolean => (error as { data?: { reason?: unknown } } | null)?.data?.reason === 'folder-workspace'

/** Source control for the worktree the open view shows; follows the layout as the view changes. */
export function SourceControl({ context, report }: Props) {
  const [layout, setLayout] = useState(() => context.getLayout())
  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])

  const worktree = worktreeOf(layout)
  useEffect(() => {
    if (worktree === null) report(scmReport(null, null))
  }, [worktree, report])

  if (worktree === null) {
    return (
      <div className="scm">
        <div className="scm-header">
          <strong>Source control</strong>
        </div>
        <p className="muted pad">Pick a worktree to see its changes</p>
      </div>
    )
  }
  return <WorktreeChanges key={worktree} context={context} worktree={worktree} report={report} />
}

/** Changes of one worktree: polls `quirky.git/status` while mounted and shows a diff for the chosen file. */
function WorktreeChanges({ context, worktree, report }: Props & { worktree: string }) {
  const [status, setStatus] = useState<GitStatusSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const [diff, setDiff] = useState<GitDiffPair | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus((await context.call('quirky.git/status', { worktree })) as GitStatusSummary)
      setError(null)
      setUnavailable(null)
    } catch (e) {
      if (isFolderRefusal(e)) setUnavailable(message(e))
      else setError(message(e))
    }
  }, [context, worktree])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/changed') void refresh()
    })
    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [context, refresh])

  const { staged, unstaged } = useMemo(() => splitFiles(status?.files ?? []), [status])

  useEffect(() => {
    report(scmReport(worktree, status))
  }, [report, worktree, status])

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
    context
      .call('quirky.git/diff', { worktree, path: selectionPath, staged: selectionStaged })
      .then((result) => {
        if (!cancelled) setDiff((prev) => reuseDiff(prev, result as GitDiffPair))
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(message(e))
      })
    return () => {
      cancelled = true
    }
  }, [context, worktree, selectionPath, selectionStaged, status])

  const attempt = async (method: string, params: Record<string, unknown>, title: string) => {
    try {
      return await context.call(method, { worktree, ...params })
    } catch (e) {
      context.toast(title, message(e))
      return undefined
    }
  }

  const toggle = (method: 'quirky.git/stage' | 'quirky.git/unstage') => async (paths: string[]) => {
    await attempt(method, { paths }, 'Git failed')
    await refresh()
  }

  const commit = async (text: string): Promise<boolean> => {
    const result = await attempt('quirky.git/commit', { message: text }, 'Commit failed')
    await refresh()
    return result !== undefined
  }

  const selectedKey = selection ? fileKey(selection.path, selection.staged) : null

  if (unavailable !== null) {
    return (
      <div className="scm">
        <div className="scm-header">
          <strong>Source control</strong>
        </div>
        <p className="muted pad scm-unavailable">{unavailable}</p>
      </div>
    )
  }

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
          onToggle={toggle('quirky.git/unstage')}
        />
        <FileList
          title="Changes"
          files={unstaged}
          staged={false}
          selectedKey={selectedKey}
          onSelect={(file) => setSelection({ path: file.path, staged: false })}
          onToggle={toggle('quirky.git/stage')}
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
