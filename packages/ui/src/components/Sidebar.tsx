import { useState } from 'react'
import { usePluginState } from '../context'
import { SidebarSections } from '../plugins/SidebarSections'
import { useRegion } from '../plugins/useRegion'
import { SettingsDialog } from './SettingsDialog'

/**
 * The left column: the plugins' sidebar sections while the layout shows the sidebar, and the
 * settings gear at the bottom either way.
 */
export function Sidebar() {
  const { layout } = usePluginState()
  const region = useRegion('sidebar')
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <aside className="sidebar" {...region}>
      <div className="sidebar-body">{layout.sidebar && <SidebarSections />}</div>
      <footer className="sidebar-footer">
        <button
          className="icon-button gear"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </footer>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </aside>
  )
}
