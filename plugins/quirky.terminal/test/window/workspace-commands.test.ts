import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import type { Group, GroupNode, TerminalTab, Workspace } from '../../src/layout/types'
import { controllerFor, focusedController, setFloatingFocus } from '../../src/window/workspace/registry'
import {
  callsTo,
  click,
  conceptualWorkspace,
  fakeDaemon,
  fire,
  group,
  key,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  mouse,
  pane,
  settle,
  session,
  simpleWorkspace,
  startRecording,
  stopRecording,
  tab,
  terminals,
  unloadWorkspace,
  type FakeDaemon,
  type MountedWorkspace
} from './workspace-support'

const views: MountedWorkspace[] = []
const releasePending: (() => void)[] = []

function deferred<T>() {
  const gate = Promise.withResolvers<T>()
  void gate.promise.catch(() => {})
  releasePending.push(() => gate.reject(new Error('test gate was not released')))
  return gate
}

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(() => {
  startRecording()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {}, readText: async () => '' } })
})
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount()
  for (const release of releasePending.splice(0)) release()
  await settleSeveral()
  stopRecording()
  document.body.innerHTML = ''
})

async function mount(workspace = conceptualWorkspace(), options: Record<string, unknown> = {}) {
  const view = await mountFixture(fakeDaemon(workspace), options as never)
  views.push(view)
  return view
}

const run = async (work: () => unknown) => {
  await act(async () => void (await work()))
  await settle()
}
const termOf = (view: MountedWorkspace, paneId: string) => terminals.find((candidate) => view.q(`[data-pane="${paneId}"]`)!.contains(candidate.element ?? null))!

function groupById(node: GroupNode, id: string): Group | null {
  if (node.kind === 'group') return node.id === id ? node : null
  return groupById(node.first, id) ?? groupById(node.second, id)
}

function selectionRaceWorkspace(): Workspace {
  const workspace = conceptualWorkspace()
  workspace.activeGroup = 'grp-2'
  return workspace
}

function appendActiveTab(workspace: Workspace, groupId: string, entry: TerminalTab): Workspace {
  const next = structuredClone(workspace)
  const target = groupById(next.root, groupId)
  if (!target) throw new Error(`missing group ${groupId}`)
  target.tabs.push(entry)
  target.activeTab = entry.id
  target.recent = [entry.id, ...target.recent.filter((id) => id !== entry.id)]
  next.activeGroup = groupId
  return next
}

function appendSessionTab(workspace: Workspace, groupId: string, sessionId: string): Workspace {
  const id = `adopted-${sessionId}`
  return appendActiveTab(workspace, groupId, tab(id, pane(id, sessionId)))
}

async function settleSeveral(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await settle()
}

async function emitLayout(view: MountedWorkspace, workspace: Workspace): Promise<void> {
  await view.fake.emit({
    type: 'quirky.terminal/layout',
    data: { workspace: workspace.id, revision: workspace.revision }
  } as never)
}

async function commitAdoption(view: MountedWorkspace, groupId: string, sessionId: string) {
  const workspace = view.daemon.set(appendSessionTab(view.daemon.workspace, groupId, sessionId))
  await emitLayout(view, workspace)
  return { workspace }
}

function watchFocus(view: MountedWorkspace, paneId: string) {
  const terminal = termOf(view, paneId)
  let count = 0
  const focus = terminal.focus.bind(terminal)
  terminal.focus = () => {
    count += 1
    focus()
  }
  return { terminal, count: () => count }
}

describe('layout commands', () => {
  test('newTab opens a tab in the workspace, optionally in a group with an agent', async () => {
    const view = await mount()
    await run(() => view.controller().newTab())
    await run(() => view.controller().newTab({ group: 'grp-2', agent: 'codex', prompt: 'hi' }))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'wt-main' }, { workspace: 'wt-main', group: 'grp-2', agent: 'codex', prompt: 'hi' }])
  })

  test('splitRight and splitDown split the focused pane unless told which', async () => {
    const view = await mount()
    await run(() => view.controller().splitRight())
    await run(() => view.controller().splitDown('pane-2'))
    expect(callsTo(view.fake, 'splitPane')).toEqual([
      { pane: 'pane-3', direction: 'right' },
      { pane: 'pane-2', direction: 'down' }
    ])
  })

  test('focusNext and focusPrevious step through the active tab panes', async () => {
    const view = await mount()
    await run(() => view.controller().focusNext())
    await run(() => view.controller().focusPrevious())
    expect(callsTo(view.fake, 'focusPane')).toEqual([
      { tab: 'tab-2', offset: 1 },
      { tab: 'tab-2', offset: -1 }
    ])
  })

  test('toggleExpand expands the focused pane, and collapses when expanded', async () => {
    const view = await mount()
    await run(() => view.controller().toggleExpand())
    await run(() => view.controller().toggleExpand())
    expect(callsTo(view.fake, 'expandPane')).toEqual([
      { pane: 'pane-3', expanded: true },
      { pane: 'pane-3', expanded: false }
    ])
  })

  test('expand and equalize do nothing with a single pane', async () => {
    const view = await mount(simpleWorkspace())
    await run(() => view.controller().toggleExpand())
    await run(() => view.controller().equalize())
    expect(callsTo(view.fake, 'expandPane')).toEqual([])
    expect(callsTo(view.fake, 'equalize')).toEqual([])
  })

  test('equalize targets the active tab', async () => {
    const view = await mount()
    await run(() => view.controller().equalize())
    expect(callsTo(view.fake, 'equalize')).toEqual([{ tab: 'tab-2' }])
  })

  test('setTitle opens the field on the focused pane; clearTitle empties it', async () => {
    const view = await mount()
    await run(() => view.controller().setTitle())
    expect(view.q('[data-pane-header="pane-3"] input[aria-label="Pane title"]')).not.toBeNull()
    await run(() => view.controller().clearTitle())
    expect(callsTo(view.fake, 'setPaneTitle')).toEqual([{ pane: 'pane-3', title: '' }])
  })

  test('setTitle keeps a lone pane header mounted for editing', async () => {
    const view = await mount(simpleWorkspace())
    await run(() => view.controller().setTitle())
    expect(view.q('[data-pane-header="pane-1"] input[aria-label="Pane title"]')).not.toBeNull()
  })

  test('clearPane and resetPane act on the focused pane', async () => {
    const view = await mount()
    await run(() => view.controller().clearPane())
    await run(() => view.controller().resetPane())
    expect(callsTo(view.fake, 'clearPane')).toEqual([{ pane: 'pane-3' }])
    expect(callsTo(view.fake, 'resetPane')).toEqual([{ pane: 'pane-3' }])
  })

  test('nextTab and previousTab move by position', async () => {
    const view = await mount()
    await run(() => view.controller().nextTab())
    await run(() => view.controller().previousTab())
    expect(callsTo(view.fake, 'activateTab')).toEqual([
      { workspace: 'wt-main', offset: 1, order: 'position' },
      { workspace: 'wt-main', offset: -1, order: 'position' }
    ])
  })

  test('selectTab picks a 1-based tab of the active group and ignores one that is not there', async () => {
    const view = await mount()
    await run(() => view.controller().selectTab(1))
    await run(() => view.controller().selectTab(3))
    await run(() => view.controller().selectTab(0))
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ workspace: 'wt-main', index: 1 }])
  })

  test('a failing call shows a toast naming what failed', async () => {
    const view = await mount()
    view.daemon.fail('splitPane', -32602, 'bad direction')
    await run(() => view.controller().splitRight())
    expect(view.fake.toasts).toEqual([{ title: 'Could not split the pane', body: 'bad direction' }])
  })
})

describe('pane passthroughs', () => {
  test('copy returns the selected text of the focused pane, selectAll selects it', async () => {
    const view = await mount()
    const term = termOf(view, 'pane-3')
    await act(async () => void term.write('hello'))
    await new Promise<void>((resolve) => term.write('', resolve))
    expect(view.controller().copy()).toEqual({ text: '' })
    await run(() => view.controller().selectAll())
    expect(view.controller().copy().text.trim()).toBe('hello')
    expect(view.controller().copy('pane-2')).toEqual({ text: '' })
  })

  test('paste writes through the chunked path to the focused pane or a named one', async () => {
    const view = await mount()
    await run(() => view.controller().paste('abc'))
    await run(() => view.controller().paste('def', 'pane-2'))
    expect(view.fake.callsTo('quirky.terminal/write').map((call) => call.params)).toEqual([
      { session: 's-3', data: 'abc' },
      { session: 's-2', data: 'def' }
    ])
  })

  test('search, searchNext, searchPrevious and searchClose drive the pane find box', async () => {
    const view = await mount()
    await run(() => view.controller().search('19', { regex: true }))
    const entry = () => view.last().panes.find((pane: any) => pane.pane === 'pane-3').search
    expect(entry()).toMatchObject({ query: '19', regex: true })
    await run(() => view.controller().searchNext())
    await run(() => view.controller().searchPrevious())
    await run(() => view.controller().searchClose())
    expect(entry()).toBeNull()
  })

  test('a query over 1,000 characters is refused', async () => {
    const view = await mount()
    expect(() => view.controller().search('x'.repeat(1001))).toThrow()
  })

  test('zoom applies to one pane and shows in the report', async () => {
    const view = await mount()
    const size = (id: string) => view.last().panes.find((pane: any) => pane.pane === id).fontSize
    await run(() => view.controller().zoomIn())
    await run(() => view.controller().zoomIn())
    expect(size('pane-3')).toBe(16)
    expect(size('pane-2')).toBe(14)
    await run(() => view.controller().zoomOut('pane-2'))
    expect(size('pane-2')).toBe(13)
    await run(() => view.controller().zoomReset())
    expect(size('pane-3')).toBe(14)
  })

  test('a named pane that is not mounted is ignored', async () => {
    const view = await mount()
    expect(view.controller().copy('pane-1')).toEqual({ text: '' })
    await run(() => view.controller().selectAll('pane-1'))
  })
})

describe('SC-21: the Ctrl+Tab switcher', () => {
  const four = () =>
    makeWorkspace(
      group(
        'grp-1',
        [1, 2, 3, 4].map((n) => tab(`t${n}`, pane(`pane-${n}`, `s-${n}`), { defaultTitle: `Tab ${n}` })),
        { activeTab: 't4', recent: ['t4', 't1', 't3', 't2'] }
      )
    )
  const titles = (view: MountedWorkspace) => view.qa('[role="option"]').map((el) => el.textContent)
  const highlighted = (view: MountedWorkspace) => view.q('[role="option"][aria-selected="true"]')!.textContent

  test('lists tabs by recent use with the previous one highlighted', async () => {
    const view = await mount(four())
    await run(() => view.controller().recentTab())
    expect(view.q('[role="dialog"]')).not.toBeNull()
    expect(titles(view)).toEqual(['Tab 4', 'Tab 1', 'Tab 3', 'Tab 2'])
    expect(highlighted(view)).toBe('Tab 1')
  })

  test('each further press moves down, and releasing Ctrl activates the highlighted tab', async () => {
    const view = await mount(four())
    await run(() => view.controller().recentTab())
    await run(() => view.controller().recentTab())
    expect(highlighted(view)).toBe('Tab 3')
    await fire(window, new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 't3' }])
    expect(view.q('[role="dialog"]')).toBeNull()
  })

  test('with sequential order it lists by position and starts after the active tab', async () => {
    const view = await mount(four(), { settings: { 'ctrl-tab-order': 'sequential' } })
    await run(() => view.controller().recentTab())
    expect(titles(view)).toEqual(['Tab 1', 'Tab 2', 'Tab 3', 'Tab 4'])
    expect(highlighted(view)).toBe('Tab 1')
  })

  test('Tab and Shift+Tab move the highlight, Escape cancels', async () => {
    const view = await mount(four())
    await run(() => view.controller().recentTab())
    await key(window, 'Tab')
    expect(highlighted(view)).toBe('Tab 3')
    await key(window, 'Tab', { shiftKey: true })
    expect(highlighted(view)).toBe('Tab 1')
    await key(view.q('[role="dialog"]')!, 'Escape')
    expect(view.q('[role="dialog"]')).toBeNull()
    expect(callsTo(view.fake, 'activateTab')).toEqual([])
  })

  test('a click on a row activates it', async () => {
    const view = await mount(four())
    await run(() => view.controller().recentTab())
    await fire(view.q('[data-tab-option="t2"]'), mouse('mouseover'))
    await click(view.q('[data-tab-option="t2"]'))
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 't2' }])
  })

  test('with one tab nothing opens', async () => {
    const view = await mount(simpleWorkspace())
    await run(() => view.controller().recentTab())
    expect(view.q('[role="dialog"]')).toBeNull()
  })
})

describe('SC-76: the view input focuses a session pane', () => {
  const elsewhere = () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.activeTab = 'tab-1'
    ;(ws as any).activeGroup = 'grp-2'
    return ws
  }

  test('focuses the pane showing the session', async () => {
    const view = await mount(elsewhere(), { input: { worktree: 'wt-main', session: 's-3' } })
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-3' }])
    expect(view.last().active).toBe('s-3')
    expect(view.last().layout.activeGroup).toBe('grp-1')
  })

  test('a session no pane shows is ignored', async () => {
    const view = await mount(elsewhere(), { input: { worktree: 'wt-main', session: 's-99' } })
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    expect(view.last().layout.activeGroup).toBe('grp-2')
  })

  test('without a session nothing is focused', async () => {
    const view = await mount(elsewhere())
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
  })
})

describe('worktree view input updates', () => {
  test('accepts the original selector and loaded ID without rebuilding the provider or terminal tree', async () => {
    const view = await mountFixture(fakeDaemon(conceptualWorkspace()), {
      input: { worktree: 'main' },
      provider: true,
      extra: { 'quirky.terminal/quickCommands': () => ({ commands: [] }) }
    })
    views.push(view)
    const controller = view.controller()
    const workspaceRoot = view.q('.qt-workspace')
    const groupBody = view.q('[data-group-body="grp-1"]')
    const terminalInstances = [...terminals]
    const terminal = termOf(view, 'pane-2')
    const originalFocus = watchFocus(view, 'pane-2')
    const quickCommandCalls = view.fake.callsTo('quirky.terminal/quickCommands').length

    expect(await view.updateInput({ worktree: 'wt-main', session: 's-2' })).toBe(true)
    await settleSeveral()

    expect(view.controller()).toBe(controller)
    expect(view.q('.qt-workspace')).toBe(workspaceRoot)
    expect(view.q('[data-group-body="grp-1"]')).toBe(groupBody)
    expect(groupBody?.isConnected).toBe(true)
    expect(termOf(view, 'pane-2') === terminal).toBe(true)
    expect(terminals.length).toBe(terminalInstances.length)
    expect(terminals.every((candidate, index) => candidate === terminalInstances[index])).toBe(true)
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-2' }])
    expect(view.last().active).toBe('s-2')
    expect(view.last().focusedPane).toBe('pane-2')
    expect(originalFocus.count()).toBeGreaterThan(0)

    const focusedBeforeRepeat = originalFocus.count()
    expect(await view.updateInput({ worktree: 'main', session: 's-2' })).toBe(true)
    await settleSeveral()

    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-2' }])
    expect(originalFocus.count()).toBeGreaterThan(focusedBeforeRepeat)
    expect(view.fake.callsTo('quirky.terminal/quickCommands')).toHaveLength(quickCommandCalls)
    expect(view.q('.qt-workspace')).toBe(workspaceRoot)
  })

  test.each(['inside', 'outside'] as const)('lifting selection suppression preserves a text field %s the workspace', async (location) => {
    const view = await mount()
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-2' })).toBe(true)
    await settleSeveral()

    const field = document.createElement('input')
    const parent = location === 'inside' ? view.element : document.body
    parent.appendChild(field)
    await run(() => field.focus())
    expect(document.activeElement === field).toBe(true)
    const focus = ['pane-2', 'pane-3', 'pane-4', 'pane-5'].map((id) => watchFocus(view, id))

    const next = view.daemon.set(structuredClone(view.daemon.workspace))
    await emitLayout(view, next)
    await settleSeveral()

    expect(view.last().layout.revision).toBe(next.revision)
    expect(focus.map((terminal) => terminal.count())).toEqual([0, 0, 0, 0])
    expect(document.activeElement === field).toBe(true)
  })

  test('preserves unaffected groups and terminals when selecting a session on another tab', async () => {
    const workspace = conceptualWorkspace()
    const firstGroup = groupById(workspace.root, 'grp-1')
    if (!firstGroup) throw new Error('missing group grp-1')
    firstGroup.activeTab = 'tab-1'
    workspace.activeGroup = 'grp-2'
    const view = await mount(workspace)
    const firstBody = view.q('[data-group-body="grp-1"]')
    const secondBody = view.q('[data-group-body="grp-2"]')
    const unaffectedTerminal = termOf(view, 'pane-5')

    expect(await view.updateInput({ worktree: 'wt-main', session: 's-3' })).toBe(true)
    await settleSeveral()

    expect(firstBody?.isConnected).toBe(true)
    expect(secondBody?.isConnected).toBe(true)
    expect(view.q('[data-group-body="grp-1"]')).toBe(firstBody)
    expect(view.q('[data-group-body="grp-2"]')).toBe(secondBody)
    expect(termOf(view, 'pane-5') === unaffectedTerminal).toBe(true)
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-3' }])
    expect(document.activeElement === termOf(view, 'pane-3').textarea).toBe(true)
    expect(view.last().active).toBe('s-3')
    expect(view.last().focusedPane).toBe('pane-3')
  })

  test('declines empty, floating, and cross-worktree inputs', async () => {
    const regular = await mountFixture(fakeDaemon(conceptualWorkspace()), { input: { worktree: 'main' } })
    views.push(regular)
    expect(await regular.updateInput({ worktree: 'wt-main', session: 's-2' })).toBe(true)
    expect(await regular.updateInput({ worktree: '', session: 's-1' })).toBe(false)
    expect(await regular.updateInput({ worktree: 'wt-other', session: 's-1' })).toBe(false)

    const empty = await mountFixture(fakeDaemon(conceptualWorkspace()), { input: { worktree: '' } })
    views.push(empty)
    expect(await empty.updateInput({ worktree: 'wt-main', session: 's-1' })).toBe(false)

    const floating = await mountFixture(fakeDaemon(makeWorkspace(group('grp-1', []), { id: 'floating' })), {
      input: { worktree: 'wt-main' },
      view: { workspace: 'floating' }
    })
    views.push(floating)
    expect(await floating.updateInput({ worktree: 'wt-main', session: 's-1' })).toBe(false)
  })
})

describe('session selection while a load is pending', () => {
  test('initial load shares its promise and selects only the latest input after the refreshed layout', async () => {
    const daemon = fakeDaemon(conceptualWorkspace())
    const firstRead = deferred<void>()
    let reads = 0
    const view = await mountFixture(daemon, {
      input: { worktree: 'wt-main' },
      extra: {
        'quirky.terminal/workspace': async () => {
          reads += 1
          if (reads === 1) {
            const snapshot = daemon.workspace
            await firstRead.promise
            return { workspace: snapshot }
          }
          return { workspace: daemon.workspace }
        }
      }
    })
    views.push(view)

    expect(reads).toBe(1)
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-1' })).toBe(true)
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-new' })).toBe(true)
    daemon.set(appendSessionTab(daemon.workspace, 'grp-2', 's-new'))
    daemon.sessions.push(session('s-new'))
    firstRead.resolve()
    await settleSeveral()

    expect(reads).toBe(2)
    expect(view.fake.callsTo('quirky.terminal/workspace').map((call) => call.params)).toEqual([
      { workspace: 'wt-main', ensure: true },
      { workspace: 'wt-main' }
    ])
    expect(callsTo(view.fake, 'adoptSession')).toEqual([])
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    expect(view.last().active).toBe('s-new')
    expect(view.last().layout.activeGroup).toBe('grp-2')
  })

  test('refresh waits for its queued reload before reconciling the latest session request', async () => {
    const daemon = fakeDaemon(conceptualWorkspace())
    const refreshGate = deferred<void>()
    let reads = 0
    const view = await mountFixture(daemon, {
      extra: {
        'quirky.terminal/workspace': async () => {
          reads += 1
          if (reads === 2) {
            const snapshot = daemon.workspace
            await refreshGate.promise
            return { workspace: snapshot }
          }
          return { workspace: daemon.workspace }
        }
      }
    })
    views.push(view)

    const refreshing = view.controller().refresh()
    await settle()
    daemon.set(appendSessionTab(daemon.workspace, 'grp-2', 's-new'))
    daemon.sessions.push(session('s-new'))
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-1' })).toBe(true)
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-new' })).toBe(true)
    refreshGate.resolve()
    await refreshing
    await settleSeveral()

    expect(reads).toBe(3)
    expect(view.fake.callsTo('quirky.terminal/workspace').map((call) => call.params)).toEqual([
      { workspace: 'wt-main', ensure: true },
      { workspace: 'wt-main' },
      { workspace: 'wt-main' }
    ])
    expect(callsTo(view.fake, 'adoptSession')).toEqual([])
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    expect(view.last().active).toBe('s-new')
    expect(view.last().layout.activeGroup).toBe('grp-2')
  })
})

describe('serialized session selection mutations', () => {

  test('a stale held session lookup exits before the mutation queue in an A-B-A sequence', async () => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const firstLookup = deferred<unknown>()
    let lookups = 0
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.session/get': async () => {
          lookups += 1
          return lookups === 1 ? firstLookup.promise : session('s-bg-1')
        },
        'quirky.terminal/adoptSession': async (params) => {
          if (!view) throw new Error('workspace fixture is not ready')
          return commitAdoption(view, params.group as string, params.session as string)
        }
      }
    })
    view = await viewPromise
    views.push(view)

    expect(await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })).toBe(true)
    await settle()
    expect(view.fake.callsTo('quirky.session/get').map((call) => call.params)).toEqual([{ session: 's-bg-1' }])
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-2' })).toBe(true)
    await settleSeveral()
    expect(await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })).toBe(true)
    await settleSeveral()

    firstLookup.resolve(session('s-bg-1'))
    await settleSeveral()

    expect(lookups).toBe(2)
    expect(view.fake.callsTo('quirky.terminal/adoptSession').map((call) => call.params)).toEqual([
      { group: 'grp-1', session: 's-bg-1' }
    ])
    expect(view.last().active).toBe('s-bg-1')
  })

  test('a late NotFound from a superseded session lookup is silent', async () => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const firstLookup = deferred<unknown>()
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.session/get': () => firstLookup.promise,
        'quirky.terminal/adoptSession': async (params) => {
          if (!view) throw new Error('workspace fixture is not ready')
          return commitAdoption(view, params.group as string, params.session as string)
        }
      }
    })
    view = await viewPromise
    views.push(view)

    await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })
    await settle()
    await view.updateInput({ worktree: 'wt-main', session: 's-2' })
    await settleSeveral()
    firstLookup.reject(new RpcError(RpcErrorCode.NotFound, 'missing session'))
    await settleSeveral()

    expect(callsTo(view.fake, 'adoptSession')).toEqual([])
    expect(view.fake.toasts).toEqual([])
    expect(view.last().active).toBe('s-2')
    expect(view.controller().getSnapshot().selectionError).toBeNull()
  })

  test('an adopted daemon layout is applied before a queued selection inspects the workspace', async () => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const adoptGate = deferred<void>()
    const adoptParams: Record<string, unknown>[] = []
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.session/get': () => session('s-bg-1'),
        'quirky.terminal/adoptSession': async (params) => {
          adoptParams.push(params)
          await adoptGate.promise
          if (!view) throw new Error('workspace fixture is not ready')
          return commitAdoption(view, params.group as string, params.session as string)
        }
      }
    })
    view = await viewPromise
    views.push(view)
    const focusedTerminal = watchFocus(view, 'pane-5')

    await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })
    await settleSeveral()
    expect(adoptParams).toEqual([{ group: 'grp-1', session: 's-bg-1' }])
    await view.updateInput({ worktree: 'wt-main', session: 's-5' })
    await settle()
    adoptGate.resolve()
    await settleSeveral()

    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-5' }])
    expect(view.daemon.workspace.activeGroup).toBe('grp-2')
    expect(view.last().active).toBe('s-5')
    expect(view.last().focusedPane).toBe('pane-5')
    expect(focusedTerminal.count()).toBeGreaterThan(0)
    expect(view.controller().getSnapshot().selectionError).toBeNull()
  })

  test.each([true, false])('a queued session selection reconciles a held focusPane after it %s', async (succeeds) => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const focusGate = deferred<void>()
    const originalFocus = daemon.handlers['quirky.terminal/focusPane']!
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.terminal/focusPane': async (params) => {
          if (params.pane !== 'pane-3') return originalFocus(params)
          await focusGate.promise
          if (!succeeds) throw new Error('focus refused')
          const result = originalFocus(params) as { workspace: Workspace }
          if (!view) throw new Error('workspace fixture is not ready')
          await emitLayout(view, result.workspace)
          return result
        }
      }
    })
    view = await viewPromise
    views.push(view)
    const staleTerminal = watchFocus(view, 'pane-3')
    const latestTerminal = watchFocus(view, 'pane-5')

    await view.updateInput({ worktree: 'wt-main', session: 's-3' })
    await settleSeveral()
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-3' }])
    await view.updateInput({ worktree: 'wt-main', session: 's-5' })
    await settle()
    if (succeeds) focusGate.resolve()
    else focusGate.reject(new Error('focus refused'))
    await settleSeveral()

    expect(callsTo(view.fake, 'focusPane')).toEqual(succeeds ? [{ pane: 'pane-3' }, { pane: 'pane-5' }] : [{ pane: 'pane-3' }])
    expect(view.daemon.workspace.activeGroup).toBe('grp-2')
    expect(view.last().active).toBe('s-5')
    expect(view.last().focusedPane).toBe('pane-5')
    expect(staleTerminal.count()).toBe(0)
    expect(latestTerminal.count()).toBeGreaterThan(0)
    expect(view.fake.toasts).toEqual([])
    expect(view.controller().getSnapshot().selectionError).toBeNull()
  })
})

describe('clearing selection and stopping', () => {
  test('clearing selection immediately clears errors and ensures an empty worktree', async () => {
    const daemon = fakeDaemon(makeWorkspace(group('grp-1', [])))
    const view = await mountFixture(daemon, {
      extra: {
        'quirky.session/get': () => {
          throw new RpcError(RpcErrorCode.NotFound, 'missing session')
        }
      }
    })
    views.push(view)

    await view.updateInput({ worktree: 'wt-main', session: 'missing' })
    await settleSeveral()
    expect(view.controller().getSnapshot().selectionError).toContain('Session missing was not found.')
    expect(await view.updateInput({ worktree: 'wt-main' })).toBe(true)
    expect(view.controller().getSnapshot().selectionError).toBeNull()
    await settleSeveral()

    expect(view.fake.callsTo('quirky.terminal/workspace').map((call) => call.params)).toEqual([
      { workspace: 'wt-main', ensure: true },
      { workspace: 'wt-main', ensure: true }
    ])
  })

  test('clearing while an empty initial load is pending queues an ensuring reload', async () => {
    const daemon = fakeDaemon(makeWorkspace(group('grp-1', [])))
    const gate = deferred<void>()
    let reads = 0
    const view = await mountFixture(daemon, {
      extra: {
        'quirky.terminal/workspace': async () => {
          reads += 1
          if (reads === 1) {
            const snapshot = daemon.workspace
            await gate.promise
            return { workspace: snapshot }
          }
          return { workspace: daemon.workspace }
        }
      }
    })
    views.push(view)

    const accepted = await view.updateInput({ worktree: 'wt-main' })
    gate.resolve()
    await settleSeveral()

    expect(accepted).toBe(true)
    expect(view.fake.callsTo('quirky.terminal/workspace').map((call) => call.params)).toEqual([
      { workspace: 'wt-main', ensure: true },
      { workspace: 'wt-main', ensure: true }
    ])
  })

  test('clearing during a held lookup cancels its later daemon mutation', async () => {
    const lookup = deferred<unknown>()
    const view = await mountFixture(fakeDaemon(selectionRaceWorkspace()), { extra: { 'quirky.session/get': () => lookup.promise } })
    views.push(view)
    await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })
    await settle()
    await view.updateInput({ worktree: 'wt-main' })
    lookup.resolve(session('s-bg-1'))
    await settleSeveral()

    expect(callsTo(view.fake, 'adoptSession')).toEqual([])
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    expect(view.controller().getSnapshot().selectionError).toBeNull()
  })

  test.each([true, false])('clearing during an issued adopt applies success and ignores failure (%s)', async (succeeds) => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const gate = deferred<void>()
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.session/get': () => session('s-bg-1'),
        'quirky.terminal/adoptSession': async (params) => {
          await gate.promise
          if (!succeeds) throw new Error('adopt refused')
          if (!view) throw new Error('workspace fixture is not ready')
          return commitAdoption(view, params.group as string, params.session as string)
        }
      }
    })
    view = await viewPromise
    views.push(view)

    await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })
    await settleSeveral()
    const accepted = await view.updateInput({ worktree: 'wt-main' })
    if (succeeds) gate.resolve()
    else gate.reject(new Error('adopt refused'))
    await settleSeveral()

    expect(accepted).toBe(true)
    expect(view.last().active).toBe(succeeds ? 's-bg-1' : 's-5')
    expect(view.last().layout.activeGroup).toBe(succeeds ? 'grp-1' : 'grp-2')
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    expect(view.fake.toasts).toEqual([])
    expect(view.controller().getSnapshot().selectionError).toBeNull()
  })

  test.each([true, false])('clearing during an issued focus applies success without focusing the superseded pane (%s)', async (succeeds) => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const gate = deferred<void>()
    const originalFocus = daemon.handlers['quirky.terminal/focusPane']!
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.terminal/focusPane': async (params) => {
          if (params.pane !== 'pane-3') return originalFocus(params)
          await gate.promise
          if (!succeeds) throw new Error('focus refused')
          const result = originalFocus(params) as { workspace: Workspace }
          if (!view) throw new Error('workspace fixture is not ready')
          await emitLayout(view, result.workspace)
          return result
        }
      }
    })
    view = await viewPromise
    views.push(view)
    const staleTerminal = watchFocus(view, 'pane-3')

    await view.updateInput({ worktree: 'wt-main', session: 's-3' })
    await settleSeveral()
    const accepted = await view.updateInput({ worktree: 'wt-main' })
    if (succeeds) gate.resolve()
    else gate.reject(new Error('focus refused'))
    await settleSeveral()

    expect(accepted).toBe(true)
    expect(view.daemon.workspace.activeGroup).toBe(succeeds ? 'grp-1' : 'grp-2')
    expect(view.last().active).toBe(succeeds ? 's-3' : 's-5')
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-3' }])
    expect(staleTerminal.count()).toBe(0)
    expect(view.fake.toasts).toEqual([])
    expect(view.controller().getSnapshot().selectionError).toBeNull()
  })

  test('stopping during a pending load prevents the load result from updating state', async () => {
    const daemon = fakeDaemon(conceptualWorkspace())
    const gate = deferred<void>()
    const view = await mountFixture(daemon, {
      extra: {
        'quirky.terminal/workspace': async () => {
          await gate.promise
          return { workspace: daemon.workspace }
        }
      }
    })
    views.push(view)
    const controller = view.controller()
    views.splice(views.indexOf(view), 1)
    await view.unmount()
    const state = controller.getSnapshot()
    gate.resolve()
    await settleSeveral()

    expect(controller.getSnapshot()).toBe(state)
    expect(view.fake.toasts).toEqual([])
  })

  test('stopping during a pending session lookup silences its eventual rejection', async () => {
    const gate = deferred<unknown>()
    const view = await mountFixture(fakeDaemon(selectionRaceWorkspace()), { extra: { 'quirky.session/get': () => gate.promise } })
    views.push(view)
    const controller = view.controller()
    await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })
    await settle()
    views.splice(views.indexOf(view), 1)
    await view.unmount()
    const state = controller.getSnapshot()
    gate.reject(new RpcError(RpcErrorCode.NotFound, 'missing session'))
    await settleSeveral()

    expect(controller.getSnapshot()).toBe(state)
    expect(callsTo(view.fake, 'adoptSession')).toEqual([])
    expect(view.fake.toasts).toEqual([])
  })

  test('stopping during an issued adopt prevents post-settlement state and toast effects', async () => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const gate = deferred<void>()
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.session/get': () => session('s-bg-1'),
        'quirky.terminal/adoptSession': async (params) => {
          await gate.promise
          if (!view) throw new Error('workspace fixture is not ready')
          return commitAdoption(view, params.group as string, params.session as string)
        }
      }
    })
    view = await viewPromise
    views.push(view)
    const controller = view.controller()
    await view.updateInput({ worktree: 'wt-main', session: 's-bg-1' })
    await settleSeveral()
    views.splice(views.indexOf(view), 1)
    await view.unmount()
    const state = controller.getSnapshot()
    gate.resolve()
    await settleSeveral()

    expect(controller.getSnapshot()).toBe(state)
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    expect(view.fake.toasts).toEqual([])
  })

  test('stopping during an issued focus prevents its result from updating or focusing a pane', async () => {
    const daemon = fakeDaemon(selectionRaceWorkspace())
    const gate = deferred<void>()
    const originalFocus = daemon.handlers['quirky.terminal/focusPane']!
    let view: MountedWorkspace | undefined
    const viewPromise = mountFixture(daemon, {
      extra: {
        'quirky.terminal/focusPane': async (params) => {
          if (params.pane !== 'pane-3') return originalFocus(params)
          await gate.promise
          const result = originalFocus(params) as { workspace: Workspace }
          if (!view) throw new Error('workspace fixture is not ready')
          await emitLayout(view, result.workspace)
          return result
        }
      }
    })
    view = await viewPromise
    views.push(view)
    const controller = view.controller()
    const staleTerminal = watchFocus(view, 'pane-3')
    await view.updateInput({ worktree: 'wt-main', session: 's-3' })
    await settleSeveral()
    views.splice(views.indexOf(view), 1)
    await view.unmount()
    const state = controller.getSnapshot()
    gate.resolve()
    await settleSeveral()

    expect(controller.getSnapshot()).toBe(state)
    expect(staleTerminal.count()).toBe(0)
    expect(view.fake.toasts).toEqual([])
  })
})

describe('the floating workspace', () => {
  const empty = () => makeWorkspace(group('grp-1', []), { id: 'floating' })
  const buttonStartingWith = (view: MountedWorkspace, label: string) => view.qa('button').find((button) => button.textContent?.trim().startsWith(label))!

  test('loads without creating a tab', async () => {
    const view = await mount(empty(), { input: undefined, view: { workspace: 'floating' } })
    expect(view.fake.callsTo('quirky.terminal/workspace')[0]!.params).toEqual({ workspace: 'floating' })
    expect(callsTo(view.fake, 'newTab')).toEqual([])
  })

  test('New Terminal opens a tab; Minimize hides the panel', async () => {
    const view = await mount(empty(), { input: undefined, view: { workspace: 'floating' } })
    await click(buttonStartingWith(view, 'New Terminal'))
    await click(buttonStartingWith(view, 'Minimize'))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'floating', group: 'grp-1' }])
    expect(view.fake.callsTo('quirky.terminal/setFloating').map((call) => call.params)).toEqual([{ open: false }])
  })

  test('a worktree workspace with no tabs opens a terminal from its action', async () => {
    const view = await mount(makeWorkspace(group('grp-1', [])))
    await click(buttonStartingWith(view, 'New Terminal'))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'wt-main', group: 'grp-1' }])
  })
})

describe('finding the workspace commands act on', () => {
  test('controllerFor finds a mounted workspace by ID', async () => {
    const view = await mount()
    expect(controllerFor('wt-main') === view.controller()).toBe(true)
    expect(controllerFor('wt-other')).toBeNull()
  })

  test('the floating workspace wins while it is told it has focus, the main view otherwise', async () => {
    const main = await mount()
    const floating = await mount(makeWorkspace(group('grp-1', []), { id: 'floating' }), { input: undefined, view: { workspace: 'floating' } })
    const mainController = controllerFor('wt-main')!
    const floatingController = controllerFor('floating')!
    expect(floatingController.floating).toBe(true)
    expect(focusedController() === mainController).toBe(true)
    setFloatingFocus(true)
    expect(focusedController() === floatingController).toBe(true)
    setFloatingFocus(false)
    expect(focusedController() === mainController).toBe(true)
    expect(main.element === floating.element).toBe(false)
  })

  test('the controller whose element holds DOM focus is the focused one', async () => {
    await mount()
    const floating = await mount(makeWorkspace(group('grp-1', []), { id: 'floating' }), { input: undefined, view: { workspace: 'floating' } })
    const input = document.createElement('input')
    floating.element.appendChild(input)
    input.focus()
    expect(focusedController() === controllerFor('floating')).toBe(true)
    input.remove()
  })

  test('nothing mounted means no controller', async () => {
    expect(focusedController()).toBeNull()
  })
})
