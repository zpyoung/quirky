import { usePluginHost, usePluginState } from '../context'

/** One header button per plugin panel; the open panel's button is pressed, and a panel's count shows beside its title. */
export function PanelToggles() {
  const host = usePluginHost()
  const { model, layout, badges, badgeTitles } = usePluginState()
  return (
    <>
      {(model?.panels ?? []).map((panel) => {
        const count = badges[panel.id]
        return (
          <button
            key={panel.id}
            className={layout.panel === panel.id ? 'active' : ''}
            aria-pressed={layout.panel === panel.id}
            onClick={() => host.togglePanel(panel.id)}
          >
            {panel.title}
            {count !== undefined && count > 0 && (
              <span className="badge" title={badgeTitles[panel.id] ?? `${count} waiting`}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </>
  )
}
