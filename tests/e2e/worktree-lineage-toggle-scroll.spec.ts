import { test, expect } from './helpers/quirky-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { addRepoWithWorkspaces, writeWorkspaceMeta } from './helpers/repo-with-workspaces'
import { seedLineageScenario } from './worktree-lineage-state'
import { waitForLineageScrollFixtureReady } from './worktree-lineage-scroll-readiness'

test.use({ launchEnv: { QUIRKY_BACKGROUND_LAUNCH: '1' } })

test('keyboard and chip preserve the scrolled parent, and unfolding opens the sidebar', async ({
  quirkyPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  await quirkyPage.emulateMedia({ reducedMotion: 'reduce' })
  await quirkyPage.setViewportSize({ width: 1200, height: 800 })
  const family = await seedLineageScenario(quirkyPage)
  const surrounding = await addRepoWithWorkspaces(quirkyPage, testInfo, 40)
  const order = (worktreeId: string, rank: number, displayName?: string) => ({
    worktreeId,
    updates: { sortOrder: rank, manualOrder: rank, ...(displayName ? { displayName } : {}) }
  })
  await writeWorkspaceMeta(quirkyPage, [
    order(family.parentId, 16.5),
    order(family.childId, 16.4),
    order(surrounding.mainId, 0),
    ...surrounding.ids.map((id, index) => order(id, 40 - index, `Surrounding workspace ${index}`))
  ])
  await quirkyPage.evaluate(async () => {
    const state = window.__store!.getState()
    state.setSortBy('manual')
    await state.setKeybindingOverride('sidebar.childWorkspaces.toggle', ['Mod+Alt+H'])
  })

  const sidebar = quirkyPage.locator('[data-worktree-sidebar]')
  const parentRow = sidebar
    .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.parentId)}]`)
    .first()
  const childRow = sidebar
    .locator(`[role="option"][data-worktree-id=${JSON.stringify(family.childId)}]`)
    .first()
  await quirkyPage.getByRole('button', { name: 'Reveal active workspace' }).click()
  await expect(parentRow).toBeVisible()
  await parentRow.evaluate((row) => row.scrollIntoView({ block: 'center' }))
  await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const geometry = () =>
    parentRow.evaluate((row) => ({
      top: row.getBoundingClientRect().top,
      scrollTop: row.closest('[data-worktree-sidebar]')?.scrollTop ?? 0
    }))
  await waitForLineageScrollFixtureReady(quirkyPage, family.parentId)
  const before = await geometry()
  await quirkyPage.mouse.move(1150, 400)
  await quirkyPage.keyboard.press('ControlOrMeta+Alt+KeyH')
  await expect(childRow).toBeHidden()
  await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
  expect((await geometry()).scrollTop).toBeGreaterThan(0)
  const collapsedProof = testInfo.outputPath('keyboard-collapsed-parent-anchor.png')
  await sidebar.screenshot({ path: collapsedProof })
  await testInfo.attach('keyboard-collapsed-parent-anchor', {
    path: collapsedProof,
    contentType: 'image/png'
  })

  await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
  await expect(childRow).toBeVisible()
  await expect.poll(async () => Math.abs((await geometry()).top - before.top)).toBeLessThan(2)
  await quirkyPage.mouse.move(1150, 400)
  await quirkyPage.keyboard.press('ControlOrMeta+Alt+KeyH')
  await expect(childRow).toBeHidden()
  await quirkyPage.evaluate(() => window.__store?.getState().setSidebarOpen(false))
  await expect(sidebar).toBeHidden()
  await quirkyPage.keyboard.press('ControlOrMeta+Alt+KeyH')
  await expect(sidebar).toBeVisible()
  await expect(childRow).toBeVisible()
})
