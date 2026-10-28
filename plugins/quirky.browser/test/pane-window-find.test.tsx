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
  localhostLabels: { available: false as const, reason: 'A reachable worktree host mapping is not configured.' }
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
      mount: () => { throw new Error('Native views are unavailable in this DOM fixture.') },
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

function findInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Find text in page"]')
  if (!input) throw new Error('Find input was not rendered')
  return input
}

async function typeIntoFind(value: string): Promise<HTMLInputElement> {
  const input = findInput()
  await act(async () => {
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Native input value setter was unavailable')
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settleUI()
  })
  return input
}

async function emitPaneChanged(next: PaneState): Promise<void> {
  paneState = next
  await act(async () => {
    const event = { type: 'quirky.browser/paneChanged', data: next } as QuirkyEvent
    for (const listener of [...listeners]) await listener(event)
    await settleUI()
  })
}

function openFindButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Find in page"]')
  if (!button) throw new Error('Find in page button was not rendered')
  return button
}

test('keeps a focused Find query through a stale pane update and sends it to Next', async () => {
  const context = makeContext()
  const initialPane = pane('pane-1', '')
  paneState = stateOf(initialPane)
  await mount(context, { pane: initialPane.id })
  await act(async () => { openFindButton().click(); await settleUI() })
  const input = await typeIntoFind('Alpha')

  const stalePane = { ...initialPane, find: { text: 'Ala', current: 1, total: 2 } }
  await emitPaneChanged(stateOf(stalePane))
  expect(input.value).toBe('Alpha')

  const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')
  if (!next) throw new Error('Next match button was not rendered')
  await act(async () => {
    next.focus()
    next.click()
    await settleUI()
  })
  expect(calls).toContainEqual({
    method: 'quirky.browser/paneControl',
    params: { pane: initialPane.id, action: 'find', text: 'Alpha', forward: true }
  })

  await act(async () => { input.blur(); await settleUI() })
  const canonicalPane = { ...stalePane, find: { text: 'canonical after blur', current: 2, total: 3 } }
  await emitPaneChanged(stateOf(canonicalPane))
  expect(input.value).toBe('canonical after blur')
})

test('hydrates the Find query when mounted input selects a different pane', async () => {
  const context = makeContext()
  const firstPane = pane('pane-1', '')
  const secondPane = pane('pane-2', 'second pane canonical query')
  paneState = stateOf(firstPane, secondPane)
  await mount(context, { pane: firstPane.id })
  await act(async () => { openFindButton().click(); await settleUI() })
  const input = await typeIntoFind('first pane draft')

  await render(context, { pane: secondPane.id })

  expect(input.value).toBe('second pane canonical query')
})
