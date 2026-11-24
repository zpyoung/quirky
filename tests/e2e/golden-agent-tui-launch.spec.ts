import { expect, test } from './helpers/quirky-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, getTerminalContent } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test('launches an agent TUI with a live multiline composer', async ({ quirkyPage }) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  await ensureTerminalVisible(quirkyPage)
  await configureGoldenStubAgent(quirkyPage)
  await launchGoldenStubAgentFromNewTab(quirkyPage)

  const activeTab = quirkyPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  await expect(activeTab).toHaveAttribute('data-tab-title', /Codex|Golden Stub Agent/i)

  await focusActiveTerminalInput(quirkyPage)
  await quirkyPage.keyboard.type('hello from e2e')
  await quirkyPage.keyboard.press('Shift+Enter')
  await quirkyPage.keyboard.type('second line')

  await expect
    .poll(() => getTerminalContent(quirkyPage), { timeout: 10_000 })
    .toContain('> hello from e2e\r\n  second line')
  expect(await getTerminalContent(quirkyPage)).not.toContain('GOLDEN_STUB_AGENT_SUBMITTED')
})
