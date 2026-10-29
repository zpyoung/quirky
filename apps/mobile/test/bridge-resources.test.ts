import { expect, test } from 'bun:test'
import type { MobileConnectionState, MobilePageBridge, MobilePageInit, MobileRpc } from '../src/contracts'
import { createBridgeHost, type PageBridgeHost } from '../src/shell/bridge-host'
import { createPageBridge, type PageBridgePort } from '../src/shell/page-bridge'

type Call = { method: string; params: Record<string, unknown> }
type RpcResponder = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
type RpcHarness = {
  rpc: MobileRpc
  calls: Call[]
  closeCalls(): number
  waitForCall(method: string, count?: number): Promise<void>
}
type BridgePair = { host: PageBridgeHost; page: MobilePageBridge }

const state = (phase: MobileConnectionState['phase'] = 'connected'): MobileConnectionState => ({ phase, attempts: 0 })
const init: MobilePageInit = {
  v: 1,
  sessionId: 'mount-resource-1',
  host: { id: 'resource-host', name: 'Desktop', endpoint: 'wss://desktop.example/rpc', publicKeyB64: 'public-key', lastConnected: null },
  route: { kind: 'session', worktreeId: 'worktree-1', sessionId: 'session-1' },
  grants: ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink'],
  preferences: { sessionView: 'terminal', onboardingCompleted: true, notificationChoice: 'disabled', terminalTextScale: 1, autocomplete: false, terminalLinkMode: 'phone', shortcuts: [] },
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  connectionState: state()
}
const browserTab = {
  tabId: 'tab-1', worktreeId: 'worktree-1', kind: 'browser' as const,
  title: 'Watch page', dirty: false, browserMode: 'watch' as const
}
const browserLease = { tab: browserTab, watchId: 'watch-1' }

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function makeRpc(respond: RpcResponder = (method) => {
  if (method === 'quirky.terminal/attach') return { streamId: 9 }
  if (method === 'quirky.terminal/detach') return { ok: true }
  if (method === 'quirky.mobile/browserWatchCreate' || method === 'quirky.mobile/browserWatchStart') return browserLease
  if (method === 'quirky.mobile/browserWatchStop') return { closed: true }
  return { ok: true }
}): RpcHarness {
  const calls: Call[] = []
  const streams = new Map<number, (bytes: Uint8Array) => void>()
  const handlers = new Set<(next: MobileConnectionState) => void>()
  const callCounts = new Map<string, number>()
  const waiters = new Map<string, Array<{ count: number; resolve(): void }>>()
  let currentState = state()
  let closeCount = 0
  const waitForCall = (method: string, count = 1): Promise<void> => {
    if ((callCounts.get(method) ?? 0) >= count) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    const pending = waiters.get(method) ?? []
    pending.push({ count, resolve })
    waiters.set(method, pending)
    return promise
  }
  const rpc: MobileRpc = {
    get state() { return currentState },
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const count = (callCounts.get(method) ?? 0) + 1
      callCounts.set(method, count)
      const pending = waiters.get(method)
      if (pending) {
        const remaining = pending.filter((waiter) => {
          if (waiter.count > count) return true
          waiter.resolve()
          return false
        })
        if (remaining.length === 0) waiters.delete(method)
        else waiters.set(method, remaining)
      }
      return await respond(method, params) as T
    },
    onEvent() { return () => {} },
    onState(handler) { handlers.add(handler); handler(currentState); return () => handlers.delete(handler) },
    onStream(streamId, handler) { streams.set(streamId, handler); return () => streams.delete(streamId) },
    close() { closeCount++ }
  }
  return { rpc, calls, closeCalls: () => closeCount, waitForCall }
}

function openBridge(rpc: MobileRpc, options: { failReplies?: boolean; pageInit?: MobilePageInit } = {}): BridgePair {
  const pageInit = options.pageInit ?? init
  const pageListeners = new Set<(json: string) => void>()
  const host = createBridgeHost({
    init: pageInit,
    rpc,
    storage: { async get() { return null }, async set() {}, async remove() {} },
    native: { async clipboardRead() { return '' }, async clipboardWrite() {}, async openExternal() {}, async haptic() {} },
    sendToPage(json) {
      const message = JSON.parse(json) as { kind?: unknown }
      if (options.failReplies && message.kind === 'reply') throw new Error('page delivery failed')
      for (const listener of pageListeners) listener(json)
    },
    onNavigate() {},
    async rememberWorkspace() {}
  })
  const port: PageBridgePort = {
    postMessage(json) { host.receive(json) },
    subscribe(handler) { pageListeners.add(handler); return () => pageListeners.delete(handler) }
  }
  const page = createPageBridge(port, pageInit)
  host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
  return { host, page }
}

function callsFor(rpc: RpcHarness, method: string): Call[] {
  return rpc.calls.filter((call) => call.method === method)
}

async function flushPromiseContinuations(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('acknowledged explicit detach and Watch stop are not repeated by host close', async () => {
  const rpc = makeRpc()
  const pair = openBridge(rpc.rpc)
  const attached = await pair.page.call<{ streamId: number }>('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  await expect(pair.page.call('quirky.terminal/detach', { streamId: attached.streamId })).resolves.toEqual({ ok: true })
  await pair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  await expect(pair.page.call('quirky.mobile/browserWatchStop', {
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })).resolves.toEqual({ closed: true })

  pair.page.close()
  pair.host.close()
  expect(callsFor(rpc, 'quirky.terminal/detach')).toHaveLength(1)
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toHaveLength(1)
})

test('an attach that completes after page close is detached by its captured RPC', async () => {
  const started = deferred<void>()
  const attach = deferred<unknown>()
  const rpc = makeRpc((method) => {
    if (method === 'quirky.terminal/attach') { started.resolve(); return attach.promise }
    if (method === 'quirky.terminal/detach') return { ok: true }
    return { ok: true }
  })
  const pair = openBridge(rpc.rpc)
  const request = pair.page.call('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  await started.promise

  pair.page.close()
  pair.host.close()
  await expect(request).rejects.toThrow(/closed/i)
  attach.resolve({ streamId: 41 })
  await rpc.waitForCall('quirky.terminal/detach')

  expect(callsFor(rpc, 'quirky.terminal/detach')[0]?.params).toEqual({ streamId: 41 })
  expect(rpc.closeCalls()).toBe(0)
})

test('a create that completes after page close is stopped by its returned lease identity', async () => {
  const started = deferred<void>()
  const create = deferred<unknown>()
  const rpc = makeRpc((method) => {
    if (method === 'quirky.mobile/browserWatchCreate') { started.resolve(); return create.promise }
    if (method === 'quirky.mobile/browserWatchStop') return { closed: true }
    return { ok: true }
  })
  const pair = openBridge(rpc.rpc)
  const request = pair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  await started.promise

  pair.page.close()
  pair.host.close()
  await expect(request).rejects.toThrow(/closed/i)
  create.resolve(browserLease)
  await rpc.waitForCall('quirky.mobile/browserWatchStop')
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')[0]?.params).toEqual({
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })
})

test('an attach from an old RPC epoch cleans up only through that captured RPC', async () => {
  const started = deferred<void>()
  const oldAttach = deferred<unknown>()
  const oldRpc = makeRpc((method) => {
    if (method === 'quirky.terminal/attach') { started.resolve(); return oldAttach.promise }
    if (method === 'quirky.terminal/detach') return { ok: true }
    return { ok: true }
  })
  const newRpc = makeRpc((method) => method === 'quirky.terminal/attach' ? { streamId: 55 } : { ok: true })
  const pair = openBridge(oldRpc.rpc)
  const oldRequest = pair.page.call('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  await started.promise

  pair.host.setRpc(newRpc.rpc)
  await expect(oldRequest).rejects.toThrow(/connection changed/i)
  const current = await pair.page.call<{ streamId: number }>('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  oldAttach.resolve({ streamId: current.streamId })
  await oldRpc.waitForCall('quirky.terminal/detach')
  expect(callsFor(newRpc, 'quirky.terminal/detach')).toEqual([])

  pair.page.close()
  pair.host.close()
  await newRpc.waitForCall('quirky.terminal/detach')
  expect(callsFor(oldRpc, 'quirky.terminal/detach')[0]?.params).toEqual({ streamId: current.streamId })
  expect(callsFor(newRpc, 'quirky.terminal/detach')[0]?.params).toEqual({ streamId: current.streamId })
})
test('a Browser Watch create completing after rebind is stopped by its original RPC', async () => {
  const started = deferred<void>()
  const create = deferred<unknown>()
  const oldRpc = makeRpc((method) => {
    if (method === 'quirky.mobile/browserWatchCreate') { started.resolve(); return create.promise }
    if (method === 'quirky.mobile/browserWatchStop') return { closed: true }
    return { ok: true }
  })
  const newRpc = makeRpc()
  const pair = openBridge(oldRpc.rpc)
  const oldRequest = pair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  await started.promise

  pair.host.setRpc(newRpc.rpc)
  await expect(oldRequest).rejects.toThrow(/connection changed/i)
  create.resolve(browserLease)
  await oldRpc.waitForCall('quirky.mobile/browserWatchStop')
  expect(callsFor(newRpc, 'quirky.mobile/browserWatchStop')).toEqual([])
  pair.page.close()
  pair.host.close()
})
test('a pending newer Watch start protects an old page lease until the newer start resolves', async () => {
  const firstStarted = deferred<void>()
  const secondStarted = deferred<void>()
  const firstStart = deferred<unknown>()
  const secondStart = deferred<unknown>()
  let starts = 0
  const rpc = makeRpc((method) => {
    if (method === 'quirky.mobile/browserWatchStart') {
      starts++
      if (starts === 1) { firstStarted.resolve(); return firstStart.promise }
      secondStarted.resolve()
      return secondStart.promise
    }
    if (method === 'quirky.mobile/browserWatchStop') return { closed: true }
    return { ok: true }
  })
  const oldPair = openBridge(rpc.rpc)
  const oldRequest = oldPair.page.call('quirky.mobile/browserWatchStart', { worktree: 'worktree-1', tabId: browserTab.tabId })
  await firstStarted.promise
  const newPair = openBridge(rpc.rpc, { pageInit: { ...init, sessionId: 'mount-resource-pending' } })
  const newRequest = newPair.page.call('quirky.mobile/browserWatchStart', { worktree: 'worktree-1', tabId: browserTab.tabId })
  await secondStarted.promise

  oldPair.page.close()
  oldPair.host.close()
  await expect(oldRequest).rejects.toThrow(/closed/i)
  firstStart.resolve(browserLease)
  await flushPromiseContinuations()
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toEqual([])

  secondStart.resolve(browserLease)
  await expect(newRequest).resolves.toEqual(browserLease)
  newPair.page.close()
  newPair.host.close()
  await rpc.waitForCall('quirky.mobile/browserWatchStop')
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toHaveLength(1)
})

test('an explicit stop releases only this host reference while another page still owns the Watch', async () => {
  const rpc = makeRpc()
  const owner = openBridge(rpc.rpc)
  await owner.page.call<typeof browserLease>('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  const adopter = openBridge(rpc.rpc, { pageInit: { ...init, sessionId: 'mount-resource-adopter' } })
  await adopter.page.call<typeof browserLease>('quirky.mobile/browserWatchStart', { worktree: 'worktree-1', tabId: browserTab.tabId })

  await expect(adopter.page.call('quirky.mobile/browserWatchStop', {
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })).resolves.toEqual({ closed: false })
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toEqual([])

  adopter.page.close()
  adopter.host.close()
  owner.page.close()
  owner.host.close()
  await rpc.waitForCall('quirky.mobile/browserWatchStop')
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toHaveLength(1)
})

test('a closed old Watch start cannot stop a same-lease owner acquired by a newer page', async () => {
  const oldStarted = deferred<void>()
  const oldStart = deferred<unknown>()
  let starts = 0
  const rpc = makeRpc((method) => {
    if (method === 'quirky.mobile/browserWatchStart') {
      starts++
      if (starts === 1) { oldStarted.resolve(); return oldStart.promise }
      return browserLease
    }
    if (method === 'quirky.mobile/browserWatchStop') return { closed: true }
    return { ok: true }
  })
  const oldPair = openBridge(rpc.rpc)
  const oldRequest = oldPair.page.call('quirky.mobile/browserWatchStart', { worktree: 'worktree-1', tabId: browserTab.tabId })
  await oldStarted.promise
  const newPair = openBridge(rpc.rpc, { pageInit: { ...init, sessionId: 'mount-resource-2' } })
  await expect(newPair.page.call('quirky.mobile/browserWatchStart', { worktree: 'worktree-1', tabId: browserTab.tabId }))
    .resolves.toEqual(browserLease)

  oldPair.page.close()
  oldPair.host.close()
  await expect(oldRequest).rejects.toThrow(/closed/i)
  oldStart.resolve(browserLease)
  await flushPromiseContinuations()
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toEqual([])

  newPair.page.close()
  newPair.host.close()
  await rpc.waitForCall('quirky.mobile/browserWatchStop')
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')[0]?.params).toEqual({
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })
})

test('another page cannot detach or stop a stream and lease it does not own', async () => {
  const rpc = makeRpc()
  const owner = openBridge(rpc.rpc)
  const attached = await owner.page.call<{ streamId: number }>('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  const created = await owner.page.call<typeof browserLease>('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  const foreign = openBridge(rpc.rpc, { pageInit: { ...init, sessionId: 'mount-resource-foreign' } })

  await expect(foreign.page.call('quirky.terminal/detach', { streamId: attached.streamId })).rejects.toThrow(/own/i)
  await expect(foreign.page.call('quirky.mobile/browserWatchStop', {
    worktree: created.tab.worktreeId, tabId: created.tab.tabId, watchId: created.watchId
  })).rejects.toThrow(/own/i)
  expect(callsFor(rpc, 'quirky.terminal/detach')).toEqual([])
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')).toEqual([])

  foreign.page.close()
  foreign.host.close()
  owner.page.close()
  owner.host.close()
  await Promise.all([rpc.waitForCall('quirky.terminal/detach'), rpc.waitForCall('quirky.mobile/browserWatchStop')])
})

test('invalid acquisitions and unacknowledged stop responses do not authorize retries', async () => {
  const invalidRpc = makeRpc((method) => {
    if (method === 'quirky.terminal/attach') return { streamId: 'not-a-stream-id' }
    if (method === 'quirky.mobile/browserWatchCreate') return { tab: browserTab, watchId: '' }
    return { ok: true }
  })
  const invalidPair = openBridge(invalidRpc.rpc)
  await invalidPair.page.call('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  await invalidPair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  invalidPair.page.close()
  invalidPair.host.close()
  expect(callsFor(invalidRpc, 'quirky.terminal/detach')).toEqual([])
  expect(callsFor(invalidRpc, 'quirky.mobile/browserWatchStop')).toEqual([])

  const explicitRpc = makeRpc((method) => {
    if (method === 'quirky.terminal/attach') return { streamId: 73 }
    if (method === 'quirky.terminal/detach') return { ok: false }
    if (method === 'quirky.mobile/browserWatchCreate') return browserLease
    if (method === 'quirky.mobile/browserWatchStop') return { closed: false }
    return { ok: true }
  })
  const explicitPair = openBridge(explicitRpc.rpc)
  await explicitPair.page.call('quirky.terminal/attach', { session: 'session-1', cols: 80, rows: 24 })
  await explicitPair.page.call('quirky.terminal/detach', { streamId: 73 })
  await explicitPair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  await explicitPair.page.call('quirky.mobile/browserWatchStop', {
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })
  explicitPair.page.close()
  explicitPair.host.close()
  expect(callsFor(explicitRpc, 'quirky.terminal/detach')).toHaveLength(1)
  expect(callsFor(explicitRpc, 'quirky.mobile/browserWatchStop')).toHaveLength(1)
})

test('an acquisition whose response cannot be serialized is reclaimed', async () => {
  const rpc = makeRpc((method) => {
    if (method === 'quirky.mobile/browserWatchCreate') return { ...browserLease, extra: 'x'.repeat(700 * 1024) }
    if (method === 'quirky.mobile/browserWatchStop') return { closed: true }
    return { ok: true }
  })
  const pair = openBridge(rpc.rpc)
  await expect(pair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })).rejects.toThrow(/bridge limit/i)
  await rpc.waitForCall('quirky.mobile/browserWatchStop')
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')[0]?.params).toEqual({
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })
  pair.page.close()
  pair.host.close()
})
test('a successful acquisition whose bridge reply cannot be delivered is reclaimed', async () => {
  const rpc = makeRpc()
  const pair = openBridge(rpc.rpc, { failReplies: true })
  const request = pair.page.call('quirky.mobile/browserWatchCreate', { worktree: 'worktree-1' })
  await rpc.waitForCall('quirky.mobile/browserWatchStop')

  pair.page.close()
  pair.host.close()
  await expect(request).rejects.toThrow(/closed/i)
  expect(callsFor(rpc, 'quirky.mobile/browserWatchStop')[0]?.params).toEqual({
    worktree: browserTab.worktreeId, tabId: browserTab.tabId, watchId: browserLease.watchId
  })
})
