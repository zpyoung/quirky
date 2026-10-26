import { useEffect, useState } from 'react'
import { useShortcuts } from './components/useShortcuts'
import { ConfirmHost } from './components/ConfirmHost'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MainArea } from './components/MainArea'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { useAppState, useDispatch, usePluginState } from './context'
import { CommandPalette } from './plugins/CommandPalette'
import { PluginSlot } from './plugins/PluginSlot'
import { useThemeVariables } from './plugins/useThemeVariables'
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
  const dispatch = useDispatch()
  const { openPanel } = usePluginState()
  const [paletteOpen, setPaletteOpen] = useState(false)
  useShortcuts(() => setPaletteOpen((open) => !open))
  useThemeVariables()

  // a plugin can open a panel itself, so the exclusion with source control is enforced here
  useEffect(() => {
    if (openPanel !== null && state.scmOpen) dispatch({ type: 'setScm', open: false })
  }, [openPanel, state.scmOpen, dispatch])

  if (state.connection === 'no-token') return <NoToken />

  return (
    <div className="app">
      <ConnectionBanner />
      <div className={`layout${state.scmOpen || openPanel !== null ? ' with-scm' : ''}`}>
        <Sidebar />
        <MainArea />
        {openPanel !== null ? (
          <aside className="scm-panel plugin-panel">
            <PluginSlot key={openPanel} id={openPanel} />
          </aside>
        ) : (
          state.scmOpen &&
          state.selectedWorktreeId && (
            <aside className="scm-panel">
              <SourceControl key={state.selectedWorktreeId} worktreeId={state.selectedWorktreeId} />
            </aside>
          )
        )}
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <Toasts />
      <ConfirmHost />
    </div>
  )
}
