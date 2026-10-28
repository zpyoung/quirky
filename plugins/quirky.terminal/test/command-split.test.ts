import { afterEach, expect, test } from 'bun:test'
import {
  cleanupAll,
  groupsOf,
  layoutOf,
  openTab,
  panesOf,
  rejection,
  SCENARIO_MS,
  startE2e,
  tabsOf,
  terminal,
  waitForLayout,
  type Workspace
} from './e2e/support'

afterEach(cleanupAll)

function focusState(workspace: Workspace) {
  return {
    activeGroup: workspace.activeGroup,
    activeTabs: groupsOf(workspace).map((group) => [group.id, group.activeTab]),
    activePanes: tabsOf(workspace).map((tab) => [tab.id, tab.activePane])
  }
}

test(
  'pane split runs a titled command, retains its output, and preserves focus when activation is disabled',
  async () => {
    const h = await startE2e()
    const source = await openTab(h)
    const before = await layoutOf(h)
    await h.call('quirky.terminal/focusContext', { workspace: before.id })
    const originalFocus = focusState(before)

    const created = await terminal<{ workspace: Workspace; session: string; pane: string }>(
      h,
      'pane',
      'split',
      source.pane.id,
      '--direction',
      'right',
      '--title',
      'Issue #42',
      '--command',
      "sh -c 'echo ISSUE_COMMAND_MARKER; exit 7'",
      '--activate=false'
    )

    const bound = panesOf(created.workspace).find((pane) => pane.id === created.pane)!
    expect(bound.session).toBe(created.session)
    expect(tabsOf(created.workspace)).toHaveLength(tabsOf(before).length)
    expect(focusState(created.workspace)).toEqual(originalFocus)
    expect(await h.call('quirky.terminal/focusContext')).toEqual({ workspace: before.id })

    await h.waitForLine(created.session, 'ISSUE_COMMAND_MARKER')
    const exited = await h.waitForSession(created.session, 'to exit', (session) => session.status === 'exited')
    expect(exited.title).toBe('Issue #42')
    expect(exited.exitCode).toBe(7)

    const settled = await waitForLayout(h, 'the command session to remain bound to its split pane', (workspace) => {
      const leaf = panesOf(workspace).find((pane) => pane.id === created.pane)
      return (
        tabsOf(workspace).length === tabsOf(before).length &&
        panesOf(workspace).filter((pane) => pane.session === created.session).length === 1 &&
        leaf?.exit?.code === 7
      )
    })
    expect(focusState(settled)).toEqual(originalFocus)
    expect(await h.call('quirky.terminal/focusContext')).toEqual({ workspace: before.id })
    expect((await h.sessionRecords()).filter((session) => session.id === created.session)).toHaveLength(1)
    expect(await h.screen(created.session)).toContain('ISSUE_COMMAND_MARKER')
  },
  SCENARIO_MS
)

test(
  'a command that fails to start leaves no extra pane or session',
  async () => {
    const h = await startE2e()
    const source = await openTab(h)
    const before = await layoutOf(h)
    const sessionIds = (await h.sessionRecords()).map((session) => session.id).sort()

    const failed = await rejection(
      h.call('quirky.terminal/splitPane', {
        pane: source.pane.id,
        direction: 'right',
        command: '\u0000'
      })
    )

    expect(failed.code).toBeDefined()
    expect(await layoutOf(h)).toEqual(before)
    expect((await h.sessionRecords()).map((session) => session.id).sort()).toEqual(sessionIds)
  },
  SCENARIO_MS
)
