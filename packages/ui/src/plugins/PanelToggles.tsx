import { usePluginHost, usePluginState } from '../context'

/** One activity control per panel; the open panel's button is pressed and badges show beside its title. */
export function PanelToggles({ vertical = false }: { vertical?: boolean }) {
  const host = usePluginHost()
  const { model, layout, badges } = usePluginState()
  return (
    <>
      {(model?.panels ?? []).map((panel) => {
        const count = badges[panel.id]
        return (
          <button
            key={panel.id}
            className={`panel-toggle${vertical ? ' panel-toggle-vertical' : ''}${layout.panel === panel.id ? ' active' : ''}`}
            aria-label={panel.title}
            title={panel.title}
            aria-pressed={layout.panel === panel.id}
            onClick={() => host.togglePanel(panel.id)}
          >
            {panel.title}
            {count !== undefined && count > 0 && (
              <span className="badge" title={`${count} waiting`}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </>
  )
}
