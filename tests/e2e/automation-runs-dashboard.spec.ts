/**
 * End-to-end coverage for the Automations runs surface.
 *
 * The test intentionally does not depend on seeded run history: a fresh E2E
 * profile may have no automations, but the Runs navigation and empty state must
 * still be usable.
 */

import { test, expect } from './helpers/quirky-app'
import { waitForSessionReady } from './helpers/store'

test('opens the runs dashboard and returns to automations', async ({ quirkyPage }) => {
  await waitForSessionReady(quirkyPage)

  await quirkyPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().openAutomationsPage()
  })

  const runsButton = quirkyPage.getByRole('button', { name: 'Runs' })
  await expect(runsButton).toBeVisible()
  await runsButton.click()

  await expect(quirkyPage.getByRole('navigation', { name: 'Automations breadcrumb' })).toBeVisible()
  await expect(quirkyPage.getByText('Successful · 24h')).toBeVisible()
  await expect(quirkyPage.getByText('Failed · 24h')).toBeVisible()
  await expect(quirkyPage.getByText('Successful · 7d')).toBeVisible()
  await expect(quirkyPage.getByText('Failed · 7d')).toBeVisible()
  await expect(quirkyPage.getByRole('button', { name: 'Filters' })).toBeVisible()
  await expect(quirkyPage.getByRole('button', { name: 'Refresh runs' })).toBeVisible()
  await expect(quirkyPage.getByText('Automation', { exact: true })).toBeVisible()
  await expect(quirkyPage.getByText('Triggered', { exact: true })).toBeVisible()
  await expect(quirkyPage.getByText('Status', { exact: true })).toBeVisible()

  await quirkyPage
    .getByRole('navigation', { name: 'Automations breadcrumb' })
    .getByRole('button', { name: 'Automations' })
    .click()
  await expect(quirkyPage.getByRole('heading', { name: 'Automations' })).toBeVisible()
  await expect(runsButton).toBeVisible()
})
