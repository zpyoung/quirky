import type { GitCompare, GitStatusEntry } from '@quirky/protocol'
import type { DiffViewInput } from '../shared/view-input'

/**
 * What to open for a note on `path`: the worktree's Review tab scrolled to the file, with the
 * note's id so its card is brought into view. A path with an unresolved conflict opens the
 * conflict file instead, since the Review tab has no card for it. `compare` is accepted for the
 * callers that still pass it.
 */
export function noteViewInput(path: string, noteId: string, entries: readonly GitStatusEntry[], _compare?: GitCompare | null): Omit<DiffViewInput, 'worktree'> {
  if (entries.some((entry) => entry.path === path && entry.area === 'conflicts')) return { mode: 'conflict-file', path }
  return { mode: 'review', reveal: path, noteId }
}
