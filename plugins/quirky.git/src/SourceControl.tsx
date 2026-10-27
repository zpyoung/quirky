import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { EMPTY_REPORT, worktreeOf, type ScmReport } from './scm'
import { addNotice, Notices, type Notice, type ShownNotice } from './panel/Notices'
import { WorktreePanel } from './panel/WorktreePanel'

type Props = { context: UiPluginContext; report: (state: ScmReport) => void }

/**
 * Source control for the worktree the open view shows; follows the layout as the view changes.
 * It outlives the per-worktree panel, so notices, commit drafts and the once-per-worktree
 * .gitignore offer survive switching worktrees.
 */
export function SourceControl({ context, report }: Props) {
  const [layout, setLayout] = useState(() => context.getLayout())
  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])

  const [notices, setNotices] = useState<ShownNotice[]>([])
  const seq = useRef(0)
  const notify = useCallback((notice: Notice) => setNotices((list) => addNotice(list, notice, ++seq.current)), [])
  const dismiss = useCallback((id: string) => setNotices((list) => list.filter((n) => n.id !== id)), [])
  const drafts = useRef(new Map<string, string>())
  const store = useRef({ get: (worktree: string) => drafts.current.get(worktree) ?? '', set: (worktree: string, text: string) => void drafts.current.set(worktree, text) })
  const offered = useRef(new Set<string>())

  const worktree = worktreeOf(layout)
  useEffect(() => {
    if (worktree === null) {
      report(EMPTY_REPORT)
      context.setPanelBadge('panel:quirky.git/source-control', null)
    }
  }, [worktree, report, context])

  return (
    <div className="scm-root">
      {worktree === null ? (
        <div className="scm">
          <div className="scm-header">
            <strong>Source control</strong>
          </div>
          <p className="muted pad">Select a workspace to view changes</p>
        </div>
      ) : (
        <WorktreePanel
          key={worktree}
          context={context}
          worktree={worktree}
          report={report}
          notify={notify}
          drafts={store.current}
          offered={offered.current}
        />
      )}
      <Notices notices={notices} current={worktree} onDismiss={dismiss} />
    </div>
  )
}
