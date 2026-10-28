import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MobileTerminalState, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { Root } from 'react-dom/client'

let act: typeof import('react').act
let createElement: typeof import('react').createElement
let createRoot: typeof import('react-dom/client').createRoot
let MobileDriverOverlay: typeof import('../src/window/pane/MobileDriverOverlay').MobileDriverOverlay
let root: Root | null = null
let container: HTMLDivElement
let state: MobileTerminalState[]
let calls: { method: string; params: Record<string, unknown> }[]
let listeners: Set<(event: QuirkyEvent) => void | Promise<void>>

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Load ReactDOM and the pane overlay after Happy DOM installs its browser globals.
  const [react, client, module] = await Promise.all([import('react'), import('react-dom/client'), import('../src/window/pane/MobileDriverOverlay')])
  act = react.act as typeof act
  createElement = react.createElement
  createRoot = client.createRoot
  MobileDriverOverlay = module.MobileDriverOverlay
})

beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  calls = []
  listeners = new Set()
  state = [
    {
      session: 'session-1',
      driver: { deviceId: 'phone-a', connectionId: 14, name: 'Phone A' },
      phoneFit: false,
      cols: 50,
      rows: 20,
      desktopCols: 120,
      desktopRows: 35
    }
  ]
  const context = {
    pluginId: 'quirky.terminal',
    log() {},
    provide() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.terminal/mobileState') return { terminals: state.filter((item) => params.session === undefined || item.session === params.session) }
      if (method === 'quirky.terminal/takeBack' || method === 'quirky.terminal/restoreFit') {
        state = params.session === undefined ? [] : state.filter((item) => item.session !== params.session)
        for (const listener of listeners) await listener({ type: 'quirky.terminal/mobileChanged', data: { terminals: state } })
        return { ok: true }
      }
      throw new Error(`unexpected method ${method}`)
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSetting() {},
    async executeCommand() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => false,
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as UiPluginContext
  root = createRoot(container)
  await act(async () => root!.render(createElement(MobileDriverOverlay, { context, sessionId: 'session-1' })))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('shows active phone control and minimizes to a live Take back chip', async () => {
  expect(container.textContent).toContain('Your phone is in control')
  expect(container.textContent).toContain('Desktop typing is paused. Output keeps streaming.')
  const minimize = container.querySelector<HTMLButtonElement>('[aria-label="Minimize phone driving controls"]')
  await act(async () => minimize?.click())
  expect(container.textContent).toContain('Phone driving')
  expect(container.querySelector('[aria-label="Restore phone driving controls"]')).not.toBeNull()
  const takeBack = container.querySelector<HTMLButtonElement>('[aria-label="Take back this terminal"]')
  await act(async () => takeBack?.click())
  expect(calls).toContainEqual({ method: 'quirky.terminal/takeBack', params: { session: 'session-1' } })
  expect(container.textContent).not.toContain('Phone driving')
})

test('shows restore controls only for server-reported phone-fit state', async () => {
  state = [{ ...state[0]!, driver: null, phoneFit: true }]
  await act(async () => {
    for (const listener of listeners) await listener({ type: 'quirky.terminal/mobileChanged', data: { terminals: state } })
  })
  expect(container.textContent).toContain('Still sized for your phone')
  expect(container.textContent).toContain('Your phone session ended. Restore to fit this window.')
  const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Restore')
  await act(async () => restore?.click())
  expect(calls).toContainEqual({ method: 'quirky.terminal/restoreFit', params: { session: 'session-1' } })
  expect(container.textContent).not.toContain('Still sized for your phone')
})
test('all-terminal buttons route to the daemon for take-back and restore-fit', async () => {
  const takeBackAll = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Take back all')
  await act(async () => takeBackAll?.click())
  expect(calls).toContainEqual({ method: 'quirky.terminal/takeBack', params: {} })

  state = [{ ...state[0]!, driver: null, phoneFit: true }]
  await act(async () => {
    for (const listener of listeners) await listener({ type: 'quirky.terminal/mobileChanged', data: { terminals: state } })
  })
  const restoreAll = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Restore all')
  await act(async () => restoreAll?.click())
  expect(calls).toContainEqual({ method: 'quirky.terminal/restoreFit', params: {} })
})
