import { describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { InputTracker } from '../src/input-tracker'
import { LayoutService } from '../src/layout/service'
import { emptyWorkspace, makeTab, appendTab, normalize, workspaceTabs } from '../src/layout/ops'
import { reconcileWorkspace } from '../src/layout/reconcile'
import { CounterIds, parseWorkspace } from '../src/layout/store'
import { groupsInOrder, paneLeaves, splitPane } from '../src/layout/tree'
import type { Workspace } from '../src/layout/types'

const NOW = '2026-10-27T00:00:00.000Z'

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    kind: 'terminal',
    agent: 'shell',
    worktreeId: 'wt',
    cwd: '/w',
    title: 'Shell',
    status: 'running',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    ...overrides
  }
}

const ended = (id: string, exitCode: number | null, extra: Partial<Session> = {}) =>
  session(id, { status: 'exited', exitCode, exitCause: 'exited', ...extra })

type Run = { sessions: Session[]; boundElsewhere?: string[]; input?: string[]; ids?: CounterIds }

function reconcile(ws: Workspace, run: Run) {
  return reconcileWorkspace({
    workspace: ws,
    sessions: run.sessions,
    boundElsewhere: new Set(run.boundElsewhere ?? []),
    hasInput: (id) => (run.input ?? []).includes(id),
    ids: run.ids ?? new CounterIds(100),
    now: NOW
  })
}

/** A workspace of one group holding one tab per session. */
function withTabs(...sessionIds: string[]): Workspace {
  return withTabsFrom(0, ...sessionIds)
}

function withTabsFrom(start: number, ...sessionIds: string[]): Workspace {
  const ids = new CounterIds(start)
  let ws = emptyWorkspace('wt', ids)
  for (const [index, id] of sessionIds.entries()) {
    const added = appendTab(ws, ws.activeGroup, makeTab(ids, { defaultTitle: `Terminal ${index + 1}`, session: id, now: NOW }))
    if (!added.ok) throw new Error(added.error.message)
    ws = added.value
  }
  return ws
}

const sessionsOf = (ws: Workspace) => workspaceTabs(ws).flatMap((tab) => paneLeaves(tab.root).map((leaf) => leaf.session))

describe('adopting sessions', () => {
  test('a session no pane holds gets a tab at the end of the active group, oldest first, and the last one is active', () => {
    const ws = withTabs('a')
    const result = reconcile(ws, {
      sessions: [session('a'), session('c', { createdAt: 3 }), session('b', { createdAt: 2 })]
    })
    expect(sessionsOf(result.workspace)).toEqual(['a', 'b', 'c'])
    expect(workspaceTabs(result.workspace).map((tab) => tab.defaultTitle)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
    const [group] = groupsInOrder(result.workspace.root)
    expect(group!.activeTab).toBe(workspaceTabs(result.workspace).at(-1)!.id)
  })

  test('shell tabs take the lowest free number, other agents and structured sessions their session title', () => {
    const result = reconcile(emptyWorkspace('wt', new CounterIds(0)), {
      sessions: [
        session('s1', { createdAt: 1 }),
        session('s2', { createdAt: 2, agent: 'claude', title: 'Claude' }),
        session('s3', { createdAt: 3, kind: 'structured', agent: 'claude', title: 'Claude 2' }),
        session('s4', { createdAt: 4 })
      ]
    })
    expect(workspaceTabs(result.workspace).map((tab) => tab.defaultTitle)).toEqual(['Terminal 1', 'Claude', 'Claude 2', 'Terminal 2'])
  })

  test('a shell session created with its own title keeps it, and the session plugin\'s own Shell titles take the number', () => {
    const result = reconcile(emptyWorkspace('wt', new CounterIds(0)), {
      sessions: [
        session('s1', { createdAt: 1, title: 'Setup' }),
        session('s2', { createdAt: 2, title: 'Shell' }),
        session('s3', { createdAt: 3, title: 'Shell 2' }),
        session('s4', { createdAt: 4, title: 'Shell 10' }),
        session('s5', { createdAt: 5, title: 'Shellfish' })
      ]
    })
    expect(workspaceTabs(result.workspace).map((tab) => tab.defaultTitle)).toEqual(['Setup', 'Terminal 1', 'Terminal 2', 'Terminal 3', 'Shellfish'])
  })

  test('sessions of another worktree, and ones another workspace\'s pane holds, are left alone', () => {
    const result = reconcile(emptyWorkspace('wt', new CounterIds(0)), {
      sessions: [session('other', { worktreeId: 'elsewhere' }), session('held'), session('free', { createdAt: 2 })],
      boundElsewhere: ['held']
    })
    expect(sessionsOf(result.workspace)).toEqual(['free'])
  })

  test('a second pass over its own result changes nothing', () => {
    const sessions = [session('a'), session('b', { createdAt: 2 }), ended('c', 3, { createdAt: 3 })]
    const first = reconcile(emptyWorkspace('wt', new CounterIds(0)), { sessions })
    const second = reconcile(first.workspace, { sessions })
    expect(second.workspace).toEqual(first.workspace)
    expect(second.notes).toEqual([])
    expect(second.closeSessions).toEqual([])
  })
})

describe('sessions that went away', () => {
  function split(): Workspace {
    const ids = new CounterIds(50)
    const ws = withTabs('a')
    const tab = workspaceTabs(ws)[0]!
    const root = splitPane(tab.root, tab.activePane, 'right', { kind: 'pane', id: 'pane-x', session: 'b', title: null, exit: null }, ids)
    if (!root.ok) throw new Error('split failed')
    const withSplit = { ...ws, root: { ...(ws.root as never as { kind: 'group' }), tabs: [{ ...tab, root: root.value, activePane: 'pane-x' }] } }
    return withSplit as Workspace
  }

  test('a pane whose session is gone is removed, its sibling takes over and the first pane becomes active', () => {
    const result = reconcile(split(), { sessions: [session('a')] })
    const [tab] = workspaceTabs(result.workspace)
    expect(tab!.root).toMatchObject({ kind: 'pane', session: 'a' })
    expect(tab!.activePane).toBe(tab!.root.id)
  })

  test('an emptied tab goes without being remembered, and an emptied group other than the last goes too', () => {
    const left = withTabs('a')
    const right = withTabsFrom(100, 'b')
    const two: Workspace = {
      ...left,
      root: { kind: 'split', id: 'split-900', direction: 'right', ratio: 0.5, first: left.root, second: right.root }
    }
    const result = reconcile(two, { sessions: [session('b')] })
    expect(sessionsOf(result.workspace)).toEqual(['b'])
    expect(groupsInOrder(result.workspace.root)).toHaveLength(1)
    expect(result.workspace.activeGroup).toBe(groupsInOrder(result.workspace.root)[0]!.id)
    expect(result.workspace.closed).toEqual([])

    const none = reconcile(withTabs('a', 'b'), { sessions: [] })
    expect(workspaceTabs(none.workspace)).toEqual([])
    expect(groupsInOrder(none.workspace.root)).toHaveLength(1)
  })
})

describe('when a shell ends', () => {
  test('exit 0 in a lone pane that never got input keeps the pane, with the exit recorded', () => {
    const result = reconcile(withTabs('a'), { sessions: [ended('a', 0)] })
    expect(paneLeaves(workspaceTabs(result.workspace)[0]!.root)[0]!.exit).toEqual({ code: 0, signal: null })
    expect(result.closeSessions).toEqual([])
  })

  test('exit 0 after input closes the lone pane and its tab and names the session to close', () => {
    const result = reconcile(withTabs('a', 'b'), { sessions: [ended('a', 0), session('b')], input: ['a'] })
    expect(sessionsOf(result.workspace)).toEqual(['b'])
    expect(result.closeSessions).toEqual(['a'])
    expect(result.workspace.closed).toEqual([])
  })

  test('exit 0 in a split closes just that pane even without input', () => {
    const ids = new CounterIds(50)
    const base = withTabs('a')
    const tab = workspaceTabs(base)[0]!
    const root = splitPane(tab.root, tab.activePane, 'right', { kind: 'pane', id: 'pane-x', session: 'b', title: null, exit: null }, ids)
    if (!root.ok) throw new Error('split failed')
    const ws = { ...base, root: { ...(base.root as never as object), tabs: [{ ...tab, root: root.value }] } } as Workspace
    const result = reconcile(ws, { sessions: [session('a'), ended('b', 0)] })
    expect(sessionsOf(result.workspace)).toEqual(['a'])
    expect(result.closeSessions).toEqual(['b'])
  })

  test('a non-zero exit, a signal and a missing code keep the pane with what is known', () => {
    for (const [exit, expected] of [
      [ended('a', 3), { code: 3, signal: null }],
      [session('a', { status: 'exited', exitCode: null, exitSignal: 'SIGKILL', exitCause: 'killed' }), { code: null, signal: 'SIGKILL' }],
      [session('a', { status: 'exited', exitCode: 0, exitCause: 'killed' }), { code: 0, signal: null }]
    ] as const) {
      const result = reconcile(withTabs('a'), { sessions: [exit], input: ['a'] })
      expect(paneLeaves(workspaceTabs(result.workspace)[0]!.root)[0]!.exit).toEqual(expected)
      expect(result.closeSessions).toEqual([])
    }
  })

  test('a session lost with the host changes nothing, and a running session clears a stale exit', () => {
    for (const exitCause of ['host-restart', 'host-lost'] as const) {
      const result = reconcile(withTabs('a'), { sessions: [session('a', { status: 'exited', exitCode: 0, exitCause, restorable: true })], input: ['a'] })
      expect(sessionsOf(result.workspace)).toEqual(['a'])
      expect(paneLeaves(workspaceTabs(result.workspace)[0]!.root)[0]!.exit).toBeNull()
    }
    const kept = reconcile(withTabs('a'), { sessions: [ended('a', 3)] })
    const restored = reconcile(kept.workspace, { sessions: [session('a')] })
    expect(paneLeaves(workspaceTabs(restored.workspace)[0]!.root)[0]!.exit).toBeNull()
  })

  test('structured sessions are never closed for ending', () => {
    const result = reconcile(withTabs('a'), { sessions: [ended('a', 0, { kind: 'structured', agent: 'claude' })], input: ['a'] })
    expect(sessionsOf(result.workspace)).toEqual(['a'])
    expect(result.closeSessions).toEqual([])
  })
})

describe('repairing a loaded workspace', () => {
  test('missing active ids fall back to the first tab, the first pane and the first group', () => {
    const ws = withTabs('a', 'b')
    const [group] = groupsInOrder(ws.root)
    const broken = {
      ...ws,
      activeGroup: 'grp-gone',
      root: { ...group!, activeTab: 'tab-gone', recent: ['tab-gone', group!.tabs[1]!.id], tabs: group!.tabs.map((tab) => ({ ...tab, activePane: 'pane-gone', expandedPane: 'pane-gone' })) }
    } as Workspace
    const fixed = normalize(broken)
    const [repaired] = groupsInOrder(fixed.root)
    expect(fixed.activeGroup).toBe(repaired!.id)
    expect(repaired!.activeTab).toBe(group!.tabs[1]!.id)
    expect(repaired!.recent).toEqual([group!.tabs[1]!.id])
    for (const tab of repaired!.tabs) expect([tab.activePane, tab.expandedPane]).toEqual([paneLeaves(tab.root)[0]!.id, null])
  })
})

describe('reading a stored workspace', () => {
  const valid = JSON.stringify(withTabs('a'))

  test('a well-formed row comes back with the row\'s revision', () => {
    const parsed = parseWorkspace('wt', 7, valid)
    expect(parsed.ok && parsed.workspace.revision).toBe(7)
  })

  test('rows that are not JSON, the wrong shape or another workspace are reported', () => {
    const base = JSON.parse(valid) as Record<string, unknown>
    const cases: [string, string][] = [
      ['{not json', 'not JSON'],
      ['[]', 'not a workspace'],
      [JSON.stringify({ ...base, id: 'other' }), 'not a workspace'],
      [JSON.stringify({ ...base, root: { kind: 'group', id: 'g', tabs: 'x' } }), 'group tree'],
      [JSON.stringify({ ...base, activeGroup: 4 }), 'activeGroup'],
      [JSON.stringify({ ...base, closed: [{}] }), 'closed tabs']
    ]
    for (const [data, reason] of cases) {
      const parsed = parseWorkspace('wt', 1, data)
      expect(parsed.ok).toBe(false)
      expect(!parsed.ok && parsed.reason).toContain(reason)
    }
  })

  test('a tab with an unknown colour or a pane tree that is not a tree is reported', () => {
    const base = JSON.parse(valid) as { root: { tabs: Record<string, unknown>[] } }
    base.root.tabs[0]!.color = 'mauve'
    expect(parseWorkspace('wt', 1, JSON.stringify(base)).ok).toBe(false)
    base.root.tabs[0]!.color = 'blue'
    base.root.tabs[0]!.root = { kind: 'split', id: 's', direction: 'up', ratio: 0.5 }
    expect(parseWorkspace('wt', 1, JSON.stringify(base)).ok).toBe(false)
  })
})

describe('allocating ids', () => {
  test('one counter numbers every kind and reports where it stopped', () => {
    const ids = new CounterIds(4)
    expect([ids.next('tab'), ids.next('pane'), ids.next('grp'), ids.next('split')]).toEqual(['tab-5', 'pane-6', 'grp-7', 'split-8'])
    expect(ids.value).toBe(8)
  })
})

describe('the service commits a repair that is only normalization', () => {
  test('a stored workspace with an unknown active group is saved repaired', async () => {
    const stored = { ...withTabs('s'), activeGroup: 'grp-missing' }
    const saved: Workspace[] = []
    const store = {
      loadWorkspaces: () => ({ workspaces: [stored], unreadable: [] }),
      counter: () => 20,
      floating: () => ({}),
      save: (ws: Workspace) => void saved.push(ws)
    }
    const context = {
      call: async () => [session('s', { worktreeId: 'wt' })],
      log: () => {},
      error: (_kind: string, message: string) => new Error(message),
      emit: () => {}
    }
    const service = new LayoutService(context as never, store as never, new InputTracker())
    service.requestReconcile()
    await (service as unknown as { tail: Promise<unknown> }).tail
    expect(saved).toHaveLength(1)
    expect(saved[0]!.activeGroup).toBe(groupsInOrder(saved[0]!.root)[0]!.id)
    expect(saved[0]!.revision).toBe(stored.revision + 1)

    service.requestReconcile()
    await (service as unknown as { tail: Promise<unknown> }).tail
    expect(saved).toHaveLength(1)
  })
})
