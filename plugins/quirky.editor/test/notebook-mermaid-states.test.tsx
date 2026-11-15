import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ComponentType } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import { formatMarkdownSelection } from '../src/markdown/operations'
import { MARKDOWN_PREVIEW_REHYPE_PLUGINS, previewHeadingId } from '../src/markdown/previewPipeline'
import { richEligibility } from '../src/markdown/source'
import {
  EDITOR_UI_CONTROL_COMMAND,
  EditorUiControlProvider,
  createEditorUiControlReportScope,
  editorUiControlDescriptor,
  type EditorUiControl,
  type EditorUiControlAddress,
  type EditorUiControlReportScope
} from '../src/window/uiControl'

type Handler = (args?: unknown) => unknown

type WindowBridge = { handlers: Map<string, Handler> }

type ContextFixture = {
  context: UiPluginContext
  calls: { method: string; params?: Record<string, unknown> }[]
  commandRoutes: number[]
  executeCalls: string[]
  subscribers: Set<(event: { type: string }) => void>
  windows: Map<number, WindowBridge>
  provided: Map<string, Handler>
  bridge: { error: Error | null; result: unknown; useResult: boolean; response: Promise<unknown> | null }
}

type Mounted = {
  element: HTMLElement
  rerender(buffer: EditorSurfaceBuffer): Promise<void>
  unmount(): Promise<void>
  report(): unknown
  contextFixture: ContextFixture
  scope: EditorUiControlReportScope
}

let createRoot: (container: HTMLElement) => Root
let NotebookSurface: ComponentType<SurfaceProps>
let mounted: Mounted[]
let activate: (context: UiPluginContext) => void
let deactivate: () => void

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Happy DOM must register before importing the surface, which captures browser APIs during initialization.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ NotebookSurface } = await import('../src/notebook/NotebookSurface'))
  ;({ activate, deactivate } = await import('../src/ui'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => { mounted = [] })

afterEach(async () => {
  for (const surface of mounted) await surface.unmount()
  mounted = []
  deactivate()
  document.body.innerHTML = ''
})

function makeContext(
  connId = 22,
  options: { identity?: unknown; bridgeError?: Error; bridgeResult?: unknown } = {}
): ContextFixture {
  const provided = new Map<string, Handler>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const commandRoutes: number[] = []
  const executeCalls: string[] = []
  const subscribers = new Set<(event: { type: string }) => void>()
  const bridge = {
    error: options.bridgeError ?? null,
    result: options.bridgeResult,
    useResult: Object.hasOwn(options, 'bridgeResult'),
    response: null as Promise<unknown> | null
  }
  const ownerHandlers = new Map<string, Handler>([[EDITOR_UI_CONTROL_COMMAND, async () => {
    throw new Error('the owner window must not receive this click')
  }]])
  const windows = new Map<number, WindowBridge>([
    [11, { handlers: ownerHandlers }],
    [connId, { handlers: provided }]
  ])
  const context = {
    pluginId: 'quirky.editor',
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return Object.hasOwn(options, 'identity') ? options.identity : { connId }
      if (method === 'ui.window.command.run') {
        const targetConnId = params?.connId as number
        commandRoutes.push(targetConnId)
        if (bridge.error) throw bridge.error
        if (bridge.useResult) return { result: bridge.result }
        if (bridge.response) return bridge.response
        const target = windows.get(targetConnId)
        const id = params?.id
        if (typeof id !== 'string') throw new Error('Missing command ID')
        const handler = target?.handlers.get(id)
        if (!handler) throw new Error(`Missing command handler: ${id}`)
        return { result: await handler(params?.args) }
      }
      return {}
    },
    provide: (id: string, handler: unknown) => {
      if (typeof handler !== 'function') throw new Error(`Expected handler for ${id}`)
      provided.set(id, handler as Handler)
    },
    subscribe: (handler: (event: { type: string }) => void) => {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },
    getSetting: () => 300,
    getLayout: () => ({}),
    executeCommand: async (id: string) => { executeCalls.push(id) },
    toast: () => {}
  } as unknown as UiPluginContext
  activate(context)
  const command = provided.get(EDITOR_UI_CONTROL_COMMAND)
  if (!command) throw new Error('activate did not provide the editor UI control command')
  windows.get(connId)!.handlers.set(EDITOR_UI_CONTROL_COMMAND, command)
  return { context, calls, commandRoutes, executeCalls, subscribers, windows, provided, bridge }
}

function makeCell(source = 'print(1)', options: Record<string, unknown> = {}) {
  return {
    cell_type: 'code',
    metadata: {},
    source,
    outputs: [],
    execution_count: null,
    ...options
  }
}

function notebookContent(cells: Record<string, unknown>[] = [makeCell()], metadata: Record<string, unknown> = { kernelspec: { language: 'python' } }): string {
  return JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 })
}

function makeBuffer(
  id = 'b1',
  content = notebookContent(),
  overrides: Partial<EditorSurfaceBuffer> = {}
): EditorSurfaceBuffer {
  return {
    id,
    worktreeId: 'wt-notebook',
    root: '/tmp/notebook-worktree',
    path: `/tmp/notebook-worktree/${id}.ipynb`,
    relativePath: `${id}.ipynb`,
    name: `${id}.ipynb`,
    kind: 'notebook',
    content,
    draft: null,
    baseline: null,
    size: content.length,
    readOnly: false,
    diskWritable: true,
    dirty: false,
    external: null,
    mode: 'rich',
    tabId: 'tab-notebook',
    preview: false,
    pinned: false,
    untitled: false,
    revision: 1,
    contentRevision: 1,
    view: {},
    error: null,
    diskContentLength: null,
    diskContentBytes: null,
    diskSignature: null,
    ...overrides
  }
}

async function renderNotebook(
  buffer: EditorSurfaceBuffer,
  onAction: SurfaceProps['onAction'],
  contextFixture = makeContext(),
  onView: SurfaceProps['onView'] = () => {},
  onDraft: SurfaceProps['onDraft'] = () => {}
): Promise<Mounted> {
  let latestReport: unknown
  const scope = createEditorUiControlReportScope((report) => { latestReport = report }, {
    surface: 'view:quirky.editor/document',
    context: contextFixture.context
  })
  let props: SurfaceProps = {
    context: contextFixture.context,
    buffer,
    fontSize: 13,
    onDraft,
    onAction,
    onView,
    registerCommandHandlers: () => () => {}
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><NotebookSurface {...props} /></EditorUiControlProvider>)
  })
  let unmounted = false
  const surface: Mounted = {
    element,
    scope,
    report: () => latestReport,
    contextFixture,
    async rerender(nextBuffer) {
      props = { ...props, buffer: nextBuffer }
      await act(async () => {
        root.render(<EditorUiControlProvider scope={scope}><NotebookSurface {...props} /></EditorUiControlProvider>)
      })
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

function isEditorUiControlAddress(value: unknown): value is EditorUiControlAddress {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    'surface' in value && typeof value.surface === 'string' &&
    'target' in value && typeof value.target === 'string' &&
    'generation' in value && typeof value.generation === 'string' &&
    'actions' in value && Array.isArray(value.actions) && value.actions.every((action) => typeof action === 'string')
}

function addressFor(surface: Mounted, target: string): EditorUiControlAddress {
  const report = surface.report()
  if (report === null || typeof report !== 'object' || Array.isArray(report) || !('uiControls' in report) || !Array.isArray(report.uiControls)) {
    throw new Error('The document report has no uiControls list.')
  }
  const address = report.uiControls.find((candidate) => isEditorUiControlAddress(candidate) && candidate.target === target)
  if (!address) throw new Error(`The document report has no ${target} control.`)
  return address
}

function controlArgs(address: EditorUiControlAddress, action: string, data?: Record<string, unknown>): EditorUiControl {
  return {
    surface: address.surface,
    target: address.target,
    generation: address.generation,
    action,
    ...(data === undefined ? {} : { data })
  }
}

async function sendPublicCommand(surface: Mounted, id: string, args: unknown): Promise<unknown> {
  const context = surface.contextFixture.context
  const identity = await context.call('ui.window.self', {})
  if (identity === null || typeof identity !== 'object' || !('connId' in identity) || typeof identity.connId !== 'number') {
    return { delivered: false }
  }
  const response = await context.call('ui.window.command.run', { connId: identity.connId, id, args })
  return response !== null && typeof response === 'object' && 'result' in response ? response.result : response
}

async function invokePublic(surface: Mounted, args: EditorUiControl): Promise<unknown> {
  const descriptor = editorUiControlDescriptor(args)
  return sendPublicCommand(surface, descriptor.command, descriptor.args)
}

async function invokeMalformedPublic(surface: Mounted, args: unknown): Promise<unknown> {
  return sendPublicCommand(surface, EDITOR_UI_CONTROL_COMMAND, args)
}

async function runAddress(
  surface: Mounted,
  address: EditorUiControlAddress,
  action: string,
  data?: Record<string, unknown>
): Promise<unknown> {
  let result: unknown = undefined
  await act(async () => { result = await invokePublic(surface, controlArgs(address, action, data)) })
  return result
}

async function runControl(
  surface: Mounted,
  target: string,
  action: string,
  data?: Record<string, unknown>
): Promise<unknown> {
  return runAddress(surface, addressFor(surface, target), action, data)
}

async function runMalformedControl(surface: Mounted, args: unknown): Promise<unknown> {
  let result: unknown = undefined
  await act(async () => { result = await invokeMalformedPublic(surface, args) })
  return result
}

function button(element: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...element.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)
}

function runtimeState(overrides: Record<string, unknown> = {}) {
  return { trusted: true, busy: false, kernel: { status: 'stopped' }, ...overrides }
}

test('an unresolved runtime read is visible and cannot authorize execution from an assumed state', async () => {
  const state = Promise.withResolvers<unknown>()
  const delegated: string[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    delegated.push(String(params.action))
    if (params.action === 'state') return state.promise
    return {}
  })

  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading notebook runtime…')
  expect(surface.element.querySelector('.notebook-cell')).not.toBeNull()
  const runAll = button(surface.element, 'Run all')!
  expect(runAll.disabled).toBe(true)
  await act(async () => runAll.click())
  expect(delegated).not.toContain('runAll')
  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()

  await act(async () => { state.resolve(runtimeState()) })
  await flush()
  expect(surface.element.querySelector('.ui-notice-line')).toBeNull()
  expect(button(surface.element, 'Run all')?.disabled).toBe(false)
})

test('a failed runtime read is shared and a successful changed-event refresh clears it', async () => {
  const context = makeContext()
  let stateReads = 0
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') {
      stateReads += 1
      if (stateReads === 1) throw new Error('fixture state failed')
      return runtimeState({ trusted: false })
    }
    return {}
  }, context)
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture state failed')
  await act(async () => {
    for (const subscriber of context.subscribers) subscriber({ type: 'quirky.editor/changed' })
    await Promise.resolve()
  })
  await flush()
  expect(stateReads).toBe(2)
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test('a previous buffer runtime response cannot replace the current pending state or publish its error', async () => {
  const earlier = Promise.withResolvers<unknown>()
  const current = Promise.withResolvers<unknown>()
  let reads = 0
  const surface = await renderNotebook(makeBuffer('b1'), async (_method, params) => {
    if (params.action !== 'state') return {}
    reads += 1
    return reads === 1 ? earlier.promise : current.promise
  })
  await surface.rerender(makeBuffer('b2'))
  expect(reads).toBe(2)
  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading notebook runtime…')

  await act(async () => { earlier.reject(new Error('stale fixture state failed')) })
  await flush()
  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading notebook runtime…')
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()

  await act(async () => { current.resolve(runtimeState({ trusted: false })) })
  await flush()
  expect(surface.element.querySelector('.ui-notice-line')).toBeNull()
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test.each([
  { label: 'save', button: 'Save notebook', operation: 'save' },
  { label: 'mutation', button: 'Clear all outputs', operation: 'clear' },
  { label: 'interrupt', button: 'Interrupt', operation: 'interrupt', runtime: { busy: true } },
  { label: 'execution', button: 'Run all', operation: 'runAll' }
])('$label rejection shows its message and releases the initiating busy state', async ({ button: buttonLabel, operation, runtime }) => {
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState(runtime)
    if (params.action === operation) throw new Error(`fixture ${operation} failed`)
    return {}
  })
  await flush()

  const control = button(surface.element, buttonLabel)!
  await act(async () => control.click())
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain(`fixture ${operation} failed`)
  expect(control.disabled).toBe(false)
  expect(surface.element.querySelector('.notebook-cell')).not.toBeNull()
})

test('selection rejection remains visible without discarding the Python environment picker', async () => {
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') return { environments: [{ path: '/fixture/python', name: 'Fixture Python' }] }
    if (params.action === 'select') throw new Error('fixture selection failed')
    return {}
  })
  await flush()
  await act(async () => button(surface.element, 'Select Kernel')!.click())
  await flush()
  const choice = button(surface.element, 'Fixture Python · /fixture/python')
    ?? [...surface.element.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('/fixture/python'))
  expect(choice).toBeDefined()
  await act(async () => choice!.click())
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture selection failed')
  expect(surface.element.querySelector('[aria-label="Python environments"]')).not.toBeNull()
  expect(button(surface.element, 'Browse for Python…')).toBeDefined()
  expect(button(surface.element, 'Cancel')).toBeDefined()
})

test('invalid notebook JSON uses InlineError and opens raw source, while a valid empty notebook stays empty', async () => {
  const views: Record<string, unknown>[] = []
  const context = makeContext()
  const invalid = await renderNotebook(makeBuffer('b1', '[]'), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  }, context, (patch) => views.push(patch))
  await flush()

  expect(invalid.element.querySelector('.ui-inline-error')?.textContent).toBe('Unable to render notebook: notebook JSON root must be an objectOpen raw source')
  expect(invalid.element.querySelector('.ui-empty-state')).toBeNull()
  await act(async () => button(invalid.element, 'Open raw source')!.click())
  await flush()
  expect(views).toEqual([{ mode: 'source' }])
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'mode', data: { value: 'source' } }
  })

  const empty = await renderNotebook(makeBuffer('b2', notebookContent([])), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  expect(empty.element.querySelector('.ui-empty-state')?.textContent).toContain('Empty notebook')
  expect(empty.element.querySelector('.ui-inline-error')).toBeNull()
})

test('malformed image output is a shared error instead of notebook content status', async () => {
  const content = notebookContent([makeCell('print(1)', {
    outputs: [{ output_type: 'display_data', data: { 'image/png': '%%%bad%%%' }, metadata: {} }]
  })])
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('Image output is too large or malformed.')
  expect(surface.element.querySelector('.notebook-cell-outputs [role="status"]')).toBeNull()
})

test('environment discovery has pending, empty, error, retry, browse, and cancel states', async () => {
  const discovery = Promise.withResolvers<unknown>()
  let environmentReads = 0
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') {
      environmentReads += 1
      if (environmentReads === 1) return discovery.promise
      if (environmentReads === 2) throw new Error('fixture environments failed')
      return { environments: [] }
    }
    if (params.action === 'select') return { cancelled: true }
    return {}
  })
  await flush()
  await act(async () => button(surface.element, 'Select Kernel')!.click())

  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading Python environments…')
  await act(async () => { discovery.resolve({ environments: [] }) })
  await flush()
  expect(surface.element.querySelector('[aria-label="Python environments"]')?.textContent).toContain('No Python environments found.')
  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No Python environments found.')
  expect(button(surface.element, 'Browse for Python…')).toBeDefined()
  expect(button(surface.element, 'Cancel')).toBeDefined()
  expect(button(surface.element, 'Retry')).toBeUndefined()

  await act(async () => button(surface.element, 'Cancel')!.click())
  expect(surface.element.querySelector('[aria-label="Python environments"]')).toBeNull()
  await act(async () => button(surface.element, 'Select Kernel')!.click())
  await flush()
  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture environments failed')
  expect(button(surface.element, 'Retry')).toBeDefined()
  expect(button(surface.element, 'Browse for Python…')).toBeDefined()
  expect(button(surface.element, 'Cancel')).toBeDefined()

  await act(async () => button(surface.element, 'Retry')!.click())
  await flush()
  expect(environmentReads).toBe(3)
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
  expect(surface.element.querySelector('.ui-empty-state')?.textContent).toContain('No Python environments found.')

  await act(async () => button(surface.element, 'Browse for Python…')!.click())
  await flush()
  expect(surface.element.querySelector('[aria-label="Python environments"]')).not.toBeNull()
  expect(button(surface.element, 'Cancel')).toBeDefined()
  await act(async () => button(surface.element, 'Cancel')!.click())
  expect(surface.element.querySelector('[aria-label="Python environments"]')).toBeNull()
})

test('a cancelled native environment browse retains the current interpreter and picker', async () => {
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState({ selectedPython: { path: '/fixture/current', name: 'Current Python' } })
    if (params.action === 'environments') return { environments: [{ path: '/fixture/other', name: 'Other Python' }] }
    if (params.action === 'select') return { cancelled: true }
    return {}
  })
  await flush()
  await act(async () => button(surface.element, 'Current Python')!.click())
  await flush()
  await act(async () => button(surface.element, 'Browse for Python…')!.click())
  await flush()

  expect(surface.element.querySelector('[aria-label="Python environments"]')).not.toBeNull()
  expect(button(surface.element, 'Current Python')?.textContent).toContain('Current Python')
  expect(button(surface.element, 'Cancel')).toBeDefined()
})

test('run and setup pending states retain setup errors in the active confirmation', async () => {
  const run = Promise.withResolvers<unknown>()
  const setup = Promise.withResolvers<unknown>()
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    if (params.action === 'runAll') return run.promise
    if (params.action === 'install') return setup.promise
    return {}
  })
  await flush()
  await act(async () => button(surface.element, 'Run all')!.click())
  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Running notebook…')
  await act(async () => { run.resolve({ status: 'missing-ipykernel', externallyManaged: false }) })
  await flush()
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Install ipykernel?')

  await act(async () => button(surface.element, 'Install')!.click())
  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Setting up Python environment…')
  await act(async () => { setup.reject(new Error('fixture setup failed')) })
  await flush()
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Install ipykernel?')
  expect(surface.element.querySelector('[role="dialog"] .ui-inline-error')?.textContent).toContain('fixture setup failed')
})

test('a returned setup failure and venv requirement stay in their corresponding dialogs', async () => {
  let install = true
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    if (params.action === 'runAll') return { status: 'missing-ipykernel', externallyManaged: false }
    if (params.action === 'install' && install) {
      install = false
      return { status: 'failed', error: 'fixture returned setup failure' }
    }
    if (params.action === 'install') return { status: 'venv-required', error: 'fixture requires venv' }
    if (params.action === 'venv') return { status: 'failed', error: 'fixture venv failed' }
    return {}
  })
  await flush()
  await act(async () => button(surface.element, 'Run all')!.click())
  await flush()
  await act(async () => button(surface.element, 'Install')!.click())
  await flush()
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Install ipykernel?')
  expect(surface.element.querySelector('[role="dialog"] .ui-inline-error')?.textContent).toContain('fixture returned setup failure')

  await act(async () => button(surface.element, 'Install')!.click())
  await flush()
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Create a virtual environment?')
  expect(surface.element.querySelector('[role="dialog"] .ui-inline-error')?.textContent).toContain('fixture requires venv')
  await act(async () => button(surface.element, 'Create .venv')!.click())
  await flush()
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Create a virtual environment?')
  expect(surface.element.querySelector('[role="dialog"] .ui-inline-error')?.textContent).toContain('fixture venv failed')
})

test('dead kernel and execution failures are shared errors while notebook output tracebacks remain content', async () => {
  const content = notebookContent([makeCell('print(1)', {
    execution_count: 5,
    outputs: [{ output_type: 'error', ename: 'ValueError', evalue: 'traceback output', traceback: ['line one', 'line two'] }]
  })])
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    if (params.action === 'state') return runtimeState({ trusted: true, kernel: { status: 'dead', error: 'fixture dead' } })
    if (params.action === 'runAll') return { status: 'dead', stderr: 'fixture stderr' }
    return {}
  })
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('The kernel died. fixture dead')
  expect(surface.element.querySelector('.notebook-output')?.textContent).toContain('ValueError: traceback output')
  expect(surface.element.querySelector('.notebook-output')?.textContent).toContain('line two')
  expect(surface.element.querySelector('[aria-label="Execution count"]')?.textContent).toContain('[5]')

  await act(async () => button(surface.element, 'Run all')!.click())
  await flush()
  expect(surface.element.querySelectorAll('.ui-inline-error').length).toBeGreaterThan(0)
  expect([...surface.element.querySelectorAll('.ui-inline-error')].some((item) => item.textContent?.includes('fixture stderr'))).toBe(true)
})
type NotebookControlCase = {
  name: string
  action: string
  data?: Record<string, unknown>
  cells?: Record<string, unknown>[]
  runtime?: Record<string, unknown>
  prepareFind?: boolean
  expectedDaemon?: string
  expectedFields?: Record<string, unknown>
  expectedView?: Record<string, unknown>
}

const validNotebookControls: NotebookControlCase[] = [
  { name: 'save', action: 'save', data: {}, expectedDaemon: 'save' },
  { name: 'save without data', action: 'save', expectedDaemon: 'save' },
  { name: 'mode', action: 'mode', data: { value: 'source' }, expectedView: { mode: 'source' } },
  { name: 'find', action: 'find', data: { query: 'print' } },
  { name: 'find without data', action: 'find' },
  { name: 'find with empty data', action: 'find', data: {} },
  { name: 'close find', action: 'find-close', data: {}, prepareFind: true },
  { name: 'next find match', action: 'find-next', data: {}, prepareFind: true },
  { name: 'previous find match', action: 'find-previous', data: {}, prepareFind: true },
  { name: 'open environments', action: 'environments', data: {}, expectedDaemon: 'environments' },
  { name: 'run all', action: 'run-all', data: {}, expectedDaemon: 'runAll' },
  { name: 'clear all outputs', action: 'clear-all', data: {}, expectedDaemon: 'clear' },
  { name: 'interrupt', action: 'interrupt', data: {}, runtime: { busy: true }, expectedDaemon: 'interrupt' },
  { name: 'restart', action: 'restart', data: {}, runtime: { kernel: { status: 'ready' } }, expectedDaemon: 'restart' },
  { name: 'append cell', action: 'append-cell', data: {}, expectedDaemon: 'insert', expectedFields: { index: 1, position: 'below', cellType: 'code' } },
  { name: 'edit cell', action: 'edit-cell', data: { index: 0, editing: true } },
  { name: 'show outputs', action: 'show-outputs', data: { index: 0 }, cells: [makeCell('print(1)', {
    outputs: Array.from({ length: 21 }, (_, index) => ({ output_type: 'execute_result', data: { 'text/plain': `frame ${index}` } }))
  })] },
  { name: 'clear cell outputs', action: 'clear-cell', data: { index: 0 }, expectedDaemon: 'clear', expectedFields: { index: 0 } },
  { name: 'delete cell', action: 'delete-cell', data: { index: 0 }, expectedDaemon: 'delete', expectedFields: { index: 0 } },
  { name: 'run cell', action: 'run-cell', data: { index: 0, mode: 'advance' }, expectedDaemon: 'run', expectedFields: { index: 0, mode: 'advance' } },
  { name: 'run cell in place', action: 'run-cell', data: { index: 0, mode: 'in-place' }, expectedDaemon: 'run', expectedFields: { index: 0, mode: 'in-place' } },
  { name: 'insert cell', action: 'insert-cell', data: { index: 0, position: 'below', cellType: 'markdown' }, expectedDaemon: 'insert', expectedFields: { index: 0, position: 'below', cellType: 'markdown' } },
  { name: 'insert at cell count', action: 'insert-cell', data: { index: 1, position: 'above', cellType: 'raw' }, expectedDaemon: 'insert', expectedFields: { index: 1, position: 'above', cellType: 'raw' } },
  { name: 'move cell', action: 'move-cell', data: { index: 0, direction: 'down' }, cells: [makeCell('first'), makeCell('second')], expectedDaemon: 'move', expectedFields: { index: 0, direction: 'down' } },
  { name: 'change cell type', action: 'cell-type', data: { index: 0, cellType: 'markdown' }, expectedDaemon: 'type', expectedFields: { index: 0, cellType: 'markdown' } }
]

test.each(validNotebookControls)('public Notebook $name control uses its registered operation', async (scenario) => {
  const context = makeContext()
  const delegated: Record<string, unknown>[] = []
  const views: Record<string, unknown>[] = []
  const cells = scenario.cells ?? [makeCell()]
  const content = notebookContent(cells)
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    delegated.push(params)
    if (params.action === 'state') return runtimeState(scenario.runtime)
    if (params.action === 'environments') return { environments: [] }
    return {}
  }, context, (patch) => views.push(patch))
  await flush()
  if (scenario.prepareFind) {
    expect(await runControl(surface, 'notebook:b1', 'find', { query: 'print' })).toEqual({ delivered: true })
  }

  expect(await runControl(surface, 'notebook:b1', scenario.action, scenario.data)).toEqual({ delivered: true })
  await flush()
  if (scenario.expectedDaemon) {
    expect(delegated.find((params) => params.action === scenario.expectedDaemon)).toMatchObject({
      bufferId: 'b1',
      action: scenario.expectedDaemon,
      ...scenario.expectedFields
    })
  }
  if (scenario.expectedView) expect(views).toContainEqual(scenario.expectedView)
  if (scenario.action === 'find') expect(surface.element.querySelector('[role="search"]')).not.toBeNull()
  if (scenario.action === 'find-close') expect(surface.element.querySelector('[role="search"]')).toBeNull()
  if (scenario.action === 'edit-cell') expect(surface.element.querySelector('textarea.notebook-cell-editor')).not.toBeNull()
  if (scenario.action === 'show-outputs') {
    expect(surface.element.querySelectorAll('pre[data-output-mime="text/plain"]')).toHaveLength(21)
    expect(surface.element.textContent).not.toContain('Showing 20 of 21 output frames.')
  }
})

test('public Notebook paging and output expansion use bounded fixed increments', async () => {
  const cells = Array.from({ length: 101 }, (_, index) => makeCell(`cell-${index + 1}`, { id: `cell-${index + 1}` }))
  const content = notebookContent(cells)
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()

  expect(await runControl(surface, 'notebook:b1', 'page', { direction: 'next' })).toEqual({ delivered: true })
  expect(surface.element.textContent).toContain('Cells 101–101 of 101')
  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('cell-101')
  expect(await runControl(surface, 'notebook:b1', 'page', { direction: 'previous' })).toEqual({ delivered: true })
  expect(surface.element.textContent).toContain('Cells 1–100 of 101')
})

test('Notebook controls reject unknown, extra, forged, mistyped, unsafe-index, and disabled operations', async () => {
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1', notebookContent([makeCell('first'), makeCell('second', { cell_type: 'markdown' })])), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') return { environments: [{ path: '/fixture/python', name: 'Fixture Python' }] }
    return {}
  })
  await flush()
  const address = addressFor(surface, 'notebook:b1')
  const invalid: [string, Record<string, unknown>][] = [
    ['unknown', {}],
    ['save', { forged: true }],
    ['run-all', { yes: true }],
    ['mode', { value: 'rich', trusted: true }],
    ['mode', { value: 'javascript' }],
    ['find', { query: 1 }],
    ['page', { direction: 'next', count: 1000000 }],
    ['page', { direction: 'sideways' }],
    ['edit-cell', { index: -1, editing: true }],
    ['edit-cell', { index: 0.5, editing: true }],
    ['edit-cell', { index: 2, editing: true }],
    ['edit-cell', { index: 0, editing: 'yes' }],
    ['run-cell', { index: 1, mode: 'in-place' }],
    ['run-cell', { index: 0, mode: 'advance', python: '/attacker/python' }],
    ['clear-cell', { index: Number.MAX_SAFE_INTEGER }],
    ['delete-cell', { index: -1 }],
    ['insert-cell', { index: 3, position: 'below', cellType: 'code' }],
    ['insert-cell', { index: 1, position: 'above', cellType: 'python' }],
    ['move-cell', { index: 0, direction: 'up' }],
    ['move-cell', { index: 1, direction: 'down' }],
    ['cell-type', { index: 0, cellType: 'wrong' }],
    ['show-outputs', { index: 1 }]
  ]
  const before = calls.filter((params) => params.action !== 'state').length
  for (const [action, data] of invalid) {
    expect(await runAddress(surface, address, action, data)).toEqual({ delivered: false })
  }
  expect(await runMalformedControl(surface, { ...controlArgs(address, 'save'), data: [] })).toEqual({ delivered: false })
  expect(await runMalformedControl(surface, { ...controlArgs(address, 'save'), extra: true })).toEqual({ delivered: false })
  expect(calls.filter((params) => params.action !== 'state')).toHaveLength(before)

  expect(await runControl(surface, 'notebook:b1', 'environments', {})).toEqual({ delivered: true })
  const environmentAddress = addressFor(surface, 'notebook-environments:b1')
  expect(await runAddress(surface, environmentAddress, 'select', { python: '/attacker/python' })).toEqual({ delivered: false })
})

test('read-only and non-Python notebooks refuse mutations and execution through public controls', async () => {
  const readOnly = await renderNotebook(makeBuffer('ro', notebookContent(), { readOnly: true }), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  expect(await runControl(readOnly, 'notebook:ro', 'save', {})).toEqual({ delivered: false })
  expect(await runControl(readOnly, 'notebook:ro', 'run-all', {})).toEqual({ delivered: false })
  expect(await runControl(readOnly, 'notebook:ro', 'edit-cell', { index: 0, editing: true })).toEqual({ delivered: false })

  const nonPython = await renderNotebook(makeBuffer('js', notebookContent([makeCell()], { kernelspec: { language: 'javascript' } })), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  expect(await runControl(nonPython, 'notebook:js', 'run-all', {})).toEqual({ delivered: false })
  expect(await runControl(nonPython, 'notebook:js', 'run-cell', { index: 0, mode: 'in-place' })).toEqual({ delivered: false })
})

test('untrusted public execution opens a current trust prompt without authorizing work', async () => {
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted: false })
    return {}
  })
  await flush()

  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Run Notebook Code?')
  expect(calls.some(({ action }) => ['trust', 'run', 'runAll', 'install', 'venv'].includes(String(action)))).toBe(false)
  const trustAddress = addressFor(surface, 'notebook-trust:b1')
  expect(trustAddress.actions).toEqual(['confirm', 'cancel'])
  expect(await runAddress(surface, trustAddress, 'cancel', {})).toEqual({ delivered: true })
  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
  expect(calls.some(({ action }) => ['trust', 'run', 'runAll', 'install', 'venv'].includes(String(action)))).toBe(false)
  expect(await runControl(surface, 'notebook:b1', 'run-cell', { index: 0, mode: 'in-place' })).toEqual({ delivered: true })
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Run Notebook Code?')
  expect(calls.some(({ action }) => ['trust', 'run', 'runAll', 'install', 'venv'].includes(String(action)))).toBe(false)
  const runCellTrust = addressFor(surface, 'notebook-trust:b1')
  expect(await runAddress(surface, runCellTrust, 'cancel', {})).toEqual({ delivered: true })
})

test('trusted run requests delegate exact modes and synchronously refuse duplicate confirmations', async () => {
  const trust = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  let trusted = false
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted })
    if (params.action === 'trust') return trust.promise.then(() => {
      trusted = true
      return {}
    })
    if (params.action === 'runAll') return {}
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const address = addressFor(surface, 'notebook-trust:b1')
  const args = controlArgs(address, 'confirm')
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  await act(async () => {
    first = invokePublic(surface, args)
    second = invokePublic(surface, args)
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
  expect(calls.filter(({ action }) => action === 'trust')).toHaveLength(1)
  let results: unknown[] = []
  await act(async () => {
    trust.resolve({})
    results = await Promise.all([first, second])
  })
  expect(results).toContainEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'runAll')).toHaveLength(1)

  const trustedSurface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted: true })
    return {}
  })
  await flush()
  expect(await runControl(trustedSurface, 'notebook:b1', 'run-cell', { index: 0, mode: 'advance' })).toEqual({ delivered: true })
  expect(calls.find((params) => params.action === 'run') ).toMatchObject({ bufferId: 'b1', action: 'run', index: 0, mode: 'advance' })
})

test('environment and setup prompt generations rotate on close and replacement', async () => {
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') return { environments: [] }
    if (params.action === 'runAll') return { status: 'missing-ipykernel' }
    return {}
  })
  await flush()

  expect(await runControl(surface, 'notebook:b1', 'environments', {})).toEqual({ delivered: true })
  const firstPicker = addressFor(surface, 'notebook-environments:b1')
  expect(await runAddress(surface, firstPicker, 'cancel', {})).toEqual({ delivered: true })
  expect(await runControl(surface, 'notebook:b1', 'environments', {})).toEqual({ delivered: true })
  const secondPicker = addressFor(surface, 'notebook-environments:b1')
  expect(secondPicker.generation).not.toBe(firstPicker.generation)
  expect(await runAddress(surface, firstPicker, 'refresh', {})).toEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'environments')).toHaveLength(2)

  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const firstSetup = addressFor(surface, 'notebook-setup:b1')
  expect(await runAddress(surface, firstSetup, 'cancel', {})).toEqual({ delivered: true })
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const secondSetup = addressFor(surface, 'notebook-setup:b1')
  expect(secondSetup.generation).not.toBe(firstSetup.generation)
  expect(await runAddress(surface, firstSetup, 'confirm', {})).toEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'install')).toHaveLength(0)
})

test('trust and setup controls capture interpreter and prompt kind and never accept consent fields', async () => {
  const calls: Record<string, unknown>[] = []
  let trusted = false
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted, selectedPython: { path: '/fixture/selected', name: 'Selected Python' } })
    if (params.action === 'trust') {
      trusted = true
      return {}
    }
    if (params.action === 'runAll') return { status: 'missing-ipykernel', externallyManaged: false }
    if (params.action === 'environments') return { environments: [] }
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const trustAddress = addressFor(surface, 'notebook-trust:b1')
  expect(await runAddress(surface, trustAddress, 'confirm', { trusted: true, yes: true, python: '/attacker/python' })).toEqual({ delivered: false })
  expect(calls.some(({ action }) => action === 'trust')).toBe(false)
  expect(await runAddress(surface, trustAddress, 'confirm', {})).toEqual({ delivered: true })
  expect(calls.some(({ action }) => action === 'runAll')).toBe(true)
  const setupAddress = addressFor(surface, 'notebook-setup:b1')
  expect(await runAddress(surface, setupAddress, 'confirm', { yes: true, python: '/attacker/python' })).toEqual({ delivered: false })
  expect(await runAddress(surface, setupAddress, 'confirm', {})).toEqual({ delivered: true })
  expect(calls.find(({ action }) => action === 'install')).toMatchObject({
    bufferId: 'b1',
    action: 'install',
    python: '/fixture/selected'
  })

  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const secondSetup = addressFor(surface, 'notebook-setup:b1')
  expect(await runAddress(surface, secondSetup, 'another-python', {})).toEqual({ delivered: true })
  expect(calls.some(({ action }) => action === 'venv')).toBe(false)
  expect(surface.element.querySelector('[aria-label="Python environments"]')).not.toBeNull()
})

test('old trust confirmation cannot authorize a replacement buffer', async () => {
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1'), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted: false })
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const oldTrust = addressFor(surface, 'notebook-trust:b1')
  await surface.rerender(makeBuffer('b2'))
  await flush()

  expect(await runAddress(surface, oldTrust, 'confirm', {})).toEqual({ delivered: false })
  expect(calls.some(({ action, bufferId }) => action === 'trust' || action === 'runAll' && bufferId === 'b2')).toBe(false)
  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
})

test('a delayed trust completion after replacement neither runs nor publishes into the new buffer', async () => {
  const trust = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1'), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted: false })
    if (params.action === 'trust') return trust.promise
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const oldTrust = addressFor(surface, 'notebook-trust:b1')
  const pending = invokePublic(surface, controlArgs(oldTrust, 'confirm'))
  await flush()
  expect(calls.filter(({ action }) => action === 'trust')).toHaveLength(1)

  await surface.rerender(makeBuffer('b2'))
  await flush()
  await act(async () => { trust.resolve({}) })
  await pending
  await flush()
  expect(calls.some(({ action, bufferId }) => action === 'runAll' && bufferId === 'b2')).toBe(false)
  expect(surface.element.querySelector('[role="dialog"]')).toBeNull()
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test('output-only refresh preserves trust identity while structural changes disable old index actions', async () => {
  const cells = [makeCell('one', { id: 'one' }), makeCell('two', { id: 'two' })]
  const surface = await renderNotebook(makeBuffer('b1', notebookContent(cells)), async (_method, params) => {
    if (params.action === 'state') return runtimeState({ trusted: false })
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const trustAddress = addressFor(surface, 'notebook-trust:b1')
  const notebookAddress = addressFor(surface, 'notebook:b1')
  const outputOnly = notebookContent([
    makeCell('one', { id: 'one', execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: 'done' }] }),
    makeCell('two', { id: 'two' })
  ])
  await surface.rerender(makeBuffer('b1', outputOnly, { contentRevision: 2 }))
  await flush()
  expect(addressFor(surface, 'notebook-trust:b1').generation).toBe(trustAddress.generation)
  expect(addressFor(surface, 'notebook:b1').generation).toBe(notebookAddress.generation)
  expect(await runAddress(surface, trustAddress, 'cancel', {})).toEqual({ delivered: true })

  const beforeMove = addressFor(surface, 'notebook:b1')
  expect(await runControl(surface, 'notebook:b1', 'move-cell', { index: 0, direction: 'down' })).toEqual({ delivered: true })
  const changed = addressFor(surface, 'notebook:b1')
  expect(changed.generation).not.toBe(beforeMove.generation)
  expect(changed.actions).not.toContain('run-cell')
  expect(await runAddress(surface, beforeMove, 'run-cell', { index: 0, mode: 'in-place' })).toEqual({ delivered: false })
})

test('echoed local drafts keep the notebook address, external replacement and unmount stale it', async () => {
  const submitted: string[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  }, makeContext(), () => {}, (draft) => submitted.push(draft))
  await flush()
  const original = addressFor(surface, 'notebook:b1')
  expect(await runControl(surface, 'notebook:b1', 'edit-cell', { index: 0, editing: true })).toEqual({ delivered: true })
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    setter.call(textarea, 'print("local")')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(await runControl(surface, 'notebook:b1', 'save', {})).toEqual({ delivered: true })
  expect(submitted).toHaveLength(1)
  await surface.rerender(makeBuffer('b1', submitted[0]!, { contentRevision: 2 }))
  await flush()
  expect(addressFor(surface, 'notebook:b1').generation).toBe(original.generation)
  expect(await runAddress(surface, original, 'save', {})).toEqual({ delivered: true })

  await surface.rerender(makeBuffer('b1', notebookContent([makeCell('external replacement')]), { contentRevision: 3 }))
  await flush()
  expect(await runAddress(surface, original, 'save', {})).toEqual({ delivered: false })
  const replacement = addressFor(surface, 'notebook:b1')
  await surface.rerender(makeBuffer('b1', notebookContent([makeCell('external replacement')]), {
    worktreeId: 'wt-notebook-next',
    contentRevision: 4
  }))
  await flush()
  expect(await runAddress(surface, replacement, 'save', {})).toEqual({ delivered: false })
  const worktreeAddress = addressFor(surface, 'notebook:b1')
  await surface.unmount()
  expect(await runAddress(surface, worktreeAddress, 'save', {})).toEqual({ delivered: false })
})

test('Notebook click dispatch uses exact popped-out window and bridge failures retain prompts', async () => {
  const context = makeContext(22)
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted: false })
    return {}
  }, context)
  await flush()
  const ownerHandler = context.windows.get(11)?.handlers.get(EDITOR_UI_CONTROL_COMMAND)
  expect(ownerHandler).toBeDefined()
  await act(async () => button(surface.element, 'Run all')!.click())
  await flush()
  expect(context.calls.slice(-2).map((call) => call.method)).toEqual(['ui.window.self', 'ui.window.command.run'])
  expect(context.commandRoutes).toEqual([22])
  expect(context.calls.at(-1)?.params).toMatchObject({
    connId: 22,
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'run-all' }
  })
  expect(calls.some(({ action }) => action === 'runAll')).toBe(false)
  expect(context.executeCalls).toEqual([])

  context.bridge.error = new Error('fixture bridge failed')
  const dialog = surface.element.querySelector<HTMLElement>('[role="dialog"]')!
  await act(async () => button(dialog, 'Cancel')!.click())
  await flush()
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Run Notebook Code?')
  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture bridge failed')
  expect(calls.some(({ action }) => action === 'trust' || action === 'run')).toBe(false)
})

test.each([
  { label: 'invalid window self identity', identity: null, message: 'The daemon did not identify this window.' },
  { label: 'bridge refusal', bridgeResult: { delivered: false }, message: 'The editor control is no longer available.' },
  { label: 'bridge rejection', bridgeError: new Error('fixture bridge rejected'), message: 'fixture bridge rejected' }
])('$label is surfaced on the initiating Notebook without local fallback', async ({ identity, bridgeResult, bridgeError, message }) => {
  const context = makeContext(22, {
    ...(identity === undefined ? {} : { identity }),
    ...(bridgeResult === undefined ? {} : { bridgeResult }),
    ...(bridgeError === undefined ? {} : { bridgeError })
  })
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  }, context)
  await flush()
  await act(async () => button(surface.element, 'Save notebook')!.click())
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain(message)
  expect(calls.filter(({ action }) => action === 'save')).toHaveLength(0)
  expect(context.executeCalls).toEqual([])
})

test('Notebook exact action data rejects malformed envelope and data records', async () => {
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  const address = addressFor(surface, 'notebook:b1')
  expect(await runMalformedControl(surface, { ...controlArgs(address, 'save'), data: [] })).toEqual({ delivered: false })
  expect(await runMalformedControl(surface, { ...controlArgs(address, 'save'), unexpected: true })).toEqual({ delivered: false })
  expect(await runAddress(surface, address, 'save', { unexpected: true })).toEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'save')).toHaveLength(0)
})

test('code-language formatting preserves indented four-backtick fences exactly outside the opener', () => {
  const source = '  ````\nprint(1)\n  ````'
  const from = source.indexOf('print(1)')
  expect(formatMarkdownSelection(source, 'codeLanguage', { from, to: from }, { language: 'python' }))
    .toBe('  ````python\nprint(1)\n  ````')
})

test('rich eligibility accepts nested supported details and rejects extra attributes', () => {
  const nested = '<details><summary>Outer</summary><details open><summary><h2>Inner</h2></summary>body</details></details>'
  expect(richEligibility(nested, 'nested.md').eligible).toBe(true)
  expect(richEligibility(nested.replace('<details open>', '<details class="wide" open>'), 'nested.md').eligible).toBe(false)
})

test('real Markdown preview retains supported details and strips hostile raw HTML while preserving safe text', () => {
  const source = [
    '## Repeat',
    '',
    '## Repeat',
    '',
    '<details><summary>Outer</summary><details open><summary><h2>Inner</h2></summary>safe nested text</details></details>',
    '',
    '<div onclick="evil()" style="color:red">safe text <a href="javascript:evil()">link text</a></div>',
    '<script>evil()</script>',
    '<svg onload="evil()"><circle /></svg>'
  ].join('\n')
  const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={MARKDOWN_PREVIEW_REHYPE_PLUGINS}>{source}</ReactMarkdown>)

  expect((html.match(/<details/g) ?? []).length).toBe(2)
  expect((html.match(/<summary/g) ?? []).length).toBe(2)
  expect(html).toContain('safe nested text')
  expect(html).toContain('safe text')
  expect(html).toContain('link text')
  expect(html).not.toMatch(/onclick|onload|style=|javascript:|<script|<svg|evil\(\)/i)
  expect(html.match(/<h2/g)?.length).toBe(3)
})

test('preview heading anchors remain unique without assuming rendered HAST ids', () => {
  const markdown = '## Repeat\n\n## Repeat'
  expect(previewHeadingId(markdown, 'repeat')).toBe('markdown-repeat')
  expect(previewHeadingId(markdown, 'repeat-1')).toBe('markdown-repeat-1')
})

test('environment selection accepts only a listed Python path and refreshes before closing', async () => {
  const calls: Record<string, unknown>[] = []
  let stateReads = 0
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') {
      stateReads += 1
      return runtimeState({ selectedPython: stateReads === 1 ? null : { path: '/fixture/python', name: 'Fixture Python' } })
    }
    if (params.action === 'environments') return { environments: [{ path: '/fixture/python', name: 'Fixture Python' }] }
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'environments', {})).toEqual({ delivered: true })
  expect(surface.element.querySelector('[aria-label="Python environments"]')).not.toBeNull()
  const picker = addressFor(surface, 'notebook-environments:b1')
  expect(picker.actions).toEqual(['refresh', 'browse', 'cancel', 'select'])
  expect(await runAddress(surface, picker, 'select', { python: '/fixture/python' })).toEqual({ delivered: true })
  expect(calls.find(({ action }) => action === 'select')).toMatchObject({
    bufferId: 'b1',
    action: 'select',
    python: '/fixture/python'
  })
  expect(stateReads).toBe(2)
  expect(surface.element.querySelector('[aria-label="Python environments"]')).toBeNull()
})

test('delayed environment discovery cannot populate or close a replacement buffer picker', async () => {
  const discovery = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  const context = makeContext()
  const surface = await renderNotebook(makeBuffer('b1'), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') return params.bufferId === 'b1'
      ? discovery.promise
      : { environments: [{ path: '/fixture/b2', name: 'Buffer Two Python' }] }
    return {}
  }, context)
  await flush()
  const notebook = addressFor(surface, 'notebook:b1')
  let pendingDiscovery!: Promise<unknown>
  await act(async () => { pendingDiscovery = invokePublic(surface, controlArgs(notebook, 'environments', {})) })
  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading Python environments…')
  const oldPicker = addressFor(surface, 'notebook-environments:b1')
  await surface.rerender(makeBuffer('b2'))
  await flush()
  expect(await runControl(surface, 'notebook:b2', 'environments', {})).toEqual({ delivered: true })
  const currentPicker = addressFor(surface, 'notebook-environments:b2')
  await act(async () => {
    discovery.resolve({ environments: [{ path: '/fixture/stale', name: 'Stale Python' }] })
    await pendingDiscovery
  })
  await flush()

  expect(addressFor(surface, 'notebook-environments:b2').generation).toBe(currentPicker.generation)
  expect(surface.element.querySelector('[aria-label="Python environments"]')?.textContent).toContain('Buffer Two Python')
  expect(surface.element.textContent).not.toContain('Stale Python')
  expect(await runAddress(surface, oldPicker, 'select', { python: '/fixture/stale' })).toEqual({ delivered: false })
  expect(calls.filter(({ action, bufferId }) => action === 'environments' && bufferId === 'b1')).toHaveLength(1)
})

test('a delayed environment selection cannot close a picker opened by the replacement buffer', async () => {
  const selected = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1'), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') return { environments: [{ path: `/fixture/${params.bufferId}`, name: `Python ${params.bufferId}` }] }
    if (params.action === 'select' && params.bufferId === 'b1') return selected.promise
    return {}
  })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'environments', {})).toEqual({ delivered: true })
  const oldPicker = addressFor(surface, 'notebook-environments:b1')
  const pending = invokePublic(surface, controlArgs(oldPicker, 'select', { python: '/fixture/b1' }))
  await flush()
  await surface.rerender(makeBuffer('b2'))
  await flush()
  expect(await runControl(surface, 'notebook:b2', 'environments', {})).toEqual({ delivered: true })
  const currentPicker = addressFor(surface, 'notebook-environments:b2')
  await act(async () => { selected.resolve({}) })
  await pending
  await flush()

  expect(addressFor(surface, 'notebook-environments:b2').generation).toBe(currentPicker.generation)
  expect(surface.element.querySelector('[aria-label="Python environments"]')?.textContent).toContain('Python b2')
  expect(calls.some(({ action, bufferId }) => action === 'select' && bufferId === 'b2')).toBe(false)
})

test('decisive clicks and custom keys use the registered Notebook operations', async () => {
  const context = makeContext()
  const calls: Record<string, unknown>[] = []
  const cells = Array.from({ length: 101 }, (_, index) => makeCell(`print(${index})`, {
    id: `cell-${index}`,
    ...(index === 0 ? { outputs: Array.from({ length: 21 }, (_, frame) => ({
      output_type: 'execute_result',
      data: { 'text/plain': `frame ${frame}` }
    })) } : {})
  }))
  const views: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1', notebookContent(cells)), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  }, context, (patch) => views.push(patch))
  await flush()
  await act(async () => button(surface.element, 'Source')!.click())
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'mode', data: { value: 'source' } }
  })
  expect(views).toContainEqual({ mode: 'source' })

  await act(async () => button(surface.element, 'Next cells')!.click())
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'page', data: { direction: 'next' } }
  })
  expect(surface.element.textContent).toContain('Cells 101–101 of 101')
  expect(await runControl(surface, 'notebook:b1', 'page', { direction: 'previous' })).toEqual({ delivered: true })
  await act(async () => button(surface.element, 'Show next output frames')!.click())
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'show-outputs', data: { index: 0 } }
  })
  expect(surface.element.querySelectorAll('pre[data-output-mime="text/plain"]')).toHaveLength(21)

  await act(async () => surface.element.querySelector<HTMLElement>('.notebook-cell-source')!.click())
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'edit-cell', data: { index: 0, editing: true } }
  })
  const cellEditor = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')!
  await act(async () => {
    cellEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
  })
  await flush()
  expect(calls.find(({ action }) => action === 'run')).toMatchObject({ bufferId: 'b1', action: 'run', index: 0, mode: 'advance' })

  await act(async () => {
    cellEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  })
  await flush()
  expect(calls.filter(({ action }) => action === 'run').at(-1)).toMatchObject({
    bufferId: 'b1',
    action: 'run',
    index: 0,
    mode: 'in-place'
  })
  await act(async () => button(surface.element, 'Run cell')!.click())
  await flush()
  expect(calls.filter(({ action }) => action === 'run').at(-1)).toMatchObject({
    bufferId: 'b1',
    action: 'run',
    index: 0,
    mode: 'in-place'
  })

  const cellType = surface.element.querySelector<HTMLSelectElement>('select[aria-label="Cell type"]')!
  await act(async () => {
    cellType.value = 'markdown'
    cellType.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'cell-type', data: { index: 0, cellType: 'markdown' } }
  })

  await act(async () => button(surface.element, 'Find')!.click())
  await flush()
  const findInput = surface.element.querySelector<HTMLInputElement>('[role="search"] input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('The input value setter is unavailable.')
  await act(async () => {
    setter.call(findInput, 'print')
    findInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  await act(async () => { findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'find-next' }
  })
  await act(async () => {
    findInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush()
  expect(context.calls.at(-1)?.params).toMatchObject({
    id: EDITOR_UI_CONTROL_COMMAND,
    args: { target: 'notebook:b1', action: 'find-close' }
  })
})

test('a delayed bridge refusal from a replaced Notebook is not published into the replacement', async () => {
  const response = Promise.withResolvers<unknown>()
  const context = makeContext()
  context.bridge.response = response.promise
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1'), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  }, context)
  await flush()

  await act(async () => button(surface.element, 'Save notebook')!.click())
  await flush()
  await surface.rerender(makeBuffer('b2'))
  await flush()
  await act(async () => { response.resolve({ result: { delivered: false } }) })
  await flush()

  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
  expect(calls.some(({ action }) => action === 'save')).toBe(false)
})

test('sandboxed HTML, image frames, ANSI streams, tracebacks, and notebook advisories remain output content', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII='
  const source = Array.from({ length: 201 }, (_, index) => `line ${index}`).join('\n')
  const content = notebookContent([makeCell(source, {
    execution_count: 7,
    outputs: [
      { output_type: 'display_data', data: { 'text/html': '<strong onclick="evil()">safe html</strong><script>evil()</script>' } },
      { output_type: 'display_data', data: { 'image/png': png } },
      { output_type: 'stream', name: 'stdout', text: '\u001b[31mred\u001b[0m' },
      { output_type: 'error', ename: 'ValueError', evalue: 'traceback output', traceback: ['line one', 'line two'] }
    ]
  })])
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    if (params.action === 'state') return runtimeState({ interruptStalled: true })
    return {}
  })
  await flush()

  const htmlFrame = surface.element.querySelector<HTMLIFrameElement>('iframe.notebook-html-output')
  expect(htmlFrame?.getAttribute('sandbox')).toBe('')
  expect(htmlFrame?.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(htmlFrame?.getAttribute('srcdoc')).toContain('safe html')
  expect(htmlFrame?.getAttribute('srcdoc')).toContain("default-src 'none'")
  const image = surface.element.querySelector<HTMLImageElement>('img.notebook-image-output')
  expect(image?.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
  expect(surface.element.querySelector('[data-output-type="stdout"]')?.textContent).toBe('red')
  expect(surface.element.querySelector('[data-output-type="error"]')?.textContent).toContain('ValueError: traceback output')
  expect(surface.element.querySelector('[data-output-type="error"]')?.textContent).toContain('line two')
  expect(surface.element.querySelector('[aria-label="Execution count"]')?.textContent).toContain('[7]')
  expect(surface.element.textContent).toContain('Cell preview limited to 200 lines or 64 KiB.')
  expect(surface.element.textContent).toContain('Not responding. Restart kernel.')
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
})

test('accepted trusted runs expose shared pending state and refuse duplicate submissions synchronously', async () => {
  const run = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'runAll') return run.promise
    return {}
  })
  await flush()
  const address = addressFor(surface, 'notebook:b1')
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  await act(async () => {
    first = invokePublic(surface, controlArgs(address, 'run-all'))
    second = invokePublic(surface, controlArgs(address, 'run-all'))
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()

  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Running notebook…')
  expect(calls.filter(({ action }) => action === 'runAll')).toHaveLength(1)
  let results: unknown[] = []
  await act(async () => {
    run.resolve({})
    results = await Promise.all([first, second])
  })
  expect(results).toContainEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'runAll')).toHaveLength(1)
})
