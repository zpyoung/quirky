import { expect, test } from 'bun:test'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { PaneState, PaneTab } from '../src/pane-contract'

const call = (h: BrowserTestHarness, name: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${name}`, params)

async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 12_000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await read()
    if (value != null) return value
    await Bun.sleep(50)
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`)
}

async function paneOf(h: BrowserTestHarness, worktree: string, id: string): Promise<PaneTab> {
  const state = await call(h, 'paneState', { worktree: `id:${worktree}` }) as PaneState
  const tab = state.tabs.find((candidate) => candidate.id === id)
  if (!tab) throw new Error('pane was not listed')
  return tab
}

async function startWatch(h: BrowserTestHarness, url: string) {
  const frames: string[] = []
  await h.client.call('events.subscribe', {})
  h.client.onEvent((event) => { if (event.type === 'quirky.browser/paneFrame') frames.push('frame') })
  const worktree = await h.addFolderWorktree('watch-state')
  const page = await call(h, 'tabCreate', { worktree: `id:${worktree}`, url }) as { browserPageId: string }
  const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, mode: 'watch', page: page.browserPageId }) as PaneTab
  await call(h, 'paneWatch', { pane: pane.id })
  await waitFor(async () => frames.length > 0 || null)
  return { worktree, page, pane }
}

const BIG_TARGET = 'display:block;position:absolute;left:0;top:0;width:300px;height:200px;font:20px sans-serif'

test('Back and Forward follow navigations made inside a Watch page', async () => {
  const h = await startBrowserHarness()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const body = new URL(request.url).pathname === '/two'
        ? `<!doctype html><title>Two</title><body style="margin:0"><a href="#" onclick="history.back();return false" style="${BIG_TARGET}">back</a>`
        : `<!doctype html><title>One</title><body style="margin:0"><a href="/two" style="${BIG_TARGET}">two</a>`
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
  })
  const click = async (pane: string) => {
    await call(h, 'paneInput', { pane, kind: 'mouse', type: 'mousePressed', x: 50, y: 50, button: 'left' })
    await call(h, 'paneInput', { pane, kind: 'mouse', type: 'mouseReleased', x: 50, y: 50, button: 'left' })
  }
  try {
    const { worktree, pane } = await startWatch(h, server.url.href)
    expect((await paneOf(h, worktree, pane.id)).canGoBack).toBe(false)

    await click(pane.id)
    await waitFor(async () => (await paneOf(h, worktree, pane.id)).canGoBack || null)
    expect((await paneOf(h, worktree, pane.id)).canGoForward).toBe(false)

    await click(pane.id)
    await waitFor(async () => (await paneOf(h, worktree, pane.id)).canGoForward || null)
  } finally {
    server.stop(true)
    await h.cleanup()
  }
}, 90_000)

test('a navigation error in a live Watch is not reported as the Watch ending', async () => {
  const h = await startBrowserHarness()
  try {
    const { worktree, pane } = await startWatch(h, `${h.fixtureUrl}first`)
    await call(h, 'paneNavigate', { pane: pane.id, input: 'http://127.0.0.1:6000/' })
    const failed = await paneOf(h, worktree, pane.id)
    expect(failed.error).toContain('ERR_UNSAFE_PORT')
    expect(failed.watchEnded).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 90_000)
