import { afterEach, expect, test } from 'bun:test'
import {
  SCENARIO_MS,
  cleanupUi,
  fails,
  fire,
  groupShape,
  groupsOf,
  layoutOf,
  mouse,
  namedTab,
  startUi,
  tabTitle,
  terminal,
  waitFor,
  type GroupNode,
  type Ui,
  type Workspace
} from './support'

afterEach(cleanupUi)

const shapeOf = async (ui: Ui) => groupShape((await layoutOf(ui.h)).root)
const groupOfTab = (ws: Workspace, tab: string) => groupsOf(ws).find((group) => group.tabs.some((entry) => entry.id === tab))!
const titlesIn = (ws: Workspace, tab: string) => groupOfTab(ws, tab).tabs.map(tabTitle)

/** Which side of its parent split the group holding `tab` is on, e.g. `right/second` for a group dropped to the right. */
function placement(root: GroupNode, tab: string, parent: GroupNode | null = null): string | null {
  if (root.kind === 'group') {
    if (parent?.kind !== 'split' || !root.tabs.some((entry) => entry.id === tab)) return null
    return `${parent.direction}/${parent.first === root ? 'first' : 'second'}`
  }
  return placement(root.first, tab, root) ?? placement(root.second, tab, root)
}

test(
  'SC-45: Move Tab to Split',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const hello = await namedTab(ui, 'Hello')
    await waitFor('both tabs drawn', () => (ui.tabTitles().join() === 'Terminal 1,Hello' ? true : undefined))
    expect(ui.qa('.qt-strip')).toHaveLength(1)

    await ui.contextMenu(`[data-tab="${hello.tab.id}"]`)
    await ui.pick('Move Tab to Split')
    expect(ui.qa('.qt-submenu [role="menuitem"]').map((row) => row.textContent)).toEqual(['Right', 'Left', 'Down', 'Up'])
    await ui.pick('Right')
    const ws = await ui.waitLayout('two groups', (candidate) => groupsOf(candidate).length === 2)
    expect(ui.callsTo('moveTab')).toEqual([{ tab: hello.tab.id, split: 'right', of: groupsOf(ws)[0]!.id }])
    expect(groupShape(ws.root)).toEqual(['right', 0.5, ['Terminal 1'], ['Hello']])
    expect(ws.activeGroup).toBe(groupOfTab(ws, hello.tab.id).id)

    await waitFor('two strips drawn', () => (ui.qa('.qt-strip').length === 2 ? true : undefined))
    expect(ui.qa('.qt-strip [data-plus]')).toHaveLength(2)
    expect(ui.qa('.qt-strip [data-actions]')).toHaveLength(2)
    expect(ui.qa('.qt-strip .qc-strip')).toHaveLength(2)
    expect(ui.qa<HTMLButtonElement>('[data-actions]').every((button) => !button.disabled)).toBe(true)
    expect(ui.tabTitles(groupOfTab(ws, hello.tab.id).id)).toEqual(['Hello'])
    expect(ui.tabTitles(groupOfTab(ws, one.tab.id).id)).toEqual(['Terminal 1'])

    await terminal(h, 'tab', 'move', hello.tab.id, '--group', groupOfTab(ws, one.tab.id).id)
    const sides = { right: 'right/second', left: 'right/first', down: 'down/second', up: 'down/first' } as const
    for (const [side, expected] of Object.entries(sides)) {
      const extra = await namedTab(ui, `Side ${side}`)
      const target = (await layoutOf(h)).activeGroup
      await terminal(h, 'tab', 'move', extra.tab.id, '--split', side, '--of', target)
      const placed = await layoutOf(h)
      expect(placement(placed.root, extra.tab.id)).toBe(expected)
      expect(placed.activeGroup).toBe(groupOfTab(placed, extra.tab.id).id)
      await terminal(h, 'tab', 'close', extra.tab.id)
    }
  },
  SCENARIO_MS
)

test(
  'SC-46: dropping a tab on a group body',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const a = await ui.firstTab()
    await terminal(h, 'tab', 'rename', a.tab.id, 'A')
    const b = await namedTab(ui, 'B')
    const c = await namedTab(ui, 'C')
    await ui.sync()
    await waitFor('three tabs drawn', () => (ui.tabTitles().length === 3 ? true : undefined))

    /** Drags `tab` over the body of `group` at (x, y), reports the preview it showed, and drops there unless `drop` is false. */
    const dragTo = async (tab: string, group: string, x: number, y: number, drop = true): Promise<string | null> => {
      const body = ui.q(`[data-group-body="${group}"]`)!
      ui.setRect(body, { left: 0, top: 0, width: 900, height: 600 })
      fire(ui.q(`[data-tab="${tab}"]`)!, mouse('dragstart'))
      await ui.settle()
      fire(body, mouse('dragover', { clientX: x, clientY: y }))
      await ui.settle()
      const zone = ui.q('[data-zone]')?.getAttribute('data-zone') ?? null
      if (drop) fire(body, mouse('drop', { clientX: x, clientY: y }))
      fire(ui.q(`[data-tab="${tab}"]`)!, mouse('dragend'))
      await ui.settle()
      return zone
    }

    const g1 = groupsOf(await layoutOf(h))[0]!.id
    expect(await dragTo(b.tab.id, g1, 450, 300, false)).toBe('center')
    expect(await dragTo(b.tab.id, g1, 40, 300, false)).toBe('left')
    expect(await dragTo(b.tab.id, g1, 860, 300, false)).toBe('right')
    expect(await dragTo(b.tab.id, g1, 450, 20, false)).toBe('up')
    expect(await dragTo(b.tab.id, g1, 450, 580, false)).toBe('down')
    expect(ui.callsTo('moveTab')).toEqual([])
    expect(ui.q('[data-zone]')).toBeNull()

    await dragTo(b.tab.id, g1, 40, 300)
    const left = await ui.waitLayout('B on the left', (ws) => groupsOf(ws).length === 2)
    expect(ui.callsTo('moveTab')).toEqual([{ tab: b.tab.id, split: 'left', of: g1 }])
    expect(groupShape(left.root)).toEqual(['right', 0.5, ['B'], ['A', 'C']])

    expect(await dragTo(c.tab.id, g1, 100, 300, false)).toBe('left')
    expect(await dragTo(c.tab.id, g1, 450, 100, false)).toBe('up')
    expect(await dragTo(c.tab.id, g1, 450, 300, false)).toBe('center')
    await dragTo(c.tab.id, g1, 860, 300)
    const right = await ui.waitLayout('C on the right', (ws) => groupsOf(ws).length === 3)
    expect(ui.callsTo('moveTab')[1]).toEqual({ tab: c.tab.id, split: 'right', of: g1 })
    expect(groupShape(right.root)).toEqual(['right', 0.5, ['B'], ['right', 0.5, ['A'], ['C']]])

    const target = groupOfTab(right, c.tab.id).id
    await dragTo(b.tab.id, target, 450, 300)
    const merged = await ui.waitLayout('B merged into C\'s group', (ws) => groupsOf(ws).length === 2)
    expect(ui.callsTo('moveTab')[2]).toEqual({ tab: b.tab.id, group: target })
    expect(groupShape(merged.root)).toEqual(['right', 0.5, ['A'], ['C', 'B']])
    expect(groupOfTab(merged, b.tab.id).activeTab).toBe(b.tab.id)

    await terminal(h, 'tab', 'move', b.tab.id, '--split', 'left', '--of', groupOfTab(merged, a.tab.id).id)
    expect(await shapeOf(ui)).toEqual(['right', 0.5, ['right', 0.5, ['B'], ['A']], ['C']])
  },
  SCENARIO_MS
)

test(
  'SC-48: a group goes away with its last tab, and "Close Split Pane" keeps tabs (the last tab closed)',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const hello = await namedTab(ui, 'Hello')
    const logs = await namedTab(ui, 'Logs')
    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    const split = await layoutOf(h)
    await terminal(h, 'tab', 'move', logs.tab.id, '--group', groupOfTab(split, hello.tab.id).id)
    await ui.sync()
    expect(await shapeOf(ui)).toEqual(['right', 0.5, ['Terminal 1'], ['Hello', 'Logs']])
    await waitFor('both strips drawn', () => (ui.qa('.qt-strip').length === 2 ? true : undefined))

    ui.q(`[aria-label="Close Terminal 1"]`)!.click()
    const closed = await ui.waitLayout('the first group gone', (ws) => groupsOf(ws).length === 1)
    expect(closed.root.kind).toBe('group')
    expect(titlesIn(closed, hello.tab.id)).toEqual(['Hello', 'Logs'])
    await waitFor('one strip filling the area', () => (ui.qa('.qt-strip').length === 1 && ui.q('[data-group]')!.parentElement!.style.width === '1000px' ? true : undefined))
    expect(ui.q<HTMLButtonElement>('[data-actions]')!.disabled).toBe(true)
    const lastGroup = groupsOf(closed)[0]!.id
    const refused = await fails(h, ['terminal', 'group', 'close', lastGroup])
    expect(refused.code).not.toBe(0)
    expect(groupsOf(await layoutOf(h))).toHaveLength(1)
  },
  SCENARIO_MS
)

test(
  'SC-48: a group goes away with its last tab, and "Close Split Pane" keeps tabs (Close Split Pane)',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const hello = await namedTab(ui, 'Hello')
    const logs = await namedTab(ui, 'Logs')
    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    const split = await layoutOf(h)
    const g1 = groupOfTab(split, one.tab.id).id
    const g2 = groupOfTab(split, hello.tab.id).id
    await terminal(h, 'tab', 'move', logs.tab.id, '--group', g2)
    await terminal(h, 'tab', 'activate', hello.tab.id)
    await ui.sync()
    await waitFor('both strips drawn', () => (ui.qa('.qt-strip').length === 2 ? true : undefined))
    const sessions = [one.session, hello.session, logs.session]
    const before = await layoutOf(h)
    const activeInSecond = groupOfTab(before, hello.tab.id).activeTab
    expect(activeInSecond).toBe(hello.tab.id)

    ui.q(`[data-actions="${g2}"]`)!.click()
    expect((await ui.waitView('the actions menu', (view) => view.menu?.kind === 'actions')).menu!.items.map((item) => item.label)).toEqual(['Close Split Pane'])
    await ui.pick('Close Split Pane')
    const merged = await ui.waitLayout('the second group gone', (ws) => groupsOf(ws).length === 1)
    expect(ui.callsTo('closeGroup')).toEqual([{ group: g2 }])
    expect(titlesIn(merged, hello.tab.id)).toEqual(['Terminal 1', 'Hello', 'Logs'])
    expect(groupsOf(merged)[0]!.id).toBe(g1)
    expect(groupsOf(merged)[0]!.activeTab).toBe(hello.tab.id)
    for (const session of sessions) expect((await h.hostRow(session))?.state).not.toBe('exited')
    expect((await h.sessionRecords()).map((record) => record.id).sort()).toEqual([...sessions].sort())
    await waitFor('one strip with three tabs', () => (ui.qa('.qt-strip').length === 1 && ui.tabTitles().join() === 'Terminal 1,Hello,Logs' ? true : undefined))

    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    const again = await layoutOf(h)
    await terminal(h, 'tab', 'move', logs.tab.id, '--split', 'down', '--of', groupOfTab(again, hello.tab.id).id)
    const nested = await layoutOf(h)
    expect(groupShape(nested.root)).toEqual(['right', 0.5, ['Terminal 1'], ['down', 0.5, ['Hello'], ['Logs']]])
    await ui.sync()
    await waitFor('three strips', () => (ui.qa('.qt-strip').length === 3 ? true : undefined))
    ui.q(`[data-actions="${groupOfTab(nested, one.tab.id).id}"]`)!.click()
    await ui.pick('Close Split Pane')
    const folded = await ui.waitLayout('the first group closed', (ws) => groupsOf(ws).length === 2)
    expect(groupShape(folded.root)).toEqual(['down', 0.5, ['Hello', 'Terminal 1'], ['Logs']])

    await terminal(h, 'group', 'close', groupOfTab(folded, logs.tab.id).id)
    const last = await layoutOf(h)
    expect(groupShape(last.root)).toEqual(['Hello', 'Terminal 1', 'Logs'])
  },
  SCENARIO_MS
)
