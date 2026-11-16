import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
const call = (client: BrowserTestHarness['client'], name: string, params: Record<string, unknown> = {}) =>
  client.callAny(`quirky.browser/${name}`, params)

type Page = { browserPageId: string; profileId?: string; url?: string }
type Cookie = {
  name: string; value: string; domain: string; path: string; hostOnly: boolean
  secure: boolean; httpOnly: boolean; sameSite?: string; expires?: number
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}
type InterceptRequest = {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  resourceType: string
  pending: true
}
type InterceptList = { patterns: string[]; requests: InterceptRequest[] }

async function waitFor<T>(read: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value != null) return value
    // chrome and the daemon run in separate processes, outside Bun's fake clock
    await Bun.sleep(20)
  }
  throw new Error(`browser fixture condition did not become true within ${timeoutMs}ms`)
}

function expectHeldRequest(request: InterceptRequest, url: string, resourceType = 'Fetch') {
  expect(Object.keys(request).sort()).toEqual(['headers', 'id', 'method', 'pending', 'resourceType', 'url'])
  expect(request).toMatchObject({ url, method: 'GET', resourceType, pending: true })
  expect(request.id.length).toBeGreaterThan(0)
  expect(Object.values(request.headers).every((value) => typeof value === 'string')).toBe(true)
}

function observeFetchesExpression(urls: string[], resultName = '__interceptResults') {
  const results = `window[${JSON.stringify(resultName)}]`
  return `(() => { ${results} = []; for (const url of ${JSON.stringify(urls)}) fetch(url).then(async response => ${results}.push(await response.text()), error => ${results}.push(error.name)); return true })()`
}

function fetchResultsExpression(url: string) {
  return `fetch(${JSON.stringify(url)}).then(response => response.text())`
}

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }

function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

function startCountedCorsServer() {
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const cors = {
        'access-control-allow-origin': request.headers.get('origin') ?? '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization,x-extras'
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1)
      return new Response(`body:${url.pathname}`, { headers: { ...cors, 'content-type': 'text/plain' } })
    }
  })
  return {
    url: server.url.href,
    count: (path: string) => counts.get(path) ?? 0,
    stop: () => server.stop(true)
  }
}


async function newPage(h: BrowserTestHarness, profile?: string, url = `${h.fixtureUrl}events`): Promise<Page> {
  return await call(h.client, 'tabCreate', { url, ...(profile ? { profile } : {}) }) as Page
}

test('SC3: cookies retain exact host, path, partition identity and storage stays in its profile/page scope', async () => {
  const h = await startBrowserHarness()
  try {
    const isolated = await call(h.client, 'profileCreate', { name: 'Extras isolation' }) as { profile: { id: string } }
    const first = await newPage(h, isolated.profile.id)
    const sameProfile = await newPage(h, isolated.profile.id)
    const otherProfile = await newPage(h)
    const fixture = new URL(h.fixtureUrl)
    const partitionKey = { topLevelSite: `${fixture.protocol}//${fixture.hostname}`, hasCrossSiteAncestor: false }

    await call(h.client, 'cookieSet', {
      page: first.browserPageId, name: 'extras_partitioned', value: 'private', url: h.fixtureUrl,
      secure: true, httpOnly: true, sameSite: 'None', expires: Math.floor(Date.now() / 1000) + 3600, partitionKey
    })
    await call(h.client, 'cookieSet', { page: first.browserPageId, name: 'extras_exact', value: 'root', url: h.fixtureUrl, path: '/' })
    await call(h.client, 'cookieSet', { page: first.browserPageId, name: 'extras_exact', value: 'nested', url: h.fixtureUrl, path: '/events' })
    await call(h.client, 'cookieSet', { page: first.browserPageId, name: 'extras_domain', value: 'domain', url: h.fixtureUrl, domain: 'example.test', path: '/' })
    const cookies = (await call(h.client, 'cookieGet', { page: first.browserPageId }) as { cookies: Cookie[] }).cookies
    expect(cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'extras_partitioned', value: 'private', hostOnly: true, secure: true, httpOnly: true, sameSite: 'None', partitionKey }),
      expect.objectContaining({ name: 'extras_exact', value: 'root', path: '/', hostOnly: true }),
      expect.objectContaining({ name: 'extras_exact', value: 'nested', path: '/events', hostOnly: true }),
      expect.objectContaining({ name: 'extras_domain', value: 'domain', hostOnly: false, path: '/' })
    ]))
    await expect(call(h.client, 'cookieDelete', { page: first.browserPageId, name: 'extras_exact', yes: true })).rejects.toBeInstanceOf(Error)
    await call(h.client, 'cookieDelete', { page: first.browserPageId, name: 'extras_exact', path: '/events', yes: true })
    const afterExactDelete = (await call(h.client, 'cookieGet', { page: first.browserPageId }) as { cookies: Cookie[] }).cookies
    expect(afterExactDelete.filter((cookie) => cookie.name === 'extras_exact').map((cookie) => cookie.path)).toEqual(['/'])
    await call(h.client, 'cookieDelete', { page: first.browserPageId, name: 'extras_partitioned', partitionKey, yes: true })
    await call(h.client, 'cookieDelete', { page: first.browserPageId, name: 'extras_domain', domain: 'example.test', path: '/', yes: true })

    const literal = '@file:/this/is/data/not/a/path — 😀'
    await call(h.client, 'storageLocalSet', { page: first.browserPageId, key: 'unicode', value: literal })
    await call(h.client, 'storageSessionSet', { page: first.browserPageId, key: 'only-this-page', value: '' })
    expect(await call(h.client, 'storageLocalGet', { page: sameProfile.browserPageId, key: 'unicode' })).toEqual({ key: 'unicode', value: literal })
    expect(await call(h.client, 'storageLocalGet', { page: otherProfile.browserPageId, key: 'unicode' })).toEqual({ key: 'unicode', value: null })
    expect(await call(h.client, 'storageSessionGet', { page: sameProfile.browserPageId, key: 'only-this-page' })).toEqual({ key: 'only-this-page', value: null })
    expect(await call(h.client, 'storageSessionGet', { page: first.browserPageId, key: 'only-this-page' })).toEqual({ key: 'only-this-page', value: '' })
    await call(h.client, 'storageSessionClear', { page: first.browserPageId, yes: true })
    expect(await call(h.client, 'storageSessionGet', { page: first.browserPageId, key: 'only-this-page' })).toEqual({ key: 'only-this-page', value: null })
  } finally { await h.cleanup() }
}, 120_000)

test('SC4: page profile rebinding is isolated and clone copies cookies transactionally into an independent page', async () => {
  const h = await startBrowserHarness()
  try {
    const sourceProfile = await call(h.client, 'profileCreate', { name: 'Clone source' }) as { profile: { id: string } }
    const destination = await call(h.client, 'profileCreate', { name: 'Clone destination' }) as { profile: { id: string } }
    const source = await newPage(h, sourceProfile.profile.id, `${h.fixtureUrl}first`)
    const neighbor = await newPage(h, sourceProfile.profile.id, `${h.fixtureUrl}second`)
    await call(h.client, 'cookieSet', { page: source.browserPageId, name: 'clone-proof', value: 'copied', url: h.fixtureUrl })
    await call(h.client, 'cookieSet', { page: neighbor.browserPageId, name: 'clone-proof', value: 'copied', url: h.fixtureUrl })

    expect(await call(h.client, 'tabProfileShow', { page: source.browserPageId })).toMatchObject({ profileId: sourceProfile.profile.id })
    const moved = await call(h.client, 'tabProfileSet', { page: source.browserPageId, profile: destination.profile.id })
    expect(moved).toMatchObject({ browserPageId: source.browserPageId, profileId: destination.profile.id })
    expect((await call(h.client, 'tabShow', { page: source.browserPageId }) as { tab: Page & { url: string } }).tab.url).toBe(`${h.fixtureUrl}first`)
    expect((await call(h.client, 'tabShow', { page: neighbor.browserPageId }) as { tab: Page }).tab.profileId).toBe(sourceProfile.profile.id)
    await call(h.client, 'tabProfileUseDefault', { page: source.browserPageId })
    expect(await call(h.client, 'tabProfileShow', { page: source.browserPageId })).toMatchObject({ profileId: 'default' })

    const copyDestination = await call(h.client, 'profileCreate', { name: 'Clone result' }) as { profile: { id: string } }
    const cloned = await call(h.client, 'profileClone', { source: neighbor.browserPageId, profile: copyDestination.profile.id }) as {
      browserPageId: string; sourceBrowserPageId: string; profileId: string
    }
    expect(cloned).toMatchObject({ sourceBrowserPageId: neighbor.browserPageId, profileId: copyDestination.profile.id })
    expect(cloned.browserPageId).not.toBe(neighbor.browserPageId)
    const copied = (await call(h.client, 'cookieGet', { page: cloned.browserPageId }) as { cookies: Cookie[] }).cookies
    expect(copied).toContainEqual(expect.objectContaining({ name: 'clone-proof', value: 'copied' }))
    expect((await call(h.client, 'tabShow', { page: neighbor.browserPageId }) as { tab: Page }).tab.profileId).toBe(sourceProfile.profile.id)
  } finally { await h.cleanup() }
}, 120_000)

test('SC5: history, advanced interactions, signed nth and full-page capture operate on the exact page', async () => {
  const downloadServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('downloaded', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=extras.txt' } })
  })
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    const pageId = page.browserPageId
    await call(h.client, 'goto', { page: pageId, url: `${h.fixtureUrl}events` })
    const markup = `<output id=\"which\"></output><button class=\"item\" onclick=\"document.querySelector('#which').textContent='one'\">one</button><button class=\"item\" onclick=\"document.querySelector('#which').textContent='two'\">two</button><button class=\"item\" onclick=\"document.querySelector('#which').textContent='three'\">three</button><input id=\"upload\" type=\"file\"><select id=\"choice\"><option value=\"a\">A</option><option value=\"b\">B</option></select><input id=\"check\" type=\"checkbox\"><div id=\"hidden\" style=\"display:none\">hidden</div><div id=\"dragSource\" draggable=\"true\" ondragstart=\"event.dataTransfer.setData('text/plain','dragged')\">source</div><div id=\"dragTarget\" ondragover=\"event.preventDefault()\" ondrop=\"event.preventDefault();document.querySelector('#dragResult').textContent=event.dataTransfer.getData('text/plain')\">target</div><output id=\"dragResult\"></output><output id=\"pointer\"></output>`
    await call(h.client, 'eval', { page: pageId, expression: `document.body.insertAdjacentHTML('beforeend',${JSON.stringify(markup)})` })
    await call(h.client, 'find', { page: pageId, locator: 'nth', value: '.item', index: -1, action: 'click' })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector(\"#which\").textContent' })).toEqual({ value: 'three' })
    await call(h.client, 'find', { page: pageId, locator: 'nth', value: '.item', index: 1, action: 'click' })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector(\"#which\").textContent' })).toEqual({ value: 'two' })
    await call(h.client, 'find', { page: pageId, locator: 'nth', value: '.item', index: 0, action: 'click' })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector(\"#which\").textContent' })).toEqual({ value: 'one' })
    await call(h.client, 'wait', { page: pageId, selector: '#hidden', state: 'hidden', timeout: 2_000 })
    expect(await call(h.client, 'get', { page: pageId, what: 'text', element: '#which' })).toEqual({ value: 'one' })
    expect(await call(h.client, 'get', { page: pageId, what: 'count', element: '.item' })).toEqual({ value: 3 })
    expect(await call(h.client, 'is', { page: pageId, what: 'visible', element: '#text' })).toEqual({ value: true })
    await call(h.client, 'clear', { page: pageId, element: '#text' })
    await call(h.client, 'keyboardInsertText', { page: pageId, text: '@file is literal' })
    expect(await call(h.client, 'get', { page: pageId, what: 'value', element: '#text' })).toEqual({ value: '@file is literal' })
    await call(h.client, 'selectAll', { page: pageId, element: '#text' })
    expect(await call(h.client, 'eval', { page: pageId, expression: '({element:document.activeElement.id,selected:document.activeElement.value.slice(document.activeElement.selectionStart,document.activeElement.selectionEnd)})' })).toEqual({ value: { element: 'text', selected: '@file is literal' } })
    await call(h.client, 'scrollIntoView', { page: pageId, element: '#dragTarget' })
    await call(h.client, 'eval', { page: pageId, expression: 'document.addEventListener(\"mousemove\",event=>document.querySelector(\"#pointer\").textContent=`${event.clientX},${event.clientY}`,{once:true})' })
    await call(h.client, 'mouseMove', { page: pageId, x: 20, y: 20 })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector(\"#pointer\").textContent' })).toEqual({ value: '20,20' })
    await call(h.client, 'eval', { page: pageId, expression: "window.__extrasMouseEvents=[];const signal=document.createElement('output');signal.id='wheelObserved';signal.hidden=true;document.body.append(signal);document.addEventListener('mousedown',e=>window.__extrasMouseEvents.push({type:'down',button:e.button}));document.addEventListener('mouseup',e=>window.__extrasMouseEvents.push({type:'up',button:e.button}));document.addEventListener('wheel',e=>{window.__extrasMouseEvents.push({type:'wheel',deltaX:e.deltaX,deltaY:e.deltaY});signal.textContent=String(e.deltaX)+','+String(e.deltaY);signal.hidden=false});true" })
    await call(h.client, 'mouseDown', { page: pageId, button: 'left' })
    await call(h.client, 'mouseUp', { page: pageId, button: 'left' })
    await call(h.client, 'mouseWheel', { page: pageId, dy: 40 })
    await call(h.client, 'wait', { page: pageId, selector: '#wheelObserved', state: 'visible', timeout: 2_000 })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'window.__extrasMouseEvents' })).toEqual({ value: [{ type: 'down', button: 0 }, { type: 'up', button: 0 }, { type: 'wheel', deltaX: 0, deltaY: 40 }] })
    await call(h.client, 'drag', { page: pageId, from: '#dragSource', to: '#dragTarget' })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector(\"#dragResult\").textContent' })).toEqual({ value: 'dragged' })
    await call(h.client, 'dblclick', { page: pageId, element: '.item' })
    await call(h.client, 'find', { page: pageId, locator: 'text', value: 'Submit', action: 'click' })
    await call(h.client, 'clear', { page: pageId, element: '#text' })
    await call(h.client, 'focus', { page: pageId, element: '#text' })
    const longUnicode = 'x😀'.repeat(5_000)
    await call(h.client, 'type', { page: pageId, input: longUnicode })
    expect(await call(h.client, 'get', { page: pageId, what: 'value', element: '#text' })).toEqual({ value: longUnicode })
    await call(h.client, 'select', { page: pageId, element: '#choice', value: 'b' })
    await call(h.client, 'check', { page: pageId, element: '#check' })
    expect(await call(h.client, 'is', { page: pageId, what: 'checked', element: '#check' })).toEqual({ value: true })
    await call(h.client, 'uncheck', { page: pageId, element: '#check' })
    expect(await call(h.client, 'get', { page: pageId, what: 'value', element: '#choice' })).toEqual({ value: 'b' })

    const uploadPath = join(h.home, 'extras-upload.txt')
    writeFileSync(uploadPath, 'upload bytes')
    await call(h.client, 'upload', { page: pageId, element: '#upload', files: [uploadPath] })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector("#upload").files[0].name' })).toEqual({ value: 'extras-upload.txt' })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'document.querySelector("#upload").files[0].text()' })).toEqual({ value: 'upload bytes' })
    const downloadPath = join(h.home, 'downloads', 'extras.txt')
    await call(h.client, 'eval', { page: pageId, expression: `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(downloadServer.url.href)};a.download='extras.txt';a.id='download';a.textContent='Download extras';document.body.append(a);return true})()` })
    await call(h.client, 'download', { page: pageId, selector: '#download', path: downloadPath })
    expect(await Bun.file(downloadPath).text()).toBe('downloaded')

    await call(h.client, 'goto', { page: pageId, url: `${h.fixtureUrl}second` })
    expect(await call(h.client, 'back', { page: pageId })).toMatchObject({ url: `${h.fixtureUrl}events` })
    expect(await call(h.client, 'forward', { page: pageId })).toMatchObject({ url: `${h.fixtureUrl}second` })
    expect(await call(h.client, 'reload', { page: pageId })).toMatchObject({ url: `${h.fixtureUrl}second` })
    await call(h.client, 'goto', { page: pageId, url: `${h.fixtureUrl}tall` })
    const viewport = await call(h.client, 'screenshot', { page: pageId }) as { data: string }
    const full = await call(h.client, 'fullScreenshot', { page: pageId }) as { data: string }
    const viewportPng = Buffer.from(viewport.data, 'base64')
    const fullPng = Buffer.from(full.data, 'base64')
    expect(viewportPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(fullPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(fullPng.readUInt32BE(20)).toBeGreaterThan(viewportPng.readUInt32BE(20))
    const pdf = Buffer.from((await call(h.client, 'pdf', { page: pageId }) as { data: string }).data, 'base64')
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
  } finally {
    await h.cleanup()
    await downloadServer.stop(true)
  }
}, 180_000)

test('SC6-SC7: HAR, pending interception, headers, emulation, clipboard and out-of-band dialog response are real', async () => {
  const responseCounts = new Map<string, number>()
  const responseServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const cors = {
        'access-control-allow-origin': request.headers.get('origin') ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization,x-extras'
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      responseCounts.set(url.pathname, (responseCounts.get(url.pathname) ?? 0) + 1)
      if (url.pathname === '/auth') {
        if (request.headers.get('authorization') !== `Basic ${btoa('extras:secret')}`) {
          return new Response('auth required', { status: 401, headers: { ...cors, 'www-authenticate': 'Basic realm=\"extras\"' } })
        }
        return new Response('authenticated', { headers: cors })
      }
      if (url.pathname === '/echo') return Response.json({ value: request.headers.get('x-extras') }, { headers: cors })
      return new Response(`body:${url.pathname}`, { headers: { ...cors, 'content-type': 'text/plain' } })
    }
  })
  const pageServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Events</title><main>Fixture</main>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } }
    )
  })
  let dialogOpened = Promise.withResolvers<void>()
  const h = await startBrowserHarness({ onDialog: () => dialogOpened.resolve() })
  try {
    const localBase = responseServer.url.href
    const pageUrl = pageServer.url.href
    const first = await newPage(h, undefined, pageUrl)
    const neighbor = await newPage(h, undefined, pageUrl)
    const pageId = first.browserPageId
    await call(h.client, 'setHeaders', { page: pageId, headers: JSON.stringify({ 'x-extras': 'header-value' }) })
    expect(await call(h.client, 'eval', { page: pageId, expression: `fetch(${JSON.stringify(`${localBase}echo`)}).then(r=>r.json())` })).toEqual({ value: { value: 'header-value' } })

    await call(h.client, 'captureStart', { page: pageId })
    await call(h.client, 'eval', { page: pageId, expression: `fetch(${JSON.stringify(`${localBase}capture-one`)}).then(r=>r.text())` })
    await call(h.client, 'eval', { page: pageId, expression: `fetch(${JSON.stringify(`${localBase}capture-two`)}).then(r=>r.text())` })
    const capture = await call(h.client, 'captureStop', { page: pageId }) as { har: { log: { entries: Array<{ request: { url: string; method: string }; response: { status: number; content: { size: number } } }> } } }
    const harEntries = capture.har.log.entries.filter((entry) => entry.request.method === 'GET' && entry.request.url.includes('/capture-'))
    expect(harEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ request: expect.objectContaining({ url: `${localBase}capture-one`, method: 'GET' }), response: expect.objectContaining({ status: 200 }) }),
      expect.objectContaining({ request: expect.objectContaining({ url: `${localBase}capture-two`, method: 'GET' }), response: expect.objectContaining({ status: 200 }) })
    ]))
    await call(h.client, 'eval', { page: pageId, expression: 'console.log(\"extras-observable-log\")' })
    const consoleLog = await call(h.client, 'console', { page: pageId, limit: 1 }) as { entries: Array<{ text: string }> }
    expect(consoleLog.entries).toHaveLength(1)
    expect(consoleLog.entries[0]!.text).toContain('extras-observable-log')
    const networkLog = await call(h.client, 'network', { page: pageId }) as { entries: Array<{ url: string; method: string; status: number }> }
    expect(networkLog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${localBase}capture-two`, method: 'GET', status: 200 })
    ]))
    expect(harEntries.every((entry) => entry.response.content.size > 0)).toBe(true)

    await call(h.client, 'setHeaders', { page: pageId, headers: '{}' })
    const patterns = ['*hold-one*', '*hold-two*']
    expect(await call(h.client, 'interceptEnable', { page: pageId, patterns })).toEqual({ enabled: true, patterns })
    const heldUrls = [`${localBase}hold-one`, `${localBase}hold-two`]
    const startAndFetchFree = `(() => { window.__interceptResults = []; for (const url of ${JSON.stringify(heldUrls)}) fetch(url).then(async response => window.__interceptResults.push(await response.text()), error => window.__interceptResults.push(error.name)); return fetch(${JSON.stringify(`${localBase}free`)}).then(response => response.text()) })()`
    expect(await call(h.client, 'eval', { page: pageId, expression: startAndFetchFree })).toEqual({ value: 'body:/free' })
    const heldSnapshot = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      return snapshot.requests.length === 2 ? snapshot : null
    })
    // chrome's cross-process fetches must stay paused throughout the observation window
    await Bun.sleep(500)
    const stillPending = await call(h.client, 'eval', { page: pageId, expression: 'window.__interceptResults.length' })
    expect(stillPending).toEqual({ value: 0 })
    expect(responseCounts.get('/hold-one') ?? 0).toBe(0)
    expect(responseCounts.get('/hold-two') ?? 0).toBe(0)
    expect(heldSnapshot.patterns).toEqual(patterns)
    expect(heldSnapshot.requests.map((request) => request.url).sort()).toEqual(heldUrls.sort())
    for (const url of heldUrls) {
      const request = heldSnapshot.requests.find((entry) => entry.url === url)
      expect(request).toBeDefined()
      expectHeldRequest(request!, url)
    }

    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })
    await waitFor(async () => {
      const result = await call(h.client, 'eval', { page: pageId, expression: 'window.__interceptResults.length' }) as { value: number }
      return result.value === 2 && responseCounts.get('/hold-one') === 1 && responseCounts.get('/hold-two') === 1 ? result : null
    })
    const releasedResults = await call(h.client, 'eval', { page: pageId, expression: 'window.__interceptResults' }) as { value: string[] }
    expect(releasedResults.value.sort()).toEqual(['body:/hold-one', 'body:/hold-two'])
    expect(await call(h.client, 'interceptList', { page: pageId })).toEqual({ patterns: [], requests: [] })
    expect(await call(h.client, 'eval', { page: pageId, expression: fetchResultsExpression(heldUrls[0]!) }))
      .toEqual({ value: 'body:/hold-one' })
    expect(responseCounts.get('/hold-one')).toBe(2)
    await call(h.client, 'setHeaders', { page: pageId, headers: JSON.stringify({ 'x-extras': 'header-value' }) })

    await call(h.client, 'setCredentials', { page: pageId, user: 'extras', pass: 'secret' })
    expect(await call(h.client, 'eval', { page: pageId, expression: `fetch(${JSON.stringify(`${localBase}auth`)},{credentials:'include'}).then(r=>r.text())` })).toEqual({ value: 'authenticated' })
    await call(h.client, 'viewport', { page: pageId, width: 414, height: 896, deviceScaleFactor: 2, mobile: true })
    await call(h.client, 'setMedia', { page: pageId, colorScheme: 'dark', reducedMotion: 'reduce' })
    await call(h.client, 'geolocation', { page: pageId, latitude: 37.4219, longitude: -122.084, accuracy: 20 })
    expect(await call(h.client, 'eval', { page: pageId, expression: '({width:innerWidth,height:innerHeight,dark:matchMedia("(prefers-color-scheme: dark)").matches,motion:matchMedia("(prefers-reduced-motion: reduce)").matches})' }))
      .toEqual({ value: { width: 414, height: 896, dark: true, motion: true } })
    await call(h.client, 'setDevice', { page: pageId, name: 'iphone 14' })
    const deviceState = await call(h.client, 'eval', { page: pageId, expression: '({width:innerWidth,height:innerHeight,userAgent:navigator.userAgent})' }) as { value: { width: number; height: number; userAgent: string } }
    expect(deviceState.value).toMatchObject({ width: 390, height: 844 })
    expect(deviceState.value.userAgent).toContain('iPhone')
    const coordinates = await call(h.client, 'eval', { page: pageId, expression: 'new Promise(resolve=>navigator.geolocation.getCurrentPosition(p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude}),e=>resolve({error:e.message})))' }) as { value: { latitude?: number; longitude?: number; error?: string } }
    expect(coordinates.value.latitude).toBeCloseTo(37.4219)
    expect(coordinates.value.longitude).toBeCloseTo(-122.084)
    await call(h.client, 'setOffline', { page: pageId, state: 'on' })
    expect(await call(h.client, 'eval', { page: pageId, expression: 'navigator.onLine' })).toEqual({ value: false })
    await call(h.client, 'setOffline', { page: pageId, state: 'off' })
    await call(h.client, 'clipboardWrite', { page: pageId, text: 'private headless clipboard — ✅' })
    expect(await call(h.client, 'clipboardRead', { page: pageId })).toEqual({ text: 'private headless clipboard — ✅' })
    await expect(call(h.client, 'clipboardWrite', { page: pageId, text: 'x'.repeat(8193) })).rejects.toBeInstanceOf(Error)
    const isolated = await call(h.client, 'profileCreate', { name: 'Emulation rebind' }) as { profile: { id: string } }
    await call(h.client, 'tabProfileSet', { page: pageId, profile: isolated.profile.id })
    const rebound = await call(h.client, 'eval', { page: pageId, expression: '({width:innerWidth,height:innerHeight,dark:matchMedia(\"(prefers-color-scheme: dark)\").matches,motion:matchMedia(\"(prefers-reduced-motion: reduce)\").matches,userAgent:navigator.userAgent})' }) as { value: { width: number; height: number; dark: boolean; motion: boolean; userAgent: string } }
    expect(rebound.value).toMatchObject({ width: 390, height: 844, dark: true, motion: true })
    expect(rebound.value.userAgent).toContain('iPhone')
    expect(await call(h.client, 'eval', { page: pageId, expression: `fetch(${JSON.stringify(`${localBase}echo`)}).then(r=>r.json())` })).toEqual({ value: { value: 'header-value' } })
    expect(await call(h.client, 'eval', { page: neighbor.browserPageId, expression: `fetch(${JSON.stringify(`${localBase}echo`)}).then(r=>r.json())` })).toEqual({ value: { value: null } })

    const pending = call(h.client, 'eval', { page: pageId, expression: 'prompt(\"out-of-band\", \"default\")' })
    await dialogOpened.promise
    await call(h.client, 'dialogAccept', { page: pageId, text: 'Unicode answer — λ' })
    // bun 1.4.0 never ends a file whose test timed out inside expect(...).resolves, so await the evals directly
    expect(await pending).toEqual({ value: 'Unicode answer — λ' })
    dialogOpened = Promise.withResolvers<void>()
    const confirmation = call(h.client, 'eval', { page: pageId, expression: 'confirm(\"dismiss this dialog?\")' })
    await dialogOpened.promise
    await call(h.client, 'dialogDismiss', { page: pageId })
    expect(await confirmation).toEqual({ value: false })
    expect(await call(h.client, 'eval', { page: neighbor.browserPageId, expression: 'document.title' })).toEqual({ value: 'Events' })
  } finally {
    await h.cleanup()
    await responseServer.stop(true)
    await pageServer.stop(true)
  }
}, 60_000)

test('unwatched interception bypasses blocked navigations, isolates pages, replaces patterns, caps held requests and forgets aborts', async () => {
  const server = startCountedCorsServer()
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h)
    const pageId = page.browserPageId
    const base = server.url

    await expect(call(h.client, 'interceptEnable', { page: pageId, patterns: [] }))
      .rejects.toThrow(/invalid_argument: interception patterns must be a non-empty array of non-empty strings/)
    await expect(call(h.client, 'interceptEnable', { page: pageId, patterns: [''] }))
      .rejects.toThrow(/invalid_argument: interception patterns must be a non-empty array of non-empty strings/)
    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })

    const directUrl = `${base}slow-doc-direct`
    await call(h.client, 'interceptEnable', { page: pageId, patterns: ['*slow-doc*'] })
    const directNavigation = settle(call(h.client, 'goto', { page: pageId, url: directUrl }) as Promise<{ url: string }>)
    const directSnapshot = await waitFor(async () => {
      const started = Date.now()
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      expect(Date.now() - started).toBeLessThan(2_000)
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expect(directSnapshot.patterns).toEqual(['*slow-doc*'])
    expectHeldRequest(directSnapshot.requests[0]!, directUrl, 'Document')
    expect(server.count('/slow-doc-direct')).toBe(0)
    const directReleaseStarted = Date.now()
    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })
    expect(Date.now() - directReleaseStarted).toBeLessThan(2_000)
    const directResult = await directNavigation
    if (directResult.status === 'rejected') throw directResult.reason
    expect(directResult.value.url).toBe(directUrl)
    expect(server.count('/slow-doc-direct')).toBe(1)

    const execUrl = `${base}slow-doc-exec`
    await call(h.client, 'interceptEnable', { page: pageId, patterns: ['*slow-doc*'] })
    const execNavigation = settle(call(h.client, 'goto', { page: pageId, url: execUrl }) as Promise<{ url: string }>)
    const execList = await waitFor(async () => {
      const started = Date.now()
      const snapshot = await call(h.client, 'exec', { page: pageId, command: 'network intercepts' }) as {
        command: { path: string[]; positionals: string[]; flags: Record<string, unknown> }; result: InterceptList
      }
      expect(Date.now() - started).toBeLessThan(2_000)
      return snapshot.result.requests.length === 1 ? snapshot : null
    })
    expect(execList.command).toMatchObject({ path: ['network', 'intercepts'], positionals: [], flags: {} })
    expect(execList.result.patterns).toEqual(['*slow-doc*'])
    expect(execList.result.requests).toHaveLength(1)
    expectHeldRequest(execList.result.requests[0]!, execUrl, 'Document')
    expect(server.count('/slow-doc-exec')).toBe(0)
    const execReleaseStarted = Date.now()
    const execRelease = await call(h.client, 'exec', { page: pageId, command: 'network unroute' }) as {
      command: { path: string[]; positionals: string[]; flags: Record<string, unknown> }; result: { disabled: boolean }
    }
    expect(Date.now() - execReleaseStarted).toBeLessThan(2_000)
    expect(execRelease.command).toMatchObject({ path: ['network', 'unroute'], positionals: [], flags: {} })
    expect(execRelease.result).toEqual({ disabled: true })
    const execResult = await execNavigation
    if (execResult.status === 'rejected') throw execResult.reason
    expect(execResult.value.url).toBe(execUrl)
    expect(server.count('/slow-doc-exec')).toBe(1)
    const fifoGate = h.fixtureGate('intercept-fifo')
    const fifoUrl = `${h.fixtureUrl}gate/intercept-fifo`
    await call(h.client, 'interceptEnable', { page: pageId, patterns: ['*fifo-seed-never-matches*'] })
    const fifoState: {
      navigation?: Outcome<{ url: string }>
      enable?: Outcome<unknown>
      evaluation?: Outcome<unknown>
      disable?: Outcome<unknown>
    } = {}
    const fifoNavigation = settle(call(h.client, 'goto', { page: pageId, url: fifoUrl }) as Promise<{ url: string }>)
    void fifoNavigation.then((outcome) => { fifoState.navigation = outcome })
    try {
      await fifoGate.requested
      const queuedUrl = `${base}queued-held`
      void settle(call(h.client, 'interceptEnable', { page: pageId, patterns: ['*queued-held*'] }))
        .then((outcome) => { fifoState.enable = outcome })
      void settle(call(h.client, 'eval', { page: pageId, expression: fetchResultsExpression(queuedUrl) }))
        .then((outcome) => { fifoState.evaluation = outcome })
      void settle(call(h.client, 'interceptDisable', { page: pageId }))
        .then((outcome) => { fifoState.disable = outcome })
      await waitFor(async () => {
        const started = Date.now()
        const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
        expect(Date.now() - started).toBeLessThan(2_000)
        return snapshot.patterns.length === 0 ? snapshot : null
      }, 5_000)
      fifoGate.release()
      const releaseStarted = Date.now()
      await waitFor(() => fifoState.navigation && fifoState.enable && fifoState.evaluation && fifoState.disable ? true : null, 10_000)
      expect(Date.now() - releaseStarted).toBeLessThan(10_000)
      const navigationOutcome = fifoState.navigation!
      const enableOutcome = fifoState.enable!
      const evaluationOutcome = fifoState.evaluation!
      const disableOutcome = fifoState.disable!
      if (navigationOutcome.status === 'rejected') throw navigationOutcome.reason
      if (enableOutcome.status === 'rejected') throw enableOutcome.reason
      if (evaluationOutcome.status === 'rejected') throw evaluationOutcome.reason
      if (disableOutcome.status === 'rejected') throw disableOutcome.reason
      expect(navigationOutcome.value.url).toBe(fifoUrl)
      expect(enableOutcome.value).toEqual({ enabled: true, patterns: ['*queued-held*'] })
      expect(evaluationOutcome.value).toEqual({ value: 'body:/queued-held' })
      expect(disableOutcome.value).toEqual({ disabled: true })
      expect(server.count('/queued-held')).toBe(1)
      expect(await call(h.client, 'interceptList', { page: pageId })).toEqual({ patterns: [], requests: [] })
    } finally {
      fifoGate.release()
    }


    const neighbor = await newPage(h)
    const firstPatterns = ['*hold-one*', '*hold-two*']
    const firstUrls = [`${base}hold-one`, `${base}hold-two`]
    expect(await call(h.client, 'interceptEnable', { page: pageId, patterns: firstPatterns }))
      .toEqual({ enabled: true, patterns: firstPatterns })
    await call(h.client, 'eval', { page: pageId, expression: observeFetchesExpression(firstUrls, '__firstHeldResults') })
    const firstHeld = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      return snapshot.requests.length === 2 ? snapshot : null
    })
    expect(firstHeld.patterns).toEqual(firstPatterns)
    expect(firstHeld.requests.map((request) => request.url).sort()).toEqual(firstUrls.sort())
    expect(firstHeld.requests.map((request) => request.pending)).toEqual([true, true])
    expect(server.count('/hold-one')).toBe(0)
    expect(server.count('/hold-two')).toBe(0)

    expect(await call(h.client, 'eval', { page: neighbor.browserPageId, expression: fetchResultsExpression(firstUrls[0]!) }))
      .toEqual({ value: 'body:/hold-one' })
    expect(await call(h.client, 'interceptList', { page: neighbor.browserPageId })).toEqual({ patterns: [], requests: [] })
    expect(server.count('/hold-one')).toBe(1)
    expect((await call(h.client, 'eval', { page: pageId, expression: 'window.__firstHeldResults.length' })))
      .toEqual({ value: 0 })
    const stillHeld = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
    expect(stillHeld.requests.map((request) => request.id).sort())
      .toEqual(firstHeld.requests.map((request) => request.id).sort())

    const replacementPatterns = ['*hold-three*']
    const replacementUrl = `${base}hold-three`
    expect(await call(h.client, 'interceptEnable', { page: pageId, patterns: replacementPatterns }))
      .toEqual({ enabled: true, patterns: replacementPatterns })
    const replacedSnapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
    expect(replacedSnapshot.patterns).toEqual(replacementPatterns)
    expect(replacedSnapshot.requests.map((request) => request.id).sort())
      .toEqual(firstHeld.requests.map((request) => request.id).sort())
    expect(replacedSnapshot.requests.map((request) => request.url).sort()).toEqual(firstUrls.sort())
    expect(await call(h.client, 'eval', { page: pageId, expression: fetchResultsExpression(firstUrls[0]!) }))
      .toEqual({ value: 'body:/hold-one' })
    expect(server.count('/hold-one')).toBe(2)
    await call(h.client, 'eval', { page: pageId, expression: observeFetchesExpression([replacementUrl], '__replacementHeldResults') })
    const allHeld = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      return snapshot.requests.length === 3 ? snapshot : null
    })
    expect(allHeld.patterns).toEqual(replacementPatterns)
    expect(allHeld.requests.map((request) => request.url).sort()).toEqual([...firstUrls, replacementUrl].sort())
    expect(server.count('/hold-three')).toBe(0)
    const replacementRequest = allHeld.requests.find((request) => request.url === replacementUrl)
    expect(replacementRequest).toBeDefined()
    expectHeldRequest(replacementRequest!, replacementUrl)
    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })
    await waitFor(async () => {
      const firstResults = await call(h.client, 'eval', { page: pageId, expression: 'window.__firstHeldResults.length' }) as { value: number }
      const replacementResults = await call(h.client, 'eval', { page: pageId, expression: 'window.__replacementHeldResults.length' }) as { value: number }
      return firstResults.value === 2 && replacementResults.value === 1 &&
        server.count('/hold-one') === 3 && server.count('/hold-two') === 1 && server.count('/hold-three') === 1
        ? true : null
    })
    expect(await call(h.client, 'interceptList', { page: pageId })).toEqual({ patterns: [], requests: [] })
    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })

    await call(h.client, 'interceptEnable', { page: pageId, patterns: ['*hold-cap*'] })
    const capUrls = Array.from({ length: 1_001 }, (_, index) => `${base}hold-cap?i=${index}`)
    await call(h.client, 'eval', { page: pageId, expression: observeFetchesExpression(capUrls, '__capResults') })
    const capSnapshot = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      return snapshot.requests.length === 1_000 && server.count('/hold-cap') === 1 ? snapshot : null
    }, 10_000)
    expect(capSnapshot.patterns).toEqual(['*hold-cap*'])
    expect(new Set(capSnapshot.requests.map((request) => request.id)).size).toBe(1_000)
    expect(server.count('/hold-cap')).toBe(1)
    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })
    await waitFor(async () => {
      const results = await call(h.client, 'eval', { page: pageId, expression: 'window.__capResults.length' }) as { value: number }
      return results.value === 1_001 && server.count('/hold-cap') === 1_001 ? results : null
    }, 10_000)
    const capResults = await call(h.client, 'eval', { page: pageId, expression: 'window.__capResults' }) as { value: string[] }
    expect(capResults.value).toEqual(Array(1_001).fill('body:/hold-cap'))

    const abortUrl = `${base}hold-abort`
    await call(h.client, 'interceptEnable', { page: pageId, patterns: ['*hold-abort*'] })
    const startAbortFetch = `(() => { window.__abortController = new AbortController(); window.__abortResults = []; fetch(${JSON.stringify(abortUrl)}, { signal: window.__abortController.signal }).then(async response => window.__abortResults.push(await response.text()), error => window.__abortResults.push(error.name)); return true })()`
    await call(h.client, 'eval', { page: pageId, expression: startAbortFetch })
    const abortHeld = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expectHeldRequest(abortHeld.requests[0]!, abortUrl)
    expect(server.count('/hold-abort')).toBe(0)
    await call(h.client, 'eval', { page: pageId, expression: 'window.__abortController.abort(); true' })
    await waitFor(async () => {
      const result = await call(h.client, 'eval', { page: pageId, expression: 'window.__abortResults.length' }) as { value: number }
      return result.value === 1 ? result : null
    })
    const afterAbort = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: pageId }) as InterceptList
      return snapshot.requests.length === 0 ? snapshot : null
    }, 2_000)
    expect(afterAbort).toEqual({ patterns: ['*hold-abort*'], requests: [] })
    expect(await call(h.client, 'interceptDisable', { page: pageId })).toEqual({ disabled: true })
    expect(server.count('/hold-abort')).toBe(0)
    expect(await call(h.client, 'eval', { page: pageId, expression: '1 + 1' })).toEqual({ value: 2 })
  } finally {
    await h.cleanup()
    await server.stop()
  }
}, 120_000)

test('interception held requests are discarded on close, profile rebind and browser loss while patterns restore', async () => {
  const server = startCountedCorsServer()
  let control: { crashHelper(profileId: string): Promise<void> } | undefined
  const h = await startBrowserHarness({ onControl: (value) => { control = value } })
  try {
    const closePage = await newPage(h)
    const closeUrls = [`${server.url}hold-one`, `${server.url}hold-two`]
    const closePatterns = ['*hold-one*', '*hold-two*']
    await call(h.client, 'interceptEnable', { page: closePage.browserPageId, patterns: closePatterns })
    await call(h.client, 'eval', { page: closePage.browserPageId, expression: observeFetchesExpression(closeUrls, '__closeHeldResults') })
    const closeSnapshot = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: closePage.browserPageId }) as InterceptList
      return snapshot.requests.length === 2 ? snapshot : null
    })
    expect(closeSnapshot.patterns).toEqual(closePatterns)
    const closeStarted = Date.now()
    expect(await call(h.client, 'tabClose', { page: closePage.browserPageId, yes: true })).toEqual({ closed: true })
    expect(Date.now() - closeStarted).toBeLessThan(10_000)
    // allow cross-process traffic accidentally released during target close to reach the server
    await Bun.sleep(500)
    expect(server.count('/hold-one')).toBe(0)
    expect(server.count('/hold-two')).toBe(0)

    const reboundPage = await newPage(h)
    const isolated = await call(h.client, 'profileCreate', { name: 'Intercept rebind' }) as { profile: { id: string } }
    const rebindUrls = [`${server.url}hold-one`, `${server.url}hold-two`]
    await call(h.client, 'interceptEnable', { page: reboundPage.browserPageId, patterns: closePatterns })
    await call(h.client, 'eval', { page: reboundPage.browserPageId, expression: observeFetchesExpression(rebindUrls, '__rebindHeldResults') })
    const beforeRebind = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: reboundPage.browserPageId }) as InterceptList
      return snapshot.requests.length === 2 ? snapshot : null
    })
    expect(beforeRebind.patterns).toEqual(closePatterns)
    await call(h.client, 'tabProfileSet', { page: reboundPage.browserPageId, profile: isolated.profile.id })
    expect(await call(h.client, 'interceptList', { page: reboundPage.browserPageId }))
      .toEqual({ patterns: closePatterns, requests: [] })
    await call(h.client, 'eval', {
      page: reboundPage.browserPageId,
      expression: observeFetchesExpression([rebindUrls[0]!], '__reboundHeldResults')
    })
    const afterRebind = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: reboundPage.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expect(afterRebind.patterns).toEqual(closePatterns)
    expectHeldRequest(afterRebind.requests[0]!, rebindUrls[0]!)
    expect(server.count('/hold-one')).toBe(0)
    expect(await call(h.client, 'interceptDisable', { page: reboundPage.browserPageId })).toEqual({ disabled: true })
    await waitFor(() => server.count('/hold-one') === 1 ? true : null)

    const restorePage = await newPage(h, undefined, `${h.fixtureUrl}events`)
    const restoreUrl = `${h.fixtureUrl}events`
    await call(h.client, 'interceptEnable', { page: restorePage.browserPageId, patterns: ['*events*'] })
    await call(h.client, 'eval', {
      page: restorePage.browserPageId,
      expression: observeFetchesExpression([restoreUrl], '__lossHeldResults')
    })
    const beforeLoss = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: restorePage.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expect(beforeLoss.patterns).toEqual(['*events*'])
    expectHeldRequest(beforeLoss.requests[0]!, restoreUrl)
    expect(control).toBeDefined()
    await control!.crashHelper('default')
    const spawnCountBeforeList = h.spawnCount()
    expect(await call(h.client, 'interceptList', { page: restorePage.browserPageId }))
      .toEqual({ patterns: ['*events*'], requests: [] })
    expect(h.spawnCount()).toBe(spawnCountBeforeList)
    const restoreStarted = Date.now()
    const restoreResult = settle(call(h.client, 'eval', { page: restorePage.browserPageId, expression: 'location.href' }))
    expect(await call(h.client, 'interceptList', { page: restorePage.browserPageId }))
      .toEqual({ patterns: ['*events*'], requests: [] })
    const restored = await restoreResult
    if (restored.status === 'rejected') throw restored.reason
    expect(restored.value).toEqual({ value: restoreUrl })
    expect(Date.now() - restoreStarted).toBeLessThan(20_000)
    await call(h.client, 'eval', {
      page: restorePage.browserPageId,
      expression: observeFetchesExpression([restoreUrl], '__restoredHeldResults')
    })
    const restoredFetch = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: restorePage.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expect(restoredFetch.patterns).toEqual(['*events*'])
    expectHeldRequest(restoredFetch.requests[0]!, restoreUrl)
    expect(await call(h.client, 'interceptDisable', { page: restorePage.browserPageId })).toEqual({ disabled: true })
    await waitFor(async () => {
      const result = await call(h.client, 'eval', { page: restorePage.browserPageId, expression: 'window.__restoredHeldResults.length' }) as { value: number }
      return result.value === 1 ? result : null
    })
  } finally {
    await h.cleanup()
    await server.stop()
  }
}, 180_000)

test('Watch holds requests, stop retains interception, and a refused stale release leaves its lease live', async () => {
  const server = startCountedCorsServer()
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('intercept-watch')
    const page = await call(h.client, 'tabCreate', { worktree: `id:${worktree}`, url: `${h.fixtureUrl}events` }) as Page
    const pane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', page: page.browserPageId
    }) as { id: string; mode: string; page: string }
    expect(pane).toMatchObject({ mode: 'watch', page: page.browserPageId })
    const firstWatch = await call(h.client, 'paneWatch', { pane: pane.id }) as { watchId: string }

    const firstUrl = `${server.url}hold-one`
    await call(h.client, 'interceptEnable', { page: page.browserPageId, patterns: ['*hold-one*'] })
    const startHeldAndFree = `(() => { window.__watchHeldResults = []; fetch(${JSON.stringify(firstUrl)}).then(async response => window.__watchHeldResults.push(await response.text()), error => window.__watchHeldResults.push(error.name)); return fetch(${JSON.stringify(`${server.url}free`)}).then(response => response.text()) })()`
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: startHeldAndFree })).toEqual({ value: 'body:/free' })
    const watchedSnapshot = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: page.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expect(watchedSnapshot.patterns).toEqual(['*hold-one*'])
    expectHeldRequest(watchedSnapshot.requests[0]!, firstUrl)
    expect(server.count('/hold-one')).toBe(0)
    expect(await call(h.client, 'interceptDisable', { page: page.browserPageId })).toEqual({ disabled: true })
    await waitFor(async () => {
      const result = await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__watchHeldResults.length' }) as { value: number }
      return result.value === 1 && server.count('/hold-one') === 1 ? result : null
    })
    expect(await call(h.client, 'paneWatchStop', { pane: pane.id, watchId: firstWatch.watchId })).toEqual({ closed: true })

    const secondWatch = await call(h.client, 'paneWatch', { pane: pane.id }) as { watchId: string }
    await call(h.client, 'interceptEnable', { page: page.browserPageId, patterns: ['*hold-one*'] })
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: observeFetchesExpression([firstUrl], '__stoppedWatchResults')
    })
    const heldWhenWatching = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: page.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expectHeldRequest(heldWhenWatching.requests[0]!, firstUrl)
    expect(server.count('/hold-one')).toBe(1)
    expect(await call(h.client, 'paneWatchStop', { pane: pane.id, watchId: secondWatch.watchId })).toEqual({ closed: true })
    expect(await call(h.client, 'interceptList', { page: page.browserPageId })).toMatchObject({
      patterns: ['*hold-one*'], requests: [expect.objectContaining({ url: firstUrl, pending: true })]
    })
    expect(server.count('/hold-one')).toBe(1)
    expect(await call(h.client, 'interceptDisable', { page: page.browserPageId })).toEqual({ disabled: true })
    await waitFor(async () => {
      const result = await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__stoppedWatchResults.length' }) as { value: number }
      return result.value === 1 && server.count('/hold-one') === 2 ? result : null
    })

    const refusedWatch = await call(h.client, 'paneWatch', { pane: pane.id }) as { watchId: string }
    const refusedUrl = `${server.url}refused-release`
    await call(h.client, 'interceptEnable', { page: page.browserPageId, patterns: ['*refused-release*'] })
    const startAbort = `(() => { window.__refusedController = new AbortController(); window.__refusedResults = []; fetch(${JSON.stringify(refusedUrl)}, { signal: window.__refusedController.signal }).then(async response => window.__refusedResults.push(await response.text()), error => window.__refusedResults.push(error.name)); return true })()`
    await call(h.client, 'eval', { page: page.browserPageId, expression: startAbort })
    const heldBeforeAbort = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: page.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expectHeldRequest(heldBeforeAbort.requests[0]!, refusedUrl)
    await call(h.client, 'eval', { page: page.browserPageId, expression: 'window.__refusedController.abort(); true' })
    expect(await call(h.client, 'interceptDisable', { page: page.browserPageId })).toEqual({ disabled: true })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.title' })).toEqual({ value: 'Events' })
    expect(await call(h.client, 'paneWatchStop', { pane: pane.id, watchId: refusedWatch.watchId })).toEqual({ closed: true })
    expect(server.count('/refused-release')).toBe(0)
    const rebindWatch = await call(h.client, 'paneWatch', { pane: pane.id }) as { watchId: string }
    expect(rebindWatch.watchId.length).toBeGreaterThan(0)
    const rebindProfile = await call(h.client, 'profileCreate', { name: 'Watch interception rebind' }) as { profile: { id: string } }
    const rebindUrl = `${server.url}watch-rebind`
    await call(h.client, 'interceptEnable', { page: page.browserPageId, patterns: ['*watch-rebind*'] })
    await call(h.client, 'eval', {
      page: page.browserPageId,
      expression: observeFetchesExpression([rebindUrl], '__watchRebindResults')
    })
    const heldBeforeWatchRebind = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: page.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expectHeldRequest(heldBeforeWatchRebind.requests[0]!, rebindUrl)
    expect(server.count('/watch-rebind')).toBe(0)
    await call(h.client, 'tabProfileSet', { page: page.browserPageId, profile: rebindProfile.profile.id })
    expect(await call(h.client, 'interceptList', { page: page.browserPageId }))
      .toEqual({ patterns: ['*watch-rebind*'], requests: [] })
    // allow cross-process traffic accidentally released during profile change to reach the server
    await Bun.sleep(500)
    expect(server.count('/watch-rebind')).toBe(0)

    const closingPage = await call(h.client, 'tabCreate', {
      worktree: `id:${worktree}`, url: `${h.fixtureUrl}events`
    }) as Page
    const closingPane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', page: closingPage.browserPageId
    }) as { id: string }
    await call(h.client, 'paneWatch', { pane: closingPane.id })
    const closingUrl = `${server.url}watch-close`
    await call(h.client, 'interceptEnable', { page: closingPage.browserPageId, patterns: ['*watch-close*'] })
    await call(h.client, 'eval', {
      page: closingPage.browserPageId,
      expression: observeFetchesExpression([closingUrl], '__watchCloseResults')
    })
    const heldBeforeWatchClose = await waitFor(async () => {
      const snapshot = await call(h.client, 'interceptList', { page: closingPage.browserPageId }) as InterceptList
      return snapshot.requests.length === 1 ? snapshot : null
    })
    expectHeldRequest(heldBeforeWatchClose.requests[0]!, closingUrl)
    expect(server.count('/watch-close')).toBe(0)
    const watchCloseStarted = Date.now()
    expect(await call(h.client, 'tabClose', { page: closingPage.browserPageId, yes: true })).toEqual({ closed: true })
    expect(Date.now() - watchCloseStarted).toBeLessThan(10_000)
    // allow cross-process traffic accidentally released during Watch close to reach the server
    await Bun.sleep(500)
    expect(server.count('/watch-close')).toBe(0)

  } finally {
    await h.cleanup()
    await server.stop()
  }
}, 120_000)

test('SC4 rollback: a failed cookie clone restores every destination identity', async () => {
  let destinationId = ''
  let destinationWrites = 0
  const h = await startBrowserHarness({
    wrapCookieTransport(transport) {
      return {
        ...transport,
        async set(profileId, cookie) {
          if (profileId === destinationId && ++destinationWrites === 2) throw new Error('injected clone write failure')
          await transport.set(profileId, cookie)
        }
      }
    }
  })
  try {
    const sourceProfile = await call(h.client, 'profileCreate', { name: 'Rollback source' }) as { profile: { id: string } }
    const destination = await call(h.client, 'profileCreate', { name: 'Rollback destination' }) as { profile: { id: string } }
    destinationId = destination.profile.id
    const source = await newPage(h, sourceProfile.profile.id)
    await call(h.client, 'cookieSet', { page: source.browserPageId, name: 'rollback-one', value: 'one', url: h.fixtureUrl })
    await call(h.client, 'cookieSet', { page: source.browserPageId, name: 'rollback-two', value: 'two', url: h.fixtureUrl })
    await expect(call(h.client, 'profileClone', { source: source.browserPageId, profile: destinationId })).rejects.toBeInstanceOf(Error)

    const destinationPage = await newPage(h, destinationId)
    const remaining = (await call(h.client, 'cookieGet', { page: destinationPage.browserPageId }) as { cookies: Cookie[] }).cookies
    expect(remaining.filter((cookie) => cookie.name.startsWith('rollback-'))).toEqual([])
  } finally { await h.cleanup() }
}, 120_000)
