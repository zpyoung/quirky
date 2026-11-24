import { test, expect } from './helpers/quirky-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

test('Cmd+J focuses the terminal after waking a sleeping workspace', async ({
  quirkyPage
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  const source = await waitForActiveWorktree(quirkyPage)
  const target = (await getAllWorktreeIds(quirkyPage)).find((id) => id !== source)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  await switchToWorktree(quirkyPage, target)
  await ensureTerminalVisible(quirkyPage)
  await waitForActiveTerminalManager(quirkyPage)
  await waitForActivePanePtyId(quirkyPage)
  const targetName = await quirkyPage.evaluate((id) => {
    const state = window.__store!.getState()
    const worktree = state.getKnownWorktreeById(id)
    if (!worktree) {
      throw new Error('Missing target workspace')
    }
    return worktree.branch.replace(/^refs\/heads\//, '')
  }, target)
  await switchToWorktree(quirkyPage, source)
  await quirkyPage.evaluate(async (id) => {
    await window.__store!.getState().shutdownWorktreeTerminals(id, { keepIdentifiers: true })
  }, target)
  await quirkyPage.evaluate(() => {
    const listSessions = window.api.pty.listSessions
    window.api.pty.listSessions = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return listSessions(...args)
    }
  })
  // Native menu accelerators require OS focus; open the same palette in the hidden renderer.
  await quirkyPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
  const dialog = quirkyPage.getByRole('dialog', { name: 'Jump to...' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox').fill(targetName)
  await expect(dialog.locator('[cmdk-item][data-selected="true"]')).toContainText(targetName)
  const cdp = await quirkyPage.context().newCDPSession(quirkyPage)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 })
  await quirkyPage.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await waitForActiveTerminalManager(quirkyPage)
  await waitForActivePanePtyId(quirkyPage)
  const terminal = quirkyPage
    .locator('[data-terminal-tab-id]:visible .xterm-helper-textarea')
    .first()
  await quirkyPage.screenshot({ path: testInfo.outputPath('wake-focus.png') })
  await expect(terminal).toBeFocused()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await cdp.detach()
  await quirkyPage.keyboard.type('echo WAKE_KEYBOARD_OK')
  await quirkyPage.keyboard.press('Enter')
  await waitForTerminalOutput(quirkyPage, 'WAKE_KEYBOARD_OK')
  await quirkyPage.screenshot({ path: testInfo.outputPath('wake-typing.png') })
})
