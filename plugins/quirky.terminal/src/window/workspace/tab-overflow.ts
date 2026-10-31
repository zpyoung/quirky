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
