import type { CheckResult, ListData, MergeMetadata } from './model'

/**
 * Scroll positions, a pending focus target and the last loaded list per view, which survive a
 * compact/expanded mount change.
 *
 * Kept in module state because a `createRoot` remount drops component state, and writing scroll
 * to the daemon on every scroll event would churn revisions. Lives as long as the plugin UI module.
 */

export type PlaceForm = 'compact' | 'expanded'
export type FocusTarget = 'row' | 'collapse' | 'expand'

/** What a list view last showed: the rows plus the per-row check and merge details loaded for them. */
export type ListSnapshot = {
  list: ListData
  checks: Readonly<Record<string, CheckResult>>
  merge: Readonly<Record<string, MergeMetadata>>
}

/** How many views keep a snapshot before the oldest is dropped. */
export const LIST_SNAPSHOT_LIMIT = 20

const scrollTops = new Map<string, number>()
const listSnapshots = new Map<string, ListSnapshot>()
let pendingFocus: FocusTarget | null = null

function scrollKey(form: PlaceForm, viewKey: string): string {
  return `${form}\u0000${viewKey}`
}

export const place = {
  /** Last saved scroll offset for a form and view key, or 0 when none was saved. */
  scrollTop(form: PlaceForm, viewKey: string): number {
    return scrollTops.get(scrollKey(form, viewKey)) ?? 0
  },

  setScrollTop(form: PlaceForm, viewKey: string, value: number): void {
    scrollTops.set(scrollKey(form, viewKey), value)
  },

  /** The last snapshot saved for a list view key, or null when that view was never loaded. */
  listSnapshot(key: string): ListSnapshot | null {
    return listSnapshots.get(key) ?? null
  },

  /** Saves a view's snapshot as the newest, dropping the oldest once more than `LIST_SNAPSHOT_LIMIT` views are kept. */
  setListSnapshot(key: string, snapshot: ListSnapshot): void {
    listSnapshots.delete(key)
    listSnapshots.set(key, snapshot)
    while (listSnapshots.size > LIST_SNAPSHOT_LIMIT) listSnapshots.delete(listSnapshots.keys().next().value!)
  },

  /** Asks the next mount to focus `target`; a later request replaces an unclaimed one. */
  requestFocus(target: FocusTarget): void {
    pendingFocus = target
  },

  /** Returns the pending focus target once, then null until the next request. */
  takeFocus(): FocusTarget | null {
    const target = pendingFocus
    pendingFocus = null
    return target
  }
}
