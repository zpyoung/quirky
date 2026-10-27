import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { base64ToBytes } from '@quirky/protocol'
import { readCheckpoint } from '../src/history/checkpoint'
import { readSegments } from '../src/history/log'
import { MODE_RESET } from '../src/history/restore'
import { type CreateParams, SessionManager, type SessionManagerOptions } from '../src/session'
import { concat, onCleanup, runCleanups, scopeForHome, tempHome, text, trackSessionProcesses, waitFor } from './helpers'

afterEach(runCleanups)

const ENV = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
const enc = (s: string) => new TextEncoder().encode(s)
const CLEARED = '\x1b[H\x1b[2J\x1b[3J'

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

/** Everything a session streams from now on, as a pane attached to it would receive it. */
async function attach(manager: SessionManager, sessionId: string) {
  const parts: Uint8Array[] = []
  const sub = await manager.subscribe(sessionId, (_id, bytes) => parts.push(bytes))
  return { sub, text: () => text(concat(parts)), bytes: () => concat(parts) }
}

async function paint(replay: Uint8Array, cols = 80, rows = 24): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 20000, allowProposedApi: true })
  onCleanup(() => term.dispose())
  await new Promise<void>((resolve) => term.write(replay, resolve))
  return term
}

function rowsOf(term: Terminal): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true))
}

async function readUntil(manager: SessionManager, sessionId: string, lines: number, done: (lines: string[]) => boolean) {
  return waitFor(
    async () => {
      const result = await manager.read(sessionId, lines)
      return done(result.lines) ? result : null
    },
    10000,
    'screen content'
  )
}

/** A shell script that prints 500 numbered lines, leaves a prompt and then waits. */
const BUSY = sh(`seq -f 'old-%g' 1 500; printf '$ '; exec cat`)

async function busySession(manager: SessionManager, sessionId: string, extra: Partial<CreateParams> = {}) {
  await manager.create(params(sessionId, BUSY, extra))
  await readUntil(manager, sessionId, 0, (lines) => lines.at(-1) === '$')
}

describe('clear', () => {
  test('SC-34: leaves the cursor line as the whole screen and removes the scrollback and history', async () => {
    const { manager } = newManager()
    await busySession(manager, 'c1')
    expect((await manager.history('c1', { lines: 100 })).lines.length).toBeGreaterThan(0)

    await manager.clear('c1')

    expect((await manager.history('c1', { lines: 100 })).lines).toEqual([])
    expect((await manager.read('c1', 1000)).lines).toEqual(['$'])
    const snapshot = await manager.snapshot('c1')
    expect(snapshot.ansi).toContain('$')
    expect(snapshot.ansi).not.toContain('old-')
    expect(snapshot.cursor).toEqual({ x: 2, y: 0 })

    const { sub } = await attach(manager, 'c1')
    const term = await paint(base64ToBytes(sub.replay))
    expect(rowsOf(term).filter((row) => row !== '')).toEqual(['$ '])
    expect(term.buffer.active.length).toBe(24)
    expect(sub.historyCursor).toBeNull()
  })

  test('SC-34: every attached stream receives the erase sequences and the cleared screen, then live output in order', async () => {
    const { manager } = newManager()
    await busySession(manager, 'c2')
    const first = await attach(manager, 'c2')
    const second = await attach(manager, 'c2')
    const before = (await manager.snapshot('c2')).offset

    await manager.clear('c2')
    manager.write('c2', enc('after\n'))
    await waitFor(() => (first.text().match(/after/g) ?? []).length >= 2, 5000, 'live output after the clear')

    for (const stream of [first, second]) {
      const sent = stream.text()
      expect(sent.startsWith(`${CLEARED}$ `)).toBe(true)
      expect(sent.indexOf('after')).toBeGreaterThan(sent.indexOf(CLEARED))
      expect(sent.indexOf('old-')).toBe(-1)
    }
    expect(first.text()).toBe(second.text())
    expect((await manager.snapshot('c2')).offset).toBe(before + first.bytes().length)
  })

  test('SC-34: offsets stay monotonic and the stream position matches what subscribers were sent', async () => {
    const { manager } = newManager()
    await busySession(manager, 'c3')
    const stream = await attach(manager, 'c3')
    const start = stream.sub.offset

    await manager.clear('c3')
    const afterClear = manager.list()[0]!.offset
    expect(afterClear).toBeGreaterThan(start)
    await manager.clear('c3')
    manager.write('c3', enc('x\n'))
    await readUntil(manager, 'c3', 5, (lines) => lines.includes('x'))
    await waitFor(() => (stream.text().match(/x/g) ?? []).length >= 2, 5000, 'echo and cat output')

    expect(manager.list()[0]!.offset).toBeGreaterThan(afterClear)
    expect(start + stream.bytes().length).toBe(manager.list()[0]!.offset)
  })

  test('SC-34: rows scrolled after the clear are history, rows before it are not', async () => {
    const { manager } = newManager()
    await busySession(manager, 'c4')
    await manager.clear('c4')
    manager.write('c4', enc(`${Array.from({ length: 60 }, (_, i) => `new-${i + 1}`).join('\n')}\n`))
    await readUntil(manager, 'c4', 0, (lines) => lines.includes('new-60'))

    const history = (await manager.history('c4', { lines: 500 })).lines
    expect(history.some((row) => row.includes('old-'))).toBe(false)
    expect(history.some((row) => row.includes('new-1'))).toBe(true)
    expect(history[0]).toBe('$ new-1')
    const page = await manager.history('c4', { lines: 500 })
    expect(page.cursor).toBeNull()
    expect((await manager.read('c4', 1000)).lines.some((row) => row.includes('old-'))).toBe(false)
  })

  test('SC-34: a raw subscription replays from the cleared screen', async () => {
    const { manager } = newManager({ tailBytes: 4096 })
    await busySession(manager, 'c5')
    await manager.clear('c5')
    const parts: Uint8Array[] = []
    const sub = await manager.subscribe('c5', (_id, bytes) => parts.push(bytes), { mode: 'raw' })
    expect(text(base64ToBytes(sub.replay)).startsWith(`${CLEARED}$ `)).toBe(true)
    expect(text(base64ToBytes(sub.replay))).not.toContain('old-')
    expect(sub.offset).toBe(manager.list()[0]!.offset)
  })

  test('SC-34: the log gets a clear record at the output position and a checkpoint of the cleared screen', async () => {
    const { manager, home } = newManager()
    await busySession(manager, 'c6')
    const before = manager.list()[0]!.offset

    await manager.clear('c6')

    const records = readSegments(dirOf(home, 'c6')).segments.flatMap((s) => s.records)
    const cleared = records.filter((r) => r.kind === 'clear')
    expect(cleared.map((r) => r.offset)).toEqual([before])
    const checkpoint = readCheckpoint(dirOf(home, 'c6'))!
    expect(checkpoint.offset).toBe(manager.list()[0]!.offset)
    expect(checkpoint.ansi).not.toContain('old-')
    expect(checkpoint.ansi).toContain('$')
  })

  test('SC-34: a cold restore after a clear shows only the kept line and what came after', async () => {
    const { manager: first, home } = newManager()
    await busySession(first, 'c7')
    await first.clear('c7')
    first.write('c7', enc('post-clear\n'))
    await readUntil(first, 'c7', 5, (lines) => lines.includes('post-clear'))
    await first.shutdown()

    const { manager: second } = newManager({}, home)
    expect(second.list()[0]).toMatchObject({ sessionId: 'c7', state: 'restorable' })
    const stored = await second.read('c7', 1000)
    expect(stored.lines.some((row) => row.includes('old-'))).toBe(false)
    expect(stored.lines).toContain('post-clear')
    expect((await second.history('c7', { lines: 100 })).lines).toEqual([])
    const stream = await second.subscribe('c7', () => {})
    const term = await paint(base64ToBytes(stream.replay))
    expect(rowsOf(term).some((row) => row.includes('old-'))).toBe(false)

    await second.create(params('c7', ['/bin/cat'], { restore: true }))
    const restored = await second.read('c7', 1000)
    expect(restored.lines.some((row) => row.includes('old-'))).toBe(false)
    expect(restored.lines).toContain('post-clear')
    expect((await second.history('c7', { lines: 100 })).lines.some((row) => row.includes('old-'))).toBe(false)
  }, 30000)

  test('SC-34: a cold restore after a clear still holds when the checkpoint is older than the clear', async () => {
    const { manager: first, home } = newManager({ checkpointIntervalMs: 60_000 })
    await busySession(first, 'c8')
    await first.clear('c8')
    await first.shutdown()
    // the checkpoint the clear wrote is replaced by one from before it
    const dir = dirOf(home, 'c8')
    const { writeCheckpoint } = await import('../src/history/checkpoint')
    const current = readCheckpoint(dir)!
    writeCheckpoint(dir, { ...current, offset: 10, ansi: 'old-1\r\nold-2' })

    const { manager: second } = newManager({}, home)
    const stored = await second.read('c8', 1000)
    expect(stored.lines.some((row) => row.includes('old-'))).toBe(false)
    expect(stored.lines).toEqual(['$'])
  }, 30000)

  test('SC-34: an exited session can be cleared and the clear survives a restart', async () => {
    const { manager, home } = newManager()
    await manager.create(params('c9', sh(`seq -f 'gone-%g' 1 200; exit 0`)))
    await waitFor(() => manager.list()[0]?.state === 'exited', 5000, 'exit')
    expect((await manager.history('c9', { lines: 50 })).lines.length).toBeGreaterThan(0)
    const before = manager.list()[0]!.offset

    await manager.clear('c9')

    expect((await manager.history('c9', { lines: 50 })).lines).toEqual([])
    expect((await manager.read('c9', 1000)).lines.some((row) => row.includes('gone-'))).toBe(false)
    expect(manager.list()[0]!.offset).toBeGreaterThan(before)
    expect(readSegments(dirOf(home, 'c9')).segments.flatMap((s) => s.records).filter((r) => r.kind === 'clear')).toHaveLength(1)

    const { manager: second } = newManager({}, home)
    expect(second.list()[0]).toMatchObject({ sessionId: 'c9', state: 'exited' })
    expect((await second.read('c9', 1000)).lines.some((row) => row.includes('gone-'))).toBe(false)
    expect((await second.history('c9', { lines: 50 })).lines).toEqual([])
  })

  test('an unknown session is the usual not-found error', async () => {
    const { manager } = newManager()
    await expect(manager.clear('nope')).rejects.toThrow('unknown session: nope')
    await expect(manager.resetModes('nope')).rejects.toThrow('unknown session: nope')
  })

  test('a stored session that is not running cannot be cleared', async () => {
    const { manager: first, home } = newManager()
    await busySession(first, 'c10')
    await first.shutdown()
    const { manager: second } = newManager({}, home)
    await expect(second.clear('c10')).rejects.toThrow('session c10 is not running')
    await expect(second.resetModes('c10')).rejects.toThrow('session c10 is not running')
  }, 30000)

  test('output that arrives while a clear waits for the screen lands after it', async () => {
    const { manager } = newManager()
    await busySession(manager, 'c11')
    const stream = await attach(manager, 'c11')
    manager.write('c11', enc('burst-1\nburst-2\nburst-3\n'))
    const clearing = manager.clear('c11')
    manager.write('c11', enc('burst-4\n'))
    await clearing
    await waitFor(() => stream.text().includes('burst-4'), 5000, 'late output')

    const sent = stream.text()
    expect(sent.lastIndexOf(CLEARED)).toBeGreaterThanOrEqual(0)
    expect(sent.indexOf('burst-4', sent.lastIndexOf(CLEARED))).toBeGreaterThan(0)
    expect(stream.sub.offset + stream.bytes().length).toBe(manager.list()[0]!.offset)
  })
})

describe('resetModes', () => {
  const MODES_ON = `stty raw -echo; printf '\\033[?1000h\\033[?1002h\\033[?1006h\\033[?2004h\\033[?1h\\033[?25lmodes-set'; exec cat`

  test('SC-34: turns the tracking modes off in the screen without touching its text', async () => {
    const { manager } = newManager()
    await manager.create(params('m1', sh(MODES_ON)))
    await readUntil(manager, 'm1', 0, (lines) => lines.includes('modes-set'))
    expect((await manager.snapshot('m1')).modes).toEqual({
      alternateScreen: false,
      bracketedPaste: true,
      mouseTracking: true,
      applicationCursor: true
    })
    const before = await manager.snapshot('m1')

    await manager.resetModes('m1')

    const after = await manager.snapshot('m1')
    expect(after.modes).toEqual({ alternateScreen: false, bracketedPaste: false, mouseTracking: false, applicationCursor: false })
    expect(after.ansi).toContain('modes-set')
    expect(after.cursor).toEqual(before.cursor)
    expect((await manager.read('m1', 10)).lines).toEqual(['modes-set'])
  })

  test('SC-34: sends the reset to every subscriber, logs it as output and writes nothing to the process', async () => {
    const { manager, home } = newManager()
    await manager.create(params('m2', sh(MODES_ON)))
    await readUntil(manager, 'm2', 0, (lines) => lines.includes('modes-set'))
    const stream = await attach(manager, 'm2')
    const before = manager.list()[0]!.offset

    await manager.resetModes('m2')
    await Bun.sleep(300)

    expect(stream.bytes()).toEqual(MODE_RESET)
    expect(manager.list()[0]!.offset).toBe(before + MODE_RESET.length)
    const logged = readSegments(dirOf(home, 'm2'))
      .segments.flatMap((s) => s.records)
      .filter((r) => r.kind === 'output')
      .map((r) => text(r.bytes!))
      .join('')
    expect(logged.endsWith(text(MODE_RESET))).toBe(true)
    expect(text(stream.bytes())).toContain('\x1b[?25h')
  })

  test('SC-34: an attach after the reset paints with the modes off, and so does a cold restore', async () => {
    const { manager: first, home } = newManager()
    await first.create(params('m3', sh(MODES_ON)))
    await readUntil(first, 'm3', 0, (lines) => lines.includes('modes-set'))
    await first.resetModes('m3')

    const { sub } = await attach(first, 'm3')
    const term = await paint(base64ToBytes(sub.replay))
    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.modes.bracketedPasteMode).toBe(false)
    expect(term.modes.applicationCursorKeysMode).toBe(false)
    await first.shutdown()

    const { manager: second } = newManager({}, home)
    expect((await second.snapshot('m3')).modes).toMatchObject({ bracketedPaste: false, mouseTracking: false, applicationCursor: false })
    await second.create(params('m3', ['/bin/cat'], { restore: true }))
    expect((await second.snapshot('m3')).modes).toMatchObject({ bracketedPaste: false, mouseTracking: false, applicationCursor: false })
  }, 30000)

  test('without a reset a stored session still shows the modes on', async () => {
    const { manager: first, home } = newManager()
    await first.create(params('m4', sh(MODES_ON)))
    await readUntil(first, 'm4', 0, (lines) => lines.includes('modes-set'))
    await first.shutdown()
    const { manager: second } = newManager({}, home)
    expect((await second.snapshot('m4')).modes).toMatchObject({ bracketedPaste: true, mouseTracking: true, applicationCursor: true })
  }, 30000)

  test('an exited session can have its modes reset', async () => {
    const { manager, home } = newManager()
    await manager.create(params('m5', sh(`printf '\\033[?2004hdone'; exit 0`)))
    await waitFor(() => manager.list()[0]?.state === 'exited', 5000, 'exit')
    expect((await manager.snapshot('m5')).modes.bracketedPaste).toBe(true)
    const before = manager.list()[0]!.offset

    await manager.resetModes('m5')

    expect((await manager.snapshot('m5')).modes.bracketedPaste).toBe(false)
    expect(manager.list()[0]!.offset).toBe(before + MODE_RESET.length)
    const { manager: second } = newManager({}, home)
    expect((await second.snapshot('m5')).modes.bracketedPaste).toBe(false)
  })
})
