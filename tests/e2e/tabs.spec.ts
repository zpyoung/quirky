/**
 * E2E tests for tab management: creating, switching, reordering, and closing tabs.
 *
 * User Prompt:
 * - New tab works
 * - dragging tabs around to reorder them
 * - closing tabs works
 * - double-click a tab to rename it inline
 *
 * Why these specs assert on the DOM: a prior version of this file drove every
 * flow through `window.__store` and read the same fields back — a tautology
 * that would have passed even if the tab bar had stopped rendering (the same
 * pattern that let PR #1186's `StartFromField` render crash ship past the
 * E2E suite in #1193). The rule in tests/e2e/AGENTS.md is that the final
 * `expect()` must target user-observable DOM. Store calls are only used here
 * for *setup* (e.g. to guarantee >= N tabs exist) or when the real user-facing
 * action genuinely can't be driven via DOM in hidden-window Electron runs
 * (dnd-kit reorder); in those cases a DOM assertion still follows.
 */

import { rm } from 'node:fs/promises'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/quirky-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getActiveTabType,
  getWorktreeTabs,
  getTabBarOrder,
  ensureTerminalVisible,
  waitForStartupWorktreeRefresh
} from './helpers/store'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function tabLocator(page: Page, tabId: string) {
  return page.locator(`${SORTABLE_TAB}[data-tab-id="${tabId}"]`).first()
}

async function closeTabFromTabBar(page: Page, tabId: string): Promise<void> {
  const tab = tabLocator(page, tabId)
  await tab.hover()
  await tab.getByRole('button', { name: /^Close tab /i }).click()
  const confirmation = page.getByRole('dialog', { name: 'Stop running command?' })
  // A shell still starting under load may require the running-command confirmation.
  await expect
    .poll(async () => (await confirmation.isVisible()) || (await tab.count()) === 0, {
      timeout: 5_000
    })
    .toBe(true)
  if (await confirmation.isVisible()) {
    await confirmation.getByRole('button', { name: 'Stop and Close', exact: true }).click()
  }
}

/** Count rendered tabs in the tab bar (user-visible, not store-level). */
async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

/**
 * Read the DOM's active-tab id from the `data-active` attribute exposed by
 * SortableTab. We assert on DOM rather than `activeTabId` in the store so a
 * render-layer regression (e.g. the active indicator failing to paint on the
 * correct tab) cannot silently pass.
 */
async function getDomActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    const match = document.querySelector(`${selector}[data-active="true"]`)
    return match?.getAttribute('data-tab-id') ?? null
  }, SORTABLE_TAB)
}

async function getFocusedTerminalTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.classList.contains('xterm-helper-textarea')) {
      return null
    }
    return active.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id') ?? null
  })
}

test.describe('Tabs', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
    await waitForStartupWorktreeRefresh(quirkyPage)
    await waitForActiveWorktree(quirkyPage)
    await ensureTerminalVisible(quirkyPage)
    const initialTabId = (await getActiveTabId(quirkyPage))!
    await expect(tabLocator(quirkyPage, initialTabId)).toBeVisible()
  })

  /**
   * User Prompt:
   * - New tab works
   *
   * Why: asserting on a new `[data-testid="sortable-tab"]` in the DOM (not
   * `tabsByWorktree.length` in the store) is the guard that would have caught
   * a tab-bar render regression. Clicking the real "+" button and then "New
   * Terminal" drives the same code path a user takes.
   */
  test('clicking "+" then "New Terminal" creates a new terminal tab', async ({ quirkyPage }) => {
    const tabsBefore = await countRenderedTabs(quirkyPage)

    // Why: hidden-window Electron can keep the animated terminal surface
    // invalidating Playwright's "stable" actionability check even though the
    // tab-bar button is visible and enabled.
    await quirkyPage.getByRole('button', { name: 'New tab' }).click({ force: true })
    // Why: the "+" dropdown uses Radix <DropdownMenuItem>, which exposes the
    // label text as the accessible name once the menu is open.
    const newTerminalMenuItem = quirkyPage.getByRole('menuitem', { name: /New Terminal/i }).first()
    await newTerminalMenuItem.click()
    await expect(newTerminalMenuItem).toBeHidden({ timeout: 3_000 })

    // Final assertion is on the rendered tab count — the tab bar itself must
    // gain an element, not just the store.
    await expect
      .poll(() => countRenderedTabs(quirkyPage), {
        timeout: 5_000,
        message: 'Clicking + → New Terminal did not render a new tab in the tab bar'
      })
      .toBeGreaterThan(tabsBefore)

    const activeType = await getActiveTabType(quirkyPage)
    expect(activeType).toBe('terminal')

    const storeActiveId = await getActiveTabId(quirkyPage)
    expect(storeActiveId).not.toBeNull()
    await expect(tabLocator(quirkyPage, storeActiveId!)).toBeVisible()
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(storeActiveId)
    await expect
      .poll(() => getFocusedTerminalTabId(quirkyPage), {
        timeout: 5_000,
        message: 'Menu-created terminal tab did not receive keyboard focus'
      })
      .toBe(storeActiveId)
  })

  test('clicking "+" then "New Markdown" focuses the editor', async ({
    quirkyPage,
    registerPostElectronShutdownCleanup
  }) => {
    let createdFilePath: string | null = null
    registerPostElectronShutdownCleanup(async () => {
      if (createdFilePath) {
        await rm(createdFilePath, { force: true })
      }
    })

    const preExistingFileIds = await quirkyPage.evaluate(
      () => window.__store?.getState().openFiles.map((file) => file.id) ?? []
    )

    await quirkyPage.getByRole('button', { name: 'New tab' }).click({ force: true })
    const newMarkdownMenuItem = quirkyPage.getByRole('menuitem', { name: /New Markdown/i }).first()
    await newMarkdownMenuItem.click()

    // Why: require an id that did not exist before the click, so an already-open
    // Markdown file can't satisfy the assertions (or be deleted by cleanup), and
    // record the path here so cleanup still has it if a later assertion fails.
    const createdFileHandle = await quirkyPage.waitForFunction(
      (knownFileIds) => {
        const state = window.__store?.getState()
        const file = state?.openFiles.find((candidate) => candidate.id === state.activeFileId)
        if (!file || knownFileIds.includes(file.id)) {
          return null
        }
        return { id: file.id, filePath: file.filePath }
      },
      preExistingFileIds,
      { timeout: 25_000 }
    )
    const createdFile = (await createdFileHandle.jsonValue())!
    createdFilePath = createdFile.filePath

    const editor = quirkyPage.locator('.rich-markdown-editor')
    await expect(editor).toBeVisible({ timeout: 25_000 })
    await expect(newMarkdownMenuItem).toBeHidden({ timeout: 3_000 })

    await expect
      .poll(() => editor.evaluate((element) => document.activeElement === element), {
        timeout: 5_000,
        message: 'Menu-created Markdown editor did not receive keyboard focus'
      })
      .toBe(true)

    const sentinel = `autofocus-${Date.now()}`
    // Why: typing through the page keyboard proves focus landed without an editor click.
    await quirkyPage.keyboard.type(sentinel)
    await expect(editor).toContainText(sentinel)

    await quirkyPage.evaluate((fileId) => {
      window.__store?.getState().closeFile(fileId)
    }, createdFile.id)
    await expect(editor).toBeHidden()
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('Cmd/Ctrl+T creates a new terminal tab', async ({ quirkyPage }) => {
    const isMac = process.platform === 'darwin'
    const mod = isMac ? 'Meta' : 'Control'
    const tabsBefore = await countRenderedTabs(quirkyPage)

    // Why: focus body first so the window-level keydown handler on Terminal.tsx
    // actually sees the event. Without focus the key may be eaten by an
    // unrelated input (e.g. a stale search field from a previous test).
    await quirkyPage.evaluate(() => document.body.focus())
    await quirkyPage.keyboard.press(`${mod}+t`)

    // DOM-level count increased — confirms a new tab actually rendered.
    await expect
      .poll(() => countRenderedTabs(quirkyPage), {
        timeout: 5_000,
        message: `${mod}+T did not add a tab to the tab bar`
      })
      .toBe(tabsBefore + 1)

    // The newly-rendered active tab must be a terminal (tab-type is visible as
    // the active surface behind the strip; we rely on the store flag here only
    // to disambiguate terminal vs. editor vs. browser — the fact that *some*
    // tab is active is already proved by the DOM assertion below).
    const activeType = await getActiveTabType(quirkyPage)
    expect(activeType).toBe('terminal')

    // The DOM must have exactly one active tab and it must match the store's
    // activeTabId — this is the load-bearing check that the render layer and
    // the state layer agree on what is selected.
    const storeActiveId = await getActiveTabId(quirkyPage)
    expect(storeActiveId).not.toBeNull()
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(storeActiveId)
  })

  test('clicking tabs still switches after dragging a terminal tab to reorder', async ({
    quirkyPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(quirkyPage))!

    await quirkyPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = (state.tabsByWorktree[targetWorktreeId] ?? []).length
      for (let i = existing; i < 2; i++) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(quirkyPage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const domOrderBefore = await quirkyPage.$$eval(SORTABLE_TAB, (nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
    )
    const [firstTabId, secondTabId] = domOrderBefore
    expect(firstTabId).toBeTruthy()
    expect(secondTabId).toBeTruthy()

    await tabLocator(quirkyPage, firstTabId).click({ force: true })
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(firstTabId)

    const firstTabBox = await tabLocator(quirkyPage, firstTabId).boundingBox()
    const secondTabBox = await tabLocator(quirkyPage, secondTabId).boundingBox()
    expect(firstTabBox).not.toBeNull()
    expect(secondTabBox).not.toBeNull()
    const startX = firstTabBox!.x + firstTabBox!.width / 2
    const startY = firstTabBox!.y + firstTabBox!.height / 2
    const endX = secondTabBox!.x + secondTabBox!.width * 0.75
    const endY = secondTabBox!.y + secondTabBox!.height / 2
    await quirkyPage.mouse.move(startX, startY)
    await quirkyPage.mouse.down()
    // Why: this mirrors the release repro: drag a terminal tab across another
    // tab far enough for dnd-kit to commit a reorder, then release on the tab
    // strip before clicking tabs again.
    await quirkyPage.mouse.move(endX, endY, { steps: 8 })
    await quirkyPage.mouse.up()

    await expect
      .poll(
        async () =>
          quirkyPage.$$eval(SORTABLE_TAB, (nodes) =>
            nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
          ),
        { timeout: 5_000, message: 'Terminal tab drag did not reorder the tab strip' }
      )
      .toEqual([secondTabId, firstTabId, ...domOrderBefore.slice(2)])

    await tabLocator(quirkyPage, firstTabId).click({ force: true })
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(firstTabId)
    await tabLocator(quirkyPage, secondTabId).click({ force: true })
    await expect
      .poll(() => getDomActiveTabId(quirkyPage), {
        timeout: 5_000,
        message: 'Tab click did not activate after a terminal tab reorder drag'
      })
      .toBe(secondTabId)
  })

  /**
   * Regression: after a drag-reorder, Cmd/Ctrl+Shift+[ must walk tabs in
   * the new visible order. The pre-fix bug read a stale legacy order
   * (`tabBarOrderByWorktree`), so pressing "left" three times cycled
   * 3 → 1 → 2 instead of 3 → 2 → 1 once tabs had been rearranged.
   *
   * The DOM assertion (`data-active` matching the expected tab element) is
   * the load-bearing check — it fails if the shortcut walks the right store
   * id but the tab bar stops painting the active indicator on that tab.
   */
  test('Cmd/Ctrl+Shift+[ walks tabs in drag-reordered order', async ({ quirkyPage }) => {
    const isMac = process.platform === 'darwin'
    const mod = isMac ? 'Meta' : 'Control'
    const worktreeId = (await getActiveWorktreeId(quirkyPage))!

    // Ensure at least 3 terminal tabs so the order cycle is non-trivial.
    // Why store-driven: we only need >=3 tabs to exist; the "+" flow is
    // already exercised by other tests in this file.
    await quirkyPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = (state.tabsByWorktree[targetWorktreeId] ?? []).length
      for (let i = existing; i < 3; i++) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(async () => (await getWorktreeTabs(quirkyPage, worktreeId)).length, {
        timeout: 5_000
      })
      .toBeGreaterThanOrEqual(3)

    const initialOrder = await getTabBarOrder(quirkyPage, worktreeId)
    expect(initialOrder.length).toBeGreaterThanOrEqual(3)
    const [a, b, c] = initialOrder

    // Reorder via the same store call drag/drop uses: move the first tab to
    // the end so the visible order becomes [b, c, a].
    await quirkyPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const groups = state.groupsByWorktree[targetWorktreeId] ?? []
      const activeGroupId = state.activeGroupIdByWorktree[targetWorktreeId]
      const activeGroup = activeGroupId
        ? groups.find((group) => group.id === activeGroupId)
        : groups[0]
      if (!activeGroup) {
        return
      }
      const [first, ...rest] = activeGroup.tabOrder
      state.reorderUnifiedTabs(activeGroup.id, [...rest, first])
    }, worktreeId)
    await expect
      .poll(async () => getTabBarOrder(quirkyPage, worktreeId), {
        timeout: 3_000
      })
      .toEqual([b, c, a])

    // Activate the last tab in the new visible order, then walk left twice.
    // Expected cycle: a → c → b (i.e. walks the *new* order in reverse).
    await quirkyPage.evaluate((tabId) => {
      window.__store?.getState().setActiveTab(tabId)
    }, a)
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(a)

    await quirkyPage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(c)
    await expect(tabLocator(quirkyPage, c)).toHaveAttribute('data-active', 'true')

    await quirkyPage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 3_000 }).toBe(b)
    await expect(tabLocator(quirkyPage, b)).toHaveAttribute('data-active', 'true')
  })

  /**
   * User Prompt:
   * - closing tabs works
   *
   * Why: clicking the real per-tab close (X) button exercises the same path a
   * user takes and catches regressions where the button silently unmounts.
   * The final assertion counts rendered `[data-testid="sortable-tab"]` nodes
   * so the test fails if the store cleared the tab but the DOM didn't
   * re-render.
   */
  test('closing the active tab removes it and activates a neighbor', async ({ quirkyPage }) => {
    const worktreeId = (await getActiveWorktreeId(quirkyPage))!

    // Need a second tab so we can close one without deactivating the worktree.
    await quirkyPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      if ((state.tabsByWorktree[targetWorktreeId] ?? []).length < 2) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(quirkyPage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const tabsBefore = await countRenderedTabs(quirkyPage)
    const activeId = await getActiveTabId(quirkyPage)
    expect(activeId).not.toBeNull()
    await closeTabFromTabBar(quirkyPage, activeId!)

    await expect
      .poll(() => countRenderedTabs(quirkyPage), {
        timeout: 5_000,
        message: 'Clicking close did not remove the tab element from the DOM'
      })
      .toBe(tabsBefore - 1)
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 5_000 }).not.toBe(activeId)
    await expect.poll(() => getDomActiveTabId(quirkyPage), { timeout: 5_000 }).not.toBeNull()
  })
})
