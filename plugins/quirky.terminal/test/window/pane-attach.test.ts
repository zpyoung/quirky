import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'node:test'
import { act } from 'react'
import { RpcError, RpcErrorCode, bytesToBase64, GRAPHITE_TERMINAL_PALETTES, TERMINAL_ANSI_KEYS, type TerminalAppearanceMode, type TerminalPalette } from '@quirky/protocol'
import type { ITheme } from '@xterm/xterm'
import { version as xtermVersion } from '@xterm/xterm/package.json'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, settle, startRecording, stopRecording, terminals, unloadPane, type MountedPane } from './pane-support'
import { trackKittyFlags } from '../../src/window/pane/kitty'
let mounted: MountedPane | null = null
const text = (value: string) => new TextEncoder().encode(value)
let restoreClock: (() => void) | null = null

function fakeClock() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  restoreClock = () => {
    mock.timers.reset()
    restoreClock = null
  }
  return {
    now: () => Date.now(),
    advance: async (duration: number) => {
      await act(async () => {
        mock.timers.tick(duration)
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
      })
    }
  }
}

async function drainClock(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      mock.timers.tick(0)
      await Promise.resolve()
    }
  })
}

async function flushWithClock(pane: MountedPane): Promise<void> {
  let flushed = false
  const pending = pane.flush().then(() => { flushed = true })
  for (let attempt = 0; attempt < 100 && !flushed; attempt += 1) await drainClock()
  if (!flushed) throw new Error('xterm write callback did not settle under mock timers')
  await pending
}

async function pressKey(pane: MountedPane, init: KeyboardEventInit) {
  await act(async () => void pane.textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
}

function terminalText(pane: MountedPane): string {
  const buffer = pane.term().buffer.active
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n')
}

function expectGraphitePalette(theme: ITheme | undefined, appearance: TerminalAppearanceMode, base: Partial<TerminalPalette> = {}) {
  const expected = GRAPHITE_TERMINAL_PALETTES[appearance]
  for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    expect(theme?.[key]).toBe(base[key] ?? expected[key])
  }
  for (const key of TERMINAL_ANSI_KEYS) expect(theme?.[key]).toBe(expected[key])
}

beforeAll(loadPane)
afterAll(unloadPane)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  restoreClock?.()
  stopRecording()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

async function mount(over = {}, handlers = paneHandlers(), settingOverrides = {}) {
  const fake = fakeContext(handlers, settingOverrides)
  mounted = await mountPane(fake, over)
  return { fake, pane: mounted }
}

describe('attach, replay and input', () => {
  test('attaches the session at the pane size with the scrollback as history lines', async () => {
    const { fake } = await mount({ settings: settings({ scrollback: 4000 }) })
    const [attach] = fake.callsTo('quirky.terminal/attach')
    expect(attach!.params.session).toBe('s1')
    expect(attach!.params.historyLines).toBe(4000)
    expect(attach!.params.cols).toBe(terminals[0]!.cols)
    expect(attach!.params.rows).toBe(terminals[0]!.rows)
  })

  test('writes the replay, then live output from the stream', async () => {
    const { fake, pane } = await mount({}, paneHandlers({ replay: bytesToBase64(text('old output')) }))
    await fake.push(101, '\r\nlive')
    await pane.flush()
    const buffer = pane.term().buffer.active
    expect(buffer.getLine(0)!.translateToString(true)).toBe('old output')
    expect(buffer.getLine(1)!.translateToString(true)).toBe('live')
  })

  test('typed input goes to the session', async () => {
    const { fake, pane } = await mount()
    await act(async () => pane.term().input('ls'))
    expect(fake.callsTo('quirky.terminal/write')[0]!.params).toEqual({ session: 's1', data: 'ls' })
  })
  test('a browser key uses one guarded write without a separate claim RPC', async () => {
    const { fake, pane } = await mount()
    const identityCalls = fake.callsTo('quirky.session/identity').length
    const callsBeforeKey = fake.calls.length
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
    expect(fake.callsTo('quirky.terminal/userInput')).toEqual([])

    await pressKey(pane, { key: 'a', keyCode: 65 })
    await settle()

    expect(fake.calls.slice(callsBeforeKey)).toEqual([{
      method: 'quirky.terminal/write',
      params: { session: 's1', data: 'a', expectedIncarnation: 'fixture-s1' }
    }])
    expect(fake.callsTo('quirky.session/identity')).toHaveLength(identityCalls)
    expect(fake.callsTo('quirky.terminal/userInput')).toEqual([])
  })


  test('replayed queries never answer into the live shell', async () => {
    const { fake, pane } = await mount({}, paneHandlers({ replay: bytesToBase64(text('\x1b[6n\x1b[>q')) }))
    await pane.flush()
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
    await act(async () => pane.term().input('x'))
    expect(fake.callsTo('quirky.terminal/write')).toHaveLength(1)
  })

  test('a program asking about synchronized output hears that the pane supports it', async () => {
    const { fake, pane } = await mount()
    await fake.push(101, '\x1b[?2026$p')
    await pane.flush()
    // DECRPM status 2 is "recognized, currently reset"; 0 would mean frames draw as they arrive
    expect(fake.callsTo('quirky.terminal/write').map((call) => call.params.data)).toEqual(['\x1b[?2026;2$y'])
  })

  test('a program asking which terminal this is hears xterm.js and its version', async () => {
    const { fake, pane } = await mount()
    await fake.push(101, '\x1b[>q')
    await pane.flush()
    expect(fake.callsTo('quirky.terminal/write').map((call) => call.params.data)).toEqual([`\x1bP>|xterm.js(${xtermVersion})\x1b\\`])
  })

  test('XTVERSION with a nonzero parameter gets no reply', async () => {
    const { fake, pane } = await mount()
    await fake.push(101, '\x1b[>1q')
    await pane.flush()
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
  })

  test('a pane that is not interactive ignores input', async () => {
    const { fake, pane } = await mount({ interactive: false })
    await act(async () => pane.term().input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
    await pane.rerender({ interactive: true })
    await act(async () => pane.term().input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toHaveLength(1)
  })

  test('an attach that is not live shows the final screen and sends no input', async () => {
    const { fake, pane } = await mount({}, paneHandlers({}, { 'quirky.terminal/attach': () => ({ streamId: 9, replay: bytesToBase64(text('bye')), live: false }) }))
    await act(async () => pane.term().input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
    expect(fake.streams.has(9)).toBe(false)
  })

  test('a failed attach writes the reason into the pane', async () => {
    const { pane } = await mount({}, paneHandlers({}, { 'quirky.terminal/attach': () => Promise.reject(new Error('no such session')) }))
    await pane.flush()
    expect(pane.term().buffer.active.getLine(1)!.translateToString(true)).toContain('Could not attach: no such session')
  })

  test('unmounting detaches the stream and stops listening to it', async () => {
    const { fake, pane } = await mount()
    expect(fake.streams.has(101)).toBe(true)
    await pane.unmount()
    mounted = null
    expect(fake.callsTo('quirky.terminal/detach')[0]!.params).toEqual({ streamId: 101 })
    expect(fake.streams.has(101)).toBe(false)
  })

  test('each attach gets its own stream', async () => {
    const { fake, pane } = await mount()
    await pane.rerender({ sessionId: 's2' })
    await settle()
    const ids = fake.callsTo('quirky.terminal/attach').map((call) => call.params.session)
    expect(ids).toEqual(['s1', 's2'])
    expect(fake.streams.has(102)).toBe(true)
  })
})
describe('output loss recovery', () => {
  test('resubscribes after lag, resets Kitty state and replays behind the input gate', async () => {
    const initialReplay = bytesToBase64(text('old\r\n\x1b[>5u\x1b_Ga=T,f=100;AAAA'))
    const historyLines = 321
    const { fake, pane } = await mount(
      { settings: settings({ scrollback: historyLines }) },
      paneHandlers({ replay: initialReplay }, {
        'quirky.terminal/resync': () => ({ streamId: 102, replay: bytesToBase64(text('new\x1b[6n')), live: true })
      })
    )
    await pane.flush()
    await pressKey(pane, { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(fake.callsTo('quirky.terminal/write').map((call) => call.params.data)).toEqual(['\x1b[13;2u'])

    const clock = fakeClock()
    await fake.lag(101)
    expect(fake.streams.has(101)).toBe(false)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(0)
    await clock.advance(249)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(0)
    await clock.advance(1)
    await flushWithClock(pane)

    expect(fake.callsTo('quirky.terminal/resync').map((call) => call.params)).toEqual([{ streamId: 101, historyLines }])
    expect(fake.streams.has(102)).toBe(true)
    expect(terminalText(pane)).toContain('new')
    expect(terminalText(pane)).not.toContain('old')
    expect(fake.callsTo('quirky.terminal/write').map((call) => call.params.data)).toEqual(['\x1b[13;2u'])
    await pressKey(pane, { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(fake.callsTo('quirky.terminal/write').map((call) => call.params.data)).toEqual(['\x1b[13;2u', '\x1b\r'])
  })

  test('bounds a continuous lag flood and converges after it ends', async () => {
    let nextStream = 101
    let replay = 0
    const { fake, pane } = await mount({}, paneHandlers({}, {
      'quirky.terminal/resync': () => ({
        streamId: ++nextStream,
        replay: bytesToBase64(text(`replay-${++replay}`)),
        live: true
      })
    }))
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    await flushWithClock(pane)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(1)

    for (let index = 0; index < 4; index += 1) {
      await fake.lag(102 + index)
      await clock.advance(2_000)
      await flushWithClock(pane)
      expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(index + 2)
    }
    await fake.lag(106)
    await clock.advance(1_750)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(5)
    await clock.advance(250)
    await flushWithClock(pane)

    expect(clock.now()).toBe(10_250)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(6)
    expect(fake.streams.has(107)).toBe(true)
    expect(terminalText(pane)).toContain('replay-6')
  })

  test('falls back to attach when resync reports NotFound', async () => {
    const { fake, pane } = await mount({}, paneHandlers({ replay: bytesToBase64(text('attached again')) }, {
      'quirky.terminal/resync': () => { throw new RpcError(RpcErrorCode.NotFound, 'no such stream: 101') }
    }))
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    await flushWithClock(pane)

    expect(fake.callsTo('quirky.terminal/resync').map((call) => call.params.streamId)).toEqual([101])
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(2)
    expect(fake.streams.has(102)).toBe(true)
    expect(terminalText(pane)).toContain('attached again')
  })

  test('shows attach failure after a NotFound fallback fails', async () => {
    const handlers = paneHandlers()
    const attach = handlers['quirky.terminal/attach']!
    let attaches = 0
    handlers['quirky.terminal/attach'] = (params) => {
      if (attaches++ > 0) throw new Error('attach unavailable')
      return attach(params)
    }
    handlers['quirky.terminal/resync'] = () => { throw new RpcError(RpcErrorCode.NotFound, 'no such stream: 101') }
    const { fake, pane } = await mount({}, handlers)
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    await flushWithClock(pane)

    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(1)
    expect(terminalText(pane)).toContain('Could not attach: attach unavailable')
    expect(fake.streams.has(101)).toBe(false)
  })
  test('detaches an ended replacement stream after replaying its final screen', async () => {
    const { fake, pane } = await mount({}, paneHandlers({}, {
      'quirky.terminal/resync': () => ({ streamId: 102, replay: bytesToBase64(text('final screen')), live: false })
    }))
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    await flushWithClock(pane)

    expect(terminalText(pane)).toContain('final screen')
    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params.streamId)).toContain(102)
  })


  test('retries transient resync failures three times at two-second intervals, then stops', async () => {
    const { fake, pane } = await mount({}, paneHandlers({}, {
      'quirky.terminal/resync': () => { throw new RpcError(RpcErrorCode.Internal, 'host busy') }
    }))
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(1)

    for (let retry = 1; retry <= 3; retry += 1) {
      await clock.advance(1_999)
      expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(retry)
      await clock.advance(1)
      expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(retry + 1)
    }
    expect(fake.callsTo('quirky.terminal/resync').map((call) => call.params.streamId)).toEqual([101, 101, 101, 101])
    await clock.advance(5_000)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(4)
    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params.streamId)).toContain(101)
    restoreClock?.()
    await pane.flush()
    expect(terminalText(pane)).toContain('Could not resync: host busy')
  })

  test('cancels a pending resync timer when the pane is disposed', async () => {
    const { fake, pane } = await mount()
    const clock = fakeClock()
    await fake.lag(101)
    await pane.unmount()
    mounted = null
    await clock.advance(250)

    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(0)
    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params.streamId)).toContain(101)
    expect(fake.streams.has(101)).toBe(false)
  })

  test('detaches the replacement stream when resync settles after disposal', async () => {
    let resolveResync!: (value: Record<string, unknown>) => void
    const pending = new Promise<Record<string, unknown>>((resolve) => { resolveResync = resolve })
    const { fake, pane } = await mount({}, paneHandlers({}, {
      'quirky.terminal/resync': () => pending
    }))
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(1)
    await pane.unmount()
    mounted = null
    resolveResync({ streamId: 102, replay: '', live: true })
    await drainClock()

    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params.streamId)).toContain(102)
    expect(fake.streams.has(102)).toBe(false)
  })
  test('detaches the original stream if an in-flight resync is rejected after disposal', async () => {
    let rejectResync!: (reason: unknown) => void
    const pending = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectResync = reject })
    const { fake, pane } = await mount({}, paneHandlers({}, {
      'quirky.terminal/resync': () => pending
    }))
    const clock = fakeClock()
    await fake.lag(101)
    await clock.advance(250)
    await flushWithClock(pane)
    expect(fake.callsTo('quirky.terminal/resync')).toHaveLength(1)

    await pane.unmount()
    mounted = null
    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params.streamId)).toContain(101)
    rejectResync(new RpcError(RpcErrorCode.Internal, 'host busy'))
    await drainClock()

    expect(fake.callsTo('quirky.terminal/detach').filter((call) => call.params.streamId === 101)).toHaveLength(1)
  })
})

describe('Kitty terminal reset', () => {
  test('ESC c resets kitty flags and returns false for xterm RIS handling', () => {
    const csi: ((params: (number | number[])[]) => boolean)[] = []
    let esc: (() => boolean) | undefined
    let escId: { intermediates?: string; final: string } | undefined
    let disposals = 0
    const parser: Parameters<typeof trackKittyFlags>[0] = {
      registerCsiHandler: (_id, callback) => {
        csi.push(callback)
        return { dispose: () => { disposals += 1 } }
      },
      registerEscHandler: (id, callback) => {
        escId = id
        esc = callback
        return { dispose: () => { disposals += 1 } }
      }
    }
    const tracked = trackKittyFlags(parser)
    csi[0]!([5])
    expect(tracked.kitty.flags).toBe(5)
    expect(escId).toEqual({ final: 'c' })
    expect(esc!()).toBe(false)
    expect(tracked.kitty.flags).toBe(0)
    tracked.dispose()
    expect(disposals).toBe(4)

    const legacy = trackKittyFlags({ registerCsiHandler: () => ({ dispose: () => {} }) })
    expect(legacy.kitty.flags).toBe(0)
    legacy.dispose()
  })
})

describe('resize', () => {
  test('sends the new size when cols or rows change, not otherwise', async () => {
    const { fake, pane } = await mount()
    await act(async () => pane.term().resize(100, 30))
    expect(fake.callsTo('quirky.terminal/resize').at(-1)!.params).toEqual({ session: 's1', cols: 100, rows: 30 })
    const before = fake.callsTo('quirky.terminal/resize').length
    await act(async () => pane.term().resize(100, 30))
    expect(fake.callsTo('quirky.terminal/resize')).toHaveLength(before)
  })

  test('the attached size counts as sent', async () => {
    const { fake } = await mount()
    expect(fake.callsTo('quirky.terminal/resize')).toEqual([])
  })

  test('while dragging nothing is sent, and the final size goes once when the drag ends', async () => {
    const { fake, pane } = await mount({ dragging: true })
    await act(async () => pane.term().resize(90, 20))
    await act(async () => pane.term().resize(70, 18))
    await act(async () => pane.term().resize(60, 16))
    expect(fake.callsTo('quirky.terminal/resize')).toEqual([])
    await pane.rerender({ dragging: false })
    expect(fake.callsTo('quirky.terminal/resize').map((call) => call.params)).toEqual([{ session: 's1', cols: 60, rows: 16 }])
    await pane.rerender({ dragging: true })
    await pane.rerender({ dragging: false })
    expect(fake.callsTo('quirky.terminal/resize')).toHaveLength(1)
  })

  test('reports its size', async () => {
    const { pane } = await mount()
    await act(async () => pane.term().resize(100, 30))
    expect(pane.lastReport()).toMatchObject({ cols: 100, rows: 30, fontSize: 14, search: null })
  })
})

describe('settings apply live', () => {
  test('SC-64: font, cursor, scrollback and reading options change without remounting', async () => {
    const { fake, pane } = await mount()
    const term = pane.term()
    await pane.rerender({
      settings: settings({
        'font-size': 16,
        'font-family': 'Menlo',
        'font-weight': 400,
        'font-weight-bold': 800,
        'line-height': 1.2,
        'cursor-style': 'bar',
        'cursor-blink': false,
        scrollback: 3000,
        'word-separators': ' /',
        'scroll-sensitivity': 2,
        'fast-scroll-sensitivity': 7,
        'minimum-contrast': 4.5,
        'option-as-alt': 'both'
      })
    })
    expect(terminals).toHaveLength(1)
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(1)
    expect(term.options).toMatchObject({
      fontSize: 16,
      fontWeight: 400,
      fontWeightBold: 800,
      lineHeight: 1.2,
      cursorStyle: 'bar',
      cursorBlink: false,
      scrollback: 3000,
      wordSeparator: ' /',
      scrollSensitivity: 2,
      fastScrollSensitivity: 7,
      minimumContrastRatio: 4.5,
      macOptionIsMeta: true
    })
    expect(term.options.fontFamily).toStartWith('Menlo')
    expect(pane.lastReport().fontSize).toBe(16)
  })

  test('macOptionIsMeta is on only for both, and click-forces-selection is always on', async () => {
    const { pane } = await mount()
    expect(pane.term().options.macOptionIsMeta).toBe(false)
    expect(pane.term().options.macOptionClickForcesSelection).toBe(true)
    await pane.rerender({ settings: settings({ 'option-as-alt': 'left' }) })
    expect(pane.term().options.macOptionIsMeta).toBe(false)
  })

  test('inactive opacity applies when the pane is not active', async () => {
    const { pane } = await mount({ settings: settings({ 'inactive-pane-opacity': 0.5 }) })
    const host = pane.element.querySelector('[data-terminal-pane]') as HTMLElement
    expect(host.style.opacity).toBe('1')
    await pane.rerender({ active: false })
    expect(host.style.opacity).toBe('0.5')
  })

  test('padding and background opacity apply to the pane surface', async () => {
    const background = '#123456'
    const themeSource = document.createElement('div')
    themeSource.style.setProperty('--terminal-background', background)
    document.body.appendChild(themeSource)
    const { pane } = await mount({
      themeSource,
      settings: settings({ 'padding-x': 10, 'padding-y': 6, 'background-opacity': 0.5 })
    })
    const host = pane.element.querySelector('[data-terminal-pane]') as HTMLElement
    const screen = host.querySelector('.terminal-pane-screen') as HTMLElement
    expect(screen.style.left).toBe('10px')
    expect(screen.style.top).toBe('6px')
    expect(host.style.background).toBe('rgba(18, 52, 86, 0.5)')
    expect(pane.term().options.allowTransparency).toBe(true)
    await pane.rerender({ settings: settings({ 'padding-x': 0, 'background-opacity': 1 }) })
    expect(screen.style.left).toBe('0px')
    expect(host.style.background).toBe(background)
  })

  test('the pane follows the complete app palette in place and cleans up its root observer', async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    const source = document.createElement('div')
    source.style.setProperty('--terminal-background', '#101010')
    document.body.appendChild(source)
    const { fake, pane } = await mount({ themeSource: source })
    const terminal = pane.term()

    expectGraphitePalette(terminal.options.theme, 'light', { background: '#101010' })
    await fake.push(101, 'retained output')
    await pane.flush()

    document.documentElement.setAttribute('data-theme', 'dark')
    await settle()
    expectGraphitePalette(terminal.options.theme, 'dark', { background: '#101010' })
    expect(terminals).toHaveLength(1)
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('retained output')

    source.style.setProperty('--terminal-background', '#202020')
    await settle()
    expectGraphitePalette(terminal.options.theme, 'dark', { background: '#202020' })
    const themeBeforeUnmount = terminal.options.theme

    await pane.unmount()
    mounted = null
    document.documentElement.setAttribute('data-theme', 'light')
    await settle()
    expect(terminal.options.theme).toEqual(themeBeforeUnmount)
  })

  test('unicode 11 widths are active before the first write', async () => {
    const { pane } = await mount()
    expect(pane.term().unicode.activeVersion).toBe('11')
  })

  test('JIS yen input types a backslash only when the setting is on', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'jis-yen-backslash': true }) })
    await act(async () => pane.term().input('¥'))
    expect(fake.callsTo('quirky.terminal/write').at(-1)!.params.data).toBe('\\')
    await pane.rerender({ settings: settings({ 'jis-yen-backslash': false }) })
    await act(async () => pane.term().input('¥'))
    expect(fake.callsTo('quirky.terminal/write').at(-1)!.params.data).toBe('¥')
  })
})

describe('fitting', () => {
  test('resize notifications within one frame fit once, and a hidden pane is not fitted', async () => {
    const callbacks: (() => void)[] = []
    const NativeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver
    const { FitAddon } = await import('@xterm/addon-fit')
    const fit = FitAddon.prototype.fit
    let fits = 0
    FitAddon.prototype.fit = function () {
      fits += 1
    }
    try {
      const { pane } = await mount()
      const screen = pane.element.querySelector('[data-terminal-pane]')!.firstElementChild as HTMLElement
      Object.defineProperty(screen, 'clientWidth', { configurable: true, value: 800 })
      Object.defineProperty(screen, 'clientHeight', { configurable: true, value: 400 })
      const before = fits
      callbacks.forEach((callback) => {
        callback()
        callback()
        callback()
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fits - before).toBe(1)
      Object.defineProperty(screen, 'clientWidth', { configurable: true, value: 0 })
      callbacks.forEach((callback) => callback())
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fits - before).toBe(1)
    } finally {
      FitAddon.prototype.fit = fit
      globalThis.ResizeObserver = NativeObserver
    }
  })
})

describe('focus follows mouse', () => {
  test('entering the pane focuses it only when the setting is on', async () => {
    const { pane } = await mount({ active: false })
    const host = pane.element.querySelector('[data-terminal-pane]')!
    await act(async () => void host.dispatchEvent(new MouseEvent('mouseenter')))
    expect(document.activeElement).not.toBe(pane.textarea())
    await pane.rerender({ settings: settings({ 'focus-follows-mouse': true }) })
    await act(async () => void host.dispatchEvent(new MouseEvent('mouseenter')))
    expect(document.activeElement).toBe(pane.textarea())
  })
})

describe('focus context', () => {
  test('terminalFocus follows the xterm textarea only', async () => {
    const { fake, pane } = await mount({ active: false })
    expect(fake.contextValue('terminalFocus')).toBeUndefined()
    await act(async () => void pane.textarea().dispatchEvent(new FocusEvent('focus')))
    expect(fake.contextValue('terminalFocus')).toBe(true)
    await act(async () => void pane.textarea().dispatchEvent(new FocusEvent('blur')))
    expect(fake.contextValue('terminalFocus')).toBe(false)
  })

  test('focus on the search box is not terminal focus', async () => {
    const { fake, pane } = await mount()
    await act(async () => void pane.textarea().dispatchEvent(new FocusEvent('focus')))
    await act(async () => pane.handle().search())
    const input = pane.element.querySelector('input')!
    await act(async () => void pane.textarea().dispatchEvent(new FocusEvent('blur')))
    await act(async () => void input.dispatchEvent(new FocusEvent('focus')))
    expect(fake.contextValue('terminalFocus')).toBe(false)
  })

  test('unmounting a focused pane clears the key unless another pane took it over', async () => {
    const { fake, pane } = await mount()
    await act(async () => void pane.textarea().dispatchEvent(new FocusEvent('focus')))
    await pane.unmount()
    mounted = null
    expect(fake.contextValue('terminalFocus')).toBe(false)
  })

  test('mousedown and focus tell the parent the pane was chosen', async () => {
    let focused = 0
    const { pane } = await mount({ active: false, onFocus: () => void (focused += 1) })
    await act(async () => void pane.element.querySelector('[data-terminal-pane]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    await act(async () => void pane.textarea().dispatchEvent(new FocusEvent('focus')))
    expect(focused).toBe(2)
  })

  test('becoming active gives the terminal keyboard focus', async () => {
    const { pane } = await mount({ active: false })
    await pane.rerender({ active: true })
    expect(document.activeElement).toBe(pane.textarea())
  })
})
