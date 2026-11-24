import { removeWorktreeViaStore } from './helpers/dead-terminal'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/quirky-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

async function createWorkspace(page: Page, name: string): Promise<void> {
  await openSidebarWorkspaceComposer(page)
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(name)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

test('creates a worktree, keeps its terminal isolated, and switches back @golden', async ({
  quirkyPage
}) => {
  test.setTimeout(180_000)
  await waitForSessionReady(quirkyPage)
  const originalWorktreeId = await waitForActiveWorktree(quirkyPage)
  await waitForActiveTerminalManager(quirkyPage, 30_000)
  const parentPtyId = await waitForActivePanePtyId(quirkyPage)
  const workspaceName = `golden-switch-${Date.now()}`
  let childWorktreeId: string | null = null

  try {
    await createWorkspace(quirkyPage, workspaceName)
    await expect(
      quirkyPage.locator('[role="option"][aria-current="page"]').filter({ hasText: workspaceName })
    ).toBeVisible({ timeout: 30_000 })
    childWorktreeId = await waitForActiveWorktree(quirkyPage)
    // Why: the cleanup force-removes childWorktreeId, so it must never resolve to the original.
    expect(childWorktreeId).not.toBe(originalWorktreeId)
    await expect(
      quirkyPage.locator(`[role="option"][data-worktree-id="${childWorktreeId}"]`)
    ).toHaveAttribute('aria-current', 'page')

    await createTerminalTabFromMenu(quirkyPage)
    await waitForActiveTerminalManager(quirkyPage, 30_000)
    const childPtyId = await waitForActivePanePtyId(quirkyPage)
    expect(childPtyId).not.toBe(parentPtyId)
    await waitForPtyShellEcho(quirkyPage, childPtyId, 15_000)
    await execInTerminal(quirkyPage, childPtyId, splitMarkerEchoCommand('worktree', '-b'))
    await waitForTerminalOutput(quirkyPage, 'worktree-b')

    await quirkyPage.locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`).click()
    await expect(
      quirkyPage.locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
    ).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
    // Why: sidebar aria-current can land before the store/terminal remount.
    // Mac release goldens then wait 30s on a child tab whose PaneManager is gone.
    await expect
      .poll(() => getActiveWorktreeId(quirkyPage), {
        timeout: 20_000,
        message: 'store did not activate the original worktree after sidebar click'
      })
      .toBe(originalWorktreeId)
    await ensureTerminalVisible(quirkyPage)
    await waitForActiveTerminalManager(quirkyPage, 30_000)
    expect(await waitForActivePanePtyId(quirkyPage, 30_000)).toBe(parentPtyId)
  } finally {
    if (childWorktreeId) {
      if ((await getActiveWorktreeId(quirkyPage).catch(() => null)) !== originalWorktreeId) {
        await quirkyPage
          .locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
          .click()
          .catch(() => undefined)
      }
      await removeWorktreeViaStore(quirkyPage, childWorktreeId)
    }
  }
})
