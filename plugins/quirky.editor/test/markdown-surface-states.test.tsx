import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import { createEditorUiControlReportScope, EditorUiControlProvider } from '../src/window/uiControl'
import type { EditorUiControlAddress } from '../src/window/uiControl'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'

type Call = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type ControlReport = { uiControls?: EditorUiControlAddress[]; [key: string]: unknown }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
type MountedSurface = {
  element: HTMLElement
  call: Call
  calls: { method: string; params: Record<string, unknown> }[]
  address(kind: string): EditorUiControlAddress | undefined
  report(): ControlReport
  commands(): Parameters<SurfaceProps['registerCommandHandlers']>[0] | undefined
  control(kind: string, action: string, data?: Record<string, unknown>): Promise<unknown>
  update(buffer: Partial<EditorSurfaceBuffer>): Promise<void>
  unmount(): Promise<void>
}
type Mode = EditorSurfaceBuffer['mode']

const SURFACE = 'view:quirky.editor/document'
let createRoot: (container: HTMLElement) => Root
let MarkdownSurface: ComponentType<SurfaceProps>
let mounted: MountedSurface[]
let activate: typeof Activate
let deactivate: typeof Deactivate
let provided: Map<string, (...args: unknown[]) => unknown>

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Register Happy DOM before importing React DOM and TipTap, which capture browser APIs.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownSurface } = await import('../src/markdown/MarkdownSurface'))
  ;({ activate, deactivate } = await import('../src/ui'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => {
  mounted = []
  provided = new Map()
  activate({
    pluginId: 'quirky.editor',
    provide(id: string, handler: (...args: unknown[]) => unknown) { provided.set(id, handler) },
    call: async () => ({}), subscribe: () => () => {},
    getSetting: () => 300, getLayout: () => ({ worktree: 'w1' }), toast() {}
  } as unknown as UiPluginContext)
})
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  deactivate()
  document.body.innerHTML = ''
})

function makeBuffer(mode: Mode, content: string, patch: Partial<EditorSurfaceBuffer> = {}): EditorSurfaceBuffer {
  return {
    id: 'buffer-markdown-states', worktreeId: 'wt-markdown-states', root: '/tmp/markdown-states',
    path: '/tmp/markdown-states/sample.md', relativePath: 'sample.md', name: 'sample.md', kind: 'markdown',
    content, draft: null, baseline: null, size: content.length, readOnly: false, dirty: false, external: null,
    mode, tabId: 'tab-markdown-states', preview: false, pinned: false, untitled: false, revision: 1,
    contentRevision: 1, view: {}, error: null, diskContentLength: null, diskContentBytes: null, diskSignature: null,
    ...patch
  }
}

async function renderSurface(
  mode: Mode,
  options: { content?: string; buffer?: Partial<EditorSurfaceBuffer>; call?: Call; connId?: number } = {}
): Promise<MountedSurface> {
  const defaults: Call = async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
      return params.includePreview ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
    }
    if (method === 'quirky.editor/markdown' && params.action === 'toc') return { headings: [] }
    if (method === 'quirky.editor/markdown' && params.action === 'documents') return { documents: [], total: 0 }
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return { templates: [] }
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    return {}
  }
  const calls: MountedSurface['calls'] = []
  const delegate = options.call ?? defaults
  const call: Call = async (method, params) => {
    calls.push({ method, params })
    if (method === 'ui.window.self') return { connId: options.connId ?? 22 }
    if (method === 'ui.window.command.run') {
      if (params.connId !== (options.connId ?? 22)) throw new Error('Control reached the wrong window.')
      const handler = provided.get(String(params.id))
      if (!handler) throw new Error('The activated command handler is missing.')
      return { result: await handler(params.args) }
    }
    return delegate(method, params)
  }
  const context = { pluginId: 'quirky.editor', call } as unknown as UiPluginContext
  let commands: Parameters<SurfaceProps['registerCommandHandlers']>[0] | undefined
  const props: SurfaceProps = {
    context, buffer: makeBuffer(mode, options.content ?? '# Existing heading\n\nDocument body.', options.buffer),
    fontSize: 13, onDraft() {}, onAction: async (method, params) => call(method, params), onView() {},
    registerCommandHandlers(handlers) { commands = handlers; return () => { if (commands === handlers) commands = undefined } }
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let report: ControlReport = {}
  const scope = createEditorUiControlReportScope((value) => { report = value as typeof report }, { surface: SURFACE, context })
  scope.report({ mounted: true, bufferId: props.buffer.id, tabId: props.buffer.tabId, mode, sibling: 'retained' })
  let buffer = props.buffer
  const render = () => root.render(<EditorUiControlProvider scope={scope}><MarkdownSurface {...props} buffer={buffer} /></EditorUiControlProvider>)
  await act(async () => { render() })
  let unmounted = false
  const surface: MountedSurface = {
    element, call, calls,
    address: (kind) => report.uiControls?.find(({ target }) => target.startsWith(`markdown-${kind}:`)),
    report: () => report,
    commands: () => commands,
    async control(kind, action, data) {
      const address = surface.address(kind)
      if (!address) throw new Error(`No current Markdown ${kind} registration.`)
      let result: unknown
      await act(async () => {
        result = await provided.get('command:quirky.editor/ui-control')!({
          surface: address.surface, target: address.target, generation: address.generation, action,
          ...(data === undefined ? {} : { data })
        })
      })
      return result
    },
    async update(patch) {
      buffer = { ...buffer, ...patch }
      await act(async () => { render() })
    },
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
      scope.dispose()
    }
  }
  mounted.push(surface)
  return surface
}

async function waitFor<T>(condition: () => T | null | undefined | false, description: string): Promise<T> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    let result: T | null | undefined | false
    await act(async () => { result = condition() })
    if (result !== null && result !== undefined && result !== false) return result as T
    await act(async () => { await Bun.sleep(10) })
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function button(root: ParentNode, text: string): HTMLButtonElement | undefined { return [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text) }
async function click(root: ParentNode, text: string): Promise<void> {
  const target = button(root, text)
  if (!target) throw new Error(`Could not find button “${text}”.`)
  await act(async () => { target.click() })
}
async function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('The DOM input value setter is unavailable.')
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
function errorMessage(root: ParentNode, message: string): HTMLElement | null { return [...root.querySelectorAll<HTMLElement>('.ui-inline-error__message')].find((item) => item.textContent === message) ?? null }
function notice(root: ParentNode, message: string): HTMLElement | null { return [...root.querySelectorAll<HTMLElement>('.ui-notice-line')].find((item) => item.textContent?.includes(message)) ?? null }
function emptyState(root: ParentNode, message: string): HTMLElement | null { return [...root.querySelectorAll<HTMLElement>('.ui-empty-state__message')].find((item) => item.textContent === message) ?? null }

test('source capability reads show shared pending and failure states, then Retry clears the failure', async () => {
  const initial = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('source', { content: '', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
      reads += 1
      return reads === 1 ? initial.promise : { richEligible: true }
    }
    return {}
  } })
  const source = surface.element.querySelector('.markdown-surface--source')!
  expect(source.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Checking rich editor availability…')
  expect(source.querySelector('textarea[aria-label="Markdown source"]')).not.toBeNull()
  expect(source.querySelector('.ui-empty-state')).toBeNull()
  expect(source.querySelector('.ui-inline-error')).toBeNull()

  initial.reject(new Error('fixture capabilities failed'))
  await waitFor(() => errorMessage(source, 'fixture capabilities failed'), 'source capability error')
  const alert = source.querySelector<HTMLElement>('.ui-inline-error')!
  expect(alert.querySelector('button')?.textContent?.trim()).toBe('Retry')
  await act(async () => { alert.querySelector('button')!.click() })
  await waitFor(() => button(source, 'Rich Editor'), 'successful rich eligibility retry')
  expect(source.querySelector('.ui-inline-error')).toBeNull()
})

test('preview capability reads show NoticeLine, one owning InlineError with recovery, and retry the read', async () => {
  const initial = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities' && params.includePreview) {
      reads += 1
      if (reads === 1) return initial.promise
      if (reads === 2) return { previewAvailable: false, previewReason: 'fixture preview unavailable' }
      if (reads === 3) return { previewAvailable: false }
      return { previewAvailable: true, imageUrls: {} }
    }
    return {}
  } })
  const preview = surface.element.querySelector('.markdown-surface--preview')!
  expect(preview.querySelector('[role="status"] .ui-notice-line')?.textContent).toContain('Preparing preview…')
  initial.reject(new Error('fixture preview failed'))
  await waitFor(() => errorMessage(preview, 'fixture preview failed'), 'preview capability error')
  const errors = preview.querySelectorAll('.ui-inline-error')
  expect(errors).toHaveLength(1)
  expect(button(errors[0]!, 'Retry')).toBeDefined()
  expect(button(preview, 'Open source')).toBeDefined()
  await act(async () => { button(errors[0]!, 'Retry')!.click() })
  await waitFor(() => errorMessage(preview, 'fixture preview unavailable'), 'preview unavailable reason')
  await click(preview, 'Retry')
  await waitFor(() => errorMessage(preview, 'This document cannot be rendered within the preview limits.'), 'preview unavailable fallback')
  await click(preview, 'Retry')
  await waitFor(() => preview.querySelector('.markdown-preview-body'), 'successful preview retry')
  expect(preview.querySelector('.ui-inline-error')).toBeNull()
})
test('source eligibility stays advisory and an ineligible Open anyway result keeps source editing available', async () => {
  const calls: Record<string, unknown>[] = []
  const opens: Record<string, unknown>[] = []
  const views: Record<string, unknown>[] = []
  const surface = await renderSurface('source', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
      calls.push(params)
      if (calls.length === 1) return { richEligible: false, richReason: 'This file exceeds 600 MB.', openAnywayAvailable: true }
      return calls.length === 2 ? { richEligible: false } : { richEligible: true }
    }
    if (method === 'quirky.editor/open') opens.push(params)
    if (method === 'quirky.editor/view') views.push(params)
    return {}
  } })
  const source = surface.element.querySelector('.markdown-surface--source')!
  await waitFor(() => button(source, 'Open anyway'), 'advisory Open anyway action')
  expect(source.querySelector('.ui-inline-error')).toBeNull()
  await click(source, 'Open anyway')
  await waitFor(() => errorMessage(source, 'This document cannot be safely opened in rich mode. Continue editing in source mode.'), 'ineligible Open anyway result')
  expect(calls[1]).toMatchObject({ openAnyway: true })
  expect(source.querySelector('textarea[aria-label="Markdown source"]')).not.toBeNull()
  await click(source, 'Open Markdown Preview')
  expect(opens).toEqual([{ worktree: 'id:wt-markdown-states', path: 'sample.md', mode: 'preview', focus: false }])
  await surface.update({ contentRevision: 2, revision: 2 })
  await waitFor(() => button(source, 'Rich Editor'), 'eligible Rich Editor action')
  await click(source, 'Rich Editor')
  await waitFor(() => views.length === 1 ? views[0] : undefined, 'rich-mode view update')
  expect(calls).toHaveLength(4)
  expect(views[0]).toMatchObject({ bufferId: 'buffer-markdown-states', action: 'update', patch: { mode: 'rich', markdownOpenAnyway: false } })
})

test('preview capabilities from an older revision cannot replace the newer rendered preview', async () => {
  const requests: Deferred<unknown>[] = []
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities' && params.includePreview) {
      const request = deferred<unknown>()
      requests.push(request)
      return request.promise
    }
    return {}
  } })
  await waitFor(() => requests.length === 1 ? requests[0] : undefined, 'first preview read')
  await surface.update({ content: '# Revision 2', contentRevision: 2, revision: 2 })
  await waitFor(() => requests.length === 2 ? requests[1] : undefined, 'second preview read')
  await act(async () => { requests[1]!.resolve({ previewAvailable: true, imageUrls: {} }) })
  const article = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-preview-body'), 'revision 2 preview')
  expect(article.textContent).toContain('Revision 2')
  await act(async () => { requests[0]!.resolve({ previewAvailable: false, previewReason: 'obsolete unavailable' }) })
  expect(surface.element.querySelector('.markdown-preview-body')?.textContent).toContain('Revision 2')
  expect(surface.element.textContent).not.toContain('obsolete unavailable')
})

async function openSearch(surface: MountedSurface, mode: 'preview' | 'rich'): Promise<HTMLElement> {
  await click(surface.element, mode === 'preview' ? 'Find in preview' : 'Find')
  return waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-toolbar--search'), `${mode} Find area`)
}

for (const mode of ['preview', 'rich'] as const) {
  test(`${mode} Find shows EmptyState only for a completed nonempty query and clears it with the query`, async () => {
    const pendingSearch = deferred<unknown>()
    const surface = await renderSurface(mode, {
      content: 'The document remains visible.',
      call: async (method, params) => {
        if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
          return params.includePreview ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
        }
        if (method === 'quirky.editor/markdown' && params.action === 'search') return mode === 'preview' ? pendingSearch.promise : { total: 0, matches: [] }
        return {}
      }
    })
    const find = await openSearch(surface, mode)
    expect(emptyState(find, 'No results')).toBeNull()
    const input = find.querySelector<HTMLInputElement>('input[aria-label=\"Find in preview\"], input[aria-label=\"Find in rich editor\"]')!
    await setValue(input, 'missing')
    expect(emptyState(find, 'No results')).toBeNull()
    await click(find, 'Find')
    if (mode === 'preview') {
      expect(emptyState(find, 'No results')).toBeNull()
      await act(async () => { pendingSearch.resolve({ total: 0, matches: [] }) })
    }
    await waitFor(() => emptyState(find, 'No results'), 'completed empty search')
    expect(surface.element.textContent).toContain('The document remains visible.')
    await setValue(input, '')
    await waitFor(() => emptyState(find, 'No results') === null ? find : undefined, 'cleared search result')
  })

  for (const success of [true, false]) {
    test(`${mode} Replace ${success ? 'success' : 'failure'} stays ${success ? 'non-error feedback' : 'InlineError with drafts retained'}`, async () => {
      const surface = await renderSurface(mode, { call: async (method, params) => {
        if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
          return params.includePreview ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
        }
        if (method === 'quirky.editor/markdown' && params.action === 'search') return { total: 0, matches: [] }
        if (method === 'quirky.editor/markdown' && params.action === 'replace') {
          if (!success) throw new Error('fixture replace failed')
          return { replacements: 2 }
        }
        return {}
      } })
      const find = await openSearch(surface, mode)
      const query = find.querySelector<HTMLInputElement>('input[aria-label=\"Find in preview\"], input[aria-label=\"Find in rich editor\"]')!
      await setValue(query, 'missing')
      await click(find, 'Replace')
      const replacement = await waitFor(() => find.querySelector<HTMLInputElement>('input[aria-label=\"Replace with\"]'), 'replacement field')
      await setValue(replacement, 'retained replacement')
      await click(find, 'Replace all')
      if (success) {
        await waitFor(() => [...surface.element.querySelectorAll<HTMLElement>('[role=\"status\"]')].find((item) => item.textContent?.includes('2 replacement(s)')), 'successful replacement feedback')
        expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
        expect(surface.element.querySelector('[role=\"alert\"]')?.textContent ?? '').not.toContain('2 replacement(s)')
      } else {
        await waitFor(() => errorMessage(surface.element, 'fixture replace failed'), 'replacement error')
        expect(query.value).toBe('missing')
        expect(replacement.value).toBe('retained replacement')
        expect([...surface.element.querySelectorAll('[role=\"status\"]')].some((item) => item.textContent?.includes('fixture replace failed'))).toBe(false)
      }
    })
  }
}

test('review notes show pending, error with Retry, then a settled empty state in their owning panel', async () => {
  const initial = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('rich', { call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return ++reads === 1 ? initial.promise : { notes: [] }
    return {}
  } })
  const toggle = await waitFor(() => button(surface.element, 'Review notes (0)'), 'Review notes control')
  await act(async () => { toggle.click() })
  const panel = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-review-notes'), 'review notes panel')
  expect(notice(panel, 'Loading review notes…')).not.toBeNull()
  initial.reject(new Error('fixture notes failed'))
  await waitFor(() => errorMessage(panel, 'fixture notes failed'), 'notes read error')
  await click(panel, 'Retry')
  await waitFor(() => emptyState(panel, 'No review notes.'), 'settled empty notes')
})

test('TOC uses a pending NoticeLine, reports read failures, and renders settled empty headings', async () => {
  const initial = deferred<unknown>()
  let reads = 0
  let headingVisible = false
  const surface = await renderSurface('rich', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'toc') {
      if (typeof params.visible === 'boolean') return {}
      return ++reads === 1 ? initial.promise : { headings: headingVisible ? [{ id: 'real-heading', text: 'Real heading', level: 1, line: 1 }] : [] }
    }
    return {}
  } })
  await click(surface.element, 'TOC')
  const panel = await waitFor(() => surface.element.querySelector<HTMLElement>('[aria-label=\"Table of Contents\"]'), 'TOC panel')
  expect(notice(panel, 'Loading headings…')).not.toBeNull()
  initial.reject(new Error('fixture headings failed'))
  await waitFor(() => errorMessage(panel, 'fixture headings failed'), 'TOC read error')
  await click(panel, 'Retry')
  await waitFor(() => emptyState(panel, 'No headings'), 'settled empty TOC')
  await click(surface.element, 'TOC')
  headingVisible = true
  await click(surface.element, 'TOC')
  const reopened = await waitFor(() => surface.element.querySelector<HTMLElement>('[aria-label="Table of Contents"]'), 'reopened TOC panel')
  await waitFor(() => button(reopened, 'Real heading'), 'loaded heading')
  await act(async () => { reopened.querySelector<HTMLInputElement>('input[aria-label="Show H1"]')!.click() })
  await waitFor(() => emptyState(reopened, 'No headings'), 'filtered empty TOC')
})

async function typeRichText(editor: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    editor.focus()
    const block = editor.querySelector('p') ?? editor
    const selection = window.getSelection()
    if (!selection) throw new Error('The document selection is unavailable.')
    const range = document.createRange()
    range.selectNodeContents(block)
    range.collapse(block.textContent === '')
    selection.removeAllRanges()
    selection.addRange(range)
    const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
    if (!editor.dispatchEvent(beforeInput)) return
    const active = window.getSelection()
    if (!active?.rangeCount) throw new Error('The editor lost its text cursor.')
    const activeRange = active.getRangeAt(0)
    activeRange.deleteContents()
    const textNode = document.createTextNode(text)
    activeRange.insertNode(textNode)
    activeRange.setStartAfter(textNode)
    activeRange.collapse(true)
    active.removeAllRanges()
    active.addRange(activeRange)
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  })
}

test('document completions show loading, report errors, and settle to No documents found', async () => {
  const initial = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('rich', { content: '', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'documents') return ++reads === 1 ? initial.promise : { documents: [], total: 0 }
    return {}
  } })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'real rich editor')
  await typeRichText(editor, '[[Guide')
  const menu = await waitFor(() => surface.element.querySelector<HTMLElement>('[role=\"dialog\"][aria-label=\"Markdown document links\"]'), 'document completion panel')
  expect(notice(menu, 'Finding Markdown documents…')).not.toBeNull()
  initial.reject(new Error('fixture documents failed'))
  await waitFor(() => errorMessage(menu, 'fixture documents failed'), 'document completion error')
  await click(menu, 'Retry')
  await waitFor(() => emptyState(menu, 'No documents found'), 'settled empty document completion')
})
test('New Markdown opens during inventory loading, retains drafts through failure, and keeps blank creation available', async () => {
  const initial = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('rich', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return ++reads === 1 ? initial.promise : { templates: [] }
    return {}
  } })
  await click(surface.element, 'New Markdown')
  const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'), 'immediate New Markdown dialog')
  expect(notice(dialog, 'Loading Markdown templates…')).not.toBeNull()
  expect(button(dialog, 'Cancel')).toBeDefined()
  const title = dialog.querySelector<HTMLInputElement>('input[placeholder="Title"]')!
  const filter = dialog.querySelector<HTMLInputElement>('input[placeholder="Search templates…"]')!
  await setValue(title, 'Draft title')
  await setValue(filter, 'Draft filter')
  initial.reject(new Error('fixture templates failed'))
  await waitFor(() => errorMessage(dialog, 'fixture templates failed'), 'template inventory error')
  await click(dialog, 'Retry')
  await waitFor(() => emptyState(dialog, 'No Markdown templates.'), 'settled empty template inventory')
  expect(title.value).toBe('Draft title')
  expect(filter.value).toBe('Draft filter')
  expect(button(dialog, 'Blank Markdown (untitled.md)')).toBeDefined()
})

test('a loaded template inventory filtered to zero says No matching templates and still offers blank Markdown', async () => {
  const surface = await renderSurface('rich', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') {
      return { templates: [{ relativePath: 'templates/weekly.md', title: 'Weekly' }] }
    }
    return {}
  } })
  await click(surface.element, 'New Markdown')
  const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'), 'New Markdown dialog')
  await waitFor(() => button(dialog, 'Weekly — templates/weekly.md'), 'loaded template')
  const filter = dialog.querySelector<HTMLInputElement>('input[placeholder="Search templates…"]')!
  await setValue(filter, 'no match')
  expect(emptyState(dialog, 'No matching templates.')).not.toBeNull()
  expect(emptyState(dialog, 'No Markdown templates.')).toBeNull()
  expect(button(dialog, 'Blank Markdown (untitled.md)')).toBeDefined()
})

for (const kind of ['export', 'clipboard'] as const) {
  for (const succeeds of [false, true]) {
    test(`rich ${kind} ${succeeds ? 'success' : 'failure'} uses ${succeeds ? 'status' : 'InlineError'}`, async () => {
      const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      const writes: string[] = []
      if (kind === 'clipboard') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
        if (!succeeds) throw new Error('fixture clipboard failed')
        writes.push(text)
      } } })
      try {
        const surface = await renderSurface('rich', { call: async (method, params) => {
          if (kind === 'export' && method === 'quirky.editor/markdown' && params.action === 'exportPdf') {
            if (!succeeds) throw new Error('fixture export failed')
            return { path: '/fixture/out.pdf' }
          }
          if (kind === 'clipboard' && method === 'quirky.editor/notes' && params.action === 'copy') return { text: 'review notes', count: 1 }
          return {}
        } })
        await waitFor(() => surface.element.querySelector('.ProseMirror'), 'real rich editor')
        if (kind === 'export') await click(surface.element, 'Export PDF')
        else {
          await click(surface.element, 'Review notes (0)')
          const panel = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-review-notes'), 'review notes panel')
          await click(panel, 'Copy notes for agent')
        }
        const message = succeeds
          ? kind === 'export' ? 'Exported PDF to /fixture/out.pdf.' : 'Copied notes for agent.'
          : kind === 'export' ? 'fixture export failed' : 'fixture clipboard failed'
        if (succeeds) {
          await waitFor(() => [...surface.element.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent?.includes(message)), `${kind} feedback`)
          expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
          if (kind === 'clipboard') expect(writes).toEqual(['review notes'])
        } else {
          await waitFor(() => errorMessage(surface.element, message), `${kind} failure`)
          expect([...surface.element.querySelectorAll('[role="status"]')].some((item) => item.textContent?.includes(message))).toBe(false)
        }
      } finally {
        if (kind === 'clipboard') {
          if (previous) Object.defineProperty(navigator, 'clipboard', previous)
          else Reflect.deleteProperty(navigator, 'clipboard')
        }
      }
    })
  }
}

test('empty slash filtering renders No blocks found inside the real rich editor', async () => {
  const surface = await renderSurface('rich', { content: '' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'real rich editor')
  await typeRichText(editor, '/no-such-block')
  await waitFor(() => surface.element.querySelector('[role="dialog"][aria-label="Slash commands"]')?.textContent?.includes('No blocks found'), 'empty slash results')
  expect(editor.textContent).toContain('/no-such-block')
})

test('emoji lazy import failure and retry run in an isolated child with real TipTap', async () => {
  const child = Bun.spawn([process.execPath, '-'], { cwd: resolve(import.meta.dir, '..'),
    stdin: new TextEncoder().encode(String.raw`import assert from 'node:assert/strict'
import React, { act } from 'react'
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register(); globalThis.IS_REACT_ACT_ENVIRONMENT = true
const failedImport = Promise.withResolvers(); mock.module('emoji-picker-react', () => failedImport.promise)
// Register Happy DOM before importing React DOM and the real TipTap surface.
const { createRoot } = await import('react-dom/client'), { MarkdownSurface } = await import('./src/markdown/MarkdownSurface'), ui = await import('./src/window/uiControl')
const provided = new Map(), { activate, deactivate } = await import('./src/ui')
const context = { pluginId: 'quirky.editor', provide: (id, handler) => provided.set(id, handler), subscribe: () => () => {}, getSetting: () => 300, toast() {}, async call(method, params) { if (method === 'ui.window.self') return { connId: 22 }; if (method === 'ui.window.command.run') return { result: await provided.get(params.id)(params.args) }; if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }; if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }; return {} } }
activate(context)
const buffer = { id: 'emoji', worktreeId: 'wt', root: '/tmp', path: '/tmp/emoji.md', relativePath: 'emoji.md', name: 'emoji.md', kind: 'markdown', content: '', draft: null, baseline: null, size: 0, readOnly: false, dirty: false, external: null, mode: 'rich', tabId: 'tab', preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null, diskContentLength: null, diskContentBytes: null, diskSignature: null }
const props = { context, buffer, fontSize: 13, onDraft() {}, onAction: context.call, onView() {}, registerCommandHandlers() { return () => {} } }
const host = document.createElement('div'), root = createRoot(host), scope = ui.createEditorUiControlReportScope(undefined, { surface: 'view:quirky.editor/document', context })
const wait = async predicate => { for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await Bun.sleep(5) } throw Error('fixture timed out') }
const click = async label => { const target = [...host.querySelectorAll('button')].find(item => item.textContent.trim() === label); assert.ok(target, 'missing ' + label); await act(async () => target.click()) }
try {
  await act(async () => root.render(React.createElement(ui.EditorUiControlProvider, { scope }, React.createElement(MarkdownSurface, props))))
  await wait(() => host.querySelector('.ProseMirror'))
  await click('More blocks ▾'); await click('Emoji')
  const picker = await wait(() => host.querySelector('[role=\"dialog\"][aria-label=\"Emoji picker\"]'))
  assert.equal(picker.querySelector('.ui-notice-line')?.textContent, 'Loading native emoji picker…')
  failedImport.reject(Error('fixture emoji failed'))
  const error = await wait(() => picker.querySelector('.ui-inline-error__message'))
  assert.equal(error.textContent, 'Could not load the emoji picker: fixture emoji failed')
  mock.module('emoji-picker-react', () => ({ default: () => React.createElement('span', null, 'native picker'), EmojiStyle: { NATIVE: 'native' } }))
  await click('Retry'); await wait(() => host.textContent.includes('native picker'))
  assert.equal(host.querySelector('.ui-inline-error'), null)
} finally {
  await act(async () => root.unmount()); scope.dispose(); deactivate(); await GlobalRegistrator.unregister()
}
`),
    stdout: 'pipe', stderr: 'pipe'
  })
  const killTimer = setTimeout(() => child.kill(), 25_000)
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (status !== 0) throw new Error(`Isolated emoji scenario failed (${status}):\n${stdout}\n${stderr}`)
  } finally {
    clearTimeout(killTimer)
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
}, 30_000)

test('empty rich Markdown remains a working TipTap editor instead of an EmptyState', async () => {
  const surface = await renderSurface('rich', { content: '' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'empty rich editor')
  expect(editor.getAttribute('aria-label')).toBe('Rich Markdown editor')
  expect(surface.element.querySelector('.ui-empty-state')).toBeNull()
})
test('rich editor initialization renders shared pending state before TipTap is ready', async () => {
  // SSR deterministically observes the actual useEditor({ immediatelyRender: false }) pending branch.
  const { renderToString } = await import('react-dom/server')
  const call: Call = async () => ({ richEligible: true })
  const context = { pluginId: 'quirky.editor', call } as unknown as UiPluginContext
  const props: SurfaceProps = { context, buffer: makeBuffer('rich', ''), fontSize: 13, onDraft() {}, onAction: call, onView() {}, registerCommandHandlers() { return () => {} } }
  const scope = createEditorUiControlReportScope(undefined, { surface: SURFACE, context })
  const host = document.createElement('div'); host.innerHTML = renderToString(<EditorUiControlProvider scope={scope}><MarkdownSurface {...props} /></EditorUiControlProvider>)
  expect(notice(host, 'Preparing rich editor…')).not.toBeNull()
  expect(host.querySelector('.ProseMirror')).toBeNull()
  scope.dispose()
})

async function selectRichText(surface: MountedSurface, text: string): Promise<void> {
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich editor')
  await act(async () => {
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    let start = -1
    while (node) {
      start = node.textContent?.indexOf(text) ?? -1
      if (start >= 0) break
      node = walker.nextNode() as Text | null
    }
    if (!node || start < 0) throw new Error(`Missing selectable rich text: ${text}`)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + text.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
}

for (const mode of ['source', 'preview', 'rich'] as const) {
  test(`${mode} registers only its mounted Markdown mode through the activated command`, async () => {
    const surface = await renderSurface(mode, { buffer: { id: 'b1', tabId: 't1' } })
    const address = await waitFor(() => surface.address(mode), `${mode} control`)
    expect(address.target).toBe(`markdown-${mode}:["b1","t1"]`)
    expect(address.surface).toBe(SURFACE)
    for (const other of ['source', 'preview', 'rich'].filter((value) => value !== mode)) expect(surface.address(other)).toBeUndefined()
    expect(surface.report()).toMatchObject({ mounted: true, bufferId: 'b1', tabId: 't1', sibling: 'retained' })
    const before = surface.calls.length
    expect(await surface.control(mode, 'unknown')).toEqual({ delivered: false })
    expect(surface.calls).toHaveLength(before)
  })
}
const MARKDOWN_UI_CONTROL = 'command:quirky.editor/ui-control'
const DOCUMENT_VIEW = 'view:quirky.editor/document'

test('live Markdown popups advertise only their current addressed operations', async () => {
  const rich = await renderSurface('rich', { content: '' })
  await waitFor(() => rich.address('rich'), 'rich base control')
  await rich.control('rich', 'find')
  const search = await waitFor(() => rich.address('search'), 'search control')
  expect(search.actions).toEqual(expect.arrayContaining(['find', 'previous', 'next', 'options', 'replace-toggle', 'close']))
  await rich.control('search', 'replace-toggle', { open: true })
  const replacementAddress = await waitFor(() => rich.address('search'), 'replace search actions')
  expect(replacementAddress.actions).toEqual(expect.arrayContaining(['replace-one', 'replace-all']))
  await rich.control('search', 'close')
  await waitFor(() => rich.address('search') ? undefined : true, 'closed search control')

  await rich.control('rich', 'more', { open: true })
  const more = await waitFor(() => rich.address('more'), 'More blocks control')
  expect(more.actions).toEqual(expect.arrayContaining(['choose', 'close']))
  await rich.control('more', 'close')

  const slash = await renderSurface('rich', { content: '' })
  const slashEditor = await waitFor(() => slash.element.querySelector<HTMLElement>('.ProseMirror'), 'slash editor')
  await typeRichText(slashEditor, '/h1')
  const slashAddress = await waitFor(() => slash.address('slash'), 'slash control')
  expect(slashAddress.actions).toEqual(expect.arrayContaining(['choose', 'close']))

  const documents = await renderSurface('rich', { content: '', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'documents') return { documents: [{ relativePath: 'guide.md', name: 'guide.md' }], total: 1 }
    return {}
  } })
  const documentEditor = await waitFor(() => documents.element.querySelector<HTMLElement>('.ProseMirror'), 'document-link editor')
  await typeRichText(documentEditor, '[[Guide')
  const documentsAddress = await waitFor(() => documents.address('documents'), 'document-completion control')
  expect(documentsAddress.actions).toEqual(expect.arrayContaining(['choose', 'close']))

  const link = await renderSurface('rich', { content: 'alpha' })
  await selectRichText(link, 'alpha')
  await link.control('selection', 'format', { value: 'link' })
  const linkAddress = await waitFor(() => link.address('link'), 'link popup control')
  expect(linkAddress.actions).toEqual(expect.arrayContaining(['open', 'copy', 'save', 'remove', 'close']))
})

test('an activated document mount preserves its report and parent controls beside Markdown controls', async () => {
  provided = new Map()
  const contextCalls: { method: string; params: Record<string, unknown> }[] = []
  const viewCalls: Record<string, unknown>[] = []
  const content = '# Activated document\n\nBody.'
  const info = {
    ...makeBuffer('rich', content, {
      id: 'activated-b1', tabId: 'activated-t1', worktreeId: 'activated-w1',
      root: '/tmp/activated', path: '/tmp/activated/guide.md', relativePath: 'guide.md', name: 'guide.md'
    }),
    contentLength: content.length,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftLength: null,
    draftBytes: null,
    diskWritable: true
  }
  const state = {
    buffers: [info], tabs: [{ bufferId: info.id, tabId: info.tabId, mode: 'edit' }],
    explorer: { worktreeId: info.worktreeId, showDotfiles: false, expanded: [] },
    search: null, quickOpenHistory: [], closeRequests: []
  }
  const settings: Record<string, unknown> = {
    editorAutoSave: false, editorAutoSaveDelayMs: 1000, editorWordWrap: false, editorFontFamily: 'monospace',
    editorPreviewTabsEnabled: true, richMarkdownSpellcheckEnabled: false, markdownReviewToolsEnabled: false,
    showGitIgnoredFiles: false, followSymlinkedDirectories: false, editorFontZoomLevel: 0,
    editorMinimapEnabled: false, editorSidebarWidth: 320
  }
  const context: UiPluginContext = {
    pluginId: 'quirky.editor',
    provide(id, handler) { provided.set(id, handler as (...args: unknown[]) => unknown) },
    async call(method, params = {}) {
      contextCalls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 11 }
      if (method === 'ui.window.command.run') {
        const handler = provided.get(String(params.id))
        if (!handler) throw new Error('The activated window command is missing.')
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.editor/state') return state
      if (method === 'quirky.editor/read') return { text: content.slice(Number(params.offset ?? 0)), offset: params.offset ?? 0, nextOffset: content.length, eof: true, contentRevision: params.contentRevision }
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }
      if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
      if (method === 'quirky.editor/view') {
        viewCalls.push(params)
        return { ...info, pinned: true }
      }
      return {}
    },
    subscribe: () => () => {},
    onConnection: () => () => {},
    getSetting(name) { return settings[name] },
    getLayout: () => ({ worktree: `id:${info.worktreeId}`, view: null, panel: null, sidebar: true, focus: 'view' }),
    setContext() {}, toast() {}, togglePanel() {}, confirm: async () => true
  } as unknown as UiPluginContext
  activate(context)

  const host = document.createElement('div')
  document.body.append(host)
  let report: ControlReport = {}
  const mount = provided.get(DOCUMENT_VIEW)
  if (!mount) throw new Error('activate did not provide the document mount.')
  let dispose: unknown
  try {
    await act(async () => {
      dispose = await mount(host, {
        input: { bufferId: info.id, tabId: info.tabId, mode: 'rich' },
        report(value: unknown) { report = value as ControlReport }
      })
    })
    const controls = await waitFor(() => {
      const documentControl = report.uiControls?.find((item) => item.target === `document:${JSON.stringify([info.id, info.tabId])}`)
      const sourceControl = report.uiControls?.find((item) => item.target === `markdown-rich:${JSON.stringify([info.id, info.tabId])}`)
      return documentControl && sourceControl ? { documentControl, sourceControl } : undefined
    }, 'parent and Markdown control registrations').catch(cause => { throw new Error(`${cause.message}: ${JSON.stringify({ report, text: host.textContent, calls: contextCalls })}`) })
    expect(report).toMatchObject({ mounted: true, bufferId: info.id, tabId: info.tabId, mode: 'rich' })
    expect(controls.documentControl.actions).toContain('pin')
    expect(controls.sourceControl.surface).toBe(SURFACE)

    const identity = await context.call('ui.window.self', {}) as { connId: number }
    let response: unknown
    await act(async () => {
      response = await context.call('ui.window.command.run', {
        connId: identity.connId,
        id: MARKDOWN_UI_CONTROL,
        args: { surface: controls.documentControl.surface, target: controls.documentControl.target, generation: controls.documentControl.generation, action: 'pin' }
      })
    })
    expect(response).toEqual({ result: { delivered: true } })
    await waitFor(() => viewCalls.find((params) => params.action === 'pin'), 'parent pin operation')
    expect(viewCalls.at(-1)).toMatchObject({ bufferId: info.id, tabId: info.tabId, action: 'pin' })
    expect(report).toMatchObject({ mounted: true, bufferId: info.id, tabId: info.tabId, mode: 'rich' })
    expect(report.uiControls?.some((item) => item.target === controls.sourceControl.target)).toBe(true)
  } finally {
    if (typeof dispose === 'function') await act(async () => { (dispose as () => void)() })
    host.remove()
  }
})

test('same-buffer tabs and popped-out windows route source mode changes to the addressed owner', async () => {
  const firstTab = await renderSurface('source', { buffer: { id: 'shared-buffer', tabId: 't1' } })
  const secondTab = await renderSurface('source', { buffer: { id: 'shared-buffer', tabId: 't2' } })
  const firstAddress = await waitFor(() => firstTab.address('source'), 'first tab source control')
  const secondAddress = await waitFor(() => secondTab.address('source'), 'second tab source control')
  expect(firstAddress.target).toBe(`markdown-source:${JSON.stringify(['shared-buffer', 't1'])}`)
  expect(secondAddress.target).toBe(`markdown-source:${JSON.stringify(['shared-buffer', 't2'])}`)
  await click(secondTab.element, 'Rich Editor')
  await waitFor(() => secondTab.calls.find((call) => call.method === 'quirky.editor/view'), 'second tab mode update')
  expect(secondTab.calls.find((call) => call.method === 'quirky.editor/view')?.params).toMatchObject({ bufferId: 'shared-buffer', tabId: 't2', action: 'update' })
  expect(firstTab.calls.some((call) => call.method === 'quirky.editor/view')).toBe(false)

  const owner = await renderSurface('source', { buffer: { id: 'popped-buffer', tabId: 'same-tab' }, connId: 11 })
  const popped = await renderSurface('source', { buffer: { id: 'popped-buffer', tabId: 'same-tab' }, connId: 22 })
  const ownerAddress = await waitFor(() => owner.address('source'), 'owner source control')
  const poppedAddress = await waitFor(() => popped.address('source'), 'popped-out source control')
  expect(ownerAddress.target).toBe(poppedAddress.target)
  expect(ownerAddress.generation).not.toBe(poppedAddress.generation)
  await click(popped.element, 'Rich Editor')
  const windowCalls = popped.calls.filter((call) => call.method === 'ui.window.self' || call.method === 'ui.window.command.run')
  expect(windowCalls.map((call) => call.method)).toEqual(['ui.window.self', 'ui.window.command.run'])
  expect(windowCalls[1]?.params).toMatchObject({ connId: 22, id: MARKDOWN_UI_CONTROL, args: {
    surface: poppedAddress.surface, target: poppedAddress.target, generation: poppedAddress.generation, action: 'rich'
  } })
  expect(popped.calls.find((call) => call.method === 'quirky.editor/view')?.params).toMatchObject({ bufferId: 'popped-buffer', tabId: 'same-tab' })
  expect(owner.calls.some((call) => call.method === 'quirky.editor/view')).toBe(false)
})

test('source rich opening rechecks capabilities and targets the captured tab on success', async () => {
  let reads = 0
  const views: Record<string, unknown>[] = []
  const surface = await renderSurface('source', {
    buffer: { id: 'fresh-b1', tabId: 'fresh-t2' },
    call: async (method, params) => {
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
        reads += 1
        return reads === 2 ? { richEligible: false } : { richEligible: true }
      }
      if (method === 'quirky.editor/view') { views.push(params); return {} }
      return {}
    }
  })
  await waitFor(() => button(surface.element, 'Rich Editor'), 'source Rich Editor button')
  await expect(surface.control('source', 'rich')).rejects.toThrow('This document cannot be safely opened in rich mode. Continue editing in source mode.')
  await waitFor(() => errorMessage(surface.element, 'This document cannot be safely opened in rich mode. Continue editing in source mode.'), 'fresh capability refusal')
  expect(reads).toBe(2)
  expect(views).toHaveLength(0)
  expect(surface.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown source"]')?.value).toContain('Existing heading')

  expect(await surface.control('source', 'rich')).toEqual({ delivered: true })
  await waitFor(() => views.length === 1 ? views[0] : undefined, 'fresh rich-mode update')
  expect(views[0]).toMatchObject({ bufferId: 'fresh-b1', tabId: 'fresh-t2', action: 'update', patch: { mode: 'rich' } })
})

for (const mode of ['preview', 'rich'] as const) {
  test(`${mode} addressed search commits options, navigates matches, replaces, and closes to its opener`, async () => {
    const content = 'alpha Alpha alpha'
    const previewMatches = [
      { from: 0, to: 5, line: 1, column: 1, text: 'alpha' },
      { from: 6, to: 11, line: 1, column: 7, text: 'Alpha' },
      { from: 12, to: 17, line: 1, column: 13, text: 'alpha' }
    ]
    const surface = await renderSurface(mode, { content, call: async (method, params) => {
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
        return params.includePreview ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
      }
      if (method === 'quirky.editor/markdown' && params.action === 'notes') return { notes: [] }
      if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
      if (method === 'quirky.editor/markdown' && params.action === 'search') {
        const query = String(params.query ?? '')
        const matches = previewMatches.filter((match) => (params.matchCase === true ? match.text.includes(query) : match.text.toLowerCase().includes(query.toLowerCase())))
        return { total: matches.length, matches }
      }
      if (method === 'quirky.editor/markdown' && params.action === 'replace') return { replacements: 2, ...(mode === 'rich' ? { buffer: makeBuffer('rich', 'beta Alpha beta', { contentRevision: 2, revision: 2 }) } : {}) }
      return {}
    } })
    const opener = document.createElement('button')
    opener.textContent = 'Search opener'
    document.body.append(opener)
    opener.focus()
    const commands = surface.commands()
    if (!commands?.find || !commands.replace) throw new Error('Markdown search commands were not registered.')
    let findResult: unknown
    await act(async () => { findResult = await commands.find!({ query: 'alpha' }) })
    expect(findResult).toMatchObject({ opened: true, replace: false, query: 'alpha', total: 3 })
    expect(findResult).not.toHaveProperty('delivered')
    await waitFor(() => surface.address('search'), `${mode} search address`)
    await waitFor(() => surface.element.querySelector<HTMLInputElement>(`input[aria-label="Find in ${mode === 'preview' ? 'preview' : 'rich editor'}"]`), `${mode} search field`)

    let replaceResult: unknown
    await act(async () => { replaceResult = await commands.replace!({ query: 'alpha' }) })
    expect(replaceResult).toMatchObject({ opened: true, replace: true, query: 'alpha', total: 3 })
    expect(replaceResult).not.toHaveProperty('delivered')
    await surface.control('search', 'options', { matchCase: true, wholeWord: true })
    await surface.control('search', 'find')
    const searchArea = surface.element.querySelector<HTMLElement>('.markdown-toolbar--search')!
    await waitFor(() => searchArea.textContent?.includes('1 of 2') ? true : undefined, `${mode} option-filtered matches`)
    if (mode === 'preview') {
      expect(surface.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'search').at(-1)?.params).toMatchObject({ query: 'alpha', matchCase: true, wholeWord: true })
    }
    await surface.control('search', 'next')
    await waitFor(() => searchArea.textContent?.includes('2 of 2') ? true : undefined, `${mode} next match`)
    await surface.control('search', 'previous')
    await waitFor(() => searchArea.textContent?.includes('1 of 2') ? true : undefined, `${mode} previous match`)
    await surface.control('search', 'replace-toggle', { open: true })
    const replacement = await waitFor(() => searchArea.querySelector<HTMLInputElement>('input[aria-label="Replace with"]'), `${mode} replacement field`)
    await setValue(replacement, 'beta')
    await surface.control('search', 'replace-all', { query: 'alpha', text: 'beta' })
    if (mode === 'preview') {
      await waitFor(() => surface.calls.some((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'replace' && call.params.all === true), 'preview replace-all operation')
      await waitFor(() => [...surface.element.querySelectorAll<HTMLElement>('[role="status"]')].some((item) => item.textContent?.includes('2 replacement(s)')), 'preview replacement result')
    } else {
      const editor = surface.element.querySelector<HTMLElement>('.ProseMirror')!
      await waitFor(() => editor.textContent === 'beta Alpha beta' ? editor : undefined, 'rich replacement output')
    }
    await surface.control('search', 'close')
    await waitFor(() => surface.element.querySelector('.markdown-toolbar--search') ? undefined : true, `${mode} search close`)
    expect(document.activeElement).toBe(opener)
  })
}

test('rich selection Bold applies alpha once, and base identity survives local editing', async () => {
  const surface = await renderSurface('rich', { content: 'alpha' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich editor for selection formatting')
  const baseGeneration = (await waitFor(() => surface.address('rich'), 'rich base address')).generation
  const oldSelection = await waitFor(() => surface.address('selection'), 'initial selection address')
  await selectRichText(surface, 'alpha')
  const selected = await waitFor(() => {
    const address = surface.address('selection')
    return address && address.generation !== oldSelection.generation ? address : undefined
  }, 'selection-context generation after selecting alpha')
  expect(surface.address('rich')?.generation).toBe(baseGeneration)
  expect(selected.actions).toContain('format')
  expect(await surface.control('selection', 'format', { value: 'bold' })).toEqual({ delivered: true })
  await waitFor(() => editor.querySelector('strong')?.textContent === 'alpha' ? editor.querySelector('strong') : undefined, 'Bold formatting output')
  expect(surface.address('rich')?.generation).toBe(baseGeneration)
  expect(await surface.control('rich', 'retry-flush')).toEqual({ delivered: true })
  await waitFor(() => surface.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'apply').length === 1, 'one serialized Markdown apply')
  expect(surface.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')[0]?.params).toMatchObject({ text: '**alpha**' })
})

test('More blocks Table preserves text before the caret while slash acceptance removes its live trigger', async () => {
  const more = await renderSurface('rich', { content: '' })
  const moreEditor = await waitFor(() => more.element.querySelector<HTMLElement>('.ProseMirror'), 'More blocks editor')
  const baseGeneration = (await waitFor(() => more.address('rich'), 'More blocks base address')).generation
  await typeRichText(moreEditor, 'alpha')
  await more.control('rich', 'more', { open: true })
  expect(await more.control('more', 'choose', { value: 'table' })).toEqual({ delivered: true })
  await waitFor(() => moreEditor.querySelector('table'), 'More blocks table insertion')
  expect(moreEditor.textContent).toContain('alpha')
  expect(more.address('rich')?.generation).toBe(baseGeneration)

  const slash = await renderSurface('rich', { content: 'x\n\n/quote' })
  const slashEditor = await waitFor(() => slash.element.querySelector<HTMLElement>('.ProseMirror'), 'slash acceptance editor')
  await act(async () => {
    slashEditor.focus()
    const range = document.createRange()
    range.selectNodeContents(slashEditor.lastElementChild!)
    range.collapse(false)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    slashEditor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await waitFor(() => slash.address('slash'), 'slash acceptance address')
  expect(await slash.control('slash', 'choose', { id: 'quote' })).toEqual({ delivered: true })
  await waitFor(() => slashEditor.querySelector('blockquote'), 'slash quote insertion')
  expect(slashEditor.textContent).toContain('x')
  expect(slashEditor.textContent).not.toContain('/quote')
})

test('table controls guard the header row and code controls validate language and copy current code', async () => {
  const table = await renderSurface('rich', { content: '' })
  const tableEditor = await waitFor(() => table.element.querySelector<HTMLElement>('.ProseMirror'), 'table operation editor')
  await typeRichText(tableEditor, '/table')
  await waitFor(() => table.address('slash'), 'table slash menu')
  expect(await table.control('slash', 'choose', { id: 'table' })).toEqual({ delivered: true })
  const header = await waitFor(() => tableEditor.querySelector<HTMLTableCellElement>('th'), 'table header cell')
  await act(async () => { header.click() })
  const tableSelection = await waitFor(() => table.address('selection'), 'current table selection')
  expect(tableSelection.actions).toContain('table')
  const tableMarkup = tableEditor.innerHTML
  expect(await table.control('selection', 'table', { operation: 'not-a-table-operation' })).toEqual({ delivered: false })
  expect(tableEditor.innerHTML).toBe(tableMarkup)
  const rowCount = tableEditor.querySelectorAll('tr').length
  expect(await table.control('selection', 'table', { operation: 'row-delete' })).toEqual({ delivered: false })
  expect(tableEditor.querySelectorAll('tr')).toHaveLength(rowCount)
  expect(await table.control('selection', 'table', { operation: 'row-below' })).toEqual({ delivered: true })
  await waitFor(() => tableEditor.querySelectorAll('tr').length === rowCount + 1, 'row-below table operation')

  const code = await renderSurface('rich', { content: 'alpha' })
  const codeEditor = await waitFor(() => code.element.querySelector<HTMLElement>('.ProseMirror'), 'code language editor')
  await selectRichText(code, 'alpha')
  expect(await code.control('selection', 'format', { value: 'codeBlock' })).toEqual({ delivered: true })
  await waitFor(() => codeEditor.querySelector('pre code'), 'code block insertion')
  await selectRichText(code, 'alpha')
  const codeSelection = await waitFor(() => code.address('selection'), 'current code selection')
  expect(codeSelection.actions).toEqual(expect.arrayContaining(['code-language', 'code-indent', 'copy-code']))
  const language = await waitFor(() => code.element.querySelector<HTMLSelectElement>('select[aria-label="Code language"]'), 'code language control')
  expect(await code.control('selection', 'code-language', { value: 'swift' })).toEqual({ delivered: true })
  await waitFor(() => language.value === 'swift' ? language : undefined, 'current code language')
  const codeMarkup = codeEditor.innerHTML
  expect(await code.control('selection', 'code-language', { value: 'made-up-language' })).toEqual({ delivered: false })
  expect(codeEditor.innerHTML).toBe(codeMarkup)
  expect(await code.control('selection', 'code-indent', { outdent: 'no' })).toEqual({ delivered: false })
  expect(codeEditor.innerHTML).toBe(codeMarkup)

  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text: string) { writes.push(text) } } })
  try {
    expect(await code.control('selection', 'copy-code')).toEqual({ delivered: true })
    expect(writes).toEqual(['alpha'])
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('read-only rich Markdown refuses mutations but still permits captured-code copying', async () => {
  const surface = await renderSurface('rich', { content: '```python\nalpha\n```', buffer: { readOnly: true } })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'read-only rich editor')
  await selectRichText(surface, 'alpha')
  const before = editor.innerHTML
  expect(await surface.control('selection', 'format', { value: 'bold' })).toEqual({ delivered: false })
  expect(editor.innerHTML).toBe(before)
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text: string) { writes.push(text) } } })
  try {
    expect(await surface.control('selection', 'copy-code')).toEqual({ delivered: true })
    expect(writes).toEqual(['alpha'])
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('advertised controls reject malformed data, extra keys, non-current choices, and unavailable operations without effects', async () => {
  const surface = await renderSurface('rich', { content: 'alpha' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'strict-control editor')
  await selectRichText(surface, 'alpha')
  await surface.control('rich', 'find')
  await surface.control('rich', 'more', { open: true })
  await surface.control('rich', 'toc', { open: true })
  const rich = await waitFor(() => surface.address('rich'), 'strict rich address')
  expect(rich.actions).toContain('toc-level')
  const selection = await waitFor(() => surface.address('selection'), 'strict selection address')
  const search = await waitFor(() => surface.address('search'), 'strict search address')
  const more = await waitFor(() => surface.address('more'), 'strict More address')
  expect(selection.actions).toContain('format')
  expect(search.actions).toContain('options')
  expect(more.actions).toContain('choose')
  const beforeMarkup = editor.innerHTML
  const beforeCalls = surface.calls.length
  const invalid: { kind: string; action: string; data?: Record<string, unknown> }[] = [
    { kind: 'rich', action: 'find', data: { query: 42 } },
    { kind: 'rich', action: 'open-link', data: { target: 'https://example.test', modifier: { metaKey: true } } },
    { kind: 'rich', action: 'toc-level', data: { level: Number.POSITIVE_INFINITY, visible: true } },
    { kind: 'rich', action: 'heading', data: { id: 'not-a-current-heading' } },
    { kind: 'selection', action: 'format', data: { value: 'bold', extra: true } },
    { kind: 'selection', action: 'format', data: { value: 'not-a-format' } },
    { kind: 'selection', action: 'table', data: { operation: 'row-below' } },
    { kind: 'search', action: 'options', data: { matchCase: true, extra: false } },
    { kind: 'search', action: 'options', data: { matchCase: 'yes' } },
    { kind: 'search', action: 'replace-all', data: { query: 42, text: 'replacement' } },
    { kind: 'more', action: 'choose', data: { value: 'not-a-more-format' } }
  ]
  for (const operation of invalid) expect(await surface.control(operation.kind, operation.action, operation.data)).toEqual({ delivered: false })
  const malformedData = await provided.get(MARKDOWN_UI_CONTROL)!({
    surface: selection.surface, target: selection.target, generation: selection.generation, action: 'format', data: []
  })
  expect(malformedData).toEqual({ delivered: false })
  const extraControlKey = await provided.get(MARKDOWN_UI_CONTROL)!({
    surface: selection.surface, target: selection.target, generation: selection.generation, action: 'format', data: { value: 'bold' }, caller: 'forged'
  })
  expect(extraControlKey).toEqual({ delivered: false })
  expect(surface.calls).toHaveLength(beforeCalls)
  expect(editor.innerHTML).toBe(beforeMarkup)
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test('slash and document completion choices accept only current inventory entries and preserve extensionless targets', async () => {
  const slash = await renderSurface('rich', { content: '' })
  const slashEditor = await waitFor(() => slash.element.querySelector<HTMLElement>('.ProseMirror'), 'inventory slash editor')
  await typeRichText(slashEditor, '/h1')
  const slashAddress = await waitFor(() => slash.address('slash'), 'current slash inventory')
  const slashBefore = slashEditor.innerHTML
  expect(await slash.control('slash', 'choose', { id: 'not-in-current-results' })).toEqual({ delivered: false })
  expect(slashEditor.innerHTML).toBe(slashBefore)
  expect(await slash.control('slash', 'choose', { id: 'heading1' })).toEqual({ delivered: true })
  await waitFor(() => slashEditor.querySelector('h1'), 'current slash item result')
  expect(slashEditor.textContent).not.toContain('/h1')
  expect(slashAddress.target).toContain('markdown-slash:')

  const documents = await renderSurface('rich', { content: '', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'documents') {
      return { documents: [{ relativePath: 'docs/Guide.md', name: 'Guide.md' }], total: 1, truncated: false }
    }
    return {}
  } })
  const documentEditor = await waitFor(() => documents.element.querySelector<HTMLElement>('.ProseMirror'), 'inventory document editor')
  await typeRichText(documentEditor, '[[Gui')
  await waitFor(() => documents.address('documents'), 'current document inventory')
  const before = documentEditor.innerHTML
  expect(await documents.control('documents', 'choose', { path: '../../outside.md' })).toEqual({ delivered: false })
  expect(documentEditor.innerHTML).toBe(before)
  expect(await documents.control('documents', 'choose', { path: 'docs/Guide.md' })).toEqual({ delivered: true })
  const atom = await waitFor(() => documentEditor.querySelector<HTMLElement>('[data-markdown-document-link]'), 'document completion atom')
  expect(atom.getAttribute('data-target')).toBe('docs/Guide')
  expect(documentEditor.textContent).not.toContain('[[Gui')
})

test('registered keyboard commands return operation results and commit captured copy context', async () => {
  const surface = await renderSurface('rich', { content: 'alpha alpha' })
  const commands = surface.commands()
  if (!commands?.find || !commands.replace || !commands['copy-context']) throw new Error('Markdown keyboard commands were not registered.')
  await selectRichText(surface, 'alpha')
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text: string) { writes.push(text) } } })
  try {
    let copied: unknown
    await act(async () => { copied = await commands['copy-context']!() })
    expect(copied).toEqual({ copied: true, path: 'sample.md', lines: '1' })
    expect(writes).toEqual(['sample.md:1\nalpha'])
    let found: unknown
    await act(async () => { found = await commands.find!({ query: 'alpha' }) })
    expect(found).toMatchObject({ opened: true, replace: false, query: 'alpha', total: 2 })
    expect(found).not.toHaveProperty('delivered')
    let replacing: unknown
    await act(async () => { replacing = await commands.replace!({ query: 'alpha' }) })
    expect(replacing).toMatchObject({ opened: true, replace: true, query: 'alpha', total: 2 })
    expect(replacing).not.toHaveProperty('delivered')
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('public preview/rich link operations reject unsafe and ambiguous targets and preserve only MethodNotFound fallback', async () => {
  const url = 'https://example.test/docs'
  const browser = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, previewHtml: '<p>Links</p>', imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'links') return { safe: true, kind: 'external' }
    if (method === 'quirky.browser/openLink') return { route: 'app' }
    return {}
  } })
  expect(await browser.control('preview', 'open-link', { target: url, modifier: true, shift: true })).toEqual({ delivered: true })
  expect(browser.calls.find((call) => call.method === 'quirky.browser/openLink')?.params).toEqual({ url, worktree: 'id:wt-markdown-states', modifier: true, shift: true })
  const nonHttp = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, previewHtml: '<p>Links</p>', imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'links') return { safe: true, kind: 'external' }
    return {}
  } })
  expect(await nonHttp.control('preview', 'open-link', { target: 'mailto:docs@example.test' })).toEqual({ delivered: true })
  expect(nonHttp.calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: 'mailto:docs@example.test' }])

  const fallback = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }
    if (method === 'quirky.editor/markdown' && params.action === 'links') return { safe: true, kind: 'external' }
    if (method === 'quirky.browser/openLink') throw Object.assign(new Error('method missing'), { code: -32601 })
    return {}
  } })
  expect(await fallback.control('rich', 'open-link', { target: url })).toEqual({ delivered: true })
  expect(fallback.calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: url }])

  for (const result of [
    { safe: false, kind: 'external', ambiguous: false },
    { safe: true, kind: 'document', ambiguous: true, resolved: null, matches: ['a/Guide.md', 'b/Guide.md'] }
  ]) {
    const surface = await renderSurface('preview', { call: async (method, params) => {
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, previewHtml: '<p>Links</p>', imageUrls: {} }
      if (method === 'quirky.editor/markdown' && params.action === 'links') return result
      return {}
    } })
    const expectedError = result.ambiguous ? 'This document link is ambiguous; use its relative path.' : 'This link is unsafe or unavailable.'
    await expect(surface.control('preview', 'open-link', { target: 'Guide' })).rejects.toThrow(expectedError)
    await waitFor(() => errorMessage(surface.element, expectedError), 'unsafe or ambiguous link error')
    expect(surface.calls.some((call) => call.method === 'quirky.browser/openLink' || call.method === 'quirky.terminal/openExternal' || call.method === 'quirky.editor/open')).toBe(false)
  }

  const refused = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, previewHtml: '<p>Links</p>', imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'links') return { safe: true, kind: 'external' }
    if (method === 'quirky.browser/openLink') throw new Error('in-app route refused')
    return {}
  } })
  await expect(refused.control('preview', 'open-link', { target: url })).rejects.toThrow('in-app route refused')
  await waitFor(() => errorMessage(refused.element, 'in-app route refused'), 'Browser routing failure')
  expect(refused.calls.some((call) => call.method === 'quirky.terminal/openExternal')).toBe(false)
})

test('document links with anchors require both identities returned by the opened preview', async () => {
  for (const opened of [{ id: 'opened-buffer' }, { openedTabId: 'opened-tab' }]) {
    const surface = await renderSurface('preview', { call: async (method, params) => {
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, previewHtml: '<p>Links</p>', imageUrls: {} }
      if (method === 'quirky.editor/markdown' && params.action === 'links') {
        return { safe: true, kind: 'document', resolved: 'docs/guide.md', anchor: 'intro' }
      }
      if (method === 'quirky.editor/open') return opened
      return {}
    } })
    await expect(surface.control('preview', 'open-link', { target: 'docs/guide.md#intro' })).rejects.toThrow('The editor did not return the preview tab identity needed to reveal this heading.')
    await waitFor(() => errorMessage(surface.element, 'The editor did not return the preview tab identity needed to reveal this heading.'), 'missing preview-tab identity error')
    expect(surface.calls.some((call) => call.method === 'quirky.editor/open')).toBe(true)
    expect(surface.calls.some((call) => call.method === 'quirky.editor/view' && call.params.patch)).toBe(false)
  }
})

test('bridge identity, rejection, malformed replies, and refused delivery never fall back to a local mode change', async () => {
  const cases: { name: string; connId: number; handler?: (...args: unknown[]) => unknown; message: string }[] = [
    { name: 'invalid self identity', connId: 0, message: 'The daemon did not identify this window.' },
    { name: 'rejected bridge', connId: 22, handler: async () => { throw new Error('fixture window bridge failed') }, message: 'fixture window bridge failed' },
    { name: 'malformed reply', connId: 22, handler: async () => ({ delivered: 'yes' }), message: 'The editor control bridge returned an invalid response.' },
    { name: 'refused delivery', connId: 22, handler: async () => ({ delivered: false }), message: 'The editor control is no longer available.' }
  ]
  for (const scenario of cases) {
    const surface = await renderSurface('source', { connId: scenario.connId })
    await waitFor(() => button(surface.element, 'Rich Editor'), `${scenario.name} source control`)
    const original = provided.get(MARKDOWN_UI_CONTROL)!
    if (scenario.handler) provided.set(MARKDOWN_UI_CONTROL, scenario.handler)
    try {
      await click(surface.element, 'Rich Editor')
      await waitFor(() => errorMessage(surface.element, scenario.message), `${scenario.name} error on the origin`)
      expect(surface.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown source"]')?.value).toContain('Existing heading')
      expect(surface.calls.some((call) => call.method === 'quirky.editor/view' || call.method === 'quirky.editor/open')).toBe(false)
    } finally {
      provided.set(MARKDOWN_UI_CONTROL, original)
    }
  }
})

test('delayed formatting is fenced by selection generation, including a changed selection before window dispatch', async () => {
  const surface = await renderSurface('rich', { content: 'alpha beta' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'delayed formatting editor')
  await selectRichText(surface, 'alpha')
  const oldSelection = await waitFor(() => surface.address('selection'), 'captured format selection')
  const original = provided.get(MARKDOWN_UI_CONTROL)!
  const gate = deferred<void>()
  const delivered = deferred<unknown>()
  provided.set(MARKDOWN_UI_CONTROL, async (...args) => {
    await gate.promise
    const result = await original(...args)
    delivered.resolve(result)
    return result
  })
  try {
    const bold = surface.element.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')
    if (!bold) throw new Error('The rich Bold control is missing.')
    await act(async () => { bold.click() })
    await waitFor(() => surface.calls.some((call) => call.method === 'ui.window.command.run'), 'delayed Bold bridge request')
    await selectRichText(surface, 'beta')
    const currentSelection = await waitFor(() => {
      const address = surface.address('selection')
      return address && address.generation !== oldSelection.generation ? address : undefined
    }, 'replacement selection generation')
    expect(currentSelection.generation).not.toBe(oldSelection.generation)
    gate.resolve()
    expect(await delivered.promise).toEqual({ delivered: false })
    expect(editor.querySelector('strong')).toBeNull()
    expect(editor.textContent).toBe('alpha beta')
    expect(surface.calls.some((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')).toBe(false)
  } finally {
    provided.set(MARKDOWN_UI_CONTROL, original)
  }
})

test('A-B-A path replacement fences an old command and does not open a preview', async () => {
  const surface = await renderSurface('source', { buffer: { id: 'aba-buffer', tabId: 'aba-tab' } })
  const originalAddress = await waitFor(() => surface.address('source'), 'A source registration')
  const originalPath = '/tmp/markdown-states/sample.md'
  const original = provided.get(MARKDOWN_UI_CONTROL)!
  const gate = deferred<void>()
  const delivered = deferred<unknown>()
  provided.set(MARKDOWN_UI_CONTROL, async (...args) => {
    await gate.promise
    const result = await original(...args)
    delivered.resolve(result)
    return result
  })
  try {
    await click(surface.element, 'Open Markdown Preview')
    await waitFor(() => surface.calls.some((call) => call.method === 'ui.window.command.run'), 'A command bridge request')
    provided.set(MARKDOWN_UI_CONTROL, original)
    await surface.update({ path: '/tmp/markdown-states/other.md', relativePath: 'other.md' })
    await waitFor(() => surface.address('source')?.generation !== originalAddress.generation, 'B source registration')
    await surface.update({ path: originalPath, relativePath: 'sample.md' })
    await waitFor(() => surface.address('source')?.generation !== originalAddress.generation, 'replacement A source registration')
    gate.resolve()
    expect(await delivered.promise).toEqual({ delivered: false })
    expect(surface.calls.some((call) => call.method === 'quirky.editor/open')).toBe(false)
  } finally {
    provided.set(MARKDOWN_UI_CONTROL, original)
  }
})

test('closing and reopening a search session fences a command already waiting at the bridge', async () => {
  const surface = await renderSurface('rich', { content: 'alpha beta' })
  await surface.control('rich', 'find', { query: 'alpha' })
  const oldSearch = await waitFor(() => surface.address('search'), 'first search session')
  const original = provided.get(MARKDOWN_UI_CONTROL)!
  const gate = deferred<void>()
  const delivered = deferred<unknown>()
  provided.set(MARKDOWN_UI_CONTROL, async (...args) => {
    await gate.promise
    const result = await original(...args)
    delivered.resolve(result)
    return result
  })
  try {
    await click(surface.element.querySelector('.markdown-toolbar--search')!, 'Next')
    await waitFor(() => surface.calls.some((call) => call.method === 'ui.window.command.run'), 'delayed search navigation')
    provided.set(MARKDOWN_UI_CONTROL, original)
    await surface.control('search', 'close')
    await surface.control('rich', 'find', { query: 'beta' })
    const newSearch = await waitFor(() => {
      const address = surface.address('search')
      return address && address.generation !== oldSearch.generation ? address : undefined
    }, 'replacement search session')
    expect(newSearch.generation).not.toBe(oldSearch.generation)
    gate.resolve()
    expect(await delivered.promise).toEqual({ delivered: false })
    expect(surface.element.querySelector<HTMLInputElement>('input[aria-label="Find in rich editor"]')?.value).toBe('beta')
    expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
  } finally {
    provided.set(MARKDOWN_UI_CONTROL, original)
  }
})

test('unmount removes a queued public command before it can perform its delegated operation', async () => {
  const surface = await renderSurface('source', { content: 'draft retained' })
  await waitFor(() => surface.address('source'), 'unmount source control')
  const original = provided.get(MARKDOWN_UI_CONTROL)!
  const gate = deferred<void>()
  const delivered = deferred<unknown>()
  provided.set(MARKDOWN_UI_CONTROL, async (...args) => {
    await gate.promise
    const result = await original(...args)
    delivered.resolve(result)
    return result
  })
  try {
    await click(surface.element, 'Open Markdown Preview')
    await waitFor(() => surface.calls.some((call) => call.method === 'ui.window.command.run'), 'queued source command')
    provided.set(MARKDOWN_UI_CONTROL, original)
    await surface.unmount()
    gate.resolve()
    expect(await delivered.promise).toEqual({ delivered: false })
    expect(surface.calls.some((call) => call.method === 'quirky.editor/open')).toBe(false)
  } finally {
    provided.set(MARKDOWN_UI_CONTROL, original)
  }
})

test('emoji insertion is literal and readonly or stale popup sessions cannot insert', async () => {
  const child = Bun.spawn([process.execPath, '-'], { cwd: resolve(import.meta.dir, '..'),
    stdin: new TextEncoder().encode(String.raw`import assert from 'node:assert/strict'
import React, { act } from 'react'
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register(); globalThis.IS_REACT_ACT_ENVIRONMENT = true
const pendingModule = Promise.withResolvers(); mock.module('emoji-picker-react', () => pendingModule.promise)
const { createRoot } = await import('react-dom/client')
const { MarkdownSurface } = await import('./src/markdown/MarkdownSurface')
const ui = await import('./src/ui'), controls = await import('./src/window/uiControl')
const provided = new Map(), calls = []
const context = {
  pluginId: 'quirky.editor',
  provide(id, handler) { provided.set(id, handler) },
  async call(method, params = {}) {
    calls.push({ method, params })
    if (method === 'ui.window.self') return { connId: 22 }
    if (method === 'ui.window.command.run') {
      const handler = provided.get(String(params.id)); assert.ok(handler, 'activate provides the ui-control command')
      return { result: await handler(params.args) }
    }
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    return {}
  },
  subscribe() { return () => {} }, onConnection() { return () => {} },
  getSetting(name) { return name === 'editorSidebarWidth' ? 320 : 300 }, getLayout() { return {} }, toast() {}
}
ui.activate(context)
const makeSurface = (id, readOnly = false) => {
  const buffer = { id, worktreeId: 'wt', root: '/tmp', path: '/tmp/' + id + '.md', relativePath: id + '.md', name: id + '.md', kind: 'markdown', content: 'alpha', draft: null, baseline: null, size: 5, readOnly, dirty: false, external: null, mode: 'rich', tabId: 'tab-' + id, preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null, diskContentLength: null, diskContentBytes: null, diskSignature: null }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let currentReport = {}
  const scope = controls.createEditorUiControlReportScope((value) => { currentReport = value }, { surface: 'view:quirky.editor/document', context })
  scope.report({ mounted: true, bufferId: id, tabId: buffer.tabId, mode: 'rich' })
  const props = { context, buffer, fontSize: 13, onDraft() {}, onAction: (method, params) => context.call(method, params), onView() {}, registerCommandHandlers() { return () => {} } }
  const render = () => React.createElement(controls.EditorUiControlProvider, { scope }, React.createElement(MarkdownSurface, props))
  return { host, root, scope, report: () => currentReport, render }
}
const wait = async predicate => { for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await Bun.sleep(5) } throw Error('fixture timed out') }
const address = (surface, kind) => surface.report().uiControls?.find(item => item.target.startsWith('markdown-' + kind + ':'))
const sendAddress = async (item, action, data) => {
  assert.ok(item, 'a current control address is required')
  const identity = await context.call('ui.window.self', {})
  let reply
  await act(async () => { reply = await context.call('ui.window.command.run', { connId: identity.connId, id: 'command:quirky.editor/ui-control', args: { surface: item.surface, target: item.target, generation: item.generation, action, ...(data === undefined ? {} : { data }) } }) })
  return reply
}
const send = async (surface, kind, action, data) => sendAddress(address(surface, kind), action, data)
let live, readOnly
try {
  live = makeSurface('emoji-live')
  await act(async () => live.root.render(live.render()))
  await wait(() => live.host.querySelector('.ProseMirror'))
  await send(live, 'rich', 'more', { open: true }); await send(live, 'more', 'choose', { value: 'emoji' })
  const oldAddress = await wait(() => address(live, 'emoji'))
  await wait(() => live.host.querySelector('[role="dialog"][aria-label="Emoji picker"] .ui-notice-line'))
  await send(live, 'emoji', 'close')
  await wait(() => !address(live, 'emoji'))
  await send(live, 'rich', 'more', { open: true }); await send(live, 'more', 'choose', { value: 'emoji' })
  const currentAddress = await wait(() => address(live, 'emoji'))
  assert.notEqual(currentAddress.generation, oldAddress.generation, 'reopened picker has a new logical session')
  pendingModule.resolve({ default: () => React.createElement('span', null, 'native picker ready'), EmojiStyle: { NATIVE: 'native' } })
  const editor = await wait(() => live.host.querySelector('.ProseMirror'))
  await wait(() => live.host.textContent.includes('native picker ready'))
  const stale = await sendAddress(oldAddress, 'insert', { value: 'stale' })
  assert.deepEqual(stale, { result: { delivered: false } })
  assert.equal(editor.textContent, 'alpha')
  const literal = '<img src=x onerror=alert(1)>'
  const inserted = await send(live, 'emoji', 'insert', { value: literal })
  assert.deepEqual(inserted, { result: { delivered: true } })
  assert.ok(editor.textContent.includes(literal), 'scripted emoji string remains literal text')
  assert.equal(editor.querySelector('img'), null, 'literal emoji input never becomes markup')

  readOnly = makeSurface('emoji-readonly', true)
  await act(async () => readOnly.root.render(readOnly.render()))
  const readonlyEditor = await wait(() => readOnly.host.querySelector('.ProseMirror'))
  const before = readonlyEditor.innerHTML
  const readonlyResult = await send(readOnly, 'selection', 'format', { value: 'bold' })
  assert.deepEqual(readonlyResult, { result: { delivered: false } })
  const emojiResult = await send(readOnly, 'selection', 'format', { value: 'emoji' })
  assert.deepEqual(emojiResult, { result: { delivered: false } })
  assert.equal(address(readOnly, 'emoji'), undefined)
  assert.equal(readonlyEditor.innerHTML, before)
} finally {
  if (live) { await act(async () => live.root.unmount()); live.scope.dispose(); live.host.remove() }
  if (readOnly) { await act(async () => readOnly.root.unmount()); readOnly.scope.dispose(); readOnly.host.remove() }
  ui.deactivate(); await GlobalRegistrator.unregister()
}
`), stdout: 'pipe', stderr: 'pipe'
  })
  const killTimer = setTimeout(() => child.kill(), 25_000)
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (status !== 0) throw new Error(`Isolated emoji command scenario failed (${status}):\n${stdout}\n${stderr}`)
  } finally {
    clearTimeout(killTimer)
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
}, 30_000)
