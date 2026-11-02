import type { GitChange, ReviewFile, ReviewMarkState } from '@quirky/protocol'
import { reviewOrder } from '../review/order'
import { AUTO_LOAD_MAX_LINES } from './entries'

/** The width, in CSS pixels, from which the Review tab lays diffs out side by side. */
export const SIDE_BY_SIDE_MIN_WIDTH = 900

export type DiffLayout = 'inline' | 'side-by-side'

/**
 * The layout for a tab body `width` wide. A user's choice from the header toggle (`override`)
 * beats the width, and an unmeasured body is inline.
 */
export function layoutFor(width: number | null, override: DiffLayout | null): DiffLayout {
  if (override !== null) return override
  return width !== null && width >= SIDE_BY_SIDE_MIN_WIDTH ? 'side-by-side' : 'inline'
}

/** One card of the tab: a file of the worktree review, or of the commit the tab is scoped to. */
export type ReviewItem = {
  /** Unique within the tab and scope: the same path in another scope is another card. */
  key: string
  path: string
  oldPath?: string
  added: number | null
  removed: number | null
  binary: boolean
  submodule: boolean
  mark: ReviewMarkState
  notes: number
  /** Changes when the file's diff may have: a refresh compares it with the one the card loaded. */
  signature: string
}

const signatureOf = (item: Pick<ReviewItem, 'path' | 'oldPath' | 'added' | 'removed' | 'binary'>, status: string): string =>
  [item.path, item.oldPath ?? '', status, item.added, item.removed, item.binary].join('|')

/** The card for a file of the worktree review. */
export function itemFromFile(file: ReviewFile): ReviewItem {
  const item = {
    key: `review:${file.path}`,
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    submodule: file.submodule !== undefined,
    mark: file.mark,
    notes: file.notes
  }
  return { ...item, signature: signatureOf(item, file.status) }
}

/** The changes of a commit in the order the panel lists files for `mode`, so a commit scope stacks like the worktree review. */
export function orderChanges(changes: readonly GitChange[], mode: 'list' | 'tree'): GitChange[] {
  const byPath = new Map(changes.map((change) => [change.path, change]))
  const asFiles = changes.map(
    (change): ReviewFile => ({
      path: change.path,
      status: 'M',
      added: change.added,
      removed: change.removed,
      binary: change.binary,
      uncommitted: false,
      staged: false,
      mark: 'none',
      notes: 0
    })
  )
  return reviewOrder(asFiles, mode).map((file) => byPath.get(file.path)!)
}

/** The card for a file of `commit`, which has no review state; `notes` is how many the worktree holds on the path. */
export function itemFromChange(change: GitChange, commit: string, notes = 0): ReviewItem {
  const item = {
    key: `commit:${commit}:${change.path}`,
    path: change.path,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    added: change.added,
    removed: change.removed,
    binary: change.binary,
    submodule: false,
    mark: 'none' as const,
    notes
  }
  return { ...item, signature: signatureOf(item, change.status) }
}

/** Why a card waits for a click: it is known to be large, or its size is not known. */
export function loadModeOf(item: Pick<ReviewItem, 'added' | 'removed' | 'binary' | 'submodule'>): 'auto' | 'large' | 'unknown' {
  if (item.binary || item.submodule) return 'auto'
  if (item.added === null || item.removed === null) return 'unknown'
  return item.added + item.removed > AUTO_LOAD_MAX_LINES ? 'large' : 'auto'
}

/**
 * What the user changed on one card since its mark last changed: `collapsed` is null until they
 * fold or unfold it by hand, and `full` asks a changed card for its whole diff.
 */
export type CardUi = { mark: ReviewMarkState; collapsed: boolean | null; full: boolean }

/** A card nobody has touched since it got `mark`. */
export const freshCard = (mark: ReviewMarkState): CardUi => ({ mark, collapsed: null, full: false })

/** The card's state under `mark`: a different mark drops the manual fold and the full-diff choice. */
export const cardFor = (ui: CardUi | undefined, mark: ReviewMarkState): CardUi => (ui !== undefined && ui.mark === mark ? ui : freshCard(mark))

/** Whether the card's body is folded: reviewed cards start folded, the rest open, until the user decides. */
export const isCollapsed = (ui: CardUi): boolean => ui.collapsed ?? ui.mark === 'reviewed'

/** Which version a card's body compares with the disk: a changed card shows what changed since the review. */
export const bodyAgainst = (ui: CardUi): 'base' | 'reviewed' => (ui.mark === 'changed' && !ui.full ? 'reviewed' : 'base')

/**
 * The stored card states with every card whose mark changed reset, or `ui` itself when none did,
 * so storing the result does not render again.
 */
export function reconcileCards(ui: Record<string, CardUi>, items: readonly Pick<ReviewItem, 'key' | 'mark'>[]): Record<string, CardUi> {
  let next: Record<string, CardUi> | null = null
  for (const item of items) {
    const stored = ui[item.key]
    if (stored !== undefined && stored.mark !== item.mark) (next ??= { ...ui })[item.key] = freshCard(item.mark)
  }
  return next ?? ui
}
