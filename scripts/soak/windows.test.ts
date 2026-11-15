import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FixtureWorktree } from '../ui-review/fixtures'
import type { WindowRequestObservation } from './contracts.ts'
import { isPanelRefreshRequest } from './verdict.ts'
import { assignWorktrees, attachMetrics, chromiumArgs, type WindowStartupObservation } from './windows.ts'

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
  observations: [],
  requests: [],
  pidAtNavigation: false,
  tracked: [],
  serverClosed: 0,
  resolveConnect: undefined,
  connectReady: Promise.withResolvers(),
  browserClosedPromise: Promise.withResolvers(),
  browserClosedCount: 0,
  controller: undefined
}

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
    sendStatus(worktree) {
      if (!socketOpened) {
        socketOpened = true
        page.emit('websocket', socket)
      }
      socket.emit('framesent', {
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'quirky.git/status', params: { worktree } })
      })
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
          page.emit('pageerror', { message: \`renderer error \${index} at \${process.env.QUIRKY_HOME}\` })
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
  async close() { current.serverClosed++ }
}

mock.module('playwright', () => ({
  chromium: {
    async launchServer() {
      current.events.push('launch')
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
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms === 100) {
    queueMicrotask(() => controller.abort())
    return 0
  }
  return nativeSetTimeout(callback, ms, ...args)
}
const world = {
  home: process.env.QUIRKY_HOME,
  runtime: { port, token: 'runtime-secret' },
  env: {},
  fixtures: {
    worktrees: [
      { id: 'ready', path: '/ready', repoId: 'repo-a', name: 'ready', isMain: false, status: 'working' },
      { id: 'retry', path: '/retry', repoId: 'repo-b', name: 'retry', isMain: false, status: 'failing' }
    ]
  },
  track(pid) { current.tracked.push(pid) },
  control: {
    async callAny(method, params) {
      if (method === 'ui.state') return { windows: current.connectionIds.map((connId) => ({ connId })) }
      if (method === 'ui.window.state') {
        
        
        const worktree = current.selected.get(params.connId) ?? 'ready'
        return {
          layout: {
            worktree,
            view: { id: 'view:quirky.session/worktree' },
            tools: { open: { 'right-top': 'panel:quirky.git/source-control' } }
          }
        }
      }
      if (method === 'quirky.worktree/navigate') {
        const connId = params.window
        const worktree = params.worktree.replace(/^id:/, '')
        current.selected.set(connId, worktree)
        const page = current.pagesByConn.get(connId)
        if (['matching-during-navigation', 'two-windows'].includes(scenario)) sendStatus(page, worktree)
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
      count: scenario === 'two-windows' ? 2 : 1,
      executable: '/recording/chromium',
      out: process.env.QUIRKY_OUT,
      signal: controller.signal,
      onRequest: (request) => current.requests.push(request),
      onStartup: (observation) => current.observations.push({
        ...observation,
        pageErrors: observation.pageErrors?.slice(),
        failedRequests: observation.failedRequests?.map((request) => ({ ...request }))
      })
    })
    const finished = await windows.finish()
    await windows.stop()
    return { resolved: true, finished }
  } catch (error) {
    return { resolved: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let result
if (scenario === 'late-connect') {
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
  browserClosed: number
  serverClosed: number
  finished?: {
    records: Array<{ requests: number }>
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
