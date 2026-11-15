import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, createRef, type ComponentPropsWithRef, type ComponentType, type ReactNode, useState } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { EditorView as EditorViewType } from '@codemirror/view'
import type { UiPluginContext } from '@quirky/protocol'
import type { SourceEditor as SourceEditorComponent, SourceEditorHandle } from '../src/window/SourceEditor'
import type { EditorSurfaceBuffer } from '../src/types'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'
import type { createEditorUiControlReportScope as CreateReportScope, EditorUiControlReportScope } from '../src/window/uiControl'
type SourceEditorProps = ComponentPropsWithRef<typeof SourceEditorComponent>
type Mounted = {
  container: HTMLDivElement
  root: Root
  render(props: SourceEditorProps): Promise<void>
  unmount(): Promise<void>
}

type UiAddress = { surface: string; target: string; generation: string; actions: string[] }
type UiReport = { mounted?: boolean; bufferId?: string | null; tabId?: string | null; mode?: string | null; uiControls?: UiAddress[] }
type CommandHandler = (args?: unknown) => unknown
type ControlHarness = {
  context: UiPluginContext
  calls: { method: string; params: Record<string, unknown> }[]
  address(action: string, targetPrefix?: string): UiAddress
  dispatch(address: UiAddress, action: string, data?: Record<string, unknown>): Promise<unknown>
}
type InteractiveMounted = Mounted & {
  calls: { method: string; params: Record<string, unknown> }[]
  report(): UiReport
  control(action: string, data?: Record<string, unknown>): Promise<unknown>
  dispatch(address: UiAddress, action: string, data?: Record<string, unknown>): Promise<unknown>
}

let createRoot: (container: HTMLElement) => Root
let SourceEditor: typeof SourceEditorComponent
let SourceEditorControlScope: ComponentType<{ context: UiPluginContext; children: ReactNode }>
let EditorUiControlProvider: ComponentType<{ scope: EditorUiControlReportScope; children: ReactNode }>
let createEditorUiControlReportScope: typeof CreateReportScope
let activateEditor: typeof Activate
let deactivateEditor: typeof Deactivate
let findEditorView: (node: HTMLElement) => EditorViewType | null
let container: HTMLDivElement
let mounted: Mounted[]
let controlHarness: ControlHarness | undefined
let restoreSelectionChangeDispatch: (() => void) | undefined
let restoreClipboard: (() => void) | undefined
let clipboardWrites: string[]

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The editor modules capture browser APIs at initialization, so register Happy DOM before importing them.
  ;({ createRoot } = await import('react-dom/client'))
  const source = await import('../src/window/SourceEditor') as {
    SourceEditor: typeof SourceEditorComponent
    SourceEditorControlScope: ComponentType<{ context: UiPluginContext; children: ReactNode }>
  }
  SourceEditor = source.SourceEditor
  SourceEditorControlScope = source.SourceEditorControlScope
  const controls = await import('../src/window/uiControl')
  EditorUiControlProvider = controls.EditorUiControlProvider
  createEditorUiControlReportScope = controls.createEditorUiControlReportScope
  ;({ activate: activateEditor, deactivate: deactivateEditor } = await import('../src/ui'))
  const { EditorView } = await import('@codemirror/view')
  findEditorView = (node) => EditorView.findFromDOM(node)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  mounted = []
  controlHarness = undefined
  clipboardWrites = []
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async readText() { return '' },
      async writeText(value: string) { clipboardWrites.push(value) }
    }
  })
  restoreClipboard = () => {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
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
  if (controlHarness) deactivateEditor()
  controlHarness = undefined
  restoreSelectionChangeDispatch?.()
  restoreSelectionChangeDispatch = undefined
  restoreClipboard?.()
  restoreClipboard = undefined
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

function activatedControlHarness(): ControlHarness {
  if (controlHarness) return controlHarness
  const handlers = new Map<string, CommandHandler>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const context = {
    pluginId: 'quirky.editor',
    provide(id: string, handler: CommandHandler) { handlers.set(id, handler) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 22 }
      if (method === 'ui.window.command.run') {
        if (params.connId !== 22) throw new Error('The source control must stay in this window.')
        const handler = handlers.get(String(params.id))
        if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
        return { result: await handler(params.args) }
      }
      return {}
    },
    getSetting() { return 320 },
    subscribe() { return () => {} },
    toast() {},
    setContext() {},
    togglePanel() {},
    setPanelBadge() {},
    getLayout() { return {} },
    mountView() { return () => {} }
  } as unknown as UiPluginContext
  activateEditor(context)
  controlHarness = {
    context,
    calls,
    address(action, targetPrefix) {
      const address = activeReport?.uiControls?.find((entry) =>
        entry.actions.includes(action) && (!targetPrefix || entry.target.startsWith(targetPrefix))
      )
      if (!address) throw new Error(`No reported source control advertises ${action}.`)
      return address
    },
    async dispatch(address, action, data) {
      return await context.call('ui.window.command.run', {
        connId: 22,
        id: 'command:quirky.editor/ui-control',
        args: {
          surface: address.surface,
          target: address.target,
          generation: address.generation,
          action,
          ...(data === undefined ? {} : { data })
        }
      })
    }
  }
  return controlHarness
}

let activeReport: UiReport | undefined

function ErrorReportingSource({ props }: { props: SourceEditorProps }) {
  const [error, setError] = useState<string | null>(props.error ?? null)
  return <SourceEditor {...props} error={error} onError={(message) => {
    props.onError(message)
    setError(message)
  }} />
}

// Interactive source fixtures use both the activated command bridge and the parent document report provider.
async function mountInteractiveEditor(props: SourceEditorProps): Promise<InteractiveMounted> {
  const harness = activatedControlHarness()
  const group = document.createElement('div')
  group.className = 'qt-group qt-active'
  const hostedView = document.createElement('div')
  hostedView.className = 'qt-hosted-view'
  hostedView.dataset.hostedView = props.tabId ?? ''
  const host = document.createElement('div')
  hostedView.append(host)
  group.append(hostedView)
  document.body.append(group)
  const root = createRoot(host)
  let report: UiReport = {}
  activeReport = report
  const scope = createEditorUiControlReportScope((next) => {
    report = next as UiReport
    activeReport = report
  }, { surface: 'view:quirky.editor/document' })
  const render = async (nextProps: SourceEditorProps) => {
    await act(async () => {
      scope.report({ mounted: true, bufferId: nextProps.buffer.id, tabId: nextProps.tabId, mode: 'source' })
      root.render(
        <EditorUiControlProvider scope={scope}>
          <SourceEditorControlScope context={harness.context}>
            <ErrorReportingSource props={nextProps} />
          </SourceEditorControlScope>
        </EditorUiControlProvider>
      )
    })
  }
  await render(props)
  let unmountedEditor = false
  const result: InteractiveMounted = {
    container: host,
    root,
    calls: harness.calls,
    report: () => report,
    control(action, data) {
      return harness.dispatch(harness.address(action, 'source:'), action, data)
    },
    dispatch(address, action, data) {
      return harness.dispatch(address, action, data)
    },
    render,
    async unmount() {
      if (unmountedEditor) return
      unmountedEditor = true
      await act(async () => root.unmount())
      scope.dispose()
      if (activeReport === report) activeReport = undefined
    }
  }
  mounted.push(result)
  return result
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

test('SourceEditor renders source operation errors with the shared inline error', async () => {
  const surface = await mountEditor({
    ...editorProps(makeBuffer({})),
    error: 'fixture source failed'
  })

  const error = surface.container.querySelector('.ui-inline-error')
  expect(error).not.toBeNull()
  expect(error?.getAttribute('role')).toBe('alert')
  expect(error?.textContent).toContain('fixture source failed')
})


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

function addressFor(surface: InteractiveMounted, action: string, targetPrefix = 'source:'): UiAddress {
  const address = surface.report().uiControls?.find((entry) =>
    entry.actions.includes(action) && entry.target.startsWith(targetPrefix)
  )
  if (!address) throw new Error(`No ${targetPrefix} control advertises ${action}.`)
  return address
}

async function deliver<T>(operation: () => Promise<T>): Promise<T> {
  let result!: T
  await act(async () => { result = await operation() })
  return result
}

async function flushClick(element: HTMLElement): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  await act(async () => {
    element.click()
    setTimeout(resolve, 0)
    await promise
  })
}

function setClipboardWriter(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { async readText() { return '' }, writeText }
  })
}

async function rejectedControl(operation: () => Promise<unknown>): Promise<Error> {
  let failure: unknown
  await act(async () => {
    try { await operation() } catch (reason) { failure = reason }
  })
  if (failure instanceof Error) return failure
  throw new Error(`Expected an Error rejection, got ${String(failure)}.`)
}

test('source addresses retain report fields and rotate only for source identity or engine replacement', async () => {
  let buffer = makeBuffer({}, 'tab-1', 'alpha\nbeta\n')
  const drafts: string[] = []
  const props = (next: EditorSurfaceBuffer) => ({ ...editorProps(next), onDraft: (content: string) => drafts.push(content) })
  const surface = await mountInteractiveEditor(props(buffer))
  const original = addressFor(surface, 'find')
  expect(original).toMatchObject({
    surface: 'view:quirky.editor/document',
    target: `source:${JSON.stringify([buffer.id, 'tab-1'])}`
  })
  expect(surface.report()).toMatchObject({ mounted: true, bufferId: buffer.id, tabId: 'tab-1', mode: 'source' })
  expect(surface.report().uiControls?.filter(({ target }) => target.startsWith('source:'))).toHaveLength(1)

  const view = viewFor(surface.container)
  await act(async () => { view.dispatch({ changes: { from: 5, insert: '!' } }) })
  expect(drafts).toEqual(['alpha!\nbeta\n'])
  expect(addressFor(surface, 'find').generation).toBe(original.generation)
  buffer = { ...buffer, draft: 'alpha!\nbeta\n', dirty: true, contentRevision: buffer.contentRevision + 1 }
  await surface.render(props(buffer))
  expect(addressFor(surface, 'find').generation).toBe(original.generation)

  buffer = { ...buffer, worktreeId: 'wt-renamed', path: '/fixture/src/renamed.ts', relativePath: 'src/renamed.ts' }
  await surface.render(props(buffer))
  const afterPath = addressFor(surface, 'find')
  expect(afterPath.target).toBe(original.target)
  expect(afterPath.generation).not.toBe(original.generation)
  expect(await deliver(() => surface.dispatch(original, 'find', { query: 'alpha' }))).toEqual({ result: { delivered: false } })

  buffer = { ...buffer, tabId: 'tab-2' }
  await surface.render({ ...props(buffer), tabId: 'tab-2' })
  const afterTab = addressFor(surface, 'find')
  expect(afterTab.target).toBe(`source:${JSON.stringify([buffer.id, 'tab-2'])}`)
  expect(afterTab.target).not.toBe(afterPath.target)
  expect(afterTab.generation).not.toBe(afterPath.generation)
  expect(surface.report()).toMatchObject({ bufferId: buffer.id, tabId: 'tab-2', mode: 'source' })

  await surface.render({ ...props(buffer), tabId: 'tab-2', comparisonOriginal: 'HEAD\ntext\n' })
  const mergeAddress = addressFor(surface, 'find')
  expect(surface.container.querySelector('[aria-label="HEAD version"]')).not.toBeNull()
  expect(surface.report().uiControls?.filter(({ target }) => target.startsWith('source:'))).toHaveLength(1)
  expect(mergeAddress.generation).not.toBe(afterTab.generation)

  await surface.render({ ...props(buffer), tabId: 'tab-2' })
  const singleAddress = addressFor(surface, 'find')
  expect(surface.container.querySelector('[aria-label="HEAD version"]')).toBeNull()
  expect(singleAddress.generation).not.toBe(mergeAddress.generation)
  await surface.unmount()
  expect(await deliver(() => surface.dispatch(singleAddress, 'find', { query: 'alpha' }))).toEqual({ result: { delivered: false } })
})

test('addressed find and replace preserve CodeMirror and imperative behavior without saving', async () => {
  const buffer = makeBuffer({}, 'tab-1', 'alpha alpha\nbeta\n')
  const drafts: string[] = []
  let flushCount = 0
  const handle = createRef<SourceEditorHandle>()
  const props: SourceEditorProps = {
    ...editorProps(buffer),
    ref: handle,
    onDraft: (content) => drafts.push(content),
    async flushDraft() { flushCount += 1 }
  }
  const surface = await mountInteractiveEditor(props)
  const opened = await deliver(() => surface.control('find', { query: 'alpha' }))
  expect(opened).toEqual({ result: { delivered: true } })
  let view = viewFor(surface.container)
  expect(view.state.doc.toString()).toBe('alpha alpha\nbeta\n')
  expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe('alpha')
  const query = surface.container.querySelector<HTMLInputElement>('input[aria-label="Find in source"]')
  expect(query?.value).toBe('alpha')

  let imperative: { opened: true; query?: string } | undefined
  await act(async () => { imperative = await handle.current!.find('alpha') })
  expect(imperative).toEqual({ opened: true, query: 'alpha' })
  expect(surface.container.querySelector<HTMLInputElement>('input[aria-label="Find in source"]')?.value).toBe('alpha')

  const findNext = [...surface.container.querySelectorAll<HTMLButtonElement>('[role="search"] button')]
    .find((button) => button.textContent?.includes('Find next'))
  expect(findNext).toBeDefined()
  const beforeFindClick = surface.calls.filter(({ method }) => method === 'ui.window.command.run').length
  await flushClick(findNext!)
  const afterFindClick = surface.calls.filter(({ method }) => method === 'ui.window.command.run')
  expect(afterFindClick).toHaveLength(beforeFindClick + 1)
  expect(afterFindClick.at(-1)?.params.args).toMatchObject({ action: 'find-next' })
  view = viewFor(surface.container)
  expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe('alpha')

  expect(await deliver(() => surface.control('replace-all', { query: 'alpha', replacement: 'z' })))
    .toEqual({ result: { delivered: true } })
  expect(view.state.doc.toString()).toBe('z z\nbeta\n')
  expect(drafts.at(-1)).toBe('z z\nbeta\n')
  expect(surface.container.querySelector<HTMLInputElement>('input[aria-label="Find in source"]')?.value).toBe('alpha')
  expect(flushCount).toBe(0)
  expect(surface.calls.some(({ method }) => method === 'quirky.editor/save')).toBe(false)

  const closeButton = surface.container.querySelector<HTMLButtonElement>('[aria-label="Close find"]')
  expect(closeButton).not.toBeNull()
  const beforeClose = surface.calls.filter(({ method }) => method === 'ui.window.command.run').length
  await flushClick(closeButton!)
  const closeCalls = surface.calls.filter(({ method }) => method === 'ui.window.command.run')
  expect(closeCalls).toHaveLength(beforeClose + 1)
  expect(closeCalls.at(-1)?.params.args).toMatchObject({ action: 'close-find' })
  expect(surface.container.querySelector('[role="search"]')).toBeNull()

  await deliver(() => surface.control('find', { query: 'z' }))
  const escapeInput = surface.container.querySelector<HTMLInputElement>('input[aria-label="Find in source"]')!
  const beforeEscape = surface.calls.filter(({ method }) => method === 'ui.window.command.run').length
  await act(async () => {
    escapeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await promise
  })
  const escapeCalls = surface.calls.filter(({ method }) => method === 'ui.window.command.run')
  expect(escapeCalls).toHaveLength(beforeEscape + 1)
  expect(escapeCalls.at(-1)?.params.args).toMatchObject({ action: 'close-find' })
  expect(surface.container.querySelector('[role="search"]')).toBeNull()

  const emptyFind = await rejectedControl(() => surface.control('find-next', { query: '' }))
  expect(emptyFind.message).toBe('Enter text to find in the source editor.')
  expect(surface.container.querySelector('.ui-inline-error')?.textContent).toContain(emptyFind.message)
  const emptyReplace = await rejectedControl(() => surface.control('replace-all', { query: '', replacement: 'x' }))
  expect(emptyReplace.message).toBe('Enter text to replace in the source editor.')
  expect(surface.container.querySelector('.ui-inline-error')?.textContent).toContain(emptyReplace.message)
  const unmatched = await rejectedControl(() => surface.control('find', { query: 'missing' }))
  expect(unmatched.message).toBe('No match for “missing”.')
  expect(surface.container.querySelector('.ui-inline-error')?.textContent).toContain(unmatched.message)
})

test('selection context and editor menus preserve captured intent through the activated route', async () => {
  let buffer = {
    ...makeBuffer({}, 'tab-1', 'alpha beta\nline two\n'),
    path: '/fixture/src/a.ts',
    relativePath: 'src/a.ts'
  }
  const searchIntents: { worktreeId: string; query: string }[] = []
  const props: SourceEditorProps = {
    ...editorProps(buffer),
    onSearchInFiles(query) { searchIntents.push({ worktreeId: buffer.worktreeId, query }) }
  }
  const surface = await mountInteractiveEditor(props)
  const view = viewFor(surface.container)
  await act(async () => { view.dispatch({ selection: { anchor: 0, head: 5 } }) })

  expect(await deliver(() => surface.control('copy-context'))).toEqual({ result: { delivered: true } })
  expect(clipboardWrites).toEqual(['src/a.ts:1\nalpha'])

  expect(await deliver(() => surface.control('menu-open', { kind: 'editor', line: 1, column: 1, x: 12, y: 9 })))
    .toEqual({ result: { delivered: true } })
  const menuAddress = addressFor(surface, 'search-in-files', 'source-menu:')
  const menu = surface.container.querySelector<HTMLElement>('.qe-source-context-menu')
  const routeCount = surface.calls.filter(({ method }) => method === 'ui.window.command.run').length
  await flushClick(menu!)
  expect(surface.report().uiControls?.some(({ target }) => target === menuAddress.target)).toBe(true)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(routeCount)

  const menuContext = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => {
    menu!.dispatchEvent(menuContext)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await promise
  })
  expect(surface.report().uiControls?.some(({ target }) => target === menuAddress.target)).toBe(true)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(routeCount)
  const backdrop = surface.container.querySelector<HTMLElement>('.qe-source-menu-layer')
  expect(backdrop).not.toBeNull()
  await flushClick(backdrop!)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(routeCount + 1)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)?.params.args)
    .toMatchObject({ action: 'close', target: menuAddress.target, generation: menuAddress.generation })
  expect(surface.container.querySelector('[role="menu"]')).toBeNull()
  expect(await deliver(() => surface.dispatch(menuAddress, 'close'))).toEqual({ result: { delivered: false } })

  await deliver(() => surface.control('menu-open', { kind: 'editor', line: 1, column: 1, x: 12, y: 9 }))
  const activeMenuAddress = addressFor(surface, 'search-in-files', 'source-menu:')
  expect(activeMenuAddress.generation).not.toBe(menuAddress.generation)
  const activeMenu = surface.container.querySelector<HTMLElement>('.qe-source-context-menu')
  expect(activeMenu).not.toBeNull()
  const activeBackdrop = surface.container.querySelector<HTMLElement>('.qe-source-menu-layer')!
  const contextDismiss = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => {
    activeBackdrop.dispatchEvent(contextDismiss)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await promise
  })
  expect(contextDismiss.defaultPrevented).toBe(true)
  expect(surface.container.querySelector('[role="menu"]')).toBeNull()
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)?.params.args)
    .toMatchObject({ action: 'close', target: activeMenuAddress.target, generation: activeMenuAddress.generation })

  await deliver(() => surface.control('menu-open', { kind: 'editor', line: 1, column: 1, x: 12, y: 9 }))
  const searchMenuAddress = addressFor(surface, 'search-in-files', 'source-menu:')
  const searchMenu = surface.container.querySelector<HTMLElement>('.qe-source-context-menu')
  const beforeSearchClick = surface.calls.filter(({ method }) => method === 'ui.window.command.run').length

  await act(async () => { view.dispatch({ selection: { anchor: 6, head: 10 } }) })
  expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe('beta')
  const searchButton = searchMenu!.querySelector<HTMLButtonElement>('[role="menuitem"]')
  expect(searchButton?.textContent).toContain('Search in Files')
  await flushClick(searchButton!)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(beforeSearchClick + 1)
  expect(searchIntents).toEqual([{ worktreeId: 'wt-source-navigation', query: 'alpha' }])
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)?.params.args)
    .toMatchObject({ action: 'search-in-files', target: searchMenuAddress.target, generation: searchMenuAddress.generation })
  expect(surface.report().uiControls?.some(({ target }) => target === searchMenuAddress.target)).toBe(false)
  await act(async () => { view.dispatch({ selection: { anchor: 0 } }) })
  await deliver(() => surface.control('menu-open', { kind: 'editor', line: 1, column: 8 }))
  await deliver(() => surface.dispatch(addressFor(surface, 'search-in-files', 'source-menu:'), 'search-in-files'))
  expect(searchIntents.at(-1)).toEqual({ worktreeId: 'wt-source-navigation', query: 'beta' })

  buffer = { ...buffer, worktreeId: 'wt-other' }
  await surface.render({ ...props, buffer })
  expect(await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 2, x: 4, y: 7 })))
    .toEqual({ result: { delivered: true } })
  let gutterAddress = addressFor(surface, 'copy-line', 'source-menu:')
  expect(await deliver(() => surface.dispatch(gutterAddress, 'copy-line', { relative: false })))
    .toEqual({ result: { delivered: true } })
  expect(clipboardWrites.at(-1)).toBe('/fixture/src/a.ts:2')

  await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 2 }))
  gutterAddress = addressFor(surface, 'copy-line', 'source-menu:')
  expect(await deliver(() => surface.dispatch(gutterAddress, 'copy-line', { relative: true })))
    .toEqual({ result: { delivered: true } })
  expect(clipboardWrites.at(-1)).toBe('src/a.ts:2')

  setClipboardWriter(async () => { throw new Error('fixture clipboard failed') })
  await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 2 }))
  gutterAddress = addressFor(surface, 'copy-line', 'source-menu:')
  expect((await rejectedControl(() => surface.dispatch(gutterAddress, 'copy-line', { relative: true }))).message)
    .toBe('Unable to copy line path: fixture clipboard failed')
  expect(surface.container.querySelector('.ui-inline-error')?.textContent).toContain('Unable to copy line path: fixture clipboard failed')
})

test.each(['resolve', 'reject'] as const)('a delayed clipboard %s cannot dismiss or change a replacement gutter menu', async (outcome) => {
  const buffer = {
    ...makeBuffer({}, 'tab-1', 'alpha\nbeta\ngamma\n'),
    path: '/fixture/src/a.ts',
    relativePath: 'src/a.ts'
  }
  const surface = await mountInteractiveEditor(editorProps(buffer))
  const pendingClipboard = Promise.withResolvers<void>()
  setClipboardWriter(async (value) => {
    clipboardWrites.push(value)
    await pendingClipboard.promise
  })
  await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 2 }))
  const first = addressFor(surface, 'copy-line', 'source-menu:')
  let copy!: Promise<unknown>
  await act(async () => {
    copy = surface.dispatch(first, 'copy-line', { relative: true })
    void copy.catch(() => {})
    await Promise.resolve()
  })
  expect(clipboardWrites).toEqual(['src/a.ts:2'])

  await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 3 }))
  const replacement = addressFor(surface, 'copy-line', 'source-menu:')
  expect(replacement.target).toBe(first.target)
  expect(replacement.generation).not.toBe(first.generation)
  let failure: unknown
  await act(async () => {
    if (outcome === 'resolve') pendingClipboard.resolve()
    else pendingClipboard.reject(new Error('fixture clipboard failed'))
    try { await copy } catch (reason) { failure = reason }
  })
  if (outcome === 'reject') expect((failure as Error)?.message).toBe('Unable to copy line path: fixture clipboard failed')
  expect(surface.container.querySelector('.ui-inline-error')).toBeNull()
  expect(surface.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(addressFor(surface, 'copy-line', 'source-menu').generation).toBe(replacement.generation)
  expect(clipboardWrites).toEqual(['src/a.ts:2'])

  expect(await deliver(() => surface.dispatch(first, 'copy-line', { relative: true })))
    .toEqual({ result: { delivered: false } })
  expect(await deliver(() => surface.dispatch(replacement, 'close'))).toEqual({ result: { delivered: true } })
  expect(surface.container.querySelector('[role="menu"]')).toBeNull()
})

test('source controls refuse malformed, stale, out-of-range and unavailable commands without side effects', async () => {
  const buffer = makeBuffer({}, 'tab-1', 'alpha\nbeta\n')
  const surface = await mountInteractiveEditor({ ...editorProps(buffer), minimap: true })
  const source = addressFor(surface, 'find')
  const beforeText = viewFor(surface.container).state.doc.toString()
  const refusals = [
    () => surface.dispatch(source, 'unknown-action'),
    () => surface.dispatch(source, 'find', { query: 17 }),
    () => surface.dispatch(source, 'replace-all', { query: 'alpha', replacement: 17 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'gutter', line: '2' }),
    () => surface.dispatch(source, 'menu-open', { kind: 'gutter', line: 0 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'gutter', line: 4 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'editor', line: 1, column: 0 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'editor', line: 1, column: 7 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'editor', line: 1, x: Number.POSITIVE_INFINITY }),
    () => surface.dispatch(source, 'menu-open', { kind: 'editor', line: 1, y: -1 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'other', line: 1 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'gutter', line: 1.5 }),
    () => surface.dispatch(source, 'menu-open', { kind: 'editor', line: 1, query: 'caller supplied' }),
    () => surface.dispatch(source, 'find', { query: 'alpha', unexpected: true }),
    () => surface.dispatch(source, 'minimap', { position: -0.1 }),
    () => surface.dispatch(source, 'minimap', { position: 1.1 }),
    () => surface.dispatch(source, 'minimap', { position: Number.NaN }),
    () => surface.dispatch({ ...source, generation: 'stale-generation' }, 'find', { query: 'alpha' })
  ]
  for (const refusal of refusals) {
    expect(await deliver(refusal)).toEqual({ result: { delivered: false } })
  }
  expect(viewFor(surface.container).state.doc.toString()).toBe(beforeText)
  expect(surface.container.querySelector('[role="search"], [role="menu"]')).toBeNull()
  expect(clipboardWrites).toEqual([])

  await surface.render({ ...editorProps(buffer), minimap: false })
  const withoutMinimap = addressFor(surface, 'find')
  expect(withoutMinimap.actions).not.toContain('minimap')
  expect(await deliver(() => surface.dispatch(withoutMinimap, 'minimap', { position: 0.5 })))
    .toEqual({ result: { delivered: false } })
})

test('minimap control maps a normalized position onto the real editor scroll range', async () => {
  const surface = await mountInteractiveEditor({ ...editorProps(makeBuffer({}, 'tab-1', 'a\nb\nc\nd\n')), minimap: true })
  const view = viewFor(surface.container)
  Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(view.scrollDOM, 'clientHeight', { configurable: true, value: 200 })

  const canvas = surface.container.querySelector<HTMLCanvasElement>('canvas[aria-label="Code minimap"]')
  expect(canvas).not.toBeNull()
  Object.defineProperty(canvas!, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 10, bottom: 110, left: 0, right: 100, width: 100, height: 100, x: 0, y: 10, toJSON() {} } as DOMRect)
  })
  const address = addressFor(surface, 'minimap')
  await act(async () => {
    canvas!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 60 }))
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await promise
  })
  expect(view.scrollDOM.scrollTop).toBe(400)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)?.params.args)
    .toMatchObject({ action: 'minimap', target: address.target, generation: address.generation, data: { position: 0.5 } })

  const beforeInvalid = view.scrollDOM.scrollTop
  expect(await deliver(() => surface.dispatch(address, 'minimap', { position: Number.POSITIVE_INFINITY })))
    .toEqual({ result: { delivered: false } })
  expect(view.scrollDOM.scrollTop).toBe(beforeInvalid)
})

test('source paste accepts the exact 16 MiB UTF-8 limit and refuses the next byte', async () => {
  const drafts: string[] = []
  const surface = await mountInteractiveEditor({
    ...editorProps(makeBuffer({}, 'tab-1', '')),
    onDraft: (content) => drafts.push(content)
  })
  const view = viewFor(surface.container)
  const limit = 16 * 1024 * 1024
  const exact = `${'a'.repeat(limit - 2)}é`
  const paste = (text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData(type: string) { return type === 'text/plain' ? text : '' } }
    })
    view.contentDOM.dispatchEvent(event)
    return event
  }

  let accepted!: Event
  await act(async () => { accepted = paste(exact) })
  expect(accepted.defaultPrevented).toBe(true)
  expect(view.state.doc.toString()).toBe(exact)
  expect(limit - 2 + new TextEncoder().encode('é').byteLength).toBe(limit)
  expect(drafts.at(-1)).toBe(exact)
  expect(surface.container.querySelector('.ui-inline-error')).toBeNull()

  await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }) })
  let refused!: Event
  await act(async () => { refused = paste(`${exact}x`) })
  expect(refused.defaultPrevented).toBe(true)
  expect(view.state.doc.toString()).toBe('')
  expect(surface.container.querySelector('.ui-inline-error')?.textContent)
    .toContain('Paste refused: source editor pastes are limited to 16 MiB.')
  expect(drafts.at(-1)).toBe('')
})

test('native editor context menus route the captured, truncated and trimmed selection', async () => {
  const intents: string[] = []
  const text = `  ${'a'.repeat(8191)}TAIL  `
  const surface = await mountInteractiveEditor({
    ...editorProps(makeBuffer({}, 'tab-1', text)),
    onSearchInFiles: (query) => { intents.push(query) }
  })
  const view = viewFor(surface.container)
  await act(async () => { view.dispatch({ selection: { anchor: 0, head: text.length } }) })
  view.posAtCoords = () => 4
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 9 })
  await act(async () => {
    view.contentDOM.dispatchEvent(event)
    await Bun.sleep(0)
  })
  expect(event.defaultPrevented).toBe(true)
  expect(surface.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)?.params.args)
    .toMatchObject({ action: 'menu-open', data: { kind: 'editor', line: 1 } })
  const address = addressFor(surface, 'search-in-files', 'source-menu:')
  expect(await deliver(() => surface.dispatch(address, 'search-in-files'))).toEqual({ result: { delivered: true } })
  expect(intents).toEqual([text.slice(0, 8192).trim()])
})

test('engine-only source controls fail visibly instead of copying through a local fallback', async () => {
  const surface = await mountEditor(editorProps(makeBuffer({}, 'tab-1', 'alpha')))
  const view = viewFor(surface.container)
  await act(async () => { view.dispatch({ selection: { anchor: 0, head: 5 } }) })
  const copy = [...surface.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Copy context'))!
  await flushClick(copy)
  expect(clipboardWrites).toEqual([])
  expect(surface.container.querySelector('.ui-inline-error')?.textContent).toContain('The editor control is no longer available.')
})

test.each([
  ['missing self', {}, 'The daemon did not identify this window.'],
  ['invalid self', { connId: 0 }, 'The daemon did not identify this window.'],
  ['refusal', { result: { delivered: false } }, 'The editor control is no longer available.'],
  ['malformed reply', { result: {} }, 'The editor control bridge returned an invalid response.'],
  ['dispatch rejection', null, 'fixture dispatch failed']
] as const)('source menu %s is visible and never falls back to a clipboard operation', async (kind, response, message) => {
  const surface = await mountInteractiveEditor(editorProps(makeBuffer({}, 'tab-1', 'alpha')))
  await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 1 }))
  const context = controlHarness!.context
  const original = context.call.bind(context)
  context.call = async (method, params) => {
    if (kind.includes('self') && method === 'ui.window.self') return response
    if (!kind.includes('self') && method === 'ui.window.command.run') {
      if (kind === 'dispatch rejection') throw new Error(message)
      return response
    }
    return original(method, params)
  }
  const copy = surface.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  await flushClick(copy)
  expect(surface.container.querySelector('.ui-inline-error')?.textContent).toContain(message)
  expect(surface.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(clipboardWrites).toEqual([])
})

test.each(['resolve', 'reject'] as const)('a delayed self %s cannot act on a replacement source menu', async (outcome) => {
  const surface = await mountInteractiveEditor(editorProps(makeBuffer({}, 'tab-1', 'alpha\nbeta')))
  await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 1 }))
  const first = addressFor(surface, 'copy-line', 'source-menu:')
  const context = controlHarness!.context
  const original = context.call.bind(context)
  const self = Promise.withResolvers<unknown>()
  context.call = async (method, params) => method === 'ui.window.self' ? self.promise : original(method, params)
  await act(async () => { surface.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(); await Promise.resolve() })
  expect(await deliver(() => surface.control('menu-open', { kind: 'gutter', line: 2 }))).toEqual({ result: { delivered: true } })
  const replacement = addressFor(surface, 'copy-line', 'source-menu:')
  expect(replacement.generation).not.toBe(first.generation)
  await act(async () => {
    if (outcome === 'resolve') self.resolve({ connId: 22 })
    else self.reject(new Error('fixture stale bridge failed'))
    await Bun.sleep(0)
  })
  expect(addressFor(surface, 'copy-line', 'source-menu:').generation).toBe(replacement.generation)
  expect(surface.container.querySelector('.ui-inline-error')).toBeNull()
  expect(clipboardWrites).toEqual([])
})
