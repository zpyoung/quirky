import { describe, expect, test } from 'bun:test'
import type { MobileBundleManifest, MobileConnectionState, MobilePageInit, MobileRpc } from '../src/contracts'
import { createBridgeHost } from '../src/shell/bridge-host'
import { createPageBridge, type PageBridgePort } from '../src/shell/page-bridge'

const state = (phase: MobileConnectionState['phase'] = 'connected'): MobileConnectionState => ({ phase, attempts: 0 })
const init: MobilePageInit = {
  v: 1,
  sessionId: 'mount-1',
  host: { id: 'host-1', name: 'Desktop', endpoint: 'wss://desktop.example/rpc', publicKeyB64: 'public-key', lastConnected: null },
  route: { kind: 'session', worktreeId: 'worktree-1', sessionId: 'session-1' },
  grants: ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink'],
  preferences: { sessionView: 'terminal', onboardingCompleted: true, notificationChoice: 'disabled', terminalTextScale: 1, autocomplete: false, terminalLinkMode: 'phone', shortcuts: [] },
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  connectionState: state()
}

function fakeRpc(initialState = state()) {
  const calls: [string, Record<string, unknown>][] = []
  const events = new Set<(event: { event: string; data: unknown }) => void>()
  let eventSubscriptionCalls = 0
  const states = new Set<(next: MobileConnectionState) => void>()
  const streams = new Map<number, (bytes: Uint8Array) => void>()
  let currentState = initialState
  const rpc: MobileRpc = {
    get state() { return currentState },
    async call(method, params = {}) {
      calls.push([method, params])
      if (method === 'quirky.terminal/attach') return { streamId: 9 }
      return { ok: true }
    },
    onEvent(handler) { eventSubscriptionCalls++; events.add(handler); return () => events.delete(handler) },
    onState(handler) { states.add(handler); return () => states.delete(handler) },
    onStream(streamId, handler) { streams.set(streamId, handler); return () => streams.delete(streamId) },
    close() {}
  }
  return {
    rpc,
    calls,
    get eventSubscriptionCalls() { return eventSubscriptionCalls },
    emitEvent(event: string, data: unknown) { for (const handler of events) handler({ event, data }) },
    emitState(next: MobileConnectionState) { currentState = next; for (const handler of states) handler(next) },
    emitStream(streamId: number, bytes: Uint8Array) { streams.get(streamId)?.(bytes) }
  }
}

function hostHarness(overrides: Partial<Parameters<typeof createBridgeHost>[0]> = {}) {
  const sent: Record<string, unknown>[] = []
  const rpc = fakeRpc()
  const reports: Record<string, unknown>[] = []
  const host = createBridgeHost({
    init,
    rpc: rpc.rpc,
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    native: { clipboardRead: async () => 'clipboard', clipboardWrite: async () => {}, openExternal: async () => {}, haptic: async () => {} },
    sendToPage: async (json) => { sent.push(JSON.parse(json) as Record<string, unknown>) },
    onNavigate: () => {},
    rememberWorkspace: async () => {},
    onReport: (report) => reports.push(report),
    ...overrides
  })
  return { host, rpc, sent, reports }
}

function pagePort() {
  const sent: Record<string, unknown>[] = []
  const listeners = new Set<(json: string) => void>()
  const port: PageBridgePort = {
    postMessage: (json) => { sent.push(JSON.parse(json) as Record<string, unknown>) },
    subscribe: (handler) => { listeners.add(handler); return () => listeners.delete(handler) }
  }
  return {
    port,
    sent,
    emit(message: Record<string, unknown>) { for (const listener of listeners) listener(JSON.stringify(message)) }
  }
}

const hostEnvelope = (kind: string, body: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind, sessionId: init.sessionId, ...body })

describe('mobile page bridge authorization', () => {
  test('forwards only page-consumer RPC calls with the active session and route grants', async () => {
    const { host, rpc, sent } = hostHarness()
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    expect(sent[0]?.kind).toBe('init')
    host.receive(hostEnvelope('call', { requestId: 'r1', method: 'quirky.terminal/write', params: { session: 'session-1', data: 'hello' } }))
    await Promise.resolve()
    expect(rpc.calls).toEqual([['quirky.terminal/write', { session: 'session-1', data: 'hello' }]])
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'r1', ok: true })

    host.receive(hostEnvelope('call', { requestId: 'r2', method: 'daemon.stop', params: {} }))
    await Promise.resolve()
    expect(rpc.calls).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'r2', ok: false })
  })

  test('workspaces cannot exercise session-only clipboard methods', async () => {
    const workspaceInit: MobilePageInit = {
      ...init,
      route: { kind: 'workspaces' },
      grants: ['rpc', 'storage', 'navigate', 'terminal', 'externalLink']
    }
    const page = pagePort()
    const bridge = createPageBridge(page.port, workspaceInit)
    await expect(bridge.native.clipboardRead()).rejects.toThrow(/grant/i)
    expect(page.sent).toEqual([])
    bridge.close()
  })

  test('rejects mutations from both bridge ends while disconnected and forwards trusted state changes', async () => {
    const disconnected = state('reconnecting')
    const downRpc = fakeRpc(disconnected)
    const { host, sent } = hostHarness({ init: { ...init, connectionState: disconnected }, rpc: downRpc.rpc })
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    host.receive(hostEnvelope('call', { requestId: 'write-1', method: 'quirky.terminal/write', params: { session: 'session-1', data: 'x' } }))
    await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'write-1', ok: false })
    expect(downRpc.calls).toEqual([])

    const page = pagePort()
    const bridge = createPageBridge(page.port, { ...init, connectionState: disconnected })
    await expect(bridge.call('quirky.terminal/write', { session: 'session-1', data: 'x' })).rejects.toThrow(/connected/i)
    expect(page.sent).toEqual([])
    bridge.close()
  })

  test('the page client resolves replies, refuses event subscriptions, and updates state/stream listeners', async () => {
    const page = pagePort()
    const bridge = createPageBridge(page.port, init)
    const stateValues: MobileConnectionState[] = []
    const streamValues: Uint8Array[] = []
    expect(bridge.state).toEqual(state('connected'))
    bridge.onState((next) => stateValues.push(next))
    expect(stateValues).toEqual([state('connected')])
    const stopStream = bridge.onStream(9, (value) => streamValues.push(value))

    const pending = bridge.call<{ ok: boolean }>('quirky.worktree/list', {}, { requestId: 'request-1' })
    expect(page.sent[0]).toMatchObject({ kind: 'call', sessionId: init.sessionId, requestId: 'request-1', method: 'quirky.worktree/list' })
    page.emit({ v: 1, kind: 'reply', sessionId: init.sessionId, requestId: 'request-1', ok: true, result: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })

    page.emit({ v: 1, kind: 'event', sessionId: init.sessionId, event: 'quirky.worktree/changed', data: { worktreeId: 'worktree-1' } })
    page.emit({ v: 1, kind: 'stream', sessionId: init.sessionId, streamId: 9, data: 'AQI=' })
    page.emit({ v: 1, kind: 'state', sessionId: init.sessionId, state: state('disconnected') })
    page.emit({ v: 1, kind: 'stream', sessionId: init.sessionId, streamId: 9, data: 'AwQ=' })
    expect(stateValues).toEqual([state('connected'), state('disconnected')])
    expect(streamValues).toEqual([new Uint8Array([1, 2])])
    expect(page.sent.some((message) => message.kind === 'stream-unsubscribe' && message.streamId === 9)).toBe(true)
    stopStream()
    bridge.close()
  })

  test('rebind rejects an in-flight request from the old RPC without replaying it', async () => {
    const old = fakeRpc()
    const next = fakeRpc()
    let finish!: (value: unknown) => void
    const oldRpc: MobileRpc = {
      ...old.rpc,
      async call<T>(method: string, params = {}) {
        old.calls.push([method, params])
        const deferred = Promise.withResolvers<T>()
        finish = deferred.resolve as (value: unknown) => void
        return deferred.promise
      }
    }
    const { host, sent } = hostHarness({ rpc: oldRpc })
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    host.receive(hostEnvelope('call', { requestId: 'old-request', method: 'quirky.terminal/write', params: { session: 'session-1', data: 'x' } }))
    await Promise.resolve()

    host.setRpc(next.rpc)

    expect(sent.filter((message) => message.requestId === 'old-request')).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'old-request', ok: false })
    expect(old.calls).toEqual([['quirky.terminal/write', { session: 'session-1', data: 'x' }]])
    expect(next.calls).toEqual([])
    finish({ ok: true })
    await Promise.resolve()
    expect(sent.filter((message) => message.requestId === 'old-request')).toHaveLength(1)
    host.close()
  })

  test('forwards domain-shaped RPC results without guessing which response fields are secrets', async () => {
    const base = fakeRpc()
    const result = { token: 'producer-approved domain value', nested: { credentials: ['public descriptor'] } }
    const rpc: MobileRpc = {
      ...base.rpc,
      async call<T>() { return result as T }
    }
    const { host, sent } = hostHarness({ rpc })
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    host.receive(hostEnvelope('call', { requestId: 'domain-result', method: 'quirky.worktree/list', params: {} }))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'domain-result', ok: true, result })
    host.close()
  })

  test('rejects the raw agent list instead of forwarding effective environment metadata', async () => {
    const { host, rpc, sent } = hostHarness()
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    host.receive(hostEnvelope('call', { requestId: 'agent-list', method: 'quirky.agents/list', params: {} }))
    await Promise.resolve()
    expect(rpc.calls).toEqual([])
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'agent-list', ok: false })
    host.close()
  })

  test('never subscribes to daemon events and accepts only bounded non-content layout reports', () => {
    const { host, rpc, sent, reports } = hostHarness()
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    rpc.emitEvent('daemon.secret', { token: 'never forward' })
    rpc.emitEvent('quirky.session/changed', { worktreeId: 'worktree-1' })
    expect(rpc.eventSubscriptionCalls).toBe(0)
    expect(sent.filter((message) => message.kind === 'event')).toHaveLength(0)

    const report = { route: 'session', worktreeId: 'worktree-1', sessionId: 'session-1', tabSessionIds: ['session-1'], selectedSessionId: 'session-1', terminalVisible: true, dockOpen: false, sheetOpen: false, displayMode: 'phone', connectionPhase: 'connected', stale: false }
    host.receive(hostEnvelope('report', { state: report }))
    expect(reports).toEqual([report])
    host.receive(hostEnvelope('report', { state: { ...report, terminalText: 'secret terminal contents' } }))
    expect(reports).toHaveLength(1)
  })

  test('native external-link actions require a granted safe web URL', async () => {
    const { host, sent } = hostHarness()
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    host.receive(hostEnvelope('native', { requestId: 'native-1', action: 'openExternal', url: 'file:///etc/passwd' }))
    await Promise.resolve()
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', requestId: 'native-1', ok: false })
  })

  test('rejects bridge calls when the isolated native origin cannot deliver a message', async () => {
    const port: PageBridgePort = {
      postMessage: () => Promise.reject(new Error('page origin is unavailable')),
      subscribe: () => () => {}
    }
    const bridge = createPageBridge(port, init)
    await expect(bridge.call('quirky.worktree/list', {})).rejects.toThrow('page origin is unavailable')
    bridge.close()
  })
  test('limits the number of concurrent per-mount page requests', async () => {
    const page = pagePort()
    const bridge = createPageBridge(page.port, init)
    const pending = Array.from({ length: 128 }, (_, index) =>
      bridge.call('quirky.worktree/list', {}, { requestId: `bounded-${index}` })
    )
    await expect(bridge.call('quirky.worktree/list', {})).rejects.toThrow(/limit/i)
    bridge.close()
    await Promise.allSettled(pending)
  })
  test('bounds the native bridge host pending request map per page mount', async () => {
    const base = fakeRpc()
    const rpc: MobileRpc = {
      ...base.rpc,
      async call<T>(method, params = {}) {
        base.calls.push([method, params])
        return await new Promise<T>(() => {})
      }
    }
    const { host, sent } = hostHarness({ rpc })
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    for (let index = 0; index < 129; index++) {
      host.receive(hostEnvelope('call', {
        requestId: `flood-${index}`,
        method: 'quirky.worktree/list',
        params: {}
      }))
    }
    await Promise.resolve()
    expect(base.calls).toHaveLength(128)
    expect(sent.find((message) => message.requestId === 'flood-128')).toMatchObject({ kind: 'reply', ok: false })
    host.close()
  })
  test('forwards destructive workspace removal only with the explicit narrow confirmation packet', async () => {
    const { host, rpc, sent } = hostHarness()
    host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
    host.receive(hostEnvelope('call', { requestId: 'remove-unconfirmed', method: 'quirky.worktree/remove', params: { worktree: 'worktree-1' } }))
    await Promise.resolve()
    expect(rpc.calls).toEqual([])
    expect(sent.at(-1)).toMatchObject({ requestId: 'remove-unconfirmed', ok: false })

    host.receive(hostEnvelope('call', { requestId: 'remove-confirmed', method: 'quirky.worktree/remove', params: { worktree: 'worktree-1', yes: true } }))
    await Promise.resolve()
    expect(rpc.calls).toEqual([['quirky.worktree/remove', { worktree: 'worktree-1', yes: true }]])
    expect(sent.at(-1)).toMatchObject({ requestId: 'remove-confirmed', ok: true })

    host.receive(hostEnvelope('call', { requestId: 'remove-forced', method: 'quirky.worktree/remove', params: { worktree: 'worktree-1', yes: true, force: true } }))
    await Promise.resolve()
    expect(rpc.calls).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ requestId: 'remove-forced', ok: false })
    host.close()
  })
})
