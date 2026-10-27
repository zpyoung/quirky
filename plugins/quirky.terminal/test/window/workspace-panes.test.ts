import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { RpcErrorCode } from '@quirky/protocol'
import * as ops from '../../src/layout/ops'
import { sequentialIds } from '../../src/layout/tree'
import {
  callsTo,
  click,
  conceptualWorkspace,
  fakeDaemon,
  fire,
  loadWorkspace,
  mountFixture,
  mouse,
  pane,
  session,
  settle,
  simpleWorkspace,
  startRecording,
  stopRecording,
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

const move = (clientX: number, clientY: number, target: Element | Window = window) => fire(target, mouse('mousemove', { clientX, clientY }))
const up = (clientX: number, clientY: number, target: Element | Window = window) => fire(target, mouse('mouseup', { clientX, clientY }))
const paneWidth = (view: MountedWorkspace, id: string) => view.q<HTMLElement>(`[data-pane="${id}"]`)!.style.width
const dragging = (view: MountedWorkspace) => view.controller().getSnapshot().dragging

describe('SC-24: resizing a pane divider', () => {
  test('previews while dragging, marks the panes as dragging, and sends one resizeSplit at the end', async () => {
    const view = await mount()
    await fire(view.q('[data-divider="split-2"]'), mouse('mousedown', { button: 0, clientX: 500, clientY: 100 }))
    await move(400, 100)
    await move(300, 100)
    expect(paneWidth(view, 'pane-2')).toBe('300px')
    expect(dragging(view)).toBe(true)
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([])
    await up(300, 100)
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([{ split: 'split-2', ratio: 0.3, revision: 5 }])
    expect(dragging(view)).toBe(false)
  })

  test('the drag stops 50 px from either edge', async () => {
    const view = await mount()
    await fire(view.q('[data-divider="split-2"]'), mouse('mousedown', { button: 0 }))
    await move(10, 100)
    expect(paneWidth(view, 'pane-2')).toBe('50px')
    await up(10, 100)
    expect(callsTo(view.fake, 'resizeSplit')[0]).toMatchObject({ ratio: 0.05 })
    await fire(view.q('[data-divider="split-2"]'), mouse('mousedown', { button: 0 }))
    await move(995, 100)
    await up(995, 100)
    expect(callsTo(view.fake, 'resizeSplit')[1]).toMatchObject({ ratio: 0.95 })
  })

  test('a stacked divider uses the height of the area it splits', async () => {
    const view = await mount()
    await fire(view.q('[data-divider="split-3"]'), mouse('mousedown', { button: 0 }))
    await move(700, 150)
    await up(700, 150)
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([{ split: 'split-3', ratio: 0.25, revision: 5 }])
  })

  test('a press with no movement sends nothing', async () => {
    const view = await mount()
    await fire(view.q('[data-divider="split-2"]'), mouse('mousedown', { button: 0 }))
    await up(500, 100)
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([])
    expect(dragging(view)).toBe(false)
  })

  test('double-click returns the pair to 0.5', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].root.ratio = 0.3
    const view = await mount(fakeDaemon(ws))
    await fire(view.q('[data-divider="split-2"]'), mouse('dblclick'))
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([{ split: 'split-2', ratio: 0.5, revision: 5 }])
  })

  test('a pane divider is a labelled separator oriented across its split', async () => {
    const view = await mount()
    const divider = view.q('[data-divider="split-2"]')!
    expect(divider.getAttribute('role')).toBe('separator')
    expect(divider.getAttribute('aria-label')).toBe('Resize panes')
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(view.q('[data-divider="split-3"]')!.getAttribute('aria-orientation')).toBe('horizontal')
  })

  test('a stale revision refreshes the workspace and drops the preview', async () => {
    const view = await mount()
    view.daemon.fail('resizeSplit', RpcErrorCode.Conflict, 'workspace wt-main is at revision 7')
    const before = view.fake.callsTo('quirky.terminal/workspace').length
    await fire(view.q('[data-divider="split-2"]'), mouse('mousedown', { button: 0 }))
    await move(300, 100)
    await up(300, 100)
    await settle()
    expect(view.fake.callsTo('quirky.terminal/workspace').length).toBe(before + 1)
    expect(paneWidth(view, 'pane-2')).toBe('500px')
    expect(view.fake.toasts).toEqual([])
  })

  test('an applied resize shows the stored ratio', async () => {
    const view = await mount()
    await fire(view.q('[data-divider="split-2"]'), mouse('mousedown', { button: 0 }))
    await move(300, 100)
    await up(300, 100)
    expect(paneWidth(view, 'pane-2')).toBe('300px')
    expect(view.controller().getSnapshot().preview).toBeNull()
  })

  test('the divider thickness setting sets how thick dividers are drawn', async () => {
    const view = await mount(fakeDaemon(conceptualWorkspace()), { settings: { 'divider-thickness': 8 } })
    expect(view.q<HTMLElement>('[data-divider="split-2"]')!.style.width).toBe('8px')
    expect(view.q<HTMLElement>('[data-group-divider="split-1"]')!.style.width).toBe('8px')
  })
})

describe('SC-47: group dividers clamp', () => {
  test('dragging to 5% stops at 0.15', async () => {
    const view = await mount()
    await fire(view.q('[data-group-divider="split-1"]'), mouse('mousedown', { button: 0 }))
    await move(50, 100)
    expect(view.q('[data-group="grp-1"]')!.parentElement!.style.width).toBe('150px')
    await up(50, 100)
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([{ split: 'split-1', ratio: 0.15, revision: 5 }])
  })

  test('0.85 is the other limit', async () => {
    const view = await mount()
    await fire(view.q('[data-group-divider="split-1"]'), mouse('mousedown', { button: 0 }))
    await move(990, 100)
    await up(990, 100)
    expect(callsTo(view.fake, 'resizeSplit')).toEqual([{ split: 'split-1', ratio: 0.85, revision: 5 }])
  })

  test('the panes are marked as dragging during a group drag too', async () => {
    const view = await mount()
    await fire(view.q('[data-group-divider="split-1"]'), mouse('mousedown', { button: 0 }))
    await move(300, 100)
    expect(dragging(view)).toBe(true)
    await up(300, 100)
    expect(dragging(view)).toBe(false)
  })
})

describe('SC-26: moving a pane by its header', () => {
  const grip = (view: MountedWorkspace) => view.q('[data-pane-header] [aria-label="Move pane"]')!

  test('a tab with one pane offers no drag handle', async () => {
    const view = await mount(fakeDaemon(simpleWorkspace()))
    expect(view.q('[aria-label="Move pane"]')).toBeNull()
  })

  test('only 2+ panes show the handle, on the active pane header', async () => {
    const view = await mount()
    expect(view.qa('[aria-label="Move pane"]')).toHaveLength(1)
  })

  test('under 5 px of movement is not a drag', async () => {
    const view = await mount()
    await fire(grip(view), mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    await move(702, 102)
    expect(view.q('[data-drop-preview]')).toBeNull()
    await up(702, 102)
    expect(callsTo(view.fake, 'movePane')).toEqual([])
  })

  test('over the top edge of another pane it previews the top half and drops with movePane', async () => {
    const view = await mount()
    await fire(grip(view), mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    await move(250, 20)
    const preview = view.q<HTMLElement>('[data-drop-preview]')!
    expect([preview.style.left, preview.style.top, preview.style.width, preview.style.height]).toEqual(['0px', '0px', '500px', '300px'])
    await up(250, 20)
    expect(callsTo(view.fake, 'movePane')).toEqual([{ pane: 'pane-3', toPane: 'pane-2', edge: 'top' }])
    expect(view.q('[data-drop-preview]')).toBeNull()
  })

  test('the nearest edge decides: right edge of the left pane', async () => {
    const view = await mount()
    await fire(grip(view), mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    await move(490, 300)
    const preview = view.q<HTMLElement>('[data-drop-preview]')!
    expect([preview.style.left, preview.style.width]).toEqual(['250px', '250px'])
    await up(490, 300)
    expect(callsTo(view.fake, 'movePane')).toEqual([{ pane: 'pane-3', toPane: 'pane-2', edge: 'right' }])
  })

  test('dropping on the pane itself does nothing', async () => {
    const view = await mount()
    await fire(grip(view), mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    await move(750, 100)
    await up(750, 100)
    expect(callsTo(view.fake, 'movePane')).toEqual([])
  })

  test('dropping on another tab moves the pane into it', async () => {
    const view = await mount()
    const target = view.q('[data-tab="tab-1"]')!
    await fire(grip(view), mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    await move(40, 10, target)
    expect(target.className).toContain('qt-drop-target')
    await up(40, 10, target)
    expect(callsTo(view.fake, 'movePane')).toEqual([{ pane: 'pane-3', toTab: 'tab-1' }])
  })

  test('dropping on the pane own tab does nothing', async () => {
    const view = await mount()
    const own = view.q('[data-tab="tab-2"]')!
    await fire(grip(view), mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    await move(40, 10, own)
    await up(40, 10, own)
    expect(callsTo(view.fake, 'movePane')).toEqual([])
  })
})

describe('the pane header', () => {
  test('expand and collapse call expandPane', async () => {
    const view = await mount()
    await click(view.q('[data-pane-header] [aria-label="Expand pane"]'))
    expect(callsTo(view.fake, 'expandPane')).toEqual([{ pane: 'pane-3', expanded: true }])
    expect(view.q('[data-pane="pane-2"]')).toBeNull()
    expect(view.q('[data-pane-header] [aria-label="Collapse pane"]')).not.toBeNull()
    await click(view.q('[data-pane-header] [aria-label="Collapse pane"]'))
    expect(callsTo(view.fake, 'expandPane')[1]).toEqual({ pane: 'pane-3', expanded: false })
    expect(view.q('[data-pane="pane-2"]')).not.toBeNull()
  })

  test('the tab collapse icon collapses an expanded pane', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].expandedPane = 'pane-3'
    const view = await mount(fakeDaemon(ws))
    await click(view.q('[data-tab="tab-2"] [aria-label="Collapse expanded pane"]'))
    expect(callsTo(view.fake, 'expandPane')).toEqual([{ pane: 'pane-3', expanded: false }])
  })

  test('a lone pane has no expand button', async () => {
    const view = await mount(fakeDaemon(simpleWorkspace()))
    expect(view.q('[aria-label="Expand pane"]')).toBeNull()
  })

  test('clicking another pane focuses it once; clicking the active one sends nothing', async () => {
    const view = await mount()
    await fire(view.q('[data-pane="pane-3"] [data-terminal-pane]'), mouse('mousedown', { button: 0 }))
    expect(callsTo(view.fake, 'focusPane')).toEqual([])
    await fire(view.q('[data-pane="pane-2"] [data-terminal-pane]'), mouse('mousedown', { button: 0 }))
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-2' }])
    expect(view.last().focusedPane).toBe('pane-2')
    expect(view.q('[data-pane="pane-2"]')!.dataset.active).toBe('true')
  })

  test('a pane in another group takes focus and its group becomes active', async () => {
    const view = await mount()
    await fire(view.q('[data-pane="pane-5"] [data-terminal-pane]'), mouse('mousedown', { button: 0 }))
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-5' }])
    expect(view.last().active).toBe('s-5')
  })
})

describe('panes keep their terminal across a reshape', () => {
  function splittable() {
    const ids = sequentialIds(900)
    const daemon = fakeDaemon(conceptualWorkspace(), {
      transforms: {
        splitPane: (ws, params) => {
          const result = ops.splitPaneOp(ws, params.pane, params.direction, pane('pane-9', 's-9'), ids)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        }
      }
    })
    daemon.sessions.push(session('s-9'))
    return daemon
  }

  test('a split mounts only the new pane; the others keep their element and terminal', async () => {
    const view = await mount(splittable())
    const before = new Map(view.qa('[data-pane]').map((el) => [el.dataset.pane!, el]))
    const opened = terminals.length
    await act(async () => void view.controller().splitRight())
    await settle()
    expect(terminals.length).toBe(opened + 1)
    for (const [id, element] of before) {
      expect(view.q(`[data-pane="${id}"]`)).toBe(element)
      expect(element.isConnected).toBe(true)
    }
    expect(callsTo(view.fake, 'splitPane')).toEqual([{ pane: 'pane-3', direction: 'right' }])
    expect(view.q('[data-pane="pane-9"]')).not.toBeNull()
  })

  test('the new pane is the focused one and gets the header', async () => {
    const view = await mount(splittable())
    await act(async () => void view.controller().splitDown())
    await settle()
    expect(view.last().focusedPane).toBe('pane-9')
    expect(view.qa('[data-pane-header]').map((el) => el.dataset.paneHeader)).toEqual(['pane-9'])
  })

  test('moving a pane within its tab only moves its rectangle', async () => {
    const view = await mount()
    const element = view.q('[data-pane="pane-4"]')!
    const opened = terminals.length
    const before = [element.style.left, element.style.top]
    await act(async () => void view.controller().movePane('pane-4', { kind: 'edge', pane: 'pane-2', edge: 'left' }))
    await settle()
    expect(terminals.length).toBe(opened)
    expect(view.q('[data-pane="pane-4"]')).toBe(element)
    expect([element.style.left, element.style.top]).not.toEqual(before)
    expect(element.style.left).toBe('0px')
  })

  test('closing a sibling leaves the others mounted', async () => {
    const view = await mount()
    const element = view.q('[data-pane="pane-3"]')!
    const opened = terminals.length
    await act(async () => void view.controller().closePane('pane-4'))
    await settle()
    expect(terminals.length).toBe(opened)
    expect(view.q('[data-pane="pane-4"]')).toBeNull()
    expect(view.q('[data-pane="pane-3"]')).toBe(element)
    expect(element.style.height).toBe('600px')
  })

  test('a reconnect attaches the panes to their streams again', async () => {
    const view = await mount()
    const attaches = view.fake.callsTo('quirky.terminal/attach').length
    await view.fake.setConnection('reconnecting')
    await view.fake.setConnection('connected')
    await settle()
    expect(view.fake.callsTo('quirky.terminal/attach').length).toBe(attaches + 4)
  })
})

describe('activating a structured pane', () => {
  const structured = () => ({
    extra: { 'quirky.session/list': () => ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, { kind: 'structured' })) }
  })

  test('pressing the mouse on it focuses its pane and group', async () => {
    const view = await mount(fakeDaemon(conceptualWorkspace()), structured())
    expect(view.last().focusedPane).toBe('pane-3')
    await fire(view.q('[data-pane="pane-5"] .qt-structured-body'), mouse('mousedown', { button: 0 }))
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-5' }])
    expect(view.last().focusedPane).toBe('pane-5')
  })

  test('focus entering the embedded view focuses its pane', async () => {
    const view = await mount(fakeDaemon(conceptualWorkspace()), structured())
    const input = document.createElement('input')
    view.q('[data-pane="pane-5"] .qt-structured-body')!.append(input)
    await act(async () => input.focus())
    await settle()
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-5' }])
    expect(view.last().focusedPane).toBe('pane-5')
  })
})
