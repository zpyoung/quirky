/** A horizontal extent in viewport coordinates. */
export type Span = { left: number; right: number }

/** Pixels of overhang ignored, so rounding in layout never reads a tab as not fitting. */
const ROUNDING = 1

/**
 * Indexes of tabs clipped too much to use. Allow one pixel for layout rounding: normal tabs must be
 * fully visible within that tolerance, while oversized tabs remain usable when they fill the viewport.
 */
export function hiddenTabIndexes(viewport: Span, tabs: readonly Span[]): number[] {
  const hidden: number[] = []
  const viewportWidth = viewport.right - viewport.left
  tabs.forEach((tab, index) => {
    const showing = Math.min(tab.right, viewport.right) - Math.max(tab.left, viewport.left)
    if (showing < Math.min(tab.right - tab.left, viewportWidth) - ROUNDING) hidden.push(index)
  })
  return hidden
}

/**
 * Whether every tab fits in `room`, the width the strip offers with no "more" button. The button
 * takes its width from the viewport, so measuring only the viewport would keep it on screen forever.
 */
export function tabsFit(room: number, content: number): boolean {
  return content <= room + ROUNDING
}

/**
 * The earliest tab of the unbroken run ending at `target` that fits in a viewport `width` wide,
 * within layout rounding. Tabs before it cannot share the viewport with `target`.
 */
export function firstTabBeside(width: number, tabs: readonly Span[], target: number): number {
  const right = tabs[target]!.right
  let first = target
  while (first > 0 && right - tabs[first - 1]!.left <= width + ROUNDING) first -= 1
  return first
}

/**
 * The blank scroll room to leave after the last tab: just enough for the earliest tab beside it to
 * reach the leading edge. Any more would let the strip stop with a hidden tab's worth of blank space.
 */
export function trailingScrollSlack(width: number, tabs: readonly Span[]): number {
  const last = tabs[tabs.length - 1]
  if (!last) return 0
  return Math.max(0, width - (last.right - tabs[firstTabBeside(width, tabs, tabs.length - 1)]!.left))
}

/**
 * How far to scroll back to bring in the hidden tabs that fit in the blank space after the visible
 * run, keeping that run in view. Nothing when no tab sits fully inside the viewport.
 */
export function scrollBackToFill(viewport: Span, tabs: readonly Span[]): number {
  const lead = tabs.findIndex((tab) => tab.left >= viewport.left - ROUNDING)
  const end = tabs.findLastIndex((tab) => tab.right <= viewport.right + ROUNDING)
  if (lead < 0 || end < lead) return 0
  return tabs[lead]!.left - tabs[firstTabBeside(viewport.right - viewport.left, tabs, end)]!.left
}
