import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { WorktreesSection } from './WorktreesSection'

/** Provides the repo and worktree tree for the `worktrees` sidebar section. */
export function activate(context: UiPluginContext): void {
  context.provide('sidebar-section:quirky.worktree/worktrees', (element: HTMLElement, props: { report?(state: unknown): void }) => {
    const root = createRoot(element)
    root.render(<WorktreesSection context={context} report={props.report} />)
    return () => root.unmount()
  })
}
