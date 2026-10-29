import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import {
  conceptualWorkspace,
  fakeDaemon,
  group,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  pane,
  paneSplit,
  session,
  settle,
  simpleWorkspace,
  startRecording,
  stopRecording,
  tab,
  terminals,
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
})

