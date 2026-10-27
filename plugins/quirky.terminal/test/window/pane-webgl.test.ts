import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { ITerminalAddon, Terminal } from '@xterm/xterm'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'

let panes: MountedPane[]
let log: string[]
let created: FakeWebgl[]
let budget: typeof import('../../src/window/pane/webgl').webglBudget

class FakeWebgl implements ITerminalAddon {
  private listeners: (() => void)[] = []
  failOnActivate = false
  activate(terminal: Terminal): void {
    if (this.failOnActivate) throw new Error('WebGL2 not supported')
    const canvas = document.createElement('canvas')
    ;(canvas as { getContext: unknown }).getContext = (type: string) =>
      type === 'webgl2' ? { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => void log.push('loseContext') } : null) } : null
    terminal.element!.appendChild(canvas)
  }
  dispose(): void {
    log.push('dispose')
  }
  onContextLoss(listener: () => void) {
    this.listeners.push(listener)
    return { dispose() {} }
  }
  lose() {
    this.listeners.forEach((listener) => listener())
  }
}

beforeAll(async () => {
  await loadPane()
  ;({ webglBudget: budget } = await import('../../src/window/pane/webgl'))
})
afterAll(unloadPane)
beforeEach(() => {
  startRecording()
  panes = []
  log = []
  created = []
})
afterEach(async () => {
  for (const pane of panes) await pane.unmount()
  expect(budget.count).toBe(0)
  stopRecording()
  document.body.innerHTML = ''
})

const factory = (configure?: (addon: FakeWebgl) => void) => () => {
  const addon = new FakeWebgl()
  configure?.(addon)
  created.push(addon)
  return addon
}

async function mount(over = {}) {
  const pane = await mountPane(fakeContext(paneHandlers()), { createWebgl: factory(), ...over })
  panes.push(pane)
  return pane
}

describe('SC-75: WebGL is capped at 12 panes', () => {
  test('the first twelve panes get a context and the rest stay on the DOM renderer', async () => {
    const mountedPanes: MountedPane[] = []
    for (let index = 0; index < 14; index += 1) mountedPanes.push(await mount({ sessionId: `s${index}` }))
    expect(mountedPanes.map((pane) => pane.lastReport().webgl)).toEqual([...Array(12).fill(true), false, false])
    expect(budget.count).toBe(12)
  })

  test('unmounting loses the context before disposing the addon, then frees the slot for another pane', async () => {
    const mountedPanes: MountedPane[] = []
    for (let index = 0; index < 12; index += 1) mountedPanes.push(await mount({ sessionId: `s${index}` }))
    const extra = await mount({ sessionId: 'extra' })
    expect(extra.lastReport().webgl).toBe(false)
    log.length = 0
    await mountedPanes[0]!.unmount()
    panes.splice(panes.indexOf(mountedPanes[0]!), 1)
    expect(log).toEqual(['loseContext', 'dispose'])
    expect(budget.count).toBe(11)
    const next = await mount({ sessionId: 'next' })
    expect(next.lastReport().webgl).toBe(true)
    expect(budget.count).toBe(12)
  })

  test('GPU acceleration off keeps a pane on the DOM renderer and turning it on later takes a slot', async () => {
    const pane = await mount({ settings: settings({ 'gpu-acceleration': 'off' }) })
    expect(pane.lastReport().webgl).toBe(false)
    expect(created).toHaveLength(0)
    await pane.rerender({ settings: settings({ 'gpu-acceleration': 'on' }) })
    expect(pane.lastReport().webgl).toBe(true)
    expect(budget.count).toBe(1)
    await pane.rerender({ settings: settings({ 'gpu-acceleration': 'off' }) })
    expect(pane.lastReport().webgl).toBe(false)
    expect(budget.count).toBe(0)
    expect(log).toEqual(['loseContext', 'dispose'])
  })

  test('an addon that cannot start leaves the pane working on the DOM and gives its slot back', async () => {
    const pane = await mount({ createWebgl: factory((addon) => void (addon.failOnActivate = true)) })
    expect(pane.lastReport().webgl).toBe(false)
    expect(budget.count).toBe(0)
  })

  test('without a GPU the real addon fails to start and the pane still works', async () => {
    const pane = await mountPane(fakeContext(paneHandlers()), { createWebgl: undefined })
    panes.push(pane)
    expect(pane.lastReport().webgl).toBe(false)
    expect(budget.count).toBe(0)
  })

  test('two context losses are recovered, the third within 60 s keeps the pane on the DOM', async () => {
    const pane = await mount()
    expect(created).toHaveLength(1)
    await act(async () => created[0]!.lose())
    expect(created).toHaveLength(2)
    expect(pane.lastReport().webgl).toBe(true)
    await act(async () => created[1]!.lose())
    expect(created).toHaveLength(3)
    expect(pane.lastReport().webgl).toBe(true)
    await act(async () => created[2]!.lose())
    expect(created).toHaveLength(3)
    expect(pane.lastReport().webgl).toBe(false)
    expect(budget.count).toBe(0)
  })
})
