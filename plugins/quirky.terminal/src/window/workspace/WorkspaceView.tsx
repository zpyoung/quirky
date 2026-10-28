import { useSyncExternalStore, type FocusEvent as ReactFocusEvent } from 'react'
import { EmptyState } from '@quirky/ui'
import { GroupTree } from './GroupView'
import { DialogLayer, MenuLayer } from './Overlays'
import { noteFocus } from './registry'
import type { WorkspaceController } from './controller'

/** One mounted workspace: its group tree, with the open menu and dialog above it. */
export function WorkspaceView({ controller }: { controller: WorkspaceController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const workspace = state.workspace
  const root = workspace ? controller.previewedRoot(workspace.root) : null

  if (state.status === 'missing') return <EmptyState message="Worktree not found" />
  if (state.status === 'error') return <EmptyState message="Could not load the workspace" />
  if (state.selectionError) return <div role="alert"><EmptyState message={state.selectionError} /></div>
  if (!workspace || !root) return null
  const reportFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    noteFocus(controller)
    if (!(event.target instanceof HTMLTextAreaElement) || !event.target.classList.contains('xterm-helper-textarea')) return
    void controller.context
      .call('quirky.terminal/focusContext', { workspace: controller.workspaceId })
      .catch((error) => controller.context.log(`could not report terminal focus: ${error instanceof Error ? error.message : String(error)}`))
  }

  return (
    <div className="qt-workspace" data-qt-root data-workspace={workspace.id} onFocusCapture={reportFocus} onMouseDownCapture={() => noteFocus(controller)}>
      <GroupTree controller={controller} state={state} node={root} />
      <MenuLayer controller={controller} state={state} />
      <DialogLayer controller={controller} state={state} />
    </div>
  )
}
