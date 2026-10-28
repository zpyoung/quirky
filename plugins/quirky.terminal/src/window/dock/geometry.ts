export const MIN_GUTTER_ROWS = 3
export const MAX_GUTTER_ROWS = 15
export const DEFAULT_GUTTER_ROWS = 5
export const GUTTER_BASE_HEIGHT_PX = 80
export const GUTTER_ROW_HEIGHT_PX = 20
export const RESIZE_HANDLE_HEIGHT_PX = 6
export const UNMOUNT_CLEARANCE_PX = 60
export const REMOUNT_CLEARANCE_PX = 100

function clampRows(rows: number): number {
  return Math.min(MAX_GUTTER_ROWS, Math.max(MIN_GUTTER_ROWS, rows))
}

/** The dock's fixed chrome plus its chosen number of twenty-pixel editing rows. */
export function dockHeight(rows: number): number {
  return GUTTER_BASE_HEIGHT_PX + GUTTER_ROW_HEIGHT_PX * clampRows(rows)
}

/** Applies a drag delta in pixels (positive is downward) as whole twenty-pixel row steps. */
export function gutterRowsAfterDrag(initialRows: number, deltaY: number): number {
  return clampRows(initialRows - Math.round(deltaY / GUTTER_ROW_HEIGHT_PX))
}

/** Applies the dock's two-threshold height hysteresis, holding the prior state during a drag. */
export function shouldMountDock(mounted: boolean, paneHeight: number, gutterHeight: number, dragging: boolean): boolean {
  if (dragging) return mounted
  return paneHeight >= gutterHeight + (mounted ? UNMOUNT_CLEARANCE_PX : REMOUNT_CLEARANCE_PX)
}
