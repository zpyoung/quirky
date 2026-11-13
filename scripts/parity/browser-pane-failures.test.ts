import { expect, test } from 'bun:test'
import { chromium, type BrowserServer, type Page } from 'playwright'
import { BrowserFailure, type BrowserWorld } from './browser-world'
import { isGreenSample, isRedSample, openWatchRenderer, sampleWatchMarker, verifyWatchAndRestartOutcome, type WatchPixelSample } from './browser-pane'

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
      expect(selector).toBe('.qbp-watch-image')
      return { evaluate: (operation: (element: HTMLImageElement, size: { width: number; height: number }) => unknown, size: { width: number; height: number }) => operation(image as unknown as HTMLImageElement, size) }
    }
  } as unknown as Page
  try {
    const sample = await sampleWatchMarker(page, { width: 800, height: 600 })
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
  await expect(sampleWatchMarker(page, { width: 800, height: 600 })).rejects.toMatchObject({ kind: 'wrong-page' })
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


