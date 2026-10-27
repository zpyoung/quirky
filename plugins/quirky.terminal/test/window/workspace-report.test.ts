import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import {
  callsTo,
  click,
  conceptualWorkspace,
  fakeDaemon,
  group,
  makeWorkspace,
  pane,
  paneSplit,
  tab,
  loadWorkspace,
  mountFixture,
  session,
  settle,
  startRecording,
  stopRecording,
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

describe('SC-3: the view reports what the window shows', () => {
  test('keeps the v1 fields and adds layout, focusedPane, panes, accessory IDs, menu and dialog', async () => {
    const view = await mount()
    const report = view.last()
    expect(Object.keys(report).sort()).toEqual([
      'active',
      'dialog',
      'focusedPane',
      'layout',
      'menu',
      'mountedAccessories',
      'panes',
      'tabs',
      'visibleSessions',
      'worktree'
    ])
    expect(report.mountedAccessories).toEqual({})
    expect(report.active).toBe('s-3')
    expect(report.focusedPane).toBe('pane-3')
    expect(report.menu).toBeNull()
    expect(report.dialog).toBeNull()
    expect(report.layout.revision).toBe(5)
    expect(report.layout.id).toBe('wt-main')
  })

  test('tabs lists one entry per pane of every tab in visual order', async () => {
    const view = await mount()
    expect(view.last().tabs.map((entry: any) => [entry.session, entry.tab, entry.group, entry.pane])).toEqual([
      ['s-1', 'tab-1', 'grp-1', 'pane-1'],
      ['s-2', 'tab-2', 'grp-1', 'pane-2'],
      ['s-3', 'tab-2', 'grp-1', 'pane-3'],
      ['s-4', 'tab-2', 'grp-1', 'pane-4'],
      ['s-5', 'tab-3', 'grp-2', 'pane-5']
    ])
    expect(view.last().tabs[0]).toEqual({ session: 's-1', title: 'Terminal 1', agent: 'shell', status: 'running', tab: 'tab-1', group: 'grp-1', pane: 'pane-1' })
    expect(view.last().tabs[1].title).toBe('Build')
  })

  test('panes lists the mounted panes with the size and font each reports', async () => {
    const view = await mount()
    const panes = view.last().panes
    expect(panes.map((entry: any) => entry.pane).sort()).toEqual(['pane-2', 'pane-3', 'pane-4', 'pane-5'])
    const three = panes.find((entry: any) => entry.pane === 'pane-3')
    expect(three.session).toBe('s-3')
    expect(three.fontSize).toBe(14)
    expect(three.cols).toBeGreaterThan(0)
    expect(three.rows).toBeGreaterThan(0)
    expect(three).toMatchObject({ webgl: false, search: null, exitOverlay: false })
  })

  test('a pane search shows up in the pane entry', async () => {
    const view = await mount()
    await act(async () => view.controller().search('19'))
    await settle()
    const three = view.last().panes.find((entry: any) => entry.pane === 'pane-3')
    expect(three.search).toMatchObject({ query: '19', regex: false, caseSensitive: false })
  })

  test('a pane with an exit overlay says so', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].root.second.second.exit = { code: 3, signal: null }
    const view = await mount(fakeDaemon(ws))
    expect(view.last().panes.find((entry: any) => entry.pane === 'pane-4').exitOverlay).toBe(true)
  })

  test('clicking a tab of another group activates it by ID', async () => {
    const view = await mount()
    await click(view.q('[data-tab="tab-3"]'))
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-3' }])
  })

  test('is sent again only when something in it changes', async () => {
    const view = await mount()
    const count = view.reports.length
    await view.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/divider-thickness', value: 3 })
    await settle()
    expect(view.reports.length).toBe(count)
    const exited = session('s-3', { status: 'exited' })
    view.daemon.sessions.splice(view.daemon.sessions.findIndex((entry) => entry.id === 's-3'), 1, exited)
    await view.fake.emit({ type: 'quirky.session/changed', data: { session: exited } })
    await settle()
    expect(view.last().tabs.find((entry: any) => entry.session === 's-3').status).toBe('exited')
    expect(view.reports.length).toBe(count + 1)
  })
})

describe('refreshing from the daemon', () => {
  test('re-fetches on a layout event for its workspace with a newer revision', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    const next = view.daemon.set(view.daemon.workspace)
    await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: next.revision } })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
    expect(view.last().layout.revision).toBe(next.revision)
  })

  test('drops layout events at or below the revision it holds, and other workspaces', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: 5 } })
    await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: 4 } })
    await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-other', revision: 99 } })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before)
  })

  test('an event for the revision a call just returned does not fetch again', async () => {
    const view = await mount()
    await click(view.q('[data-tab="tab-3"]'))
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: view.daemon.workspace.revision } })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before)
  })

  test('reloads after a reconnect', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.setConnection('reconnecting')
    await view.fake.setConnection('connected')
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
  })

  test('a removed session drops out of the session map', async () => {
    const view = await mount()
    await view.fake.emit({ type: 'quirky.session/changed', data: { session: session('s-3', { status: 'exited' }) } })
    await view.fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's-3' } })
    await settle()
    expect(view.last().tabs.find((entry: any) => entry.session === 's-3').status).toBe('running')
  })

  test('applies a changed setting and re-fetches the workspace', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/font-size', value: 18 })
    await settle()
    expect(view.last().panes[0].fontSize).toBe(18)
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
  })

  test('another plugin setting does not re-fetch the workspace', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.emit({ type: 'setting.changed', id: 'setting:quirky.other/font-size', value: 18 })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before)
  })

  test('a changed session of the workspace re-fetches the workspace', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.emit({ type: 'quirky.session/changed', data: { session: session('s-3', { status: 'working' }) } })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
    await view.fake.emit({ type: 'quirky.session/changed', data: { session: session('s-9', { worktreeId: 'wt-other' }) } })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
  })

  test('a removed session of the workspace re-fetches the workspace', async () => {
    const view = await mount()
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await view.fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's-3' } })
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
  })

  test('a failed session lookup keeps the session metadata it already has', async () => {
    const ws = makeWorkspace(group('grp-1', [tab('tab-1', paneSplit('split-1', 'right', pane('pane-1', 's-1'), pane('pane-2', 's-2')))]))
    const daemon = fakeDaemon(ws, { sessions: [session('s-1'), session('s-2', { kind: 'structured', agent: 'claude' })] })
    let failing = false
    const view = await mount(daemon, {
      extra: {
        'quirky.session/list': () => {
          if (failing) throw new Error('daemon busy')
          return daemon.sessions
        }
      }
    })
    expect(view.fake.mountedViews).toHaveLength(1)
    failing = true
    await act(async () => view.controller().refresh())
    await settle()
    expect(view.fake.mountedViews).toHaveLength(1)
    expect(view.fake.mountedViews[0]!.unmounted).toBe(false)
    expect(view.q('[data-pane="pane-2"]')!.querySelector('.xterm')).toBeNull()
    expect(view.controller().getSnapshot().sessions['s-2']!.kind).toBe('structured')
  })
})
