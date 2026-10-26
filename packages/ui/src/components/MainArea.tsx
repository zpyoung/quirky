import { useEffect, useRef } from 'react'
import { createSession } from '../actions'
import { AskCards } from '../asks/AskCards'
import { useAppState, useConnection, useDispatch, usePluginHost, usePluginState } from '../context'
import { sessionsOf } from '../lib/state'
import { PanelToggles } from '../plugins/PanelToggles'
import { PluginSlot } from '../plugins/PluginSlot'
import { SessionTabs } from './SessionTabs'
import { SessionView } from './SessionView'

export function MainArea() {
  const state = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const host = usePluginHost()
  const { openView, openPanel } = usePluginState()
  const worktree = state.worktrees.find((w) => w.id === state.selectedWorktreeId)
  const sessions = sessionsOf(state, state.selectedWorktreeId)
  const session = sessions.find((s) => s.id === state.selectedSessionId)

  const selectedSessionId = state.selectedSessionId
  const previousSession = useRef(selectedSessionId)
  useEffect(() => {
    if (previousSession.current !== selectedSessionId) host.closeView()
    previousSession.current = selectedSessionId
  }, [host, selectedSessionId])

  const toggleScm = () => {
    if (!state.scmOpen && openPanel !== null) host.togglePanel(openPanel, false)
    dispatch({ type: 'toggleScm' })
  }

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
          onClick={toggleScm}
        >
          Source control
        </button>
        <PanelToggles />
      </div>
      {worktree && <SessionTabs worktree={worktree} sessions={sessions} />}
      <div className="main-body">
        {openView && <PluginSlot key={openView.id} id={openView.id} input={openView.input} />}
        {!openView && !worktree && <p className="empty">Add a repo and pick a worktree to get started.</p>}
        {!openView && worktree && !session && (
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
        {!openView && session && <SessionView key={session.id} session={session} />}
        <AskCards />
      </div>
    </main>
  )
}
