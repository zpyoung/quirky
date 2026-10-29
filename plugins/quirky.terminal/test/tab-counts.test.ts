import { afterEach, expect, test } from 'bun:test'
import type { QuirkyClient, TerminalTabCounts } from '@quirky/protocol'
import { InputTracker } from '../src/input-tracker'
import { LayoutService } from '../src/layout/service'
import { groupsInOrder } from '../src/layout/tree'
import type { ClosedTab, Group, GroupSplit, PaneLeaf, TerminalTab, ViewTab, Workspace } from '../src/layout/types'
import { commands } from '../cli'
import { call, restartDaemon, startPluginHarness, testCliContext, TERMINAL_PLUGINS } from './support'
import { sessionCreates } from './fakes/quirky.session/main'

const pane = (id: string, session: string): PaneLeaf => ({ kind: 'pane', id, session, title: null, exit: null })

function terminalTab(): TerminalTab {
  const first = pane('pane-first', 'private-session-first')
  const second = pane('pane-second', 'private-session-second')
  return {
    id: 'tab-terminal', defaultTitle: 'Private terminal title', customTitle: null, liveTitle: null,
    color: 'none', pinned: false,
    root: { kind: 'split', id: 'pane-split', direction: 'right', ratio: 0.5, first, second },
    activePane: first.id, expandedPane: null, createdAt: '2026-10-28T00:00:00.000Z'
  }
}

function hostedTab(id: string, viewId: string, title: string, input: Record<string, unknown>): ViewTab {
  return {
    kind: 'view', id, viewId, key: id, input, title, color: 'none', pinned: false, preview: false,
    closeParams: { path: '/private/layout/path' }, createdAt: '2026-10-28T00:00:00.000Z'
  }
}

function group(id: string, tabs: Group['tabs']): Group {
  return { kind: 'group', id, tabs, activeTab: tabs[0]?.id ?? null, recent: [], lastQuickCommand: null }
}

function mixedWorkspace(): Workspace {
  const left = group('group-left', [
    terminalTab(),
    hostedTab('tab-native', 'view:quirky.browser/page', 'Private Native title', { pane: 'native-pane' }),
    hostedTab('tab-watch', 'view:quirky.browser/page', 'Private Watch title', { pane: 'watch-pane' })
  ])
  const right = group('group-right', [
    hostedTab('tab-markdown', 'view:quirky.editor/document', 'Private Markdown title', { bufferId: 'private-buffer' })
  ])
  const root: GroupSplit = { kind: 'split', id: 'group-split', direction: 'right', ratio: 0.5, first: left, second: right }
  const closed: ClosedTab[] = [{ title: 'Closed title', defaultTitle: 'History only', color: 'none', cwd: '/history/path', agent: 'shell', closedAt: '2026-10-27T00:00:00.000Z' }]
  return { id: 'wt-mixed', revision: 7, root, activeGroup: left.id, closed }
}

test('LayoutService counts current tabs once across groups and omits unreadable layouts without exposing layout data', async () => {
  const workspace = mixedWorkspace()
  const empty: Workspace = { id: 'wt-empty', revision: 0, root: group('group-empty', []), activeGroup: 'group-empty', closed: [] }
  const storeWrites: string[] = []
  const providerCalls: string[] = []
  const ptyCalls: unknown[][] = []
  const context = {
    log() {},
    error(_kind: string, message: string) { return new Error(message) },
    async call(method: string) {
      providerCalls.push(method)
      return [{ id: 'background-session', background: true }]
    },
    pty: { async spawn(...args: unknown[]) { ptyCalls.push(args); return undefined } }
  }
  const store = {
    loadWorkspaces: () => ({
      workspaces: [workspace, empty],
      unreadable: [{ id: 'wt-unreadable', revision: 4, reason: 'corrupt layout data' }]
    }),
    counter: () => 20,
    floating: () => ({}),
    save: () => storeWrites.push('save')
  }
  const service = new LayoutService(context as never, store as never, new InputTracker())

  const result = await service.methods.tabCounts!({}, {} as never) as TerminalTabCounts

  expect(result.counts.find((row) => row.worktreeId === 'wt-mixed')?.tabCount).toBe(4)
  expect(result.counts.find((row) => row.worktreeId === 'wt-empty')?.tabCount).toBe(0)
  expect(result.counts.some((row) => row.worktreeId === 'wt-unreadable')).toBe(false)
  expect(result.unavailableWorktrees).toContain('wt-unreadable')
  const serialized = JSON.stringify(result)
  for (const privateValue of ['Private terminal title', 'Private Native title', 'Private Watch title', 'Private Markdown title', 'private-session-first', 'private-buffer', 'native-pane', 'watch-pane', 'view:quirky.browser/page', 'view:quirky.editor/document', 'private.invalid', '/private/', 'Closed title']) {
    expect(serialized).not.toContain(privateValue)
  }
  expect(providerCalls).toEqual([])
  expect(ptyCalls).toEqual([])
  expect(storeWrites).toEqual([])
})

let harness: Awaited<ReturnType<typeof startPluginHarness>> | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

test('public tabCounts follows live tabs through splits, close history, cold restart and CLI', async () => {
  sessionCreates().length = 0
  harness = await startPluginHarness(TERMINAL_PLUGINS)
  const client = await harness.connect('cli')
  const api = <T,>(method: string, params: Record<string, unknown> = {}, target: QuirkyClient = client) =>
    call<T>(target, `quirky.terminal/${method}`, params)

  // A first count query must not realize an empty workspace or start its default terminal.
  const emptySnapshot = await api<TerminalTabCounts>('tabCounts')
  expect(emptySnapshot.counts).toEqual([])
  expect(sessionCreates()).toHaveLength(0)

  const created = await api<{ workspace: Workspace }>('workspace', { workspace: 'main', ensure: true })
  const firstTab = groupsInOrder(created.workspace.root).flatMap((item) => item.tabs)
    .find((item): item is TerminalTab => !('kind' in item))!
  const creationsBeforeCount = sessionCreates().length

  const initial = await api<TerminalTabCounts>('tabCounts')
  expect(initial.counts.find((row) => row.worktreeId === created.workspace.id)?.tabCount).toBe(1)
  expect(sessionCreates()).toHaveLength(creationsBeforeCount)

  await api('splitPane', { pane: firstTab.activePane, direction: 'right' })
  expect((await api<TerminalTabCounts>('tabCounts')).counts.find((row) => row.worktreeId === created.workspace.id)?.tabCount).toBe(1)

  await api('newTab', { workspace: 'main' })
  const beforeRestart = sessionCreates().length
  expect((await api<TerminalTabCounts>('tabCounts')).counts.find((row) => row.worktreeId === created.workspace.id)?.tabCount).toBe(2)

  const restarted = await restartDaemon(harness)
  try {
    const afterRestart = await api<TerminalTabCounts>('tabCounts', {}, restarted.client)
    expect(afterRestart.counts.find((row) => row.worktreeId === created.workspace.id)?.tabCount).toBe(2)
    expect(sessionCreates()).toHaveLength(beforeRestart)

    const closed = await api<{ workspace: Workspace }>('closeTab', { tab: firstTab.id }, restarted.client)
    expect(closed.workspace.closed).toHaveLength(1)
    const afterClose = await api<TerminalTabCounts>('tabCounts', {}, restarted.client)
    expect(afterClose.counts.find((row) => row.worktreeId === created.workspace.id)?.tabCount).toBe(1)

    const cli = testCliContext(restarted.client, { json: true })
    await commands['tab-counts']!({ positionals: [], flags: {} }, cli.ctx)
    const cliCounts = JSON.parse(cli.lines[0]!) as TerminalTabCounts
    expect(cliCounts.counts.find((row) => row.worktreeId === created.workspace.id)?.tabCount).toBe(1)
  } finally {
    await restarted.stop()
  }
})
