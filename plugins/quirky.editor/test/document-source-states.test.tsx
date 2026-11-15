import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo } from '../src/types'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'

const DOCUMENT_VIEW = 'view:quirky.editor/document'
type Handler = (...args: unknown[]) => unknown
type MountProps = { input?: unknown; report?: (state: unknown) => void }
type StateReader = (attempt: number) => unknown | Promise<unknown>
type ReadReader = (attempt: number, params: Record<string, unknown>) => unknown | Promise<unknown>
type Event = { type: string; id?: string }
type Call = { method: string; params: Record<string, unknown> }

type Fixture = {
  element: HTMLElement
  calls: Call[]
  report: Record<string, unknown>
  stateCalls: number
  readCalls: number
  setBuffers(buffers: EditorBufferInfo[]): void
  setStateReader(reader: StateReader): void
  setReadReader(reader: ReadReader): void
  setSettingFailure(message: string | null): void
  notify(event: Event): Promise<void>
  mount(input?: unknown): Promise<void>
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

let createRoot: (container: HTMLElement) => Root
let activate: typeof Activate
let deactivate: typeof Deactivate
const fixtures: Fixture[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ activate, deactivate } = await import('../src/ui'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.unmount()
  deactivate()
  document.body.replaceChildren()
})

function makeInfo(options: {
  content?: string
  omitContent?: boolean
  draft?: string | null
  draftLength?: number | null
  external?: EditorBufferInfo['external']
  diskWritable?: boolean
  dirty?: boolean
  revision?: number
  contentRevision?: number
} = {}): EditorBufferInfo {
  const content = options.content ?? 'fixture text'
  const draft = options.draft ?? null
  const draftLength = options.draftLength ?? draft?.length ?? null
  return {
    id: 'b1',
    worktreeId: 'w1',
    root: '/fixture',
    path: '/fixture/src/a.ts',
    relativePath: 'src/a.ts',
    name: 'a.ts',
    kind: 'text',
    ...(options.omitContent ? {} : { content }),
    ...(options.draft === undefined ? {} : { draft: options.draft }),
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: options.diskWritable ?? true,
    dirty: options.dirty ?? (draft !== null || (draftLength !== null && draftLength > 0)),
    external: options.external ?? null,
    mode: 'source',
    tabId: 't1',
    preview: false,
    pinned: false,
    untitled: false,
    revision: options.revision ?? 1,
    contentRevision: options.contentRevision ?? 1,
    view: {},
    error: null,
    contentLength: content.length,
    draftLength,
    diskContentLength: null,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
    diskContentBytes: null,
    diskSignature: null
  }
}

function stateFor(buffers: EditorBufferInfo[]): Record<string, unknown> {
  return {
    buffers,
    tabs: [{ tabId: 't1', bufferId: 'b1', mode: 'edit' }],
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
  let buffers = initialBuffers
  let stateCalls = 0
  let readCalls = 0
  let settingFailure: string | null = null
  let stateReader: StateReader = () => stateFor(buffers)
  let readReader: ReadReader = (_attempt, params) => readResult('', params)
  let disposeView: (() => void) | undefined
  const element = document.createElement('div')
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
      if (method === 'ui.window.self') return { connId: 22 }
      if (method === 'ui.window.command.run') {
        const handler = provided.get(String(params.id))
        if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.editor/state') return await stateReader(++stateCalls)
      if (method === 'quirky.editor/read') return await readReader(++readCalls, params)
      if (method === 'ui.panel.configure') return {}
      return {}
    },
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection: () => () => {},
    getSetting(name: string) {
      if (settingFailure) throw new Error(settingFailure)
      return SETTINGS[name]
    },
    getLayout: () => ({ worktree: 'w1', view: null, panel: null, sidebar: true, focus: 'view' }),
    setContext() {},
    toast() {},
    togglePanel() {},
    async executeCommand(command: string) { throw new Error(`Unexpected executeCommand: ${command}`) }
  } as unknown as UiPluginContext

  activate(context)

  const fixture: Fixture = {
    element,
    calls,
    get report() { return report },
    get stateCalls() { return stateCalls },
    get readCalls() { return readCalls },
    setBuffers(value) { buffers = value },
    setStateReader(reader) { stateReader = reader },
    setReadReader(reader) { readReader = reader },
    setSettingFailure(message) { settingFailure = message },
    async notify(event) { await act(async () => { for (const listener of [...listeners]) listener(event) }) },
    async mount(input = { bufferId: 'b1', tabId: 't1', mode: 'source' }) {
      const mount = provided.get(DOCUMENT_VIEW)
      if (!mount) throw new Error('activate did not provide the document mount.')
      await act(async () => {
        disposeView = mount(element, { input, report: (value) => { report = value as Record<string, unknown> } } satisfies MountProps) as () => void
      })
      fixtures.push(fixture)
      await settle()
    },
    async unmount() {
      if (!disposeView) return
      await act(async () => { disposeView?.() })
      disposeView = undefined
      listeners.clear()
      element.remove()
    }
  }
  return fixture
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
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
  await act(async () => { button.click(); await Promise.resolve() })
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
  fixture.setBuffers([blank])
  await click(buttonByText(empty, 'Retry'))
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
  await click(buttonByText(error, 'Retry'))
  await waitFor(() => editorText(fixture.element) !== null, 'Retry did not restore the document.')
  expect(fixture.stateCalls).toBe(2)
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

  const error = expectInlineError(fixture.element, 'fixture hydrate failed')
  await click(buttonByText(error, 'Retry'))
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
  await click(buttonByText(fixture.element, 'Compare local text'))
  await waitFor(() => fixture.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea').length === 2, 'Compare did not open.')

  expect([...fixture.element.querySelectorAll<HTMLTextAreaElement>('.qe-compare-textarea')].map((textarea) => textarea.value))
    .toEqual(['shared draft', 'local draft'])
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
