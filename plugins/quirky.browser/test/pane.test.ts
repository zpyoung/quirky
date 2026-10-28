import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { basename, dirname, join } from 'node:path'
import { expect, test } from 'bun:test'
import type { QuirkyEvent } from '@quirky/protocol'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { PaneFrame, PaneState, PaneTab } from '../src/pane-contract'
type CertificateServer = { port: number; stop(): Promise<void> }

const call = (h: BrowserTestHarness, name: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${name}`, params)

function startPageServer() {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/auth') {
        const credentials = Buffer.from('pane-user:auth-secret').toString('base64')
        if (request.headers.get('authorization') === `Basic ${credentials}`) {
          return new Response('<!doctype html><title>Authenticated</title><main>authorized</main>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        return new Response('authentication required', {
          status: 401,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="Pane fixture"' }
        })
      }
      if (path === '/page') return new Response(`<!doctype html><title>Pane fixture</title><body style="margin:0"><input id="text" value=""><button id="button">Button</button><p>needle needle needle</p></body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (path === '/dialog') return new Response('<!doctype html><title>Dialog fixture</title><main>dialog</main>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (path === '/download') return new Response('owned download contents', {
        headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="safe.txt"' }
      })
      if (path === '/unsafe-download') return new Response('owned unsafe-name download', {
        headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="../../unsafe.txt"' }
      })
      if (path === '/download-page') return new Response('<!doctype html><title>Download</title><a id="safe" href="/download">Download fixture</a><a id="unsafe" href="/unsafe-download">Unsafe name fixture</a>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
      return new Response('not found', { status: 404 })
    }
  })
  return { url: server.url.href, stop: () => server.stop(true) }
}
async function startCertificateServer(h: BrowserTestHarness) {
  const keyPath = join(h.home, 'pane-test-key.pem')
  const certPath = join(h.home, 'pane-test-cert.pem')
  const child = h.scope.spawn([
    '/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=example.test'
  ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`test certificate generation failed with exit code ${exitCode}`)
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Certificate accepted</title>')
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test certificate server did not bind a TCP port')
  return {
    port: address.port,
    async stop() {
      const closed = Promise.withResolvers<void>()
      server.close((error) => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
  }
}

async function waitFor<T>(read: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 12_000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await read()
    if (value != null) return value
    // Real CDP frames, timer-driven downloads and prompt callbacks need an event-loop turn.
    await Bun.sleep(20)
  }
  throw new Error(`pane fixture condition did not become true within ${timeoutMs}ms`)
}

function paneFrame(event: QuirkyEvent): PaneFrame | undefined {
  if (event.type !== 'quirky.browser/paneFrame' || !('data' in event)) return undefined
  const data = event.data
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as PaneFrame : undefined
}

async function createAgentPage(h: BrowserTestHarness, worktree: string, url: string) {
  return await call(h, 'tabCreate', { worktree: `id:${worktree}`, url }) as { browserPageId: string }
}

test('pane navigation normalizes safely, persists bounded recency history, and keeps Native browsing Chrome-free', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-native')
    const worktreePath = realpathSync(join(h.home, 'projects', 'pane-native'))
    writeFileSync(join(worktreePath, 'local-document.txt'), 'safe local page')
    writeFileSync(join(worktreePath, 'suggested-document.txt'), 'workspace suggestion')
    writeFileSync(join(worktreePath, 'local-page.html'), '<!doctype html><title>Local</title>')
    const outsideHtml = join(h.home, 'outside.html')
    writeFileSync(outsideHtml, '<!doctype html><title>Outside explicit file</title>')
    const ipv4 = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: '127.0.0.1:3000' }) as { url: string }
    const ipv6 = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: '[::1]:3000' }) as { url: string }
    const localHost = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: 'app.localhost:8080' }) as { url: string }
    expect(ipv4.url).toBe('http://127.0.0.1:3000/')
    expect(ipv6.url).toBe('http://[::1]:3000/')
    expect(localHost.url).toBe('http://app.localhost:8080/')
    const local = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: join(worktreePath, 'local-document.txt') }) as { url: string; preview?: { path: string } }
    expect(local.preview?.path).toBe(join(worktreePath, 'local-document.txt'))
    expect(local.url.startsWith('http://127.0.0.1:')).toBe(true)
    const localHtml = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: join(worktreePath, 'local-page.html') }) as { url: string; sourcePath?: string }
    const outsideHtmlPane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: outsideHtml }) as { url: string; sourcePath?: string }
    const missingHtml = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: join(worktreePath, 'missing.html') }) as { url: string; error: string | null }
    expect(localHtml.url.startsWith('file:')).toBe(true)
    expect(localHtml.sourcePath).toBe(join(worktreePath, 'local-page.html'))
    expect(outsideHtmlPane.url.startsWith('file:')).toBe(true)
    expect(outsideHtmlPane.sourcePath).toBeUndefined()
    expect(missingHtml.url.startsWith('file:')).toBe(true)
    expect(missingHtml.error).toContain('does not exist')
    const documents = await call(h, 'paneSuggestions', { worktree: `id:${worktree}`, query: 'suggested-document' }) as { suggestions: Array<{ kind: string; url: string }> }
    expect(documents.suggestions.some((suggestion) => suggestion.kind === 'document' && suggestion.url.startsWith('file:'))).toBe(true)
    expect(h.spawnCount()).toBe(0)
    const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: 'localhost:3000' }) as { id: string; url: string; mode: string; tabId?: string }
    expect(pane).toMatchObject({ url: 'http://localhost:3000/', mode: 'native' })
    expect(pane.tabId).toBeTruthy()
    expect(h.spawnCount()).toBe(0)

    const searchPane = await call(h, 'paneOpen', { worktree: `id:${worktree}` }) as { id: string; tabId: string }
    const searching = await call(h, 'paneNavigate', { pane: searchPane.id, input: 'hello world' }) as { command: { id: string; url: string } }
    expect(searching.command.url).toBe('https://www.google.com/search?q=hello+world')
    await call(h, 'paneReport', { pane: searchPane.id, tabId: searchPane.tabId, command: searching.command.id, url: searching.command.url, title: 'Search', loading: false })

    const beforeUnsafe = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { history: Array<{ url: string }> }
    await expect(call(h, 'paneNavigate', { pane: searchPane.id, input: 'javascript:alert(1)' })).rejects.toBeInstanceOf(Error)
    await expect(call(h, 'paneNavigate', { pane: searchPane.id, input: 'data:text/html,hello' })).rejects.toBeInstanceOf(Error)
    await expect(call(h, 'paneNavigate', { pane: searchPane.id, input: 'file:///etc/passwd' })).rejects.toBeInstanceOf(Error)
    const afterUnsafe = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { history: Array<{ url: string }> }
    expect(afterUnsafe.history).toEqual(beforeUnsafe.history)

    const stale = await call(h, 'paneNavigate', { pane: searchPane.id, input: 'example.com/old' }) as { command: { id: string; url: string } }
    const latest = await call(h, 'paneNavigate', { pane: searchPane.id, input: 'example.com/new' }) as { command: { id: string; url: string } }
    await expect(call(h, 'paneReport', { pane: searchPane.id, tabId: searchPane.tabId, command: stale.command.id, url: stale.command.url, title: 'Stale', loading: false })).rejects.toBeInstanceOf(Error)
    await call(h, 'paneReport', { pane: searchPane.id, tabId: searchPane.tabId, command: latest.command.id, url: latest.command.url, title: 'Latest', loading: false })

    const credentials = await call(h, 'paneNavigate', { pane: searchPane.id, input: 'https://user:secret@kagi.com/search?q=private&token=session-secret' }) as { command: { id: string; url: string } }
    expect(credentials.command.url).not.toContain('user:secret')
    expect(credentials.command.url).not.toContain('session-secret')
    await call(h, 'paneReport', { pane: searchPane.id, tabId: searchPane.tabId, command: credentials.command.id, url: credentials.command.url, title: 'Private query', loading: false })

    for (let index = 0; index < 205; index++) {
      const next = await call(h, 'paneNavigate', { pane: searchPane.id, input: `https://example.com/history/${index}` }) as { command: { id: string; url: string } }
      await call(h, 'paneReport', { pane: searchPane.id, tabId: searchPane.tabId, command: next.command.id, url: next.command.url, title: `History ${index}`, loading: false })
    }
    const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { history: Array<{ url: string; title: string }> }
    expect(state.history).toHaveLength(200)
    expect(state.history.some((item) => item.url.endsWith('/history/0'))).toBe(false)
    expect(state.history[0]?.url).toBe('https://example.com/history/204')
    expect(JSON.stringify(state.history)).not.toContain('session-secret')
    expect((await call(h, 'paneSuggestions', { worktree: `id:${worktree}`, query: 'example.com/history/204' }) as { suggestions: Array<{ kind: string; url: string }> }).suggestions.length).toBeLessThanOrEqual(8)
    expect((await call(h, 'paneSuggestions', { worktree: `id:${worktree}`, query: 'x'.repeat(2049) }) as { suggestions: unknown[] }).suggestions).toHaveLength(0)
    expect(h.spawnCount()).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 90_000)

test('Watch leases deliver acknowledged latest frames and typed input/find/zoom/viewport stay on the exact page', async () => {
  const h = await startBrowserHarness()
  const fixture = startPageServer()
  const events: QuirkyEvent[] = []
  try {
    const worktree = await h.addFolderWorktree('pane-watch')
    await h.client.call('events.subscribe', {})
    const unsubscribe = h.client.onEvent((event) => events.push(event))
    try {
      const first = await createAgentPage(h, worktree, `${fixture.url}page`)
      const second = await createAgentPage(h, worktree, `${fixture.url}page`)
      const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, mode: 'watch', page: first.browserPageId }) as { id: string; mode: string; page: string; tabId?: string }
      expect(pane).toMatchObject({ mode: 'watch', page: first.browserPageId })
      expect(pane.tabId).toBeTruthy()

      const watch = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      const firstFrame = await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === watch.watchId))
      const encodedFrame = Buffer.from(firstFrame.data, 'base64')
      expect([...encodedFrame.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
      expect(firstFrame.width).toBeGreaterThan(0)
      expect(firstFrame.height).toBeGreaterThan(0)
      await call(h, 'eval', { page: first.browserPageId, expression: 'document.body.style.backgroundColor = "rgb(18, 52, 86)"' })
      await Bun.sleep(350)
      expect(events.map(paneFrame).filter((frame) => frame?.watchId === watch.watchId)).toHaveLength(1)

      await call(h, 'paneFrameAck', { pane: pane.id, watchId: watch.watchId, sequence: firstFrame.sequence })
      // CDP only captures damaged frames; a static page need not emit another image.
      expect(await call(h, 'eval', {
        page: first.browserPageId,
        expression: "document.body.style.backgroundColor='rgb(230,20,20)'; (() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(() => resolve('repainted'))); return promise })()"
      })).toEqual({ value: 'repainted' })
      const nextFrame = await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === watch.watchId && frame.sequence !== firstFrame.sequence))
      expect(nextFrame.sequence).toBeGreaterThan(firstFrame.sequence)

      await call(h, 'paneInput', { pane: pane.id, kind: 'mouse', type: 'mousePressed', x: 45, y: 16, button: 'left' })
      await call(h, 'paneInput', { pane: pane.id, kind: 'mouse', type: 'mouseReleased', x: 45, y: 16, button: 'left' })
      await call(h, 'paneInput', { pane: pane.id, kind: 'text', text: 'only-the-watched-page' })
      expect(await call(h, 'eval', { page: first.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'only-the-watched-page' })
      expect(await call(h, 'eval', { page: second.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: '' })

      await call(h, 'eval', {
        page: first.browserPageId,
        expression: 'window.__watchFindTextNode = document.querySelector("p").firstChild; true'
      })
      const find = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle' }) as { find: { current: number; total: number } }
      expect(find.find.total).toBe(3)
      expect(find.find.current).toBe(1)
      expect(await call(h, 'eval', {
        page: first.browserPageId,
        expression: 'window.__watchFindTextNode === document.querySelector("p").firstChild && window.getSelection()?.toString() === "needle" && window.getSelection()?.getRangeAt(0).startOffset === 0'
      })).toEqual({ value: true })
      expect(await call(h, 'eval', {
        page: second.browserPageId,
        expression: 'window.getSelection()?.rangeCount === 0'
      })).toEqual({ value: true })
      const nextFind = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle', forward: true }) as { find: { current: number; total: number } }
      expect(nextFind.find).toMatchObject({ current: 2, total: 3 })
      const previousFind = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle', forward: false }) as { find: { current: number; total: number } }
      expect(previousFind.find).toMatchObject({ current: 1, total: 3 })
      const previousWrap = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle', forward: false }) as { find: { current: number; total: number } }
      expect(previousWrap.find).toMatchObject({ current: 3, total: 3 })
      const nextWrap = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle', forward: true }) as { find: { current: number; total: number } }
      expect(nextWrap.find).toMatchObject({ current: 1, total: 3 })
      const advanceBeforeChange = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle', forward: true }) as { find: { current: number; total: number } }
      expect(advanceBeforeChange.find).toMatchObject({ current: 2, total: 3 })
      const changedFind = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'dle' }) as { find: { current: number; total: number } }
      expect(changedFind.find).toMatchObject({ current: 1, total: 3 })
      const clearedFind = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: '' }) as { find: { current: number; total: number } }
      expect(clearedFind.find).toMatchObject({ current: 0, total: 0 })
      expect(await call(h, 'eval', {
        page: first.browserPageId,
        expression: 'window.__watchFindTextNode === document.querySelector("p").firstChild && window.getSelection()?.rangeCount === 0'
      })).toEqual({ value: true })
      const zoom = await call(h, 'paneControl', { pane: pane.id, action: 'zoom', level: 1 }) as { zoom: number }
      expect(zoom.zoom).toBe(1)
      const viewport = await call(h, 'paneControl', { pane: pane.id, action: 'viewport', preset: 'mobile-m' }) as { viewport: string }
      expect(viewport.viewport).toBe('mobile-m')

      const stop = await call(h, 'paneWatchStop', { pane: pane.id, watchId: watch.watchId }) as { closed: boolean }
      expect(stop.closed).toBe(true)
      await Bun.sleep(180)
      const countAfterStop = events.map(paneFrame).filter((frame) => frame?.watchId === watch.watchId).length
      await Bun.sleep(180)
      expect(events.map(paneFrame).filter((frame) => frame?.watchId === watch.watchId)).toHaveLength(countAfterStop)

      const resumed = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      expect(resumed.watchId).not.toBe(watch.watchId)
      await call(h, 'tabClose', { page: first.browserPageId, yes: true })
      const ended = await waitFor(async () => {
        const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { tabs: Array<{ id: string; error: string | null }> }
        return state.tabs.find((tab) => tab.id === pane.id)?.error
      })
      expect(ended).toContain('closed')
      await expect(call(h, 'paneFrameAck', { pane: pane.id, watchId: resumed.watchId, sequence: 1 })).rejects.toBeInstanceOf(Error)
    } finally {
      unsubscribe()
    }
  } finally {
    fixture.stop()
    await h.cleanup()
  }
}, 90_000)

test('profileSet rebinds a Watch pane to isolated managed pages and retires the previous lease', async () => {
  const h = await startBrowserHarness()
  const events: QuirkyEvent[] = []
  try {
    const worktree = await h.addFolderWorktree('pane-watch-profiles')
    await h.client.call('events.subscribe', {})
    const unsubscribe = h.client.onEvent((event) => events.push(event))
    try {
      const profileA = ((await call(h, 'profileCreate', { name: 'Owned A' }) as { profile: { id: string } }).profile).id
      const profileB = ((await call(h, 'profileCreate', { name: 'Owned B' }) as { profile: { id: string } }).profile).id
      const original = await call(h, 'tabCreate', {
        worktree: `id:${worktree}`, profile: profileA, url: `${h.fixtureUrl}events`
      }) as { browserPageId: string }
      await call(h, 'eval', {
        page: original.browserPageId,
        expression: "localStorage.setItem('lane8-profile', 'owned-A'); document.cookie='lane8-cookie=owned-A; path=/'; document.title"
      })
      const pane = await call(h, 'paneOpen', {
        worktree: `id:${worktree}`, mode: 'watch', page: original.browserPageId
      }) as { id: string; tabId: string; worktreeId: string; url: string }
      const oldLease = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      const oldFrame = await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === oldLease.watchId))

      const switched = (await call(h, 'profileSet', { pane: pane.id, profile: profileB }) as { pane: PaneTab }).pane
      expect(switched).toMatchObject({
        id: pane.id, tabId: pane.tabId, worktreeId: pane.worktreeId, mode: 'watch', url: pane.url,
        profileId: profileB, partition: `persist:quirky-browser-${profileB}`,
        title: 'Events', loading: false, error: null
      })
      expect(switched.page).not.toBe(original.browserPageId)
      const pageB = (await call(h, 'tabShow', { page: switched.page! }) as { tab: { browserPageId: string; worktreeId: string; profileId: string } }).tab
      expect(pageB).toMatchObject({ browserPageId: switched.page, worktreeId: worktree, profileId: profileB })
      expect(await call(h, 'eval', { page: switched.page!, expression: "localStorage.getItem('lane8-profile')" })).toEqual({ value: null })
      expect(await call(h, 'eval', { page: switched.page!, expression: 'document.cookie' })).toEqual({ value: '' })
      await expect(call(h, 'paneFrameAck', {
        pane: pane.id, watchId: oldLease.watchId, sequence: oldFrame.sequence
      })).rejects.toBeInstanceOf(Error)

      const newLease = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      expect(newLease.watchId).not.toBe(oldLease.watchId)
      const newFrame = await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === newLease.watchId))
      const afterSwitch = await call(h, 'paneState') as PaneState
      const watchedB = afterSwitch.tabs.find((tab) => tab.id === pane.id)!
      expect(watchedB.page).toBe(switched.page)
      expect(await call(h, 'paneFrameAck', {
        pane: pane.id, watchId: newLease.watchId, sequence: newFrame.sequence
      })).toEqual({ acknowledged: true })

      const restoredSelection = (await call(h, 'profileSet', { pane: pane.id, profile: profileA }) as { pane: PaneTab }).pane
      expect(restoredSelection).toMatchObject({
        id: pane.id, tabId: pane.tabId, worktreeId: pane.worktreeId, mode: 'watch', url: pane.url,
        profileId: profileA, partition: `persist:quirky-browser-${profileA}`,
        title: 'Events', loading: false, error: null
      })
      expect(restoredSelection.page).not.toBe(switched.page)
      const pageA = (await call(h, 'tabShow', { page: restoredSelection.page! }) as { tab: { browserPageId: string; worktreeId: string; profileId: string } }).tab
      expect(pageA).toMatchObject({ browserPageId: restoredSelection.page, worktreeId: worktree, profileId: profileA })
      expect(await call(h, 'eval', { page: restoredSelection.page!, expression: "localStorage.getItem('lane8-profile')" })).toEqual({ value: 'owned-A' })
      expect(await call(h, 'eval', { page: restoredSelection.page!, expression: 'document.cookie' })).toEqual({ value: 'lane8-cookie=owned-A' })
      expect(await call(h, 'eval', { page: original.browserPageId, expression: "localStorage.getItem('lane8-profile')" })).toEqual({ value: 'owned-A' })
      const restoredLease = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
      const restoredFrame = await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === restoredLease.watchId))
      const afterRestore = await call(h, 'paneState') as PaneState
      const restored = afterRestore.tabs.find((tab) => tab.id === pane.id)!
      expect(restored.page).toBe(restoredSelection.page)
      expect(await call(h, 'paneFrameAck', {
        pane: pane.id, watchId: restoredLease.watchId, sequence: restoredFrame.sequence
      })).toEqual({ acknowledged: true })
      await call(h, 'paneClose', { pane: pane.id })
    } finally {
      unsubscribe()
    }
  } finally {
    await h.cleanup()
  }
}, 90_000)

test('profileSet closes only its prepared target page when its pane closes during preparation', async () => {
  const requested = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let profileLoads = 0
  const fixture = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/favicon.ico') return new Response(null, { status: 204 })
      if (path !== '/profile') return new Response('not found', { status: 404 })
      profileLoads++
      if (profileLoads === 2) {
        requested.resolve()
        await released.promise
      }
      return new Response('<!doctype html><title>Profile fixture</title><main>profile</main>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }
  })
  let h: BrowserTestHarness | undefined
  let unsubscribe: (() => void) | undefined
  let switching: Promise<unknown> | undefined
  try {
    h = await startBrowserHarness()
    const worktree = await h.addFolderWorktree('pane-profile-switch-close')
    await h.client.call('events.subscribe', {})
    unsubscribe = h.client.onEvent(() => {})
    const profileA = ((await call(h, 'profileCreate', { name: 'Close race A' }) as { profile: { id: string } }).profile).id
    const profileB = ((await call(h, 'profileCreate', { name: 'Close race B' }) as { profile: { id: string } }).profile).id
    const original = await call(h, 'tabCreate', {
      worktree: `id:${worktree}`, profile: profileA, url: `${fixture.url}profile`
    }) as { browserPageId: string }
    const pane = await call(h, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', page: original.browserPageId
    }) as { id: string }
    await call(h, 'paneWatch', { pane: pane.id })

    switching = call(h, 'profileSet', { pane: pane.id, profile: profileB })
    await requested.promise
    await call(h, 'paneClose', { pane: pane.id })
    released.resolve()
    await expect(switching).rejects.toBeInstanceOf(Error)

    const state = await call(h, 'paneState') as PaneState
    expect(state.tabs.some((tab) => tab.id === pane.id)).toBe(false)
    const pages = await call(h, 'tabList', { worktree: `id:${worktree}` }) as { tabs: Array<{ browserPageId: string }> }
    expect(pages.tabs.map((page) => page.browserPageId)).toEqual([original.browserPageId])
    expect(await call(h, 'eval', { page: original.browserPageId, expression: 'document.title' })).toEqual({ value: 'Profile fixture' })
  } finally {
    released.resolve()
    if (switching) await switching.catch(() => undefined)
    unsubscribe?.()
    try { fixture.stop(true) } finally { await h?.cleanup() }
  }
}, 90_000)

test('Watch JavaScript dialogs resolve pending eval outside the profile lock and downloads use collision-safe owned names', async () => {
  const h = await startBrowserHarness({
    chromeArguments: ['--use-mock-keychain', '--host-resolver-rules=MAP example.test 127.0.0.1']
  })
  const fixture = startPageServer()
  let certificate: CertificateServer | undefined
  try {
    certificate = await startCertificateServer(h)
    const worktree = await h.addFolderWorktree('pane-events')
    await h.client.call('events.subscribe', {})
    const dialogPage = await createAgentPage(h, worktree, `${fixture.url}dialog`)
    const dialogPane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, mode: 'watch', page: dialogPage.browserPageId }) as { id: string }
    await call(h, 'paneWatch', { pane: dialogPane.id })

    const pendingEval = call(h, 'eval', { page: dialogPage.browserPageId, expression: 'alert("watch dialog"); "continued"' })
    const dialog = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { tabs: Array<{ id: string; prompts: Array<{ id: string; kind: string; message: string }> }> }
      return state.tabs.find((tab) => tab.id === dialogPane.id)?.prompts.find((prompt) => prompt.kind === 'alert')
    })
    expect(dialog.message).toBe('watch dialog')
    await call(h, 'paneRespond', { pane: dialogPane.id, prompt: dialog.id, accept: true })
    expect(await pendingEval).toEqual({ value: 'continued' })
    const authNavigation = call(h, 'paneNavigate', { pane: dialogPane.id, input: `${fixture.url}auth` }) as Promise<{ title: string; error: string | null }>
    const authPrompt = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { tabs: Array<{ id: string; prompts: Array<{ id: string; kind: string; message: string }> }> }
      return state.tabs.find((tab) => tab.id === dialogPane.id)?.prompts.find((prompt) => prompt.kind === 'auth')
    })
    expect(authPrompt.message).toContain('Pane fixture')
    await call(h, 'paneRespond', { pane: dialogPane.id, prompt: authPrompt.id, accept: true, username: 'pane-user', password: 'auth-secret' })
    const authResult = await authNavigation
    expect(authResult.title).toBe('Authenticated')
    const authState = await call(h, 'paneState', { worktree: `id:${worktree}` })
    expect(JSON.stringify(authState)).not.toContain('auth-secret')

    const remoteNavigation = call(h, 'paneNavigate', {
      pane: dialogPane.id,
      input: `https://example.test:${certificate.port}/secure`
    }) as Promise<{ title: string; error: string | null }>
    const remoteCertificate = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { tabs: Array<{ id: string; prompts: Array<{ id: string; kind: string; canProceed?: boolean }> }> }
      return state.tabs.find((tab) => tab.id === dialogPane.id)?.prompts.find((prompt) => prompt.kind === 'certificate')
    })
    expect(remoteCertificate.canProceed).toBe(false)
    await expect(call(h, 'paneRespond', { pane: dialogPane.id, prompt: remoteCertificate.id, accept: true })).rejects.toBeInstanceOf(Error)
    const remoteResult = await remoteNavigation.then((value) => ({ value }), (error: unknown) => ({ error }))
    if ('value' in remoteResult) expect(remoteResult.value.error).toBeTruthy()
    else expect(remoteResult.error).toBeInstanceOf(Error)

    const loopbackNavigation = call(h, 'paneNavigate', {
      pane: dialogPane.id,
      input: `https://127.0.0.1:${certificate.port}/secure`
    }) as Promise<{ title: string; error: string | null }>
    const loopbackCertificate = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { tabs: Array<{ id: string; prompts: Array<{ id: string; kind: string; canProceed?: boolean }> }> }
      return state.tabs.find((tab) => tab.id === dialogPane.id)?.prompts.find((prompt) => prompt.kind === 'certificate')
    })
    expect(loopbackCertificate.canProceed).toBe(true)
    await call(h, 'paneRespond', { pane: dialogPane.id, prompt: loopbackCertificate.id, accept: true })
    const loopbackResult = await loopbackNavigation
    expect(loopbackResult).toMatchObject({ title: 'Certificate accepted', error: null })

    const downloads = join(h.home, 'Downloads')
    mkdirSync(downloads, { recursive: true })
    writeFileSync(join(downloads, 'safe.txt'), 'keep existing file')
    const downloadPage = await createAgentPage(h, worktree, `${fixture.url}download-page`)
    const downloadPane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, mode: 'watch', page: downloadPage.browserPageId }) as { id: string }
    await call(h, 'paneWatch', { pane: downloadPane.id })
    await call(h, 'click', { page: downloadPage.browserPageId, element: '#safe' })
    const downloaded = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as PaneState
      return state.tabs.find((tab) => tab.id === downloadPane.id)?.downloads.find((download) => download.state === 'completed')
    })
    const firstPath = downloaded.path
    if (typeof firstPath !== 'string') throw new Error('Completed download has no published path')
    expect(downloaded.name).toBe('safe (1).txt')
    expect(basename(firstPath)).toBe(downloaded.name)
    expect(existsSync(firstPath)).toBe(true)
    expect(dirname(realpathSync(firstPath))).toBe(realpathSync(downloads))
    expect(readFileSync(firstPath, 'utf8')).toBe('owned download contents')
    writeFileSync(firstPath, 'keep first publication')

    await call(h, 'click', { page: downloadPage.browserPageId, element: '#safe' })
    const collision = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as PaneState
      return state.tabs.find((tab) => tab.id === downloadPane.id)?.downloads.find((download) => download.state === 'completed' && download.id !== downloaded.id)
    })
    const collisionPath = collision.path
    if (typeof collisionPath !== 'string') throw new Error('Completed collision download has no published path')
    expect(collisionPath).not.toBe(firstPath)
    expect(dirname(realpathSync(collisionPath))).toBe(realpathSync(downloads))
    expect(collision.name).toBe(basename(collisionPath))
    expect(readFileSync(firstPath, 'utf8')).toBe('keep first publication')
    expect(readFileSync(join(downloads, 'safe.txt'), 'utf8')).toBe('keep existing file')
    expect(readFileSync(collisionPath, 'utf8')).toBe('owned download contents')
    await call(h, 'click', { page: downloadPage.browserPageId, element: '#unsafe' })
    const unsafe = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as PaneState
      return state.tabs.find((tab) => tab.id === downloadPane.id)?.downloads.find((download) =>
        download.state === 'completed' && download.id !== downloaded.id && download.id !== collision.id)
    })
    const unsafePath = unsafe.path
    if (typeof unsafePath !== 'string') throw new Error('Completed unsafe-name download has no published path')
    expect(dirname(realpathSync(unsafePath))).toBe(realpathSync(downloads))
    expect(unsafe.name).toBe(basename(unsafePath))
    expect(readFileSync(unsafePath, 'utf8')).toBe('owned unsafe-name download')
    expect(readFileSync(join(downloads, 'safe.txt'), 'utf8')).toBe('keep existing file')
  } finally {
    fixture.stop()
    try { await h.cleanup() } finally { await certificate?.stop() }
  }
}, 90_000)
