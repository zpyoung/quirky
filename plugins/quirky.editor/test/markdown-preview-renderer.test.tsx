import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import { createEditorUiControlReportScope, EditorUiControlProvider } from '../src/window/uiControl'

let createRoot: (container: HTMLElement) => Root
let MarkdownSurface: ComponentType<SurfaceProps>
let roots: { root: Root; element: HTMLElement }[] = []
let renders: string[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mock.module('mermaid', () => ({ default: {
    initialize() {},
    render: async (_id: string, source: string) => { renders.push(source); return { svg: '<svg><text>fixture diagram</text></svg>' } }
  } }))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownSurface } = await import('../src/markdown/MarkdownSurface'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })
afterEach(async () => {
  for (const { root, element } of roots) { await act(async () => root.unmount()); element.remove() }
  roots = []
  renders = []
})

async function mountPreview(content: string, imageUrls: Record<string, string> = {}): Promise<HTMLElement> {
  const call = async (method: string, params: Record<string, unknown>) => {
    if (method === 'quirky.editor/markdown' && params.action === 'capabilities') return { previewAvailable: true, imageUrls }
    if (method === 'quirky.editor/markdown' && params.action === 'toc') return { headings: [] }
    return {}
  }
  const context = { pluginId: 'quirky.editor', call } as unknown as UiPluginContext
  const buffer: EditorSurfaceBuffer = {
    id: 'buffer-preview-renderer', worktreeId: 'wt', root: '/tmp/preview', path: '/tmp/preview/readme.md',
    relativePath: 'readme.md', name: 'readme.md', kind: 'markdown', content, draft: null, baseline: null,
    size: content.length, readOnly: false, dirty: false, external: null, mode: 'preview', tabId: 'tab-preview',
    preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null,
    diskContentLength: null, diskContentBytes: null, diskSignature: null
  }
  const props: SurfaceProps = {
    context, buffer, fontSize: 13, onDraft() {}, onAction: async (method, params) => call(method, params), onView() {},
    registerCommandHandlers: () => () => {}
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push({ root, element })
  const scope = createEditorUiControlReportScope(() => {}, { surface: 'view:quirky.editor/document', context })
  await act(async () => root.render(<EditorUiControlProvider scope={scope}><MarkdownSurface {...props} /></EditorUiControlProvider>))
  const deadline = Date.now() + 3_000
  while (!element.querySelector('article.markdown-preview-body') && Date.now() < deadline) await act(async () => { await Bun.sleep(10) })
  await act(async () => { await Bun.sleep(20) })
  return element.querySelector('article.markdown-preview-body') as HTMLElement
}

test('the preview renders through the shared file-profile renderer inside the editor article', async () => {
  const article = await mountPreview('# Title\n\nbody')
  expect(article.className).toBe('markdown-body markdown-body--editor markdown-preview-body')
  const shared = article.querySelector('.qmd')
  expect(shared?.getAttribute('data-profile')).toBe('file')
})

test('raw HTML survives cleaning while scripts, handlers and javascript links do not', async () => {
  const article = await mountPreview([
    '<p align="center"><img src="docs/logo.svg" width="80"></p>',
    '',
    '<script>window.pwned = 1</script>',
    '',
    '<div onclick="window.pwned = 2">clickable</div>',
    '',
    '<a href="javascript:alert(1)">bad link</a>',
    '',
    '[md bad](javascript:alert(2))'
  ].join('\n'), { 'docs/logo.svg': 'quirky-resource://logo.svg' })
  const logo = article.querySelector('img')
  expect(logo?.getAttribute('src')).toBe('quirky-resource://logo.svg')
  expect(article.querySelector('script')).toBeNull()
  expect(article.innerHTML).not.toContain('onclick')
  expect(article.innerHTML).not.toContain('javascript:')
  expect(article.textContent).toContain('clickable')
  expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined()
})

test('images resolve through imageUrls and fall back to alt text', async () => {
  const article = await mountPreview('![known](a.png)\n\n![missing alt](b.png)\n\n![](c.png)', { 'a.png': 'quirky-resource://a.png' })
  const images = article.querySelectorAll('img')
  expect(images.length).toBe(1)
  expect(images[0]!.getAttribute('src')).toBe('quirky-resource://a.png')
  expect(images[0]!.getAttribute('alt')).toBe('known')
  expect(article.textContent).toContain('missing alt')
})

test('a GitHub alert renders the shared alert block', async () => {
  const article = await mountPreview('> [!NOTE]\n> Remember this.')
  const alert = article.querySelector('[data-alert]')
  expect(alert).not.toBeNull()
  expect(alert!.textContent).toContain('Remember this.')
})

test('a mermaid fence renders through MermaidDiagram', async () => {
  const article = await mountPreview('```mermaid\ngraph TD; A-->B\n```')
  await act(async () => { await Bun.sleep(50) })
  expect(article.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Mermaid diagram')
  expect(renders).toEqual(['graph TD; A-->B'])
})

test('headings render and in-document links point at the preview heading ids', async () => {
  const article = await mountPreview('# First Heading\n\n## Second Heading\n\n[jump](#second-heading)')
  expect(article.querySelector('h1')?.textContent).toBe('First Heading')
  expect(article.querySelector('h2')?.textContent).toBe('Second Heading')
  expect(article.querySelector('a')?.getAttribute('href')).toBe('#markdown-second-heading')
})
