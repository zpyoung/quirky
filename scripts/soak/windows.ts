import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright'
import type { FixtureWorktree } from '../ui-review/fixtures.ts'
import type { SwitchRecord, WindowRecord, WindowRequestObservation } from './contracts.ts'
import type { SoakWorld } from './world.ts'

export type WindowStartupObservation = {
  stage: 'launch' | 'connect' | 'context' | 'page' | 'navigation'
    | 'connection' | 'shell' | 'worktree' | 'layout' | 'changes' | 'ready' | 'failed'
  elapsedMs: number
  index?: number
  worktree?: string
  connId?: number
  browserPid?: number
  message?: string
  pageErrors?: string[]
  failedRequests?: Array<{ path: string; message: string }>
}

type RequestFrame = { at: number; method: string; params: unknown }

type WindowAttribution = { settled: string; target: string | null }

const REQUEST_RING_CAPACITY = 2_000
const RECONCILE_MS = 5_000
type WindowMetrics = {
  closed: boolean
  crashed: boolean
  requests: Map<string, number>
  requestRing: (RequestFrame | undefined)[]
  requestCount: number
  nextRequestSlot: number
  requestListeners: Set<(request: RequestFrame) => void>
  sockets: number
  lastRequestAt: number | null
  pageErrors: number
  pageErrorExamples: string[]
  failedRequests?: Array<{ path: string; message: string }>
}

type OpenWindow = {
  index: number
  attribution: WindowAttribution
  connId: number
  page: Page
  metrics: WindowMetrics
  statusRequests: Map<string, number>
}

export type WindowLiveness = Pick<WindowRecord, 'index' | 'connId' | 'worktree' | 'open'>

export type SoakWindows = {
  pages: readonly Page[]
  browserPid: number
  finish(): Promise<{ records: WindowRecord[]; requests: { method: string; total: number }[] }>
  liveness?(): WindowLiveness[]
  navigate?(index: number, worktreeId: string, options: { signal: AbortSignal; followTimeoutMs: number }): Promise<Omit<SwitchRecord, 'at' | 'seq'>>
  waitForRequest?(index: number, matches: (method: string, params: unknown) => boolean,
    options: { since: number; timeoutMs: number; signal: AbortSignal }): Promise<{ at: number; method: string; params: unknown } | null>
  stop(): Promise<void>
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function sanitizeDiagnostic(value: string, home: string, limit: number): string {
  const redacted = value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (raw) => {
    const trailing = raw.match(/[),.;!?]+$/)?.[0] ?? ''
    try {
      const url = new URL(raw.slice(0, raw.length - trailing.length))
      return `${url.origin}${url.pathname}${trailing}`
    } catch {
      return raw
    }
  }).replaceAll(home, '<soak-home>')
  return redacted.slice(0, limit)
}

function localRequestFailure(
  urlValue: string,
  message: string,
  port: number,
  home: string
): { path: string; message: string } | null {
  try {
    const url = new URL(urlValue)
    if (url.origin !== `http://127.0.0.1:${port}`) return null
    return {
      path: url.pathname.slice(0, 300),
      message: sanitizeDiagnostic(message, home, 300)
    }
  } catch {
    return null
  }
}

function interrupted(): Error {
  return new Error('soak setup was interrupted')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw interrupted()
}

function waitWithAbort<T>(
  task: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
  onLateValue?: (value: T) => void | Promise<void>
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (ok: boolean, value: T | Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    if (ok) resolve(value as T)
    else reject(value)
  }
  const closeLateValue = (value: T) => {
    if (onLateValue) void Promise.resolve().then(() => onLateValue(value)).catch(() => undefined)
  }
  const abort = () => finish(false, interrupted())

  if (signal.aborted) {
    settled = true
    void task.then(closeLateValue).catch(() => undefined)
    reject(interrupted())
    return promise
  }
  timer = setTimeout(() => finish(false, new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  task.then((value) => {
    if (settled) closeLateValue(value)
    else finish(true, value)
  }, (error: unknown) => finish(false, error instanceof Error ? error : new Error(String(error))))
  return promise
}

function pauseWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  if (signal.aborted) {
    reject(interrupted())
    return promise
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: Error) => {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    if (error) reject(error)
    else resolve()
  }
  const abort = () => finish(interrupted())
  timer = setTimeout(() => finish(), ms)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return promise
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid response`)
  return value as Record<string, unknown>
}

function connectionIds(value: unknown): number[] {
  const state = asRecord(value, 'ui.state')
  if (!Array.isArray(state.windows)) throw new Error('ui.state returned no windows list')
  const ids: number[] = []
  for (const entry of state.windows) {
    const info = asRecord(entry, 'ui.state window')
    if (typeof info.connId === 'number' && Number.isSafeInteger(info.connId) && info.connId > 0) ids.push(info.connId)
  }
  return ids
}

async function rpc(
  world: SoakWorld,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  throwIfAborted(signal)
  return await waitWithAbort(
    world.control.callAny(method, params, { timeoutMs }),
    timeoutMs,
    signal,
    method
  )
}

async function waitForNewConnection(
  world: SoakWorld,
  existing: Set<number>,
  signal: AbortSignal
): Promise<number> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const timeoutMs = Math.max(1, Math.min(5_000, deadline - Date.now()))
    const ids = connectionIds(await rpc(world, 'ui.state', {}, timeoutMs, signal))
      .filter((connId) => !existing.has(connId))
    if (ids.length === 1) return ids[0]!
    if (ids.length > 1) throw new Error('more than one new UI connection appeared')
    await pauseWithAbort(Math.min(100, Math.max(1, deadline - Date.now())), signal)
  }
  throw new Error('did not connect within 30000ms')
}

function isRpcSocket(url: string): boolean {
  try {
    return new URL(url).pathname === '/rpc'
  } catch {
    return false
  }
}

export function attachMetrics(
  page: Page,
  metrics: WindowMetrics,
  allRequests: Map<string, number>,
  home: string,
  observer?: {
    index: number
    worktree: string | ((method: string, params: unknown) => string)
    onRequest: (request: WindowRequestObservation) => void
  },
): void {
  page.on('websocket', (socket) => {
    if (!isRpcSocket(socket.url())) return
    metrics.sockets++
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      let request: unknown
      try {
        request = JSON.parse(payload)
      } catch {
        return
      }
      if (request === null || typeof request !== 'object' || Array.isArray(request)) return
      const requestRecord = request as Record<string, unknown>
      const method = requestRecord.method
      if (typeof method !== 'string') return
      metrics.requests.set(method, (metrics.requests.get(method) ?? 0) + 1)
      allRequests.set(method, (allRequests.get(method) ?? 0) + 1)
      metrics.lastRequestAt = Date.now()
      const frame: RequestFrame = {
        at: performance.now(),
        method,
        params: requestRecord.params
      }
      metrics.requestRing[metrics.nextRequestSlot] = frame
      metrics.nextRequestSlot = (metrics.nextRequestSlot + 1) % REQUEST_RING_CAPACITY
      metrics.requestCount = Math.min(REQUEST_RING_CAPACITY, metrics.requestCount + 1)
      for (const listener of metrics.requestListeners) listener(frame)
      if (observer) {
        observer.onRequest({
          at: frame.at,
          index: observer.index,
          worktree: typeof observer.worktree === 'function'
            ? observer.worktree(method, frame.params)
            : observer.worktree,
          method,
          params: frame.params
        })
      }
    })
  })

  page.on('pageerror', (error) => {
    metrics.pageErrors++
    if (metrics.pageErrorExamples.length < 5) {
      metrics.pageErrorExamples.push(sanitizeDiagnostic(error.message, home, 300))
    }
  })
  page.on('crash', () => { metrics.crashed = true })
  page.on('close', () => { metrics.closed = true })
}

function normalizedWorktree(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.startsWith('id:') ? value.slice(3) : value
}

function worktreeFromParams(params: unknown): string | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  return normalizedWorktree((params as Record<string, unknown>).worktree)
}

function findRequest(
  metrics: WindowMetrics,
  matches: (method: string, params: unknown) => boolean,
  since: number
): RequestFrame | null {
  const first = (metrics.nextRequestSlot - metrics.requestCount + REQUEST_RING_CAPACITY) % REQUEST_RING_CAPACITY
  for (let offset = 0; offset < metrics.requestCount; offset++) {
    const request = metrics.requestRing[(first + offset) % REQUEST_RING_CAPACITY]
    if (request && request.at >= since && matches(request.method, request.params)) return request
  }
  return null
}

function waitForWindowRequest(
  metrics: WindowMetrics,
  matches: (method: string, params: unknown) => boolean,
  options: { since: number; timeoutMs: number; signal: AbortSignal }
): Promise<RequestFrame | null> {
  if (options.signal.aborted) return Promise.reject(interrupted())
  const buffered = findRequest(metrics, matches, options.since)
  if (buffered) return Promise.resolve(buffered)

  const { promise, resolve, reject } = Promise.withResolvers<RequestFrame | null>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: Error, request?: RequestFrame | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    metrics.requestListeners.delete(onRequest)
    if (error) reject(error)
    else resolve(request ?? null)
  }
  const abort = (): void => finish(interrupted())
  const onRequest = (request: RequestFrame): void => {
    if (request.at < options.since) return
    try {
      if (matches(request.method, request.params)) finish(undefined, request)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }

  metrics.requestListeners.add(onRequest)
  options.signal.addEventListener('abort', abort, { once: true })
  timer = setTimeout(() => finish(), Math.max(0, options.timeoutMs))
  if (options.signal.aborted) abort()
  return promise
}

async function closeBounded(close: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = Promise.withResolvers<never>()
    timer = setTimeout(() => timeout.reject(new Error('cleanup timed out')), 10_000)
    await Promise.race([Promise.resolve().then(close), timeout.promise])
  } catch {
    return
  } finally {
    clearTimeout(timer)
  }
}

async function currentWindowWorktree(world: SoakWorld, connId: number, timeoutMs = RECONCILE_MS): Promise<string | null> {
  const task = world.control.callAny('ui.window.state', { connId }, { timeoutMs })
  const value = await waitWithAbort(task, timeoutMs, new AbortController().signal, 'ui.window.state')
  const state = asRecord(value, 'ui.window.state')
  const layout = asRecord(state.layout, 'ui.window.state layout')
  return typeof layout.worktree === 'string' ? layout.worktree : null
}

function totalRequests(metrics: WindowMetrics): number {
  let total = 0
  for (const count of metrics.requests.values()) total += count
  return total
}

/** Locates the full Chromium binary that the soak will launch. */
export function chromiumPath(): string | null {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && statSync(executable).isFile() ? executable : null
  } catch {
    return null
  }
}

/** Spreads windows across projects before reusing a project's worktrees. */
export function assignWorktrees(worktrees: FixtureWorktree[], count: number): FixtureWorktree[] {
  const groups = new Map<string, { nonMain: FixtureWorktree[]; main: FixtureWorktree[] }>()
  for (const worktree of worktrees) {
    let group = groups.get(worktree.repoId)
    if (!group) {
      group = { nonMain: [], main: [] }
      groups.set(worktree.repoId, group)
    }
    if (worktree.isMain) group.main.push(worktree)
    else group.nonMain.push(worktree)
  }

  const orderedGroups = [...groups.values()].map((group) => [...group.nonMain, ...group.main])
  const selected: FixtureWorktree[] = []
  for (let round = 0; selected.length < count; round++) {
    let added = false
    for (const group of orderedGroups) {
      const worktree = group[round]
      if (!worktree) continue
      selected.push(worktree)
      added = true
      if (selected.length === count) return selected
    }
    if (!added) break
  }
  return selected
}

/** Chromium arguments for an isolated headless browser, with the caller's extras last. */
export function chromiumArgs(platform: NodeJS.Platform, extra: readonly string[]): string[] {
  return [
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ...(platform === 'linux' ? ['--no-sandbox'] : []),
    ...extra
  ]
}

/** Opens real renderers and waits for each worktree's own Changes polling. */
export async function openWindows(options: {
  world: SoakWorld
  count: number
  executable: string
  out: string
  signal: AbortSignal
  browserArgs?: readonly string[]
  onRequest?: (request: WindowRequestObservation) => void
  onStartup?: (observation: WindowStartupObservation) => void
}): Promise<SoakWindows> {

  const startupStartedAt = performance.now()
  const { world, count, executable, out, signal } = options
  const worktrees = assignWorktrees(world.fixtures.worktrees, count)
  const sessions: OpenWindow[] = []
  const pages: Page[] = []
  const requests = new Map<string, number>()
  let server: BrowserServer | undefined
  let browser: Browser | undefined
  let launch: Promise<BrowserServer> | undefined
  let browserPid: number | null = null
  let stopPromise: Promise<void> | undefined
  let currentIndex: number | undefined
  let currentWorktree: string | undefined
  let currentConnId: number | undefined
  let currentMetrics: WindowMetrics | undefined
  let lastStage: WindowStartupObservation['stage'] = 'launch'

  const report = (stage: WindowStartupObservation['stage'], message?: string): void => {
    lastStage = stage
    const observation: WindowStartupObservation = {
      stage,
      elapsedMs: Math.max(0, performance.now() - startupStartedAt),
      ...(currentIndex === undefined ? {} : { index: currentIndex }),
      ...(currentWorktree === undefined ? {} : { worktree: currentWorktree }),
      ...(currentConnId === undefined ? {} : { connId: currentConnId }),
      ...(browserPid === null ? {} : { browserPid }),
      ...(currentMetrics === undefined ? {} : {
        pageErrors: currentMetrics.pageErrorExamples.slice(0, 5),
        ...(currentMetrics.failedRequests === undefined ? {} : {
          failedRequests: currentMetrics.failedRequests.slice(0, 5).map((failure) => ({ ...failure }))
        })
      })
    }
    if (message !== undefined) observation.message = sanitizeDiagnostic(message, world.home, 1_000)
    options.onStartup?.(observation)
  }

  const recordServer = (launched: BrowserServer): number | null => {
    const pid = launched.process().pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
    browserPid = pid
    report('launch')
    world.track(pid)
    writeFileSync(join(out, 'browser.pid'), `${pid}\n`)
    return pid
  }

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (browser) await closeBounded(() => browser!.close())
      if (server) await closeBounded(() => server!.close())
    })()
    return stopPromise
  }

  let failureIndex = 0
  try {
    throwIfAborted(signal)
    if (worktrees.length !== count) throw new Error(`requested ${count} windows but only ${worktrees.length} worktrees are available`)
    const args = chromiumArgs(process.platform, options.browserArgs ?? [])
    report('launch')
    launch = chromium.launchServer({
      executablePath: executable,
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 30_000,
      env: world.env,
      args
    })
    server = await waitWithAbort(launch, 30_000, signal, 'Chromium launch')
    browserPid = recordServer(server)
    if (browserPid === null) throw new Error('Chromium server did not report its process id')
    throwIfAborted(signal)

    report('connect')
    const connection = chromium.connect(server.wsEndpoint(), { timeout: 30_000 })
    browser = await waitWithAbort(connection, 30_000, signal, 'Chromium connection', async (lateBrowser) => {
      await closeBounded(() => lateBrowser.close())
    })

    for (let index = 0; index < worktrees.length; index++) {
      failureIndex = index
      const worktree = worktrees[index]!.id
      currentIndex = index
      currentWorktree = worktree
      currentConnId = undefined
      currentMetrics = undefined
      throwIfAborted(signal)
      report('context')
      const before = new Set(connectionIds(await rpc(world, 'ui.state', {}, 5_000, signal)))
      throwIfAborted(signal)
      const context = await waitWithAbort(
        browser.newContext({ viewport: { width: 1400, height: 880 } }),
        30_000,
        signal,
        'browser context creation',
        async (lateContext) => { await closeBounded(() => lateContext.close()) }
      )
      throwIfAborted(signal)
      report('page')
      const page = await waitWithAbort(
        context.newPage(),
        30_000,
        signal,
        'browser page creation',
        async (latePage) => { await closeBounded(() => latePage.close()) }
      )
      throwIfAborted(signal)
      page.setDefaultTimeout(30_000)
      page.setDefaultNavigationTimeout(30_000)
      const metrics: WindowMetrics = {
        closed: false,
        crashed: false,
        requests: new Map(),
        requestRing: new Array(REQUEST_RING_CAPACITY),
        requestCount: 0,
        nextRequestSlot: 0,
        requestListeners: new Set(),
        sockets: 0,
        lastRequestAt: null,
        pageErrors: 0,
        pageErrorExamples: [],
        failedRequests: []
      }
      const attribution: WindowAttribution = { settled: worktree, target: null }
      const statusRequests = new Map<string, number>()
      currentMetrics = metrics
      attachMetrics(page, metrics, requests, world.home, {
        index,
        worktree: (_method, params) => {
          const requestedWorktree = worktreeFromParams(params)
          return attribution.target !== null && requestedWorktree === attribution.target
            ? attribution.target
            : attribution.settled
        },
        onRequest: (request) => {
          if (request.method === 'quirky.git/status') {
            const requestedWorktree = worktreeFromParams(request.params)
            if (requestedWorktree !== null) {
              statusRequests.set(requestedWorktree, (statusRequests.get(requestedWorktree) ?? 0) + 1)
            }
          }
          options.onRequest?.(request)
        }
      })
      const recordFailedRequest = (url: string, message: string): void => {
        const failures = metrics.failedRequests!
        if (failures.length >= 5) return
        const failure = localRequestFailure(url, message, world.runtime.port, world.home)
        if (failure !== null) failures.push(failure)
      }
      page.on('requestfailed', (request) => {
        recordFailedRequest(request.url(), request.failure()?.errorText ?? 'request failed')
      })
      page.on('response', (response) => {
        const status = response.status()
        if (status >= 400) recordFailedRequest(response.url(), `HTTP ${status}`)
      })
      pages.push(page)

      throwIfAborted(signal)
      report('navigation')
      await waitWithAbort(page.goto(`http://127.0.0.1:${world.runtime.port}/#token=${encodeURIComponent(world.runtime.token)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      }), 30_000, signal, 'renderer navigation')
      report('connection')
      const connId = await waitForNewConnection(world, before, signal)
      currentConnId = connId
      report('connection')
      throwIfAborted(signal)
      report('shell')
      await waitWithAbort(
        page.locator('.shell-workspace').waitFor({ state: 'visible', timeout: 30_000 }),
        30_000,
        signal,
        '.shell-workspace visibility'
      )
      sessions.push({ index, attribution, connId, page, metrics, statusRequests })
    }

    failureIndex = 0
    currentIndex = undefined
    currentWorktree = undefined
    currentConnId = undefined
    currentMetrics = undefined
    report('changes')
    await rpc(world, 'quirky.worktree/setOptions', { filterRepoIds: [] }, 5_000, signal)
    await rpc(world, 'ui.tool.open', { id: 'panel:quirky.git/source-control' }, 5_000, signal)

    for (const session of sessions) {
      failureIndex = session.index
      currentIndex = session.index
      currentWorktree = session.attribution.settled
      currentConnId = session.connId
      currentMetrics = session.metrics
      throwIfAborted(signal)
      const worktree = worktrees[session.index]!
      report('worktree')
      const statusRequestsBeforeNavigation = session.statusRequests.get(worktree.id) ?? 0
      const result = asRecord(await rpc(world, 'quirky.worktree/navigate', {
        worktree: `id:${worktree.id}`,
        window: session.connId
      }, 5_000, signal), 'quirky.worktree/navigate')
      if (result.worktreeId !== worktree.id) throw new Error(`navigation did not select worktree ${worktree.id}`)

      report('layout')
      const value = await rpc(world, 'ui.window.state', { connId: session.connId }, 5_000, signal)
      throwIfAborted(signal)
      const state = asRecord(value, 'ui.window.state')
      const layout = asRecord(state.layout, 'ui.window.state layout')
      const view = asRecord(layout.view, 'ui.window.state view')
      const tools = asRecord(layout.tools, 'ui.window.state tools')
      const openTools = asRecord(tools.open, 'ui.window.state tools.open')
      if (layout.worktree !== worktree.id || view.id !== 'view:quirky.session/worktree'
        || openTools['right-top'] !== 'panel:quirky.git/source-control') {
        throw new Error(`window layout did not show worktree ${worktree.id} with terminal and Changes`)
      }

      report('changes')
      const pageIsOpen = (): boolean => {
        try {
          return !session.metrics.closed && !session.metrics.crashed && !session.page.isClosed()
        } catch {
          return false
        }
      }
      const deadline = Date.now() + 30_000
      while ((session.statusRequests.get(worktree.id) ?? 0) <= statusRequestsBeforeNavigation
        && pageIsOpen() && Date.now() < deadline) {
        throwIfAborted(signal)
        await pauseWithAbort(Math.min(100, Math.max(1, deadline - Date.now())), signal)
      }
      if (!pageIsOpen()) throw new Error('renderer page closed before Changes readiness')
      if ((session.statusRequests.get(worktree.id) ?? 0) <= statusRequestsBeforeNavigation) {
        throw new Error('did not send its first quirky.git/status request within 30000ms')
      }
      report('ready')
    }

    const readyBrowserPid = browserPid
    if (readyBrowserPid === null) throw new Error('Chromium server did not report its process id')

    const isOpen = (session: OpenWindow): boolean => {
      try {
        return !session.metrics.closed && !session.metrics.crashed && !session.page.isClosed() && browser?.isConnected() === true
      } catch {
        return false
      }
    }

    return {
      pages,
      browserPid: readyBrowserPid,
      liveness() {
        return sessions.map((session): WindowLiveness => ({
          index: session.index,
          connId: session.connId,
          worktree: session.attribution.settled,
          open: isOpen(session)
        }))
      },
      waitForRequest(index, matches, requestOptions) {
        const session = sessions.find((candidate) => candidate.index === index)
        if (!session) return Promise.reject(new Error(`window ${index} does not exist`))
        return waitForWindowRequest(session.metrics, matches, requestOptions)
      },
      async navigate(index, worktreeId, navigationOptions) {
        const session = sessions.find((candidate) => candidate.index === index)
        if (!session) throw new Error(`window ${index} does not exist`)
        if (navigationOptions.signal.aborted) throw interrupted()

        const since = performance.now()
        const deadline = since + navigationOptions.followTimeoutMs
        const previous = session.attribution.settled
        session.attribution.target = worktreeId
        const reconcile = async (): Promise<boolean> => {
          try {
            const worktree = await currentWindowWorktree(world, session.connId, RECONCILE_MS)
            if (worktree !== null) session.attribution.settled = worktree
            return worktree !== null
          } catch {
            return false
          } finally {
            session.attribution.target = null
          }
        }
        const failedRecord = (error: string): Omit<SwitchRecord, 'at' | 'seq'> => ({
          index,
          from: previous,
          requested: worktreeId,
          settled: session.attribution.settled,
          proof: null,
          ok: false,
          followMs: null,
          error
        })

        const failedFollow = async (): Promise<Omit<SwitchRecord, 'at' | 'seq'>> => {
          const readable = await reconcile()
          if (navigationOptions.signal.aborted) throw interrupted()
          const message = `did not request status for ${worktreeId} within ${navigationOptions.followTimeoutMs}ms`
          return failedRecord(`${message}${readable ? '' : '; window state unreadable'}`)
        }

        let result: Record<string, unknown>
        try {
          const timeoutMs = Math.max(0, deadline - performance.now())
          const task = world.control.callAny('quirky.worktree/navigate', {
            worktree: `id:${worktreeId}`,
            window: session.connId
          }, { timeoutMs })
          result = asRecord(await waitWithAbort(
            task,
            timeoutMs,
            navigationOptions.signal,
            'quirky.worktree/navigate'
          ), 'quirky.worktree/navigate')
        } catch (error) {
          const readable = await reconcile()
          if (navigationOptions.signal.aborted) throw interrupted()
          const message = `${errorMessage(error)}${readable ? '' : '; window state unreadable'}`
          return failedRecord(message)
        }

        if (performance.now() > deadline) {
          const readable = await reconcile()
          if (navigationOptions.signal.aborted) throw interrupted()
          const message = `quirky.worktree/navigate timed out after ${navigationOptions.followTimeoutMs}ms`
          return failedRecord(`${message}${readable ? '' : '; window state unreadable'}`)
        }

        if (result.worktreeId !== worktreeId) {
          const readable = await reconcile()
          if (navigationOptions.signal.aborted) throw interrupted()
          const message = `navigation selected ${String(result.worktreeId)}, expected ${worktreeId}`
          return failedRecord(`${message}${readable ? '' : '; window state unreadable'}`)
        }

        session.attribution.settled = worktreeId
        session.attribution.target = null
        let proof: RequestFrame | null
        try {
          proof = await waitForWindowRequest(session.metrics, (method, params) =>
            method === 'quirky.git/status' && worktreeFromParams(params) === worktreeId, {
            since,
            timeoutMs: Math.max(0, deadline - performance.now()),
            signal: navigationOptions.signal
          })
        } catch (error) {
          if (navigationOptions.signal.aborted) {
            await reconcile()
            throw interrupted()
          }
          throw error
        }
        if (navigationOptions.signal.aborted) {
          await reconcile()
          throw interrupted()
        }
        if (proof === null || proof.at > deadline) return await failedFollow()
        const observedWorktree = worktreeFromParams(proof.params)
        if (observedWorktree === null) return await failedFollow()
        return {
          index,
          from: previous,
          requested: worktreeId,
          settled: session.attribution.settled,
          proof: { at: proof.at, method: proof.method, worktree: observedWorktree },
          ok: true,
          followMs: proof.at - since,
          error: null
        }
      },
      async finish() {
        const daemonWindows = await Promise.all(sessions.map(async (session) => {
          try {
            const worktree = await currentWindowWorktree(world, session.connId)
            return {
              worktree: worktree ?? session.attribution.settled,
              shown: worktree !== null && worktree === session.attribution.settled
            }
          } catch {
            return { worktree: session.attribution.settled, shown: false }
          }
        }))
        const now = Date.now()
        const records = sessions.map((session, index): WindowRecord => ({
          index: session.index,
          worktree: daemonWindows[index]!.worktree,
          connId: session.connId,
          open: isOpen(session),
          shown: daemonWindows[index]!.shown,
          lastRequestAgeSeconds: session.metrics.lastRequestAt === null ? null : Math.max(0, (now - session.metrics.lastRequestAt) / 1000),
          requests: totalRequests(session.metrics),
          sockets: session.metrics.sockets,
          pageErrors: session.metrics.pageErrors,
          pageErrorExamples: session.metrics.pageErrorExamples.slice(0, 5)
        }))
        const topRequests = [...requests.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 15)
          .map(([method, total]) => ({ method, total }))
        return { records, requests: topRequests }
      },
      stop
    }
  } catch (error) {
    if (!server && launch) {
      try {
        server = await launch
        browserPid = recordServer(server)
      } catch {}
    }
    try {
      report('failed', `${lastStage}: ${errorMessage(error)}`)
    } catch {}
    await stop()
    if (/^window \d+:/.test(errorMessage(error))) throw error
    throw new Error(`window ${failureIndex}: ${errorMessage(error)}`)
  }
}
