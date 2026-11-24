import { test, expect } from './helpers/quirky-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { showActivePaneAsNativeChat } from './helpers/native-chat-view'
import { waitForActiveTerminalManager } from './helpers/terminal'

test('typing @ in the chat composer lists workspace files and inserts the chosen one', async ({
  quirkyPage
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  await ensureTerminalVisible(quirkyPage)
  await waitForActiveTerminalManager(quirkyPage)
  await showActivePaneAsNativeChat(quirkyPage, 'claude', 'Claude')

  const composer = quirkyPage.getByRole('textbox', {
    name: 'Ask anything, @ to mention files, / for commands',
    exact: true
  })
  await expect(composer).toBeVisible()
  await composer.click()

  await quirkyPage.keyboard.type('review @')
  // The sidebar's worktree list is a listbox too.
  const files = quirkyPage.locator('[role="listbox"][id^="native-chat-picker-"]')
  await expect(files.getByRole('option', { name: /README\.md/ })).toBeVisible()
  await quirkyPage.screenshot({ path: testInfo.outputPath('mention-all-files.png') })

  await quirkyPage.keyboard.type('index')
  const match = files.getByRole('option', { name: /index\.ts/ })
  await expect(match).toHaveAttribute('aria-selected', 'true')
  await expect(files.getByRole('option', { name: /README\.md/ })).toHaveCount(0)
  await quirkyPage.screenshot({ path: testInfo.outputPath('mention-filtered.png') })

  await quirkyPage.keyboard.press('Enter')
  await expect(composer).toHaveText('review @src/index.ts ')
  await expect(files).toHaveCount(0)

  await quirkyPage.keyboard.type('@zzz-no-such-file')
  await expect(files).toContainText('No matching files')
  // A one-off app tooltip can be open and takes the first Escape for itself.
  await expect(async () => {
    await quirkyPage.keyboard.press('Escape')
    await expect(files).toHaveCount(0, { timeout: 1000 })
  }).toPass()
  await quirkyPage.keyboard.type('x')
  await expect(composer).toContainText('@zzz-no-such-filex')
  await expect(files).toHaveCount(0)
  await quirkyPage.keyboard.type(' @')
  await expect(files.getByRole('option', { name: /README\.md/ })).toBeVisible()
})
