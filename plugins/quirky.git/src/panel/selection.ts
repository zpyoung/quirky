import type { ReviewFile } from '@quirky/protocol'
import { nextToReview, reviewOrder } from '../review/order'

/** What a key press asks of the file list; `null` from `keyIntent` means the key is not the list's. */
export type KeyIntent =
  | { type: 'select'; path: string | null }
  | { type: 'open'; path: string }
  | { type: 'toggle-mark'; path: string; reviewed: boolean }
  | { type: 'revert'; path: string }

/**
 * The step a key press takes in the list. `rows` are the files in the order they are shown (a
 * collapsed folder's files are not in it) and `selected` is the shared selection. ↓ from nothing
 * selects the first row and ↑ the last; at either end the selection stays. Space marks a file that
 * is not reviewed (or changed since review) and unmarks a reviewed one, and does nothing for a
 * conflicted file. Keys that need a selection return null without one, except Escape, which
 * clears it.
 */
export function keyIntent(rows: readonly ReviewFile[], selected: string | null, key: string): KeyIntent | null {
  const at = selected === null ? -1 : rows.findIndex((row) => row.path === selected)
  const current = at === -1 ? undefined : rows[at]
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (rows.length === 0) return null
      const next = current === undefined ? (key === 'ArrowDown' ? 0 : rows.length - 1) : at + (key === 'ArrowDown' ? 1 : -1)
      const row = rows[Math.min(rows.length - 1, Math.max(0, next))]!
      return { type: 'select', path: row.path }
    }
    case 'Enter':
      return current === undefined ? null : { type: 'open', path: current.path }
    case ' ':
      return current === undefined || current.conflict !== undefined
        ? null
        : { type: 'toggle-mark', path: current.path, reviewed: current.mark !== 'reviewed' }
    case 'Backspace':
    case 'Delete':
      return current === undefined ? null : { type: 'revert', path: current.path }
    case 'Escape':
      return selected === null ? null : { type: 'select', path: null }
    default:
      return null
  }
}

/**
 * Where the selection goes after `path` is marked reviewed: the next file in the shown order
 * that still needs a look, wrapping around, or null when none is left and the selection stays.
 * `files` is the whole review, not the filtered rows, so a filter never hides the next file.
 */
export function advanceAfterMark(files: readonly ReviewFile[], mode: 'list' | 'tree', path: string): string | null {
  return nextToReview(reviewOrder(files, mode), path)
}
