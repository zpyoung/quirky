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
    mode: 'watch',
    page: 'page-1',
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
      if (method === 'quirky.browser/paneWatch') return { watchId: 'watch-1' }
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

async function emitFrame(sequence: number, width = 375, height = 667): Promise<void> {
  await act(async () => {
    const event = { type: 'quirky.browser/paneFrame', data: { pane: 'pane-1', watchId: 'watch-1', sequence, data: 'AAAA', width, height } } as QuirkyEvent
    for (const listener of [...listeners]) await listener(event)
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

function frameImage(): HTMLImageElement {
  const image = container.querySelector<HTMLImageElement>('img.qbp-watch-image')
  if (!image) throw new Error('Watch frame was not rendered')
  return image
}

function describedText(element: Element): string {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
}

async function mountWatching(): Promise<PaneTab> {
  const initial = { ...pane('pane-1', ''), title: 'Alpha Docs', url: 'https://alpha.test/docs' }
  paneState = stateOf(initial)
  await mount(makeContext(), { pane: initial.id })
  await emitFrame(1)
  return initial
}

test('names the Watch frame after the page it shows and follows navigation', async () => {
  const initial = await mountWatching()
  expect(frameImage().alt).toContain('Alpha Docs')

  await emitPaneChanged(stateOf({ ...initial, title: 'Beta Pricing', url: 'https://beta.test/pricing' }))
  expect(frameImage().alt).toContain('Beta Pricing')
  expect(frameImage().alt).not.toContain('Alpha Docs')
})

test('falls back to the address when the page has no title', async () => {
  const initial = await mountWatching()
  await emitPaneChanged(stateOf({ ...initial, title: '', url: 'https://untitled.test/x' }))
  expect(frameImage().alt).toContain('https://untitled.test/x')
})

test('describes the Watch view as interactive and says how to use it', async () => {
  await mountWatching()
  const host = container.querySelector<HTMLElement>('.qbp-page')
  if (!host) throw new Error('page host missing')
  const description = describedText(host).toLowerCase()
  expect(description).toContain('interactive')
  expect(description).toContain('keyboard')
  expect(description).toContain('click')
})

test('announces a navigation politely, not the initial page or a mere frame update', async () => {
  const initial = await mountWatching()
  const region = container.querySelector<HTMLElement>('.qbp-watch-announcer')
  if (!region) throw new Error('live region missing')
  expect(region.getAttribute('aria-live')).toBe('polite')
  expect(region.textContent).toBe('')

  await emitFrame(2)
  expect(region.textContent).toBe('')

  await emitPaneChanged(stateOf({ ...initial, title: 'Beta Pricing', url: 'https://beta.test/pricing' }))
  expect(region.textContent).toContain('Beta Pricing')
})

test('fits the whole frame inside the pane, so a tall emulated viewport is not clipped', async () => {
  await mountWatching()
  const style = frameImage().style
  expect(style.objectFit).toBe('contain')
  expect(style.width).toBe('100%')
  expect(style.height).toBe('100%')
})
