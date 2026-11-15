import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
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

const NativeResponse = globalThis.Response

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
  if (scenario.action === 'show-outputs') {
    expect(surface.element.querySelectorAll('pre[data-output-mime="text/plain"]')).toHaveLength(20)
    expect(surface.element.querySelector('[role="status"]')?.textContent).toBe('Showing 20 of 21 output frames.')
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

test('a captured trust confirmation refuses a same-buffer read-only cutover', async () => {
  let trusted = false
  const calls: Record<string, unknown>[] = []
  const buffer = makeBuffer()
  const surface = await renderNotebook(buffer, async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted })
    if (params.action === 'trust') trusted = true
    return {}
  })
  expect(await runControl(surface, 'notebook:b1', 'run-all')).toEqual({ delivered: true })
  const trust = addressFor(surface, 'notebook-trust:b1')
  await surface.rerender({ ...buffer, readOnly: true })
  expect(await runAddress(surface, trust, 'confirm')).toEqual({ delivered: false })
  expect(calls.filter(({ action }) => ['trust', 'run', 'runAll', 'install', 'venv'].includes(String(action)))).toEqual([])
})

test('an already-issued trust call cannot execute after a same-buffer read-only cutover', async () => {
  const gate = Promise.withResolvers<unknown>()
  let trusted = false
  const calls: Record<string, unknown>[] = []
  const buffer = makeBuffer()
  const surface = await renderNotebook(buffer, async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted })
    if (params.action === 'trust') {
      await gate.promise
      trusted = true
    }
    return {}
  })
  expect(await runControl(surface, 'notebook:b1', 'run-all')).toEqual({ delivered: true })
  const trust = addressFor(surface, 'notebook-trust:b1')
  let pending!: Promise<unknown>
  await act(async () => { pending = invokePublic(surface, controlArgs(trust, 'confirm')) })
  await flush()
  expect(calls.filter(({ action }) => action === 'trust')).toHaveLength(1)
  await surface.rerender({ ...buffer, readOnly: true })
  let result: unknown
  await act(async () => { gate.resolve({}); result = await pending })
  expect(result).toEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'trust')).toHaveLength(1)
  expect(calls.filter(({ action }) => ['run', 'runAll', 'install', 'venv'].includes(String(action)))).toEqual([])
})

test.each(['pending', 'failed'] as const)('Clear all outputs remains usable during a %s runtime read', async (phase) => {
  const state = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') {
      if (phase === 'pending') return state.promise
      throw new Error('fixture state failed')
    }
    return {}
  })
  try {
    await flush()
    expect(addressFor(surface, 'notebook:b1').actions).toContain('clear-all')
    const clear = button(surface.element, 'Clear all outputs')!
    expect(clear.disabled).toBe(false)
    await act(async () => clear.click())
    await flush()
    expect(calls.filter(({ action }) => action === 'clear')).toEqual([{ bufferId: 'b1', action: 'clear' }])
    expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('print(1)')
    if (phase === 'pending') {
      expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading notebook runtime…')
    } else {
      expect(surface.element.querySelector('.ui-inline-error')?.textContent).toContain('fixture state failed')
    }
  } finally {
    await act(async () => { state.resolve(runtimeState()) })
  }
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

test('unacknowledged external drafts invalidate notebook and trust controls and discard cell edits', async () => {
  const cells = [makeCell('first source', { id: 'first' }), makeCell('second source', { id: 'second' })]
  const content = notebookContent(cells)
  const externalDraft = notebookContent([cells[1]!, cells[0]!])
  const calls: Record<string, unknown>[] = []
  const submitted: string[] = []
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({ trusted: false })
    return {}
  }, makeContext(), () => {}, (draft) => submitted.push(draft))
  await flush()

  const notebook = addressFor(surface, 'notebook:b1')
  expect(await runControl(surface, 'notebook:b1', 'edit-cell', { index: 0, editing: true })).toEqual({ delivered: true })
  const editor = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    setter.call(editor, 'print("unacknowledged")')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(await runControl(surface, 'notebook:b1', 'run-cell', { index: 0, mode: 'in-place' })).toEqual({ delivered: true })
  const trust = addressFor(surface, 'notebook-trust:b1')

  await surface.rerender(makeBuffer('b1', content, { draft: externalDraft, contentRevision: 2 }))
  await flush()
  const replacement = addressFor(surface, 'notebook:b1')
  expect(replacement.generation).not.toBe(notebook.generation)
  expect(await runAddress(surface, notebook, 'save', {})).toEqual({ delivered: false })
  expect(await runAddress(surface, trust, 'confirm', {})).toEqual({ delivered: false })
  expect(calls.some(({ action }) => action === 'trust' || action === 'run')).toBe(false)
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBeNull()
  expect(surface.element.textContent).toContain('second source')
  expect(surface.element.textContent).not.toContain('unacknowledged')
  expect(await runAddress(surface, replacement, 'save', {})).toEqual({ delivered: true })
  expect(submitted).toEqual([])
})

test('unacknowledged external drafts invalidate setup confirmation', async () => {
  const cells = [makeCell('first source', { id: 'first' }), makeCell('second source', { id: 'second' })]
  const content = notebookContent(cells)
  const externalDraft = notebookContent([cells[1]!, cells[0]!])
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'runAll') return { status: 'missing-ipykernel', externallyManaged: false }
    return {}
  })
  await flush()
  const notebook = addressFor(surface, 'notebook:b1')
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const setup = addressFor(surface, 'notebook-setup:b1')

  await surface.rerender(makeBuffer('b1', content, { draft: externalDraft, contentRevision: 2 }))
  await flush()
  const replacement = addressFor(surface, 'notebook:b1')
  expect(replacement.generation).not.toBe(notebook.generation)
  expect(await runAddress(surface, notebook, 'save', {})).toEqual({ delivered: false })
  expect(await runAddress(surface, setup, 'confirm', {})).toEqual({ delivered: false })
  expect(calls.some(({ action }) => action === 'install' || action === 'venv')).toBe(false)
})

test('same-type no-ops are refused without locking index controls; no-ID move acknowledgements recover safely', async () => {
  const content = notebookContent([makeCell('only cell')])
  const noOpCalls: Record<string, unknown>[] = []
  const noOpTypeSurface = await renderNotebook(makeBuffer('noop', content), async (_method, params) => {
    noOpCalls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  const beforeNoOp = addressFor(noOpTypeSurface, 'notebook:noop')
  expect(beforeNoOp.actions).toContain('cell-type')
  expect(await runControl(noOpTypeSurface, 'notebook:noop', 'cell-type', { index: 0, cellType: 'code' }))
    .toEqual({ delivered: false })
  const afterNoOp = addressFor(noOpTypeSurface, 'notebook:noop')
  expect(afterNoOp.generation).toBe(beforeNoOp.generation)
  expect(afterNoOp.actions).toContain('cell-type')
  expect(noOpCalls.filter(({ action }) => action === 'type')).toEqual([])

  const noIdCells = [makeCell('first'), makeCell('second')]
  const beforeMoveContent = notebookContent(noIdCells)
  const moveSurface = await renderNotebook(makeBuffer('move', beforeMoveContent), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  const beforeMove = addressFor(moveSurface, 'notebook:move')
  expect(await runControl(moveSurface, 'notebook:move', 'move-cell', { index: 0, direction: 'down' }))
    .toEqual({ delivered: true })
  const pendingMove = addressFor(moveSurface, 'notebook:move')
  expect(pendingMove.actions).not.toContain('move-cell')
  await moveSurface.rerender(makeBuffer('move', notebookContent([noIdCells[1]!, noIdCells[0]!]), { contentRevision: 2 }))
  await flush()
  const acknowledgedMove = addressFor(moveSurface, 'notebook:move')
  expect(acknowledgedMove.actions).toContain('move-cell')
  expect(await runAddress(moveSurface, beforeMove, 'move-cell', { index: 0, direction: 'down' }))
    .toEqual({ delivered: false })
  expect(await runAddress(moveSurface, pendingMove, 'move-cell', { index: 0, direction: 'down' }))
    .toEqual({ delivered: false })
})

test('read-only notebooks can page cells and reveal additional output frames', async () => {
  const cells = Array.from({ length: 101 }, (_, index) => makeCell(`cell-${index + 1}`, {
    id: `cell-${index + 1}`,
    outputs: index === 0
      ? Array.from({ length: 21 }, (_, frame) => ({ output_type: 'execute_result', data: { 'text/plain': `frame ${frame}` } }))
      : []
  }))
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('readonly', notebookContent(cells), { readOnly: true }), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  })
  await flush()
  const address = addressFor(surface, 'notebook:readonly')
  expect(address.actions).not.toContain('save')
  expect(address.actions).not.toContain('run-all')
  expect(address.actions).not.toContain('clear-all')
  expect(address.actions).not.toContain('append-cell')
  expect(address.actions).not.toContain('edit-cell')
  expect(address.actions).not.toContain('delete-cell')
  expect(address.actions).not.toContain('cell-type')
  expect(address.actions).not.toContain('insert-cell')
  expect(address.actions).not.toContain('move-cell')
  expect(address.actions).not.toContain('clear-cell')
  expect(address.actions).not.toContain('run-cell')
  expect(address.actions).toContain('page')
  expect(address.actions).toContain('show-outputs')
  expect(await runAddress(surface, address, 'page', { direction: 'next' })).toEqual({ delivered: true })
  expect(surface.element.textContent).toContain('Cells 101–101 of 101')
  expect(await runAddress(surface, addressFor(surface, 'notebook:readonly'), 'page', { direction: 'previous' }))
    .toEqual({ delivered: true })
  expect(surface.element.textContent).toContain('Cells 1–100 of 101')
  expect(surface.element.querySelectorAll('pre[data-output-mime="text/plain"]')).toHaveLength(20)
  expect(await runAddress(surface, addressFor(surface, 'notebook:readonly'), 'show-outputs', { index: 0 }))
    .toEqual({ delivered: true })
  expect(surface.element.querySelectorAll('pre[data-output-mime="text/plain"]')).toHaveLength(21)
  expect(calls.filter(({ action }) => action !== 'state')).toEqual([])
})

test('trust confirmation runs once with its fresh runtime despite an earlier deferred change read', async () => {
  const deferredChange = Promise.withResolvers<unknown>()
  const context = makeContext()
  const calls: Record<string, unknown>[] = []
  let stateReads = 0
  let trusted = false
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') {
      stateReads += 1
      if (stateReads === 1) return runtimeState({ trusted: false })
      if (stateReads === 2) return deferredChange.promise
      return runtimeState({ trusted })
    }
    if (params.action === 'trust') {
      trusted = true
      return {}
    }
    return {}
  }, context)
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const trust = addressFor(surface, 'notebook-trust:b1')
  await act(async () => {
    for (const listener of context.subscribers) listener({ type: 'quirky.editor/changed' })
  })
  await flush()

  expect(await runAddress(surface, trust, 'confirm', {})).toEqual({ delivered: true })
  expect(calls.filter(({ action }) => action === 'runAll')).toHaveLength(1)
  expect(calls.filter(({ action }) => action === 'trust')).toHaveLength(1)
  await act(async () => { deferredChange.resolve(runtimeState({ trusted: false })) })
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  expect(calls.filter(({ action }) => action === 'runAll')).toHaveLength(2)
  expect(calls.filter(({ action }) => action === 'trust')).toHaveLength(1)
})

test('missing-ipykernel setup captures the interpreter selected during kernel preparation', async () => {
  const context = makeContext()
  const calls: Record<string, unknown>[] = []
  let selectedPython: string | null = null
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState({
      selectedPython: selectedPython === null ? null : { path: selectedPython, name: selectedPython }
    })
    if (params.action === 'runAll') {
      selectedPython = '/fixture/python-A'
      return { status: 'missing-ipykernel', externallyManaged: false }
    }
    return {}
  }, context)
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'run-all', {})).toEqual({ delivered: true })
  const setup = addressFor(surface, 'notebook-setup:b1')
  expect(surface.element.querySelector('[role="dialog"]')?.textContent).toContain('Install ipykernel?')

  selectedPython = '/fixture/python-B'
  await act(async () => {
    for (const listener of context.subscribers) listener({ type: 'quirky.editor/changed' })
  })
  await flush()
  expect(addressFor(surface, 'notebook-setup:b1').generation).toBe(setup.generation)
  expect(await runAddress(surface, setup, 'confirm', {})).toEqual({ delivered: true })
  expect(calls.find(({ action }) => action === 'install')).toMatchObject({
    bufferId: 'b1',
    action: 'install',
    python: '/fixture/python-A'
  })
  expect(calls.some(({ action, python }) => action === 'install' && python === '/fixture/python-B')).toBe(false)
  expect(calls.some(({ action }) => action === 'venv')).toBe(false)
})

test('a cancelled discovery rejection cannot publish into a reopened environment picker', async () => {
  const delayedDiscovery = Promise.withResolvers<unknown>()
  const calls: Record<string, unknown>[] = []
  let environmentReads = 0
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    if (params.action === 'environments') {
      environmentReads += 1
      if (environmentReads === 1) return delayedDiscovery.promise
      return { environments: [{ path: '/fixture/current', name: 'Current Python' }] }
    }
    return {}
  })
  await flush()
  await act(async () => { button(surface.element, 'Select Kernel')!.click() })
  await flush()
  const oldPicker = addressFor(surface, 'notebook-environments:b1')
  expect(surface.element.querySelector('.ui-notice-line')?.textContent).toContain('Loading Python environments…')
  expect(await runAddress(surface, oldPicker, 'cancel', {})).toEqual({ delivered: true })
  await act(async () => { button(surface.element, 'Select Kernel')!.click() })
  await flush()
  const currentPicker = addressFor(surface, 'notebook-environments:b1')

  await act(async () => { delayedDiscovery.reject(new Error('obsolete discovery failed')) })
  await flush()
  expect(addressFor(surface, 'notebook-environments:b1').generation).toBe(currentPicker.generation)
  expect(surface.element.querySelector('[aria-label="Python environments"]')?.textContent).toContain('Current Python')
  expect(surface.element.querySelector('[aria-label="Python environments"]')).not.toBeNull()
  expect(surface.element.querySelector('.ui-inline-error')).toBeNull()
  expect(calls.filter(({ action }) => action === 'environments')).toHaveLength(2)
})

 
test('raw notebook draft acknowledgements preserve source editor focus and selection', async () => {
  const content = notebookContent([makeCell('print(1)')])
  const draft = content.replace('print(1)', 'print(2)')
  const submitted: string[] = []
  let surface!: Mounted
  let echo!: Promise<void>
  let revision = 1
  surface = await renderNotebook(makeBuffer('raw', content, { mode: 'source' }), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  }, makeContext(), () => {}, (value) => {
    submitted.push(value)
    echo = surface.rerender(makeBuffer('raw', content, { mode: 'source', draft: value, contentRevision: ++revision }))
  })
  await flush()
  const originalAddress = addressFor(surface, 'notebook:raw')
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-source')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    textarea.focus()
    setter.call(textarea, draft)
    textarea.setSelectionRange(10, 12)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await echo
  })
  await flush()
  expect(submitted).toEqual([draft])
  expect(addressFor(surface, 'notebook:raw').generation).toBe(originalAddress.generation)
  const echoed = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-source')
  expect(echoed).toBe(textarea)
  expect(echoed?.value).toBe(draft)
  expect(document.activeElement).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([10, 12])
})

test('two outstanding cell draft acknowledgements preserve the current typing session', async () => {
  const submitted: string[] = []
  const surface = await renderNotebook(makeBuffer(), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  }, makeContext(), () => {}, (draft) => submitted.push(draft))
  await flush()
  const originalAddress = addressFor(surface, 'notebook:b1')
  expect(await runControl(surface, 'notebook:b1', 'edit-cell', { index: 0, editing: true })).toEqual({ delivered: true })
  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-cell-editor')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('The textarea value setter is unavailable.')

  await act(async () => {
    setter.call(textarea, 'print("first draft")')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(await runControl(surface, 'notebook:b1', 'save', {})).toEqual({ delivered: true })
  await act(async () => {
    setter.call(textarea, 'print("second draft")')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(await runControl(surface, 'notebook:b1', 'save', {})).toEqual({ delivered: true })
  expect(submitted).toHaveLength(2)

  textarea.focus()
  textarea.setSelectionRange(7, 11)
  await surface.rerender(makeBuffer('b1', notebookContent(), { draft: submitted[0]!, contentRevision: 2 }))
  await flush()
  expect(addressFor(surface, 'notebook:b1').generation).toBe(originalAddress.generation)
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 11])

  await surface.rerender(makeBuffer('b1', notebookContent(), { draft: submitted[1]!, contentRevision: 3 }))
  await flush()
  expect(addressFor(surface, 'notebook:b1').generation).toBe(originalAddress.generation)
  expect(surface.element.querySelector('textarea.notebook-cell-editor')).toBe(textarea)
  expect(document.activeElement).toBe(textarea)
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 11])
})

test('a locally acknowledged raw reorder stales earlier rich cell addresses', async () => {
  const cells = [makeCell('first cell'), makeCell('second cell')]
  const content = notebookContent(cells)
  const reordered = notebookContent([cells[1]!, cells[0]!])
  const submitted: string[] = []
  const calls: Record<string, unknown>[] = []
  const surface = await renderNotebook(makeBuffer('b1', content), async (_method, params) => {
    calls.push(params)
    if (params.action === 'state') return runtimeState()
    return {}
  }, makeContext(), () => {}, (draft) => submitted.push(draft))
  await flush()
  const richAddress = addressFor(surface, 'notebook:b1')
  expect(richAddress.actions).toContain('run-cell')
  expect(await runControl(surface, 'notebook:b1', 'mode', { value: 'source' })).toEqual({ delivered: true })
  await surface.rerender(makeBuffer('b1', content, { mode: 'source' }))
  await flush()

  const textarea = surface.element.querySelector<HTMLTextAreaElement>('textarea.notebook-source')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('The textarea value setter is unavailable.')
  await act(async () => {
    setter.call(textarea, reordered)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(submitted).toEqual([reordered])
  await surface.rerender(makeBuffer('b1', content, { mode: 'source', draft: reordered, contentRevision: 2 }))
  await flush()
  expect(await runControl(surface, 'notebook:b1', 'mode', { value: 'rich' })).toEqual({ delivered: true })
  await surface.rerender(makeBuffer('b1', reordered, { mode: 'rich', contentRevision: 2 }))
  await flush()

  expect(surface.element.querySelector('.notebook-cell-source')?.textContent).toBe('second cell')
  expect(addressFor(surface, 'notebook:b1').generation).not.toBe(richAddress.generation)
  expect(await runAddress(surface, richAddress, 'run-cell', { index: 0, mode: 'in-place' }))
    .toEqual({ delivered: false })
  expect(calls.filter(({ action }) => action === 'run')).toEqual([])
})

async function runMermaidScenario(code: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'quirky-mermaid-test-'))
  try {
    const child = Bun.spawn([process.execPath, '-'], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, QUIRKY_HOME: home },
      stdin: new TextEncoder().encode(code), stdout: 'pipe', stderr: 'pipe'
    })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (status !== 0) throw new Error('Isolated Mermaid scenario failed (' + status + '):\n' + stdout + '\n' + stderr)
  } finally { await rm(home, { recursive: true, force: true }) }
}

test('Mermaid public retry preserves duplicate targets, stale sessions and inherited Markdown scope', async () => {
  await runMermaidScenario(String.raw`import assert from 'node:assert/strict'
import React, { act } from 'react'
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
document.insertBefore(document.implementation.createDocumentType('html', '', ''), document.documentElement)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const requests = [], initializations = []
mock.module('mermaid', () => ({ default: {
  initialize(options) { initializations.push(options) },
  render(id, source) { const pending = Promise.withResolvers(); requests.push({ id, source, ...pending }); return pending.promise }
} }))
const { createRoot } = await import('react-dom/client')
const { MermaidDiagram } = await import('./src/markdown/MermaidDiagram')
const { MarkdownSurface } = await import('./src/markdown/MarkdownSurface')
const { activate, deactivate } = await import('./src/ui')
const controls = await import('./src/window/uiControl')
const handlers = new Map(), calls = []
let bridgeFailure = null, bridgeGate = null, refusal = false, self = 22, ownerCommands = 0
const windows = new Map([[11, new Map([[controls.EDITOR_UI_CONTROL_COMMAND, () => { ownerCommands += 1; return { delivered: true } }]])], [22, handlers]])
const context = {
  pluginId: 'quirky.editor',
  provide: (id, handler) => handlers.set(id, handler), subscribe: () => () => {}, getSetting: () => 300, getLayout: () => ({}), toast() {},
  executeCommand() { throw Error('Owner-window dispatch is forbidden') },
  async call(method, params) {
    calls.push({ method, params })
    if (method === 'ui.window.self') return { connId: self }
    if (method === 'ui.window.command.run') {
      assert.equal(params.connId, 22)
      if (bridgeGate) return await bridgeGate.promise
      if (bridgeFailure) throw bridgeFailure
      return { result: refusal ? { delivered: false } : await windows.get(params.connId).get(params.id)(params.args) }
    }
    if (method === 'quirky.editor/markdown') {
      if (params.action === 'capabilities') return { previewAvailable: true, imageUrls: {} }
      if (params.action === 'toc') return { headings: [] }
    }
    if (method === 'quirky.editor/notes') return { notes: [] }
    return {}
  }
}
activate(context)
const host = document.createElement('div'); document.body.append(host)
const root = createRoot(host)
let report
const scope = controls.createEditorUiControlReportScope(value => report = value, { surface: 'view:quirky.editor/document', context })
scope.report({ mounted: true, bufferId: 'md' })
const render = async node => act(async () => root.render(React.createElement(controls.EditorUiControlProvider, { scope }, node)))
const diagrams = source => React.createElement(React.Fragment, null, React.createElement(MermaidDiagram, { source, key: 'first' }), React.createElement(MermaidDiagram, { source, key: 'second' }))
const invoke = (address, action = 'retry', data) => handlers.get(controls.EDITOR_UI_CONTROL_COMMAND)({ surface: address.surface, target: address.target, generation: address.generation, action, ...(data === undefined ? {} : { data }) })
const addresses = () => report.uiControls.filter(address => address.target.startsWith('markdown-mermaid:'))
const fail = async (request, message = 'fixture diagram failed') => act(async () => request.reject(Error(message)))
const finish = async (request, svg) => act(async () => request.resolve({ svg }))
try {
  const maliciousSource = 'graph TD; A[<script>fixture</script>] --> B'
  await render(diagrams(maliciousSource))
  assert.equal(addresses().length, 2)
  assert.notEqual(addresses()[0].target, addresses()[1].target)
  for (const address of addresses()) assert.match(address.target, /^markdown-mermaid:[1-9][0-9]*$/)
  assert.equal(host.querySelectorAll('.ui-notice-line').length, 2)
  assert.equal(host.querySelector('.ui-notice-line').textContent, 'Rendering diagram…')
  const first = addresses()[0], second = addresses()[1]
  assert.deepEqual(await invoke(second), { delivered: false })
  await fail(requests[0]); await fail(requests[1])
  assert.equal(host.querySelectorAll('.ui-inline-error').length, 2)
  assert.equal(host.querySelector('.ui-inline-error').textContent, 'Mermaid preview failed. fixture diagram failedRetry')
  assert.equal(host.querySelector('details pre').textContent, maliciousSource)
  assert.equal(host.querySelector('details script'), null)
  assert.deepEqual(await invoke(second, 'unknown'), { delivered: false })
  assert.deepEqual(await invoke(second, 'retry', { yes: true }), { delivered: false })
  assert.deepEqual(await invoke(second, 'retry', []), { delivered: false })
  calls.length = 0
  await act(async () => host.querySelectorAll('.ui-inline-error button')[1].click())
  assert.deepEqual(calls.map(call => call.method), ['ui.window.self', 'ui.window.command.run'])
  assert.equal(calls[1].params.id, 'command:quirky.editor/ui-control')
  assert.equal(calls[1].params.args.target, second.target)
  assert.equal(requests.length, 3)
  assert.equal(host.querySelectorAll('.ui-inline-error').length, 1)
  assert.equal(host.querySelectorAll('.ui-notice-line').length, 1)
  assert.equal(addresses()[1].generation, second.generation)
  await finish(requests[2], '<svg><text>safe second</text></svg>')
  assert.equal(host.querySelector('[role="img"]').getAttribute('aria-label'), 'Mermaid diagram')
  assert.equal(host.querySelector('[role="img"]').textContent, 'safe second')
  assert.deepEqual(await invoke(second), { delivered: false })
  bridgeFailure = Error('fixture bridge failed')
  await act(async () => host.querySelector('.ui-inline-error button').click())
  assert.match(host.querySelector('.ui-inline-error').textContent, /fixture bridge failed/)
  assert.equal(requests.length, 3)
  bridgeFailure = null; refusal = true
  await act(async () => host.querySelector('.ui-inline-error button').click())
  assert.match(host.querySelector('.ui-inline-error').textContent, /The editor control is no longer available\./)
  assert.equal(requests.length, 3)
  refusal = false; self = 0
  await act(async () => host.querySelector('.ui-inline-error button').click())
  assert.match(host.querySelector('.ui-inline-error').textContent, /The daemon did not identify this window/)
  assert.equal(requests.length, 3)
  self = 22
  let duplicate
  await act(async () => { const one = invoke(first); const two = invoke(first); duplicate = await Promise.all([one, two]) })
  assert.deepEqual(duplicate, [{ delivered: true }, { delivered: false }])
  assert.equal(requests.length, 4)
  await render(diagrams('graph TD; New-->Source'))
  assert.deepEqual(await invoke(first), { delivered: false })
  const replacement = addresses()[0]
  await finish(requests[3], '<svg><text>stale source</text></svg>')
  assert.equal(host.textContent.includes('stale source'), false)
  await finish(requests[4], '<svg><text>new first</text></svg>'); await finish(requests[5], '<svg><text>new second</text></svg>')
  document.documentElement.style.setProperty('--ui-text', '#111111')
  await act(async () => document.documentElement.setAttribute('data-theme', 'light'))
  assert.notEqual(addresses()[0].generation, replacement.generation)
  assert.deepEqual(await invoke(replacement), { delivered: false })
  const light = addresses()[0]
  await act(async () => document.documentElement.setAttribute('data-theme', 'dark'))
  assert.notEqual(addresses()[0].generation, light.generation)
  await finish(requests[6], '<svg><text>stale light</text></svg>')
  assert.equal(host.textContent.includes('stale light'), false)
  assert.ok(initializations.every(options => options.securityLevel === 'strict' && options.theme === 'base' && options.startOnLoad === false))
  assert.ok(initializations.every(options => typeof options.themeVariables.textColor === 'string'))
  const old = addresses()[0]
  const markdown = '\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n'
  const buffer = { id: 'md', worktreeId: 'wt', root: '/fixture', path: '/fixture/readme.md', relativePath: 'readme.md', name: 'readme.md', kind: 'markdown', content: markdown, draft: null, baseline: null, size: markdown.length, readOnly: false, dirty: false, external: null, mode: 'preview', tabId: 'tab', preview: false, pinned: false, untitled: false, revision: 1, contentRevision: 1, view: {}, error: null, diskContentLength: null, diskContentBytes: null, diskSignature: null }
  await render(React.createElement(MarkdownSurface, { context, buffer, fontSize: 13, onDraft() {}, onAction: context.call, onView() {}, registerCommandHandlers: () => () => {} }))
  assert.equal(addresses().length, 2)
  assert.notEqual(addresses()[0].target, addresses()[1].target)
  assert.notEqual(addresses()[0].target, old.target)
  assert.deepEqual(await invoke(old), { delivered: false })
  assert.equal(report.bufferId, 'md')
  const last = requests.slice(-2)
  await fail(last[0]); await fail(last[1])
  const beforeRetry = requests.length
  await act(async () => host.querySelectorAll('.ui-inline-error button')[1].click())
  assert.equal(requests.length, beforeRetry + 1)
  assert.equal(host.querySelectorAll('.ui-inline-error').length, 1)
  await fail(requests.at(-1))
  assert.match(host.querySelectorAll('.ui-inline-error')[1].textContent, /fixture diagram failed/)
  bridgeGate = Promise.withResolvers()
  await act(async () => host.querySelector('.ui-inline-error button').click())
  await render(diagrams('graph TD; Replacement-->Current'))
  bridgeGate.reject(Error('expired bridge failure'))
  await act(async () => {})
  assert.equal(host.textContent.includes('expired bridge failure'), false)
  assert.equal(host.querySelectorAll('.ui-notice-line').length, 2)
  assert.equal(ownerCommands, 0)
  const unmounted = addresses()[0]
  await act(async () => root.unmount()); scope.dispose()
  assert.deepEqual(await invoke(unmounted), { delivered: false })
  for (const request of requests) request.resolve({ svg: '<svg><text>after unmount</text></svg>' })
  await act(async () => {})
  assert.equal(host.textContent, '')
  console.log('Mermaid lifecycle, exact-window controls and inherited Markdown scope passed')
} finally {
  if (host.textContent) await act(async () => root.unmount())
  scope.dispose(); deactivate(); await GlobalRegistrator.unregister()
}
`)
}, 30_000)

test('Mermaid retries rejected lazy imports without leaking renderer mocks into other tests', async () => {
  await runMermaidScenario(String.raw`import assert from 'node:assert/strict'
import React, { act } from 'react'
import { mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register(); globalThis.IS_REACT_ACT_ENVIRONMENT = true
mock.module('mermaid', async () => { throw Error('fixture import failed') })
const { createRoot } = await import('react-dom/client')
const { MermaidDiagram } = await import('./src/markdown/MermaidDiagram')
const { activate, deactivate } = await import('./src/ui')
const controls = await import('./src/window/uiControl')
const handlers = new Map()
const context = {
  pluginId: 'quirky.editor', provide: (id, handler) => handlers.set(id, handler), subscribe: () => () => {}, getSetting: () => 300, getLayout: () => ({}), toast() {},
  async call(method, params) {
    if (method === 'ui.window.self') return { connId: 22 }
    if (method === 'ui.window.command.run') return { result: await handlers.get(params.id)(params.args) }
    return {}
  }
}
activate(context)
const host = document.createElement('div'); const root = createRoot(host)
const scope = controls.createEditorUiControlReportScope(undefined, { surface: 'view:quirky.editor/document', context })
try {
  await act(async () => root.render(React.createElement(controls.EditorUiControlProvider, { scope }, React.createElement(MermaidDiagram, { source: 'graph TD; A-->B' }))))
  assert.match(host.querySelector('.ui-inline-error').textContent, /Mermaid preview failed\. fixture import failed/)
  await act(async () => host.querySelector('.ui-inline-error button').click())
  assert.match(host.querySelector('.ui-inline-error').textContent, /fixture import failed/)
  mock.module('mermaid', () => ({ default: { initialize() {}, render: async () => ({ svg: '<svg><text>retry imported</text></svg>' }) } }))
  await act(async () => host.querySelector('.ui-inline-error button').click())
  assert.equal(host.querySelector('[role="img"]').textContent, 'retry imported')
  assert.equal(host.querySelector('.ui-inline-error'), null)
  console.log('Rejected Mermaid import cache released; repeated failure and later import retry passed')
} finally {
  await act(async () => root.unmount()); scope.dispose(); deactivate(); await GlobalRegistrator.unregister()
}
`)
}, 30_000)

test.skipIf(!existsSync(chromium.executablePath()))('Notebook and Mermaid sanitize active output in a real browser and retain shared token themes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'quirky-mermaid-browser-'))
  const editorRoot = resolve(import.meta.dir, '..')
  let browser: Browser | undefined
  let server: Bun.Server<undefined> | undefined
  try {
    const entrypoint = join(scratch, 'entry.tsx')
    await Bun.write(entrypoint, `
      import React from ${JSON.stringify(Bun.resolveSync('react', editorRoot))}
      import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', editorRoot))}
      import { MermaidDiagram } from ${JSON.stringify(join(editorRoot, 'src/markdown/MermaidDiagram.tsx'))}
      import { NotebookSurface } from ${JSON.stringify(join(editorRoot, 'src/notebook/NotebookSurface.tsx'))}
      import { activate } from ${JSON.stringify(join(editorRoot, 'src/ui.tsx'))}
      import { createEditorUiControlReportScope, EditorUiControlProvider } from ${JSON.stringify(join(editorRoot, 'src/window/uiControl.tsx'))}
      const handlers = new Map()
      const context = {
        pluginId: 'quirky.editor', provide: (id, handler) => handlers.set(id, handler),
        subscribe: () => () => {}, getSetting: () => 300, getLayout: () => ({}), toast() {},
        async call(method, params) {
          if (method === 'ui.window.self') return { connId: 22 }
          if (method === 'ui.window.command.run') return { result: await handlers.get(params.id)(params.args) }
          if (params?.action === 'state') return { trusted: true, busy: false, kernel: { status: 'stopped' } }
          return {}
        }
      }
      activate(context)
      const scope = createEditorUiControlReportScope(undefined, { surface: 'view:quirky.editor/document', context })
      const root = createRoot(document.getElementById('root'))
      root.render(
        <EditorUiControlProvider scope={scope}><MermaidDiagram source="graph TD; A-->B" /></EditorUiControlProvider>
      )
      window.showNotebook = () => {
        const content = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { language: 'python' } }, cells: [{
          id: 'cell', cell_type: 'code', metadata: {}, source: 'print(1)', execution_count: 1, outputs: [
            { output_type: 'display_data', data: { 'text/html': '<strong onclick="window.injected=true">safe html</strong><script>window.injected=true</script>' } },
            { output_type: 'display_data', data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg" onload="window.injected=true"><script>window.injected=true</script><circle cx="1" cy="1" r="1" /></svg>' } }
          ]
        }] })
        const buffer = { id: 'b1', worktreeId: 'wt', root: '/fixture', path: '/fixture/demo.ipynb', name: 'demo.ipynb', relativePath: 'demo.ipynb', kind: 'notebook', mode: 'rich', content, draft: null, readOnly: false, view: {}, revision: 1, contentRevision: 1 }
        root.render(<EditorUiControlProvider scope={scope}><NotebookSurface context={context} buffer={buffer} fontSize={13} onDraft={() => {}} onAction={context.call} onView={() => {}} registerCommandHandlers={() => () => {}} /></EditorUiControlProvider>)
      }
    `)
    const bundle = await Bun.build({
      entrypoints: [entrypoint], target: 'browser', format: 'esm',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'isolated-mermaid-renderer', setup(builder) {
        builder.onResolve({ filter: /^react\/jsx-(?:dev-)?runtime$/ }, ({ path }) => ({ path: Bun.resolveSync(path, editorRoot) }))
        builder.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'renderer', namespace: 'mermaid-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'mermaid-fixture' }, () => ({ loader: 'js', contents: `
          export default {
            initialize(options) { window.mermaidOptions = options },
            async render() { return { svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="window.injected=true"><script>window.injected=true</script><filter id="safe"/><text onclick="window.injected=true">Safe diagram</text></svg>' } }
          }
        ` }))
      } }]
    })
    if (!bundle.success) throw new Error(bundle.logs.map((item) => item.message).join('\n'))
    browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new NativeResponse('<!doctype html><html><body><main id="root"></main></body></html>', { headers: { 'Content-Type': 'text/html' } }) })
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(server.url.href)
    await page.addStyleTag({ content: await Bun.file(resolve(editorRoot, '../../packages/ui/src/design-system/tokens.css')).text() })
    await page.addScriptTag({ type: 'module', content: await bundle.outputs[0]!.text() })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
      await page.waitForFunction("window.mermaidOptions?.themeVariables.textColor === getComputedStyle(document.documentElement).getPropertyValue('--ui-text').trim()")
      await page.locator('[role="img"] svg').waitFor()
      expect(await page.locator('[role="img"]').getAttribute('aria-label')).toBe('Mermaid diagram')
      expect(await page.locator('[role="img"] svg text').textContent()).toBe('Safe diagram')
      expect(await page.locator('[role="img"] svg filter').count()).toBe(1)
      expect(await page.locator('[role="img"] script, [role="img"] [onload], [role="img"] [onclick]').count()).toBe(0)
      expect(await page.evaluate('window.injected')).toBeUndefined()
      expect(await page.evaluate('window.mermaidOptions')).toMatchObject({ securityLevel: 'strict', startOnLoad: false, theme: 'base' })
    }
    await page.evaluate('window.showNotebook()')
    const frame = page.locator('iframe.notebook-html-output')
    await frame.waitFor()
    expect(await frame.getAttribute('sandbox')).toBe('')
    expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(await frame.getAttribute('srcdoc')).toContain('safe html')
    expect(await frame.getAttribute('srcdoc')).not.toMatch(/onclick|<script|window\.injected/i)
    const svgData = await page.locator('img.notebook-image-output').getAttribute('src')
    expect(svgData).toBeTruthy()
    const decoded = decodeURIComponent(svgData!.split(',').slice(1).join(','))
    expect(decoded).toContain('<circle')
    expect(decoded).not.toMatch(/onload|<script|window\.injected/i)
    expect(await page.evaluate('window.injected')).toBeUndefined()
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    server?.stop(true)
    await rm(scratch, { recursive: true, force: true })
  }
}, 60_000)

