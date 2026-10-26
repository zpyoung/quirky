import { usePluginState } from '../context'
import { PluginSlot } from './PluginSlot'

/** The plugins' sidebar sections in model order; renders nothing when there are none. */
export function SidebarSections() {
  const sections = usePluginState().model?.sidebarSections ?? []
  if (sections.length === 0) return null
  return (
    <div className="sidebar-sections">
      {sections.map((section) => (
        <PluginSlot key={section.id} id={section.id} />
      ))}
    </div>
  )
}
