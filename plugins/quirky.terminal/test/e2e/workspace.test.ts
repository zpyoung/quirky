import { afterEach, expect, test } from 'bun:test'
import {
  RpcErrorCode,
  SCENARIO_MS,
  cleanupAll,
  ensureWorkspace,
  fails,
  findTab,
  layoutOf,
  leavesOf,
  openTab,
  paneShape,
  panesOf,
  rejection,
  splitPane,
  startE2e,
  tabsOf,
  terminal,
  waitForLayout,
  type Workspace
} from './support'

afterEach(cleanupAll)

test(
  'SC-2: `quirky terminal layout` prints the tree',
  async () => {
    const h = await startE2e()
    const one = await openTab(h)
    const build = await openTab(h)
    const hello = await openTab(h)
    await terminal(h, 'tab', 'rename', build.tab.id, 'Build')
    await terminal(h, 'tab', 'rename', hello.tab.id, 'Hello')
    await terminal(h, 'tab', 'color', one.tab.id, 'blue')
    const right = await splitPane(h, build.pane.id, 'right')
    const down = await splitPane(h, right.pane.id, 'down')
    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    await terminal(h, 'pane', 'focus', right.pane.id)

    const ws = await layoutOf(h)
    if (ws.root.kind !== 'split' || ws.root.first.kind !== 'group' || ws.root.second.kind !== 'group') throw new Error('expected two groups')
    const [g1, g2] = [ws.root.first.id, ws.root.second.id]
    const sessionOf = (pane: string) => panesOf(ws).find((candidate) => candidate.id === pane)!.session
    const text = await h.ok(['terminal', 'layout', '--worktree', 'main'])
    expect(text.trimEnd().split('\n')).toEqual([
      'split right 0.5',
      `  group ${g1} (active)`,
      `    tab ${one.tab.id} "Terminal 1" blue`,
      `      pane ${one.pane.id} ${one.session}`,
      `    tab ${build.tab.id} "Build" (active)`,
      '      split right 0.5',
      `        pane ${build.pane.id} ${build.session}`,
      '        split down 0.5',
      `          pane ${right.pane.id} ${sessionOf(right.pane.id)} (active)`,
      `          pane ${down.pane.id} ${sessionOf(down.pane.id)}`,
      `  group ${g2}`,
      `    tab ${hello.tab.id} "Hello"`,
      `      pane ${hello.pane.id} ${hello.session}`
    ])

    const json = await h.json<Workspace>(['terminal', 'layout', '--worktree', 'main'])
    expect(json.revision).toBe(ws.revision)
    expect(json.revision).toBeGreaterThan(0)
    expect(json.id).toBe(ws.id)
  },
  SCENARIO_MS
)

test(
  'SC-4: sessions started elsewhere open in a new tab',
  async () => {
    const h = await startE2e()
    const first = await ensureWorkspace(h)
    const [only] = tabsOf(first)
    expect(only!.defaultTitle).toBe('Terminal 1')

    const session = await h.newSession()
    const ws = await waitForLayout(h, 'a second tab', (candidate) => tabsOf(candidate).length === 2)
    const [old, added] = tabsOf(ws)
    expect(old).toEqual(only!)
    expect(added!.defaultTitle).toBe('Terminal 2')
    expect(leavesOf(added!.root).map((pane) => pane.session)).toEqual([session.id])
    expect(ws.root.kind === 'group' && ws.root.tabs.map((tab) => tab.id)).toEqual([old!.id, added!.id])
    expect(ws.root.kind === 'group' && ws.root.activeTab).toBe(added!.id)
    expect(ws.activeGroup).toBe(ws.root.id)
  },
  SCENARIO_MS
)

test(
  'SC-5: a session closed elsewhere leaves its pane',
  async () => {
    const h = await startE2e()
    const one = await openTab(h)
    const build = await openTab(h)
    const right = await splitPane(h, build.pane.id, 'right')
    const down = await splitPane(h, right.pane.id, 'down')
    expect(paneShape(findTab(await layoutOf(h), build.tab.id).root)).toEqual(['right', 0.5, build.pane.id, ['down', 0.5, right.pane.id, down.pane.id]])
    expect(findTab(await layoutOf(h), build.tab.id).activePane).toBe(down.pane.id)

    expect((await h.cli(['session', 'close', down.pane.session])).code).toBe(0)
    const ws = await waitForLayout(h, 'pane-4 gone', (candidate) => !panesOf(candidate).some((pane) => pane.id === down.pane.id))
    const tab = findTab(ws, build.tab.id)
    expect(paneShape(tab.root)).toEqual(['right', 0.5, build.pane.id, right.pane.id])
    expect(tab.activePane).toBe(build.pane.id)

    expect((await h.cli(['session', 'close', one.session])).code).toBe(0)
    const after = await waitForLayout(h, 'the lone tab gone', (candidate) => tabsOf(candidate).length === 1)
    expect(tabsOf(after).map((candidate) => candidate.id)).toEqual([build.tab.id])
    expect(after.closed).toEqual([])
  },
  SCENARIO_MS
)

test(
  'SC-6: a stale revision is refused',
  async () => {
    const h = await startE2e()
    const { pane } = await openTab(h)
    await splitPane(h, pane.id, 'right')
    const ws = await layoutOf(h)
    const tab = tabsOf(ws)[0]!
    if (tab.root.kind !== 'split') throw new Error('expected a split')

    const stale = await rejection(h.call('quirky.terminal/resizeSplit', { split: tab.root.id, ratio: 0.3, revision: ws.revision - 1 }))
    expect(stale.code).toBe(RpcErrorCode.Conflict)
    expect(stale.message).toBe(`workspace ${ws.id} is at revision ${ws.revision}`)
    expect(await layoutOf(h)).toEqual(ws)

    const fresh = await h.call<{ workspace: Workspace }>('quirky.terminal/resizeSplit', { split: tab.root.id, ratio: 0.3, revision: ws.revision })
    expect(fresh.workspace.revision).toBe(ws.revision + 1)
  },
  SCENARIO_MS
)

test(
  'SC-7: bad targets fail with clear errors and leave the layout alone',
  async () => {
    const h = await startE2e()
    const one = await openTab(h)
    const two = await openTab(h)
    await terminal(h, 'tab', 'move', two.tab.id, '--split', 'right')
    const before = await layoutOf(h)

    const missing = await fails(h, ['terminal', 'pane', 'focus', 'pane-99'])
    expect(missing).toEqual({ code: 1, stderr: 'quirky: no pane pane-99\n' })

    const lastPane = await fails(h, ['terminal', 'pane', 'move', one.pane.id, '--to-tab', two.tab.id])
    expect(lastPane).toEqual({ code: 1, stderr: "quirky: the last pane of a tab can't be moved out\n" })

    const group = tabsOf(before).length === 2 && before.root.kind === 'split' ? before.root.first.id : ''
    const divider = await fails(h, ['terminal', 'group', 'resize', group, '--ratio', '0.9'])
    expect(divider).toEqual({ code: 1, stderr: 'quirky: a group divider stays between 0.15 and 0.85\n' })

    expect(await layoutOf(h)).toEqual(before)
  },
  SCENARIO_MS
)
