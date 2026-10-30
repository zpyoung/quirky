import { expect, test } from 'bun:test'
import { startBrowserHarness } from './harness'

test('a browser pane opens its hosted tab with the globe icon', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('tab-icon-main')
    await h.client.callAny('quirky.browser/paneOpen', { worktree: `id:${worktree}`, url: 'https://example.com/icon' })
    const shown = await h.client.callAny('quirky.terminal/activeTabIcon', { workspace: `id:${worktree}` })
    expect(shown).toEqual({ icon: { kind: 'control', name: 'globe' } })
  } finally {
    await h.cleanup()
  }
}, 90_000)
