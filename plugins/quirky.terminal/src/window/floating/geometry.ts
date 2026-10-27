import { FLOATING_DEFAULTS } from '../../layout/types'
import type { FloatingBounds } from '../../layout/types'

export type Viewport = { width: number; height: number }
export type Point = { x: number; y: number }
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const BUTTON_SIZE = 36
const BUTTON_MARGIN = 8
const BUTTON_RIGHT = 24
const BUTTON_BOTTOM = 72

const { minWidth, minHeight } = FLOATING_DEFAULTS
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** The panel's first placement: 920x560 (smaller in a small window), 24 px from the right and 84 px from the bottom. */
export function defaultBounds(view: Viewport): FloatingBounds {
  const width = Math.min(FLOATING_DEFAULTS.width, Math.max(minWidth, view.width - 48))
  const height = Math.min(FLOATING_DEFAULTS.height, Math.max(minHeight, view.height - 96))
  return clampBounds({ x: view.width - width - FLOATING_DEFAULTS.right, y: view.height - height - FLOATING_DEFAULTS.bottom, width, height }, view)
}

/** The whole window less a 12 px margin, which covers the sidebar. */
export function maximizedBounds(view: Viewport): FloatingBounds {
  const margin = FLOATING_DEFAULTS.margin
  return { x: margin, y: margin, width: Math.max(minWidth, view.width - margin * 2), height: Math.max(minHeight, view.height - margin * 2) }
}

/** Pulls bounds inside the window and up to the minimum size, shrinking one that is larger than the window. */
export function clampBounds(bounds: FloatingBounds, view: Viewport): FloatingBounds {
  const width = clamp(bounds.width, minWidth, view.width)
  const height = clamp(bounds.height, minHeight, view.height)
  return { x: clamp(bounds.x, 0, view.width - width), y: clamp(bounds.y, 0, view.height - height), width, height }
}

/** The bounds the panel draws: maximized, else the saved bounds pulled inside the window, else the default. */
export function resolveBounds(state: { maximized: boolean; bounds: FloatingBounds | null }, view: Viewport): FloatingBounds {
  if (state.maximized) return maximizedBounds(view)
  return state.bounds ? clampBounds(state.bounds, view) : defaultBounds(view)
}

/** The panel after its title bar was dragged by `dx`, `dy`; its size stays and it cannot leave the window. */
export function moveBounds(start: FloatingBounds, dx: number, dy: number, view: Viewport): FloatingBounds {
  return clampBounds({ ...start, x: start.x + dx, y: start.y + dy }, view)
}

/** The panel after `edge` was dragged by `dx`, `dy`; the opposite sides stay, and the minimum size and the window limit it. */
export function resizeBounds(start: FloatingBounds, edge: Edge, dx: number, dy: number, view: Viewport): FloatingBounds {
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (edge.includes('w')) left = clamp(left + dx, 0, right - minWidth)
  if (edge.includes('e')) right = clamp(right + dx, left + minWidth, view.width)
  if (edge.includes('n')) top = clamp(top + dy, 0, bottom - minHeight)
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minHeight, view.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The button's place before it is dragged: the bottom right of the window. */
export function defaultButton(view: Viewport): Point {
  return clampButton({ x: view.width - BUTTON_SIZE - BUTTON_RIGHT, y: view.height - BUTTON_SIZE - BUTTON_BOTTOM }, view)
}

/** Keeps the whole button inside the window. */
export function clampButton(point: Point, view: Viewport): Point {
  return {
    x: clamp(point.x, BUTTON_MARGIN, view.width - BUTTON_SIZE - BUTTON_MARGIN),
    y: clamp(point.y, BUTTON_MARGIN, view.height - BUTTON_SIZE - BUTTON_MARGIN)
  }
}
