import { useEffect, useState, useSyncExternalStore } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { WorktreeSessions } from './model'
import { SessionTabs } from './SessionTabs'
import { SessionView } from './SessionView'

type Connection = { connected: boolean; epoch: number }

/** Connection state of the window; `epoch` changes on each reconnect so panes attach again. */
function useConnection(context: UiPluginContext): Connection {
  const [state, setState] = useState<Connection>({ connected: true, epoch: 0 })
  useEffect(
    () =>
      context.onConnection((status) =>
        setState((current) =>
          status === 'connected'
            ? { connected: true, epoch: current.connected ? current.epoch : current.epoch + 1 }
            : { ...current, connected: false }
        )
      ),
    [context]
  )
  return state
}

/** A worktree's header, session tabs and the active session. */
export function WorktreeView({
  context,
  store,
  themeSource
}: {
  context: UiPluginContext
  store: WorktreeSessions
  /** The element the view is mounted on, which carries the theme's custom properties. */
  themeSource: Element
}) {
  const { status, worktree, sessions, active } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { connected, epoch } = useConnection(context)

  return (
    <>
      <div className="main-header">
        <div className="main-title">
          {worktree ? (
            <>
              <strong>{worktree.name}</strong>
              <span className="muted path">{worktree.path}</span>
            </>
          ) : (
            <span className="muted">{status === 'missing' ? 'Worktree not found' : 'Quirky'}</span>
          )}
        </div>
      </div>
      {worktree && <SessionTabs store={store} sessions={sessions} active={active} />}
      <div className="main-body">
        {status === 'ready' && !active && (
          <div className="empty">
            <p>No sessions in this worktree.</p>
            <button className="primary" onClick={() => void store.create('shell', '', false)}>
              New shell
            </button>
          </div>
        )}
        {active && (
          <SessionView
            key={`${active.id}:${epoch}`}
            context={context}
            themeSource={themeSource}
            session={active}
            connected={connected}
            onClose={() => void store.close(active)}
          />
        )}
      </div>
    </>
  )
}
