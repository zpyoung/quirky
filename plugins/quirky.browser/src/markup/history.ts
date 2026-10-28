import type { MarkupShape } from './geometry'

export const MARKUP_HISTORY_LIMIT = 100

export type MarkupHistory = {
  shapes: MarkupShape[]
  undo: MarkupShape[][]
  redo: MarkupShape[][]
}

export function createMarkupHistory(): MarkupHistory {
  return { shapes: [], undo: [], redo: [] }
}

function pushSnapshot(snapshots: MarkupShape[][], snapshot: MarkupShape[]): MarkupShape[][] {
  return [...snapshots.slice(-(MARKUP_HISTORY_LIMIT - 1)), snapshot]
}

export function commitMarkupAction(history: MarkupHistory, shapes: MarkupShape[]): MarkupHistory {
  if (shapes.length === history.shapes.length && shapes.every((shape, index) => shape === history.shapes[index])) return history
  return {
    shapes,
    undo: pushSnapshot(history.undo, history.shapes),
    redo: []
  }
}

export function clearMarkup(history: MarkupHistory): MarkupHistory {
  return history.shapes.length === 0 ? history : commitMarkupAction(history, [])
}

export function undoMarkup(history: MarkupHistory): MarkupHistory {
  const shapes = history.undo.at(-1)
  if (!shapes) return history
  return {
    shapes,
    undo: history.undo.slice(0, -1),
    redo: pushSnapshot(history.redo, history.shapes)
  }
}

export function redoMarkup(history: MarkupHistory): MarkupHistory {
  const shapes = history.redo.at(-1)
  if (!shapes) return history
  return {
    shapes,
    undo: pushSnapshot(history.undo, history.shapes),
    redo: history.redo.slice(0, -1)
  }
}
