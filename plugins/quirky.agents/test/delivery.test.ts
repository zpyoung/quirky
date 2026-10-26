import { afterEach, describe, expect, test } from 'bun:test'
import type { PluginPty } from '@quirky/protocol'
import { DeliveryRunner } from '../src/delivery'
import { validateEntry } from '../src/core/entry'
import type { AgentEntry } from '../src/core/types'

const SESSION = 's1'
const PASTE_ON = '\x1b[?2004h'
const CURSOR = '\x1b[?25h'
const SCALE = 0.05

function entry(id: string, data: Record<string, unknown> = {}): AgentEntry {
  const result = validateEntry('quirky.agents', id, { label: id, detect: id, prompt: 'stdin-after-start', ...data })
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

/** Ready the moment output shows the cursor under bracketed paste, so tests need no quiet window. */
const fast = (id: string, data: Record<string, unknown> = {}) =>
  entry(id, { readySignal: 'render-cursor-after-bracketed-paste', ...data })

type Write = { at: number; data: string }

class FakePty {
  writes: Write[] = []
  subscribed: string[] = []
  unsubscribed: string[] = []
  replay = ''
  subscribeError: Error | null = null
  writeError: Error | null = null
  private data = new Set<(sessionId: string, bytes: Uint8Array) => void>()
  private exits = new Set<(sessionId: string, exitCode: number | null) => void>()
  private reconnects = new Set<() => void>()

  listenerCount = () => this.data.size + this.exits.size + this.reconnects.size

  readonly api = {
    connected: true,
    subscribe: async (sessionId: string) => {
      this.subscribed.push(sessionId)
      if (this.subscribeError) throw this.subscribeError
      return { replay: this.replay, offset: 0 }
    },
    unsubscribe: async (sessionId: string) => {
      this.unsubscribed.push(sessionId)
    },
    write: (_sessionId: string, data: string | Uint8Array) => {
      if (this.writeError) throw this.writeError
      this.writes.push({ at: Date.now(), data: typeof data === 'string' ? data : new TextDecoder().decode(data) })
    },
    onData: (listener: (sessionId: string, bytes: Uint8Array) => void) => {
      this.data.add(listener)
      return () => this.data.delete(listener)
    },
    onExit: (listener: (sessionId: string, exitCode: number | null) => void) => {
      this.exits.add(listener)
      return () => this.exits.delete(listener)
    },
    onReconnect: (listener: () => void) => {
      this.reconnects.add(listener)
      return () => this.reconnects.delete(listener)
    }
  } as unknown as PluginPty

  setReplay(text: string) {
    this.replay = Buffer.from(text).toString('base64')
  }
  emit(text: string, sessionId = SESSION) {
    for (const listener of [...this.data]) listener(sessionId, new TextEncoder().encode(text))
  }
  exit(sessionId = SESSION) {
    for (const listener of [...this.exits]) listener(sessionId, 0)
  }
  reconnect() {
    for (const listener of [...this.reconnects]) listener()
  }
  get paste() {
    return this.writes.map((w) => w.data)
  }
}

let goneListeners = new Set<(sessionId: string) => void>()
const logs: string[] = []

function setup(options: { timeScale?: number } = {}) {
  const pty = new FakePty()
  goneListeners = new Set()
  logs.length = 0
  const runner = new DeliveryRunner({
    pty: pty.api,
    onSessionGone: (listener) => {
      goneListeners.add(listener)
      return () => goneListeners.delete(listener)
    },
    timeScale: options.timeScale ?? SCALE,
    log: (message) => logs.push(message)
  })
  return { pty, runner }
}

const sessionGone = (sessionId = SESSION) => {
  for (const listener of [...goneListeners]) listener(sessionId)
}

const until = async (condition: () => boolean, ms = 2000) => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('condition not reached')
    await Bun.sleep(1)
  }
}

const frame = (text: string) => `\x1b[200~${text}\x1b[201~`

afterEach(() => {
  goneListeners = new Set()
})

describe('DeliveryRunner', () => {
  test('SC-20: a bracketed paste goes out once ready, then a separate Enter after the settle delay', async () => {
    const { pty, runner } = setup()
    const goose = entry('goose')
    const result = runner.deliver(SESSION, goose, 'a\r\nb\x1bc', true)
    await until(() => pty.subscribed.length === 1)
    pty.emit(PASTE_ON)
    expect(await result).toBe('pasted')
    expect(pty.paste).toEqual([frame('a\rb␛c'), '\r'])
    const gap = pty.writes[1]!.at - pty.writes[0]!.at
    expect(gap).toBeGreaterThanOrEqual(501 * SCALE - 2)
  })

  test('SC-20: nothing is written before the agent is ready', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, entry('goose'), 'hi', true)
    await until(() => pty.subscribed.length === 1)
    pty.emit('booting...')
    await Bun.sleep(100)
    expect(pty.writes).toEqual([])
    pty.emit(PASTE_ON)
    expect(await result).toBe('pasted')
  })

  test('SC-22: an agent that never signals ready gets a blind paste and Enter at the deadline, unconfirmed', async () => {
    const { pty, runner } = setup()
    const start = Date.now()
    const aider = entry('aider')
    const outcome = await runner.deliver(SESSION, aider, 'hi', true)
    expect(outcome).toBe('unconfirmed')
    expect(pty.paste).toEqual([frame('hi'), '\r'])
    expect(pty.writes[0]!.at - start).toBeGreaterThanOrEqual(8000 * SCALE - 2)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(SESSION)
    expect(logs[0]).toContain('aider')
    expect(logs[0]).toContain('unconfirmed')
  })

  test('SC-23: a codex entry that never shows its composer is not delivered and nothing is written', async () => {
    const { pty, runner } = setup()
    const codex = entry('codex', { readySignal: 'codex-composer-prompt', readyTimeoutMs: 20000, blindPaste: false })
    const result = runner.deliver(SESSION, codex, 'review', false)
    await until(() => pty.subscribed.length === 1)
    pty.emit('Update available! Press enter to continue')
    expect(await result).toBe('not-delivered')
    expect(pty.writes).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('codex')
    expect(logs[0]).toContain('not-delivered')
    expect(pty.unsubscribed).toEqual([SESSION])
  })

  test('SC-24: an exit before ready writes nothing and is not delivered', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, entry('amp'), 'hi', true)
    await until(() => pty.subscribed.length === 1)
    pty.exit()
    expect(await result).toBe('not-delivered')
    expect(pty.writes).toEqual([])
    expect(logs).toHaveLength(1)
  })

  test('SC-24: a session removed before ready writes nothing and is not delivered', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, entry('aider'), 'hi', true)
    await until(() => pty.subscribed.length === 1)
    sessionGone()
    expect(await result).toBe('not-delivered')
    expect(pty.writes).toEqual([])
  })

  test('SC-24: a session removed while the subscribe is in flight writes nothing', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, fast('amp'), 'hi', true)
    sessionGone()
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await result).toBe('not-delivered')
    expect(pty.writes).toEqual([])
    expect(pty.unsubscribed).toEqual([SESSION])
  })

  test('SC-24: another session exiting or sending output changes nothing', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, fast('goose'), 'hi', false)
    await until(() => pty.subscribed.length === 1)
    pty.exit('other')
    pty.emit(`${PASTE_ON}${CURSOR}`, 'other')
    sessionGone('other')
    await Bun.sleep(30)
    expect(pty.writes).toEqual([])
    pty.emit(`${PASTE_ON}${CURSOR}`)
    expect(await result).toBe('pasted')
  })

  test('a PTY reconnect before the paste is not delivered and writes nothing', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, entry('goose'), 'hi', true)
    await until(() => pty.subscribed.length === 1)
    pty.reconnect()
    expect(await result).toBe('not-delivered')
    expect(pty.writes).toEqual([])
  })

  test('a subscribe that throws is not delivered and leaves no listeners', async () => {
    const { pty, runner } = setup()
    pty.subscribeError = new Error('unknown session')
    expect(await runner.deliver(SESSION, entry('goose'), 'hi', true)).toBe('not-delivered')
    expect(pty.writes).toEqual([])
    expect(pty.listenerCount()).toBe(0)
    expect(goneListeners.size).toBe(0)
  })

  test('SC-25: qwen-code gets a second Enter submitRetryMs after the first', async () => {
    const { pty, runner } = setup()
    const qwen = fast('qwen-code', { submitRetryMs: 1200 })
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await runner.deliver(SESSION, qwen, 'one\ntwo\nthree', true)).toBe('pasted')
    expect(pty.paste).toEqual([frame('one\rtwo\rthree'), '\r', '\r'])
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(501 * SCALE - 2)
    expect(pty.writes[2]!.at - pty.writes[1]!.at).toBeGreaterThanOrEqual(1200 * SCALE - 2)
  })

  test('SC-25: antigravity waits an extra 45 ms per line before Enter', async () => {
    const { pty, runner } = setup()
    const agy = fast('antigravity', { lineSettleMs: 45 })
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    await runner.deliver(SESSION, agy, 'a\nb\nc', true)
    expect(pty.paste).toEqual([frame('a\rb\rc'), '\r'])
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual((500 + 3 * 45) * SCALE - 2)
  })

  test('SC-25: omp sends Enter in the same write as the paste', async () => {
    const { pty, runner } = setup()
    const omp = fast('omp', { enterWithPaste: true })
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await runner.deliver(SESSION, omp, 'x', true)).toBe('pasted')
    expect(pty.paste).toEqual([`${frame('x')}\r`])
  })

  test('SC-25: enterWithPaste still honours submitRetryMs after the combined write', async () => {
    const { pty, runner } = setup()
    const omp = fast('omp', { enterWithPaste: true, submitRetryMs: 600 })
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    await runner.deliver(SESSION, omp, 'x', true)
    expect(pty.paste).toEqual([`${frame('x')}\r`, '\r'])
    expect(pty.writes[1]!.at - pty.writes[0]!.at).toBeGreaterThanOrEqual(600 * SCALE - 2)
  })

  test('SC-26: a draft is pasted with no Enter and no retry', async () => {
    const { pty, runner } = setup()
    const draft = fast('goose', { submitRetryMs: 1200, enterWithPaste: true })
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await runner.deliver(SESSION, draft, 'look at #5', false)).toBe('pasted')
    await Bun.sleep(1500 * SCALE + 30)
    expect(pty.paste).toEqual([frame('look at #5')])
  })

  test('a draft waits on the ready signal, a submit on the submit signal', async () => {
    const opencode = entry('opencode', {
      readySignal: 'render-cursor-after-bracketed-paste',
      submitSignal: 'opencode-agent-row',
      readyTimeoutMs: 1000
    })
    const first = setup()
    first.pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await first.runner.deliver(SESSION, opencode, 'hi', false)).toBe('pasted')
    expect(first.pty.paste).toEqual([frame('hi')])

    const second = setup()
    second.pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await second.runner.deliver(SESSION, opencode, 'hi', true)).toBe('unconfirmed')
  })

  test('a ready signal already in the replay pastes without waiting for output', async () => {
    const { pty, runner } = setup()
    pty.setReplay(`banner\n${PASTE_ON}${CURSOR}`)
    const start = Date.now()
    expect(await runner.deliver(SESSION, fast('goose'), 'hi', false)).toBe('pasted')
    expect(Date.now() - start).toBeLessThan(500)
    expect(pty.paste).toEqual([frame('hi')])
  })

  test('a quiet-window signal in the replay fires after the scaled quiet window', async () => {
    const { pty, runner } = setup()
    pty.setReplay(PASTE_ON)
    const start = Date.now()
    expect(await runner.deliver(SESSION, entry('goose'), 'hi', false)).toBe('pasted')
    expect(Date.now() - start).toBeGreaterThanOrEqual(1500 * SCALE - 2)
  })

  test('escape sequences split across chunks still signal ready', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, fast('goose'), 'hi', false)
    await until(() => pty.subscribed.length === 1)
    for (const chunk of ['\x1b[?20', '04h\x1b', '[?2', '5h']) {
      pty.emit(chunk)
    }
    expect(await result).toBe('pasted')
  })

  test('output that arrives while the subscribe is in flight is scanned after the replay', async () => {
    const { pty, runner } = setup()
    const result = runner.deliver(SESSION, fast('goose'), 'hi', false)
    pty.emit(PASTE_ON)
    pty.emit(CURSOR)
    expect(await result).toBe('pasted')
  })

  test('an exit during the Enter delay cancels the Enter and still reports pasted', async () => {
    const { pty, runner } = setup({ timeScale: 0.2 })
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    const result = runner.deliver(SESSION, fast('goose'), 'hi', true)
    await until(() => pty.writes.length === 1)
    pty.exit()
    expect(await result).toBe('pasted')
    await Bun.sleep(600 * 0.2 + 30)
    expect(pty.paste).toEqual([frame('hi')])
  })

  test('an exit during a blind delivery reports unconfirmed and cancels the Enter', async () => {
    const { pty, runner } = setup({ timeScale: 0.02 })
    const result = runner.deliver(SESSION, entry('aider', { readyTimeoutMs: 1000 }), 'hi', true)
    await until(() => pty.writes.length === 1)
    sessionGone()
    expect(await result).toBe('unconfirmed')
    await Bun.sleep(40)
    expect(pty.paste).toEqual([frame('hi')])
  })

  test('a reconnect after the paste does not stop the Enter', async () => {
    const { pty, runner } = setup()
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    const result = runner.deliver(SESSION, fast('goose'), 'hi', true)
    await until(() => pty.writes.length === 1)
    pty.reconnect()
    expect(await result).toBe('pasted')
    expect(pty.paste).toEqual([frame('hi'), '\r'])
  })

  test('a write that throws before anything was written is not delivered', async () => {
    const { pty, runner } = setup()
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    pty.writeError = new Error('session is gone')
    expect(await runner.deliver(SESSION, fast('goose'), 'hi', true)).toBe('not-delivered')
    expect(pty.writes).toEqual([])
    expect(pty.unsubscribed).toEqual([SESSION])
  })

  test('a write that throws at the deadline is not delivered', async () => {
    const { pty, runner } = setup({ timeScale: 0.01 })
    pty.writeError = new Error('session is gone')
    expect(await runner.deliver(SESSION, entry('aider', { readyTimeoutMs: 1000 }), 'hi', true)).toBe('not-delivered')
  })

  test('a failing Enter write after the paste still reports pasted', async () => {
    const { pty, runner } = setup()
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    const result = runner.deliver(SESSION, fast('goose'), 'hi', true)
    await until(() => pty.writes.length === 1)
    pty.writeError = new Error('session is gone')
    expect(await result).toBe('pasted')
    expect(pty.paste).toEqual([frame('hi')])
  })

  test('settling unsubscribes once, removes every listener and writes nothing afterwards', async () => {
    const { pty, runner } = setup()
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await runner.deliver(SESSION, fast('qwen-code', { submitRetryMs: 300 }), 'hi', true)).toBe('pasted')
    expect(pty.unsubscribed).toEqual([SESSION])
    expect(pty.listenerCount()).toBe(0)
    expect(goneListeners.size).toBe(0)
    const count = pty.writes.length
    pty.emit(`${PASTE_ON}${CURSOR}`)
    pty.exit()
    pty.reconnect()
    sessionGone()
    await Bun.sleep(100)
    expect(pty.writes).toHaveLength(count)
    expect(pty.unsubscribed).toEqual([SESSION])
  })

  test('an unsubscribe that rejects does not fail the delivery', async () => {
    const { pty, runner } = setup()
    pty.api.unsubscribe = async () => {
      throw new Error('host gone')
    }
    pty.setReplay(`${PASTE_ON}${CURSOR}`)
    expect(await runner.deliver(SESSION, fast('goose'), 'hi', false)).toBe('pasted')
  })

  test('two deliveries to different sessions do not disturb each other', async () => {
    const { pty, runner } = setup()
    const a = runner.deliver('a', fast('goose'), 'for a', false)
    const b = runner.deliver('b', fast('goose'), 'for b', false)
    await until(() => pty.subscribed.length === 2)
    pty.emit(`${PASTE_ON}${CURSOR}`, 'b')
    expect(await b).toBe('pasted')
    expect(pty.paste).toEqual([frame('for b')])
    sessionGone('a')
    expect(await a).toBe('not-delivered')
  })
})
