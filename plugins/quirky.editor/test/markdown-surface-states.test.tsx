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
import { searchMarkdown } from '../src/markdown/source'

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
      let completion: Promise<{ ok: boolean; value?: unknown; error?: unknown }> | undefined
      await act(() => {
        completion = Promise.resolve(provided.get('command:quirky.editor/ui-control')!({
          surface: address.surface, target: address.target, generation: address.generation, action,
          ...(data === undefined ? {} : { data })
        })).then(value => ({ ok: true, value }), error => ({ ok: false, error }))
      })
      const outcome = await completion!
      await act(async () => {})
      if (!outcome.ok) throw outcome.error
      return outcome.value
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
  const props: SurfaceProps = { context, buffer: makeBuffer('rich', ''), fontSize: 13, onDraft() {}, onAction: async (method, params) => call(method, params), onView() {}, registerCommandHandlers() { return () => {} } }
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
    provide(id: string, handler: unknown) { provided.set(id, handler as (...args: unknown[]) => unknown) },
    async call(method: string, params: Record<string, unknown> = {}) {
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
    getSetting(name: string) { return settings[name] },
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
    const bAddress = await waitFor(() => {
      const address = surface.address('source')
      return address && address.generation !== originalAddress.generation ? address : undefined
    }, 'B source registration')
    await surface.update({ path: originalPath, relativePath: 'sample.md' })
    await waitFor(() => {
      const address = surface.address('source')
      return address && address.generation !== bAddress.generation ? address : undefined
    }, 'replacement A source registration')
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
  await act(async () => { readonlyEditor.focus(); const range = document.createRange(); range.selectNodeContents(readonlyEditor.querySelector('p')); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); readonlyEditor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
  await wait(() => address(readOnly, 'selection'))
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
const notesBufferA = {
  id: 'b1', tabId: 't1', worktreeId: 'w1', root: '/fixture', path: '/fixture/a.md',
  relativePath: 'a.md', name: 'a.md', revision: 7, contentRevision: 7
}
const notesBufferB = {
  id: 'b2', tabId: 't2', worktreeId: 'w2', root: '/fixture', path: '/fixture/b.md',
  relativePath: 'b.md', name: 'b.md', revision: 3, contentRevision: 3
}
const notesSessionInventory = [{ id: 's1', agent: 'agent1', title: 'Fixture terminal', kind: 'terminal', status: 'running' }]
const notesAgentInventory = [{ id: 'agent1', label: 'Agent One' }, { id: 'agent2', label: 'Agent Two' }]


function notesNote(body = 'existing note', id = 'n1') {
  return {
    id, bufferId: 'b1', worktreeId: 'w1', filePath: 'a.md', source: 'markdown' as const,
    selectedText: 'alpha', startLine: 1, endLine: 1, lineNumber: 1, body, createdAt: 1, side: 'modified' as const
  }
}
function notesCalls(surface: MountedSurface, method: string, action: string) {
  return surface.calls.filter((call) => call.method === method && call.params.action === action)
}
async function notesOpenNotes(surface: MountedSurface): Promise<HTMLElement> {
  expect(surface.address('rich')).toBeDefined()
  await surface.control('rich', 'notes', { open: true })
  return waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-review-notes'), 'addressed Review notes panel')
}
async function notesOpenAdd(surface: MountedSurface, text = 'alpha'): Promise<HTMLElement> {
  await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'real TipTap editor')
  await waitFor(() => surface.address('selection'), 'selection control address')
  await selectRichText(surface, text)
  await surface.control('selection', 'add-review-note')
  const dialog = await waitFor(() => surface.element.querySelector<HTMLElement>('[role="dialog"][aria-label="Add note for the AI"]'), 'addressed Add note composer')
  expect(surface.address('note')).toBeDefined()
  return dialog
}
async function notesOpenSend(surface: MountedSurface): Promise<HTMLElement> {
  await notesOpenNotes(surface)
  await surface.control('rich', 'send-menu')
  const dialog = await waitFor(() => surface.element.querySelector<HTMLElement>('[role="dialog"][aria-label="Send notes to"]'), 'addressed Send notes dialog')
  expect(surface.address('send')).toBeDefined()
  return dialog
}
async function notesOpenTemplates(surface: MountedSurface): Promise<HTMLElement> {
  expect(surface.address('rich')).toBeDefined()
  await surface.control('rich', 'templates')
  const dialog = await waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(element => element.textContent?.includes('New Markdown')), 'addressed New Markdown dialog')
  expect(surface.address('templates')).toBeDefined()
  return dialog
}
async function notesExpectRejected(surface: MountedSurface, operation: Promise<unknown>, message: string): Promise<void> {
  let cause: unknown
  try { await operation } catch (error) { cause = error }
  expect(cause).toBeInstanceOf(Error)
  expect((cause as Error).message).toBe(message)
  await waitFor(() => errorMessage(surface.element, message) ?? [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map(element => errorMessage(element, message)).find(Boolean), `InlineError ${message}`)
}

test('addressed Edit saves the existing note body without any editor selection', async () => {
  const surface = await renderSurface('rich', {
    content: 'alpha', buffer: notesBufferA,
    call: async (method, params) => method === 'quirky.editor/notes' && params.action === 'list'
      ? { notes: [notesNote()] }
      : {}
  })
  await notesOpenNotes(surface)
  await waitFor(() => button(surface.element, 'Edit'), 'existing review note')
  window.getSelection()?.removeAllRanges()
  expect(window.getSelection()?.toString()).toBe('')
  await surface.control('rich', 'edit-note', { noteId: 'n1' })
  const composer = await waitFor(() => surface.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]'), 'Edit note composer')
  expect(surface.address('note')).toBeDefined()
  expect(composer.value).toBe('existing note')
  await surface.control('note', 'submit')
  expect(notesCalls(surface, 'quirky.editor/notes', 'edit')).toEqual([{
    method: 'quirky.editor/notes', params: { bufferId: 'b1', action: 'edit', noteId: 'n1', text: 'existing note' }
  }])
})

test('addressed Add submits the captured rich selection and exact line range', async () => {
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA })
  const dialog = await notesOpenAdd(surface)
  await setValue(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!, 'review this')
  await surface.control('note', 'submit')
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toEqual([{
    method: 'quirky.editor/notes', params: {
      bufferId: 'b1', action: 'add',
      selection: { text: 'alpha', startLine: 1, endLine: 1, mode: 'rich' }, text: 'review this'
    }
  }])
})

for (const { label, body, accepted } of [
  { label: '16,384 ASCII bytes', body: 'a'.repeat(16_384), accepted: true },
  { label: '16,385 ASCII bytes', body: 'a'.repeat(16_385), accepted: false },
  { label: '16,384 multibyte bytes', body: 'é'.repeat(8_192), accepted: true },
  { label: '16,385 multibyte bytes', body: 'é'.repeat(8_192) + 'x', accepted: false }
]) {
  test(`note submit ${accepted ? 'accepts' : 'refuses'} ${label}`, async () => {
    const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA })
    const dialog = await notesOpenAdd(surface)
    const draft = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!
    await setValue(draft, body)
    await surface.control('note', 'submit')
    const writes = notesCalls(surface, 'quirky.editor/notes', 'add')
    if (accepted) {
      expect(writes).toHaveLength(1)
      expect(writes[0]?.params).toEqual({
        bufferId: 'b1', action: 'add',
        selection: { text: 'alpha', startLine: 1, endLine: 1, mode: 'rich' }, text: body
      })
    } else {
      expect(errorMessage(surface.element, 'Comment is too large to submit safely.')).not.toBeNull()
      expect(draft.value).toBe(body)
      expect(writes).toHaveLength(0)
    }
  })
}

test('selection above 32,768 bytes cannot open an Add note composer', async () => {
  const text = 'x'.repeat(32_769)
  const surface = await renderSurface('rich', { content: text, buffer: notesBufferA })
  await waitFor(() => surface.address('rich'), 'rich control address')
  await waitFor(() => surface.element.querySelector('.ProseMirror'), 'real TipTap editor')
  await selectRichText(surface, text)
  expect(await surface.control('selection', 'add-review-note')).toEqual({ delivered: false })
  expect(surface.address('note')).toBeUndefined()
  expect(surface.element.querySelector('[role="dialog"][aria-label="Add note for the AI"]')).toBeNull()
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toHaveLength(0)
})

test('copy context preserves its active-command result and writes exact Markdown context', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  try {
    const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA })
    await waitFor(() => surface.address('selection'), 'selection control address')
    await selectRichText(surface, 'alpha')
    const command = await waitFor(() => surface.commands()?.['copy-context'], 'active copy-context command')
    expect(await command()).toEqual({ copied: true, path: 'a.md', lines: '1' })
    expect(writes).toEqual(['a.md:1\nalpha'])
    expect(await surface.control('selection', 'copy-context')).toEqual({ delivered: true })
    expect(writes).toEqual(['a.md:1\nalpha', 'a.md:1\nalpha'])
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('hiding and reopening Review notes preserves the unsent addressed composer draft', async () => {
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA })
  await notesOpenNotes(surface)
  const dialog = await notesOpenAdd(surface)
  await setValue(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!, 'unsent draft')
  await surface.control('rich', 'notes', { open: false })
  expect(surface.element.querySelector('.markdown-review-notes')).toBeNull()
  expect(surface.address('note')).toBeUndefined()
  await surface.control('rich', 'notes', { open: true })
  const reopened = await waitFor(() => surface.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]'), 'reopened note composer')
  expect(reopened.value).toBe('unsent draft')
  expect(surface.address('note')).toBeDefined()
})

test('note submit acquires busy state synchronously and refuses a same-tick duplicate', async () => {
  const write = deferred<unknown>()
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'add') return write.promise
    return {}
  } })
  const dialog = await notesOpenAdd(surface)
  await setValue(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!, 'one note')
  const first = surface.control('note', 'submit')
  const duplicate = surface.control('note', 'submit')
  await waitFor(() => notesCalls(surface, 'quirky.editor/notes', 'add').length === 1, 'first note write')
  expect(await duplicate).toEqual({ delivered: false })
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toHaveLength(1)
  write.resolve({})
  await first
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toHaveLength(1)
})

test('stale note completion cannot clear a reopened composer after A-B-A buffer replacement', async () => {
  const oldWrite = deferred<unknown>()
  let addCount = 0
  let listCount = 0
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') { listCount += 1; return { notes: [] } }
    if (method === 'quirky.editor/notes' && params.action === 'add') return ++addCount === 1 ? oldWrite.promise : {}
    return {}
  } })
  const oldDialog = await notesOpenAdd(surface)
  await setValue(oldDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!, 'old draft')
  const oldCompletion = surface.control('note', 'submit')
  await waitFor(() => addCount === 1, 'delayed old note write')
  await surface.control('note', 'cancel')
  await surface.update(notesBufferB)
  await surface.update(notesBufferA)
  await waitFor(() => surface.element.querySelector('.ProseMirror'), 'replacement TipTap editor')
  const currentDialog = await notesOpenAdd(surface)
  await setValue(currentDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!, 'new composer draft')
  const readsBeforeOldCompletion = listCount
  oldWrite.resolve({})
  await oldCompletion
  const stillCurrent = surface.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')
  expect(stillCurrent?.value).toBe('new composer draft')
  expect(surface.address('note')).toBeDefined()
  expect(listCount).toBe(readsBeforeOldCompletion)
})

test('send validates completed session and agent inventories before any note-write effect', async () => {
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [notesNote()] }
    if (method === 'quirky.session/list') return notesSessionInventory
    if (method === 'quirky.agents/list') return notesAgentInventory
    return {}
  } })
  await notesOpenSend(surface)
  await waitFor(() => button(surface.element, 'Send'), 'loaded existing-session Send action')
  expect(await surface.control('send', 'send', { target: 'existing', sessionId: 'forged-session' })).toEqual({ delivered: false })
  expect(await surface.control('send', 'send', { target: 'new', agent: 'forged-agent' })).toEqual({ delivered: false })
  expect(notesCalls(surface, 'quirky.editor/notes', 'send')).toHaveLength(0)
  expect(surface.address('send')).toBeDefined()
})

test('send pending read can fail, retry to an empty inventory, and remain cancellable', async () => {
  const firstSessions = deferred<unknown>()
  let sessionReads = 0
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    if (method === 'quirky.session/list') return ++sessionReads === 1 ? firstSessions.promise : []
    if (method === 'quirky.agents/list') return []
    return {}
  } })
  const dialog = await notesOpenSend(surface)
  expect(notice(dialog, 'Loading note destinations…')).not.toBeNull()
  firstSessions.reject(new Error('fixture destinations failed'))
  await waitFor(() => errorMessage(dialog, 'fixture destinations failed'), 'send inventory failure')
  expect(button(dialog, 'Cancel')).toBeDefined()
  await surface.control('send', 'retry')
  await waitFor(() => emptyState(dialog, 'No note destinations available.'), 'settled empty destination inventory')
  expect(button(dialog, 'Cancel')).toBeDefined()
  expect(surface.address('send')).toBeDefined()
  await surface.control('send', 'cancel')
  expect(surface.address('send')).toBeUndefined()
  expect(surface.element.querySelector('[role="dialog"][aria-label="Send notes to"]')).toBeNull()
})

test('send uses loaded session ownership, reports returned delivery failure, and closes only its origin on success', async () => {
  const delayedSend = deferred<unknown>()
  let currentNotes = [notesNote()]
  let sendCount = 0
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: currentNotes }
    if (method === 'quirky.session/list') return notesSessionInventory
    if (method === 'quirky.agents/list') return notesAgentInventory
    if (method === 'quirky.editor/notes' && params.action === 'send') {
      if (++sendCount === 1) return delayedSend.promise
      currentNotes = []
      return { delivery: 'delivered', deletedNoteIds: ['n1'], retainedNoteIds: [] }
    }
    return {}
  } })
  const notesPanel = await notesOpenNotes(surface)
  await waitFor(() => notesPanel.querySelector('.markdown-note'), 'existing note to send')
  const sendDialog = await notesOpenSend(surface)
  const existing = surface.control('send', 'send', { target: 'existing', sessionId: 's1' })
  const duplicate = surface.control('send', 'send', { target: 'existing', sessionId: 's1' })
  await waitFor(() => sendCount === 1, 'single existing-session send')
  expect(await duplicate).toEqual({ delivered: false })
  delayedSend.resolve({ delivery: 'not-delivered', deletedNoteIds: [], retainedNoteIds: ['n1'], error: 'fixture send failed' })
  await notesExpectRejected(surface, existing, 'fixture send failed')
  await waitFor(() => errorMessage(sendDialog, 'fixture send failed'), 'returned send failure')
  expect(sendDialog.textContent).toContain('Cancel')
  expect(surface.address('send')).toBeDefined()
  expect(notesPanel.textContent).toContain('existing note')
  expect(notesCalls(surface, 'quirky.editor/notes', 'send').map((call) => call.params)).toEqual([{
    bufferId: 'b1', action: 'send', target: 'existing', sessionId: 's1', agent: 'agent1'
  }])

  const other = await renderSurface('rich', { buffer: notesBufferB, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [notesNote('other note', 'n2')] }
    if (method === 'quirky.session/list') return notesSessionInventory
    if (method === 'quirky.agents/list') return notesAgentInventory
    return {}
  } })
  await notesOpenSend(other)
  const readsBeforeSuccess = notesCalls(surface, 'quirky.editor/notes', 'list').length
  await surface.control('send', 'send', { target: 'new', agent: 'agent2' })
  expect(notesCalls(surface, 'quirky.editor/notes', 'send').map((call) => call.params)).toEqual([
    { bufferId: 'b1', action: 'send', target: 'existing', sessionId: 's1', agent: 'agent1' },
    { bufferId: 'b1', action: 'send', target: 'new', agent: 'agent2' }
  ])
  expect(notesCalls(surface, 'quirky.editor/notes', 'list').length).toBeGreaterThan(readsBeforeSuccess)
  await waitFor(() => emptyState(notesPanel, 'No review notes.'), 'notes reload after successful delivery')
  expect(surface.address('send')).toBeUndefined()
  expect(surface.element.querySelector('[role="dialog"][aria-label="Send notes to"]')).toBeNull()
  expect(other.address('send')).toBeDefined()
  expect(other.element.querySelector('[role="dialog"][aria-label="Send notes to"]')).not.toBeNull()
})

test('note delete, PDF export and clipboard control failures retain their actual InlineError message', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('fixture clipboard failed') } } })
  try {
    const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
      if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [notesNote()] }
      if (method === 'quirky.editor/notes' && params.action === 'delete') throw new Error('fixture delete failed')
      if (method === 'quirky.editor/notes' && params.action === 'copy') return { text: 'review notes', count: 1 }
      if (method === 'quirky.editor/markdown' && params.action === 'exportPdf') throw new Error('fixture export failed')
      return {}
    } })
    const panel = await notesOpenNotes(surface)
    await notesExpectRejected(surface, surface.control('rich', 'delete-note', { noteId: 'n1' }), 'fixture delete failed')
    expect(panel.textContent).toContain('existing note')
    await surface.control('rich', 'dismiss-error')
    await notesExpectRejected(surface, surface.control('rich', 'export-pdf'), 'fixture export failed')
    await surface.control('rich', 'dismiss-error')
    await notesExpectRejected(surface, surface.control('rich', 'copy-notes'), 'fixture clipboard failed')
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('template inventory pending, failure, Retry and empty-state recovery leave Cancel usable', async () => {
  const firstRead = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return ++reads === 1 ? firstRead.promise : { templates: [] }
    return {}
  } })
  const dialog = await notesOpenTemplates(surface)
  expect(notice(dialog, 'Loading Markdown templates…')).not.toBeNull()
  expect(button(dialog, 'Cancel')).toBeDefined()
  firstRead.reject(new Error('fixture templates failed'))
  await waitFor(() => errorMessage(dialog, 'fixture templates failed'), 'template inventory failure')
  await surface.control('templates', 'retry')
  await waitFor(() => emptyState(dialog, 'No Markdown templates.'), 'empty template inventory')
  expect(button(dialog, 'Blank Markdown (untitled.md)')).toBeDefined()
  expect(button(dialog, 'Cancel')).toBeDefined()
  await surface.control('templates', 'cancel')
  expect(surface.address('templates')).toBeUndefined()
})

test('template create accepts only a loaded template or explicit blank and captures worktree and title', async () => {
  const creates: Record<string, unknown>[] = []
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return { templates: [{ relativePath: 'templates/base.md', title: 'Starter' }] }
    if (method === 'quirky.editor/markdown' && params.action === 'new') { creates.push(params); return {} }
    return {}
  } })
  let dialog = await notesOpenTemplates(surface)
  await waitFor(() => button(dialog, 'Starter — templates/base.md'), 'loaded Markdown template')
  expect(await surface.control('templates', 'create', { title: 'Untrusted', template: 'templates/forged.md' })).toEqual({ delivered: false })
  expect(creates).toHaveLength(0)
  await surface.control('templates', 'create', { title: 'Captured title', template: 'templates/base.md' })
  expect(creates[0]).toEqual({
    bufferId: 'b1', action: 'new', worktree: 'id:w1', title: 'Captured title', template: 'templates/base.md'
  })
  await waitFor(() => surface.address('templates') === undefined, 'successful template dialog close')

  dialog = await notesOpenTemplates(surface)
  await waitFor(() => button(dialog, 'Starter — templates/base.md'), 'template inventory for blank create')
  await surface.control('templates', 'create', { title: 'Blank title' })
  expect(creates[1]).toEqual({ bufferId: 'b1', action: 'new', worktree: 'id:w1', title: 'Blank title' })
})

test('failed template creation retains title and filter drafts with the actual InlineError', async () => {
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return { templates: [{ relativePath: 'templates/starter.md', title: 'Starter' }] }
    if (method === 'quirky.editor/markdown' && params.action === 'new') throw new Error('fixture create failed')
    return {}
  } })
  const dialog = await notesOpenTemplates(surface)
  await waitFor(() => button(dialog, 'Starter — templates/starter.md'), 'loaded template before failed create')
  const title = dialog.querySelector<HTMLInputElement>('input[placeholder="Title"]')!
  const filter = dialog.querySelector<HTMLInputElement>('input[placeholder="Search templates…"]')!
  await setValue(title, 'Retained title')
  await setValue(filter, 'starter')
  await notesExpectRejected(surface, surface.control('templates', 'create'), 'fixture create failed')
  expect(title.value).toBe('Retained title')
  expect(filter.value).toBe('starter')
  expect(surface.address('templates')).toBeDefined()
})

test('template create prevents same-tick duplicates and stale A-B-A completions cannot close or clear a reopened dialog', async () => {
  const oldCreate = deferred<unknown>()
  let creates = 0
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return { templates: [{ relativePath: 'templates/base.md', title: 'Starter' }] }
    if (method === 'quirky.editor/markdown' && params.action === 'new') { creates += 1; return oldCreate.promise }
    return {}
  } })
  const firstDialog = await notesOpenTemplates(surface)
  await waitFor(() => button(firstDialog, 'Starter — templates/base.md'), 'loaded template for delayed create')
  const oldCompletion = surface.control('templates', 'create', { title: 'Old title', template: 'templates/base.md' })
  const duplicate = surface.control('templates', 'create', { title: 'Old title', template: 'templates/base.md' })
  await waitFor(() => creates === 1, 'single delayed create')
  expect(await duplicate).toEqual({ delivered: false })
  await surface.control('templates', 'cancel')
  const currentDialog = await notesOpenTemplates(surface)
  await waitFor(() => button(currentDialog, 'Starter — templates/base.md'), 'reopened template dialog')
  await setValue(currentDialog.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, 'New title')
  await setValue(currentDialog.querySelector<HTMLInputElement>('input[placeholder="Search templates…"]')!, 'new filter')
  await surface.update(notesBufferB)
  await surface.update(notesBufferA)
  const replacementDialog = await notesOpenTemplates(surface)
  await setValue(replacementDialog.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, 'New title')
  await setValue(replacementDialog.querySelector<HTMLInputElement>('input[placeholder="Search templates…"]')!, 'new filter')
  const newTitle = replacementDialog.querySelector<HTMLInputElement>('input[placeholder="Title"]')!
  const newFilter = replacementDialog.querySelector<HTMLInputElement>('input[placeholder="Search templates…"]')!
  oldCreate.resolve({})
  await oldCompletion
  expect(surface.address('templates')).toBeDefined()
  expect(document.body.contains(replacementDialog)).toBe(true)
  expect(newTitle.value).toBe('New title')
  expect(newFilter.value).toBe('new filter')
  expect(creates).toBe(1)
})

test('old template completion after unmount performs no replacement UI or delegated effect', async () => {
  const create = deferred<unknown>()
  const creates: Record<string, unknown>[] = []
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'templates') return { templates: [] }
    if (method === 'quirky.editor/markdown' && params.action === 'new') { creates.push(params); return create.promise }
    return {}
  } })
  await notesOpenTemplates(surface)
  await waitFor(() => emptyState(surface.element, 'No Markdown templates.'), 'empty template list before blank create')
  const completion = surface.control('templates', 'create', { title: 'Unmounted' })
  await waitFor(() => creates.length === 1, 'pending template creation')
  await surface.unmount()
  const callsBeforeResolve = surface.calls.length
  create.resolve({})
  await completion
  expect(surface.calls).toHaveLength(callsBeforeResolve)
  expect(surface.element.textContent).toBe('')
})

test('real TipTap flush applies at its expected revision before export and preserves source bytes', async () => {
  const order: string[] = []
  const applyResponses: unknown[] = []
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') {
      order.push('apply')
      const response = { changed: true, sourcePreserved: true, buffer: { contentRevision: 8 } }
      applyResponses.push(response)
      return response
    }
    if (method === 'quirky.editor/markdown' && params.action === 'exportPdf') {
      order.push('export')
      return { path: '/fixture/out.pdf' }
    }
    return {}
  } })
  await waitFor(() => surface.element.querySelector('.ProseMirror'), 'real TipTap editor before apply')
  await selectRichText(surface, 'alpha')
  expect(surface.address('selection')).toBeDefined()
  await surface.control('selection', 'format', { value: 'bold' })
  await surface.control('rich', 'export-pdf')
  expect(notesCalls(surface, 'quirky.editor/markdown', 'apply')[0]?.params).toMatchObject({
    bufferId: 'b1', action: 'apply', expectedRevision: 7
  })
  expect(notesCalls(surface, 'quirky.editor/markdown', 'apply')[0]?.params.text).not.toBe('alpha')
  expect(applyResponses).toEqual([{ changed: true, sourcePreserved: true, buffer: { contentRevision: 8 } }])
  expect(order).toEqual(['apply', 'export'])
  expect(errorMessage(surface.element, 'Rich Markdown update did not preserve its source bytes.')).toBeNull()
})

test('a real rich edit remains visible when an in-flight apply conflicts with an external revision', async () => {
  const apply = deferred<unknown>()
  const conflict = 'The Markdown draft changed elsewhere. Your local rich edit is retained; switch to source or compare before retrying.'
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') return apply.promise
    return {}
  } })
  await waitFor(() => surface.element.querySelector('.ProseMirror'), 'real TipTap editor before external conflict')
  await selectRichText(surface, 'alpha')
  const formatting = surface.control('selection', 'format', { value: 'bold' })
  await waitFor(() => notesCalls(surface, 'quirky.editor/markdown', 'apply').length === 1, 'pending rich apply')
  await surface.update({ content: 'external replacement', revision: 8, contentRevision: 8 })
  await waitFor(() => errorMessage(surface.element, conflict), 'external revision conflict')
  expect(surface.element.querySelector('.ProseMirror')?.textContent).toContain('alpha')
  expect(surface.element.querySelector('.ProseMirror')?.textContent).not.toContain('external replacement')
  expect(notesCalls(surface, 'quirky.editor/markdown', 'apply')[0]?.params.expectedRevision).toBe(7)
  apply.resolve({ changed: true, sourcePreserved: true, buffer: { contentRevision: 8 } })
  await formatting.catch(() => {})
  expect(surface.element.querySelector('.ProseMirror')?.textContent).toContain('alpha')
  expect(errorMessage(surface.element, conflict)).not.toBeNull()
  expect(surface.element.querySelector('.ProseMirror')?.textContent).not.toContain('external replacement')
})

test('a pasted image transfer is cancelled when its captured selection changes before begin completes', async () => {
  const begin = deferred<unknown>()
  const bytes = Uint8Array.of(137, 80, 78, 71)
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/transfer') {
      if (params.action === 'begin') return begin.promise
      if (params.action === 'chunk') return { offset: bytes.length }
      if (params.action === 'commit') return { path: 'images/old.png' }
    }
    return {}
  } })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'image paste editor')
  const file = { name: 'fixture.png', type: 'image/png', size: bytes.length, slice: (start: number, end: number) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }) }
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { items: [], files: [file] } })
  await act(async () => { editor.dispatchEvent(paste) })
  await waitFor(() => surface.calls.some(call => call.method === 'quirky.editor/transfer' && call.params.action === 'begin'), 'bounded image begin')
  await selectRichText(surface, 'alpha')
  await act(async () => { begin.resolve({ transferId: 'old-image', maxChunkBytes: 65_536 }) })
  await waitFor(() => surface.calls.some(call => call.method === 'quirky.editor/transfer' && call.params.action === 'cancel'), 'cancelled old image transfer')
  expect(surface.calls.filter(call => call.method === 'quirky.editor/transfer' && call.params.action === 'cancel').map(call => call.params)).toEqual([{ action: 'cancel', transferId: 'old-image' }])
  expect(surface.calls.some(call => call.method === 'quirky.editor/transfer' && ['chunk', 'commit'].includes(String(call.params.action)))).toBe(false)
  expect(surface.calls.some(call => call.method === 'quirky.editor/markdown' && call.params.action === 'importImage')).toBe(false)
  expect(editor.textContent).toBe('alpha')
})

for (const mode of ['preview', 'rich'] as const) {
  for (const unit of ['a', 'é']) {
    test(`${mode} public Find and Replace preserve the UTF-8 query boundary for ${unit}`, async () => {
      const query = unit.repeat(unit === 'a' ? 2048 : 1024)
      const source = query + 'x'
      const surface = await renderSurface(mode, { content: source, call: async (method, params) => {
        if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true, previewAvailable: true, imageUrls: {} }
        if (method === 'quirky.editor/markdown' && params.action === 'search') return searchMarkdown(source, String(params.query), {})
        if (method === 'quirky.editor/markdown' && params.action === 'replace') return { replacements: 1 }
        return {}
      } })
      await surface.control(mode, 'find', { query })
      const search = await waitFor(() => surface.element.querySelector<HTMLElement>('.markdown-toolbar--search'), 'bounded query search')
      expect(search.textContent).toContain('1 of 1')
      await surface.control('search', 'replace-all', { query, text: 'replacement' })
      const replacements = surface.calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'replace')
      expect(replacements).toHaveLength(1)
      const oversized = query + 'x'
      await surface.control('search', 'find', { query: oversized })
      await waitFor(() => emptyState(search, 'No results'), 'oversized Find result')
      await expect(surface.control('search', 'replace-all', { query: oversized, text: 'replacement' })).rejects.toThrow('Markdown find queries are limited to 2 KiB.')
      expect(surface.calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'replace')).toHaveLength(1)
    })
  }
}

test('a delayed link check cannot navigate or clear a same-kind reopened link form', async () => {
  const checked = deferred<unknown>()
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'links') return checked.promise
    return {}
  } })
  await selectRichText(surface, 'alpha')
  await surface.control('selection', 'format', { value: 'link' })
  const oldAddress = surface.address('link')!
  const pending = surface.control('link', 'open', { target: 'https://old.test' })
  try {
    await waitFor(() => surface.calls.some(call => call.method === 'quirky.editor/markdown' && call.params.action === 'links'), 'pending old link check')
    await surface.control('link', 'close')
    await surface.control('selection', 'format', { value: 'link' })
    const current = await waitFor(() => surface.address('link'), 'reopened link control')
    expect(current.generation).not.toBe(oldAddress.generation)
    const field = surface.element.querySelector<HTMLInputElement>('input[aria-label="Paste or type a link"]')!
    await setValue(field, 'https://new.test')
    checked.resolve({ safe: true, kind: 'external' })
    await pending
    expect(field.value).toBe('https://new.test')
    expect(surface.address('link')?.generation).toBe(current.generation)
    expect(surface.calls.some(call => ['quirky.browser/openLink', 'quirky.terminal/openExternal', 'quirky.editor/open'].includes(call.method))).toBe(false)
  } finally {
    checked.resolve({ safe: true, kind: 'external' })
    await pending
  }
})

test('an apply acknowledgement projected before its RPC reply keeps the mounted rich generation and newer local draft', async () => {
  const reply = deferred<unknown>()
  let acknowledged: EditorSurfaceBuffer | undefined
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') return reply.promise
    return {}
  } })
  const original = (await waitFor(() => surface.address('rich'), 'rich acknowledgement origin')).generation
  const editor = surface.element.querySelector<HTMLElement>('.ProseMirror')!
  await selectRichText(surface, 'alpha')
  const changed = surface.control('selection', 'format', { value: 'bold' })
  try {
    const applied = await waitFor(() => surface.calls.find(call => call.method === 'quirky.editor/markdown' && call.params.action === 'apply'), 'pending apply request')
    acknowledged = makeBuffer('rich', 'alpha', { draft: String(applied.params.text), contentRevision: 2, revision: 2 })
    await surface.update(acknowledged)
    expect(surface.address('rich')?.generation).toBe(original)
    expect(errorMessage(surface.element, 'The Markdown draft changed elsewhere. Your local rich edit is retained; switch to source or compare before retrying.')).toBeNull()
    expect(editor.querySelector('strong')?.textContent).toBe('alpha')
    await typeRichText(editor, ' newer')
    expect(editor.textContent).toBe('alpha newer')
  } finally {
    reply.resolve({ buffer: acknowledged, sourcePreserved: true })
    await changed
  }
  expect(editor.textContent).toBe('alpha newer')
  expect(surface.address('rich')?.generation).toBe(original)
  expect(surface.calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')).toHaveLength(1)
})

test('renaming a mounted rich buffer before debounce preserves and flushes its local text', async () => {
  const surface = await renderSurface('rich', { content: 'alpha' })
  const editor = surface.element.querySelector<HTMLElement>('.ProseMirror')!
  await typeRichText(editor, ' newer')
  await surface.update({ path: '/tmp/markdown-states/renamed.md', relativePath: 'renamed.md', name: 'renamed.md', revision: 2 })
  expect(surface.element.querySelector('.ProseMirror')?.textContent).toBe('alpha newer')
  await act(async () => { await surface.commands()!.flush!() })
  expect(surface.calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'apply').at(-1)?.params.text).toBe('alpha newer')
})

test('preview replacement uses the current revision after an external update', async () => {
  const surface = await renderSurface('preview', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'search') return { total: 1, matches: [{ from: 0, to: 5, line: 1, text: 'alpha' }] }
    if (method === 'quirky.editor/markdown' && params.action === 'replace') {
      if (params.expectedRevision !== 2) throw new Error('stale fixture revision')
      return { replacements: 1 }
    }
    return {}
  } })
  await surface.update({ content: 'alpha alpha', contentRevision: 2, revision: 2 })
  await surface.control('preview', 'replace', { query: 'alpha' })
  expect(await surface.control('search', 'replace-all', { text: 'beta' })).toEqual({ delivered: true })
  expect(surface.calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'replace').at(-1)?.params.expectedRevision).toBe(2)
})

test('preview replacement acknowledges a close-reopened search session with unchanged drafts', async () => {
  let replacements = 0
  const surface = await renderSurface('preview', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'search') return { total: 1, matches: [{ from: 0, to: 5, line: 1, text: 'alpha' }] }
    if (method === 'quirky.editor/markdown' && params.action === 'replace') return { replacements: ++replacements }
    return {}
  } })
  await surface.control('preview', 'replace', { query: 'alpha' })
  await surface.control('search', 'replace-all', { text: 'beta' })
  await surface.control('preview', 'dismiss-feedback')
  await surface.control('search', 'close')
  await surface.control('preview', 'replace', { query: 'alpha' })
  await surface.control('search', 'replace-all', { text: 'beta' })
  expect([...surface.element.querySelectorAll('[role="status"]')].some(element => element.textContent?.includes('2 replacement(s)'))).toBe(true)
})

test('a committed Add note is not retryable as a new write when its inventory refresh fails', async () => {
  let listed = 0
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') {
      if (++listed === 2) throw new Error('fixture reload failed')
      return { notes: listed > 2 ? [notesNote('persisted note')] : [] }
    }
    return {}
  } })
  await notesOpenAdd(surface)
  await expect(surface.control('note', 'submit', { text: 'persisted note' })).rejects.toThrow('fixture reload failed')
  expect(surface.address('note')).toBeUndefined()
  expect(surface.element.querySelector('textarea[aria-label="Add note for the AI"]')).toBeNull()
  await surface.control('rich', 'refresh-notes')
  expect(surface.element.textContent).toContain('persisted note')
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toHaveLength(1)
})

test('an early rich acknowledgement preserves frontmatter and untouched Markdown syntax without replacing its generation', async () => {
  const prefix = '---\r\ntitle: fixture\r\n---\r\n'
  const reply = deferred<unknown>()
  const surface = await renderSurface('rich', { content: prefix + '* alpha\n', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') return reply.promise
    return {}
  } })
  const original = (await waitFor(() => surface.address('rich'), 'preserved-syntax origin')).generation
  await selectRichText(surface, 'alpha')
  const changed = surface.control('selection', 'format', { value: 'bold' })
  let acknowledged: EditorSurfaceBuffer | undefined
  try {
    const applied = await waitFor(() => surface.calls.find(call => call.method === 'quirky.editor/markdown' && call.params.action === 'apply'), 'preserved-syntax apply')
    const body = String(applied.params.text).replace(/^- /m, '* ') + '\n'
    acknowledged = makeBuffer('rich', prefix + '* alpha\n', { draft: prefix + body, dirty: true, contentRevision: 2, revision: 2 })
    await surface.update(acknowledged)
    expect(surface.address('rich')?.generation).toBe(original)
    expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
    expect(acknowledged.draft?.startsWith(prefix)).toBe(true)
  } finally {
    reply.resolve({ buffer: acknowledged, sourcePreserved: true })
    await changed
  }
})

test('an older note write cannot block or unlock a replacement composer write', async () => {
  const old = deferred<unknown>(), current = deferred<unknown>()
  let writes = 0
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'add') return ++writes === 1 ? old.promise : current.promise
    return {}
  } })
  await notesOpenAdd(surface)
  const first = surface.control('note', 'submit', { text: 'first note' })
  await waitFor(() => writes === 1, 'first pending note write')
  await surface.control('note', 'cancel')
  const replacement = await notesOpenAdd(surface)
  const second = surface.control('note', 'submit', { text: 'second note' })
  try {
    await waitFor(() => writes === 2, 'replacement pending note write')
    old.resolve({})
    await first
    const field = replacement.querySelector<HTMLTextAreaElement>('textarea')!
    expect(field.value).toBe('second note')
    expect(field.disabled).toBe(true)
    expect(surface.address('note')?.actions).not.toContain('submit')
  } finally {
    old.resolve({}); current.resolve({})
    await first; await second
  }
})

test('rich unmount flushes typed text before the debounce exactly once', async () => {
  const surface = await renderSurface('rich', { content: 'alpha' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich editor before unmount flush')
  await typeRichText(editor, ' before close')
  await surface.unmount()
  const apply = await waitFor(() => surface.calls.filter((call) =>
    call.method === 'quirky.editor/markdown' && call.params.action === 'apply'
  ).length === 1 ? surface.calls.find((call) =>
    call.method === 'quirky.editor/markdown' && call.params.action === 'apply'
  ) : undefined, 'one final rich apply')
  expect(apply.params.text).toBe('alpha before close')
  expect(surface.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')).toHaveLength(1)
})

test('source eligibility remains settled while a typed draft refresh is pending', async () => {
  const secondRead = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('source', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
      reads += 1
      return reads === 1 ? { richEligible: true } : secondRead.promise
    }
    return {}
  } })
  const source = surface.element.querySelector<HTMLElement>('.markdown-surface--source')!
  await waitFor(() => button(source, 'Rich Editor'), 'settled rich eligibility')
  const textarea = source.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown source"]')!
  await setValue(textarea, 'typed source')
  await surface.update({ draft: 'typed source' })
  await waitFor(() => reads === 2 ? true : undefined, 'draft capability refresh')
  expect(notice(source, 'Checking rich editor availability…')).toBeNull()
  expect(button(source, 'Rich Editor')).toBeDefined()
  expect(surface.address('source')?.actions).toContain('rich')
  secondRead.resolve({ richEligible: true })
  await waitFor(() => reads === 2 && !notice(source, 'Checking rich editor availability…') ? true : undefined, 'settled draft capability refresh')
})

test('preview read errors retain retry and source recovery without advertising dismissal', async () => {
  let reads = 0
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities' && params.includePreview) {
      reads += 1
      if (reads === 1) throw new Error('fixture preview read failed')
      return { previewAvailable: true, imageUrls: {} }
    }
    return {}
  } })
  await waitFor(() => errorMessage(surface.element, 'fixture preview read failed'), 'preview read error')
  const failedAddress = surface.address('preview')!
  expect(failedAddress.actions).toContain('retry')
  expect(failedAddress.actions).not.toContain('dismiss-error')
  expect(failedAddress.actions).not.toContain('dismiss-feedback')
  expect(button(surface.element, 'Open source')).toBeDefined()
  expect(await surface.control('preview', 'dismiss-error')).toEqual({ delivered: false })
  expect(errorMessage(surface.element, 'fixture preview read failed')).not.toBeNull()
  await surface.control('preview', 'retry')
  await waitFor(() => surface.element.querySelector('.markdown-preview-body'), 'preview read recovery')
  expect(surface.address('preview')?.actions).not.toContain('retry')
  expect(surface.address('preview')?.actions).not.toContain('dismiss-error')
  expect(surface.address('preview')?.actions).not.toContain('dismiss-feedback')
})

for (const mode of ['preview', 'rich'] as const) {
  test(`${mode} replacement keeps its search session when the buffer acknowledgement arrives before the reply`, async () => {
    const reply = deferred<unknown>()
    const surface = await renderSurface(mode, {
      content: 'alpha',
      buffer: { contentRevision: 7, revision: 7 },
      call: async (method, params) => {
        if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
          return params.includePreview ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
        }
        if (method === 'quirky.editor/markdown' && params.action === 'search') return searchMarkdown('alpha', String(params.query ?? ''))
        if (method === 'quirky.editor/markdown' && params.action === 'replace') return reply.promise
        return {}
      }
    })
    const modeAddress = await waitFor(() => surface.address(mode), `${mode} replacement base address`)
    await surface.control(mode, 'replace', { query: 'alpha' })
    const searchAddress = await waitFor(() => surface.address('search'), `${mode} replacement search address`)
    const replacing = surface.control('search', 'replace-all', { query: 'alpha', text: 'beta' })
    const request = await waitFor(() => surface.calls.find((call) =>
      call.method === 'quirky.editor/markdown' && call.params.action === 'replace'
    ), `${mode} replacement request`)
    expect(request.params.expectedRevision).toBe(7)

    const updated = makeBuffer(mode, 'beta', { contentRevision: 8, revision: 8 })
    await surface.update(updated)
    expect(surface.address(mode)?.generation).toBe(modeAddress.generation)
    expect(surface.address('search')?.generation).toBe(searchAddress.generation)
    reply.resolve({ replacements: 1, buffer: updated })
    await replacing
    await waitFor(() => [...surface.element.querySelectorAll<HTMLElement>('[role="status"]')]
      .some((item) => item.textContent?.includes('1 replacement(s)')), `${mode} replacement feedback`)
    expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
    expect(surface.address('search')?.generation).toBe(searchAddress.generation)
  })
}

test('rich export errors clear only when that same operation succeeds', async () => {
  let exports = 0
  const surface = await renderSurface('rich', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'exportPdf') {
      exports += 1
      if (exports === 1) throw new Error('fixture export failed')
      return { path: '/fixture/out.pdf' }
    }
    return {}
  } })
  await expect(surface.control('rich', 'export-pdf')).rejects.toThrow('fixture export failed')
  await waitFor(() => errorMessage(surface.element, 'fixture export failed'), 'export operation error')
  expect(surface.element.querySelectorAll('.ui-inline-error__message')).toHaveLength(1)
  await surface.control('rich', 'export-pdf')
  expect(errorMessage(surface.element, 'fixture export failed')).toBeNull()
  expect([...surface.element.querySelectorAll<HTMLElement>('[role="status"]')]
    .some((item) => item.textContent?.includes('Exported PDF to /fixture/out.pdf.'))).toBe(true)
})

test('a failed Add note flush has one owning InlineError', async () => {
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') throw new Error('fixture note flush failed')
    return {}
  } })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich editor before note flush failure')
  await typeRichText(editor, ' before note')
  const dialog = await notesOpenAdd(surface)
  await setValue(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Add note for the AI"]')!, 'comment')
  await expect(surface.control('note', 'submit')).rejects.toThrow('fixture note flush failed')
  await waitFor(() => errorMessage(surface.element, 'fixture note flush failed'), 'note flush InlineError')
  expect([...surface.element.querySelectorAll<HTMLElement>('.ui-inline-error__message')]
    .filter((message) => message.textContent === 'fixture note flush failed')).toHaveLength(1)
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toHaveLength(0)
})

test('review notes reload when an acknowledged rich content revision advances', async () => {
  let reads = 0
  const surface = await renderSurface('rich', { content: 'alpha', buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') {
      reads += 1
      return { notes: [] }
    }
    if (method === 'quirky.editor/markdown' && params.action === 'apply') return {
      sourcePreserved: true, buffer: { contentRevision: 8, revision: 8 }
    }
    return {}
  } })
  await waitFor(() => reads === 1 ? true : undefined, 'initial notes read')
  await selectRichText(surface, 'alpha')
  await surface.control('selection', 'format', { value: 'bold' })
  await surface.update({ contentRevision: 8, revision: 8 })
  await waitFor(() => reads === 2 ? true : undefined, 'notes read for acknowledged content revision')
  expect(notesCalls(surface, 'quirky.editor/notes', 'list')).toHaveLength(2)
})

test('feedback dismissal and unrelated success preserve the owning operation error', async () => {
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() {} } })
  const surface = await renderSurface('rich', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'exportPdf') throw new Error('fixture export failed')
    if (method === 'quirky.editor/notes' && params.action === 'copy') return { text: '', count: 0 }
    return {}
  } })
  try {
    await expect(surface.control('rich', 'export-pdf')).rejects.toThrow('fixture export failed')
    await waitFor(() => errorMessage(surface.element, 'fixture export failed'), 'owning export error')
    await surface.control('rich', 'copy-notes')
    expect(errorMessage(surface.element, 'fixture export failed')).not.toBeNull()
    expect([...surface.element.querySelectorAll<HTMLElement>('[role="status"]')]
      .some((item) => item.textContent?.includes('No review notes to copy.'))).toBe(true)

    await surface.control('rich', 'dismiss-feedback')
    expect(errorMessage(surface.element, 'fixture export failed')).not.toBeNull()
    expect([...surface.element.querySelectorAll('[role="status"]')]
      .some((item) => item.textContent?.includes('No review notes to copy.'))).toBe(false)

    await surface.control('rich', 'copy-notes')
    await surface.control('rich', 'dismiss-error')
    expect(errorMessage(surface.element, 'fixture export failed')).toBeNull()
    expect([...surface.element.querySelectorAll<HTMLElement>('[role="status"]')]
      .some((item) => item.textContent?.includes('No review notes to copy.'))).toBe(true)
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('rich eligibility stays settled while an acknowledged draft refresh is pending', async () => {
  const secondRead = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
      reads += 1
      return reads === 1
        ? { richEligible: false, richReason: 'This document exceeds 600 MB.' }
        : secondRead.promise
    }
    if (method === 'quirky.editor/markdown' && params.action === 'apply') {
      return { sourcePreserved: true, buffer: { contentRevision: 2, revision: 2 } }
    }
    return {}
  } })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich editor for eligibility acknowledgement')
  await waitFor(() => button(surface.element, 'Open anyway'), 'settled rich override advisory')
  const generation = (await waitFor(() => surface.address('rich'), 'rich eligibility control')).generation
  await typeRichText(editor, ' typed')
  await surface.control('rich', 'retry-flush')
  const apply = surface.calls.find((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')!
  await surface.update({ draft: String(apply.params.text), contentRevision: 2, revision: 2 })
  await waitFor(() => reads === 2 ? true : undefined, 'acknowledged rich eligibility refresh')
  expect(notice(surface.element, 'Checking rich editing availability…')).toBeNull()
  expect(button(surface.element, 'Open anyway')).toBeDefined()
  expect(surface.address('rich')?.generation).toBe(generation)
  expect(surface.address('rich')?.actions).toContain('open-anyway')
  secondRead.resolve({ richEligible: true })
  await waitFor(() => button(surface.element, 'Open anyway') === undefined ? true : undefined, 'settled rich eligibility replacement')
})

async function g353PressRichKey(editor: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => { editor.dispatchEvent(event) })
  return event.defaultPrevented
}

function g353RoutedArgs(surface: MountedSurface, target: string, action: string): Record<string, unknown> | undefined {
  return surface.calls
    .filter((call) => call.method === 'ui.window.command.run')
    .map((call) => call.params.args)
    .find((args): args is Record<string, unknown> =>
      typeof args === 'object' && args !== null && !Array.isArray(args) &&
      (args as Record<string, unknown>).target === target && (args as Record<string, unknown>).action === action)
}

test('preview capability failures from a replaced source cannot replace the current preview', async () => {
  const obsolete = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities' && params.includePreview) {
      if (++reads === 1) return obsolete.promise
      return { previewAvailable: true, imageUrls: {} }
    }
    return {}
  } })
  await waitFor(() => reads === 1 ? reads : undefined, 'initial pending preview capability read')
  await surface.update({
    path: '/tmp/markdown-states/replacement.md', relativePath: 'replacement.md', name: 'replacement.md',
    content: '# Replacement document', contentRevision: 2, revision: 2
  })
  await waitFor(() => reads === 2 ? reads : undefined, 'replacement preview capability read')
  const preview = await waitFor(() => {
    const article = surface.element.querySelector<HTMLElement>('.markdown-preview-body')
    return article?.textContent?.includes('Replacement document') ? article : undefined
  }, 'replacement preview content')
  await act(async () => { obsolete.reject(new Error('obsolete preview failure')); await Bun.sleep(10) })
  expect(preview.textContent).toContain('Replacement document')
  expect(errorMessage(surface.element, 'obsolete preview failure')).toBeNull()
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test('unmounting a preview fences a pending capability failure', async () => {
  const pending = deferred<unknown>()
  let reads = 0
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities' && params.includePreview) {
      reads += 1
      return pending.promise
    }
    return {}
  } })
  await waitFor(() => notice(surface.element, 'Preparing preview…'), 'pending preview state before unmount')
  await waitFor(() => reads === 1 ? reads : undefined, 'in-flight preview capability request')
  await surface.unmount()
  await act(async () => { pending.reject(new Error('late preview failure')); await Bun.sleep(10) })
  expect(surface.element.textContent).toBe('')
  expect(reads).toBe(1)
  expect(surface.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'capabilities' && call.params.includePreview)).toHaveLength(1)
})
test('missing Markdown anchors use InlineError in preview and rich modes', async () => {
  for (const scenario of [
    { mode: 'preview' as const, message: 'No Markdown preview heading or HTML anchor matches “missing-anchor”.' },
    { mode: 'rich' as const, message: 'No Markdown heading matches “missing-anchor”.' }
  ]) {
    const surface = await renderSurface(scenario.mode, { buffer: { view: { markdownAnchor: 'missing-anchor' } } })
    const content = scenario.mode === 'preview'
      ? await waitFor(() => surface.element.querySelector('.markdown-preview-body'), 'preview document before missing-anchor resolution')
      : await waitFor(() => surface.element.querySelector('.ProseMirror'), 'rich document before missing-anchor resolution')
    expect(content).toBeDefined()
    const failure = await waitFor(() => errorMessage(surface.element, scenario.message), `${scenario.mode} missing-anchor error`)
    expect(failure.textContent).toBe(scenario.message)
    expect([...surface.element.querySelectorAll<HTMLElement>('[role="status"]')].some((item) => item.textContent?.includes(scenario.message))).toBe(false)
  }
})

test('source-preservation flush failures expose Retry and Open source recovery', async () => {
  let retryAttempts = 0
  const retry = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') {
      retryAttempts += 1
      return retryAttempts === 1 ? { sourcePreserved: false } : { sourcePreserved: true }
    }
    return {}
  } })
  await waitFor(() => retry.element.querySelector('.ProseMirror'), 'rich editor for flush retry')
  await selectRichText(retry, 'alpha')
  await expect(retry.control('selection', 'format', { value: 'bold' })).rejects.toThrow('Rich Markdown update did not preserve its source bytes.')
  await waitFor(() => errorMessage(retry.element, 'Rich Markdown update did not preserve its source bytes.'), 'source-preservation InlineError')
  expect(retry.address('rich')?.actions).toContain('retry-flush')
  expect(await retry.control('rich', 'retry-flush')).toEqual({ delivered: true })
  expect(retryAttempts).toBe(2)
  expect(errorMessage(retry.element, 'Rich Markdown update did not preserve its source bytes.')).toBeNull()
  expect(retry.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')).toHaveLength(2)

  let sourceAttempts = 0
  const source = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'apply') {
      sourceAttempts += 1
      return { sourcePreserved: false }
    }
    return {}
  } })
  await waitFor(() => source.element.querySelector('.ProseMirror'), 'rich editor for source recovery')
  await selectRichText(source, 'alpha')
  await expect(source.control('selection', 'format', { value: 'bold' })).rejects.toThrow('Rich Markdown update did not preserve its source bytes.')
  await waitFor(() => errorMessage(source.element, 'Rich Markdown update did not preserve its source bytes.'), 'failed flush before Open source')
  await click(source.element, 'Open source')
  await waitFor(() => source.calls.find((call) => call.method === 'quirky.editor/view' && call.params.action === 'update'), 'Open source view update')
  expect(sourceAttempts).toBe(2)
  expect(source.calls.find((call) => call.method === 'quirky.editor/view' && call.params.action === 'update')?.params).toMatchObject({
    bufferId: 'buffer-markdown-states', tabId: 'tab-markdown-states', patch: { mode: 'source' }
  })
})

test('link and code copying show their successful non-error status messages', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text: string) { writes.push(text) } } })
  try {
    const link = await renderSurface('rich', { content: 'alpha' })
    await waitFor(() => link.element.querySelector('.ProseMirror'), 'link-copy editor')
    await selectRichText(link, 'alpha')
    expect(await link.control('selection', 'format', { value: 'link' })).toEqual({ delivered: true })
    await waitFor(() => link.address('link'), 'registered link actions')
    expect(await link.control('link', 'copy', { target: 'https://fixture.invalid/docs' })).toEqual({ delivered: true })
    const copiedLink = await waitFor(() => [...link.element.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent?.includes('Copied link')), 'Copied link status')
    expect(copiedLink.textContent).toContain('Copied link')
    expect(link.element.querySelector('.ui-inline-error')).toBeNull()
    expect(link.element.querySelector('[role="alert"]')).toBeNull()

    const code = await renderSurface('rich', { content: '```python\nalpha\n```' })
    await waitFor(() => code.element.querySelector('.ProseMirror'), 'code-copy editor')
    await selectRichText(code, 'alpha')
    expect(await code.control('selection', 'copy-code')).toEqual({ delivered: true })
    const copiedCode = await waitFor(() => [...code.element.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent?.includes('Copied code')), 'Copied code status')
    expect(copiedCode.textContent).toContain('Copied code')
    expect(code.element.querySelector('.ui-inline-error')).toBeNull()
    expect(code.element.querySelector('[role="alert"]')).toBeNull()
    expect(writes).toEqual(['https://fixture.invalid/docs', 'alpha'])
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('copying an empty review-note set reports a non-error status', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(text: string) { writes.push(text) } } })
  try {
    const surface = await renderSurface('rich', { call: async (method, params) => {
      if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
      if (method === 'quirky.editor/notes' && params.action === 'copy') return { text: '', count: 0 }
      return {}
    } })
    await notesOpenNotes(surface)
    expect(await surface.control('rich', 'copy-notes')).toEqual({ delivered: true })
    const status = await waitFor(() => [...surface.element.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent?.includes('No review notes to copy.')), 'empty notes copy status')
    expect(status.textContent).toContain('No review notes to copy.')
    expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
    expect(surface.element.querySelector('[role="alert"]')).toBeNull()
    expect(writes).toEqual([''])
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('successful delivery of two review notes is reported as non-error feedback', async () => {
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    if (method === 'quirky.session/list') return notesSessionInventory
    if (method === 'quirky.agents/list') return notesAgentInventory
    if (method === 'quirky.editor/notes' && params.action === 'send') return { deletedNoteIds: ['n1', 'n2'] }
    return {}
  } })
  await notesOpenSend(surface)
  expect(await surface.control('send', 'send', { target: 'new', agent: 'agent2' })).toEqual({ delivered: true })
  const status = await waitFor(() => [...surface.element.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent?.includes('2 note(s) delivered.')), 'two-note delivery status')
  expect(status.textContent).toContain('2 note(s) delivered.')
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
  expect(surface.element.querySelector('[role="alert"]')).toBeNull()
  expect(notesCalls(surface, 'quirky.editor/notes', 'send').map((call) => call.params)).toEqual([
    { bufferId: 'b1', action: 'send', target: 'new', agent: 'agent2' }
  ])
  expect(surface.address('send')).toBeUndefined()
})

test('custom strike and link shortcuts dispatch their registered selection operations', async () => {
  const strike = await renderSurface('rich', { content: 'alpha' })
  const strikeEditor = await waitFor(() => strike.element.querySelector<HTMLElement>('.ProseMirror'), 'strike shortcut editor')
  await selectRichText(strike, 'alpha')
  const strikeSelection = await waitFor(() => strike.address('selection'), 'strike selection address')
  expect(await g353PressRichKey(strikeEditor, 'x', { ctrlKey: true, shiftKey: true })).toBe(true)
  await waitFor(() => strikeEditor.querySelector('s')?.textContent === 'alpha' ? strikeEditor.querySelector('s') : undefined, 'strike shortcut formatting')
  expect(g353RoutedArgs(strike, strikeSelection.target, 'format')).toMatchObject({ data: { value: 'strike' } })

  const link = await renderSurface('rich', { content: 'alpha' })
  const linkEditor = await waitFor(() => link.element.querySelector<HTMLElement>('.ProseMirror'), 'link shortcut editor')
  await selectRichText(link, 'alpha')
  const linkSelection = await waitFor(() => link.address('selection'), 'link selection address')
  expect(await g353PressRichKey(linkEditor, 'k', { ctrlKey: true })).toBe(true)
  const linkAddress = await waitFor(() => link.address('link'), 'link shortcut popup')
  expect(linkAddress.actions).toContain('save')
  expect(g353RoutedArgs(link, linkSelection.target, 'format')).toMatchObject({ data: { value: 'link' } })
})

test('slash and document completion Enter and Tab accept through their addressed choices', async () => {
  for (const key of ['Enter', 'Tab']) {
    const slash = await renderSurface('rich', { content: '' })
    const slashEditor = await waitFor(() => slash.element.querySelector<HTMLElement>('.ProseMirror'), `${key} slash editor`)
    await typeRichText(slashEditor, '/quote')
    const slashAddress = await waitFor(() => slash.address('slash'), `${key} slash menu`)
    await waitFor(() => {
      const dialog = slash.element.querySelector('[role="dialog"][aria-label="Slash commands"]')
      return dialog ? button(dialog, 'Basic blocks: Quote') : undefined
    }, `${key} current quote result`)
    expect(await g353PressRichKey(slashEditor, key)).toBe(true)
    await waitFor(() => slashEditor.querySelector('blockquote'), `${key} slash quote insertion`)
    expect(slash.address('slash')).toBeUndefined()
    expect(g353RoutedArgs(slash, slashAddress.target, 'choose')).toMatchObject({ data: { id: 'quote' } })

    const documents = await renderSurface('rich', { content: '', call: async (method, params) => {
      if (method === 'quirky.editor/markdown' && params.action === 'documents') {
        return { documents: [{ relativePath: 'docs/Guide.md', name: 'Guide.md' }], total: 1, truncated: false }
      }
      return {}
    } })
    const documentEditor = await waitFor(() => documents.element.querySelector<HTMLElement>('.ProseMirror'), `${key} document-completion editor`)
    await typeRichText(documentEditor, '[[Gui')
    const documentAddress = await waitFor(() => documents.address('documents'), `${key} document menu`)
    await waitFor(() => {
      const dialog = documents.element.querySelector('[role="dialog"][aria-label="Markdown document links"]')
      return dialog ? button(dialog, 'docs/Guide.md') : undefined
    }, `${key} current document result`)
    expect(await g353PressRichKey(documentEditor, key)).toBe(true)
    const atom = await waitFor(() => documentEditor.querySelector<HTMLElement>('[data-markdown-document-link]'), `${key} document-link insertion`)
    expect(atom.getAttribute('data-target')).toBe('docs/Guide')
    expect(documents.address('documents')).toBeUndefined()
    expect(g353RoutedArgs(documents, documentAddress.target, 'choose')).toMatchObject({ data: { path: 'docs/Guide.md' } })
  }
})

test('Escape closes slash and document completion popups without accepting a result', async () => {
  const slash = await renderSurface('rich', { content: '' })
  const slashEditor = await waitFor(() => slash.element.querySelector<HTMLElement>('.ProseMirror'), 'slash Escape editor')
  await typeRichText(slashEditor, '/quote')
  const slashAddress = await waitFor(() => slash.address('slash'), 'slash menu before Escape')
  expect(await g353PressRichKey(slashEditor, 'Escape')).toBe(true)
  await waitFor(() => slash.address('slash') === undefined ? slashEditor : undefined, 'slash popup close')
  expect(slashEditor.textContent).toContain('/quote')
  expect(g353RoutedArgs(slash, slashAddress.target, 'choose')).toBeUndefined()

  const documents = await renderSurface('rich', { content: '', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'documents') {
      return { documents: [{ relativePath: 'docs/Guide.md', name: 'Guide.md' }], total: 1, truncated: false }
    }
    return {}
  } })
  const editor = await waitFor(() => documents.element.querySelector<HTMLElement>('.ProseMirror'), 'document Escape editor')
  await typeRichText(editor, '[[Gui')
  const documentAddress = await waitFor(() => documents.address('documents'), 'document menu before Escape')
  await waitFor(() => {
    const dialog = documents.element.querySelector('[role="dialog"][aria-label="Markdown document links"]')
    return dialog ? button(dialog, 'docs/Guide.md') : undefined
  }, 'current document result before Escape')
  expect(await g353PressRichKey(editor, 'Escape')).toBe(true)
  await waitFor(() => documents.address('documents') === undefined ? editor : undefined, 'document popup close')
  expect(editor.textContent).toContain('[[Gui')
  expect(editor.querySelector('[data-markdown-document-link]')).toBeNull()
  expect(g353RoutedArgs(documents, documentAddress.target, 'choose')).toBeUndefined()
})

test('code-block Tab and Shift+Tab invoke registered indent and outdent operations', async () => {
  const surface = await renderSurface('rich', { content: '```text\nalpha\nbeta\n```' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'code indentation editor')
  await selectRichText(surface, 'alpha')
  expect(await g353PressRichKey(editor, 'Tab')).toBe(true)
  await waitFor(() => editor.querySelector('pre code')?.textContent?.startsWith('  alpha') ? editor.querySelector('pre code') : undefined, 'indented code selection')
  await selectRichText(surface, '  alpha')
  expect(await g353PressRichKey(editor, 'Tab', { shiftKey: true })).toBe(true)
  await waitFor(() => editor.querySelector('pre code')?.textContent?.startsWith('alpha') ? editor.querySelector('pre code') : undefined, 'outdented code selection')
  const operations = surface.calls
    .filter((call) => call.method === 'ui.window.command.run')
    .map((call) => call.params.args as Record<string, unknown>)
    .filter((args) => args.action === 'code-indent')
  expect(operations.map((args) => args.data)).toEqual([{ outdent: false }, { outdent: true }])
})

test('empty code-language value is accepted and updates the active code block', async () => {
  const surface = await renderSurface('rich', { content: '```python\nalpha\n```' })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'plain-text language editor')
  await selectRichText(surface, 'alpha')
  expect(await surface.control('selection', 'code-language', { value: '' })).toEqual({ delivered: true })
  const language = await waitFor(() => {
    const select = surface.element.querySelector<HTMLSelectElement>('select[aria-label="Code language"]')
    return select?.value === '' ? select : undefined
  }, 'Plain text language selection')
  expect(language.value).toBe('')
  expect(editor.querySelector('pre code')).not.toBeNull()
})

test('multibyte selection over 32,768 UTF-8 bytes cannot open an Add note composer', async () => {
  const text = 'é'.repeat(16_385)
  expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(32_768)
  const surface = await renderSurface('rich', { content: text, buffer: notesBufferA })
  await waitFor(() => surface.address('rich'), 'rich control for multibyte selection limit')
  await waitFor(() => surface.element.querySelector('.ProseMirror'), 'real TipTap editor for multibyte selection')
  await selectRichText(surface, text)
  expect(await surface.control('selection', 'add-review-note')).toEqual({ delivered: false })
  expect(surface.address('note')).toBeUndefined()
  expect(surface.element.querySelector('[role="dialog"][aria-label="Add note for the AI"]')).toBeNull()
  expect(notesCalls(surface, 'quirky.editor/notes', 'add')).toHaveLength(0)
})

test('forged note IDs and TOC levels outside 1–5 are refused without delegated effects', async () => {
  const surface = await renderSurface('rich', { buffer: notesBufferA, call: async (method, params) => {
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [notesNote()] }
    if (method === 'quirky.editor/markdown' && params.action === 'toc') {
      return { headings: [{ id: 'heading-1', text: 'Heading', line: 1, level: 1 }] }
    }
    return {}
  } })
  const notes = await notesOpenNotes(surface)
  await waitFor(() => notes.textContent?.includes('existing note') ? notes : undefined, 'current note inventory')
  await surface.control('rich', 'toc', { open: true })
  await waitFor(() => surface.element.querySelector('[aria-label="Table of Contents"]'), 'current TOC')
  const callsBeforeInvalid = surface.calls.length
  expect(await surface.control('rich', 'edit-note', { noteId: 'forged-note-id' })).toEqual({ delivered: false })
  expect(await surface.control('rich', 'delete-note', { noteId: 'forged-note-id' })).toEqual({ delivered: false })
  expect(await surface.control('rich', 'toc-level', { level: 0, visible: false })).toEqual({ delivered: false })
  expect(await surface.control('rich', 'toc-level', { level: 6, visible: false })).toEqual({ delivered: false })
  expect(surface.calls).toHaveLength(callsBeforeInvalid)
  expect(notesCalls(surface, 'quirky.editor/notes', 'edit')).toHaveLength(0)
  expect(notesCalls(surface, 'quirky.editor/notes', 'delete')).toHaveLength(0)
  expect(notes.textContent).toContain('existing note')
  expect(surface.address('note')).toBeUndefined()
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test('source replacement fences an old emoji import failure from the reopened picker', async () => {
  const child = Bun.spawn([process.execPath, '-'], { cwd: resolve(import.meta.dir, '..'),
    stdin: new TextEncoder().encode(String.raw`import assert from 'node:assert/strict'
import React, { act } from 'react'
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register(); globalThis.IS_REACT_ACT_ENVIRONMENT = true
const firstImport = Promise.withResolvers(); let importReads = 0
mock.module('emoji-picker-react', () => { importReads += 1; return firstImport.promise })
const { createRoot } = await import('react-dom/client')
const { MarkdownSurface } = await import('./src/markdown/MarkdownSurface')
const ui = await import('./src/ui'), controls = await import('./src/window/uiControl')
const provided = new Map()
const context = {
  pluginId: 'quirky.editor', provide(id, handler) { provided.set(id, handler) },
  async call(method, params = {}) {
    if (method === 'ui.window.self') return { connId: 22 }
    if (method === 'ui.window.command.run') return { result: await provided.get(params.id)(params.args) }
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    return {}
  },
  subscribe() { return () => {} }, onConnection() { return () => {} }, getSetting() { return 300 }, getLayout() { return {} }, toast() {}
}
ui.activate(context)
let buffer = { id: 'emoji-stale-import', worktreeId: 'wt', root: '/tmp', path: '/tmp/emoji-stale-import.md', relativePath: 'emoji-stale-import.md', name: 'emoji-stale-import.md', kind: 'markdown', content: 'alpha', draft: null, baseline: null, size: 5, readOnly: false, dirty: false, external: null, mode: 'rich', tabId: 'tab-emoji-stale-import', preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null, diskContentLength: null, diskContentBytes: null, diskSignature: null }
const host = document.createElement('div'); document.body.append(host)
const root = createRoot(host); let report = {}
const scope = controls.createEditorUiControlReportScope(value => { report = value }, { surface: 'view:quirky.editor/document', context })
scope.report({ mounted: true, bufferId: buffer.id, tabId: buffer.tabId, mode: 'rich' })
const props = { context, fontSize: 13, onDraft() {}, onAction: (method, params) => context.call(method, params), onView() {}, registerCommandHandlers() { return () => {} } }
const render = () => React.createElement(controls.EditorUiControlProvider, { scope }, React.createElement(MarkdownSurface, { ...props, buffer }))
const wait = async predicate => { for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await Bun.sleep(5) } throw Error('fixture timed out: ' + predicate.toString()) }
const address = kind => report.uiControls?.find(item => item.target.startsWith('markdown-' + kind + ':'))
const sendAddress = async (item, action, data) => {
  const identity = await context.call('ui.window.self', {})
  return context.call('ui.window.command.run', { connId: identity.connId, id: 'command:quirky.editor/ui-control', args: { surface: item.surface, target: item.target, generation: item.generation, action, ...(data === undefined ? {} : { data }) } })
}
const send = async (kind, action, data) => {
  const item = await wait(() => address(kind))
  let result
  await act(async () => { result = await sendAddress(item, action, data) })
  return result
}
try {
  await act(async () => root.render(render()))
  await wait(() => host.querySelector('.ProseMirror'))
  await send('rich', 'more', { open: true }); await send('more', 'choose', { value: 'emoji' })
  await wait(() => address('emoji'))
  await wait(() => host.querySelector('[role="dialog"][aria-label="Emoji picker"] .ui-notice-line') && importReads === 1)
  mock.module('emoji-picker-react', () => { importReads += 1; return { default: () => React.createElement('span', null, 'native picker ready'), EmojiStyle: { NATIVE: 'native' } } })
  buffer = { ...buffer, id: 'emoji-stale-import-replacement', path: '/tmp/emoji-stale-import-replacement.md', relativePath: 'emoji-stale-import-replacement.md', name: 'emoji-stale-import-replacement.md', tabId: 'tab-emoji-stale-import-replacement', content: 'beta', size: 4, revision: 2, contentRevision: 2 }
  scope.report({ mounted: true, bufferId: buffer.id, tabId: buffer.tabId, mode: 'rich' })
  await act(async () => root.render(render()))
  await wait(() => !address('emoji'))
  await wait(() => {
    const item = address('rich')
    return item && item.target.includes('emoji-stale-import-replacement') ? item : undefined
  })
  await send('rich', 'more', { open: true }); await send('more', 'choose', { value: 'emoji' })
  const currentAddress = await wait(() => address('emoji'))
  await wait(() => host.textContent.includes('native picker ready') && importReads === 2)
  firstImport.reject(new Error('obsolete emoji import failed'))
  await act(async () => { await Bun.sleep(10) })
  assert.equal(address('emoji').generation, currentAddress.generation)
  assert.ok(host.textContent.includes('native picker ready'), 'the replacement picker stays ready')
  assert.equal(host.querySelector('.ui-inline-error'), null, 'the obsolete failure does not surface in the source-replaced picker')
  assert.ok(host.querySelector('.ProseMirror')?.textContent?.includes('beta'), 'the replacement document remains mounted')
  assert.equal(address('emoji').generation, currentAddress.generation)
  assert.equal(host.querySelector('.ui-inline-error'), null)
} finally {
  firstImport.resolve({ default: () => React.createElement('span', null, 'native picker ready'), EmojiStyle: { NATIVE: 'native' } })
  await act(async () => root.unmount()); scope.dispose(); host.remove()
  ui.deactivate(); await GlobalRegistrator.unregister()
}
`), stdout: 'pipe', stderr: 'pipe'
  })
  const killTimer = setTimeout(() => child.kill(), 25_000)
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (status !== 0) throw new Error(`Isolated stale emoji import scenario failed (${status}):\n${stdout}\n${stderr}`)
  } finally {
    clearTimeout(killTimer)
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
}, 30_000)

test('emoji insertion flushes through the apply queue and closes only its own popup', async () => {
  const child = Bun.spawn([process.execPath, '-'], { cwd: resolve(import.meta.dir, '..'),
    stdin: new TextEncoder().encode(String.raw`import assert from 'node:assert/strict'
import React, { act } from 'react'
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register(); globalThis.IS_REACT_ACT_ENVIRONMENT = true
mock.module('emoji-picker-react', () => ({ default: () => React.createElement('span', null, 'native picker ready'), EmojiStyle: { NATIVE: 'native' } }))
const { createRoot } = await import('react-dom/client')
const { MarkdownSurface } = await import('./src/markdown/MarkdownSurface')
const ui = await import('./src/ui'), controls = await import('./src/window/uiControl')
const provided = new Map(), calls = []
const context = {
  pluginId: 'quirky.editor', provide(id, handler) { provided.set(id, handler) },
  async call(method, params = {}) {
    calls.push({ method, params })
    if (method === 'ui.window.self') return { connId: 22 }
    if (method === 'ui.window.command.run') return { result: await provided.get(params.id)(params.args) }
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }
    if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }
    if (method === 'quirky.editor/markdown' && params.action === 'apply') return { changed: true, sourcePreserved: true }
    return {}
  },
  subscribe() { return () => {} }, onConnection() { return () => {} }, getSetting() { return 300 }, getLayout() { return {} }, toast() {}
}
ui.activate(context)
const makeSurface = id => {
  const buffer = { id, worktreeId: 'wt', root: '/tmp', path: '/tmp/' + id + '.md', relativePath: id + '.md', name: id + '.md', kind: 'markdown', content: 'alpha', draft: null, baseline: null, size: 5, readOnly: false, dirty: false, external: null, mode: 'rich', tabId: 'tab-' + id, preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null, diskContentLength: null, diskContentBytes: null, diskSignature: null }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); let report = {}
  const scope = controls.createEditorUiControlReportScope(value => { report = value }, { surface: 'view:quirky.editor/document', context })
  scope.report({ mounted: true, bufferId: id, tabId: buffer.tabId, mode: 'rich' })
  const props = { context, buffer, fontSize: 13, onDraft() {}, onAction: (method, params) => context.call(method, params), onView() {}, registerCommandHandlers() { return () => {} } }
  const render = () => React.createElement(controls.EditorUiControlProvider, { scope }, React.createElement(MarkdownSurface, props))
  return { id, host, root, scope, report: () => report, render }
}
const wait = async predicate => { for (let i = 0; i < 400; i++) { const value = predicate(); if (value) return value; await Bun.sleep(5) } throw Error('fixture timed out') }
const address = (surface, kind) => surface.report().uiControls?.find(item => item.target.startsWith('markdown-' + kind + ':'))
const sendAddress = async (item, action, data) => {
  const identity = await context.call('ui.window.self', {})
  return context.call('ui.window.command.run', { connId: identity.connId, id: 'command:quirky.editor/ui-control', args: { surface: item.surface, target: item.target, generation: item.generation, action, ...(data === undefined ? {} : { data }) } })
}
const send = async (surface, kind, action, data) => {
  const item = await wait(() => address(surface, kind))
  let result
  await act(async () => { result = await sendAddress(item, action, data) })
  return result
}
let first, second
try {
  first = makeSurface('emoji-first'); second = makeSurface('emoji-second')
  await act(async () => { first.root.render(first.render()); second.root.render(second.render()) })
  await wait(() => first.host.querySelector('.ProseMirror') && second.host.querySelector('.ProseMirror'))
  await send(first, 'rich', 'more', { open: true }); await send(first, 'more', 'choose', { value: 'emoji' })
  await wait(() => first.host.textContent.includes('native picker ready'))
  await send(second, 'rich', 'more', { open: true }); await send(second, 'more', 'choose', { value: 'emoji' })
  const secondPopup = await wait(() => address(second, 'emoji'))
  await wait(() => second.host.textContent.includes('native picker ready'))
  const inserted = await send(first, 'emoji', 'insert', { value: '🙂' })
  assert.deepEqual(inserted, { result: { delivered: true } })
  await wait(() => !address(first, 'emoji'))
  assert.equal(address(first, 'emoji'), undefined, 'the insertion closes its originating picker')
  assert.equal(address(second, 'emoji')?.generation, secondPopup.generation, 'the other live picker keeps its own generation')
  assert.ok(second.host.querySelector('[role="dialog"][aria-label="Emoji picker"]'), 'the other popup remains visible')
  assert.ok(first.host.querySelector('.ProseMirror')?.textContent?.includes('🙂'))
  const applies = calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')
  assert.equal(applies.length, 1, 'emoji insertion passes through the serialized apply queue')
  assert.equal(applies[0].params.bufferId, 'emoji-first')
  assert.ok(String(applies[0].params.text).includes('🙂'))
} finally {
  if (first) { await act(async () => first.root.unmount()); first.scope.dispose(); first.host.remove() }
  if (second) { await act(async () => second.root.unmount()); second.scope.dispose(); second.host.remove() }
  ui.deactivate(); await GlobalRegistrator.unregister()
}
`), stdout: 'pipe', stderr: 'pipe'
  })
  const killTimer = setTimeout(() => child.kill(), 25_000)
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (status !== 0) throw new Error(`Isolated emoji apply-queue scenario failed (${status}):\n${stdout}\n${stderr}`)
  } finally {
    clearTimeout(killTimer)
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
}, 30_000)

test('rejected preview search settles its pending status', async () => {
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'search') throw new Error('fixture search failed')
    return {}
  } })
  await expect(surface.control('preview', 'find', { query: 'alpha' })).rejects.toThrow('fixture search failed')
  await waitFor(() => errorMessage(surface.element, 'fixture search failed'), 'search failure')
  expect(notice(surface.element, 'Searching preview…')).toBeNull()
})

test('final unmount flush advances revision after an in-flight apply', async () => {
  const first = deferred<unknown>()
  let writes = 0
  const surface = await renderSurface('rich', { content: 'alpha', call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }
    if (method === 'quirky.editor/markdown' && params.action === 'apply') {
      if (++writes === 1) return first.promise
      return { sourcePreserved: true, buffer: { contentRevision: 3, revision: 3 } }
    }
    return {}
  } })
  const editor = await waitFor(() => surface.element.querySelector<HTMLElement>('.ProseMirror'), 'rich editor')
  await typeRichText(editor, ' first')
  const flushing = surface.control('rich', 'retry-flush')
  await waitFor(() => writes === 1, 'in-flight first apply')
  await typeRichText(editor, ' final')
  await surface.unmount()
  first.resolve({ sourcePreserved: true, buffer: { contentRevision: 2, revision: 2 } })
  await flushing
  await waitFor(() => writes === 2, 'final queued apply')
  const applies = surface.calls.filter(call => call.method === 'quirky.editor/markdown' && call.params.action === 'apply')
  expect(applies[1]?.params.text).toBe('alpha first final')
  expect(applies[1]?.params.expectedRevision).toBe(2)
})

for (const mode of ['preview', 'rich'] as const) {
  test(`${mode} old export rejection cannot enter replacement scope`, async () => {
    const pending = deferred<unknown>()
    const surface = await renderSurface(mode, { call: async (method, params) => {
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return params.includePreview ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
      if (method === 'quirky.editor/markdown' && params.action === 'exportPdf') return pending.promise
      return {}
    } })
    await waitFor(() => surface.address(mode), 'initial mode registration')
    const oldGeneration = surface.address(mode)!.generation
    const result = surface.control(mode, 'export-pdf').then(value => ({value}), error => ({error}))
    await waitFor(() => surface.calls.some(call => call.params.action === 'exportPdf'), 'pending export')
    await surface.update({ path: '/tmp/markdown-states/new.md', relativePath: 'new.md', content: 'replacement', contentRevision: 2, revision: 2 })
    await waitFor(() => surface.address(mode)?.generation !== oldGeneration, 'replacement mode generation')
    await act(async () => { pending.reject(new Error('obsolete export failure')) })
    const outcome = await result
    expect('error' in outcome).toBe(true)
    expect(errorMessage(surface.element, 'obsolete export failure')).toBeNull()
  })
}


test('an obsolete preview search rejection cannot settle a newer pending search', async () => {
  const older = deferred<unknown>()
  const newer = deferred<unknown>()
  const surface = await renderSurface('preview', { call: async (method, params) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, imageUrls: {} }
    if (method === 'quirky.editor/markdown' && params.action === 'search') return params.query === 'older' ? older.promise : newer.promise
    return {}
  } })
  const first = surface.control('preview', 'find', { query: 'older' }).catch(cause => cause)
  await waitFor(() => surface.calls.some(call => call.params.action === 'search' && call.params.query === 'older'), 'older search request')
  const second = surface.control('preview', 'find', { query: 'newer' })
  await waitFor(() => surface.calls.some(call => call.params.action === 'search' && call.params.query === 'newer'), 'newer search request')
  await act(async () => { older.reject(new Error('obsolete search failure')) })
  await first
  expect(notice(surface.element, 'Searching preview…')).not.toBeNull()
  expect(surface.element.querySelector<HTMLInputElement>('input[aria-label="Find in preview"]')?.value).toBe('newer')
  await act(async () => { newer.resolve({ total: 0, matches: [] }) })
  expect(await second).toEqual({ delivered: true })
  expect(notice(surface.element, 'Searching preview…')).toBeNull()
  expect(emptyState(surface.element, 'No results')).not.toBeNull()
})
