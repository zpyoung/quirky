import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { SessionsPanel, type SessionsReport } from './window/SessionsPanel'

const PANEL_ID = 'panel:quirky.terminal/sessions'

/** Provides the Terminal Sessions panel and the command that opens it. */
export function activate(context: UiPluginContext): void {
  context.provide(PANEL_ID, (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    const report = (state: SessionsReport) => props.report?.(state)
    root.render(<SessionsPanel context={context} report={report} />)
    return () => root.unmount()
  })
  context.provide('command:quirky.terminal/manage-sessions', () => context.togglePanel(PANEL_ID, true))
}
