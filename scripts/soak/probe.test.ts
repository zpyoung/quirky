import { afterEach, expect, jest, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionLost, type QuirkyClient } from '@quirky/protocol'
import { createPtyHostTracker } from './world'
import { createPongMatcher, startProbe } from './probe'
import type { EventRecord, GitProbeRecord, ProbeRecord, TerminalProbeRecord } from './contracts'

type ProbeHandle = {
  events: EventRecord[]
  probes: ProbeRecord[]
  gitProbes: GitProbeRecord[]
  terminalProbes: TerminalProbeRecord[]
  daemonExited(): boolean
  finish(): void
  stop(): void
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

type TerminalBehavior = {
  sessions?: () => unknown
  attach?: (params: unknown) => unknown
  send?: (params: unknown) => unknown
  detach?: (params: unknown) => unknown
}

type TerminalSubscription = {
  streamId: number
  handler: (bytes: Uint8Array) => void
  onLagged?: () => void
  disposed: boolean
}

type FakeClient = QuirkyClient & {
  calls: string[]
  rpcCalls: { method: string; params: unknown; options: unknown }[]
  closeCalls: number
  terminalSubscriptions: TerminalSubscription[]
  emitEvent(event: { type: string }): void
  emitTerminal(streamId: number, bytes: Uint8Array | string): void
  lagTerminal(streamId: number): void
  disconnect(): void
}

const activeProbes: ProbeHandle[] = []
const temporaryHomes: string[] = []
let savedSetTimeout: typeof setTimeout | undefined
let savedProcessKill: typeof process.kill | undefined

const realSetTimeout = globalThis.setTimeout

const timerControls = jest as unknown as { advanceTimersByTime(ms: number): void }
const advanceTimersByTime = (ms: number): void => timerControls.advanceTimersByTime(ms)

type ProbeClock = {
  now(): number
  jumpTo(ms: number): void
  advanceBy(ms: number): void
}

async function drainMicrotasks(rounds = 32): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}

async function drainUntil(predicate: () => boolean, rounds = 32): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    if (predicate()) return
    await Promise.resolve()
  }
  expect(predicate()).toBe(true)
}

async function advanceProbeClock(clock: ProbeClock, target: number, quantumMs = 50): Promise<void> {
  let current = clock.now()
  while (current < target) {
    const next = Math.min(target, current + quantumMs)
    clock.jumpTo(next)
    advanceTimersByTime(next - current)
    current = next
    await drainMicrotasks()
  }
}

async function withProbeClock(
  action: (clock: ProbeClock) => Promise<void>,
  clockOnly = false
): Promise<void> {
  jest.useFakeTimers()
  const probeIndex = activeProbes.length
  let monotonicNow = performance.now()
  let restoreOwnedClock: (() => void) | undefined
  try {
    if (clockOnly) {
      const clockSpy = spyOn(performance, 'now').mockImplementation(() => monotonicNow)
      restoreOwnedClock = () => clockSpy.mockRestore()
    }
    const clock: ProbeClock = {
      now: () => performance.now(),
      jumpTo: (ms) => {
        monotonicNow = ms
      },
      advanceBy: (ms) => {
        advanceTimersByTime(ms)
        if (clockOnly) monotonicNow += ms
      }
    }
    await action(clock)
  } finally {
    try {
      for (const probe of activeProbes.slice(probeIndex)) probe.stop()
      await drainMicrotasks()
    } finally {
      restoreOwnedClock?.()
      jest.useRealTimers()
    }
  }
}



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

function fakeClient(
  status: () => unknown = () => ({ ptyHost: { pid: 42 } }),
  initiallyClosed = false,
  gitStatus: (params: unknown) => unknown = () => undefined,
  terminal: TerminalBehavior = {}
): FakeClient {
  let closed = initiallyClosed
  let nextStreamId = 70
  const eventHandlers = new Set<(event: { type: string }) => void>()
  const closeHandlers = new Set<() => void>()
  const terminalSubscriptions: TerminalSubscription[] = []
  const calls: string[] = []
  const rpcCalls: FakeClient['rpcCalls'] = []
  let closeCalls = 0
  const client = {
    get isClosed() {
      return closed
    },
    calls,
    rpcCalls,
    terminalSubscriptions,
    get closeCalls() {
      return closeCalls
    },
    callAny(method: string, params?: unknown, options?: unknown): Promise<unknown> {
      calls.push(method)
      rpcCalls.push({ method, params, options })
      try {
        if (method === 'status.get') return Promise.resolve(status())
        if (method === 'quirky.git/status') return Promise.resolve(gitStatus(params))
        if (method === 'quirky.terminal/sessions') {
          return Promise.resolve(terminal.sessions?.() ?? {
            sessions: [{ sessionId: 's1', cols: 132, rows: 40 }]
          })
        }
        if (method === 'quirky.terminal/attach') {
          return Promise.resolve(terminal.attach?.(params) ?? { streamId: ++nextStreamId, replay: '' })
        }
        if (method === 'quirky.terminal/send') return Promise.resolve(terminal.send?.(params))
        if (method === 'quirky.terminal/detach') return Promise.resolve(terminal.detach?.(params))
        return Promise.resolve(undefined)
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
    onTerminalOutput(
      streamId: number,
      handler: (bytes: Uint8Array) => void,
      options?: { onLagged?: () => void }
    ) {
      const subscription: TerminalSubscription = {
        streamId,
        handler,
        onLagged: options?.onLagged,
        disposed: false
      }
      terminalSubscriptions.push(subscription)
      return () => {
        subscription.disposed = true
      }
    },
    close() {
      closeCalls++
      this.disconnect()
    },
    emitEvent(event: { type: string }) {
      for (const handler of eventHandlers) handler(event)
    },
    emitTerminal(streamId: number, bytes: Uint8Array | string) {
      const chunk = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      for (const subscription of terminalSubscriptions) {
        if (subscription.streamId === streamId && !subscription.disposed) subscription.handler(chunk)
      }
    },
    lagTerminal(streamId: number) {
      for (const subscription of terminalSubscriptions) {
        if (subscription.streamId === streamId && !subscription.disposed) subscription.onLagged?.()
      }
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

test('records a pending status watchdog at its exact deadline and ignores late settlement', async () => {
  await withProbeClock(async (clock) => {
    for (const lateSettlement of ['resolve', 'reject'] as const) {
      const status = deferred<unknown>()
      const client = fakeClient(() => status.promise)
      let connectionCalls = 0
      let lostCalls = 0
      const pidCalls: Array<number | null> = []
      const probe = launch({
        probeTimeoutMs: 40,
        connect: () => {
          connectionCalls++
          return Promise.resolve(client)
        },
        onDaemonLost: () => lostCalls++,
        onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
      })
      await drainUntil(() => client.calls.includes('status.get'))
      expect(connectionCalls).toBe(1)
      expect(client.calls).toEqual(['status.get'])

      clock.advanceBy(39)
      await drainMicrotasks()
      expect(probe.probes).toEqual([])
      expect(lostCalls).toBe(0)

      clock.advanceBy(1)
      await drainMicrotasks()
      const expectTerminalResult = () => {
        expect(probe.probes).toEqual([{ at: 0, ms: 40, ownLagMs: 0, timedOut: true }])
        expect(lostCalls).toBe(1)
        expect(probe.daemonExited()).toBe(false)
        expect(client.closeCalls).toBe(1)
        expect(pidCalls).toEqual([])
        expect(connectionCalls).toBe(1)
        expect(client.calls).toEqual(['status.get'])
      }
      expectTerminalResult()

      if (lateSettlement === 'resolve') status.resolve({ ptyHost: { pid: 99 } })
      else status.reject(new Error('late status failure'))
      await drainMicrotasks()
      clock.advanceBy(1000)
      await drainMicrotasks()
      expectTerminalResult()
    }
  })
})

test('classifies the exact RPC timeout error as a status timeout before the watchdog', async () => {
  await withProbeClock(async (clock) => {
    const status = deferred<unknown>()
    const client = fakeClient(() => status.promise)
    let connectionCalls = 0
    let lostCalls = 0
    const pidCalls: Array<number | null> = []
    const probe = launch({
      probeTimeoutMs: 40,
      connect: () => {
        connectionCalls++
        return Promise.resolve(client)
      },
      onDaemonLost: () => lostCalls++,
      onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
    })
    await drainUntil(() => client.calls.includes('status.get'))

    clock.advanceBy(5)
    status.reject(new Error('RPC call timed out after 40 ms'))
    await drainMicrotasks()
    const expectTerminalResult = () => {
      expect(probe.probes).toEqual([{ at: 0, ms: 40, ownLagMs: 0, timedOut: true }])
      expect(lostCalls).toBe(1)
      expect(probe.daemonExited()).toBe(false)
      expect(client.closeCalls).toBe(1)
      expect(pidCalls).toEqual([])
      expect(connectionCalls).toBe(1)
      expect(client.calls).toEqual(['status.get'])
    }
    expectTerminalResult()

    clock.advanceBy(1000)
    await drainMicrotasks()
    expectTerminalResult()
  })
})

test('classifies an ordinary status rejection at the deadline by elapsed time', async () => {
  await withProbeClock(async (clock) => {
    const status = deferred<unknown>()
    const client = fakeClient(() => status.promise)
    let connectionCalls = 0
    let lostCalls = 0
    const pidCalls: Array<number | null> = []
    const probe = launch({
      probeTimeoutMs: 40,
      connect: () => {
        connectionCalls++
        return Promise.resolve(client)
      },
      onDaemonLost: () => lostCalls++,
      onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
    })
    await drainUntil(() => client.calls.includes('status.get'))

    const beganAt = clock.now()
    clock.jumpTo(beganAt + 40)
    status.reject(new Error('ordinary status failure'))
    await drainMicrotasks()
    const expectTerminalResult = () => {
      expect(probe.probes).toEqual([{ at: 0, ms: 40, ownLagMs: 0, timedOut: true }])
      expect(lostCalls).toBe(1)
      expect(probe.daemonExited()).toBe(false)
      expect(client.closeCalls).toBe(1)
      expect(pidCalls).toEqual([])
      expect(connectionCalls).toBe(1)
      expect(client.calls).toEqual(['status.get'])
    }
    expectTerminalResult()

    clock.advanceBy(1000)
    await drainMicrotasks()
    expectTerminalResult()
  }, true)
})

test('keeps an early ordinary status rejection nonterminal and waits 250 ms before retrying', async () => {
  await withProbeClock(async (clock) => {
    const firstStatus = deferred<unknown>()
    const secondStatus = deferred<unknown>()
    let statusCalls = 0
    const client = fakeClient(() => {
      statusCalls++
      return statusCalls === 1 ? firstStatus.promise : secondStatus.promise
    })
    let connectionCalls = 0
    let lostCalls = 0
    const probe = launch({
      probeTimeoutMs: 40,
      connect: () => {
        connectionCalls++
        return Promise.resolve(client)
      },
      onDaemonLost: () => lostCalls++
    })
    await drainUntil(() => client.calls.includes('status.get'))
    expect(statusCalls).toBe(1)

    clock.advanceBy(5)
    firstStatus.reject(new Error('ordinary status failure'))
    await drainMicrotasks()
    const ordinaryFailure = [{ at: 0, ms: 5, ownLagMs: 0, timedOut: false }]
    expect(probe.probes).toEqual(ordinaryFailure)
    expect(lostCalls).toBe(0)
    expect(client.closeCalls).toBe(0)

    clock.advanceBy(249)
    await drainMicrotasks()
    expect(statusCalls).toBe(1)
    expect(client.calls).toEqual(['status.get'])
    clock.advanceBy(1)
    await drainUntil(() => statusCalls === 2)
    expect(statusCalls).toBe(2)
    expect(client.calls).toEqual(['status.get', 'status.get'])
    expect(probe.probes).toEqual(ordinaryFailure)
    expect(lostCalls).toBe(0)
    expect(connectionCalls).toBe(1)

    probe.stop()
    await drainMicrotasks()
    clock.advanceBy(1000)
    await drainMicrotasks()
    expect(probe.probes).toEqual(ordinaryFailure)
    expect(lostCalls).toBe(0)
    expect(connectionCalls).toBe(1)
  })
})

test('does not accept successful status replies at or beyond the watchdog deadline', async () => {
  await withProbeClock(async (clock) => {
    for (const elapsedMs of [40, 41]) {
      const status = deferred<unknown>()
      const client = fakeClient(() => status.promise)
      let connectionCalls = 0
      let lostCalls = 0
      const pidCalls: Array<number | null> = []
      const probe = launch({
        probeTimeoutMs: 40,
        connect: () => {
          connectionCalls++
          return Promise.resolve(client)
        },
        onDaemonLost: () => lostCalls++,
        onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
      })
      await drainUntil(() => client.calls.includes('status.get'))
      const beganAt = clock.now()
      clock.jumpTo(beganAt + elapsedMs)

      status.resolve({ ptyHost: { pid: 42 } })
      await drainMicrotasks()
      const expectTerminalResult = () => {
        expect(probe.probes).toEqual([{ at: 0, ms: 40, ownLagMs: 0, timedOut: true }])
        expect(lostCalls).toBe(1)
        expect(probe.daemonExited()).toBe(false)
        expect(client.closeCalls).toBe(1)
        expect(pidCalls).toEqual([])
        expect(connectionCalls).toBe(1)
        expect(client.calls).toEqual(['status.get'])
      }
      expectTerminalResult()

      clock.advanceBy(1000)
      await drainMicrotasks()
      expectTerminalResult()
    }
  }, true)
})

test('closes connections that resolve at or beyond the connection deadline without using them', async () => {
  await withProbeClock(async (clock) => {
    for (const elapsedMs of [40, 41]) {
      const connecting = deferred<QuirkyClient>()
      const client = fakeClient()
      let connectionCalls = 0
      let lostCalls = 0
      const probe = launch({
        connectTimeoutMs: 40,
        connect: () => {
          connectionCalls++
          return connecting.promise
        },
        onDaemonLost: () => lostCalls++
      })
      await drainUntil(() => connectionCalls === 1)
      const beganAt = clock.now()
      clock.jumpTo(beganAt + elapsedMs)

      connecting.resolve(client)
      await drainMicrotasks()
      const expectTerminalResult = () => {
        expect(probe.probes).toEqual([{ at: 0, ms: 40, ownLagMs: 0, timedOut: true }])
        expect(lostCalls).toBe(1)
        expect(probe.daemonExited()).toBe(false)
        expect(client.closeCalls).toBe(1)
        expect(client.calls).toEqual([])
        expect(connectionCalls).toBe(1)
      }
      expectTerminalResult()

      clock.advanceBy(1000)
      await drainMicrotasks()
      expectTerminalResult()
    }
  }, true)
})

test('uses the default 30,000 ms connection deadline', async () => {
  await withProbeClock(async (clock) => {
    const connecting = deferred<QuirkyClient>()
    const client = fakeClient()
    let connectionCalls = 0
    let lostCalls = 0
    const probe = launch({
      connect: () => {
        connectionCalls++
        return connecting.promise
      },
      onDaemonLost: () => lostCalls++
    })
    await drainUntil(() => connectionCalls === 1)

    clock.advanceBy(29_999)
    await drainMicrotasks()
    expect(probe.probes).toEqual([])
    expect(lostCalls).toBe(0)
    expect(probe.daemonExited()).toBe(false)
    expect(connectionCalls).toBe(1)

    clock.advanceBy(1)
    await drainMicrotasks()
    const expectTerminalResult = () => {
      expect(probe.probes).toEqual([{ at: 0, ms: 30_000, ownLagMs: 0, timedOut: true }])
      expect(lostCalls).toBe(1)
      expect(probe.daemonExited()).toBe(false)
      expect(connectionCalls).toBe(1)
      expect(client.calls).toEqual([])
    }
    expectTerminalResult()

    connecting.resolve(client)
    await drainMicrotasks()
    expect(client.closeCalls).toBe(1)
    clock.advanceBy(1000)
    await drainMicrotasks()
    expectTerminalResult()
    expect(client.closeCalls).toBe(1)
  })
})
test('keeps status records stable after finish or stop when the request settles late', async () => {
  await withProbeClock(async (clock) => {
    for (const terminalMethod of ['finish', 'stop'] as const) {
      for (const lateSettlement of ['resolve', 'reject'] as const) {
        const status = deferred<unknown>()
        const client = fakeClient(() => status.promise)
        let connectionCalls = 0
        let lostCalls = 0
        const pidCalls: Array<number | null> = []
        const probe = launch({
          maxStallMs: 10,
          probeTimeoutMs: 100,
          connect: () => {
            connectionCalls++
            return Promise.resolve(client)
          },
          onDaemonLost: () => lostCalls++,
          onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
        })
        await drainUntil(() => client.calls.includes('status.get'))
        expect(connectionCalls).toBe(1)

        clock.advanceBy(20)
        if (terminalMethod === 'finish') probe.finish()
        else probe.stop()
        const expected = terminalMethod === 'finish'
          ? [{ at: 0, ms: 20, ownLagMs: 0, timedOut: false }]
          : []
        const expectStableResult = () => {
          expect(probe.probes).toEqual(expected)
          expect(client.closeCalls).toBe(1)
          expect(client.calls).toEqual(['status.get'])
          expect(connectionCalls).toBe(1)
          expect(lostCalls).toBe(0)
          expect(pidCalls).toEqual([])
          expect(probe.daemonExited()).toBe(false)
        }
        expectStableResult()

        probe.finish()
        probe.finish()
        probe.stop()
        probe.stop()
        expectStableResult()
        await drainMicrotasks()
        expectStableResult()

        if (lateSettlement === 'resolve') status.resolve({ ptyHost: { pid: 99 } })
        else status.reject(new Error('late status failure'))
        await drainMicrotasks()
        expectStableResult()

        clock.advanceBy(1000)
        await drainMicrotasks()
        expectStableResult()
      }
    }
  })
})

test('bounds connection retries from settlement and uses the default when omitted', async () => {
  await withProbeClock(async (clock) => {
    for (const retryDelayMs of [undefined, 40] as const) {
      const firstConnection = deferred<QuirkyClient>()
      const secondConnection = deferred<QuirkyClient>()
      const secondClient = fakeClient()
      let connectionCalls = 0
      let lostCalls = 0
      const retryOption = retryDelayMs === undefined ? {} : { retryDelayMs }
      const probe = launch({
        ...retryOption,
        connect: () => {
          connectionCalls++
          return connectionCalls === 1 ? firstConnection.promise : secondConnection.promise
        },
        onDaemonLost: () => lostCalls++
      })
      await drainUntil(() => connectionCalls === 1)

      clock.advanceBy(15)
      firstConnection.reject(new Error('ordinary connection failure'))
      await drainMicrotasks()
      const expected = [{ at: 0, ms: 15, ownLagMs: 0, timedOut: true }]
      const expectRetryState = (expectedCalls: number) => {
        expect(probe.probes).toEqual(expected)
        expect(connectionCalls).toBe(expectedCalls)
        expect(lostCalls).toBe(0)
        expect(probe.daemonExited()).toBe(false)
        expect(secondClient.calls).toEqual([])
      }
      expectRetryState(1)

      const retryWaitMs = retryDelayMs ?? 250
      clock.advanceBy(retryWaitMs - 1)
      await drainMicrotasks()
      expectRetryState(1)

      clock.advanceBy(1)
      await drainUntil(() => connectionCalls === 2)
      expectRetryState(2)

      probe.stop()
      await drainMicrotasks()
      expectRetryState(2)
      secondConnection.resolve(secondClient)
      await drainMicrotasks()
      expect(secondClient.closeCalls).toBe(1)
      expectRetryState(2)

      clock.advanceBy(1000)
      await drainMicrotasks()
      expect(secondClient.closeCalls).toBe(1)
      expectRetryState(2)
    }
  })
})

test('records finish only strictly beyond the stall boundary for connections and status', async () => {
  await withProbeClock(async (clock) => {
    for (const attemptKind of ['connect', 'status'] as const) {
      for (const elapsedMs of [10, 11] as const) {
        const connecting = deferred<QuirkyClient>()
        const status = deferred<unknown>()
        const client = fakeClient(() => status.promise)
        let connectionCalls = 0
        let lostCalls = 0
        const pidCalls: Array<number | null> = []
        const probe = launch({
          maxStallMs: 10,
          connectTimeoutMs: 40,
          probeTimeoutMs: 40,
          connect: () => {
            connectionCalls++
            return attemptKind === 'connect' ? connecting.promise : Promise.resolve(client)
          },
          onDaemonLost: () => lostCalls++,
          onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
        })
        if (attemptKind === 'connect') await drainUntil(() => connectionCalls === 1)
        else await drainUntil(() => client.calls.includes('status.get'))
        expect(connectionCalls).toBe(1)

        clock.advanceBy(elapsedMs)
        probe.finish()
        const expected = elapsedMs === 10
          ? []
          : [{ at: 0, ms: 11, ownLagMs: 0, timedOut: attemptKind === 'connect' }]
        const expectBoundaryResult = (closeCalls: number) => {
          expect(probe.probes).toEqual(expected)
          expect(connectionCalls).toBe(1)
          expect(client.calls).toEqual(attemptKind === 'status' ? ['status.get'] : [])
          expect(lostCalls).toBe(0)
          expect(pidCalls).toEqual([])
          expect(probe.daemonExited()).toBe(false)
          expect(client.closeCalls).toBe(closeCalls)
        }
        expectBoundaryResult(attemptKind === 'status' ? 1 : 0)
        await drainMicrotasks()
        expectBoundaryResult(attemptKind === 'status' ? 1 : 0)

        if (attemptKind === 'connect') connecting.resolve(client)
        else status.resolve({ ptyHost: { pid: 99 } })
        await drainMicrotasks()
        expectBoundaryResult(1)

        clock.advanceBy(1000)
        await drainMicrotasks()
        expectBoundaryResult(1)
      }
    }
  })
})

test('external abort discards stalled connection and status attempts after late settlement', async () => {
  await withProbeClock(async (clock) => {
    for (const attemptKind of ['connect', 'status'] as const) {
      for (const lateSettlement of ['resolve', 'reject'] as const) {
        const controller = new AbortController()
        const connecting = deferred<QuirkyClient>()
        const status = deferred<unknown>()
        const client = fakeClient(() => status.promise)
        let connectionCalls = 0
        let lostCalls = 0
        const pidCalls: Array<number | null> = []
        const probe = launch({
          maxStallMs: 10,
          connectTimeoutMs: 100,
          probeTimeoutMs: 100,
          signal: controller.signal,
          connect: () => {
            connectionCalls++
            return attemptKind === 'connect' ? connecting.promise : Promise.resolve(client)
          },
          onDaemonLost: () => lostCalls++,
          onPtyHostPid: (pid: number | null) => pidCalls.push(pid)
        })
        if (attemptKind === 'connect') await drainUntil(() => connectionCalls === 1)
        else await drainUntil(() => client.calls.includes('status.get'))
        expect(connectionCalls).toBe(1)

        clock.advanceBy(20)
        controller.abort()
        const expectAbortedResult = (expectedCloseCalls: number) => {
          expect(probe.probes).toEqual([])
          expect(connectionCalls).toBe(1)
          expect(client.calls).toEqual(attemptKind === 'status' ? ['status.get'] : [])
          expect(client.closeCalls).toBe(expectedCloseCalls)
          expect(lostCalls).toBe(0)
          expect(pidCalls).toEqual([])
          expect(probe.daemonExited()).toBe(false)
        }
        expectAbortedResult(attemptKind === 'status' ? 1 : 0)
        await drainMicrotasks()
        expectAbortedResult(attemptKind === 'status' ? 1 : 0)

        if (attemptKind === 'connect') {
          if (lateSettlement === 'resolve') connecting.resolve(client)
          else connecting.reject(new Error('late connection failure'))
        } else if (lateSettlement === 'resolve') {
          status.resolve({ ptyHost: { pid: 99 } })
        } else {
          status.reject(new Error('late status failure'))
        }
        await drainMicrotasks()
        const expectedCloseCalls = attemptKind === 'status' || lateSettlement === 'resolve' ? 1 : 0
        expectAbortedResult(expectedCloseCalls)

        clock.advanceBy(1000)
        await drainMicrotasks()
        expectAbortedResult(expectedCloseCalls)
      }
    }
  })
})

test('finish caps stalled connections by the connection deadline and preserves host lag', async () => {
  await withProbeClock(async (clock) => {
    for (const deadlines of [
      { connectTimeoutMs: 40, probeTimeoutMs: 100, expectedMs: 40 },
      { connectTimeoutMs: 100, probeTimeoutMs: 40, expectedMs: 60 }
    ]) {
      const connecting = deferred<QuirkyClient>()
      const client = fakeClient()
      let connectionCalls = 0
      let lostCalls = 0
      const probe = launch({
        maxStallMs: 10,
        connectTimeoutMs: deadlines.connectTimeoutMs,
        probeTimeoutMs: deadlines.probeTimeoutMs,
        connect: () => {
          connectionCalls++
          return connecting.promise
        },
        onDaemonLost: () => lostCalls++
      })
      await drainUntil(() => connectionCalls === 1)
      const beganAt = clock.now()
      clock.jumpTo(beganAt + 60)
      probe.finish()
      const expected = [{ at: 0, ms: deadlines.expectedMs, ownLagMs: 10, timedOut: true }]
      const expectCappedResult = (expectedCloseCalls: number) => {
        expect(probe.probes).toEqual(expected)
        expect(connectionCalls).toBe(1)
        expect(client.calls).toEqual([])
        expect(client.closeCalls).toBe(expectedCloseCalls)
        expect(lostCalls).toBe(0)
        expect(probe.daemonExited()).toBe(false)
      }
      expectCappedResult(0)
      await drainMicrotasks()
      expectCappedResult(0)

      connecting.resolve(client)
      await drainMicrotasks()
      expectCappedResult(1)

      clock.advanceBy(1000)
      await drainMicrotasks()
      expectCappedResult(1)
    }
  }, true)
})

test('runs optional git probes round-robin at a start-based interval beside status probes', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const firstGitStatus = deferred<unknown>()
    const gitCalls: Array<{ worktree: unknown; at: number }> = []
    const client = fakeClient(undefined, false, (params) => {
      const worktree = (params as { worktree?: unknown } | undefined)?.worktree
      gitCalls.push({ worktree, at: clock.now() })
      return gitCalls.length === 1 ? firstGitStatus.promise : undefined
    })
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      probeTimeoutMs: 10_000,
      gitProbe: { worktrees: ['w1', 'w2', 'w3'] }
    })
    await drainUntil(() => gitCalls.length === 1)
    expect(gitCalls).toEqual([{ worktree: 'id:w1', at: startedAt }])

    await advanceProbeClock(clock, startedAt + 1_500)
    firstGitStatus.resolve(undefined)
    await drainMicrotasks()
    expect(gitCalls).toEqual([
      { worktree: 'id:w1', at: startedAt },
      { worktree: 'id:w2', at: startedAt + 1_500 }
    ])

    await advanceProbeClock(clock, startedAt + 2_499)
    expect(gitCalls).toHaveLength(2)
    await advanceProbeClock(clock, startedAt + 2_500)
    expect(gitCalls[2]).toEqual({ worktree: 'id:w3', at: startedAt + 2_500 })
    await advanceProbeClock(clock, startedAt + 3_500)
    expect(gitCalls[3]).toEqual({ worktree: 'id:w1', at: startedAt + 3_500 })

    expect(probe.gitProbes).toHaveLength(4)
    expect(probe.gitProbes.map(({ worktree }) => worktree)).toEqual(['w1', 'w2', 'w3', 'w1'])
    expect(probe.gitProbes[0]).toMatchObject({ at: 0, ms: 1_500, timedOut: false, failed: false })
    expect(client.rpcCalls.filter(({ method }) => method === 'quirky.git/status').map(({ params, options }) => ({
      params,
      options
    }))).toEqual([
      { params: { worktree: 'id:w1' }, options: { timeoutMs: 10_000 } },
      { params: { worktree: 'id:w2' }, options: { timeoutMs: 10_000 } },
      { params: { worktree: 'id:w3' }, options: { timeoutMs: 10_000 } },
      { params: { worktree: 'id:w1' }, options: { timeoutMs: 10_000 } }
    ])
    expect(probe.probes.length).toBeGreaterThan(1)
    expect(client.calls.every((method) => method === 'status.get' || method === 'quirky.git/status')).toBe(true)
  }, true)
})

test('keeps git probes empty and status-only when the optional option is absent', async () => {
  const client = fakeClient()
  const probe = launch({ connect: () => Promise.resolve(client) })

  await waitFor(() => client.calls.includes('status.get'))
  expect(probe.gitProbes).toEqual([])
  expect(client.calls).toEqual(['status.get'])
})

test('records a git RPC timeout and continues both probe loops', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const firstGitStatus = deferred<unknown>()
    const gitCalls: unknown[] = []
    const client = fakeClient(undefined, false, (params) => {
      gitCalls.push(params)
      return gitCalls.length === 1 ? firstGitStatus.promise : undefined
    })
    let lostCalls = 0
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      probeTimeoutMs: 40,
      gitProbe: { worktrees: ['w1', 'w2'] },
      onDaemonLost: () => lostCalls++
    })
    await drainUntil(() => gitCalls.length === 1)
    await advanceProbeClock(clock, startedAt + 39)
    expect(probe.gitProbes).toEqual([])
    await advanceProbeClock(clock, startedAt + 40)
    expect(probe.gitProbes).toEqual([{
      at: 0,
      ms: 40,
      ownLagMs: 0,
      timedOut: true,
      failed: false,
      worktree: 'w1'
    }])
    expect(probe.daemonExited()).toBe(false)
    expect(lostCalls).toBe(0)

    await advanceProbeClock(clock, startedAt + 1_000)
    expect(gitCalls).toEqual([{ worktree: 'id:w1' }, { worktree: 'id:w2' }])
    expect(probe.probes.length).toBeGreaterThan(1)
    expect(probe.daemonExited()).toBe(false)
    expect(lostCalls).toBe(0)
  }, true)
})

test('records ordinary git RPC rejection and continues round-robin', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const gitCalls: unknown[] = []
    const client = fakeClient(undefined, false, (params) => {
      gitCalls.push(params)
      if (gitCalls.length === 1) return Promise.reject(new Error('git status failed'))
      return undefined
    })
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      gitProbe: { worktrees: ['w1', 'w2'], intervalMs: 25 }
    })
    await drainUntil(() => probe.gitProbes.length === 1)
    expect(probe.gitProbes[0]).toMatchObject({
      at: 0,
      ownLagMs: 0,
      timedOut: false,
      failed: true,
      worktree: 'w1'
    })

    await advanceProbeClock(clock, startedAt + 24)
    expect(gitCalls).toHaveLength(1)
    await advanceProbeClock(clock, startedAt + 25)
    expect(gitCalls).toEqual([{ worktree: 'id:w1' }, { worktree: 'id:w2' }])
    expect(probe.gitProbes).toHaveLength(2)
    expect(probe.gitProbes[1]).toMatchObject({ timedOut: false, failed: false, worktree: 'w2' })
  }, true)
})

test('treats ConnectionLost from git status as daemon loss and stops both loops', async () => {
  await withProbeClock(async (clock) => {
    const client = fakeClient(undefined, false, () => Promise.reject(new ConnectionLost()))
    let lostCalls = 0
    const probe = launch({
      connect: () => Promise.resolve(client),
      gitProbe: { worktrees: ['w1'] },
      onDaemonLost: () => lostCalls++
    })
    await drainUntil(() => lostCalls === 1)
    const callsAtLoss = [...client.calls]
    expect(probe.daemonExited()).toBe(true)
    expect(probe.gitProbes).toEqual([])
    expect(client.calls.filter((method) => method === 'quirky.git/status')).toHaveLength(1)
    expect(callsAtLoss).toContain('status.get')

    clock.jumpTo(clock.now() + 1_000)
    advanceTimersByTime(1_000)
    await drainMicrotasks()
    expect(client.calls).toEqual(callsAtLoss)
    expect(lostCalls).toBe(1)
  }, true)
})

test('finish records a stalled in-flight git call while stop discards it', async () => {
  await withProbeClock(async (clock) => {
    for (const terminal of ['finish', 'stop'] as const) {
      const startedAt = clock.now()
      const gitStatus = deferred<unknown>()
      const client = fakeClient(undefined, false, () => gitStatus.promise)
      const probe = launch({
        startedAt,
        connect: () => Promise.resolve(client),
        maxStallMs: 10,
        probeTimeoutMs: 100,
        gitProbe: { worktrees: ['w1'] }
      })
      await drainUntil(() => client.calls.includes('quirky.git/status'))
      clock.jumpTo(startedAt + 11)
      if (terminal === 'finish') probe.finish()
      else probe.stop()
      expect(probe.gitProbes).toEqual(terminal === 'finish' ? [{
        at: 0,
        ms: 11,
        ownLagMs: 0,
        timedOut: false,
        failed: false,
        worktree: 'w1'
      }] : [])
      gitStatus.resolve(undefined)
      await drainMicrotasks()
      expect(probe.gitProbes).toHaveLength(terminal === 'finish' ? 1 : 0)
    }
  }, true)
})

test('finish marks an in-flight git call timed out at its RPC deadline', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const gitStatus = deferred<unknown>()
    const client = fakeClient(undefined, false, () => gitStatus.promise)
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      maxStallMs: 1,
      probeTimeoutMs: 40,
      gitProbe: { worktrees: ['w1'] }
    })
    await drainUntil(() => client.calls.includes('quirky.git/status'))
    clock.jumpTo(startedAt + 40)
    probe.finish()
    expect(probe.gitProbes).toEqual([{
      at: 0,
      ms: 40,
      ownLagMs: 0,
      timedOut: true,
      failed: false,
      worktree: 'w1'
    }])
    gitStatus.resolve(undefined)
    await drainMicrotasks()
    expect(probe.gitProbes).toHaveLength(1)
  }, true)
})
test('createPongMatcher accepts only complete exact lines for its current token', () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const matcherFor = (token: string) => {
    const matcher = createPongMatcher()
    matcher.expect(token)
    return matcher
  }

  expect(matcherFor('ab12cd34-1').push(encode('\r\nsoak-pong ab12cd34-1\r\n'))).toBe(true)

  const split = matcherFor('ab12cd34-1')
  expect(split.push(encode('\r\nsoak-po'))).toBe(false)
  expect(split.push(encode('ng ab12cd34-1'))).toBe(false)
  expect(split.push(encode('\r\n'))).toBe(true)

  expect(matcherFor('ab12cd34-1').push(
    encode(`\nsoak-pong ab12cd34-1\n${'x'.repeat(50_000)}\n`)
  )).toBe(true)
  expect(matcherFor('ab12cd34-1').push(
    encode(`${'x'.repeat(10_000)}\nsoak-pong ab12cd34-1\n`)
  )).toBe(true)

  const mismatches = matcherFor('ab12cd34-1')
  expect(mismatches.push(encode(
    'soak-pong ab12cd34-10\nsoak-pong ab12cd34-2\nsoak-pong ab12cd34-0\n' +
    'xsoak-pong ab12cd34-1\nsoak-pong ab12cd34-1 \nsoak-ping ab12cd34-1\n'
  ))).toBe(false)

  const nextAttempt = matcherFor('ab12cd34-2')
  expect(nextAttempt.push(encode('soak-pong ab12cd34-0\nsoak-pong ab12cd34-1\n'))).toBe(false)
  expect(nextAttempt.push(encode('soak-pong ab12cd34-2\n'))).toBe(true)

  const terminated = matcherFor('ab12cd34-1')
  expect(terminated.push(encode('soak-pong ab12cd34-1'))).toBe(false)
  expect(terminated.push(encode('\n'))).toBe(true)
})

test('createPongMatcher bounds long tails and decodes split UTF-8 characters', () => {
  const matcher = createPongMatcher()
  const token = 'ab12cd34-1'
  const encode = (text: string) => new TextEncoder().encode(text)
  matcher.expect(token)

  expect(matcher.push(encode(`${'x'.repeat(100_000)}soak-pong ${token}`))).toBe(false)
  expect(matcher.push(encode('\n'))).toBe(false)
  expect(matcher.push(encode(`\nsoak-pong ${token}\n`))).toBe(true)

  const utf8 = createPongMatcher()
  utf8.expect(token)
  const bytes = encode(`⠿\nsoak-pong ${token}\n`)
  expect(utf8.push(bytes.slice(0, 1))).toBe(false)
  expect(utf8.push(bytes.slice(1, 2))).toBe(false)
  expect(utf8.push(bytes.slice(2, 5))).toBe(false)
  expect(utf8.push(bytes.slice(5))).toBe(true)
})

test('terminal probes register before send, wait for both results, and use session dimensions', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const sending = deferred<unknown>()
    const client = fakeClient(undefined, false, undefined, { send: () => sending.promise })
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      terminalProbe: { session: 's1' }
    })
    await drainUntil(() => client.calls.includes('quirky.terminal/send'))

    const sessions = client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/sessions')
    const attaches = client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/attach')
    const send = client.rpcCalls.find(({ method }) => method === 'quirky.terminal/send')!
    expect(sessions).toHaveLength(1)
    expect(attaches.map(({ params }) => params)).toEqual([{
      session: 's1',
      cols: 132,
      rows: 40,
      historyLines: 0
    }])
    expect(client.terminalSubscriptions).toHaveLength(1)
    expect(typeof client.terminalSubscriptions[0]!.onLagged).toBe('function')

    const sendText = (send.params as { text: string }).text
    const match = /^soak-ping ([0-9a-f]{8}-[1-9]\d{0,8})\n$/.exec(sendText)
    expect(match).not.toBeNull()
    const token = match![1]!
    expect(token.endsWith('-1')).toBe(true)
    expect(send.params).toEqual({ session: 's1', text: `soak-ping ${token}\n` })

    await advanceProbeClock(clock, startedAt + 10, 10)
    client.emitTerminal(client.terminalSubscriptions[0]!.streamId, `\nsoak-pong ${token}\n`)
    await drainMicrotasks()
    expect(probe.terminalProbes).toEqual([])

    await advanceProbeClock(clock, startedAt + 30, 10)
    sending.resolve(undefined)
    await drainUntil(() => probe.terminalProbes.length === 1)
    expect(probe.terminalProbes[0]).toEqual({
      at: 0,
      ms: 30,
      ownLagMs: 0,
      timedOut: false,
      failed: false
    })

    await advanceProbeClock(clock, startedAt + 999, 50)
    expect(client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/send')).toHaveLength(1)
    await advanceProbeClock(clock, startedAt + 1_000, 50)
    await drainUntil(() => client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/send').length === 2)
    expect(client.terminalSubscriptions).toHaveLength(1)
    const secondText = (client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/send')[1]!.params as { text: string }).text
    expect(secondText).toMatch(/^soak-ping [0-9a-f]{8}-2\n$/)
  }, true)
})

test('terminal timeout detaches and reattaches, and the default timeout is 30 seconds', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const client = fakeClient()
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      probeTimeoutMs: 40,
      terminalProbe: { session: 's1', intervalMs: 80 }
    })
    await drainUntil(() => client.rpcCalls.some(({ method }) => method === 'quirky.terminal/send'))
    await advanceProbeClock(clock, startedAt + 40, 10)
    expect(probe.terminalProbes).toEqual([{
      at: 0,
      ms: 40,
      ownLagMs: 0,
      timedOut: true,
      failed: false
    }])
    expect(client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/detach').map(({ params }) => params))
      .toEqual([{ streamId: client.terminalSubscriptions[0]!.streamId }])

    await advanceProbeClock(clock, startedAt + 80, 10)
    await drainUntil(() => client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/attach').length === 2)
    expect(client.terminalSubscriptions).toHaveLength(2)
    probe.stop()

    const defaultStartedAt = clock.now()
    const defaultClient = fakeClient()
    const defaultProbe = launch({
      startedAt: defaultStartedAt,
      connect: () => Promise.resolve(defaultClient),
      maxStallMs: 1,
      terminalProbe: { session: 's1' }
    })
    await drainUntil(() => defaultClient.calls.includes('quirky.terminal/send'))
    await advanceProbeClock(clock, defaultStartedAt + 30_000, 50)
    defaultProbe.finish()
    expect(defaultProbe.terminalProbes).toEqual([{
      at: 0,
      ms: 30_000,
      ownLagMs: 0,
      timedOut: true,
      failed: false
    }])
  }, true)
})

test('terminal send rejection records failure even after a pong and the loop continues', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const firstSend = deferred<unknown>()
    let sendCount = 0
    const client = fakeClient(undefined, false, undefined, {
      send: () => ++sendCount === 1 ? firstSend.promise : undefined
    })
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      terminalProbe: { session: 's1', intervalMs: 20 },
      probeTimeoutMs: 100
    })
    await drainUntil(() => client.rpcCalls.some(({ method }) => method === 'quirky.terminal/send'))
    const firstText = (client.rpcCalls.find(({ method }) => method === 'quirky.terminal/send')!.params as { text: string }).text
    const token = /^soak-ping ([^\n]+)\n$/.exec(firstText)![1]!
    await advanceProbeClock(clock, startedAt + 4, 4)
    client.emitTerminal(client.terminalSubscriptions[0]!.streamId, `\nsoak-pong ${token}\n`)
    await advanceProbeClock(clock, startedAt + 5, 1)
    firstSend.reject(new Error('send failed'))
    await drainUntil(() => probe.terminalProbes.length === 1)
    expect(probe.terminalProbes[0]).toMatchObject({
      ms: 5,
      timedOut: false,
      failed: true
    })

    await advanceProbeClock(clock, startedAt + 20, 5)
    await drainUntil(() => client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/send').length === 2)
    expect(probe.terminalProbes).toHaveLength(1)
  }, true)
})

test('terminal session lookup and attach failures are recorded and retried', async () => {
  await withProbeClock(async (clock) => {
    for (const failure of ['missing-session', 'attach'] as const) {
      const startedAt = clock.now()
      let sessionLookups = 0
      let attachCalls = 0
      const client = fakeClient(undefined, false, undefined, {
        sessions: () => {
          sessionLookups++
          return failure === 'missing-session' && sessionLookups === 1
            ? { sessions: [] }
            : { sessions: [{ sessionId: 's1', cols: 100, rows: 30 }] }
        },
        attach: () => {
          attachCalls++
          if (failure === 'attach' && attachCalls === 1) throw new Error('attach failed')
          return { streamId: 70 + attachCalls }
        }
      })
      const probe = launch({
        startedAt,
        connect: () => Promise.resolve(client),
        terminalProbe: { session: 's1', intervalMs: 20 },
        probeTimeoutMs: 100
      })
      await drainUntil(() => probe.terminalProbes.length === 1)
      expect(probe.terminalProbes[0]).toMatchObject({ timedOut: false, failed: true })

      await advanceProbeClock(clock, startedAt + 20, 5)
      await drainUntil(() => client.rpcCalls.some(({ method }) => method === 'quirky.terminal/send'))
      const secondSendText = (client.rpcCalls.find(({ method }) => method === 'quirky.terminal/send')!.params as { text: string }).text
      expect(secondSendText).toMatch(/^soak-ping [0-9a-f]{8}-2\n$/)
      expect(client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/attach')).toHaveLength(
        failure === 'missing-session' ? 1 : 2
      )
      expect(client.terminalSubscriptions).toHaveLength(1)
      probe.stop()
    }
  }, true)
})
test('terminal send rejection with an undefined reason is recorded as a failure', async () => {
  const client = fakeClient(undefined, false, undefined, {
    send: () => Promise.reject(undefined)
  })
  const probe = launch({
    connect: () => Promise.resolve(client),
    terminalProbe: { session: 's1', intervalMs: 20 }
  })
  await waitFor(() => probe.terminalProbes.length === 1)
  expect(probe.terminalProbes[0]).toMatchObject({ timedOut: false, failed: true })
  probe.stop()
})


test('terminal stream lag fails the attempt, detaches despite errors, and reattaches', async () => {
  const client = fakeClient(undefined, false, undefined, {
    detach: () => Promise.reject(new Error('detach failed'))
  })
  const probe = launch({
    connect: () => Promise.resolve(client),
    probeTimeoutMs: 500,
    terminalProbe: { session: 's1', intervalMs: 20 }
  })
  await waitFor(() => client.terminalSubscriptions.length === 1)
  const firstStream = client.terminalSubscriptions[0]!.streamId
  client.lagTerminal(firstStream)
  await waitFor(() => probe.terminalProbes.length === 1)
  expect(probe.terminalProbes[0]).toMatchObject({ timedOut: false, failed: true })
  await waitFor(() => client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/attach').length === 2)
  expect(client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/detach').map(({ params }) => params))
    .toContainEqual({ streamId: firstStream })
  expect(client.terminalSubscriptions[0]!.disposed).toBe(true)
  probe.stop()
})

test('ConnectionLost from terminal lookup, attach, or send marks daemon loss without a record', async () => {
  for (const failure of ['sessions', 'attach', 'send'] as const) {
    let lostCalls = 0
    const client = fakeClient(undefined, false, undefined, {
      sessions: () => {
        if (failure === 'sessions') throw new ConnectionLost()
        return { sessions: [{ sessionId: 's1', cols: 132, rows: 40 }] }
      },
      attach: () => {
        if (failure === 'attach') throw new ConnectionLost()
        return { streamId: 71 }
      },
      send: () => failure === 'send' ? Promise.reject(new ConnectionLost()) : undefined
    })
    const probe = launch({
      connect: () => Promise.resolve(client),
      onDaemonLost: () => lostCalls++,
      terminalProbe: { session: 's1' }
    })
    await waitFor(() => lostCalls === 1)
    expect(probe.daemonExited()).toBe(true)
    expect(probe.terminalProbes).toEqual([])
    expect(lostCalls).toBe(1)
    probe.stop()
  }
})

test('terminal own lag uses the shared probe lateness timer', async () => {
  await withProbeClock(async (clock) => {
    const startedAt = clock.now()
    const client = fakeClient()
    const probe = launch({
      startedAt,
      connect: () => Promise.resolve(client),
      probeTimeoutMs: 2_000,
      terminalProbe: { session: 's1' }
    })
    await drainUntil(() => client.calls.includes('quirky.terminal/send'))
    const token = /^soak-ping ([^\n]+)\n$/.exec(
      (client.rpcCalls.find(({ method }) => method === 'quirky.terminal/send')!.params as { text: string }).text
    )![1]!

    clock.jumpTo(startedAt + 600)
    advanceTimersByTime(600)
    await drainMicrotasks()
    client.emitTerminal(client.terminalSubscriptions[0]!.streamId, `\nsoak-pong ${token}\n`)
    await drainUntil(() => probe.terminalProbes.length === 1)
    expect(probe.terminalProbes[0]!.ownLagMs).toBeGreaterThan(500)
  }, true)
})

test('finish records only stalled terminal attempts, while stop discards them and unregisters output', async () => {
  await withProbeClock(async (clock) => {
    for (const end of ['finish', 'quick-finish', 'stop'] as const) {
      const startedAt = clock.now()
      const sending = deferred<unknown>()
      const client = fakeClient(undefined, false, undefined, { send: () => sending.promise })
      const probe = launch({
        startedAt,
        connect: () => Promise.resolve(client),
        maxStallMs: 1_000,
        probeTimeoutMs: 10_000,
        terminalProbe: { session: 's1' }
      })
      await drainUntil(() => client.calls.includes('quirky.terminal/send'))
      const elapsed = end === 'quick-finish' ? 900 : 1_200
      await advanceProbeClock(clock, startedAt + elapsed, 50)
      if (end === 'stop') probe.stop()
      else probe.finish()

      expect(probe.terminalProbes).toEqual(end === 'finish' ? [{
        at: 0,
        ms: 1_200,
        ownLagMs: 0,
        timedOut: false,
        failed: false
      }] : [])
      expect(client.terminalSubscriptions[0]!.disposed).toBe(true)
      expect(client.rpcCalls.filter(({ method }) => method === 'quirky.terminal/detach'))
        .toContainEqual(expect.objectContaining({ params: { streamId: client.terminalSubscriptions[0]!.streamId } }))

      sending.resolve(undefined)
      client.emitTerminal(client.terminalSubscriptions[0]!.streamId, '\nsoak-pong 0123abcd-1\n')
      await drainMicrotasks()
      expect(probe.terminalProbes).toHaveLength(end === 'finish' ? 1 : 0)
    }
  }, true)
})

test('terminal option absent leaves terminal instrumentation and calls untouched', async () => {
  const client = fakeClient()
  const probe = launch({ connect: () => Promise.resolve(client) })
  await waitFor(() => client.calls.includes('status.get'))
  expect(probe.terminalProbes).toEqual([])
  expect(client.calls.filter((method) => method.startsWith('quirky.terminal/'))).toEqual([])
  expect(client.terminalSubscriptions).toEqual([])
})
