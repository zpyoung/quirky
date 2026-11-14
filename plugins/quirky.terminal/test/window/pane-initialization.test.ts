import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Terminal } from '@xterm/xterm'
import { loadPane, mountPane, paneHandlers, settings, settle, startRecording, stopRecording, terminals, unloadPane, type MountedPane } from './pane-support'
import { fakeContext } from '../ui-fake'

let mounted: MountedPane | null = null
let restoreInstrumentation: (() => void) | null = null
let restoreFrames: (() => void) | null = null
let restoreMedia: (() => void) | null = null

beforeAll(loadPane)
afterAll(unloadPane)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  restoreInstrumentation?.()
  restoreInstrumentation = null
  restoreFrames?.()
  restoreFrames = null
  restoreMedia?.()
  restoreMedia = null
  stopRecording()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

async function instrumentRuntime() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  let fits = 0
  let themeAssignments = 0
  const open = Terminal.prototype.open
  const fit = FitAddon.prototype.fit
  const optionsDescriptor = Object.getOwnPropertyDescriptor(Terminal.prototype, 'options')!
  const opened = new WeakSet<Terminal>()
  Terminal.prototype.open = function (this: Terminal, element: HTMLElement) {
    element.style.width = '960px'
    element.style.height = '480px'
    Object.defineProperties(element, {
      clientWidth: { configurable: true, value: 960 },
      clientHeight: { configurable: true, value: 480 }
    })
    const result = open.call(this, element)
    if (this.element) this.element.style.padding = '0px'
    opened.add(this)
    return result
  }
  Object.defineProperty(Terminal.prototype, 'options', {
    ...optionsDescriptor,
    get(this: Terminal) {
      const options = optionsDescriptor.get!.call(this)
      if (!opened.has(this)) return options
      return new Proxy(options, {
        set(target, key, value) {
          if (key === 'theme') themeAssignments += 1
          return Reflect.set(target, key, value, target)
        }
      })
    }
  })
  FitAddon.prototype.fit = function () {
    fits += 1
    return fit.call(this)
  }
  return {
    counts: () => ({ fits, themeAssignments }),
    restore: () => {
      Terminal.prototype.open = open
      Object.defineProperty(Terminal.prototype, 'options', optionsDescriptor)
      FitAddon.prototype.fit = fit
    }
  }
}

function captureFrames() {
  const globalRequest = globalThis.requestAnimationFrame
  const globalCancel = globalThis.cancelAnimationFrame
  const windowRequest = window.requestAnimationFrame
  const windowCancel = window.cancelAnimationFrame
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  }
  const cancelFrame = (id: number) => void callbacks.delete(id)
  globalThis.requestAnimationFrame = requestFrame
  globalThis.cancelAnimationFrame = cancelFrame
  window.requestAnimationFrame = requestFrame
  window.cancelAnimationFrame = cancelFrame
  return {
    drain: async () => {
      for (let turn = 0; callbacks.size && turn < 50; turn += 1) {
        const batch = [...callbacks.values()]
        callbacks.clear()
        await act(async () => {
          for (const callback of batch) callback(performance.now())
          await Promise.resolve()
        })
      }
      if (callbacks.size) throw new Error('animation frames did not drain')
    },
    restore: () => {
      globalThis.requestAnimationFrame = globalRequest
      globalThis.cancelAnimationFrame = globalCancel
      window.requestAnimationFrame = windowRequest
      window.cancelAnimationFrame = windowCancel
    }
  }
}

function captureSystemTheme() {
  let light = true
  const media = new EventTarget()
  Object.defineProperty(media, 'matches', { get: () => light })
  Object.defineProperty(media, 'media', { value: '(prefers-color-scheme: light)' })
  Object.assign(media, {
    addListener: (listener: EventListenerOrEventListenerObject) => media.addEventListener('change', listener),
    removeListener: (listener: EventListenerOrEventListenerObject) => media.removeEventListener('change', listener)
  })
  const previous = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => media as unknown as MediaQueryList
  })
  return {
    setLight: (value: boolean) => {
      light = value
      media.dispatchEvent(new Event('change'))
    },
    restore: () => {
      if (previous) Object.defineProperty(window, 'matchMedia', previous)
      else delete (window as Partial<Window>).matchMedia
    }
  }
}

describe('pane initialization', () => {
  test('fits once and skips redundant theme work while preserving live geometry and color updates', async () => {
    const frames = captureFrames()
    restoreFrames = frames.restore
    const instrumentation = await instrumentRuntime()
    restoreInstrumentation = instrumentation.restore
    const systemTheme = captureSystemTheme()
    restoreMedia = systemTheme.restore
    document.documentElement.setAttribute('data-theme', 'light')

    const source = document.createElement('div')
    source.style.setProperty('--terminal-background', '#102030')
    document.body.appendChild(source)
    const initial = settings({
      'gpu-acceleration': 'off',
      'inline-images': false,
      ligatures: 'off',
      'theme-mode': 'inherit'
    })
    const fake = fakeContext(paneHandlers())
    mounted = await mountPane(fake, { themeSource: source, settings: initial })
    const terminal = mounted.term()

    await frames.drain()
    const initialCounts = instrumentation.counts()
    expect(initialCounts).toEqual({ fits: 1, themeAssignments: 0 })
    expect(terminal.options.fontSize).toBe(initial['font-size'])
    expect(terminal.options.theme?.background).toBe('#102030')
    expect(terminal.cols).toBeGreaterThan(80)
    expect(terminal.rows).toBeGreaterThan(24)
    expect(fake.callsTo('quirky.terminal/attach')[0]!.params).toMatchObject({ cols: terminal.cols, rows: terminal.rows })

    await mounted.rerender()
    await frames.drain()
    expect(instrumentation.counts()).toEqual(initialCounts)

    const resizedSettings = { ...initial, 'font-size': 18, 'padding-x': 10, 'padding-y': 8 }
    await mounted.rerender({ settings: resizedSettings })
    await frames.drain()
    expect(instrumentation.counts().fits).toBeGreaterThan(initialCounts.fits)
    expect(terminals).toHaveLength(1)
    expect(mounted.term()).toBe(terminal)

    await mounted.rerender({ settings: { ...resizedSettings, 'background-opacity': 0.5 } })
    expect((mounted.element.querySelector('[data-terminal-pane]') as HTMLElement).style.background).toBe('rgba(16, 32, 48, 0.5)')

    source.style.setProperty('--terminal-background', '#405060')
    await settle()
    expect((mounted.element.querySelector('[data-terminal-pane]') as HTMLElement).style.background).toBe('rgba(64, 80, 96, 0.5)')
    const replacementSource = document.createElement('div')
    replacementSource.style.setProperty('--terminal-background', '#708090')
    document.body.appendChild(replacementSource)
    await mounted.rerender({ themeSource: replacementSource })
    await settle()
    expect((mounted.element.querySelector('[data-terminal-pane]') as HTMLElement).style.background).toBe('rgba(112, 128, 144, 0.5)')
    expect(terminals).toHaveLength(1)
    expect(mounted.term()).toBe(terminal)


    await mounted.rerender({ settings: { ...resizedSettings, 'background-opacity': 0.5, 'theme-mode': 'system' } })
    const lightForeground = terminal.options.theme?.foreground
    systemTheme.setLight(false)
    await settle()
    expect(terminal.options.theme?.foreground).not.toBe(lightForeground)
    expect(terminals).toHaveLength(1)
    expect(mounted.term()).toBe(terminal)
  })
})
