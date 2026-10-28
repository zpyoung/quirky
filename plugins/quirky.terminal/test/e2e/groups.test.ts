import { afterEach, expect, test } from 'bun:test'
import {
  SCENARIO_MS,
  cleanupAll,
  fails,
  groupOf,
  groupShape,
  groupsOf,
  layoutOf,
  openTab,
  startE2e,
  tabsOf,
  terminal,
  waitFor
} from './support'

afterEach(cleanupAll)

const titles = async (h: Awaited<ReturnType<typeof startE2e>>) => groupShape((await layoutOf(h)).root)

test(
  'SC-45: Move Tab to Split places the new group on the chosen side',
  async () => {
    const h = await startE2e({ cleanShell: true })
    const one = await openTab(h, ['--title', 'Terminal 1'], { ready: false })
    const hello = await openTab(h, ['--title', 'Hello'], { ready: false })
    expect(await titles(h)).toEqual(['Terminal 1', 'Hello'])

    const { workspace } = await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    expect(groupShape(workspace.root)).toEqual(['right', 0.5, ['Terminal 1'], ['Hello']])
    expect(groupOf(workspace, hello.tab.id).id).toBe(workspace.activeGroup)
    expect(groupOf(workspace, one.tab.id).id).not.toBe(workspace.activeGroup)

    const left = await openTab(h, ['--title', 'Left'], { ready: false })
    await terminal(h, 'tab', 'move', left.tab.id, '--split', 'left')
    expect(await titles(h)).toEqual(['right', 0.5, ['Terminal 1'], ['right', 0.5, ['Left'], ['Hello']]])

    const down = await openTab(h, ['--title', 'Down'], { ready: false })
    await terminal(h, 'tab', 'move', down.tab.id, '--split', 'down', '--of', groupOf(await layoutOf(h), hello.tab.id).id)
    expect(await titles(h)).toEqual(['right', 0.5, ['Terminal 1'], ['right', 0.5, ['Left'], ['down', 0.5, ['Hello'], ['Down']]]])

    const up = await openTab(h, ['--title', 'Up'], { ready: false })
    await terminal(h, 'tab', 'move', up.tab.id, '--split', 'up', '--of', groupOf(await layoutOf(h), one.tab.id).id)
    expect(await titles(h)).toEqual([
      'right',
      0.5,
      ['down', 0.5, ['Up'], ['Terminal 1']],
      ['right', 0.5, ['Left'], ['down', 0.5, ['Hello'], ['Down']]]
    ])
    expect(groupsOf(await layoutOf(h)).every((group) => group.tabs.length === 1)).toBe(true)
  },
  SCENARIO_MS
)

test(
  'SC-47: group dividers clamp between 0.15 and 0.85',
  async () => {
    const h = await startE2e({ cleanShell: true })
    await openTab(h, ['--title', 'A'], { ready: false })
    const b = await openTab(h, ['--title', 'B'], { ready: false })
    await terminal(h, 'tab', 'move', b.tab.id, '--split', 'right')
    const ws = await layoutOf(h)
    if (ws.root.kind !== 'split') throw new Error('expected two groups')
    const [first, second, split] = [ws.root.first.id, ws.root.second.id, ws.root.id]

    for (const ratio of ['0.1', '0.9', '0.14', '0']) {
      const refused = await fails(h, ['terminal', 'group', 'resize', first, '--ratio', ratio])
      expect(refused, ratio).toEqual({ code: 1, stderr: 'quirky: a group divider stays between 0.15 and 0.85\n' })
    }
    expect((await fails(h, ['terminal', 'group', 'resize', '--split', split, '--ratio', '0.05'])).stderr).toBe('quirky: a group divider stays between 0.15 and 0.85\n')
    expect(await layoutOf(h)).toEqual(ws)

    expect(groupShape((await terminal(h, 'group', 'resize', first, '--ratio', '0.15')).workspace.root)).toEqual(['right', 0.15, ['A'], ['B']])
    expect(groupShape((await terminal(h, 'group', 'resize', first, '--ratio', '0.85')).workspace.root)).toEqual(['right', 0.85, ['A'], ['B']])
    expect(groupShape((await terminal(h, 'group', 'resize', second, '--ratio', '0.15')).workspace.root)).toEqual(['right', 0.85, ['A'], ['B']])
    expect(groupShape((await terminal(h, 'group', 'resize', '--split', split, '--ratio', '0.5')).workspace.root)).toEqual(['right', 0.5, ['A'], ['B']])
  },
  SCENARIO_MS
)

test(
  'SC-48: a group goes away with its last tab, and Close Split Pane keeps its tabs',
  async () => {
    const h = await startE2e({ cleanShell: true })
    const one = await openTab(h, ['--title', 'Terminal 1'])
    const hello = await openTab(h, ['--title', 'Hello'])
    const logs = await openTab(h, ['--title', 'Logs'])
    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    await terminal(h, 'tab', 'move', logs.tab.id, '--group', groupOf(await layoutOf(h), hello.tab.id).id)
    await terminal(h, 'tab', 'activate', hello.tab.id)
    expect(await titles(h)).toEqual(['right', 0.5, ['Terminal 1'], ['Hello', 'Logs']])
    const [grp1, grp2] = [groupOf(await layoutOf(h), one.tab.id).id, groupOf(await layoutOf(h), hello.tab.id).id]

    await terminal(h, 'group', 'close', grp2)
    let ws = await layoutOf(h)
    expect(ws.root).toMatchObject({ kind: 'group', id: grp1 })
    expect(groupShape(ws.root)).toEqual(['Terminal 1', 'Hello', 'Logs'])
    expect(groupOf(ws, one.tab.id).activeTab).toBe(hello.tab.id)
    expect(ws.activeGroup).toBe(grp1)
    for (const opened of [one, hello, logs]) expect((await h.hostRow(opened.session))?.state).toBe('running')

    const last = await fails(h, ['terminal', 'group', 'close', grp1])
    expect(last.code).toBe(1)
    expect(await titles(h)).toEqual(['Terminal 1', 'Hello', 'Logs'])

    await terminal(h, 'tab', 'move', hello.tab.id, '--split', 'right')
    await terminal(h, 'tab', 'move', logs.tab.id, '--group', groupOf(await layoutOf(h), hello.tab.id).id)
    await terminal(h, 'tab', 'close', one.tab.id)
    ws = await layoutOf(h)
    expect(ws.root).toMatchObject({ kind: 'group' })
    expect(groupShape(ws.root)).toEqual(['Hello', 'Logs'])
    expect(groupsOf(ws)).toHaveLength(1)

    const zed = await openTab(h, ['--title', 'Zed'], { ready: false })
    await terminal(h, 'tab', 'move', logs.tab.id, '--split', 'right')
    await terminal(h, 'tab', 'move', zed.tab.id, '--split', 'down', '--of', groupOf(await layoutOf(h), logs.tab.id).id)
    expect(await titles(h)).toEqual(['right', 0.5, ['Hello'], ['down', 0.5, ['Logs'], ['Zed']]])
    const leftmost = groupOf(await layoutOf(h), hello.tab.id).id
    const topmost = groupOf(await layoutOf(h), logs.tab.id).id
    await terminal(h, 'group', 'close', leftmost)
    ws = await layoutOf(h)
    expect(groupShape(ws.root)).toEqual(['down', 0.5, ['Logs', 'Hello'], ['Zed']])
    expect(groupOf(ws, hello.tab.id).id).toBe(topmost)
    await waitFor('every session to keep running', async () => (await h.hostRow(hello.session))?.state === 'running')
    expect(tabsOf(ws)).toHaveLength(3)
  },
  SCENARIO_MS
)
