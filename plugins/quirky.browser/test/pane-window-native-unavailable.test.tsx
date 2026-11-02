import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { PaneState } from '../src/pane-contract'
import { BrowserPaneWindow } from '../src/window/BrowserPaneWindow'

let createRoot: typeof CreateReactRoot
let root: Root | null = null
let container: HTMLElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ createRoot } = await import('react-dom/client'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

const paneState: PaneState = {
  active: 'pane-1',
  history: [],
  tabs: [{
    id: 'pane-1', worktreeId: 'worktree-1', profileId: 'default', partition: 'persist:quirky-browser-default', mode: 'native', page: null,
    url: 'https://example.test/', title: 'Example', loading: false, error: null, canGoBack: false, canGoForward: false, zoom: 0,
    viewport: 'default', command: null, find: { text: '', current: 0, total: 0 }, prompts: [], downloads: []
  }]
}

const context = {
  nativeBrowser: { available: false, clearPartitionAvailable: false, previewAvailable: false },
  pluginId: 'quirky.browser',
  log: () => {},
  provide: () => {},
  call: async (method: string) => {
    if (method === 'quirky.browser/paneState') return paneState
    if (method === 'quirky.browser/preferencesState') return { profiles: [], imports: { available: false }, localhostLabels: { available: false } }
    if (method === 'quirky.browser/paneSuggestions') return { suggestions: [] }
    return undefined
  },
  subscribe: () => () => {},
  getSetting: () => true,
  getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
  onLayout: () => () => {},
  onStream: () => () => {},
  onConnection: () => () => {},
  toast: () => {},
  setContext: () => {},
  setPanelBadge: () => {}
} as unknown as UiPluginContext

test('the Native-unavailable card stacks its content and explains once', async () => {
  container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={context} input={{ pane: 'pane-1' }} />)
    for (let index = 0; index < 5; index++) await Promise.resolve()
  })

  const heading = [...container.querySelectorAll('*')].find((node) => node.children.length === 0 && node.textContent === 'Native browsing is unavailable here')
  const card = heading?.closest<HTMLElement>('.qbp-card')
  if (!card) throw new Error('the Native-unavailable card was not rendered')
  expect(card.style.flexDirection).toBe('column')
  expect(card.querySelectorAll('p').length).toBe(1)
  expect(card.textContent).toMatch(/desktop app/i)
  expect(card.textContent).toMatch(/Watch/)
})

test('a failed Watch start from the Native-unavailable card shows its error once', async () => {
  container = document.createElement('div')
  document.body.append(container)
  const failing = {
    ...context,
    call: async (method: string, params?: unknown) => {
      if (method === 'quirky.browser/paneWatch') throw new Error('the browser stopped responding; try again')
      return (context.call as (method: string, params?: unknown) => Promise<unknown>)(method, params)
    }
  } as unknown as UiPluginContext
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={failing} input={{ pane: 'pane-1' }} />)
    for (let index = 0; index < 5; index++) await Promise.resolve()
  })
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Watch this address in an owned page')
  if (!button) throw new Error('the Watch button was not rendered')
  await act(async () => {
    button.click()
    for (let index = 0; index < 10; index++) await Promise.resolve()
  })
  const alerts = [...container.querySelectorAll('[role="alert"]')].filter((node) => node.textContent?.includes('stopped responding'))
  expect(alerts).toHaveLength(1)
})
