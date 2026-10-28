import { usePluginState } from '../context'
import { PanelToggles } from '../plugins/PanelToggles'
import { PluginSlot } from '../plugins/PluginSlot'
import { useRegion } from '../plugins/useRegion'

/** The view title and the main view, with legacy-inline panel controls when no activity position is configured. */
export function MainArea() {
  const { model, layout } = usePluginState()
  const region = useRegion('view')
  const view = layout.view ? model?.views.find((candidate) => candidate.id === layout.view!.id) : undefined

  return (
    <main className="main" {...region}>
      <div className="main-header">
        <div className="main-title">{view ? <strong>{view.title}</strong> : <span className="muted">Quirky</span>}</div>
        {layout.activityBarPosition === undefined && <PanelToggles />}
      </div>
      <div className="main-body">
        {view && <PluginSlot key={view.id} id={view.id} input={layout.view!.input} />}
        {!view && model && (
          <p className="empty">
            {model.views.length === 0 ? 'Nothing to show here.' : 'Add a repo and pick a worktree to get started.'}
          </p>
        )}
      </div>
    </main>
  )
}
