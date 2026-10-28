import { usePluginState } from '../context'
import { PluginSlot } from './PluginSlot'

/** The public activity-item contributions, mounted independently of the open panel. */
export function ActivityItems() {
  const items = usePluginState().model?.activityItems ?? []
  if (items.length === 0) return null
  return (
    <nav className="activity-items" aria-label="Activity items">
      {items.map((item) => (
        <PluginSlot key={item.id} id={item.id} />
      ))}
    </nav>
  )
}
