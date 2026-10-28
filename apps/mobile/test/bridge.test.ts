import { describe, expect, test } from 'bun:test'
import type { MobileConnectionState, MobilePageInit, MobileRpc } from '../src/contracts'
import { createBridgeHost } from '../src/shell/bridge-host'
import { createPageBridge, type PageBridgePort } from '../src/shell/page-bridge'
import { builtinsDir, startHarness } from '../../../packages/daemon/test/helpers'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { createMobileRpc } from '@quirky/protocol/paired-client'

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

type RpcImplementation = <T>(method: string, params: Record<string, unknown>) => Promise<T>
type Envelope = Record<string, unknown>
type EnvelopeTransform = (message: Envelope) => Envelope[]
type RpcHarness = {
  rpc: MobileRpc
  calls: string[]
  readonly eventSubscriptionCalls: number
  readonly streamSubscriptionCount: number
  readonly streamCleanupCalls: number
  emitEvent(event: string, data: unknown): void
  emitState(next: MobileConnectionState): void
  emitStream(streamId: number, bytes: Uint8Array): void
}


function deferred<T>() {
  return Promise.withResolvers<T>()
}

function fakeRpc(initialState = state(), implementation?: RpcImplementation): RpcHarness {
  const calls: string[] = []
  const events = new Set<(event: { event: string; data: unknown }) => void>()
  const states = new Set<(next: MobileConnectionState) => void>()
  const streams = new Map<number, (bytes: Uint8Array) => void>()
  let eventSubscriptionCalls = 0
  let streamCleanupCalls = 0
  let currentState = initialState
  const rpc: MobileRpc = {
    get state() { return currentState },
    async call<T>(method: string, params = {}) {
      calls.push(method)
      if (implementation) return implementation<T>(method, params)
      if (method === 'quirky.terminal/attach') return { streamId: 9 } as T
      return { ok: true } as T
    },
    onEvent(handler) { eventSubscriptionCalls++; events.add(handler); return () => events.delete(handler) },
    onState(handler) { states.add(handler); return () => states.delete(handler) },
    onStream(streamId, handler) {
      streams.set(streamId, handler)
      return () => { streams.delete(streamId); streamCleanupCalls++ }
    },
    close() {}
  }
  return {
    rpc,
    calls,
    get eventSubscriptionCalls() { return eventSubscriptionCalls },
    get streamSubscriptionCount() { return streams.size },
    get streamCleanupCalls() { return streamCleanupCalls },
    emitEvent(event: string, data: unknown) { for (const handler of events) handler({ event, data }) },
    emitState(next: MobileConnectionState) { currentState = next; for (const handler of states) handler(next) },
    emitStream(streamId: number, bytes: Uint8Array) { streams.get(streamId)?.(bytes) }
  }
}

function bridgeHarness(options: { init?: MobilePageInit; rpc?: RpcHarness } = {}) {
  const pageInit = options.init ?? init
  const rpc = options.rpc ?? fakeRpc()
  const pageListeners = new Set<(json: string) => void>()
  const reports: Record<string, unknown>[] = []
  const navigations: unknown[] = []
  const storage = new Map<string, string>()
  const openedExternalUrls: string[] = []
  let pageTransform: EnvelopeTransform = (message) => [message]
  let hostTransform: EnvelopeTransform = (message) => [message]

  const host = createBridgeHost({
    init: pageInit,
    rpc: rpc.rpc,
    storage: {
      async get(key) { return storage.get(key) ?? null },
      async set(key, value) { storage.set(key, value) },
      async remove(key) { storage.delete(key) }
    },
    native: {
      async clipboardRead() { return 'clipboard' },
      async clipboardWrite() {},
      async openExternal(url) { openedExternalUrls.push(url) },
      async haptic() {}
    },
    sendToPage(json) {
      const message = JSON.parse(json) as Envelope
      for (const delivery of hostTransform(message)) {
        const encoded = JSON.stringify(delivery)
        for (const listener of pageListeners) listener(encoded)
      }
    },
    onNavigate(route) { navigations.push(route) },
    async rememberWorkspace() {},
    onReport(report) { reports.push(report) }
  })

  const createPage = (nextInit: MobilePageInit = pageInit) => {
    const port: PageBridgePort = {
      postMessage(json) {
        const message = JSON.parse(json) as Envelope
        for (const delivery of pageTransform(message)) host.receive(JSON.stringify(delivery))
      },
      subscribe(handler) { pageListeners.add(handler); return () => pageListeners.delete(handler) }
    }
    return createPageBridge(port, nextInit)
  }
  const page = createPage()
  host.receive(JSON.stringify({ v: 1, kind: 'ready' }))

  return {
    page,
    host,
    rpc,
    createPage,
    reports,
    navigations,
    openedExternalUrls,
    setPageTransform(transform: EnvelopeTransform) { pageTransform = transform },
    setHostTransform(transform: EnvelopeTransform) { hostTransform = transform }
  }
}

describe('mobile page bridge consumers', () => {
  test('page RPC consumers await successful results from the paired bridge host', async () => {
    const pair = bridgeHarness()
    await expect(pair.page.call('quirky.worktree/list', {})).resolves.toEqual({ ok: true })
    pair.page.close()
    pair.host.close()
  })

  test('page RPC consumers receive sanitized host errors', async () => {
    const rpc = fakeRpc(state(), async <T>(): Promise<T> => { throw new Error('token=private-value daemon failed') })
    const pair = bridgeHarness({ rpc })
    await expect(pair.page.call('quirky.worktree/list', {})).rejects.toThrow('[redacted] daemon failed')
    pair.page.close()
    pair.host.close()
  })

  test('workspace pages lack clipboard grants and the host rejects tampered native actions', async () => {
    const workspaceInit: MobilePageInit = {
      ...init,
      route: { kind: 'workspaces' },
      grants: ['rpc', 'storage', 'navigate', 'terminal', 'externalLink']
    }
    const pair = bridgeHarness({ init: workspaceInit })

    await expect(pair.page.native.clipboardRead()).rejects.toThrow(/grant/i)
    pair.setPageTransform((message) => message.kind === 'storage'
      ? [{ v: 1, kind: 'native', sessionId: message.sessionId, requestId: message.requestId, action: 'clipboardRead' }]
      : [message])
    await expect(pair.page.storage.get('workspace-secret')).rejects.toThrow(/unavailable/i)
    expect(pair.rpc.calls).toEqual([])
    pair.page.close()
    pair.host.close()
  })

  test('session consumers retain the external-link grant for safe web URLs', async () => {
    const pair = bridgeHarness()
    await pair.page.native.openExternal('https://example.test/guide')
    expect(pair.openedExternalUrls).toEqual(['https://example.test/guide'])
    await expect(pair.page.native.openExternal('file:///etc/passwd')).rejects.toThrow(/http\(s\)/i)
    pair.page.close()
    pair.host.close()
  })

  test('the host denies raw agent and administrative RPC methods', async () => {
    const pair = bridgeHarness()
    await expect(pair.page.call('quirky.agents/list', {})).rejects.toThrow(/unavailable/i)

    for (const method of ['quirky.agents/list', 'daemon.stop']) {
      pair.setPageTransform((message) => message.kind === 'call' ? [{ ...message, method }] : [message])
      await expect(pair.page.call('quirky.worktree/list', {})).rejects.toThrow()
    }
    expect(pair.rpc.calls).toEqual([])
    pair.page.close()
    pair.host.close()
  })

  test('both bridge ends ignore messages from another session', async () => {
    const pair = bridgeHarness()
    pair.setPageTransform((message) => message.kind === 'call'
      ? [{ ...message, sessionId: 'another-mount', method: 'daemon.stop' }, message]
      : [message])
    await expect(pair.page.call('quirky.worktree/list', {})).resolves.toEqual({ ok: true })

    pair.setPageTransform((message) => [message])
    pair.setHostTransform((message) => message.kind === 'reply' && message.ok === true
      ? [{ ...message, sessionId: 'another-mount', result: { spoofed: true } }, message]
      : [message])
    await expect(pair.page.call('quirky.worktree/list', {})).resolves.toEqual({ ok: true })
    expect(pair.rpc.calls).toHaveLength(2)
    pair.page.close()
    pair.host.close()
  })

  test('page events remain unavailable and reports contain only bounded layout state', () => {
    const pair = bridgeHarness()
    expect(() => pair.page.onEvent(() => {})).toThrow(/unavailable/i)
    pair.rpc.emitEvent('daemon.secret', { token: 'must not be forwarded' })
    expect(pair.rpc.eventSubscriptionCalls).toBe(0)

    const report = {
      route: 'session', worktreeId: 'worktree-1', sessionId: 'session-1', tabSessionIds: ['session-1'],
      selectedSessionId: 'session-1', terminalVisible: true, dockOpen: false, sheetOpen: false,
      displayMode: 'phone', connectionPhase: 'connected', stale: false
    }
    pair.page.report(report)
    expect(pair.reports).toEqual([report])
    expect(() => pair.page.report({ ...report, terminalText: 'private terminal output' })).toThrow()
    expect(pair.reports).toEqual([report])
    pair.page.close()
    pair.host.close()
  })

  test('disconnect state reaches consumers and blocks mutations on both bridge ends', async () => {
    const pair = bridgeHarness()
    const states: MobileConnectionState[] = []
    pair.page.onState((next) => states.push(next))
    pair.rpc.emitState(state('reconnecting'))

    expect(pair.page.state).toEqual(state('reconnecting'))
    expect(states).toEqual([state('connected'), state('reconnecting')])
    await expect(pair.page.call('quirky.terminal/write', { session: 'session-1', data: 'x' })).rejects.toThrow(/connected/i)

    const stalePage = pair.createPage(init)
    await expect(stalePage.call('quirky.terminal/write', { session: 'session-1', data: 'x' })).rejects.toThrow(/connected/i)
    expect(pair.rpc.calls).toEqual([])
    stalePage.close()
    pair.page.close()
    pair.host.close()
  })

  test('rebind rejects an old in-flight consumer request without replaying it', async () => {
    const started = deferred<void>()
    const result = deferred<unknown>()
    const settled = deferred<void>()
    const oldRpc = fakeRpc(state(), async <T>() => {
      started.resolve()
      try { return await result.promise as T } finally { settled.resolve() }
    })
    const nextRpc = fakeRpc()
    const pair = bridgeHarness({ rpc: oldRpc })
    const request = pair.page.call('quirky.worktree/list', {})
    await started.promise

    pair.host.setRpc(nextRpc.rpc)
    await expect(request).rejects.toThrow(/connection changed/i)
    result.resolve({ ok: true })
    await settled.promise

    expect(oldRpc.calls).toHaveLength(1)
    expect(nextRpc.calls).toEqual([])
    pair.page.close()
    pair.host.close()
  })

  test('disconnect cleans up host stream subscriptions and page listeners', async () => {
    const pair = bridgeHarness()
    const attached = await pair.page.call<{ streamId: number }>('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
    const received: Uint8Array[] = []
    pair.page.onStream(attached.streamId, (bytes) => received.push(bytes))
    expect(pair.rpc.streamSubscriptionCount).toBe(1)

    pair.rpc.emitStream(attached.streamId, new Uint8Array([1, 2]))
    pair.rpc.emitState(state('reconnecting'))
    expect(pair.rpc.streamCleanupCalls).toBe(1)
    pair.rpc.emitStream(attached.streamId, new Uint8Array([3, 4]))
    expect(received).toEqual([new Uint8Array([1, 2])])
    pair.page.close()
    pair.host.close()
  })

  test('page clients enforce their concurrent request capacity', async () => {
    const rpc = fakeRpc(state(), async <T>() => new Promise<T>(() => {}))
    const pair = bridgeHarness({ rpc })
    const pending = Array.from({ length: 128 }, (_, index) =>
      pair.page.call('quirky.worktree/list', {}, { requestId: `client-${index}` })
    )
    const excess = pair.page.call('quirky.worktree/list', {})
    const pendingResults = Promise.allSettled(pending)
    const excessResult = expect(excess).rejects.toThrow(/limit/i)
    pair.page.close()
    pair.host.close()
    await pendingResults
    await excessResult
  })

  test('the host enforces its pending request capacity across page clients', async () => {
    const rpc = fakeRpc(state(), async <T>() => new Promise<T>(() => {}))
    const pair = bridgeHarness({ rpc })
    const pending = Array.from({ length: 128 }, (_, index) =>
      pair.page.call('quirky.worktree/list', {}, { requestId: `host-${index}` })
    )
    const secondPage = pair.createPage()
    const excess = secondPage.call('quirky.worktree/list', {}, { requestId: 'host-overflow' })
    const pendingResults = Promise.allSettled(pending)
    const excessResult = expect(excess).rejects.toThrow(/limit/i)
    secondPage.close()
    pair.page.close()
    pair.host.close()
    await pendingResults
    await excessResult
  })
})

test('the page bridge answers a real encrypted question with a role ID and skipped-ID array', async () => {
  const oldPort = process.env.QUIRKY_MOBILE_PORT
  process.env.QUIRKY_MOBILE_PORT = '0'
  let harness: Harness | undefined
  let phone: MobileRpc | undefined
  let pair: ReturnType<typeof bridgeHarness> | undefined
  try {
    harness = await startHarness({ builtinPluginsDir: builtinsDir() })
    const local = await harness.connect('cli')
    const pairing = await local.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
    const offer = JSON.parse(Buffer.from(new URL(pairing.pairingUrl).searchParams.get('code')!, 'base64url').toString())
    phone = await createMobileRpc({ endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64, token: offer.deviceToken })
    pair = bridgeHarness({
      rpc: fakeRpc(state(), <T>(method: string, params: Record<string, unknown> = {}) => phone!.call<T>(method, params))
    })
    const { askId } = await local.callAny('quirky.ask/create', {
      spec: { questions: [{ id: 'role', type: 'text', question: 'Which role should review this change?' }] }
    }) as { askId: string }
    await pair.page.call('quirky.ask/answer', {
      askId,
      answers: { role: { value: 'reviewer', source: 'input' } },
      skipped: []
    })
    const answered = await local.callAny('quirky.ask/wait', { askId, timeoutMs: 0 })
    expect(answered).toMatchObject({ status: 'answered', answers: { role: { value: 'reviewer', source: 'input' } } })
  } finally {
    pair?.page.close()
    pair?.host.close()
    phone?.close()
    await harness?.cleanup()
    if (oldPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = oldPort
  }
}, 20_000)
