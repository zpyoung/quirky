import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { NativeBrowserOptions, NativeBrowserPageAnswer, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { PaneNativeDecision, PanePrompt, PaneState, PaneTab } from '../src/pane-contract'
import { BrowserPaneWindow } from '../src/window/BrowserPaneWindow'

let container: HTMLElement
let root: Root | null = null
let createRoot: typeof CreateReactRoot
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let paneState: PaneState
let mounted: NativeBrowserOptions | null
let decisions: Map<string, PaneNativeDecision>
const calls: { method: string; params?: Record<string, unknown> }[] = []
const answers: Array<[string, NativeBrowserPageAnswer]> = []

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
  answers.length = 0
  mounted = null
  decisions = new Map()
  paneState = stateOf(pane())
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

function pane(patch: Partial<PaneTab> = {}): PaneTab {
  return {
    id: 'pane-1', worktreeId: 'worktree-1', profileId: 'default', partition: 'persist:quirky-browser-default', mode: 'native',
    page: null, url: 'https://example.test/', title: 'Example', loading: false, error: null, canGoBack: false, canGoForward: false,
    zoom: 0, viewport: 'default', command: null, find: { text: '', current: 0, total: 0 }, prompts: [], downloads: [], ...patch
  }
}

function stateOf(...tabs: PaneTab[]): PaneState {
  return { tabs, active: tabs[0]?.id ?? null, history: [] }
}

// A desktop-like Native capability: it records the mount options and every answer the window sends back.
function makeContext(): UiPluginContext {
  return {
    nativeBrowser: {
      available: true,
      clearPartitionAvailable: false,
      pageRequestsAvailable: true,
      mount: (_element, options) => {
        mounted = options
        return {
          request: async () => ({ id: options.id, url: options.url, title: '', loading: false, canGoBack: false, canGoForward: false, zoom: 0, error: null, findCurrent: 0, findTotal: 0 }),
          evaluate: async () => null,
          answer: async (id, answer) => { answers.push([id, answer]); return true },
          cancelDownload: async () => true,
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
      if (method === 'quirky.browser/preferencesState') return { profiles: [], identity: {}, imports: {}, localhostLabels: {} }
      if (method === 'quirky.browser/paneSuggestions') return { suggestions: [] }
      if (method === 'quirky.browser/paneNativeRequest') {
        const request = (params as { request: { id: string } }).request
        return decisions.get(request.id) ?? { prompt: null, answer: { accept: false } }
      }
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
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

async function emit(type: string, data: unknown): Promise<void> {
  await act(async () => {
    for (const listener of [...listeners]) await listener({ type, data } as QuirkyEvent)
    await settleUI()
  })
}

async function typeInto(label: string, value: string): Promise<void> {
  const input = [...container.querySelectorAll<HTMLInputElement>('input')].find((candidate) =>
    container.querySelector(`label[for="${candidate.id}"]`)?.textContent === label)
  if (!input) throw new Error(`${label} field was not rendered`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settleUI()
  })
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text)
  if (!button) throw new Error(`${text} button was not rendered`)
  await act(async () => { button.click(); await settleUI() })
}

async function mountWindow(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<BrowserPaneWindow context={makeContext()} input={{ pane: 'pane-1' }} />)
    await settleUI()
  })
  if (!mounted) throw new Error('the Native view was not mounted')
}

test('Native sign-in credentials go from the overlay straight to the view, never through the daemon', async () => {
  await mountWindow()
  decisions.set('5', { prompt: 'prompt-1', answer: null })
  await act(async () => {
    mounted!.onPageRequest?.({ id: '5', kind: 'auth', origin: 'https://example.test', host: 'example.test', realm: 'Fixture', isProxy: false, previousFailureCount: 0 })
    await settleUI()
  })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneNativeRequest', params: { pane: 'pane-1', request: expect.objectContaining({ id: '5', kind: 'auth' }) } })

  const prompt: PanePrompt = { id: 'prompt-1', kind: 'auth', origin: 'https://example.test', message: 'https://example.test requests authentication for Fixture.', expiresAt: Date.now() + 120_000 }
  await emit('quirky.browser/paneChanged', stateOf(pane({ prompts: [prompt] })))
  expect(container.querySelector('[role="dialog"][aria-label="auth from https://example.test"]')).not.toBeNull()
  await typeInto('Username', 'ada')
  await typeInto('Password', 'auth-secret')
  await click('Sign in')

  const respond = calls.find((entry) => entry.method === 'quirky.browser/paneRespond')
  expect(respond?.params).toEqual({ pane: 'pane-1', prompt: 'prompt-1', accept: true })
  expect(JSON.stringify(calls)).not.toContain('auth-secret')

  await emit('quirky.browser/paneNative', { pane: 'pane-1', action: 'answer', id: '5', prompt: 'prompt-1', kind: 'auth', accept: true })
  expect(answers).toEqual([['5', { accept: true, username: 'ada', password: 'auth-secret' }]])
})

test('an immediate daemon answer goes back to the view, and a refused popup is explained', async () => {
  await mountWindow()
  decisions.set('9', { prompt: null, answer: { accept: false } })
  decisions.set('10', { prompt: null, answer: { accept: true, path: '/Users/ada/Downloads/a.pdf' } })
  await act(async () => {
    mounted!.onPageRequest?.({ id: '9', kind: 'popup', origin: 'https://example.test', url: 'https://accounts.test/oauth', method: 'POST', width: null, height: null })
    mounted!.onPageRequest?.({ id: '10', kind: 'download', origin: 'https://example.test', url: 'https://example.test/a.pdf', suggestedFilename: 'a.pdf', mimeType: 'application/pdf', expectedBytes: 3 })
    await settleUI()
  })
  expect(answers).toEqual([['9', { accept: false }], ['10', { accept: true, path: '/Users/ada/Downloads/a.pdf' }]])
  expect(container.textContent).toContain('A popup to https://accounts.test/oauth was blocked')

  await act(async () => { mounted!.onDownload?.({ id: '10', state: 'progress', received: 1, total: 3 }); await settleUI() })
  expect(calls).toContainEqual({ method: 'quirky.browser/paneNativeUpdate', params: { pane: 'pane-1', download: { id: '10', state: 'progress', received: 1, total: 3 } } })
  await emit('quirky.browser/paneChanged', stateOf(pane({ downloads: [{ id: 'd-1', name: 'a.pdf', state: 'downloading', received: 1, total: 3 }] })))
  expect(container.querySelector('[aria-label="Downloads"]')?.textContent).toContain('a.pdf')
})

test('answers for another pane are ignored', async () => {
  await mountWindow()
  await emit('quirky.browser/paneNative', { pane: 'pane-2', action: 'answer', id: '5', prompt: 'p', kind: 'confirm', accept: true })
  expect(answers).toEqual([])
})
