import type { GitCompare, GitStatusEntry } from '@quirky/protocol'
import type { DiffViewInput } from '../shared/view-input'

/**
 * What to open for a note on `path`, by the first that applies: its unstaged diff, its untracked
 * file's diff, another uncommitted entry's diff, its Committed on Branch diff, else its diff
 * against HEAD (an unstaged diff of a file with no change). The note's id rides along so the
 * view can scroll its card into view.
 */
export function noteViewInput(path: string, noteId: string, entries: readonly GitStatusEntry[], compare: GitCompare | null): Omit<DiffViewInput, 'worktree'> {
  const own = entries.filter((entry) => entry.path === path)
  const unstaged = own.find((entry) => entry.area === 'unstaged' || entry.area === 'untracked')
  const other = own.find((entry) => entry.area !== 'unstaged' && entry.area !== 'untracked')
  const oldPath = (value: string | undefined) => (value === undefined ? {} : { oldPath: value })
  if (unstaged) return { mode: 'file', source: 'unstaged', path, noteId }
  if (other?.area === 'conflicts') return { mode: 'conflict-file', path }
  if (other) return { mode: 'file', source: 'staged', path, ...oldPath(other.oldPath), noteId }
  const committed = compare?.status === 'ready' ? compare.entries.find((change) => change.path === path) : undefined
  if (committed) return { mode: 'file', source: 'branch', path, ...oldPath(committed.oldPath), noteId }
  return { mode: 'file', source: 'unstaged', path, noteId }
}
