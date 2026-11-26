// STA-3319 / STA-8147: Cmd/Ctrl+C arms element grab only in the focused split.

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/quirky-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  browserOverlay,
  createBrowserSplit,
  guestModifier,
  pressKeyInBrowserGuest,
  shortcutModifier,
  waitForFocusedGroup,
  type GuestModifier
} from './helpers/browser-split-fixture'
import { waitForGuestUrl } from './helpers/browser-split-guest-probes'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './helpers/browser-split-page-server'

const copyChord = `${shortcutModifier}+c`
// Default annotate chord: Cmd+Shift+C on macOS, Alt+Shift+N on Linux and Windows.
const annotateGuestChord: { keyCode: string; modifiers: GuestModifier[] } =
  process.platform === 'darwin'
    ? { keyCode: 'C', modifiers: [guestModifier, 'shift'] }
    : { keyCode: 'N', modifiers: ['alt', 'shift'] }

function grabBanner(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).getByText(/Click or hover an element|Grab failed/)
}

function annotateBanner(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).getByText(
    'Click an element to add feedback for the agent.'
  )
}

function reloadButton(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).getByRole('button', { name: 'Reload', exact: true })
}

async function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

async function writeClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

test.describe('browser split grab shortcut', () => {
  // Why: these tests share the system clipboard, so keep them on one worker.
  test.describe.configure({ mode: 'default' })

  let server: BrowserSplitPageServer
  let savedClipboard: string | null = null

  test.beforeEach(async ({ electronApp, quirkyPage }) => {
    server = await startBrowserSplitPageServer()
    // Why: the copy assertions read the real system clipboard; put the user's text back after.
    savedClipboard = await readClipboard(electronApp)
    await waitForSessionReady(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
    await ensureTerminalVisible(quirkyPage)
  })

  test.afterEach(async ({ electronApp }) => {
    if (savedClipboard !== null) {
      await writeClipboard(electronApp, savedClipboard)
    }
    await server.close()
  })

  test('copy chord from one split toolbar arms grab only in that split', async ({ quirkyPage }) => {
    const fixture = await createBrowserSplit(quirkyPage, {
      first: server.pageUrl('a', 1),
      second: server.pageUrl('b', 1, 'localhost')
    })
    await waitForGuestUrl(quirkyPage, fixture.firstBrowserTabId, server.pageUrl('a', 1))
    await waitForGuestUrl(
      quirkyPage,
      fixture.secondBrowserTabId,
      server.pageUrl('b', 1, 'localhost')
    )

    await reloadButton(quirkyPage, fixture.firstBrowserTabId).focus()
    await waitForFocusedGroup(quirkyPage, fixture.firstBrowserGroupId)
    await quirkyPage.keyboard.press(copyChord)

    await expect(grabBanner(quirkyPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(grabBanner(quirkyPage, fixture.secondBrowserTabId)).toBeHidden()
  })

  test('annotate chord typed in one guest arms annotate only in that split', async ({
    quirkyPage
  }) => {
    const fixture = await createBrowserSplit(quirkyPage, {
      first: server.pageUrl('a', 1),
      second: server.pageUrl('b', 1, 'localhost')
    })
    await waitForGuestUrl(quirkyPage, fixture.firstBrowserTabId, server.pageUrl('a', 1))
    await waitForGuestUrl(
      quirkyPage,
      fixture.secondBrowserTabId,
      server.pageUrl('b', 1, 'localhost')
    )

    await pressKeyInBrowserGuest(
      quirkyPage,
      fixture.firstBrowserTabId,
      fixture.firstBrowserPageId,
      annotateGuestChord.keyCode,
      annotateGuestChord.modifiers
    )

    await expect(annotateBanner(quirkyPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(annotateBanner(quirkyPage, fixture.secondBrowserTabId)).toBeHidden()
  })
})
