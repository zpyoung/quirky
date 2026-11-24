/**
 * Stress test for dead-terminal reproduction (manual-split flow).
 *
 * Why @headful: the dead-terminal bug is a WebGL canvas staleness issue — after
 * wrapInSplit() reparents the existing pane's container, the WebGL canvas can
 * fail to repaint. In headless mode WebGL is NEVER active, so the DOM fallback
 * renderer is used and the bug cannot manifest. Running headful ensures real
 * WebGL contexts matching production.
 *
 * See helpers/dead-terminal.ts for the shared worktree-creation helper that
 * replicates the exact activateAndRevealWorktree + ensureWorktreeHasInitialTerminal
 * production flow.
 */

import { test, expect } from './helpers/quirky-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import {
  createAndActivateWorktreeWithManualSplit,
  removeWorktreeViaStore,
  waitForAllPanesToHaveContent,
  checkWebglState
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Reproduction @headful', () => {
  const createdWorktreeIds: string[] = []

  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
    await ensureTerminalVisible(quirkyPage)
  })

  test.afterEach(async ({ quirkyPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(quirkyPage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('@headful manual-split flow does not produce dead terminals', async ({ quirkyPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(quirkyPage)
    await waitForActiveTerminalManager(quirkyPage, 30_000)
    await checkWebglState(quirkyPage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithManualSplit(
        quirkyPage,
        `setup-${i}`,
        direction
      )
      createdWorktreeIds.push(newId)

      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(quirkyPage)
      await waitForActiveTerminalManager(quirkyPage, 30_000)
      await waitForPaneCount(quirkyPage, 2, 15_000)
      await checkWebglState(quirkyPage, `setup-${i}`)
      await waitForAllPanesToHaveContent(quirkyPage, `setup-${i} both panes`)

      await switchToWorktree(quirkyPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(quirkyPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful manual-split then switch-back does not leave panes dead', async ({
    quirkyPage
  }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(quirkyPage)
    await waitForActiveTerminalManager(quirkyPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        quirkyPage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(quirkyPage)
      await waitForActiveTerminalManager(quirkyPage, 30_000)
      await waitForPaneCount(quirkyPage, 2, 15_000)
      await waitForAllPanesToHaveContent(quirkyPage, `switchback-${i} initial`)

      await switchToWorktree(quirkyPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(quirkyPage)
      await waitForActiveTerminalManager(quirkyPage, 15_000)

      await switchToWorktree(quirkyPage, newId)
      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(quirkyPage)
      await waitForActiveTerminalManager(quirkyPage, 15_000)
      await waitForAllPanesToHaveContent(quirkyPage, `switchback-${i} after return`)

      await switchToWorktree(quirkyPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(quirkyPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful rapid switching between many manual-split worktrees', async ({ quirkyPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(quirkyPage)
    await waitForActiveTerminalManager(quirkyPage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        quirkyPage,
        `multi-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect
        .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
        .toBe(newId)
      await ensureTerminalVisible(quirkyPage)
      await waitForActiveTerminalManager(quirkyPage, 30_000)
      await waitForPaneCount(quirkyPage, 2, 15_000)
      await waitForAllPanesToHaveContent(quirkyPage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(quirkyPage, wId)
        await expect
          .poll(async () => getActiveWorktreeId(quirkyPage), { timeout: 10_000 })
          .toBe(wId)
        await ensureTerminalVisible(quirkyPage)
        await waitForActiveTerminalManager(quirkyPage, 15_000)
        await waitForAllPanesToHaveContent(quirkyPage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
