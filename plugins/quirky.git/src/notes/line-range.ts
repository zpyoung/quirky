import type { EditorState } from '@codemirror/state'

/** The lines a note covers, 1-based and inclusive; `startLine` equals `line` for a single line. */
export type LineRange = { startLine: number; line: number }

/** The range between two lines in either order. */
export function orderRange(a: number, b: number): LineRange {
  return { startLine: Math.min(a, b), line: Math.max(a, b) }
}

export function sameRange(a: LineRange | null, b: LineRange | null): boolean {
  if (a === null || b === null) return a === b
  return a.startLine === b.startLine && a.line === b.line
}

/** "Line 30" or "Lines 3-7", as the cards head their note. */
export function rangeLabel(range: LineRange): string {
  return range.startLine === range.line ? `Line ${range.line}` : `Lines ${range.startLine}-${range.line}`
}

/**
 * The lines the main selection covers. A selection that ends at column 1 of a later line leaves
 * that line out, since it visually covers only the lines above it; a cursor covers its own line.
 */
export function selectionLineRange(state: EditorState): LineRange {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from)
  const last = state.doc.lineAt(to)
  const endsAtLineStart = to === last.from && last.number > first.number
  return { startLine: first.number, line: endsAtLineStart ? last.number - 1 : last.number }
}
