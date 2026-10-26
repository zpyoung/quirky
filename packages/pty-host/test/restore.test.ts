import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Checkpoint, readCheckpoint, writeCheckpoint } from '../src/history/checkpoint'
import { HistoryLog } from '../src/history/log'
import { CheckpointScheduler, GROUND, rebuildScreen } from '../src/history/restore'
import { OutputScanner } from '../src/scanner'
import { Screen } from '../src/screen'

const enc = (s: string) => new TextEncoder().encode(s)
const ESC = '\x1b'
const BEL = '\x07'
const FALLBACK = { cols: 80, rows: 24, cwd: '/fallback' }

const roots: string[] = []
const disposables: Array<{ dispose(): void }> = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qrs-'))
  roots.push(dir)
  return dir
}
function track<T extends { dispose(): void }>(value: T): T {
  disposables.push(value)
  return value
}
afterEach(() => {
  for (const d of disposables.splice(0)) d.dispose()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(5)
  }
}

/** A session as the host runs it: every chunk goes to the log, the scanner and the screen. */
class Live {
  readonly screen = track(new Screen({ cols: 80, rows: 24 }))
  readonly scanner = new OutputScanner()
  readonly log: HistoryLog
  offset = 0
  cwd = '/start'
  title: string | null = null

  constructor(
    readonly dir: string,
    cols = 80,
    rows = 24
  ) {
    this.log = HistoryLog.create(dir, { cols, rows })
    if (cols !== 80 || rows !== 24) this.screen.resize(cols, rows)
  }

  feed(text: string): void {
    const bytes = enc(text)
    this.log.appendOutput(bytes)
    for (const fact of this.scanner.push(bytes).facts) {
      if (fact.kind === 'cwd') this.cwd = fact.cwd
      if (fact.kind === 'title') this.title = fact.title
    }
    this.screen.write(bytes)
    this.offset += bytes.length
  }

  resize(cols: number, rows: number): void {
    this.log.appendResize(cols, rows)
    this.screen.resize(cols, rows)
  }

  async checkpoint(): Promise<void> {
    await this.screen.settled()
    const snap = this.screen.snapshot()
    writeCheckpoint(this.dir, {
      version: 1,
      offset: this.offset,
      cols: snap.cols,
      rows: snap.rows,
      ansi: snap.ansi,
      cwd: this.cwd,
      title: this.title,
      savedAt: Date.now()
    })
  }
}

function text(screen: Screen): string[] {
  return screen.lines().map((l) => l.text)
}

async function rebuilt(dir: string, cols = 80, rows = 24) {
  const screen = track(new Screen({ cols, rows }))
  const result = await rebuildScreen(dir, screen, { ...FALLBACK, cols, rows })
  await screen.settled()
  return { screen, result }
}

const PAGE_ONE = `${ESC}[1;32mhello${ESC}[0m world\r\nsecond line\r\n${ESC}[2;5Hxx${ESC}[31mred${ESC}[0m`
const PAGE_TWO = `\r\nthird ${ESC}[44mblue${ESC}[0m\r\n${ESC}[10;10Hmoved`

describe('rebuildScreen', () => {
  test('checkpoint plus log reproduces the uninterrupted screen', async () => {
    const live = new Live(freshDir())
    live.feed(PAGE_ONE)
    await live.checkpoint()
    live.feed(PAGE_TWO)
    await live.screen.settled()

    const { screen, result } = await rebuilt(live.dir)
    expect(result.source).toBe('checkpoint+log')
    expect(text(screen)).toEqual(text(live.screen))
    expect(screen.snapshot().cursor).toEqual(live.screen.snapshot().cursor)
    expect(screen.snapshot().ansi).toBe(live.screen.snapshot().ansi)
    expect(result.offset).toBe(live.offset)
    expect([result.cols, result.rows]).toEqual([80, 24])
  })

  test('log only rebuilds from the first segment', async () => {
    const live = new Live(freshDir())
    live.feed(PAGE_ONE)
    live.feed(PAGE_TWO)
    await live.screen.settled()

    const { screen, result } = await rebuilt(live.dir)
    expect(result.source).toBe('log')
    expect(text(screen)).toEqual(text(live.screen))
    expect(screen.snapshot().cursor).toEqual(live.screen.snapshot().cursor)
  })

  test('replays resizes in order and reports the final size', async () => {
    const live = new Live(freshDir())
    live.feed('before\r\n')
    live.resize(100, 30)
    live.feed('after\r\n')
    await live.screen.settled()

    const { screen, result } = await rebuilt(live.dir)
    expect([result.cols, result.rows]).toEqual([100, 30])
    expect(screen.snapshot().cols).toBe(100)
    expect(text(screen)).toEqual(text(live.screen))
  })

  test('restores the checkpoint size before replaying the log after it', async () => {
    const live = new Live(freshDir(), 100, 30)
    live.feed('one\r\n')
    await live.checkpoint()
    live.feed('two\r\n')
    await live.screen.settled()

    const { screen, result } = await rebuilt(live.dir, 80, 24)
    expect(result.source).toBe('checkpoint+log')
    expect([result.cols, result.rows]).toEqual([100, 30])
    expect(text(screen)).toEqual(text(live.screen))
  })

  test('uses the checkpoint alone when the log is unreadable', async () => {
    const live = new Live(freshDir())
    live.feed(PAGE_ONE)
    await live.checkpoint()
    live.log.close()
    writeFileSync(join(live.dir, 'output.log'), Buffer.from('not a log at all, bad magic'))

    const { screen, result } = await rebuilt(live.dir)
    expect(result.source).toBe('checkpoint')
    expect(result.offset).toBe(0)
    expect(text(screen)).toEqual(text(live.screen))
  })

  test('writes the note when neither checkpoint nor log is usable', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'output.log'), Buffer.from('garbage garbage garbage'))
    writeFileSync(join(dir, 'checkpoint.json'), '{ nope')

    const { screen, result } = await rebuilt(dir, 100, 30)
    expect(result).toMatchObject({ source: 'none', cols: 100, rows: 30, cwd: '/fallback', title: null, offset: 0 })
    expect(text(screen)[0]).toBe('[history could not be read]')
  })

  test('an empty session directory is the same as no history', async () => {
    const { result } = await rebuilt(freshDir())
    expect(result.source).toBe('none')
  })

  test('a torn last record is ignored and everything before it restored', async () => {
    const live = new Live(freshDir())
    live.feed('kept line\r\n')
    live.log.close()
    appendFileSync(join(live.dir, 'output.log'), Buffer.from([0x01, 100, 0, 0, 0, 0x74, 0x6f, 0x72, 0x6e]))
    await live.screen.settled()

    const { screen, result } = await rebuilt(live.dir)
    expect(result.source).toBe('log')
    expect(text(screen)[0]).toBe('kept line')
    expect(text(screen).join('\n')).not.toContain('torn')
    expect(result.offset).toBe(live.offset)
  })

  test('cwd is the last OSC 7 directory that still exists', async () => {
    const base = freshDir()
    const first = join(base, 'first')
    const second = join(base, 'second')
    mkdirSync(first)
    mkdirSync(second)
    const osc7 = (p: string) => `${ESC}]7;file://localhost${p}${BEL}`
    const live = new Live(freshDir())
    live.feed(`${osc7(first)}a\r\n${osc7(second)}b\r\n`)
    await live.screen.settled()

    expect((await rebuilt(live.dir)).result.cwd).toBe(second)

    rmSync(second, { recursive: true })
    expect((await rebuilt(live.dir)).result.cwd).toBe(first)

    rmSync(first, { recursive: true })
    expect((await rebuilt(live.dir)).result.cwd).toBe('/fallback')
  })

  test('cwd falls back to the checkpoint when replayed directories are gone', async () => {
    const base = freshDir()
    const kept = join(base, 'kept')
    mkdirSync(kept)
    const live = new Live(freshDir())
    live.feed(`${ESC}]7;file://localhost${kept}${BEL}a\r\n`)
    await live.checkpoint()
    live.feed(`${ESC}]7;file://localhost${join(base, 'missing')}${BEL}b\r\n`)
    await live.screen.settled()

    const { result } = await rebuilt(live.dir)
    expect(result.cwd).toBe(kept)
  })

  test('title is restored from the log and from the checkpoint', async () => {
    const live = new Live(freshDir())
    live.feed(`${ESC}]0;first title${BEL}hello\r\n`)
    await live.checkpoint()
    expect((await rebuilt(live.dir)).result.title).toBe('first title')

    live.feed(`${ESC}]2;second title${BEL}more\r\n`)
    await live.screen.settled()
    expect((await rebuilt(live.dir)).result.title).toBe('second title')
  })

  test('queries in replayed history produce no reply (SC-21)', async () => {
    const live = new Live(freshDir())
    live.feed(`before${ESC}[6n${ESC}[c${ESC}]11;?${BEL}after\r\n`)
    await live.checkpoint()
    live.feed(`again${ESC}[6n${ESC}[c${ESC}]11;?${BEL}\r\n`)

    const replies: Uint8Array[] = []
    const screen = track(new Screen({ cols: 80, rows: 24, onReply: (bytes) => replies.push(bytes) }))
    await rebuildScreen(live.dir, screen, FALLBACK)
    await screen.settled()
    expect(replies).toEqual([])
    expect(text(screen)[0]).toBe('beforeafter')

    screen.write(`${ESC}[6n`)
    await screen.settled()
    expect(replies).toHaveLength(1)
  })

  test('queries are dropped when only the log exists', async () => {
    const live = new Live(freshDir())
    live.feed(`x${ESC}[6n${ESC}[c${ESC}]11;?${BEL}y\r\n`)
    const replies: Uint8Array[] = []
    const screen = track(new Screen({ cols: 80, rows: 24, onReply: (bytes) => replies.push(bytes) }))
    await rebuildScreen(live.dir, screen, FALLBACK)
    await screen.settled()
    expect(replies).toEqual([])
  })
})

describe('GROUND', () => {
  test('leaves modes and attributes in a clean state', () => {
    const ground = new TextDecoder().decode(GROUND)
    expect(ground).toBe(
      `\x18${ESC}[?1049l${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${ESC}[?2004l${ESC}[?1l${ESC}[?25h${ESC}[0m\r\n`
    )
  })
})

function schedulerFor(live: Live, overrides: Partial<ConstructorParameters<typeof CheckpointScheduler>[0]> = {}) {
  return new CheckpointScheduler({
    dir: live.dir,
    screen: live.screen,
    scanner: live.scanner,
    intervalMs: 30,
    maxWaitMs: 200,
    cwd: () => live.cwd,
    title: () => live.title,
    offset: () => live.offset,
    ...overrides
  })
}

describe('CheckpointScheduler', () => {
  test('writes a checkpoint within the interval while output arrives', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live)
    live.feed('busy output\r\n')
    scheduler.noteOutput()
    await until(() => readCheckpoint(live.dir) !== null)
    scheduler.dispose()

    const cp = readCheckpoint(live.dir)!
    expect(cp.offset).toBe(live.offset)
    expect(cp.ansi).toContain('busy output')
    expect(cp.cwd).toBe('/start')
  })

  test('keeps checkpointing as output continues', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live)
    live.feed('one\r\n')
    scheduler.noteOutput()
    await until(() => readCheckpoint(live.dir)?.offset === live.offset)
    live.feed('two\r\n')
    scheduler.noteOutput()
    await until(() => readCheckpoint(live.dir)?.offset === live.offset)
    scheduler.dispose()
    expect(readCheckpoint(live.dir)!.ansi).toContain('two')
  })

  test('an idle session writes nothing (SC-15)', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live)
    live.feed('prompt$ ')
    scheduler.noteOutput()
    await until(() => readCheckpoint(live.dir) !== null)
    const path = join(live.dir, 'checkpoint.json')
    const before = { body: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs }

    await sleep(200)
    scheduler.dispose()
    expect(readFileSync(path, 'utf8')).toBe(before.body)
    expect(statSync(path).mtimeMs).toBe(before.mtime)
  })

  test('never writes for a session that produced no output', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live)
    await sleep(120)
    scheduler.dispose()
    expect(readCheckpoint(live.dir)).toBeNull()
  })

  test('defers while the scanner is mid-sequence and restores RED in red (spec-review F2)', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live, { maxWaitMs: 2000 })
    live.feed('plain ')
    live.feed(`${ESC}[31`)
    scheduler.noteOutput()
    await sleep(150)
    expect(readCheckpoint(live.dir)).toBeNull()

    live.feed('mRED')
    scheduler.noteOutput()
    await until(() => readCheckpoint(live.dir) !== null)
    scheduler.dispose()
    const cp = readCheckpoint(live.dir)!
    expect(cp.offset).toBe(live.offset)

    const { screen } = await rebuilt(live.dir)
    expect(text(screen)[0]).toBe('plain RED')
    expect(screen.snapshot().ansi).toContain(`${ESC}[31mRED`)
  })

  test('a checkpoint is never taken at an offset inside a sequence', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live, { maxWaitMs: 60 })
    live.feed(`ok${ESC}[31`)
    scheduler.noteOutput()
    await sleep(400)
    scheduler.dispose()
    expect(readCheckpoint(live.dir)).toBeNull()
  })

  test('gives up after maxWaitMs and tries again on the next interval', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live, { maxWaitMs: 40 })
    live.feed(`ok${ESC}[31`)
    scheduler.noteOutput()
    await sleep(150)
    expect(readCheckpoint(live.dir)).toBeNull()

    live.feed('m!')
    await until(() => readCheckpoint(live.dir) !== null)
    scheduler.dispose()
    expect(readCheckpoint(live.dir)!.offset).toBe(live.offset)
  })

  test('flushFinal writes at a boundary', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live, { intervalMs: 60_000 })
    live.feed('final words\r\n')
    scheduler.noteOutput()
    expect(await scheduler.flushFinal()).toBe(true)
    scheduler.dispose()
    const cp = readCheckpoint(live.dir)!
    expect(cp.offset).toBe(live.offset)
    expect(cp.ansi).toContain('final words')
  })

  test('flushFinal skips mid-sequence and leaves the previous checkpoint alone', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live, { intervalMs: 60_000 })
    live.feed('first\r\n')
    expect(await scheduler.flushFinal()).toBe(true)
    const before = readFileSync(join(live.dir, 'checkpoint.json'), 'utf8')

    live.feed(`second${ESC}[3`)
    scheduler.noteOutput()
    expect(await scheduler.flushFinal()).toBe(false)
    scheduler.dispose()
    expect(readFileSync(join(live.dir, 'checkpoint.json'), 'utf8')).toBe(before)
  })

  test('flushFinal writes nothing mid-sequence when no checkpoint exists', async () => {
    const live = new Live(freshDir())
    const scheduler = schedulerFor(live, { intervalMs: 60_000 })
    live.feed(`x${ESC}]0;half a title`)
    expect(await scheduler.flushFinal()).toBe(false)
    scheduler.dispose()
    expect(readCheckpoint(live.dir)).toBeNull()
  })

  test('a failing write is logged once and checkpointing continues', async () => {
    const live = new Live(freshDir())
    const messages: string[] = []
    let calls = 0
    const scheduler = schedulerFor(live, {
      log: (m) => messages.push(m),
      writeCheckpoint: () => {
        calls++
        if (calls <= 2) throw new Error('disk full')
      }
    })
    for (let i = 0; i < 3; i++) {
      live.feed(`line ${i}\r\n`)
      scheduler.noteOutput()
      await until(() => calls === i + 1)
      await sleep(10)
    }
    scheduler.dispose()
    expect(calls).toBe(3)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('disk full')
  })

  test('at most four checkpoint writes run at once', async () => {
    let active = 0
    let peak = 0
    let done = 0
    const slowWrite = async (_dir: string, _cp: Checkpoint) => {
      active++
      peak = Math.max(peak, active)
      await sleep(60)
      active--
      done++
    }
    const lives = Array.from({ length: 6 }, () => new Live(freshDir()))
    const schedulers = lives.map((live) => schedulerFor(live, { writeCheckpoint: slowWrite }))
    lives.forEach((live, i) => {
      live.feed(`session ${i}\r\n`)
      schedulers[i]!.noteOutput()
    })
    await until(() => done === 6)
    schedulers.forEach((s) => s.dispose())
    expect(peak).toBe(4)
  })
})
