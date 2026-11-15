import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import { createEditorUiControlReportScope, EditorUiControlProvider } from '../src/window/uiControl'

type Call = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
type MountedSurface = {
  element: HTMLElement
  call: Call
  update(buffer: Partial<EditorSurfaceBuffer>): Promise<void>
  unmount(): Promise<void>
}
type Mode = EditorSurfaceBuffer['mode']

const SURFACE = 'view:quirky.editor/document'
let createRoot: (container: HTMLElement) => Root
let MarkdownSurface: ComponentType<SurfaceProps>
let mounted: MountedSurface[]

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
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => { mounted = [] })
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
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
  options: { content?: string; buffer?: Partial<EditorSurfaceBuffer>; call?: Call } = {}
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
  const call = options.call ?? defaults
  const context = { pluginId: 'quirky.editor', call } as unknown as UiPluginContext
  const props: SurfaceProps = {
    context, buffer: makeBuffer(mode, options.content ?? '# Existing heading\n\nDocument body.', options.buffer),
    fontSize: 13, onDraft() {}, onAction: call, onView() {}, registerCommandHandlers() { return () => {} }
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const scope = createEditorUiControlReportScope(undefined, { surface: SURFACE, context })
  let buffer = props.buffer
  const render = () => root.render(<EditorUiControlProvider scope={scope}><MarkdownSurface {...props} buffer={buffer} /></EditorUiControlProvider>)
  await act(async () => { render() })
  let unmounted = false
  const surface: MountedSurface = {
    element, call,
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
const context = { pluginId: 'quirky.editor', async call(method, params) { if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { richEligible: true }; if (method === 'quirky.editor/notes' && params.action === 'list') return { notes: [] }; return {} } }
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
  await act(async () => root.unmount()); scope.dispose(); await GlobalRegistrator.unregister()
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
