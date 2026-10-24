import { createSession } from '../actions'
import { AskCards } from '../asks/AskCards'
import { useAppState, useConnection, useDispatch } from '../context'
import { sessionsOf } from '../lib/state'
import { SessionTabs } from './SessionTabs'
import { SessionView } from './SessionView'

export function MainArea() {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const worktree = state.worktrees.find((w) => w.id === state.selectedWorktreeId)
  const sessions = sessionsOf(state, state.selectedWorktreeId)
  const session = sessions.find((s) => s.id === state.selectedSessionId)

  return (
    <main className="main">
      <div className="main-header">
        <div className="main-title">
          {worktree ? (
            <>
              <strong>{worktree.name}</strong>
              <span className="muted path">{worktree.path}</span>
            </>
          ) : (
            <span className="muted">Quirky</span>
          )}
        </div>
        <button
          className={state.scmOpen ? 'active' : ''}
          disabled={!worktree}
          aria-pressed={state.scmOpen}
          onClick={() => dispatch({ type: 'toggleScm' })}
        >
          Source control
        </button>
      </div>
      {worktree && <SessionTabs worktree={worktree} sessions={sessions} />}
      <div className="main-body">
        {!worktree && <p className="empty">Add a repo and pick a worktree to get started.</p>}
        {worktree && !session && (
          <div className="empty">
            <p>No sessions in this worktree.</p>
            <button
              className="primary"
              onClick={() => void createSession(connection, worktree.id, 'shell', '', false)}
            >
              New shell
            </button>
          </div>
        )}
        {session && <SessionView key={session.id} session={session} />}
        <AskCards />
      </div>
    </main>
  )
}
