import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, useEffect, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorBufferInfo, EditorKind, EditorMode } from '../src/types'
import type { DocumentSurface as DocumentSurfaceComponent } from '../src/window/DocumentSurface'
import type { ExplorerPanel as ExplorerPanelComponent } from '../src/window/ExplorerPanel'

type OpenedDocument = { bufferId: string; tabId: string }
type EditorEvent = { type: string; id?: string }
type Runtime = {
  buffers: EditorBufferInfo[]
  tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview' }[]
  entries: { path: string; name: string; isDirectory: boolean; isSymlink: boolean }[]
  createdPath: string | null
  opened: OpenedDocument | null
  openCompleted: boolean
  mountDuringOpen: boolean
  deferPostOpen: boolean
  publishOpened?: () => void
  resolveEditorReady(): void
  editorReady: Promise<void>
  stateReads: number
  postOpenStarted: Promise<void>
  signalPostOpen(): void
  postOpenGate: Promise<void>
  releasePostOpen(): void
  listeners: Set<(event: EditorEvent) => void>
}
type Mounted = { element: HTMLElement; unmount(): Promise<void> }

const ROOT = '/worktree/new-file-focus'
const WORKTREE_ID = 'wt-new-file-focus'
const BACKGROUND_BUFFER_ID = 'buffer-background'
const BACKGROUND_TAB_ID = 'tab-background'
const SETTINGS = new Map<string, unknown>([
  ['editorAutoSave', false],
  ['editorAutoSaveDelayMs', 1000],
  ['editorWordWrap', false],
  ['editorFontFamily', 'monospace'],
  ['editorPreviewTabsEnabled', true],
  ['richMarkdownSpellcheckEnabled', false],
  ['markdownReviewToolsEnabled', false],
  ['showGitIgnoredFiles', false],
  ['followSymlinkedDirectories', false],
  ['editorFontZoomLevel', 0],
  ['editorMinimapEnabled', false],
  ['editorSidebarWidth', 300]
])

let createRoot: (container: HTMLElement) => Root
let DocumentSurface: typeof DocumentSurfaceComponent
let ExplorerPanel: typeof ExplorerPanelComponent
let mounted: Mounted[] = []

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ DocumentSurface } = await import('../src/window/DocumentSurface'))
  ;({ ExplorerPanel } = await import('../src/window/ExplorerPanel'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  document.body.replaceChildren()
})

function bufferInfo(
  id: string,
  tabId: string,
  relativePath: string,
  kind: EditorKind,
  mode: EditorMode,
  content = ''
): EditorBufferInfo {
  return {
    id,
    worktreeId: WORKTREE_ID,
    root: ROOT,
    path: `${ROOT}/${relativePath}`,
    relativePath,
    name: relativePath.split('/').at(-1)!,
    kind,
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: false,
    external: null,
    mode,
    tabId,
    preview: false,
    pinned: true,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    contentLength: content.length,
    draftLength: null,
    diskContentLength: null,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftBytes: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

function makeRuntime(mountDuringOpen: boolean, deferPostOpen = false): Runtime {
  const ready = Promise.withResolvers<void>()
  const postOpenStarted = Promise.withResolvers<void>()
  const postOpenGate = Promise.withResolvers<void>()
  return {
    buffers: [bufferInfo(BACKGROUND_BUFFER_ID, BACKGROUND_TAB_ID, 'background.txt', 'text', 'source', 'background\n')],
    tabs: [{ tabId: BACKGROUND_TAB_ID, bufferId: BACKGROUND_BUFFER_ID, mode: 'edit' }],
    entries: [],
    createdPath: null,
    opened: null,
    openCompleted: false,
    mountDuringOpen,
    deferPostOpen,
    resolveEditorReady: ready.resolve,
    editorReady: ready.promise,
    postOpenStarted: postOpenStarted.promise,
    signalPostOpen: postOpenStarted.resolve,
    postOpenGate: postOpenGate.promise,
    releasePostOpen: postOpenGate.resolve,
    stateReads: 0,
    listeners: new Set()
  }
}

function stateSnapshot(runtime: Runtime) {
  runtime.stateReads++
  return {
    buffers: runtime.buffers.map((buffer) => ({ ...buffer })),
    tabs: [...runtime.tabs],
    explorer: {
      worktreeId: WORKTREE_ID,
      showDotfiles: true,
      expanded: [],
      selectedPaths: [],
      focusedPath: null
    },
    search: null,
    quickOpenHistory: [],
    closeRequests: []
  }
}

function makeContext(runtime: Runtime): UiPluginContext {
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.editor/state') return stateSnapshot(runtime)
      if (method === 'quirky.git/status') return { files: [] }
      if (method === 'quirky.editor/documentRoot') return { id: WORKTREE_ID, path: ROOT }
      if (method === 'quirky.worktree/list') return [{ id: WORKTREE_ID, path: ROOT, name: 'Focus test' }]
      if (method === 'quirky.editor/explorer') {
        const entries = [...runtime.entries]
        const listing = {
          root: ROOT,
          entries,
          showDotfiles: true,
          showIgnored: false,
          followSymlinkedDirectories: false
        }
        if (params.action === 'list') return listing
        if (params.action === 'reveal' && runtime.deferPostOpen) {
          runtime.signalPostOpen()
          await runtime.postOpenGate
        }
        const path = typeof params.path === 'string' ? params.path : ''
        const absolutePath = `${ROOT}/${path}`
        return {
          ...listing,
          interaction: { selectedPaths: [absolutePath], focusedPath: absolutePath }
        }
      }
      if (method === 'quirky.editor/mutate') {
        if (params.action === 'createFile' && typeof params.path === 'string') {
          runtime.createdPath = params.path
          runtime.entries = [{
            path: `${ROOT}/${params.path}`,
            name: params.path.split('/').at(-1)!,
            isDirectory: false,
            isSymlink: false
          }]
        }
        return {}
      }
      if (method === 'quirky.editor/open') {
        const relativePath = String(params.path)
        const kind: EditorKind = relativePath.endsWith('.md') ? 'markdown' : 'text'
        const mode: EditorMode = kind === 'markdown' ? 'rich' : 'source'
        const bufferId = `buffer-${relativePath}`
        const tabId = `tab-${relativePath}`
        const info = bufferInfo(bufferId, tabId, relativePath, kind, mode)
        runtime.buffers = [...runtime.buffers.filter((buffer) => buffer.id !== bufferId), info]
        runtime.tabs = [
          ...runtime.tabs.filter((tab) => tab.tabId !== tabId),
          { tabId, bufferId, mode: 'edit' }
        ]
        runtime.opened = { bufferId, tabId }
        if (runtime.mountDuringOpen) {
          runtime.publishOpened?.()
          await runtime.editorReady
        }
        runtime.openCompleted = true
        return { ...info, openedTabId: tabId }
      }
      if (method === 'quirky.editor/markdown') {
        if (params.action === 'capabilities') return { richEligible: true, openAnywayAvailable: false }
        if (params.action === 'toc') return { headings: [] }
        return {}
      }
      if (method === 'quirky.editor/notes') return { notes: [] }
      return {}
    },
    subscribe(listener: (event: EditorEvent) => void) {
      runtime.listeners.add(listener)
      return () => runtime.listeners.delete(listener)
    },
    getSetting: (name: string) => SETTINGS.get(name),
    getLayout: () => ({ worktree: WORKTREE_ID, view: null, panel: null, sidebar: true, focus: 'view' }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    nativeBrowser: {},
    nativeDropPaths: async () => null,
    readClipboardText: async () => '',
    provide() {},
    log() {},
    async executeCommand() {},
    createCommandDrag: () => 'unused-command-drag',
    consumeCommandDrag: () => null,
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    async confirm() { return false },
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  }
  return context as unknown as UiPluginContext
}

function OpenedDocumentHost({ runtime, context, opened }: {
  runtime: Runtime
  context: UiPluginContext
  opened: OpenedDocument
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const signalReady = () => {
      if (element.querySelector('[contenteditable="true"]')) runtime.resolveEditorReady()
    }
    const observer = new MutationObserver(signalReady)
    observer.observe(element, { childList: true, subtree: true, attributes: true })
    signalReady()
    return () => observer.disconnect()
  }, [opened.bufferId, opened.tabId, runtime])
  return (
    <div className="qt-group qt-active" data-testid="opened-group">
      <div ref={host} className="qt-hosted-view" data-hosted-view={opened.tabId} data-testid="opened-document">
        <DocumentSurface context={context} input={{ bufferId: opened.bufferId, tabId: opened.tabId }} />
      </div>
    </div>
  )
}

function FocusTestApp({ runtime, context }: { runtime: Runtime; context: UiPluginContext }) {
  const [opened, setOpened] = useState<OpenedDocument | null>(null)
  useEffect(() => {
    runtime.publishOpened = () => {
      if (runtime.opened) setOpened(runtime.opened)
    }
    return () => { runtime.publishOpened = undefined }
  }, [runtime])
  return (
    <>
      <ExplorerPanel context={context} />
      <div className="qt-group" data-testid="background-group">
        <div className="qt-hosted-view" data-hosted-view={BACKGROUND_TAB_ID} data-testid="background-document">
          <DocumentSurface context={context} input={{ bufferId: BACKGROUND_BUFFER_ID, tabId: BACKGROUND_TAB_ID }} />
        </div>
      </div>
      {opened && <OpenedDocumentHost runtime={runtime} context={context} opened={opened} />}
    </>
  )
}

async function flushReact(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
}

async function waitForUi<T>(check: () => T | false | null | undefined): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await flushReact()
  }
  throw new Error('Timed out waiting for the editor UI.')
}
async function focusWithPointer(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    target.focus()
  })
}

async function renderApp(runtime: Runtime, context: UiPluginContext): Promise<Mounted> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let unmounted = false
  const surface: Mounted = {
    element,
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => root.unmount())
    }
  }
  mounted.push(surface)
  await act(async () => root.render(<FocusTestApp runtime={runtime} context={context} />))
  await waitForUi(() => element.querySelector('button[title="New File"]'))
  await waitForUi(() => element.querySelector('[data-testid="background-document"] .cm-content[contenteditable="true"]'))
  return surface
}

function editableSelector(kind: EditorKind): string {
  return kind === 'markdown'
    ? '[contenteditable="true"][aria-label="Rich Markdown editor"]'
    : '.cm-content[contenteditable="true"]'
}

async function createFileThroughExplorer(panel: Mounted, path: string): Promise<void> {
  const newFile = panel.element.querySelector<HTMLButtonElement>('button[title="New File"]')
  if (!newFile) throw new Error('Missing New File action')
  await act(async () => newFile.click())
  const input = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('.qe-explorer-inline-row input'))
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, path)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const create = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('.qe-explorer-inline-row button'))
    .find((button) => button.textContent?.trim() === 'Create')
  if (!create) throw new Error('Missing Create action for New File')
  await act(async () => create.click())
}

const cases = [
  { path: 'created.txt', kind: 'text' as const, mountDuringOpen: false },
  { path: 'created.md', kind: 'markdown' as const, mountDuringOpen: false },
  { path: 'created-mounted.txt', kind: 'text' as const, mountDuringOpen: true },
  { path: 'created-mounted.md', kind: 'markdown' as const, mountDuringOpen: true }
]

test.each(cases)('New File focuses the $kind editor when mountDuringOpen=$mountDuringOpen', async ({ path, kind, mountDuringOpen }) => {
  const runtime = makeRuntime(mountDuringOpen)
  const context = makeContext(runtime)
  const panel = await renderApp(runtime, context)

  await createFileThroughExplorer(panel, path)
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)
  expect(runtime.createdPath).toBe(path)
  expect(runtime.opened).not.toBeNull()

  let targetDocument = panel.element.querySelector<HTMLElement>('[data-testid="opened-document"]')
  if (mountDuringOpen) {
    targetDocument = await waitForUi(() => panel.element.querySelector<HTMLElement>('[data-testid="opened-document"]'))
    expect(runtime.openCompleted).toBe(true)
  } else {
    expect(runtime.openCompleted).toBe(true)
    expect(targetDocument === null).toBe(true)
    await act(async () => runtime.publishOpened?.())
    targetDocument = await waitForUi(() => panel.element.querySelector<HTMLElement>('[data-testid="opened-document"]'))
  }

  const editable = await waitForUi(() => targetDocument!.querySelector<HTMLElement>(editableSelector(kind)))
  expect(panel.element.querySelector('.qe-explorer-inline-row')).toBeNull()
  expect(document.activeElement === editable).toBe(true)

  const backgroundEditable = panel.element.querySelector<HTMLElement>(
    '[data-testid="background-document"] .cm-content[contenteditable="true"]'
  )
  expect(backgroundEditable !== null).toBe(true)
  const previousReads = runtime.stateReads
  await act(async () => {
    runtime.buffers = runtime.buffers.map((buffer) => ({ ...buffer, revision: buffer.revision + 1 }))
    for (const listener of runtime.listeners) listener({ type: 'quirky.editor/changed' })
  })
  await waitForUi(() => runtime.stateReads > previousReads || false)
  expect(document.activeElement === editable).toBe(true)
  expect(document.activeElement !== backgroundEditable).toBe(true)
})
test('focusing Explorer Find files cancels a pending new-file editor focus', async () => {
  const runtime = makeRuntime(false)
  const context = makeContext(runtime)
  const panel = await renderApp(runtime, context)

  await createFileThroughExplorer(panel, 'created-later.txt')
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)
  expect(runtime.openCompleted).toBe(true)
  expect(panel.element.querySelector('[data-testid="opened-document"]') === null).toBe(true)

  const findFiles = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]'))
  await focusWithPointer(findFiles)
  expect(document.activeElement === findFiles).toBe(true)

  await act(async () => runtime.publishOpened?.())
  const targetDocument = await waitForUi(() => panel.element.querySelector<HTMLElement>('[data-testid="opened-document"]'))
  await waitForUi(() => targetDocument.querySelector<HTMLElement>(editableSelector('text')))
  expect(document.activeElement === findFiles).toBe(true)
})
test('later Find files focus wins when the editor is ready before New File finishes', async () => {
  const runtime = makeRuntime(true, true)
  const context = makeContext(runtime)
  const panel = await renderApp(runtime, context)

  await createFileThroughExplorer(panel, 'created-before-request.txt')
  await runtime.postOpenStarted
  expect(runtime.openCompleted).toBe(true)

  const findFiles = await waitForUi(() => panel.element.querySelector<HTMLInputElement>('input[placeholder="Find files"]'))
  const targetDocument = await waitForUi(() => panel.element.querySelector<HTMLElement>('[data-testid="opened-document"]'))
  await waitForUi(() => targetDocument.querySelector<HTMLElement>(editableSelector('text')))
  expect(panel.element.querySelector('.qe-explorer-inline-row') !== null).toBe(true)
  await focusWithPointer(findFiles)
  expect(document.activeElement === findFiles).toBe(true)

  runtime.releasePostOpen()
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)
  expect(document.activeElement === findFiles).toBe(true)
})
test('programmatic background textarea focus does not cancel the new-file handoff', async () => {
  const runtime = makeRuntime(true, true)
  const context = makeContext(runtime)
  const panel = await renderApp(runtime, context)
  const backgroundInput = document.createElement('textarea')
  panel.element.querySelector('[data-testid="background-group"]')!.append(backgroundInput)

  await createFileThroughExplorer(panel, 'created-with-startup-terminal.txt')
  await runtime.postOpenStarted
  const targetDocument = await waitForUi(() => panel.element.querySelector<HTMLElement>('[data-testid="opened-document"]'))
  const targetEditable = await waitForUi(() => targetDocument.querySelector<HTMLElement>(editableSelector('text')))
  await act(async () => backgroundInput.focus())
  expect(document.activeElement === backgroundInput).toBe(true)

  runtime.releasePostOpen()
  await waitForUi(() => panel.element.querySelector('.qe-explorer-inline-row') === null || false)
  expect(document.activeElement === targetEditable).toBe(true)
})
