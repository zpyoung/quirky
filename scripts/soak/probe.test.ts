import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionLost, type QuirkyClient } from '@quirky/protocol'
import { createPtyHostTracker } from './world'
import { startProbe } from './probe'
import type { EventRecord, ProbeRecord } from './contracts'

type ProbeHandle = {
  events: EventRecord[]
  probes: ProbeRecord[]
  daemonExited(): boolean
  finish(): void
  stop(): void
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

type FakeClient = QuirkyClient & {
  calls: string[]
  closeCalls: number
  emitEvent(event: { type: string }): void
  disconnect(): void
}

const activeProbes: ProbeHandle[] = []
const temporaryHomes: string[] = []
let savedSetTimeout: typeof setTimeout | undefined
let savedProcessKill: typeof process.kill | undefined

const realSetTimeout = globalThis.setTimeout

afterEach(() => {
  if (savedSetTimeout) globalThis.setTimeout = savedSetTimeout
  if (savedProcessKill) process.kill = savedProcessKill
  savedSetTimeout = undefined
  savedProcessKill = undefined
  for (const probe of activeProbes.splice(0)) probe.stop()
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-probe-test-'))
  temporaryHomes.push(home)
  return home
}

function launch(overrides: Record<string, unknown> = {}): ProbeHandle {
  const home = typeof overrides.home === 'string' ? overrides.home : newHome()
  const options = {
    home,
    startedAt: performance.now(),
    onDaemonLost: () => undefined,
    isDaemonDead: () => false,
    ...overrides
  } as Parameters<typeof startProbe>[0]
  const probe = startProbe(options) as unknown as ProbeHandle
  activeProbes.push(probe)
  return probe
}

function fakeClient(status: () => unknown = () => ({ ptyHost: { pid: 42 } }), initiallyClosed = false): FakeClient {
  let closed = initiallyClosed
  const eventHandlers = new Set<(event: { type: string }) => void>()
  const closeHandlers = new Set<() => void>()
  const calls: string[] = []
  let closeCalls = 0
  const client = {
    get isClosed() {
      return closed
    },
    calls,
    get closeCalls() {
      return closeCalls
    },
    callAny(method: string): Promise<unknown> {
      calls.push(method)
      if (method !== 'status.get') return Promise.resolve(undefined)
      try {
        return Promise.resolve(status())
      } catch (error) {
        return Promise.reject(error)
      }
    },
    onEvent(handler: (event: { type: string }) => void) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    onClose(handler: () => void) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close() {
      closeCalls++
      this.disconnect()
    },
    emitEvent(event: { type: string }) {
      for (const handler of eventHandlers) handler(event)
    },
    disconnect() {
      if (closed) return
      closed = true
      for (const handler of closeHandlers) handler()
    }
  }
  return client as unknown as FakeClient
}

async function waitFor(predicate: () => boolean, timeoutMs = 400): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate() && performance.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 1)
    await promise
  }
  expect(predicate()).toBe(true)
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function nativeDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  realSetTimeout(resolve, ms)
  return promise
}

function setKill(behavior: (pid: number, signal?: NodeJS.Signals | number) => true): void {
  savedProcessKill ??= process.kill
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => behavior(pid, signal)) as typeof process.kill
}

function writeRuntime(home: string, pid: unknown): void {
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid }))
}

test('returns synchronously during connection and leaves an already-aborted probe inert', async () => {
  const connecting = deferred<QuirkyClient>()
  const client = fakeClient()
  let connectCalls = 0
  let lostCalls = 0
  const probe = launch({
    connect: () => {
      connectCalls++
      return connecting.promise
    },
    onDaemonLost: () => lostCalls++
  })

  expect(connectCalls).toBe(1)
  expect(probe.probes).toEqual([])
  expect(typeof probe.finish).toBe('function')

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const inert = launch({
    signal: alreadyAborted.signal,
    connect: () => {
      connectCalls++
      return Promise.resolve(client)
    },
    onDaemonLost: () => lostCalls++
  })
  expect(connectCalls).toBe(1)
  expect(inert.probes).toEqual([])
  expect(inert.daemonExited()).toBe(false)
  expect(lostCalls).toBe(0)

  probe.stop()
  connecting.resolve(client)
  await waitFor(() => client.closeCalls === 1)
})

test('abort during connection cancels the wait and closes a client that resolves late', async () => {
  const connecting = deferred<QuirkyClient>()
  const client = fakeClient()
  const controller = new AbortController()
  let connectCalls = 0
  let lostCalls = 0
  const probe = launch({
    signal: controller.signal,
    connect: () => {
      connectCalls++
      return connecting.promise
    },
    onDaemonLost: () => lostCalls++
  })

  controller.abort()
  await delay(2)
  expect(connectCalls).toBe(1)
  expect(probe.probes).toEqual([])
  expect(lostCalls).toBe(0)

  connecting.resolve(client)
  await waitFor(() => client.closeCalls === 1)
  expect(probe.daemonExited()).toBe(false)
})

test('records a live connection failure, waits after settle, then recovers to events and status', async () => {
  const first = deferred<QuirkyClient>()
  const status = deferred<unknown>()
  const client = fakeClient(() => status.promise)
  const observed: string[] = []
  let connectCalls = 0
  let lostCalls = 0
  const startedAt = performance.now() - 10
  const probe = launch({
    startedAt,
    retryDelayMs: 40,
    connectTimeoutMs: 500,
    probeTimeoutMs: 500,
    isDaemonDead: () => false,
    connect: () => {
      connectCalls++
      return connectCalls === 1 ? first.promise : Promise.resolve(client)
    },
    onDaemonLost: () => lostCalls++,
    onPtyHostPid: (pid: number | null) => observed.push(`pid:${pid}`)
  })

  first.reject(new Error('transient connection failure'))
  await waitFor(() => probe.probes.length === 1)
  expect(probe.probes[0]).toMatchObject({ timedOut: true })
  expect(probe.probes[0]!.at).toBeGreaterThanOrEqual(0)
  expect(probe.probes[0]!.ms).toBeGreaterThanOrEqual(0)
  expect(probe.probes[0]!.ownLagMs).toBeGreaterThanOrEqual(0)
  expect(probe.daemonExited()).toBe(false)
  expect(lostCalls).toBe(0)

  await delay(8)
  expect(connectCalls).toBe(1)
  await waitFor(() => connectCalls === 2)
  await waitFor(() => client.calls.includes('status.get'))
  client.emitEvent({ type: 'session.updated' })
  observed.push('event:session.updated')
  status.resolve({ ptyHost: { pid: 314 } })
  await waitFor(() => probe.probes.length === 2)

  expect(probe.probes[0]!.timedOut).toBe(true)
  expect(probe.probes[1]!.timedOut).toBe(false)
  expect(probe.probes[1]!.ms).toBeGreaterThanOrEqual(0)
  expect(probe.events.map(({ type }) => type)).toEqual(['session.updated'])
  expect(observed).toEqual(['event:session.updated', 'pid:314'])
  expect(lostCalls).toBe(0)
  probe.stop()
})

test('abort during the retry pause prevents the next connection attempt', async () => {
  const first = deferred<QuirkyClient>()
  const controller = new AbortController()
  let connectCalls = 0
  let lostCalls = 0
  const probe = launch({
    signal: controller.signal,
    retryDelayMs: 55,
    connectTimeoutMs: 500,
    isDaemonDead: () => false,
    connect: () => {
      connectCalls++
      return first.promise
    },
    onDaemonLost: () => lostCalls++
  })

  first.reject(new Error('transient connection failure'))
  await waitFor(() => probe.probes.length === 1)
  await delay(8)
  controller.abort()
  await delay(60)

  expect(connectCalls).toBe(1)
  expect(probe.probes).toHaveLength(1)
  expect(probe.daemonExited()).toBe(false)
  expect(lostCalls).toBe(0)
})

test('re-arms an early connection timeout against monotonic time and closes a late client', async () => {
  const timeoutMs = 30
  const connecting = deferred<QuirkyClient>()
  const client = fakeClient()
  let lostCalls = 0
  let connectCalls = 0
  let earlyTimerCalls = 0
  savedSetTimeout ??= globalThis.setTimeout
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delayMs?: number) => {
    if (delayMs === timeoutMs && earlyTimerCalls === 0) {
      earlyTimerCalls++
      return originalSetTimeout(handler, timeoutMs - 8)
    }
    return originalSetTimeout(handler, delayMs)
  }) as typeof setTimeout

  const beganAt = performance.now()
  const probe = launch({
    connectTimeoutMs: timeoutMs,
    isDaemonDead: () => false,
    connect: () => {
      connectCalls++
      return connecting.promise
    },
    onDaemonLost: () => lostCalls++
  })

  await waitFor(() => lostCalls === 1, 250)
  expect(earlyTimerCalls).toBe(1)
  expect(performance.now() - beganAt).toBeGreaterThanOrEqual(timeoutMs)
  expect(probe.probes).toHaveLength(1)
  expect(probe.probes[0]).toMatchObject({ ms: timeoutMs, timedOut: true })
  expect(probe.daemonExited()).toBe(false)
  expect(connectCalls).toBe(1)

  connecting.resolve(client)
  await waitFor(() => client.closeCalls === 1)
  await delay(8)
  expect(connectCalls).toBe(1)
  expect(lostCalls).toBe(1)
})

test('detects a dead daemon before the first attempt and between live retry attempts', async () => {
  let firstConnectCalls = 0
  let firstLostCalls = 0
  const deadBeforeStart = launch({
    isDaemonDead: () => true,
    connect: () => {
      firstConnectCalls++
      return Promise.resolve(fakeClient())
    },
    onDaemonLost: () => firstLostCalls++
  })
  await waitFor(() => firstLostCalls === 1)
  expect(deadBeforeStart.daemonExited()).toBe(true)
  expect(deadBeforeStart.probes).toEqual([])
  expect(firstConnectCalls).toBe(0)

  const connecting = deferred<QuirkyClient>()
  let alive = true
  let connectCalls = 0
  let lostCalls = 0
  const retryProbe = launch({
    retryDelayMs: 45,
    connectTimeoutMs: 500,
    isDaemonDead: () => !alive,
    connect: () => {
      connectCalls++
      return connecting.promise
    },
    onDaemonLost: () => lostCalls++
  })
  connecting.reject(new Error('failure while daemon was alive'))
  await waitFor(() => retryProbe.probes.length === 1)
  alive = false
  await waitFor(() => lostCalls === 1)

  expect(retryProbe.probes).toHaveLength(1)
  expect(retryProbe.probes[0]!.timedOut).toBe(true)
  expect(retryProbe.daemonExited()).toBe(true)
  expect(connectCalls).toBe(1)
})

test('treats ConnectionLost during connect as daemon loss without recording a stall', async () => {
  let connectCalls = 0
  let lostCalls = 0
  const probe = launch({
    isDaemonDead: () => false,
    retryDelayMs: 10,
    connect: () => {
      connectCalls++
      return Promise.reject(new ConnectionLost())
    },
    onDaemonLost: () => lostCalls++
  })

  await waitFor(() => lostCalls === 1)
  await delay(15)
  expect(probe.daemonExited()).toBe(true)
  expect(probe.probes).toEqual([])
  expect(connectCalls).toBe(1)
})

test('classifies a daemon that dies during a connection hang as exited rather than stalled', async () => {
  let dead = false
  let connectCalls = 0
  let lostCalls = 0
  const probe = launch({
    connectTimeoutMs: 20,
    isDaemonDead: () => dead,
    connect: () => {
      connectCalls++
      return new Promise<QuirkyClient>(() => undefined)
    },
    onDaemonLost: () => lostCalls++
  })
  dead = true
  await waitFor(() => lostCalls === 1)
  expect(probe.daemonExited()).toBe(true)
  expect(probe.probes).toEqual([])
  expect(connectCalls).toBe(1)
})

test('uses runtime.json and ESRCH or EPERM to classify daemon liveness by default', async () => {
  const absentHome = newHome()
  const malformedHome = newHome()
  writeFileSync(join(malformedHome, 'runtime.json'), '{not json')
  const unreadableHome = newHome()
  mkdirSync(join(unreadableHome, 'runtime.json'))

  for (const home of [absentHome, malformedHome, unreadableHome]) {
    let connectCalls = 0
    let lostCalls = 0
    const probe = launch({
      home,
      isDaemonDead: undefined,
      connect: () => {
        connectCalls++
        return Promise.resolve(fakeClient())
      },
      onDaemonLost: () => lostCalls++
    })
    await waitFor(() => lostCalls === 1)
    expect(probe.daemonExited()).toBe(true)
    expect(probe.probes).toEqual([])
    expect(connectCalls).toBe(0)
  }

  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '314', null]) {
    const home = newHome()
    writeRuntime(home, pid)
    let connectCalls = 0
    let killCalls = 0
    let lostCalls = 0
    setKill(() => {
      killCalls++
      return true
    })
    const probe = launch({
      home,
      isDaemonDead: undefined,
      connect: () => {
        connectCalls++
        return Promise.resolve(fakeClient())
      },
      onDaemonLost: () => lostCalls++
    })
    await waitFor(() => lostCalls === 1)
    expect(probe.daemonExited()).toBe(true)
    expect(probe.probes).toEqual([])
    expect(connectCalls).toBe(0)
    expect(killCalls).toBe(0)
  }

  const esrchHome = newHome()
  writeRuntime(esrchHome, 987654)
  let esrchConnectCalls = 0
  let esrchLostCalls = 0
  setKill(() => {
    throw Object.assign(new Error('process is gone'), { code: 'ESRCH' })
  })
  const esrchProbe = launch({
    home: esrchHome,
    isDaemonDead: undefined,
    connect: () => {
      esrchConnectCalls++
      return Promise.resolve(fakeClient())
    },
    onDaemonLost: () => esrchLostCalls++
  })
  await waitFor(() => esrchLostCalls === 1)
  expect(esrchProbe.daemonExited()).toBe(true)
  expect(esrchConnectCalls).toBe(0)

  const liveHome = newHome()
  writeRuntime(liveHome, 987653)
  const liveConnecting = deferred<QuirkyClient>()
  const liveClient = fakeClient()
  let liveConnectCalls = 0
  let liveLostCalls = 0
  setKill(() => true)
  const liveProbe = launch({
    isDaemonDead: undefined,
    home: liveHome,
    connect: () => {
      liveConnectCalls++
      return liveConnecting.promise
    },
    onDaemonLost: () => liveLostCalls++
  })
  expect(liveConnectCalls).toBe(1)
  expect(liveProbe.daemonExited()).toBe(false)
  expect(liveLostCalls).toBe(0)
  liveProbe.stop()
  liveConnecting.resolve(liveClient)
  await waitFor(() => liveClient.closeCalls === 1)

  const epermHome = newHome()
  writeRuntime(epermHome, 987655)
  const epermConnecting = deferred<QuirkyClient>()
  const epermClient = fakeClient()
  let epermConnectCalls = 0
  let epermLostCalls = 0
  setKill(() => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  })
  const epermProbe = launch({
    isDaemonDead: undefined,
    home: epermHome,
    connect: () => {
      epermConnectCalls++
      return epermConnecting.promise
    },
    onDaemonLost: () => epermLostCalls++
  })
  expect(epermConnectCalls).toBe(1)
  expect(epermProbe.daemonExited()).toBe(false)
  expect(epermLostCalls).toBe(0)
  epermProbe.stop()
  epermConnecting.resolve(epermClient)
  await waitFor(() => epermClient.closeCalls === 1)
})

test('stops before retry when runtime.json disappears during the retry pause', async () => {
  const home = newHome()
  writeRuntime(home, 987656)
  setKill(() => true)
  const first = deferred<QuirkyClient>()
  let connectCalls = 0
  let lostCalls = 0
  const probe = launch({
    home,
    isDaemonDead: undefined,
    retryDelayMs: 45,
    connectTimeoutMs: 500,
    connect: () => {
      connectCalls++
      return first.promise
    },
    onDaemonLost: () => lostCalls++
  })

  first.reject(new Error('live daemon rejected connection'))
  await waitFor(() => probe.probes.length === 1)
  unlinkSync(join(home, 'runtime.json'))
  await waitFor(() => lostCalls === 1)

  expect(probe.daemonExited()).toBe(true)
  expect(probe.probes).toHaveLength(1)
  expect(connectCalls).toBe(1)
})

test('stops after an established client closes, is already closed, or loses status RPC', async () => {
  const establishedClient = fakeClient()
  let closeConnectCalls = 0
  let closeLostCalls = 0
  const closeProbe = launch({
    connect: () => {
      closeConnectCalls++
      return Promise.resolve(establishedClient)
    },
    onDaemonLost: () => closeLostCalls++
  })
  await waitFor(() => establishedClient.calls.includes('status.get'))
  establishedClient.emitEvent({ type: 'session.before-close' })
  establishedClient.disconnect()
  await waitFor(() => closeLostCalls === 1)
  const eventCountAtClose = closeProbe.events.length
  establishedClient.emitEvent({ type: 'session.after-close' })
  await delay(5)
  expect(closeProbe.daemonExited()).toBe(true)
  expect(closeProbe.events).toHaveLength(eventCountAtClose)
  expect(closeConnectCalls).toBe(1)

  const alreadyClosedClient = fakeClient(() => ({ ptyHost: { pid: 1 } }), true)
  let closedConnectCalls = 0
  let closedLostCalls = 0
  const alreadyClosedProbe = launch({
    connect: () => {
      closedConnectCalls++
      return Promise.resolve(alreadyClosedClient)
    },
    onDaemonLost: () => closedLostCalls++
  })
  await waitFor(() => closedLostCalls === 1)
  expect(alreadyClosedProbe.daemonExited()).toBe(true)
  expect(alreadyClosedClient.calls).toEqual([])
  expect(closedConnectCalls).toBe(1)

  const lostStatusClient = fakeClient(() => Promise.reject(new ConnectionLost()))
  let statusConnectCalls = 0
  let statusLostCalls = 0
  const lostStatusProbe = launch({
    connect: () => {
      statusConnectCalls++
      return Promise.resolve(lostStatusClient)
    },
    onDaemonLost: () => statusLostCalls++
  })
  await waitFor(() => statusLostCalls === 1)
  expect(lostStatusProbe.daemonExited()).toBe(true)
  expect(lostStatusProbe.probes).toEqual([])
  expect(statusConnectCalls).toBe(1)
})

test('finish records a stalled in-flight connection while stop discards one and closes late clients', async () => {
  const stalledConnect = deferred<QuirkyClient>()
  const finishedClient = fakeClient()
  const finishProbe = launch({
    maxStallMs: 1,
    connectTimeoutMs: 500,
    isDaemonDead: () => false,
    connect: () => stalledConnect.promise
  })
  await delay(8)
  finishProbe.finish()
  expect(finishProbe.probes).toHaveLength(1)
  expect(finishProbe.probes[0]!.ms).toBeGreaterThan(1)
  expect(finishProbe.probes[0]!.timedOut).toBe(true)
  stalledConnect.resolve(finishedClient)
  await waitFor(() => finishedClient.closeCalls === 1)

  const quickConnect = deferred<QuirkyClient>()
  const quickProbe = launch({
    maxStallMs: 200,
    connectTimeoutMs: 500,
    isDaemonDead: () => false,
    connect: () => quickConnect.promise
  })
  quickProbe.finish()
  expect(quickProbe.probes).toEqual([])
  const quickClient = fakeClient()
  quickConnect.resolve(quickClient)
  await waitFor(() => quickClient.closeCalls === 1)

  const stoppedConnect = deferred<QuirkyClient>()
  const stoppedClient = fakeClient()
  const stopProbe = launch({
    maxStallMs: 1,
    connectTimeoutMs: 500,
    isDaemonDead: () => false,
    connect: () => stoppedConnect.promise
  })
  await delay(8)
  stopProbe.stop()
  expect(stopProbe.probes).toEqual([])
  stoppedConnect.resolve(stoppedClient)
  await waitFor(() => stoppedClient.closeCalls === 1)
})

test('finish records in-flight status duration and timeout state while stop discards it', async () => {
  const status = deferred<unknown>()
  const client = fakeClient(() => status.promise)
  const probe = launch({
    maxStallMs: 1,
    probeTimeoutMs: 500,
    connectTimeoutMs: 500,
    connect: () => Promise.resolve(client)
  })
  await waitFor(() => client.calls.includes('status.get'))
  await delay(8)
  probe.finish()
  expect(probe.probes).toHaveLength(1)
  expect(probe.probes[0]!.ms).toBeGreaterThan(1)
  expect(probe.probes[0]!.timedOut).toBe(false)

  const quickStatus = deferred<unknown>()
  const quickClient = fakeClient(() => quickStatus.promise)
  const quickProbe = launch({
    maxStallMs: 200,
    probeTimeoutMs: 500,
    connectTimeoutMs: 500,
    connect: () => Promise.resolve(quickClient)
  })
  await waitFor(() => quickClient.calls.includes('status.get'))
  quickProbe.finish()
  expect(quickProbe.probes).toEqual([])

  const timedStatus = deferred<unknown>()
  const timedClient = fakeClient(() => timedStatus.promise)
  const timeoutMs = 14
  savedSetTimeout ??= globalThis.setTimeout
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delayMs?: number) => {
    if (delayMs === timeoutMs) return originalSetTimeout(handler, timeoutMs + 100)
    return originalSetTimeout(handler, delayMs)
  }) as typeof setTimeout
  const timedProbe = launch({
    maxStallMs: 1,
    probeTimeoutMs: timeoutMs,
    connectTimeoutMs: 500,
    connect: () => Promise.resolve(timedClient)
  })
  await waitFor(() => timedClient.calls.includes('status.get'))
  await nativeDelay(timeoutMs + 6)
  timedProbe.finish()
  expect(timedProbe.probes).toHaveLength(1)
  expect(timedProbe.probes[0]!.ms).toBe(timeoutMs)
  expect(timedProbe.probes[0]!.timedOut).toBe(true)

  const stoppedStatus = deferred<unknown>()
  const stoppedClient = fakeClient(() => stoppedStatus.promise)
  const stoppedProbe = launch({
    maxStallMs: 1,
    probeTimeoutMs: 500,
    connectTimeoutMs: 500,
    connect: () => Promise.resolve(stoppedClient)
  })
  await waitFor(() => stoppedClient.calls.includes('status.get'))
  await delay(8)
  stoppedProbe.stop()
  expect(stoppedProbe.probes).toEqual([])
})

test('tracks each distinct positive safe-integer pty host PID once', () => {
  const tracked: number[] = []
  const tracker = createPtyHostTracker((pid) => tracked.push(pid), 41)
  expect(tracker.current()).toBe(41)
  expect(tracked).toEqual([41])

  tracker.update(41)
  tracker.update(null)
  expect(tracker.current()).toBe(null)
  tracker.update(0)
  tracker.update(-1)
  tracker.update(1.5)
  tracker.update('41')
  tracker.update(Number.MAX_SAFE_INTEGER + 1)
  tracker.update(undefined)
  expect(tracker.current()).toBe(null)
  expect(tracked).toEqual([41])

  tracker.update(88)
  expect(tracker.current()).toBe(88)
  tracker.update(41)
  expect(tracker.current()).toBe(41)
  expect(tracked).toEqual([41, 88])
})
