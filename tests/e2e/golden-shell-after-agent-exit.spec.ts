import { expect, test } from './helpers/quirky-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_EXIT_MARKER,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

// Why: xterm renders the typed command itself, so `echo after-agent` would
// satisfy waitForTerminalOutput even if the shell never ran it. Splitting the
// marker keeps it out of the input, so a match proves real shell execution.
function buildSplitMarkerEcho(prefix: string, suffix: string): { command: string; marker: string } {
  const command =
    process.platform === 'win32'
      ? `Write-Output ('${prefix}' + '${suffix}')`
      : `echo "${prefix}""${suffix}"`
  return { command, marker: `${prefix}${suffix}` }
}

test('opens a clean live shell after an agent exits', async ({ quirkyPage }) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  await ensureTerminalVisible(quirkyPage)
  await configureGoldenStubAgent(quirkyPage)
  await launchGoldenStubAgentFromNewTab(quirkyPage)

  await quirkyPage.keyboard.type('exit')
  await quirkyPage.keyboard.press('Enter')
  await waitForTerminalOutput(quirkyPage, GOLDEN_STUB_EXIT_MARKER, 15_000)

  const tabsBeforeShell = await quirkyPage.locator('[data-testid="sortable-tab"]').count()
  await quirkyPage.getByRole('button', { name: 'New tab' }).click({ force: true })
  await quirkyPage
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect(quirkyPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
  const shellPtyId = await waitForActivePanePtyId(quirkyPage)
  // Why: a bound ptyId only means the pane exists; the renderer transport can
  // still drop keystrokes until it connects, which would strand the markers.
  expect(await waitForRestoredTerminalInputReady(quirkyPage, shellPtyId)).toBe(true)

  const afterAgent = buildSplitMarkerEcho('after-', 'agent')
  await focusActiveTerminalInput(quirkyPage)
  await quirkyPage.keyboard.type(afterAgent.command)
  await quirkyPage.keyboard.press('Enter')
  await waitForTerminalOutput(quirkyPage, afterAgent.marker, 15_000)

  const afterShiftEnter = buildSplitMarkerEcho('after-shift-', 'enter')
  await quirkyPage.keyboard.press('Shift+Enter')
  await quirkyPage.keyboard.type(afterShiftEnter.command)
  await quirkyPage.keyboard.press('Enter')
  await waitForTerminalOutput(quirkyPage, afterShiftEnter.marker, 15_000)
  await expect(quirkyPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
})
