import { useSyncExternalStore } from 'react'
import { GroupTree } from './GroupView'
import { DialogLayer, MenuLayer } from './Overlays'
import { noteFocus } from './registry'
import type { WorkspaceController } from './controller'

/** One mounted workspace: its group tree, with the open menu and dialog above it. */
export function WorkspaceView({ controller }: { controller: WorkspaceController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const workspace = state.workspace
  const root = workspace ? controller.previewedRoot(workspace.root) : null

  if (state.status === 'missing') return <p className="qt-muted qt-pad">Worktree not found</p>
  if (state.status === 'error') return <p className="qt-muted qt-pad">Could not load the workspace</p>
  if (!workspace || !root) return null

  return (
    <div className="qt-workspace" data-qt-root data-workspace={workspace.id} onFocusCapture={() => noteFocus(controller)} onMouseDownCapture={() => noteFocus(controller)}>
      <GroupTree controller={controller} state={state} node={root} />
      <MenuLayer controller={controller} state={state} />
      <DialogLayer controller={controller} state={state} />
    </div>
  )
}
