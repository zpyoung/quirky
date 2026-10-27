import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCENARIO_MS,
  cleanupAll,
  descendantsOf,
  fails,
  findTab,
  groupOf,
  groupsOf,
  layoutOf,
  leavesOf,
  openTab,
  pwdOf,
  restartDaemon,
  splitPane,
  startAsking,
  startE2e,
  tabTitle,
  tabsOf,
  terminal,
  typeAsPerson,
  waitFor,
  waitForLayout
} from './support'

afterEach(cleanupAll)

test(
  'SC-8: `quirky terminal tab new` opens "Terminal N" with the lowest free number',
  async () => {
    const h = await startE2e()
    const one = await openTab(h)
    const two = await openTab(h)
    const three = await openTab(h)
    expect(tabsOf(three.workspace).map((tab) => tab.defaultTitle)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
    await terminal(h, 'tab', 'close', two.tab.id)

    const fresh = await openTab(h)
    const ws = await layoutOf(h)
    expect(fresh.tab.defaultTitle).toBe('Terminal 2')
    expect(tabsOf(ws).map((tab) => tab.id)).toEqual([one.tab.id, three.tab.id, fresh.tab.id])
    const group = groupOf(ws, fresh.tab.id)
    expect(group.activeTab).toBe(fresh.tab.id)
    expect(await pwdOf(h, fresh.session)).toBe(h.repo)
  },
  SCENARIO_MS
)

test(
  'SC-9: renaming a tab from the CLI sticks when the shell sets a window title',
  async () => {
    const h = await startE2e()
    const { tab, session } = await openTab(h)
    expect(tabTitle(tab)).toBe('Terminal 1')

    const renamed = await terminal(h, 'tab', 'rename', tab.id, 'Build')
    expect(findTab(renamed.workspace, tab.id).customTitle).toBe('Build')
    expect((await h.ok(['terminal', 'layout', '--worktree', 'main'])).split('\n').some((line) => line.trim() === `tab ${tab.id} "Build" (active)`)).toBe(true)

    await h.run(session, `printf '\\033]0;deploy\\007'`)
    const ws = await waitForLayout(h, 'the live title', (candidate) => findTab(candidate, tab.id).liveTitle === 'deploy')
    expect(tabTitle(findTab(ws, tab.id))).toBe('Build')
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`tab ${tab.id} "Build"`)

    const tooLong = await fails(h, ['terminal', 'tab', 'rename', tab.id, 'x'.repeat(201)])
    expect(tooLong.stderr).toMatch(/at most 200/)
  },
  SCENARIO_MS
)

test(
  'SC-10: a tab shows its live title until it gets a custom one',
  async () => {
    const h = await startE2e()
    const { tab, pane, session } = await openTab(h)

    await h.run(session, `printf '\\033]0;deploy\\007'`)
    await waitForLayout(h, 'the live title deploy', (ws) => findTab(ws, tab.id).liveTitle === 'deploy')
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`tab ${tab.id} "deploy"`)

    await terminal(h, 'tab', 'rename', tab.id, 'Build')
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`tab ${tab.id} "Build"`)
    await terminal(h, 'tab', 'rename', tab.id, '')
    expect(findTab(await layoutOf(h), tab.id).customTitle).toBeNull()
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`tab ${tab.id} "deploy"`)

    const other = await splitPane(h, pane.id, 'right')
    await h.run(other.pane.session, `printf '\\033]0;second\\007'`)
    await waitForLayout(h, 'the active pane title', (ws) => findTab(ws, tab.id).liveTitle === 'second')
    await terminal(h, 'pane', 'focus', pane.id)
    await waitForLayout(h, 'the first pane title after focusing it', (ws) => findTab(ws, tab.id).liveTitle === 'deploy')
    await terminal(h, 'pane', 'focus', other.pane.id)
    await waitForLayout(h, 'the second pane title after focusing it', (ws) => findTab(ws, tab.id).liveTitle === 'second')
  },
  SCENARIO_MS
)

test(
  'SC-12: closing an idle tab ends its sessions without asking and activates the tab used before',
  async () => {
    const h = await startE2e()
    const a = await openTab(h)
    const b = await openTab(h)
    const c = await openTab(h)
    const d = await openTab(h)
    const second = await splitPane(h, b.pane.id, 'down')
    for (const tab of [a, d, b]) await terminal(h, 'tab', 'activate', tab.tab.id)
    expect(groupOf(await layoutOf(h), b.tab.id).activeTab).toBe(b.tab.id)

    const closed = await h.cli(['terminal', 'tab', 'close', b.tab.id])
    expect(closed.code).toBe(0)
    expect(closed.stderr).toBe('')
    const ws = await layoutOf(h)
    expect(tabsOf(ws).map((tab) => tab.id)).toEqual([a.tab.id, c.tab.id, d.tab.id])
    expect(groupOf(ws, a.tab.id).activeTab).toBe(d.tab.id)
    expect(ws.closed).toHaveLength(1)

    await waitFor('both sessions of the closed tab to be gone', async () => {
      const ids = (await h.sessionRecords()).map((session) => session.id)
      return !ids.includes(b.session) && !ids.includes(second.pane.session)
    })
  },
  SCENARIO_MS
)

test(
  'SC-14: the CLI asks before closing a running command unless --yes',
  async () => {
    const h = await startE2e()
    const keep = await openTab(h)
    const busy = await openTab(h)
    await h.type(busy.session, 'sleep 300')
    const shell = await h.shellPid(busy.session)
    const sleep = await waitFor('the foreground sleep', () => descendantsOf(shell).find((row) => row.command === 'sleep 300')?.pid)
    h.track(sleep)

    const asking = await startAsking(h, ['terminal', 'tab', 'close', busy.tab.id])
    expect(asking.stderr()).toContain('Stop sleep in Terminal 2?')
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toEqual([keep.tab.id, busy.tab.id])
    expect(await asking.answer(false)).toBe(1)
    expect(asking.stderr()).toContain('declined')
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toEqual([keep.tab.id, busy.tab.id])
    expect(descendantsOf(shell).some((row) => row.pid === sleep)).toBe(true)

    const paneAsk = await startAsking(h, ['terminal', 'pane', 'close', busy.pane.id])
    expect(paneAsk.stderr()).toContain('Stop sleep in Terminal 2?')
    expect(await paneAsk.answer(false)).toBe(1)
    expect(tabsOf(await layoutOf(h))).toHaveLength(2)

    const forced = await h.cli(['terminal', 'tab', 'close', busy.tab.id, '--yes'])
    expect(forced.code).toBe(0)
    expect(forced.stderr).not.toContain('confirm in Quirky')
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toEqual([keep.tab.id])
    await waitFor('the sleep to be gone', () => !descendantsOf(shell).some((row) => row.pid === sleep))
  },
  SCENARIO_MS
)

test(
  'SC-17: reopening a closed tab starts it fresh, and ten are remembered across a restart',
  async () => {
    const h = await startE2e()
    mkdirSync(join(h.repo, 'web'))
    const web = join(h.repo, 'web')
    await openTab(h)
    const build = await openTab(h, ['--cwd', web])
    await terminal(h, 'tab', 'rename', build.tab.id, 'Build')
    await terminal(h, 'tab', 'color', build.tab.id, 'blue')
    await h.run(build.session, 'echo reopen-me')
    expect((await h.screen(build.session)).some((line) => line === 'reopen-me')).toBe(true)
    await terminal(h, 'tab', 'close', build.tab.id)
    expect((await layoutOf(h)).closed).toMatchObject([{ title: 'Build', color: 'blue', cwd: web, agent: 'shell' }])

    const { workspace } = await terminal(h, 'tab', 'reopen')
    const reopened = tabsOf(workspace).at(-1)!
    expect(reopened).toMatchObject({ customTitle: 'Build', color: 'blue' })
    expect(workspace.closed).toEqual([])
    const session = leavesOf(reopened.root)[0]!.session
    expect(session).not.toBe(build.session)
    await waitFor('the reopened shell', async () => (await h.hostRow(session))?.shellState === 'ready')
    expect(await pwdOf(h, session)).toBe(web)
    expect((await h.screen(session)).some((line) => line.includes('reopen-me'))).toBe(false)

    for (let n = 1; n <= 12; n += 1) {
      const opened = await openTab(h, ['--title', `Tab ${n}`], { ready: false })
      await terminal(h, 'tab', 'close', opened.tab.id)
    }
    const ws = await layoutOf(h)
    expect(ws.closed).toHaveLength(10)
    expect(ws.closed.map((closed) => closed.defaultTitle)).toEqual(Array.from({ length: 10 }, (_, i) => `Tab ${12 - i}`))
    await restartDaemon(h)
    expect((await layoutOf(h)).closed).toEqual(ws.closed)
  },
  SCENARIO_MS
)

test(
  'SC-18: tabs reorder and move between groups',
  async () => {
    const h = await startE2e()
    const a = await openTab(h, ['--title', 'A'])
    const b = await openTab(h, ['--title', 'B'])
    const c = await openTab(h, ['--title', 'C'])
    const d = await openTab(h, ['--title', 'D'])
    await terminal(h, 'tab', 'move', d.tab.id, '--split', 'right')
    const grp2 = groupOf(await layoutOf(h), d.tab.id).id
    const grp1 = groupOf(await layoutOf(h), a.tab.id).id

    await terminal(h, 'tab', 'move', c.tab.id, '--group', grp1, '--index', '0')
    await terminal(h, 'tab', 'move', b.tab.id, '--group', grp2, '--index', '0')
    const ws = await layoutOf(h)
    const groups = Object.fromEntries(groupsOf(ws).map((group) => [group.id, group]))
    expect(groups[grp1]!.tabs.map(tabTitle)).toEqual(['C', 'A'])
    expect(groups[grp2]!.tabs.map(tabTitle)).toEqual(['B', 'D'])
    expect(groups[grp2]!.activeTab).toBe(b.tab.id)
    expect(ws.activeGroup).toBe(grp2)
  },
  SCENARIO_MS
)

test(
  'SC-19: tab colours and pins',
  async () => {
    const h = await startE2e()
    const a = await openTab(h, ['--title', 'A'], { ready: false })
    const b = await openTab(h, ['--title', 'B'], { ready: false })
    const c = await openTab(h, ['--title', 'C'], { ready: false })

    let { workspace } = await terminal(h, 'tab', 'color', b.tab.id, 'blue')
    expect(findTab(workspace, b.tab.id).color).toBe('blue')
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`tab ${b.tab.id} "B" blue`)
    ;({ workspace } = await terminal(h, 'tab', 'color', b.tab.id, 'none'))
    expect(findTab(workspace, b.tab.id).color).toBe('none')

    for (const color of ['purple', 'pink', 'red', 'orange', 'yellow', 'green', 'teal', 'gray']) {
      ;({ workspace } = await terminal(h, 'tab', 'color', a.tab.id, color))
      expect(String(findTab(workspace, a.tab.id).color)).toBe(color)
    }
    const bad = await fails(h, ['terminal', 'tab', 'color', a.tab.id, 'mauve'])
    expect(bad.stderr).toContain('none, blue, purple, pink, red, orange, yellow, green, teal, gray')

    ;({ workspace } = await terminal(h, 'tab', 'pin', c.tab.id))
    expect(tabsOf(workspace).map(tabTitle)).toEqual(['C', 'A', 'B'])
    expect(findTab(workspace, c.tab.id).pinned).toBe(true)
    ;({ workspace } = await terminal(h, 'tab', 'unpin', c.tab.id))
    expect(findTab(workspace, c.tab.id).pinned).toBe(false)
  },
  SCENARIO_MS
)

test(
  'SC-21: `tab activate --index`, next and previous switch tabs',
  async () => {
    const h = await startE2e()
    const tabs = [] as Awaited<ReturnType<typeof openTab>>[]
    for (const n of [1, 2, 3, 4]) tabs.push(await openTab(h, ['--title', `T${n}`], { ready: false }))
    const [t1, t2, t3, t4] = tabs.map((opened) => opened.tab.id) as [string, string, string, string]
    for (const id of [t3, t1, t4]) await terminal(h, 'tab', 'activate', id)
    const active = async () => groupOf(await layoutOf(h), t1).activeTab
    expect(groupOf(await layoutOf(h), t1).recent.slice(0, 4)).toEqual([t4, t1, t3, t2])
    await h.call('quirky.terminal/activateTab', { workspace: 'main', offset: 1, order: 'recent' })
    expect(await active()).toBe(t1)

    await terminal(h, 'tab', 'activate', '--index', '2')
    expect(await active()).toBe(t2)
    await terminal(h, 'tab', 'activate', '--index', '4')
    expect(await active()).toBe(t4)
    await terminal(h, 'tab', 'next')
    expect(await active()).toBe(t1)
    await terminal(h, 'tab', 'previous')
    expect(await active()).toBe(t4)
    await terminal(h, 'tab', 'previous')
    expect(await active()).toBe(t3)

    const group = groupOf(await layoutOf(h), t1).id
    await terminal(h, 'tab', 'activate', '--index', '1', '--group', group)
    expect(await active()).toBe(t1)
    const outOfRange = await fails(h, ['terminal', 'tab', 'activate', '--index', '9'])
    expect(outOfRange.code).toBe(1)
    expect(await active()).toBe(t1)
  },
  SCENARIO_MS
)

test(
  'SC-72: reopening with nothing to reopen says so',
  async () => {
    const h = await startE2e()
    await openTab(h)
    const gone = await openTab(h)
    await typeAsPerson(h, gone.session, 'exit')
    const ws = await waitForLayout(h, 'the exited tab gone', (candidate) => tabsOf(candidate).length === 1)
    expect(ws.closed).toEqual([])

    const refused = await fails(h, ['terminal', 'tab', 'reopen'])
    expect(refused).toEqual({ code: 1, stderr: 'quirky: no closed tab to reopen in main\n' })
    expect(tabsOf(await layoutOf(h))).toHaveLength(1)
  },
  SCENARIO_MS
)
