import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryLog, LogReader, newestOffset, oldestOffset } from '../src/history/log'
import { composeReplay, formatCursor, pageBefore, parseCursor, scratchControlRows, textLinesAbove } from '../src/history/reader'
import { Screen } from '../src/screen'

const realFs = { ...fs }

/** Runs `work` and returns how many bytes the log reader pulled from disk meanwhile. */
async function bytesRead(work: () => Promise<unknown>): Promise<number> {
  let total = 0
  mock.module('node:fs', () => ({
    ...realFs,
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const n = realFs.readSync(...args)
      total += n
      return n
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const data = realFs.readFileSync(...args)
      total += data.length
      return data
    }
  }))
  try {
    await work()
  } finally {
    mock.module('node:fs', () => realFs)
  }
  return total
}

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

  test.each([
    ['ESC E (NEL)', (i: number) => `${i}\x1bE`],
    ['ESC D (IND)', (i: number) => `${i}\x1bD\r`],
    ['LF', (i: number) => `${i}\n\r`],
    ['VT', (i: number) => `${i}\v\r`],
    ['FF', (i: number) => `${i}\f\r`],
    ['U+0085 (NEL)', (i: number) => `${i}\u0085`]
  ])('every row survives when lines advance by %s', async (_name, advance) => {
    const dir = logWith(Array.from({ length: 1000 }, (_, i) => advance(i + 1)).join(''))
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 5000, format: 'text', screenRows: 24 })
    expect(page.cursor).toBeNull()
    expect(page.lines).toEqual(Array.from({ length: 1000 }, (_, i) => String(i + 1)))
  })

  test('every row survives when the only line advance is a wrap', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => String(i % 10).repeat(80))
    const dir = logWith(rows.join(''))
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 5000, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual(rows)
  })

  test('every row survives wrapping at a narrow width mixed with line feeds', async () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 10, rows: 5 })
    const expected: string[] = []
    for (let i = 0; i < 300; i++) {
      log.appendOutput(enc(`${'a'.repeat(35)}\x1bE`))
      expected.push('a'.repeat(10), 'a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5))
    }
    log.close()
    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 5000, format: 'text', screenRows: 5 })
    expect(page.lines).toEqual(expected)
  })

  test('a resize is applied after the output before it has been parsed', async () => {
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    // the cursor jump only lands in column 70 while the screen is still 80 wide
    log.appendOutput(enc('abc\x1b[1;70Hq\r\n'))
    log.appendResize(40, 24)
    log.appendOutput(enc('next\r\n'))
    log.close()

    const reference = new Screen({ cols: 80, rows: 24, scrollback: 100 })
    reference.write('abc\x1b[1;70Hq\r\n')
    await reference.settled()
    reference.resize(40, 24)
    reference.write('next\r\n')
    await reference.settled()
    const expected = reference.lines().map((row) => row.text)
    while (expected.at(-1) === '') expected.pop()
    reference.dispose()

    const page = await pageBefore(dir, { before: newestOffset(dir), lines: 50, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual(expected)
    expect(page.lines.join('\n')).toContain('abc')
    expect(page.lines.at(-1)).toBe('next')
  })

  test('a page never reads past the 8 MiB cap', async () => {
    const mib = 1024 * 1024
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    const block = new Uint8Array(mib).fill(0x78)
    for (let i = 0; i < 9; i++) log.appendOutput(block)
    log.close()

    let page!: Awaited<ReturnType<typeof pageBefore>>
    const read = await bytesRead(async () => {
      page = await pageBefore(dir, { lines: 10, format: 'text', screenRows: 24 })
    })
    expect(read).toBeLessThanOrEqual(8 * mib + 128 * 1024)
    expect(page.cursor).toBe(formatCursor(9 * mib - 8 * mib))
    expect(page.lines.join('').length).toBeLessThanOrEqual(8 * mib)
    expect(page.lines.join('').length).toBeGreaterThan(8 * mib - 24 * 80)

    const older = await pageBefore(dir, { before: parseCursor(page.cursor!), lines: 10, format: 'text', screenRows: 24 })
    expect(older.cursor).toBeNull()
    expect(older.lines.join('').length).toBe(mib)
  }, 60_000)

  test('one record larger than the cap is read only from its tail', async () => {
    const mib = 1024 * 1024
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(new Uint8Array(9 * mib).fill(0x78))
    log.close()

    let page!: Awaited<ReturnType<typeof pageBefore>>
    const read = await bytesRead(async () => {
      page = await pageBefore(dir, { lines: 1, format: 'text', screenRows: 24 })
    })
    expect(read).toBeLessThanOrEqual(8 * mib + 128 * 1024)
    expect(page.cursor).toBe(formatCursor(mib))
  }, 60_000)

  test('an attach reads only the bytes its window needs, not the retained segments', async () => {
    const mib = 1024 * 1024
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    const chunk = enc(numbered('h', 1, 800))
    let appended = 0
    while (appended < 12 * mib) {
      log.appendOutput(chunk)
      appended += chunk.length
    }
    log.close()

    const live = new Screen({ cols: 80, rows: 24, scrollback: 100 })
    live.write('prompt')
    await live.settled()
    const snapshot = live.snapshot()
    live.dispose()

    const replayRead = await bytesRead(() => composeReplay(dir, { historyLines: 2000, live: snapshot }))
    expect(replayRead).toBeLessThan(mib / 2)
    const before = newestOffset(dir)
    const pageRead = await bytesRead(() => pageBefore(dir, { before, lines: 100, format: 'text', screenRows: 24 }))
    expect(pageRead).toBeLessThan(mib / 2)
  }, 60_000)

  test('a replay of a log with no newlines still stops at the cap', async () => {
    const mib = 1024 * 1024
    const dir = freshDir()
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    for (let i = 0; i < 9; i++) log.appendOutput(new Uint8Array(mib).fill(0x78))
    log.close()
    const live = new Screen({ cols: 80, rows: 24 })
    await live.settled()
    const snapshot = live.snapshot()
    live.dispose()

    const read = await bytesRead(() => composeReplay(dir, { historyLines: 2000, live: snapshot }))
    expect(read).toBeLessThanOrEqual(8 * mib + 128 * 1024)
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

  test('an empty log gives just the live snapshot, which already ends with the cursor', async () => {
    const live = liveScreen('\x1b[31mhello\x1b[0m')
    await live.settled()
    const snapshot = live.snapshot()

    const dir = freshDir()
    HistoryLog.create(dir, { cols: 80, rows: 24 }).close()
    for (const target of [dir, freshDir()]) {
      const { replay, historyCursor } = await composeReplay(target, { historyLines: 2000, live: snapshot })
      expect(historyCursor).toBeNull()
      expect(dec(replay)).toBe(snapshot.ansi)
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

describe('attach replay cursor state', () => {
  async function replayInto(dir: string, live: Screen, historyLines: number): Promise<Screen> {
    const { replay } = await composeReplay(dir, { historyLines, live: live.snapshot() })
    const pane = new Screen({ cols: 5, rows: 3, scrollback: 1000 })
    pane.write(replay)
    await pane.settled()
    return pane
  }

  test('a pending wrap survives the replay without history, so the next character wraps', async () => {
    const host = new Screen({ cols: 5, rows: 3 })
    host.write('abcde')
    await host.settled()
    const pane = await replayInto(freshDir(), host, 0)
    host.write('X')
    pane.write('X')
    await Promise.all([host.settled(), pane.settled()])
    expect(pane.lines().map((row) => row.text)).toEqual(host.lines().map((row) => row.text))
    expect(host.lines()[1].text).toBe('X')
    host.dispose()
    pane.dispose()
  })

  test('a pending wrap survives the replay with history behind it', async () => {
    const output = `${numbered('h', 1, 20)}abcde`
    const dir = logWith(output, { cols: 5, rows: 3 })
    const host = new Screen({ cols: 5, rows: 3, scrollback: 1000 })
    host.write(output)
    await host.settled()
    const pane = await replayInto(dir, host, 100)
    host.write('X')
    pane.write('X')
    await Promise.all([host.settled(), pane.settled()])
    expect(pane.lines().map((row) => row.text)).toEqual(host.lines().map((row) => row.text))
    host.dispose()
    pane.dispose()
  })

  test('a scroll region survives the replay', async () => {
    const output = `${numbered('h', 1, 20)}one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[2;4r\x1b[4;1H`
    const dir = logWith(output, { cols: 10, rows: 5 })
    const host = new Screen({ cols: 10, rows: 5, scrollback: 1000 })
    host.write(output)
    await host.settled()
    const { replay } = await composeReplay(dir, { historyLines: 100, live: host.snapshot() })
    const pane = new Screen({ cols: 10, rows: 5, scrollback: 1000 })
    pane.write(replay)
    await pane.settled()
    host.write('\r\nNEW')
    pane.write('\r\nNEW')
    await Promise.all([host.settled(), pane.settled()])
    expect(pane.lines().slice(-5).map((row) => row.text)).toEqual(host.lines().slice(-5).map((row) => row.text))
    host.dispose()
    pane.dispose()
  })
})

describe('history colours', () => {
  const RED = /\x1b\[(?:[0-9;]*;)?31m/

  test('an ansi page keeps a colour set before its window (SC-11)', async () => {
    const dir = logWith(`\x1b[31m${numbered('h', 1, 100)}`)
    const page = await pageBefore(dir, { lines: 10, format: 'ansi', screenRows: 24 })
    expect(page.lines.length).toBeGreaterThanOrEqual(10)
    for (const line of page.lines) expect(line).toMatch(RED)
  })

  test('every page of a long coloured stretch carries the colour, and pages stay contiguous', async () => {
    const dir = logWith(`\x1b[31m${numbered('h', 1, 300)}\x1b[0m${numbered('p', 1, 100)}`)
    const pages = await pageToTheEnd(dir, 50, 'ansi')
    const all = pages.slice().reverse().flat()
    const reds = all.filter((line) => line.includes('h-'))
    expect(reds.length).toBe(300)
    for (const line of reds) expect(line).toMatch(RED)
    for (const line of all.filter((row) => row.includes('p-'))) expect(line).not.toMatch(RED)
    expect(all.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).filter((line) => line !== '').length).toBe(all.length)
  })

  test('a reset before the window drops the colour', async () => {
    const dir = logWith(`\x1b[31mred\x1b[0m\r\n${numbered('h', 1, 100)}`)
    const page = await pageBefore(dir, { lines: 10, format: 'ansi', screenRows: 24 })
    for (const line of page.lines) expect(line).not.toMatch(RED)
  })

  test('the colour is looked for only a bounded distance before the window', async () => {
    const dir = logWith(`\x1b[31m${'filler\r\n'.repeat(20_000)}${numbered('h', 1, 100)}`)
    const page = await pageBefore(dir, { lines: 10, format: 'ansi', screenRows: 24 })
    expect(page.lines.length).toBeGreaterThanOrEqual(10)
    for (const line of page.lines) expect(line).not.toMatch(RED)
  })

  test('a colour set before an attach window colours its replayed history', async () => {
    const output = `\x1b[32m${numbered('h', 1, 300)}\x1b[0m`
    const dir = logWith(output)
    const live = new Screen({ cols: 80, rows: 24, scrollback: 1000 })
    live.write(output)
    await live.settled()
    const { replay } = await composeReplay(dir, { historyLines: 50, live: live.snapshot() })
    const pane = new Screen({ cols: 80, rows: 24, scrollback: 1000 })
    pane.write(replay)
    await pane.settled()
    expect(pane.serialize().startsWith('\x1b[32mh-')).toBe(true)
    live.dispose()
    pane.dispose()
  })
})

describe('scratch screen memory', () => {
  test('a page of vertical tabs holds a window sized by the page, not by the bytes', async () => {
    const total = 64 * 1024
    const dir = logWith('\x0b'.repeat(total))
    const page = await pageBefore(dir, { lines: 1, format: 'text', screenRows: 24 })
    expect(page.lines).toEqual([])
    // 1 line plus 24 screen rows is 25 row breaks, so the window is those 25 bytes at most
    expect(parseCursor(page.cursor!)).toBeGreaterThanOrEqual(total - 25)
  })

  test('a page of 1 line over text split by vertical tabs returns a few rows, not all of them', async () => {
    const dir = logWith('x\x0b'.repeat(30_000))
    const page = await pageBefore(dir, { lines: 1, format: 'text', screenRows: 24 })
    expect(page.lines.length).toBeGreaterThanOrEqual(1)
    expect(page.lines.length).toBeLessThanOrEqual(3)
    expect(page.cursor).not.toBeNull()
  })

  test('form feeds count as row breaks too', async () => {
    const dir = logWith('x\x0c'.repeat(30_000))
    const page = await pageBefore(dir, { lines: 1, format: 'text', screenRows: 24 })
    expect(page.lines.length).toBeLessThanOrEqual(3)
  })

  test('control bytes that open rows without a break are held to the budget, and paging still ends', async () => {
    // ESC D (IND) opens a row per two bytes and is not a line break
    const dir = logWith('x\x1bD'.repeat(30_000))
    const budget = scratchControlRows(1, 24)
    expect(budget).toBeLessThan(10_000)
    const page = await pageBefore(dir, { lines: 1, format: 'text', screenRows: 24 })
    const textRows = Math.ceil((3 * 30_000) / 80)
    expect(page.lines.length).toBeGreaterThan(0)
    expect(page.lines.length).toBeLessThanOrEqual(budget + textRows + 24 * 2 + 16)
    expect(page.cursor).not.toBeNull()

    let seen = page.lines.length
    let cursor = page.cursor
    let pages = 0
    while (cursor !== null) {
      const older = await pageBefore(dir, { before: parseCursor(cursor), lines: 1, format: 'text', screenRows: 24 })
      expect(older.lines.length).toBeLessThanOrEqual(budget + textRows + 24 * 2 + 16)
      if (older.cursor !== null) expect(parseCursor(older.cursor)).toBeLessThan(parseCursor(cursor))
      seen += older.lines.length
      cursor = older.cursor
      expect(++pages).toBeLessThan(200)
    }
    expect(seen).toBeGreaterThan(29_000)
  }, 60_000)

  test('the budget scales with the page and has a floor', () => {
    expect(scratchControlRows(0, 0)).toBeGreaterThan(0)
    expect(scratchControlRows(2000, 24)).toBeGreaterThan(scratchControlRows(10, 24))
  })
})

describe('unreadable history', () => {
  function failingReads<T>(work: () => Promise<T>, after = 0): Promise<T> {
    const open = LogReader.open
    LogReader.open = (dir: string) => {
      const reader = open.call(LogReader, dir)
      const readOutput = reader.readOutput.bind(reader)
      let reads = 0
      reader.readOutput = (...args: Parameters<LogReader['readOutput']>) => {
        if (reads++ >= after) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return readOutput(...args)
      }
      return reader
    }
    return work().finally(() => {
      LogReader.open = open
    })
  }

  test('a page whose reads fail is empty with no cursor', async () => {
    const dir = logWith(numbered('h', 1, 200))
    const page = await failingReads(() => pageBefore(dir, { lines: 10, format: 'text', screenRows: 24 }))
    expect(page).toEqual({ lines: [], cursor: null })
    const before = await failingReads(() => pageBefore(dir, { before: 500, lines: 10, format: 'ansi', screenRows: 24 }))
    expect(before).toEqual({ lines: [], cursor: null })
  })

  test('attach still returns the live screen when history reads fail', async () => {
    const output = numbered('h', 1, 200)
    const dir = logWith(output)
    const live = new Screen({ cols: 80, rows: 24, scrollback: 1000 })
    live.write(output)
    await live.settled()
    const snapshot = live.snapshot()
    const { replay, historyCursor } = await failingReads(() => composeReplay(dir, { historyLines: 100, live: snapshot }))
    expect(historyCursor).toBeNull()
    expect(dec(replay)).toBe(snapshot.ansi)
    live.dispose()
  })

  test('a failure after some data was read returns what was read, and the next page ends', async () => {
    const dir = logWith(numbered('h', 1, 3000), { maxSegmentBytes: 8 * 1024, chunk: 1024 })
    const page = await failingReads(() => pageBefore(dir, { lines: 2000, format: 'text', screenRows: 24 }), 3)
    expect(page.lines.length).toBeGreaterThan(0)
    expect(page.lines.length).toBeLessThan(2000)
    const next = await failingReads(() => pageBefore(dir, { before: parseCursor(page.cursor!), lines: 10, format: 'text', screenRows: 24 }))
    expect(next).toEqual({ lines: [], cursor: null })
  })

  test('a log that cannot be opened gives an empty page and the live screen', async () => {
    const open = LogReader.open
    LogReader.open = () => {
      throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
    }
    try {
      expect(await pageBefore(freshDir(), { lines: 10, format: 'text', screenRows: 24 })).toEqual({ lines: [], cursor: null })
      const { replay } = await composeReplay(freshDir(), {
        historyLines: 10,
        live: { ansi: 'live', cols: 80, rows: 24, cursor: { x: 0, y: 0 } }
      })
      expect(dec(replay)).toBe('live')
    } finally {
      LogReader.open = open
    }
  })
})
