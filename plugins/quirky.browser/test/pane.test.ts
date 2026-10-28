import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { basename, join } from 'node:path'
import { expect, test } from 'bun:test'
import type { QuirkyEvent } from '@quirky/protocol'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
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
        headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="../../safe.txt"' }
      })
      if (path === '/download-page') return new Response('<!doctype html><title>Download</title><a href="/download">Download fixture</a>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
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

function paneFrame(event: QuirkyEvent): Record<string, unknown> | undefined {
  if (event.type !== 'event:quirky.browser/paneFrame' || !('data' in event)) return undefined
  const data = event.data
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : undefined
}

async function createAgentPage(h: BrowserTestHarness, worktree: string, url: string) {
  return await call(h, 'tabCreate', { worktree: `id:${worktree}`, url }) as { browserPageId: string }
}

test('pane navigation normalizes safely, persists bounded recency history, and keeps Native browsing Chrome-free', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-native')
    const worktreePath = join(h.home, 'projects', 'pane-native')
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
      expect(typeof firstFrame.data).toBe('string')
      expect((firstFrame.data as string).length).toBeGreaterThan(100)
      expect(firstFrame.width).toBeGreaterThan(0)
      expect(firstFrame.height).toBeGreaterThan(0)
      await Bun.sleep(350)
      expect(events.map(paneFrame).filter((frame) => frame?.watchId === watch.watchId)).toHaveLength(1)

      await call(h, 'paneFrameAck', { pane: pane.id, watchId: watch.watchId, sequence: firstFrame.sequence })
      const nextFrame = await waitFor(() => events.map(paneFrame).find((frame) => frame?.watchId === watch.watchId && frame.sequence !== firstFrame.sequence))
      expect(nextFrame.sequence).toBeGreaterThan(firstFrame.sequence as number)

      await call(h, 'paneInput', { pane: pane.id, kind: 'mouse', type: 'mousePressed', x: 45, y: 16, button: 'left' })
      await call(h, 'paneInput', { pane: pane.id, kind: 'mouse', type: 'mouseReleased', x: 45, y: 16, button: 'left' })
      await call(h, 'paneInput', { pane: pane.id, kind: 'text', text: 'only-the-watched-page' })
      expect(await call(h, 'eval', { page: first.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'only-the-watched-page' })
      expect(await call(h, 'eval', { page: second.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: '' })

      const find = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle' }) as { find: { current: number; total: number } }
      expect(find.find.total).toBe(3)
      expect(find.find.current).toBe(1)
      const nextFind = await call(h, 'paneControl', { pane: pane.id, action: 'find', text: 'needle', forward: true }) as { find: { current: number; total: number } }
      expect(nextFind.find.current).toBe(2)
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
      await call(h, 'tabClose', { page: first.browserPageId })
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
    await call(h, 'click', { page: downloadPage.browserPageId, element: 'a' })
    const downloaded = await waitFor(async () => {
      const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as { tabs: Array<{ id: string; downloads: Array<{ id: string; state: string; path?: string }> }> }
      return state.tabs.find((tab) => tab.id === downloadPane.id)?.downloads.find((download) => download.state === 'completed')
    })
    expect(downloaded.path).toBeTruthy()
    expect(basename(downloaded.path!)).toBe('safe (1).txt')
    expect(readFileSync(join(downloads, 'safe.txt'), 'utf8')).toBe('keep existing file')
    expect(existsSync(downloaded.path!)).toBe(true)
    expect(readFileSync(downloaded.path!, 'utf8')).toBe('owned download contents')
  } finally {
    fixture.stop()
    try { await h.cleanup() } finally { await certificate?.stop() }
  }
}, 90_000)
