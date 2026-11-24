import { expect, test } from './helpers/quirky-app'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  browserAddressBar,
  createBrowserSplit,
  createTerminalBrowserSplit,
  focusBrowserAddressBar,
  focusBrowserGroup,
  guestModifier,
  pressKeyInBrowserGuest,
  shortcutModifier as modifier,
  waitForFocusedGroup
} from './helpers/browser-split-fixture'

function browserFindInput(page: Page) {
  return page.getByPlaceholder('Find in page...')
}

function browserFindCloseButton(page: Page) {
  return browserFindInput(page).locator('xpath=..').getByTitle('Close')
}

function browserSplitFindInput(page: Page, browserTabId: string) {
  return page
    .locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
    .getByPlaceholder('Find in page...')
}

async function pressFindInBrowserGuest(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await pressKeyInBrowserGuest(page, browserTabId, browserPageId, 'F', [guestModifier])
}

function terminalFindInput(page: Page) {
  return page.locator('[data-terminal-search-root] input:visible')
}

test.describe('browser split shortcuts', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
    await ensureTerminalVisible(quirkyPage)
  })

  test('routes repeated Find shortcuts to the focused terminal or browser split', async ({
    quirkyPage
  }) => {
    const fixture = await createTerminalBrowserSplit(quirkyPage)

    await quirkyPage.evaluate(({ terminalGroupId }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      if (state && worktreeId) {
        state.focusGroup(worktreeId, terminalGroupId)
      }
    }, fixture)
    await focusActiveTerminalInput(quirkyPage)
    await waitForFocusedGroup(quirkyPage, fixture.terminalGroupId)
    await quirkyPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(quirkyPage)).toBeFocused()
    await expect(browserFindInput(quirkyPage)).toBeHidden()
    await quirkyPage.keyboard.press('Escape')

    await focusBrowserGroup(quirkyPage, fixture.browserGroupId)
    await focusBrowserAddressBar(quirkyPage, fixture.browserTabId)
    await quirkyPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(quirkyPage)).toBeFocused()
    await expect(terminalFindInput(quirkyPage)).toBeHidden()
    await browserFindCloseButton(quirkyPage).click()
    await expect(browserFindInput(quirkyPage)).toBeHidden()

    await quirkyPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(quirkyPage)).toBeFocused()
    await browserFindCloseButton(quirkyPage).click()

    await quirkyPage.evaluate(({ browserTabId }) => {
      window.__store?.getState().closeBrowserTab(browserTabId)
    }, fixture)
    await expect(
      quirkyPage.locator(`[data-browser-overlay-tab-id="${fixture.browserTabId}"]`)
    ).toHaveCount(0)

    await focusActiveTerminalInput(quirkyPage)
    await quirkyPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(quirkyPage)).toBeFocused()
    await expect(browserFindInput(quirkyPage)).toBeHidden()
  })

  test('opens Find only in the browser split whose guest owns the shortcut', async ({
    quirkyPage
  }) => {
    const fixture = await createBrowserSplit(quirkyPage)

    await pressFindInBrowserGuest(quirkyPage, fixture.firstBrowserTabId, fixture.firstBrowserPageId)

    await expect(browserSplitFindInput(quirkyPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(browserSplitFindInput(quirkyPage, fixture.secondBrowserTabId)).toBeHidden()
    await expect
      .poll(() =>
        quirkyPage.evaluate(
          ({ browserPageId, browserTabId }) =>
            window.__store
              ?.getState()
              .browserPagesByWorkspace[browserTabId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null,
          {
            browserPageId: fixture.firstBrowserPageId,
            browserTabId: fixture.firstBrowserTabId
          }
        )
      )
      .toBeNull()
  })

  test('keeps browser Find available when split focus state is temporarily missing', async ({
    quirkyPage
  }) => {
    const fixture = await createTerminalBrowserSplit(quirkyPage)
    await focusBrowserGroup(quirkyPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(quirkyPage, fixture.browserTabId)
    await focusBrowserAddressBar(quirkyPage, fixture.browserTabId)

    await quirkyPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => {
        const activeGroupIdByWorktree = { ...state.activeGroupIdByWorktree }
        delete activeGroupIdByWorktree[worktreeId]
        return { activeGroupIdByWorktree }
      })
    })
    await expect(addressBar).toBeFocused()

    await quirkyPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(quirkyPage)).toBeFocused()
    await expect(terminalFindInput(quirkyPage)).toBeHidden()
  })

  test('keeps browser Find available when the focused split ID is stale', async ({
    quirkyPage
  }) => {
    const fixture = await createTerminalBrowserSplit(quirkyPage)
    await focusBrowserGroup(quirkyPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(quirkyPage, fixture.browserTabId)
    await focusBrowserAddressBar(quirkyPage, fixture.browserTabId)

    await quirkyPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => ({
        activeGroupIdByWorktree: {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: 'removed-group'
        }
      }))
    })
    await expect(addressBar).toBeFocused()

    await quirkyPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(quirkyPage)).toBeFocused()
    await expect(terminalFindInput(quirkyPage)).toBeHidden()
  })
})
