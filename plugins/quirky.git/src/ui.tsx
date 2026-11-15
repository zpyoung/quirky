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
import {
  dispatchGitUiControl,
  GIT_UI_CONTROL_COMMAND,
  mountGitUiControls
} from './ui-control'
import { subscribeHostedLayouts } from './view/hosted-tabs'

const STATUS_BAR_ID = 'status-bar:quirky.git/ahead-behind'

/** Provides the source-control panel, the diff view, the AI defaults view and every command. The panel follows the worktree of the open view. */
export function activate(context: UiPluginContext): void {
  subscribeHostedLayouts(context)
  context.provide(PANEL_ID, mountGitUiControls(context, PANEL_ID, (scopedContext) =>
    (element: HTMLElement, props: { report?(state: unknown): void }) => {
      const root = createRoot(element)
      const report = (state: ScmReport) => props.report?.(state)
      root.render(<SourceControl context={scopedContext} report={report} />)
      return () => root.unmount()
    }
  ))
  context.provide(STATUS_BAR_ID, mountGitUiControls(context, STATUS_BAR_ID, (scopedContext) =>
    (element: HTMLElement) => {
      const root = createRoot(element)
      root.render(<AheadBehind context={scopedContext} />)
      return () => root.unmount()
    }
  ))
  context.provide(DIFF_VIEW_ID, mountGitUiControls(context, DIFF_VIEW_ID, mountDiffView))
  context.provide(AI_SETTINGS_VIEW_ID, mountGitUiControls(context, AI_SETTINGS_VIEW_ID, mountAiSettings))
  context.provide(GIT_UI_CONTROL_COMMAND, (args: unknown) => dispatchGitUiControl(context, args))
  for (const [id, handler] of Object.entries(commandHandlers(context))) {
    context.provide(`command:quirky.git/${id}`, handler)
  }
}
