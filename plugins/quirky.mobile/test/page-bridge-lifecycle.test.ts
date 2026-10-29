import { afterEach, expect, test } from 'bun:test'
import type { MobileCallOptions, MobilePageBridge, MobilePageInit, MobileRpc } from '../../../apps/mobile/src/contracts'
import { createMobileRpc } from '@quirky/protocol/paired-client'
import { createBridgeHost, type PageBridgeHost } from '../../../apps/mobile/src/shell/bridge-host'
import { PAGE_BUNDLE_ROUTES } from '../../../apps/mobile/src/shell/generation'
import { createPageBridge, type PageBridgePort } from '../../../apps/mobile/src/shell/page-bridge'
import { startBrowserHarness, type BrowserTestHarness } from '../../quirky.browser/test/harness'

type RpcOutcome = { kind: 'result'; value: unknown } | { kind: 'error'; error: unknown }
type RpcCompletion = { method: string; outcome: RpcOutcome }
type RpcWaiter = { count: number; resolve(outcome: RpcOutcome): void }
type ObservedRpc = { rpc: MobileRpc; waitFor(method: string, count?: number): Promise<RpcOutcome>; closeCalls(): number }
type PageMount = { page: MobilePageBridge; host: PageBridgeHost }

let harness: BrowserTestHarness | undefined
let nativeRpc: MobileRpc | undefined
let phone: ObservedRpc | undefined
let previousMobilePort: string | undefined
let portChanged = false
const mounts: PageMount[] = []

function observeRpc(inner: MobileRpc): ObservedRpc {
  const completed: RpcCompletion[] = []
  const waiters = new Map<string, RpcWaiter[]>()
  let closeCount = 0
  const record = (method: string, outcome: RpcOutcome) => {
    completed.push({ method, outcome })
    const matching = waiters.get(method)
    if (!matching) return
    const count = completed.filter((entry) => entry.method === method).length
    const remaining = matching.filter((waiter) => {
      if (waiter.count > count) return true
      waiter.resolve(outcome)
      return false
    })
    if (remaining.length === 0) waiters.delete(method)
    else waiters.set(method, remaining)
  }
  const rpc: MobileRpc = {
    get state() { return inner.state },
    async call<T>(method: string, params: Record<string, unknown> = {}, options?: MobileCallOptions) {
      try {
        const value = await inner.call<T>(method, params, options)
        record(method, { kind: 'result', value })
        return value
      } catch (error) {
        record(method, { kind: 'error', error })
        throw error
      }
    },
    onEvent(handler) { return inner.onEvent(handler) },
    onStream(streamId, handler) { return inner.onStream(streamId, handler) },
    onState(handler) { return inner.onState(handler) },
    close() { closeCount++; inner.close() }
  }
  return {
    rpc,
    closeCalls: () => closeCount,
    waitFor(method, count = 1) {
      const prior = completed.filter((entry) => entry.method === method)
      if (prior.length >= count) return Promise.resolve(prior[count - 1]!.outcome)
      const { promise, resolve } = Promise.withResolvers<RpcOutcome>()
      const methodWaiters = waiters.get(method) ?? []
      methodWaiters.push({ count, resolve })
      waiters.set(method, methodWaiters)
      return promise
    }
  }
}

function mountPage(rpc: MobileRpc, worktreeId: string, sessionId: string): PageMount {
  const route = { kind: 'session' as const, worktreeId, sessionId }
  const routeDefinition = PAGE_BUNDLE_ROUTES.find((item) => item.kind === 'session')!
  const init: MobilePageInit = {
    v: 1,
    sessionId: crypto.randomUUID(),
    host: { id: 'page-lifecycle-host', name: 'Browser fixture desktop', endpoint: 'wss://desktop.invalid/rpc', publicKeyB64: 'fixture-key', lastConnected: Date.now() },
    route,
    grants: [...routeDefinition.grants],
    preferences: {
      sessionView: 'terminal', onboardingCompleted: true, notificationChoice: 'disabled',
      terminalTextScale: 1, autocomplete: false, terminalLinkMode: 'phone', shortcuts: []
    },
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    connectionState: rpc.state
  }
  const listeners = new Set<(json: string) => void>()
  const host = createBridgeHost({
    init,
    rpc,
    storage: { async get() { return null }, async set() {}, async remove() {} },
    native: { async clipboardRead() { return '' }, async clipboardWrite() {}, async openExternal() {}, async haptic() {} },
    sendToPage(json) { for (const listener of listeners) listener(json) },
    onNavigate() {},
    async rememberWorkspace() {}
  })
  const port: PageBridgePort = {
    postMessage(json) { host.receive(json) },
    subscribe(handler) { listeners.add(handler); return () => listeners.delete(handler) }
  }
  const page = createPageBridge(port, init)
  host.receive(JSON.stringify({ v: 1, kind: 'ready' }))
  return { page, host }
}

afterEach(async () => {
  for (const mount of mounts.splice(0)) {
    mount.page.close()
    mount.host.close()
  }
  nativeRpc?.close()
  nativeRpc = undefined
  if (harness) await harness.cleanup()
  harness = undefined
  if (portChanged) {
    if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
  }
  previousMobilePort = undefined
  portChanged = false
})

test('page host teardown releases real terminal and Chrome Watch resources without disconnecting the phone', async () => {
  previousMobilePort = process.env.QUIRKY_MOBILE_PORT
  portChanged = true
  process.env.QUIRKY_MOBILE_PORT = '0'
  harness = await startBrowserHarness({}, { includeMobile: true })
  const worktreeId = await harness.addFolderWorktree('page-bridge-lifecycle')
  const session = await harness.client.callAny('quirky.session/create', {
    worktree: `id:${worktreeId}`, agent: 'shell', cols: 80, rows: 24
  }) as { id: string }
  const pairing = await harness.client.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string }
  const code = new URL(pairing.pairingUrl).searchParams.get('code')
  if (!code) throw new Error('mobile pairing offer did not include its one-time code')
  const offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as {
    endpoint: string
    publicKeyB64: string
    deviceToken: string
  }
  nativeRpc = await createMobileRpc({
    endpoint: offer.endpoint, publicKeyB64: offer.publicKeyB64, token: offer.deviceToken, requestTimeoutMs: 30_000
  })
  phone = observeRpc(nativeRpc)

  const first = mountPage(phone.rpc, worktreeId, session.id)
  mounts.push(first)
  const attached = await first.page.call<{ streamId: number }>('quirky.terminal/attach', {
    session: session.id, cols: 80, rows: 24, historyLines: 10
  })
  const created = await first.page.call<{ tab: { tabId: string; worktreeId: string }; watchId: string }>(
    'quirky.mobile/browserWatchCreate', { worktree: worktreeId, url: `${harness.fixtureUrl}events` }
  )

  first.page.close()
  first.host.close()
  const [detached, stopped] = await Promise.all([
    phone.waitFor('quirky.terminal/detach'),
    phone.waitFor('quirky.mobile/browserWatchStop')
  ])
  expect(detached).toMatchObject({ kind: 'result', value: { ok: true } })
  expect(stopped).toMatchObject({ kind: 'result', value: { closed: true } })
  expect(phone.closeCalls()).toBe(0)
  expect(nativeRpc.state.phase).toBe('connected')
  await expect(nativeRpc.call('quirky.terminal/detach', { streamId: attached.streamId })).rejects.toThrow(/no such stream/i)

  const second = mountPage(phone.rpc, worktreeId, session.id)
  mounts.push(second)
  const resumed = await second.page.call<{ tab: { tabId: string; worktreeId: string }; watchId: string }>(
    'quirky.mobile/browserWatchStart', { worktree: created.tab.worktreeId, tabId: created.tab.tabId }
  )
  expect(resumed.watchId).not.toBe(created.watchId)

  second.page.close()
  second.host.close()
  expect(await phone.waitFor('quirky.mobile/browserWatchStop', 2)).toMatchObject({ kind: 'result', value: { closed: true } })
  expect(nativeRpc.state.phase).toBe('connected')
}, 60_000)
