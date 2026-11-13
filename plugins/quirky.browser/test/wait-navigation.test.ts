import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { spansNavigation } from '../src/runtime/actions'
import { BROWSER_METHODS } from '../src/runtime/catalog'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
type Fixture = { baseUrl: string; stop(): void }
type WaitSignal = { promise: Promise<void>; resolve(): void }

const call = (h: BrowserTestHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${method}`, params)

function startNavigationFixture(): Fixture {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/a') return html('<!doctype html><title>A</title><a id="go" href="/b">Go</a>')
      if (path === '/b') return html('<!doctype html><title>B</title><h1>Bee</h1><button id="late">Late</button>')
      return new Response('not found', { status: 404 })
    }
  })
  return { baseUrl: server.url.href, stop: () => server.stop(true) }
}

async function withFixtureHarness(
  operation: (h: BrowserTestHarness, baseUrl: string) => Promise<void>,
  overrides: Parameters<typeof startBrowserHarness>[0] = {}
): Promise<void> {
  const fixture = startNavigationFixture()
  let h: BrowserTestHarness | undefined
  try {
    h = await startBrowserHarness(overrides)
    await operation(h, fixture.baseUrl)
  } finally {
    try {
      if (h) await h.cleanup()
    } finally {
      fixture.stop()
    }
  }
}

function route(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).href
}

async function newPage(h: BrowserTestHarness, baseUrl: string, path = '/a') {
  return await call(h, 'tabCreate', { url: route(baseUrl, path) }) as { browserPageId: string }
}

// Chrome runs in a separate process, so fake test timers cannot schedule its navigation.
async function scheduleNavigation(h: BrowserTestHarness, pageId: string, path = '/b'): Promise<void> {
  await call(h, 'eval', {
    page: pageId,
    expression: `setTimeout(() => { location.href = ${JSON.stringify(path)} }, 600); 1`
  })
}

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

function rejectionMessage<T>(outcome: Outcome<T>): string {
  expect(outcome.status).toBe('rejected')
  return outcome.status === 'rejected'
    ? outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
    : ''
}

function deferred(): WaitSignal {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

async function signalBefore(signal: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = deferred()
  const timer = setTimeout(() => timeout.resolve(), timeoutMs)
  try {
    return await Promise.race([signal.then(() => true), timeout.promise.then(() => false)])
  } finally {
    clearTimeout(timer)
  }
}

async function runBrowserCli(h: BrowserTestHarness, argv: string[]) {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used' })
  })
  return { code, stdout, stderr }
}

test('wait conditions survive cross-document and same-document navigation (scenarios 1-7)', async () => {
  await withFixtureHarness(async (h, baseUrl) => {
    const pageId = (await newPage(h, baseUrl)).browserPageId
    const outcomes: Record<string, Outcome<unknown>> = {}
    const wait = async (name: string, params: Record<string, unknown>) => {
      outcomes[name] = await settle(call(h, 'wait', { page: pageId, timeout: 8_000, ...params }))
    }

    await scheduleNavigation(h, pageId)
    const urlStarted = performance.now()
    await wait('url', { url: '/b' })
    expect(performance.now() - urlStarted).toBeLessThan(8_000)
    expect(await call(h, 'eval', { page: pageId, expression: 'location.pathname' })).toEqual({ value: '/b' })

    await call(h, 'goto', { page: pageId, url: route(baseUrl, '/a') })
    await call(h, 'eval', {
      page: pageId,
      expression: "setTimeout(() => { location.hash = '#done' }, 600); 1"
    })
    await wait('hash', { url: '#done' })

    await call(h, 'eval', {
      page: pageId,
      expression: "setTimeout(() => { history.pushState({}, '', '/pushed') }, 600); 1"
    })
    await wait('pushState', { url: '/pushed' })

    for (const [name, condition] of Object.entries({
      text: { text: 'Bee' },
      fn: { fn: 'document.title === "B"' },
      selector: { selector: '#late' }
    })) {
      await call(h, 'goto', { page: pageId, url: route(baseUrl, '/a') })
      await scheduleNavigation(h, pageId)
      await wait(name, condition)
    }

    await call(h, 'goto', { page: pageId, url: route(baseUrl, '/a') })
    await scheduleNavigation(h, pageId)
    // This integration case measures the browser helper's real timeout across navigation.
    const timeoutStarted = performance.now()
    await wait('timeout', { timeout: 1_500 })
    expect(performance.now() - timeoutStarted).toBeGreaterThanOrEqual(1_500)

    await call(h, 'goto', { page: pageId, url: route(baseUrl, '/a') })
    await scheduleNavigation(h, pageId)
    await wait('networkidle', { load: 'networkidle', timeout: 5_000 })

    await call(h, 'goto', { page: pageId, url: route(baseUrl, '/a') })
    expect(await call(h, 'click', { page: pageId, element: '#go' })).toMatchObject({ clicked: '#go' })
    await wait('afterClick', { url: '/b' })

    await call(h, 'goto', { page: pageId, url: route(baseUrl, '/a') })
    await scheduleNavigation(h, pageId)
    const firstWait = settle(call(h, 'wait', { page: pageId, timeout: 1_500 }))
    const queuedWait = settle(call(h, 'wait', { page: pageId, url: '/b', timeout: 5_000 }))
    const [firstOutcome, queuedOutcome] = await Promise.all([firstWait, queuedWait])
    outcomes.firstWait = firstOutcome
    outcomes.queuedWait = queuedOutcome
    expect(outcomes).toEqual(Object.fromEntries(
      ['url', 'hash', 'pushState', 'text', 'fn', 'selector', 'timeout', 'networkidle', 'afterClick', 'firstWait', 'queuedWait']
        .map((name) => [name, { status: 'fulfilled', value: { waited: true } }])
    ))
  })
}, 90_000)

test('CLI and exec wait forms survive navigation (scenario 8)', async () => {
  await withFixtureHarness(async (h, baseUrl) => {
    const cliPage = (await newPage(h, baseUrl)).browserPageId
    await scheduleNavigation(h, cliPage)
    const cliResult = await runBrowserCli(h, [
      'browser', 'wait', '--page', cliPage, '--url', '/b', '--timeout', '8000', '--json'
    ])
    const execPage = (await newPage(h, baseUrl)).browserPageId
    await scheduleNavigation(h, execPage)
    const execResult = await settle(call(h, 'exec', {
      page: execPage,
      command: 'wait --url /b --timeout 8000'
    }))
    expect({ cli: cliResult, exec: execResult }).toEqual({
      cli: { code: 0, stdout: expect.stringContaining('"waited"'), stderr: '' },
      exec: { status: 'fulfilled', value: expect.objectContaining({ result: { waited: true } }) }
    })
    expect(JSON.parse(cliResult.stdout)).toEqual({ waited: true })
  })
}, 90_000)

test('wait refusals retain timeout, close, profile, lost-browser, and snapshot guards (scenarios 10-15)', async () => {
  const startedWaits = new Map<string, WaitSignal>()
  let crashHelper: ((profileId: string) => Promise<void>) | undefined
  await withFixtureHarness(async (h, baseUrl) => {
    const pageId = (await newPage(h, baseUrl)).browserPageId

    await scheduleNavigation(h, pageId)
    const notSatisfied = settle(call(h, 'wait', { page: pageId, url: '/zzz', timeout: 2_000 }))
    expect(rejectionMessage(await notSatisfied)).toBe('browser_timeout: wait timed out')

    const { outcome: waitOnClosedPage } = await startPendingWait(h, pageId, startedWaits)
    await call(h, 'tabClose', { page: pageId, yes: true })
    expect(rejectionMessage(await waitOnClosedPage)).toMatch(/^browser_tab_closed/)

    const profilePage = (await newPage(h, baseUrl)).browserPageId
    const profile = await call(h, 'profileCreate', { name: 'Wait navigation target' }) as { profile: { id: string } }
    const { outcome: waitOnChangingPage } = await startPendingWait(h, profilePage, startedWaits)
    await call(h, 'tabProfileSet', { page: profilePage, profile: profile.profile.id })
    expect(rejectionMessage(await waitOnChangingPage))
      .toBe('browser_tab_changed: the managed page changed browser profiles during the operation')

    const lostPage = (await newPage(h, baseUrl)).browserPageId
    const { outcome: waitOnLostBrowser } = await startPendingWait(h, lostPage, startedWaits)
    expect(crashHelper).toBeDefined()
    if (!crashHelper) throw new Error('browser test control was not provided')
    await crashHelper('default')
    const lostOutcome = await waitOnLostBrowser
    expect(lostOutcome.status).toBe('rejected')
    if (lostOutcome.status === 'rejected') {
      const message = lostOutcome.reason instanceof Error ? lostOutcome.reason.message : String(lostOutcome.reason)
      expect(message).not.toBe('browser_timeout: wait timed out')
    }

    const stalePage = (await newPage(h, baseUrl)).browserPageId
    const staleSnapshot = await call(h, 'snapshot', { page: stalePage }) as { refs: Array<{ ref: string }> }
    const oldRef = staleSnapshot.refs.find(({ ref }) => ref.startsWith('qbr1:'))?.ref
    expect(oldRef).toBeDefined()
    await call(h, 'goto', { page: stalePage, url: route(baseUrl, '/b') })
    const staleWait = settle(call(h, 'wait', { page: stalePage, selector: oldRef!, timeout: 2_000 }))
    expect(rejectionMessage(await staleWait))
      .toBe('browser_stale_ref: snapshot reference is stale or belongs to another page')

    const refPage = (await newPage(h, baseUrl)).browserPageId
    const freshSnapshot = await call(h, 'snapshot', { page: refPage }) as { refs: Array<{ ref: string }> }
    const freshRef = freshSnapshot.refs.find(({ ref }) => ref.startsWith('qbr1:'))?.ref
    expect(freshRef).toBeDefined()
    await scheduleNavigation(h, refPage)
    const refWait = settle(call(h, 'wait', {
      page: refPage,
      selector: freshRef!,
      state: 'hidden',
      timeout: 3_000
    }))
    expect(rejectionMessage(await refWait)).toBe('browser_timeout: wait timed out')
  }, {
    onOperation: (event) => {
      if (event.method === 'wait') startedWaits.get(event.pageId)?.resolve()
    },
    onControl: (control) => { crashHelper = control.crashHelper }
  })
}, 90_000)

async function startPendingWait(
  h: BrowserTestHarness,
  pageId: string,
  startedWaits: Map<string, WaitSignal>
): Promise<{ outcome: Promise<Outcome<unknown>> }> {
  const started = deferred()
  startedWaits.set(pageId, started)
  const outcome = settle(call(h, 'wait', { page: pageId, url: '/never', timeout: 8_000 }))
  const didStart = await signalBefore(started.promise, 5_000)
  startedWaits.delete(pageId)
  expect(didStart).toBe(true)
  return { outcome }
}

test('eval queued behind a wait keeps the navigation guard (scenario 16)', async () => {
  await withFixtureHarness(async (h, baseUrl) => {
    const pageId = (await newPage(h, baseUrl)).browserPageId
    await scheduleNavigation(h, pageId)

    const waitOutcome = settle(call(h, 'wait', { page: pageId, timeout: 1_500 }))
    const evalOutcome = settle(call(h, 'eval', { page: pageId, expression: '1 + 1' }))
    const [waitResult, evalResult] = await Promise.all([waitOutcome, evalOutcome])
    expect(waitResult.status).toBe('fulfilled')
    if (waitResult.status === 'fulfilled') expect(waitResult.value).toEqual({ waited: true })
    expect(rejectionMessage(evalResult))
      .toBe('browser_tab_changed: the managed page changed before the operation ran')
  })
}, 90_000)

test('spansNavigation is true only for waits without snapshot references', () => {
  expect(spansNavigation('wait', {})).toBe(true)
  expect(spansNavigation('wait', { selector: '#late' })).toBe(true)
  expect(spansNavigation('wait', { selector: '' })).toBe(true)
  expect(spansNavigation('wait', { selector: 'qbr1:page:1' })).toBe(false)
  expect(spansNavigation('wait', { selector: null })).toBe(false)
  expect(spansNavigation('wait', { selector: 42 })).toBe(false)

  for (const method of BROWSER_METHODS) {
    if (method === 'wait') continue
    expect(spansNavigation(method, {})).toBe(false)
    expect(spansNavigation(method, { selector: '#late' })).toBe(false)
  }
})
