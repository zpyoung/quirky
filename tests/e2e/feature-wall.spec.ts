import { test, expect } from './helpers/quirky-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { ElectronApplication } from '@stablyai/playwright-test'

async function openFeatureTourFromMenu(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const featureTourItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'Help')
      ?.submenu?.items.find((item) => item.label === 'Explore Quirky')

    if (!featureTourItem) {
      throw new Error('Explore Quirky menu item was not registered')
    }

    const window = BrowserWindow.getAllWindows()[0]
    featureTourItem.click(featureTourItem, window, {
      triggeredByAccelerator: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false
    } as Electron.KeyboardEvent)
  })
}

test.describe('Feature tour modal', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
  })

  test('opens from the Help menu and renders the workflow rail', async ({
    electronApp,
    quirkyPage
  }) => {
    await openFeatureTourFromMenu(electronApp)

    await expect(quirkyPage.getByRole('dialog', { name: 'Get to know Quirky' })).toBeVisible({
      timeout: 10_000
    })
    await expect(quirkyPage.getByText('Reopen any time from Help > Explore Quirky.')).toBeVisible()

    // Five workflow rows in the rail.
    const rail = quirkyPage.getByRole('navigation', { name: 'Workflows' })
    await expect(rail.getByRole('tab')).toHaveCount(5)
    await expect(rail.getByRole('tab', { name: /Workspaces/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await expect(quirkyPage.locator('[data-ws-id]')).toHaveCount(3)

    // ArrowDown moves selection through the rail.
    await rail.getByRole('tab', { name: /Workspaces/i }).focus()
    await quirkyPage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')
    await quirkyPage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await rail.getByRole('button', { name: /Browser/i }).click()
    await expect(
      quirkyPage.getByText(
        "Run your app in Quirky's browser, send selected UI elements to agents, and let your agents interact with your webpage."
      )
    ).toBeVisible()
    await expect(quirkyPage.getByRole('heading', { name: 'Browser Use skill' })).toBeVisible()
    await expect(
      quirkyPage.getByText("Enables agents to navigate and verify pages in Quirky's browser.")
    ).toBeVisible()
    await expect(quirkyPage.getByRole('heading', { name: 'CLI skill' })).toHaveCount(0)
    await expect(quirkyPage.getByText('With the Quirky CLI skill', { exact: false })).toHaveCount(0)
  })

  test('shows unified task copy without leaving the walkthrough', async ({ quirkyPage }) => {
    await quirkyPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        preflightStatus: {
          git: { installed: true },
          gh: { installed: true, authenticated: false },
          glab: { installed: false, authenticated: false }
        },
        preflightStatusChecked: true,
        preflightStatusLoading: false,
        linearStatus: { connected: false, viewer: null },
        linearStatusChecked: true
      })
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    await expect(quirkyPage.getByRole('dialog', { name: 'Get to know Quirky' })).toBeVisible({
      timeout: 10_000
    })
    await quirkyPage
      .getByRole('navigation', { name: 'Workflows' })
      .getByRole('tab', { name: /Tasks/i })
      .click()
    await expect(quirkyPage.getByText('Start work directly from GitHub or Linear.')).toBeVisible()
    await expect(quirkyPage.getByText('Connect GitHub or Linear once')).toHaveCount(0)
    await expect(quirkyPage.getByRole('dialog', { name: 'Get to know Quirky' })).toBeVisible()
    await expect
      .poll(async () => getStoreState<string>(quirkyPage, 'activeView'))
      .not.toBe('settings')
  })

  test('continue advances through workflow substeps before the next workflow', async ({
    quirkyPage
  }) => {
    await quirkyPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = quirkyPage.getByRole('navigation', { name: 'Workflows' })
    const continueButton = quirkyPage.getByRole('button', { name: /^Continue/ })

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: /Visibility/i })).toHaveAttribute(
      'aria-current',
      'step'
    )

    await continueButton.click()
    await expect(rail.getByRole('button', { name: /Orchestration/i })).toHaveAttribute(
      'aria-current',
      'step'
    )
    await expect(rail.getByRole('tab', { name: /Workbench/i })).toHaveAttribute(
      'aria-selected',
      'false'
    )

    await continueButton.click()
    await expect(rail.getByRole('button', { name: /Usage/i })).toHaveAttribute(
      'aria-current',
      'step'
    )

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Workbench/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: /Terminal/i })).toHaveAttribute(
      'aria-current',
      'step'
    )
  })

  test('does not pre-check configured workflows until the user visits them', async ({
    quirkyPage,
    electronApp
  }) => {
    await electronApp.evaluate(
      ({ ipcMain }, preflightStatus) => {
        ipcMain.removeHandler('preflight:check')
        ipcMain.handle('preflight:check', () => preflightStatus)
        ipcMain.removeHandler('linear:status')
        ipcMain.handle('linear:status', () => ({ connected: false, viewer: null }))
        ipcMain.removeHandler('jira:status')
        ipcMain.handle('jira:status', () => ({ connected: false, viewer: null }))
      },
      {
        git: { installed: true },
        gh: { installed: true, authenticated: true },
        glab: { installed: false, authenticated: false }
      }
    )
    await quirkyPage.evaluate(async () => {
      for (const key of [
        'quirky.featureWall.visitedWorkflows.v1',
        'quirky.featureWall.visitedAgentSteps.v1',
        'quirky.featureWall.visitedWorkbenchSteps.v1',
        'quirky.featureWall.visitedReviewSteps.v1',
        'quirky.featureWall.completedWorkflows.v1',
        'quirky.featureWall.completedAgentSteps.v1',
        'quirky.featureWall.completedWorkbenchSteps.v1',
        'quirky.featureWall.completedReviewSteps.v1'
      ]) {
        localStorage.removeItem(key)
      }
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Seed through the status actions so each result gets the current execution context.
      await Promise.all([
        store.getState().refreshPreflightStatus({ force: true }),
        store.getState().checkLinearConnection(true),
        store.getState().checkJiraConnection()
      ])
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = quirkyPage.getByRole('navigation', { name: 'Workflows' })
    const workspacesTab = rail.locator('[data-feature-wall-workflow-id="workspaces"]')
    const tasksTab = rail.locator('[data-feature-wall-workflow-id="tasks"]')
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(0)
    await tasksTab.click()
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(1)
  })

  test('keeps persisted completed setup-backed substeps checked when reopened', async ({
    quirkyPage
  }) => {
    await quirkyPage.evaluate(() => {
      localStorage.setItem(
        'quirky.featureWall.completedAgentSteps.v1',
        JSON.stringify(['orchestration'])
      )
      localStorage.setItem(
        'quirky.featureWall.completedWorkbenchSteps.v1',
        JSON.stringify(['browser'])
      )
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = quirkyPage.getByRole('navigation', { name: 'Workflows' })

    await rail.getByRole('tab', { name: /Agents/i }).click()
    await expect(
      rail.getByRole('button', { name: /Orchestration/i }).locator('[aria-label="Completed"]')
    ).toHaveCount(1)

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await expect(
      rail.getByRole('button', { name: /Browser/i }).locator('[aria-label="Completed"]')
    ).toHaveCount(1)
  })
})
