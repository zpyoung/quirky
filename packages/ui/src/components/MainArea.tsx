import { IconButton, Tabs } from '../design-system'
import { usePluginHost, usePluginState } from '../context'
import { PluginSlot } from '../plugins/PluginSlot'
import { useRegion } from '../plugins/useRegion'
import { useAttention } from '../shell/attention'

/** What the center says with no view open: it asks for a repo only when none has been added. */
export function emptyMainMessage({ views, repos }: { views: number; repos: number | null }): string {
  if (views === 0) return 'Nothing to show here.'
  return repos ? 'Pick a worktree to get started.' : 'Add a repo and pick a worktree to get started.'
}

const WORKTREE_VIEW = 'view:quirky.session/worktree'

/** Whether the row of open views shows: the worktree view alone draws its own tab strip, so a second row would only repeat it. */
export function showsViewTabs(tabs: readonly { id: string }[]): boolean {
  return !(tabs.length === 1 && tabs[0]!.id === WORKTREE_VIEW)
}

/** The active center contribution and only the view contributions actually opened in this window. */
export function MainArea() {
  const { model, layout, windowRoute } = usePluginState()
  const host = usePluginHost()
  const { snapshot } = useAttention()
  const region = useRegion('view')
  const viewId = windowRoute ? windowRoute.view ?? undefined : layout.view?.id
  const view = viewId ? model?.views.find((candidate) => candidate.id === viewId) : undefined
  const opened = windowRoute
    ? []
    : layout.viewTabs ?? (layout.view ? [{ id: layout.view.id, ...(layout.view.input === undefined ? {} : { input: layout.view.input }) }] : [])
  const seen = new Set<string>()
  const tabs = opened.filter((tab) => {
    if (seen.has(tab.id) || !model?.views.some((candidate) => candidate.id === tab.id)) return false
    seen.add(tab.id)
    return true
  })
  const input = windowRoute ? windowRoute.input : layout.view?.input
  const tabItems = tabs.map((tab) => ({
    id: tab.id,
    label: model?.views.find((candidate) => candidate.id === tab.id)?.title ?? tab.id
  }))

  return (
    <main className="main" {...region}>
      {(windowRoute || showsViewTabs(tabs)) && <div className={`main-header${windowRoute ? '' : ' shell-main-header'}`}>
        {windowRoute ? (
          <div className="main-title">
            {windowRoute.title ? <strong>{windowRoute.title}</strong> : view ? <strong>{view.title}</strong> : <span className="muted">Auxiliary window</span>}
          </div>
        ) : tabs.length > 0 && viewId ? (
          <>
            <Tabs label="Open views" items={tabItems} value={viewId} onChange={(id) => {
              const selected = tabs.find((tab) => tab.id === id)
              if (selected) host.openView(selected.id, selected.input)
            }} />
            <IconButton label="Close active view" onClick={() => host.closeView()}>×</IconButton>
          </>
        ) : (
          <div className="main-title"><span className="muted">Quirky</span></div>
        )}
      </div>}
      <div className="main-body">
        {view && <PluginSlot key={windowRoute ? `${windowRoute.windowId}:${view.id}` : view.id} id={view.id} input={input} />}
        {windowRoute && model && !view && (
          <p className="empty" role="alert">
            {windowRoute.view === null ? 'No view is open in this auxiliary window.' : `The requested view ${windowRoute.view} is unavailable.`}
          </p>
        )}
        {!windowRoute && !view && model && (
          <p className="empty">
            {emptyMainMessage({ views: model.views.length, repos: snapshot.repos?.length ?? null })}
          </p>
        )}
      </div>
    </main>
  )
}
