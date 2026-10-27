import { afterEach, expect, test } from 'bun:test'
import {
  SCENARIO_MS,
  cleanupAll,
  daemonLog,
  findTab,
  groupOf,
  layoutOf,
  leavesOf,
  openTab,
  openStore,
  panesOf,
  restartDaemon,
  splitPane,
  startE2e,
  tabsOf,
  terminal,
  waitFor,
  waitForLayout,
  type Workspace
} from './support'

afterEach(cleanupAll)

/** The saved layout without what a restored shell may change on its own: the revision and live titles. */
const settled = (ws: Workspace) => JSON.parse(JSON.stringify(ws, (key, value) => (key === 'liveTitle' ? null : key === 'revision' ? 0 : value))) as Workspace

test(
  'SC-65: the layout survives a daemon restart and a PTY host restart',
  async () => {
    const h = await startE2e()
    const pinned = await openTab(h, ['--title', 'Pinned'])
    const build = await openTab(h, ['--title', 'Build'])
    const second = await splitPane(h, build.pane.id, 'right')
    const third = await splitPane(h, second.pane.id, 'down')
    const hello = await openTab(h, ['--title', 'Hello'])
    await terminal(h, 'tab', 'rename', pinned.tab.id, 'Keep')
    await terminal(h, 'tab', 'color', pinned.tab.id, 'blue')
    await terminal(h, 'tab', 'pin', pinned.tab.id)
    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    const grp1 = groupOf(await layoutOf(h), pinned.tab.id).id
    await terminal(h, 'group', 'resize', grp1, '--ratio', '0.3')
    await terminal(h, 'pane', 'title', third.pane.id, 'logs')
    await h.run(third.pane.session, 'seq 1 50')
    await terminal(h, 'pane', 'expand', third.pane.id)
    await terminal(h, 'tab', 'activate', build.tab.id)
    const saved = await layoutOf(h)
    expect(saved.root).toMatchObject({ kind: 'split', ratio: 0.3 })
    expect(findTab(saved, build.tab.id)).toMatchObject({ expandedPane: third.pane.id, activePane: third.pane.id })

    await restartDaemon(h)
    expect(await layoutOf(h)).toEqual(saved)
    expect(await h.waitForLine(third.pane.session, '50')).toContain('50')

    const oldHost = h.hostPid()
    await h.json(['terminal', 'restart-host', '--yes'])
    await waitFor('a new host', () => (h.hostPid() !== oldHost ? true : undefined))
    for (const pane of panesOf(saved)) {
      await h.waitForSession(pane.session, 'ended with the host', (session) => session.status === 'exited' && session.exitCause === 'host-restart')
    }
    expect(await layoutOf(h)).toEqual(saved)

    const pane = await h.attach(third.pane.session)
    expect(pane.result).toMatchObject({ restored: true, live: true })
    expect(pane.replayText).toContain('50')
    await pane.detach()
    h.noteProcesses()
    const after = await layoutOf(h)
    expect(settled(after)).toEqual(settled(saved))
    expect(leavesOf(findTab(after, build.tab.id).root).find((leaf) => leaf.id === third.pane.id)!.title).toBe('logs')
  },
  SCENARIO_MS
)

test(
  'SC-66: a damaged saved layout is rebuilt from the sessions',
  async () => {
    const h = await startE2e()
    const first = await h.newSession()
    const second = await h.newSession()
    const ws = await waitForLayout(h, 'both sessions as tabs', (candidate) => tabsOf(candidate).length === 2)

    for (const damage of ['{"id": "truncated', JSON.stringify({ id: ws.id, root: { kind: 'group' }, activeGroup: 'grp-1', closed: [] })]) {
      await h.stopDaemon()
      const db = openStore(h)
      try {
        db.query('UPDATE workspaces SET data = ? WHERE id = ?').run(damage, ws.id)
      } finally {
        db.close()
      }
      await h.startDaemon()

      const rebuilt = await waitForLayout(h, 'two rebuilt tabs', (candidate) => tabsOf(candidate).length === 2)
      expect(tabsOf(rebuilt).map((tab) => leavesOf(tab.root)[0]!.session)).toEqual([first.id, second.id])
      expect(tabsOf(rebuilt).map((tab) => tab.defaultTitle)).toEqual(['Terminal 1', 'Terminal 2'])
      expect(rebuilt.revision).toBeGreaterThan(ws.revision)
      expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`pane `)
      expect(daemonLog(h)).toContain(`quirky.terminal: rebuilt the layout of ${ws.id} from its sessions`)
      ws.revision = rebuilt.revision
    }
  },
  SCENARIO_MS
)

test(
  'SC-74: a split survives a daemon crash right after it',
  async () => {
    const h = await startE2e()
    const { pane } = await openTab(h)

    const split = await h.json<{ workspace: Workspace }>(['terminal', 'pane', 'split', pane.id, '--direction', 'right'])
    await h.stopDaemon('SIGKILL')
    await h.startDaemon()

    const ws = await layoutOf(h)
    expect(ws.revision).toBe(split.workspace.revision)
    const panes = panesOf(ws)
    expect(panes).toHaveLength(2)
    const records = (await h.sessionRecords()).filter((session) => session.kind === 'terminal')
    expect(records.map((session) => session.id).sort()).toEqual(panes.map((candidate) => candidate.session).sort())
    for (const session of records) expect(session.status).toBe('running')
    expect(tabsOf(ws)).toHaveLength(1)
  },
  SCENARIO_MS
)
