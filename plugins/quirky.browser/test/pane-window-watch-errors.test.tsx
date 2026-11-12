import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { PaneState, PaneTab } from '../src/pane-contract'
import { BrowserPaneWindow } from '../src/window/BrowserPaneWindow'

let container: HTMLElement
let root: Root | null = null
let createRoot: typeof CreateReactRoot
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let paneState: PaneState
const calls: { method: string; params?: Record<string, unknown> }[] = []

const PREFERENCES_STATE = {
  profiles: [{ profile: { id: 'default', label: 'Default', scope: 'default' as const }, active: true }],
  identity: { selected: 'clean' as const, active: 'clean' as const, restartRequired: false, nativeSupported: false as const },
  imports: { available: true as const, destination: 'managed-chrome' as const, nativeSupported: false as const, reason: 'Cookie imports are stored in managed Chrome, not Native.' },
  localhostLabels: { available: true as const, enabled: false, reason: 'Loopback links get worktree labels.', labels: [] }
}

beforeAll(async () => {
  GlobalRegistrator.register()
  // ReactDOM detects input-event support at module load, so establish the test DOM before importing it.
  ;({ createRoot } = await import('react-dom/client'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  listeners = []
  calls.length = 0
  paneState = stateOf(pane('pane-1', ''))
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

function pane(id: string, findText: string): PaneTab {
  return {
    id,
    worktreeId: 'worktree-1',
    profileId: 'default',
    partition: 'persist:quirky-browser-default',
    mode: 'native',
    page: null,
    url: `https://example.test/${id}`,
    title: 'Example',
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    zoom: 0,
    viewport: 'default',
    command: null,
    find: { text: findText, current: 0, total: 0 },
    prompts: [],
    downloads: []
  }
}

function stateOf(...tabs: PaneTab[]): PaneState {
  return { tabs, active: tabs[0]?.id ?? null, history: [] }
}

function makeContext(): UiPluginContext {
  return {
    nativeBrowser: {
      available: false,
      clearPartitionAvailable: false,
      previewAvailable: false,
      mount: () => { throw new Error('Native views are unavailable in this DOM fixture.') },
      clearPartition: async () => { throw new Error('Native storage is unavailable in this DOM fixture.') },
      defaultUserAgent: async () => null
    },
    pluginId: 'quirky.browser',
    log: () => {},
    nativeDropPaths: async () => null,
    readClipboardText: async () => '',
    provide: () => {},
    call: async (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) })
      if (method === 'quirky.browser/paneState') return paneState
      if (method === 'quirky.browser/preferencesState') return PREFERENCES_STATE
      if (method === 'quirky.browser/paneSuggestions') return { suggestions: [] }
      if (method === 'quirky.browser/paneWatch') return { watchId: 'watch-1' }
      return undefined
    },
    subscribe: (listener) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((current) => current !== listener) }
    },
    getSetting: (name) => name === 'setting:quirky.browser/browserImportHintHidden' ? true : undefined,
    executeCommand: async () => {},
    createCommandDrag: () => 'drag-token',
    consumeCommandDrag: () => null,
    cancelCommandDrag: () => {},
    openView: () => {},
    closeView: () => {},
    togglePanel: () => {},
    setPalette: () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => false,
    toast: () => {},
    setPanelBadge: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }
}

async function settleUI(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function mount(context: UiPluginContext, input: unknown): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={context} input={input} />)
    await settleUI()
  })
}

async function render(context: UiPluginContext, input: unknown): Promise<void> {
  await act(async () => {
    root?.render(<BrowserPaneWindow context={context} input={input} />)
    await settleUI()
  })
}


function watchPane(overrides: Partial<PaneTab>): PaneTab {
  return { ...pane('pane-1', ''), mode: 'watch', page: 'page-1', url: 'http://127.0.0.1:6000/', ...overrides }
}

async function showFrame(): Promise<void> {
  await act(async () => {
    const event = {
      type: 'quirky.browser/paneFrame',
      data: { pane: 'pane-1', watchId: 'watch-1', sequence: 1, data: 'AAAA', width: 800, height: 600 }
    } as QuirkyEvent
    for (const listener of [...listeners]) await listener(event)
    await settleUI()
  })
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

test('a navigation error in a live Watch is shown once, in plain words, without a Watch ended card', async () => {
  const context = makeContext()
  const failing = watchPane({ error: 'net::ERR_UNSAFE_PORT', watchEnded: false })
  paneState = stateOf(failing)
  await mount(context, { pane: failing.id })
  await showFrame()
  expect(container.querySelector('img.qbp-watch-image')).not.toBeNull()
  const text = container.textContent ?? ''
  expect(text).not.toContain('Watch ended')
  expect(text).not.toContain('Retry this Watch')
  expect(text).toContain('port')
  expect(occurrences(text, 'ERR_UNSAFE_PORT')).toBe(1)
})

test('an ended Watch says so and states the reason once', async () => {
  const context = makeContext()
  const ended = watchPane({ error: 'Watch stopped because its frame was not acknowledged.', watchEnded: true })
  paneState = stateOf(ended)
  await mount(context, { pane: ended.id })
  await showFrame()
  expect(container.querySelector('img.qbp-watch-image')).not.toBeNull()
  const text = container.textContent ?? ''
  expect(text).toContain('Watch ended')
  expect(occurrences(text, 'frame was not acknowledged')).toBe(1)
})
