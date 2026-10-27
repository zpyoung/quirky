import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode, type PluginEvent, type QuirkyEvent, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { groupsInOrder, paneLeaves } from '../src/layout/tree'
import type { FloatingState, Group, PaneLeaf, Tab, Workspace } from '../src/layout/types'
import { sessionCreates } from './fakes/quirky.session/main'
import { call, createSession, restartDaemon, startPluginHarness, TERMINAL_PLUGINS, type PluginSet } from './support'

const WT = 'wt_main'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  sessionCreates().length = 0
  h = await startPluginHarness(TERMINAL_PLUGINS)
  client = await h.connect('cli')
  events = (await h.connectWithEvents('ui')).events
})
afterEach(async () => {
  await h.cleanup()
})

const api = (method: string, params: Record<string, unknown> = {}, c: QuirkyClient = client) => call<any>(c, `quirky.terminal/${method}`, params)
const layoutOf = async (workspace = WT, c: QuirkyClient = client) => (await api('workspace', { workspace }, c)).workspace as Workspace
const tabsOf = (ws: Workspace): Tab[] => groupsInOrder(ws.root).flatMap((group) => group.tabs)
const groupsOf = (ws: Workspace): Group[] => groupsInOrder(ws.root)
const panesOf = (tab: Tab): PaneLeaf[] => paneLeaves(tab.root)
const titles = (ws: Workspace) => tabsOf(ws).map((tab) => tab.customTitle ?? tab.defaultTitle)
const tabNamed = (ws: Workspace, title: string) => tabsOf(ws).find((tab) => (tab.customTitle ?? tab.defaultTitle) === title)!
const newTab = async (params: Record<string, unknown> = {}) => (await api('newTab', { workspace: WT, ...params })).workspace as Workspace
const lastTab = (ws: Workspace) => tabsOf(ws).at(-1)!
const error = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (Error & { code?: number }) | null
const sessionList = () => call<Session[]>(client, 'quirky.session/list', {})

/** Sends a PTY fact and waits until the daemon has reported it, so a following call sees it. */
async function fact(sessionId: string, value: Parameters<typeof h.pty.fact>[1], eventName: string): Promise<void> {
  const seen = events.length
  h.pty.fact(sessionId, value)
  await waitFor(() =>
    events.slice(seen).some((e) => e.type === `quirky.terminal/${eventName}` && ((e as PluginEvent).data as { sessionId?: string }).sessionId === sessionId)
  )
}

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'qt-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SC-1: the first tab', () => {
  test('ensure creates "Terminal 1" on a new shell in the worktree and a second ensure adds nothing', async () => {
    const first = (await api('workspace', { workspace: 'main', ensure: true })).workspace as Workspace
    expect(first.id).toBe(WT)
    expect(first.revision).toBe(1)
    expect(groupsOf(first)).toHaveLength(1)
    const [tab] = tabsOf(first)
    expect(tab!.defaultTitle).toBe('Terminal 1')
    expect(panesOf(tab!)).toHaveLength(1)
    const session = panesOf(tab!)[0]!.session
    expect(tab!.activePane).toBe(panesOf(tab!)[0]!.id)
    expect(sessionCreates()).toEqual([{ worktree: 'id:wt_main', agent: 'shell' }])
    expect((await call<Session[]>(client, 'quirky.session/list', {})).map((s) => s.id)).toEqual([session])

    const again = (await api('workspace', { workspace: 'main', ensure: true })).workspace as Workspace
    expect(again).toEqual(first)
    expect(sessionCreates()).toHaveLength(1)
  })

  test('without ensure, a workspace with no tabs stays empty at revision 0', async () => {
    const ws = await layoutOf()
    expect(ws).toMatchObject({ id: WT, revision: 0, closed: [] })
    expect(tabsOf(ws)).toEqual([])
    expect(sessionCreates()).toHaveLength(0)
  })

  test('ensure adopts a session that no pane holds instead of starting another', async () => {
    const existing = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    await waitForAsync(async () => tabsOf(await layoutOf()).length === 1)
    const ws = (await api('workspace', { workspace: WT, ensure: true })).workspace as Workspace
    expect(tabsOf(ws).map((tab) => panesOf(tab)[0]!.session)).toEqual([existing.id])
  })

  test('the caller\'s worktree is the default workspace, and a floating caller gets floating', async () => {
    const inMain = await QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', worktreeId: WT })
    const inFloating = await QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', worktreeId: 'floating' })
    try {
      expect((await api('workspace', {}, inMain)).workspace.id).toBe(WT)
      expect((await api('workspace', {}, inFloating)).workspace.id).toBe('floating')
    } finally {
      inMain.close()
      inFloating.close()
    }
  })
})

describe('SC-4, SC-5: sessions started and closed elsewhere', () => {
  test('SC-4: a session started elsewhere gets a new active tab at the end of the active group', async () => {
    await api('workspace', { workspace: WT, ensure: true })
    const before = await layoutOf()
    const other = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return tabsOf(current).length === 2 ? current : null
    })
    expect(titles(ws)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(panesOf(lastTab(ws))[0]!.session).toBe(other.id)
    expect(groupsOf(ws)[0]!.activeTab).toBe(lastTab(ws).id)
    expect(tabsOf(ws)[0]).toEqual(tabsOf(before)[0]!)
  })

  test('sessions of other worktrees get their own workspaces', async () => {
    await createSession(client, { worktree: 'id:wt_other', agent: 'shell' })
    const ws = await waitForAsync(async () => {
      const current = await layoutOf('wt_other')
      return tabsOf(current).length === 1 ? current : null
    })
    expect(ws.id).toBe('wt_other')
    expect(tabsOf(await layoutOf())).toHaveLength(0)
  })

  test('SC-5: a closed session leaves its pane, the sibling takes the space, and the first pane becomes active', async () => {
    let ws = await newTab()
    const pane = panesOf(lastTab(ws))[0]!
    ws = (await api('splitPane', { pane: pane.id, direction: 'right' })).workspace
    ws = (await api('splitPane', { pane: panesOf(lastTab(ws))[1]!.id, direction: 'down' })).workspace
    const tab = lastTab(ws)
    const [first, second, third] = panesOf(tab)
    expect(tab.activePane).toBe(third!.id)

    await call(client, 'quirky.session/close', { session: third!.session })
    ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return panesOf(lastTab(current)).length === 2 ? current : null
    })
    expect(panesOf(lastTab(ws)).map((p) => p.id)).toEqual([first!.id, second!.id])
    expect(lastTab(ws).root).toMatchObject({ kind: 'split', first: { id: first!.id }, second: { id: second!.id } })
    expect(lastTab(ws).activePane).toBe(first!.id)
  })

  test('closing the session of a tab\'s only pane removes the tab without offering it for reopen', async () => {
    const ws = await newTab()
    await call(client, 'quirky.session/close', { session: panesOf(lastTab(ws))[0]!.session })
    const after = await waitForAsync(async () => {
      const current = await layoutOf()
      return tabsOf(current).length === 0 ? current : null
    })
    expect(after.closed).toEqual([])
    expect(groupsOf(after)).toHaveLength(1)
  })

  test('a layout survives sessions from a repaired pass: no pane is bound twice', async () => {
    await Promise.all([newTab(), newTab(), createSession(client, { worktree: 'id:wt_main', agent: 'shell' }), newTab(), createSession(client, { worktree: 'id:wt_main', agent: 'shell' })])
    const ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return tabsOf(current).length === 5 ? current : null
    })
    const bound = tabsOf(ws).flatMap((tab) => panesOf(tab).map((pane) => pane.session))
    expect(new Set(bound).size).toBe(5)
    expect(bound.sort()).toEqual((await sessionList()).map((s) => s.id).sort())
  })
})

describe('SC-6, SC-7: revisions and bad targets', () => {
  test('SC-6: a stale revision is a conflict naming the current one, and nothing changes', async () => {
    let ws = await newTab()
    ws = await newTab()
    const tab = lastTab(ws)
    const failed = await error(api('renameTab', { tab: tab.id, title: 'x', revision: ws.revision - 1 }))
    expect(failed?.code).toBe(RpcErrorCode.Conflict)
    expect(failed?.message).toBe(`workspace ${WT} is at revision ${ws.revision}`)
    expect(await layoutOf()).toEqual(ws)

    const accepted = await api('renameTab', { tab: tab.id, title: 'x', revision: ws.revision })
    expect(accepted.workspace.revision).toBe(ws.revision + 1)
  })

  test('every change bumps the revision by one', async () => {
    let ws = await newTab()
    const revisions = [ws.revision]
    for (const step of [
      () => api('renameTab', { tab: lastTab(ws).id, title: 'a' }),
      () => api('setTabColor', { tab: lastTab(ws).id, color: 'blue' }),
      () => api('pinTab', { tab: lastTab(ws).id, pinned: true })
    ]) {
      ws = (await step()).workspace
      revisions.push(ws.revision)
    }
    expect(revisions.map((r, i) => (i === 0 ? 0 : r - revisions[i - 1]!))).toEqual([0, 1, 1, 1])
  })

  test('SC-7: unknown ids are not-found naming the id; impossible moves are invalid-params with the spec text', async () => {
    let ws = await newTab()
    ws = await newTab()
    const only = panesOf(tabsOf(ws)[0]!)[0]!
    const target = tabsOf(ws)[1]!

    const missing = await error(api('focusPane', { pane: 'pane-99' }))
    expect([missing?.code, missing?.message]).toEqual([RpcErrorCode.NotFound, 'no pane pane-99'])
    expect((await error(api('closeTab', { tab: 'tab-99' })))?.message).toBe('no tab tab-99')
    expect((await error(api('closeGroup', { group: 'grp-99' })))?.message).toBe('no group grp-99')
    expect((await error(api('resizeSplit', { split: 'split-99', ratio: 0.5 })))?.message).toBe('no split split-99')
    expect((await error(api('paneOf', { session: 's_nope' })))?.code).toBe(RpcErrorCode.NotFound)

    const lastPane = await error(api('movePane', { pane: only.id, toTab: target.id }))
    expect([lastPane?.code, lastPane?.message]).toEqual([RpcErrorCode.InvalidParams, "the last pane of a tab can't be moved out"])
    const group = await error(api('resizeSplit', { group: groupsOf(ws)[0]!.id, share: 0.9 }))
    expect(group?.code).toBe(RpcErrorCode.InvalidParams)
    expect(await layoutOf()).toEqual(ws)
  })
})

describe('tabs', () => {
  test('SC-8: a new tab takes the lowest free "Terminal N"', async () => {
    await newTab()
    await newTab()
    let ws = await newTab()
    expect(titles(ws)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
    ws = (await api('closeTab', { tab: tabNamed(ws, 'Terminal 2').id })).workspace
    ws = await newTab()
    expect(titles(ws)).toEqual(['Terminal 1', 'Terminal 3', 'Terminal 2'])
    expect(groupsOf(ws)[0]!.activeTab).toBe(lastTab(ws).id)
  })

  test('newTab with an agent, prompt, title and cwd passes them to the session plugin', async () => {
    const dir = tempDir()
    const ws = await newTab({ agent: 'claude', prompt: 'review the diff', title: 'Review', cwd: dir })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'id:wt_main', agent: 'claude', prompt: 'review the diff', cwd: dir })
    expect(lastTab(ws).defaultTitle).toBe('Review')
    const agentTab = await newTab({ agent: 'codex' })
    expect(lastTab(agentTab).defaultTitle).toBe('Codex')
    expect((await error(api('newTab', { workspace: WT, cwd: '/no/such/dir' })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect(tabsOf(await layoutOf())).toHaveLength(2)
  })

  test('SC-9: rename sets a custom title, the empty string clears it, and long titles are refused', async () => {
    let ws = await newTab()
    const tab = lastTab(ws)
    ws = (await api('renameTab', { tab: tab.id, title: 'Build' })).workspace
    expect(lastTab(ws)).toMatchObject({ customTitle: 'Build', defaultTitle: 'Terminal 1' })
    ws = (await api('renameTab', { tab: tab.id, title: '' })).workspace
    expect(lastTab(ws).customTitle).toBeNull()
    const long = await error(api('renameTab', { tab: tab.id, title: 'x'.repeat(201) }))
    expect(long?.code).toBe(RpcErrorCode.InvalidParams)
    ws = (await api('renameTab', { tab: tab.id, title: 'x'.repeat(200) })).workspace
    expect(lastTab(ws).customTitle).toHaveLength(200)
  })

  test('SC-10: the shell\'s title becomes the live title, follows the active pane, and a custom title keeps its place', async () => {
    let ws = await newTab()
    const tab = lastTab(ws)
    const first = panesOf(tab)[0]!
    await fact(first.session, { kind: 'title', title: 'deploy' }, 'title')
    ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return lastTab(current).liveTitle === 'deploy' ? current : null
    })

    ws = (await api('splitPane', { pane: first.id, direction: 'right' })).workspace
    const second = panesOf(lastTab(ws))[1]!
    expect(lastTab(ws).liveTitle).toBeNull()
    await fact(second.session, { kind: 'title', title: 'logs' }, 'title')
    await waitForAsync(async () => lastTab(await layoutOf()).liveTitle === 'logs')
    await fact(first.session, { kind: 'title', title: 'build' }, 'title')
    await Bun.sleep(30)
    expect(lastTab(await layoutOf()).liveTitle).toBe('logs')

    ws = (await api('focusPane', { pane: first.id })).workspace
    expect(lastTab(ws).liveTitle).toBe('build')
    ws = (await api('renameTab', { tab: tab.id, title: 'Mine' })).workspace
    expect(lastTab(ws)).toMatchObject({ customTitle: 'Mine', liveTitle: 'build' })
  })

  test('colours accept only the ten names; pinned tabs sort first and keep their relative order', async () => {
    await newTab()
    await newTab()
    let ws = await newTab()
    const [a, b, c] = tabsOf(ws)
    ws = (await api('setTabColor', { tab: b!.id, color: 'blue' })).workspace
    expect(tabsOf(ws)[1]!.color).toBe('blue')
    expect((await error(api('setTabColor', { tab: b!.id, color: 'mauve' })))?.code).toBe(RpcErrorCode.InvalidParams)
    ws = (await api('setTabColor', { tab: b!.id, color: 'none' })).workspace
    expect(tabsOf(ws)[1]!.color).toBe('none')

    ws = (await api('pinTab', { tab: c!.id, pinned: true })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([c!.id, a!.id, b!.id])
    ws = (await api('pinTab', { tab: a!.id, pinned: true })).workspace
    expect(tabsOf(ws).map((t) => [t.id, t.pinned])).toEqual([[c!.id, true], [a!.id, true], [b!.id, false]])
    ws = (await api('pinTab', { tab: c!.id, pinned: false })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([a!.id, c!.id, b!.id])
  })

  test('SC-12: closing an idle tab ends its sessions without asking, and the previously used tab becomes active', async () => {
    await newTab()
    await newTab()
    let ws = await newTab()
    const [one, two, three] = tabsOf(ws)
    ws = (await api('activateTab', { tab: one!.id })).workspace
    ws = (await api('activateTab', { tab: three!.id })).workspace
    const doomed = panesOf(three!)[0]!.session
    ws = (await api('closeTab', { tab: three!.id })).workspace
    expect(groupsOf(ws)[0]!.activeTab).toBe(one!.id)
    expect(tabsOf(ws).map((t) => t.id)).toEqual([one!.id, two!.id])
    expect((await sessionList()).map((s) => s.id)).not.toContain(doomed)
    expect(h.pty.sessions.has(doomed)).toBe(false)
  })

  test('closeTabs closes the others, the tabs to the right or the left, and skips pinned ones', async () => {
    for (let i = 0; i < 5; i++) await newTab()
    let ws = await layoutOf()
    const [a, b, c, d, e] = tabsOf(ws)
    ws = (await api('pinTab', { tab: b!.id, pinned: true })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([b!.id, a!.id, c!.id, d!.id, e!.id])
    ws = (await api('closeTabs', { tab: c!.id, which: 'left' })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([b!.id, c!.id, d!.id, e!.id])
    ws = (await api('closeTabs', { tab: d!.id, which: 'right' })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([b!.id, c!.id, d!.id])
    ws = (await api('closeTabs', { tab: d!.id, which: 'others' })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([b!.id, d!.id])
    expect(ws.closed.map((closed) => closed.defaultTitle)).toEqual(['Terminal 3', 'Terminal 5', 'Terminal 1'])
    expect(await sessionList()).toHaveLength(2)
  })

  test('SC-18: moving tabs reorders within a group and between groups, and the moved tab becomes active there', async () => {
    await newTab()
    await newTab()
    let ws = await newTab()
    const [a, b, c] = tabsOf(ws)
    ws = (await api('moveTab', { tab: c!.id, group: groupsOf(ws)[0]!.id, index: 0 })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([c!.id, a!.id, b!.id])
    expect(groupsOf(ws)[0]!.activeTab).toBe(c!.id)

    ws = (await api('moveTab', { tab: b!.id, split: 'right' })).workspace
    const [left, right] = groupsOf(ws)
    expect(left!.tabs.map((t) => t.id)).toEqual([c!.id, a!.id])
    expect(right!.tabs.map((t) => t.id)).toEqual([b!.id])
    expect(ws.activeGroup).toBe(right!.id)
    expect(ws.root).toMatchObject({ kind: 'split', direction: 'right', ratio: 0.5 })

    ws = (await api('moveTab', { tab: a!.id, group: right!.id, index: 0 })).workspace
    expect(groupsOf(ws).map((g) => g.tabs.map((t) => t.id))).toEqual([[c!.id], [a!.id, b!.id]])
    expect(groupsOf(ws)[1]!.activeTab).toBe(a!.id)

    ws = (await api('moveTab', { tab: c!.id, group: right!.id })).workspace
    expect(groupsOf(ws)).toHaveLength(1)
    expect(tabsOf(ws).map((t) => t.id)).toEqual([a!.id, b!.id, c!.id])
  })

  test('moveTab keeps pinned tabs first, refuses a lone tab split off its own group, and refuses mixed forms', async () => {
    const solo = await newTab()
    const lone = await error(api('moveTab', { tab: lastTab(solo).id, split: 'left' }))
    expect([lone?.code, lone?.message]).toEqual([RpcErrorCode.InvalidParams, "a group's only tab can't be split off its own group"])

    let ws = await newTab()
    const [a, b] = tabsOf(ws)
    ws = (await api('pinTab', { tab: b!.id, pinned: true })).workspace
    ws = (await api('moveTab', { tab: a!.id, group: groupsOf(ws)[0]!.id, index: 0 })).workspace
    expect(tabsOf(ws).map((t) => t.id)).toEqual([b!.id, a!.id])
    expect((await error(api('moveTab', { tab: a!.id })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await error(api('moveTab', { tab: a!.id, split: 'left', group: groupsOf(ws)[0]!.id })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await error(api('moveTab', { tab: a!.id, group: 'grp-99' })))?.message).toBe('no group grp-99')
  })

  test('SC-21: activateTab by id, by 1-based index, and by offset in position or recent order', async () => {
    for (let i = 0; i < 4; i++) await newTab()
    let ws = await layoutOf()
    const [t1, t2, t3, t4] = tabsOf(ws)
    for (const tab of [t3!, t1!, t4!]) ws = (await api('activateTab', { tab: tab.id })).workspace
    const active = () => groupsOf(ws)[0]!.activeTab

    ws = (await api('activateTab', { workspace: WT, index: 2 })).workspace
    expect(active()).toBe(t2!.id)
    expect((await error(api('activateTab', { workspace: WT, index: 9 })))?.code).toBe(RpcErrorCode.InvalidParams)
    ws = (await api('activateTab', { workspace: WT, offset: 1 })).workspace
    expect(active()).toBe(t3!.id)
    ws = (await api('activateTab', { workspace: WT, offset: -1 })).workspace
    expect(active()).toBe(t2!.id)
    ws = (await api('activateTab', { tab: t4!.id })).workspace
    ws = (await api('activateTab', { workspace: WT, offset: 1 })).workspace
    expect(active()).toBe(t1!.id)
    ws = (await api('activateTab', { tab: t1!.id })).workspace
    ws = (await api('activateTab', { workspace: WT, offset: 1, order: 'recent' })).workspace
    expect(active()).toBe(t4!.id)
    expect((await error(api('activateTab', { workspace: WT })))?.code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('closed tabs', () => {
  test('SC-17: reopening starts a fresh session with the title, colour and directory; ten are kept, newest first', async () => {
    const dir = tempDir()
    let ws = await newTab({ cwd: dir })
    const tab = lastTab(ws)
    await api('renameTab', { tab: tab.id, title: 'Build' })
    await api('setTabColor', { tab: tab.id, color: 'blue' })
    const oldSession = panesOf(tab)[0]!.session
    ws = (await api('closeTab', { tab: tab.id })).workspace
    expect(ws.closed).toHaveLength(1)
    expect(ws.closed[0]).toMatchObject({ title: 'Build', color: 'blue', cwd: dir, agent: 'shell', defaultTitle: 'Terminal 1' })

    sessionCreates().length = 0
    ws = (await api('reopenTab', { workspace: WT })).workspace
    expect(ws.closed).toEqual([])
    expect(lastTab(ws)).toMatchObject({ customTitle: 'Build', color: 'blue', defaultTitle: 'Terminal 1' })
    expect(panesOf(lastTab(ws))[0]!.session).not.toBe(oldSession)
    expect(sessionCreates()).toEqual([{ worktree: 'id:wt_main', agent: 'shell', cwd: dir }])
    expect(groupsOf(ws)[0]!.activeTab).toBe(lastTab(ws).id)
  })

  test('the directory a shell reported is the directory the tab reopens in', async () => {
    const dir = tempDir()
    const ws = await newTab()
    const tab = lastTab(ws)
    await fact(panesOf(tab)[0]!.session, { kind: 'cwd', cwd: dir }, 'cwd')
    const closed = (await api('closeTab', { tab: tab.id })).workspace
    expect(closed.closed[0]!.cwd).toBe(dir)
  })

  test('only ten closed tabs are kept, newest first', async () => {
    for (let i = 0; i < 12; i++) await newTab({ title: `T${i}` })
    for (const tab of tabsOf(await layoutOf())) await api('closeTab', { tab: tab.id })
    const ws = await layoutOf()
    expect(ws.closed.map((c) => c.defaultTitle)).toEqual(Array.from({ length: 10 }, (_, i) => `T${11 - i}`))
  })

  test('SC-72: nothing to reopen is not-found naming the worktree, also when the only closed tab came from a shell exit', async () => {
    const missing = await error(api('reopenTab', { workspace: WT }))
    expect([missing?.code, missing?.message]).toEqual([RpcErrorCode.NotFound, 'no closed tab to reopen in main'])

    const ws = await newTab()
    const session = panesOf(lastTab(ws))[0]!.session
    await call(client, 'quirky.terminal/write', { session, data: 'exit\r' })
    h.pty.exit(session, 0)
    await waitForAsync(async () => tabsOf(await layoutOf()).length === 0)
    const again = await error(api('reopenTab', { workspace: WT }))
    expect([again?.code, again?.message]).toEqual([RpcErrorCode.NotFound, 'no closed tab to reopen in main'])
  })

})

describe('panes', () => {
  async function tabWithPanes(count: number): Promise<{ ws: Workspace; tab: Tab }> {
    let ws = await newTab()
    for (let i = 1; i < count; i++) {
      ws = (await api('splitPane', { pane: lastTab(ws).activePane, direction: 'right' })).workspace
    }
    return { ws, tab: lastTab(ws) }
  }

  test('SC-23: a split starts a shell in the source pane\'s directory and the new pane takes half and focus', async () => {
    const dir = tempDir()
    let ws = await newTab()
    const source = panesOf(lastTab(ws))[0]!
    await fact(source.session, { kind: 'cwd', cwd: dir }, 'cwd')
    ws = (await api('splitPane', { pane: source.id, direction: 'right' })).workspace
    const tab = lastTab(ws)
    const [kept, added] = panesOf(tab)
    expect(kept!.id).toBe(source.id)
    expect(tab.root).toMatchObject({ kind: 'split', direction: 'right', ratio: 0.5 })
    expect(tab.activePane).toBe(added!.id)
    expect(sessionCreates().at(-1)).toMatchObject({ cwd: dir, agent: 'shell' })

    ws = (await api('splitPane', { session: added!.session, direction: 'down' })).workspace
    expect(lastTab(ws).root).toMatchObject({ kind: 'split', direction: 'right', second: { kind: 'split', direction: 'down', ratio: 0.5 } })
    expect(lastTab(ws).activePane).toBe(panesOf(lastTab(ws))[2]!.id)
  })

  test('a source directory that no longer exists falls back to the worktree root', async () => {
    const ws = await newTab()
    const source = panesOf(lastTab(ws))[0]!
    await fact(source.session, { kind: 'cwd', cwd: '/no/such/dir' }, 'cwd')
    const split = (await api('splitPane', { pane: source.id, direction: 'down' })).workspace
    const created = (await sessionList()).find((s) => s.id === panesOf(lastTab(split))[1]!.session)!
    expect(created.cwd).toBe('/fake/alpha')
  })

  test('SC-24: resizing by split, by pane share and by group share, with the divider rules', async () => {
    const { ws, tab } = await tabWithPanes(2)
    const split = tab.root as { id: string }
    let next = (await api('resizeSplit', { split: split.id, ratio: 0.3333 })).workspace
    expect(lastTab(next).root).toMatchObject({ ratio: 0.333 })
    next = (await api('resizeSplit', { pane: panesOf(tab)[1]!.id, share: 0.25 })).workspace
    expect(lastTab(next).root).toMatchObject({ ratio: 0.75 })
    for (const ratio of [0, 1, -0.2, 1.5]) {
      expect((await error(api('resizeSplit', { split: split.id, ratio })))?.code).toBe(RpcErrorCode.InvalidParams)
    }
    expect((await error(api('resizeSplit', {})))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await error(api('resizeSplit', { split: split.id })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect(ws.id).toBe(WT)
  })

  test('SC-47: group dividers clamp to 0.15 to 0.85', async () => {
    await newTab()
    let ws = await newTab()
    ws = (await api('moveTab', { tab: lastTab(ws).id, split: 'right' })).workspace
    const [left, right] = groupsOf(ws)
    const failed = await error(api('resizeSplit', { group: left!.id, share: 0.1 }))
    expect([failed?.code, failed?.message]).toEqual([RpcErrorCode.InvalidParams, 'a group divider stays between 0.15 and 0.85'])
    expect((await error(api('resizeSplit', { group: right!.id, share: 0.1 })))?.code).toBe(RpcErrorCode.InvalidParams)
    ws = (await api('resizeSplit', { group: left!.id, share: 0.85 })).workspace
    expect(ws.root).toMatchObject({ ratio: 0.85 })
    ws = (await api('resizeSplit', { split: (ws.root as { id: string }).id, ratio: 0.15 })).workspace
    expect(ws.root).toMatchObject({ ratio: 0.15 })
  })

  test('SC-25: equalize gives same-axis neighbours equal shares', async () => {
    const { tab } = await tabWithPanes(3)
    expect(tab.root).toMatchObject({ ratio: 0.5, second: { ratio: 0.5 } })
    const equalized = lastTab((await api('equalize', { tab: tab.id })).workspace)
    expect(equalized.root).toMatchObject({ ratio: 0.333, second: { ratio: 0.5 } })
  })

  test('SC-26: movePane to an edge of a pane, into another tab, and the refusals', async () => {
    let ws = await newTab()
    const { tab } = await tabWithPanes(2)
    ws = await layoutOf()
    const [p2, p3] = panesOf(lastTab(ws))
    ws = (await api('movePane', { pane: p3!.id, toPane: p2!.id, edge: 'top' })).workspace
    expect(lastTab(ws).root).toMatchObject({ kind: 'split', direction: 'down', first: { id: p3!.id }, second: { id: p2!.id } })
    expect(lastTab(ws).activePane).toBe(p3!.id)

    const target = tabsOf(ws)[0]!
    ws = (await api('movePane', { pane: p3!.id, toTab: target.id })).workspace
    expect(panesOf(tabNamed(ws, 'Terminal 1')).map((p) => p.id)).toEqual([panesOf(target)[0]!.id, p3!.id])
    expect(panesOf(tabsOf(ws)[1]!).map((p) => p.id)).toEqual([p2!.id])
    expect(groupsOf(ws)[0]!.activeTab).toBe(target.id)
    expect(tab.id).toBeDefined()

    expect((await error(api('movePane', { pane: p2!.id, toPane: p2!.id, edge: 'left' })))?.code).toBe(RpcErrorCode.InvalidParams)
    const alone = await error(api('movePane', { pane: p2!.id, toTab: target.id }))
    expect(alone?.message).toBe("the last pane of a tab can't be moved out")
    expect((await error(api('movePane', { pane: p2!.id })))?.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a pane can\'t be moved to a tab of another workspace', async () => {
    const ws = await newTab()
    const other = await createSession(client, { worktree: 'id:wt_other', agent: 'shell' })
    const otherWs = await waitForAsync(async () => {
      const current = await layoutOf('wt_other')
      return tabsOf(current).length ? current : null
    })
    const { tab } = await tabWithPanes(2)
    const moving = panesOf(tab)[1]!
    const failed = await error(api('movePane', { pane: moving.id, toTab: tabsOf(otherWs)[0]!.id }))
    expect(failed?.code).toBe(RpcErrorCode.InvalidParams)
    expect(other.id).toBeDefined()
    expect(ws.id).toBe(WT)
  })

  test('SC-27: expand fills the tab; focusing collapses it first; one pane can\'t be expanded', async () => {
    const lone = await newTab()
    expect((await error(api('expandPane', { pane: panesOf(lastTab(lone))[0]!.id, expanded: true })))?.code).toBe(RpcErrorCode.InvalidParams)

    const { tab } = await tabWithPanes(3)
    const [p1, p2, p3] = panesOf(tab)
    let ws = (await api('expandPane', { pane: p3!.id, expanded: true })).workspace
    expect(lastTab(ws)).toMatchObject({ expandedPane: p3!.id, activePane: p3!.id })
    ws = (await api('focusPane', { tab: tab.id, offset: 1 })).workspace
    expect(lastTab(ws)).toMatchObject({ expandedPane: null, activePane: p1!.id })
    ws = (await api('expandPane', { pane: p2!.id, expanded: true })).workspace
    ws = (await api('expandPane', { pane: p2!.id, expanded: false })).workspace
    expect(lastTab(ws)).toMatchObject({ expandedPane: null, activePane: p2!.id })
  })

  test('SC-28: focus next and previous wrap in tree order; focusing a pane activates its tab and group', async () => {
    const first = await newTab()
    const { tab } = await tabWithPanes(3)
    const [p1, p2, p3] = panesOf(tab)
    let ws = (await api('focusPane', { tab: tab.id, offset: 1 })).workspace
    expect(lastTab(ws).activePane).toBe(p1!.id)
    ws = (await api('focusPane', { tab: tab.id, offset: -1 })).workspace
    expect(lastTab(ws).activePane).toBe(p3!.id)
    ws = (await api('focusPane', { tab: tab.id, offset: -1 })).workspace
    expect(lastTab(ws).activePane).toBe(p2!.id)

    ws = (await api('activateTab', { tab: tabsOf(first)[0]!.id })).workspace
    ws = (await api('focusPane', { session: p3!.session })).workspace
    expect(groupsOf(ws)[0]!.activeTab).toBe(tab.id)
    expect(lastTab(ws).activePane).toBe(p3!.id)
    ws = (await api('focusPane', { offset: 1, workspace: WT })).workspace
    expect(lastTab(ws).activePane).toBe(p1!.id)
  })

  test('SC-29: closing a pane ends its session, promotes the sibling and activates the first pane; a lone pane closes the tab', async () => {
    const { tab } = await tabWithPanes(3)
    const [p1, p2, p3] = panesOf(tab)
    let ws = (await api('closePane', { pane: p3!.id })).workspace
    expect(lastTab(ws).root).toMatchObject({ kind: 'split', first: { id: p1!.id }, second: { id: p2!.id } })
    expect(lastTab(ws).activePane).toBe(p1!.id)
    expect((await sessionList()).map((s) => s.id)).not.toContain(p3!.session)

    ws = (await api('closePane', { session: p2!.session })).workspace
    expect(lastTab(ws).root).toMatchObject({ kind: 'pane', id: p1!.id })
    ws = (await api('closePane', { pane: p1!.id })).workspace
    expect(tabsOf(ws)).toEqual([])
    expect(ws.closed).toHaveLength(1)
  })

  test('SC-30: a pane title is set, cleared and bounded', async () => {
    const { tab } = await tabWithPanes(2)
    const pane = panesOf(tab)[1]!
    let ws = (await api('setPaneTitle', { pane: pane.id, title: 'logs' })).workspace
    expect(panesOf(lastTab(ws))[1]!.title).toBe('logs')
    ws = (await api('setPaneTitle', { pane: pane.id, title: '' })).workspace
    expect(panesOf(lastTab(ws))[1]!.title).toBeNull()
    expect((await error(api('setPaneTitle', { pane: pane.id, title: 'x'.repeat(201) })))?.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('paneOf names the workspace, tab and pane showing a session', async () => {
    const { tab } = await tabWithPanes(2)
    const pane = panesOf(tab)[1]!
    expect(await api('paneOf', { session: pane.session })).toEqual({ workspace: WT, tab: tab.id, pane: pane.id })
  })

  test('SC-34: clearPane and resetPane reach the PTY host for the pane\'s session', async () => {
    const { tab } = await tabWithPanes(2)
    const pane = panesOf(tab)[1]!
    expect(await api('clearPane', { pane: pane.id })).toEqual({ ok: true })
    expect(await api('resetPane', { session: pane.session })).toEqual({ ok: true })
    const sent = h.pty.requests.filter((r) => r.type === 'clear' || r.type === 'resetModes')
    expect(sent.map((r) => [r.type, (r as { sessionId: string }).sessionId])).toEqual([
      ['clear', pane.session],
      ['resetModes', pane.session]
    ])
  })
})

describe('SC-32, SC-33, SC-71: when a shell ends', () => {
  async function splitTab(): Promise<{ lone: PaneLeaf; extra: PaneLeaf; tab: Tab }> {
    let ws = await newTab()
    const lone = panesOf(lastTab(ws))[0]!
    ws = (await api('splitPane', { pane: lone.id, direction: 'right' })).workspace
    return { lone, extra: panesOf(lastTab(ws))[1]!, tab: lastTab(ws) }
  }
  const typeExit = (session: string) => call(client, 'quirky.terminal/write', { session, data: 'exit\r' })

  test('SC-32a: exit 0 in a split closes the pane and its session; the last pane closing closes the tab', async () => {
    const { lone, extra } = await splitTab()
    await typeExit(extra.session)
    h.pty.exit(extra.session, 0)
    await waitForAsync(async () => panesOf(lastTab(await layoutOf())).length === 1)
    expect((await sessionList()).map((s) => s.id)).not.toContain(extra.session)

    await typeExit(lone.session)
    h.pty.exit(lone.session, 0)
    const ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return tabsOf(current).length === 0 ? current : null
    })
    expect(ws.closed).toEqual([])
    expect(await sessionList()).toEqual([])
  })

  test('SC-32b: a lone pane nobody typed into stays, with its exit recorded', async () => {
    const ws = await newTab()
    const pane = panesOf(lastTab(ws))[0]!
    h.pty.exit(pane.session, 0)
    const after = await waitForAsync(async () => {
      const current = await layoutOf()
      return panesOf(lastTab(current))[0]!.exit ? current : null
    })
    expect(panesOf(lastTab(after))[0]!.exit).toEqual({ code: 0, signal: null })
    expect((await sessionList()).map((s) => s.id)).toEqual([pane.session])
  })

  test('SC-33, SC-71: a non-zero exit keeps the pane with its code, in a lone pane and in a split', async () => {
    const { lone, extra } = await splitTab()
    await typeExit(extra.session)
    h.pty.exit(extra.session, 3)
    h.pty.exit(lone.session, 3)
    const ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return panesOf(lastTab(current)).every((p) => p.exit) ? current : null
    })
    expect(panesOf(lastTab(ws)).map((p) => p.exit)).toEqual([{ code: 3, signal: null }, { code: 3, signal: null }])

    const solo = await newTab()
    const only = panesOf(lastTab(solo))[0]!
    h.pty.exit(only.session, 3)
    const kept = await waitForAsync(async () => {
      const current = await layoutOf()
      return panesOf(lastTab(current))[0]!.exit ? current : null
    })
    expect(panesOf(lastTab(kept))[0]!.exit).toEqual({ code: 3, signal: null })
  })

  test('a signal exit records the signal; a session lost with the host changes nothing', async () => {
    const { lone, extra } = await splitTab()
    h.pty.exit(extra.session, null, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    h.pty.exit(lone.session, null, { exitCause: 'host-restart' })
    const ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return panesOf(lastTab(current))[1]!.exit ? current : null
    })
    expect(panesOf(lastTab(ws)).map((p) => p.exit)).toEqual([null, { code: null, signal: 'SIGKILL' }])
  })

  test('SC-33: restartPane replaces an ended session in the same pane and directory; a running pane conflicts', async () => {
    const dir = tempDir()
    const { lone, extra, tab } = await splitTab()
    const running = await error(api('restartPane', { pane: extra.id }))
    expect([running?.code, running?.message]).toEqual([RpcErrorCode.Conflict, `pane ${extra.id} is still running`])

    await fact(extra.session, { kind: 'cwd', cwd: dir }, 'cwd')
    h.pty.exit(extra.session, 3)
    await waitForAsync(async () => panesOf(lastTab(await layoutOf()))[1]!.exit)
    const ws = (await api('restartPane', { pane: extra.id })).workspace
    const restarted = panesOf(lastTab(ws))[1]!
    expect(restarted).toMatchObject({ id: extra.id, exit: null })
    expect(restarted.session).not.toBe(extra.session)
    expect(panesOf(lastTab(ws))[0]!.session).toBe(lone.session)
    expect(sessionCreates().at(-1)).toMatchObject({ cwd: dir, agent: 'shell' })
    expect((await sessionList()).map((s) => s.id)).not.toContain(extra.session)
    expect(lastTab(ws).id).toBe(tab.id)
  })

  test('a pane whose session was restored by the host stops showing the exit', async () => {
    const ws = await newTab()
    const pane = panesOf(lastTab(ws))[0]!
    h.pty.exit(pane.session, 3)
    await waitForAsync(async () => panesOf(lastTab(await layoutOf()))[0]!.exit)
    h.pty.exit(pane.session, null, { exitCause: 'host-restart' })
    await Bun.sleep(30)
    expect(panesOf(lastTab(await layoutOf()))[0]!.exit).toEqual({ code: 3, signal: null })
  })
})

describe('groups', () => {
  test('SC-45: a tab moved to a split opens a group; closeGroup keeps its tabs; the last group stays', async () => {
    await newTab()
    await newTab()
    let ws = await newTab()
    const [a, b, c] = tabsOf(ws)
    ws = (await api('moveTab', { tab: b!.id, split: 'right' })).workspace
    ws = (await api('moveTab', { tab: c!.id, group: groupsOf(ws)[1]!.id })).workspace
    const [g1, g2] = groupsOf(ws)
    expect([g1!.tabs.map((t) => t.id), g2!.tabs.map((t) => t.id)]).toEqual([[a!.id], [b!.id, c!.id]])

    ws = (await api('closeGroup', { group: g2!.id })).workspace
    expect(groupsOf(ws)).toHaveLength(1)
    expect(tabsOf(ws).map((t) => t.id)).toEqual([a!.id, b!.id, c!.id])
    expect(groupsOf(ws)[0]!.activeTab).toBe(c!.id)
    expect(ws.activeGroup).toBe(g1!.id)
    expect(await sessionList()).toHaveLength(3)

    const only = await error(api('closeGroup', { group: g1!.id }))
    expect(only?.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('SC-48: closing a group\'s last tab removes the group; the tabs go to the first group of a split sibling', async () => {
    await newTab()
    await newTab()
    let ws = await newTab()
    const [a, b, c] = tabsOf(ws)
    ws = (await api('moveTab', { tab: b!.id, split: 'right' })).workspace
    ws = (await api('moveTab', { tab: c!.id, split: 'down', of: groupsOf(ws)[1]!.id })).workspace
    expect(groupsOf(ws).map((g) => g.tabs.map((t) => t.id))).toEqual([[a!.id], [b!.id], [c!.id]])
    const [g1, g2, g3] = groupsOf(ws)

    const closed = (await api('closeGroup', { group: g1!.id })).workspace
    expect(groupsOf(closed).map((g) => g.id)).toEqual([g2!.id, g3!.id])
    expect(groupsOf(closed)[0]!.tabs.map((t) => t.id)).toEqual([b!.id, a!.id])

    ws = (await api('closeTab', { tab: b!.id })).workspace
    ws = (await api('closeTab', { tab: a!.id })).workspace
    expect(groupsOf(ws).map((g) => g.id)).toEqual([g3!.id])
    expect(ws.activeGroup).toBe(g3!.id)
  })
})

describe('the serial queue', () => {
  test('concurrent newTab calls and external creates bind every session exactly once', async () => {
    await api('workspace', { workspace: WT, ensure: true })
    await Promise.all([
      newTab(),
      createSession(client, { worktree: 'id:wt_main', agent: 'shell' }),
      newTab(),
      newTab(),
      createSession(client, { worktree: 'id:wt_main', agent: 'shell' }),
      newTab()
    ])
    const ws = await waitForAsync(async () => {
      const current = await layoutOf()
      return tabsOf(current).length === 7 ? current : null
    })
    const bound = tabsOf(ws).flatMap((tab) => panesOf(tab).map((pane) => pane.session))
    expect(new Set(bound).size).toBe(7)
    expect(bound.sort()).toEqual((await sessionList()).map((s) => s.id).sort())
    await Bun.sleep(50)
    expect(tabsOf(await layoutOf())).toHaveLength(7)
  })

  test('a revision check and its change can\'t interleave: of two calls with the same revision one conflicts', async () => {
    const ws = await newTab()
    const tab = lastTab(ws)
    const results = await Promise.all([
      error(api('renameTab', { tab: tab.id, title: 'one', revision: ws.revision })),
      error(api('renameTab', { tab: tab.id, title: 'two', revision: ws.revision }))
    ])
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.find((r) => r)?.code).toBe(RpcErrorCode.Conflict)
  })

  test('layout events carry the workspace and its new revision', async () => {
    const ws = await newTab()
    await waitFor(() => events.some((e) => e.type === 'quirky.terminal/layout' && ((e as PluginEvent).data as { revision: number }).revision === ws.revision))
    const event = events.find((e) => e.type === 'quirky.terminal/layout') as PluginEvent
    expect(event.data).toMatchObject({ workspace: WT })
  })
})

describe('describeClose and conditional confirmation', () => {
  let asking: Harness
  let asker: QuirkyClient
  const children: ReturnType<typeof Bun.spawn>[] = []
  beforeEach(async () => {
    const set: PluginSet = { ...TERMINAL_PLUGINS, real: [...TERMINAL_PLUGINS.real, 'quirky.ask'] }
    asking = await startPluginHarness(set)
    asker = await asking.connect('cli')
  })
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill()
    await asking.cleanup()
  })

  /** Makes the PTY host report a shell whose process has a running child, as a shell running `sleep` has. */
  async function runCommandIn(sessionId: string): Promise<void> {
    const shell = Bun.spawn(['sh', '-c', 'sleep 30 & wait'], { stdout: 'ignore', stderr: 'ignore' })
    children.push(shell)
    asking.pty.sessions.get(sessionId)!.info.pid = shell.pid
    await waitFor(() => Bun.spawnSync(['pgrep', '-P', String(shell.pid)]).stdout.toString().trim() !== '')
  }
  const ask = (method: string, params: Record<string, unknown>) => call<any>(asker, `quirky.terminal/${method}`, params)

  test('an idle tab closes with no question and describeClose says null', async () => {
    const ws = (await ask('newTab', { workspace: WT })).workspace as Workspace
    const tab = lastTab(ws)
    expect(await ask('describeClose', { tab: tab.id })).toBeNull()
    const closed = (await ask('closeTab', { tab: tab.id })).workspace as Workspace
    expect(tabsOf(closed)).toEqual([])
  })

  test('SC-14: a tab running a command asks first, naming the command and tab; yes closes it', async () => {
    const ws = (await ask('newTab', { workspace: WT })).workspace as Workspace
    const tab = lastTab(ws)
    await runCommandIn(panesOf(tab)[0]!.session)
    expect(await ask('describeClose', { tab: tab.id })).toBe('Stop sleep in Terminal 1?')

    const asked = await error(ask('closeTab', { tab: tab.id }))
    expect(asked?.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(((asked as unknown as { data: { action: string } }).data).action).toBe('Stop sleep in Terminal 1?')
    expect(tabsOf((await ask('workspace', { workspace: WT })).workspace)).toHaveLength(1)

    const closed = (await ask('closeTab', { tab: tab.id, yes: true })).workspace as Workspace
    expect(tabsOf(closed)).toEqual([])
  })

  test('closePane and closeTabs ask the same way, naming each running target', async () => {
    let ws = (await ask('newTab', { workspace: WT })).workspace as Workspace
    ws = (await ask('newTab', { workspace: WT })).workspace as Workspace
    const [a, b] = tabsOf(ws)
    await runCommandIn(panesOf(a!)[0]!.session)
    await runCommandIn(panesOf(b!)[0]!.session)
    expect(await ask('describeClose', { tab: a!.id, which: 'others' })).toBe('Stop sleep in Terminal 2?')
    expect((await error(ask('closeTabs', { tab: a!.id, which: 'others' })))?.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect((await error(ask('closePane', { pane: panesOf(b!)[0]!.id })))?.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(await ask('describeClose', { pane: panesOf(b!)[0]!.id })).toBe('Stop sleep in Terminal 2?')
    expect(await ask('describeClose', { session: panesOf(a!)[0]!.session })).toBe('Stop sleep in Terminal 1?')
    expect((await error(ask('describeClose', {})))?.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('SC-13: a live agent asks "Stop agent <title>?" and an exited shell does not ask', async () => {
    let ws = (await ask('newTab', { workspace: WT, agent: 'claude' })).workspace as Workspace
    const agentTab = lastTab(ws)
    expect(await ask('describeClose', { tab: agentTab.id })).toBe('Stop agent Claude?')
    ws = (await ask('newTab', { workspace: WT })).workspace as Workspace
    const shell = lastTab(ws)
    asking.pty.exit(panesOf(shell)[0]!.session, 3)
    await waitForAsync(async () => (await ask('describeClose', { tab: shell.id })) === null)
    expect(await ask('describeClose', { tab: shell.id })).toBeNull()
  })
})

describe('SC-55 to SC-57: the floating workspace', () => {
  let home: string
  const savedHome = process.env.HOME
  beforeEach(() => {
    home = tempDir()
    mkdirSync(join(home, 'sub'))
    process.env.HOME = home
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  })

  test('SC-56: the state starts closed with default placement and each field is stored', async () => {
    const start = (await api('floating')) as FloatingState
    expect(start).toEqual({ enabled: true, open: false, maximized: false, bounds: null, button: null })

    const opened = (await api('setFloating', { open: true })) as FloatingState
    expect(opened).toMatchObject({ open: true, maximized: false })
    const bounds = { x: 10, y: 20, width: 500, height: 300 }
    expect(await api('setFloating', { maximized: true, bounds, button: { x: 5, y: 6 } })).toEqual({
      enabled: true,
      open: true,
      maximized: true,
      bounds,
      button: { x: 5, y: 6 }
    })
    expect(await api('floating')).toMatchObject({ bounds, button: { x: 5, y: 6 } })
    expect(await api('setFloating', { bounds: null, button: null })).toMatchObject({ bounds: null, button: null })
    await waitFor(() => events.filter((e) => e.type === 'quirky.terminal/floating').length === 3)
    expect(((events.find((e) => e.type === 'quirky.terminal/floating') as PluginEvent).data as { state: FloatingState }).state.open).toBe(true)
  })

  test('SC-56: bounds under 420x280 or malformed are invalid-params and change nothing', async () => {
    await api('setFloating', { open: true })
    for (const bounds of [{ x: 0, y: 0, width: 419, height: 300 }, { x: 0, y: 0, width: 500, height: 279 }, { x: 0, y: 0 }, 'wide']) {
      expect((await error(api('setFloating', { bounds: bounds as never })))?.code).toBe(RpcErrorCode.InvalidParams)
    }
    expect((await error(api('setFloating', { button: { x: 1 } })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect(await api('floating')).toMatchObject({ open: true, bounds: null })
    expect((await api('setFloating', { bounds: { x: 0, y: 0, width: 420, height: 280 } })).bounds).toEqual({ x: 0, y: 0, width: 420, height: 280 })
  })

  test('enabled follows the floating-enabled setting', async () => {
    await call(client, 'setting.set', { id: 'setting:quirky.terminal/floating-enabled', value: false })
    expect((await api('floating')).enabled).toBe(false)
  })

  test('SC-55: a floating tab starts in the Terminal Directory with ~ expanded from HOME', async () => {
    let ws = (await api('newTab', { workspace: 'floating' })).workspace as Workspace
    expect(ws.id).toBe('floating')
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'floating', agent: 'shell', cwd: home })
    expect(lastTab(ws).defaultTitle).toBe('Terminal 1')

    await call(client, 'setting.set', { id: 'setting:quirky.terminal/floating-cwd', value: '~/sub' })
    ws = (await api('newTab', { workspace: 'floating' })).workspace as Workspace
    expect(sessionCreates().at(-1)).toMatchObject({ cwd: join(home, 'sub') })

    await call(client, 'setting.set', { id: 'setting:quirky.terminal/floating-cwd', value: '/no/such/dir' })
    await api('newTab', { workspace: 'floating' })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'floating', agent: 'shell' })
    expect((await api('workspace', { workspace: 'floating' })).workspace.revision).toBe(3)
  })

  test('SC-57: the floating state and its tabs survive a daemon restart', async () => {
    await api('newTab', { workspace: 'floating' })
    await api('setFloating', { open: true, maximized: true })
    const before = await layoutOf('floating')
    const restarted = await restartDaemon(h)
    try {
      expect(await api('floating', {}, restarted.client)).toMatchObject({ open: true, maximized: true })
      expect(await layoutOf('floating', restarted.client)).toEqual(before)
    } finally {
      await restarted.stop()
    }
  })
})

describe('the PTY host connection', () => {
  test('the layout keeps working after the connection to the PTY host drops and returns', async () => {
    const before = await newTab()
    h.pty.dropConnections()
    const after = await waitForAsync(async () => (await api('newTab', { workspace: WT }).then((r) => r.workspace as Workspace, () => null)), 8000)
    expect(tabsOf(after).map((tab) => tab.defaultTitle)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(after.revision).toBe(before.revision + 1)
    expect(tabsOf(after)[0]).toEqual(tabsOf(before)[0]!)
  })
})

describe('links and paths', () => {
  const log = () => join(tempDir(), 'open.log')

  test('openExternal accepts http, https, mailto and absolute paths, and refuses the rest', async () => {
    const file = log()
    process.env.QUIRKY_TEST_OPEN_LOG = file
    try {
      expect(await api('openExternal', { target: 'https://example.com/a?b=1' })).toEqual({ ok: true })
      expect(await api('openExternal', { target: '/tmp/w/api/a b.txt', reveal: true })).toEqual({ ok: true })
      expect(await api('openExternal', { target: 'mailto:a@b.co' })).toEqual({ ok: true })
      for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'relative/path', '']) {
        expect((await error(api('openExternal', { target })))?.code).toBe(RpcErrorCode.InvalidParams)
      }
      expect(
        readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      ).toEqual([
        { target: 'https://example.com/a?b=1', reveal: false },
        { target: '/tmp/w/api/a b.txt', reveal: true },
        { target: 'mailto:a@b.co', reveal: false }
      ])
    } finally {
      delete process.env.QUIRKY_TEST_OPEN_LOG
    }
  })

  test('pathsExist answers per path, false for relative paths, and at most 50 paths', async () => {
    const dir = tempDir()
    expect(await api('pathsExist', { paths: [dir, join(dir, 'nope'), 'relative', ''] })).toEqual({ exists: [true, false, false, false] })
    expect(await api('pathsExist', { paths: [] })).toEqual({ exists: [] })
    expect((await error(api('pathsExist', { paths: Array.from({ length: 51 }, () => dir) })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await api('pathsExist', { paths: Array.from({ length: 50 }, () => dir) })).exists).toHaveLength(50)
  })
})

describe('persistence', () => {
  test('SC-65: groups, titles, colours, pins, ratios, expanded panes, closed tabs and ids survive a daemon restart', async () => {
    await newTab()
    await newTab()
    let ws = await newTab({ title: 'Doomed' })
    const [a, b] = tabsOf(ws)
    ws = (await api('splitPane', { pane: panesOf(a!)[0]!.id, direction: 'right' })).workspace
    ws = (await api('splitPane', { pane: panesOf(tabsOf(ws)[0]!)[1]!.id, direction: 'down' })).workspace
    const wide = tabsOf(ws)[0]!
    ws = (await api('setPaneTitle', { pane: panesOf(wide)[0]!.id, title: 'logs' })).workspace
    ws = (await api('expandPane', { pane: panesOf(wide)[0]!.id, expanded: true })).workspace
    ws = (await api('renameTab', { tab: b!.id, title: 'Mine' })).workspace
    ws = (await api('setTabColor', { tab: b!.id, color: 'blue' })).workspace
    ws = (await api('pinTab', { tab: b!.id, pinned: true })).workspace
    ws = (await api('moveTab', { tab: a!.id, split: 'right' })).workspace
    ws = (await api('resizeSplit', { group: groupsOf(ws)[0]!.id, share: 0.3 })).workspace
    ws = (await api('closeTab', { tab: tabNamed(ws, 'Doomed').id })).workspace
    expect(ws.closed).toHaveLength(1)

    const restarted = await restartDaemon(h)
    try {
      expect((await api('workspace', { workspace: WT }, restarted.client)).workspace).toEqual(ws)
      const next = (await api('newTab', { workspace: WT }, restarted.client)).workspace as Workspace
      const numbers = (id: string) => Number(id.split('-')[1])
      const older = tabsOf(ws).flatMap((tab) => [numbers(tab.id), ...panesOf(tab).map((pane) => numbers(pane.id))])
      expect(numbers(lastTab(next).id)).toBeGreaterThan(Math.max(...older))
    } finally {
      await restarted.stop()
    }
  })

  test('SC-74: a split is saved before the call returns, so a daemon stopped right after it still has both panes bound', async () => {
    const ws = await newTab()
    const source = panesOf(lastTab(ws))[0]!
    const split = (await api('splitPane', { pane: source.id, direction: 'right' })).workspace as Workspace
    const restarted = await restartDaemon(h)
    try {
      const after = (await api('workspace', { workspace: WT }, restarted.client)).workspace as Workspace
      expect(after).toEqual(split)
      const bound = tabsOf(after).flatMap((tab) => panesOf(tab).map((pane) => pane.session))
      expect(bound.sort()).toEqual((await call<Session[]>(restarted.client, 'quirky.session/list', {})).map((s) => s.id).sort())
    } finally {
      await restarted.stop()
    }
  })

  test('SC-66: an unreadable stored layout is rebuilt from the sessions with a log line, one tab per session', async () => {
    const first = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const second = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    await waitForAsync(async () => tabsOf(await layoutOf()).length === 2)
    const revision = (await layoutOf()).revision
    await h.daemon.stop()
    const db = new Database(join(h.home, 'plugin-data', 'quirky.terminal', 'store.db'))
    db.query("UPDATE workspaces SET data = '{not json' WHERE id = ?").run(WT)
    db.close()

    const logs: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logs.push(args.join(' '))
    const restarted = await restartDaemon(h)
    try {
      const rebuilt = (await api('workspace', { workspace: 'main' }, restarted.client)).workspace as Workspace
      expect(tabsOf(rebuilt).map((tab) => panesOf(tab)[0]!.session).sort()).toEqual([first.id, second.id].sort())
      expect(titles(rebuilt)).toEqual(['Terminal 1', 'Terminal 2'])
      expect(rebuilt.revision).toBe(revision + 1)
      expect(logs.some((line) => line.includes('quirky.terminal') && line.includes(WT) && line.includes('rebuilt'))).toBe(true)
    } finally {
      console.error = original
      await restarted.stop()
    }
  })

  test('a stored layout with a dangling session is repaired on start: the pane goes, the other stays', async () => {
    let ws = await newTab()
    ws = (await api('splitPane', { pane: lastTab(ws).activePane, direction: 'right' })).workspace
    const [keep, lose] = panesOf(lastTab(ws))
    await h.daemon.stop()
    const file = join(h.home, 'plugin-data', 'quirky.session', 'sessions.json')
    const sessions = JSON.parse(readFileSync(file, 'utf8')) as Session[]
    await Bun.write(file, JSON.stringify(sessions.filter((s) => s.id !== lose!.session)))

    const restarted = await restartDaemon(h)
    try {
      const after = (await api('workspace', { workspace: WT }, restarted.client)).workspace as Workspace
      expect(panesOf(lastTab(after)).map((p) => p.id)).toEqual([keep!.id])
      expect(lastTab(after).activePane).toBe(keep!.id)
    } finally {
      await restarted.stop()
    }
  })

})
