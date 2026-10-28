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

test('SC6-SC7: HAR, multiple intercept patterns, headers, emulation, clipboard and out-of-band dialog response are real', async () => {
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

    await call(h.client, 'interceptEnable', { page: pageId, patterns: ['*intercept-one*', '*intercept-two*'] })
    await call(h.client, 'eval', { page: pageId, expression: `Promise.all([fetch(${JSON.stringify(`${localBase}intercept-one`)}),fetch(${JSON.stringify(`${localBase}intercept-two`)})]).then(()=>true)` })
    const intercepts = await call(h.client, 'interceptList', { page: pageId }) as { patterns: string[]; requests: Array<{ url: string }> }
    expect(intercepts.patterns).toEqual(['*intercept-one*', '*intercept-two*'])
    expect(intercepts.requests.map((request) => request.url)).toEqual(expect.arrayContaining([`${localBase}intercept-one`, `${localBase}intercept-two`]))
    await call(h.client, 'interceptDisable', { page: pageId })
    await call(h.client, 'eval', { page: pageId, expression: `fetch(${JSON.stringify(`${localBase}intercept-one`)}).then(r=>r.text())` })
    const afterDisable = await call(h.client, 'interceptList', { page: pageId }) as { requests: Array<{ url: string }> }
    expect(afterDisable.requests).toHaveLength(intercepts.requests.length)

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
    await expect(pending).resolves.toEqual({ value: 'Unicode answer — λ' })
    dialogOpened = Promise.withResolvers<void>()
    const confirmation = call(h.client, 'eval', { page: pageId, expression: 'confirm(\"dismiss this dialog?\")' })
    await dialogOpened.promise
    await call(h.client, 'dialogDismiss', { page: pageId })
    await expect(confirmation).resolves.toEqual({ value: false })
    expect(await call(h.client, 'eval', { page: neighbor.browserPageId, expression: 'document.title' })).toEqual({ value: 'Events' })
  } finally {
    await h.cleanup()
    await responseServer.stop(true)
    await pageServer.stop(true)
  }
}, 180_000)

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
