import { test, expect } from './helpers/quirky-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    quirkyPage
  }) => {
    await quirkyPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(quirkyPage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await quirkyPage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(quirkyPage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = quirkyPage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(quirkyPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(quirkyPage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(quirkyPage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(quirkyPage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(quirkyPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(quirkyPage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await quirkyPage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(quirkyPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await quirkyPage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(quirkyPage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
