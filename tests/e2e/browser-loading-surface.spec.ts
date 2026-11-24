import { expect, test } from './helpers/quirky-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { crashGuestRenderer } from './browser-guest-runtime-oracle'
import { observeBrowserLoadingSurface } from './browser-loading-surface-oracle'

test('browser host follows the theme before content and preserves the webpage canvas', async ({
  quirkyPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  await ensureTerminalVisible(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  const observations = await observeBrowserLoadingSurface(
    quirkyPage,
    (name) => testInfo.outputPath(name),
    async (id) => {
      await crashGuestRenderer(electronApp, id)
    }
  )
  expect(observations.filter((entry) => !entry.pass)).toEqual([])
})
