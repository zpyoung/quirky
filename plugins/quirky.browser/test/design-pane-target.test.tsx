import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { PaneState, PaneTab } from '../src/pane-contract'

type CommandHandler = (args?: unknown) => unknown
type Window = typeof import('../src/window/BrowserPaneWindow')

let createRoot: typeof CreateReactRoot
let BrowserPaneWindow: Window['BrowserPaneWindow']
let focusedBrowserPane: Window['focusedBrowserPane']
let activate: (context: UiPluginContext) => void
let deactivate: () => void
let paneState: PaneState
let designCommand: CommandHandler
let mounted: { root: Root; container: HTMLElement }[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  // ReactDOM detects input-event support at module load, so establish the test DOM before importing it.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ BrowserPaneWindow, focusedBrowserPane } = await import('../src/window/BrowserPaneWindow'))
  ;({ activate, deactivate } = await import('../src/ui'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  paneState = { tabs: [], active: null, history: [] }
})

afterEach(async () => {
  await act(async () => {
    for (const { root, container } of mounted) {
      root.unmount()
      container.remove()
    }
  })
  mounted = []
  deactivate()
})

function pane(id: string, mode: PaneTab['mode']): PaneTab {
  return {
    id,
    worktreeId: 'worktree-1',
    profileId: 'default',
    partition: 'persist:quirky-browser-default',
    mode,
    page: mode === 'watch' ? `page-${id}` : null,
    url: `https://example.test/${id}`,
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
    downloads: []
  }
}

function makeContext(provided: Map<string, unknown>): UiPluginContext {
  const context = {
    nativeBrowser: {
      available: false,
      clearPartitionAvailable: false,
      mount: () => { throw new Error('Native views are unavailable in this DOM fixture.') },
      clearPartition: async () => { throw new Error('Native storage is unavailable in this DOM fixture.') }
    },
    pluginId: 'quirky.browser',
    log: () => {},
    provide: (id: string, implementation: unknown) => { provided.set(id, implementation) },
    call: async (method: string) => {
      if (method === 'quirky.browser/paneState') return paneState
      if (method === 'quirky.browser/preferencesState') {
        return {
          profiles: [{ profile: { id: 'default', label: 'Default', scope: 'default' as const }, active: true }],
          identity: { selected: 'clean', active: 'clean', restartRequired: false, nativeSupported: false },
          imports: { available: true, destination: 'managed-chrome', nativeSupported: false, reason: 'Cookie imports are stored in managed Chrome, not Native.' },
          localhostLabels: { available: false, reason: 'A reachable worktree host mapping is not configured.' }
        }
      }
      if (method === 'quirky.browser/paneSuggestions') return { suggestions: [] }
      return undefined
    },
    subscribe: () => () => {},
    getSetting: (name: string) => name === 'setting:quirky.browser/browserImportHintHidden' ? true : undefined,
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null, worktree: null }),
    onLayout: () => () => {},
    toast: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }
  return context as unknown as UiPluginContext
}

async function settleUI(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function blurFocusedPane(): Promise<void> {
  await act(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await settleUI()
  })
}

// each pane claims focus from a zero-delay timer after mounting, so let those fire before asserting
async function mountPanes(...tabs: PaneTab[]): Promise<void> {
  paneState = { tabs, active: tabs[0]?.id ?? null, history: [] }
  const provided = new Map<string, unknown>()
  const context = makeContext(provided)
  activate(context)
  const handler = provided.get('command:quirky.browser/design')
  if (typeof handler !== 'function') throw new Error('Browser design command was not provided')
  designCommand = handler as CommandHandler
  for (const tab of tabs) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted.push({ root, container })
    await act(async () => {
      root.render(<BrowserPaneWindow context={context} input={{ pane: tab.id }} />)
      await settleUI()
    })
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  await blurFocusedPane()
}

function focusPaneRoot(id: string): void {
  const root = [...document.querySelectorAll<HTMLElement>('[data-browser-pane]')].find((entry) => entry.dataset.browserPane === id)
  if (!root) throw new Error(`Pane ${id} was not rendered`)
  root.focus()
}

test('without a pane, the design command reports that no browser pane is focused', async () => {
  await mountPanes(pane('pane-1', 'native'))
  expect(await designCommand({ action: 'cancel' })).toEqual({ started: false, reason: 'No browser pane is focused.' })
})

test('without a pane, the design command still acts on the focused Native pane', async () => {
  await mountPanes(pane('pane-1', 'native'), pane('pane-2', 'native'))
  await act(async () => { focusPaneRoot('pane-2'); await settleUI() })
  expect(focusedBrowserPane()).toBe('pane-2')
  expect(await designCommand({ action: 'cancel' })).toEqual({ started: true })
})

test('a pane argument focuses that Native pane and runs the action there', async () => {
  await mountPanes(pane('pane-1', 'native'), pane('pane-2', 'native'))
  await act(async () => { focusPaneRoot('pane-1'); await settleUI() })
  expect(focusedBrowserPane()).toBe('pane-1')

  let result: unknown
  await act(async () => { result = await designCommand({ action: 'cancel', pane: 'pane-2' }) })
  expect(result).toEqual({ started: true })
  expect(focusedBrowserPane()).toBe('pane-2')
})

test('a pane argument works when no pane was focused before', async () => {
  await mountPanes(pane('pane-1', 'native'))
  expect(focusedBrowserPane()).toBeNull()
  let result: unknown
  await act(async () => { result = await designCommand({ action: 'cancel', pane: 'pane-1' }) })
  expect(result).toEqual({ started: true })
  expect(focusedBrowserPane()).toBe('pane-1')
})

test('an unmounted pane returns a reason instead of acting on another pane', async () => {
  await mountPanes(pane('pane-1', 'native'))
  await act(async () => { focusPaneRoot('pane-1'); await settleUI() })
  const result = await designCommand({ action: 'cancel', pane: 'missing' }) as { started: boolean; reason?: string }
  expect(result.started).toBe(false)
  expect(result.reason).toContain('missing')
  expect(focusedBrowserPane()).toBe('pane-1')
})

test('a Watch pane returns a reason', async () => {
  await mountPanes(pane('pane-1', 'native'), pane('pane-2', 'watch'))
  const result = await designCommand({ action: 'cancel', pane: 'pane-2' }) as { started: boolean; reason?: string }
  expect(result.started).toBe(false)
  expect(result.reason).toContain('Watch')
})

test('a pane argument that is not a non-empty string is rejected', async () => {
  await mountPanes(pane('pane-1', 'native'))
  for (const bad of [42, '', null, ['pane-1'], { id: 'pane-1' }]) {
    const result = await designCommand({ action: 'cancel', pane: bad }) as { started: boolean; reason?: string }
    expect(result.started).toBe(false)
    expect(result.reason).toContain('pane')
  }
  expect(focusedBrowserPane()).toBeNull()
})
