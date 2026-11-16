import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { PROJECTS_CONTROL_COMMAND, requestProjectsControl } from '../src/projects/control'

type RpcCall = { method: string; params: Record<string, unknown> }
type CallHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type FakeContext = {
  context: UiPluginContext
  calls: RpcCall[]
  emitConnection(status: 'connected' | 'reconnecting'): void
  activeConnectionListeners(): number
}

function fakeContext(handleCall: CallHandler): FakeContext {
  const calls: RpcCall[] = []
  const listeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const context: UiPluginContext = {
    nativeBrowser: {
      available: false,
      clearPartitionAvailable: false,
      previewAvailable: false,
      mount() { throw new Error('Native browser is not used by this fixture.') },
      async defaultUserAgent() { return null },
      async clearPartition() {}
    },
    pluginId: 'quirky.tasks',
    log() {},
    async readClipboardText() { return '' },
    async nativeDropPaths() { return null },
    provide() {},
    async call(method, params = {}) {
      calls.push({ method, params })
      return await handleCall(method, params)
    },
    subscribe() { return () => {} },
    getSetting() { return undefined },
    async executeCommand() {},
    createCommandDrag() { return 'unused-command-drag' },
    consumeCommandDrag() { return null },
    cancelCommandDrag() {},
    openView() {},
    closeView() {},
    togglePanel() {},
    setPalette() {},
    getLayout() { return { view: null, panel: null, sidebar: true, focus: null } },
    onLayout() { return () => {} },
    onStream() { return () => {} },
    onConnection(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async confirm() { return false },
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  }
  return {
    context,
    calls,
    emitConnection(status) { for (const listener of [...listeners]) listener(status) },
    activeConnectionListeners() { return listeners.size }
  }
}

const pickerRequest = { action: 'picker', open: true } as const

function callsTo(fake: FakeContext, method: string): RpcCall[] {
  return fake.calls.filter((call) => call.method === method)
}

test('resolves this window for every request after reconnect and daemon connection-ID reuse', async () => {
  let firstWindowId = 7
  const owners = new Map<number, string>([[7, 'first window']])
  const deliveries: Array<{ owner: string | undefined; connId: number }> = []
  const route = (name: string, getConnId: () => number) => fakeContext((method, params) => {
    if (method === 'ui.window.self') return { connId: getConnId() }
    if (method === 'ui.window.command.run') {
      const connId = params.connId
      if (typeof connId !== 'number') throw new Error('A numeric connection ID is required.')
      deliveries.push({ owner: owners.get(connId), connId })
      return { delivered: 1, name }
    }
    throw new Error(`Unexpected RPC ${method}.`)
  })
  const first = route('first window', () => firstWindowId)
  const second = route('second window', () => 7)

  await requestProjectsControl(first.context, pickerRequest)
  expect(deliveries).toEqual([{ owner: 'first window', connId: 7 }])

  owners.set(7, 'second window')
  await requestProjectsControl(second.context, pickerRequest)
  firstWindowId = 22
  owners.set(22, 'first window')
  first.emitConnection('reconnecting')
  first.emitConnection('connected')

  await requestProjectsControl(first.context, pickerRequest)
  await requestProjectsControl(second.context, pickerRequest)

  expect(deliveries).toEqual([
    { owner: 'first window', connId: 7 },
    { owner: 'second window', connId: 7 },
    { owner: 'first window', connId: 22 },
    { owner: 'second window', connId: 7 }
  ])
  expect(callsTo(first, 'ui.window.self')).toHaveLength(2)
  expect(callsTo(second, 'ui.window.self')).toHaveLength(2)
  expect(callsTo(first, 'ui.window.command.run').map((call) => call.params.connId)).toEqual([7, 22])
  expect(callsTo(second, 'ui.window.command.run').map((call) => call.params.connId)).toEqual([7, 7])
  expect(first.activeConnectionListeners()).toBe(0)
  expect(second.activeConnectionListeners()).toBe(0)
})

test('rejects a self lookup that resolves after any connection transition without dispatching it', async () => {
  let selfCalls = 0
  const pendingSelf = deferred<unknown>()
  const fake = fakeContext((method) => {
    if (method === 'ui.window.self') {
      selfCalls += 1
      return selfCalls === 1 ? pendingSelf.promise : { connId: 22 }
    }
    if (method === 'ui.window.command.run') return { delivered: 1 }
    throw new Error(`Unexpected RPC ${method}.`)
  })

  const staleRequest = requestProjectsControl(fake.context, pickerRequest)
  expect(fake.activeConnectionListeners()).toBe(1)
  fake.emitConnection('reconnecting')
  pendingSelf.resolve({ connId: 7 })
  await expect(staleRequest).rejects.toThrow('The window connection changed while identifying this window.')
  expect(callsTo(fake, 'ui.window.command.run')).toHaveLength(0)
  expect(fake.activeConnectionListeners()).toBe(0)

  await requestProjectsControl(fake.context, pickerRequest)
  expect(callsTo(fake, 'ui.window.self')).toHaveLength(2)
  expect(callsTo(fake, 'ui.window.command.run').map((call) => call.params.connId)).toEqual([22])
  expect(fake.activeConnectionListeners()).toBe(0)
})

test('does not retry or replay successful and failed command dispatches', async () => {
  let selfCalls = 0
  let dispatchCalls = 0
  const fake = fakeContext((method) => {
    if (method === 'ui.window.self') {
      selfCalls += 1
      return { connId: 9 }
    }
    if (method === 'ui.window.command.run') {
      dispatchCalls += 1
      if (dispatchCalls === 2) throw new Error('delivery outcome unavailable')
      return { delivered: 1 }
    }
    throw new Error(`Unexpected RPC ${method}.`)
  })

  await requestProjectsControl(fake.context, pickerRequest)
  expect(fake.activeConnectionListeners()).toBe(0)
  await expect(requestProjectsControl(fake.context, pickerRequest)).rejects.toThrow('delivery outcome unavailable')

  expect(selfCalls).toBe(2)
  expect(dispatchCalls).toBe(2)
  expect(callsTo(fake, 'ui.window.command.run')).toHaveLength(2)
  expect(callsTo(fake, 'ui.window.command.run').every((call) => call.params.id === PROJECTS_CONTROL_COMMAND)).toBe(true)
  expect(fake.activeConnectionListeners()).toBe(0)
})

test('cleans up the connection listener when self lookup rejects', async () => {
  const fake = fakeContext((method) => {
    if (method === 'ui.window.self') throw new Error('identity lookup failed')
    throw new Error(`Unexpected RPC ${method}.`)
  })

  await expect(requestProjectsControl(fake.context, pickerRequest)).rejects.toThrow('identity lookup failed')
  expect(callsTo(fake, 'ui.window.command.run')).toHaveLength(0)
  expect(fake.activeConnectionListeners()).toBe(0)
})

test('rejects invalid self identities and always removes the connection listener', async () => {
  for (const response of [null, {}, { connId: 0 }, { connId: 1.5 }]) {
    const fake = fakeContext((method) => {
      if (method === 'ui.window.self') return response
      throw new Error(`Unexpected RPC ${method}.`)
    })

    await expect(requestProjectsControl(fake.context, pickerRequest)).rejects.toThrow('The daemon did not identify this window.')
    expect(callsTo(fake, 'ui.window.command.run')).toHaveLength(0)
    expect(fake.activeConnectionListeners()).toBe(0)
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
