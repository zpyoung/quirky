import type { SerializeAddon } from '@xterm/addon-serialize'
import { Screen } from '../screen'
import { LogReader } from './log'

/** The most output bytes one window reads, so a single page or attach stays bounded. */
const READ_CAP_BYTES = 8 * 1024 * 1024

/** How far past the oldest retained byte to look for the end of a cut-off first line. */
const LINE_START_SCAN_BYTES = 64 * 1024
const READ_BLOCK_BYTES = 64 * 1024

/** Bytes that start a new row without a wrap: LF, VT and FF. */
const BREAK_BYTES = new Set([0x0a, 0x0b, 0x0c])
const CURSOR_PATTERN = /^h1\.(\d+)$/
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const ALT_SCREEN_OFF = '\x1b[?1049l'
// colours, scroll region, origin, insert and wrap modes the window left behind must not shape the live snapshot
const CLEAR_FOR_LIVE = '\x1b[0m\x1b[r\x1b[?6l\x1b[4l\x1b[?7h\x1b[H\x1b[2J'

/** How far before a window to look for the SGR state in effect where it begins. */
const LEAD_IN_BYTES = 64 * 1024
/** The most SGR text carried into a window; older sequences are dropped whole. */
const LEAD_SGR_MAX_CHARS = 4096

const CONTROL_ROWS_PER_LINE = 32
const CONTROL_ROWS_MIN = 4096

const encoder = new TextEncoder()

type Size = { cols: number; rows: number }

type WindowEvent = { kind: 'output'; bytes: Uint8Array } | { kind: 'resize'; cols: number; rows: number }

/** A stretch of the log, `[start, end)` in output positions, with `oldest` the first line the log still holds whole. */
type Located = { start: number; end: number; oldest: number }

type Piece = { offset: number; bytes: Uint8Array }

type Window = Located & { size: Size | null; events: WindowEvent[]; lead: Uint8Array }

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

function indexOfBreak(bytes: Uint8Array, from: number, to = bytes.length): number {
  for (let i = from; i < to; i++) if (BREAK_BYTES.has(bytes[i])) return i
  return -1
}

function lastIndexOfBreak(bytes: Uint8Array, from: number): number {
  for (let i = from; i >= 0; i--) if (BREAK_BYTES.has(bytes[i])) return i
  return -1
}

/**
 * Absolute output position of the first line start at or after the oldest retained byte. Looks
 * ahead only `LINE_START_SCAN_BYTES`, so a line longer than that at the edge counts as whole.
 */
function wholeLineStart(reader: LogReader, retainedStart: number, newest: number): number {
  if (retainedStart === 0) return 0
  let budget = LINE_START_SCAN_BYTES
  try {
    for (const segment of reader.segments) {
      for (const record of segment.records) {
        if (record.kind !== 'output' || record.offset + record.length <= retainedStart || record.offset >= newest) continue
        const limit = Math.min(record.length, newest - record.offset)
        for (let from = Math.max(0, retainedStart - record.offset); from < limit && budget > 0; ) {
          const to = from + Math.min(limit - from, READ_BLOCK_BYTES, budget)
          const found = indexOfBreak(reader.readOutput(segment, record, from, to), 0)
          if (found >= 0) return record.offset + from + found + 1
          budget -= to - from
          from = to
        }
      }
    }
  } catch {
    // an unreadable stretch leaves the first line counted as whole
  }
  return retainedStart
}

function firstBreak(pieces: Piece[], from: number, end: number): number {
  for (const piece of pieces) {
    if (piece.offset + piece.bytes.length <= from || piece.offset >= end) continue
    const skip = Math.max(0, from - piece.offset)
    const found = indexOfBreak(piece.bytes, skip, Math.min(piece.bytes.length, end - piece.offset))
    if (found >= 0) return piece.offset + found
  }
  return -1
}

/**
 * Reads the log backwards from `end` until the `wanted`-th line break, the oldest whole line or
 * the read cap, whichever comes first. Returns where it stopped and the bytes it read, oldest
 * first; `failed` is set when a read error cut it short, in which case `start` is the lowest
 * position that was read.
 */
function readBackwards(
  reader: LogReader,
  oldest: number,
  end: number,
  wanted: number
): { start: number; pieces: Piece[]; failed: boolean } {
  const pieces: Piece[] = []
  let breaks = 0
  let budget = READ_CAP_BYTES
  let lowest = end
  const stopAt = (start: number, failed = false) => ({ start, pieces: pieces.reverse(), failed })
  try {
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
          lowest = record.offset + lo
          budget -= hi - lo
          for (let at = bytes.length; at > 0; ) {
            at = lastIndexOfBreak(bytes, at - 1)
            if (at < 0) break
            if (++breaks === wanted) return stopAt(record.offset + lo + at)
          }
          if (budget === 0) return stopAt(record.offset + lo)
          hi = lo
        }
      }
    }
  } catch {
    return stopAt(lowest, true)
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
  // an unreadable stretch ends the page with no cursor, since the same stretch would fail again
  if (read.failed && read.pieces.length === 0) return { start: oldest, end: oldest, oldest, pieces: [] }
  let start = Math.max(read.start, oldest)
  if (start > oldest) {
    const lineBreak = firstBreak(read.pieces, start, end)
    // a window with no line break before its end keeps its cut, so paging always moves
    if (lineBreak >= 0 && lineBreak + 1 < end) start = lineBreak + 1
  }
  return { start, end, oldest, pieces: read.pieces }
}

function buildWindow(reader: LogReader, located: Located & { pieces: Piece[] }, lead: Uint8Array): Window {
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
  return { start, end, oldest: located.oldest, size, events, lead }
}

/** Bytes `[from, to)` of output, or none at all when any of them cannot be read. */
function readRange(reader: LogReader, from: number, to: number): Uint8Array {
  const parts: Uint8Array[] = []
  try {
    for (const segment of reader.segments) {
      for (const record of segment.records) {
        if (record.kind !== 'output' || record.offset + record.length <= from || record.offset >= to) continue
        parts.push(reader.readOutput(segment, record, Math.max(0, from - record.offset), Math.min(record.length, to - record.offset)))
      }
    }
  } catch {
    return new Uint8Array()
  }
  return Buffer.concat(parts)
}

/** True when an SGR parameter list contains a reset (an empty or `0` parameter that is not a colour argument). */
function resetsStyle(params: string): boolean {
  const list = params.split(';')
  for (let i = 0; i < list.length; i++) {
    const param = list[i]
    if (param === '' || param === '0') return true
    if (param === '38' || param === '48' || param === '58') i += list[i + 1] === '5' ? 2 : list[i + 1] === '2' ? 4 : 0
  }
  return false
}

/**
 * The SGR sequences that, written into a fresh terminal, recreate the style `bytes` leave behind:
 * everything from the last sequence that resets. At most `LEAD_SGR_MAX_CHARS` characters are
 * kept, dropping the oldest sequences whole, so style set further back than that is lost.
 */
function sgrState(bytes: Uint8Array): Uint8Array {
  const sequences = [...Buffer.from(bytes).toString('latin1').matchAll(/\x1b\[([0-9;:]*)m/g)]
  let first = 0
  for (let i = sequences.length - 1; i >= 0; i--) {
    if (resetsStyle(sequences[i][1])) {
      first = i
      break
    }
  }
  const kept = sequences.slice(first).map((match) => match[0])
  let chars = kept.reduce((sum, sequence) => sum + sequence.length, 0)
  while (chars > LEAD_SGR_MAX_CHARS && kept.length > 0) chars -= kept.shift()!.length
  return Buffer.from(kept.join(''), 'latin1')
}

/**
 * Opens the log, reads the window a page or attach needs, and closes the log again. The window
 * carries the SGR state in effect at its start, found in at most `LEAD_IN_BYTES` before it, so
 * rows keep colours set earlier. A log that cannot be read gives an empty window.
 */
function readWindow(dir: string, before: number | undefined, lines: number, screenRows: number): Window {
  let reader: LogReader | null = null
  try {
    reader = LogReader.open(dir)
    const located = locate(reader, before, lines, screenRows)
    const floor = reader.segments[0]?.startOffset ?? 0
    const lead = located.start > floor ? sgrState(readRange(reader, Math.max(floor, located.start - LEAD_IN_BYTES), located.start)) : new Uint8Array()
    return buildWindow(reader, located, lead)
  } catch {
    return { start: 0, end: 0, oldest: 0, size: null, events: [], lead: new Uint8Array() }
  } finally {
    try {
      reader?.close()
    } catch {
      // the descriptors are already gone
    }
  }
}

/**
 * Rows a window's text can fill: the rows its characters wrap into at the narrowest width in
 * force (a cell takes at least a byte), the reflow after a resize, and `controlRows` for rows
 * that control bytes open without text (line breaks, VT, FF, IND, NEL). The last term is a
 * budget, not a count: a window that needs more is narrowed, not given more memory.
 */
function scrollbackFor(window: Window, initial: Size, controlRows: number): number {
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
  const wraps = Math.ceil(bytes / Math.max(1, minCols))
  // a wide character is two cells in three bytes, so a reflow adds at most 2 * bytes / cols rows
  const reflow = resizes > 0 ? Math.ceil((2 * bytes) / Math.max(2, minCols)) : 0
  return wraps + reflow + controlRows + maxRows * (resizes + 2) + 16
}

/**
 * The rows, beyond those the text wraps into, that a page of about `lines` rows may open with
 * control bytes. A window needing more is narrowed by `renderBounded`, so the scratch screen's
 * memory follows the page asked for, not how many rows a stream of VT, FF, IND or NEL bytes can
 * produce.
 */
export function scratchControlRows(lines: number, screenRows: number): number {
  return CONTROL_ROWS_PER_LINE * (Math.max(0, lines) + Math.max(0, screenRows)) + CONTROL_ROWS_MIN
}

/**
 * The newest quarter of a window, starting just after a line break near the three-quarter mark
 * (or at the mark when there is none), with the style and size in force where it now begins.
 * Null when the window is too short to shrink.
 */
function narrow(window: Window): Window | null {
  const length = window.end - window.start
  if (length < 2) return null
  const mark = window.start + Math.floor((length * 3) / 4)

  let cut = mark
  let at = window.start
  for (const event of window.events) {
    if (event.kind !== 'output') continue
    const found = at + event.bytes.length > mark ? indexOfBreak(event.bytes, Math.max(0, mark - at)) : -1
    if (found >= 0) {
      cut = at + found + 1
      break
    }
    at += event.bytes.length
  }
  if (cut >= window.end) cut = mark

  const events: WindowEvent[] = []
  const dropped: Uint8Array[] = [window.lead]
  let size = window.size
  at = window.start
  for (const event of window.events) {
    if (event.kind === 'resize') {
      if (at <= cut) size = { cols: event.cols, rows: event.rows }
      else events.push(event)
      continue
    }
    const skip = Math.min(event.bytes.length, Math.max(0, cut - at))
    if (skip > 0) dropped.push(event.bytes.subarray(0, skip))
    if (skip < event.bytes.length) events.push({ kind: 'output', bytes: event.bytes.subarray(skip) })
    at += event.bytes.length
  }
  return { ...window, start: cut, size, events, lead: sgrState(Buffer.concat(dropped)) }
}

/**
 * Replays the window into a scratch screen sized for it and leaves the screen on the normal
 * buffer, so a window that ended inside a full-screen program still yields its scrolled rows.
 * `full` is set when the screen filled its scrollback, so rows may have been trimmed.
 */
async function renderWindow(
  window: Window,
  fallback: Size,
  controlRows: number
): Promise<{ screen: Screen; size: Size; full: boolean }> {
  const size = { ...(window.size ?? fallback) }
  const scrollback = scrollbackFor(window, size, controlRows)
  const screen = new Screen({ cols: size.cols, rows: size.rows, scrollback })
  if (window.lead.length > 0) screen.write(window.lead)
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
  return { screen, size, full: screen.scrollbackRows >= scrollback }
}

/**
 * Renders the window, shrinking it to its newest part while the render fills its scrollback, so the
 * rows rendered are exactly the rows of the returned window and its start is the page cursor.
 */
async function renderBounded(
  window: Window,
  fallback: Size,
  controlRows: number
): Promise<{ screen: Screen; size: Size; window: Window }> {
  for (;;) {
    const rendered = await renderWindow(window, fallback, controlRows)
    const narrower = rendered.full ? narrow(window) : null
    if (!narrower) return { screen: rendered.screen, size: rendered.size, window }
    rendered.screen.dispose()
    window = narrower
  }
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
  const read = readWindow(dir, options.before, options.lines, options.screenRows)
  if (read.start >= read.end) return { lines: [], cursor: read.start > read.oldest ? formatCursor(read.start) : null }

  const fallback = { cols: DEFAULT_COLS, rows: options.screenRows || DEFAULT_ROWS }
  const { screen, window } = await renderBounded(read, fallback, scratchControlRows(options.lines, options.screenRows))
  const cursor = window.start > window.oldest ? formatCursor(window.start) : null
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
 * the live screen, which already ends with the live cursor, style and pending wrap, so nothing
 * is appended that could cancel them. `historyCursor` pages further back and is null
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
  const read = readWindow(dir, undefined, options.historyLines, live.rows)
  if (!read.events.some((event) => event.kind === 'output')) {
    return { replay: encoder.encode(live.ansi), historyCursor: null }
  }

  const controlRows = scratchControlRows(options.historyLines, live.rows)
  const { screen, size, window } = await renderBounded(read, { cols: live.cols, rows: live.rows }, controlRows)
  try {
    if (size.cols !== live.cols || size.rows !== live.rows) screen.resize(live.cols, live.rows)
    screen.write(CLEAR_FOR_LIVE + live.ansi)
    await screen.settled()
    return {
      replay: encoder.encode(screen.serialize()),
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
