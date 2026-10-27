const LEADING_SPACES = /^ */

/**
 * The selection without the left gutter an agent CLI paints its messages behind: only the run of
 * spaces every non-blank line shares is removed, so nested indentation survives, and a selection
 * with any column-zero line is returned as it was.
 */
export function trimGutter(selection: string): string {
  const lines = selection.split('\n').map((raw) => {
    const cr = raw.endsWith('\r')
    const text = cr ? raw.slice(0, -1) : raw
    return { text, cr, indent: LEADING_SPACES.exec(text)![0].length }
  })
  let gutter = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.indent === line.text.length) continue
    gutter = Math.min(gutter, line.indent)
    if (gutter === 0) return selection
  }
  if (!Number.isFinite(gutter)) return selection
  return lines.map((line) => line.text.slice(Math.min(line.indent, gutter)) + (line.cr ? '\r' : '')).join('\n')
}
