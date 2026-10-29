import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
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
  simpleWorkspace,
  startRecording,
  stopRecording,
  tab,
  terminals,
  unloadWorkspace,
  type MountedWorkspace
} from './workspace-support'

const views: MountedWorkspace[] = []

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(() => {
  startRecording()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {}, readText: async () => '' } })
})
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount()
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
