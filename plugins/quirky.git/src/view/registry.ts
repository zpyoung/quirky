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

/** What a mounted Review tab offers `openReview`, so a second open reuses the tab instead of remounting it. */
export type ReviewViewHandle = {
  worktree: string
  /** Scrolls the card for `path` into view, expands it and makes it the active card. */
  reveal(path: string, noteId?: string): void
  /** Scrolls the stack to its first card. */
  scrollToTop(): void
  /** Shows one commit's files (a commit sha) or returns to the worktree review (null). */
  setScope(commit: string | null): void
}

const reviewHandles = new Map<string, ReviewViewHandle>()

/** Makes `handle` the Review tab for its worktree until the returned function runs. */
export function registerReviewView(handle: ReviewViewHandle): () => void {
  reviewHandles.set(handle.worktree, handle)
  return () => {
    if (reviewHandles.get(handle.worktree) === handle) reviewHandles.delete(handle.worktree)
  }
}

/** The mounted Review tab of `worktree`, or null when none is mounted. */
export function reviewViewFor(worktree: string): ReviewViewHandle | null {
  return reviewHandles.get(worktree) ?? null
}
