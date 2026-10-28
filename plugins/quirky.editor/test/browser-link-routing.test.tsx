import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'

const WORKTREE = 'wt-editor-origin'
const HTTP_LINK = 'https://example.test/docs'
const MAIL_LINK = 'mailto:docs@example.test'

type Call = { method: string; params: Record<string, unknown> }
type DocumentCandidate = { relativePath: string; name: string }
type Options = {
  browser?: 'available' | 'missing' | 'reject'
  linkResult?(target: string): Record<string, unknown>
  documentsResult?(query: string): { documents: DocumentCandidate[]; total: number; truncated: boolean }
  readOnly?: boolean
}
type MountedSurface = { element: HTMLElement; calls: Call[]; unmount(): Promise<void> }

let createRoot: (container: HTMLElement) => Root
let MarkdownSurface: ComponentType<SurfaceProps>
let originalPlatform: PropertyDescriptor | undefined
let surfaces: MountedSurface[]

beforeAll(async () => {
  // React DOM and TipTap inspect window while initializing, so load them only after Happy DOM is registered.
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownSurface } = await import('../src/markdown/MarkdownSurface'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  surfaces = []
  originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
})
afterEach(async () => {
  for (const surface of surfaces) await surface.unmount()
  surfaces = []
  document.body.innerHTML = ''
  if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform)
  else Reflect.deleteProperty(navigator, 'platform')
})

function makeBuffer(mode: 'preview' | 'rich', content: string, readOnly = false): EditorSurfaceBuffer {
  return {
    id: 'buffer-1',
    worktreeId: WORKTREE,
    root: '/tmp/editor-origin',
    path: '/tmp/editor-origin/notes.md',
    relativePath: 'notes.md',
    name: 'notes.md',
    kind: 'markdown',
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly,
    dirty: false,
    external: null,
    mode,
    tabId: 'tab-1',
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    diskContentLength: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function renderSurface(mode: 'preview' | 'rich', content: string, options: Options = {}): Promise<MountedSurface> {
  const calls: Call[] = []
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.editor/markdown' && params.action === 'documents') {
        return options.documentsResult?.(String(params.query ?? '')) ?? { documents: [], total: 0, truncated: false }
      }
      if (method === 'quirky.editor/markdown' && params.action === 'capabilities') {
        return mode === 'preview' ? { previewAvailable: true, imageUrls: {} } : { richEligible: true }
      }
      if (method === 'quirky.editor/markdown' && params.action === 'links') {
        return options.linkResult?.(String(params.target)) ?? { safe: true, kind: 'external' }
      }
      if (method === 'quirky.editor/notes') return { notes: [] }
      if (method === 'quirky.browser/openLink') {
        if (options.browser === 'missing') throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
        if (options.browser === 'reject') throw new RpcError(RpcErrorCode.Conflict, 'in-app route refused')
        return { route: 'app', pane: 'browser-pane-1' }
      }
      if (method === 'quirky.editor/open') return { id: 'buffer-linked', openedTabId: 'tab-linked' }
      return {}
    }
  } as unknown as UiPluginContext
  const props: SurfaceProps = {
    context,
    buffer: makeBuffer(mode, content, options.readOnly),
    fontSize: 13,
    onDraft() {},
    onAction: (method, params) => context.call(method, params),
    onView() {},
    registerCommandHandlers: () => () => {}
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root: Root = createRoot(element)
  await act(async () => root.render(<MarkdownSurface {...props} />))
  const mounted: MountedSurface = {
    element,
    calls,
    async unmount() { await act(async () => root.unmount()) }
  }
  surfaces.push(mounted)
  return mounted
}

async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}

async function link(surface: MountedSurface, href: string): Promise<HTMLAnchorElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = [...surface.element.querySelectorAll<HTMLAnchorElement>('a[href]')].find((candidate) => candidate.getAttribute('href') === href)
    if (found) return found
    await flush()
  }
  throw new Error(`No Markdown link for ${href} appeared.`)
}

function browserCalls(surface: MountedSurface): Record<string, unknown>[] {
  return surface.calls.filter((call) => call.method === 'quirky.browser/openLink').map((call) => call.params)
}

test('Markdown Preview routes HTTP links with their worktree and selected modifiers', async () => {
  const surface = await renderSurface('preview', `[Docs](${HTTP_LINK})`)
  const anchor = await link(surface, HTTP_LINK)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, shiftKey: true })

  await act(async () => void anchor.dispatchEvent(event))
  await flush()
  const controlClick = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
  await act(async () => void anchor.dispatchEvent(controlClick))
  await flush()

  expect(event.defaultPrevented).toBe(true)
  expect(browserCalls(surface)).toEqual([
    { url: HTTP_LINK, worktree: `id:${WORKTREE}`, modifier: true, shift: true },
    { url: HTTP_LINK, worktree: `id:${WORKTREE}` }
  ])

})

test('Rich Markdown keeps ordinary link clicks in the editor and routes modified navigation through Browser', async () => {
  const surface = await renderSurface('rich', `[Docs](${HTTP_LINK})`)
  const anchor = await link(surface, HTTP_LINK)
  await act(async () => void anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await flush()
  expect(browserCalls(surface)).toEqual([])

  const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
  await act(async () => void anchor.dispatchEvent(event))
  await flush()
  expect(event.defaultPrevented).toBe(true)
  expect(browserCalls(surface)).toEqual([{ url: HTTP_LINK, worktree: `id:${WORKTREE}`, modifier: true }])
})

test('mail links retain the external opener and document links retain editor navigation', async () => {
  const surface = await renderSurface('preview', `[Mail](${MAIL_LINK})\n\n[Doc](docs/target.md)`, {
    linkResult: (target) => target === MAIL_LINK
      ? { safe: true, kind: 'external' }
      : { safe: true, kind: 'document', resolved: 'docs/target.md' }
  })
  const mail = await link(surface, MAIL_LINK)
  await act(async () => void mail.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await flush()
  expect(surface.calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: MAIL_LINK }])
  expect(browserCalls(surface)).toEqual([])

  const doc = await link(surface, 'docs/target.md')
  await act(async () => void doc.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await flush()
  expect(surface.calls.filter((call) => call.method === 'quirky.editor/open').map((call) => call.params)).toEqual([{
    worktree: `id:${WORKTREE}`, path: 'docs/target.md', mode: 'preview', focus: true
  }])
  expect(browserCalls(surface)).toEqual([])
})

test('ambiguous document links refuse navigation instead of choosing a basename match', async () => {
  const surface = await renderSurface('preview', '[[Duplicate]]', {
    linkResult: () => ({
      safe: true,
      kind: 'document',
      resolved: null,
      ambiguous: true,
      matches: ['a/Duplicate.md', 'b/Duplicate.md']
    })
  })
  const anchor = await link(surface, 'Duplicate')
  await act(async () => void anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await flush()
  expect(surface.calls.filter((call) => call.method === 'quirky.editor/open')).toEqual([])
  expect(surface.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'links').map((call) => call.params)).toContainEqual({
    bufferId: 'buffer-1',
    action: 'links',
    target: 'Duplicate'
  })
  expect(surface.element.querySelector('[role="alert"]')?.textContent).toContain('ambiguous')
})

test('only a missing Browser method falls back to external open; an in-app failure stays visible', async () => {
  const missing = await renderSurface('preview', `[Docs](${HTTP_LINK})`, { browser: 'missing' })
  const missingLink = await link(missing, HTTP_LINK)
  await act(async () => void missingLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await flush()
  expect(missing.calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: HTTP_LINK }])

  const failed = await renderSurface('preview', `[Docs](${HTTP_LINK})`, { browser: 'reject' })
  const failedLink = await link(failed, HTTP_LINK)
  await act(async () => void failedLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  await flush()
  expect(failed.calls.filter((call) => call.method === 'quirky.terminal/openExternal')).toEqual([])
  expect(failed.element.querySelector('[role="alert"]')?.textContent).toContain('in-app route refused')
})

test('document-link completion shows capped totals, follows keyboard selection, and inserts an extensionless atom', async () => {
  const documents = [
    { relativePath: 'docs/Guide.md', name: 'Guide.md' },
    { relativePath: 'docs/Guides.md', name: 'Guides.md' },
    ...Array.from({ length: 18 }, (_, index) => ({
      relativePath: `docs/Guide-${index}.md`,
      name: `Guide-${index}.md`
    }))
  ]
  const surface = await renderSurface('rich', '[[Gu', {
    documentsResult: () => ({ documents, total: 27, truncated: true })
  })
  await flush()
  expect(surface.calls
    .filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'documents')
    .map((call) => call.params.query)).toContain('Gu')
  const menu = surface.element.querySelector('[aria-label="Markdown document links"]')
  expect(menu?.textContent).toContain('20 of 27')
  expect(menu?.textContent).toContain('truncated')
  const editor = surface.element.querySelector<HTMLElement>('.ProseMirror')
  expect(editor).not.toBeNull()
  await act(async () => {
    editor!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  await flush()
  await act(async () => {
    const accepted = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    editor!.dispatchEvent(accepted)
    expect(accepted.defaultPrevented).toBe(true)
  })
  await flush()
  expect(editor?.querySelector('[data-markdown-document-link]')?.getAttribute('data-target')).toBe('docs/Guides')
  expect(surface.calls.some((call) => call.method === 'quirky.editor/open')).toBe(false)
})

test('document-link completion accepts Tab, dismisses with Escape, and respects boundary, IME and read-only guards', async () => {
  const documentsResult = (query: string) => ({
    documents: [{ relativePath: 'docs/Guide.md', name: 'Guide.md' }],
    total: query === 'Gu' ? 1 : 0,
    truncated: false
  })
  const tabbed = await renderSurface('rich', '[[Gu', { documentsResult })
  await flush()
  const tabEditor = tabbed.element.querySelector<HTMLElement>('.ProseMirror')
  await act(async () => {
    const accepted = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    tabEditor?.dispatchEvent(accepted)
    expect(accepted.defaultPrevented).toBe(true)
  })
  expect(tabEditor?.querySelector('[data-markdown-document-link]')?.getAttribute('data-target')).toBe('docs/Guide')

  const escaped = await renderSurface('rich', '[[Gu', { documentsResult })
  await flush()
  const escapeEditor = escaped.element.querySelector<HTMLElement>('.ProseMirror')
  await act(async () => {
    escapeEditor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(escaped.element.querySelector('[aria-label="Markdown document links"]')).toBeNull()
  expect(escapeEditor?.querySelector('[data-markdown-document-link]')).toBeNull()

  const boundary = await renderSurface('rich', 'word[[Gu', { documentsResult })
  await flush()
  expect(boundary.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'documents')).toEqual([])

  const readOnly = await renderSurface('rich', '[[Gu', { documentsResult, readOnly: true })
  await flush()
  expect(readOnly.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'documents')).toEqual([])

  const composing = await renderSurface('rich', '', { documentsResult })
  await flush()
  const composingEditor = composing.element.querySelector<HTMLElement>('.ProseMirror')
  await act(async () => {
    composingEditor?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    if (composingEditor) composingEditor.innerHTML = '<p>[[Gu</p>'
    composingEditor?.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertCompositionText',
      data: '[[Gu'
    }))
    composingEditor?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  await flush()
  expect(composing.calls.filter((call) => call.method === 'quirky.editor/markdown' && call.params.action === 'documents')).toEqual([])
})
