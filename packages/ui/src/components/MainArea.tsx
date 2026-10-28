import { usePluginState } from '../context'
import { PanelToggles } from '../plugins/PanelToggles'
import { PluginSlot } from '../plugins/PluginSlot'
import { useRegion } from '../plugins/useRegion'

/** The view title and the main view, with legacy-inline panel controls when no activity position is configured. */
export function MainArea() {
  const { model, layout, windowRoute } = usePluginState()
  const region = useRegion('view')
  const viewId = windowRoute ? windowRoute.view ?? undefined : layout.view?.id
  const view = viewId ? model?.views.find((candidate) => candidate.id === viewId) : undefined
  const input = windowRoute ? windowRoute.input : layout.view?.input

  return (
    <main className="main" {...region}>
      <div className="main-header">
        <div className="main-title">
          {windowRoute?.title ? <strong>{windowRoute.title}</strong> : view ? <strong>{view.title}</strong> : <span className="muted">{windowRoute ? 'Auxiliary window' : 'Quirky'}</span>}
        </div>
        {!windowRoute && layout.activityBarPosition === undefined && <PanelToggles />}
      </div>
      <div className="main-body">
        {view && <PluginSlot key={windowRoute ? `${windowRoute.windowId}:${view.id}` : view.id} id={view.id} input={input} />}
        {windowRoute && model && !view && (
          <p className="empty" role="alert">
            {windowRoute.view === null ? 'No view is open in this auxiliary window.' : `The requested view ${windowRoute.view} is unavailable.`}
          </p>
        )}
        {!windowRoute && !view && model && (
          <p className="empty">
            {model.views.length === 0 ? 'Nothing to show here.' : 'Add a repo and pick a worktree to get started.'}
          </p>
        )}
      </div>
    </main>
  )
}
