/**
 * Scroll positions and a pending focus target that survive a compact/expanded mount change.
 *
 * Kept in module state because a `createRoot` remount drops component state, and writing scroll
 * to the daemon on every scroll event would churn revisions. Lives as long as the plugin UI module.
 */

export type PlaceForm = 'compact' | 'expanded'
export type FocusTarget = 'row' | 'collapse' | 'expand'

const scrollTops = new Map<string, number>()
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
