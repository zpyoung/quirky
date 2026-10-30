export type PlacementRect = { left: number; top: number; width: number; height: number }

export type SetupPlacement = { left: number; top: number; maxHeight: number }

const SAFE_MARGIN = 16
const BUTTON_GAP = 12

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function placeSetupCard({
  viewport,
  button,
  statusBar,
  card
}: {
  viewport: { width: number; height: number }
  button: PlacementRect | null
  statusBar: Pick<PlacementRect, 'top'> | null
  card: { width: number; height: number }
}): SetupPlacement {
  const safeLeft = Math.min(SAFE_MARGIN, viewport.width / 2)
  const safeRight = Math.max(safeLeft, viewport.width - safeLeft)
  const safeTop = Math.min(SAFE_MARGIN, viewport.height / 2)
  const statusTop = statusBar ? clamp(statusBar.top, 0, viewport.height) : viewport.height
  const safeBottom = Math.max(safeTop, statusTop - SAFE_MARGIN)
  const safeWidth = safeRight - safeLeft
  const safeHeight = safeBottom - safeTop
  const width = Math.min(card.width, safeWidth)
  const height = Math.max(0, card.height)
  const leftOf = (rect: PlacementRect) => clamp(rect.left + (rect.width - width) / 2, safeLeft, safeRight - width)

  if (!button) {
    const visibleHeight = Math.min(height, safeHeight)
    return { left: safeRight - width, top: safeBottom - visibleHeight, maxHeight: safeHeight }
  }

  const buttonRight = button.left + button.width
  const buttonBottom = button.top + button.height
  const aboveBottom = Math.max(safeTop, Math.min(button.top - BUTTON_GAP, safeBottom))
  const aboveSpace = aboveBottom - safeTop
  const belowTop = buttonBottom + BUTTON_GAP
  const belowSpace = Math.max(0, safeBottom - belowTop)

  if (height <= aboveSpace) {
    return { left: leftOf(button), top: aboveBottom - height, maxHeight: aboveSpace }
  }
  if (height <= belowSpace) {
    return { left: leftOf(button), top: belowTop, maxHeight: belowSpace }
  }

  const rightLeft = buttonRight + BUTTON_GAP
  const rightSpace = safeRight - rightLeft
  if (width <= rightSpace && height <= safeHeight) {
    return {
      left: rightLeft,
      top: clamp(button.top + (button.height - height) / 2, safeTop, safeBottom - height),
      maxHeight: safeHeight
    }
  }

  const leftSpace = button.left - BUTTON_GAP - safeLeft
  if (width <= leftSpace && height <= safeHeight) {
    return {
      left: button.left - BUTTON_GAP - width,
      top: clamp(button.top + (button.height - height) / 2, safeTop, safeBottom - height),
      maxHeight: safeHeight
    }
  }

  const constrained: { side: 'above' | 'below' | 'right' | 'left'; space: number }[] = [
    { side: 'above', space: aboveSpace },
    { side: 'below', space: belowSpace }
  ]
  if (width <= rightSpace) constrained.push({ side: 'right', space: safeHeight })
  if (width <= leftSpace) constrained.push({ side: 'left', space: safeHeight })
  const best = constrained.reduce((winner, candidate) => candidate.space > winner.space ? candidate : winner)
  const visibleHeight = Math.min(height, best.space)

  if (best.side === 'above') {
    return { left: leftOf(button), top: aboveBottom - visibleHeight, maxHeight: best.space }
  }
  if (best.side === 'below') {
    return { left: leftOf(button), top: belowTop, maxHeight: best.space }
  }

  return {
    left: best.side === 'right' ? rightLeft : button.left - BUTTON_GAP - width,
    top: clamp(button.top + (button.height - visibleHeight) / 2, safeTop, safeBottom - visibleHeight),
    maxHeight: best.space
  }
}
