/** The cell size xterm measures while `stubXtermFontMetrics` is installed. */
export const CELL = { width: 8, height: 17 }

/**
 * Gives xterm a real cell size under happy-dom, which measures every element as 0x0. xterm 6
 * scrolls by pixel offset (lines times cell height), so with no cell size `scrollToTop` and
 * `scrollToLine` never move the viewport. xterm measures through `OffscreenCanvas` text metrics
 * first, so stubbing that leaves the layout of every other element alone. Returns the restore.
 */
export function stubXtermFontMetrics(): () => void {
  const scope = globalThis as { OffscreenCanvas?: unknown }
  const had = 'OffscreenCanvas' in scope
  const original = scope.OffscreenCanvas
  const metrics = { width: CELL.width, fontBoundingBoxAscent: CELL.height - 4, fontBoundingBoxDescent: 4 }
  scope.OffscreenCanvas = class {
    getContext() {
      return { font: '', measureText: () => metrics }
    }
  }
  return () => {
    if (had) scope.OffscreenCanvas = original
    else delete scope.OffscreenCanvas
  }
}
