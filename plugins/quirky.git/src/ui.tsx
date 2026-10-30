import '@quirky/ui/styles.css'

import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { mountAiSettings } from './ai/AiSettingsView'
import { AI_SETTINGS_VIEW_ID } from './ai/types'
import { SourceControl } from './SourceControl'
import { AheadBehind } from './StatusBarItem'
import type { ScmReport } from './scm'
import { DIFF_VIEW_ID, PANEL_ID } from './shared/view-input'
import { commandHandlers } from './view/commands'
import { mountDiffView } from './view/DiffWindow'
import { subscribeHostedLayouts } from './view/hosted-tabs'

const STATUS_BAR_ID = 'status-bar:quirky.git/ahead-behind'

/** Provides the source-control panel, the diff view, the AI defaults view and every command. The panel follows the worktree of the open view. */
export function activate(context: UiPluginContext): void {
  subscribeHostedLayouts(context)
  context.provide(PANEL_ID, (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    const report = (state: ScmReport) => props.report?.(state)
    root.render(<SourceControl context={context} report={report} />)
    return () => root.unmount()
  })
  context.provide(STATUS_BAR_ID, (element: HTMLElement) => {
    const root = createRoot(element)
    root.render(<AheadBehind context={context} />)
    return () => root.unmount()
  })
  context.provide(DIFF_VIEW_ID, mountDiffView(context))
  context.provide(AI_SETTINGS_VIEW_ID, mountAiSettings(context))
  for (const [id, handler] of Object.entries(commandHandlers(context))) {
    context.provide(`command:quirky.git/${id}`, handler)
  }
}
