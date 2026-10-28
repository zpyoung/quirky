import { afterEach, expect, test } from 'bun:test'
import { cleanupUi, leavesOf, openTab, startUi, tabsOf, waitFor } from '../../quirky.terminal/test/e2e-ui/support'
import type { DockState } from '../src/types'
import { enableDock, launchFakeClaude, paneOf, startDockE2E, type DockHarness } from './support'

let harness: DockHarness | undefined
afterEach(async () => {
  await cleanupUi()
  harness = undefined
})

test(
  'SC-23: generated dock CLI reads, revision-edits, toggles and lists the canonical daemon state',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)

    const initial = await harness.json<DockState>(['dock', 'get', '--pane', pane])
    expect(initial.docked).toBe(true)
    const edited = await harness.json<DockState>([
      'dock',
      'set',
      '--pane', pane,
      '--revision',
      String(initial.revision),
      '--draft',
      'set through CLI'
    ])
    expect(edited.draft).toBe('set through CLI')
    const resized = await harness.json<DockState>(['dock', 'set', '--pane', pane, '--gutter-rows', '7'])
    expect(resized.gutterRows).toBe(7)

    const toggled = await harness.json<DockState>(['dock', 'toggle', '--pane', pane])
    expect(toggled.docked).toBe(false)
    expect(toggled.userUndocked).toBe(true)
    const listed = await harness.json<{ panes: DockState[] }>(['dock', 'list'])
    expect(listed.panes.find((state) => state.pane === pane)?.draft).toBe('set through CLI')
  },
  90_000
)

test(
  'SC-23: CLI passthrough is absolute and requires the active mounted dock host',
  async () => {
    const ui = await startUi({ agents: ['claude'] })
    const activeHarness = ui.h
    ui.win.setFocus(true)
    await waitFor('focused active UI window', async () => {
      const state = await activeHarness.call<{ windows: { focused: boolean }[] }>('ui.state')
      return state.windows.some((window) => window.focused) ? true : undefined
    })
    const initialWorkspace = await ui.waitLayout('its initial terminal pane', (workspace) => tabsOf(workspace).length > 0)
    const shellPane = leavesOf(tabsOf(initialWorkspace)[0]!.root)[0]!.id
    await enableDock(activeHarness)

    const agent = await openTab(activeHarness, ['--agent', 'claude'], { ready: false })
    const pane = agent.pane.id
    await ui.waitView('the recognized Claude pane', (view) =>
      view.tabs.some((tab) => tab.session === agent.session && tab.agent === 'claude')
    )
    const editor = await ui.el<HTMLTextAreaElement>('.qtd-editor')
    await waitFor('focused mounted dock host report', async () => {
      const state = await activeHarness.call<DockState>('quirky.terminal-dock/get', { pane })
      const report = ui.calls.some((call) =>
        call.method === 'quirky.terminal-dock/report' && call.params.pane === pane &&
        call.params.mounted === true && call.params.focused === true
      )
      return state.mounted && report && ui.win.document.activeElement === editor ? true : undefined
    })

    const setPassthrough = (desired: boolean) =>
      activeHarness.json<DockState>(['dock', 'set', '--pane', pane, `--passthrough=${desired}`])
    expect((await setPassthrough(true)).passthrough).toBe(true)
    expect((await setPassthrough(true)).passthrough).toBe(true)
    expect((await setPassthrough(false)).passthrough).toBe(false)
    expect((await setPassthrough(false)).passthrough).toBe(false)

    const beforeUnhostedSet = await activeHarness.call<DockState>('quirky.terminal-dock/get', { pane: shellPane })
    const unhosted = await activeHarness.cli([
      'dock', 'set',
      '--pane', shellPane,
      '--passthrough=true',
      '--gutter-rows', '11'
    ])
    expect(unhosted.code).not.toBe(0)
    expect(unhosted.stderr).toContain('passthrough requires the active mounted dock host')
    const afterUnhostedSet = await activeHarness.call<DockState>('quirky.terminal-dock/get', { pane: shellPane })
    expect(afterUnhostedSet.gutterRows).toBe(beforeUnhostedSet.gutterRows)
    expect(afterUnhostedSet.passthrough).toBe(beforeUnhostedSet.passthrough)

    await ui.stop()
    await waitFor('headless UI window disconnect', async () => {
      const state = await activeHarness.call<{ windows: unknown[] }>('ui.state')
      return state.windows.length === 0 ? true : undefined
    })
    const beforeNoWindowSet = await activeHarness.call<DockState>('quirky.terminal-dock/get', { pane })
    const noWindow = await activeHarness.cli([
      'dock', 'set',
      '--pane', pane,
      '--passthrough=true',
      '--gutter-rows', '11'
    ])
    expect(noWindow.code).not.toBe(0)
    expect(noWindow.stderr).toContain('no Quirky window is open')
    const afterNoWindowSet = await activeHarness.call<DockState>('quirky.terminal-dock/get', { pane })
    expect(afterNoWindowSet.gutterRows).toBe(beforeNoWindowSet.gutterRows)
    expect(afterNoWindowSet.passthrough).toBe(beforeNoWindowSet.passthrough)
  },
  90_000
)
