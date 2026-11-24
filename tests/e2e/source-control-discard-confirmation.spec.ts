import { test, expect } from './helpers/quirky-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Locator, Page } from '@playwright/test'

type SeededUntrackedFile = {
  fileName: string
}

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
  await page.getByTestId('source-control-filter-toggle').click()
  await expect(page.getByPlaceholder(/Filter files/)).toBeVisible()
}

async function seedUntrackedFile(
  page: Page,
  requestedFileName?: string
): Promise<SeededUntrackedFile> {
  const seeded = await page.evaluate(async (requestedFileName) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }

    const separator = worktree.path.includes('\\') ? '\\' : '/'
    const fileName = requestedFileName ?? `quirky-discard-confirm-${Date.now()}.txt`
    const relativePath = fileName
    await window.api.fs.writeFile({
      filePath: `${worktree.path}${separator}${relativePath}`,
      content: 'delete me\n'
    })

    return {
      fileName
    }
  }, requestedFileName)

  // Why: a status read already in flight when the file was written can be joined and miss it.
  await expect
    .poll(
      async () => (await refreshGitStatus(page)).some((path) => path.endsWith(seeded.fileName)),
      { timeout: 10_000, message: `git status did not include ${seeded.fileName}` }
    )
    .toBe(true)
  return seeded
}

async function refreshGitStatus(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    const status = await window.api.git.status({ worktreePath: worktree.path })
    state.setGitStatus(worktree.id, status)
    return status.entries.map((entry) => entry.path)
  })
}

async function deleteUntrackedFileFromRow(row: Locator): Promise<void> {
  const deleteButton = row.getByRole('button', { name: 'Delete untracked file' })
  // Why: row actions are hover/focus revealed; keyboard activation avoids
  // CI hover hit-test drift while exercising the same accessible control.
  await deleteButton.focus()
  await expect(deleteButton).toBeFocused()
  await deleteButton.press('Enter')
}

async function confirmPendingDelete(page: Page): Promise<void> {
  // Why: the confirm button is auto-focused when the dialog opens
  // (see focusDiscardDialogConfirmButton in source-control-discard-dialog.tsx).
  // Pressing Enter on the row's original button just retriggers open; we need
  // to target the dialog confirm by accessible name.
  const confirmButton = page.getByRole('button', { name: 'Delete' }).last()
  await expect(confirmButton).toBeVisible()
  await confirmButton.click()
}

async function expectDeleteDialogLayout(page: Page, fileName: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: `Delete "${fileName}"?` })
  await expect(dialog).toBeVisible()
  await expect
    .poll(
      async () =>
        dialog.evaluate((element) => {
          const panel = element.getBoundingClientRect()
          const title = element.querySelector<HTMLElement>('[data-slot="dialog-title"]')
          const footer = element.querySelector<HTMLElement>('[data-slot="dialog-footer"]')
          if (!title || !footer) {
            return false
          }
          const titleRect = title.getBoundingClientRect()
          const footerRect = footer.getBoundingClientRect()
          const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight) || 16
          const buttonsFit = [...footer.querySelectorAll<HTMLElement>('button')].every((button) => {
            const rect = button.getBoundingClientRect()
            return rect.left >= panel.left && rect.right <= panel.right
          })
          return (
            titleRect.height > lineHeight * 1.5 &&
            titleRect.left >= panel.left &&
            titleRect.right <= panel.right &&
            footerRect.left >= panel.left &&
            footerRect.right <= panel.right &&
            buttonsFit &&
            element.scrollWidth <= element.clientWidth
          )
        }),
      { timeout: 5_000, message: 'long delete-dialog title or footer escaped the panel' }
    )
    .toBe(true)
}

test.describe('Source Control discard confirmation', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
  })

  test('keeps long untracked-file confirmation usable and deletes on confirm', async ({
    quirkyPage
  }) => {
    const seededFile = await seedUntrackedFile(
      quirkyPage,
      `quirky-discard-confirm-${'x'.repeat(96)}.txt`
    )
    await openSourceControl(quirkyPage)

    const row = quirkyPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: seededFile.fileName })
    await expect(row).toBeVisible()

    await deleteUntrackedFileFromRow(row)
    await expectDeleteDialogLayout(quirkyPage, seededFile.fileName)

    await quirkyPage.getByRole('button', { name: 'Cancel' }).click()
    await expect(row).toBeVisible()

    await deleteUntrackedFileFromRow(row)
    await confirmPendingDelete(quirkyPage)

    await expect(
      quirkyPage.getByRole('dialog', { name: `Delete "${seededFile.fileName}"?` })
    ).toHaveCount(0)
    await expect(row).toHaveCount(0, { timeout: 10_000 })

    await refreshGitStatus(quirkyPage)
    await expect(
      quirkyPage.locator('[data-testid="source-control-entry"]').filter({
        hasText: seededFile.fileName
      })
    ).toHaveCount(0)
  })
})
