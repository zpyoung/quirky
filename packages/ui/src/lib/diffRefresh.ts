import type { GitDiff, GitFileStatus } from '@quirky/protocol'

export type DiffSelection = { path: string; staged: boolean }

/** The selection if its file is still listed on the side it was chosen from, otherwise null (the diff should close). */
export function keepSelection(
  selection: DiffSelection | null,
  staged: GitFileStatus[],
  unstaged: GitFileStatus[]
): DiffSelection | null {
  if (!selection) return null
  const side = selection.staged ? staged : unstaged
  return side.some((f) => f.path === selection.path) ? selection : null
}

/**
 * The previous diff when a refetch returned the same content, so the merge view is not rebuilt
 * (which would reset its scroll position) on every status poll.
 */
export function reuseDiff(prev: GitDiff | null, next: GitDiff): GitDiff {
  if (
    prev &&
    prev.path === next.path &&
    prev.staged === next.staged &&
    prev.binary === next.binary &&
    prev.original === next.original &&
    prev.modified === next.modified
  ) {
    return prev
  }
  return next
}
