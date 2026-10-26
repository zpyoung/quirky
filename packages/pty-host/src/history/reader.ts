import type { SerializeAddon } from '@xterm/addon-serialize'
import { Screen } from '../screen'
import { LogReader } from './log'

/** The most output bytes one window reads, so a single page or attach stays bounded. */
const READ_CAP_BYTES = 8 * 1024 * 1024

/** How far past the oldest retained byte to look for the end of a cut-off first line. */
const LINE_START_SCAN_BYTES = 64 * 1024
const READ_BLOCK_BYTES = 64 * 1024

const NEWLINE = 0x0a
const CURSOR_PATTERN = /^h1\.(\d+)$/
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const ALT_SCREEN_OFF = '\x1b[?1049l'
// colours, scroll region, origin, insert and wrap modes the window left behind must not shape the live snapshot
const CLEAR_FOR_LIVE = '\x1b[0m\x1b[r\x1b[?6l\x1b[4l\x1b[?7h\x1b[H\x1b[2J'

const encoder = new TextEncoder()

type Size = { cols: number; rows: number }

type WindowEvent = { kind: 'output'; bytes: Uint8Array } | { kind: 'resize'; cols: number; rows: number }

/** A stretch of the log, `[start, end)` in output positions, with `oldest` the first line the log still holds whole. */
type Located = { start: number; end: number; oldest: number }

type Piece = { offset: number; bytes: Uint8Array }

type Window = Located & { size: Size | null; events: WindowEvent[] }

export type HistoryPage = { lines: string[]; cursor: string | null }

/** The opaque paging token for the output position where a page's window begins. */
export function formatCursor(offset: number): string {
  return `h1.${offset}`
}

/** Inverse of `formatCursor`; throws `Error('invalid history cursor')` for any other string. */
export function parseCursor(cursor: string): number {
  const match = CURSOR_PATTERN.exec(cursor)
  const offset = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(offset)) throw new Error('invalid history cursor')
  return offset
}

/**
 * Absolute output position of the first line start at or after the oldest retained byte. Looks
 * ahead only `LINE_START_SCAN_BYTES`, so a line longer than that at the edge counts as whole.
 */
function wholeLineStart(reader: LogReader, retainedStart: number, newest: number): number {
  if (retainedStart === 0) return 0
  let budget = LINE_START_SCAN_BYTES
  for (const segment of reader.segments) {
    for (const record of segment.records) {
      if (record.kind !== 'output' || record.offset + record.length <= retainedStart || record.offset >= newest) continue
      const limit = Math.min(record.length, newest - record.offset)
      for (let from = Math.max(0, retainedStart - record.offset); from < limit && budget > 0; ) {
        const to = from + Math.min(limit - from, READ_BLOCK_BYTES, budget)
        const found = reader.readOutput(segment, record, from, to).indexOf(NEWLINE)
        if (found >= 0) return record.offset + from + found + 1
        budget -= to - from
        from = to
      }
    }
  }
  return retainedStart
}

function firstNewline(pieces: Piece[], from: number, end: number): number {
  for (const piece of pieces) {
    if (piece.offset + piece.bytes.length <= from || piece.offset >= end) continue
    const skip = Math.max(0, from - piece.offset)
    const found = piece.bytes.subarray(skip, Math.min(piece.bytes.length, end - piece.offset)).indexOf(NEWLINE)
    if (found >= 0) return piece.offset + skip + found
  }
  return -1
}

/**
 * Reads the log backwards from `end` until the `wanted`-th newline, the oldest whole line or the
 * read cap, whichever comes first. Returns where it stopped and the bytes it read, oldest first.
 */
function readBackwards(reader: LogReader, oldest: number, end: number, wanted: number): { start: number; pieces: Piece[] } {
  const pieces: Piece[] = []
  let newlines = 0
  let budget = READ_CAP_BYTES
  const stopAt = (start: number) => ({ start, pieces: pieces.reverse() })
  for (let s = reader.segments.length - 1; s >= 0; s--) {
    const segment = reader.segments[s]
    for (let r = segment.records.length - 1; r >= 0; r--) {
      const record = segment.records[r]
      if (record.kind !== 'output' || record.offset >= end || record.offset + record.length <= oldest) continue
      const floor = Math.max(0, oldest - record.offset)
      for (let hi = Math.min(record.length, end - record.offset); hi > floor; ) {
        const lo = hi - Math.min(hi - floor, READ_BLOCK_BYTES, budget)
        const bytes = reader.readOutput(segment, record, lo, hi)
        pieces.push({ offset: record.offset + lo, bytes })
        budget -= hi - lo
        for (let at = bytes.length; at > 0; ) {
          at = bytes.lastIndexOf(NEWLINE, at - 1)
          if (at < 0) break
          if (++newlines === wanted) return stopAt(record.offset + lo + at)
        }
        if (budget === 0) return stopAt(record.offset + lo)
        hi = lo
      }
    }
  }
  return stopAt(oldest)
}

function locate(reader: LogReader, before: number | undefined, lines: number, screenRows: number): Located & { pieces: Piece[] } {
  const { segments } = reader
  if (segments.length === 0) return { start: 0, end: 0, oldest: 0, pieces: [] }
  const newest = segments[segments.length - 1].endOffset
  const oldest = wholeLineStart(reader, segments[0].startOffset, newest)
  const end = before === undefined ? newest : Math.min(Math.max(before, oldest), newest)
  if (end <= oldest) return { start: oldest, end: oldest, oldest, pieces: [] }

  const wanted = before === undefined ? lines + screenRows : lines
  if (wanted <= 0) return { start: end, end, oldest, pieces: [] }
  const read = readBackwards(reader, oldest, end, wanted)
  let start = Math.max(read.start, oldest)
  if (start > oldest) {
    const newline = firstNewline(read.pieces, start, end)
    // a window with no newline before its end keeps its cut, so paging always moves
    if (newline >= 0 && newline + 1 < end) start = newline + 1
  }
  return { start, end, oldest, pieces: read.pieces }
}

function buildWindow(reader: LogReader, located: Located & { pieces: Piece[] }): Window {
  const { start, end, pieces } = located
  let size: Size | null = null
  const events: WindowEvent[] = []
  let at = start
  const outputUpTo = (to: number) => {
    for (const piece of pieces) {
      const from = Math.max(at, piece.offset)
      const upto = Math.min(to, piece.offset + piece.bytes.length)
      if (upto > from) events.push({ kind: 'output', bytes: piece.bytes.subarray(from - piece.offset, upto - piece.offset) })
    }
    at = Math.max(at, to)
  }
  for (const segment of reader.segments) {
    for (const record of segment.records) {
      if (record.kind !== 'resize') continue
      if (record.offset <= start) {
        size = { cols: record.cols!, rows: record.rows! }
      } else if (record.offset < end) {
        outputUpTo(record.offset)
        events.push({ kind: 'resize', cols: record.cols!, rows: record.rows! })
      }
    }
  }
  outputUpTo(end)
  return { start, end, oldest: located.oldest, size, events }
}

/** Opens the log, reads the window a page or attach needs, and closes the log again. */
function readWindow(dir: string, before: number | undefined, lines: number, screenRows: number): Window {
  const reader = LogReader.open(dir)
  try {
    return buildWindow(reader, locate(reader, before, lines, screenRows))
  } finally {
    reader.close()
  }
}

/**
 * Rows a window can produce. A byte advances at most one row whatever advances it (a line feed,
 * VT, FF, NEL, IND or a wrap), and a narrower width after a resize reflows what is already there.
 */
function scrollbackFor(window: Window, initial: Size): number {
  let bytes = 0
  let resizes = 0
  let minCols = initial.cols
  let maxRows = initial.rows
  for (const event of window.events) {
    if (event.kind === 'resize') {
      resizes++
      minCols = Math.min(minCols, event.cols)
      maxRows = Math.max(maxRows, event.rows)
    } else {
      bytes += event.bytes.length
    }
  }
  // a wide character is two cells in three bytes, so a reflow adds at most 2 * bytes / cols rows
  const reflow = resizes > 0 ? Math.ceil((2 * bytes) / Math.max(2, minCols)) : 0
  return bytes + reflow + maxRows * (resizes + 2) + 16
}

/**
 * Replays the window into a scratch screen sized for it and leaves the screen on the normal
 * buffer, so a window that ended inside a full-screen program still yields its scrolled rows.
 */
async function renderWindow(window: Window, fallback: Size): Promise<{ screen: Screen; size: Size }> {
  const size = { ...(window.size ?? fallback) }
  const screen = new Screen({ cols: size.cols, rows: size.rows, scrollback: scrollbackFor(window, size) })
  for (const event of window.events) {
    if (event.kind === 'output') {
      screen.write(event.bytes)
    } else {
      await screen.settled()
      screen.resize(event.cols, event.rows)
      size.cols = event.cols
      size.rows = event.rows
    }
  }
  await screen.settled()
  if (screen.isAlternate) {
    screen.write(ALT_SCREEN_OFF)
    await screen.settled()
  }
  return { screen, size }
}

/**
 * One buffer row as ANSI that stands alone: the serializer starts every row from default style
 * and trails the terminal's current style, which is state, not content, so it is cut off.
 */
function serializeRow(screen: Screen, y: number): string {
  const { addon } = screen as unknown as { addon: SerializeAddon }
  const raw = addon.serialize({ range: { start: y, end: y }, excludeModes: true, excludeAltBuffer: true })
  const row = raw.replace(/(?:\x1b\[[0-9;:]*m)+$/, '')
  return row.includes('\x1b') ? `${row}\x1b[0m` : row
}

/**
 * The rows of history before an output position, rendered by replaying the log through a scratch
 * emulator so redraws in place read back as they looked.
 *
 * `before` omitted means the live end of the log; the page then stops where the live screen
 * (the last `screenRows` rows) begins. `lines` sizes the window rather than trimming the page,
 * so a page holds about that many rows, and the next page, asked for before `cursor`, begins
 * exactly where this one ends. `cursor` is null once the oldest retained line is reached. `ansi`
 * rows carry their SGR colours, one entry per buffer row, so a wrapped line is several entries.
 * A damaged log yields what can be read, never an error.
 */
export async function pageBefore(
  dir: string,
  options: { before?: number; lines: number; format: 'text' | 'ansi'; screenRows: number }
): Promise<HistoryPage> {
  const window = readWindow(dir, options.before, options.lines, options.screenRows)
  const cursor = window.start > window.oldest ? formatCursor(window.start) : null
  if (window.start >= window.end) return { lines: [], cursor }

  const fallback = { cols: DEFAULT_COLS, rows: options.screenRows || DEFAULT_ROWS }
  const { screen } = await renderWindow(window, fallback)
  try {
    const rows = screen.lines()
    let count = options.before === undefined ? Math.max(0, rows.length - options.screenRows) : rows.length
    while (count > 0 && rows[count - 1].text === '') count--
    const lines =
      options.format === 'text'
        ? rows.slice(0, count).map((row) => row.text)
        : Array.from({ length: count }, (_, y) => serializeRow(screen, y))
    return { lines, cursor }
  } finally {
    screen.dispose()
  }
}

/**
 * The bytes a client writes into a fresh terminal on attach: recent history as scrollback, then
 * the live screen, then the live cursor position. `historyCursor` pages further back and is null
 * when nothing older is retained. With no readable output the replay is the live screen alone.
 */
export async function composeReplay(
  dir: string,
  options: {
    historyLines: number
    live: { ansi: string; cols: number; rows: number; cursor: { x: number; y: number } }
  }
): Promise<{ replay: Uint8Array; historyCursor: string | null }> {
  const { live } = options
  const cursorMove = `\x1b[${live.cursor.y + 1};${live.cursor.x + 1}H`
  const window = readWindow(dir, undefined, options.historyLines, live.rows)
  if (!window.events.some((event) => event.kind === 'output')) {
    return { replay: encoder.encode(live.ansi + cursorMove), historyCursor: null }
  }

  const { screen, size } = await renderWindow(window, { cols: live.cols, rows: live.rows })
  try {
    if (size.cols !== live.cols || size.rows !== live.rows) screen.resize(live.cols, live.rows)
    screen.write(CLEAR_FOR_LIVE + live.ansi)
    await screen.settled()
    return {
      replay: encoder.encode(screen.serialize() + cursorMove),
      historyCursor: window.start > window.oldest ? formatCursor(window.start) : null
    }
  } finally {
    screen.dispose()
  }
}

/** The last `lines` text rows above the live screen, for a plain `read`; trimmed, unlike a page. */
export async function textLinesAbove(dir: string, lines: number, screenRows: number): Promise<string[]> {
  if (lines <= 0) return []
  const page = await pageBefore(dir, { lines, format: 'text', screenRows })
  return page.lines.slice(-lines)
}
