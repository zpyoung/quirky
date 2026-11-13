import { existsSync, statSync } from 'node:fs'
import { readRuntime } from '@quirky/protocol/node'
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from 'playwright'
import { chromiumPath } from '../soak/windows'
import { BrowserFailure, readShimLogs, type BrowserWorld } from './browser-world'
import type { BrowserCheck, CheckContext } from './browser-run'

export type WatchPixelSample = {
  r: number
  g: number
  b: number
  digest: string
  naturalWidth: number
  naturalHeight: number
  sampleX: number
  sampleY: number
}

export type WatchRenderer = {
  page: Page
  pid: number
  connectToDaemon(home: string): Promise<{ port: number }>
  close(): Promise<void>
}

export type WatchAndRestartOutcome = {
  watch?: {
    beforeSample?: WatchPixelSample | null
    afterSample?: WatchPixelSample | null
  }
  restart?: {
    previousPid?: number
    daemonPid?: number
    pageA?: string
    pageB?: string
    profileA?: string
    profileB?: string
    localStorageA?: string | null
    cookieA?: string | null
    localStorageB?: string | null
    cookiesB?: readonly { name: string; value: string }[]
    identityAfterRestart?: { mode?: string; active?: string; restartRequired?: boolean }
  }
  shimLogs?: { empty: boolean; bytes: Record<string, number>; orcaLog: string; securityLog: string }
}

type PageCssSize = { width: number; height: number }
type RendererOptions = { launchServer?: typeof chromium.launchServer; signal?: AbortSignal; deadline?: number }
type WatchState = { mode: string; active: string; restartRequired: boolean }
type PaneTab = { id: string; worktreeId: string; mode: string; page: string; profileId: string }
type WatchSampleCheck = (sample: WatchPixelSample) => boolean

const CLOSE_TIMEOUT_MS = 2_500
const RENDERER_STARTUP_MS = 30_000
const SAMPLE_POLL_MS = 80
const SAMPLE_WINDOW_MS = 15_000

function deadlineFailure(signal: AbortSignal | undefined, message: string): BrowserFailure {
  const reason = signal?.reason
  if (reason instanceof BrowserFailure) return reason
  return new BrowserFailure('deadline', message)
}

function remainingMs(deadline: number, signal: AbortSignal | undefined, message: string): number {
  if (signal?.aborted) throw deadlineFailure(signal, message)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new BrowserFailure('deadline', message)
  return Math.max(1, Math.floor(remaining))
}

async function awaitOperation<T>(
  operation: () => PromiseLike<T> | T,
  deadline: number,
  signal: AbortSignal | undefined,
  message: string
): Promise<T> {
  const remaining = remainingMs(deadline, signal, message)
  let removeAbort: (() => void) | undefined
  const timedOut = Promise.withResolvers<never>()
  const cancelled = Promise.withResolvers<never>()
  const timer = setTimeout(() => timedOut.reject(new BrowserFailure('deadline', message)), remaining)
  if (signal) {
    const abort = () => cancelled.reject(deadlineFailure(signal, message))
    signal.addEventListener('abort', abort, { once: true })
    removeAbort = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) abort()
  }
  try {
    return await Promise.race([Promise.resolve().then(operation), timedOut.promise, cancelled.promise])
  } finally {
    clearTimeout(timer)
    removeAbort?.()
  }
}

function throwRendererFailure(error: unknown, stage: 'launch' | 'connect' | 'shell', signal: AbortSignal | undefined, deadline: number): never {
  if (error instanceof BrowserFailure) throw error
  if (signal?.aborted || Date.now() >= deadline) throw deadlineFailure(signal, 'Watch pane renderer exceeded its deadline')
  const message = error instanceof Error ? error.message : String(error)
  throw new BrowserFailure(stage === 'launch' ? 'startup-failed' : 'wrong-page', `Watch pane renderer ${stage} failed: ${message}`)
}

async function closeBounded(close: () => Promise<unknown> | undefined, deadline: number): Promise<void> {
  const closing = Promise.resolve().then(close).then(() => undefined, () => undefined)
  const timeout = Math.max(0, Math.min(CLOSE_TIMEOUT_MS, deadline - Date.now()))
  if (timeout === 0) {
    void closing
    return
  }
  const timedOut = Promise.withResolvers<void>()
  const timer = setTimeout(timedOut.resolve, timeout)
  try {
    await Promise.race([closing, timedOut.promise])
  } finally {
    clearTimeout(timer)
  }
}


async function closeRendererHandles(
  context: BrowserContext | undefined,
  browser: Browser | undefined,
  server: BrowserServer | undefined,
  deadline: number
): Promise<void> {
  await Promise.all([
    closeBounded(() => context?.close(), deadline),
    closeBounded(() => browser?.close(), deadline)
  ])
  await closeBounded(() => server?.close(), deadline)
}

function validExecutable(path: string | undefined): path is string {
  if (!path || !existsSync(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export async function openWatchRenderer(world: BrowserWorld, options: RendererOptions = {}): Promise<WatchRenderer> {
  const deadline = options.deadline ?? Date.now() + RENDERER_STARTUP_MS
  const signal = options.signal
  let server: BrowserServer | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let stage: 'launch' | 'connect' | 'shell' = 'launch'
  let launchPromise: Promise<BrowserServer> | undefined
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= closeRendererHandles(context, browser, server, deadline)
    return closePromise
  }
  try {
    remainingMs(deadline, signal, 'Watch pane renderer startup deadline reached')
    const executablePath = chromiumPath() ?? world.env.QUIRKY_BROWSER_CHROME
    if (!validExecutable(executablePath)) throw new BrowserFailure('missing-chrome', 'No Chromium or Chrome binary available for Watch pane renderer')
    const launchServer = options.launchServer ?? chromium.launchServer.bind(chromium)
    const launchOptions = {
      headless: true,
      executablePath,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      env: world.env,
      timeout: remainingMs(deadline, signal, 'Watch pane renderer launch deadline reached'),
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
    }
    server = await awaitOperation(() => {
      const pendingLaunch = Promise.resolve(launchServer(launchOptions))
      launchPromise = pendingLaunch
      return pendingLaunch
    }, deadline, signal, 'Watch pane renderer launch deadline reached')
    const pid = server.process()?.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new BrowserFailure('startup-failed', 'Watch renderer Chromium server did not report a pid')
    world.track?.(pid)
    stage = 'connect'
    browser = await awaitOperation(
      () => chromium.connect(server!.wsEndpoint(), { timeout: remainingMs(deadline, signal, 'Watch renderer connection deadline reached') }),
      deadline,
      signal,
      'Watch renderer connection deadline reached'
    )
    context = await awaitOperation(
      () => browser!.newContext({ viewport: { width: 1440, height: 900 } }),
      deadline,
      signal,
      'Watch renderer context creation deadline reached'
    )
    const page = await awaitOperation(() => context!.newPage(), deadline, signal, 'Watch renderer page creation deadline reached')
    await page.setDefaultTimeout(Math.min(5_000, remainingMs(deadline, signal, 'Watch renderer setup deadline reached')))
    let escapedUrl: string | undefined
    await awaitOperation(() => page.route('**/*', async route => {
      let url: URL
      try {
        url = new URL(route.request().url())
      } catch {
        escapedUrl = route.request().url()
        await route.abort().catch(() => {})
        return
      }
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        await route.continue()
        return
      }
      escapedUrl = url.href
      await route.abort().catch(() => {})
    }), deadline, signal, 'Watch renderer route setup deadline reached')
    const renderer: WatchRenderer = {
      page,
      pid,
      async connectToDaemon(home) {
        stage = 'shell'
        const runtime = readRuntime(home)
        if (!runtime || typeof runtime.port !== 'number' || typeof runtime.token !== 'string' || !runtime.token) {
          throw new BrowserFailure('daemon-exited', 'temporary browser daemon runtime is unavailable for Watch pane renderer')
        }
        const address = `http://127.0.0.1:${runtime.port}/`
        const url = `${address}#token=${encodeURIComponent(runtime.token)}`
        if (page.url().startsWith(address)) {
          await awaitOperation(
            () => page.goto('about:blank', { timeout: remainingMs(deadline, signal, 'Watch renderer document reset deadline reached') }),
            deadline,
            signal,
            'Watch renderer document reset deadline reached'
          )
        }
        await awaitOperation(
          () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: remainingMs(deadline, signal, 'Watch renderer shell navigation deadline reached') }),
          deadline,
          signal,
          'Watch renderer shell navigation deadline reached'
        )
        await awaitOperation(
          () => page.waitForFunction(() => {
            const app = document.querySelector('.app')
            return app !== null && app.querySelector('.banner') === null
          }, undefined, { timeout: remainingMs(deadline, signal, 'Watch renderer RPC handshake deadline reached') }),
          deadline,
          signal,
          'Watch renderer RPC handshake deadline reached'
        )
        if (escapedUrl) throw new BrowserFailure('network-escape', `Watch renderer attempted non-loopback request ${escapedUrl}`)
        return { port: runtime.port }
      },
      close
    }
    return renderer
  } catch (error) {
    if (!server && launchPromise) {
      void launchPromise.then(async (lateServer) => {
        server = lateServer
        try {
          const latePid = lateServer.process()?.pid
          if (typeof latePid === 'number' && Number.isSafeInteger(latePid) && latePid > 0) world.track?.(latePid)
        } finally {
          await closeBounded(() => lateServer.close(), Date.now() + CLOSE_TIMEOUT_MS)
        }
      }).catch(() => undefined)
    }
    await close()
    throwRendererFailure(error, stage, signal, deadline)
  }
}

export async function sampleWatchMarker(
  uiPage: Page,
  pageCssSize: PageCssSize,
  options: { signal?: AbortSignal; deadline?: number } = {}
): Promise<WatchPixelSample> {
  const deadline = options.deadline ?? Date.now() + 30_000
  if (!Number.isFinite(pageCssSize.width) || !Number.isFinite(pageCssSize.height) || pageCssSize.width <= 0 || pageCssSize.height <= 0) {
    throw new BrowserFailure('wrong-page', 'Watch page CSS dimensions are unavailable')
  }
  try {
    return await awaitOperation(() => uiPage.locator('.qbp-watch-image').evaluate((node, size) => {
      const image = node as HTMLImageElement
      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error('Watch pane image has not rendered')
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Watch pane sample canvas is unavailable')
      context.drawImage(image, 0, 0)
      const sampleX = Math.round((120 / size.width) * image.naturalWidth)
      const sampleY = Math.round((80 / size.height) * image.naturalHeight)
      if (sampleX < 2 || sampleY < 2 || sampleX + 2 >= image.naturalWidth || sampleY + 2 >= image.naturalHeight) {
        throw new Error('Watch marker sample is outside the rendered frame')
      }
      const pixels = context.getImageData(sampleX - 2, sampleY - 2, 5, 5).data
      if (pixels.length !== 100) throw new Error('Watch marker sample did not contain 25 pixels')
      let r = 0
      let g = 0
      let b = 0
      for (let index = 0; index < pixels.length; index += 4) {
        r += pixels[index]!
        g += pixels[index + 1]!
        b += pixels[index + 2]!
      }
      let hash = 2_166_136_261
      for (let index = 0; index < image.src.length; index++) hash = Math.imul(hash ^ image.src.charCodeAt(index), 16_777_619)
      return {
        r: Math.round(r / 25),
        g: Math.round(g / 25),
        b: Math.round(b / 25),
        digest: (hash >>> 0).toString(16).padStart(8, '0'),
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        sampleX,
        sampleY
      }
    }, pageCssSize, { timeout: Math.min(5_000, remainingMs(deadline, options.signal, 'Watch frame sample deadline reached')) }), deadline, options.signal, 'Watch frame sample deadline reached')
  } catch (error) {
    if (error instanceof BrowserFailure) throw error
    throw new BrowserFailure('wrong-page', 'Watch pane image failed to render a sample')
  }
}

export function isRedSample(sample: WatchPixelSample): boolean {
  return sample.r > 180 && sample.g < 80 && sample.b < 80
}

export function isGreenSample(sample: WatchPixelSample): boolean {
  return sample.g > 180 && sample.r < 80 && sample.b < 80
}

export function verifyWatchAndRestartOutcome(outcome: WatchAndRestartOutcome): void {
  if (outcome.watch) {
    const { beforeSample, afterSample } = outcome.watch
    if (!beforeSample || !afterSample || !isRedSample(beforeSample) || !isGreenSample(afterSample) || beforeSample.digest === afterSample.digest) {
      throw new BrowserFailure('wrong-page', 'Watch pane did not render a red marker followed by a new green frame')
    }
  }
  if (outcome.restart) {
    const restart = outcome.restart
    if (typeof restart.previousPid !== 'number' || typeof restart.daemonPid !== 'number' || restart.previousPid === restart.daemonPid ||
      !restart.pageA || !restart.pageB || !restart.profileA || !restart.profileB ||
      restart.localStorageA !== 'local-restart' || restart.cookieA !== 'cookie-restart' ||
      restart.localStorageB !== null || !Array.isArray(restart.cookiesB) || restart.cookiesB.some(cookie => cookie.name === 'restart') ||
      restart.identityAfterRestart?.active !== 'native') {
      throw new BrowserFailure('restart-lost-profile', 'Browser profile, daemon, or worktree-isolation state did not survive restart')
    }
  }
  if (outcome.shimLogs && (!outcome.shimLogs.empty || outcome.shimLogs.orcaLog !== '' || outcome.shimLogs.securityLog !== '')) {
    throw new BrowserFailure('shim-invoked', 'Browser parity invoked an Orca or security shim')
  }
}

function isIdentityState(value: unknown): value is WatchState {
  return value !== null && typeof value === 'object' && 'mode' in value && typeof value.mode === 'string' &&
    'active' in value && typeof value.active === 'string' && 'restartRequired' in value && typeof value.restartRequired === 'boolean'
}

function assertIdentityState(c: CheckContext, actual: WatchState, expected: WatchState, label: string): void {
  c.equal(actual, expected, label)
}

function assertUserAgent(c: CheckContext, userAgent: string, mode: 'clean' | 'native'): void {
  c.assert(typeof userAgent === 'string', `${mode} identity did not expose a navigator.userAgent string`)
  const containsHeadless = userAgent.includes('HeadlessChrome/')
  c.assert(mode === 'native' ? containsHeadless : !containsHeadless,
    `${mode} identity user agent had unexpected HeadlessChrome/ evidence`)
}

async function ensurePaneTargets(c: CheckContext): Promise<void> {
  if (!c.state.profileA) {
    const created = await c.call<{ profile: { id: string } }>('tab profile create', { label: 'Parity A' }, '')
    c.state.profileA = created.profile.id
  }
  if (!c.state.profileB) {
    const created = await c.call<{ profile: { id: string } }>('tab profile create', { label: 'Parity B' }, '')
    c.state.profileB = created.profile.id
  }
  if (!c.state.pageA) {
    const created = await c.call<{ browserPageId: string }>('tab create', {
      worktree: c.world.worktreeA,
      profile: c.state.profileA,
      url: `${c.world.fixture.origin}/watch-page`
    }, '')
    c.state.pageA = created.browserPageId
  }
  if (!c.state.pageB) {
    const created = await c.call<{ browserPageId: string }>('tab create', {
      worktree: c.world.worktreeB,
      profile: c.state.profileB,
      url: `${c.world.fixture.origin}/page?peer=b`
    }, '')
    c.state.pageB = created.browserPageId
  }
}

function paneRenderer(c: CheckContext): WatchRenderer | undefined {
  const renderer = c.state.watchRenderer
  return renderer !== null && typeof renderer === 'object' && 'close' in renderer && typeof renderer.close === 'function'
    ? renderer as WatchRenderer
    : undefined
}

async function waitForWatchSample(
  uiPage: Page,
  pageCssSize: PageCssSize,
  accept: WatchSampleCheck,
  description: string,
  c: CheckContext,
  deadline = Math.min(c.deadline ?? Date.now() + SAMPLE_WINDOW_MS, Date.now() + SAMPLE_WINDOW_MS)
): Promise<WatchPixelSample> {
  let latestError: unknown
  while (Date.now() < deadline) {
    const sample = await sampleWatchMarker(uiPage, pageCssSize, { signal: c.signal, deadline }).catch(error => {
      if (error instanceof BrowserFailure && error.kind === 'wrong-page') {
        latestError = error
        return undefined
      }
      throw error
    })
    if (sample && accept(sample)) return sample
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await awaitOperation(() => Bun.sleep(Math.min(SAMPLE_POLL_MS, remaining)), deadline, c.signal, `waiting for ${description} exceeded its deadline`)
  }
  const detail = latestError instanceof Error ? `: ${latestError.message}` : ''
  throw new BrowserFailure('wrong-page', `${description} did not render before the Watch pane deadline${detail}`)
}

async function waitForRendererAddress(renderer: WatchRenderer, url: string, c: CheckContext): Promise<void> {
  const deadline = c.deadline ?? Date.now() + SAMPLE_WINDOW_MS
  await awaitOperation(() => renderer.page.waitForFunction(expected => {
    return document.querySelector<HTMLInputElement>('input[aria-label="Address and search"]')?.value === expected
  }, url, { timeout: remainingMs(deadline, c.signal, 'Watch pane address update deadline reached') }), deadline, c.signal, 'Watch pane address update deadline reached')
}

async function openWorktreeA(c: CheckContext): Promise<void> {
  const receipt = await c.world.cli(['worktree', 'open-in', `id:${c.world.worktreeA}`, '--target', 'terminal'])
  const result = receipt.result as { worktreeId?: unknown; target?: unknown }
  c.assert(result.worktreeId === c.world.worktreeA && result.target === 'terminal', 'UI window did not switch to worktree A')
}

async function restartDaemon(c: CheckContext): Promise<{ previousPid: number; daemonPid: number }> {
  if (!c.world.restartDaemon) throw new BrowserFailure('restart-lost-profile', 'Browser world does not support daemon restart')
  const previousPid = c.world.daemonPid
  const restarted = await c.world.restartDaemon(c.signal)
  const daemonPid = c.world.daemonPid
  if (restarted.previousPid !== previousPid || restarted.daemonPid !== daemonPid) {
    throw new BrowserFailure('restart-lost-profile', 'Browser daemon pid did not advance across restart')
  }
  const runtime = readRuntime(c.world.home)
  if (!runtime || runtime.pid !== daemonPid) throw new BrowserFailure('restart-lost-profile', 'Restarted browser daemon runtime is unavailable')
  return { previousPid, daemonPid }
}

async function stageNativeIdentity(c: CheckContext): Promise<{ identity: WatchState; userAgent: string }> {
  const identity = await c.call<WatchState>('identity set', { mode: 'native' }, '')
  assertIdentityState(c, identity, { mode: 'native', active: 'clean', restartRequired: true }, 'identity must stage native mode before restart')
  c.state.identityNeedsRestore = true
  const userAgent = await c.observe<string>('navigator.userAgent', c.state.pageA)
  assertUserAgent(c, userAgent, 'clean')
  c.state.identityBeforeRestart = identity
  c.state.userAgentBeforeRestart = userAgent
  return { identity, userAgent }
}

async function activateNativeIdentity(c: CheckContext): Promise<{ identity: WatchState; userAgent: string }> {
  const { daemonPid } = await restartDaemon(c)
  const runtime = readRuntime(c.world.home)
  if (!runtime || runtime.pid !== daemonPid) throw new BrowserFailure('restart-lost-profile', 'Restarted runtime identity is unavailable')
  await c.call('goto', { url: `${c.world.fixture.origin}/watch-page` }, c.state.pageA)
  const identity = await c.call<WatchState>('identity get', {}, '')
  c.assert(identity.mode === 'native' && identity.active === 'native' && !identity.restartRequired, 'native browser identity did not activate after daemon restart')
  const userAgent = await c.observe<string>('navigator.userAgent', c.state.pageA)
  assertUserAgent(c, userAgent, 'native')
  c.state.identityAfterRestart = identity
  c.state.userAgentAfterRestart = userAgent
  return { identity, userAgent }
}


export const paneChecks: BrowserCheck[] = [
  {
    id: 'worktree-watch-page',
    async run(c) {
      await ensurePaneTargets(c)
      await c.call('viewport', { width: 800, height: 600, scale: 1, mobile: false }, c.state.pageA)
      await c.call('goto', { url: `${c.world.fixture.origin}/watch-page` }, c.state.pageA)
      await c.call('goto', { url: `${c.world.fixture.origin}/page?peer=b` }, c.state.pageB)
      const pageCssSize = await c.observe<PageCssSize>('({ width: window.innerWidth, height: window.innerHeight })', c.state.pageA)
      let renderer: WatchRenderer | undefined
      try {
        renderer = await openWatchRenderer(c.world, { signal: c.signal, deadline: c.deadline })
        c.state.watchRenderer = renderer
        await renderer.connectToDaemon(c.world.home)
        await openWorktreeA(c)
        const opened = await c.call<PaneTab>('pane open', { mode: 'watch' }, c.state.pageA)
        c.assert(opened.id && opened.page === c.state.pageA && opened.profileId === c.state.profileA && opened.mode === 'watch', 'Watch pane opened with the wrong page or profile')
        c.state.paneTabId = opened.id
        const paneState = await c.call<{ tabs: PaneTab[]; active: string | null }>('pane state', { worktree: `id:${c.world.worktreeA}` }, '')
        c.assert(paneState.tabs.some(tab => tab.id === opened.id && tab.page === c.state.pageA && tab.profileId === c.state.profileA && tab.mode === 'watch'), 'Watch pane state is not bound to page A')
        c.equal(paneState.active, opened.id, 'Watch pane is not active')
        const beforeSample = await waitForWatchSample(renderer.page, pageCssSize, isRedSample, 'red Watch marker', c)
        const worktreeBBefore = await c.observe<{ title: string; field: string | null; result: string | null }>(
          '({ title: document.title, field: document.querySelector("#text")?.value ?? null, result: document.querySelector("#result")?.textContent ?? null })',
          c.state.pageB
        )
        c.equal(worktreeBBefore, { title: 'Parity fixture', field: 'seed', result: '' }, 'worktree B fixture did not start in its untouched state')
        await c.call('click', { element: '#watch-marker' }, c.state.pageA)
        const afterClick = await c.observe<{ title: string; state: string | null }>(
          '({ title: document.title, state: document.querySelector("#watch-marker")?.getAttribute("data-state") ?? null })',
          c.state.pageA
        )
        c.equal(afterClick, { title: 'CLI changed', state: 'green' }, 'CLI click did not change the watched page')
        const afterSample = await waitForWatchSample(renderer.page, pageCssSize,
          sample => isGreenSample(sample) && sample.digest !== beforeSample.digest,
          'new green Watch frame after CLI click', c)
        verifyWatchAndRestartOutcome({ watch: { beforeSample, afterSample } })
        await waitForRendererAddress(renderer, `${c.world.fixture.origin}/watch-page`, c)
        const worktreeBAfter = await c.observe<{ title: string; field: string | null; result: string | null }>(
          '({ title: document.title, field: document.querySelector("#text")?.value ?? null, result: document.querySelector("#result")?.textContent ?? null })',
          c.state.pageB
        )
        c.equal(worktreeBAfter, worktreeBBefore, 'CLI click in worktree A changed worktree B page')
        return {
          worktreeId: c.world.worktreeA,
          pageId: c.state.pageA,
          profileId: c.state.profileA,
          paneTabId: opened.id,
          beforeSample,
          afterSample,
          titleAfterClick: afterClick.title,
          worktreeBBefore,
          worktreeBAfter
        }
      } catch (error) {
        if (renderer) {
          await renderer.close()
          if (c.state.watchRenderer === renderer) delete c.state.watchRenderer
        }
        throw error
      }
    }
  },
  {
    id: 'daemon-restart-profile',
    async run(c) {
      const renderer = paneRenderer(c)
      if (!renderer) throw new BrowserFailure('wrong-page', 'Watch renderer was not retained for daemon restart')
      try {
        await c.call('storage local set', { key: 'restart', value: 'local-restart' }, c.state.pageA)
        await c.call('cookie set', {
          name: 'restart',
          value: 'cookie-restart',
          url: c.world.fixture.origin,
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600
        }, c.state.pageA)
        const { userAgent: userAgentBeforeRestart } = await stageNativeIdentity(c)
        const restarted = await restartDaemon(c)
        const tabsAfter = await c.call<{ tabs: Array<{ browserPageId: string; worktreeId: string; profileId: string; url: string }> }>('tab list', { worktree: 'all' }, '')
        c.assert(tabsAfter.tabs.some(tab => tab.browserPageId === c.state.pageA && tab.worktreeId === c.world.worktreeA && tab.profileId === c.state.profileA), 'page A tab did not survive daemon restart')
        c.assert(tabsAfter.tabs.some(tab => tab.browserPageId === c.state.pageB && tab.worktreeId === c.world.worktreeB && tab.profileId === c.state.profileB), 'page B tab did not survive daemon restart')
        const profilesAfter = await c.call<{ profiles: Array<{ id: string; label: string }> }>('tab profile list', {}, '')
        c.assert(profilesAfter.profiles.some(profile => profile.id === c.state.profileA && profile.label === 'Parity A'), 'Parity A profile did not survive daemon restart')
        c.assert(profilesAfter.profiles.some(profile => profile.id === c.state.profileB && profile.label === 'Parity B'), 'Parity B profile did not survive daemon restart')
        await c.call('goto', { url: `${c.world.fixture.origin}/watch-page` }, c.state.pageA)
        const localA = await c.call<{ key: string; value: string | null }>('storage local get', { key: 'restart' }, c.state.pageA)
        const cookiesA = await c.call<{ cookies: Array<{ name: string; value: string }> }>('cookie get', { url: c.world.fixture.origin }, c.state.pageA)
        const cookieA = cookiesA.cookies.find(cookie => cookie.name === 'restart')?.value ?? null
        await c.call('goto', { url: `${c.world.fixture.origin}/page?peer=b` }, c.state.pageB)
        const localB = await c.call<{ key: string; value: string | null }>('storage local get', { key: 'restart' }, c.state.pageB)
        const cookiesB = await c.call<{ cookies: Array<{ name: string; value: string }> }>('cookie get', { url: c.world.fixture.origin }, c.state.pageB)
        const cookieCountB = cookiesB.cookies.filter(cookie => cookie.name === 'restart').length
        await c.call('goto', { url: `${c.world.fixture.origin}/watch-page` }, c.state.pageB)
        const worktreeBMarkerBefore = await c.observe<string | null>('document.querySelector("#watch-marker")?.getAttribute("data-state") ?? null', c.state.pageB)
        c.equal(worktreeBMarkerBefore, 'red', 'worktree B marker did not start red')
        const runtimeAfter = readRuntime(c.world.home)
        if (!runtimeAfter || runtimeAfter.pid !== restarted.daemonPid) throw new BrowserFailure('restart-lost-profile', 'Restarted daemon runtime is unavailable for Watch reconnect')
        const connected = await renderer.connectToDaemon(c.world.home)
        c.equal(connected.port, runtimeAfter.port, 'Watch renderer did not connect to the restarted daemon runtime')
        await openWorktreeA(c)
        const paneTabId = c.state.paneTabId
        c.assert(typeof paneTabId === 'string' && paneTabId.length > 0, 'Watch pane identity is missing after daemon restart')
        const paneState = await c.call<{ tabs: PaneTab[] }>('pane state', { worktree: `id:${c.world.worktreeA}` }, '')
        c.assert(paneState.tabs.some(tab => tab.id === paneTabId && tab.page === c.state.pageA && tab.profileId === c.state.profileA && tab.mode === 'watch'), 'Watch pane did not reconnect to page A after daemon restart')
        const pageCssSize = await c.observe<PageCssSize>('({ width: window.innerWidth, height: window.innerHeight })', c.state.pageA)
        const postRestartBefore = await waitForWatchSample(renderer.page, pageCssSize, isRedSample, 'red Watch marker after daemon restart', c)
        const identityAfterRestart = await c.call<WatchState>('identity get', {}, '')
        c.assert(identityAfterRestart.mode === 'native' && identityAfterRestart.active === 'native' && !identityAfterRestart.restartRequired, 'native browser identity did not activate after daemon restart')
        const userAgentAfterRestart = await c.observe<string>('navigator.userAgent', c.state.pageA)
        assertUserAgent(c, userAgentAfterRestart, 'native')
        await c.call('click', { element: '#watch-marker' }, c.state.pageA)
        const afterClick = await c.observe<{ title: string; state: string | null }>(
          '({ title: document.title, state: document.querySelector("#watch-marker")?.getAttribute("data-state") ?? null })',
          c.state.pageA
        )
        c.equal(afterClick, { title: 'CLI changed', state: 'green' }, 'CLI click did not change page A after daemon restart')
        const worktreeBMarkerAfter = await c.observe<string | null>('document.querySelector("#watch-marker")?.getAttribute("data-state") ?? null', c.state.pageB)
        c.equal(worktreeBMarkerAfter, 'red', 'CLI click in worktree A changed worktree B marker')
        const postRestartAfter = await waitForWatchSample(renderer.page, pageCssSize,
          sample => isGreenSample(sample) && sample.digest !== postRestartBefore.digest,
          'new green Watch frame after daemon restart', c)
        await waitForRendererAddress(renderer, `${c.world.fixture.origin}/watch-page`, c)
        const restartOutcome = {
          previousPid: restarted.previousPid,
          daemonPid: restarted.daemonPid,
          pageA: c.state.pageA,
          pageB: c.state.pageB,
          profileA: c.state.profileA,
          profileB: c.state.profileB,
          localStorageA: localA.value,
          cookieA,
          localStorageB: localB.value,
          cookiesB: cookiesB.cookies,
          identityAfterRestart
        }
        verifyWatchAndRestartOutcome({ watch: { beforeSample: postRestartBefore, afterSample: postRestartAfter }, restart: restartOutcome })
        c.state.identityAfterRestart = identityAfterRestart
        c.state.userAgentAfterRestart = userAgentAfterRestart
        c.state.paneRestartEvidence = restartOutcome
        return {
          ...restartOutcome,
          cookieA: cookieA ?? null,
          cookieCountB,
          worktreeBMarkerBefore,
          worktreeBMarkerAfter,
          postRestartBefore,
          postRestartAfter
        }
      } finally {
        await renderer.close()
        if (c.state.watchRenderer === renderer) delete c.state.watchRenderer
      }
    }
  },
  {
    id: 'browser-identity-set-activation-after-restart',
    async run(c) {
      let identityBeforeRestart = c.state.identityBeforeRestart
      let identityAfterRestart = c.state.identityAfterRestart
      let userAgentBeforeRestart = c.state.userAgentBeforeRestart
      let userAgentAfterRestart = c.state.userAgentAfterRestart
      if (!isIdentityState(identityBeforeRestart) || !isIdentityState(identityAfterRestart) ||
        typeof userAgentBeforeRestart !== 'string' || typeof userAgentAfterRestart !== 'string') {
        await ensurePaneTargets(c)
        await c.call('goto', { url: `${c.world.fixture.origin}/watch-page` }, c.state.pageA)
        await stageNativeIdentity(c)
        const activated = await activateNativeIdentity(c)
        identityBeforeRestart = c.state.identityBeforeRestart
        identityAfterRestart = activated.identity
        userAgentBeforeRestart = c.state.userAgentBeforeRestart
        userAgentAfterRestart = activated.userAgent
      }
      if (!isIdentityState(identityBeforeRestart) || !isIdentityState(identityAfterRestart) ||
        typeof userAgentBeforeRestart !== 'string' || typeof userAgentAfterRestart !== 'string') {
        throw new BrowserFailure('restart-lost-profile', 'Browser identity evidence is incomplete across daemon restart')
      }
      assertIdentityState(c, identityBeforeRestart, { mode: 'native', active: 'clean', restartRequired: true }, 'identity stage before restart')
      assertIdentityState(c, identityAfterRestart, { mode: 'native', active: 'native', restartRequired: false }, 'identity activation after restart')
      assertUserAgent(c, userAgentBeforeRestart, 'clean')
      assertUserAgent(c, userAgentAfterRestart, 'native')
      const restored = await c.call<WatchState>('identity set', { mode: 'clean' }, '')
      c.assert(restored.mode === 'clean', 'browser identity mode did not restore to clean')
      c.state.identityNeedsRestore = false
      c.state.identityRestored = true
      const shimLogs = readShimLogs(c.world.home)
      verifyWatchAndRestartOutcome({ shimLogs })
      c.assert(shimLogs.orcaLog === '' && shimLogs.securityLog === '', 'browser identity invoked an Orca or security shim')
      return {
        beforeRestart: identityBeforeRestart,
        afterRestart: identityAfterRestart,
        userAgentBeforeRestart,
        userAgentAfterRestart,
        restoredMode: restored.mode
      }
    }
  }
]
