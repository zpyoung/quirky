/** E2E coverage for copying provider identity from the exact terminal pane. */

import { test, expect } from './helpers/quirky-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForPaneIdentitySnapshot } from './helpers/terminal'
import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'

const SESSION_ID = 'e2e-terminal-pane-session'

test('terminal pane context menu copies its agent session ID', async ({ quirkyPage }) => {
  await waitForSessionReady(quirkyPage)
  const worktreeId = await waitForActiveWorktree(quirkyPage)
  await ensureTerminalVisible(quirkyPage)

  const tabId = await getActiveTabId(quirkyPage)
  if (!tabId) {
    throw new Error('No active terminal tab')
  }
  const snapshot = await waitForPaneIdentitySnapshot(quirkyPage, 1)
  const leafId = snapshot.panes[0]?.leafId
  if (!leafId) {
    throw new Error('No active terminal pane')
  }
  const paneKey = `${tabId}:${leafId}`

  // Keep this independent of an installed provider CLI while exercising the
  // durable pane identity used when transient live status has been cleared.
  await quirkyPage.evaluate(
    ({ paneKey, tabId, worktreeId, sessionId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      state.recordAgentProviderSession(
        paneKey,
        'claude',
        { key: 'session_id', id: sessionId },
        undefined,
        { tabId, worktreeId }
      )
    },
    { paneKey, tabId, worktreeId, sessionId: SESSION_ID }
  )

  await expect
    .poll(
      () =>
        quirkyPage.evaluate(
          ({ paneKey }) =>
            window.__store?.getState().sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id,
          { paneKey }
        ),
      { timeout: 3_000 }
    )
    .toBe(SESSION_ID)

  await openTerminalContextMenu(quirkyPage)

  const identityItems = await quirkyPage.getByRole('menuitem').allInnerTexts()
  const sessionIdIndex = identityItems.indexOf('Copy Session ID')
  expect(identityItems.slice(sessionIdIndex, sessionIdIndex + 3)).toEqual([
    'Copy Session ID',
    'Copy Terminal ID',
    'Copy Pane ID'
  ])

  const copyItem = quirkyPage.getByRole('menuitem', { name: 'Copy Session ID', exact: true })
  await expect(copyItem).toBeVisible()
  await copyItem.click()

  await expect
    .poll(() => quirkyPage.evaluate(() => window.api.ui.readClipboardText()), { timeout: 3_000 })
    .toBe(SESSION_ID)
})
