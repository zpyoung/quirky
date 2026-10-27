import type { DiffViewInput } from '../shared/view-input'

/** What the window's commands can do to the mounted diff view; a mode ignores what it has no control for. */
export type ViewHandle = {
  input: DiffViewInput
  nextChange(): void
  previousChange(): void
  nextConflict(): void
  previousConflict(): void
  revertChange(): void
  save(): Promise<void>
  reloadFromDisk(): Promise<void>
  overwrite(): Promise<void>
  collapseAll(collapsed?: boolean): void
  loadDiff(path: string): Promise<void>
}

let current: ViewHandle | null = null

/** Makes `handle` the view commands act on until the returned function runs. */
export function registerView(handle: ViewHandle): () => void {
  current = handle
  return () => {
    if (current === handle) current = null
  }
}

/** The mounted diff view, or null when none is open. */
export function openDiffView(): ViewHandle | null {
  return current
}

/** The mounted diff view; throws when none is open, so a command reports it rather than doing nothing. */
export function activeView(): ViewHandle {
  if (current === null) throw new Error('No diff view is open.')
  return current
}
