import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  DOUBLE_CLICK_MS,
  SCENARIO_MS,
  cleanupUi,
  descendantsOf,
  fire,
  findTab,
  isAlive,
  layoutOf,
  leavesOf,
  mouse,
  openTab,
  settingValue,
  splitPane,
  startUi,
  tabTitle,
  tabsOf,
  terminal,
  waitFor,
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
