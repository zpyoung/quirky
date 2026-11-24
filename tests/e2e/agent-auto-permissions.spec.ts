import { test, expect } from './helpers/quirky-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('global Auto syncs native defaults only for supporting agents and persists', async ({
  quirkyPage
}) => {
  await waitForSessionReady(quirkyPage)
  await quirkyPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Quirky store is unavailable')
    }
    return store.getState().updateSettingsOrThrow({ nativeChatPermissionMode: 'accept-edits' })
  })
  await quirkyPage.getByRole('button', { name: 'Settings', exact: true }).click()
  await quirkyPage.getByRole('button', { name: 'Agents', exact: true }).click()
  const group = quirkyPage.getByRole('radiogroup', { name: 'Agent Permissions' })
  const others = quirkyPage.getByRole('radiogroup', { name: 'Permissions for other agents' })
  const readArgs = () =>
    quirkyPage.evaluate(async () => {
      const settings = await window.api.settings.get()
      return {
        claude: settings.agentDefaultArgs?.claude,
        codex: settings.agentDefaultArgs?.codex,
        gemini: settings.agentDefaultArgs?.gemini,
        native: settings.nativeChatPermissionMode,
        claudeNative: settings.agentNativeChatPermissionModes?.claude,
        codexNative: settings.agentNativeChatPermissionModes?.codex,
        grokNative: settings.agentNativeChatPermissionModes?.grok
      }
    })

  await group.getByRole('radio', { name: 'Yolo', exact: true }).click()
  await expect(others).toHaveCount(0)
  await group.getByRole('radio', { name: 'Auto', exact: true }).click()
  await expect(group.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(others.getByRole('radio', { name: 'Yolo', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(readArgs).toEqual({
    claude: '--permission-mode auto',
    codex: '--approve-for-me',
    gemini: '--yolo',
    native: 'full-access',
    claudeNative: 'auto',
    codexNative: 'auto',
    grokNative: undefined
  })

  await others.getByRole('radio', { name: 'Manual', exact: true }).click()
  await expect.poll(readArgs).toEqual({
    claude: '--permission-mode auto',
    codex: '--approve-for-me',
    gemini: '',
    native: 'full-access',
    claudeNative: 'auto',
    codexNative: 'auto',
    grokNative: 'ask'
  })

  await quirkyPage.reload()
  await quirkyPage.waitForFunction(() => Boolean(window.__store))
  await waitForSessionReady(quirkyPage)
  await quirkyPage.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(group.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(others.getByRole('radio', { name: 'Manual', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(readArgs).toMatchObject({
    native: 'full-access',
    claudeNative: 'auto',
    codexNative: 'auto',
    grokNative: 'ask'
  })

  await group.getByRole('radio', { name: 'Manual', exact: true }).click()
  await expect.poll(readArgs).toEqual({
    claude: '',
    codex: '',
    gemini: '',
    native: 'ask',
    claudeNative: undefined,
    codexNative: undefined,
    grokNative: undefined
  })
})
