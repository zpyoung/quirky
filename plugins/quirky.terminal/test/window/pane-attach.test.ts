import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { bytesToBase64, GRAPHITE_TERMINAL_PALETTES, TERMINAL_ANSI_KEYS, type TerminalAppearanceMode, type TerminalPalette } from '@quirky/protocol'
import type { ITheme } from '@xterm/xterm'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, settle, startRecording, stopRecording, terminals, unloadPane, type MountedPane } from './pane-support'

let mounted: MountedPane | null = null
const text = (value: string) => new TextEncoder().encode(value)

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

  test('replayed queries never answer into the live shell', async () => {
    const { fake, pane } = await mount({}, paneHandlers({ replay: bytesToBase64(text('\x1b[6n')) }))
    await pane.flush()
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
    await act(async () => pane.term().input('x'))
    expect(fake.callsTo('quirky.terminal/write')).toHaveLength(1)
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
    const { pane } = await mount({ settings: settings({ 'padding-x': 10, 'padding-y': 6, 'background-opacity': 0.5 }) })
    const host = pane.element.querySelector('[data-terminal-pane]') as HTMLElement
    const screen = host.firstElementChild as HTMLElement
    expect(screen.style.left).toBe('10px')
    expect(screen.style.top).toBe('6px')
    expect(host.style.background).toBe('rgba(22, 24, 29, 0.5)')
    expect(pane.term().options.allowTransparency).toBe(true)
    await pane.rerender({ settings: settings({ 'padding-x': 0, 'background-opacity': 1 }) })
    expect(screen.style.left).toBe('0px')
    expect(host.style.background).toBe('#16181d')
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
