import { afterEach, expect, test } from 'bun:test'
import { SCENARIO_MS, cleanupUi, isAlive, panesOf, startUi, waitFor, type E2eHarness, type Workspace } from '../../../quirky.terminal/test/e2e-ui/support'
import type { Session } from '@quirky/protocol'
import type { PanelState } from '../../src/types'

afterEach(cleanupUi)

async function waitForAgentProcess(h: E2eHarness, session: string): Promise<void> {
  await waitFor(`a running agent process for ${session}`, async () => {
    const row = await h.hostRow(session)
    return row?.state === 'running' && isAlive(row.pid) ? row : undefined
  })
}

test(
  'SC-1, SC-2, SC-7, and SC-32: the mounted panel follows focused agents and opens resumed sessions',
  async () => {
    const ui = await startUi({ agents: ['claude', 'codex'] })
    const { h } = ui
    const initial = await ui.waitLayout('the initial shell pane', (workspace) => panesOf(workspace).length > 0)
    const initialPane = panesOf(initial)[0]
    if (!initialPane) throw new Error('Expected the initial shell pane')
    const shell = { session: initialPane.session }

    await ui.run('command:quirky.session-info/open')
    const panel = await ui.el<HTMLElement>('main[aria-label=\"Session Info\"]')
    await waitFor('the empty focused shell state', () => panel.textContent?.includes('No agent session') ? true : undefined)
    expect(panel.textContent).toContain('Focus a terminal pane with an agent session to inspect it here.')

    const { workspace: claudeWorkspace } = await h.json<{ workspace: Workspace }>(['terminal', 'tab', 'new', '--agent', 'claude', '--worktree', 'main'])
    const claudePane = panesOf(claudeWorkspace).find((pane) => pane.session !== shell.session)!
    await waitForAgentProcess(h, claudePane.session)
    await h.call('quirky.terminal/focusPane', { pane: claudePane.id, workspace: 'main' })
    const claude = await h.call<PanelState>('quirky.session-info/get', {})
    expect(claude.info?.identity).toMatchObject({ agent: 'claude', sessionId: claudePane.session, pane: claudePane.id })
    await waitFor('the panel to follow Claude', () => panel.textContent?.includes('claude') ? true : undefined)

    const { workspace: codexWorkspace } = await h.json<{ workspace: Workspace }>(['terminal', 'tab', 'new', '--agent', 'codex', '--worktree', 'main'])
    const codexPane = panesOf(codexWorkspace).find((pane) => pane.session !== claudePane.session && pane.session !== shell.session)!
    await waitForAgentProcess(h, codexPane.session)
    await h.call('quirky.terminal/focusPane', { pane: codexPane.id, workspace: 'main' })
    const codex = await h.call<PanelState>('quirky.session-info/get', {})
    expect(codex.info?.identity).toMatchObject({ agent: 'codex', sessionId: codexPane.session, pane: codexPane.id })
    expect(codex.info?.usage).toBeUndefined()
    expect(codex.info?.context).toBeUndefined()
    expect(codex.info?.filesTouched).toBeUndefined()
    await waitFor('the panel to follow Codex without Claude-only sections', () => panel.textContent?.includes('codex') && !panel.textContent.includes('Total tokens') ? true : undefined)
    expect(panel.textContent).not.toContain('No agent session')
    await ui.run('command:quirky.session-info/focus-pane', { session: claudePane.session })
    const focusedView = await ui.waitView('the Session Info target pane', (view) => view.focusedPane === claudePane.id)
    expect(focusedView.active).toBe(claudePane.session)
    const focusedTerminal = ui.term(claudePane.id)
    if (!focusedTerminal) throw new Error('Expected the focused terminal to be mounted')
    const textarea = focusedTerminal.textarea
    if (!textarea) throw new Error('Expected the focused terminal textarea to be mounted')
    expect(ui.win.document.activeElement).toBe(textarea)
    expect(focusedTerminal.buffer.active.viewportY).toBe(focusedTerminal.buffer.active.baseY)
    await h.ok(['session', 'set-provider-session', claudePane.session, 'provider-123'])
    const resumed = await ui.run('command:quirky.session-info/resume', { session: claudePane.session }) as Session
    expect(resumed.resumedFrom).toBe(claudePane.session)
    await ui.waitView('the resumed agent session', (view) => view.active === resumed.id)
    const resumedProjection = await h.call<PanelState>('quirky.session-info/get', {})
    expect(resumedProjection.info?.identity.sessionId).toBe(resumed.id)

    const forked = await ui.run('command:quirky.session-info/fork', { session: claudePane.session }) as Session
    expect(forked.resumedFrom).toBe(claudePane.session)
    await ui.waitView('the forked agent session', (view) => view.active === forked.id)
    const forkedProjection = await h.call<PanelState>('quirky.session-info/get', {})
    expect(forkedProjection.info?.identity.sessionId).toBe(forked.id)
  },
  SCENARIO_MS
)
