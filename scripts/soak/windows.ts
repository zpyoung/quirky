import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright'
import type { FixtureWorktree } from '../ui-review/fixtures.ts'
import type { WindowRecord } from './contracts.ts'
import type { SoakWorld } from './world.ts'

type WindowMetrics = {
  closed: boolean
  crashed: boolean
  requests: Map<string, number>
  sockets: number
  lastRequestAt: number | null
  pageErrors: number
  pageErrorExamples: string[]
}

type OpenWindow = {
  index: number
  worktree: string
  connId: number
  page: Page
  metrics: WindowMetrics
}

export type SoakWindows = {
  pages: readonly Page[]
  browserPid: number
  finish(): Promise<{ records: WindowRecord[]; requests: { method: string; total: number }[] }>
  stop(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function attachMetrics(page: Page, metrics: WindowMetrics, allRequests: Map<string, number>, home: string): void {
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
      const method = (request as Record<string, unknown>).method
      if (typeof method !== 'string') return
      metrics.requests.set(method, (metrics.requests.get(method) ?? 0) + 1)
      allRequests.set(method, (allRequests.get(method) ?? 0) + 1)
      metrics.lastRequestAt = Date.now()
    })
  })
  page.on('pageerror', (error) => {
    metrics.pageErrors++
    if (metrics.pageErrorExamples.length < 5) {
      metrics.pageErrorExamples.push(error.message.replaceAll(home, '<soak-home>').slice(0, 300))
    }
  })
  page.on('crash', () => { metrics.crashed = true })
  page.on('close', () => { metrics.closed = true })
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

async function currentWindowWorktree(world: SoakWorld, connId: number): Promise<string | null> {
  const value = await world.control.callAny('ui.window.state', { connId }, { timeoutMs: 5_000 })
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

/** Opens real renderers and waits for each worktree's own Changes polling. */
export async function openWindows(options: {
  world: SoakWorld
  count: number
  executable: string
  out: string
  signal: AbortSignal
}): Promise<SoakWindows> {
  const { world, count, executable, out, signal } = options
  const worktrees = assignWorktrees(world.fixtures.worktrees, count)
  const sessions: OpenWindow[] = []
  const pages: Page[] = []
  const requests = new Map<string, number>()
  let server: BrowserServer | undefined
  let browser: Browser | undefined
  let launch: Promise<BrowserServer> | undefined
  let stopPromise: Promise<void> | undefined

  const recordServer = (launched: BrowserServer): number | null => {
    const pid = launched.process().pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
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
    const args = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
    if (process.platform === 'linux') args.push('--no-sandbox')
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
    const browserPid = recordServer(server)
    if (browserPid === null) throw new Error('Chromium server did not report its process id')
    throwIfAborted(signal)

    const connection = chromium.connect(server.wsEndpoint(), { timeout: 30_000 })
    browser = await waitWithAbort(connection, 30_000, signal, 'Chromium connection', async (lateBrowser) => {
      await closeBounded(() => lateBrowser.close())
    })

    for (let index = 0; index < worktrees.length; index++) {
      failureIndex = index
      throwIfAborted(signal)
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
        sockets: 0,
        lastRequestAt: null,
        pageErrors: 0,
        pageErrorExamples: []
      }
      attachMetrics(page, metrics, requests, world.home)
      pages.push(page)

      throwIfAborted(signal)
      await waitWithAbort(page.goto(`http://127.0.0.1:${world.runtime.port}/#token=${encodeURIComponent(world.runtime.token)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      }), 30_000, signal, 'renderer navigation')
      const connId = await waitForNewConnection(world, before, signal)
      throwIfAborted(signal)
      await waitWithAbort(
        page.locator('.shell-workspace').waitFor({ state: 'visible', timeout: 30_000 }),
        30_000,
        signal,
        '.shell-workspace visibility'
      )
      sessions.push({ index, worktree: worktrees[index]!.id, connId, page, metrics })
    }

    failureIndex = 0
    await rpc(world, 'quirky.worktree/setOptions', { filterRepoIds: [] }, 5_000, signal)
    await rpc(world, 'ui.tool.open', { id: 'panel:quirky.git/source-control' }, 5_000, signal)

    for (const session of sessions) {
      failureIndex = session.index
      throwIfAborted(signal)
      const worktree = worktrees[session.index]!
      const result = asRecord(await rpc(world, 'quirky.worktree/navigate', {
        worktree: `id:${worktree.id}`,
        window: session.connId
      }, 5_000, signal), 'quirky.worktree/navigate')
      if (result.worktreeId !== worktree.id) throw new Error(`navigation did not select worktree ${worktree.id}`)

      const statusRequestsBeforeReturn = session.metrics.requests.get('quirky.git/status') ?? 0
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

      const deadline = Date.now() + 30_000
      while ((session.metrics.requests.get('quirky.git/status') ?? 0) <= statusRequestsBeforeReturn && Date.now() < deadline) {
        throwIfAborted(signal)
        await pauseWithAbort(Math.min(100, Math.max(1, deadline - Date.now())), signal)
      }
      if ((session.metrics.requests.get('quirky.git/status') ?? 0) <= statusRequestsBeforeReturn) {
        throw new Error('did not send its first quirky.git/status request within 30000ms')
      }
    }

    return {
      pages,
      browserPid,
      async finish() {
        let currentWorktrees = new Set<string>()
        try {
          const state = await world.control.callAny('ui.state', {}, { timeoutMs: 5_000 })
          const ids = connectionIds(state)
          const visible = await Promise.all(ids.map(async (connId) => {
            try {
              return await currentWindowWorktree(world, connId)
            } catch {
              return null
            }
          }))
          currentWorktrees = new Set(visible.filter((worktree): worktree is string => worktree !== null))
        } catch {
          currentWorktrees = new Set()
        }

        const now = Date.now()
        const records = sessions.map((session): WindowRecord => {
          let open = false
          try {
            open = !session.metrics.closed && !session.metrics.crashed && !session.page.isClosed() && browser?.isConnected() === true
          } catch {
            open = false
          }
          return {
            index: session.index,
            worktree: session.worktree,
            connId: session.connId,
            open,
            shown: currentWorktrees.has(session.worktree),
            lastRequestAgeSeconds: session.metrics.lastRequestAt === null ? null : Math.max(0, (now - session.metrics.lastRequestAt) / 1000),
            requests: totalRequests(session.metrics),
            sockets: session.metrics.sockets,
            pageErrors: session.metrics.pageErrors,
            pageErrorExamples: session.metrics.pageErrorExamples.slice(0, 5)
          }
        })
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
        recordServer(server)
      } catch {}
    }
    await stop()
    if (/^window \d+:/.test(errorMessage(error))) throw error
    throw new Error(`window ${failureIndex}: ${errorMessage(error)}`)
  }
}
