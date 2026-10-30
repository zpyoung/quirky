/** A horizontal extent in viewport coordinates. */
export type Span = { left: number; right: number }

/** Pixels of overhang ignored, so rounding in layout never hides a tab that looks fully visible. */
const ROUNDING = 1

/**
 * The indexes of the tabs not fully inside the strip's visible width, on either side. A tab that is
 * partly clipped counts as hidden.
 */
export function hiddenTabIndexes(viewport: Span, tabs: readonly Span[]): number[] {
  const hidden: number[] = []
  tabs.forEach((tab, index) => {
    if (tab.left < viewport.left - ROUNDING || tab.right > viewport.right + ROUNDING) hidden.push(index)
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
