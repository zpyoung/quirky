import * as React from 'react'
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import pluginManifest from '../quirky-plugin.json'
import {
  EDITOR_UI_CONTROL_COMMAND,
  EditorUiControlProvider,
  createEditorUiControlReportScope,
  editorUiControlDescriptor,
  registerEditorUiControl,
  requestEditorUiControl,
  runEditorUiControl,
  useEditorUiControl,
  useEditorUiControlReport,
  type EditorUiControlAddress,
  type EditorUiControlReportScope
} from '../src/window/uiControl'
import { activate, deactivate } from '../src/ui'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

type Call = { method: string; params?: Record<string, unknown> }
type Handler = (args?: unknown) => unknown

type WindowBridge = {
  handlers: Map<string, Handler>
  calls: Call[]
}

function makeContext(connId = 22, windows = new Map<number, WindowBridge>()) {
  const provided = new Map<string, Handler>()
  const calls: Call[] = []
  const commandRoutes: number[] = []
  const executeCalls: string[] = []
  const ownWindow: WindowBridge = { handlers: provided, calls }
  if (!windows.has(connId)) windows.set(connId, ownWindow)
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
    subscribe: () => () => {},
    getSetting: () => 300,
    getLayout: () => ({}),
    executeCommand: async (id: string) => { executeCalls.push(id) },
    toast: () => {}
  } as unknown as UiPluginContext
  return { context, provided, calls, commandRoutes, executeCalls, windows, ownWindow }
}

const address = (target: string, actions = ['select']): EditorUiControlAddress => ({
  surface: 'view:quirky.editor/document',
  target,
  generation: 'generation-1',
  actions
})

const controlArgs = (target: string, action = 'select') => ({
  surface: 'view:quirky.editor/document',
  target,
  generation: 'generation-1',
  action,
  data: { value: 7 }
})

function mount(container: HTMLElement, scope: EditorUiControlReportScope, node: React.ReactNode): Root {
  const root = createRoot(container)
  root.render(<EditorUiControlProvider scope={scope}>{node}</EditorUiControlProvider>)
  return root
}

afterEach(() => {
  deactivate()
  document.body.innerHTML = ''
})

test('manifest declares ui-control as a hidden strict-schema command', () => {
  const command = pluginManifest.contributes.command.find((item) => item.id === 'ui-control')
  expect(command).toMatchObject({
    palette: false,
    args: {
      type: 'object',
      properties: {
        surface: { type: 'string' },
        target: { type: 'string' },
        generation: { type: 'string' },
        action: { type: 'string' },
        data: { type: 'object', additionalProperties: true }
      },
      required: ['surface', 'target', 'generation', 'action'],
      additionalProperties: false
    }
  })
  expect(EDITOR_UI_CONTROL_COMMAND).toBe('command:quirky.editor/ui-control')
})

test('the command provided by activate validates, dispatches extensions, and refuses stale or malformed commands', async () => {
  const fixture = makeContext()
  activate(fixture.context)
  const command = fixture.provided.get(EDITOR_UI_CONTROL_COMMAND)
  expect(command).toBeTypeOf('function')
  expect([...fixture.provided.keys()]).toEqual(expect.arrayContaining([
    'view:quirky.editor/document',
    'sidebar-section:quirky.editor/explorer',
    'panel:quirky.editor/explorer',
    'overlay:quirky.editor/quick-open',
    'overlay:quirky.editor/close',
    EDITOR_UI_CONTROL_COMMAND
  ]))

  let handlerCalls = 0
  let delegated = 0
  const dispose = registerEditorUiControl(address('doc:extension'), async (control) => {
    handlerCalls++
    if (control.data?.value !== 7) return { delivered: false }
    delegated++
    return { delivered: true }
  })
  let disposeSelf = () => {}
  disposeSelf = registerEditorUiControl(address('doc:self-close'), async () => {
    disposeSelf()
    return { delivered: true }
  })
  try {
    expect(await command!(controlArgs('doc:extension'))).toEqual({ delivered: true })
    expect(await command!(controlArgs('doc:extension', 'future-action'))).toEqual({ delivered: false })
    expect(await command!({ ...controlArgs('doc:extension'), data: { value: 'bad' } })).toEqual({ delivered: false })
    expect(await command!(controlArgs('doc:self-close'))).toEqual({ delivered: true })
    expect(await command!(controlArgs('doc:self-close'))).toEqual({ delivered: false })
    expect(await command!(controlArgs('missing'))).toEqual({ delivered: false })
    expect(await command!({ ...controlArgs('doc:extension'), generation: 'stale' })).toEqual({ delivered: false })
    expect(await command!({ ...controlArgs('doc:extension'), data: [] })).toEqual({ delivered: false })
    expect(await command!({ ...controlArgs('doc:extension'), extra: true })).toEqual({ delivered: false })
    expect(await command!({ ...controlArgs('doc:extension'), surface: '  ' })).toEqual({ delivered: false })
    expect(handlerCalls).toBe(2)
    expect(delegated).toBe(1)
  } finally {
    dispose()
    disposeSelf()
  }
})

test('descriptor rejects invalid controls and the registry replacement disposer cannot remove a newer entry', async () => {
  const targetAddress = address('doc:replace')
  expect(() => registerEditorUiControl({ ...address('doc:invalid'), target: ' ' }, async () => ({ delivered: true }))).toThrow()
  expect(() => registerEditorUiControl({ ...address('doc:invalid'), actions: [''] }, async () => ({ delivered: true }))).toThrow()
  expect(() => registerEditorUiControl({ ...address('doc:invalid'), actions: ['select', 'select'] }, async () => ({ delivered: true }))).toThrow()
  const oldCalls: string[] = []
  const newCalls: string[] = []
  const disposeOld = registerEditorUiControl(targetAddress, async () => {
    oldCalls.push('old')
    return { delivered: true }
  })
  const disposeNew = registerEditorUiControl(targetAddress, async () => {
    newCalls.push('new')
    return { delivered: true }
  })
  try {
    expect(() => editorUiControlDescriptor({ ...controlArgs('doc:replace'), action: '' })).toThrow()
    expect(() => editorUiControlDescriptor({ ...controlArgs('doc:replace'), data: null } as never)).toThrow()
    disposeOld()
    expect(await runEditorUiControl(controlArgs('doc:replace'))).toEqual({ delivered: true })
    expect(oldCalls).toEqual([])
    expect(newCalls).toEqual(['new'])
  } finally {
    disposeNew()
  }
})

test('report scopes merge nested registrations and raw reports across multiple mounts of one surface', async () => {
  const reportsA: Record<string, unknown>[] = []
  const reportsB: Record<string, unknown>[] = []
  const scopeA = createEditorUiControlReportScope((state) => reportsA.push(state as Record<string, unknown>), {
    surface: 'view:quirky.editor/document'
  })
  const scopeB = createEditorUiControlReportScope((state) => reportsB.push(state as Record<string, unknown>), {
    surface: 'view:quirky.editor/document'
  })
  scopeA.report({ mounted: true, bufferId: 'a' })
  scopeB.report({ mounted: true, bufferId: 'b' })

  function NestedControl({ target }: { target: string }) {
    useEditorUiControl({
      context: makeContext().context,
      address: { ...address(target), surface: 'view:quirky.editor/document' },
      handler: async () => ({ delivered: true })
    })
    const report = useEditorUiControlReport()
    React.useEffect(() => report({ refreshed: target }), [report, target])
    return null
  }

  const elementA = document.createElement('div')
  const elementB = document.createElement('div')
  document.body.append(elementA, elementB)
  let rootA!: Root
  let rootB!: Root
  try {
    await act(async () => {
      rootA = mount(elementA, scopeA, <NestedControl target="document:a" />)
      rootB = mount(elementB, scopeB, <NestedControl target="document:b" />)
      await Promise.resolve()
    })
    expect(reportsA.at(-1)).toEqual({
      mounted: true,
      bufferId: 'a',
      refreshed: 'document:a',
      uiControls: [{ ...address('document:a'), surface: 'view:quirky.editor/document' }]
    })
    expect(reportsB.at(-1)).toEqual({
      mounted: true,
      bufferId: 'b',
      refreshed: 'document:b',
      uiControls: [{ ...address('document:b'), surface: 'view:quirky.editor/document' }]
    })
    scopeA.report({ close: { open: true, requestId: 'close-1' } })
    scopeA.report({ saveAs: { open: true, requestId: 'save-1' } })
    expect(reportsA.at(-1)).toMatchObject({
      mounted: true,
      bufferId: 'a',
      refreshed: 'document:a',
      close: { open: true, requestId: 'close-1' },
      saveAs: { open: true, requestId: 'save-1' },
      uiControls: [{ ...address('document:a'), surface: 'view:quirky.editor/document' }]
    })
    scopeA.report({ error: 'close error' })
    expect(reportsA.at(-1)).toMatchObject({
      close: { open: true, requestId: 'close-1' },
      saveAs: { open: true, requestId: 'save-1' },
      error: 'close error'
    })
    scopeA.report({ mounted: true, bufferId: 'a', updated: true })
    expect(reportsA.at(-1)).toMatchObject({
      mounted: true,
      bufferId: 'a',
      updated: true,
      saveAs: { open: true, requestId: 'save-1' },
      uiControls: [{ ...address('document:a'), surface: 'view:quirky.editor/document' }]
    })
  } finally {
    await act(async () => { rootA.unmount(); rootB.unmount() })
    scopeA.dispose()
    scopeB.dispose()
  }
})

test('a clicked control routes through self and the actual activated handler to its exact window', async () => {
  const owner: WindowBridge = { handlers: new Map(), calls: [] }
  const local: WindowBridge = { handlers: new Map(), calls: [] }
  const windows = new Map<number, WindowBridge>([[11, owner], [22, local]])
  const fixture = makeContext(22, windows)
  activate(fixture.context)
  const actualActivatedHandler = fixture.provided.get(EDITOR_UI_CONTROL_COMMAND)!
  owner.handlers.set(EDITOR_UI_CONTROL_COMMAND, async () => {
    throw new Error('the owner window must not receive this click')
  })
  local.handlers.set(EDITOR_UI_CONTROL_COMMAND, actualActivatedHandler)

  let localChanges = 0
  const scope = createEditorUiControlReportScope(() => {}, { surface: 'view:quirky.editor/document' })
  const element = document.createElement('div')
  document.body.append(element)
  let root!: Root
  try {
    await act(async () => {
      root = mount(element, scope, <ClickControl context={fixture.context} target="window:22" onControl={() => { localChanges++ }} />)
      await Promise.resolve()
    })
    const button = element.querySelector('button')!
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve() })
    expect(fixture.commandRoutes).toEqual([22])
    expect(fixture.calls.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
      method: 'ui.window.command.run',
      params: {
        connId: 22,
        id: EDITOR_UI_CONTROL_COMMAND,
        args: controlArgs('window:22')
      }
    }])
    expect(localChanges).toBe(1)
    expect(fixture.executeCalls).toEqual([])
  } finally {
    await act(async () => { root.unmount() })
    scope.dispose()
  }
})

function ClickControl({ context, target, onControl }: { context: UiPluginContext; target: string; onControl(): void }) {
  const control = useEditorUiControl({
    context,
    address: address(target),
    handler: async () => {
      onControl()
      return { delivered: true }
    }
  })
  return <button onClick={() => { void control.run('select', { value: 7 }) }}>Select</button>
}

test('request helper validates window identity and envelopes while preserving bridge exceptions', async () => {
  const invalidSelf = {
    call: async (method: string) => method === 'ui.window.self' ? { connId: Number.MAX_SAFE_INTEGER + 1 } : { result: { delivered: true } }
  } as unknown as UiPluginContext
  await expect(requestEditorUiControl(invalidSelf, controlArgs('doc:invalid') as never)).rejects.toThrow()

  const invalidEnvelope = {
    call: async (method: string) => method === 'ui.window.self'
      ? { connId: 22 }
      : { result: { delivered: 'yes' } }
  } as unknown as UiPluginContext
  await expect(requestEditorUiControl(invalidEnvelope, controlArgs('doc:invalid') as never)).rejects.toThrow()

  const bridgeError = new Error('window bridge failed')
  const failedBridge = {
    call: async (method: string) => {
      if (method === 'ui.window.self') return { connId: 22 }
      throw bridgeError
    }
  } as unknown as UiPluginContext
  await expect(requestEditorUiControl(failedBridge, controlArgs('doc:invalid') as never)).rejects.toBe(bridgeError)
})

test('a valid refusal is unwrapped and surfaced by the originating hook', async () => {
  const calls: Call[] = []
  const context = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 22 }
      if (method === 'ui.window.command.run') return { result: { delivered: false } }
      throw new Error(`Unexpected call ${method}`)
    }
  } as unknown as UiPluginContext
  const reportScope = createEditorUiControlReportScope(() => {}, { surface: 'view:quirky.editor/document' })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () => {
      root.render(<EditorUiControlProvider scope={reportScope}><RefusalControl context={context} /></EditorUiControlProvider>)
      await Promise.resolve()
    })
    await act(async () => { element.querySelector('button')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(element.querySelector('[role="alert"]')?.textContent).toBe('The editor control is no longer available.')
    expect(calls.map((call) => call.method)).toEqual(['ui.window.self', 'ui.window.command.run'])
  } finally {
    await act(async () => { root.unmount() })
    reportScope.dispose()
  }
})

function RefusalControl({ context }: { context: UiPluginContext }) {
  const [error, setError] = React.useState('')
  const control = useEditorUiControl({
    context,
    address: address('doc:refusal'),
    handler: async () => ({ delivered: true }),
    onError: (reason) => setError(reason.message)
  })
  return <><button onClick={() => { void control.run('select') }}>Select</button>{error && <div role="alert">{error}</div>}</>
}
