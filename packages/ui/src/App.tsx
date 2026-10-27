import { useShortcuts } from './components/useShortcuts'
import { ConfirmHost } from './components/ConfirmHost'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MainArea } from './components/MainArea'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { useAppState, usePluginHost, usePluginState } from './context'
import { CommandPalette } from './plugins/CommandPalette'
import { OverlayLayer } from './plugins/OverlayLayer'
import { PluginSlot } from './plugins/PluginSlot'
import { useRegion } from './plugins/useRegion'
import { useThemeVariables } from './plugins/useThemeVariables'

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

function PanelColumn({ id }: { id: string }) {
  const region = useRegion('panel')
  return (
    <aside className="scm-panel plugin-panel" {...region}>
      <PluginSlot key={id} id={id} />
    </aside>
  )
}

export function App() {
  const state = useAppState()
  const { model, layout } = usePluginState()
  const host = usePluginHost()
  useShortcuts()
  useThemeVariables()

  if (state.connection === 'no-token') return <NoToken />

  const panel = layout.panel !== null && model?.panels.some((candidate) => candidate.id === layout.panel) ? layout.panel : null
  const statusBars = model?.statusBars ?? []
  return (
    <div className="app">
      <ConnectionBanner />
      <div className={`layout${panel !== null ? ' with-panel' : ''}${layout.sidebar ? '' : ' no-sidebar'}`}>
        <Sidebar />
        <MainArea />
        {panel !== null && <PanelColumn id={panel} />}
      </div>
      {statusBars.length > 0 && (
        <div className="plugin-status-bar" data-region="status-bar" aria-label="Plugin status bar">
          {statusBars.map((entry) => <PluginSlot key={entry.id} id={entry.id} />)}
        </div>
      )}
      <OverlayLayer />
      {layout.palette === true && <CommandPalette onClose={() => host.setPalette(false)} />}
      <Toasts />
      <ConfirmHost />
    </div>
  )
}
