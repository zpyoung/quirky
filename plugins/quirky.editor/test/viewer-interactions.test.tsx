import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { ComponentType } from 'react'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import {
  EDITOR_UI_CONTROL_COMMAND,
  EditorUiControlProvider,
  createEditorUiControlReportScope,
  type EditorUiControlAddress,
  type EditorUiControlReportScope
} from '../src/window/uiControl'

type ControlHandler = (...args: unknown[]) => unknown
type WindowBridge = { handlers: Map<string, ControlHandler> }
type ControlReport = { mounted?: boolean; bufferId?: string; tabId?: string; uiControls?: EditorUiControlAddress[] }
type ControlRuntime = {
  context: UiPluginContext
  calls: { method: string; params?: Record<string, unknown> }[]
  reportScopes: EditorUiControlReportScope[]
  reports: ControlReport[]
  provided: Map<string, ControlHandler>
  windows: Map<number, WindowBridge>
  commandRoutes: number[]
  executeCalls: string[]
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>
}
type Mounted = {
  element: HTMLElement
  runtime: ControlRuntime
  scope: EditorUiControlReportScope
  commands(): CommandHandlers | undefined
  report(): ControlReport
  addresses(): EditorUiControlAddress[]
  dispatch(action: string, data?: Record<string, unknown>, target?: string): Promise<{ delivered: boolean }>
  rerender(buffer: EditorSurfaceBuffer): Promise<void>
  unmount(): Promise<void>
}
type CommandHandlers = Parameters<SurfaceProps['registerCommandHandlers']>[0]

let createRoot: (container: HTMLElement) => Root
let NotebookSurface: ComponentType<SurfaceProps>
let ViewerSurface: ComponentType<SurfaceProps>
let activate: (context: UiPluginContext) => void
let deactivate: () => void
let mounted: Mounted[]
let runtimes: ControlRuntime[]
let controlFixture: ControlRuntime | null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // These modules capture browser APIs during initialization, so Happy DOM must be registered first.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ NotebookSurface } = await import('../src/notebook/NotebookSurface'))
  ;({ ViewerSurface } = await import('../src/viewers/ViewerSurface'))
  ;({ activate, deactivate } = await import('../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  mounted = []
  runtimes = []
  controlFixture = null
})
afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  for (const runtime of runtimes) for (const scope of runtime.reportScopes) scope.dispose()
  deactivate()
  runtimes = []
  controlFixture = null
  document.body.innerHTML = ''
})


function makeBuffer(kind: EditorSurfaceBuffer['kind'], content = ''): EditorSurfaceBuffer {
  return {
    id: `buffer-${kind}`,
    worktreeId: 'wt-editor-viewers',
    root: '/tmp/viewer-worktree',
    path: `/tmp/viewer-worktree/sample.${kind === 'notebook' ? 'ipynb' : 'csv'}`,
    relativePath: `sample.${kind === 'notebook' ? 'ipynb' : 'csv'}`,
    name: `sample.${kind === 'notebook' ? 'ipynb' : 'csv'}`,
    kind,
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: kind === 'csv',
    diskWritable: kind !== 'csv',
    dirty: false,
    external: null,
    mode: 'rich',
    tabId: 'tab-viewers',
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

function createControlRuntime(delegate: SurfaceProps['onAction']): ControlRuntime {
  const provided = new Map<string, ControlHandler>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const reportScopes: EditorUiControlReportScope[] = []
  const reports: ControlReport[] = []
  const commandRoutes: number[] = []
  const executeCalls: string[] = []
  const subscribers = new Set<(event: { type: string }) => void>()
  const ownerHandlers = new Map<string, ControlHandler>([[EDITOR_UI_CONTROL_COMMAND, async () => {
    throw new Error('the owner window must not receive this click')
  }]])
  const windows = new Map<number, WindowBridge>([
    [11, { handlers: ownerHandlers }],
    [22, { handlers: provided }]
  ])
  const invoke = (method: string, params: Record<string, unknown>) => delegate(method, params)
  const context = {
    pluginId: 'quirky.editor',
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 22 }
      if (method === 'ui.window.command.run') {
        const connId = params.connId as number
        commandRoutes.push(connId)
        const id = typeof params.id === 'string' ? params.id : ''
        if (!id) throw new Error('Missing command ID')
        const handler = windows.get(connId)?.handlers.get(id)
        if (!handler) throw new Error(`Missing command handler: ${id}`)
        return { result: await handler(params.args) }
      }
      return invoke(method, params)
    },
    provide(id: string, handler: unknown) {
      if (typeof handler !== 'function') throw new Error(`Expected handler for ${id}`)
      provided.set(id, handler as ControlHandler)
    },
    subscribe(handler: (event: { type: string }) => void) {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },
    onConnection: () => () => {},
    getSetting(name: string) {
      const settings: Record<string, unknown> = {
        editorSidebarWidth: 300,
        editorAutoSave: false,
        editorAutoSaveDelayMs: 1000,
        editorWordWrap: false,
        editorFontFamily: 'monospace',
        editorPreviewTabsEnabled: true,
        richMarkdownSpellcheckEnabled: false,
        markdownReviewToolsEnabled: false,
        showGitIgnoredFiles: false,
        followSymlinkedDirectories: false,
        editorFontZoomLevel: 0,
        editorMinimapEnabled: false
      }
      return Object.hasOwn(settings, name) ? settings[name] : 300
    },
    getLayout: () => ({ worktree: 'wt-editor-viewers', view: null, panel: null }),
    executeCommand: async (id: string) => { executeCalls.push(id) },
    toast: () => {}
  } as unknown as UiPluginContext
  activate(context)
  const activatedHandler = provided.get(EDITOR_UI_CONTROL_COMMAND)
  if (!activatedHandler) throw new Error('activate did not provide the editor UI control command')
  windows.get(22)!.handlers.set(EDITOR_UI_CONTROL_COMMAND, activatedHandler)
  const runtime = { context, calls, reportScopes, reports, provided, windows, commandRoutes, executeCalls, invoke }
  runtimes.push(runtime)
  return runtime
}

function getControlFixture(): ControlRuntime {
  if (controlFixture === null) controlFixture = createControlRuntime(async () => ({}))
  return controlFixture
}

async function renderSurface(
  Component: ComponentType<SurfaceProps>,
  buffer: EditorSurfaceBuffer,
  onAction: SurfaceProps['onAction'],
  onDraft: SurfaceProps['onDraft'] = () => {},
  existingRuntime?: ControlRuntime
): Promise<Mounted> {
  const runtime = existingRuntime ?? getControlFixture()
  let report: ControlReport = {}
  const scope = createEditorUiControlReportScope((value) => {
    report = value as ControlReport
    runtime.reports.push(report)
  }, {
    surface: 'view:quirky.editor/document',
    context: runtime.context
  })
  runtime.reportScopes.push(scope)
  scope.report({ mounted: true, bufferId: buffer.id, tabId: buffer.tabId })
  let commands: CommandHandlers | undefined
  let props: SurfaceProps = {
    context: runtime.context,
    buffer,
    fontSize: 13,
    onDraft,
    onAction,
    onView() {},
    registerCommandHandlers(handlers) {
      commands = handlers
      return () => { if (commands === handlers) commands = undefined }
    }
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(
    <EditorUiControlProvider scope={scope}>
      <Component {...props} />
    </EditorUiControlProvider>
  ))
  let unmounted = false
  const surface: Mounted = {
    element,
    runtime,
    commands: () => commands,
    scope,
    report: () => report,
    addresses: () => report.uiControls ?? [],
    async dispatch(action, data, target) {
      const address = (report.uiControls ?? []).find((candidate) =>
        candidate.actions.includes(action) && (target === undefined || candidate.target === target || candidate.target.startsWith(target))
      )
      if (!address) throw new Error(`No mounted viewer control for ${action}.`)
      const handler = runtime.provided.get(EDITOR_UI_CONTROL_COMMAND)
      if (!handler) throw new Error('The activate-provided UI control handler is unavailable.')
      let result: unknown
      let failure: { reason: unknown } | undefined
      await act(async () => {
        try {
          result = await handler({
            surface: address.surface,
            target: address.target,
            generation: address.generation,
            action,
            ...(data === undefined ? {} : { data })
          })
        } catch (reason) { failure = { reason } }
      })
      if (failure) throw failure.reason
      if (!result || typeof result !== 'object' || !('delivered' in result) || typeof result.delivered !== 'boolean') {
        throw new Error('The activated control returned an invalid result.')
      }
      return { delivered: result.delivered }
    },
    async rerender(buffer) {
      props = { ...props, buffer }
      await act(async () => root.render(
        <EditorUiControlProvider scope={scope}>
          <Component {...props} />
        </EditorUiControlProvider>
      ))
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

async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}
async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setValue) throw new Error('The input value setter is unavailable.')
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function notebookWithSource(cellType: 'code' | 'markdown', source: string): string {
  return JSON.stringify({
    cells: [{
      cell_type: cellType,
      metadata: {},
      source,
      ...(cellType === 'code' ? { outputs: [], execution_count: null } : {})
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  })
}

function notebookCellSource(content: string): string {
  const notebook = JSON.parse(content) as { cells: { source: string | string[] }[] }
  const source = notebook.cells[0]!.source
  return Array.isArray(source) ? source.join('') : source
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string, selection: number): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setValue) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    setValue.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => textarea.setSelectionRange(selection, selection))
}

async function replaceTextareaSelection(textarea: HTMLTextAreaElement, replacement: string): Promise<void> {
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  await setTextareaValue(
    textarea,
    textarea.value.slice(0, start) + replacement + textarea.value.slice(end),
    start + replacement.length
  )
}

async function flushNotebookChanges(surface: Mounted): Promise<void> {
  const flushChanges = surface.commands()?.flush
  expect(flushChanges).toBeDefined()
  await act(async () => { flushChanges!() })
}

test.each([
  { cellType: 'code' as const },
  { cellType: 'markdown' as const }
])('accepting queued local $cellType cell drafts preserves editing focus and later input', async ({ cellType }) => {
  const content = notebookWithSource(cellType, 'seed')
  const buffer = makeBuffer('notebook', content)
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  expect(editButton).toBeDefined()
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => {
    textarea!.focus()
    textarea!.setSelectionRange(1, 3)
  })
  await replaceTextareaSelection(textarea!, 'X')
  expect(textarea!.value).toBe('sXd')

  await flushNotebookChanges(surface)
  expect(submittedDrafts).toHaveLength(1)
  const firstDraft = submittedDrafts[0]!
  expect(notebookCellSource(firstDraft)).toBe('sXd')
  await replaceTextareaSelection(textarea!, 'Y')
  expect(textarea!.value).toBe('sXYd')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toHaveLength(2)
  const secondDraft = submittedDrafts[1]!
  expect(notebookCellSource(secondDraft)).toBe('sXYd')
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect(textarea!.value).toBe('sXYd')

  await surface.rerender({
    ...buffer,
    draft: firstDraft,
    contentRevision: buffer.contentRevision + 1,
    dirty: true
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect(textarea!.selectionStart).toBe(3)
  expect(textarea!.selectionEnd).toBe(3)
  expect(textarea!.value).toBe('sXYd')

  await surface.rerender({
    ...buffer,
    draft: secondDraft,
    contentRevision: buffer.contentRevision + 2,
    dirty: true
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect(textarea!.value).toBe('sXYd')
  expect(textarea!.selectionStart).toBe(3)
  expect(textarea!.selectionEnd).toBe(3)
  expect(notebookCellSource(secondDraft)).toBe('sXYd')

  const doneButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Done editing')
  expect(doneButton).toBeDefined()
  await act(async () => doneButton!.click())
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('sXYd')
})

test('unrelated external replacements discard local cell text and reset editing', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'seed'))
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => textarea!.focus())
  await setTextareaValue(textarea!, 'stale local text', 15)
  await flushNotebookChanges(surface)
  const acceptedA = submittedDrafts[0]!
  expect(notebookCellSource(acceptedA)).toBe('stale local text')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toEqual([acceptedA])

  const replacement = notebookWithSource('code', 'external replacement')
  await surface.rerender({
    ...buffer,
    content: replacement
  })

  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('external replacement')
  expect(surface.element.textContent).not.toContain('stale local text')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toEqual([acceptedA])

  await surface.unmount()
  expect(submittedDrafts).toEqual([acceptedA])
})

test('an unflushed cell edit is discarded when an external replacement arrives', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'seed'))
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => textarea!.focus())
  await setTextareaValue(textarea!, 'unflushed local text', 20)

  const replacement = notebookWithSource('code', 'external replacement')
  await surface.rerender({
    ...buffer,
    content: replacement
  })

  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('external replacement')
  await flushNotebookChanges(surface)
  expect(submittedDrafts).toEqual([])
  await surface.unmount()
  expect(submittedDrafts).toEqual([])
})


test('an earlier local echo cannot hide an unrelated replacement that returns to its content', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'seed'))
  const submittedDrafts: string[] = []
  const surface = await renderSurface(
    NotebookSurface,
    buffer,
    async () => ({}),
    (draft) => { submittedDrafts.push(draft) }
  )
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(textarea).not.toBeNull()
  await act(async () => {
    textarea!.focus()
    textarea!.setSelectionRange(1, 3)
  })
  await replaceTextareaSelection(textarea!, 'X')
  await flushNotebookChanges(surface)
  const submittedA = submittedDrafts[0]!
  expect(notebookCellSource(submittedA)).toBe('sXd')

  const externalB = notebookWithSource('code', 'external B')
  await surface.rerender({
    ...buffer,
    content: externalB,
    contentRevision: buffer.contentRevision + 1
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('external B')

  const editExternalButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editExternalButton!.click())
  const externalTextarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')
  expect(externalTextarea).not.toBeNull()
  await act(async () => externalTextarea!.focus())
  await setTextareaValue(externalTextarea!, 'stale B edit', 12)

  await surface.rerender({
    ...buffer,
    content: submittedA,
    contentRevision: buffer.contentRevision + 2
  })
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('sXd')
  expect(surface.element.textContent).not.toContain('stale B edit')
})

test('switching notebook buffers resets cell editing', async () => {
  const buffer = makeBuffer('notebook', notebookWithSource('code', 'first file'))
  const surface = await renderSurface(NotebookSurface, buffer, async () => ({}))
  await flush()

  const editButton = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Edit cell')
  await act(async () => editButton!.click())
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).not.toBeNull()

  const nextBuffer = {
    ...makeBuffer('notebook', notebookWithSource('markdown', 'second file')),
    id: 'buffer-notebook-second',
    path: '/tmp/viewer-worktree/second.ipynb',
    relativePath: 'second.ipynb',
    name: 'second.ipynb'
  }
  await surface.rerender(nextBuffer)

  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('second file')
})

test('Escape cancels notebook trust without authorizing execution', async () => {
  const actions: string[] = []
  const content = JSON.stringify({
    cells: [{ cell_type: 'code', metadata: {}, source: 'print(1)', outputs: [], execution_count: null }],
    metadata: { kernelspec: { language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5
  })
  const surface = await renderSurface(NotebookSurface, makeBuffer('notebook', content), async (_method, params) => {
    const action = String(params.action)
    actions.push(action)
    if (action === 'state') return { trusted: false, busy: false, kernel: { status: 'stopped' } }
    return {}
  })
  await flush()

  const runAll = [...surface.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Run all')
  expect(runAll).toBeDefined()
  await act(async () => { runAll!.click() })
  const dialog = surface.element.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog!.textContent).toContain('Run Notebook Code?')
  await act(async () => {
    dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
  expect(actions).not.toContain('trust')
  expect(actions).not.toContain('runAll')
})

test('read-only paged CSV keeps edit controls hidden and rejects find', async () => {
  const actions: string[] = []
  const buffer = makeBuffer('csv', 'name,value\nalpha,1\n')
  const surface = await renderSurface(ViewerSurface, buffer, async (_method, params) => {
    const action = String(params.action)
    actions.push(action)
    if (action === 'metadata') return { paged: true, rows: 2, columns: 2, limits: { maxColumns: 4, maxRecordBytes: 2048, maxCachedPages: 2 } }
    if (action === 'page') return {
      rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }],
      nextPage: null,
      offset: 0,
      delimiter: ','
    }
    return {}
  })
  await flush()
  const commands = surface.commands()

  expect(surface.element.querySelector('section[aria-label="Paged CSV preview"]')).not.toBeNull()
  expect(surface.element.querySelector('input')).toBeNull()
  for (const label of ['Save', 'Add row', 'Add column', 'Paste', 'Copy range', 'Delete column']) {
    expect([...surface.element.querySelectorAll('button')].some((button) => button.textContent?.trim() === label)).toBe(false)
  }
  expect(commands?.find).toBeDefined()
  await expect(Promise.resolve().then(() => commands!.find!({ query: 'alpha' }))).rejects.toThrow('read-only paged CSV previews')
  expect(actions).not.toContain('filter')
  expect(actions).not.toContain('edit')
  const copyCells = [...surface.element.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => button.textContent?.trim() === 'Copy cell')
  expect(copyCells.length).toBeGreaterThan(0)
  expect(copyCells.every((button) => button.disabled)).toBe(true)
  const cell = surface.element.querySelector('tbody td')
  await act(async () => cell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(actions).not.toContain('copy')
})
test('the activated document mount merges viewer controls into its public report and exact-window route', async () => {
  const content = 'name,value\nalpha,1\n'
  const buffer = { ...makeBuffer('csv', content), readOnly: false }
  const info = {
    ...buffer,
    contentLength: content.length,
    contentBytes: new TextEncoder().encode(content).byteLength,
    draftLength: null,
    draftBytes: null
  }
  const apiCalls: { method: string; params: Record<string, unknown> }[] = []
  const runtime = createControlRuntime(async (method, params) => {
    apiCalls.push({ method, params })
    if (method === 'quirky.editor/state') {
      return { buffers: [info], tabs: [], explorer: { worktreeId: 'wt-editor-viewers', showDotfiles: false, expanded: [] }, search: null, quickOpenHistory: [], closeRequests: [] }
    }
    if (method === 'quirky.editor/viewer') {
      if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
      if (params.action === 'page') return { rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }], nextPage: null }
    }
    return {}
  })
  const mountDocument = runtime.provided.get('view:quirky.editor/document') as unknown as (
    element: HTMLElement,
    props: { input: unknown; report(value: unknown): void }
  ) => () => void
  const element = document.createElement('div')
  document.body.append(element)
  let report: ControlReport = {}
  let unmount = () => {}
  await act(async () => {
    unmount = mountDocument(element, {
      input: { bufferId: buffer.id, tabId: buffer.tabId, mode: 'rich' },
      report(value) { report = value as ControlReport }
    })
  })
  try {
    await flush()
    expect(structuredClone(report)).toMatchObject({
      mounted: true,
      bufferId: buffer.id,
      tabId: buffer.tabId,
      mode: 'rich',
      uiControls: expect.arrayContaining([
        expect.objectContaining({ target: 'csv:["buffer-csv","tab-viewers"]', actions: expect.arrayContaining(['filter', 'add-row']) })
      ])
    })
    const heading = [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'name')
    expect(heading).toBeDefined()
    await act(async () => heading!.click())
    await flush()
    expect(runtime.calls.filter(({ method, params }) => method === 'ui.window.self' || method === 'ui.window.command.run')).toEqual([
      { method: 'ui.window.self', params: {} },
      expect.objectContaining({
        method: 'ui.window.command.run',
        params: expect.objectContaining({
          connId: 22,
          id: 'command:quirky.editor/ui-control',
          args: expect.objectContaining({
            surface: 'view:quirky.editor/document',
            target: 'csv:["buffer-csv","tab-viewers"]',
            action: 'sort'
          })
        })
      })
    ])
    expect(apiCalls.filter(({ method, params }) => method === 'quirky.editor/viewer' && params.action === 'sort')).toHaveLength(1)
  } finally {
    await act(async () => unmount())
  }
})
test('same-buffer tabs have independent viewer targets and pointer controls route in window 22', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const onAction: SurfaceProps['onAction'] = async (method, params) => {
    calls.push({ method, params })
    if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
    if (params.action === 'page') return { rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }], nextPage: null }
    return {}
  }
  const firstBuffer = { ...makeBuffer('csv', 'name,value\nalpha,1\n'), readOnly: false, tabId: 't1' }
  const first = await renderSurface(ViewerSurface, firstBuffer, onAction)
  await flush()
  const second = await renderSurface(ViewerSurface, { ...firstBuffer, tabId: 't2' }, onAction, () => {}, first.runtime)
  await flush()

  expect(first.report().uiControls?.some(({ target }) => target === 'csv:["buffer-csv","t1"]')).toBe(true)
  expect(second.report().uiControls?.some(({ target }) => target === 'csv:["buffer-csv","t2"]')).toBe(true)
  expect(first.report().uiControls?.some(({ target }) => target === 'csv:["buffer-csv","t2"]')).toBe(false)
  const addRow = [...second.element.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Add row')
  expect(addRow).toBeDefined()
  await act(async () => addRow!.click())
  await flush()

  const route = first.runtime.calls.filter(({ method }) => method === 'ui.window.command.run').at(-1)
  expect(route).toMatchObject({
    method: 'ui.window.command.run',
    params: {
      connId: 22,
      id: 'command:quirky.editor/ui-control',
      args: { target: 'csv:["buffer-csv","t2"]', action: 'add-row' }
    }
  })
  expect(calls.filter(({ params }) => params.action === 'insertRow')).toHaveLength(1)
})

test('paged CSV remains bounded and routes paging and reload with source positions', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let changed = false
  const buffer = {
    ...makeBuffer('csv', 'name,value\nalpha,1\n'),
    size: 1024 * 1024,
    readOnly: true,
    external: 'changed' as const
  }
  const surface = await renderSurface(ViewerSurface, buffer, async (method, params) => {
    calls.push({ method, params })
    if (params.action === 'metadata') return { paged: true, rows: null, columns: null }
    if (params.action === 'page') return changed
      ? { rows: [], changedOnDisk: true, nextPage: null, offset: 0 }
      : { rows: [], nextPage: 1, offset: params.page === 1 ? 4096 : 0 }
    return {}
  })
  await flush()
  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No rows on this page.')
  expect([...surface.element.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Next page')).toBe(true)
  expect(surface.addresses().find(({ target }) => target.startsWith('csv:'))?.actions).not.toEqual(
    expect.arrayContaining(['edit', 'sort', 'copy', 'filter', 'paste', 'add-row'])
  )

  const next = [...surface.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Next page')
  await act(async () => next!.click())
  await flush()
  expect(calls.filter(({ params }) => params.action === 'page').map(({ params }) => params.page)).toEqual([0, 1])
  expect(calls.find(({ params }) => params.action === 'position' && params.page === 2)?.params).toMatchObject({ page: 2, offset: 4096 })
  const previous = [...surface.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Previous page')
  await act(async () => previous!.click())
  await flush()
  expect(calls.filter(({ params }) => params.action === 'page').at(-1)?.params.page).toBe(0)

  changed = true
  await surface.dispatch('retry', undefined, 'csv:')
  await flush()
  expect(surface.element.textContent).toContain('changed on disk')
  const beforeReload = calls.length
  await surface.dispatch('reload', undefined, 'csv:')
  await flush()
  const reloadCalls = calls.slice(beforeReload)
  expect(reloadCalls.findIndex(({ method, params }) => params.action === 'reload' && method === 'quirky.editor/view')).toBeGreaterThanOrEqual(0)
  expect(reloadCalls.findIndex(({ params }) => params.action === 'page' && params.page === 0)).toBeGreaterThan(
    reloadCalls.findIndex(({ method, params }) => params.action === 'reload' && method === 'quirky.editor/view')
  )
})
test('CSV routes mutations and copies with source coordinates and refuses malformed or oversized payloads', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const copied: string[] = []
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { async writeText(value: string) { copied.push(value) } }
  })
  const surface = await renderSurface(ViewerSurface, { ...makeBuffer('csv', 'name,value\nalpha,1\nbeta,2\n'), readOnly: false }, async (method, params) => {
    calls.push({ method, params })
    if (params.action === 'metadata') return { paged: false, rows: 21, columns: 2 }
    if (params.action === 'page') return {
      rows: [{ index: 0, cells: ['name', 'value'] }, { index: 7, cells: ['alpha', '1'] }, { index: 20, cells: ['beta', '2'] }],
      nextPage: null,
      delimiter: ','
    }
    if (params.action === 'copy') return { text: 'alpha\t1' }
    return {}
  })
  try {
    await flush()
    await surface.dispatch('add-row')
    await surface.dispatch('add-column')
    await surface.dispatch('delete-row', { row: 20 })
    await surface.dispatch('delete-column', { column: 1 })
    await surface.dispatch('delimiter', { delimiter: ';' })
    await surface.dispatch('filter', { query: 'alpha' })
    await surface.dispatch('sort', { column: 0, order: 'desc' })
    await surface.dispatch('paste', { row: 7, column: 1, text: 'new\t3' })
    await surface.dispatch('copy', { row: 7, column: 1 })
    await surface.dispatch('copy-range', { row: 7, column: 0, endRow: 20, endColumn: 1 })
    await surface.dispatch('save')

    const viewerCalls = calls.filter(({ method }) => method === 'quirky.editor/viewer')
    expect(viewerCalls.find(({ params }) => params.action === 'insertRow')?.params).toMatchObject({ index: 21, count: 1 })
    expect(viewerCalls.find(({ params }) => params.action === 'insertColumn')?.params).toMatchObject({ index: 2, value: 'Column 3' })
    expect(viewerCalls.find(({ params }) => params.action === 'deleteRow')?.params).toMatchObject({ row: 20 })
    expect(viewerCalls.find(({ params }) => params.action === 'deleteColumn')?.params).toMatchObject({ index: 1 })
    expect(viewerCalls.find(({ params }) => params.action === 'delimiter')?.params).toMatchObject({ delimiter: ';' })
    expect(viewerCalls.find(({ params }) => params.action === 'filter')?.params).toMatchObject({ query: 'alpha' })
    expect(viewerCalls.find(({ params }) => params.action === 'sort')?.params).toMatchObject({ column: 0, order: 'desc' })
    expect(viewerCalls.find(({ params }) => params.action === 'paste')?.params).toMatchObject({ row: 7, column: 1, text: 'new\t3' })
    const copyCalls = viewerCalls.filter(({ params }) => params.action === 'copy')
    expect(copyCalls).toHaveLength(2)
    expect(copyCalls[0]?.params).toMatchObject({ row: 7, column: 1 })
    expect(copyCalls[1]?.params).toMatchObject({ row: 7, column: 0, endRow: 20, endColumn: 1 })
    expect(copied).toEqual(['alpha\t1', 'alpha\t1'])

    const beforeInvalid = calls.length
    const invalid: [string, Record<string, unknown>][] = [
      ['edit', { row: -1, column: 0, value: 'x' }],
      ['edit', { row: 7, column: 0, value: 3 }],
      ['edit', { row: 7, column: 0, value: 'x', bufferId: 'other' }],
      ['delete-row', { row: 1.5 }],
      ['delete-column', { column: Number.NaN }],
      ['delimiter', { delimiter: ':' }],
      ['filter', { query: 'x'.repeat(8193) }],
      ['sort', { column: Number.POSITIVE_INFINITY }],
      ['copy', { row: 7, endRow: 20 }],
      ['copy-range', { row: 20, column: 0, endRow: 7, endColumn: 1 }],
      ['paste', { row: -1, column: 0, text: 'bad' }],
      ['paste', { row: 7, column: 0, text: 'é'.repeat(512 * 1024) }]
    ]
    for (const [action, data] of invalid) {
      expect(await surface.dispatch(action, data)).toEqual({ delivered: false })
    }
    expect(calls).toHaveLength(beforeInvalid)
    expect(copied).toEqual(['alpha\t1', 'alpha\t1'])
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('CSV typing is local, blur and Save deduplicate a pending edit, and failures retain the draft', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const editGate = Promise.withResolvers<unknown>()
  let delayEdit = false
  let failEdit = false
  const surface = await renderSurface(ViewerSurface, { ...makeBuffer('csv', 'name,value\nalpha,1\n'), readOnly: false }, async (method, params) => {
    if (method === 'quirky.editor/viewer') {
      calls.push({ method, params })
      if (params.action === 'metadata') return { paged: false, rows: 2, columns: 2 }
      if (params.action === 'page') return { rows: [{ index: 0, cells: ['name', 'value'] }, { index: 1, cells: ['alpha', '1'] }], nextPage: null }
      if (params.action === 'edit' && delayEdit) return editGate.promise
      if (params.action === 'edit' && failEdit) {
        failEdit = false
        throw new Error('fixture edit failed')
      }
    }
    return {}
  })
  await flush()

  let input = surface.element.querySelector<HTMLInputElement>('input[aria-label="Row 2, column 2"]')!
  await setInputValue(input, '2')
  expect(calls.filter(({ params }) => params.action === 'edit')).toHaveLength(0)

  delayEdit = true
  const save = [...surface.element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Save')
  await act(async () => {
    input.focus()
    input.blur()
    save?.click()
  })
  await flush()
  expect(calls.filter(({ params }) => params.action === 'edit')).toHaveLength(1)
  expect(calls.filter(({ params }) => params.action === 'save')).toHaveLength(0)
  editGate.resolve({})
  delayEdit = false
  await flush()
  expect(calls.filter(({ params }) => params.action === 'edit')).toHaveLength(1)
  expect(calls.filter(({ params }) => params.action === 'save')).toHaveLength(1)

  input = surface.element.querySelector<HTMLInputElement>('input[aria-label="Row 2, column 2"]')!
  await setInputValue(input, 'kept after failure')
  failEdit = true
  await act(async () => {
    input.focus()
    input.blur()
  })
  await flush()
  expect(input.value).toBe('kept after failure')
  expect(surface.element.querySelector('[role="alert"]')?.textContent).toContain('fixture edit failed')
})
