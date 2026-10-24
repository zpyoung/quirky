import { useShortcuts } from './components/useShortcuts'
import { ConfirmHost } from './components/ConfirmHost'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MainArea } from './components/MainArea'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { useAppState } from './context'
import { SourceControl } from './scm/SourceControl'

function NoToken() {
  return (
    <div className="fullscreen-message">
      <h1>Not connected</h1>
      <p>
        This page needs an access token. Open Quirky from the desktop app, or use the URL the daemon
        prints, which ends in <code>#token=…</code>.
      </p>
    </div>
  )
}

export function App() {
  const state = useAppState()
  useShortcuts()

  if (state.connection === 'no-token') return <NoToken />

  return (
    <div className="app">
      <ConnectionBanner />
      <div className={`layout${state.scmOpen ? ' with-scm' : ''}`}>
        <Sidebar />
        <MainArea />
        {state.scmOpen && state.selectedWorktreeId && (
          <aside className="scm-panel">
            <SourceControl key={state.selectedWorktreeId} worktreeId={state.selectedWorktreeId} />
          </aside>
        )}
      </div>
      <Toasts />
      <ConfirmHost />
    </div>
  )
}
