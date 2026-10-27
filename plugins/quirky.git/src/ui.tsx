import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { SourceControl } from './SourceControl'
import type { ScmReport } from './scm'
import { DIFF_VIEW_ID, PANEL_ID } from './shared/view-input'
import { commandHandlers } from './view/commands'
import { mountDiffView } from './view/DiffWindow'

/** Provides the source-control panel, the diff view and every command. The panel follows the worktree of the open view. */
export function activate(context: UiPluginContext): void {
  context.provide(PANEL_ID, (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    const report = (state: ScmReport) => props.report?.(state)
    root.render(<SourceControl context={context} report={report} />)
    return () => root.unmount()
  })
  context.provide(DIFF_VIEW_ID, mountDiffView(context))
  for (const [id, handler] of Object.entries(commandHandlers(context))) {
    context.provide(`command:quirky.git/${id}`, handler)
  }
}
