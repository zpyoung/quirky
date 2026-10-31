/** A horizontal extent in viewport coordinates. */
export type Span = { left: number; right: number }

/** Pixels of overhang ignored, so rounding in layout never reads a tab as not fitting. */
const ROUNDING = 1

/**
 * The indexes of the tabs too clipped to use: less than half of the tab shows in the strip, on
 * either side. A tab with most of itself showing stays clickable, so listing it would only mislead.
 */
export function hiddenTabIndexes(viewport: Span, tabs: readonly Span[]): number[] {
  const hidden: number[] = []
  tabs.forEach((tab, index) => {
    const showing = Math.min(tab.right, viewport.right) - Math.max(tab.left, viewport.left)
    if (showing < (tab.right - tab.left) / 2) hidden.push(index)
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
