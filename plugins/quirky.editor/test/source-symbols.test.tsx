import { expect as RS_expect, test as RS_test } from 'bun:test'
import { act as RS_act } from 'react'
import { cpSync as RS_cpSync, readFileSync as RS_readFileSync, rmSync as RS_rmSync } from 'node:fs'
import { join as RS_join, resolve as RS_resolve } from 'node:path'
import type { QuirkyClient as RS_QuirkyClient, UiPluginContext as RS_UiPluginContext } from '@quirky/protocol'
import { chordFromKeyEvent as RS_chordFromKeyEvent, parseChord as RS_parseChord } from '@quirky/protocol'
import { builtinsDir as RS_builtinsDir, makeHomeWithoutAutoHooks as RS_makeHomeWithoutAutoHooks, startHarness as RS_startHarness, waitForAsync as RS_waitForAsync, type Harness as RS_Harness } from '../../../packages/daemon/test/helpers'
import { isolateEditorTestEnvironment as RS_isolateEditorTestEnvironment } from './isolated-environment'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, createRef, type ComponentType, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { EditorState, Text } from '@codemirror/state'
import { CHORD_PLATFORM, chordFromKeyEvent, parseChord, type UiPluginContext } from '@quirky/protocol'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { EditorView as EditorViewType } from '@codemirror/view'
import type { EditorBufferInfo, EditorSurfaceBuffer } from '../src/types'
import type { DocumentSurface as DocumentSurfaceComponent } from '../src/window/DocumentSurface'
import type { SourceEditor as SourceEditorComponent, SourceEditorControlScope as SourceEditorControlScopeComponent, SourceEditorHandle } from '../src/window/SourceEditor'
import type { activate as Activate, deactivate as Deactivate } from '../src/ui'
import type { createEditorUiControlReportScope as CreateReportScope, EditorUiControlAddress, EditorUiControlReportScope } from '../src/window/uiControl'
import { activeDocument } from '../src/window/activeDocument'
import { fromNavigationPosition, navigationLanguage, toNavigationPosition, type NavigationResult } from '../src/window/sourceNavigation'

const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8')) as {
  contributes: {
    command: { id: string; title?: string; args?: { type: string; properties?: Record<string, { type: string; minimum?: number }>; additionalProperties?: boolean } }[]
    keybinding: { key: string; command: string; when: string }[]
    method: { id: string; params?: { properties?: Record<string, { type: string; minimum?: number }>; additionalProperties?: boolean } }[]
    'cli-command': { words: string; method: string }[]
  }
}

test('manifest exposes the source-symbol commands, argument shape, keybindings, methods and CLI forms', () => {
  for (const [id, title] of [['go-to-definition', 'Go to Definition'], ['find-references', 'Find References']]) {
    const command = manifest.contributes.command.find((entry) => entry.id === id)
    expect(command?.title).toBe(title)
    expect(command?.args).toMatchObject({
      type: 'object',
      properties: {
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    })
    expect(manifest.contributes.keybinding).toContainEqual(expect.objectContaining({ key: id === 'go-to-definition' ? 'f12' : 'shift+f12', command: id, when: 'editorFocus' }))
    expect(manifest.contributes.method.find((entry) => entry.id === id)?.params).toMatchObject({
      properties: {
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    })
    expect(manifest.contributes['cli-command']).toContainEqual(expect.objectContaining({ words: id, method: id }))
  }
})
test('F12 key events canonicalize to the declared command chords', () => {
  expect(parseChord('f12')).toMatchObject({ ok: true, chord: 'f12' })
  expect(parseChord('shift+f12')).toMatchObject({ ok: true, chord: 'shift+f12' })
  expect(chordFromKeyEvent({ key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe('f12')
  expect(chordFromKeyEvent({ key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe('shift+f12')
})


test('source navigation maps supported extensions and converts UTF-16 positions across separators', () => {
  expect(navigationLanguage('src/a.TSX')).toBe('typescript')
  expect(navigationLanguage('src/a.mts')).toBe('typescript')
  expect(navigationLanguage('src/a.cjs')).toBe('typescript')
  expect(navigationLanguage('main.pyi')).toBe('python')
  expect(navigationLanguage('README.md')).toBeNull()

  // CodeMirror normalizes CRLF into one document line break.
  const crlf = EditorState.create({ doc: 'alpha\r\nbeta' }).doc
  expect(toNavigationPosition(crlf, 7, 'python')).toEqual({ line: 2, column: 2 })
  expect(fromNavigationPosition(crlf, 2, 2, 'python')).toBe(7)

  const unicodeSeparator = Text.of(['a\u2028b', 'tail'])
  expect(toNavigationPosition(unicodeSeparator, 2, 'typescript')).toEqual({ line: 2, column: 1 })
  expect(fromNavigationPosition(unicodeSeparator, 2, 1, 'typescript')).toBe(2)
  expect(toNavigationPosition(unicodeSeparator, 2, 'python')).toEqual({ line: 1, column: 3 })
  expect(fromNavigationPosition(unicodeSeparator, 1, 3, 'python')).toBe(2)

  const leadingSeparators = Text.of(['\u2028x\u2029y'])
  expect(toNavigationPosition(leadingSeparators, 0, 'typescript')).toEqual({ line: 1, column: 1 })
  expect(toNavigationPosition(leadingSeparators, 1, 'typescript')).toEqual({ line: 2, column: 1 })
  expect(toNavigationPosition(leadingSeparators, 3, 'typescript')).toEqual({ line: 3, column: 1 })
  expect(fromNavigationPosition(leadingSeparators, 1, 1, 'typescript')).toBe(0)
  expect(fromNavigationPosition(leadingSeparators, 2, 1, 'typescript')).toBe(1)
  expect(fromNavigationPosition(leadingSeparators, 3, 1, 'typescript')).toBe(3)

  const emojiLine = Text.of(['first', 'second', 'third', `${'1'.repeat(24)}🙂greet()`])
  expect(toNavigationPosition(emojiLine, emojiLine.line(4).from + 26, 'typescript')).toEqual({ line: 4, column: 27 })
  expect(fromNavigationPosition(emojiLine, 4, 27, 'typescript')).toBe(emojiLine.line(4).from + 26)
})

const WORKTREE_ID = 'wt-source-symbols'
const BUFFER_ID = 'buffer-source-symbols'
const TAB_ID = 'tab-source-symbols'
type TestCall = { method: string; params: Record<string, unknown> }
type ProvidedHandler = (args?: unknown) => unknown
type NavigationHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type MountOptions = {
  relativePath?: string
  content?: string
  draft?: string | null
  external?: EditorBufferInfo['external']
  untitled?: boolean
  navigation?: NavigationHandler
  secondTab?: boolean
  windowSelf?: () => unknown | Promise<unknown>
}
type UiReport = { uiControls?: EditorUiControlAddress[]; sourceSymbols?: Record<string, unknown> } & Record<string, unknown>
type MountedDocument = {
  container: HTMLDivElement
  context: UiPluginContext
  calls: TestCall[]
  navigationCalls: TestCall[]
  openCalls: TestCall[]
  saveCalls: TestCall[]
  viewWrites: TestCall[]
  report(): UiReport
  view(tabId?: string): EditorViewType
  command(command: 'go-to-definition' | 'find-references', args?: Record<string, unknown>): Promise<unknown>
  address(prefix: string): EditorUiControlAddress
  dispatch(address: EditorUiControlAddress, action: string, data?: Record<string, unknown>): Promise<unknown>
  updateBuffer(patch: Partial<EditorBufferInfo>): void
  unmount(): Promise<void>
}

let createRoot: (container: HTMLElement) => Root
let DocumentSurface: typeof DocumentSurfaceComponent
let SourceEditor: typeof SourceEditorComponent
let SourceEditorControlScope: typeof SourceEditorControlScopeComponent
let EditorUiControlProvider: ComponentType<{ scope: EditorUiControlReportScope; children: ReactNode }>
let createEditorUiControlReportScope: typeof CreateReportScope
let activateEditor: typeof Activate
let deactivateEditor: typeof Deactivate
let findEditorView: (node: HTMLElement) => EditorViewType | null
let mountedDocuments: MountedDocument[] = []
let editorActivated = false
const NativeResponse = globalThis.Response
let restoreSelectionChangeDispatch: (() => void) | undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  globalThis.Response = NativeResponse
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The editor captures browser APIs at module initialization; register Happy DOM before importing it.
  ;({ createRoot } = await import('react-dom/client'))
  await import('../src/viewers/ViewerSurface')
  ;({ DocumentSurface } = await import('../src/window/DocumentSurface'))
  ;({ SourceEditor, SourceEditorControlScope } = await import('../src/window/SourceEditor'))
  ;({ activate: activateEditor, deactivate: deactivateEditor } = await import('../src/ui'))
  ;({ EditorUiControlProvider, createEditorUiControlReportScope } = await import('../src/window/uiControl'))
  const { EditorView } = await import('@codemirror/view')
  findEditorView = (node) => EditorView.findFromDOM(node)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  const dispatchEvent = document.dispatchEvent.bind(document)
  let timer: number | undefined
  // browsers queue selectionchange; Happy DOM dispatches it inside CodeMirror's update.
  document.dispatchEvent = ((event: Event) => {
    if (event.type !== 'selectionchange') return dispatchEvent(event)
    if (timer === undefined) timer = window.setTimeout(() => {
      timer = undefined
      dispatchEvent(event)
    }, 0)
    return true
  }) as typeof document.dispatchEvent
  restoreSelectionChangeDispatch = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    document.dispatchEvent = dispatchEvent
  }
})

afterEach(async () => {
  const failures: unknown[] = []
  for (const fixture of [...RS_fixtures]) {
    try { await RS_cleanupFixture(fixture) } catch (error) { failures.push(error) }
  }
  for (const mounted of mountedDocuments) {
    try { await mounted.unmount() } catch (error) { failures.push(error) }
  }
  mountedDocuments = []
  if (editorActivated) {
    deactivateEditor()
    editorActivated = false
  }
  restoreSelectionChangeDispatch?.()
  document.body.replaceChildren()
  if (failures.length) throw new AggregateError(failures, 'Source-symbol fixture teardown failed')
})

function makeBufferInfo(options: MountOptions = {}): EditorBufferInfo {
  const relativePath = options.relativePath ?? 'src/use.ts'
  const content = options.content ?? 'const greet = "🙂";\nconst caller = greet\n'
  const draft = options.draft ?? null
  const path = `/fixture/${relativePath}`
  return {
    id: BUFFER_ID,
    worktreeId: WORKTREE_ID,
    root: '/fixture',
    path,
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    kind: 'text',
    content,
    draft,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: draft !== null,
    external: options.external ?? null,
    mode: 'source',
    tabId: TAB_ID,
    preview: false,
    pinned: false,
    untitled: options.untitled ?? false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    contentLength: content.length,
    draftLength: draft?.length ?? null,
    diskContentLength: null,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
    diskContentBytes: null,
    diskSignature: null
  }
}

async function tickUi(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

async function mountDocument(options: MountOptions = {}): Promise<MountedDocument> {
  let info = makeBufferInfo(options)
  const tabIds = options.secondTab ? [TAB_ID, `${TAB_ID}-second`] : [TAB_ID]
  const state = {
    buffers: [info],
    tabs: tabIds.map((tabId) => ({ tabId, bufferId: BUFFER_ID, mode: 'edit' as const })),
    explorer: { worktreeId: WORKTREE_ID, showDotfiles: false, expanded: [] },
    search: null,
    quickOpenHistory: [],
    closeRequests: []
  }
  const calls: TestCall[] = []
  const navigationCalls: TestCall[] = []
  const openCalls: TestCall[] = []
  const saveCalls: TestCall[] = []
  const viewWrites: TestCall[] = []
  const handlers = new Map<string, ProvidedHandler>()
  const listeners = new Set<(event: { type: string; id?: string; value?: unknown }) => void>()
  const settings = new Map<string, unknown>([
    ['editorAutoSave', false], ['editorAutoSaveDelayMs', 1000], ['editorWordWrap', false],
    ['editorFontFamily', 'monospace'], ['editorPreviewTabsEnabled', true],
    ['richMarkdownSpellcheckEnabled', true], ['markdownReviewToolsEnabled', true],
    ['showGitIgnoredFiles', false], ['followSymlinkedDirectories', true],
    ['editorFontZoomLevel', 0], ['editorMinimapEnabled', false], ['editorSidebarWidth', 320]
  ])
  const publishBuffer = (patch: Partial<EditorBufferInfo>) => {
    info = { ...info, ...patch }
    state.buffers[0] = info
    for (const listener of listeners) listener({ type: 'quirky.editor/changed' })
  }
  const context = {
    pluginId: 'quirky.editor',
    provide(id: string, handler: ProvidedHandler) { handlers.set(id, handler) },
    async call(method: string, params: Record<string, unknown> = {}) {
      const call = { method, params: { ...params } }
      calls.push(call)
      if (method === 'ui.window.self') return options.windowSelf ? await options.windowSelf() : { connId: 22 }
      if (method === 'ui.window.command.run') {
        if (params.connId !== 22) throw new Error('The UI control must stay in this window.')
        const handler = handlers.get(String(params.id))
        if (!handler) throw new Error(`No provided handler for ${String(params.id)}.`)
        return { result: await handler(params.args) }
      }
      if (method === 'quirky.editor/state') return { ...state, buffers: [{ ...info }] }
      if (method === 'quirky.navigation/definition' || method === 'quirky.navigation/references') {
        navigationCalls.push(call)
        if (options.navigation) return await options.navigation(method, params)
        return { worktreeId: WORKTREE_ID, language: 'typescript', locations: [], truncated: false } satisfies NavigationResult
      }
      if (method === 'quirky.editor/open') {
        openCalls.push(call)
        return { openedTabId: 'opened-source-symbol-target' }
      }
      if (method === 'quirky.editor/save') {
        saveCalls.push(call)
        info = { ...info, content: info.draft ?? info.content, draft: null, dirty: false }
        state.buffers[0] = info
        return { ...info }
      }
      if (method === 'quirky.editor/draft') {
        const content = String(params.content ?? '')
        const draft = content === info.content ? null : content
        info = {
          ...info,
          draft,
          draftLength: draft?.length ?? null,
          draftBytes: draft === null ? null : new TextEncoder().encode(draft).byteLength,
          dirty: draft !== null,
          revision: info.revision + 1,
          contentRevision: info.contentRevision + 1
        }
        state.buffers[0] = info
        return { ...info }
      }
      if (method === 'quirky.editor/view') {
        viewWrites.push(call)
        if (params.action === 'update' && params.patch && typeof params.patch === 'object') {
          info = { ...info, view: { ...info.view, ...params.patch as Record<string, unknown> } }
          state.buffers[0] = info
        }
        return { ...info }
      }
      if (method === 'quirky.editor/close') return { closed: true }
      return {}
    },
    getSetting(name: string) { return settings.get(name) },
    subscribe(listener: (event: { type: string; id?: string; value?: unknown }) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnection() { return () => {} },
    getLayout() { return { worktree: WORKTREE_ID, focus: 'view' } },
    setContext() {},
    toast() {},
    togglePanel() {},
    setPanelBadge() {},
    mountView() { return () => {} }
  } as unknown as UiPluginContext

  activateEditor(context)
  editorActivated = true
  let report: UiReport = {}
  const scope = createEditorUiControlReportScope((value) => { report = value as UiReport }, {
    surface: 'view:quirky.editor/document',
    context
  })
  scope.report({ mounted: true, bufferId: BUFFER_ID, tabId: TAB_ID, mode: 'source' })

  const containers: HTMLDivElement[] = []
  for (const tabId of tabIds) {
    const group = document.createElement('div')
    group.className = 'qt-group qt-active'
    const hostedView = document.createElement('div')
    hostedView.className = 'qt-hosted-view'
    hostedView.dataset.hostedView = tabId
    const container = document.createElement('div')
    hostedView.append(container)
    group.append(hostedView)
    document.body.append(group)
    containers.push(container)
  }
  const container = containers[0]!
  const roots = containers.map((container) => createRoot(container))
  await act(async () => {
    roots.forEach((root, index) => {
      root.render(
        <EditorUiControlProvider scope={scope}>
          <DocumentSurface context={context} input={{ bufferId: BUFFER_ID, tabId: tabIds[index], mode: 'source' }} />
        </EditorUiControlProvider>
      )
    })
  })
  await tickUi()

  let unmounted = false
  const mounted: MountedDocument = {
    container,
    context,
    calls,
    navigationCalls,
    openCalls,
    saveCalls,
    viewWrites,
    report: () => report,
    view(tabId = TAB_ID) {
      const index = tabIds.indexOf(tabId)
      const editor = containers[index]?.querySelector<HTMLElement>('.cm-editor')
      if (!editor) throw new Error(`DocumentSurface did not render the source editor in ${tabId}.`)
      const view = findEditorView(editor)
      if (!view) throw new Error(`The source editor in ${tabId} has no CodeMirror view.`)
      return view
    },
    command(command, args) {
      const document = activeDocument()
      if (!document) throw new Error('There is no active document.')
      return document.runCommand(command, args)
    },
    address(prefix) {
      const address = report.uiControls?.find((control) => control.target.startsWith(prefix))
      if (!address) throw new Error(`No UI control address starts with ${prefix}.`)
      return address
    },
    async dispatch(address, action, data) {
      let response: unknown
      await act(async () => {
        response = await context.call('ui.window.command.run', {
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
      })
      return response
    },
    updateBuffer(patch) { publishBuffer(patch) },
    async unmount() {
      if (unmounted) return
      unmounted = true
      await act(async () => { for (const root of roots) root.unmount() })
      scope.dispose()
    }
  }
  mountedDocuments.push(mounted)
  return mounted
}

function navigationResult(locations: NavigationResult['locations'], worktreeId = WORKTREE_ID, truncated = false): NavigationResult {
  return { worktreeId, language: 'typescript', locations, truncated }
}


async function waitUi(milliseconds = 200): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)) })
}

test('a same-file definition reveals only the initiating tab and persists its view', async () => {
  const fixture = await mountDocument({
    secondTab: true,
    navigation: async () => navigationResult([{
      path: '/fixture/src/use.ts',
      relativePath: 'src/use.ts',
      line: 1,
      column: 7,
      endLine: 1,
      endColumn: 12,
      preview: 'const greet = \"🙂\";'
    }])
  })
  const firstView = fixture.view()
  const secondView = fixture.view(`${TAB_ID}-second`)
  const secondHead = secondView.state.doc.length - 1
  await act(async () => {
    secondView.dispatch({ selection: { anchor: secondHead } })
    firstView.focus()
  })

  const result = await symbolCommand(fixture, 'go-to-definition', { line: 2, column: 16 })
  expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'src/use.ts', line: 1, column: 7 })
  expect(fixture.navigationCalls[0]?.params).toEqual({
    worktree: `id:${WORKTREE_ID}`,
    path: 'src/use.ts',
    line: 2,
    column: 16
  })
  expect(firstView.state.doc.sliceString(firstView.state.selection.main.from, firstView.state.selection.main.to)).toBe('greet')
  expect(secondView.state.selection.main.head).toBe(secondHead)
  expect(fixture.openCalls).toHaveLength(0)
  expect(fixture.saveCalls).toHaveLength(0)

  await waitUi()
  expect(fixture.viewWrites.some(({ params }) =>
    params.action === 'update' && typeof params.patch === 'object' && params.patch !== null &&
      'selection' in params.patch
  )).toBe(true)
})

test('references show the exact shared panel title and safe summary while local rows reveal in place', async () => {
  const fixture = await mountDocument({
    content: 'const greet = 1\\n',
    navigation: async () => navigationResult([{
      path: '/fixture/src/use.ts',
      relativePath: 'src/use.ts',
      line: 1,
      column: 7,
      endLine: 1,
      endColumn: 12,
      preview: 'const greet = 1'
    }])
  })
  await act(async () => fixture.view().focus())
  const result = await symbolCommand(fixture, 'find-references', { line: 1, column: 7 })
  expect(result).toEqual({ kind: 'references', status: 'list', count: 1, truncated: false })
  expect(fixture.container.querySelector('.qe-source-locations h2')?.textContent).toBe('References to greet')
  expect(fixture.container.querySelector('.qe-source-locations__count')?.textContent).toBe('1 results')
  expect(fixture.container.querySelector('.ui-list-row__title')?.textContent).toBe('src/use.ts:1:7')
  expect(fixture.container.querySelector('.ui-list-row__description')?.textContent).toBe('const greet = 1')
  expect(fixture.report().sourceSymbols).toEqual({
    status: 'list', kind: 'references', count: 1, truncated: false, error: null
  })
  expect(JSON.stringify(fixture.report().sourceSymbols)).not.toMatch(/src\/use|preview|const greet/)

  const symbols = fixture.address('source-symbols:')
  const beforeInvalid = fixture.navigationCalls.length
  for (const data of [
    { line: 0, column: 1 },
    { line: 1 },
    { line: 1, column: 7, extra: true },
    { line: 99, column: 1 }
  ]) {
    expect(await fixture.dispatch(symbols, 'definition', data)).toEqual({ result: { delivered: false } })
  }
  expect(fixture.navigationCalls).toHaveLength(beforeInvalid)

  const locations = fixture.address('source-locations:')
  expect(await fixture.dispatch(locations, 'open', { index: -1 })).toEqual({ result: { delivered: false } })
  expect(await fixture.dispatch(locations, 'open', { index: 0 })).toEqual({ result: { delivered: true } })
  expect(fixture.openCalls).toHaveLength(0)
  expect(fixture.container.querySelector('.qe-source-locations h2')?.textContent).toBe('References to greet')
  expect(fixture.view().state.doc.sliceString(fixture.view().state.selection.main.from, fixture.view().state.selection.main.to)).toBe('greet')
})
type RS_Call = { method: string; params: Record<string, unknown> }
type RS_Opened = { id: string; openedTabId: string; path: string; relativePath: string }
type RS_NavigationResult = {
  kind?: string
  status?: string
  path?: string
  line?: number
  column?: number
  count?: number
  truncated?: boolean
}
type RS_Handler = (args?: unknown) => unknown

type RS_Window = {
  client: RS_QuirkyClient
  connId: number
  calls: RS_Call[]
  handlers: Map<string, RS_Handler>
  context?: RS_UiPluginContext
  deactivate?: () => void
}
type RS_Mounted = {
  element: HTMLDivElement
  host: HTMLDivElement
  root: ReturnType<RS_UiRuntime['createRoot']>
  scope: ReturnType<RS_UiRuntime['createEditorUiControlReportScope']>
  runtime: RS_UiRuntime
  window: RS_Window
  bufferId: string
  tabId: string
  unmount(): Promise<void>
}
type RS_Fixture = {
  home: string
  root: string
  worktreeId: string
  harness: RS_Harness
  client: RS_QuirkyClient
  envRestore: () => void
  calls: RS_Call[]
  windows: RS_Window[]
  mounts: RS_Mounted[]
  cleaned: boolean
}

type RS_UiRuntime = Awaited<ReturnType<typeof RS_loadUiRuntime>>
let RS_uiRuntimePromise: Promise<RS_UiRuntime> | undefined
const RS_fixtures = new Set<RS_Fixture>()
const RS_EDITOR_SURFACE = 'view:quirky.editor/document'
const RS_CLI_ENTRY = RS_resolve(import.meta.dir, '../../../packages/cli/src/main.ts')

async function RS_loadUiRuntime() {
  const [{ createRoot }, { DocumentSurface }, controls, ui, { EditorView }] = await Promise.all([
    import('react-dom/client'),
    import('../src/window/DocumentSurface'),
    import('../src/window/uiControl'),
    import('../src/ui'),
    import('@codemirror/view')
  ])
  return {
    createRoot,
    DocumentSurface,
    EditorUiControlProvider: controls.EditorUiControlProvider,
    createEditorUiControlReportScope: controls.createEditorUiControlReportScope,
    activate: ui.activate,
    deactivate: ui.deactivate,
    findEditorView(node: HTMLElement) { return EditorView.findFromDOM(node) }
  }
}

async function RS_uiRuntime(): Promise<RS_UiRuntime> {
  RS_uiRuntimePromise ??= RS_loadUiRuntime()
  return await RS_uiRuntimePromise
}

const RS_call = <T = unknown>(fixture: RS_Fixture, method: string, params: Record<string, unknown> = {}): Promise<T> => {
  fixture.calls.push({ method, params })
  return fixture.client.callAny(method, params) as Promise<T>
}

function RS_calls(window: RS_Window, method: string): RS_Call[] {
  return window.calls.filter((call) => call.method === method)
}

async function RS_makeWindow(fixture: RS_Fixture): Promise<RS_Window> {
  const client = await fixture.harness.connect('ui')
  const identity = await client.callAny('ui.window.self', {}) as { connId: number }
  if (!Number.isSafeInteger(identity.connId) || identity.connId < 1) throw new Error('The UI client did not receive a real window connection ID.')
  const window: RS_Window = { client, connId: identity.connId, calls: [], handlers: new Map() }
  fixture.windows.push(window)
  await client.callAny('ui.window.view.open', {
    connId: window.connId,
    id: 'view:quirky.session/worktree',
    input: { worktree: fixture.worktreeId }
  })
  return window
}

async function RS_activateWindow(fixture: RS_Fixture, window: RS_Window): Promise<void> {
  const settings = await RS_call<Array<{ id: string; value: unknown }>>(fixture, 'setting.list', { pluginId: 'quirky.editor' })
  const settingValues = new Map(settings.map(({ id, value }) => [id.replace(/^setting:quirky\.editor\//, ''), value]))
  const context = {
    pluginId: 'quirky.editor',
    nativeBrowser: {},
    log() {},
    nativeDropPaths: async () => null,
    readClipboardText: async () => '',
    provide(id: string, handler: RS_Handler) { window.handlers.set(id, handler) },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      window.calls.push({ method, params })
      if (method === 'ui.window.command.run' && params.connId === window.connId) {
        const handler = window.handlers.get(String(params.id))
        if (!handler) throw new Error(`No activated handler for ${String(params.id)}.`)
        return { result: await handler(params.args) }
      }
      return await window.client.callAny(method, params)
    },
    subscribe: (listener: (event: unknown) => void) => window.client.onEvent((event) => { void listener(event) }),
    getSetting: (name: string) => settingValues.get(name),
    async executeCommand() {},
    createCommandDrag: () => 'unused-real-symbols-command-drag',
    consumeCommandDrag: () => null,
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    getLayout: () => ({ worktree: fixture.worktreeId, view: { id: 'view:quirky.session/worktree', input: { worktree: fixture.worktreeId } }, panel: null, sidebar: true, focus: 'view' }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: (listener: (state: string) => void) => window.client.onClose(() => listener('reconnecting')),
    async confirm() { return false },
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as RS_UiPluginContext
  const runtime = await RS_uiRuntime()
  window.context = context
  runtime.activate(context)
  window.deactivate = runtime.deactivate
}

async function RS_startFixture(language: 'ts' | 'py' = 'ts', windowCount = 1): Promise<RS_Fixture> {
  const envRestore = RS_isolateEditorTestEnvironment()
  const home = RS_makeHomeWithoutAutoHooks('quirky-g6-5-symbols-home-')
  const root = RS_join(home, 'workspace')
  let harness: RS_Harness | undefined
  let fixture: RS_Fixture | undefined
  try {
    RS_cpSync(RS_resolve(import.meta.dir, `../../quirky.navigation/test/fixtures/${language}`), root, { recursive: true })
    harness = await RS_startHarness({ home, builtinPluginsDir: RS_builtinsDir() })
    const client = await harness.connect('cli', 'editor-g6-5-real-symbols-test')
    await client.callAny('quirky.repo/add', { path: root, folder: true })
    const worktree = await client.callAny('quirky.worktree/resolve', { selector: `path:${root}` }) as { id: string }
    fixture = { home, root, worktreeId: worktree.id, harness, client, envRestore, calls: [], windows: [], mounts: [], cleaned: false }
    RS_fixtures.add(fixture)
    for (let index = 0; index < windowCount; index++) await RS_makeWindow(fixture)
    return fixture
  } catch (error) {
    if (fixture) {
      RS_fixtures.delete(fixture)
      await RS_cleanupFixture(fixture)
    } else {
      try { await harness?.cleanup() } finally {
        RS_rmSync(root, { recursive: true, force: true })
        RS_rmSync(home, { recursive: true, force: true })
        envRestore()
      }
    }
    throw error
  }
}

async function RS_cleanupFixture(fixture: RS_Fixture): Promise<void> {
  if (fixture.cleaned) return
  fixture.cleaned = true
  RS_fixtures.delete(fixture)
  const failures: unknown[] = []
  try { await RS_call(fixture, 'quirky.navigation/stop', {}) } catch (error) { failures.push(error) }
  try {
    const status = await RS_call<{ servers: unknown[] }>(fixture, 'quirky.navigation/status', {})
    RS_expect(status.servers).toEqual([])
  } catch (error) {
    failures.push(error)
  }
  for (const mount of fixture.mounts.splice(0).reverse()) {
    try { await mount.unmount() } catch (error) { failures.push(error) }
  }
  for (const window of fixture.windows) {
    try { window.deactivate?.() } catch (error) { failures.push(error) }
  }
  try { await fixture.harness.cleanup() } catch (error) { failures.push(error) }
  try { RS_rmSync(fixture.root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  try { RS_rmSync(fixture.home, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  try { fixture.envRestore() } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, 'Real source-symbols fixture cleanup failed')
}


async function RS_openDocument(fixture: RS_Fixture, window: RS_Window, path: string): Promise<RS_Opened> {
  return await RS_call<RS_Opened>(fixture, 'quirky.editor/open', {
    worktree: fixture.worktreeId,
    path,
    mode: 'source',
    focus: true,
    window: window.connId
  })
}
async function RS_mountOpenedPath(fixture: RS_Fixture, window: RS_Window, path: string): Promise<RS_Mounted> {
  const state = await RS_call<{
    buffers: Array<{ id: string; relativePath: string }>
    tabs: Array<{ tabId: string; bufferId: string; mode: 'edit' | 'preview' }>
  }>(fixture, 'quirky.editor/state', { worktree: fixture.worktreeId })
  const buffer = state.buffers.find((entry) => entry.relativePath === path)
  if (!buffer) throw new Error(`The real editor state has no buffer for ${path}.`)
  const tab = state.tabs.find((entry) => entry.bufferId === buffer.id && entry.mode === 'edit')
  if (!tab) throw new Error(`The real editor state has no editable tab for ${path}.`)
  return await RS_mountDocument(fixture, window, buffer.id, tab.tabId)
}

async function RS_mountDocument(fixture: RS_Fixture, window: RS_Window, bufferId: string, tabId: string): Promise<RS_Mounted> {
  const runtime = await RS_uiRuntime()
  const group = document.createElement('div')
  group.className = 'qt-group qt-active'
  const host = document.createElement('div')
  host.className = 'qt-hosted-view'
  host.dataset.hostedView = tabId
  const element = document.createElement('div')
  host.append(element)
  group.append(host)
  document.body.append(group)
  const root = runtime.createRoot(element)
  const scope = runtime.createEditorUiControlReportScope(undefined, { surface: RS_EDITOR_SURFACE, context: window.context! })
  const mounted: RS_Mounted = {
    element,
    host,
    root,
    scope,
    runtime,
    window,
    bufferId,
    tabId,
    async unmount() {
      try {
        await RS_act(async () => { root.unmount() })
      } finally {
        scope.dispose()
        group.remove()
      }
    }
  }
  fixture.mounts.push(mounted)
  await RS_act(async () => {
    root.render(
      <runtime.EditorUiControlProvider scope={scope}>
        <runtime.DocumentSurface context={window.context!} input={{ bufferId, tabId, mode: 'source' }} />
      </runtime.EditorUiControlProvider>
    )
  })
  await RS_waitForAsync(() => element.querySelector<HTMLElement>('.cm-editor') ?? undefined, 10_000)
  return mounted
}
function RS_view(mounted: RS_Mounted) {
  const editor = mounted.element.querySelector<HTMLElement>('.cm-editor')
  if (!editor) throw new Error('DocumentSurface did not render a CodeMirror editor.')
  const view = mounted.runtime.findEditorView(editor)
  if (!view) throw new Error('The mounted source editor has no CodeMirror view.')
  return view
}


function RS_position(view: { state: { doc: { line(number: number): { from: number } } } }, line: number, column: number): number {
  return view.state.doc.line(line).from + column - 1
}

async function RS_setCaret(mounted: RS_Mounted, line: number, column: number): Promise<void> {
  const view = RS_view(mounted)
  const position = RS_position(view, line, column)
  await RS_act(async () => {
    view.dispatch({ selection: { anchor: position } })
    view.focus()
  })
}

async function RS_invokeHandler(window: RS_Window, id: string, args?: unknown): Promise<unknown> {
  const handler = window.handlers.get(id)
  if (!handler) throw new Error(`Activation did not provide ${id}.`)
  let result: unknown
  let failure: unknown
  await RS_act(async () => {
    try { result = args === undefined ? await handler() : await handler(args) }
    catch (error) { failure = error }
  })
  if (failure !== undefined) throw failure
  return result
}

function RS_rows(mounted: RS_Mounted): { panel: HTMLElement; rows: { title: string; preview: string }[] } {
  const panel = mounted.element.querySelector<HTMLElement>('.qe-source-locations')
  if (!panel) throw new Error('The source locations panel is not mounted.')
  const rows = [...panel.querySelectorAll<HTMLElement>('.ui-list-row')].map((row) => ({
    title: row.querySelector('.ui-list-row__title')?.textContent ?? '',
    preview: row.querySelector('.ui-list-row__description')?.textContent ?? ''
  }))
  return { panel, rows }
}

async function RS_runCli(fixture: RS_Fixture, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, RS_CLI_ENTRY, '--json', ...args], {
    cwd: fixture.root,
    env: { ...process.env, HOME: fixture.home, QUIRKY_HOME: fixture.home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const deadline = setTimeout(() => child.kill(), 20_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(deadline)
  }
}

RS_test('real daemon: TypeScript F12 jumps to the disk definition and selects greet', async () => {
  const fixture = await RS_startFixture('ts')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'src/use.ts')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  await RS_setCaret(source, 4, 27)

  const result = await RS_invokeHandler(window, 'command:quirky.editor/go-to-definition') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'src/greet.ts', line: 3, column: 17 })
  RS_expect(RS_calls(window, 'quirky.navigation/definition').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'src/use.ts', line: 4, column: 27
  }])
  RS_expect(RS_calls(window, 'quirky.editor/open').map(({ params }) => params)).toEqual([{
    worktree: fixture.worktreeId,
    path: 'src/greet.ts',
    mode: 'source',
    line: 3,
    column: 17,
    matchLength: 5,
    window: window.connId
  }])
  RS_expect(source.element.querySelector('.qe-source-locations')).toBeNull()

  const mountedDestination = await RS_mountOpenedPath(fixture, window, 'src/greet.ts')
  const view = RS_view(mountedDestination)
  const start = RS_position(view, 3, 17)
  RS_expect(view.state.selection.main.from).toBe(start)
  RS_expect(view.state.selection.main.to).toBe(start + 5)
  RS_expect(view.state.doc.sliceString(start, start + 5)).toBe('greet')
}, 60_000)

RS_test('real daemon: Python F12 jumps to pkg/mod.py and selects greet', async () => {
  const fixture = await RS_startFixture('py')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'main.py')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  await RS_setCaret(source, 5, 21)

  const result = await RS_invokeHandler(window, 'command:quirky.editor/go-to-definition') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'pkg/mod.py', line: 4, column: 5 })
  RS_expect(RS_calls(window, 'quirky.navigation/definition').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'main.py', line: 5, column: 21
  }])
  RS_expect(RS_calls(window, 'quirky.editor/open').map(({ params }) => params)).toEqual([{
    worktree: fixture.worktreeId,
    path: 'pkg/mod.py',
    mode: 'source',
    line: 4,
    column: 5,
    matchLength: 5,
    window: window.connId
  }])
  RS_expect(source.element.querySelector('.qe-source-locations')).toBeNull()

  const destination = await RS_mountOpenedPath(fixture, window, 'pkg/mod.py')
  const view = RS_view(destination)
  const start = RS_position(view, 4, 5)
  RS_expect(view.state.doc.sliceString(start, start + 5)).toBe('greet')
  RS_expect(view.state.selection.main.from).toBe(start)
  RS_expect(view.state.selection.main.to).toBe(start + 5)
}, 60_000)

RS_test('real daemon: TypeScript Shift-F12 renders ordered reference previews and Enter opens row two', async () => {
  const fixture = await RS_startFixture('ts')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'src/use.ts')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  await RS_setCaret(source, 4, 27)

  const result = await RS_invokeHandler(window, 'command:quirky.editor/find-references') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'references', status: 'list', count: 6, truncated: false })
  RS_expect(RS_calls(window, 'quirky.navigation/references').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'src/use.ts', line: 4, column: 27
  }])
  let { panel, rows } = RS_rows(source)
  RS_expect(panel.textContent).toContain('References to greet')
  RS_expect(panel.textContent).toContain('6 results')
  RS_expect(rows).toEqual([
    { title: 'src/greet.ts:3:17', preview: 'export function greet(name: Name): string {' },
    { title: 'src/greet.ts:11:30', preview: '    return `${this.prefix} ${greet(name)}`' },
    { title: 'src/index.ts:1:10', preview: "export { greet, Greeter } from './greet'" },
    { title: 'src/use.ts:1:10', preview: "import { greet, Greeter, type Name } from './index'" },
    { title: 'src/use.ts:4:27', preview: "const label = 'héllo 🙂'; greet(who)" },
    { title: 'src/use.ts:7:23', preview: 'export const twice = [greet(label), greeter.hello(label)]' }
  ])

  let buttons = [...panel.querySelectorAll<HTMLButtonElement>('button.ui-list-row__main')]
  RS_expect(buttons).toHaveLength(6)
  RS_expect(document.activeElement).toBe(buttons[0])
  await RS_act(async () => {
    buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  RS_expect(document.activeElement).toBe(buttons[1])
  await RS_act(async () => {
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    buttons[1]!.dispatchEvent(enter)
    // Happy DOM does not synthesize a native button activation for Enter; model that browser default.
    if (!enter.defaultPrevented) buttons[1]!.click()
  })
  await RS_act(async () => { await RS_waitForAsync(() => RS_calls(window, 'quirky.editor/open').length === 1, 10_000) })
  RS_expect(RS_calls(window, 'quirky.editor/open').map(({ params }) => params)).toEqual([{
    worktree: fixture.worktreeId,
    path: 'src/greet.ts',
    mode: 'source',
    line: 11,
    column: 30,
    matchLength: 5,
    window: window.connId
  }])
  ;({ panel, rows } = RS_rows(source))
  RS_expect(panel.textContent).toContain('References to greet')
  RS_expect(panel.textContent).toContain('6 results')
  RS_expect(rows).toHaveLength(6)
}, 60_000)

RS_test('real daemon: Python Shift-F12 renders all six exact references and previews', async () => {
  const fixture = await RS_startFixture('py')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'main.py')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  await RS_setCaret(source, 5, 21)

  const result = await RS_invokeHandler(window, 'command:quirky.editor/find-references') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'references', status: 'list', count: 6, truncated: false })
  RS_expect(RS_calls(window, 'quirky.navigation/references').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'main.py', line: 5, column: 21
  }])
  const { panel, rows } = RS_rows(source)
  RS_expect(panel.textContent).toContain('References to greet')
  RS_expect(panel.textContent).toContain('6 results')
  RS_expect(rows).toEqual([
    { title: 'main.py:2:17', preview: 'from pkg import greet' },
    { title: 'main.py:5:21', preview: 'label = "héllo 🙂"; greet(label)' },
    { title: 'main.py:8:9', preview: 'print(m.greet(label), m.Greeter("yo").hello(label))' },
    { title: 'pkg/__init__.py:1:18', preview: 'from .mod import greet' },
    { title: 'pkg/mod.py:4:5', preview: 'def greet(name):' },
    { title: 'pkg/mod.py:13:36', preview: '        return self.prefix + " " + greet(name)' }
  ])
}, 60_000)

RS_test('real daemon: dirty TypeScript is refused without navigation or save, then saved text navigates', async () => {
  const fixture = await RS_startFixture('ts')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'src/use.ts')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  const view = RS_view(source)
  const original = RS_readFileSync(RS_join(fixture.root, 'src/use.ts'), 'utf8')
  await RS_setCaret(source, 4, 33)
  await RS_act(async () => { view.dispatch({ changes: { from: 0, insert: 'x' } }) })
  RS_expect(view.state.doc.sliceString(view.state.selection.main.head, view.state.selection.main.head + 3)).toBe('who')
  await RS_waitForAsync(async () => {
    const response = await RS_call<{ buffer?: { draft?: string | null } }>(fixture, 'quirky.editor/read', { bufferId: opened.id, action: 'buffer' })
    return typeof response.buffer?.draft === 'string' ? response.buffer : undefined
  }, 10_000)

  await RS_expect(RS_invokeHandler(window, 'command:quirky.editor/go-to-definition'))
    .rejects.toThrow('Save this file first. Navigation reads files from disk, and this one has unsaved changes.')
  RS_expect(source.element.textContent).toContain('Save this file first. Navigation reads files from disk, and this one has unsaved changes.')
  RS_expect(window.calls.filter(({ method }) => method.startsWith('quirky.navigation/'))).toEqual([])
  RS_expect(RS_calls(window, 'quirky.editor/save')).toEqual([])
  RS_expect(RS_readFileSync(RS_join(fixture.root, 'src/use.ts'), 'utf8')).toBe(original)

  await RS_invokeHandler(window, 'command:quirky.editor/save')
  RS_expect(RS_calls(window, 'quirky.editor/save')).toHaveLength(1)
  RS_expect(RS_readFileSync(RS_join(fixture.root, 'src/use.ts'), 'utf8')).toBe(`x${original}`)
  const result = await RS_invokeHandler(window, 'command:quirky.editor/go-to-definition') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'src/use.ts', line: 3, column: 7 })
  RS_expect(RS_calls(window, 'quirky.navigation/definition').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'src/use.ts', line: 4, column: 33
  }])
  RS_expect(RS_calls(window, 'quirky.editor/open')).toEqual([])
  const target = RS_position(view, 3, 7)
  RS_expect(view.state.selection.main.from).toBe(target)
  RS_expect(view.state.doc.sliceString(target, target + 3)).toBe('who')
}, 60_000)

RS_test('real daemon: one TypeScript worktree open targets c2 and leaves c1 layout and navigation history unchanged', async () => {
  const fixture = await RS_startFixture('ts', 2)
  const [c1, c2] = fixture.windows
  await RS_activateWindow(fixture, c2!)
  const opened = await RS_openDocument(fixture, c2!, 'src/use.ts')
  const source = await RS_mountDocument(fixture, c2!, opened.id, opened.openedTabId)
  await RS_setCaret(source, 4, 27)
  const layoutBefore = await RS_call<Record<string, unknown>>(fixture, 'ui.window.state', { connId: c1!.connId })
  const historyBefore = await RS_call<Record<string, unknown>>(fixture, 'quirky.worktree/navigationState', { window: c1!.connId })

  const result = await RS_invokeHandler(c2!, 'command:quirky.editor/go-to-definition') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'src/greet.ts', line: 3, column: 17 })
  RS_expect(RS_calls(c2!, 'quirky.editor/open').map(({ params }) => params)).toEqual([{
    worktree: fixture.worktreeId,
    path: 'src/greet.ts',
    mode: 'source',
    line: 3,
    column: 17,
    matchLength: 5,
    window: c2!.connId
  }])
  RS_expect(await RS_call<Record<string, unknown>>(fixture, 'ui.window.state', { connId: c1!.connId })).toEqual(layoutBefore)
  RS_expect(await RS_call<Record<string, unknown>>(fixture, 'quirky.worktree/navigationState', { window: c1!.connId })).toEqual(historyBefore)
}, 60_000)

RS_test('real daemon: local who definition reveals in the initiating view without quirky.editor/open', async () => {
  const fixture = await RS_startFixture('ts')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'src/use.ts')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  await RS_setCaret(source, 4, 33)

  const result = await RS_invokeHandler(window, 'command:quirky.editor/go-to-definition') as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'src/use.ts', line: 3, column: 7 })
  RS_expect(RS_calls(window, 'quirky.navigation/definition').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'src/use.ts', line: 4, column: 33
  }])
  RS_expect(RS_calls(window, 'quirky.editor/open')).toEqual([])
  const view = RS_view(source)
  const target = RS_position(view, 3, 7)
  RS_expect(view.state.selection.main.from).toBe(target)
  RS_expect(view.state.selection.main.to).toBe(target + 3)
  RS_expect(view.state.doc.sliceString(target, target + 3)).toBe('who')
  const persisted = await RS_waitForAsync(async () => {
    const response = await RS_call<{
      buffer?: { view?: { byTabId?: Record<string, { selection?: { anchor: number; head: number } }> } }
    }>(fixture, 'quirky.editor/read', { bufferId: opened.id, action: 'buffer' })
    const tabView = response.buffer?.view?.byTabId?.[opened.openedTabId]
    return tabView?.selection?.head === target + 3 ? tabView : undefined
  }, 10_000)
  RS_expect(persisted.selection).toEqual({ anchor: target, head: target + 3 })
}, 60_000)

RS_test('real daemon: explicit command coordinates override the caret position', async () => {
  const fixture = await RS_startFixture('ts')
  const window = fixture.windows[0]!
  await RS_activateWindow(fixture, window)
  const opened = await RS_openDocument(fixture, window, 'src/use.ts')
  const source = await RS_mountDocument(fixture, window, opened.id, opened.openedTabId)
  await RS_setCaret(source, 4, 33)

  const result = await RS_invokeHandler(window, 'command:quirky.editor/go-to-definition', { line: 4, column: 27 }) as RS_NavigationResult
  RS_expect(result).toEqual({ kind: 'definition', status: 'opened', path: 'src/greet.ts', line: 3, column: 17 })
  RS_expect(RS_calls(window, 'quirky.navigation/definition').map(({ params }) => params)).toEqual([{
    worktree: `id:${fixture.worktreeId}`, path: 'src/use.ts', line: 4, column: 27
  }])
  RS_expect(RS_calls(window, 'quirky.editor/open').map(({ params }) => params)).toEqual([{
    worktree: fixture.worktreeId,
    path: 'src/greet.ts',
    mode: 'source',
    line: 3,
    column: 17,
    matchLength: 5,
    window: window.connId
  }])
}, 60_000)

RS_test('real daemon and manifest: API methods route to ui.command.run and CLI help exposes source coordinates', async () => {
  const fixture = await RS_startFixture('ts', 0)
  for (const method of ['quirky.editor/go-to-definition', 'quirky.editor/find-references']) {
    await RS_expect(RS_call(fixture, method, { line: 4, column: 27 }))
      .rejects.toThrow('no Quirky window is open')
  }

  const manifest = JSON.parse(RS_readFileSync(RS_resolve(import.meta.dir, '../quirky-plugin.json'), 'utf8')) as {
    contributes: {
      command: Array<{ id: string; title: string; args?: Record<string, unknown> }>
      keybinding: Array<{ id: string; key: string; command: string; when: string }>
      method: Array<{ id: string }>
      'cli-command': Array<{ id: string; words: string; method: string }>
    }
  }
  for (const [id, title, key, method] of [
    ['go-to-definition', 'Go to Definition', 'f12', 'go-to-definition'],
    ['find-references', 'Find References', 'shift+f12', 'find-references']
  ] as const) {
    const command = manifest.contributes.command.find((entry) => entry.id === id)
    RS_expect(command).toMatchObject({
      id,
      title,
      args: {
        type: 'object',
        properties: { line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 } },
        additionalProperties: false
      }
    })
    const keybinding = manifest.contributes.keybinding.find((entry) => entry.id === id)
    RS_expect(keybinding).toMatchObject({ id, key, command: id, when: 'editorFocus' })
    RS_expect(manifest.contributes.method.some((entry) => entry.id === method)).toBe(true)
    RS_expect(manifest.contributes['cli-command'].find((entry) => entry.id === id)).toMatchObject({ id, words: id, method })
  }
  RS_expect(RS_parseChord('f12')).toEqual({ ok: true, chord: 'f12' })
  RS_expect(RS_parseChord('shift+f12')).toEqual({ ok: true, chord: 'shift+f12' })
  RS_expect(RS_chordFromKeyEvent({ key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe('f12')
  RS_expect(RS_chordFromKeyEvent({ key: 'F12', code: 'F12', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe('shift+f12')

  const definitionHelp = await RS_runCli(fixture, ['editor', 'go-to-definition', '--help'])
  const referencesHelp = await RS_runCli(fixture, ['editor', 'find-references', '--help'])
  for (const help of [definitionHelp, referencesHelp]) {
    RS_expect(help.code).toBe(0)
    RS_expect(help.stdout).toContain('--line')
    RS_expect(help.stdout).toContain('--column')
    RS_expect(help.stdout).toContain('--json')
  }
}, 60_000)
const SYMBOL_TEXT = readFileSync(new URL('../../quirky.navigation/test/fixtures/ts/src/use.ts', import.meta.url), 'utf8')
const SAVED_FIRST = 'Save this file first. Navigation reads files from disk, and this one has unsaved changes.'
const symbolLocation = (relativePath: string | null = 'src/greet.ts', line = 3, column = 17) => ({
  path: `/fixture/${relativePath ?? 'outside/lib.ts'}`, relativePath, line, column,
  endLine: line, endColumn: column + 5, preview: 'export function greet(name: Name): string {'
})
const symbolAnswer = (locations = [symbolLocation()], truncated = false, worktreeId = WORKTREE_ID): NavigationResult => ({
  worktreeId, language: 'typescript', locations, truncated
})
async function symbolCommand(surface: MountedDocument, kind: 'go-to-definition' | 'find-references' = 'go-to-definition', args: Record<string, unknown> = { line: 4, column: 27 }): Promise<unknown> {
  let result: unknown
  let failure: unknown
  await act(async () => {
    surface.view().focus()
    try { result = await surface.command(kind, args) }
    catch (error) { failure = error }
  })
  if (failure !== undefined) throw failure
  return result
}
async function beginSymbolCommand(surface: MountedDocument, kind: 'go-to-definition' | 'find-references' = 'go-to-definition'): Promise<{ outcome: Promise<unknown> }> {
  let outcome!: Promise<unknown>
  await act(async () => {
    surface.view().focus()
    outcome = surface.command(kind, { line: 4, column: 27 }).catch((error: unknown) => error)
  })
  return { outcome }
}


test.each(['go-to-definition', 'find-references'] as const)('%s distinguishes empty results from errors and redacts reports', async (kind) => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => symbolAnswer([]) })
  expect(await symbolCommand(surface, kind, { line: 2, column: 1 })).toEqual({ kind: kind === 'go-to-definition' ? 'definition' : 'references', status: 'empty' })
  expect(surface.container.textContent).toContain(`No ${kind === 'go-to-definition' ? 'definition' : 'references'} found at line 2, column 1.`)
  expect(surface.report().sourceSymbols).toEqual({ status: 'empty', kind: kind === 'go-to-definition' ? 'definition' : 'references', count: 0, truncated: false, error: null })
  expect(surface.openCalls).toEqual([])
})

test('multiple definitions stay listed until a row is opened, outside locations stay disabled, and generations rotate', async () => {
  let answer = symbolAnswer([symbolLocation(), symbolLocation('src/second.ts', 8, 2)])
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => answer })
  expect(await symbolCommand(surface)).toEqual({ kind: 'definition', status: 'list', count: 2, truncated: false })
  expect(surface.container.textContent).toContain('Definitions of greet')
  const address = surface.address('source-locations:')
  expect(surface.openCalls).toEqual([])
  expect(await surface.dispatch(address, 'open', { index: 1 })).toEqual({ result: { delivered: true } })
  await tickUi()
  expect(surface.openCalls[0]?.params).toEqual({ worktree: WORKTREE_ID, path: 'src/second.ts', mode: 'source', line: 8, column: 2, matchLength: 5, window: 22 })
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
  answer = symbolAnswer([symbolLocation(null)])
  expect(await symbolCommand(surface)).toEqual({ kind: 'definition', status: 'list', count: 1, truncated: false })
  expect(surface.container.textContent).toContain('Outside this worktree')
  const next = surface.address('source-locations:')
  expect(next.generation).not.toBe(address.generation)
  expect(next.actions).toEqual(['close'])
  expect(await surface.dispatch(next, 'open', { index: 0 })).toEqual({ result: { delivered: false } })
  expect(await surface.dispatch(address, 'close')).toEqual({ result: { delivered: false } })
})

test('truncated references retain all rows, previews, and their panel after a jump', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => symbolAnswer(Array.from({ length: 1000 }, (_, index) => symbolLocation(`src/${index}.ts`)), true) })
  expect(await symbolCommand(surface, 'find-references')).toEqual({ kind: 'references', status: 'list', count: 1000, truncated: true })
  expect(surface.container.querySelectorAll('.ui-list-row')).toHaveLength(1000)
  expect(surface.container.textContent).toContain('Showing the first 1,000 results. Navigation found more.')
  expect(surface.container.querySelector('.ui-list-row__description')?.textContent).toBe('export function greet(name: Name): string {')
  expect(await surface.dispatch(surface.address('source-locations:'), 'open', { index: 0 })).toEqual({ result: { delivered: true } })
  await tickUi()
  expect(surface.container.querySelectorAll('.ui-list-row')).toHaveLength(1000)
  expect(surface.report().sourceSymbols).toEqual({ status: 'list', kind: 'references', count: 1000, truncated: true, error: null })
})

test.each([
  { draft: 'changed', message: SAVED_FIRST },
  { untitled: true, message: SAVED_FIRST },
  { external: 'changed' as const, message: 'This file changed on disk. Reload or save it before navigating.' },
  { external: 'deleted' as const, message: "This file was deleted on disk, so navigation can't read it." }
])('disk-only navigation refuses $message without saving', async ({ message, ...options }) => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, ...options })
  await expect(symbolCommand(surface)).rejects.toThrow(message)
  expect(surface.container.textContent).toContain(message)
  expect(surface.container.textContent).not.toContain('Retry')
  expect(surface.navigationCalls).toEqual([])
  expect(surface.saveCalls).toEqual([])
})

test('unsupported source has no symbol address or panel', async () => {
  const surface = await mountDocument({ relativePath: 'README.md', content: SYMBOL_TEXT })
  expect(surface.report().uiControls?.some(({ target }) => target.startsWith('source-symbols:'))).toBe(false)
  await expect(symbolCommand(surface)).rejects.toThrow('Go to Definition and Find References work in TypeScript, JavaScript and Python files.')
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
  expect(surface.navigationCalls).toEqual([])
})

test('server failure offers an identical-parameter retry that clears its error', async () => {
  let attempts = 0
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => {
    if (attempts++ === 0) throw new Error('TypeScript is not available for this worktree.')
    return symbolAnswer()
  } })
  await expect(symbolCommand(surface)).rejects.toThrow('Go to Definition failed: TypeScript is not available for this worktree.')
  const address = surface.address('source-locations:')
  expect(address.actions).toContain('retry')
  expect(await surface.dispatch(address, 'retry')).toEqual({ result: { delivered: true } })
  await tickUi()
  expect(surface.navigationCalls[1]?.params).toEqual(surface.navigationCalls[0]?.params)
  expect(surface.openCalls).toHaveLength(1)
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
})

test.each(['definition', 'references'] as const)('%s pending state reports immediately and close fences its answer', async (kind) => {
  const deferred = Promise.withResolvers<NavigationResult>()
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => deferred.promise })
  const { outcome } = await beginSymbolCommand(surface, kind === 'definition' ? 'go-to-definition' : 'find-references')
  expect(surface.report().sourceSymbols?.status).toBe('pending')
  if (kind === 'definition') {
    expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 310)) })
  }
  expect(surface.container.textContent).toContain(kind === 'definition' ? 'Finding definitions…' : 'Finding references…')
  expect(await surface.dispatch(surface.address('source-locations:'), 'close')).toEqual({ result: { delivered: true } })
  expect(await outcome).toMatchObject({ message: 'The lookup was closed before it finished.' })
  await act(async () => { deferred.resolve(symbolAnswer()); await deferred.promise })
  expect(surface.openCalls).toEqual([])
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
})

test.each(['edit', 'replace', 'unmount', 'external', 'worktree'] as const)('a pending lookup fences %s before completion', async (change) => {
  const deferred = Promise.withResolvers<NavigationResult>()
  let attempts = 0
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => attempts++ === 0 ? deferred.promise : symbolAnswer([]) })
  const { outcome } = await beginSymbolCommand(surface)
  if (change === 'edit') await act(async () => { surface.view().dispatch({ changes: { from: 0, insert: 'x' } }) })
  if (change === 'replace') await symbolCommand(surface, 'find-references')
  if (change === 'unmount') await surface.unmount()
  if (change === 'external') await act(async () => { surface.updateBuffer({ external: 'changed' }); await new Promise((resolve) => setTimeout(resolve, 0)) })
  await act(async () => { deferred.resolve(symbolAnswer([symbolLocation()], false, change === 'worktree' ? 'wrong-worktree' : WORKTREE_ID)); await deferred.promise })
  const result = await outcome
  if (change === 'edit') expect(result).toMatchObject({ message: 'The document changed before the lookup finished.' })
  if (change === 'replace') expect(result).toMatchObject({ message: 'A newer lookup replaced this one.' })
  if (change === 'external') expect(surface.container.textContent).toContain('This file changed on disk. Reload or save it before navigating.')
  if (change === 'worktree') expect(result).toMatchObject({ message: 'Navigation answered for a different worktree.' })
  expect(surface.openCalls).toEqual([])
  if (change !== 'external' && change !== 'worktree' && change !== 'replace') expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
})

test.each([() => { throw new Error('offline') }, () => ({}), () => ({ connId: 0 })])('window identity failure refuses a cross-file jump', async (windowSelf) => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, windowSelf, navigation: () => symbolAnswer() })
  await expect(symbolCommand(surface)).rejects.toThrow('The daemon did not identify this window.')
  expect(surface.container.textContent).toContain('The daemon did not identify this window.')
  expect(surface.openCalls).toEqual([])
})

test('closing a lookup while window identity resolves prevents an open', async () => {
  const identity = Promise.withResolvers<unknown>()
  const surface = await mountDocument({ content: SYMBOL_TEXT, windowSelf: () => identity.promise, navigation: () => symbolAnswer() })
  const { outcome } = await beginSymbolCommand(surface)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 310)) })
  await surface.dispatch(surface.address('source-locations:'), 'close')
  await act(async () => { identity.resolve({ connId: 22 }); await identity.promise })
  expect(await outcome).toMatchObject({ message: 'The lookup was closed before it finished.' })
  expect(surface.openCalls).toEqual([])
})

test('addressed symbols reject malformed positions and stale controls without effects', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => symbolAnswer([symbolLocation(), symbolLocation('src/second.ts')]) })
  const address = surface.address('source-symbols:')
  expect(address.target).toBe(`source-symbols:${JSON.stringify([BUFFER_ID, TAB_ID])}`)
  expect(address.actions).toEqual(['definition', 'references'])
  for (const data of [{ line: 0, column: 1 }, { line: 1.5, column: 1 }, { line: '4', column: 1 }, { line: 999, column: 1 }, { line: 1, column: 0 }, { line: 2, column: 2 }, { line: 4 }, { column: 27 }, { line: 4, column: 27, extra: true }]) {
    expect(await surface.dispatch(address, 'definition', data)).toEqual({ result: { delivered: false } })
  }
  expect(await surface.dispatch({ ...address, generation: 'stale' }, 'definition', { line: 4, column: 27 })).toEqual({ result: { delivered: false } })
  expect(await surface.dispatch(address, 'unknown')).toEqual({ result: { delivered: false } })
  expect(surface.navigationCalls).toEqual([])
  expect(await surface.dispatch(address, 'definition', { line: 4, column: 27 })).toEqual({ result: { delivered: true } })
  await tickUi()
  const results = surface.address('source-locations:')
  for (const index of [-1, 1.5, '0', 2]) expect(await surface.dispatch(results, 'open', { index })).toEqual({ result: { delivered: false } })
  expect(surface.openCalls).toEqual([])
})

test('unacknowledged edits and competing drafts refuse disk navigation without saving', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT })
  let failure: unknown
  await act(async () => {
    surface.view().focus()
    surface.view().dispatch({ changes: { from: 0, insert: 'x' } })
    try { await surface.command('go-to-definition', { line: 4, column: 27 }) } catch (error) { failure = error }
  })
  expect(failure).toMatchObject({ message: SAVED_FIRST })
  expect(surface.container.textContent).toContain(SAVED_FIRST)
  await act(async () => {
    surface.updateBuffer({ draft: 'competing draft', contentRevision: 99, revision: 99 })
  })
  await tickUi()
  await expect(symbolCommand(surface)).rejects.toThrow(SAVED_FIRST)
  expect(surface.view().state.doc.toString()).toBe(`x${SYMBOL_TEXT}`)
  expect(surface.navigationCalls).toEqual([])
  expect(surface.saveCalls).toEqual([])
})

test('direct symbol commands validate coordinate pairs without starting navigation', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT })
  for (const args of [{ line: 4 }, { column: 27 }, { line: 4, column: '27' }, { line: 4, column: 27, extra: true }]) {
    await expect(symbolCommand(surface, 'go-to-definition', args)).rejects.toThrow('Line and column must be supplied together as positive integers.')
  }
  expect(surface.navigationCalls).toEqual([])
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
})

test('a clean CRLF source remains navigable in normalized editor coordinates', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT.replaceAll('\n', '\r\n'), navigation: () => symbolAnswer([]) })
  expect(await symbolCommand(surface)).toEqual({ kind: 'definition', status: 'empty' })
  expect(surface.navigationCalls[0]?.params).toEqual({ worktree: `id:${WORKTREE_ID}`, path: 'src/use.ts', line: 4, column: 27 })
})

test('the happy-DOM modifier handler uses the activated UI-control bridge without changing selection', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => symbolAnswer([]) })
  const view = surface.view()
  const position = view.state.doc.line(4).from + 26
  Object.defineProperty(view, 'posAtCoords', { configurable: true, value: () => position })
  const selection = view.state.selection.toJSON()
  await act(async () => {
    view.contentDOM.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0,
      metaKey: CHORD_PLATFORM === 'darwin', ctrlKey: CHORD_PLATFORM !== 'darwin'
    }))
  })
  await tickUi()
  expect(surface.navigationCalls.map(({ params }) => params)).toEqual([{ worktree: `id:${WORKTREE_ID}`, path: 'src/use.ts', line: 4, column: 27 }])
  expect(surface.calls).toContainEqual(expect.objectContaining({ method: 'ui.window.command.run', params: expect.objectContaining({
    id: 'command:quirky.editor/ui-control', args: expect.objectContaining({ action: 'definition', data: { line: 4, column: 27 } })
  }) }))
  expect(view.state.selection.toJSON()).toEqual(selection)
})

test('opening Changes detaches a pending lookup and exposes no symbol controls', async () => {
  const deferred = Promise.withResolvers<NavigationResult>()
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => deferred.promise })
  await act(async () => { surface.updateBuffer({ baseline: SYMBOL_TEXT, revision: 2 }) })
  await tickUi()
  const { outcome } = await beginSymbolCommand(surface)
  const owner = activeDocument()!
  expect(await surface.dispatch(surface.address('document:'), 'changes', { open: true })).toEqual({ result: { delivered: true } })
  await act(async () => { deferred.resolve(symbolAnswer()); await deferred.promise })
  await outcome
  expect(surface.openCalls).toEqual([])
  expect(surface.report().uiControls?.some(({ target }) => target.startsWith('source-symbols:'))).toBe(false)
  expect(surface.report().sourceSymbols).toEqual({ status: 'idle', kind: null, count: null, truncated: null, error: null })
  await expect(owner.runCommand('go-to-definition')).rejects.toThrow('Go to Definition and Find References work in the source editor.')
})

test('an engine replacement rotates symbol controls and drops its pending completion', async () => {
  const deferred = Promise.withResolvers<NavigationResult>()
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => deferred.promise })
  const ref = createRef<SourceEditorHandle>()
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let report: UiReport = {}
  const scope = createEditorUiControlReportScope((value) => { report = value as UiReport }, { surface: 'view:quirky.editor/document', context: surface.context })
  const buffer: EditorSurfaceBuffer = { ...makeBufferInfo({ content: SYMBOL_TEXT }), content: SYMBOL_TEXT, draft: null, diskContent: null }
  const render = (comparisonOriginal?: string) => root.render(
    <EditorUiControlProvider scope={scope}>
      <SourceEditorControlScope context={surface.context}>
        <SourceEditor ref={ref} buffer={buffer} tabId="engine-tab" wrap={false} minimap={false} fontSize={13} fontFamily="monospace"
          onDraft={() => {}} flushDraft={async () => {}} onView={() => {}} onEditorFocus={() => {}} onSearchInFiles={() => {}} onError={() => {}}
          symbols={{ context: surface.context, refusal: () => null }} comparisonOriginal={comparisonOriginal} />
      </SourceEditorControlScope>
    </EditorUiControlProvider>
  )
  try {
    await act(async () => render())
    const before = report.uiControls!.find(({ target }) => target.startsWith('source-symbols:'))!
    let outcome!: Promise<unknown>
    await act(async () => { outcome = ref.current!.definition({ line: 4, column: 27 }) })
    await act(async () => render('old source'))
    const after = report.uiControls!.find(({ target }) => target.startsWith('source-symbols:'))!
    expect(after.generation).not.toBe(before.generation)
    await act(async () => { deferred.resolve(symbolAnswer()); await deferred.promise })
    await outcome
    expect(surface.openCalls).toEqual([])
    expect(element.querySelector('.qe-source-locations')).toBeNull()
    expect(await surface.dispatch(before, 'definition')).toEqual({ result: { delivered: false } })
  } finally {
    await act(async () => root.unmount())
    scope.dispose()
    element.remove()
  }
})

test('closing references while a row resolves window identity prevents its open', async () => {
  const identity = Promise.withResolvers<unknown>()
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => symbolAnswer(), windowSelf: () => identity.promise })
  await symbolCommand(surface, 'find-references')
  const address = surface.address('source-locations:')
  expect(await surface.dispatch(address, 'open', { index: 0 })).toEqual({ result: { delivered: true } })
  await surface.dispatch(address, 'close')
  await act(async () => { identity.resolve({ connId: 22 }); await identity.promise })
  expect(surface.openCalls).toEqual([])
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
})

test.each(['reject', 'missing', 'zero'] as const)('a result click surfaces a %s window-bridge identity failure', async (failure) => {
  let failIdentity = false
  const surface = await mountDocument({
    content: SYMBOL_TEXT, navigation: () => symbolAnswer(),
    windowSelf: () => {
      if (!failIdentity) return { connId: 22 }
      if (failure === 'reject') throw new Error('window transport unavailable')
      return failure === 'missing' ? {} : { connId: 0 }
    }
  })
  await symbolCommand(surface, 'find-references')
  failIdentity = true
  await act(async () => { surface.container.querySelector<HTMLButtonElement>('.ui-list-row__main')!.click() })
  await tickUi()
  expect(surface.container.textContent).toContain('The daemon did not identify this window.')
  expect(surface.address('source-locations:').actions).toEqual(['close'])
  expect(surface.openCalls).toEqual([])
})

test('backend failure details stay visible locally but never enter the symbol report', async () => {
  const message = 'File not found: src/use.ts'
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => { throw new Error(message) } })
  await expect(symbolCommand(surface)).rejects.toThrow(`Go to Definition failed: ${message}`)
  expect(surface.container.textContent).toContain(message)
  expect(surface.report().sourceSymbols?.error).toBe('Go to Definition failed.')
  expect(JSON.stringify(surface.report().sourceSymbols)).not.toContain('src/use.ts')
})

test('renaming unsupported source enables modifier-click without remounting its document', async () => {
  const surface = await mountDocument({ content: SYMBOL_TEXT, relativePath: 'scratch.txt', navigation: () => symbolAnswer([]) })
  await act(async () => { surface.updateBuffer({ path: '/fixture/scratch.ts', relativePath: 'scratch.ts', name: 'scratch.ts', revision: 2 }) })
  await tickUi()
  const view = surface.view()
  Object.defineProperty(view, 'posAtCoords', { configurable: true, value: () => view.state.doc.line(4).from + 26 })
  await act(async () => {
    view.contentDOM.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0,
      metaKey: CHORD_PLATFORM === 'darwin', ctrlKey: CHORD_PLATFORM !== 'darwin'
    }))
  })
  await tickUi()
  expect(surface.navigationCalls.map(({ params }) => params)).toEqual([{ worktree: `id:${WORKTREE_ID}`, path: 'scratch.ts', line: 4, column: 27 }])
})

test('an old result-click bridge failure cannot restore a panel after an edit', async () => {
  const identity = Promise.withResolvers<unknown>()
  const surface = await mountDocument({ content: SYMBOL_TEXT, navigation: () => symbolAnswer(), windowSelf: () => identity.promise })
  await symbolCommand(surface, 'find-references')
  await act(async () => { surface.container.querySelector<HTMLButtonElement>('.ui-list-row__main')!.click() })
  await act(async () => { surface.view().dispatch({ changes: { from: 0, insert: 'x' } }) })
  await act(async () => { identity.reject(new Error('old window transport failure')); await identity.promise.catch(() => {}) })
  await tickUi()
  expect(surface.container.querySelector('.qe-source-locations')).toBeNull()
  expect(surface.report().sourceSymbols?.status).toBe('idle')
  expect(surface.openCalls).toEqual([])
})
