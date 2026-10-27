import { afterEach, expect, test } from 'bun:test'
import { SCENARIO_MS, cleanupUi, findTab, layoutOf, leavesOf, panesOf, startUi, waitFor, waitForLayout } from './support'

afterEach(cleanupUi)

test(
  'SC-74: a split survives a crash right after it',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const first = await ui.firstTab()
    await ui.waitView('the pane drawn', (view) => view.panes.length === 1)

    // the split is in flight when the window goes away, and the daemon is killed as soon as it answers
    const split = h.cli(['terminal', 'pane', 'split', first.pane.id, '--direction', 'right'])
    await ui.stop()
    const answered = await split
    expect(answered.code, answered.stderr).toBe(0)
    h.noteProcesses()
    await ui.restartDaemon('SIGKILL')

    const ws = await waitForLayout(h, 'both panes', (candidate) => panesOf(candidate).length === 2)
    const tab = findTab(ws, first.tab.id)
    const panes = leavesOf(tab.root)
    expect(panes.map((pane) => pane.id)).toContain(first.pane.id)
    const sessions = await h.sessionRecords()
    expect(sessions.map((session) => session.id).sort()).toEqual(panes.map((pane) => pane.session).sort())
    for (const pane of panes) expect(pane.exit).toBeNull()
    await waitFor('both shells still known to the host', async () => ((await Promise.all(panes.map((pane) => h.hostRow(pane.session)))).every(Boolean) ? true : undefined))
    expect((await layoutOf(h)).revision).toBeGreaterThanOrEqual(ws.revision)
  },
  SCENARIO_MS
)

test(
  'SC-74: a split made from the window survives killing the window and the daemon',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const first = await ui.firstTab()
    await ui.waitView('the pane drawn', (view) => view.panes.length === 1)
    await ui.term(first.pane.id)!.focus()

    expect(await ui.run('split-right')).toEqual({ ok: true })
    await ui.waitView('both panes drawn', (view) => view.panes.length === 2)
    await ui.stop()
    await ui.restartDaemon('SIGKILL')

    const ws = await waitForLayout(h, 'both panes', (candidate) => panesOf(candidate).length === 2)
    const panes = leavesOf(findTab(ws, first.tab.id).root)
    expect(panes.map((pane) => pane.id)).toContain(first.pane.id)
    const sessions = (await h.sessionRecords()).map((session) => session.id).sort()
    expect(panes.map((pane) => pane.session).sort()).toEqual(sessions)
    expect(sessions).toHaveLength(2)
  },
  SCENARIO_MS
)
