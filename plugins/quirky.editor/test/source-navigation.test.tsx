import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { EditorView as EditorViewType } from '@codemirror/view'
import type { SourceEditor as SourceEditorComponent } from '../src/window/SourceEditor'
import type { EditorSurfaceBuffer } from '../src/types'

type SourceEditorProps = ComponentProps<typeof SourceEditorComponent>
type Mounted = {
  container: HTMLDivElement
  root: Root
  render(props: SourceEditorProps): Promise<void>
  unmount(): Promise<void>
}

let createRoot: (container: HTMLElement) => Root
let SourceEditor: typeof SourceEditorComponent
let findEditorView: (node: HTMLElement) => EditorViewType | null
let container: HTMLDivElement
let mounted: Mounted[]
let restoreSelectionChangeDispatch: (() => void) | undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // the editor modules capture browser APIs at initialization, so register Happy DOM before importing them.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SourceEditor } = await import('../src/window/SourceEditor'))
  const { EditorView } = await import('@codemirror/view')
  findEditorView = (node) => EditorView.findFromDOM(node)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  mounted = []
  // browsers queue selectionchange; Happy DOM dispatches it inside CodeMirror's update.
  const dispatchEvent = document.dispatchEvent.bind(document)
  let selectionChangeTimer: number | undefined
  document.dispatchEvent = ((event: Event) => {
    if (event.type === 'selectionchange') {
      if (selectionChangeTimer === undefined) {
        selectionChangeTimer = window.setTimeout(() => {
          selectionChangeTimer = undefined
          dispatchEvent(event)
        }, 0)
      }
      return true
    }
    return dispatchEvent(event)
  }) as typeof document.dispatchEvent
  restoreSelectionChangeDispatch = () => {
    if (selectionChangeTimer !== undefined) window.clearTimeout(selectionChangeTimer)
    document.dispatchEvent = dispatchEvent
  }
})

afterEach(async () => {
  for (const editor of mounted) await editor.unmount()
  mounted = []
  restoreSelectionChangeDispatch?.()
  restoreSelectionChangeDispatch = undefined
  document.body.replaceChildren()
})

const TEXT = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta'

function makeBuffer(view: Record<string, unknown>, tabId = 'tab-1', content = TEXT): EditorSurfaceBuffer {
  return {
    id: 'buffer-source-navigation',
    worktreeId: 'wt-source-navigation',
    root: '/tmp/source-navigation',
    path: '/tmp/source-navigation/sample.ts',
    relativePath: 'sample.ts',
    name: 'sample.ts',
    kind: 'text',
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: false,
    external: null,
    mode: 'source',
    tabId,
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view,
    error: null,
    diskContentLength: null,
    diskContentBytes: null,
    diskSignature: null
  }
}

function editorProps(
  buffer: EditorSurfaceBuffer,
  onView: SourceEditorProps['onView'] = () => {},
  onEditorFocus: SourceEditorProps['onEditorFocus'] = () => {}
): SourceEditorProps {
  return {
    buffer,
    tabId: buffer.tabId,
    wrap: false,
    minimap: false,
    fontSize: 13,
    fontFamily: 'monospace',
    onDraft() {},
    async flushDraft() {},
    onView,
    onEditorFocus,
    onSearchInFiles() {},
    onError() {}
  }
}

async function mountEditor(props: SourceEditorProps): Promise<Mounted> {
  const group = document.createElement('div')
  group.className = 'qt-group qt-active'
  const hostedView = document.createElement('div')
  hostedView.className = 'qt-hosted-view'
  hostedView.dataset.hostedView = props.tabId ?? ''
  container = document.createElement('div')
  hostedView.append(container)
  group.append(hostedView)
  document.body.append(group)
  const root = createRoot(container)
  await act(async () => root.render(<SourceEditor {...props} />))
  let unmountedEditor = false
  const result: Mounted = {
    container,
    root,
    async render(nextProps) {
      await act(async () => root.render(<SourceEditor {...nextProps} />))
    },
    async unmount() {
      if (unmountedEditor) return
      unmountedEditor = true
      await act(async () => root.unmount())
    }
  }
  mounted.push(result)
  return result
}

function positionIn(text: string, line: number, column: number): number {
  const lines = text.split('\n')
  let offset = 0
  for (let index = 0; index < line - 1; index++) offset += lines[index]!.length + 1
  return offset + Math.min(lines[line - 1]!.length, column - 1)
}

function position(line: number, column: number): number {
  return positionIn(TEXT, line, column)
}

function viewFor(container: HTMLElement): EditorViewType {
  const editor = container.querySelector<HTMLElement>('.cm-editor')
  expect(editor).not.toBeNull()
  const view = findEditorView(editor!)
  expect(view).not.toBeNull()
  return view!
}

function applyTabViewPatch(buffer: EditorSurfaceBuffer, tabId: string, patch: Record<string, unknown>): EditorSurfaceBuffer {
  const byTabId = buffer.view.byTabId as Record<string, Record<string, unknown>>
  return {
    ...buffer,
    view: {
      ...buffer.view,
      byTabId: {
        ...byTabId,
        [tabId]: { ...byTabId[tabId], ...patch }
      }
    }
  }
}

async function flushViewTimer(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 190)
  await act(async () => { await promise })
}

test.each(['source', 'changes'] as const)('initial pending tab navigation overrides saved selection and focuses the active %s editor', async (mode) => {
  const tabId = 'tab-1'
  const saved = { selection: { anchor: 0, head: 0 }, cursor: { line: 1, column: 1 }, scrollTop: 0 }
  const navigationId = 'nav-initial'
  const buffer = makeBuffer({ byTabId: { [tabId]: { ...saved, line: 3, column: 2, matchLength: 3, focused: true, navigationId } } }, tabId)
  const patches: Record<string, unknown>[] = []
  const focusEvents: number[] = []
  const props = editorProps(buffer, (patch) => patches.push(patch), () => focusEvents.push(1))
  if (mode === 'changes') props.comparisonOriginal = 'original\nfile\ncontents'
  const surface = await mountEditor(props)
  const modified = surface.container.querySelector<HTMLElement>('[role="group"][aria-label="Modified editor"]')
  const view = viewFor(modified ?? surface.container)

  const matchStart = position(3, 2)
  expect(view.state.selection.main.from).toBe(matchStart)
  expect(view.state.selection.main.to).toBe(matchStart + 3)
  expect(view.state.selection.main.head).toBe(matchStart + 3)
  expect(document.activeElement).toBe(view.contentDOM)
  expect(focusEvents.length).toBeGreaterThan(0)
  expect(patches).toContainEqual(expect.objectContaining({
    line: null,
    column: null,
    matchLength: null,
    focused: false,
    navigationId,
    selection: { anchor: matchStart, head: matchStart + 3 },
    cursor: { line: 3, column: 5 }
  }))
  if (mode === 'changes') {
    const head = surface.container.querySelector<HTMLElement>('[role="group"][aria-label="HEAD version"]')
    expect(head).not.toBeNull()
    expect(viewFor(head!).state.selection.main.empty).toBe(true)
    expect(viewFor(head!).state.selection.main.head).toBe(0)
  }
})

test('mounted navigation updates repeat after cursor movement and remount restores the newer cursor', async () => {
  const tabId = 'tab-1'
  let buffer = makeBuffer({ byTabId: { [tabId]: { cursor: { line: 1, column: 1 } } } }, tabId)
  const patches: Record<string, unknown>[] = []
  const applyView = (patch: Record<string, unknown>) => {
    patches.push(patch)
    buffer = applyTabViewPatch(buffer, tabId, patch)
  }
  const surface = await mountEditor(editorProps(buffer, applyView))
  let view = viewFor(surface.container)

  buffer = applyTabViewPatch(buffer, tabId, { line: 4, column: 3, matchLength: 2, focused: true, navigationId: 'nav-first' })
  await surface.render(editorProps(buffer, applyView))
  expect(view.state.selection.main.from).toBe(position(4, 3))
  expect(view.state.selection.main.to).toBe(position(4, 3) + 2)
  expect(document.activeElement).toBe(view.contentDOM)

  await act(async () => { view.dispatch({ selection: { anchor: position(5, 2) } }) })
  await flushViewTimer()
  expect(view.state.selection.main.head).toBe(position(5, 2))
  expect(buffer.view.byTabId).toMatchObject({
    [tabId]: {
      selection: { anchor: position(5, 2), head: position(5, 2) },
      cursor: { line: 5, column: 2 }
    }
  })

  await surface.render(editorProps(buffer, applyView))
  buffer = applyTabViewPatch(buffer, tabId, { line: 4, column: 3, matchLength: 2, focused: true, navigationId: 'nav-second' })
  await surface.render(editorProps(buffer, applyView))
  expect(view.state.selection.main.from).toBe(position(4, 3))
  expect(view.state.selection.main.to).toBe(position(4, 3) + 2)

  await act(async () => { view.dispatch({ selection: { anchor: position(6, 3) } }) })
  await flushViewTimer()
  await surface.unmount()

  const remounted = await mountEditor(editorProps(buffer, applyView))
  view = viewFor(remounted.container)
  expect(view.state.selection.main.head).toBe(position(6, 3))
})
test('pending CRLF navigation uses CodeMirror-normalized document positions', async () => {
  const tabId = 'tab-1'
  const content = 'alpha\r\nbeta\r\ngamma'
  const normalized = content.replace(/\r\n/g, '\n')
  const buffer = makeBuffer({
    byTabId: {
      [tabId]: { line: 3, column: 2, matchLength: 4, focused: true, navigationId: 'nav-crlf' }
    }
  }, tabId, content)
  const surface = await mountEditor(editorProps(buffer))
  const view = viewFor(surface.container)
  const matchStart = positionIn(normalized, 3, 2)

  expect(view.state.doc.toString()).toBe(normalized)
  expect(view.state.selection.main.from).toBe(matchStart)
  expect(view.state.selection.main.to).toBe(matchStart + 4)
})

test('a new request for the same location applies without an acknowledgement rerender', async () => {
  const tabId = 'tab-1'
  let buffer = makeBuffer({
    byTabId: {
      [tabId]: { line: 4, column: 3, matchLength: 2, focused: true, navigationId: 'nav-first' }
    }
  }, tabId)
  const patches: Record<string, unknown>[] = []
  const captureView = (patch: Record<string, unknown>) => { patches.push(patch) }
  const surface = await mountEditor(editorProps(buffer, captureView))
  const view = viewFor(surface.container)

  expect(view.state.selection.main.from).toBe(position(4, 3))
  await act(async () => { view.dispatch({ selection: { anchor: position(5, 2) } }) })
  await flushViewTimer()
  expect(view.state.selection.main.head).toBe(position(5, 2))

  buffer = applyTabViewPatch(buffer, tabId, {
    line: 4,
    column: 3,
    matchLength: 2,
    focused: true,
    navigationId: 'nav-second'
  })
  await surface.render(editorProps(buffer, captureView))

  expect(view.state.selection.main.from).toBe(position(4, 3))
  expect(view.state.selection.main.to).toBe(position(4, 3) + 2)
  expect(patches).toContainEqual(expect.objectContaining({ navigationId: 'nav-second', line: null, column: null }))
})

test('pending navigation is isolated to the matching tab and background requests do not focus it', async () => {
  const buffer = makeBuffer({
    byTabId: {
      'tab-1': { line: 4, column: 2, matchLength: 2, focused: true, navigationId: 'nav-other-tab' },
      'tab-2': {
        line: 2,
        column: 3,
        matchLength: 2,
        focused: false,
        navigationId: 'nav-background',
        cursor: { line: 1, column: 1 },
        selection: { anchor: 0, head: 0 }
      }
    }
  }, 'tab-2')
  const patches: Record<string, unknown>[] = []
  const surface = await mountEditor(editorProps(buffer, (patch) => patches.push(patch)))
  const view = viewFor(surface.container)

  expect(view.state.selection.main.from).toBe(position(2, 3))
  expect(view.state.selection.main.to).toBe(position(2, 3) + 2)
  expect(view.hasFocus).toBe(false)
  expect(document.activeElement).not.toBe(view.contentDOM)
  expect(patches).toContainEqual(expect.objectContaining({ line: null, column: null, matchLength: null, focused: false }))
})
