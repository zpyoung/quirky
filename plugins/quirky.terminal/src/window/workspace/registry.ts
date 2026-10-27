import type { WorkspaceController } from './controller'

const controllers = new Set<WorkspaceController>()
let lastFocused: WorkspaceController | null = null
let floatingHasFocus = false

/** Makes `controller` findable by `focusedController` and `controllerFor`; returns the function that removes it. */
export function registerController(controller: WorkspaceController): () => void {
  controllers.add(controller)
  return () => {
    controllers.delete(controller)
    if (lastFocused === controller) lastFocused = null
  }
}

/** Records that `controller`'s workspace was the last place focus went. */
export function noteFocus(controller: WorkspaceController): void {
  lastFocused = controller
}

/** Tells the registry whether the floating panel holds focus, mirroring the `floatingFocus` context key. */
export function setFloatingFocus(value: boolean): void {
  floatingHasFocus = value
}

function holdsFocus(controller: WorkspaceController): boolean {
  const root = controller.root
  return root !== null && root.contains(root.ownerDocument.activeElement)
}

/**
 * The workspace commands act on: the floating panel while it was told it has focus; else the one
 * holding DOM focus; else the one focused last; else the main view's; else the floating one.
 * Null when nothing is mounted.
 */
export function focusedController(): WorkspaceController | null {
  const all = [...controllers]
  const floating = all.filter((controller) => controller.floating)
  const main = all.filter((controller) => !controller.floating)
  if (floatingHasFocus && floating.length > 0) return floating[floating.length - 1]!
  const focused = [...floating, ...main].find(holdsFocus)
  if (focused) return focused
  if (lastFocused && controllers.has(lastFocused)) return lastFocused
  return main[main.length - 1] ?? floating[floating.length - 1] ?? null
}

/** The mounted controller of workspace `workspaceId` (a worktree ID or `floating`), if any. */
export function controllerFor(workspaceId: string): WorkspaceController | null {
  const matches = [...controllers].filter((controller) => controller.workspaceId === workspaceId || controller.selector === workspaceId)
  return matches[matches.length - 1] ?? null
}
