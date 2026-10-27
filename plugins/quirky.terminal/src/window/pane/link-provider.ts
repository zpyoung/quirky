import type { IBuffer, ILink, ILinkProvider } from '@xterm/xterm'
import { MAX_PATHS_PER_LINE, describeTarget, findPathCandidates, resolveAgainst } from './links'

const MAX_WRAPPED_ROWS = 20
const MAX_CACHED_PATHS = 4000

type Cell = { row: number; col: number; width: number }

/** One logical line of the buffer (a row plus the rows it wraps onto) with the cell behind each character. */
export type LogicalLine = { text: string; cells: Cell[] }

/**
 * Reads the logical line containing 1-based buffer row `y`. `cells[i]` is where `text[i]` sits,
 * so wide characters and surrogate pairs map back to the right columns.
 */
export function readLogicalLine(buffer: Pick<IBuffer, 'getLine'>, y: number): LogicalLine {
  let first = y - 1
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1
  let text = ''
  const cells: Cell[] = []
  for (let row = first, count = 0; count < MAX_WRAPPED_ROWS; row += 1, count += 1) {
    const line = buffer.getLine(row)
    if (!line || (count > 0 && !line.isWrapped)) break
    for (let col = 0; col < line.length; col += 1) {
      const cell = line.getCell(col)
      if (!cell) continue
      const width = cell.getWidth()
      if (width === 0) continue
      const chars = cell.getChars() || ' '
      for (let unit = 0; unit < chars.length; unit += 1) cells.push({ row, col, width })
      text += chars
    }
  }
  return { text: text.trimEnd(), cells }
}

/**
 * Answers whether paths exist through the daemon, in batches of at most 50, remembering answers
 * so hovering the same line again costs nothing. A failed call counts as "does not exist".
 */
export class PathChecker {
  private known = new Map<string, boolean>()

  constructor(private readonly ask: (paths: string[]) => Promise<boolean[]>) {}

  async check(paths: string[]): Promise<boolean[]> {
    const unknown = [...new Set(paths.filter((path) => !this.known.has(path)))]
    for (let start = 0; start < unknown.length; start += MAX_PATHS_PER_LINE) {
      const batch = unknown.slice(start, start + MAX_PATHS_PER_LINE)
      let answers: boolean[] = []
      try {
        answers = await this.ask(batch)
      } catch {
        // an unreachable daemon leaves these unknown so a later hover asks again
        continue
      }
      if (this.known.size > MAX_CACHED_PATHS) this.known.clear()
      batch.forEach((path, index) => this.known.set(path, answers[index] === true))
    }
    return paths.map((path) => this.known.get(path) === true)
  }

  clear(): void {
    this.known.clear()
  }
}

export type FileLinkHandlers = {
  /** The pane's current directory, which relative paths are joined onto. */
  cwd(): string
  hover(target: string | null): void
  activate(event: MouseEvent, link: { path: string; line: number | null; column: number | null }): void
}

/**
 * The link provider for file paths: absolute or cwd-relative paths with an optional
 * `:line:column`, underlined only when the path exists. Any failure yields no links, so a bad
 * line can never break the pane.
 */
export function createFileLinkProvider(
  term: { buffer: { active: Pick<IBuffer, 'getLine'> } },
  checker: PathChecker,
  handlers: FileLinkHandlers
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      void (async () => {
        try {
          const { text, cells } = readLogicalLine(term.buffer.active, y)
          const cwd = handlers.cwd()
          const candidates = findPathCandidates(text).flatMap((match) => {
            const absolute = resolveAgainst(match.path, cwd)
            return absolute ? [{ match, absolute }] : []
          })
          if (candidates.length === 0) return callback(undefined)
          const exists = await checker.check(candidates.map((candidate) => candidate.absolute))
          const links: ILink[] = []
          candidates.forEach(({ match, absolute }, index) => {
            const startCell = cells[match.start]
            const endCell = cells[match.end - 1]
            if (!exists[index] || !startCell || !endCell) return
            const target = describeTarget(absolute, match.line, match.column)
            links.push({
              range: { start: { x: startCell.col + 1, y: startCell.row + 1 }, end: { x: endCell.col + endCell.width, y: endCell.row + 1 } },
              text: match.text,
              activate: (event) => handlers.activate(event, { path: absolute, line: match.line, column: match.column }),
              hover: () => handlers.hover(target),
              leave: () => handlers.hover(null)
            })
          })
          callback(links.length > 0 ? links : undefined)
        } catch {
          callback(undefined)
        }
      })()
    }
  }
}
