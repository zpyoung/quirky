import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer } from '../src/types'
import type { ChangesSurfaceProps } from '../src/window/ChangesSurface'

const WORKTREE = 'wt-editor-changes'
type Call = { method: string; params: Record<string, unknown> }
type Mounted = { element: HTMLElement; calls: Call[]; unmount(): Promise<void> }

let createRoot: (container: HTMLElement) => Root
let ChangesSurface: ComponentType<ChangesSurfaceProps>
let mounted: Mounted[]

beforeAll(async () => {
  // SourceEditor and CodeMirror inspect window at module initialization; load them after Happy DOM.
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChangesSurface } = await import('../src/window/ChangesSurface'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => { mounted = [] })
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  document.body.innerHTML = ''
})

function makeBuffer(kind: 'text' | 'markdown', content: string, draft: string | null): EditorSurfaceBuffer {
  return {
    id: 'buffer-changes',
    worktreeId: WORKTREE,
    root: '/tmp/changes-worktree',
    path: `/tmp/changes-worktree/${kind === 'markdown' ? 'README.md' : 'src/app.ts'}`,
    relativePath: kind === 'markdown' ? 'README.md' : 'src/app.ts',
    name: kind === 'markdown' ? 'README.md' : 'app.ts',
    kind,
    content,
    draft,
    baseline: 'content-baseline',
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: draft !== null,
    external: null,
    mode: 'source',
    tabId: 'tab-changes',
    preview: false,
    pinned: false,
    untitled: false,
    revision: 2,
    contentRevision: draft === null ? 1 : 2,
    view: {},
    error: null,
    diskContentLength: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function renderChanges(buffer: EditorSurfaceBuffer, diff?: { original: string; modified: string }): Promise<Mounted> {
  const calls: Call[] = []
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.git/diff') {
        return {
          path: buffer.relativePath,
          source: 'unstaged',
          staged: false,
          original: diff?.original ?? 'HEAD version\n',
          modified: diff?.modified ?? 'Index version\n',
          binary: false,
          kind: 'text',
          modifiedHash: 'working-hash',
          modifiedDeleted: false
        }
      }
      if (method === 'quirky.editor/markdown' && params.action === 'renderPreview') {
        return { html: '<article><h1>Shared draft</h1></article>' }
      }
      return {}
    },
    subscribe() { return () => {} },
    setContext() {},
    toast() {}
  } as unknown as UiPluginContext
  const props: ChangesSurfaceProps = {
    context,
    buffer,
    tabId: buffer.tabId,
    fontSize: 13,
    fontFamily: 'monospace',
    wrap: true,
    minimap: false,
    onDraft() {},
    flushDraft: async () => {},
    onView() {},
    onEditorFocus() {},
    onSearchInFiles() {},
    error: null,
    onError() {},
    registerCommandHandlers: () => () => {}
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(<ChangesSurface {...props} />))
  const surface = {
    element,
    calls,
    async unmount() { await act(async () => root.unmount()) }
  }
  mounted.push(surface)
  return surface
}

async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}

test('Changes compares HEAD to the shared draft, not staged content, in the same editable tab', async () => {
  const surface = await renderChanges(makeBuffer('text', 'Working file\n', 'Shared draft\n'), {
    original: 'Committed HEAD\n',
    modified: 'Staged index\n'
  })
  await flush()
  expect(surface.calls).toContainEqual({
    method: 'quirky.git/diff',
    params: {
      worktree: `id:${WORKTREE}`,
      path: 'src/app.ts',
      source: 'unstaged',
      compareAgainstHead: true
    }
  })
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).toContain('Committed HEAD')
  expect(surface.element.querySelector('[aria-label="HEAD version"]')?.textContent).not.toContain('Staged index')
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain('Shared draft')
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).not.toContain('Staged index')
  expect(surface.calls.some((call) => call.method === 'quirky.editor/open')).toBe(false)
  expect(surface.element.querySelector('[aria-pressed="true"][aria-label="Side by side"]')).not.toBeNull()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Inline"]')?.click())
  expect(surface.element.querySelector('.qe-changes-inline')).not.toBeNull()
  expect(surface.element.querySelector('[aria-label="Inline diff"]')?.textContent).toContain('Committed HEAD')
  expect(surface.element.querySelector('[aria-label="Inline diff"]')?.textContent).toContain('Shared draft')
  expect(surface.element.querySelector('[aria-label="Inline diff"]')?.textContent).not.toContain('Staged index')
  expect(surface.element.querySelector('[aria-label="Next change"]')).not.toBeNull()
})

test('Changes Markdown preview renders only the modified draft and switching back preserves it', async () => {
  const draft = '# Shared draft\n\nDraft-only body.\n'
  const surface = await renderChanges(makeBuffer('markdown', '# Working file\n', draft), {
    original: '# Committed HEAD\n',
    modified: '# Staged index\n'
  })
  await flush()
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Markdown preview"]')?.click())
  await flush()
  expect(surface.element.querySelector('.qe-changes-preview-notice')?.textContent).toContain('modified content only')
  expect(surface.element.querySelector('.qe-changes-preview-notice')?.textContent).toContain('Local images are omitted')
  expect(surface.element.querySelector('[aria-label="HEAD version"]')).toBeNull()
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).toContain('Shared draft')
  expect(surface.element.querySelector('.qe-changes-markdown-preview')?.textContent).not.toContain('Committed HEAD')
  expect(surface.calls).toContainEqual({
    method: 'quirky.editor/markdown',
    params: { action: 'renderPreview', text: draft }
  })
  await act(async () => surface.element.querySelector<HTMLButtonElement>('[aria-label="Source editor"]')?.click())
  await flush()
  expect(surface.element.querySelector('[aria-label="Modified editor"] .cm-content')?.textContent).toContain('Shared draft')
  expect(surface.calls.some((call) => call.method === 'quirky.editor/open')).toBe(false)
})

test('Changes makes a clean HEAD comparison explicit', async () => {
  const source = 'No changes\n'
  const surface = await renderChanges(makeBuffer('text', source, null), { original: source, modified: source })
  await flush()
  expect(surface.element.textContent).toContain('No uncommitted changes')
})
