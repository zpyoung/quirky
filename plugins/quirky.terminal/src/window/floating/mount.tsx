import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { WorkspaceOptions } from '../workspace'
import { FloatingOverlay } from './FloatingOverlay'

/**
 * Mounts the overlay `overlay:quirky.terminal/floating` into `element` and returns the function
 * that unmounts it. `workspaceOptions` supplies the slots the floating workspace shares with the main view.
 */
export function mountFloatingOverlay(
  context: UiPluginContext,
  element: HTMLElement,
  props: { report?(state: unknown): void },
  workspaceOptions: () => WorkspaceOptions = () => ({})
): () => void {
  // the host clears the overlay's element right after unmounting, before React finishes removing its nodes, so React gets a container of its own
  const container = element.ownerDocument.createElement('div')
  element.appendChild(container)
  const root = createRoot(container)
  root.render(<FloatingOverlay context={context} report={props.report} workspaceOptions={workspaceOptions} />)
  return () => {
    root.unmount()
    container.remove()
  }
}
