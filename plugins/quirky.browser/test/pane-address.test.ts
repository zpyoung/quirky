import { expect, test } from 'bun:test'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

const call = (h: BrowserTestHarness, name: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${name}`, params)

type Suggestions = { suggestions: Array<{ kind: string; url: string }> }
type History = { history: Array<{ url: string }> }

test('URL-like input gets no search suggestion and plain words still do', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-address')
    for (const query of ['http://127.0.0.1:8765/', '127.0.0.1:8765', 'localhost:3000/x', 'example.com']) {
      const result = await call(h, 'paneSuggestions', { worktree: `id:${worktree}`, query }) as Suggestions
      expect(result.suggestions.some((item) => item.kind === 'search')).toBe(false)
    }
    const words = await call(h, 'paneSuggestions', { worktree: `id:${worktree}`, query: 'hello world' }) as Suggestions
    expect(words.suggestions.some((item) => item.kind === 'search')).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('starting Watch from a Native pane records the page it loads in history', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-address-watch-history')
    const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}` }) as { id: string }
    const address = `${h.fixtureUrl}first`
    await call(h, 'paneNavigate', { pane: pane.id, input: address })
    const before = await call(h, 'paneState', { worktree: `id:${worktree}` }) as History
    expect(before.history.some((item) => item.url === address)).toBe(false)
    await call(h, 'paneWatch', { pane: pane.id })
    const after = await call(h, 'paneState', { worktree: `id:${worktree}` }) as History
    expect(after.history.some((item) => item.url === address)).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 60_000)

test('a Native navigation enters history only once the view reports the page loaded', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-address-history')
    const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}` }) as { id: string; tabId: string }
    const navigated = await call(h, 'paneNavigate', { pane: pane.id, input: 'hello world' }) as { command: { id: string; url: string } }
    const pending = await call(h, 'paneState', { worktree: `id:${worktree}` }) as History
    expect(pending.history.some((item) => item.url.includes('search'))).toBe(false)
    await call(h, 'paneReport', { pane: pane.id, tabId: pane.tabId, command: navigated.command.id, url: navigated.command.url, title: 'Search', loading: false })
    const loaded = await call(h, 'paneState', { worktree: `id:${worktree}` }) as History
    expect(loaded.history.some((item) => item.url.includes('search'))).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 30_000)
