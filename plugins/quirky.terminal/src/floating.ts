import { FLOATING_DEFAULTS } from './layout/types'
import type { FloatingBounds, FloatingState } from './layout/types'

/** The part of `FloatingState` the store keeps; `enabled` always comes from the setting. */
export type StoredFloating = Omit<FloatingState, 'enabled'>

export const DEFAULT_FLOATING: StoredFloating = { open: false, maximized: false, bounds: null, button: null }

export type FloatingUpdate = { open?: unknown; maximized?: unknown; bounds?: unknown; button?: unknown }
export type FloatingResult = { ok: true; state: StoredFloating } | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function parseBounds(value: unknown): FloatingBounds | string {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)) {
    return 'bounds must be null or {x, y, width, height} numbers'
  }
  if (value.width < FLOATING_DEFAULTS.minWidth || value.height < FLOATING_DEFAULTS.minHeight) {
    return `bounds must be at least ${FLOATING_DEFAULTS.minWidth}x${FLOATING_DEFAULTS.minHeight}`
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

/**
 * Applies a partial update to the stored floating state. `bounds` and `button` take null to go
 * back to the default placement; bounds under 420x280 are refused.
 */
export function applyFloatingUpdate(current: StoredFloating, update: FloatingUpdate): FloatingResult {
  const next: StoredFloating = { ...current }
  if (update.open !== undefined) {
    if (typeof update.open !== 'boolean') return { ok: false, message: 'open must be a boolean' }
    next.open = update.open
  }
  if (update.maximized !== undefined) {
    if (typeof update.maximized !== 'boolean') return { ok: false, message: 'maximized must be a boolean' }
    next.maximized = update.maximized
  }
  if (update.bounds !== undefined) {
    if (update.bounds === null) next.bounds = null
    else {
      const bounds = parseBounds(update.bounds)
      if (typeof bounds === 'string') return { ok: false, message: bounds }
      next.bounds = bounds
    }
  }
  if (update.button !== undefined) {
    if (update.button === null) next.button = null
    else if (isRecord(update.button) && finite(update.button.x) && finite(update.button.y)) {
      next.button = { x: update.button.x, y: update.button.y }
    } else return { ok: false, message: 'button must be null or {x, y} numbers' }
  }
  return { ok: true, state: next }
}

/** The stored state from its JSON, or the defaults when it is missing or damaged. */
export function parseStoredFloating(json: string | null): StoredFloating {
  if (json === null) return DEFAULT_FLOATING
  try {
    const value: unknown = JSON.parse(json)
    if (!isRecord(value)) return DEFAULT_FLOATING
    const merged = applyFloatingUpdate(DEFAULT_FLOATING, value)
    return merged.ok ? merged.state : DEFAULT_FLOATING
  } catch {
    return DEFAULT_FLOATING
  }
}
