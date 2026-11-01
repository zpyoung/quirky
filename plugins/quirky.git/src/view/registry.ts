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
  requestClose(): Promise<void>
}

const hostedHandles = new Map<string, ViewHandle>()
let current: ViewHandle | null = null
let activeHostedTab: string | null = null

/** Makes `handle` the view commands act on until the returned function runs. */
export function registerView(handle: ViewHandle): () => void {
  const tabId = handle.input.tabId
  if (tabId) {
    hostedHandles.set(tabId, handle)
    if (activeHostedTab === null || activeHostedTab === tabId) current = handle
  } else {
    current = handle
  }
  return () => {
    if (tabId && hostedHandles.get(tabId) === handle) hostedHandles.delete(tabId)
    if (current === handle) current = activeHostedTab ? hostedHandles.get(activeHostedTab) ?? null : null
  }
}

/** Selects a mounted hosted diff from a public terminal workspace snapshot. */
export function setActiveHostedView(tabId: string | null): void {
  activeHostedTab = tabId
  current = tabId === null ? null : hostedHandles.get(tabId) ?? null
}

/** Requests a close from this hosted tab's mounted view, or returns null when it is inactive. */
export function requestHostedDiffClose(tabId: string): Promise<void> | null {
  const handle = hostedHandles.get(tabId)
  return handle?.requestClose() ?? null
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
