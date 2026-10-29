import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCENARIO_MS,
  cleanupUi,
  groupsOf,
  layoutOf,
  leavesOf,
  openTab,
  paneShape,
  panesOf,
  splitPane,
  startUi,
  tabsOf,
  terminal,
  waitFor,
  type Workspace
} from './support'

afterEach(cleanupUi)

const titleOf = (tab: { customTitle: string | null; liveTitle: string | null; defaultTitle: string }) => tab.customTitle || tab.liveTitle || tab.defaultTitle

test(
  'SC-1: opening a worktree with no tabs creates one terminal',
  async () => {
    const ui = await startUi({ view: false })
    const { h } = ui
    expect(tabsOf(await layoutOf(h))).toEqual([])
    expect(await h.sessionRecords()).toEqual([])

    await h.ok(['ui', 'open-view', 'view:quirky.session/worktree', '--input', '{"worktree":"main"}'])
    const ws = await ui.waitLayout('one tab', (candidate) => tabsOf(candidate).length === 1)
    const json = await h.json<Workspace>(['terminal', 'layout', '--worktree', 'main'])
    expect(json).toEqual(ws)

    const tabs = tabsOf(json)
    expect(groupsOf(json)).toHaveLength(1)
    expect(tabs).toHaveLength(1)
    const [tab] = tabs
    const panes = leavesOf(tab!.root)
    expect(panes).toHaveLength(1)
    expect(tab!.activePane).toBe(panes[0]!.id)
    expect(json.revision).toBe(1)

    const sessions = await h.sessionRecords()
    expect(sessions.map((session) => session.id)).toEqual([panes[0]!.session])
    expect(sessions[0]).toMatchObject({ agent: 'shell', kind: 'terminal', cwd: h.repo })

    const report = await ui.waitView('the pane', (view) => view.panes.length === 1)
    expect(report.focusedPane).toBe(panes[0]!.id)
  },
  SCENARIO_MS
)

test(
  'SC-3: the view reports what the window shows',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    const right = await splitPane(h, build.pane.id, 'right')
    const down = await splitPane(h, right.pane.id, 'down')
    const hello = await openTab(h, ['--title', 'Hello'])
    await terminal(h, 'tab', 'color', one.tab.id, 'blue')
    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    await terminal(h, 'pane', 'focus', right.pane.id)
    const ws = await layoutOf(h)

    const state = await ui.state()
    const slot = state.slots.find((entry) => entry.id === 'view:quirky.session/worktree')!
    expect(slot).toMatchObject({ kind: 'view', plugin: 'quirky.terminal', shown: true })
    const report = await ui.waitView('the focused pane', (view) => view.layout?.revision === ws.revision && view.focusedPane === right.pane.id && view.panes.length === 4)

    expect(report.worktree).toBe(ws.id)
    expect(report.active).toBe(right.pane.session)
    expect(report.layout).toEqual(ws)
    expect(report.focusedPane).toBe(right.pane.id)
    expect(report.menu).toBeNull()
    expect(report.dialog).toBeNull()

    const groupOfTab = (tab: string) => groupsOf(ws).find((group) => group.tabs.some((entry) => entry.id === tab))!.id
    expect(report.tabs.map((entry) => [entry.session, entry.tab, entry.group, entry.pane, entry.title])).toEqual([
      [one.session, one.tab.id, groupOfTab(one.tab.id), one.pane.id, 'Terminal 1'],
      [build.session, build.tab.id, groupOfTab(build.tab.id), build.pane.id, 'Build'],
      [right.pane.session, build.tab.id, groupOfTab(build.tab.id), right.pane.id, 'Build'],
      [down.pane.session, build.tab.id, groupOfTab(build.tab.id), down.pane.id, 'Build'],
      [hello.session, hello.tab.id, groupOfTab(hello.tab.id), hello.pane.id, 'Hello']
    ])
    expect(report.tabs.every((entry) => entry.agent === 'shell' && entry.status === 'running')).toBe(true)

    expect(report.panes.map((entry) => entry.pane).sort()).toEqual([build.pane.id, right.pane.id, down.pane.id, hello.pane.id].sort())
    for (const entry of report.panes) {
      expect(entry.cols).toBeGreaterThan(0)
      expect(entry.rows).toBeGreaterThan(0)
      expect(entry.session).toBe(panesOf(ws).find((pane) => pane.id === entry.pane)!.session)
    }
  },
  SCENARIO_MS
)

test(
  'SC-76: opening the view with a session focuses its pane',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    const right = await splitPane(h, build.pane.id, 'right')
    await terminal(h, 'tab', 'move', build.tab.id, '--split', 'right')
    await terminal(h, 'tab', 'activate', one.tab.id)
    const before = await layoutOf(h)
    expect(before.activeGroup).not.toBe(groupsOf(before).find((group) => group.tabs.some((tab) => tab.id === build.tab.id))!.id)

    await ui.openView({ session: right.pane.session })
    const after = await ui.waitLayout('the pane of the session focused', (ws) => tabsOf(ws).find((tab) => tab.id === build.tab.id)?.activePane === right.pane.id && ws.activeGroup !== before.activeGroup)
    const buildGroup = groupsOf(after).find((group) => group.tabs.some((tab) => tab.id === build.tab.id))!
    expect(after.activeGroup).toBe(buildGroup.id)
    expect(buildGroup.activeTab).toBe(build.tab.id)
    const report = await ui.waitView('the session active', (view) => view.active === right.pane.session)
    expect(report.focusedPane).toBe(right.pane.id)
    expect(paneShape(tabsOf(after).find((tab) => tab.id === build.tab.id)!.root)).toEqual(['right', 0.5, build.pane.id, right.pane.id])

  },
  SCENARIO_MS
)

const ACME_VIEW = `export function activate(context) {
  context.provide('view:quirky.session/worktree', (element, props) => {
    element.setAttribute('data-acme-view', 'true')
    element.textContent = 'acme worktree view'
    props.report?.({ acme: true, input: props.input })
    return () => { element.textContent = '' }
  })
}
export function deactivate() {}
`

type Contributions = { views: { id: string; plugin: string }[] }

test(
  'SC-70: the worktree view stays replaceable',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const viewSlot = async () => (await ui.state()).slots.find((slot) => slot.id === 'view:quirky.session/worktree')!
    const viewOwner = async () => (await h.json<Contributions>(['ui', 'contributions'])).views.find((entry) => entry.id === 'view:quirky.session/worktree')!.plugin

    expect(await viewOwner()).toBe('quirky.terminal')
    expect(await viewSlot()).toMatchObject({ plugin: 'quirky.terminal', shown: true })
    await ui.el('.qt-workspace')

    const source = mkdtempSync('/tmp/qa-')
    try {
      writeFileSync(
        join(source, 'quirky-plugin.json'),
        JSON.stringify({
          id: 'acme.worktree-view',
          name: 'Acme worktree view',
          version: '1.0.0',
          ui: 'ui.js',
          dependencies: ['quirky.terminal'],
          overrides: [{ id: 'view:quirky.session/worktree', title: 'Acme worktree' }]
        })
      )
      writeFileSync(join(source, 'ui.js'), ACME_VIEW)
      await h.ok(['plugin', 'install', source, '--yes'])
      await waitFor('the test plugin to own the view', async () => ((await viewOwner()) === 'acme.worktree-view' ? true : undefined))
      await ui.el('[data-acme-view]')
      expect(await viewSlot()).toMatchObject({ plugin: 'acme.worktree-view', report: { acme: true, input: { worktree: 'main' } } })
      expect(ui.q('.qt-workspace')).toBeNull()
      expect((await ui.state()).layout.view).toMatchObject({ id: 'view:quirky.session/worktree' })

      await h.ok(['plugin', 'uninstall', 'acme.worktree-view', '--yes'])
      await waitFor('the workspace back', async () => ((await viewOwner()) === 'quirky.terminal' ? true : undefined))
      await ui.el('.qt-workspace')
    } finally {
      rmSync(source, { recursive: true, force: true })
    }

    await h.ok(['plugin', 'disable', 'quirky.terminal'])
    await waitFor('the session plugin to own the view', async () => ((await viewOwner()) === 'quirky.session' ? true : undefined))
    const fallback = await waitFor('the fallback view', async () => {
      const slot = await viewSlot()
      return slot.plugin === 'quirky.session' && slot.report !== undefined ? slot : undefined
    })
    expect(fallback.report).toMatchObject({ worktree: expect.any(String) })
    expect(ui.q('.qt-workspace')).toBeNull()
    expect((await ui.state()).layout.view).toMatchObject({ id: 'view:quirky.session/worktree' })

    await h.ok(['plugin', 'enable', 'quirky.terminal'])
    await waitFor('the workspace again', async () => ((await viewOwner()) === 'quirky.terminal' ? true : undefined))
    await ui.el('.qt-workspace')
  },
  SCENARIO_MS
)

test(
  'SC-75: hidden tabs cost nothing in the window, and WebGL is capped',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const first = await ui.firstTab()
    const rest = []
    for (let n = 2; n <= 8; n += 1) rest.push(await openTab(h, [], { ready: false }))
    const tabs = [first, ...rest]
    const third = tabs[2]!
    const sixth = tabs[5]!
    const thirdRight = await splitPane(h, third.pane.id, 'right')
    const sixthRight = await splitPane(h, sixth.pane.id, 'down')
    await terminal(h, 'tab', 'move', sixth.tab.id, '--split', 'right')
    await terminal(h, 'tab', 'activate', third.tab.id)

    const ws = await layoutOf(h)
    expect(tabsOf(ws)).toHaveLength(8)
    expect(groupsOf(ws)).toHaveLength(2)
    expect(groupsOf(ws).map((group) => group.tabs.find((tab) => tab.id === group.activeTab)!.id).sort()).toEqual([third.tab.id, sixth.tab.id].sort())

    const visible = [third.pane.id, thirdRight.pane.id, sixth.pane.id, sixthRight.pane.id].sort()
    const report = await ui.waitView('the two shown tabs mounted', (view) => view.panes.length === 4 && view.layout?.revision === ws.revision)
    expect(report.panes.map((entry) => entry.pane).sort()).toEqual(visible)
    expect(ui.qa('[data-pane]').map((element) => element.dataset.pane!).sort()).toEqual(visible)
    expect(ui.qa('.xterm')).toHaveLength(4)
    expect(report.panes.filter((entry) => entry.webgl).length).toBeLessThanOrEqual(12)

    await terminal(h, 'tab', 'activate', first.tab.id)
    const swapped = await ui.waitView('the first tab shown', (view) => view.panes.length === 3)
    expect(swapped.panes.map((entry) => entry.pane)).toContain(first.pane.id)
    await waitFor('the hidden tab unmounted', () => (ui.qa('.xterm').length === 3 && ui.q(`[data-pane="${third.pane.id}"]`) === null ? true : undefined))
  },
  SCENARIO_MS
)

test(
  'SC-69: embedding another plugin\'s view',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const first = await ui.firstTab()
    const session = await h.call<{ id: string }>('quirky.session/register', { worktree: 'main', agent: 'claude', kind: 'structured', title: 'Claude (background)' })
    // Background registration must not steal focus; hosting a structured viewer requires explicit adoption.
    const beforeAdoption = await layoutOf(h)
    expect(panesOf(beforeAdoption).some((pane) => pane.session === session.id)).toBe(false)
    await h.call('quirky.terminal/adoptSession', { session: session.id, group: groupsOf(beforeAdoption)[0]!.id })
    const ws = await ui.waitLayout('the structured session in a tab', (candidate) => panesOf(candidate).some((pane) => pane.session === session.id))
    const tab = tabsOf(ws).find((entry) => leavesOf(entry.root).some((pane) => pane.session === session.id))!
    expect(titleOf(tab)).toBe('Claude (background)')
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(tab.id)

    const transcript = await ui.el(`[data-session="${session.id}"] .qt-structured-body [role="log"]`)
    expect(transcript.isConnected).toBe(true)
    expect(ui.q(`[data-session="${session.id}"] .xterm`)).toBeNull()
    expect(ui.qa('[data-session] .qt-structured-body [role="log"]')).toHaveLength(1)

    await terminal(h, 'tab', 'activate', first.tab.id)
    await ui.gone(`[data-session="${session.id}"]`)
    expect(transcript.isConnected).toBe(false)
    expect(ui.qa('.qt-structured-body [role="log"]')).toHaveLength(0)

    await terminal(h, 'tab', 'activate', tab.id)
    await ui.el(`[data-session="${session.id}"] .qt-structured-body [role="log"]`)
  },
  SCENARIO_MS
)

test(
  'SC-71: opening a requested background structured session selects its transcript without creating a shell',
  async () => {
    const ui = await startUi({ view: false })
    const { h } = ui
    const session = await h.call<{ id: string }>('quirky.session/register', {
      worktree: 'main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude background',
      background: true
    })
    expect(await h.sessionRecord(session.id)).toMatchObject({ kind: 'structured', background: true })
    expect(tabsOf(await layoutOf(h))).toEqual([])

    await ui.openView({ worktree: 'main', session: session.id })
    const ws = await ui.waitLayout('the requested structured session adopted', (candidate) => panesOf(candidate).some((pane) => pane.session === session.id))
    const group = groupsOf(ws)[0]!
    const tab = tabsOf(ws).find((candidate) => leavesOf(candidate.root).some((pane) => pane.session === session.id))!
    expect(group.activeTab).toBe(tab.id)
    expect(tabsOf(ws)).toHaveLength(1)
    expect((await h.sessionRecords()).map((record) => record.id)).toEqual([session.id])
    expect(await h.hostRow(session.id)).toBeUndefined()

    const report = await ui.waitView('the requested session active in the worktree view', (view) => view.active === session.id)
    expect(report.active).toBe(session.id)
    await ui.el(`[data-session="${session.id}"] .qt-structured-body [role="log"]`)
    expect(ui.q(`[data-session="${session.id}"] .xterm`)).toBeNull()
    const sourceWorktree = (await h.sessionRecord(session.id)).worktreeId
    expect(report.worktree).toBe(sourceWorktree)
    expect(ui.callsTo('adoptSession').at(-1)).toMatchObject({ group: group.id, session: session.id })
  },
  SCENARIO_MS
)

test(
  'SC-72: a missing or wrong-worktree session selection stays visible instead of falling back',
  async () => {
    const ui = await startUi({ view: false })
    const { h } = ui
    await h.ok(['worktree', 'create', 'api', 'other', '--json'])
    const session = await h.call<{ id: string }>('quirky.session/register', {
      worktree: 'other',
      agent: 'claude',
      kind: 'structured',
      title: 'Other worktree'
    })

    await ui.openView({ worktree: 'main', session: 'missing-session' })
    await waitFor('the missing-session alert', () =>
      (ui.q('[role="alert"]')?.textContent?.includes('Session missing-session was not found') ? true : undefined)
    )
    expect(tabsOf(await layoutOf(h))).toEqual([])
    expect((await h.sessionRecords()).map((record) => record.id)).toEqual([session.id])
    expect(ui.q('.qt-workspace')).toBeNull()

    await ui.openView({ worktree: 'main', session: session.id })
    await waitFor('the wrong-worktree alert', () =>
      (ui.q('[role="alert"]')?.textContent?.includes('belongs to a different worktree') ? true : undefined)
    )
    expect(tabsOf(await layoutOf(h))).toEqual([])
    expect((await h.sessionRecords()).map((record) => record.id)).toEqual([session.id])
    expect(ui.q('.qt-workspace')).toBeNull()
  },
  SCENARIO_MS
)
