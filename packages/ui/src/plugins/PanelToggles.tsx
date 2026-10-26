import { usePluginHost, usePluginState } from '../context'

/** One header button per plugin panel; the open panel's button is pressed. */
export function PanelToggles() {
  const host = usePluginHost()
  const { model, openPanel } = usePluginState()
  return (
    <>
      {(model?.panels ?? []).map((panel) => (
        <button
          key={panel.id}
          className={openPanel === panel.id ? 'active' : ''}
          aria-pressed={openPanel === panel.id}
          onClick={() => host.togglePanel(panel.id)}
        >
          {panel.title}
        </button>
      ))}
    </>
  )
}
