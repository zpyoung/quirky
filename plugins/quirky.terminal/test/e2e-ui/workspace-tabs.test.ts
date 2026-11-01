import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOUBLE_CLICK_MS,
  SCENARIO_MS,
  cleanupUi,
  descendantsOf,
  fails,
  fire,
  findTab,
  groupsOf,
  isAlive,
  layoutOf,
  leavesOf,
  mouse,
  namedTab,
  openTab,
  pwdOf,
  splitPane,
  startUi,
  tabTitle,
  tabsOf,
  terminal,
  typeAsPerson,
  waitFor,
  waitReady,
  type Ui
} from './support'

afterEach(cleanupUi)

test(
  'SC-8: ⌘T opens "Terminal N" with the lowest free number',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const two = await openTab(h)
    const three = await openTab(h)
    await terminal(h, 'tab', 'close', two.tab.id)
    await ui.waitView('Terminal 1 and Terminal 3', (view) => view.tabs.length === 2)
    expect(ui.tabTitles()).toEqual(['Terminal 1', 'Terminal 3'])

    await ui.el('.xterm-helper-textarea')
    await ui.chord('mod+t')
    const ws = await ui.waitLayout('a third tab', (candidate) => tabsOf(candidate).length === 3)
    const added = tabsOf(ws).at(-1)!
    expect(tabsOf(ws).map((tab) => tab.id)).toEqual([one.tab.id, three.tab.id, added.id])
    expect(added.defaultTitle).toBe('Terminal 2')
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(added.id)
    const session = leavesOf(added.root)[0]!.session
    expect((await h.sessionRecord(session)).cwd).toBe(h.repo)
    await waitFor('the new tab drawn', () => (ui.tabTitles().join() === 'Terminal 1,Terminal 3,Terminal 2' ? true : undefined))
    expect(ui.q('.qt-selected .qt-tab-title')!.textContent).toBe('Terminal 2')

    await terminal(h, 'tab', 'close', added.id)
    expect(await ui.run('quirky.session/new-shell')).toEqual({ ok: true })
    const viaCommand = await ui.waitLayout('Terminal 2 again', (candidate) => tabsOf(candidate).length === 3)
    expect(tabsOf(viaCommand).at(-1)!.defaultTitle).toBe('Terminal 2')
    expect(viaCommand.root.kind === 'group' && viaCommand.root.activeTab).toBe(tabsOf(viaCommand).at(-1)!.id)

    await terminal(h, 'tab', 'close', tabsOf(viaCommand).at(-1)!.id)
    const viaCli = await openTab(h, [], { ready: false })
    expect(viaCli.tab.defaultTitle).toBe('Terminal 2')
    expect(viaCli.workspace.root.kind === 'group' && viaCli.workspace.root.tabs.at(-1)!.id).toBe(viaCli.tab.id)
    expect((await h.sessionRecord(viaCli.session)).cwd).toBe(h.repo)
  },
  SCENARIO_MS
)

test(
  'new-shell wakes a sleeping worktree and selects exactly one new terminal tab',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const first = await ui.firstTab()
    const worktree = (await h.call<Array<{ id: string; path: string; sleeping: boolean }>>('quirky.worktree/list'))
      .find((row) => row.path === h.repo)
    if (!worktree) throw new Error(`worktree ${h.repo} is missing`)
    await h.call('quirky.worktree/sleep', { worktree: worktree.id })
    expect((await h.call<Array<{ id: string; sleeping: boolean }>>('quirky.worktree/list')).find((row) => row.id === worktree.id)?.sleeping).toBe(true)

    expect(await ui.run('quirky.session/new-shell')).toEqual({ ok: true })
    expect((await h.call<Array<{ id: string; sleeping: boolean }>>('quirky.worktree/list')).find((row) => row.id === worktree.id)?.sleeping).toBe(false)
    const workspace = await ui.waitLayout('one new terminal tab', (candidate) => tabsOf(candidate).length === 2)
    const tabs = tabsOf(workspace)
    expect(tabs[0]!.id).toBe(first.tab.id)
    expect(tabs[1]!.defaultTitle).toBe('Terminal 2')
    expect(workspace.root.kind === 'group' && workspace.root.activeTab).toBe(tabs[1]!.id)
    await waitFor('Terminal 2 selected', () => ui.q('.qt-selected .qt-tab-title')?.textContent === 'Terminal 2' ? true : undefined)
  },
  SCENARIO_MS
)

test(
  'SC-9: renaming a tab (a: double-click, type, Enter, or the CLI)',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const two = await openTab(h)
    await waitFor('both tabs drawn', () => (ui.tabTitles().length === 2 ? true : undefined))

    const field = async () => ui.el<HTMLInputElement>('input[aria-label="Tab title"]')
    fire(ui.q(`[data-tab="${two.tab.id}"]`)!, mouse('dblclick'))
    const input = await field()
    expect(input.value).toBe('Terminal 2')

    await ui.fill(input, 'ビルド')
    await ui.key(input, 'Enter', { isComposing: true })
    await ui.key(input, 'Enter', { keyCode: 229 })
    expect(ui.callsTo('renameTab')).toEqual([])
    expect(ui.q('input[aria-label="Tab title"]')).not.toBeNull()

    await ui.fill(input, 'Build')
    await ui.key(input, 'Enter')
    await ui.gone('input[aria-label="Tab title"]')
    expect(ui.callsTo('renameTab')).toEqual([{ tab: two.tab.id, title: 'Build' }])
    const renamed = await ui.waitLayout('the custom title', (ws) => findTab(ws, two.tab.id).customTitle === 'Build')
    expect(tabTitle(findTab(renamed, two.tab.id))).toBe('Build')
    await waitFor('Build drawn', () => (ui.tabTitles().join() === 'Terminal 1,Build' ? true : undefined))

    await h.type(two.session, "printf '\\033]0;deploy\\007'")
    const titled = await ui.waitLayout('the shell title', (ws) => findTab(ws, two.tab.id).liveTitle === 'deploy')
    expect(tabTitle(findTab(titled, two.tab.id))).toBe('Build')
    expect(ui.tabTitles()).toEqual(['Terminal 1', 'Build'])

    await terminal(h, 'tab', 'rename', two.tab.id, 'Ship')
    await ui.waitView('the CLI title', (view) => view.tabs.some((entry) => entry.title === 'Ship'))
    await waitFor('Ship drawn', () => (ui.tabTitles().join() === 'Terminal 1,Ship' ? true : undefined))

    await ui.run('rename-tab')
    const again = await field()
    expect(again.value).toBe('Ship')
    await ui.key(again, 'Escape')
    await ui.gone('input[aria-label="Tab title"]')
  },
  SCENARIO_MS
)

test(
  'SC-9: renaming a tab (b: Escape keeps the old name)',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const two = await openTab(h)
    await waitFor('both tabs drawn', () => (ui.tabTitles().length === 2 ? true : undefined))
    const before = await layoutOf(h)

    await ui.chord('mod+r')
    const input = await ui.el<HTMLInputElement>('input[aria-label="Tab title"]')
    expect(input.value).toBe('Terminal 2')
    await ui.fill(input, 'Build')
    await ui.key(input, 'Escape')
    await ui.gone('input[aria-label="Tab title"]')
    expect(ui.tabTitles()).toEqual(['Terminal 1', 'Terminal 2'])
    expect(ui.callsTo('renameTab')).toEqual([])
    expect(await layoutOf(h)).toEqual(before)
    expect(findTab(before, two.tab.id).customTitle).toBeNull()
  },
  SCENARIO_MS
)

test(
  'SC-11: clicking a tab activates it and it is remembered',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    await h.run(one.session, 'echo marker-one')
    await h.run(build.session, 'echo marker-build')
    await ui.waitView('Build shown', (view) => view.focusedPane === build.pane.id && view.panes.length === 1)

    ui.q(`[data-tab="${one.tab.id}"]`)!.click()
    await ui.waitView('Terminal 1 shown', (view) => view.focusedPane === one.pane.id && view.panes.map((entry) => entry.pane).join() === one.pane.id)
    expect(ui.callsTo('activateTab')).toEqual([{ tab: one.tab.id }])
    expect((await layoutOf(h)).root.kind === 'group' && (await layoutOf(h)).root).toMatchObject({ activeTab: one.tab.id })
    expect(ui.q(`[data-pane="${build.pane.id}"]`)).toBeNull()

    const other = JSON.parse(await h.ok(['worktree', 'create', 'api', 'other', '--json'])) as { worktree: { id: string } }
    await ui.openView({ worktree: other.worktree.id })
    await ui.waitView('the other worktree', (view) => view.worktree === other.worktree.id && view.tabs.length > 0)
    expect(ui.q(`[data-pane="${one.pane.id}"]`)).toBeNull()

    const attaches = ui.callsTo('attach').length
    await ui.openView({ worktree: 'main' })
    const back = await ui.waitView('main again', (view) => view.worktree === (view.layout?.id ?? '') && view.focusedPane === one.pane.id && view.panes.length === 1)
    expect(back.panes[0]!.session).toBe(one.session)
    expect(ui.tabTitles()).toEqual(['Terminal 1', 'Build'])
    expect(ui.q('[data-tab="' + one.tab.id + '"] [role="tab"]')!.getAttribute('aria-selected')).toBe('true')
    await waitFor('the screen of Terminal 1 back', () => (ui.paneText(one.pane.id).some((line) => line === 'marker-one') ? true : undefined))
    expect(ui.callsTo('attach').length).toBeGreaterThan(attaches)
    expect(ui.q(`[data-pane="${build.pane.id}"]`)).toBeNull()
    expect(ui.qa('.xterm')).toHaveLength(1)

    ui.q(`[data-tab="${build.tab.id}"]`)!.click()
    await ui.waitView('Build shown', (view) => view.focusedPane === build.pane.id)
    await waitFor('the screen of Build', () => (ui.paneText(build.pane.id).some((line) => line === 'marker-build') ? true : undefined))
  },
  SCENARIO_MS
)

/** A tab "Build" with the given number of idle shells, made current. */
async function buildTab(ui: Awaited<ReturnType<typeof startUi>>, panes: number) {
  const build = await openTab(ui.h, ['--title', 'Build'])
  const sessions = [build.pane]
  for (let n = 1; n < panes; n += 1) sessions.push((await splitPane(ui.h, sessions.at(-1)!.id, 'right')).pane)
  return { build, sessions }
}

test(
  'SC-12: closing an idle tab ends its sessions without asking',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const a = await ui.firstTab()
    const b = await openTab(h, ['--title', 'B'])

    const recentOrder = async (build: string) => {
      await terminal(h, 'tab', 'activate', b.tab.id)
      await terminal(h, 'tab', 'activate', a.tab.id)
      await terminal(h, 'tab', 'activate', build)
      await ui.waitView('Build shown', (view) => view.layout?.root.kind === 'group' && view.layout.root.activeTab === build)
    }

    const first = await buildTab(ui, 2)
    await recentOrder(first.build.tab.id)
    const dead = first.sessions.map((pane) => pane.session)
    fire(ui.q(`[data-tab="${first.build.tab.id}"]`)!, mouse('auxclick', { button: 1 }))
    let ws = await ui.waitLayout('Build closed', (candidate) => !tabsOf(candidate).some((tab) => tab.id === first.build.tab.id))
    expect(ui.callsTo('describeClose')).toEqual([{ tab: first.build.tab.id }])
    expect(ui.callsTo('closeTab')).toEqual([{ tab: first.build.tab.id, yes: true }])
    expect(ui.q('[role="dialog"]')).toBeNull()
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(a.tab.id)
    await waitFor('its sessions gone', async () => ((await h.sessionRecords()).every((session) => !dead.includes(session.id)) ? true : undefined))

    const second = await buildTab(ui, 1)
    await recentOrder(second.build.tab.id)
    await ui.chord('mod+w')
    ws = await ui.waitLayout('Build closed by ⌘W', (candidate) => !tabsOf(candidate).some((tab) => tab.id === second.build.tab.id))
    expect(ui.q('[role="dialog"]')).toBeNull()
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(a.tab.id)

    const third = await buildTab(ui, 1)
    await recentOrder(third.build.tab.id)
    expect(await ui.run('quirky.session/close-session')).toEqual({ ok: true })
    ws = await ui.waitLayout('Build closed by the command', (candidate) => !tabsOf(candidate).some((tab) => tab.id === third.build.tab.id))
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(a.tab.id)

    const fourth = await buildTab(ui, 2)
    await recentOrder(fourth.build.tab.id)
    await terminal(h, 'tab', 'close', fourth.build.tab.id)
    ws = await layoutOf(h)
    expect(tabsOf(ws).map((tab) => tab.id)).toEqual([a.tab.id, b.tab.id])
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(a.tab.id)
    await ui.waitView('A shown', (view) => view.focusedPane === a.pane.id)
  },
  SCENARIO_MS
)

/** Starts `sleep 300` in the tab's shell and waits until the daemon sees it as a running command. */
async function startSleep(ui: Ui, tab: string, session: string): Promise<number> {
  await ui.h.type(session, 'sleep 300')
  const row = await waitFor('sleep running', async () => descendantsOf(await ui.h.shellPid(session)).find((entry) => entry.command.includes('sleep 300')))
  ui.h.track(row.pid)
  await waitFor(`${tab} to be running`, async () => ((await ui.h.call<string | null>('quirky.terminal/describeClose', { tab })) !== null ? true : undefined))
  return row.pid
}

const stoppedBy = (pid: number) => waitFor(`process ${pid} to end`, () => (isAlive(pid) ? undefined : true))
const settingValue = async (ui: Ui, name: string) => JSON.parse(await ui.h.ok(['setting', 'get', `setting:quirky.terminal/${name}`])) as unknown

test(
  'SC-13: closing a tab running a command asks first',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const second = await openTab(h)
    const third = await openTab(h)
    const sleepOne = await startSleep(ui, one.tab.id, one.session)
    await terminal(h, 'tab', 'activate', one.tab.id)
    await ui.waitView('Terminal 1 shown', (view) => view.focusedPane === one.pane.id)

    ui.q(`[aria-label="Close Terminal 1"]`)!.click()
    const dialog = await ui.dialog()
    expect(dialog.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(ui.callsTo('describeClose')).toEqual([{ tab: one.tab.id }])

    ui.dialogButton('Cancel')!.click()
    await ui.waitView('no dialog', (view) => view.dialog === null)
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toContain(one.tab.id)
    expect(isAlive(sleepOne)).toBe(true)
    expect(ui.callsTo('closeTab')).toEqual([])

    ui.q(`[aria-label="Close Terminal 1"]`)!.click()
    await ui.dialog()
    ui.dialogButton('Stop and Close')!.click()
    await ui.waitLayout('Terminal 1 closed', (ws) => !tabsOf(ws).some((tab) => tab.id === one.tab.id))
    await stoppedBy(sleepOne)
    expect(ui.callsTo('closeTab')).toEqual([{ tab: one.tab.id, yes: true }])
    expect(await settingValue(ui, 'confirm-close-running')).toBe(true)

    await Bun.sleep(DOUBLE_CLICK_MS + 50)
    const sleepTwo = await startSleep(ui, second.tab.id, second.session)
    await terminal(h, 'tab', 'activate', second.tab.id)
    await ui.waitView('the second tab shown', (view) => view.focusedPane === second.pane.id)
    ui.q(`[aria-label="Close Terminal 2"]`)!.click()
    await ui.dialog()
    ui.dialog().then((element) => (element.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    await ui.settle()
    ui.dialogButton('Stop and Close')!.click()
    await ui.waitLayout('Terminal 2 closed', (ws) => !tabsOf(ws).some((tab) => tab.id === second.tab.id))
    await stoppedBy(sleepTwo)
    await waitFor('the setting off', async () => ((await settingValue(ui, 'confirm-close-running')) === false ? true : undefined))

    await Bun.sleep(DOUBLE_CLICK_MS + 50)
    const sleepThree = await startSleep(ui, third.tab.id, third.session)
    await ui.waitView('the third tab shown', (view) => view.focusedPane === third.pane.id)
    ui.q(`[aria-label="Close Terminal 3"]`)!.click()
    await ui.waitLayout('Terminal 3 closed without a question', (ws) => !tabsOf(ws).some((tab) => tab.id === third.tab.id))
    expect(ui.q('[role="dialog"]')).toBeNull()
    await stoppedBy(sleepThree)
  },
  SCENARIO_MS
)

test(
  'SC-13: closing a tab running an agent asks first',
  async () => {
    const ui = await startUi({ agents: ['claude'] })
    const { h } = ui
    await ui.waitLayout('its first tab', (ws) => tabsOf(ws).length === 1)
    const agent = await openTab(h, ['--agent', 'claude'], { ready: false })
    await waitFor('the agent tab drawn', () => (ui.q(`[data-tab="${agent.tab.id}"]`) ? true : undefined))
    await waitFor('the agent reported as running', async () => (/^Stop agent /.test((await h.call<string | null>('quirky.terminal/describeClose', { tab: agent.tab.id })) ?? '') ? true : undefined))
    ui.q(`[data-tab="${agent.tab.id}"]`)!.click()
    await ui.waitView('the agent tab shown', (view) => view.focusedPane === agent.pane.id)

    ui.q(`[aria-label^="Close "][aria-label$="${tabTitle(agent.tab).replace(/"/g, '')}"]`)!.click()
    await ui.dialog()
    expect(ui.dialogButton('Stop Agent')).not.toBeNull()
    ui.dialogButton('Stop Agent')!.click()
    await ui.waitLayout('the agent tab closed', (ws) => !tabsOf(ws).some((tab) => tab.id === agent.tab.id))
    expect((await h.sessionRecords()).some((session) => session.id === agent.session)).toBe(false)
  },
  SCENARIO_MS
)

test(
  "SC-15: a double click can't confirm the next tab",
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const two = await openTab(h)
    const sleepOne = await startSleep(ui, one.tab.id, one.session)
    const sleepTwo = await startSleep(ui, two.tab.id, two.session)
    await terminal(h, 'tab', 'activate', one.tab.id)
    await ui.waitView('Terminal 1 shown', (view) => view.focusedPane === one.pane.id)

    ui.q(`[aria-label="Close Terminal 1"]`)!.click()
    await ui.dialog()
    const confirm = ui.dialogButton('Stop and Close')!
    confirm.click()
    confirm.click()
    ui.q(`[aria-label="Close Terminal 2"]`)!.click()
    await ui.waitLayout('Terminal 1 closed', (ws) => !tabsOf(ws).some((tab) => tab.id === one.tab.id))
    await stoppedBy(sleepOne)
    await Bun.sleep(150)
    expect(ui.q('[role="dialog"]')).toBeNull()
    expect(ui.callsTo('closeTab')).toEqual([{ tab: one.tab.id, yes: true }])
    expect(ui.callsTo('describeClose')).toEqual([{ tab: one.tab.id }])
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toEqual([two.tab.id])
    expect(isAlive(sleepTwo)).toBe(true)

    await Bun.sleep(DOUBLE_CLICK_MS)
    ui.q(`[aria-label="Close Terminal 2"]`)!.click()
    await ui.dialog()
  },
  SCENARIO_MS
)

test(
  'SC-16: closing a pinned tab asks unless turned off',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const logs = await openTab(h, ['--title', 'Logs'])
    const more = await openTab(h, ['--title', 'More'])
    await terminal(h, 'tab', 'pin', logs.tab.id)
    await terminal(h, 'tab', 'pin', more.tab.id)
    await terminal(h, 'tab', 'activate', logs.tab.id)
    await ui.waitView('Logs shown', (view) => view.focusedPane === logs.pane.id)

    await ui.chord('mod+w')
    const dialog = await ui.dialog()
    expect(dialog.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(ui.callsTo('closeTab')).toEqual([])
    ui.dialogButton('Close')!.click()
    await ui.waitLayout('Logs closed', (ws) => !tabsOf(ws).some((tab) => tab.id === logs.tab.id))
    expect(await settingValue(ui, 'confirm-close-pinned')).toBe(true)

    await Bun.sleep(DOUBLE_CLICK_MS + 50)
    await terminal(h, 'tab', 'activate', more.tab.id)
    await ui.waitView('More shown', (view) => view.focusedPane === more.pane.id)
    expect(await ui.run('quirky.session/close-session')).toEqual({ ok: true })
    const again = await ui.dialog()
    ;(again.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    await ui.settle()
    ui.dialogButton('Close')!.click()
    await ui.waitLayout('More closed', (ws) => !tabsOf(ws).some((tab) => tab.id === more.tab.id))
    await waitFor('the setting off', async () => ((await settingValue(ui, 'confirm-close-pinned')) === false ? true : undefined))
  },
  SCENARIO_MS
)

test(
  'SC-17: reopening a closed tab starts it fresh',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    mkdirSync(join(h.repo, 'web'))
    const build = await openTab(h, ['--cwd', join(h.repo, 'web')])
    await terminal(h, 'tab', 'rename', build.tab.id, 'Build')
    await terminal(h, 'tab', 'color', build.tab.id, 'blue')
    await h.run(build.session, 'echo reopen-me')
    await ui.waitView('Build shown', (view) => view.focusedPane === build.pane.id)

    await ui.chord('mod+w')
    const closed = await ui.waitLayout('Build closed', (ws) => !tabsOf(ws).some((tab) => tab.id === build.tab.id))
    expect(closed.closed).toMatchObject([{ title: 'Build', color: 'blue', cwd: join(h.repo, 'web'), agent: 'shell' }])

    await ui.restartDaemon()
    expect((await layoutOf(h)).closed).toEqual(closed.closed)
    await ui.sync()
    await ui.chord('mod+shift+t')
    const ws = await ui.waitLayout('Build reopened', (candidate) => tabsOf(candidate).some((tab) => tab.customTitle === 'Build'))
    const reopened = tabsOf(ws).find((tab) => tab.customTitle === 'Build')!
    expect(reopened.color).toBe('blue')
    expect(reopened.id).not.toBe(build.tab.id)
    const pane = leavesOf(reopened.root)[0]!
    expect(pane.session).not.toBe(build.session)
    expect(ws.closed).toEqual([])
    expect((await h.sessionRecord(pane.session)).cwd).toBe(join(h.repo, 'web'))
    await waitReady(h, pane.session)
    expect(await pwdOf(h, pane.session)).toBe(join(h.repo, 'web'))
    await ui.waitView('the reopened tab shown', (view) => view.focusedPane === pane.id)
    await waitFor('the tab drawn blue', () => (ui.q(`[data-tab="${reopened.id}"] .qt-color[data-color="blue"]`) ? true : undefined))
    expect(ui.paneText(pane.id).join('\n')).not.toContain('reopen-me')
    expect((await h.screen(pane.session)).join('\n')).not.toContain('reopen-me')

    await terminal(h, 'tab', 'close', reopened.id)
    expect(await ui.run('reopen-tab')).toEqual({ ok: true })
    const viaCommand = await ui.waitLayout('reopened by the command', (candidate) => tabsOf(candidate).some((tab) => tab.customTitle === 'Build' && tab.id !== reopened.id))
    await terminal(h, 'tab', 'close', tabsOf(viaCommand).find((tab) => tab.customTitle === 'Build')!.id)
    const viaCli = await terminal(h, 'tab', 'reopen')
    expect(tabsOf(viaCli.workspace).some((tab) => tab.customTitle === 'Build' && tab.color === 'blue')).toBe(true)
  },
  SCENARIO_MS
)

test(
  'SC-72: reopening with nothing to reopen leaves tabs unchanged',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const gone = await openTab(h)
    await typeAsPerson(h, gone.session, 'exit')
    const ws = await ui.waitLayout('the exited tab gone', (candidate) => !tabsOf(candidate).some((tab) => tab.id === gone.tab.id))
    expect(ws.closed).toEqual([])
    const tabs = tabsOf(ws).map((tab) => tab.id)

    await ui.chord('mod+shift+t')
    await waitFor('the toast', () => (ui.q('.ui-toast[role="alert"], .ui-toast[role="status"]') ? true : undefined))
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toEqual(tabs)

    const refused = await fails(h, ['terminal', 'tab', 'reopen'])
    expect(refused).toEqual({ code: 1, stderr: 'quirky: no closed tab to reopen in main\n' })
  },
  SCENARIO_MS
)

test(
  'SC-18: reorder and move tabs by dragging',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const a = await ui.firstTab()
    await terminal(h, 'tab', 'rename', a.tab.id, 'A')
    const b = await namedTab(ui, 'B')
    const c = await namedTab(ui, 'C')
    const d = await namedTab(ui, 'D')
    await terminal(h, 'tab', 'move', d.tab.id, '--split', 'right')
    const start = await ui.waitLayout('two groups', (ws) => groupsOf(ws).length === 2)
    const [g1, g2] = groupsOf(start).map((group) => group.id) as [string, string]
    const shape = async () => groupsOf(await layoutOf(h)).map((group) => group.tabs.map(tabTitle))
    expect(await shape()).toEqual([['A', 'B', 'C'], ['D']])
    await waitFor('both strips drawn', () => (ui.tabTitles().length === 4 ? true : undefined))

    const dragOnto = async (dragged: string, target: string, x: number) => {
      const over = ui.q(`[data-tab="${target}"]`)!
      ui.setRect(over, { left: 0, top: 0, width: 100, height: 30 })
      fire(ui.q(`[data-tab="${dragged}"]`)!, mouse('dragstart'))
      await ui.settle()
      fire(over, mouse('dragover', { clientX: x, clientY: 10 }))
      await ui.settle()
      fire(over, mouse('drop', { clientX: x, clientY: 10 }))
      fire(ui.q(`[data-tab="${dragged}"]`)!, mouse('dragend'))
      await ui.settle()
    }

    await dragOnto(c.tab.id, a.tab.id, 10)
    await ui.waitLayout('C before A', (ws) => groupsOf(ws)[0]!.tabs[0]!.id === c.tab.id)
    expect(ui.callsTo('moveTab')).toEqual([{ tab: c.tab.id, group: g1, index: 0 }])
    expect(groupsOf(await layoutOf(h))[0]!.activeTab).toBe(c.tab.id)

    await dragOnto(b.tab.id, d.tab.id, 10)
    const moved = await ui.waitLayout('B in the second group', (ws) => groupsOf(ws)[1]!.tabs.length === 2)
    expect(ui.callsTo('moveTab')[1]).toEqual({ tab: b.tab.id, group: g2, index: 0 })
    expect(groupsOf(moved).map((group) => group.tabs.map(tabTitle))).toEqual([['C', 'A'], ['B', 'D']])
    expect(groupsOf(moved)[1]!.activeTab).toBe(b.tab.id)
    await waitFor('the strips redrawn', () => (ui.tabTitles(g2).join() === 'B,D' && ui.tabTitles(g1).join() === 'C,A' ? true : undefined))

    await terminal(h, 'tab', 'move', b.tab.id, '--group', g1, '--index', '1')
    expect(await shape()).toEqual([['C', 'B', 'A'], ['D']])
    await terminal(h, 'tab', 'move', b.tab.id, '--group', g2, '--index', '0')
    expect(await shape()).toEqual([['C', 'A'], ['B', 'D']])
    expect(groupsOf(await layoutOf(h))[1]!.activeTab).toBe(b.tab.id)

    fire(ui.q(`[data-tab="${a.tab.id}"]`)!, mouse('dragstart'))
    await ui.settle()
    fire(ui.q(`[data-group="${g2}"] .qt-strip`)!, mouse('drop'))
    await ui.waitLayout('A at the end of the second group', (ws) => groupsOf(ws)[1]!.tabs.at(-1)!.id === a.tab.id)
    expect(await shape()).toEqual([['C'], ['B', 'D', 'A']])
  },
  SCENARIO_MS
)

test(
  'SC-19: tab colours and pins',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await namedTab(ui, 'Build')
    await waitFor('both tabs drawn', () => (ui.tabTitles().length === 2 ? true : undefined))
    const tabEl = (id: string) => ui.q(`[data-tab="${id}"]`)!

    await ui.contextMenu(`[data-tab="${build.tab.id}"]`)
    await ui.pick('Tab Color')
    const swatches = ui.qa('.qt-submenu [role="menuitem"]').map((row) => row.textContent!.replace('✓', ''))
    expect(swatches).toEqual(['None', 'Blue', 'Purple', 'Pink', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Gray'])
    await ui.pick('Blue')
    await ui.waitLayout('a blue tab', (ws) => findTab(ws, build.tab.id).color === 'blue')
    await waitFor('the dot', () => (tabEl(build.tab.id).querySelector('.qt-color[data-color="blue"]') ? true : undefined))
    const dot = tabEl(build.tab.id).querySelector('.qt-color')!
    const close = tabEl(build.tab.id).querySelector('.qt-tab-close')!
    expect(dot.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await ui.contextMenu(`[data-tab="${build.tab.id}"]`)
    await ui.pick('Pin Tab')
    const pinned = await ui.waitLayout('a pinned tab', (ws) => findTab(ws, build.tab.id).pinned)
    expect(groupsOf(pinned)[0]!.tabs.map((tab) => tab.id)).toEqual([build.tab.id, one.tab.id])
    await waitFor('the pinned tab on the left', () => (ui.tabTitles().join() === 'Build,Terminal 1' ? true : undefined))
    expect(tabEl(build.tab.id).querySelector('.qt-pin')).not.toBeNull()
    expect(tabEl(build.tab.id).querySelector('.qt-tab-close')).toBeNull()
    expect(tabEl(one.tab.id).querySelector('.qt-tab-close')).not.toBeNull()

    await ui.contextMenu(`[data-tab="${build.tab.id}"]`)
    expect((await ui.waitView('the menu', (view) => view.menu !== null)).menu!.items.map((item) => item.label)).toContain('Unpin Tab')
    await ui.pick('Tab Color')
    await ui.pick('None')
    await ui.waitLayout('no colour', (ws) => findTab(ws, build.tab.id).color === 'none')
    await waitFor('the dot gone', () => (tabEl(build.tab.id).querySelector('.qt-color') === null ? true : undefined))

    await terminal(h, 'tab', 'color', one.tab.id, 'teal')
    await terminal(h, 'tab', 'unpin', build.tab.id)
    const cli = await ui.waitLayout('teal and unpinned', (ws) => findTab(ws, one.tab.id).color === 'teal' && !findTab(ws, build.tab.id).pinned)
    expect(findTab(cli, one.tab.id).color).toBe('teal')
    await waitFor('the teal dot', () => (tabEl(one.tab.id).querySelector('.qt-color[data-color="teal"]') ? true : undefined))
    const refused = await fails(h, ['terminal', 'tab', 'color', one.tab.id, 'mauve'])
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('mauve')
    expect(findTab(await layoutOf(h), one.tab.id).color).toBe('teal')
  },
  SCENARIO_MS
)

test(
  'SC-20: the tab menu',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const a = await ui.firstTab()
    await terminal(h, 'tab', 'rename', a.tab.id, 'A')
    const b = await namedTab(ui, 'B')
    const c = await namedTab(ui, 'C')
    await terminal(h, 'tab', 'pin', b.tab.id)
    await terminal(h, 'tab', 'activate', c.tab.id)
    await waitFor('the strip drawn', () => (ui.tabTitles().join() === 'B,A,C' ? true : undefined))

    await ui.contextMenu(`[data-tab="${c.tab.id}"]`)
    const menu = (await ui.waitView('the tab menu', (view) => view.menu?.kind === 'tab')).menu!
    expect(menu.target).toBe(c.tab.id)
    expect(menu.items.map((item) => item.label)).toEqual([
      'Move Tab to Split',
      'Split Terminal',
      'Pin Tab',
      'Copy Tab ID',
      'Close',
      'Close Others',
      'Close All Tabs To The Right',
      'Close All Tabs To The Left',
      'Change Title',
      'Tab Color'
    ])
    const row = (label: string) => menu.items.find((item) => item.label === label)!
    expect(row('Close All Tabs To The Right').enabled).toBe(false)
    expect(row('Close All Tabs To The Left').enabled).toBe(true)
    expect([row('Close').key, row('Change Title').key]).toEqual(['⌘W', '⌘R'])

    await ui.pick('Move Tab to Split')
    expect(ui.qa('.qt-submenu [role="menuitem"]').map((element) => element.textContent)).toEqual(['Right', 'Left', 'Down', 'Up'])
    await ui.pick('Split Terminal')
    expect(ui.qa('.qt-submenu [role="menuitem"]').map((element) => element.textContent)).toEqual(['Right', 'Down'])
    await ui.pick('Tab Color')
    expect(ui.qa('.qt-submenu .qt-swatch')).toHaveLength(9)
    expect(ui.qa('.qt-submenu [role="menuitem"]')).toHaveLength(10)

    await ui.pick('Copy Tab ID')
    expect(ui.clipboard.written).toEqual([c.tab.id])
    await ui.waitView('the menu closed', (view) => view.menu === null)

    await ui.contextMenu(`[data-tab="${c.tab.id}"]`)
    await ui.pick('Close All Tabs To The Left')
    const left = await ui.waitLayout('A closed', (ws) => !tabsOf(ws).some((tab) => tab.id === a.tab.id))
    expect(tabsOf(left).map((tab) => tab.id)).toEqual([b.tab.id, c.tab.id])
    expect(findTab(left, b.tab.id).pinned).toBe(true)

    const a2 = await namedTab(ui, 'A2')
    await waitFor('A2 drawn', () => (ui.tabTitles().join() === 'B,C,A2' ? true : undefined))
    await ui.contextMenu(`[data-tab="${c.tab.id}"]`)
    await ui.pick('Close Others')
    const others = await ui.waitLayout('A2 closed', (ws) => !tabsOf(ws).some((tab) => tab.id === a2.tab.id))
    expect(tabsOf(others).map((tab) => tab.id)).toEqual([b.tab.id, c.tab.id])

    await ui.contextMenu(`[data-tab="${c.tab.id}"]`)
    expect((await ui.waitView('the menu', (view) => view.menu?.kind === 'tab')).menu!.items.map((item) => item.label)).not.toContain('Close Split Pane')
    await ui.run('close-menu')
    await terminal(h, 'tab', 'move', c.tab.id, '--split', 'right')
    await ui.waitLayout('two groups', (ws) => groupsOf(ws).length === 2)
    await ui.contextMenu(`[data-tab="${c.tab.id}"]`)
    const split = (await ui.waitView('the menu', (view) => view.menu?.kind === 'tab' && view.menu.items.some((item) => item.label === 'Close Split Pane'))).menu!
    expect(split.items.at(-1)!.label).toBe('Close Split Pane')
    await ui.pick('Close Split Pane')
    const merged = await ui.waitLayout('one group again', (ws) => groupsOf(ws).length === 1)
    expect(tabsOf(merged).map((tab) => tab.id)).toEqual([b.tab.id, c.tab.id])
  },
  SCENARIO_MS
)

test(
  'SC-21: switching tabs from the keyboard',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const t1 = await ui.firstTab()
    await terminal(h, 'tab', 'rename', t1.tab.id, '1')
    const t2 = await namedTab(ui, '2')
    const t3 = await namedTab(ui, '3')
    const t4 = await namedTab(ui, '4')
    for (const tab of [t3, t1, t4]) await terminal(h, 'tab', 'activate', tab.tab.id)
    await ui.sync()
    const options = () => ui.qa('[data-tab-option]').map((element) => element.dataset.tabOption!)
    const highlighted = () => ui.q('[data-tab-option][aria-selected="true"]')?.getAttribute('data-tab-option')
    const active = async () => groupsOf(await layoutOf(h))[0]!.activeTab

    await ui.chord('ctrl+tab')
    expect((await ui.waitView('the switcher', (view) => view.dialog !== null)).dialog?.kind).toBe('switch-tabs')
    expect(options()).toEqual([t4, t1, t3, t2].map((entry) => entry.tab.id))
    expect(highlighted()).toBe(t1.tab.id)
    await ui.chord('ctrl+tab')
    expect(highlighted()).toBe(t3.tab.id)
    await ui.keyup('Control')
    await ui.waitView('the switcher closed', (view) => view.dialog === null)
    await ui.waitLayout('3 active', (ws) => groupsOf(ws)[0]!.activeTab === t3.tab.id)

    await h.ok(['setting', 'set', 'setting:quirky.terminal/ctrl-tab-order', 'sequential'])
    await waitFor('the setting applied', async () => ((await settingValue(ui, 'ctrl-tab-order')) === 'sequential' ? true : undefined))
    await ui.run('recent-tab')
    await ui.waitView('the switcher', (view) => view.dialog !== null)
    expect(options()).toEqual([t1, t2, t3, t4].map((entry) => entry.tab.id))
    expect(highlighted()).toBe(t4.tab.id)
    await ui.key(ui.q('[role="dialog"]')!, 'Escape')
    await ui.waitView('the switcher closed', (view) => view.dialog === null)
    expect(await active()).toBe(t3.tab.id)

    await ui.chord('ctrl+pagedown')
    await ui.waitLayout('4 active', (ws) => groupsOf(ws)[0]!.activeTab === t4.tab.id)
    await ui.chord('mod+alt+]')
    await ui.waitLayout('1 active (wrapped)', (ws) => groupsOf(ws)[0]!.activeTab === t1.tab.id)
    await ui.chord('ctrl+pageup')
    await ui.waitLayout('4 active (wrapped back)', (ws) => groupsOf(ws)[0]!.activeTab === t4.tab.id)
    await ui.chord('mod+shift+[')
    await ui.waitLayout('3 active', (ws) => groupsOf(ws)[0]!.activeTab === t3.tab.id)
    await ui.chord('ctrl+2')
    await ui.waitLayout('2 active', (ws) => groupsOf(ws)[0]!.activeTab === t2.tab.id)
    await ui.chord('mod+4')
    await ui.waitLayout('4 active by ⌘4', (ws) => groupsOf(ws)[0]!.activeTab === t4.tab.id)
    expect(await ui.run('quirky.session/select-tab-2')).toEqual({ ok: true })
    await ui.waitLayout('2 active by the command', (ws) => groupsOf(ws)[0]!.activeTab === t2.tab.id)
    await ui.run('next-tab')
    await ui.waitLayout('3 active by next-tab', (ws) => groupsOf(ws)[0]!.activeTab === t3.tab.id)
    await ui.run('previous-tab')
    await ui.waitLayout('2 active by previous-tab', (ws) => groupsOf(ws)[0]!.activeTab === t2.tab.id)

    await terminal(h, 'tab', 'activate', '--index', '4')
    expect(await active()).toBe(t4.tab.id)
    await terminal(h, 'tab', 'activate', '--index', '2')
    expect(await active()).toBe(t2.tab.id)
  },
  SCENARIO_MS
)

test(
  'SC-22: the `+` menu',
  async () => {
    const ui = await startUi({ agents: ['claude', 'codex'] })
    const { h } = ui
    await ui.waitLayout('its first tab', (ws) => tabsOf(ws).length === 1)
    const build = await openTab(h, ['--title', 'Build'], { ready: false })
    const group = groupsOf(await layoutOf(h))[0]!.id
    await waitFor('both tabs drawn', () => (ui.tabTitles().length === 2 ? true : undefined))

    ui.q(`[data-plus="${group}"]`)!.click()
    const open = (await ui.waitView('detected agents in the + menu', (view) => {
      const menu = view.menu
      return menu?.kind === 'plus' &&
        menu.items.some((item) => /claude/i.test(item.label)) &&
        menu.items.some((item) => /codex/i.test(item.label))
    })).menu!
    const labels = open.items.map((item) => item.label)
    expect(labels[0]).toBe('New Terminal')
    expect(open.items[0]!.key).toBe('⌘T')
    expect(labels.filter((label) => /claude/i.test(label)).length).toBeGreaterThanOrEqual(1)
    expect(labels.some((label) => /codex/i.test(label))).toBe(true)
    const search = await ui.el<HTMLInputElement>('input[aria-label="Search open tabs and agents…"]')
    expect(search.placeholder).toBe('Search open tabs and agents…')

    await ui.fill(search, 'bu')
    const filtered = (await ui.waitView('the filtered menu', (view) => view.menu?.items.length === 1)).menu!
    expect(filtered.items.map((item) => item.label)).toEqual(['Build'])
    await ui.key(search, 'Enter')
    await ui.waitLayout('Build active', (ws) => groupsOf(ws)[0]!.activeTab === build.tab.id)
    await ui.waitView('the menu closed', (view) => view.menu === null)
  },
  SCENARIO_MS
)
