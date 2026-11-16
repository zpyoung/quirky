import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FixtureWorktree } from '../ui-review/fixtures'
import type { WindowRequestObservation } from './contracts.ts'
import { isPanelRefreshRequest } from './verdict.ts'
import { assignWorktrees, attachMetrics, chromiumArgs, type WindowLiveness, type WindowStartupObservation } from './windows.ts'

function fixtureWorktrees(): FixtureWorktree[] {
  return [
    { id: 'fixture-main', path: '/fixture', repoId: 'repo-ui', name: 'ui-review-fixture', isMain: true, status: 'idle' },
    { id: 'ready', path: '/ready', repoId: 'repo-ui', name: 'ui-review-ready', isMain: false, status: 'working' },
    { id: 'notes', path: '/notes', repoId: 'repo-ui', name: 'ui-review-notes', isMain: false, status: 'needs-you' },
    { id: 'harbor-main', path: '/harbor', repoId: 'repo-harbor', name: 'harbor-api', isMain: true, status: 'idle' },
    { id: 'retry', path: '/retry', repoId: 'repo-harbor', name: 'retry-queue', isMain: false, status: 'failing' },
    { id: 'ledger-main', path: '/ledger', repoId: 'repo-ledger', name: 'ledger-web', isMain: true, status: 'idle' },
    { id: 'export', path: '/export', repoId: 'repo-ledger', name: 'export-csv', isMain: false, status: 'done' }
  ]
}

type EventListener = (event: unknown) => void

class FakeEmitter {
  private readonly listeners = new Map<string, EventListener[]>()

  on(event: string, listener: EventListener): void {
    const handlers = this.listeners.get(event) ?? []
    handlers.push(listener)
    this.listeners.set(event, handlers)
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

function metricsForTest(): Parameters<typeof attachMetrics>[1] {
  return {
    closed: false,
    crashed: false,
    requests: new Map(),
    requestRing: new Array(2_000),
    requestCount: 0,
    nextRequestSlot: 0,
    requestListeners: new Set(),
    sockets: 0,
    lastRequestAt: null,
    pageErrors: 0,
    pageErrorExamples: [],
  }
}

function fakeSocket(url: string): FakeEmitter & { url(): string } {
  const socket = new FakeEmitter() as FakeEmitter & { url(): string }
  socket.url = () => url
  return socket
}

function sendFrame(socket: FakeEmitter, payload: unknown): void {
  socket.emit('framesent', { payload })
}
function recordingWindowSource(moduleUrl: string, scenario: string): string {
  return `
import { mock } from 'bun:test'

const scenario = ${JSON.stringify(scenario)}
const port = 43123
const current = {
  connectionIds: [],
  pagesByConn: new Map(),
  pages: [],
  selected: new Map(),
  events: [],
  rpcCalls: [],
  observations: [],
  requests: [],
  pidAtNavigation: false,
  pidAtClose: false,
  tracked: [],
  serverClosed: 0,
  resolveConnect: undefined,
  resolveLaunch: undefined,
  launchReady: Promise.withResolvers(),
  connectReady: Promise.withResolvers(),
  browserClosedPromise: Promise.withResolvers(),
  browserClosedCount: 0,
  controller: undefined,
  navigationCalls: 0,
  stateReads: 0,
  resolveNavigate: undefined,
  navigationStarted: Promise.withResolvers(),
  resolveState: undefined,
  reconciliationStarted: Promise.withResolvers()
}

let fastReconcileTimeout = false
let virtualTime = false
let followNow = 0
class Emitter {
  listeners = new Map()
  on(event, listener) {
    const handlers = this.listeners.get(event) ?? []
    handlers.push(listener)
    this.listeners.set(event, handlers)
  }
  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

function sendStatus(page, worktree) {
  page.sendStatus(worktree)
}

function makePage() {
  const listeners = new Emitter()
  const socket = new Emitter()
  socket.url = () => \`ws://127.0.0.1:\${port}/rpc\`
  let socketOpened = false
  let closed = false
  const page = {
    on: listeners.on.bind(listeners),
    emit: listeners.emit.bind(listeners),
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    isClosed: () => closed,
    async close() {
      closed = true
      page.emit('close', {})
    },
    locator() {
      return {
        async waitFor() {
          if (closed) throw new Error('page closed before shell became visible')
        }
      }
    },
    sendRequest(method, params) {
      if (!socketOpened) {
        socketOpened = true
        page.emit('websocket', socket)
      }
      socket.emit('framesent', {
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
    },
    sendStatus(worktree) {
      page.sendRequest('quirky.git/status', { worktree })
    },
    async goto(url) {
      current.pidAtNavigation = current.observations.some(({ stage, browserPid }) => stage === 'launch' && browserPid === 801)
      const firstConnId = 41 + current.pages.indexOf(page)
      const ids = scenario === 'duplicate-connection' ? [firstConnId, firstConnId + 1] : [firstConnId]
      for (const connId of ids) {
        current.connectionIds.push(connId)
        current.pagesByConn.set(connId, page)
      }
      if (scenario === 'closed-page') {
        closed = true
        page.emit('close', {})
      }
      if (scenario === 'old-request') sendStatus(page, 'ready')
      if (scenario === 'navigation-failure') {
        for (let index = 0; index < 7; index++) {
          page.emit('pageerror', { message: \`renderer error \${index} at \${process.env.QUIRKY_HOME} http://u:p@127.0.0.1:\${port}\${process.env.QUIRKY_HOME}/asset.js?auth=path-secret#fragment-secret WSS://u:p@127.0.0.1:\${port}/rpc?auth=socket-secret#socket-fragment-secret\` })
          if (index === 4) {
            page.emit('response', {
              url: () => \`http://127.0.0.1:\${port}/assets/\${index}.js?auth=response-secret#fragment-secret\`,
              status: () => 404
            })
          } else {
            page.emit('requestfailed', {
              url: () => \`http://127.0.0.1:\${port}/assets/\${index}.js?auth=request-secret#fragment-secret\`,
              failure: () => ({ errorText: 'net::ERR_ABORTED' })
            })
          }
        }
        page.emit('requestfailed', {
          url: () => 'https://outside.invalid/private.js?auth=outside-secret',
          failure: () => ({ errorText: 'net::ERR_FAILED' })
        })
        throw new Error(\`local renderer navigation failed at http://127.0.0.1:\${port}/?auth=nav-secret#token=nav-secret\`)
      }
    }
  }
  current.pages.push(page)
  return page
}

const browser = {
  connected: true,
  isConnected() { return this.connected },
  async close() {
    current.browserClosedPromise.resolve()
    current.browserClosedCount++
    this.connected = false
  },
  async newContext() {
    return {
      async newPage() { return makePage() },
      async close() { current.events.push('context:close') }
    }
  }
}

const server = {
  process: () => ({ pid: 801 }),
  wsEndpoint: () => \`ws://127.0.0.1:\${port}\`,
  async close() {
    current.pidAtClose = current.observations.some(({ browserPid }) => browserPid === 801)
    current.serverClosed++
  }
}

mock.module('playwright', () => ({
  chromium: {
    async launchServer() {
      current.events.push('launch')
      current.launchReady.resolve()
      if (scenario === 'late-launch-track-failure') {
        const deferred = Promise.withResolvers()
        current.resolveLaunch = deferred.resolve
        return deferred.promise
      }
      return server
    },
    connect() {
      current.events.push('connect')
      current.connectReady.resolve()
      if (scenario === 'late-connect') {
        const deferred = Promise.withResolvers()
        current.resolveConnect = deferred.resolve
        return deferred.promise
      }
      return Promise.resolve(browser)
    }
  }
}))

// Load windows.ts after the Playwright mock so this subprocess never opens a real browser.
const { openWindows } = await import(${JSON.stringify(moduleUrl)})
const controller = new AbortController()
current.controller = controller
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
const nativePerformanceNow = performance.now.bind(performance)
const virtualTimeout = (callback, ms, args) => {
  const timer = { virtualTimer: true, active: true }
  queueMicrotask(() => queueMicrotask(() => {
    if (!timer.active) return
    timer.active = false
    followNow += ms
    callback(...args)
  }))
  return timer
}
const startVirtualClock = () => {
  followNow = nativePerformanceNow()
  Object.defineProperty(performance, 'now', { configurable: true, value: () => followNow })
  virtualTime = true
}
globalThis.setTimeout = (callback, ms, ...args) => {
  if ((virtualTime && [1, 5, 20].includes(ms)) || (fastReconcileTimeout && ms === 5000)) {
    return virtualTimeout(callback, ms, args)
  }
  if (ms === 100) {
    queueMicrotask(() => controller.abort())
    return 0
  }
  return nativeSetTimeout(callback, ms, ...args)
}
globalThis.clearTimeout = (timer) => {
  if (timer?.virtualTimer === true) {
    timer.active = false
    return
  }
  return nativeClearTimeout(timer)
}
const world = {
  home: process.env.QUIRKY_HOME,
  runtime: { port, token: 'runtime-secret' },
  env: {},
  fixtures: {
    worktrees: scenario === 'liveness'
      ? [
          { id: 'wt-a', path: '/wt-a', repoId: 'repo-a', name: 'wt-a', isMain: false, status: 'working' },
          { id: 'wt-b', path: '/wt-b', repoId: 'repo-b', name: 'wt-b', isMain: false, status: 'failing' }
        ]
      : [
          { id: 'ready', path: '/ready', repoId: 'repo-a', name: 'ready', isMain: false, status: 'working' },
          { id: 'retry', path: '/retry', repoId: 'repo-b', name: 'retry', isMain: false, status: 'failing' }
        ]
  },
  track(pid) {
    current.tracked.push(pid)
    if (scenario === 'track-failure' || scenario === 'late-launch-track-failure') throw new Error('owned browser tracking failed')
  },
  control: {
    async callAny(method, params) {
      current.rpcCalls.push(method)
      if (method === 'ui.state') return { windows: current.connectionIds.map((connId) => ({ connId })) }
      if (method === 'ui.window.state') {
        current.stateReads++
        if (scenario === 'abort-reconcile-read' && current.stateReads > 1) {
          const deferred = Promise.withResolvers()
          current.reconciliationStarted.resolve()
          current.resolveState = deferred.resolve
          return deferred.promise
        }
        if (['switch-unreadable', 'switch-no-proof-unreadable'].includes(scenario) && current.stateReads > 1) {
          throw new Error('window state unavailable')
        }
        if (scenario === 'switch-no-proof' && current.stateReads > 1) current.selected.set(params.connId, 'wt-c')
        const worktree = scenario === 'finish-mismatch' && current.stateReads > 1
          ? 'daemon-worktree'
          : current.selected.get(params.connId) ?? 'ready'
        return {
          layout: {
            worktree,
            view: { id: 'view:quirky.session/worktree' },
            tools: { open: { 'right-top': 'panel:quirky.git/source-control' } }
          }
        }
      }
      if (method === 'quirky.worktree/navigate') {
        current.navigationCalls++
        const connId = params.window
        const worktree = params.worktree.replace(/^id:/, '')
        const page = current.pagesByConn.get(connId)
        if (current.navigationCalls > 1 && scenario === 'abort-nav') {
          current.selected.set(connId, 'wt-c')
          current.navigationStarted.resolve()
          const deferred = Promise.withResolvers()
          current.resolveNavigate = deferred.resolve
          return deferred.promise
        }
        if (current.navigationCalls > 1 && scenario === 'abort-reconcile-read') throw new Error('navigation rejected')
        if (current.navigationCalls > 1 && ['switch-mismatch', 'switch-unreadable'].includes(scenario)) {
          current.selected.set(connId, 'wt-c')
          return { worktreeId: 'wt-c' }
        }
        current.selected.set(connId, worktree)
        if (['matching-during-navigation', 'two-windows', 'liveness'].includes(scenario)) sendStatus(page, worktree)
        if (current.navigationCalls === 1 && (scenario.startsWith('switch-')
          || scenario.startsWith('abort-') || scenario.startsWith('wait-') || scenario.startsWith('finish-'))) {
          sendStatus(page, worktree)
        }
        if (current.navigationCalls > 1 && scenario === 'switch-proof') sendStatus(page, \`id:\${worktree}\`)
        if (current.navigationCalls > 1 && scenario === 'switch-wrong-proof') sendStatus(page, 'wrong-worktree')
        if (scenario === 'wrong-worktree') sendStatus(page, 'another-worktree')
        return { worktreeId: worktree }
      }
      return {}
    }
  }
}

const capture = async () => {
  try {
    const windows = await openWindows({
      world,
      count: ['two-windows', 'liveness'].includes(scenario) ? 2 : 1,
      executable: '/recording/chromium',
      out: process.env.QUIRKY_OUT,
      signal: controller.signal,
      ...(scenario === 'wait-ring-no-observer' ? {} : {
        onRequest: (request) => current.requests.push(request)
      }),
      onStartup: (observation) => current.observations.push({
        ...observation,
        pageErrors: observation.pageErrors?.slice(),
        failedRequests: observation.failedRequests?.map((request) => ({ ...request }))
      })
    })
    let liveness
    let livenessAfterDisconnect
    let livenessAfterCrash
    let livenessAfterPageClose
    let livenessWasSynchronous
    let livenessRpcCalls
    let switchRecord
    let actionError
    let dropped
    let recent
    let waited
    let waitWrong
    if (scenario === 'liveness') {
      const rpcCallsBeforeLiveness = current.rpcCalls.length
      liveness = windows.liveness()
      livenessWasSynchronous = !(liveness instanceof Promise)
      browser.connected = false
      livenessAfterDisconnect = windows.liveness()
      browser.connected = true
      windows.pages[0].emit('crash', {})
      livenessAfterCrash = windows.liveness()
      await windows.pages[1].close()
      livenessAfterPageClose = windows.liveness()
      livenessRpcCalls = current.rpcCalls.slice(rpcCallsBeforeLiveness)
    }
    if (scenario === 'wait-ring-no-observer') {
      startVirtualClock()
      for (let index = 0; index <= 2000; index++) windows.pages[0].sendRequest(\`ring.\${index}\`, {})
      dropped = await windows.waitForRequest(0, (method) => method === 'ring.0', {
        since: 0,
        timeoutMs: 1,
        signal: new AbortController().signal
      })
      recent = await windows.waitForRequest(0, (method) => method === 'ring.2000', {
        since: 0,
        timeoutMs: 1,
        signal: new AbortController().signal
      })
    }
    if (scenario === 'switch-proof' || scenario === 'switch-mismatch' || scenario === 'switch-unreadable'
      || scenario === 'switch-wrong-proof' || scenario === 'switch-no-proof' || scenario === 'switch-no-proof-unreadable') {
      startVirtualClock()
      switchRecord = await windows.navigate(0, 'wt-b', {
        signal: new AbortController().signal,
        followTimeoutMs: 20
      })
      windows.pages[0].sendStatus('wt-a')
    }
    if (scenario === 'abort-nav') {
      const signal = new AbortController()
      const pending = windows.navigate(0, 'wt-b', { signal: signal.signal, followTimeoutMs: 1000 })
      await current.navigationStarted.promise
      signal.abort()
      actionError = await pending.then(() => null, (error) => error.message)
      current.resolveNavigate?.({ worktreeId: 'wt-b' })
      windows.pages[0].sendStatus('wt-a')
    }
    if (scenario === 'abort-reconcile-read') {
      fastReconcileTimeout = true
      startVirtualClock()
      const signal = new AbortController()
      const pending = windows.navigate(0, 'wt-b', { signal: signal.signal, followTimeoutMs: 1000 })
      await current.reconciliationStarted.promise
      signal.abort()
      actionError = await pending.then(() => null, (error) => error.message)
      current.resolveState?.({ layout: { worktree: 'wt-c' } })
      windows.pages[0].sendStatus('wt-a')
    }
    if (scenario === 'finish-mismatch') windows.pages[0].sendStatus('ready')
    if (scenario === 'wait-filter') {
      startVirtualClock()
      windows.pages[0].sendStatus('wt-b')
      dropped = await windows.waitForRequest(0, (method, params) => method === 'quirky.git/status'
        && params?.worktree === 'wt-b', {
        since: performance.now() + 1_000,
        timeoutMs: 5,
        signal: new AbortController().signal
      })
      const wrongWait = windows.waitForRequest(0, (method, params) => method === 'quirky.git/status'
        && params?.worktree === 'wt-b', {
        since: performance.now(),
        timeoutMs: 5,
        signal: new AbortController().signal
      })
      windows.pages[0].sendStatus('wt-a')
      waitWrong = await wrongWait
      const waiting = windows.waitForRequest(0, (method, params) => method === 'quirky.git/status'
        && params?.worktree === 'wt-b', {
        since: performance.now(),
        timeoutMs: 100,
        signal: new AbortController().signal
      })
      windows.pages[0].sendStatus('wt-b')
      waited = await waiting
    }
    const rpcCallsBeforeFinish = current.rpcCalls.length
    const finished = await windows.finish()
    const finishRpcCalls = current.rpcCalls.slice(rpcCallsBeforeFinish)
    await windows.stop()
    return {
      resolved: true,
      finished,
      liveness,
      livenessAfterDisconnect,
      livenessAfterCrash,
      livenessAfterPageClose,
      livenessWasSynchronous,
      livenessRpcCalls,
      finishRpcCalls,
      switchRecord,
      actionError,
      dropped,
      recent,
      waited,
      waitWrong
    }
  } catch (error) {
    return { resolved: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let result
if (scenario === 'late-launch-track-failure') {
  const pending = capture()
  await current.launchReady.promise
  controller.abort()
  current.resolveLaunch?.(server)
  result = await pending
} else if (scenario === 'late-connect') {
  const pending = capture()
  await current.connectReady.promise
  controller.abort()
  result = await pending
  current.resolveConnect?.(browser)
  await current.browserClosedPromise.promise
} else {
  result = await capture()
}

process.stdout.write(JSON.stringify({
  ...result,
  events: current.observations,
  requests: current.requests,
  pidAtNavigation: current.pidAtNavigation,
  pidAtClose: current.pidAtClose,
  tracked: current.tracked,
  browserClosed: current.browserClosedCount,
  serverClosed: current.serverClosed
}))
`
}

async function runRecordingWindowScenario(scenario: string): Promise<RecordingWindowRun> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-window-recording-'))
  const home = join(root, 'home')
  const out = join(root, 'out')
  mkdirSync(home)
  mkdirSync(out)
  if (scenario === 'pid-write-failure') mkdirSync(join(out, 'browser.pid'))
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, 'windows.ts')).href
  const child = Bun.spawn([process.execPath, '-e', recordingWindowSource(moduleUrl, scenario)], {
    env: { ...process.env, QUIRKY_HOME: home, QUIRKY_OUT: out },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    return JSON.parse(stdout) as RecordingWindowRun
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

type RecordingWindowEvent = WindowStartupObservation

type RecordingWindowRun = {
  resolved: boolean
  error?: string
  events: RecordingWindowEvent[]
  requests: WindowRequestObservation[]
  pidAtNavigation: boolean
  tracked: number[]
  pidAtClose: boolean
  browserClosed: number
  serverClosed: number
  liveness?: WindowLiveness[]
  livenessAfterDisconnect?: WindowLiveness[]
  livenessAfterCrash?: WindowLiveness[]
  livenessAfterPageClose?: WindowLiveness[]
  livenessWasSynchronous?: boolean
  livenessRpcCalls?: string[]
  finishRpcCalls?: string[]
  switchRecord?: {
    index: number
    from: string
    requested: string
    settled: string
    proof: { at: number; method: string; worktree: string } | null
    ok: boolean
    followMs: number | null
    error: string | null
  }
  actionError?: string | null
  dropped?: { at: number; method: string; params: unknown } | null
  recent?: { at: number; method: string; params: unknown } | null
  waited?: { at: number; method: string; params: unknown } | null
  waitWrong?: { at: number; method: string; params: unknown } | null
  finished?: {
    records: Array<{ index: number; connId: number; worktree: string; open: boolean; shown: boolean; requests: number }>
    requests: Array<{ method: string; total: number }>
  }
}

test('accepts a matching status request sent before navigation resolves', async () => {
  const result = await runRecordingWindowScenario('matching-during-navigation')

  expect(result.resolved).toBe(true)
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0]).toMatchObject({
    index: 0,
    worktree: 'ready',
    method: 'quirky.git/status',
    params: { worktree: 'ready' }
  })
  expect(result.finished?.records[0]?.requests).toBe(1)
  expect(result.finished?.requests).toContainEqual({ method: 'quirky.git/status', total: 1 })
})
test('returns synchronous renderer liveness without RPCs and tracks page and browser state', async () => {
  const result = await runRecordingWindowScenario('liveness')

  expect(result.resolved).toBe(true)
  expect(result.livenessWasSynchronous).toBe(true)
  expect(result.liveness).toEqual([
    { index: 0, connId: 41, worktree: 'wt-a', open: true },
    { index: 1, connId: 42, worktree: 'wt-b', open: true }
  ])
  expect(result.livenessRpcCalls).toEqual([])
  expect(result.livenessAfterDisconnect?.map(({ open }) => open)).toEqual([false, false])
  expect(result.livenessAfterCrash?.map(({ open }) => open)).toEqual([false, true])
  expect(result.livenessAfterPageClose?.map(({ open }) => open)).toEqual([false, false])
  expect(result.finishRpcCalls).toEqual(['ui.window.state', 'ui.window.state'])
  expect(result.finished?.records).toMatchObject([
    { index: 0, connId: 41, worktree: 'wt-a', open: false, shown: true },
    { index: 1, connId: 42, worktree: 'wt-b', open: false, shown: true }
  ])
})
test('keeps the last 2,000 requests even without an observer and waits from ring or live traffic', async () => {
  const ring = await runRecordingWindowScenario('wait-ring-no-observer')

  expect(ring.resolved).toBe(true)
  expect(ring.requests).toEqual([])
  expect(ring.dropped).toBeNull()
  expect(ring.recent).toMatchObject({ method: 'ring.2000', params: {} })
  expect(ring.finished?.records[0]?.requests).toBe(2002)

  const filtering = await runRecordingWindowScenario('wait-filter')
  expect(filtering.resolved).toBe(true)
  expect(filtering.dropped).toBeNull()
  expect(filtering.waitWrong).toBeNull()
  expect(filtering.waited).toMatchObject({ method: 'quirky.git/status', params: { worktree: 'wt-b' } })
})

test('navigates with a ring-backed proof and labels requests from the settled daemon worktree', async () => {
  const result = await runRecordingWindowScenario('switch-proof')

  expect(result.resolved, result.error ?? 'window scenario failed').toBe(true)
  expect(result.switchRecord).toMatchObject({
    index: 0,
    from: 'ready',
    requested: 'wt-b',
    settled: 'wt-b',
    proof: { method: 'quirky.git/status', worktree: 'wt-b' },
    ok: true,
    error: null
  })
  expect(result.requests.slice(-2).map(({ worktree }) => worktree)).toEqual(['wt-b', 'wt-b'])
})

test('keeps failed follow and navigation attribution aligned with daemon readback', async () => {
  const noFollow = await runRecordingWindowScenario('switch-no-proof')
  expect(noFollow.resolved, noFollow.error ?? 'window scenario failed').toBe(true)
  expect(noFollow.switchRecord).toMatchObject({
    requested: 'wt-b',
    settled: 'wt-c',
    proof: null,
    ok: false,
    error: 'did not request status for wt-b within 20ms'
  })
  expect(noFollow.requests.at(-1)?.worktree).toBe('wt-c')
  const unreadableFollow = await runRecordingWindowScenario('switch-no-proof-unreadable')
  expect(unreadableFollow.resolved, unreadableFollow.error ?? 'window scenario failed').toBe(true)
  expect(unreadableFollow.switchRecord).toMatchObject({
    requested: 'wt-b',
    settled: 'wt-b',
    proof: null,
    ok: false,
    error: 'did not request status for wt-b within 20ms; window state unreadable'
  })
  expect(unreadableFollow.requests.at(-1)?.worktree).toBe('wt-b')

  const wrongProof = await runRecordingWindowScenario('switch-wrong-proof')
  expect(wrongProof.resolved, wrongProof.error ?? 'window scenario failed').toBe(true)
  expect(wrongProof.switchRecord).toMatchObject({ settled: 'wt-b', proof: null, ok: false })

  const mismatch = await runRecordingWindowScenario('switch-mismatch')
  expect(mismatch.resolved, mismatch.error ?? 'window scenario failed').toBe(true)
  expect(mismatch.switchRecord).toMatchObject({
    requested: 'wt-b',
    settled: 'wt-c',
    proof: null,
    ok: false,
    error: 'navigation selected wt-c, expected wt-b'
  })
  expect(mismatch.requests.at(-1)?.worktree).toBe('wt-c')

  const unreadable = await runRecordingWindowScenario('switch-unreadable')
  expect(unreadable.resolved, unreadable.error ?? 'window scenario failed').toBe(true)
  expect(unreadable.switchRecord).toMatchObject({
    settled: 'ready',
    error: 'navigation selected wt-c, expected wt-b; window state unreadable'
  })
  expect(unreadable.requests.at(-1)?.worktree).toBe('ready')
})

test('drops late navigate and reconciliation responses after abort settles', async () => {
  const navigation = await runRecordingWindowScenario('abort-nav')
  expect(navigation.resolved).toBe(true)
  expect(navigation.actionError).toContain('soak setup was interrupted')
  expect(navigation.requests.at(-1)?.worktree).toBe('wt-c')

  const reconciliation = await runRecordingWindowScenario('abort-reconcile-read')
  expect(reconciliation.resolved).toBe(true)
  expect(reconciliation.actionError).toContain('soak setup was interrupted')
  expect(reconciliation.requests.at(-1)?.worktree).toBe('ready')
})

test('finish reports each window state from the daemon rather than the starting worktree', async () => {
  const result = await runRecordingWindowScenario('finish-mismatch')

  expect(result.resolved).toBe(true)
  expect(result.finished?.records[0]).toMatchObject({
    worktree: 'daemon-worktree',
    shown: false
  })
  expect(result.finishRpcCalls).toEqual(['ui.window.state'])
})

test('requires a fresh status request for the actual worktree', async () => {
  for (const scenario of ['old-request', 'wrong-worktree', 'no-request']) {
    const result = await runRecordingWindowScenario(scenario)

    expect(result.resolved).toBe(false)
    expect(result.error).toContain('window 0:')
    expect(result.events.at(-1)?.stage).toBe('failed')
    if (scenario === 'old-request') {
      expect(result.requests).toHaveLength(1)
      expect(result.requests[0]).toMatchObject({ method: 'quirky.git/status', params: { worktree: 'ready' } })
    }
    if (scenario === 'wrong-worktree') {
      expect(result.requests[0]).toMatchObject({
        worktree: 'ready',
        params: { worktree: 'another-worktree' }
      })
    }
    if (scenario === 'no-request') expect(result.requests).toEqual([])
  }
})

test('keeps duplicate-connection and closed-page failures fail-closed', async () => {
  const duplicate = await runRecordingWindowScenario('duplicate-connection')
  expect(duplicate.resolved).toBe(false)
  expect(duplicate.error).toContain('more than one new UI connection appeared')
  expect(duplicate.events.at(-1)).toMatchObject({ stage: 'failed', index: 0, worktree: 'ready' })
  expect(duplicate.browserClosed).toBe(1)
  expect(duplicate.serverClosed).toBe(1)

  const closed = await runRecordingWindowScenario('closed-page')
  expect(closed.resolved).toBe(false)
  expect(closed.error).toContain('page closed before shell became visible')
  expect(closed.events.at(-1)).toMatchObject({ stage: 'failed', index: 0, worktree: 'ready', connId: 41 })
  expect(closed.browserClosed).toBe(1)
  expect(closed.serverClosed).toBe(1)
})

test('reports per-window startup stages and ready identities with the captured browser PID', async () => {
  const result = await runRecordingWindowScenario('two-windows')

  expect(result.resolved).toBe(true)
  expect(result.events).toContainEqual(expect.objectContaining({ stage: 'launch', browserPid: 801 }))
  expect(result.pidAtNavigation).toBe(true)
  expect(result.events.map(({ stage }) => stage)).toEqual(expect.arrayContaining([
    'launch', 'connect', 'context', 'page', 'navigation', 'connection', 'shell',
    'worktree', 'layout', 'changes', 'ready'
  ]))
  expect(result.events.filter(({ stage }) => stage === 'ready')).toEqual(expect.arrayContaining([
    expect.objectContaining({ index: 0, worktree: 'ready', connId: 41 }),
    expect.objectContaining({ index: 1, worktree: 'retry', connId: 42 })
  ]))
  const navigation = result.events.findIndex(({ stage }) => stage === 'navigation')
  expect(result.events.findIndex(({ stage, browserPid }) => stage === 'launch' && browserPid === 801))
    .toBeLessThan(navigation)
  expect(result.requests).toHaveLength(2)
  expect(result.finished?.records.map(({ requests }) => requests)).toEqual([1, 1])
  expect(result.finished?.requests).toContainEqual({ method: 'quirky.git/status', total: 2 })
  expect(result.events.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0)).toBe(true)
})

test('retains bounded navigation failure diagnostics without authenticated URL secrets', async () => {
  const result = await runRecordingWindowScenario('navigation-failure')
  const failed = result.events.at(-1)

  expect(result.resolved).toBe(false)
  expect(result.error).toContain('local renderer navigation failed')
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'launch', browserPid: 801 }),
    expect.objectContaining({ stage: 'navigation', index: 0, worktree: 'ready', browserPid: 801 })
  ]))
  expect(failed).toMatchObject({ stage: 'failed', index: 0, worktree: 'ready' })
  expect(failed?.message).toContain('navigation')
  expect(failed?.message).toContain('local renderer navigation failed')
  expect(failed?.pageErrors).toHaveLength(5)
  expect(failed?.pageErrors?.[0]).toContain('<soak-home>')
  expect(failed?.failedRequests).toHaveLength(5)
  expect(failed?.failedRequests?.[4]?.message).toBe('HTTP 404')
  expect(failed?.failedRequests?.map(({ path }) => path)).toEqual([
    '/assets/0.js', '/assets/1.js', '/assets/2.js', '/assets/3.js', '/assets/4.js'
  ])
  expect(JSON.stringify(result.events)).not.toContain('secret')
  expect(JSON.stringify(result.events)).not.toContain('quirky-soak-window-recording-')
})

test('aborts connection acquisition and closes the browser if it resolves late', async () => {
  const result = await runRecordingWindowScenario('late-connect')

  expect(result.resolved).toBe(false)
  expect(result.error).toContain('soak setup was interrupted')
  expect(result.events.at(-1)).toMatchObject({ stage: 'failed', browserPid: 801 })
  expect(result.tracked).toEqual([801])
  expect(result.browserClosed).toBe(1)
  expect(result.serverClosed).toBe(1)
})

test('reports acquired browser identity before tracking or PID persistence fails, including late launch', async () => {
  for (const scenario of ['track-failure', 'pid-write-failure', 'late-launch-track-failure']) {
    const result = await runRecordingWindowScenario(scenario)
    expect(result.resolved, scenario).toBe(false)
    expect(result.events, scenario).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'launch', browserPid: 801 })
    ]))
    expect(result.events.at(-1), scenario).toMatchObject({ stage: 'failed', browserPid: 801 })
    expect(result.events.at(-1)?.message, scenario).toContain('launch')
    expect(result.pidAtClose, scenario).toBe(true)
    expect(result.serverClosed, scenario).toBe(1)
  }
})

test('observes outgoing /rpc attempts across sockets without altering aggregate request metrics', () => {
  const page = new FakeEmitter()
  const metrics = metricsForTest()
  const allRequests = new Map<string, number>()
  const observed: WindowRequestObservation[] = []
  attachMetrics(
    page as never,
    metrics,
    allRequests,
    '/tmp/soak-home',
    {
      index: 3,
      worktree: 'assigned-worktree',
      onRequest: (request) => observed.push(request),
    },
  )

  const first = fakeSocket('ws://127.0.0.1/rpc')
  page.emit('websocket', first)
  const target = { jsonrpc: '2.0', id: 1, method: 'quirky.git/status', params: { worktree: 'different' } }
  sendFrame(first, JSON.stringify(target))
  sendFrame(first, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'quirky.reviews/checksRefresh', params: { force: true } }))
  sendFrame(first, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'quirky.reviews/checksRefresh', params: { force: false } }))
  sendFrame(first, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'quirky.reviews/state' }))

  const ignoredPath = fakeSocket('ws://127.0.0.1/not-rpc')
  page.emit('websocket', ignoredPath)
  sendFrame(ignoredPath, JSON.stringify(target))

  const reopened = fakeSocket('ws://127.0.0.1/rpc')
  page.emit('websocket', reopened)
  sendFrame(reopened, JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'soak.faults/feedbackRefresh',
    params: { owner: 'another-worktree' },
  }))

  expect(observed.map(({ method }) => method)).toEqual([
    'quirky.git/status',
    'quirky.reviews/checksRefresh',
    'quirky.reviews/checksRefresh',
    'quirky.reviews/state',
    'soak.faults/feedbackRefresh',
  ])
  const counted = observed.filter((request) => isPanelRefreshRequest(request.method, request.params))
  expect(counted.map(({ method }) => method)).toEqual([
    'quirky.git/status',
    'quirky.reviews/checksRefresh',
    'soak.faults/feedbackRefresh',
  ])
  expect(observed.every((request) => request.index === 3 && request.worktree === 'assigned-worktree')).toBe(true)
  expect(observed.every((request) => Number.isFinite(request.at) && request.at >= 0)).toBe(true)
  const observationTimes = observed.map((request) => request.at)
  expect(observationTimes).toEqual([...observationTimes].sort((left, right) => left - right))
  expect(observed[0]).toMatchObject({ method: 'quirky.git/status', params: target.params })
  expect(metrics.requests.get('quirky.git/status')).toBe(1)
  expect(metrics.requests.get('quirky.reviews/checksRefresh')).toBe(2)
  expect(allRequests.get('quirky.git/status')).toBe(1)
  expect(metrics.lastRequestAt).toBeGreaterThan(0)
  expect(metrics.sockets).toBe(2)
})

test('ignores malformed, array, binary and response frames while retaining large and low-ranked requests', () => {
  const page = new FakeEmitter()
  const metrics = metricsForTest()
  const observed: WindowRequestObservation[] = []
  attachMetrics(
    page as never,
    metrics,
    new Map(),
    '/tmp/soak-home',
    { index: 0, worktree: 'a', onRequest: (request) => observed.push(request) },
  )
  const socket = fakeSocket('ws://127.0.0.1/rpc')
  page.emit('websocket', socket)
  for (let index = 0; index < 20; index++) {
    sendFrame(socket, JSON.stringify({ jsonrpc: '2.0', id: index, method: `other.method${index}` }))
  }
  sendFrame(socket, '{')
  sendFrame(socket, JSON.stringify([{ jsonrpc: '2.0', method: 'quirky.git/status' }]))
  sendFrame(socket, new Uint8Array([1, 2, 3]))
  sendFrame(socket, JSON.stringify({ jsonrpc: '2.0', id: 21, result: {}, method: undefined }))
  const padded = {
    jsonrpc: '2.0',
    id: 22,
    method: 'quirky.git/status',
    params: { note: 'x'.repeat(65_536) },
  }
  sendFrame(socket, JSON.stringify(padded))

  expect(observed).toHaveLength(21)
  expect(observed.filter((request) => isPanelRefreshRequest(request.method, request.params)))
    .toHaveLength(1)
  expect(observed.at(-1)?.method).toBe('quirky.git/status')
  expect(observed.at(-1)).toMatchObject({ method: 'quirky.git/status', params: padded.params })
  expect(metrics.requests.get('quirky.git/status')).toBe(1)
  expect(metrics.requests.size).toBe(21)
  const aggregateTop15 = [...metrics.requests.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15)
  expect(aggregateTop15.some(([method]) => method === 'quirky.git/status')).toBe(false)
})

test('keeps platform isolation arguments before caller browser arguments', () => {
  const isolation = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
  expect(chromiumArgs('darwin', ['--disable-gpu'])).toEqual([isolation, '--disable-gpu'])
  expect(chromiumArgs('linux', [])).toEqual([isolation, '--no-sandbox'])
  expect(chromiumArgs('linux', ['--disable-gpu'])).toEqual([isolation, '--no-sandbox', '--disable-gpu'])
  expect(chromiumArgs('darwin', [])).toEqual([isolation])
})

test('assigns one non-main worktree from each project first', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 3)

  expect(assigned.map((worktree) => worktree.name)).toEqual([
    'ui-review-ready', 'retry-queue', 'export-csv'
  ])
})

test('continues assignment round-robin with remaining worktrees and project mains', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 7)

  expect(assigned.map((worktree) => worktree.name)).toEqual([
    'ui-review-ready', 'retry-queue', 'export-csv', 'ui-review-notes',
    'harbor-api', 'ledger-web', 'ui-review-fixture'
  ])
})

test('assigns no worktrees when the requested count is zero', () => {
  expect(assignWorktrees(fixtureWorktrees(), 0)).toEqual([])
})

test('chooses different repositories before repeating a repository', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 2)

  expect(assigned).toHaveLength(2)
  expect(new Set(assigned.map((worktree) => worktree.repoId)).size).toBe(2)
})

test('chromiumPath returns null when Playwright has no installed browsers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-chromium-path-'))
  const home = join(root, 'home')
  const browsers = join(root, 'browsers')
  mkdirSync(home)
  mkdirSync(browsers)
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, 'windows.ts')).href
  const source = `import { chromiumPath } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(chromiumPath()))`
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...process.env, QUIRKY_HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe('null')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
