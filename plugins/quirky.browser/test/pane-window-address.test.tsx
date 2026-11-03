import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { NativeBrowserOptions, NativeBrowserRequest, NativeBrowserState, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { PaneState, PaneTab } from '../src/pane-contract'
import { BrowserPaneWindow } from '../src/window/BrowserPaneWindow'

let container: HTMLElement
let root: Root | null = null
let createRoot: typeof CreateReactRoot
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let paneState: PaneState
let mounted: NativeBrowserOptions | null
const calls: { method: string; params?: Record<string, unknown> }[] = []
const requests: NativeBrowserRequest[] = []

const PREFERENCES_STATE = {
  profiles: [{ profile: { id: 'default', label: 'Default', scope: 'default' as const }, active: true }],
  identity: { selected: 'clean' as const, active: 'clean' as const, restartRequired: false, nativeSupported: false as const },
  imports: { available: true as const, destination: 'managed-chrome' as const, nativeSupported: false as const, reason: 'Cookie imports are stored in managed Chrome, not Native.' },
  localhostLabels: { available: false as const, reason: 'A reachable worktree host mapping is not configured.' }
}
const SEARCH = { url: 'https://www.google.com/search?q=http%3A%2F%2F127.0.0.1%3A8765%2F', title: 'Search for http://127.0.0.1:8765/', kind: 'search' as const }
const SUGGESTIONS = [SEARCH, { url: 'https://example.test/other', title: 'Other', kind: 'history' as const }]

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
  requests.length = 0
  mounted = null
  paneState = stateOf(pane())
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

function pane(overrides: Partial<PaneTab> = {}): PaneTab {
  return {
    id: 'pane-1',
    worktreeId: 'worktree-1',
    profileId: 'default',
    partition: 'persist:quirky-browser-default',
    mode: 'native',
    page: null,
    url: 'https://example.test/page',
    title: 'Example',
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    zoom: 0,
    viewport: 'default',
    command: null,
    find: { text: '', current: 0, total: 0 },
    prompts: [],
    downloads: [],
    ...overrides
  }
}

function stateOf(...tabs: PaneTab[]): PaneState {
  return { tabs, active: tabs[0]?.id ?? null, history: [] }
}

function nativeState(overrides: Partial<NativeBrowserState> = {}): NativeBrowserState {
  return {
    id: 'pane-1', url: 'https://example.test/page', title: 'Example', loading: false, canGoBack: false, canGoForward: false,
    zoom: 0, error: null, findCurrent: 0, findTotal: 0, hardReloadAvailable: false, ...overrides
  }
}

function makeContext(): UiPluginContext {
  return {
    nativeBrowser: {
      available: false,
      clearPartitionAvailable: false,
      previewAvailable: false,
      mount: (_element, options) => {
        mounted = options
        return {
          request: async (request) => {
            requests.push(request)
            return nativeState({ hardReloadAvailable: true })
          },
          evaluate: async () => null,
          dispose: () => {}
        }
      },
      clearPartition: async () => { throw new Error('Native storage is unavailable in this DOM fixture.') },
      defaultUserAgent: async () => null
    },
    pluginId: 'quirky.browser',
    nativeDropPaths: async () => null,
    log: () => {},
    readClipboardText: async () => '',
    provide: () => {},
    call: async (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) })
      if (method === 'quirky.browser/paneState') return paneState
      if (method === 'quirky.browser/preferencesState') return PREFERENCES_STATE
      if (method === 'quirky.browser/identityGet') return { active: 'native' }
      if (method === 'quirky.browser/paneSuggestions') return { suggestions: SUGGESTIONS }
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
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

async function mountWindow(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={makeContext()} input={{ pane: 'pane-1' }} />)
    await settleUI()
  })
}

async function reportNative(state: NativeBrowserState): Promise<void> {
  await act(async () => {
    mounted?.onState(state)
    await settleUI()
  })
}

async function emitPaneChanged(next: PaneState): Promise<void> {
  paneState = next
  await act(async () => {
    const event = { type: 'quirky.browser/paneChanged', data: next } as QuirkyEvent
    for (const listener of [...listeners]) await listener(event)
    await settleUI()
  })
}


async function typeAddress(value: string): Promise<HTMLInputElement> {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Address and search"]')
  if (!input) throw new Error('address field not found')
  await act(async () => { input.focus(); await settleUI() })
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 250))
    await settleUI()
  })
  return input
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settleUI()
  })
}

function navigations() {
  return calls.filter((call) => call.method === 'quirky.browser/paneNavigate').map((call) => call.params?.input)
}

test('Enter on typed URL input opens it even though a search suggestion is listed', async () => {
  await mountWindow()
  const input = await typeAddress('http://127.0.0.1:8765/')
  await press(input, 'Enter')
  expect(navigations()).toEqual(['http://127.0.0.1:8765/'])
})

test('Enter after arrowing to a suggestion opens that suggestion', async () => {
  await mountWindow()
  const input = await typeAddress('http://127.0.0.1:8765/')
  await press(input, 'ArrowDown')
  await press(input, 'ArrowDown')
  await press(input, 'Enter')
  expect(navigations()).toEqual(['https://example.test/other'])
})

test('a Native pane without a native view never shows Stop loading', async () => {
  paneState = stateOf(pane({ loading: true }))
  await mountWindow()
  expect(container.querySelector('[aria-label="Stop loading"]')).toBeNull()
  expect(container.querySelector('[aria-label="Reload"]')).not.toBeNull()
})

function addressField(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Address and search"]')
  if (!input) throw new Error('address field not found')
  return input
}

test('a new tab leaves the address field empty so its placeholder shows', async () => {
  paneState = stateOf(pane({ url: 'about:blank', title: '' }))
  await mountWindow()
  expect(addressField().value).toBe('')
  await emitPaneChanged(stateOf(pane({ url: 'about:blank', title: '' })))
  expect(addressField().value).toBe('')
})

test('typed address text survives blur and pane updates until Escape reverts it', async () => {
  await mountWindow()
  const input = await typeAddress('example.org/draft')
  await act(async () => { input.blur(); await new Promise((resolve) => setTimeout(resolve, 150)); await settleUI() })
  expect(addressField().value).toBe('example.org/draft')
  await emitPaneChanged(stateOf(pane({ title: 'Example, retitled' })))
  expect(addressField().value).toBe('example.org/draft')
  await act(async () => { input.focus(); await settleUI() })
  await press(input, 'Escape')
  expect(addressField().value).toBe('https://example.test/page')
})

test('the Native New Tab card stacks its content', async () => {
  paneState = stateOf(pane({ url: 'about:blank', title: '' }))
  const context = makeContext()
  Object.assign(context.nativeBrowser, { available: true })
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={context} input={{ pane: 'pane-1' }} />)
    await settleUI()
  })
  const heading = [...container.querySelectorAll('*')].find((node) => node.children.length === 0 && node.textContent === 'New Tab')
  const card = heading?.closest<HTMLElement>('.qbp-card')
  if (!card) throw new Error('the New Tab card was not rendered')
  expect(card.style.flexDirection).toBe('column')
})
