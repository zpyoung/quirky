import { test, expect } from './helpers/quirky-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

test('Pi modal hooks show the existing waiting-for-input indicator', async ({
  quirkyPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(quirkyPage)
  await waitForActiveWorktree(quirkyPage)
  await ensureTerminalVisible(quirkyPage)
  await waitForActiveTerminalManager(quirkyPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const ptyId = await waitForActivePanePtyId(quirkyPage)
  const marker = '__PI_MODAL_STATUS_READY__'
  await sendToTerminal(quirkyPage, ptyId, `printf '${marker}\\n'\r`)
  await waitForTerminalOutput(quirkyPage, marker)
  const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(quirkyPage)

  async function emit(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/pi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Quirky-Agent-Hook-Token': endpoint.token
      },
      body: JSON.stringify({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId,
        env: endpoint.env,
        version: endpoint.version,
        payload
      })
    })
    expect(response.status).toBe(204)
  }

  // Terminal tabs present both waiting and blocked as "Needs attention".
  const waiting = quirkyPage.locator('[aria-label="Needs attention"]')
  await emit({ hook_event_name: 'before_agent_start', prompt: 'Pi modal status check' })
  await expect(quirkyPage.locator('[aria-label="Working"]').first()).toBeVisible()
  await quirkyPage.screenshot({ path: testInfo.outputPath('before-working.png') })

  await emit({ hook_event_name: 'ui_prompt_start', ui_prompt_active: true })
  await expect
    .poll(() =>
      quirkyPage.evaluate(
        (key) => window.__store?.getState().agentStatusByPaneKey[key]?.state,
        paneKey
      )
    )
    .toBe('waiting')
  await expect(waiting.first()).toBeVisible()
  await quirkyPage.screenshot({ path: testInfo.outputPath('after-waiting.png') })
  await emit({ hook_event_name: 'tool_execution_end', tool_name: 'bash', ui_prompt_active: true })
  await expect(waiting.first()).toBeVisible()

  await emit({ hook_event_name: 'ui_prompt_end', is_idle: false })
  await expect(waiting).toHaveCount(0)
  await expect(quirkyPage.locator('[aria-label="Working"]').first()).toBeVisible()
  await emit({ hook_event_name: 'agent_end' })
  await expect(quirkyPage.locator('[aria-label="Working"]')).toHaveCount(0)
  await expect(waiting).toHaveCount(0)
})
