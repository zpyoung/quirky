import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryLog, newestOffset, oldestOffset } from '../src/history/log'
import { composeReplay, formatCursor, pageBefore, parseCursor, textLinesAbove } from '../src/history/reader'
import { Screen } from '../src/screen'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

const roots: string[] = []
function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'qhist-'))
  roots.push(root)
  return join(root, 'session')
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function numbered(prefix: string, from: number, to: number): string {
  let text = ''
  for (let i = from; i <= to; i++) text += `${prefix}-${i}\r\n`
  return text
}

function logWith(
  output: string,
  options: { cols?: number; rows?: number; maxSegmentBytes?: number; chunk?: number } = {}
): string {
  const dir = freshDir()
  const log = HistoryLog.create(dir, { cols: options.cols ?? 80, rows: options.rows ?? 24, maxSegmentBytes: options.maxSegmentBytes })
  const bytes = enc(output)
  const chunk = options.chunk ?? Math.max(bytes.length, 1)
  for (let at = 0; at < bytes.length; at += chunk) log.appendOutput(bytes.subarray(at, at + chunk))
  log.close()
  return dir
}

function numberOf(row: string): number {
  return Number(row.slice(row.indexOf('-') + 1))
}

/** Pages back from "now" until the cursor runs out, returning pages newest first. */
async function pageToTheEnd(dir: string, lines: number, format: 'text' | 'ansi' = 'text') {
  const pages: string[][] = []
  let page = await pageBefore(dir, { lines, format, screenRows: 24 })
  pages.push(page.lines)
  while (page.cursor !== null) {
    page = await pageBefore(dir, { before: parseCursor(page.cursor), lines, format, screenRows: 24 })
    pages.push(page.lines)
    expect(pages.length).toBeLessThan(1000)
  }
  return pages
}

describe('history cursor', () => {
  test('round-trips an output position', () => {
    expect(formatCursor(1234)).toBe('h1.1234')
    expect(parseCursor(formatCursor(0))).toBe(0)
    expect(parseCursor(formatCursor(9_000_000_000))).toBe(9_000_000_000)
  })

  test('rejects anything that is not h1.<digits>', () => {
    for (const bad of ['', 'h1.', 'h2.5', 'h1.-1', 'h1.1.2', '12', 'h1.abc', 'h1. 5', 'H1.5', 'h1.1e3']) {
      expect(() => parseCursor(bad)).toThrow('invalid history cursor')
    }
  })
})

describe('pageBefore', () => {
  test('pages of 300 over 1,000 lines cover every line once, each ending where the last began (SC-11)', async () => {
    const dir = logWith(numbered('h', 1, 1000))
    const pages = await pageToTheEnd(dir, 300)

    expect(pages.length).toBeGreaterThan(2)
    for (const page of pages.slice(0, -1)) expect(page.length).toBeGreaterThanOrEqual(298)
    for (let i = 0; i < pages.length - 1; i++) {
      expect(numberOf(pages[i + 1].at(-1)!) + 1).toBe(numberOf(pages[i][0]))
    }
    const all = pages.slice().reverse().flat()
    // the 24 screen rows (h-978 to h-1000 and the cursor row) are not history
    expect(all).toEqual(Array.from({ length: 977 }, (_, i) => `h-${i + 1}`))
  })

  test('the last page has a null cursor and earlier pages carry a cursor', async () => {
    const dir = logWith(numbered('h', 1, 1000))
    const first = await pageBefore(dir, { lines: 300, format: 'text', screenRows: 24 })
    expect(first.cursor).toMatch(/^h1\.\d+$/)
    const oldest = await pageBefore(dir, { before: parseCursor(first.cursor!), lines: 5000, format: 'text', screenRows: 24 })
    expect(oldest.cursor).toBeNull()
    expect(oldest.lines[0]).toBe('h-1')
  })

  test('a page with fewer rows than the screen is empty with a null cursor', async () => {
    const dir = logWith(numbered('h', 1, 10))
    expect(await pageBefore(dir, { lines: 300, format: 'text', screenRows: 24 })).toEqual({ lines: [], cursor: null })
  })

  test('ansi pages carry the colours of coloured lines and render the same text', async () => {
    let output = ''
    for (let i = 1; i <= 400; i++) output += i % 2 === 0 ? `\x1b[31mred-${i}\x1b[0m\r\n` : `\x1b[1;34mblue-${i}\x1b[0m plain\r\n`
    const dir = logWith(output)

    const text = await pageBefore(dir, { before: newestOffset(dir), lines: 100, format: 'text', screenRows: 24 })
    const ansi = await pageBefore(dir, { before: newestOffset(dir), lines: 100, format: 'ansi', screenRows: 24 })
    expect(ansi.lines.length).toBe(text.lines.length)
    expect(ansi.cursor).toBe(text.cursor)

    expect(ansi.lines.some((row) => row.includes('\x1b[31m'))).toBe(true)
    expect(ansi.lines.some((row) => /\x1b\[(?:[0-9;]*;)?34[;m]/.test(row))).toBe(true)

    const probe = new Screen({ cols: 80, rows: 24, scrollback: 1000 })
    probe.write(ansi.lines.join('\r\n'))
    await probe.settled()
    const rendered = probe.lines().map((row) => row.text)
    expect(rendered.slice(0, text.lines.length)).toEqual(text.lines)
    probe.dispose()
  })

  test('ansi rows stand alone: a style open across a line break is restated and closed in each row', async () => {
    const dir = logWith('\x1b[31mred row\r\nstill red\x1b[0m\r\nplain row\r\n')
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 10, format: 'ansi', screenRows: 24 })
    expect(page.lines).toHaveLength(3)
    expect(page.lines[0]).toStartWith('\x1b[31m')
    expect(page.lines[0]).toEndWith('\x1b[0m')
    expect(page.lines[1]).toContain('\x1b[31mstill red')
    expect(page.lines[2]).toBe('plain row')
  })

  test('a carriage-return progress bar redrawn 100 times then done reads back as one line (SC-14)', async () => {
    let output = 'before\r\n'
    for (let i = 1; i <= 100; i++) output += `\r[${'#'.repeat(i / 5)}${'.'.repeat(20 - i / 5)}] ${i}%`
    output += '\r\ndone\r\n'
    const dir = logWith(output, { chunk: 7 })
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 50, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual(['before', `[${'#'.repeat(20)}] 100%`, 'done'])
  })

  test('a window spanning a resize renders each part at its width', async () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc(`${'x'.repeat(60)}\r\n`))
    log.appendResize(120, 24)
    log.appendOutput(enc(`${'y'.repeat(100)}\r\n`))
    log.close()
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 50, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual(['x'.repeat(60), 'y'.repeat(100)])
  })

  test('a window starting after a resize uses the size in force at its start, and wrapped rows are their own entries', async () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc(`${'x'.repeat(60)}\r\n`))
    log.appendResize(40, 24)
    log.appendOutput(enc(`${'y'.repeat(60)}\r\n`))
    log.close()
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 2, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual(['y'.repeat(40), 'y'.repeat(20)])
    expect(page.cursor).toBe(formatCursor(62))
  })

  test('output that left the alternate screen on shows the normal screen rows', async () => {
    const dir = logWith('one\r\ntwo\r\n\x1b[?1049h\x1b[Hfull screen app\r\n')
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 20, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual(['one', 'two'])
  })

  test('a before older than the oldest retained output clamps to an empty page with a null cursor', async () => {
    const dir = logWith(numbered('h', 1, 100))
    expect(await pageBefore(dir, { before: 0, lines: 10, format: 'text', screenRows: 24 })).toEqual({ lines: [], cursor: null })
    const past = await pageBefore(dir, { before: newestOffset(dir) + 5000, lines: 10, format: 'text', screenRows: 24 })
    expect(past.lines.at(-1)).toBe('h-100')
  })

  test('long sessions keep a whole-line start inside the retained 16 to 32 units (SC-12 scaled)', async () => {
    const unit = 8000
    const line = (i: number) => `${String(i).padStart(6, '0')}-${'x'.repeat(71)}\r\n`
    let output = ''
    for (let i = 1; i <= 4000; i++) output += line(i)
    expect(output.length).toBe(40 * unit)

    const dir = logWith(output, { maxSegmentBytes: 16 * unit, chunk: 1000 })
    const retained = newestOffset(dir) - oldestOffset(dir)
    expect(retained).toBeGreaterThanOrEqual(15 * unit)
    expect(retained).toBeLessThanOrEqual(32 * unit + 1005)

    const pages: string[][] = []
    let before = newestOffset(dir)
    for (;;) {
      const page = await pageBefore(dir, { before, lines: 300, format: 'text', screenRows: 24 })
      pages.push(page.lines)
      if (page.cursor === null) break
      before = parseCursor(page.cursor)
    }
    const all = pages.reverse().flat()
    expect(all[0]).toMatch(/^\d{6}-x{71}$/)
    const first = Number(all[0].slice(0, 6))
    expect(all).toEqual(Array.from({ length: 4000 - first + 1 }, (_, i) => line(first + i).trimEnd()))
    expect((first - 1) * 80).toBeGreaterThanOrEqual(oldestOffset(dir))
    // the byte before the oldest retained one is gone, so a line starting exactly there is not known to be whole
    expect((first - 1) * 80).toBeLessThanOrEqual(oldestOffset(dir) + 80)
  })

  test('a page never reads past the 8 MiB cap', async () => {
    const mib = 1024 * 1024
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    const block = new Uint8Array(mib).fill(0x78)
    for (let i = 0; i < 9; i++) log.appendOutput(block)
    log.close()

    const page = await pageBefore(dir, { lines: 10, format: 'text', screenRows: 24 })
    expect(page.cursor).toBe(formatCursor(9 * mib - 8 * mib))
    expect(page.lines.join('').length).toBeLessThanOrEqual(8 * mib)
    expect(page.lines.join('').length).toBeGreaterThan(8 * mib - 24 * 80)

    const older = await pageBefore(dir, { before: parseCursor(page.cursor!), lines: 10, format: 'text', screenRows: 24 })
    expect(older.cursor).toBeNull()
    expect(older.lines.join('').length).toBe(mib)
  }, 60_000)

  test('a damaged or missing log yields an empty page instead of throwing', async () => {
    const missing = freshDir()
    expect(await pageBefore(missing, { lines: 10, format: 'text', screenRows: 24 })).toEqual({ lines: [], cursor: null })

    const dir = logWith(numbered('h', 1, 50))
    writeFileSync(join(dir, 'output.log'), 'not a log at all, just garbage bytes')
    expect(await pageBefore(dir, { lines: 10, format: 'text', screenRows: 24 })).toEqual({ lines: [], cursor: null })
  })
})

describe('textLinesAbove', () => {
  test('returns the last lines above the screen, trimmed to the count', async () => {
    const dir = logWith(numbered('r', 1, 500))
    const rows = await textLinesAbove(dir, 100, 24)
    expect(rows).toEqual(Array.from({ length: 100 }, (_, i) => `r-${378 + i}`))
  })

  test('returns fewer when less history exists, and nothing for zero', async () => {
    const dir = logWith(numbered('r', 1, 40))
    expect(await textLinesAbove(dir, 100, 24)).toEqual(Array.from({ length: 17 }, (_, i) => `r-${i + 1}`))
    expect(await textLinesAbove(dir, 0, 24)).toEqual([])
  })
})

describe('composeReplay', () => {
  function liveScreen(output: string): Screen {
    const screen = new Screen({ cols: 80, rows: 24, scrollback: 10_000 })
    screen.write(output)
    return screen
  }

  test('replays 2,000 history lines then the live screen exactly (SC-8)', async () => {
    const output = numbered('h', 1, 5000)
    const dir = logWith(output, { chunk: 4096 })
    const live = liveScreen(output)
    await live.settled()
    const snapshot = live.snapshot()

    const { replay, historyCursor } = await composeReplay(dir, { historyLines: 2000, live: snapshot })
    expect(historyCursor).toMatch(/^h1\.\d+$/)

    const fresh = new Screen({ cols: 80, rows: 24, scrollback: 10_000 })
    fresh.write(replay)
    await fresh.settled()

    const expected = live.lines().slice(-(2000 + 24))
    const rows = fresh.lines()
    expect(rows.length).toBe(2000 + 24)
    expect(rows.map((row) => row.text)).toEqual(expected.map((row) => row.text))
    expect(rows[0].text).toBe('h-2978')
    expect(fresh.scrollbackRows).toBe(2000)
    expect(fresh.snapshot().ansi).toBe(snapshot.ansi)
    expect(fresh.snapshot().cursor).toEqual(snapshot.cursor)

    const older = await pageBefore(dir, { before: parseCursor(historyCursor!), lines: 3, format: 'text', screenRows: 24 })
    expect(older.lines.at(-1)).toBe('h-2977')
    live.dispose()
    fresh.dispose()
  })

  test('historyCursor is null when the whole log fits in the replay', async () => {
    const output = numbered('h', 1, 100)
    const dir = logWith(output)
    const live = liveScreen(output)
    await live.settled()
    const { replay, historyCursor } = await composeReplay(dir, { historyLines: 2000, live: live.snapshot() })
    expect(historyCursor).toBeNull()

    const fresh = new Screen({ cols: 80, rows: 24, scrollback: 10_000 })
    fresh.write(replay)
    await fresh.settled()
    expect(fresh.lines().map((row) => row.text)).toEqual(live.lines().map((row) => row.text))
    live.dispose()
    fresh.dispose()
  })

  test('an empty log gives just the live snapshot and the cursor position', async () => {
    const live = liveScreen('\x1b[31mhello\x1b[0m')
    await live.settled()
    const snapshot = live.snapshot()

    const dir = freshDir()
    HistoryLog.create(dir, { cols: 80, rows: 24 }).close()
    for (const target of [dir, freshDir()]) {
      const { replay, historyCursor } = await composeReplay(target, { historyLines: 2000, live: snapshot })
      expect(historyCursor).toBeNull()
      expect(dec(replay)).toBe(`${snapshot.ansi}\x1b[${snapshot.cursor.y + 1};${snapshot.cursor.x + 1}H`)
    }
    live.dispose()
  })

  test('keeps a full-screen program in the alternate screen with history behind it', async () => {
    const output = `${numbered('h', 1, 100)}\x1b[?1049h\x1b[2J\x1b[Happ frame\x1b[5;10Hcursor here`
    const dir = logWith(output)
    const live = liveScreen(output)
    await live.settled()
    const snapshot = live.snapshot()
    expect(snapshot.modes.alternateScreen).toBe(true)

    const { replay } = await composeReplay(dir, { historyLines: 50, live: snapshot })
    const fresh = new Screen({ cols: 80, rows: 24, scrollback: 10_000 })
    fresh.write(replay)
    await fresh.settled()
    expect(fresh.isAlternate).toBe(true)
    expect(fresh.snapshot().ansi).toBe(snapshot.ansi)
    expect(fresh.snapshot().cursor).toEqual(snapshot.cursor)
    expect(fresh.scrollbackRows).toBeGreaterThanOrEqual(50)
    live.dispose()
    fresh.dispose()
  })
})
