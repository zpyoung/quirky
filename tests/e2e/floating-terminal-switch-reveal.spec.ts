import { test, expect } from './helpers/quirky-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// E2E specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'

// `quirky terminal switch` to a floating terminal reaches the renderer as ui:focusTerminal. It used
// to select the floating workspace in the main window, blanking it while the panel stayed closed.
test('switching to a floating terminal opens the panel and keeps the main workspace', async ({
  electronApp,
  quirkyPage
}) => {
  await waitForSessionReady(quirkyPage)
  const mainWorktreeId = await waitForActiveWorktree(quirkyPage)

  const tabId = await quirkyPage.evaluate(async (worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().updateSettings({ floatingTerminalEnabled: true })
    store.setState({ floatingWorkspacePanelOpen: false })
    return store.getState().createTab(worktreeId, undefined, undefined, { activate: false }).id
  }, FLOATING_WORKTREE_ID)
  await expect(quirkyPage.locator(OPEN_PANEL_SELECTOR)).toHaveCount(0)

  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:focusTerminal', payload)
    },
    { tabId, worktreeId: FLOATING_WORKTREE_ID }
  )

  await expect(quirkyPage.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
  const selection = await quirkyPage.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    return {
      active: state?.activeWorktreeId,
      floatingTab: state?.activeTabIdByWorktree[worktreeId]
    }
  }, FLOATING_WORKTREE_ID)
  expect(selection).toEqual({ active: mainWorktreeId, floatingTab: tabId })
})
