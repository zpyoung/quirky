import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { base64ToBytes, type PtyEvent } from '@quirky/protocol'
import { readCheckpoint, writeCheckpoint } from '../src/history/checkpoint'
import { HistoryLog, readSegments } from '../src/history/log'
import { readMeta, writeMeta } from '../src/history/meta'
import { type CreateParams, DEFAULT_TAIL_BYTES, SessionManager, type SessionManagerOptions } from '../src/session'
import { concat, onCleanup, runCleanups, scopeForHome, tempHome, text, trackSessionProcesses, waitFor } from './helpers'

afterEach(runCleanups)

const ENV = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
const enc = (s: string) => new TextEncoder().encode(s)

function params(sessionId: string, argv: string[], extra: Partial<CreateParams> = {}): CreateParams {
  return { sessionId, cwd: '/tmp', argv, env: ENV, cols: 80, rows: 24, ...extra }
}

function sh(script: string): string[] {
  return ['/bin/sh', '-c', script]
}

function newManager(options: Partial<SessionManagerOptions> = {}, home: string = tempHome()) {
  const scope = scopeForHome(home)
  const manager = new SessionManager({ home, ...options })
  trackSessionProcesses(manager, scope)
  onCleanup(() => manager.shutdown())
  return { manager, home }
}

const dirOf = (home: string, sessionId: string) => join(home, 'sessions', sessionId)

function exitEvents(manager: SessionManager): PtyEvent[] {
  const seen: PtyEvent[] = []
  manager.onExit((event) => seen.push(event))
  return seen
}

function factEvents(manager: SessionManager): PtyEvent[] {
  const seen: PtyEvent[] = []
  manager.onFact((event) => seen.push(event))
  return seen
}

/** Everything a session prints from now on, via a raw subscription (so it also shows what a pane would see). */
async function tap(manager: SessionManager, sessionId: string) {
  const parts: Uint8Array[] = []
  const sub = await manager.subscribe(sessionId, (_id, bytes) => parts.push(bytes), { mode: 'raw' })
  const before = base64ToBytes(sub.replay)
  return { text: () => text(concat(parts)), all: () => text(concat([before, ...parts])) }
}

/** Writes a replay into a fresh terminal the way a pane does. */
async function paint(replay: Uint8Array, cols = 80, rows = 24): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 20000, allowProposedApi: true })
  onCleanup(() => term.dispose())
  await new Promise<void>((resolve) => term.write(replay, resolve))
  return term
}

async function feed(term: Terminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => term.write(bytes, resolve))
}

/** A /bin/sh command that writes `bytes` to the terminal one byte at a time, pausing between bytes. */
function dribble(bytes: string): string {
  return Array.from(enc(bytes), (b) => `printf '\\${b.toString(8).padStart(3, '0')}'; sleep 0.05`).join('; ')
}

/** Every visible cell of the active buffer, with the colours and attributes that make it look the way it does. */
function visibleCells(term: Terminal): string[][] {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, y) => {
    const line = buffer.getLine(buffer.baseY + y)!
    return Array.from({ length: term.cols }, (_, x) => {
      const cell = line.getCell(x)!
      return [
        cell.getChars() || ' ',
        `fg${cell.getFgColorMode()}:${cell.getFgColor()}`,
        `bg${cell.getBgColorMode()}:${cell.getBgColor()}`,
        cell.isBold() ? 'b' : '',
        cell.isInverse() ? 'i' : ''
      ].join('|')
    })
  })
}

function bufferLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true))
}

function numbered(lines: string[], prefix: string): number[] {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  return lines.flatMap((line) => {
    const match = pattern.exec(line)
    return match ? [Number(match[1])] : []
  })
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

async function readUntil(manager: SessionManager, sessionId: string, lines: number, done: (lines: string[]) => boolean, timeoutMs = 10000) {
  return waitFor(
    async () => {
      const result = await manager.read(sessionId, lines)
      return done(result.lines) ? result : null
    },
    timeoutMs,
    'screen content'
  )
}

/** Waits until the session's checkpoint covers everything it has printed. */
async function checkpointCaughtUp(manager: SessionManager, home: string, sessionId: string): Promise<void> {
  await waitFor(
    () => {
      const offset = manager.list().find((info) => info.sessionId === sessionId)?.offset ?? 0
      const checkpoint = readCheckpoint(dirOf(home, sessionId))
      return offset > 0 && checkpoint?.offset === offset
    },
    10000,
    'checkpoint to catch up'
  )
}

/** The session directories as a crashed host would have left them: copied while the shells still ran. */
function crashImage(home: string): string {
  const copy = tempHome()
  cpSync(join(home, 'sessions'), join(copy, 'sessions'), { recursive: true })
  return copy
}

/** A stored session on disk whose log is `output`, with a stale meta cwd. */
function storedSession(sessionId: string, output: string, metaCwd = '/qm-stale'): string {
  const home = tempHome()
  const dir = dirOf(home, sessionId)
  mkdirSync(dir, { recursive: true })
  const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
  log.appendOutput(enc(output))
  log.close()
  writeMeta(dir, {
    version: 1,
    sessionId,
    argv: ['/bin/cat'],
    startCwd: metaCwd,
    cwd: metaCwd,
    cols: 80,
    rows: 24,
    createdAt: Date.now(),
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  })
  return home
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qm-')))
  onCleanup(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('defaults', () => {
  test('the hot tail keeps 256 KiB', () => {
    expect(DEFAULT_TAIL_BYTES).toBe(256 * 1024)
  })

  test('requests for unknown sessions fail with the session id', async () => {
    const { manager } = newManager()
    const ghost = 'unknown session: ghost'
    expect(() => manager.resize('ghost', 80, 24)).toThrow(ghost)
    expect(() => manager.kill('ghost')).toThrow(ghost)
    expect(() => manager.forget('ghost')).toThrow(ghost)
    await expect(manager.subscribe('ghost', () => {})).rejects.toThrow(ghost)
    await expect(manager.read('ghost', 1)).rejects.toThrow(ghost)
    await expect(manager.snapshot('ghost')).rejects.toThrow(ghost)
    await expect(manager.history('ghost')).rejects.toThrow(ghost)
  })

  test('restoring a session that is not stored restorable fails', async () => {
    const { manager } = newManager()
    await expect(manager.create(params('ghost', ['/bin/cat'], { restore: true }))).rejects.toThrow('session ghost is not restorable')
    await manager.create(params('live', ['/bin/cat']))
    await expect(manager.create(params('live', ['/bin/cat'], { restore: true }))).rejects.toThrow('session live is not restorable')
  })
})

describe('shell-ready barrier', () => {
  const MARKER = `printf '\\033]777;quirky-shell-ready\\007'`

  test('SC-2: input sent before the marker waits for it and arrives in order', async () => {
    const { manager, home } = newManager()
    await manager.create(params('b', sh(`sleep 0.7; ${MARKER}; echo READY; cat`), { shellReady: true }))
    const out = await tap(manager, 'b')
    expect(manager.list()[0]!.shellState).toBe('pending')
    manager.write('b', enc('one\n'))
    manager.write('b', enc('two\n'))
    await Bun.sleep(300)
    expect(out.text()).toBe('')

    await waitFor(() => out.text().includes('two'), 5000, 'held input')
    const printed = out.text()
    expect(printed.indexOf('READY')).toBeLessThan(printed.indexOf('one'))
    expect(printed.indexOf('one')).toBeLessThan(printed.indexOf('two'))
    expect(manager.list()[0]!.shellState).toBe('ready')
    expect(printed).not.toContain('777')

    const logged = readSegments(dirOf(home, 'b')).segments.flatMap((s) => s.records.filter((r) => r.kind === 'output').map((r) => text(r.bytes!)))
    expect(logged.join('')).not.toContain('777')
    expect(logged.join('')).not.toContain('quirky-shell-ready')
  })

  test('SC-4: a shell that never reports ready gets its input after the timeout', async () => {
    const { manager } = newManager()
    await manager.create(params('late', ['/bin/cat'], { shellReady: true, shellReadyTimeoutMs: 400 }))
    const out = await tap(manager, 'late')
    manager.write('late', enc('late\n'))
    await Bun.sleep(150)
    expect(out.text()).toBe('')
    expect(manager.list()[0]!.shellState).toBe('pending')
    await waitFor(() => out.text().includes('late'), 3000, 'input after timeout')
    expect(manager.list()[0]!.shellState).toBe('timed_out')
  })

  test('SC-4: the manager option sets the timeout when the request does not', async () => {
    const { manager } = newManager({ shellReadyTimeoutMs: 200 })
    await manager.create(params('opt', ['/bin/cat'], { shellReady: true }))
    await waitFor(() => manager.list()[0]!.shellState === 'timed_out', 3000, 'timeout from the option')
  })

  test('SC-5: sessions without shellReady have no barrier', async () => {
    const { manager } = newManager()
    await manager.create(params('plain', ['/bin/cat']))
    const out = await tap(manager, 'plain')
    expect(manager.list()[0]!.shellState).toBe('unsupported')
    manager.write('plain', enc('now\n'))
    await waitFor(() => out.text().includes('now'), 1000, 'immediate input')
  })
})

describe('facts', () => {
  test('SC-30, SC-31, SC-33: bell, title, command-finished and cwd are reported once each', async () => {
    const { manager } = newManager()
    const facts = factEvents(manager)
    const script = [
      `printf 'a\\007'`,
      `printf '\\033]0;t1\\007'`,
      `printf '\\033]0;t1\\007'`,
      `printf '\\033]0;t2\\033\\\\'`,
      `printf '\\033]133;D;4\\007'`,
      `printf '\\033]7;file://host/tmp\\007'`,
      'sleep 30'
    ].join('; ')
    await manager.create(params('f', sh(script)))
    await waitFor(() => facts.length >= 5, 5000, 'facts')
    await Bun.sleep(100)
    expect(facts).toEqual([
      { type: 'fact', sessionId: 'f', fact: { kind: 'bell' } },
      { type: 'fact', sessionId: 'f', fact: { kind: 'title', title: 't1' } },
      { type: 'fact', sessionId: 'f', fact: { kind: 'title', title: 't2' } },
      { type: 'fact', sessionId: 'f', fact: { kind: 'command-finished', exitCode: 4 } },
      { type: 'fact', sessionId: 'f', fact: { kind: 'cwd', cwd: '/tmp' } }
    ])
    expect(manager.list()[0]).toMatchObject({ title: 't2', cwd: '/tmp' })
  })

  test('SC-32: sequences split across reads are seen once', async () => {
    const { manager } = newManager()
    const facts = factEvents(manager)
    const script = [
      dribble('\x07'),
      dribble('\x1b]133;D;4\x07'),
      dribble('\x1b]7;file://host/tmp\x07'),
      `printf 'split-done\\n'`,
      'sleep 30'
    ].join('; ')
    await manager.create(params('split', sh(script)))
    await readUntil(manager, 'split', 0, (lines) => lines.includes('split-done'), 20000)
    expect(facts).toEqual([
      { type: 'fact', sessionId: 'split', fact: { kind: 'bell' } },
      { type: 'fact', sessionId: 'split', fact: { kind: 'command-finished', exitCode: 4 } },
      { type: 'fact', sessionId: 'split', fact: { kind: 'cwd', cwd: '/tmp' } }
    ])
    expect(manager.list()[0]).toMatchObject({ cwd: '/tmp' })
  }, 30000)

  test('a listener that stops listening gets no more events', async () => {
    const { manager } = newManager()
    const seen: PtyEvent[] = []
    const stop = manager.onFact((event) => seen.push(event))
    stop()
    await manager.create(params('f', sh(`printf '\\007'; sleep 30`)))
    await Bun.sleep(300)
    expect(seen).toEqual([])
  })
})

describe('attach', () => {
  test('SC-8: the replay is recent history, then the screen, with a cursor for more', async () => {
    const { manager } = newManager()
    await manager.create(params('s', sh(`seq -f 'n-%g' 1 5000; sleep 30`)))
    await readUntil(manager, 's', 0, (lines) => lines.includes('n-5000'))

    const sub = await manager.subscribe('s', () => {}, { historyLines: 2000 })
    const term = await paint(base64ToBytes(sub.replay))
    expect(term.buffer.active.baseY).toBeGreaterThan(1900)
    expect(term.buffer.active.baseY).toBeLessThan(2100)
    expect(sub.historyCursor).not.toBeNull()
    expect(sub).toMatchObject({ cols: 80, rows: 24, live: true, shellState: 'unsupported' })
    const seen = numbered(bufferLines(term), 'n')
    expect(seen.at(-1)).toBe(5000)
    expect(seen).toEqual(range(seen[0]!, 5000))

    const byDefault = await manager.subscribe('s', () => {})
    const defaultTerm = await paint(base64ToBytes(byDefault.replay))
    expect(defaultTerm.buffer.active.baseY).toBe(term.buffer.active.baseY)

    const small = await manager.subscribe('s', () => {}, { historyLines: 50 })
    expect((await paint(base64ToBytes(small.replay))).buffer.active.baseY).toBeLessThan(120)
    const none = await manager.subscribe('s', () => {}, { historyLines: 0 })
    expect((await paint(base64ToBytes(none.replay))).buffer.active.baseY).toBeLessThanOrEqual(1)
  }, 30000)

  test('SC-7: attach restores a full-screen program frame and modes', async () => {
    const { manager } = newManager()
    const frame = [
      '\\033[?1049h',
      '\\033[?2004h',
      '\\033[?1000h',
      '\\033[2J',
      '\\033[1;3H\\033[31mred\\033[0m \\033[1;42mgreen-bold\\033[0m',
      '\\033[3;5H\\033[38;5;208morange\\033[0m',
      '\\033[5;1H\\033[48;2;10;20;30m\\033[38;2;200;100;50mtruecolor\\033[0m',
      '\\033[7;2H\\033[7mreverse\\033[0m',
      '\\033[10;20H'
    ].join('')
    await manager.create(params('full', sh(`printf '${frame}'; sleep 30`)))
    const out = await tap(manager, 'full')
    const hostScreen = await waitFor(
      async () => {
        const snap = await manager.snapshot('full')
        return snap.ansi.includes('truecolor') && snap.cursor.y === 9 ? snap : null
      },
      5000,
      'the frame'
    )
    const sub = await manager.subscribe('full', () => {}, { mode: 'screen' })
    expect(sub).toMatchObject({ cols: 80, rows: 24 })
    const pane = await paint(base64ToBytes(sub.replay), sub.cols, sub.rows)
    const truth = await paint(enc(out.all()), 80, 24)

    expect(truth.buffer.active.type).toBe('alternate')
    expect(pane.buffer.active.type).toBe('alternate')
    expect(visibleCells(pane)).toEqual(visibleCells(truth))
    expect(bufferLines(pane).slice(-24).slice(0, 7).map((line) => line.trimEnd())).toEqual([
      '  red green-bold',
      '',
      '    orange',
      '',
      'truecolor',
      '',
      ' reverse'
    ])
    const cells = visibleCells(pane)
    expect(cells[0]![2]).toBe('r|fg16777216:1|bg0:-1||')
    expect(cells[0]![6]).toBe('g|fg0:-1|bg16777216:2|b|')
    expect(cells[2]![4]).toBe('o|fg33554432:208|bg0:-1||')
    expect(cells[4]![0]).toBe('t|fg50331648:13132850|bg50331648:660510||')
    expect(cells[6]![1]).toBe('r|fg0:-1|bg0:-1||i')
    expect({ x: pane.buffer.active.cursorX, y: pane.buffer.active.cursorY }).toEqual({ x: 19, y: 9 })
    expect(pane.modes.bracketedPasteMode).toBe(true)
    expect(pane.modes.mouseTrackingMode).not.toBe('none')

    const fromSnapshot = await paint(enc(hostScreen.ansi), 80, 24)
    expect(visibleCells(fromSnapshot)).toEqual(visibleCells(truth))
    expect(hostScreen.cursor).toEqual({ x: 19, y: 9 })
    expect(hostScreen.modes).toEqual({ alternateScreen: true, bracketedPaste: true, mouseTracking: true, applicationCursor: false })
  })

  test('SC-9: the replay and the live stream join without a gap or a repeat', async () => {
    const { manager } = newManager()
    const total = 300
    await manager.create(params('f', sh(`i=0; while [ $i -lt ${total} ]; do echo line-$i; i=$((i+1)); sleep 0.005; done; sleep 30`)))
    await waitFor(() => manager.list()[0]!.offset > 100, 5000, 'some output')

    const chunks: Uint8Array[] = []
    const sub = await manager.subscribe('f', (_id, bytes) => chunks.push(bytes))
    await waitFor(() => text(concat(chunks)).includes(`line-${total - 1}\r\n`), 15000, 'the rest of the output')
    expect(sub.offset).toBeGreaterThan(0)
    expect(sub.offset + concat(chunks).length).toBe(manager.list()[0]!.offset)

    const term = await paint(base64ToBytes(sub.replay))
    await feed(term, concat(chunks))
    expect(numbered(bufferLines(term), 'line')).toEqual(range(0, total - 1))
  }, 30000)

  test('SC-9: attaching repeatedly to a saturated session still joins without a gap or a repeat', async () => {
    const { manager } = newManager()
    const total = 400000
    await manager.create(params('hot', sh(`i=0; while [ $i -lt ${total} ]; do echo line-$i; i=$((i+1)); done; sleep 30`)))
    const attached: Array<{ sub: Awaited<ReturnType<SessionManager['subscribe']>>; chunks: Uint8Array[] }> = []
    await waitFor(() => manager.list()[0]!.offset > 20000, 15000, 'some output')
    for (let i = 0; i < 6; i++) {
      const chunks: Uint8Array[] = []
      attached.push({ sub: await manager.subscribe('hot', (_id, bytes) => chunks.push(bytes), { historyLines: 300 }), chunks })
    }
    await waitFor(() => attached.every(({ chunks }) => text(concat(chunks)).includes(`line-${total - 1}\r\n`)), 30000, 'the rest of the output')
    for (const { sub, chunks } of attached) {
      const term = await paint(base64ToBytes(sub.replay))
      await feed(term, concat(chunks))
      const seen = numbered(bufferLines(term), 'line')
      expect(seen.length).toBeGreaterThan(300)
      expect(seen).toEqual(range(seen[0]!, total - 1))
    }
  }, 60000)

  test('raw mode replays the hot tail and joins the live stream at the offset', async () => {
    const { manager } = newManager({ tailBytes: 128 })
    await manager.create(params('w', ['/bin/cat']))
    const first = await tap(manager, 'w')
    manager.write('w', enc(Array.from({ length: 40 }, (_, i) => `line-${i}\n`).join('')))
    await waitFor(() => occurrences(first.text(), 'line-39') >= 2, 5000, 'echo and cat output')

    const live: Uint8Array[] = []
    const sub = await manager.subscribe('w', (_id, bytes) => live.push(bytes), { mode: 'raw' })
    const replay = base64ToBytes(sub.replay)
    const whole = first.all()
    expect(sub.offset).toBe(whole.length)
    expect(replay.length).toBeLessThanOrEqual(128)
    expect(whole[sub.offset - replay.length - 1]).toBe('\n')
    expect(text(replay)).toBe(whole.slice(sub.offset - replay.length))
    expect(sub.historyCursor).toBeNull()

    manager.write('w', enc('tail-end\n'))
    await waitFor(() => occurrences(text(concat(live)), 'tail-end') >= 2, 5000, 'more output')
    expect(text(concat([replay, ...live]))).toBe(first.all().slice(sub.offset - replay.length))
  })

  test('SC-10: a snapshot reports the screen, cwd, title, modes and position', async () => {
    const { manager } = newManager()
    await manager.create(params('snap', sh(`printf '\\033]7;file://host/tmp\\007\\033]0;build\\007\\033[?2004hhello'; sleep 30`)))
    await readUntil(manager, 'snap', 0, (lines) => lines.includes('hello'))
    const snap = await manager.snapshot('snap')
    expect(snap).toMatchObject({
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      title: 'build',
      shellState: 'unsupported',
      modes: { alternateScreen: false, bracketedPaste: true, mouseTracking: false, applicationCursor: false },
      cursor: { x: 5, y: 0 }
    })
    expect(snap.ansi).toContain('hello')
    expect(snap.offset).toBe(manager.list()[0]!.offset)
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })

  test('the snapshot cwd is the start cwd until the shell reports one', async () => {
    const { manager } = newManager()
    await manager.create(params('plain', ['/bin/cat']))
    expect(await manager.snapshot('plain')).toMatchObject({ cwd: '/tmp', title: null })
  })
})

describe('history and read', () => {
  test('SC-11: pages run back to the oldest output, each ending where the last began', async () => {
    const { manager } = newManager()
    await manager.create(params('h', sh(`seq -f 'h-%g' 1 1000; sleep 30`)))
    await readUntil(manager, 'h', 0, (lines) => lines.includes('h-1000'))

    const pages: string[][] = []
    let before: string | undefined
    for (let i = 0; i < 20; i++) {
      const page = await manager.history('h', { lines: 300, before })
      pages.unshift(page.lines)
      if (page.cursor === null) break
      before = page.cursor
    }
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.at(0)![0]).toBe('h-1')
    const screen = (await manager.read('h', 0)).lines
    const all = [...pages.flat(), ...screen]
    expect(numbered(all, 'h')).toEqual(range(1, 1000))
    for (const page of pages.slice(1)) expect(page.length).toBeGreaterThan(250)
  })

  test('SC-11: ansi pages carry the colours of the same rows', async () => {
    const { manager } = newManager()
    await manager.create(params('c', sh(`for i in $(seq 1 60); do printf '\\033[31mc-%s\\033[0m\\n' $i; done; sleep 30`), { rows: 10 }))
    await readUntil(manager, 'c', 0, (lines) => lines.includes('c-60'))
    const plain = await manager.history('c', { lines: 100 })
    const ansi = await manager.history('c', { lines: 100, format: 'ansi' })
    expect(ansi.lines).toHaveLength(plain.lines.length)
    expect(ansi.lines[0]).toContain('\x1b[31m')
    expect(ansi.lines.map((row) => row.replace(/\x1b\[[0-9;:]*m/g, ''))).toEqual(plain.lines)
  })

  test('history rejects a bad cursor, bad bounds and an unknown format', async () => {
    const { manager } = newManager()
    await manager.create(params('h', ['/bin/cat']))
    await expect(manager.history('h', { before: 'nope' })).rejects.toThrow('invalid history cursor')
    await expect(manager.history('h', { lines: 0 })).rejects.toThrow(/lines/)
    await expect(manager.history('h', { lines: 10001 })).rejects.toThrow(/lines/)
    await expect(manager.history('h', { format: 'html' as never })).rejects.toThrow('invalid history format: html')
  })

  test('SC-13: read returns the lines above the screen, then the screen', async () => {
    const { manager } = newManager()
    await manager.create(params('r', sh(`seq -f 'r-%g' 1 500; sleep 30`)))
    await readUntil(manager, 'r', 0, (lines) => lines.includes('r-500'))
    const result = await manager.read('r', 100)
    expect(result).toMatchObject({ cols: 80, rows: 24, alt: false })
    expect(result.lines).toHaveLength(123)
    expect(numbered(result.lines, 'r')).toEqual(range(378, 500))
  })

  test('SC-14: a progress bar that redraws one line reads back once, in its final state', async () => {
    const { manager } = newManager()
    const bar = Array.from({ length: 10 }, (_, i) => `printf '\\rprogress ${i * 10}%%'`).join('; ')
    await manager.create(params('p', sh(`${bar}; printf '\\rprogress done\\n'; seq -f 'after-%g' 1 40; sleep 30`), { rows: 10 }))
    await readUntil(manager, 'p', 0, (lines) => lines.includes('after-40'))
    const lines = (await manager.history('p', { lines: 100 })).lines
    expect(lines.filter((line) => line.startsWith('progress'))).toEqual(['progress done'])
  })

  test('read keeps blank interior rows and drops trailing ones', async () => {
    const { manager } = newManager()
    await manager.create(params('tb', sh('printf "a\\n\\n\\nb"; sleep 30'), { cols: 40, rows: 10 }))
    const result = await readUntil(manager, 'tb', 0, (lines) => lines.includes('b'))
    expect(result.lines).toEqual(['a', '', '', 'b'])
    expect(await manager.read('tb', 0)).toMatchObject({ cols: 40, rows: 10 })
  })

  test('read validates its line count', async () => {
    const { manager } = newManager()
    await manager.create(params('v', ['/bin/cat']))
    await expect(manager.read('v', -1)).rejects.toThrow('lines must be a non-negative integer')
  })

  test('resize reaches the process, the screen and the stored size', async () => {
    const { manager, home } = newManager()
    await manager.create(params('rs', sh('read x; stty size; sleep 30')))
    const out = await tap(manager, 'rs')
    manager.resize('rs', 100, 30)
    manager.write('rs', enc('\n'))
    await waitFor(() => out.text().includes('30 100'), 5000, 'stty size output')
    expect(manager.list()[0]).toMatchObject({ cols: 100, rows: 30 })
    expect(await manager.read('rs', 0)).toMatchObject({ cols: 100, rows: 30 })
    await waitFor(() => readMeta(dirOf(home, 'rs'))?.cols === 100, 3000, 'meta size')
    const sizes = readSegments(dirOf(home, 'rs')).segments.flatMap((s) => s.records.filter((r) => r.kind === 'resize').map((r) => [r.cols, r.rows]))
    expect(sizes.at(-1)).toEqual([100, 30])
  })
})

describe('checkpoints', () => {
  test('SC-15: a busy session is checkpointed and an idle one costs nothing', async () => {
    const { manager, home } = newManager({ checkpointIntervalMs: 150 })
    await manager.create(params('busy', sh('i=0; while :; do echo $i; i=$((i+1)); sleep 0.03; done')))
    await manager.create(params('idle', sh('echo prompt; sleep 30')))
    await checkpointCaughtUp(manager, home, 'idle')
    await waitFor(() => readCheckpoint(dirOf(home, 'busy')), 5000, 'busy checkpoint')

    const idleFile = join(dirOf(home, 'idle'), 'checkpoint.json')
    const idleBefore = readFileSync(idleFile, 'utf8')
    const busyBefore = readCheckpoint(dirOf(home, 'busy'))!
    await Bun.sleep(900)
    expect(readFileSync(idleFile, 'utf8')).toBe(idleBefore)
    const busyAfter = readCheckpoint(dirOf(home, 'busy'))!
    expect(busyAfter.savedAt).toBeGreaterThan(busyBefore.savedAt)
    expect(busyAfter.offset).toBeGreaterThan(busyBefore.offset)
    expect(Date.now() - busyAfter.savedAt).toBeLessThan(500)
    expect(readMeta(dirOf(home, 'busy'))).toMatchObject({ endedAt: null, restorable: false })
  }, 20000)

  test('a checkpoint records the last reported cwd and title', async () => {
    const { manager, home } = newManager({ checkpointIntervalMs: 100 })
    await manager.create(params('c', sh(`printf '\\033]7;file://h/tmp\\007\\033]0;ttl\\007'; sleep 30`)))
    await checkpointCaughtUp(manager, home, 'c')
    expect(readCheckpoint(dirOf(home, 'c'))).toMatchObject({ cwd: '/tmp', title: 'ttl' })
    expect(readMeta(dirOf(home, 'c'))).toMatchObject({ cwd: '/tmp' })
  })
})

describe('exit', () => {
  test('SC-34: a normal exit records its status and writes the meta', async () => {
    const { manager, home } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('e', sh('printf hello; exit 3')))
    await waitFor(() => exits.length > 0, 5000, 'exit event')
    expect(exits[0]).toEqual({ type: 'exit', sessionId: 'e', exitCode: 3, exitSignal: null, exitCause: 'exited' })
    expect(manager.list()[0]).toMatchObject({ state: 'exited', alive: false, exitCode: 3, exitSignal: null, exitCause: 'exited', offset: 5 })
    expect(manager.isAlive('e')).toBe(false)
    expect(readMeta(dirOf(home, 'e'))).toMatchObject({ exitCode: 3, exitSignal: null, exitCause: 'exited', restorable: false })
    expect(readMeta(dirOf(home, 'e'))!.endedAt).toBeGreaterThan(0)
  })

  test('SC-36: a signal death reports 128 plus the signal', async () => {
    const { manager } = newManager()
    const exits = exitEvents(manager)
    const { pid } = await manager.create(params('t', sh('sleep 30')))
    process.kill(pid, 'SIGTERM')
    await waitFor(() => exits.length > 0, 5000, 'exit event')
    expect(exits[0]).toEqual({ type: 'exit', sessionId: 't', exitCode: 143, exitSignal: 'SIGTERM', exitCause: 'exited' })
  })

  test('SC-23: a kill with a reason is SIGKILL, cause killed, and not restorable', async () => {
    const { manager, home } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('k', sh('sleep 30 & wait')))
    manager.kill('k', undefined, 'killed')
    await waitFor(() => exits.length > 0, 5000, 'exit event')
    expect(exits[0]).toEqual({ type: 'exit', sessionId: 'k', exitCode: 137, exitSignal: 'SIGKILL', exitCause: 'killed' })
    expect(readMeta(dirOf(home, 'k'))).toMatchObject({ exitCause: 'killed', restorable: false })
  })

  test('a kill with a reason also ends background jobs that run in their own process group', async () => {
    const { manager } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('bg', sh('set -m; sleep 7777 & echo bg=$!; wait')))
    let bgPid = 0
    try {
      const seen = await readUntil(manager, 'bg', 0, (lines) => lines.some((line) => /^bg=\d+$/.test(line)))
      bgPid = Number(seen.lines.find((line) => /^bg=\d+$/.test(line))!.slice(3))
      expect(() => process.kill(bgPid, 0)).not.toThrow()
      manager.kill('bg', undefined, 'killed')
      await waitFor(() => exits.length > 0, 2000, 'exit event')
      await waitFor(
        () => {
          try {
            process.kill(bgPid, 0)
            return false
          } catch {
            return true
          }
        },
        2500,
        'background job to be killed'
      )
    } finally {
      if (bgPid) {
        try {
          process.kill(bgPid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  })

  test('a plain kill sends SIGTERM and is not a requested kill', async () => {
    const { manager } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('k', sh('sleep 30 & wait')))
    manager.kill('k')
    await waitFor(() => exits.length > 0, 5000, 'exit event')
    expect(exits[0]).toMatchObject({ exitCode: 143, exitSignal: 'SIGTERM', exitCause: 'exited' })
    expect(() => manager.kill('k', 'SIGNOPE')).toThrow(/signal/i)
  })

  test('a failed start leaves nothing behind and the id can be used again', async () => {
    const { manager, home } = newManager()
    await expect(manager.create(params('bad', ['/bin/cat'], { cwd: '/definitely/not/here' }))).rejects.toThrow()
    expect(existsSync(dirOf(home, 'bad'))).toBe(false)
    expect(manager.list()).toEqual([])
    await manager.create(params('bad', ['/bin/cat']))
  })

  test('creating a session with a stored id replaces the stored one', async () => {
    const { manager, home } = newManager()
    await manager.create(params('s', sh('echo old-run; sleep 30')))
    await readUntil(manager, 's', 0, (lines) => lines.includes('old-run'))
    await manager.shutdown()

    const { manager: next } = newManager({}, home)
    expect(next.list()[0]).toMatchObject({ state: 'restorable' })
    const created = await next.create(params('s', sh('echo new-run; sleep 30')))
    expect(created.restored).toBe(false)
    const result = await readUntil(next, 's', 50, (lines) => lines.includes('new-run'))
    expect(result.lines).not.toContain('old-run')
    expect(next.list()).toHaveLength(1)
    expect(next.list()[0]).toMatchObject({ state: 'running' })
  })
})

describe('cold restore', () => {
  test('SC-16, SC-17, SC-19: a lost host leaves a session that restores with its screen, history, cwd and size', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'src'))
    const { manager: first, home } = newManager({ checkpointIntervalMs: 100 })
    const script = (marker: string) => `printf '\\033]7;file://h${root}/src\\007'; echo ${marker}; sleep 30`
    await first.create(params('s1', sh(script('before-crash')), { cols: 100, rows: 30 }))
    await first.create(params('s2', sh(script('other-session')), { cols: 100, rows: 30 }))
    await checkpointCaughtUp(first, home, 's1')
    await checkpointCaughtUp(first, home, 's2')
    const crashed = crashImage(home)

    const { manager: second } = newManager({}, crashed)
    const stored = second.list().find((info) => info.sessionId === 's1')!
    expect(stored).toMatchObject({
      state: 'restorable',
      pid: 0,
      alive: false,
      exitCode: null,
      exitSignal: null,
      exitCause: 'host-lost',
      cwd: `${root}/src`,
      cols: 100,
      rows: 30,
      shellState: 'unsupported'
    })
    const preOffset = stored.offset
    expect(preOffset).toBeGreaterThan(0)
    const old = await second.history('s1', { lines: 50, before: 'h1.999999' })
    expect(old.lines).toContain('before-crash')
    expect((await second.read('s1', 10)).lines).toContain('before-crash')

    const env = { ...ENV, HOME: root, PS1: 'prompt> ' }
    const restored = await second.create(params('s1', ['/bin/zsh', '-f'], { env, restore: true }))
    expect(restored).toMatchObject({ restored: true, cwd: `${root}/src`, cols: 100, rows: 30 })
    expect(restored.pid).toBeGreaterThan(0)
    const out = await tap(second, 's1')
    const screen = await readUntil(second, 's1', 20, (lines) => {
      const at = lines.indexOf('before-crash')
      return at >= 0 && lines.slice(at + 1).some((line) => line.trim() !== '')
    })
    expect(screen.lines).toContain('before-crash')
    expect(second.list().find((info) => info.sessionId === 's1')).toMatchObject({ state: 'running', alive: true, exitCause: null })
    expect(second.list().find((info) => info.sessionId === 's1')!.offset).toBeGreaterThan(preOffset)
    expect(readMeta(dirOf(crashed, 's1'))).toMatchObject({ endedAt: null, restorable: false, exitCode: null, exitCause: null })

    second.write('s1', enc('pwd\n'))
    await waitFor(() => out.text().includes(`${root}/src`), 5000, 'pwd output')
    second.write('s1', enc(`seq -f 'after-%g' 1 80\n`))
    await readUntil(second, 's1', 0, (lines) => lines.includes('after-80'))
    const history = (await second.history('s1', { lines: 300 })).lines
    expect(history.indexOf('before-crash')).toBeGreaterThanOrEqual(0)
    expect(history.indexOf('before-crash')).toBeLessThan(history.indexOf('after-1'))

    const other = await second.create(params('s2', ['/bin/cat'], { restore: true }))
    expect(other).toMatchObject({ restored: true, cols: 100, rows: 30 })
    const otherScreen = (await second.read('s2', 10)).lines
    expect(otherScreen).toContain('other-session')
    expect(otherScreen).not.toContain('before-crash')
  }, 30000)

  test('SC-16, SC-28: a screen that had scrolled keeps its old lines above the new prompt after a restore', async () => {
    const { manager: first, home } = newManager({ checkpointIntervalMs: 100 })
    await first.create(params('scrolled', sh(`seq -f 'scrolled-%g' 1 60; sleep 30`)))
    await readUntil(first, 'scrolled', 24, (lines) => lines.includes('scrolled-60'))
    await checkpointCaughtUp(first, home, 'scrolled')
    const crashed = crashImage(home)

    const { manager: second } = newManager({}, crashed)
    const env = { ...ENV, HOME: tempDir(), PS1: 'prompt> ' }
    await second.create(params('scrolled', ['/bin/zsh', '-f'], { env, restore: true }))
    const screen = await readUntil(second, 'scrolled', 24, (lines) => lines.some((line) => line.startsWith('prompt>')))
    const kept = Array.from({ length: 10 }, (_, i) => `scrolled-${51 + i}`)
    expect(screen.lines.filter((line) => kept.includes(line))).toEqual(kept)
  }, 30000)

  test('the log continues across the restore boundary with one restore record', async () => {
    const { manager: first, home } = newManager({ checkpointIntervalMs: 100 })
    await first.create(params('s', sh('echo first-life; sleep 30')))
    await checkpointCaughtUp(first, home, 's')
    const { manager: second, home: crashed } = newManager({}, crashImage(home))
    const before = second.list()[0]!.offset
    await second.create(params('s', ['/bin/cat'], { restore: true }))
    second.write('s', enc('second-life\n'))
    await readUntil(second, 's', 10, (lines) => lines.includes('second-life'))

    const segments = readSegments(dirOf(crashed, 's')).segments
    const kinds = segments.flatMap((segment) => segment.records.map((record) => record.kind))
    expect(kinds.filter((kind) => kind === 'restore')).toHaveLength(1)
    const output = segments.flatMap((segment) => segment.records.filter((r) => r.kind === 'output').map((r) => text(r.bytes!))).join('')
    expect(output.indexOf('first-life')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('first-life')).toBeLessThan(output.indexOf('second-life'))
    expect(segments.at(-1)!.endOffset).toBe(second.list()[0]!.offset)
    expect(second.list()[0]!.offset).toBeGreaterThan(before)
  })

  test('SC-21: queries in the history produce no input to the restored shell', async () => {
    const { manager: first, home } = newManager({ checkpointIntervalMs: 100 })
    await first.create(params('q', sh(`printf '\\033[6n\\033[c\\033]11;?\\007\\033[?u\\033[>q'; echo q-done; sleep 30`)))
    await checkpointCaughtUp(first, home, 'q')
    const crashed = crashImage(home)

    const { manager: second } = newManager({}, crashed)
    await second.create(params('q', ['/bin/cat'], { restore: true }))
    const offset = second.list()[0]!.offset
    const out = await tap(second, 'q')
    await second.subscribe('q', () => {})
    await second.snapshot('q')
    await Bun.sleep(600)
    expect(second.list()[0]!.offset).toBe(offset)
    expect(out.text()).toBe('')
    expect((await second.read('q', 10)).lines).toContain('q-done')

    second.write('q', enc('typed\n'))
    await waitFor(() => out.text().includes('typed'), 3000, 'typed input')
    expect(out.text().replace(/typed\r\ntyped\r\n/, '')).toBe('')
  }, 20000)

  describe('SC-20: damaged history restores what it can', () => {
    function fabricate(home: string, sessionId: string, cwd = '/tmp'): string {
      const dir = dirOf(home, sessionId)
      mkdirSync(dir, { recursive: true })
      const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
      log.appendOutput(enc('old-1\r\nold-2\r\n'))
      writeCheckpoint(dir, { version: 1, offset: 14, cols: 80, rows: 24, ansi: 'old-1\r\nold-2\r\n', cwd, title: null, savedAt: Date.now() })
      log.appendOutput(enc('old-3\r\n'))
      log.close()
      writeMeta(dir, {
        version: 1,
        sessionId,
        argv: ['/bin/cat'],
        startCwd: cwd,
        cwd,
        cols: 80,
        rows: 24,
        createdAt: Date.now(),
        endedAt: null,
        exitCode: null,
        exitSignal: null,
        exitCause: null,
        restorable: false
      })
      return dir
    }

    test('torn record, unreadable checkpoint, unreadable log, and both unreadable', async () => {
      const home = tempHome()
      const torn = fabricate(home, 'torn')
      truncateSync(join(torn, 'output.log'), statSync(join(torn, 'output.log')).size - 3)
      writeFileSync(join(fabricate(home, 'nocp'), 'checkpoint.json'), 'not json')
      writeFileSync(join(fabricate(home, 'nolog'), 'output.log'), 'garbage that is no log')
      const both = fabricate(home, 'neither')
      writeFileSync(join(both, 'checkpoint.json'), '{')
      writeFileSync(join(both, 'output.log'), 'garbage that is no log')

      const { manager } = newManager({}, home)
      expect(manager.list().map((info) => [info.sessionId, info.state])).toEqual(
        expect.arrayContaining([['torn', 'restorable'], ['nocp', 'restorable'], ['nolog', 'restorable'], ['neither', 'restorable']])
      )
      const screens: Record<string, string[]> = {}
      for (const id of ['torn', 'nocp', 'nolog', 'neither']) {
        await manager.create(params(id, ['/bin/cat'], { restore: true }))
        expect(manager.list().find((info) => info.sessionId === id)).toMatchObject({ state: 'running' })
        screens[id] = (await manager.read(id, 20)).lines
      }
      expect(screens.torn).toEqual(expect.arrayContaining(['old-1', 'old-2']))
      expect(screens.torn).not.toContain('old-3')
      expect(screens.nocp).toEqual(expect.arrayContaining(['old-1', 'old-2', 'old-3']))
      expect(screens.nolog).toEqual(expect.arrayContaining(['old-1', 'old-2']))
      expect(screens.nolog).not.toContain('old-3')
      expect(screens.neither).toContain('[history could not be read]')
    }, 20000)
  })

  test('a recovered directory that is gone falls back to the request, and a failed start leaves the session restorable', async () => {
    const home = tempHome()
    const dir = join(home, 'sessions', 'g')
    mkdirSync(dir, { recursive: true })
    const log = HistoryLog.create(dir, { cols: 80, rows: 24 })
    log.appendOutput(enc('old-1\r\n'))
    log.close()
    writeMeta(dir, {
      version: 1,
      sessionId: 'g',
      argv: ['/bin/cat'],
      startCwd: '/qm-gone',
      cwd: '/qm-gone',
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false
    })
    const { manager } = newManager({}, home)
    await expect(manager.create(params('g', ['/bin/cat'], { cwd: '/definitely/not/here', restore: true }))).rejects.toThrow()
    expect(manager.list()).toMatchObject([{ sessionId: 'g', state: 'restorable' }])
    expect(existsSync(dir)).toBe(true)

    const restored = await manager.create(params('g', ['/bin/cat'], { restore: true }))
    expect(restored.cwd).toBe('/tmp')
    expect((await manager.read('g', 5)).lines).toContain('old-1')
  })

  test('directories without readable meta are ignored and left alone', async () => {
    const home = tempHome()
    mkdirSync(join(home, 'sessions', 'junk'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'junk', 'output.log'), 'old raw log')
    mkdirSync(join(home, 'sessions', 'badmeta'), { recursive: true })
    writeFileSync(join(home, 'sessions', 'badmeta', 'meta.json'), '{"version":1')
    const { manager } = newManager({}, home)
    expect(manager.list()).toEqual([])
    await expect(manager.read('junk', 1)).rejects.toThrow('unknown session: junk')
    expect(readFileSync(join(home, 'sessions', 'junk', 'output.log'), 'utf8')).toBe('old raw log')
  })
})

describe('shutdown and stored sessions', () => {
  test('SC-25: shutdown ends every session as host-restart and restorable, and a new host lists them', async () => {
    const { manager, home } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('a', sh('echo out-a; sleep 30')))
    await manager.create(params('b', sh('echo out-b; sleep 30')))
    await readUntil(manager, 'a', 0, (lines) => lines.includes('out-a'))
    await readUntil(manager, 'b', 0, (lines) => lines.includes('out-b'))
    await manager.shutdown()

    expect(exits.map((e) => e.type === 'exit' && e.exitCause)).toEqual(['host-restart', 'host-restart'])
    for (const id of ['a', 'b']) {
      expect(readMeta(dirOf(home, id))).toMatchObject({ exitCause: 'host-restart', restorable: true, endedAt: expect.any(Number) })
    }

    const { manager: next } = newManager({}, home)
    const listed = next.list()
    expect(listed.map((info) => info.sessionId).sort()).toEqual(['a', 'b'])
    for (const info of listed) {
      expect(info).toMatchObject({ state: 'restorable', pid: 0, alive: false, exitCode: null, exitSignal: null, exitCause: 'host-restart' })
    }

    const metaB = readFileSync(join(dirOf(home, 'b'), 'meta.json'), 'utf8')
    await next.create(params('a', ['/bin/cat'], { restore: true }))
    expect((await next.read('a', 5)).lines).toContain('out-a')
    await next.shutdown()
    expect(readFileSync(join(dirOf(home, 'b'), 'meta.json'), 'utf8')).toBe(metaB)
    expect(readMeta(dirOf(home, 'a'))).toMatchObject({ exitCause: 'host-restart', restorable: true })
  }, 20000)

  test('SC-42: an ended stored session can be subscribed read only', async () => {
    const { manager, home } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('x', sh('echo bye; exit 0')))
    await waitFor(() => exits.length > 0, 5000, 'exit event')
    await manager.shutdown()

    const { manager: next } = newManager({}, home)
    expect(next.list()[0]).toMatchObject({ sessionId: 'x', state: 'exited', alive: false, exitCode: 0, exitCause: 'exited', pid: 0 })
    const chunks: Uint8Array[] = []
    const sub = await next.subscribe('x', (_id, bytes) => chunks.push(bytes))
    expect(sub.live).toBe(false)
    expect(sub).toMatchObject({ cols: 80, rows: 24, shellState: 'unsupported' })
    expect(bufferLines(await paint(base64ToBytes(sub.replay))).join('\n')).toContain('bye')
    expect(next.subscriberCount('x')).toBe(0)
    await expect(next.subscribe('x', () => {}, { mode: 'raw' })).rejects.toThrow('session x is not running')

    expect((await next.read('x', 5)).lines).toContain('bye')
    const snap = await next.snapshot('x')
    expect(snap.ansi).toContain('bye')
    expect(snap).toMatchObject({ shellState: 'unsupported', cols: 80, rows: 24 })
    await expect(next.create(params('x', ['/bin/cat'], { restore: true }))).rejects.toThrow('session x is not restorable')
    expect(chunks).toEqual([])
  })

  test('SC-39: forget removes a stored session and its directory', async () => {
    const { manager, home } = newManager()
    const exits = exitEvents(manager)
    await manager.create(params('x', sh('echo bye; exit 0')))
    await waitFor(() => exits.length > 0, 5000, 'exit event')
    await manager.shutdown()

    const { manager: next } = newManager({}, home)
    expect(existsSync(dirOf(home, 'x'))).toBe(true)
    next.forget('x')
    expect(existsSync(dirOf(home, 'x'))).toBe(false)
    expect(next.list()).toEqual([])
    expect(() => next.forget('x')).toThrow('unknown session: x')
    await expect(next.history('x')).rejects.toThrow('unknown session: x')
  })

  test('forget kills a running session and removes its directory', async () => {
    const { manager, home } = newManager()
    const { pid } = await manager.create(params('f', sh('echo hi; sleep 100')))
    await readUntil(manager, 'f', 0, (lines) => lines.includes('hi'))
    manager.forget('f')
    expect(existsSync(dirOf(home, 'f'))).toBe(false)
    expect(manager.list()).toEqual([])
    await waitFor(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      5000,
      'process to be killed'
    )
    await Bun.sleep(100)
    expect(existsSync(dirOf(home, 'f'))).toBe(false)
  })
})

describe('removed sinks and shutdown races', () => {
  test('a sink removed while its screen subscribe settles is never registered', async () => {
    const { manager } = newManager()
    await manager.create(params('r', sh('echo hi; sleep 30')))
    await readUntil(manager, 'r', 0, (lines) => lines.includes('hi'))

    const gone = () => {}
    const unsubscribed = manager.subscribe('r', gone)
    manager.unsubscribe('r', gone)
    await expect(unsubscribed).rejects.toThrow('subscription cancelled')
    expect(manager.subscriberCount('r')).toBe(0)

    const dropped = manager.subscribe('r', gone)
    manager.dropSink(gone)
    await expect(dropped).rejects.toThrow('subscription cancelled')
    expect(manager.subscriberCount('r')).toBe(0)

    const kept = () => {}
    const other = manager.subscribe('r', kept)
    manager.dropSink(gone)
    await other
    expect(manager.subscriberCount('r')).toBe(1)
  })

  test('forgetting a session cancels a subscribe that is still settling', async () => {
    const { manager } = newManager()
    await manager.create(params('r', sh('echo hi; sleep 30')))
    await readUntil(manager, 'r', 0, (lines) => lines.includes('hi'))
    const pending = manager.subscribe('r', () => {})
    manager.forget('r')
    await expect(pending).rejects.toThrow()
  })

  test('a stored session reports the cwd the rebuild recovered, not the stale meta cwd', async () => {
    const root = tempDir()
    const home = storedSession('c', `\x1b]7;file://h${root}\x07done\r\n`)
    const { manager } = newManager({}, home)
    expect((await manager.snapshot('c')).cwd).toBe(root)
  })

  test('a stored session read reports the alternate screen from the rebuilt screen', async () => {
    const home = storedSession('a', '\x1b[?1049hfullscreen\r\n')
    const { manager } = newManager({}, home)
    const result = await manager.read('a', 5)
    expect(result.alt).toBe(true)
    expect(result.lines).toContain('fullscreen')
  })

  test('a restore still replaying from disk when shutdown begins does not spawn and stays restorable', async () => {
    const home = storedSession('w', 'old-1\r\n')
    const { manager } = newManager({}, home)
    const restoring = manager.create(params('w', ['/bin/cat'], { restore: true }))
    const stopped = manager.shutdown()
    await expect(restoring).rejects.toThrow('Terminal host is shutting down')
    await stopped
    expect(manager.isAlive('w')).toBe(false)
    expect(manager.list()).toMatchObject([{ sessionId: 'w', state: 'restorable' }])
    await expect(manager.create(params('n', ['/bin/cat']))).rejects.toThrow('Terminal host is shutting down')
  })
})
