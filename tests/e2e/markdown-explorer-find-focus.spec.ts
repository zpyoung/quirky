import { expect, test } from './helpers/quirky-app'
import { openFileExplorer } from './helpers/file-explorer'
import { pressShortcut } from './helpers/shortcuts'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('Explorer-opened Markdown accepts the find shortcut without a document click', async ({
  quirkyPage
}) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  await openFileExplorer(quirkyPage)

  const readmeRow = quirkyPage.locator('[data-file-explorer-row]').filter({ hasText: 'README.md' })
  await expect(readmeRow).toBeVisible({ timeout: 10_000 })
  await readmeRow.focus()
  await readmeRow.click()

  await expect(quirkyPage.locator('.rich-markdown-editor')).toBeVisible({ timeout: 25_000 })
  await pressShortcut(quirkyPage, 'f')

  await expect(
    quirkyPage.getByRole('textbox', { name: 'Find in rich markdown editor' })
  ).toBeVisible()
})
