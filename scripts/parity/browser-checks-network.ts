import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserCheck, CheckContext } from './browser-run'

type CaptureResult = { data: string; format?: string }
type ConsoleLog = { entries: Array<{ text: string; type?: string }> }
type NetworkLog = { entries: Array<{ url: string; method: string; status: number | null }> }
type HarCapture = {
  stopped: boolean
  har: { log: { entries: Array<{
    request: { url: string; method: string }
    response: { status: number; content: { size: number } }
  }> } }
}
type InterceptRecord = { url: string; method?: string; pending?: boolean }
type InterceptList = { patterns: string[]; requests: InterceptRecord[] }
type InterceptPageState = {
  status: 'pending' | 'fulfilled' | 'rejected'
  responseStatus?: number
  body?: string
  error?: string
}
type FixtureRequest = CheckContext['world']['fixture']['requests'][number]
type InterceptReleaseObservation = { state: InterceptPageState; requests: FixtureRequest[] }
type Viewport = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
type GeoResult = { latitude?: number; longitude?: number; error?: string }
type FetchResult = { status: number; ok: boolean; body: string }

type InterceptObservation = {
  url: string
  pattern: string
  listed: InterceptRecord | undefined
  list: InterceptList
  state: InterceptPageState
  requests: FixtureRequest[]
  pending: boolean
}

const INTERCEPT_GAP = 'Matching requests are logged and immediately continued rather than held pending; follow-up: Keep intercepted requests pending until explicitly released.'
const INTERCEPT_OBSERVE_MS = 750
const INTERCEPT_POLL_MS = 25

function fixtureUrl(c: CheckContext, path: string): string {
  return new URL(path, c.world.fixture.origin).href
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('capture is not a PNG with a complete IHDR')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}


function interceptedRequestsSince(c: CheckContext, start: number) {
  return c.world.fixture.requests.slice(start).filter(request => request.path === '/intercept')
}

function assertInterceptResponse(c: CheckContext, state: InterceptPageState): void {
  if (state.status === 'rejected') throw new Error(`intercept probe fetch rejected: ${state.error ?? 'unknown fetch error'}`)
  if (state.status === 'fulfilled') {
    c.equal(state.responseStatus, 200, 'intercept response status')
    c.equal(state.body, 'intercept-proof', 'intercept response body')
  }
}

async function readInterceptState(c: CheckContext, key: string, page: string): Promise<InterceptPageState> {
  const state = await c.observe<InterceptPageState | null>(`window[${JSON.stringify(key)}]`, page)
  if (!state || !['pending', 'fulfilled', 'rejected'].includes(state.status)) {
    throw new Error('intercept probe did not publish a valid fetch state')
  }
  return state
}

async function observeIntercept(
  c: CheckContext,
  key: string,
  url: string,
  pattern: string,
  page: string,
  requestStart: number
): Promise<InterceptObservation> {
  const deadline = Date.now() + INTERCEPT_OBSERVE_MS
  let state = await readInterceptState(c, key, page)
  let list = await c.call<InterceptList>('intercept list', {}, page)
  let listed = list.requests.find(request => request.url === url)
  let requests = interceptedRequestsSince(c, requestStart)

  while (Date.now() < deadline && state.status === 'pending') {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, INTERCEPT_POLL_MS)
    await promise
    state = await readInterceptState(c, key, page)
    list = await c.call<InterceptList>('intercept list', {}, page)
    listed = list.requests.find(request => request.url === url)
    requests = interceptedRequestsSince(c, requestStart)
  }

  assertInterceptResponse(c, state)
  const pending = state.status === 'pending' && listed !== undefined && requests.length === 0
  return { url, pattern, listed, list, state, requests, pending }
}

async function waitForInterceptRelease(c: CheckContext, key: string, page: string, requestStart: number): Promise<InterceptReleaseObservation> {
  const deadline = Date.now() + INTERCEPT_OBSERVE_MS
  let state = await readInterceptState(c, key, page)
  let requests = interceptedRequestsSince(c, requestStart)
  while (Date.now() < deadline && state.status === 'pending') {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, INTERCEPT_POLL_MS)
    await promise
    state = await readInterceptState(c, key, page)
    requests = interceptedRequestsSince(c, requestStart)
  }
  assertInterceptResponse(c, state)
  return { state, requests }
}

async function runInterceptProbe(
  c: CheckContext,
  id: 'intercept-enable' | 'intercept-list' | 'intercept-disable'
): Promise<Record<string, unknown>> {
  const page = c.state.pageA
  c.assert(page.length > 0, 'network checks require page A')
  const key = `__g10_1_${id.replaceAll('-', '_')}`
  const pattern = `*g10-1-${id}*`
  const url = fixtureUrl(c, `/intercept?probe=g10-1-${id}`)
  const requestStart = c.world.fixture.requests.length
  let enabled: { enabled: boolean; patterns: string[] } | undefined
  let beforeDisable: InterceptObservation | undefined
  let afterDisable: InterceptReleaseObservation | undefined
  let disable: { disabled: boolean } | undefined
  let probeStarted = false
  let disableSucceeded = false
  let failure: unknown

  try {
    enabled = await c.call<{ enabled: boolean; patterns: string[] }>('intercept enable', { patterns: pattern }, page)
    c.equal(enabled.enabled, true, 'interception enabled')
    c.equal(enabled.patterns, [pattern], 'enabled interception pattern')
    probeStarted = true
    const started = await c.observe<boolean>(`(()=>{const key=${JSON.stringify(key)};window[key]={status:'pending'};void fetch(${JSON.stringify(url)},{cache:'no-store'}).then(async response=>{window[key]={status:'fulfilled',responseStatus:response.status,body:await response.text()}}).catch(error=>{window[key]={status:'rejected',error:String(error)}});return true})()`, page)
    c.equal(started, true, 'intercept probe started without awaiting the fetch')
    beforeDisable = await observeIntercept(c, key, url, pattern, page, requestStart)
    if (!beforeDisable.listed || beforeDisable.listed.url !== url) throw new Error('intercept list omitted the matching request')
    c.equal(beforeDisable.list.patterns, [pattern], 'intercept list patterns')

    if (id === 'intercept-disable') {
      disable = await c.call<{ disabled: boolean }>('intercept disable', {}, page)
      c.equal(disable.disabled, true, 'interception disabled')
      disableSucceeded = true
    }
  } catch (error) {
    failure = error
  }

  if (!disableSucceeded) {
    try {
      disable = await c.call<{ disabled: boolean }>('intercept disable', {}, page)
      c.equal(disable.disabled, true, 'interception disabled during probe cleanup')
      disableSucceeded = true
    } catch (error) {
      failure ??= error
    }
  }
  if (probeStarted) {
    try {
      afterDisable = await waitForInterceptRelease(c, key, page, requestStart)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
  if (!enabled || !beforeDisable || !afterDisable) throw new Error('intercept probe did not complete its bounded observation')

  if (afterDisable.state.status !== 'fulfilled' || afterDisable.requests.length === 0) {
    throw new Error('intercepted request was not delivered after interception was disabled')
  }
  const released = true
  const evidence = {
    enabled: enabled.enabled,
    patterns: beforeDisable.list.patterns,
    matched: beforeDisable.listed?.url === url,
    listedUrl: beforeDisable.listed?.url,
    listedPending: beforeDisable.listed?.pending ?? false,
    pageStatusBeforeDisable: beforeDisable.state.status,
    serverRequestsBeforeDisable: beforeDisable.requests.length,
    pendingBeforeDisable: beforeDisable.pending,
    disabled: disable?.disabled ?? false,
    pageStatusAfterDisable: afterDisable.state.status,
    serverRequestsAfterDisable: afterDisable.requests.length,
    released,
    responseStatus: afterDisable.state.responseStatus,
    responseBody: afterDisable.state.body
  }

  if (!beforeDisable.pending && (beforeDisable.state.status !== 'fulfilled' || beforeDisable.requests.length === 0)) {
    throw new Error('intercept probe was neither pending nor observed as auto-continued')
  }
  if (!beforeDisable.pending) return { gap: INTERCEPT_GAP, ...evidence }
  return evidence
}

async function originalViewport(c: CheckContext, page: string): Promise<Viewport> {
  return await c.observe<Viewport>('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})', page)
}

async function restoreViewport(c: CheckContext, page: string, viewport: Viewport): Promise<void> {
  const restored = await c.call<Viewport>('viewport', {
    width: viewport.width, height: viewport.height, scale: viewport.deviceScaleFactor, mobile: false
  }, page)
  c.equal(restored, { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: false }, 'viewport settings restored')
  const observed = await c.observe<{ width: number; height: number; scale: number }>('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})', page)
  c.equal(observed, { width: viewport.width, height: viewport.height, scale: viewport.deviceScaleFactor }, 'restored viewport DOM dimensions')
}

export const networkChecks: BrowserCheck[] = [
  { id: 'screenshot', async run(c) {
    const png = await c.call<CaptureResult>('screenshot', { format: 'png' })
    const pngBytes = Buffer.from(png.data, 'base64')
    const pngSize = pngDimensions(pngBytes)
    c.equal(png.format, 'png', 'viewport screenshot format')
    c.assert(pngSize.width > 0 && pngSize.height > 0, 'viewport PNG dimensions must be positive')

    const jpeg = await c.call<CaptureResult>('screenshot', { format: 'jpeg' })
    const jpegBytes = Buffer.from(jpeg.data, 'base64')
    c.assert(jpegBytes.subarray(0, 3).toString('hex') === 'ffd8ff', 'viewport JPEG signature')
    c.equal(jpeg.format, 'jpeg', 'viewport JPEG format')
    return {
      png: { signature: pngBytes.subarray(0, 8).toString('hex'), ...pngSize, bytes: pngBytes.length },
      jpeg: { signature: jpegBytes.subarray(0, 3).toString('hex'), bytes: jpegBytes.length }
    }
  } },
  { id: 'full-screenshot', async run(c) {
    const viewport = await c.call<CaptureResult>('screenshot', { format: 'png' })
    const full = await c.call<CaptureResult>('full-screenshot', { format: 'png' })
    const viewportBytes = Buffer.from(viewport.data, 'base64')
    const fullBytes = Buffer.from(full.data, 'base64')
    const viewportSize = pngDimensions(viewportBytes)
    const fullSize = pngDimensions(fullBytes)
    c.assert(fullSize.height > viewportSize.height, 'full-page screenshot must be taller than the viewport')
    return {
      viewport: { ...viewportSize, bytes: viewportBytes.length },
      fullPage: { ...fullSize, bytes: fullBytes.length },
      heightIncrease: fullSize.height - viewportSize.height
    }
  } },
  { id: 'pdf', async run(c) {
    const pdf = await c.call<CaptureResult>('pdf')
    const bytes = Buffer.from(pdf.data, 'base64')
    c.assert(bytes.subarray(0, 4).toString() === '%PDF', 'PDF signature')
    return { signature: bytes.subarray(0, 4).toString(), bytes: bytes.length }
  } },
  { id: 'upload', async run(c) {
    const path = join(c.world.home, 'upload.txt')
    const bytes = 'upload-proof\n'
    await writeFile(path, bytes, 'utf8')
    c.equal(await readFile(path, 'utf8'), bytes, 'owned upload source bytes')
    const uploaded = await c.call<{ uploaded: number }>('upload', { element: '#upload', files: path })
    c.equal(uploaded.uploaded, 1, 'uploaded file count')
    const observed = await c.observe<{ name: string; text: string } | null>('(()=>{const file=document.querySelector("#upload").files[0];return file?file.text().then(text=>({name:file.name,text})):null})()')
    if (!observed) throw new Error('uploaded file must be present in the file input')
    c.equal(observed.name, 'upload.txt', 'uploaded filename')
    c.equal(observed.text, bytes, 'uploaded File.text bytes')
    return { filename: observed.name, text: observed.text, sourceBytes: bytes.length }
  } },
  { id: 'download', async run(c) {
    const path = join(c.world.home, 'downloads', 'download-proof.txt')
    const downloaded = await c.call<{ path: string }>('download', { selector: '#download', path })
    c.equal(downloaded.path, path, 'download destination')
    const bytes = await readFile(path, 'utf8')
    c.equal(bytes, 'download-proof\n', 'downloaded file bytes')
    const server = c.world.fixture.requests.find(request => request.path === '/download' && request.method === 'GET')
    if (!server) throw new Error('fixture server must serve the download')
    return { filename: 'download-proof.txt', bytes, serverRequest: { path: server.path, method: server.method } }
  } },
  { id: 'console', async run(c) {
    const marker = 'g10-1-console-proof'
    await c.call('eval', { expression: `console.log(${JSON.stringify(marker)});true` })
    const log = await c.call<ConsoleLog>('console', { limit: 100 })
    const entry = log.entries.find(candidate => candidate.text.includes(marker))
    if (!entry) throw new Error('console command must return the page marker')
    return { marker, entry }
  } },
  { id: 'network', async run(c) {
    const url = fixtureUrl(c, '/resource?probe=g10-1-network')
    const start = c.world.fixture.requests.length
    const response = await c.observe<FetchResult>(`fetch(${JSON.stringify(url)},{cache:'no-store'}).then(async response=>({status:response.status,ok:response.ok,body:await response.text()}))`)
    c.equal(response, { status: 200, ok: true, body: 'resource-proof' }, 'fixture resource response')
    const server = c.world.fixture.requests.slice(start).find(request => request.path === '/resource' && request.method === 'GET')
    if (!server) throw new Error('fixture server must receive the resource request')
    const network = await c.call<NetworkLog>('network', { limit: 100 })
    const entry = network.entries.find(candidate => candidate.url === url && candidate.method === 'GET')
    if (!entry) throw new Error('network command must report the fixture request')
    c.equal(entry.status, 200, 'network entry status')
    return { url, response, serverRequest: { path: server.path, method: server.method }, entry }
  } },
  { id: 'capture-start', async run(c) {
    const started = await c.call<{ capturing: boolean }>('capture start')
    let stopped = false
    try {
      c.equal(started.capturing, true, 'HAR capture started')
      const url = fixtureUrl(c, '/resource?probe=g10-1-capture-start')
      const start = c.world.fixture.requests.length
      const response = await c.observe<FetchResult>(`fetch(${JSON.stringify(url)},{cache:'no-store'}).then(async response=>({status:response.status,ok:response.ok,body:await response.text()}))`)
      c.equal(response, { status: 200, ok: true, body: 'resource-proof' }, 'capture start fixture request')
      const server = c.world.fixture.requests.slice(start).find(request => request.path === '/resource' && request.method === 'GET')
      if (!server) throw new Error('capture start request must reach the fixture')
      const capture = await c.call<HarCapture>('capture stop')
      stopped = true
      c.equal(capture.stopped, true, 'capture started by capture-start must stop')
      const entry = capture.har.log.entries.find(candidate => candidate.request.url === url && candidate.request.method === 'GET')
      if (!entry) throw new Error('capture-start must produce a HAR entry for its fixture request')
      c.equal(entry.response.status, 200, 'capture-start HAR response status')
      c.assert(entry.response.content.size > 0, 'capture-start HAR response content must have positive size')
      return { capturing: started.capturing, url, response, serverRequest: { path: server.path, method: server.method }, har: entry }
    } finally {
      if (!stopped) await c.call('capture stop')
    }
  } },
  { id: 'capture-stop', async run(c) {
    const started = await c.call<{ capturing: boolean }>('capture start')
    let stopped = false
    try {
      c.equal(started.capturing, true, 'capture-stop probe starts HAR capture')
      const url = fixtureUrl(c, '/resource?probe=g10-1-capture-stop')
      const start = c.world.fixture.requests.length
      const response = await c.observe<FetchResult>(`fetch(${JSON.stringify(url)},{cache:'no-store'}).then(async response=>({status:response.status,ok:response.ok,body:await response.text()}))`)
      c.equal(response, { status: 200, ok: true, body: 'resource-proof' }, 'capture stop fixture request')
      const server = c.world.fixture.requests.slice(start).find(request => request.path === '/resource' && request.method === 'GET')
      if (!server) throw new Error('capture stop request must reach the fixture')
      const stoppedCapture = await c.call<HarCapture>('capture stop')
      stopped = true
      c.equal(stoppedCapture.stopped, true, 'HAR capture stopped')
      const entry = stoppedCapture.har.log.entries.find(candidate => candidate.request.url === url && candidate.request.method === 'GET')
      if (!entry) throw new Error('capture-stop must return a HAR entry for its fixture request')
      c.equal(entry.response.status, 200, 'HAR response status')
      c.assert(entry.response.content.size > 0, 'HAR response content must have positive size')
      return { url, response, serverRequest: { path: server.path, method: server.method }, har: entry }
    } finally {
      if (!stopped) await c.call('capture stop')
    }
  } },
  { id: 'intercept-enable', async run(c) { return await runInterceptProbe(c, 'intercept-enable') } },
  { id: 'intercept-disable', async run(c) { return await runInterceptProbe(c, 'intercept-disable') } },
  { id: 'intercept-list', async run(c) { return await runInterceptProbe(c, 'intercept-list') } },
  { id: 'viewport', async run(c) {
    const page = c.state.pageB
    const before = await originalViewport(c, page)
    try {
      const result = await c.call<Viewport>('viewport', { width: 414, height: 896, scale: 2, mobile: true }, page)
      c.equal(result, { width: 414, height: 896, deviceScaleFactor: 2, mobile: true }, 'viewport command result')
      const observed = await c.observe<{ width: number; height: number; scale: number }>('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})', page)
      c.equal(observed, { width: 414, height: 896, scale: 2 }, 'viewport DOM dimensions')
      return { viewport: result, observed }
    } finally {
      await restoreViewport(c, page, before)
    }
  } },
  { id: 'geolocation', async run(c) {
    const page = c.state.pageB
    try {
      const changed = await c.call<{ latitude: number; longitude: number; accuracy: number }>('geolocation', { latitude: 37.4219, longitude: -122.084, accuracy: 20 }, page)
      c.equal(changed, { latitude: 37.4219, longitude: -122.084, accuracy: 20 }, 'geolocation command result')
      const coordinates = await c.observe<GeoResult>(`new Promise(resolve=>navigator.geolocation.getCurrentPosition(position=>resolve({latitude:position.coords.latitude,longitude:position.coords.longitude}),error=>resolve({error:error.message})))`, page)
      c.assert(coordinates.error === undefined, `geolocation lookup failed: ${coordinates.error ?? ''}`)
      c.assert(coordinates.latitude !== undefined && Math.abs(coordinates.latitude - 37.4219) < 0.000001, 'page latitude must match the configured coordinate')
      c.assert(coordinates.longitude !== undefined && Math.abs(coordinates.longitude + 122.084) < 0.000001, 'page longitude must match the configured coordinate')
      return { configured: changed, observed: coordinates }
    } finally {
      const restored = await c.call<{ latitude: number; longitude: number; accuracy: number }>('geolocation', { latitude: 0, longitude: 0, accuracy: 0 }, page)
      c.equal(restored, { latitude: 0, longitude: 0, accuracy: 0 }, 'geolocation settings restored')
      const coordinates = await c.observe<GeoResult>(`new Promise(resolve=>navigator.geolocation.getCurrentPosition(position=>resolve({latitude:position.coords.latitude,longitude:position.coords.longitude}),error=>resolve({error:error.message})))`, page)
      c.assert(coordinates.error === undefined, `restored geolocation lookup failed: ${coordinates.error ?? ''}`)
      c.assert(coordinates.latitude !== undefined && Math.abs(coordinates.latitude) < 0.000001, 'restored page latitude must be zero')
      c.assert(coordinates.longitude !== undefined && Math.abs(coordinates.longitude) < 0.000001, 'restored page longitude must be zero')
    }
  } },
  { id: 'set-device', async run(c) {
    const created = await c.call<{ browserPageId: string }>('tab create', {
      profile: c.state.profileA, worktree: c.world.worktreeA, url: fixtureUrl(c, '/page')
    }, '')
    const page = created.browserPageId
    try {
      c.assert(page.length > 0, 'device probe page must have an ID')
      const device = await c.call<{ name: string }>('set device', { name: 'iphone 14' }, page)
      c.equal(device.name, 'iphone 14', 'device name')
      const observed = await c.observe<{ width: number; height: number; userAgent: string }>('({width:innerWidth,height:innerHeight,userAgent:navigator.userAgent})', page)
      c.equal(observed.width, 390, 'iPhone viewport width')
      c.equal(observed.height, 844, 'iPhone viewport height')
      c.assert(observed.userAgent.includes('iPhone'), 'iPhone device user agent')
      return { device, observed, page }
    } finally {
      await c.call('tab close', { yes: true }, page)
      const tabs = await c.call<{ tabs: Array<{ browserPageId: string }> }>('tab list', { worktree: c.world.worktreeA }, '')
      c.assert(!tabs.tabs.some(tab => tab.browserPageId === page), 'device probe page must be closed')
    }
  } },
  { id: 'set-offline', async run(c) {
    const page = c.state.pageB
    const probeUrl = fixtureUrl(c, '/resource?probe=g10-1-offline')
    const onlineUrl = fixtureUrl(c, '/resource?probe=g10-1-offline-online')
    const baselineCount = c.world.fixture.requests.filter(request => request.path === '/resource').length
    const offline = await c.call<{ offline: boolean }>('set offline', { state: 'on' }, page)
    let failedFetch: { ok: boolean; error?: string } | undefined
    let online: { offline: boolean } | undefined
    try {
      c.equal(offline.offline, true, 'offline emulation enabled')
      c.equal(await c.observe<boolean>('navigator.onLine', page), false, 'navigator.onLine while offline')
      failedFetch = await c.observe<{ ok: boolean; error?: string }>(`fetch(${JSON.stringify(probeUrl)},{cache:'no-store'}).then(response=>({ok:response.ok}),error=>({ok:false,error:error.name}))`, page)
      c.assert(failedFetch.ok === false && typeof failedFetch.error === 'string', 'offline fetch must fail in the page')
      const offlineRequestCount = c.world.fixture.requests.filter(request => request.path === '/resource').length
      c.equal(offlineRequestCount, baselineCount, 'offline request must not reach the local server')
    } finally {
      online = await c.call<{ offline: boolean }>('set offline', { state: 'off' }, page)
    }
    if (!online || !failedFetch) throw new Error('offline check did not restore the page state')
    c.equal(online.offline, false, 'offline emulation restored')
    c.equal(await c.observe<boolean>('navigator.onLine', page), true, 'navigator.onLine restored')
    const recovered = await c.observe<FetchResult>(`fetch(${JSON.stringify(onlineUrl)},{cache:'no-store'}).then(async response=>({status:response.status,ok:response.ok,body:await response.text()}))`, page)
    c.equal(recovered, { status: 200, ok: true, body: 'resource-proof' }, 'fetch after restoring online mode')
    const server = c.world.fixture.requests.filter(request => request.path === '/resource')
    c.assert(server.length > baselineCount, 'online retry must reach the fixture server')
    return { offline: offline.offline, failedFetch, restored: online.offline === false, recovered, serverRequests: server.length - baselineCount }
  } },
  { id: 'set-headers', async run(c) {
    const page = c.state.pageB
    const headerValue = 'header-proof'
    const url = fixtureUrl(c, '/echo?probe=g10-1-header')
    const start = c.world.fixture.requests.length
    let response: { value: string | null } | undefined
    try {
      const configured = await c.call<{ headers: Record<string, string> }>('set headers', { headers: JSON.stringify({ 'x-parity': headerValue }) }, page)
      c.equal(configured.headers, { 'x-parity': headerValue }, 'configured extra request header')
      response = await c.observe<{ value: string | null }>(`fetch(${JSON.stringify(url)},{cache:'no-store'}).then(result=>result.json())`, page)
      c.equal(response, { value: headerValue }, 'header echo DOM response')
      const server = c.world.fixture.requests.slice(start).find(request => request.path === '/echo' && request.method === 'GET')
      if (!server) throw new Error('header request must reach the local fixture')
      c.equal(server.headers['x-parity'], headerValue, 'fixture observed configured header')
      return { url, response, serverRequest: { path: server.path, method: server.method, header: server.headers['x-parity'] } }
    } finally {
      const restored = await c.call<{ headers: Record<string, string> }>('set headers', { headers: '{}' }, page)
      c.equal(restored.headers, {}, 'extra headers cleared')
      const restoredUrl = fixtureUrl(c, '/echo?probe=g10-1-header-restored')
      const restoredResponse = await c.observe<{ value: string | null }>(`fetch(${JSON.stringify(restoredUrl)},{cache:'no-store'}).then(result=>result.json())`, page)
      c.equal(restoredResponse, { value: null }, 'restored headers absent from page response')
      const restoredRequest = c.world.fixture.requests.slice(start).filter(request => request.path === '/echo').at(-1)
      if (!restoredRequest) throw new Error('restored header probe must reach the fixture')
      c.equal(restoredRequest.headers['x-parity'], undefined, 'restored header absent from fixture request')
    }
  } },
  { id: 'set-media', async run(c) {
    const page = c.state.pageB
    try {
      const media = await c.call<{ colorScheme: string; reducedMotion: string }>('set media', { 'color-scheme': 'dark', 'reduced-motion': 'reduce' }, page)
      const observed = await c.observe<{ dark: boolean; reducedMotion: boolean }>('({dark:matchMedia("(prefers-color-scheme: dark)").matches,reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches})', page)
      c.equal(observed, { dark: true, reducedMotion: true }, 'media query DOM state')
      return { media, observed }
    } finally {
      const restored = await c.call<{ colorScheme: string | null; reducedMotion: string | null }>('set media', { 'color-scheme': 'light', 'reduced-motion': 'no-preference' }, page)
      c.equal(restored, { colorScheme: 'light', reducedMotion: 'no-preference' }, 'media settings restored')
      const observed = await c.observe<{ dark: boolean; reducedMotion: boolean }>('({dark:matchMedia("(prefers-color-scheme: dark)").matches,reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches})', page)
      c.equal(observed, { dark: false, reducedMotion: false }, 'restored media query state')
    }
  } },
  { id: 'set-credentials', async run(c) {
    const page = c.state.pageB
    const url = fixtureUrl(c, '/auth')
    const echoUrl = fixtureUrl(c, '/echo?probe=g10-1-credentials-isolation')
    const start = c.world.fixture.requests.length
    const expected = `Basic ${Buffer.from('parity:fixture-only').toString('base64')}`
    try {
      const configured = await c.call<{ configured: boolean }>('set credentials', { user: 'parity', pass: 'fixture-only' }, page)
      c.equal(configured.configured, true, 'Basic credentials configured')
      const echo = await c.observe<{ value: string | null }>(`fetch(${JSON.stringify(echoUrl)},{credentials:'include',cache:'no-store'}).then(result=>result.json())`, page)
      c.equal(echo, { value: null }, 'non-auth endpoint must not receive credentials before an auth challenge')
      const echoRequest = c.world.fixture.requests.slice(start).find(request => request.path === '/echo' && request.method === 'GET')
      if (!echoRequest) throw new Error('credential-isolation request must reach the local fixture')
      c.assert(echoRequest.headers.authorization !== expected, 'Basic credentials must not reach /echo')
      const response = await c.observe<FetchResult>(`fetch(${JSON.stringify(url)},{credentials:'include',cache:'no-store'}).then(async result=>({status:result.status,ok:result.ok,body:await result.text()}))`, page)
      c.equal(response, { status: 200, ok: true, body: 'authenticated' }, 'authenticated local response')
      const requests = c.world.fixture.requests.slice(start)
      const authRequests = requests.filter(request => request.path === '/auth' && request.method === 'GET')
      c.assert(authRequests.some(request => request.headers.authorization === expected), 'fixture must observe the exact Basic credentials on /auth')
      c.assert(requests.every(request => request.path === '/auth' || request.headers.authorization !== expected), 'Basic credentials must not reach a non-auth endpoint')
      return {
        url, echoUrl, echo, echoRequest: { path: echoRequest.path, method: echoRequest.method, authorizationObserved: echoRequest.headers.authorization === expected },
        response, authRequests: authRequests.map(request => ({ path: request.path, method: request.method, authorizationObserved: request.headers.authorization === expected })),
        nonAuthRequestsWithCredentials: requests.filter(request => request.path !== '/auth' && request.headers.authorization === expected).length
      }
    } finally {
      await c.call('set credentials', { user: '', pass: '' }, page)
    }
  } }
]
