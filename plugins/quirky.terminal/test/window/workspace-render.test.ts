import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import {
  conceptualWorkspace,
  fakeDaemon,
  fire,
  group,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  notFound,
  pane,
  paneSplit,
  session,
  settle,
  simpleWorkspace,
  startRecording,
  stopRecording,
  tab,
  terminals,
  type as typeText,
  unloadWorkspace,
  type MountedWorkspace
} from './workspace-support'

let mounted: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

async function mount(daemon = fakeDaemon(conceptualWorkspace()), options = {}) {
  mounted = await mountFixture(daemon, options)
  return mounted
}

const ACCESSORY_ID = 'terminal-accessory:test.accessory/account'
const ACCESSORY_VIEW_ID = 'view:test.accessory/account'

function accessoryHandlers() {
  return {
    'plugin.contributions': () => [
      {
        id: ACCESSORY_ID,
        kind: 'terminal-accessory',
        plugin: 'test.accessory',
        status: 'effective',
        data: { title: 'Account', order: 10, view: ACCESSORY_VIEW_ID }
      }
    ],
    'ui.contributions': () => ({ views: [{ id: ACCESSORY_VIEW_ID, module: 'fixture.js' }] })
  }
}

describe('rendering from the daemon workspace', () => {
  test('loads the workspace for the input worktree with ensure', async () => {
    const view = await mount()
    const [call] = view.fake.callsTo('quirky.terminal/workspace')
    expect(call!.params).toEqual({ workspace: 'wt-main', ensure: true })
  })

  test('draws one strip per group with a tab per tab, selected by the group', async () => {
    const view = await mount()
    expect(view.qa('[data-group]').map((el) => el.dataset.group)).toEqual(['grp-1', 'grp-2'])
    const tabs = view.qa('[role="tab"]')
    expect(tabs.map((el) => el.closest<HTMLElement>('[data-tab]')!.dataset.tab)).toEqual(['tab-1', 'tab-2', 'tab-3'])
    expect(tabs.map((el) => el.getAttribute('aria-selected'))).toEqual(['false', 'true', 'true'])
    expect(tabs.map((el) => el.textContent)).toEqual(['Terminal 1', 'Build', 'Hello'])
  })

  test("a tab's accessible element holds only its title, so pressing it can't reach the close button", async () => {
    const view = await mount()
    const tab = view.qa('[role="tab"]')[0]!
    expect(tab.querySelector('button')).toBeNull()
    expect(tab.closest('[data-tab]')!.querySelector('.qt-tab-close')).not.toBeNull()
  })

  test('shows a colour dot, a pin instead of close, and a collapse icon for an expanded tab', async () => {
    const ws = conceptualWorkspace()
    const first = (ws.root as any).first
    first.tabs[0].pinned = true
    first.tabs[1].expandedPane = 'pane-3'
    const view = await mount(fakeDaemon(ws))
    const pinned = view.q('[data-tab="tab-1"]')!
    expect(pinned.querySelector('[data-color="blue"]')).not.toBeNull()
    expect(pinned.querySelector('[aria-label="Pinned"]')).not.toBeNull()
    expect(pinned.querySelector('.qt-tab-close')).toBeNull()
    const expanded = view.q('[data-tab="tab-2"]')!
    expect(expanded.querySelector('[aria-label="Collapse expanded pane"]')).not.toBeNull()
    expect(expanded.querySelector('.qt-tab-close')).not.toBeNull()
  })

  test('the tab title follows displayTitle: custom, then live, then default', async () => {
    const ws = conceptualWorkspace()
    const tabs = (ws.root as any).first.tabs
    tabs[0].liveTitle = 'deploy'
    tabs[1].customTitle = null
    const view = await mount(fakeDaemon(ws))
    expect(view.q('[data-tab="tab-1"] .qt-tab-title')!.textContent).toBe('deploy')
    expect(view.q('[data-tab="tab-2"] .qt-tab-title')!.textContent).toBe('Terminal 2')
  })

  test('the status dot comes from the active pane session', async () => {
    const daemon = fakeDaemon(conceptualWorkspace(), { sessions: ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, id === 's-3' ? { status: 'exited' } : {})) })
    const view = await mount(daemon)
    expect(view.q('[data-tab="tab-2"] .qt-dot')!.className).toContain('qt-dot-exited')
    expect(view.q('[data-tab="tab-1"] .qt-dot')!.className).toContain('qt-dot-running')
  })

  test('mounts only the panes of each group active tab, all as siblings in one container', async () => {
    const view = await mount()
    const panes = view.qa('[data-pane]')
    expect(panes.map((el) => el.dataset.pane).sort()).toEqual(['pane-2', 'pane-3', 'pane-4', 'pane-5'])
    for (const el of panes) expect(el.parentElement!.className).toBe('qt-panes')
    expect(terminals).toHaveLength(4)
  })

  test('positions panes from the pane tree and draws one divider per split', async () => {
    const view = await mount()
    const group1 = view.q('[data-group="grp-1"]')!
    const rect = (id: string) => {
      const style = group1.querySelector<HTMLElement>(`[data-pane="${id}"]`)!.style
      return [style.left, style.top, style.width, style.height]
    }
    expect(rect('pane-2')).toEqual(['0px', '0px', '500px', '600px'])
    expect(rect('pane-3')).toEqual(['500px', '0px', '500px', '300px'])
    expect(rect('pane-4')).toEqual(['500px', '300px', '500px', '300px'])
    expect(group1.querySelectorAll('[data-divider]')).toHaveLength(2)
  })

  test('only the active pane of the focused group shows its header', async () => {
    const view = await mount()
    const headers = view.qa('[data-pane-header]')
    expect(headers.map((el) => el.dataset.paneHeader)).toEqual(['pane-3'])
    expect(view.q('[data-pane="pane-3"]')!.dataset.active).toBe('true')
    expect(view.q('[data-pane="pane-2"]')!.dataset.active).toBe('false')
  })

  test('an expanded pane fills the tab and the others are not mounted', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].expandedPane = 'pane-3'
    const view = await mount(fakeDaemon(ws))
    const grp = view.q('[data-group="grp-1"]')!
    expect([...grp.querySelectorAll('[data-pane]')].map((el) => (el as HTMLElement).dataset.pane)).toEqual(['pane-3'])
    expect(grp.querySelector<HTMLElement>('[data-pane="pane-3"]')!.style.width).toBe('1000px')
    expect(terminals).toHaveLength(2)
  })

  test('panes of a non-active tab are not mounted', async () => {
    const view = await mount()
    expect(view.q('[data-pane="pane-1"]')).toBeNull()
  })

  test('groups share the width the divider leaves by the split ratio', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).ratio = 0.3
    const view = await mount(fakeDaemon(ws))
    const slots = ['grp-1', 'grp-2'].map((id) => view.q(`[data-group="${id}"]`)!.parentElement!.style)
    expect(slots.map((style) => [style.left, style.width])).toEqual([
      ['0px', '299px'],
      ['302px', '698px']
    ])
    expect(view.q<HTMLElement>('[data-group-divider="split-1"]')!.style.left).toBe('299px')
  })

  test('splitting the group tree keeps the terminals of the group that stays mounted', async () => {
    const ws = makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1')), tab('tab-2', pane('pane-2', 's-2'))]))
    const view = await mount(fakeDaemon(ws))
    const original = view.q('[data-pane="pane-1"]')
    expect(terminals).toHaveLength(1)
    await act(async () => view.controller().moveTabToSplit('tab-2', 'right', 'grp-1'))
    await settle()
    expect(view.qa('[data-group]')).toHaveLength(2)
    expect(view.q('[data-pane="pane-1"]')).toBe(original)
    expect(terminals).toHaveLength(2)
  })

  test('a missing worktree input shows the muted pick text and reports an empty view', async () => {
    const view = await mount(fakeDaemon(simpleWorkspace()), { input: {} })
    expect(view.element.textContent).toBe('Pick a worktree to see its sessions.')
    expect(view.last()).toEqual({ worktree: null, tabs: [], active: null, visibleSessions: [] })
    expect(view.fake.callsTo('quirky.terminal/workspace')).toHaveLength(0)
  })

  test('a worktree the daemon does not know shows a not-found line', async () => {
    const daemon = fakeDaemon(simpleWorkspace())
    daemon.handlers['quirky.terminal/workspace'] = () => {
      throw Object.assign(new Error('no worktree'), { code: -32004 })
    }
    const view = await mount(daemon)
    expect(view.element.textContent).toContain('Worktree not found')
  })

  test('a structured session pane mounts the structured view instead of a terminal', async () => {
    const ws = makeWorkspace(group('grp-1', [tab('tab-1', paneSplit('split-1', 'right', pane('pane-1', 's-1'), pane('pane-2', 's-2')))]))
    const daemon = fakeDaemon(ws, { sessions: [session('s-1'), session('s-2', { kind: 'structured', agent: 'claude' })] })
    const view = await mount(daemon)
    expect(view.fake.mountedViews.map((entry) => [entry.viewId, entry.input])).toEqual([['view:quirky.session/structured', { session: 's-2' }]])
    expect(view.fake.mountedViews[0]!.element.isConnected).toBe(true)
    expect(terminals).toHaveLength(1)
    expect(view.q('[data-pane="pane-2"]')!.querySelector('.xterm')).toBeNull()
  })

  test('switching away from a structured pane unmounts its view', async () => {
    const ws = makeWorkspace(
      group('grp-1', [tab('tab-1', pane('pane-1', 's-2')), tab('tab-2', pane('pane-2', 's-1'))], { activeTab: 'tab-1' })
    )
    const daemon = fakeDaemon(ws, { sessions: [session('s-1'), session('s-2', { kind: 'structured', agent: 'claude' })] })
    const view = await mount(daemon)
    expect(view.fake.mountedViews[0]!.unmounted).toBe(false)
    await act(async () => void view.daemon.set({ ...view.daemon.workspace, root: { ...(ws.root as any), activeTab: 'tab-2' } }))
    await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: view.daemon.workspace.revision } })
    await settle()
    expect(view.fake.mountedViews[0]!.unmounted).toBe(true)
  })

  test('the exited pane overlay names the exit code and offers Close and Restart', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].root.second.second.exit = { code: 3, signal: null }
    const view = await mount(fakeDaemon(ws))
    const overlay = view.q('[data-exit-overlay="pane-4"]')!
    expect(overlay.textContent).toContain('Terminal exited')
    expect(overlay.textContent).toContain('The shell process ended with exit code 3. Its output is preserved.')
    expect([...overlay.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close', 'Restart'])
  })

  test('an accessory whose view renders nothing leaves its chrome empty so CSS can hide it over the prompt', async () => {
    const view = await mount(fakeDaemon(simpleWorkspace()), { extra: accessoryHandlers() })
    await settle()

    const accessory = view.q(`[data-terminal-accessory="${ACCESSORY_ID}"]`)!
    expect(accessory.classList.contains('qt-pane-accessory')).toBe(true)
    expect(view.fake.mountedViews.map(({ element }) => element)).toContain(accessory)
    expect(accessory.childNodes).toHaveLength(0)
  })

  test('shares discovery across four panes and keeps each accessory mounted on an equal refresh', async () => {
    const view = await mount(fakeDaemon(conceptualWorkspace()), { extra: accessoryHandlers() })
    await settle()

    expect(view.fake.callsTo('plugin.contributions')).toHaveLength(1)
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(1)
    expect(view.fake.mountedViews.map(({ input }) => input)).toEqual([
      { sessionId: 's-2', paneId: 'pane-2' },
      { sessionId: 's-3', paneId: 'pane-3' },
      { sessionId: 's-4', paneId: 'pane-4' },
      { sessionId: 's-5', paneId: 'pane-5' }
    ])
    expect(view.last().mountedAccessories).toEqual({
      'pane-2': [ACCESSORY_ID],
      'pane-3': [ACCESSORY_ID],
      'pane-4': [ACCESSORY_ID],
      'pane-5': [ACCESSORY_ID]
    })
    const originalElements = view.fake.mountedViews.map(({ element }) => element)

    await view.fake.emit({ type: 'plugin.changed' })
    await settle()

    expect(view.fake.callsTo('plugin.contributions')).toHaveLength(2)
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(2)
    expect(view.fake.mountedViews).toHaveLength(4)
    expect(view.fake.mountedViews.map(({ element }) => element)).toEqual(originalElements)
    expect(view.fake.mountedViews.every(({ unmounted }) => !unmounted)).toBe(true)
  })

  test('retains the catalog while switching panes and unmounts views removed from the pane tree', async () => {
    const ws = makeWorkspace(
      group(
        'grp-1',
        [
          tab('tab-1', paneSplit('split-1', 'right', pane('pane-1', 's-1'), pane('pane-2', 's-2'))),
          tab('tab-2', pane('pane-3', 's-3'))
        ],
        { activeTab: 'tab-1' }
      )
    )
    const view = await mount(fakeDaemon(ws), { extra: accessoryHandlers() })
    await settle()
    expect(view.fake.callsTo('plugin.contributions')).toHaveLength(1)
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(1)
    expect(view.fake.mountedViews.map(({ input }) => input)).toEqual([
      { sessionId: 's-1', paneId: 'pane-1' },
      { sessionId: 's-2', paneId: 'pane-2' }
    ])
    const firstTabMounts = [...view.fake.mountedViews]

    await act(async () => view.controller().activateTab('tab-2'))
    await settle()
    expect(firstTabMounts.every(({ unmounted }) => unmounted)).toBe(true)
    expect(view.fake.mountedViews.at(-1)?.input).toEqual({ sessionId: 's-3', paneId: 'pane-3' })
    expect(view.last().mountedAccessories).toEqual({ 'pane-3': [ACCESSORY_ID] })

    await act(async () => view.controller().activateTab('tab-1'))
    await settle()
    expect(view.fake.callsTo('plugin.contributions')).toHaveLength(1)
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(1)
    expect(view.fake.mountedViews.at(-2)?.input).toEqual({ sessionId: 's-1', paneId: 'pane-1' })
    expect(view.fake.mountedViews.at(-1)?.input).toEqual({ sessionId: 's-2', paneId: 'pane-2' })
    expect(view.fake.mountedViews[2]?.unmounted).toBe(true)
    expect(view.last().mountedAccessories).toEqual({
      'pane-1': [ACCESSORY_ID],
      'pane-2': [ACCESSORY_ID]
    })
  })

  test('an initial workspace wait is a shared status notice and disappears on success', async () => {
    const daemon = fakeDaemon(simpleWorkspace())
    const { promise, resolve: release } = Promise.withResolvers<unknown>()
    daemon.handlers['quirky.terminal/workspace'] = () => promise
    const view = await mount(daemon)
    expect(view.q('[role="status"] .ui-notice-line')?.textContent).toBe('Loading workspace…')
    expect(view.q('.ui-empty-state, .ui-inline-error')).toBeNull()
    await act(async () => release({ workspace: daemon.workspace }))
    await settle()
    expect(view.q('[data-workspace="wt-main"]')).not.toBeNull()
    expect(view.q('[role="status"] .ui-notice-line')).toBeNull()
  })

  test('initial workspace rejection is one shared error rather than empty content', async () => {
    const daemon = fakeDaemon(simpleWorkspace())
    daemon.handlers['quirky.terminal/workspace'] = () => { throw new Error('offline') }
    const view = await mount(daemon)
    expect(view.q('.ui-inline-error')?.textContent).toContain('Could not load the workspace')
    expect(view.q('.ui-empty-state')).toBeNull()
    expect(view.fake.toasts).toEqual([{ title: 'Could not load the workspace', body: 'offline' }])
  })

  test('a pane awaiting its listed session has a pane-scoped shared notice', async () => {
    const view = await mount(fakeDaemon(simpleWorkspace(), { sessions: [] }))
    expect(view.q('[data-pane="pane-1"] [role="status"] .ui-notice-line')?.textContent).toBe('Loading session…')
    expect(view.q('[data-pane="pane-1"] .ui-inline-error')).toBeNull()
  })

  for (const [exit, text] of [
    [{ code: 0, signal: null }, 'The shell process ended with exit code 0. Its output is preserved.'],
    [{ code: null, signal: 'SIGTERM' }, 'The shell process ended with signal SIGTERM. Its output is preserved.'],
    [{ code: null, signal: null }, 'The shell process ended. Its output is preserved.']
  ] as const) {
    test(`exit outcome uses a shared informational notice: ${text}`, async () => {
      const ws = simpleWorkspace()
      if (ws.root.kind !== 'group' || !ws.root.tabs[0] || ws.root.tabs[0].kind === 'view') throw new Error('expected a terminal fixture')
      ws.root.tabs[0].root = pane('pane-1', 's-1', { exit })
      const view = await mount(fakeDaemon(ws))
      const overlay = view.q('[data-exit-overlay="pane-1"]')!
      expect(overlay.getAttribute('role')).toBe('alert')
      expect(overlay.querySelector('.ui-notice-line')?.textContent).toBe(text)
      expect(overlay.querySelector('.ui-inline-error')).toBeNull()
      expect([...overlay.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Close', 'Restart'])
    })
  }

  test.each(['structured', 'hosted', 'accessory'])('synchronous %s mount failure is a shared error outside its mount node', async (kind) => {
    const ws = kind === 'hosted'
      ? makeWorkspace(group('grp-1', [{ kind: 'view', id: 'view-tab', viewId: 'view:test/detail', key: 'detail', title: 'Detail', color: 'none', pinned: false, preview: false, createdAt: '2026-11-14T00:00:00Z' }]))
      : simpleWorkspace()
    const daemon = fakeDaemon(ws, { sessions: [session('s-1', kind === 'structured' ? { kind: 'structured', agent: 'codex' } : {})] })
    const { promise, resolve } = Promise.withResolvers<unknown>()
    daemon.handlers['quirky.terminal/workspace'] = () => promise
    const view = await mount(daemon, { extra: kind === 'accessory' ? accessoryHandlers() : {} })
    const mountNodes: HTMLElement[] = []
    view.fake.context.mountView = (_id, element) => {
      mountNodes.push(element)
      throw new Error(kind === 'accessory' ? 'accessory refused' : 'mount refused')
    }
    await act(async () => resolve({ workspace: daemon.workspace }))
    await settle()
    await settle()
    const expected = kind === 'structured' ? 'Could not open structured session: mount refused' : kind === 'accessory' ? 'Could not open Account: accessory refused' : 'mount refused'
    const failure = kind === 'accessory' ? view.q('[data-terminal-accessory-failure] .ui-inline-error') : view.q('.qt-structured .ui-inline-error')
    expect(failure?.textContent).toBe(expected)
    expect(mountNodes.length).toBeGreaterThan(0)
    expect(mountNodes.every((element) => element.querySelector('.ui-inline-error') === null)).toBe(true)
    if (kind === 'accessory') expect(terminals).toHaveLength(1)
  })

  test.each([true, false])('hosted input failure recovers with mount cleanup preserved (updateInput=%s)', async (supportsUpdate) => {
    const hosted = { kind: 'view' as const, id: 'view-tab', viewId: 'view:test/detail', key: 'detail', title: 'Detail', color: 'none' as const, pinned: false, preview: false, input: { revision: 1 }, createdAt: '2026-11-14T00:00:00Z' }
    const daemon = fakeDaemon(makeWorkspace(group('grp-1', [hosted])))
    const { promise, resolve } = Promise.withResolvers<unknown>()
    let initialRead = true
    daemon.handlers['quirky.terminal/workspace'] = () => initialRead ? promise : { workspace: daemon.workspace }
    const view = await mount(daemon)
    let refuse = false
    let mounts = 0
    let cleanups = 0
    const updates: unknown[] = []
    view.fake.context.mountView = () => {
      mounts++
      if (refuse) throw new Error('update refused')
      const cleanup = () => { cleanups++ }
      return supportsUpdate ? Object.assign(cleanup, {
        updateInput: (input: unknown) => {
          updates.push(input)
          if (refuse) throw new Error('update refused')
          return true
        }
      }) : cleanup
    }
    await act(async () => resolve({ workspace: daemon.workspace }))
    await settle()
    initialRead = false
    const changeInput = async (revision: number) => {
      const ws = daemon.workspace
      daemon.set({ ...ws, root: group('grp-1', [{ ...hosted, input: { revision } }]) })
      await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: daemon.workspace.revision } })
      await settle()
    }
    refuse = true
    await changeInput(2)
    expect(view.q('[data-hosted-view="view-tab"] .ui-inline-error')?.textContent).toBe('update refused')
    refuse = false
    await changeInput(3)
    expect(view.q('[data-hosted-view="view-tab"] .ui-inline-error')).toBeNull()
    expect(mounts).toBe(supportsUpdate ? 1 : 3)
    expect(cleanups).toBe(supportsUpdate ? 0 : 1)
    if (supportsUpdate) expect(updates).toEqual([{ revision: 2, tabId: 'view-tab' }, { revision: 3, tabId: 'view-tab' }])
    await view.unmount()
    mounted = null
    expect(cleanups).toBe(supportsUpdate ? 1 : 2)
  })

  test.each([false, true])('selection failure is one shared alert and recovers without adoption (wrong worktree=%s)', async (wrongWorktree) => {
    const daemon = fakeDaemon(simpleWorkspace())
    const view = await mount(daemon, {
      input: { worktree: 'wt-main', session: 'missing' },
      extra: {
        'quirky.session/get': () => {
          if (!wrongWorktree) throw notFound('missing session')
          return session('missing', { worktreeId: 'wt-other' })
        }
      }
    })
    const error = view.q('.ui-inline-error')!
    expect(error.textContent).toBe(wrongWorktree ? 'Session missing belongs to a different worktree.' : 'Session missing was not found.')
    expect(view.qa('[role="alert"]')).toHaveLength(1)
    expect(error.parentElement?.closest('[role="alert"]')).toBeNull()
    expect(view.q('.ui-empty-state')).toBeNull()
    expect(view.fake.callsTo('quirky.terminal/adoptSession')).toEqual([])
    await view.updateInput({ worktree: 'wt-main' })
    await settle()
    expect(error.isConnected).toBe(false)
    expect(view.controller().getSnapshot().selectionError).toBeNull()
    expect(view.q('[data-workspace="wt-main"]')).not.toBeNull()
  })
})


test.each([
  { metaKey: true, isComposing: false, keyCode: 13 },
  { ctrlKey: true, isComposing: false, keyCode: 13 },
  { metaKey: true, isComposing: true, keyCode: 13 },
  { ctrlKey: true, isComposing: false, keyCode: 229 }
])('prompt shortcut normalizes Enter without duplicate or composing submissions: %j', async (init) => {
  const { PromptDialog } = await import('../../src/window/workspace/PromptDialog')
  // React's DOM feature detection needs the installed test window.
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const submissions: string[] = []
  try {
    await act(async () => root.render(createElement(PromptDialog, {
      request: { agent: 'codex', background: false, label: 'Codex' },
      pending: false, started: false, error: null,
      onSubmit: (prompt: string) => submissions.push(prompt), onClose: () => {}
    })))
    const input = host.querySelector('textarea')!
    await typeText(input, ' review the diff ')
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    await fire(input, event)
    const composing = init.isComposing || init.keyCode === 229
    expect(submissions).toEqual(composing ? [] : [' review the diff '])
    if (!composing) expect(event.defaultPrevented).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

test.each([
  { pending: true, started: false, error: 'stale error', notice: 'Starting session…' },
  { pending: true, started: true, error: 'stale error', notice: 'Opening session…' },
  { pending: false, started: false, error: 'start refused', notice: null }
] as const)('prompt progress and failure share components exclusively: %j', async (state) => {
  // React's DOM feature detection needs the installed test window.
  const { createRoot } = await import('react-dom/client')
  const { PromptDialog } = await import('../../src/window/workspace/PromptDialog')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(PromptDialog, {
      request: { agent: 'codex', background: true, label: 'Codex' },
      ...state, onSubmit: () => {}, onClose: () => {}
    })))
    if (state.pending) {
      expect(host.querySelector('[role="status"] .ui-notice-line')?.textContent).toBe(state.notice)
      expect(host.querySelector('.ui-inline-error')).toBeNull()
      expect(host.querySelector('textarea')?.readOnly).toBe(true)
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    } else {
      expect(host.querySelector('.ui-inline-error')?.textContent).toBe(state.error)
      expect(host.querySelector('[role="status"]')).toBeNull()
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
