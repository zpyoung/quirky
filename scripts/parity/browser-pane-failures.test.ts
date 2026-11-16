import { expect, jest, test } from 'bun:test'
import { chromium, type BrowserServer, type Page } from 'playwright'
import { BrowserFailure, type BrowserWorld } from './browser-world'
import { isGreenSample, isRedSample, openWatchRenderer, sampleWatchMarker, verifyWatchAndRestartOutcome, waitForWatchImage, waitForWatchSample, type WatchPixelSample } from './browser-pane'

const clock = jest as typeof jest & {
  advanceTimersByTime(milliseconds: number): void
}

type Outcome = {
  watch?: { beforeSample: WatchPixelSample | null; afterSample: WatchPixelSample | null }
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
    identityAfterRestart?: { active?: string }
  }
  shimLogs?: { empty: boolean; bytes: Record<string, number>; orcaLog: string; securityLog: string }
}

const red: WatchPixelSample = { r: 220, g: 30, b: 30, digest: 'red-frame', naturalWidth: 800, naturalHeight: 600, sampleX: 120, sampleY: 80 }
const green: WatchPixelSample = { r: 20, g: 210, b: 50, digest: 'green-frame', naturalWidth: 800, naturalHeight: 600, sampleX: 120, sampleY: 80 }

function validOutcome(): Outcome {
  return {
    watch: { beforeSample: red, afterSample: green },
    restart: {
      previousPid: 101,
      daemonPid: 202,
      pageA: 'page-a',
      pageB: 'page-b',
      profileA: 'profile-a',
      profileB: 'profile-b',
      localStorageA: 'local-restart',
      cookieA: 'cookie-restart',
      localStorageB: null,
      cookiesB: [],
      identityAfterRestart: { active: 'native' }
    },
    shimLogs: { empty: true, bytes: { orca: 0, security: 0 }, orcaLog: '', securityLog: '' }
  }
}

function expectFailure(outcome: Outcome, kind: string): void {
  let failure: unknown
  try {
    verifyWatchAndRestartOutcome(outcome)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(BrowserFailure)
  expect(failure).toMatchObject({ kind })
}

function rendererWorld(track: (pid: number) => void): BrowserWorld {
  return {
    home: '/owned/home',
    env: { QUIRKY_BROWSER_CHROME: process.execPath },
    fixture: { origin: 'http://127.0.0.1:1234', startedAt: 0, requests: [], dialogCount: 0, waitForDialog: async () => {}, waitForGate: async () => {}, releaseGate: () => {}, stop: async () => {} },
    worktreeA: 'worktree-a',
    worktreeB: 'worktree-b',
    daemonPid: 1,
    track,
    cli: async () => ({ argv: [], result: {}, exitCode: 0, stderrTail: '' }),
    cleanup: async () => ({ ok: true }),
    processEvidence: async () => ({})
  } as unknown as BrowserWorld
}

test('pixel predicates enforce the strict red and green channel thresholds', () => {
  expect(isRedSample({ ...red, r: 181, g: 79, b: 79 })).toBe(true)
  expect(isRedSample({ ...red, r: 180 })).toBe(false)
  expect(isRedSample({ ...red, g: 80 })).toBe(false)
  expect(isGreenSample({ ...green, g: 181, r: 79, b: 79 })).toBe(true)
  expect(isGreenSample({ ...green, g: 180 })).toBe(false)
  expect(isGreenSample({ ...green, r: 80 })).toBe(false)
})

test('canvas samples the mapped 5 by 5 block and averages all pixels', async () => {
  const image = { src: 'data:image/jpeg;base64,AAAA', complete: true, naturalWidth: 1200, naturalHeight: 900 }
  const pixels = new Uint8ClampedArray(25 * 4)
  for (let index = 0; index < 25; index++) {
    pixels[index * 4] = 180 + index
    pixels[index * 4 + 1] = 10 + index
    pixels[index * 4 + 2] = 30 + index
    pixels[index * 4 + 3] = 255
  }
  let canvasWidth = 0
  let canvasHeight = 0
  let sampleRect: number[] = []
  const context = {
    drawImage: (source: unknown) => expect(source).toBe(image),
    getImageData: (x: number, y: number, width: number, height: number) => {
      sampleRect = [x, y, width, height]
      return { data: pixels }
    }
  }
  const canvas = {
    set width(value: number) { canvasWidth = value },
    get width() { return canvasWidth },
    set height(value: number) { canvasHeight = value },
    get height() { return canvasHeight },
    getContext: () => context
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } })
  const page = {
    locator: (selector: string) => {
      expect(selector).toBe('.qbp[data-browser-pane="pane-fixture"] .qbp-watch-image')
      return { evaluate: (operation: (element: HTMLImageElement, size: { width: number; height: number }) => unknown, size: { width: number; height: number }) => operation(image as unknown as HTMLImageElement, size) }
    }
  } as unknown as Page
  try {
    const sample = await sampleWatchMarker(page, { width: 800, height: 600 }, { paneId: 'pane-fixture' })
    expect([canvasWidth, canvasHeight, ...sampleRect]).toEqual([1200, 900, 178, 118, 5, 5])
    expect(sample).toMatchObject({ r: 192, g: 22, b: 42, naturalWidth: 1200, naturalHeight: 900, sampleX: 180, sampleY: 120 })
    expect(sample.digest).toBeTruthy()
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('a missing Watch image is classified as wrong-page', async () => {
  const page = { locator: () => ({ evaluate: async () => { throw new Error('image did not render') } }) } as unknown as Page
  await expect(sampleWatchMarker(page, { width: 800, height: 600 }, { paneId: 'pane-fixture' })).rejects.toMatchObject({ kind: 'wrong-page' })
})

test('a frame window reports its last observed color and image state', async () => {
  const page = {
    locator: () => ({ evaluate: async () => green }),
    evaluate: async () => ({ imageCount: 1, pageLabel: 'Watched page: fixture' })
  } as unknown as Page
  const failure = await waitForWatchSample(page, 'pane-fixture', { width: 800, height: 600 }, isRedSample, 'red marker', {
    signal: new AbortController().signal, deadline: Date.now() + 5_000
  }, Date.now() + 20).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(BrowserFailure)
  if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
  expect(failure.kind).toBe('wrong-page')
  expect(failure.message).toContain('"digest":"green-frame"')
  expect(failure.message).toContain('"g":210')
  expect(failure.message).toContain('"imageCount":1')
})

test('an expired frame window preserves the missing-image error instead of escaping as deadline', async () => {
  const page = {
    locator: () => ({ evaluate: async () => { throw new BrowserFailure('deadline', 'Watch frame sample deadline reached: fixture image missing') } }),
    evaluate: async () => ({ imageCount: 0, pageLabel: null })
  } as unknown as Page
  const failure = await waitForWatchSample(page, 'pane-fixture', { width: 800, height: 600 }, isRedSample, 'red marker', {
    signal: new AbortController().signal, deadline: Date.now() + 5_000
  }, Date.now() + 20).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(BrowserFailure)
  if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
  expect(failure.kind).toBe('wrong-page')
  expect(failure.message).toContain('fixture image missing')
  expect(failure.message).toContain('"imageCount":0')
})

test('a frame probe preserves a page error that explains the missing sample', async () => {
  const page = {
    locator: () => ({ evaluate: async () => { throw new Error('fixture Watch image could not decode') } }),
    evaluate: async () => ({ imageCount: 1, pageLabel: 'Watched page: fixture' })
  } as unknown as Page
  const failure = await waitForWatchSample(page, 'pane-fixture', { width: 800, height: 600 }, isRedSample, 'red marker', {
    signal: new AbortController().signal, deadline: Date.now() + 5_000
  }, Date.now() + 20).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(BrowserFailure)
  if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
  expect(failure.kind).toBe('wrong-page')
  expect(failure.message).toContain('fixture Watch image could not decode')
})

test('global cancellation remains a deadline rather than a frame-window failure', async () => {
  const controller = new AbortController()
  controller.abort(new BrowserFailure('deadline', 'fixture run interrupted'))
  const page = { locator: () => ({ evaluate: async () => red }) } as unknown as Page
  await expect(waitForWatchSample(page, 'pane-fixture', { width: 800, height: 600 }, isRedSample, 'red marker', {
    signal: controller.signal, deadline: Date.now() + 5_000
  }, Date.now() + 20)).rejects.toMatchObject({ kind: 'deadline', message: 'fixture run interrupted' })
})

test('a visible plugin activation error refuses a missing Watch pane immediately with the banner text', async () => {
  const text = 'quirky.terminal failed to activate: activation timed out'
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  const banner = { textContent: text, getClientRects: () => [{}] }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelectorAll: () => [banner], querySelector: () => null
  } })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ display: 'block', visibility: 'visible' }) })
  const diagnosticsStarted = Promise.withResolvers<void>()
  const diagnosticResponse = Promise.withResolvers<unknown>()
  const page = {
    waitForFunction: async (predicate: (id: string) => unknown, id: string) => ({
      jsonValue: async () => predicate(id), dispose: async () => {}
    }),
    evaluate: () => { diagnosticsStarted.resolve(); return diagnosticResponse.promise },
    locator: () => { throw new Error('must reject activation before trying to decode an absent image') }
  } as unknown as Page
  const pending = waitForWatchImage(page, 'pane-fixture', {
    signal: new AbortController().signal, deadline: Date.now() + 5_000
  }).catch((error: unknown) => error)
  try {
    const observed = await Promise.race([
      pending.then(failure => ({ status: 'failed' as const, failure })),
      diagnosticsStarted.promise.then(() => ({ status: 'waiting-for-diagnostics' as const }))
    ])
    expect(observed.status).toBe('failed')
    if (observed.status !== 'failed') throw new Error('activation error waited for diagnostics')
    const failure = observed.failure
    expect(failure).toBeInstanceOf(BrowserFailure)
    if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
    expect(failure.kind).toBe('wrong-page')
    expect(failure.message).toContain(text)
    expect(failure.message).not.toContain('Watch pane mount deadline reached')
  } finally {
    diagnosticResponse.resolve({ renderedPanes: [], banners: [text] })
    await pending
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousStyle) Object.defineProperty(globalThis, 'getComputedStyle', previousStyle)
    else Reflect.deleteProperty(globalThis, 'getComputedStyle')
  }
})

test('frame failure diagnostics retain a slow renderer response instead of a one-second timeout', async () => {
  clock.useFakeTimers()
  const text = 'quirky.terminal failed to activate: activation timed out'
  const diagnosisStarted = Promise.withResolvers<void>()
  const response = Promise.withResolvers<{ renderedPanes: string[]; banners: string[] }>()
  const page = {
    locator: () => ({ evaluate: async () => { throw new BrowserFailure('deadline', 'Watch sample window exhausted') } }),
    evaluate: () => { diagnosisStarted.resolve(); return response.promise }
  } as unknown as Page
  try {
    const pending = waitForWatchSample(page, 'pane-fixture', { width: 800, height: 600 }, isRedSample, 'red marker', {
      signal: new AbortController().signal, deadline: Date.now() + 10_000
    }, Date.now() + 20).catch((error: unknown) => error)
    await diagnosisStarted.promise
    clock.advanceTimersByTime(1_100)
    response.resolve({ renderedPanes: [], banners: [text] })
    const failure = await pending
    expect(failure).toBeInstanceOf(BrowserFailure)
    if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
    expect(failure.kind).toBe('wrong-page')
    expect(failure.message).toContain(text)
    expect(failure.message).not.toContain('Watch failure diagnostics deadline reached')
  } finally {
    response.resolve({ renderedPanes: [], banners: [text] })
    clock.useRealTimers()
  }
})

test('a renderer connection failure still tracks its pid and closes the server', async () => {
  const tracked: number[] = []
  let closeCalls = 0
  const server = {
    process: () => ({ pid: 7341 }),
    wsEndpoint: () => 'ws://127.0.0.1:1',
    close: async () => { closeCalls++ }
  } as unknown as BrowserServer
  const launchServer: typeof chromium.launchServer = async () => server
  let failure: unknown
  try {
    await openWatchRenderer(rendererWorld(pid => tracked.push(pid)), { launchServer })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(BrowserFailure)
  expect(['wrong-page', 'deadline']).toContain((failure as BrowserFailure).kind)
  expect(tracked).toEqual([7341])
  expect(closeCalls).toBe(1)
})
test('a renderer launch resolving after cancellation is tracked and closed', async () => {
  const abort = new AbortController()
  const launchStarted = Promise.withResolvers<void>()
  const launchResult = Promise.withResolvers<BrowserServer>()
  const closeReceipt = Promise.withResolvers<void>()
  const tracked: number[] = []
  let closeCalls = 0
  const server = {
    process: () => ({ pid: 7342 }),
    wsEndpoint: () => 'ws://127.0.0.1:1',
    close: async () => {
      closeCalls++
      closeReceipt.resolve()
    }
  } as unknown as BrowserServer
  const launchServer: typeof chromium.launchServer = () => {
    launchStarted.resolve()
    return launchResult.promise
  }
  const opening = openWatchRenderer(rendererWorld(pid => tracked.push(pid)), {
    launchServer,
    signal: abort.signal,
    deadline: Date.now() + 5_000
  })

  await launchStarted.promise
  abort.abort(new BrowserFailure('deadline', 'Watch pane renderer launch deadline reached'))
  await expect(opening).rejects.toMatchObject({ kind: 'deadline' })

  launchResult.resolve(server)
  await closeReceipt.promise

  expect(closeCalls).toBe(1)
  expect(tracked).toEqual([7342])
})

test('Watch validation rejects an unrendered frame, an unchanged digest, or a non-green click', () => {
  expectFailure({ watch: { beforeSample: null, afterSample: green } }, 'wrong-page')
  const unchanged = validOutcome()
  unchanged.watch!.afterSample = { ...green, digest: red.digest }
  expectFailure(unchanged, 'wrong-page')
  const stillRed = validOutcome()
  stillRed.watch!.afterSample = { ...red, digest: 'different-frame' }
  expectFailure(stillRed, 'wrong-page')
})

for (const [condition, change] of [
  ['localStorage A', { localStorageA: null }],
  ['cookie A', { cookieA: null }],
  ['localStorage leaked into B', { localStorageB: 'local-restart' }],
  ['cookie leaked into B', { cookiesB: [{ name: 'restart', value: 'cookie-restart' }] }],
  ['daemon pid did not change', { daemonPid: 101 }],
  ['page A is missing', { pageA: '' }],
  ['page B is missing', { pageB: '' }],
  ['profile A is missing', { profileA: '' }],
  ['profile B is missing', { profileB: '' }],
  ['identity did not activate', { identityAfterRestart: { active: 'clean' } }]
] as const) {
  test(`restart validation rejects ${condition}`, () => {
    const outcome = validOutcome()
    outcome.restart = { ...outcome.restart, ...change }
    expectFailure(outcome, 'restart-lost-profile')
  })
}

for (const [command, field] of [['orca', 'orcaLog'], ['security', 'securityLog']] as const) {
  test(`shim validation rejects a non-empty ${command} log`, () => {
    const outcome = validOutcome()
    outcome.shimLogs = { ...outcome.shimLogs!, [field]: `${command} invoked` }
    expectFailure(outcome, 'shim-invoked')
  })
}

test('readiness-handle disposal cannot replace an observed activation error', async () => {
  const text = 'quirky.terminal failed to activate: activation timed out'
  const disposalStarted = Promise.withResolvers<void>()
  const disposal = Promise.withResolvers<void>()
  const page = {
    waitForFunction: async () => ({
      jsonValue: async () => ({ activationError: text }),
      dispose: () => { disposalStarted.resolve(); return disposal.promise }
    }),
    evaluate: async () => ({ renderedPanes: [] })
  } as unknown as Page
  const pending = waitForWatchImage(page, 'pane-fixture', {
    signal: new AbortController().signal, deadline: Date.now() + 5_000
  }).catch((error: unknown) => error)
  await disposalStarted.promise
  disposal.reject(new Error('renderer closed during handle disposal'))
  const failure = await pending
  expect(failure).toBeInstanceOf(BrowserFailure)
  if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
  expect(failure.kind).toBe('wrong-page')
  expect(failure.message).toContain(text)
  expect(failure.message).not.toContain('renderer closed during handle disposal')
})

test('readiness serialization is bounded even when the renderer replies after the startup window', async () => {
  clock.useFakeTimers()
  const serializationStarted = Promise.withResolvers<void>()
  const response = Promise.withResolvers<{ ready: true }>()
  const page = {
    waitForFunction: async () => ({
      jsonValue: () => { serializationStarted.resolve(); return response.promise },
      dispose: async () => {}
    }),
    evaluate: async () => ({ renderedPanes: [] })
  } as unknown as Page
  try {
    const pending = waitForWatchImage(page, 'pane-fixture', {
      signal: new AbortController().signal, deadline: Date.now() + 60_000
    }).catch((error: unknown) => error)
    await serializationStarted.promise
    clock.advanceTimersByTime(30_001)
    response.resolve({ ready: true })
    const failure = await pending
    expect(failure).toBeInstanceOf(BrowserFailure)
    if (!(failure instanceof BrowserFailure)) throw new Error('expected a Watch failure')
    expect(failure.kind).toBe('wrong-page')
    expect(failure.message).toContain('Watch readiness details deadline reached')
  } finally {
    response.resolve({ ready: true })
    clock.useRealTimers()
  }
})
