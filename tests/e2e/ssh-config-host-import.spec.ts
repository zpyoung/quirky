/**
 * E2E: SSH config bulk import (picker "Add all") vs Settings Import re-adopt.
 * Covers plan cases P5, P6, P7, P9. Picker list/filter/select live in
 * ssh-config-host-picker.spec.ts.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/quirky-app'
import { waitForSessionReady } from './helpers/store'
import {
  buildSshConfigBody,
  configHostRow,
  expectSshHostAbsentFromSettings,
  expectSshHostListedInSettings,
  makeSshConfigHostPrefix,
  openSshConfigHostPicker,
  openSshHostSettings,
  removeSshTargetByAlias,
  removeSshTargetsByPrefix,
  returnToAppShell,
  seedIsolatedSshConfig,
  seedQuirkySshTargetMatchingAlias,
  type SeededSshConfigHost
} from './helpers/ssh-config-host-picker'

test.use({ seedTestRepo: false })

// Why: afterEach deletes every target carrying this prefix; workers loading the
// module in the same millisecond must not collide on a shared Date.now().
const HOST_PREFIX = makeSshConfigHostPrefix()

function pairHosts(prefix: string): { alpha: SeededSshConfigHost; bravo: SeededSshConfigHost } {
  return {
    alpha: {
      alias: `${prefix}-alpha`,
      hostname: `${prefix}-alpha.example.test`,
      user: 'deploy',
      port: 22
    },
    bravo: {
      alias: `${prefix}-bravo`,
      hostname: `${prefix}-bravo.example.test`,
      user: 'ops',
      port: 2222
    }
  }
}

async function seedPairConfig(
  electronApp: ElectronApplication,
  prefix: string
): Promise<{ alpha: SeededSshConfigHost; bravo: SeededSshConfigHost }> {
  const hosts = pairHosts(prefix)
  await seedIsolatedSshConfig(electronApp, buildSshConfigBody([hosts.alpha, hosts.bravo]))
  return hosts
}

/** Import both config hosts via picker, then suppress `alias` (removeTarget tombstone). */
async function importPairThenDeleteAlias(
  page: Page,
  electronApp: ElectronApplication,
  prefix: string,
  aliasToDelete: string
): Promise<{ alpha: SeededSshConfigHost; bravo: SeededSshConfigHost }> {
  const hosts = await seedPairConfig(electronApp, prefix)
  const picker = await openSshConfigHostPicker(page)
  await expect(picker.getByRole('button', { name: 'Add all 2 to Quirky' })).toBeEnabled()
  await picker.getByRole('button', { name: 'Add all 2 to Quirky' }).click()
  await expect(page.getByText('Added 2 hosts to Quirky.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('dialog', { name: 'Choose from ~/.ssh/config' })).toBeHidden({
    timeout: 10_000
  })
  await expect(page.getByRole('dialog', { name: 'Add SSH host' })).toBeHidden({
    timeout: 10_000
  })
  await removeSshTargetByAlias(page, aliasToDelete)
  return hosts
}

test.describe('SSH config host import (bulk + settings re-adopt)', () => {
  test.beforeEach(async ({ quirkyPage }) => {
    await waitForSessionReady(quirkyPage)
  })

  test.afterEach(async ({ quirkyPage }) => {
    await removeSshTargetsByPrefix(quirkyPage, HOST_PREFIX).catch(() => undefined)
  })

  // ── P5 ─────────────────────────────────────────────────────────────
  test('P5: already-in-Quirky badge, disabled row, and Add all counts only new hosts', async ({
    electronApp,
    quirkyPage
  }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    await seedQuirkySshTargetMatchingAlias(quirkyPage, {
      alias: hosts.alpha.alias,
      hostname: hosts.alpha.hostname,
      username: hosts.alpha.user,
      port: hosts.alpha.port
    })

    const picker = await openSshConfigHostPicker(quirkyPage)
    const alphaRow = configHostRow(picker, hosts.alpha)
    const bravoRow = configHostRow(picker, hosts.bravo)

    await expect(alphaRow).toBeVisible()
    await expect(alphaRow).toBeDisabled()
    await expect(alphaRow.getByText('In Quirky', { exact: true })).toBeVisible()

    await expect(bravoRow).toBeVisible()
    await expect(bravoRow).toBeEnabled()
    await expect(bravoRow.getByText('In Quirky', { exact: true })).toHaveCount(0)

    await expect(picker.getByRole('button', { name: 'Add all 1 to Quirky' })).toBeEnabled()
    await expect(picker.getByRole('button', { name: 'Add all 2 to Quirky' })).toHaveCount(0)
  })

  // ── P6 ─────────────────────────────────────────────────────────────
  test('P6: Add all N to Quirky imports new hosts; re-open shows all in Quirky', async ({
    electronApp,
    quirkyPage
  }) => {
    const hosts = await seedPairConfig(electronApp, HOST_PREFIX)
    const picker = await openSshConfigHostPicker(quirkyPage)

    await expect(configHostRow(picker, hosts.alpha)).toBeVisible()
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Add all 2 to Quirky' })).toBeEnabled()

    await picker.getByRole('button', { name: 'Add all 2 to Quirky' }).click()
    await expect(quirkyPage.getByText('Added 2 hosts to Quirky.')).toBeVisible({ timeout: 15_000 })
    await expect(quirkyPage.getByRole('dialog', { name: 'Choose from ~/.ssh/config' })).toBeHidden({
      timeout: 10_000
    })
    await expect(quirkyPage.getByRole('dialog', { name: 'Add SSH host' })).toBeHidden({
      timeout: 10_000
    })

    const sshSection = await openSshHostSettings(quirkyPage)
    await expectSshHostListedInSettings(sshSection, hosts.alpha)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)

    await returnToAppShell(quirkyPage)
    const reopened = await openSshConfigHostPicker(quirkyPage)
    await expect(configHostRow(reopened, hosts.alpha)).toBeDisabled()
    await expect(
      configHostRow(reopened, hosts.alpha).getByText('In Quirky', { exact: true })
    ).toBeVisible()
    await expect(configHostRow(reopened, hosts.bravo)).toBeDisabled()
    await expect(
      configHostRow(reopened, hosts.bravo).getByText('In Quirky', { exact: true })
    ).toBeVisible()
    await expect(reopened.getByRole('button', { name: 'No new hosts to add' })).toBeDisabled()
  })

  // ── P7 ─────────────────────────────────────────────────────────────
  test('P7: Add all does not re-adopt deleted config hosts (suppress tombstones)', async ({
    electronApp,
    quirkyPage
  }) => {
    const hosts = await importPairThenDeleteAlias(
      quirkyPage,
      electronApp,
      HOST_PREFIX,
      `${HOST_PREFIX}-alpha`
    )

    const picker = await openSshConfigHostPicker(quirkyPage)
    // Suppressed aliases stay listed (re-pickable) but never count as new.
    const alphaRow = configHostRow(picker, hosts.alpha)
    await expect(alphaRow).toBeVisible()
    await expect(alphaRow).toBeEnabled()
    await expect(alphaRow.getByText('Removed from Quirky', { exact: true })).toBeVisible()
    await expect(alphaRow.getByText('In Quirky', { exact: true })).toHaveCount(0)
    await expect(configHostRow(picker, hosts.bravo)).toBeVisible()
    await expect(
      configHostRow(picker, hosts.bravo).getByText('In Quirky', { exact: true })
    ).toBeVisible()
    await expect(picker.getByRole('button', { name: 'No new hosts to add' })).toBeDisabled()
    await expect(picker.getByRole('button', { name: /Add all \d+ to Quirky/ })).toHaveCount(0)

    await returnToAppShell(quirkyPage)
    const sshSection = await openSshHostSettings(quirkyPage)
    // Pane auto-syncs without reAdopt — deleted alpha must stay gone.
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)
  })

  // ── P9 ─────────────────────────────────────────────────────────────
  test('P9: Sync keeps deleted config hosts; Restore removed hosts re-adopts them', async ({
    electronApp,
    quirkyPage
  }) => {
    const hosts = await importPairThenDeleteAlias(
      quirkyPage,
      electronApp,
      HOST_PREFIX,
      `${HOST_PREFIX}-alpha`
    )

    const sshSection = await openSshHostSettings(quirkyPage)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)

    // Sync never lifts a removal, so bulk removal sticks.
    await sshSection.getByRole('button', { name: 'Sync ~/.ssh/config' }).click()
    await expect(quirkyPage.getByText(/already in sync|Synced \d+ servers?/i).first()).toBeVisible({
      timeout: 15_000
    })
    await expectSshHostAbsentFromSettings(sshSection, hosts.alpha)

    await sshSection.getByRole('button', { name: 'More SSH host actions' }).click()
    // The label carries the removed count once ~/.ssh/config is read; click waits for it to enable.
    await quirkyPage.getByRole('menuitem', { name: /^Restore removed hosts \(\d+\)…$/ }).click()
    const restoreDialog = quirkyPage.getByRole('dialog', { name: 'Restore removed hosts?' })
    await expect(restoreDialog.getByText(hosts.alpha.alias)).toBeVisible({ timeout: 15_000 })
    await restoreDialog.getByRole('button', { name: 'Restore' }).click()
    await expect(quirkyPage.getByText(/Synced \d+ servers?/i)).toBeVisible({ timeout: 15_000 })

    await expectSshHostListedInSettings(sshSection, hosts.alpha)
    await expectSshHostListedInSettings(sshSection, hosts.bravo)
  })
})
