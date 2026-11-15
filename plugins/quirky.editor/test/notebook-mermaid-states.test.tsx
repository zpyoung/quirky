import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ComponentType } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { EditorSurfaceBuffer, SurfaceProps } from '../src/types'
import {
  EDITOR_UI_CONTROL_COMMAND,
  EditorUiControlProvider,
  createEditorUiControlReportScope,
  type EditorUiControlReportScope
} from '../src/window/uiControl'
import { activate, deactivate } from '../src/ui'

type Handler = (args?: unknown) => unknown

type WindowBridge = { handlers: Map<string, Handler> }

type ContextFixture = {
  context: UiPluginContext
  calls: { method: string; params?: Record<string, unknown> }[]
  commandRoutes: number[]
  executeCalls: string[]
  subscribers: Set<(event: { type: string }) => void>
  windows: Map<number, WindowBridge>
}

type Mounted = {
  element: HTMLElement
  rerender(buffer: EditorSurfaceBuffer): Promise<void>
  unmount(): Promise<void>
  scope: EditorUiControlReportScope
}

let createRoot: (container: HTMLElement) => Root
let NotebookSurface: ComponentType<SurfaceProps>
let mounted: Mounted[]

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The surface and UI modules capture browser APIs during initialization, so import them after Happy DOM registers.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ NotebookSurface } = await import('../src/notebook/NotebookSurface'))
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

function makeContext(connId = 22): ContextFixture {
  const provided = new Map<string, Handler>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const commandRoutes: number[] = []
  const executeCalls: string[] = []
  const subscribers = new Set<(event: { type: string }) => void>()
  const windows = new Map<number, WindowBridge>([[connId, { handlers: provided }]])
  const context = {
    pluginId: 'quirky.editor',
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId }
      if (method === 'ui.window.command.run') {
        const targetConnId = params?.connId as number
        commandRoutes.push(targetConnId)
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
  return { context, calls, commandRoutes, executeCalls, subscribers, windows }
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

function notebookContent(cells = [makeCell()], metadata: Record<string, unknown> = { kernelspec: { language: 'python' } }): string {
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
  const scope = createEditorUiControlReportScope(() => {}, {
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
  const invalid = await renderNotebook(makeBuffer('b1', '[]'), async (_method, params) => {
    if (params.action === 'state') return runtimeState()
    return {}
  }, makeContext(), (patch) => views.push(patch))
  await flush()

  expect(invalid.element.querySelector('.ui-inline-error')?.textContent).toBe('Unable to render notebook: notebook JSON root must be an objectOpen raw source')
  expect(invalid.element.querySelector('.ui-empty-state')).toBeNull()
  await act(async () => button(invalid.element, 'Open raw source')!.click())
  expect(views).toEqual([{ mode: 'source' }])

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
