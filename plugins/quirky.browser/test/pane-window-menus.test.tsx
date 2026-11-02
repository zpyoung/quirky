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
  return { tabs, active: tabs[0]?.id ?? null, history: [{ url: 'https://example.test/seen', title: 'Seen', visitedAt: 1 }] }
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

function detailsFor(summaryLabel: string): HTMLDetailsElement {
  const summary = container.querySelector(`summary[aria-label="${summaryLabel}"]`)
  const details = summary?.parentElement
  if (!(details instanceof HTMLDetailsElement)) throw new Error(`no menu for ${summaryLabel}`)
  return details
}

function menuButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.startsWith(label))
  if (!button) throw new Error(`no menu item ${label}`)
  return button
}

async function press(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settleUI()
  })
}

test('the Browser menu closes after a one-shot choice and returns focus to its trigger', async () => {
  await mountWindow()
  await reportNative(nativeState({ hardReloadAvailable: true }))
  const details = detailsFor('Browser menu')
  details.open = true
  await act(async () => { menuButton('Hard Reload').click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneControl', params: { pane: 'pane-1', action: 'hardReload' } })
  expect(details.open).toBe(false)
  expect(document.activeElement).toBe(details.querySelector('summary'))
})

test('the Browser menu stays open for repeatable zoom steps', async () => {
  await mountWindow()
  const details = detailsFor('Browser menu')
  details.open = true
  await act(async () => { menuButton('Zoom In').click(); await settleUI() })
  await act(async () => { menuButton('Zoom Out').click(); await settleUI() })
  expect(details.open).toBe(true)
  await act(async () => { menuButton('Reset Zoom').click(); await settleUI() })
  expect(details.open).toBe(false)
})

test('choosing a history entry closes the History popover', async () => {
  await mountWindow()
  const details = detailsFor('Browser history')
  details.open = true
  await act(async () => { menuButton('Seen').click(); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneNavigate', params: { pane: 'pane-1', input: 'https://example.test/seen' } })
  expect(details.open).toBe(false)
})

test('Escape closes either popover and focuses its trigger', async () => {
  await mountWindow()
  for (const label of ['Browser menu', 'Browser history']) {
    const details = detailsFor(label)
    details.open = true
    await press(menuButton(label === 'Browser menu' ? 'Zoom In' : 'Seen'), 'Escape')
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(details.querySelector('summary'))
  }
})

test('a press outside an open popover closes it', async () => {
  await mountWindow()
  const details = detailsFor('Browser history')
  details.open = true
  await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await settleUI() })
  expect(details.open).toBe(false)
})

test('popovers override the menu list min-width: 100% so they cannot outgrow the toolbar', async () => {
  await mountWindow()
  for (const label of ['Browser menu', 'Browser history']) {
    const popover = detailsFor(label).querySelector<HTMLElement>(':scope > .ui-menu__list')
    expect(['0', '0px']).toContain(popover?.style.minWidth ?? '')
  }
})
