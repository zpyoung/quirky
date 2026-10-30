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
const FAILED_URL = 'http://127.0.0.1:9/closed'

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
      available: true,
      clearPartitionAvailable: false,
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
      clearPartition: async () => { throw new Error('Native storage is unavailable in this DOM fixture.') }
    },
    pluginId: 'quirky.browser',
    log: () => {},
    readClipboardText: async () => '',
    provide: () => {},
    call: async (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) })
      if (method === 'quirky.browser/paneState') return paneState
      if (method === 'quirky.browser/preferencesState') return PREFERENCES_STATE
      if (method === 'quirky.browser/paneSuggestions') return { suggestions: [] }
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
  if (!mounted) throw new Error('the pane window did not mount its native view')
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

function menuButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label)
}

test('Native Hard Reload is offered only when the view reports cache-bypassing reload', async () => {
  await mountWindow()
  await reportNative(nativeState({ hardReloadAvailable: false }))
  expect(menuButton('Hard Reload')).toBeUndefined()
  expect(container.textContent).toContain('Hard Reload is unavailable in Native mode on this system webview')

  await reportNative(nativeState({ hardReloadAvailable: true }))
  const hardReload = menuButton('Hard Reload')
  if (!hardReload) throw new Error('Hard Reload was not offered for a supporting view')
  await act(async () => { hardReload.click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneControl', params: { pane: 'pane-1', action: 'hardReload' } })
})

test('a queued Native hardReload command runs the cache-bypassing request only on a supporting view', async () => {
  await mountWindow()
  await reportNative(nativeState({ hardReloadAvailable: true }))
  await emitPaneChanged(stateOf(pane({ command: { id: 'command-1', action: 'hardReload' } })))
  expect(requests).toEqual([{ action: 'hardReload' }])

  await reportNative(nativeState({ hardReloadAvailable: false }))
  await emitPaneChanged(stateOf(pane({ command: { id: 'command-2', action: 'hardReload' } })))
  expect(requests).toEqual([{ action: 'hardReload' }])
  const report = calls.find((call) => call.method === 'quirky.browser/paneReport' && call.params?.command === 'command-2')
  expect(String(report?.params?.error)).toContain('Hard Reload is unavailable in Native mode')
})

test('Retry after a Native load failure navigates to the retained requested address', async () => {
  await mountWindow()
  await reportNative(nativeState({ url: FAILED_URL, error: 'Could not connect to the server. (NSURLErrorDomain -1004)' }))
  expect(container.textContent).toContain('Page could not load')
  expect(container.textContent).toContain('Could not connect to the server. (NSURLErrorDomain -1004)')
  const failureReport = calls.findLast((call) => call.method === 'quirky.browser/paneReport')
  expect(failureReport?.params).toMatchObject({ url: FAILED_URL, loading: false, error: 'Could not connect to the server. (NSURLErrorDomain -1004)' })

  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry')
  if (!retry) throw new Error('Retry was not offered for the failed page')
  await act(async () => { retry.click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: FAILED_URL } })
  expect(calls.some((call) => call.method === 'quirky.browser/paneControl' && call.params?.action === 'reload')).toBe(false)
})

test('a Native state change during a pending command waits for that command to report it', async () => {
  await mountWindow()
  await emitPaneChanged(stateOf(pane({ command: { id: 'command-3', action: 'reload' } })))
  const before = calls.length
  await reportNative(nativeState({ url: 'https://example.test/page', loading: true }))
  const unacknowledged = calls.slice(before).filter((call) => call.method === 'quirky.browser/paneReport' && call.params?.command === undefined)
  expect(unacknowledged).toEqual([])
  expect(calls).toContainEqual(expect.objectContaining({
    method: 'quirky.browser/paneReport',
    params: expect.objectContaining({ command: 'command-3' })
  }))
})
