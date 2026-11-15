import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act, createElement } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { EditorView as EditorViewClass } from '@codemirror/view'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo } from '../src/types'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { clearExplorerSearch, useExplorerSearchIntent } from '../src/window/explorerIntent'

const DOCUMENT_VIEW = 'view:quirky.editor/document'
const UI_CONTROL = 'command:quirky.editor/ui-control'
type Handler = (...args: unknown[]) => unknown
type MountProps = { input?: unknown; report?: (state: Record<string, unknown>) => void }
type StateReader = (attempt: number) => unknown | Promise<unknown>
type ReadReader = (attempt: number, params: Record<string, unknown>) => unknown | Promise<unknown>
type ApiReader = (params: Record<string, unknown>) => unknown | Promise<unknown>
type SelfReader = () => unknown | Promise<unknown>
type DispatchReader = (params: Record<string, unknown>, invoke: () => Promise<unknown>) => unknown | Promise<unknown>
type Event = { type: string; id?: string }
type Call = { method: string; params: Record<string, unknown> }
type ControlAddress = { surface: string; target: string; generation: string; actions: string[] }
type ControlRequest = { surface: string; target: string; generation: string; action: string; data?: Record<string, unknown> }
type MountedDocument = { element: HTMLElement; report: Record<string, unknown>; unmount(): Promise<void> }
type ClipboardReader = (text: string) => void | Promise<void>
type Fixture = {
  element: HTMLElement
  elements: HTMLElement[]
  calls: Call[]
  panelToggles: { panel: string; open?: boolean }[]
  report: Record<string, unknown>
  stateCalls: number
  readCalls: number
  clipboardWrites: string[]
  clipboardReader: ClipboardReader | null
  clipboardFailure: string | null
  confirmations: Parameters<UiPluginContext['confirm']>[0][]
  setBuffers(buffers: EditorBufferInfo[]): void
  setStateReader(reader: StateReader): void
  setReadReader(reader: ReadReader): void
  setApiHandler(method: string, reader: ApiReader): void
  setSettingFailure(message: string | null): void
  setClipboardFailure(message: string | null): void
  setClipboardReader(reader: ClipboardReader | null): void
  setConfirmReader(reader: () => boolean | Promise<boolean>): void
  setSelfReader(reader: SelfReader): void
  setDispatchReader(reader: DispatchReader | null): void
  notify(event: Event): Promise<void>
  mount(input?: unknown): Promise<void>
  replaceDocument(input: unknown): Promise<void>
  mountAnother(input: unknown): Promise<MountedDocument>
  dispatch(request: ControlRequest): Promise<unknown>
  unmount(): Promise<void>
}

const SETTINGS: Record<string, unknown> = {
  editorAutoSave: false,
  editorAutoSaveDelayMs: 1000,
  editorWordWrap: false,
  editorFontFamily: 'monospace',
  editorPreviewTabsEnabled: true,
  richMarkdownSpellcheckEnabled: false,
  markdownReviewToolsEnabled: false,
  showGitIgnoredFiles: false,
  followSymlinkedDirectories: false,
  editorFontZoomLevel: 0,
  editorMinimapEnabled: false,
  editorSidebarWidth: 320
}

let activate: typeof Activate
let deactivate: typeof Deactivate
let EditorView: typeof EditorViewClass
let createRoot: typeof CreateRoot
const fixtures: Fixture[] = []
let clipboardDescriptor: PropertyDescriptor | undefined
let activeClipboardFixture: Fixture | undefined
type LazyState = { status: 'ready' | 'throw' } | { status: 'pending'; promise: Promise<unknown> }
const lazyStates: Record<'markdown' | 'notebook' | 'viewer', LazyState> = {
  markdown: { status: 'ready' },
  notebook: { status: 'ready' },
  viewer: { status: 'ready' }
}
let realLazyModules: Record<'markdown' | 'notebook' | 'viewer', object> | undefined

function lazyChild(name: keyof typeof lazyStates) {
  return ({ buffer }: { buffer: Partial<EditorBufferInfo> }) => {
    const state = lazyStates[name]
    if (state.status === 'pending') throw state.promise
    if (state.status === 'throw') throw new Error('fixture surface failed')
    return createElement('div', { className: 'fixture-lazy-child', 'data-child': name }, buffer.draft ?? buffer.content ?? '')
  }
}

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // browser-dependent editor modules must initialize after Happy DOM registration.
  ;({ EditorView } = await import('@codemirror/view'))
  ;({ createRoot } = await import('react-dom/client'))
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text: string) {
        const fixture = activeClipboardFixture
        if (!fixture) throw new Error('Clipboard used without a mounted fixture.')
        if (fixture.clipboardFailure) throw new Error(fixture.clipboardFailure)
        await fixture.clipboardReader?.(text)
        fixture.clipboardWrites.push(text)
      }
    }
  })
  // Load actual lazy imports first so their factories can be restored after this isolated fixture.
  realLazyModules = {
    markdown: await import('../src/markdown/MarkdownSurface'),
    notebook: await import('../src/notebook/NotebookSurface'),
    viewer: await import('../src/viewers/ViewerSurface')
  }
  mock.module(new URL('../src/markdown/MarkdownSurface.tsx', import.meta.url).pathname, () => ({ MarkdownSurface: lazyChild('markdown') }))
  mock.module(new URL('../src/notebook/NotebookSurface.tsx', import.meta.url).pathname, () => ({ NotebookSurface: lazyChild('notebook') }))
  mock.module(new URL('../src/viewers/ViewerSurface.tsx', import.meta.url).pathname, () => ({ ViewerSurface: lazyChild('viewer') }))
  ;({ activate, deactivate } = await import('../src/ui'))
})

afterAll(async () => {
  const originals = realLazyModules
  if (originals) {
    mock.module(new URL('../src/markdown/MarkdownSurface.tsx', import.meta.url).pathname, () => originals.markdown)
    mock.module(new URL('../src/notebook/NotebookSurface.tsx', import.meta.url).pathname, () => originals.notebook)
    mock.module(new URL('../src/viewers/ViewerSurface.tsx', import.meta.url).pathname, () => originals.viewer)
  }
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.unmount()
  deactivate()
  for (const name of Object.keys(lazyStates) as (keyof typeof lazyStates)[]) lazyStates[name] = { status: 'ready' }
  activeClipboardFixture = undefined
  document.body.replaceChildren()
})

function makeInfo(options: {
  id?: string
  worktreeId?: string
  path?: string
  relativePath?: string
  tabId?: string | null
  kind?: EditorBufferInfo['kind']
  content?: string
  omitContent?: boolean
  draft?: string | null
  draftLength?: number | null
  external?: EditorBufferInfo['external']
  diskContentLength?: number | null
  diskSignature?: string | null
  diskWritable?: boolean
  dirty?: boolean
  baseline?: string | null
  pinned?: boolean
  untitled?: boolean
  readOnly?: boolean
  error?: string | null
  revision?: number
  contentRevision?: number
} = {}): EditorBufferInfo {
  const content = options.content ?? 'fixture text'
  const draft = options.draft ?? null
  const relativePath = options.relativePath ?? 'src/a.ts'
  const draftLength = options.draftLength ?? draft?.length ?? null
  return {
    id: options.id ?? 'b1',
    worktreeId: options.worktreeId ?? 'w1',
    root: '/fixture',
    path: options.path ?? `/fixture/${relativePath}`,
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    kind: options.kind ?? 'text',
    ...(options.omitContent ? {} : { content }),
    ...(options.draft === undefined ? {} : { draft: options.draft }),
    baseline: options.baseline ?? null,
    size: content.length,
    readOnly: options.readOnly ?? false,
    diskWritable: options.diskWritable ?? true,
    dirty: options.dirty ?? (draft !== null || (draftLength !== null && draftLength > 0)),
    external: options.external ?? null,
    mode: 'source',
    tabId: options.tabId === undefined ? 't1' : options.tabId,
    preview: false,
    pinned: options.pinned ?? false,
    untitled: options.untitled ?? false,
    revision: options.revision ?? 1,
    contentRevision: options.contentRevision ?? 1,
    view: {},
    error: options.error ?? null,
    contentLength: content.length,
    draftLength,
    diskContentLength: options.diskContentLength ?? null,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
    diskContentBytes: null,
    diskSignature: options.diskSignature ?? null
  }
}

function stateFor(buffers: EditorBufferInfo[]): Record<string, unknown> {
  return {
    buffers,
    tabs: buffers.map((buffer) => ({ tabId: buffer.tabId ?? 't1', bufferId: buffer.id, mode: 'edit' })),
    explorer: { worktreeId: 'w1', showDotfiles: false, expanded: [] },
    search: null,
    quickOpenHistory: [],
    closeRequests: []
  }
}

function readResult(text: string, params: Record<string, unknown>): Record<string, unknown> {
  const offset = typeof params.offset === 'number' ? params.offset : 0
  return {
    text: text.slice(offset),
    offset,
    nextOffset: text.length,
    eof: true,
    contentRevision: params.contentRevision
  }
}

function makeFixture(initialBuffers: EditorBufferInfo[] = []): Fixture {
  const provided = new Map<string, Handler>()
  const listeners = new Set<(event: Event) => void>()
  const calls: Call[] = []
  const panelToggles: { panel: string; open?: boolean }[] = []
  const clipboardWrites: string[] = []
  const confirmations: Parameters<UiPluginContext['confirm']>[0][] = []
  const apiReaders = new Map<string, ApiReader>()
  const mountedDisposers = new Set<() => void>()
  let mainDispose: (() => void) | undefined
  const elements: HTMLElement[] = []
  let buffers = initialBuffers
  let stateCalls = 0
  let readCalls = 0
  let settingFailure: string | null = null
  let clipboardFailure: string | null = null
  let confirmReader: () => boolean | Promise<boolean> = () => false
  let selfReader: SelfReader = () => ({ connId: 22 })
  let dispatchReader: DispatchReader | null = null
  let clipboardReader: ClipboardReader | null = null
  let stateReader: StateReader = () => stateFor(buffers)
  let readReader: ReadReader = (_attempt, params) => readResult('', params)
  const element = document.createElement('div')
  elements.push(element)
  document.body.append(element)
  let report: Record<string, unknown> = {}

  const context = {
    pluginId: 'quirky.editor',
    provide(id: string, handler: unknown) {
      if (typeof handler !== 'function') throw new Error(`Expected handler for ${id}`)
      provided.set(id, handler as Handler)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const invoke = async () => {
        const handler = provided.get(String(params.id))
        if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
        return await handler(params.args)
      }
      if (method === 'ui.window.self') return await selfReader()
      if (method === 'ui.window.command.run') {
        if (dispatchReader) return await dispatchReader(params, invoke)
        return { result: await invoke() }
      }
      const custom = apiReaders.get(method)
      if (custom) return await custom(params)
      if (method === 'quirky.editor/state') return await stateReader(++stateCalls)
      if (method === 'quirky.editor/read') return await readReader(++readCalls, params)
      if (method === 'quirky.editor/view') {
        const current = buffers.find((buffer) => buffer.id === params.bufferId) ?? makeInfo()
        const patch = params.patch && typeof params.patch === 'object' && !Array.isArray(params.patch) ? params.patch : {}
        return { ...current, ...(params.action === 'pin' ? { pinned: !current.pinned } : {}), ...patch }
      }
      if (method === 'quirky.editor/save') {
        const current = buffers.find((buffer) => buffer.id === params.bufferId) ?? makeInfo()
        return {
          ...current,
          content: current.draft ?? current.content ?? '',
          draft: null,
          dirty: false,
          draftLength: null,
          draftBytes: null,
          contentRevision: current.contentRevision + 1,
          revision: current.revision + 1
        }
      }
      if (method === 'quirky.editor/mutate') {
        if (params.action === 'rename') return { path: params.newPath }
        if (params.action === 'duplicate') return { path: 'src/a copy.ts' }
        return {}
      }
      if (method === 'quirky.editor/open') return { openedTabId: 't-copy' }
      if (method === 'ui.panel.configure' || method === 'setting.set' || method === 'quirky.editor/explorer') return {}
      return {}
    },
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection: () => () => {},
    confirm: async (options: Parameters<UiPluginContext['confirm']>[0]) => {
      confirmations.push(options)
      return await confirmReader()
    },
    getSetting(name: string) {
      if (settingFailure) throw new Error(settingFailure)
      return SETTINGS[name]
    },
    getLayout: () => ({ worktree: 'w1', view: null, panel: null, sidebar: true, focus: 'view' }),
    setContext() {},
    toast() {},
    togglePanel(panel: string, open?: boolean) { panelToggles.push({ panel, open }) },
    async executeCommand(command: string) { throw new Error(`Unexpected executeCommand: ${command}`) }
  } as unknown as UiPluginContext

  activate(context)

  const mountInto = async (target: HTMLElement, input: unknown, onReport: (value: Record<string, unknown>) => void) => {
    const mount = provided.get(DOCUMENT_VIEW)
    if (!mount) throw new Error('activate did not provide the document mount.')
    let dispose: (() => void) | undefined
    await act(async () => {
      dispose = mount(target, { input, report: onReport } satisfies MountProps) as () => void
    })
    if (dispose) mountedDisposers.add(dispose)
    return dispose
  }
  const fixture: Fixture = {
    element,
    elements,
    calls,
    panelToggles,
    clipboardWrites,
    confirmations,
    get clipboardReader() { return clipboardReader },
    get report() { return report },
    get stateCalls() { return stateCalls },
    get readCalls() { return readCalls },
    get clipboardFailure() { return clipboardFailure },
    setBuffers(value) { buffers = value },
    setStateReader(reader) { stateReader = reader },
    setReadReader(reader) { readReader = reader },
    setApiHandler(method, reader) { apiReaders.set(method, reader) },
    setSettingFailure(message) { settingFailure = message },
    setClipboardFailure(message) { clipboardFailure = message },
    setConfirmReader(reader) { confirmReader = reader },
    setClipboardReader(reader) { clipboardReader = reader },
    setSelfReader(reader) { selfReader = reader },
    setDispatchReader(reader) { dispatchReader = reader },
    async notify(event) { await act(async () => { for (const listener of [...listeners]) listener(event) }) },
    async mount(input = { bufferId: 'b1', tabId: 't1', mode: 'source' }) {
      mainDispose = await mountInto(element, input, (value) => { report = value })
      fixtures.push(fixture)
      await settle()
    },
    async replaceDocument(input) {
      if (mainDispose) {
        await act(async () => { mainDispose!() })
        mountedDisposers.delete(mainDispose)
      }
      mainDispose = await mountInto(element, input, (value) => { report = value })
      await settle()
    },
    async mountAnother(input) {
      const nextElement = document.createElement('div')
      elements.push(nextElement)
      document.body.append(nextElement)
      let nextReport: Record<string, unknown> = {}
      const dispose = await mountInto(nextElement, input, (value) => { nextReport = value })
      if (!dispose) throw new Error('The second document mount did not return a disposer.')
      await settle()
      return {
        element: nextElement,
        get report() { return nextReport },
        async unmount() {
          await act(async () => { dispose() })
          mountedDisposers.delete(dispose)
          nextElement.remove()
        }
      }
    },
    async dispatch(request) {
      activeClipboardFixture = fixture
      const response = await context.call('ui.window.command.run', { connId: 22, id: UI_CONTROL, args: request })
      if (response && typeof response === 'object' && 'result' in response) return response.result
      return response
    },
    async unmount() {
      await act(async () => {
        for (const dispose of [...mountedDisposers].reverse()) dispose()
      })
      mountedDisposers.clear()
      listeners.clear()
      for (const target of elements) target.remove()
    }
  }
  return fixture
}

async function settle(): Promise<void> {
  await act(async () => { await Bun.sleep(0) })
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await settle()
  }
  throw new Error(message)
}

function buttonByText(element: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(element.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

async function click(button: HTMLButtonElement): Promise<void> {
  const owner = fixtures.find((fixture) => fixture.elements.some((element) => element.contains(button)))
  activeClipboardFixture = owner
  await act(async () => { button.click(); await Promise.resolve() })
}

function isControlAddress(value: unknown): value is ControlAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return 'surface' in value && typeof value.surface === 'string' &&
    'target' in value && typeof value.target === 'string' &&
    'generation' in value && typeof value.generation === 'string' &&
    'actions' in value && Array.isArray(value.actions) &&
    value.actions.every((action) => typeof action === 'string')
}

function addresses(mount: Pick<MountedDocument, 'report'> | Pick<Fixture, 'report'>): ControlAddress[] {
  const controls = mount.report.uiControls
  if (!Array.isArray(controls)) throw new Error('The activated document report has no uiControls array.')
  return controls.filter(isControlAddress)
}

function documentTarget(bufferId = 'b1', tabId: string | null = 't1'): string {
  return `document:${JSON.stringify([bufferId, tabId])}`
}

function controlAddress(
  mount: Pick<MountedDocument, 'report'> | Pick<Fixture, 'report'>,
  target: string,
  action?: string
): ControlAddress {
  const address = addresses(mount).find((candidate) => candidate.target === target)
  if (!address) throw new Error(`Missing advertised control target: ${target}`)
  if (action && !address.actions.includes(action)) throw new Error(`Control ${target} does not advertise ${action}.`)
  return address
}

function controlRequest(
  mount: Pick<MountedDocument, 'report'> | Pick<Fixture, 'report'>,
  target: string,
  action: string,
  data?: Record<string, unknown>
): ControlRequest {
  const address = controlAddress(mount, target)
  return {
    surface: address.surface,
    target: address.target,
    generation: address.generation,
    action,
    ...(data === undefined ? {} : { data })
  }
}

async function waitForControlAddress(mount: Pick<MountedDocument, 'report'> | Pick<Fixture, 'report'>, target: string): Promise<void> {
  await waitFor(() => {
    const controls = mount.report.uiControls
    return Array.isArray(controls) && controls.some((value) => isControlAddress(value) && value.target === target)
  }, `The activated mount did not advertise ${target}.`)
}

async function runControl(
  fixture: Fixture,
  mount: Pick<MountedDocument, 'report'> | Pick<Fixture, 'report'>,
  action: string,
  data?: Record<string, unknown>,
  target = documentTarget()
): Promise<unknown> {
  await waitForControlAddress(mount, target)
  let result: unknown
  await act(async () => { result = await fixture.dispatch(controlRequest(mount, target, action, data)) })
  return result
}
function startControl(
  fixture: Fixture,
  mount: Pick<MountedDocument, 'report'> | Pick<Fixture, 'report'>,
  action: string,
  data?: Record<string, unknown>,
  target = documentTarget()
): Promise<unknown> {
  return fixture.dispatch(controlRequest(mount, target, action, data))
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await Promise.resolve()
  })
}

function apiCalls(fixture: Fixture, method: string): Call[] {
  return fixture.calls.filter((call) => call.method === method)
}

function editorText(element: HTMLElement): HTMLElement | null {
  return element.querySelector<HTMLElement>('.cm-content[contenteditable="true"]')
}

function expectInlineError(element: HTMLElement, message: string): HTMLElement {
  const error = element.querySelector<HTMLElement>('.ui-inline-error')
  expect(error?.getAttribute('role')).toBe('alert')
  expect(error?.textContent).toContain(message)
  return error!
}

test('invalid document input renders the shared error and never starts document loading', async () => {
  const fixture = makeFixture()
  await fixture.mount({ tabId: 't1', mode: 'source' })

  expectInlineError(fixture.element, 'The document tab has no buffer ID.')
  expect(addresses(fixture)).toEqual([])
  expect(fixture.element.querySelector('.ui-notice-line')).toBeNull()
  expect(fixture.element.querySelector('.ui-empty-state')).toBeNull()
  expect(fixture.stateCalls).toBe(0)
})

test('unresolved initial state reads use the shared accessible loading status', async () => {
  const fixture = makeFixture()
  const pending = Promise.withResolvers<unknown>()
  fixture.setStateReader(() => pending.promise)
  await fixture.mount()
  await waitFor(() => fixture.stateCalls === 1, 'The initial state read did not start.')

  const notice = fixture.element.querySelector<HTMLElement>('.ui-notice-line')
  expect(notice?.textContent).toBe('Loading document…')
  expect(notice?.closest('[role="status"]')).not.toBeNull()
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()

  pending.resolve(stateFor([makeInfo()]))
  await waitFor(() => editorText(fixture.element) !== null, 'The document did not appear after its state read completed.')
})

test('a missing buffer is EmptyState, while retry can open the same valid blank file as an editor', async () => {
  const blank = makeInfo({ content: '' })
  const fixture = makeFixture()
  await fixture.mount()
  await waitFor(() => fixture.element.querySelector('.ui-empty-state') !== null, 'A successful missing-buffer response did not render EmptyState.')
  const empty = fixture.element.querySelector<HTMLElement>('.ui-empty-state')!

  expect(empty.textContent).toContain('This document is no longer open.')
  expect(controlAddress(fixture, documentTarget(), 'retry').actions).toContain('retry')
  fixture.setBuffers([blank])
  expect(await runControl(fixture, fixture, 'retry')).toEqual({ delivered: true })
  await waitFor(() => editorText(fixture.element) !== null, 'Retry did not hydrate the now-present blank buffer.')

  expect(fixture.element.querySelector('.ui-empty-state')).toBeNull()
  expect(editorText(fixture.element)?.textContent).toBe('')
  expect(fixture.element.querySelector('[contenteditable="true"]')).not.toBeNull()
})

test('pending text hydration uses the shared loading status until the text arrives', async () => {
  const fixture = makeFixture([makeInfo({ omitContent: true, content: 'hydrated text' })])
  const pending = Promise.withResolvers<unknown>()
  fixture.setReadReader(() => pending.promise)
  await fixture.mount()
  await waitFor(() => fixture.readCalls === 1, 'The initial text hydration did not start.')

  const notice = fixture.element.querySelector<HTMLElement>('.ui-notice-line')
  expect(notice?.textContent).toBe('Loading document…')
  expect(notice?.closest('[role="status"]')).not.toBeNull()
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()

  const read = fixture.calls.find(({ method }) => method === 'quirky.editor/read')!
  pending.resolve(readResult('hydrated text', read.params))
  await waitFor(() => editorText(fixture.element)?.textContent === 'hydrated text', 'The editor did not appear after hydration completed.')
})

test('initial state read failures use InlineError and Retry refreshes the document state', async () => {
  const fixture = makeFixture([makeInfo()])
  fixture.setStateReader((attempt) => {
    if (attempt === 1) throw new Error('fixture state failed')
    return stateFor([makeInfo()])
  })
  await fixture.mount()
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The failed state read did not render InlineError.')

  const error = expectInlineError(fixture.element, 'fixture state failed')
  expect(buttonByText(error, 'Retry')).toBeDefined()
  expect(controlAddress(fixture, documentTarget(), 'retry').actions).toContain('retry')
  expect(await runControl(fixture, fixture, 'retry')).toEqual({ delivered: true })
  await waitFor(() => editorText(fixture.element) !== null, 'Retry did not restore the document.')
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
})

test('hydration failure offers Retry and retries text at the same buffer revision', async () => {
  const info = makeInfo({ omitContent: true, content: 'hydration retry succeeds' })
  const fixture = makeFixture([info])
  fixture.setReadReader((attempt, params) => {
    if (attempt === 1) throw new Error('fixture hydrate failed')
    return readResult('hydration retry succeeds', params)
  })
  await fixture.mount()
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The hydration failure did not render InlineError.')

  expectInlineError(fixture.element, 'fixture hydrate failed')
  expect(controlAddress(fixture, documentTarget(), 'retry').actions).toContain('retry')
  expect(await runControl(fixture, fixture, 'retry')).toEqual({ delivered: true })
  await waitFor(() => editorText(fixture.element)?.textContent === 'hydration retry succeeds', 'Retry did not hydrate the document.')
  expect(fixture.stateCalls).toBe(2)
  expect(fixture.readCalls).toBe(2)
  expect(fixture.calls.filter(({ method }) => method === 'quirky.editor/read').map(({ params }) => params.contentRevision)).toEqual([info.contentRevision, info.contentRevision])
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
})

test('a later state or hydration error preserves the mounted editor and its local draft', async () => {
  const first = makeInfo({ content: 'base text', draft: 'local draft' })
  const fixture = makeFixture([first])
  await fixture.mount()
  await waitFor(() => editorText(fixture.element)?.textContent === 'local draft', 'The initial local draft did not hydrate.')
  const editor = editorText(fixture.element)
  if (!editor) throw new Error('The source editor did not mount.')

  fixture.setStateReader((attempt) => {
    if (attempt === 2) throw new Error('fixture later state failed')
    return stateFor([first])
  })
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => fixture.element.querySelector('.ui-inline-error')?.textContent?.includes('fixture later state failed') === true, 'The later state failure did not render.')
  expect(editorText(fixture.element)).toBe(editor)
  expect(editor.textContent).toBe('local draft')

  const next = makeInfo({ omitContent: true, content: 'latest base', draft: 'local draft', revision: 2, contentRevision: 2 })
  fixture.setBuffers([next])
  fixture.setStateReader(() => stateFor([next]))
  fixture.setReadReader(() => { throw new Error('fixture later hydrate failed') })
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => fixture.element.querySelector('.ui-inline-error')?.textContent?.includes('fixture later hydrate failed') === true, 'The later hydration failure did not render.')

  expect(editorText(fixture.element)).toBe(editor)
  expect(editor.textContent).toBe('local draft')
  expect(fixture.element.querySelector('.ui-notice-line')).toBeNull()
})

test('a settings reload failure renders through InlineError without replacing the editor', async () => {
  const fixture = makeFixture([makeInfo({ content: 'still editable' })])
  await fixture.mount()
  await waitFor(() => editorText(fixture.element) !== null, 'The source editor did not mount.')
  const editor = editorText(fixture.element)
  fixture.setSettingFailure('fixture settings failed')
  await fixture.notify({ type: 'setting.changed', id: 'setting:quirky.editor/editorWordWrap' })
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The settings reload failure did not render.')

  expectInlineError(fixture.element, 'fixture settings failed')
  expect(editorText(fixture.element)).toBe(editor)
  expect(fixture.element.querySelector('.ui-empty-state')).toBeNull()
})

test('a draft conflict keeps Compare available alongside a settings error and compares shared to local text', async () => {
  const local = makeInfo({ content: 'base text', draft: 'local draft' })
  const fixture = makeFixture([local])
  await fixture.mount()
  await waitFor(() => editorText(fixture.element)?.textContent === 'local draft', 'The local draft did not mount.')

  const shared = makeInfo({ content: 'base text', draft: 'shared draft', revision: 2, contentRevision: 2 })
  fixture.setBuffers([shared])
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => fixture.element.textContent?.includes('A newer shared draft arrived.') === true, 'The competing shared draft was not reported.')

  fixture.setSettingFailure('fixture settings failed')
  await fixture.notify({ type: 'setting.changed', id: 'setting:quirky.editor/editorWordWrap' })
  await waitFor(() => [...fixture.element.querySelectorAll('.ui-inline-error')].some((error) => error.textContent?.includes('fixture settings failed')), 'The settings failure was not shown beside the draft conflict.')
  expectInlineError(fixture.element, 'fixture settings failed')
  expect(controlAddress(fixture, documentTarget(), 'compare-local').actions).toContain('compare-local')
  expect(await runControl(fixture, fixture, 'compare-local')).toEqual({ delivered: true })
  await waitFor(() => fixture.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea').length === 2, 'Compare did not open.')

  expect([...fixture.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')].map((textarea) => textarea.value))
    .toEqual(['shared draft', 'local draft'])
  const target = `document-compare:${JSON.stringify(['b1', 't1'])}`
  const firstGeneration = controlAddress(fixture, target).generation
  expect(await runControl(fixture, fixture, 'close', undefined, target)).toEqual({ delivered: true })
  await waitFor(() => !addresses(fixture).some((address) => address.target === target), 'The local comparison did not close.')
  expect(await runControl(fixture, fixture, 'compare-local')).toEqual({ delivered: true })
  expect(controlAddress(fixture, target).generation).not.toBe(firstGeneration)

})

test('permission and external-change messages remain non-blocking advisories', async () => {
  const changed = makeInfo({ content: 'dirty text', dirty: true, external: 'changed', diskWritable: false })
  const fixture = makeFixture([changed])
  await fixture.mount()
  await waitFor(() => fixture.element.querySelector('.qe-external-change-banner') !== null, 'The changed-on-disk advisory did not render.')

  expect(fixture.element.querySelector('.qe-permission-banner')?.getAttribute('role')).toBe('status')
  expect(fixture.element.querySelector('.qe-external-change-banner')?.textContent).toContain('This file changed on disk while you have unsaved edits.')
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
  expect(fixture.element.querySelector('.ui-empty-state')).toBeNull()
  expect(fixture.element.querySelector('.ui-notice-line')).toBeNull()

  const deleted = makeInfo({ content: 'dirty text', external: 'deleted', diskWritable: false, revision: 2 })
  fixture.setBuffers([deleted])
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => fixture.element.querySelector('.qe-external-change-banner')?.textContent?.includes('This file was deleted on disk.') === true, 'The deleted-on-disk advisory did not render.')
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
  expect(fixture.element.querySelector('.ui-empty-state')).toBeNull()
  expect(fixture.element.querySelector('.ui-notice-line')).toBeNull()
})
const lazyPendingCases = [
  { child: 'markdown', kind: 'markdown', loading: 'Loading Markdown surface…' },
  { child: 'notebook', kind: 'notebook', loading: 'Loading notebook surface…' },
  { child: 'viewer', kind: 'csv', loading: 'Loading viewer…' }
] as const

for (const scenario of lazyPendingCases) {
  test(`${scenario.child} child pending state uses its shared accessible loading notice`, async () => {
    const pending = Promise.withResolvers<void>()
    lazyStates[scenario.child] = { status: 'pending', promise: pending.promise }
    const fixture = makeFixture([makeInfo({ kind: scenario.kind, content: 'child content' })])
    await fixture.mount({ bufferId: 'b1', tabId: 't1', mode: 'rich' })

    await waitFor(() => fixture.element.textContent?.includes(scenario.loading) === true, 'The lazy child did not suspend.')
    const notice = fixture.element.querySelector<HTMLElement>('.ui-notice-line')
    expect(notice?.textContent).toBe(scenario.loading)
    expect(notice?.closest('[role="status"]')).not.toBeNull()

    await act(async () => {
      lazyStates[scenario.child] = { status: 'ready' }
      pending.resolve()
      await pending.promise
    })
    await waitFor(() => fixture.element.querySelector('.fixture-lazy-child') !== null, 'The pending lazy child did not resume.')
  })
}

test('failed lazy child retries through the advertised document route without losing its draft', async () => {
  lazyStates.markdown = { status: 'throw' }
  const fixture = makeFixture([makeInfo({ kind: 'markdown', content: 'base', draft: 'draft survives' })])
  await fixture.mount({ bufferId: 'b1', tabId: 't1', mode: 'rich' })
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The failing lazy child did not reach the boundary.')

  expectInlineError(fixture.element, 'The document surface could not be loaded: fixture surface failed')
  expect(controlAddress(fixture, documentTarget(), 'retry-surface').actions).toContain('retry-surface')
  lazyStates.markdown = { status: 'ready' }
  expect(await runControl(fixture, fixture, 'retry-surface')).toEqual({ delivered: true })
  await waitFor(() => fixture.element.querySelector('.fixture-lazy-child') !== null, 'Retry did not remount the lazy child.')
  expect(fixture.element.querySelector('.fixture-lazy-child')?.textContent).toContain('draft survives')
  expect(fixture.stateCalls).toBe(1)
})

test('activated document reports advertise per-tab controls and dispatch only to window 22', async () => {
  const fixture = makeFixture([makeInfo({ kind: 'markdown' })])
  await fixture.mount()
  const firstTarget = documentTarget('b1', 't1')
  const sourceTarget = `source:${JSON.stringify(['b1', 't1'])}`
  await waitForControlAddress(fixture, firstTarget)
  await waitForControlAddress(fixture, sourceTarget)
  expect(fixture.report).toMatchObject({ mounted: true, bufferId: 'b1', tabId: 't1', mode: 'source' })
  expect(controlAddress(fixture, firstTarget, 'pin').surface).toBe(DOCUMENT_VIEW)
  expect(controlAddress(fixture, sourceTarget, 'find').surface).toBe(DOCUMENT_VIEW)

  const second = await fixture.mountAnother({ bufferId: 'b1', tabId: 't2', mode: 'source' })
  await waitForControlAddress(second, documentTarget('b1', 't2'))
  expect(second.report).toMatchObject({ mounted: true, bufferId: 'b1', tabId: 't2', mode: 'source' })
  expect(await runControl(fixture, second, 'pin', undefined, documentTarget('b1', 't2'))).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/view').at(-1)?.params).toMatchObject({ bufferId: 'b1', tabId: 't2', action: 'pin' })
  expect(apiCalls(fixture, 'ui.window.command.run').at(-1)?.params).toMatchObject({ connId: 22, id: UI_CONTROL })
})

test('path-copy buttons and addressed relative copy use the exact-window control route', async () => {
  const fixture = makeFixture([makeInfo()])
  await fixture.mount()
  await waitForControlAddress(fixture, documentTarget())
  const fileActions = fixture.element.querySelector<HTMLDetailsElement>('.qe-file-actions')
  if (!fileActions) throw new Error('The native File actions disclosure is missing.')
  fileActions.open = true
  await click(buttonByText(fixture.element, 'Copy Path'))
  await waitFor(() => fixture.clipboardWrites.length === 1, 'The absolute path was not copied.')

  expect(fixture.clipboardWrites).toEqual(['/fixture/src/a.ts'])
  expect(apiCalls(fixture, 'ui.window.self')).toHaveLength(1)
  expect(apiCalls(fixture, 'ui.window.command.run').at(-1)?.params).toMatchObject({
    connId: 22,
    id: UI_CONTROL,
    args: { target: documentTarget(), action: 'copy-path' }
  })
  expect(await runControl(fixture, fixture, 'copy-path', { relative: true })).toEqual({ delivered: true })
  expect(fixture.clipboardWrites).toEqual(['/fixture/src/a.ts', 'src/a.ts'])
})

test('document controls preserve pin, navigation, settings, mode, Changes, duplicate, close and Save operations', async () => {
  const fixture = makeFixture([makeInfo({ kind: 'markdown', content: 'local draft', draft: 'local draft', dirty: true, baseline: 'head' })])
  fixture.setApiHandler('quirky.git/diff', () => ({ kind: 'text', original: 'head', modified: 'local draft' }))
  await fixture.mount()

  expect(await runControl(fixture, fixture, 'pin')).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/view').at(-1)?.params).toMatchObject({ bufferId: 'b1', tabId: 't1', action: 'pin' })
  expect(await runControl(fixture, fixture, 'explorer')).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/explorer').at(-1)?.params).toMatchObject({ worktree: 'w1', action: 'reveal', path: 'src/a.ts' })
  expect(fixture.panelToggles.at(-1)).toEqual({ panel: 'panel:quirky.editor/explorer', open: true })
  expect(await runControl(fixture, fixture, 'source-control')).toEqual({ delivered: true })
  expect(fixture.panelToggles.at(-1)).toEqual({ panel: 'panel:quirky.git/source-control', open: true })

  expect(await runControl(fixture, fixture, 'zoom', { direction: 'in' })).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'setting.set').at(-1)?.params).toEqual({ id: 'setting:quirky.editor/editorFontZoomLevel', value: 1 })
  expect(await runControl(fixture, fixture, 'setting', { name: 'editorWordWrap', value: true })).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'setting.set').at(-1)?.params).toEqual({ id: 'setting:quirky.editor/editorWordWrap', value: true })
  expect(await runControl(fixture, fixture, 'mode', { value: 'preview' })).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/open').at(-1)?.params).toEqual({
    worktree: 'w1', path: 'src/a.ts', mode: 'preview', preview: false, focus: true
  })

  expect(await runControl(fixture, fixture, 'changes', { open: true })).toEqual({ delivered: true })
  await waitFor(() => fixture.element.querySelector('.qe-changes-surface') !== null, 'Changes did not open.')
  expect(await runControl(fixture, fixture, 'changes', { open: false })).toEqual({ delivered: true })
  await waitFor(() => fixture.element.querySelector('.qe-changes-surface') === null, 'Changes did not close.')

  expect(await runControl(fixture, fixture, 'duplicate')).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/mutate').at(-1)?.params).toEqual({ worktree: 'w1', action: 'duplicate', path: 'src/a.ts' })
  expect(apiCalls(fixture, 'quirky.editor/open').at(-1)?.params).toEqual({ worktree: 'w1', path: 'src/a copy.ts', focus: true, preview: false })
  expect(await runControl(fixture, fixture, 'close')).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/close').at(-1)?.params).toEqual({ bufferId: 'b1', tabId: 't1' })
  expect(await runControl(fixture, fixture, 'save')).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/save').at(-1)?.params).toEqual({ bufferId: 'b1', trigger: 'user' })
})

test('a buffer-open failure advertises retry-open and retries through the activated handler', async () => {
  const fixture = makeFixture([makeInfo({ error: 'fixture buffer failed' })])
  await fixture.mount()
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The buffer error did not render.')

  expectInlineError(fixture.element, 'fixture buffer failed')
  expect(controlAddress(fixture, documentTarget(), 'retry-open').actions).toContain('retry-open')
  expect(await runControl(fixture, fixture, 'retry-open')).toEqual({ delivered: true })
  expect(apiCalls(fixture, 'quirky.editor/open').at(-1)?.params).toEqual({
    worktree: 'w1', path: 'src/a.ts', mode: 'source', focus: true
  })
})

test('invalid, unavailable, stale and unmounted controls do not delegate or change the UI', async () => {
  const fixture = makeFixture([makeInfo({ content: 'unchanged' })])
  await fixture.mount()
  await waitForControlAddress(fixture, documentTarget())
  const sourceTarget = `source:${JSON.stringify(['b1', 't1'])}`
  await waitForControlAddress(fixture, sourceTarget)
  const document = controlAddress(fixture, documentTarget())
  const source = controlAddress(fixture, sourceTarget)
  const invalid: ControlRequest[] = [
    { ...document, action: 'not-an-action' },
    { ...document, action: 'pin', data: { unexpected: true } },
    { ...document, action: 'copy-path', data: { relative: 'yes' } },
    { ...document, action: 'zoom', data: { direction: 'sideways' } },
    { ...document, action: 'setting', data: { name: 'arbitrarySetting', value: true } },
    { ...document, action: 'setting', data: { name: 'editorWordWrap', value: 1 } },
    { ...document, action: 'setting', data: { name: 'editorAutoSaveDelayMs', value: 249 } },
    { ...document, action: 'setting', data: { name: 'editorAutoSaveDelayMs', value: Number.POSITIVE_INFINITY } },
    { ...document, action: 'setting', data: { name: 'editorFontZoomLevel', value: 19 } },
    { ...document, action: 'mode', data: { value: 'mystery' } },
    { ...document, action: 'mode', data: { value: 'preview', unexpected: true } },
    { ...document, action: 'delete', data: { yes: true } },
    { ...document, action: 'reload' },
    { ...document, action: 'keep' },
    { ...document, action: 'compare-disk' },
    { ...source, action: 'minimap', data: { position: 0.5 } },
    { ...source, action: 'minimap', data: { position: Number.NaN } },
    { ...source, action: 'menu-open', data: { kind: 'gutter', line: 0 } },
    { ...source, action: 'menu-open', data: { kind: 'gutter', line: 2 } },
    { ...source, action: 'copy-context', data: { text: 'caller-supplied clipboard' } }
  ]
  const delegatedCount = () => fixture.calls.filter(({ method }) => method !== 'ui.window.self' && method !== 'ui.window.command.run').length
  const beforeDelegated = delegatedCount()
  const beforeMarkup = fixture.element.innerHTML
  const beforePanels = fixture.panelToggles.length
  for (const request of invalid) expect(await fixture.dispatch(request)).toEqual({ delivered: false })

  const stale = { ...document, generation: 'stale-generation', action: 'pin' }
  expect(await fixture.dispatch(stale)).toEqual({ delivered: false })
  expect(await fixture.dispatch({
    ...document,
    target: `document:${JSON.stringify(['missing', 't1'])}`,
    action: 'pin'
  })).toEqual({ delivered: false })
  expect(delegatedCount()).toBe(beforeDelegated)
  expect(fixture.clipboardWrites).toEqual([])
  expect(fixture.panelToggles).toHaveLength(beforePanels)
  expect(fixture.element.innerHTML).toBe(beforeMarkup)

  expect(await runControl(fixture, fixture, 'rename-start')).toEqual({ delivered: true })
  const rename = controlAddress(fixture, `document-rename:${JSON.stringify(['b1', 't1'])}`)
  const renameMarkup = fixture.element.innerHTML
  for (const path of ['', '   ']) {
    expect(await fixture.dispatch({ ...rename, action: 'submit', data: { path } })).toEqual({ delivered: false })
  }
  expect(await fixture.dispatch({ ...rename, action: 'submit', data: { path: 'src/b.ts', extra: true } })).toEqual({ delivered: false })
  expect(fixture.element.innerHTML).toBe(renameMarkup)
  expect(fixture.element.querySelector('.qe-inline-rename')).not.toBeNull()
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(0)
  expect(delegatedCount()).toBe(beforeDelegated)

  const liveRequest = { ...document, action: 'pin' }
  await fixture.unmount()
  expect(await fixture.dispatch(liveRequest)).toEqual({ delivered: false })
  expect(delegatedCount()).toBe(beforeDelegated)
})

test('rename Enter trims and submits once while Escape cancels without mutating', async () => {
  const fixture = makeFixture([makeInfo()])
  await fixture.mount()
  expect(await runControl(fixture, fixture, 'rename-start')).toEqual({ delivered: true })
  const field = fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')
  if (!field) throw new Error('The rename form did not open.')
  await setInputValue(field, '  src/b.ts  ')
  await press(field, 'Enter')
  await waitFor(() => apiCalls(fixture, 'quirky.editor/mutate').length === 1, 'Enter did not submit the rename.')
  expect(apiCalls(fixture, 'quirky.editor/mutate')[0]?.params).toEqual({
    worktree: 'w1', action: 'rename', path: 'src/a.ts', newPath: 'src/b.ts'
  })
  await waitFor(() => !addresses(fixture).some((address) => address.target === `document-rename:${JSON.stringify(['b1', 't1'])}`), 'The submitted rename form stayed open.')

  expect(await runControl(fixture, fixture, 'rename-start')).toEqual({ delivered: true })
  const nextField = fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')
  if (!nextField) throw new Error('A fresh rename form did not open.')
  await setInputValue(nextField, 'src/c.ts')
  await press(nextField, 'Escape')
  await waitFor(() => !addresses(fixture).some((address) => address.target === `document-rename:${JSON.stringify(['b1', 't1'])}`), 'Escape did not cancel the rename form.')
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(1)
})

test('a failed rename keeps its draft and form generation', async () => {
  const fixture = makeFixture([makeInfo()])
  fixture.setApiHandler('quirky.editor/mutate', () => { throw new Error('Destination already exists.') })
  await fixture.mount()
  await runControl(fixture, fixture, 'rename-start')
  const target = `document-rename:${JSON.stringify(['b1', 't1'])}`
  const generation = controlAddress(fixture, target).generation
  const field = fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')
  if (!field) throw new Error('The rename form did not open.')
  await setInputValue(field, 'src/b.ts')
  await press(field, 'Enter')
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The rename failure did not appear.')

  expectInlineError(fixture.element, 'Destination already exists.')
  expect(fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')?.value).toBe('src/b.ts')
  expect(controlAddress(fixture, target).generation).toBe(generation)
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(1)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`a deferred ${outcome} cannot close or report against a replacement rename form`, async () => {
    const fixture = makeFixture([makeInfo()])
    const pending = Promise.withResolvers<unknown>()
    fixture.setApiHandler('quirky.editor/mutate', () => pending.promise)
    await fixture.mount()
    await runControl(fixture, fixture, 'rename-start')
    const target = `document-rename:${JSON.stringify(['b1', 't1'])}`
    const original = controlAddress(fixture, target)
    const completion = startControl(fixture, fixture, 'submit', { path: 'src/b.ts' }, target).then(
      () => null,
      (reason: unknown) => reason
    )
    await waitFor(() => apiCalls(fixture, 'quirky.editor/mutate').length === 1, 'The rename mutation did not start.')
    await runControl(fixture, fixture, 'rename-start')
    const replacement = controlAddress(fixture, target)
    expect(replacement.generation).not.toBe(original.generation)
    const stateCallsBeforeCompletion = apiCalls(fixture, 'quirky.editor/state').length

    if (outcome === 'success') pending.resolve({ path: 'src/b.ts' })
    else pending.reject(new Error('late rename failure'))
    const error = await completion
    await settle()

    if (outcome === 'failure') expect(error).toBeInstanceOf(Error)
    expect(controlAddress(fixture, target).generation).toBe(replacement.generation)
    expect(fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')?.value).toBe('src/a.ts')
    expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
    expect(apiCalls(fixture, 'quirky.editor/state')).toHaveLength(stateCallsBeforeCompletion)
  })
}

test('delete cancellation and confirmation use exactly one guarded mutation', async () => {
  const fixture = makeFixture([makeInfo()])
  fixture.setConfirmReader(() => false)
  await fixture.mount()

  expect(await runControl(fixture, fixture, 'delete')).toEqual({ delivered: true })
  expect(fixture.confirmations).toHaveLength(1)
  expect(fixture.confirmations[0]).toMatchObject({ title: 'Delete a.ts?' })
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(0)

  fixture.setConfirmReader(() => true)
  expect(await runControl(fixture, fixture, 'delete')).toEqual({ delivered: true })
  expect(fixture.confirmations).toHaveLength(2)
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(1)
  expect(apiCalls(fixture, 'quirky.editor/mutate')[0]?.params).toEqual({
    worktree: 'w1', action: 'delete', path: 'src/a.ts', yes: true
  })
})

test('a late delete confirmation cannot mutate a buffer whose path changed', async () => {
  const fixture = makeFixture([makeInfo()])
  const pending = Promise.withResolvers<boolean>()
  fixture.setConfirmReader(() => pending.promise)
  await fixture.mount()
  const completion = startControl(fixture, fixture, 'delete').then(
    () => null,
    (reason: unknown) => reason
  )
  await waitFor(() => fixture.confirmations.length === 1, 'The delete confirmation did not start.')
  const oldGeneration = controlAddress(fixture, documentTarget()).generation
  const replacement = makeInfo({ relativePath: 'src/next.ts', content: 'replacement', revision: 2, contentRevision: 2 })
  fixture.setBuffers([replacement])
  fixture.setStateReader(() => stateFor([replacement]))
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => controlAddress(fixture, documentTarget()).generation !== oldGeneration, 'The path change did not replace the document session.')
  pending.resolve(true)
  await completion
  await settle()

  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(0)
  expect(editorText(fixture.element)?.textContent).toBe('replacement')
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
})

test('a deferred duplicate cannot open its result after path, tab or document replacement', async () => {
  for (const replacement of ['path', 'tab', 'unmount'] as const) {
    const fixture = makeFixture([makeInfo()])
    const pending = Promise.withResolvers<unknown>()
    fixture.setApiHandler('quirky.editor/mutate', () => pending.promise)
    await fixture.mount()
    const completion = startControl(fixture, fixture, 'duplicate').then(
      () => null,
      (reason: unknown) => reason
    )
    await waitFor(() => apiCalls(fixture, 'quirky.editor/mutate').length === 1, 'The duplicate mutation did not start.')

    if (replacement === 'path') {
      const next = makeInfo({ relativePath: 'src/renamed.ts', content: 'new path', revision: 2, contentRevision: 2 })
      fixture.setBuffers([next])
      fixture.setStateReader(() => stateFor([next]))
      await fixture.notify({ type: 'quirky.editor/changed' })
      await waitFor(() => editorText(fixture.element)?.textContent === 'new path', 'The replacement path did not mount.')
    } else {
      await fixture.unmount()
      if (replacement === 'tab') {
        const otherTab = await fixture.mountAnother({ bufferId: 'b1', tabId: 't2', mode: 'source' })
        await waitForControlAddress(otherTab, documentTarget('b1', 't2'))
        pending.resolve({ path: 'src/a copy.ts' })
        await completion
        expect(apiCalls(fixture, 'quirky.editor/open')).toHaveLength(0)
        await otherTab.unmount()
        continue
      }
    }

    pending.resolve({ path: 'src/a copy.ts' })
    await completion
    expect(apiCalls(fixture, 'quirky.editor/open')).toHaveLength(0)
    await fixture.unmount()
  }
})

test('a deferred close cannot request state or open a decision for a replacement document', async () => {
  const fixture = makeFixture([makeInfo()])
  const pending = Promise.withResolvers<unknown>()
  fixture.setApiHandler('quirky.editor/close', () => pending.promise)
  await fixture.mount()
  const oldGeneration = controlAddress(fixture, documentTarget()).generation
  const completion = startControl(fixture, fixture, 'close').then(
    () => null,
    (reason: unknown) => reason
  )
  await waitFor(() => apiCalls(fixture, 'quirky.editor/close').length === 1, 'The close request did not start.')

  const replacement = makeInfo({ relativePath: 'src/next.ts', content: 'replacement', revision: 2, contentRevision: 2 })
  fixture.setBuffers([replacement])
  fixture.setStateReader(() => stateFor([replacement]))
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => controlAddress(fixture, documentTarget()).generation !== oldGeneration, 'The replacement document did not mount.')
  const stateCallsAfterReplacement = apiCalls(fixture, 'quirky.editor/state').length
  pending.resolve({ needsDecision: true, closed: false })
  await completion
  await settle()

  expect(apiCalls(fixture, 'quirky.editor/state')).toHaveLength(stateCallsAfterReplacement)
  expect(document.body.querySelector('.qe-close-dialog')).toBeNull()
  expect(editorText(fixture.element)?.textContent).toBe('replacement')
})

test('a close API failure rejects the addressed control and renders its exact message', async () => {
  const fixture = makeFixture([makeInfo()])
  fixture.setApiHandler('quirky.editor/close', () => { throw new Error('fixture close failed') })
  await fixture.mount()

  await expect(runControl(fixture, fixture, 'close')).rejects.toThrow('fixture close failed')
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The close failure did not render.')
  expectInlineError(fixture.element, 'fixture close failed')
})

test('minimap rejects nonfinite and out-of-range positions without scrolling', async () => {
  const original = SETTINGS.editorMinimapEnabled
  SETTINGS.editorMinimapEnabled = true
  const fixture = makeFixture([makeInfo({ content: 'one\ntwo' })])
  try {
    await fixture.mount()
    const sourceTarget = `source:${JSON.stringify(['b1', 't1'])}`
    await waitForControlAddress(fixture, sourceTarget)
    const source = controlAddress(fixture, sourceTarget)
    const before = fixture.calls.filter(({ method }) => method !== 'ui.window.command.run').length
    for (const position of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(await fixture.dispatch({ ...source, action: 'minimap', data: { position } })).toEqual({ delivered: false })
    }
    expect(fixture.calls.filter(({ method }) => method !== 'ui.window.command.run')).toHaveLength(before)
  } finally {
    await fixture.unmount()
    SETTINGS.editorMinimapEnabled = original
  }
})

test('disk comparison reads all chunks, preserves left/right text and renews its generation', async () => {
  const diskText = 'disk line\n'.repeat(9000)
  const initial = makeInfo({
    content: 'base text', draft: 'local draft', dirty: true, external: 'changed', contentRevision: 7
  })
  const compared = makeInfo({
    content: 'base text', draft: 'local draft', dirty: true, external: 'changed',
    diskContentLength: diskText.length, diskSignature: 'disk-v1', contentRevision: 7
  })
  const fixture = makeFixture([initial])
  fixture.setApiHandler('quirky.editor/view', () => compared)
  fixture.setReadReader((_attempt, params) => {
    if (params.kind !== 'disk') return readResult('', params)
    const offset = typeof params.offset === 'number' ? params.offset : 0
    const length = typeof params.length === 'number' ? params.length : 0
    const nextOffset = Math.min(offset + length, diskText.length)
    return {
      text: diskText.slice(offset, nextOffset), offset, nextOffset,
      eof: nextOffset === diskText.length, contentRevision: params.contentRevision
    }
  })
  await fixture.mount()
  expect(await runControl(fixture, fixture, 'compare-disk')).toEqual({ delivered: true })
  await waitFor(() => fixture.element.querySelectorAll('.qe-compare-textarea').length === 2, 'The disk comparison did not open.')
  const textareas = [...fixture.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')]
  expect(textareas.map((textarea) => textarea.value)).toEqual([diskText, 'local draft'])
  expect(apiCalls(fixture, 'quirky.editor/read').filter(({ params }) => params.kind === 'disk').map(({ params }) => params.offset))
    .toEqual([0, 65536])

  const target = `document-compare:${JSON.stringify(['b1', 't1'])}`
  const firstGeneration = controlAddress(fixture, target).generation
  expect(await runControl(fixture, fixture, 'close', undefined, target)).toEqual({ delivered: true })
  await waitFor(() => !addresses(fixture).some((address) => address.target === target), 'The comparison did not close.')
  expect(await runControl(fixture, fixture, 'compare-disk')).toEqual({ delivered: true })
  const reopened = controlAddress(fixture, target)
  expect(reopened.generation).not.toBe(firstGeneration)
})

test('Save and Overwrite keep their triggers, while clean deleted files expose only explicit Save', async () => {
  for (const action of ['user', 'overwrite', 'keep', 'reload'] as const) {
    const changed = makeFixture([makeInfo({ content: 'base', draft: 'local draft', external: 'changed', dirty: true })])
    await changed.mount()
    const saving = action === 'user' || action === 'overwrite'
    expect(await runControl(changed, changed, saving ? 'save' : action, saving ? { trigger: action } : undefined)).toEqual({ delivered: true })
    if (saving) expect(apiCalls(changed, 'quirky.editor/save').at(-1)?.params.trigger).toBe(action)
    else expect(apiCalls(changed, 'quirky.editor/view').at(-1)?.params.action).toBe(action)
    await changed.unmount()
  }

  const deleted = makeFixture([makeInfo({ content: 'clean', external: 'deleted', dirty: false, diskWritable: false })])
  await deleted.mount()
  const address = controlAddress(deleted, documentTarget())
  expect(address.actions).toContain('save')
  expect(address.actions).not.toContain('compare-disk')
  expect(address.actions).not.toContain('reload')
  expect(address.actions).not.toContain('keep')
  for (const action of ['compare-disk', 'reload', 'keep']) {
    expect(await deleted.dispatch({ ...address, action })).toEqual({ delivered: false })
  }
  expect(apiCalls(deleted, 'quirky.editor/view')).toHaveLength(0)
  expect(await runControl(deleted, deleted, 'save')).toEqual({ delivered: true })
  expect(apiCalls(deleted, 'quirky.editor/save').at(-1)?.params).toEqual({ bufferId: 'b1', trigger: 'user' })
})

test('Undo Reload is refused after its 8,000 ms window expires', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  const fixture = makeFixture([makeInfo({ content: 'base', draft: 'local draft', dirty: true, external: 'changed' })])
  try {
    fixture.setApiHandler('quirky.editor/view', () => {
      const reloaded = makeInfo({ content: 'disk text', revision: 2, contentRevision: 2 })
      fixture.setBuffers([reloaded])
      return reloaded
    })
    await fixture.mount()
    expect(await runControl(fixture, fixture, 'reload')).toEqual({ delivered: true })
    await waitFor(() => fixture.element.querySelector('.qe-undo-reload') !== null, 'Undo Reload was not offered.')
    now += 8001
    const before = apiCalls(fixture, 'quirky.editor/view').length
    expect(await runControl(fixture, fixture, 'undo-reload')).toEqual({ delivered: false })
    expect(apiCalls(fixture, 'quirky.editor/view')).toHaveLength(before)
  } finally {
    await fixture.unmount()
    Date.now = originalNow
  }
})

test('a delayed source flush cannot open Changes or clear the replacement draft', async () => {
  const initial = makeInfo({ content: 'base text', baseline: 'head' })
  const fixture = makeFixture([initial])
  const pendingDraft = Promise.withResolvers<unknown>()
  fixture.setApiHandler('quirky.editor/draft', () => pendingDraft.promise)
  await fixture.mount()
  const content = editorText(fixture.element)
  const view = content ? EditorView.findFromDOM(content) : undefined
  if (!view) throw new Error('The source editor view did not mount.')
  await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: ' edit' } }) })
  await waitFor(() => apiCalls(fixture, 'quirky.editor/draft').length === 1, 'The draft write did not become pending.')
  const completion = startControl(fixture, fixture, 'changes', { open: true }).then(
    () => null,
    (reason: unknown) => reason
  )

  const replacement = makeInfo({ tabId: 't2', relativePath: 'src/next.ts', content: 'next base', draft: 'next local draft', revision: 3, contentRevision: 3 })
  fixture.setBuffers([replacement])
  fixture.setStateReader(() => stateFor([replacement]))
  await fixture.replaceDocument({ bufferId: 'b1', tabId: 't2', mode: 'source' })
  await waitFor(() => editorText(fixture.element)?.textContent === 'next local draft', 'The replacement draft did not mount.')
  const stateCallsBeforeCompletion = apiCalls(fixture, 'quirky.editor/state').length
  pendingDraft.resolve(makeInfo({
    content: 'base text', draft: 'base text edit', revision: 2, contentRevision: 2
  }))
  await completion
  await settle()

  expect(fixture.element.querySelector('.qe-changes-surface')).toBeNull()
  expect(editorText(fixture.element)?.textContent).toBe('next local draft')
  expect(apiCalls(fixture, 'quirky.editor/state')).toHaveLength(stateCallsBeforeCompletion)
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
})

test('a replaced comparison ignores its delayed disk read and retains the local draft', async () => {
  const initial = makeInfo({ content: 'base', draft: 'local draft', dirty: true, external: 'changed' })
  const compared = makeInfo({
    content: 'base', draft: 'shared draft', dirty: true, external: 'changed',
    diskContentLength: 4, diskSignature: 'disk-v1', contentRevision: 2
  })
  const fixture = makeFixture([initial])
  const pendingRead = Promise.withResolvers<unknown>()
  fixture.setApiHandler('quirky.editor/view', () => compared)
  fixture.setReadReader((_attempt, params) => params.kind === 'disk' ? pendingRead.promise : readResult('', params))
  await fixture.mount()
  fixture.setBuffers([compared])
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => addresses(fixture).some((address) => address.actions.includes('compare-local')), 'The competing draft did not expose Compare local text.')
  const oldComparison = startControl(fixture, fixture, 'compare-disk').then(
    () => null,
    (reason: unknown) => reason
  )
  await waitFor(() => fixture.readCalls === 1, 'The disk read did not start.')
  expect(await runControl(fixture, fixture, 'compare-local')).toEqual({ delivered: true })
  const target = `document-compare:${JSON.stringify(['b1', 't1'])}`
  const replacementGeneration = controlAddress(fixture, target).generation
  const errorsBefore = [...fixture.element.querySelectorAll('.ui-inline-error')].map((error) => error.textContent)
  const beforeViewCalls = apiCalls(fixture, 'quirky.editor/view').length
  const read = apiCalls(fixture, 'quirky.editor/read')[0]!
  pendingRead.resolve(readResult('disk', read.params))
  await oldComparison
  await settle()

  expect(controlAddress(fixture, target).generation).toBe(replacementGeneration)
  expect([...fixture.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')].map((textarea) => textarea.value))
    .toEqual(['shared draft', 'local draft'])
  expect(editorText(fixture.element)?.textContent).toBe('local draft')
  expect(apiCalls(fixture, 'quirky.editor/view')).toHaveLength(beforeViewCalls)
  expect([...fixture.element.querySelectorAll('.ui-inline-error')].map((error) => error.textContent)).toEqual(errorsBefore)
})

const renameBridgeFailures: {
  name: string
  message: string
  configure(fixture: Fixture): void
}[] = [
  { name: 'missing window identity', message: 'The daemon did not identify this window.', configure: (fixture) => fixture.setSelfReader(() => undefined) },
  { name: 'invalid window identity', message: 'The daemon did not identify this window.', configure: (fixture) => fixture.setSelfReader(() => ({ connId: -1 })) },
  { name: 'rejected dispatch', message: 'fixture dispatch failed', configure: (fixture) => fixture.setDispatchReader(async () => { throw new Error('fixture dispatch failed') }) },
  { name: 'malformed reply', message: 'The editor control bridge returned an invalid response.', configure: (fixture) => fixture.setDispatchReader(() => ({ result: 'malformed' })) },
  { name: 'refused result', message: 'The editor control is no longer available.', configure: (fixture) => fixture.setDispatchReader(() => ({ result: { delivered: false } })) }
]

for (const scenario of renameBridgeFailures) {
  test(`rename bridge ${scenario.name} stays visible on its live form without fallback`, async () => {
    const fixture = makeFixture([makeInfo()])
    await fixture.mount()
    await runControl(fixture, fixture, 'rename-start')
    const target = `document-rename:${JSON.stringify(['b1', 't1'])}`
    const generation = controlAddress(fixture, target).generation
    const field = fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')
    if (!field) throw new Error('The rename form did not open.')
    await setInputValue(field, 'src/b.ts')
    scenario.configure(fixture)
    await click(buttonByText(fixture.element, 'Apply'))
    await waitFor(() => fixture.element.querySelector('.ui-inline-error') !== null, 'The bridge failure did not reach the initiating form.')

    expectInlineError(fixture.element, scenario.message)
    expect(fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')?.value).toBe('src/b.ts')
    expect(controlAddress(fixture, target).generation).toBe(generation)
    expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(0)
  })
}

test('late bridge refusal and clipboard failure do not leak into a replacement document', async () => {
  const fixture = makeFixture([makeInfo()])
  await fixture.mount()
  await runControl(fixture, fixture, 'rename-start')
  const field = fixture.element.querySelector<HTMLInputElement>('.qe-inline-rename input')
  if (!field) throw new Error('The rename form did not open.')
  await setInputValue(field, 'src/b.ts')
  const bridge = Promise.withResolvers<unknown>()
  const bridgeCallsBefore = apiCalls(fixture, 'ui.window.command.run').length
  fixture.setDispatchReader(() => bridge.promise)
  await click(buttonByText(fixture.element, 'Apply'))
  await waitFor(() => apiCalls(fixture, 'ui.window.command.run').length === bridgeCallsBefore + 1, 'The delayed command dispatch did not start.')

  const next = makeInfo({ relativePath: 'src/next.ts', content: 'next document', revision: 2, contentRevision: 2 })
  fixture.setBuffers([next])
  fixture.setStateReader(() => stateFor([next]))
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => editorText(fixture.element)?.textContent === 'next document', 'The replacement document did not mount.')
  bridge.resolve({ result: { delivered: false } })
  await settle()
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(0)

  fixture.setDispatchReader(null)
  const actions = fixture.element.querySelector<HTMLDetailsElement>('.qe-file-actions')
  if (!actions) throw new Error('The File actions disclosure is missing.')
  actions.open = true
  const clipboard = Promise.withResolvers<void>()
  let clipboardStarted = false
  fixture.setClipboardReader(() => { clipboardStarted = true; return clipboard.promise })
  await click(buttonByText(fixture.element, 'Copy Path'))
  await waitFor(() => clipboardStarted, 'The delayed clipboard write did not start.')
  const last = makeInfo({ relativePath: 'src/last.ts', content: 'last document', revision: 3, contentRevision: 3 })
  fixture.setBuffers([last])
  fixture.setStateReader(() => stateFor([last]))
  await fixture.notify({ type: 'quirky.editor/changed' })
  await waitFor(() => editorText(fixture.element)?.textContent === 'last document', 'The second replacement document did not mount.')
  clipboard.reject(new Error('late clipboard failure'))
  await settle()

  expect(fixture.clipboardWrites).toEqual([])
  expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
  expect(apiCalls(fixture, 'quirky.editor/mutate')).toHaveLength(0)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`a stale initial hydration ${outcome} cannot replace newer text or error`, async () => {
    const pending = Promise.withResolvers<unknown>()
    let firstParams: Record<string, unknown> | null = null
    const fixture = makeFixture([makeInfo({ omitContent: true, content: 'stale text' })])
    fixture.setReadReader((attempt, params) => {
      if (attempt === 1) { firstParams = params; return pending.promise }
      return readResult('latest text', params)
    })
    await fixture.mount()
    await waitFor(() => fixture.readCalls === 1, 'The first hydration did not start.')
    const latest = makeInfo({ omitContent: true, content: 'latest text', revision: 2, contentRevision: 2 })
    fixture.setBuffers([latest])
    fixture.setStateReader(() => stateFor([latest]))
    await fixture.notify({ type: 'quirky.editor/changed' })
    await waitFor(() => editorText(fixture.element)?.textContent === 'latest text', 'The latest hydration did not replace the pending read.')

    if (outcome === 'success') pending.resolve(readResult('stale text', firstParams!))
    else pending.reject(new Error('late hydration failure'))
    await settle()
    expect(editorText(fixture.element)?.textContent).toBe('latest text')
    expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
  })
}

test('late initial hydration success or failure is ignored after unmount', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const pending = Promise.withResolvers<unknown>()
    let params: Record<string, unknown> | null = null
    const fixture = makeFixture([makeInfo({ omitContent: true, content: 'pending text' })])
    fixture.setReadReader((_attempt, readParams) => { params = readParams; return pending.promise })
    await fixture.mount()
    await waitFor(() => fixture.readCalls === 1, 'The initial hydration did not start.')
    await fixture.unmount()
    if (outcome === 'success') pending.resolve(readResult('late text', params!))
    else pending.reject(new Error('late hydration failure'))
    await settle()
    expect(document.body.contains(fixture.element)).toBe(false)
    expect(fixture.element.querySelector('.ui-inline-error')).toBeNull()
  }
})

function ExplorerIntentProbe() {
  const intent = useExplorerSearchIntent()
  return <output>{intent && JSON.stringify({ worktree: intent.worktree, query: intent.query })}</output>
}

test('the addressed source menu opens this document worktree Explorer intent', async () => {
  clearExplorerSearch()
  const fixture = makeFixture([makeInfo({ content: 'alpha\n' })])
  await fixture.mount()
  const probe = document.createElement('div')
  document.body.append(probe)
  const root = createRoot(probe)
  try {
    await act(async () => { root.render(<ExplorerIntentProbe />) })
    const identity = JSON.stringify(['b1', 't1'])
    expect(await runControl(fixture, fixture, 'menu-open', { kind: 'editor', line: 1, column: 1 }, `source:${identity}`)).toEqual({ delivered: true })
    expect(await runControl(fixture, fixture, 'search-in-files', undefined, `source-menu:${identity}`)).toEqual({ delivered: true })
    expect(probe.textContent).toBe(JSON.stringify({ worktree: 'w1', query: 'alpha' }))
    expect(fixture.panelToggles.at(-1)).toEqual({ panel: 'panel:quirky.editor/explorer', open: true })
  } finally {
    await act(async () => { root.unmount() })
    probe.remove()
    clearExplorerSearch()
  }
})

test('a forced same-revision hydration retry survives a faster state refresh with a usable editor', async () => {
  const info = makeInfo({ content: 'base', draft: 'draft survives', omitContent: true })
  const initialState = stateFor([info])
  const refreshedState = Promise.withResolvers<unknown>()
  const text = Promise.withResolvers<void>()
  const fixture = makeFixture([info])
  fixture.setStateReader((attempt) => attempt === 3 ? refreshedState.promise : initialState)
  fixture.setReadReader(async (attempt, params) => {
    if (attempt === 2) throw new Error('fixture hydrate failed')
    if (attempt >= 3) await text.promise
    return readResult('base', params)
  })
  await fixture.mount()
  const editor = editorText(fixture.element)
  expect(editor?.textContent).toBe('draft survives')
  await runControl(fixture, fixture, 'retry')
  await waitFor(() => fixture.element.querySelector('.ui-inline-error')?.textContent?.includes('fixture hydrate failed') === true, 'The forced read failure was not shown.')
  await runControl(fixture, fixture, 'retry')
  await waitFor(() => fixture.readCalls === 3, 'The repeated same-revision text read did not begin.')
  await act(async () => { refreshedState.resolve(stateFor([{ ...info }])); await Bun.sleep(0) })
  await act(async () => { text.resolve(); await Bun.sleep(0) })
  await waitFor(() => fixture.element.querySelector('.ui-inline-error') === null, 'The faster state refresh discarded the successful hydration retry.')
  expect(editorText(fixture.element)).toBe(editor)
  expect(editor?.textContent).toBe('draft survives')
})

test.each(['self', 'dispatch'] as const)('a delayed %s failure remains visible when typing changes document action availability', async (bridge) => {
  const fixture = makeFixture([makeInfo({ content: 'base' })])
  const pending = Promise.withResolvers<unknown>()
  fixture.setApiHandler('quirky.editor/draft', (params) => {
    const updated = makeInfo({ content: 'base', draft: params.content as string, dirty: true, revision: 2, contentRevision: 2 })
    fixture.setBuffers([updated])
    return updated
  })
  await fixture.mount()
  const original = controlAddress(fixture, documentTarget())
  expect(original.actions).not.toContain('save')
  if (bridge === 'self') fixture.setSelfReader(() => pending.promise)
  else fixture.setDispatchReader(() => pending.promise)
  fixture.element.querySelector<HTMLDetailsElement>('.qe-file-actions')!.open = true
  await click(buttonByText(fixture.element, 'Copy Path'))
  const view = EditorView.findFromDOM(editorText(fixture.element)!)!
  await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '+' } }) })
  await waitFor(() => controlAddress(fixture, documentTarget()).actions.includes('save'), 'Typing did not enable Save.')
  expect(controlAddress(fixture, documentTarget()).generation).toBe(original.generation)
  await act(async () => { pending.reject(new Error('fixture typing bridge failed')); await Bun.sleep(0) })
  await waitFor(() => fixture.element.querySelector('.ui-inline-error')?.textContent?.includes('fixture typing bridge failed') === true, 'Typing hid the still-live document bridge failure.')
  expect(fixture.clipboardWrites).toEqual([])
  expect(view.state.doc.toString()).toBe('base+')
})
