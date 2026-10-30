import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { QuirkyEvent } from '@quirky/protocol'
import type { FloatingState, Workspace } from '../../src/layout/types'
import {
  click,
  conceptualWorkspace,
  fakeContext,
  fakeDaemon,
  fire,
  group,
  loadWorkspace,
  makeWorkspace,
  mouse,
  settle,
  startRecording,
  stopRecording,
  unloadWorkspace,
  type FakeContext
} from './workspace-support'

const OVERLAY = 'overlay:quirky.terminal/floating'
const VIEW = 'view:quirky.session/worktree'
const VIEWPORT = { width: 1400, height: 900 }

let ui: typeof import('../../src/ui')
let registry: typeof import('../../src/window/workspace/registry')
let mounted: { unmount(): Promise<void> }[] = []

type Overlay = Awaited<ReturnType<typeof mountOverlay>>

beforeAll(async () => {
  await loadWorkspace()
  ui = await import('../../src/ui')
  registry = await import('../../src/window/workspace/registry')
})
afterAll(unloadWorkspace)
beforeEach(() => {
  startRecording()
  ;(window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport(VIEWPORT)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {}, readText: async () => '' } })
})
afterEach(async () => {
  for (const entry of mounted.splice(0)) await entry.unmount()
  registry.setFloatingFocus(false)
  stopRecording()
  document.body.innerHTML = ''
})

const emptyFloating = (): Workspace => makeWorkspace(group('grp-1', []), { id: 'floating' })
const oneTab = (): Workspace => {
  const ws = conceptualWorkspace()
  return { ...ws, id: 'floating' }
}

type Options = {
  state?: Partial<FloatingState>
  floatingWorkspace?: Workspace
  withMain?: boolean
  settings?: Record<string, unknown>
  read?: () => unknown
}

/** Mounts the plugin's overlay (and, with `withMain`, the worktree view beside it) over fake daemons. */
async function mountOverlay(options: Options = {}) {
  const main = fakeDaemon(conceptualWorkspace())
  const floatingDaemon = fakeDaemon(options.floatingWorkspace ?? emptyFloating())
  let state: FloatingState = { enabled: true, open: false, maximized: false, bounds: null, button: null, ...options.state }
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const forWorkspace = (id: unknown) => (id === 'floating' ? floatingDaemon : main)
  const fake: FakeContext = fakeContext(
    {
      ...main.handlers,
      'quirky.terminal/workspace': (params) => ({ workspace: forWorkspace(params.workspace).current }),
      'quirky.terminal/newTab': (params) => ({ workspace: forWorkspace(params.workspace).current }),
      'quirky.terminal/activateTab': (params) => ({ workspace: forWorkspace(params.workspace).current }),
      'quirky.terminal/quickCommands': () => ({ commands: [] }),
      'quirky.worktree/resolve': () => ({ repoId: 'repo-1' }),
      'quirky.terminal/floating': () => (options.read ? options.read() : state),
      'quirky.terminal/focusContext': (params) => ({ workspace: params.workspace ?? null }),
      'quirky.terminal/setFloating': (params) => {
        state = { ...state, ...params }
        for (const listener of [...listeners]) listener({ type: 'quirky.terminal/floating', data: { state } } as never)
        return state
      }
    },
    options.settings
  )
  // the daemon announces a floating change to every window; the fake does it inside the call, as the daemon does
  const subscribe = fake.context.subscribe
  fake.context.subscribe = (listener) => {
    listeners.add(listener)
    const off = subscribe(listener)
    return () => {
      listeners.delete(listener)
      off()
    }
  }
  ui.activate(fake.context)
  const reports: any[] = []
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmount: (() => void) | void = undefined
  await act(async () => {
    unmount = fake.provided.get(OVERLAY)!(element, { report: (value: unknown) => void reports.push(value) }) as () => void
  })
  await settle()
  await settle()
  let unmountMain: (() => void) | void = undefined
  const mainElement = document.createElement('div')
  if (options.withMain) {
    document.body.appendChild(mainElement)
    fake.layout.worktree = 'wt-main'
    fake.layout.view = { id: VIEW, input: { worktree: 'wt-main' } }
    await act(async () => {
      unmountMain = fake.provided.get(VIEW)!(mainElement, { input: { worktree: 'wt-main' }, report: () => {} }) as () => void
    })
    await settle()
    await settle()
    // the main view's pane took focus when it mounted; the person then clicks into the panel
    await act(async () => void document.querySelector<HTMLElement>('[data-floating-panel]')?.focus())
  }
  const entry = {
    fake,
    element,
    reports,
    state: () => state,
    last: () => reports.at(-1),
    q: <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector),
    qa: <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)],
    calls: (method: string) => fake.callsTo(`quirky.terminal/${method}`).map((call) => call.params),
    run: async (id: string, prefix = 'quirky.terminal') => {
      let result: unknown
      await act(async () => void (result = await fake.provided.get(`command:${prefix}/${id}`)!()))
      await settle()
      return result
    },
    unmount: async () => {
      await act(async () => {
        ;(unmountMain as (() => void) | undefined)?.()
        ;(unmount as (() => void) | undefined)?.()
      })
      await settle()
    }
  }
  mounted.push(entry)
  return entry
}

const panel = (view: Overlay) => view.q('[data-floating-panel]')
const button = (view: Overlay) => view.q('[data-floating-button]')!
const at = (element: Element | null) => {
  const style = (element as HTMLElement).style
  return { x: parseFloat(style.left), y: parseFloat(style.top), width: parseFloat(style.width), height: parseFloat(style.height) }
}
const down = (target: Element, x: number, y: number) => fire(target, mouse('mousedown', { button: 0, clientX: x, clientY: y }))
const moveTo = (x: number, y: number) => fire(window, mouse('mousemove', { clientX: x, clientY: y }))
const release = (x: number, y: number) => fire(window, mouse('mouseup', { clientX: x, clientY: y }))

describe('SC-59: the floating button', () => {
  test('centers in the shell anchor and follows it when it moves', async () => {
    let rect = { left: 600, top: 700, width: 40, height: 40 }
    const anchor = document.createElement('div')
    anchor.setAttribute('data-overlay-button-anchor', '')
    anchor.getBoundingClientRect = () => rect as DOMRect
    document.body.append(anchor)
    const view = await mountOverlay()
    expect(at(button(view))).toMatchObject({ x: 602, y: 702 })

    rect = { left: 900, top: 600, width: 40, height: 40 }
    await fire(window, new Event('resize'))
    await settle()
    expect(at(button(view))).toMatchObject({ x: 902, y: 602 })
    expect(panel(view)).toBeNull()
  })

  test('sits where it was saved, pulled back inside the window', async () => {
    const view = await mountOverlay({ state: { button: { x: 300, y: 200 } } })
    expect(at(button(view))).toMatchObject({ x: 300, y: 200 })
    await view.unmount()
    const away = await mountOverlay({ state: { button: { x: 9000, y: 9000 } } })
    expect(at(button(away))).toMatchObject({ x: 1400 - 36 - 8 })
  })

  test('a click opens the panel and the next one minimizes it', async () => {
    const view = await mountOverlay()
    await click(button(view))
    expect(view.calls('setFloating')).toEqual([{ open: true }])
    expect(panel(view)).not.toBeNull()
    expect(button(view).getAttribute('aria-pressed')).toBe('true')
    await click(button(view))
    expect(view.calls('setFloating')).toEqual([{ open: true }, { open: false }])
    expect(panel(view)).toBeNull()
  })

  test('opening an empty floating panel does not report terminal focus', async () => {
    const view = await mountOverlay({ state: { open: true } })
    expect(panel(view)).not.toBeNull()
    expect(view.fake.contextValue('floatingFocus')).toBe(true)
    expect(view.calls('focusContext')).toEqual([])
  })

  test('focusing a floating terminal reports its workspace', async () => {
    const view = await mountOverlay({ state: { open: true }, floatingWorkspace: oneTab() })
    const textarea = view.q<HTMLTextAreaElement>('[data-pane="pane-3"] textarea.xterm-helper-textarea')!
    expect(document.activeElement).toBe(textarea)
    expect(view.calls('focusContext')).toEqual([{ workspace: 'floating' }])
  })

  test('dragging moves it with the mouse and stores the place once, on release', async () => {
    const view = await mountOverlay()
    const start = at(button(view))
    await down(button(view), start.x + 10, start.y + 10)
    await moveTo(start.x - 90, start.y - 190)
    expect(at(button(view))).toMatchObject({ x: start.x - 100, y: start.y - 200 })
    await moveTo(start.x - 190, start.y - 290)
    expect(view.calls('setFloating')).toEqual([])
    await release(start.x - 190, start.y - 290)
    expect(view.calls('setFloating')).toEqual([{ button: { x: start.x - 200, y: start.y - 300 } }])
    expect(at(button(view))).toMatchObject({ x: start.x - 200, y: start.y - 300 })
  })

  test('a drag does not also click, and a small wobble still does', async () => {
    const view = await mountOverlay()
    const start = at(button(view))
    await down(button(view), start.x, start.y)
    await moveTo(start.x - 60, start.y)
    await release(start.x - 60, start.y)
    await click(button(view))
    expect(view.calls('setFloating')).toEqual([{ button: { x: start.x - 60, y: start.y } }])
    expect(panel(view)).toBeNull()

    await down(button(view), 5, 5)
    await moveTo(7, 6)
    await release(7, 6)
    await click(button(view))
    expect(view.calls('setFloating')).toHaveLength(2)
    expect(view.calls('setFloating')[1]).toEqual({ open: true })
  })

  test('the button stays inside the window while dragged', async () => {
    const view = await mountOverlay()
    const start = at(button(view))
    await down(button(view), start.x, start.y)
    await moveTo(start.x + 5000, start.y + 5000)
    await release(start.x + 5000, start.y + 5000)
    expect(view.calls('setFloating')).toEqual([{ button: { x: 1400 - 36 - 8, y: 900 - 36 - 8 } }])
  })

  test('right-click offers Hide Floating Workspace, which turns the setting off', async () => {
    const view = await mountOverlay()
    await fire(button(view), mouse('contextmenu', { clientX: 1300, clientY: 800 }))
    const rows = document.querySelectorAll('[role="menuitem"]')
    expect([...rows].map((row) => row.textContent)).toEqual(['Hide Floating Workspace'])
    await click(rows[0]!)
    expect(view.fake.callsTo('setting.set').map((call) => call.params)).toEqual([{ id: 'setting:quirky.terminal/floating-enabled', value: false }])
  })


  test('a floating-state read answered after the setting turned the workspace off does not bring the button back', async () => {
    let finish: (state: FloatingState) => void = () => {}
    const view = await mountOverlay({ read: () => new Promise((resolve) => (finish = resolve as never)) })
    expect(view.q('[data-floating-button]')).toBeNull()
    await view.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/floating-enabled', value: false })
    await act(async () => finish({ enabled: true, open: false, maximized: false, bounds: null, button: null }))
    await settle()
    expect(view.q('[data-floating-button]')).toBeNull()
  })

  test('a floating-state read answered after a newer floating event does not replace it', async () => {
    let finish: (state: FloatingState) => void = () => {}
    const view = await mountOverlay({ read: () => new Promise((resolve) => (finish = resolve as never)) })
    const newer: FloatingState = { enabled: true, open: false, maximized: false, bounds: null, button: { x: 300, y: 200 } }
    await view.fake.emit({ type: 'quirky.terminal/floating', data: { state: newer } } as never)
    expect(at(button(view))).toMatchObject({ x: 300, y: 200 })
    await act(async () => finish({ ...newer, button: { x: 10, y: 10 } }))
    await settle()
    expect(at(button(view))).toMatchObject({ x: 300, y: 200 })
  })

  test('turning the setting off removes the button and the panel; turning it on brings them back', async () => {
    const view = await mountOverlay({ state: { open: true } })
    expect(panel(view)).not.toBeNull()
    await view.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/floating-enabled', value: false })
    expect(view.q('[data-floating-button]')).toBeNull()
    expect(panel(view)).toBeNull()
    expect(view.last()).toMatchObject({ shown: false })
    await view.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/floating-enabled', value: true })
    expect(view.q('[data-floating-button]')).not.toBeNull()
    expect(panel(view)).not.toBeNull()
  })

  test('with the workspace disabled from the start nothing is drawn', async () => {
    const view = await mountOverlay({ state: { enabled: false, open: true } })
    expect(view.q('[data-floating-button]')).toBeNull()
    expect(panel(view)).toBeNull()
    expect(view.last()).toMatchObject({ shown: false })
  })
})

describe('SC-55, SC-56: the panel', () => {
  test('opens 920x560, 24 px from the right and 84 px from the bottom, with its title bar and controls', async () => {
    const view = await mountOverlay({ state: { open: true } })
    expect(at(panel(view))).toEqual({ x: 1400 - 920 - 24, y: 900 - 560 - 84, width: 920, height: 560 })
    expect(view.q('[data-floating-titlebar]')!.textContent).toContain('Floating Workspace')
    expect(view.q('button[aria-label="Maximize"]')).not.toBeNull()
    expect(view.q('button[aria-label="Minimize"]')).not.toBeNull()
  })

  test('maximized it fills the window less 12 px, and its button says Restore', async () => {
    const view = await mountOverlay({ state: { open: true, maximized: true } })
    expect(at(panel(view))).toEqual({ x: 12, y: 12, width: 1376, height: 876 })
    expect(view.q('button[aria-label="Restore"]')).not.toBeNull()
    expect(view.q('button[aria-label="Maximize"]')).toBeNull()
  })

  test('saved bounds are used, and bounds that no longer fit are pulled inside', async () => {
    const saved = await mountOverlay({ state: { open: true, bounds: { x: 100, y: 120, width: 700, height: 500 } } })
    expect(at(panel(saved))).toEqual({ x: 100, y: 120, width: 700, height: 500 })
    await saved.unmount()
    const off = await mountOverlay({ state: { open: true, bounds: { x: 3000, y: -40, width: 700, height: 500 } } })
    expect(at(panel(off))).toEqual({ x: 700, y: 0, width: 700, height: 500 })
  })

  test('the window shrinking pulls the panel inside without storing anything', async () => {
    const view = await mountOverlay({ state: { open: true } })
    await act(async () => {
      ;(window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 800, height: 600 })
      window.dispatchEvent(new Event('resize'))
    })
    await settle()
    expect(at(panel(view))).toEqual({ x: 24, y: 12, width: 752, height: 504 })
    expect(view.calls('setFloating')).toEqual([])
  })

  test('Maximize, Restore and Minimize send one change each', async () => {
    const view = await mountOverlay({ state: { open: true } })
    await click(view.q('button[aria-label="Maximize"]'))
    expect(at(panel(view))).toMatchObject({ x: 12, y: 12 })
    await click(view.q('button[aria-label="Restore"]'))
    expect(at(panel(view))).toMatchObject({ x: 456, y: 256 })
    await click(view.q('button[aria-label="Minimize"]'))
    expect(view.calls('setFloating')).toEqual([{ maximized: true }, { maximized: false }, { open: false }])
    expect(panel(view)).toBeNull()
  })

  test('a double click on the title bar maximizes', async () => {
    const view = await mountOverlay({ state: { open: true } })
    await fire(view.q('[data-floating-titlebar]'), new MouseEvent('dblclick', { bubbles: true }))
    expect(view.calls('setFloating')).toEqual([{ maximized: true }])
  })

  test('dragging the title bar moves the panel locally and stores the bounds once, on release', async () => {
    const view = await mountOverlay({ state: { open: true } })
    const start = at(panel(view))
    await down(view.q('[data-floating-titlebar]')!, 600, 300)
    await moveTo(500, 250)
    expect(at(panel(view))).toEqual({ ...start, x: start.x - 100, y: start.y - 50 })
    await moveTo(450, 200)
    expect(view.calls('setFloating')).toEqual([])
    await release(450, 200)
    expect(view.calls('setFloating')).toEqual([{ bounds: { ...start, x: start.x - 150, y: start.y - 100 } }])
    expect(at(panel(view))).toEqual({ ...start, x: start.x - 150, y: start.y - 100 })
  })

  test('a click on the title bar without moving stores nothing', async () => {
    const view = await mountOverlay({ state: { open: true } })
    await down(view.q('[data-floating-titlebar]')!, 600, 300)
    await release(600, 300)
    expect(view.calls('setFloating')).toEqual([])
  })

  test('the title bar of a maximized panel does not drag', async () => {
    const view = await mountOverlay({ state: { open: true, maximized: true } })
    await down(view.q('[data-floating-titlebar]')!, 600, 300)
    await moveTo(300, 100)
    await release(300, 100)
    expect(at(panel(view))).toMatchObject({ x: 12, y: 12 })
    expect(view.calls('setFloating')).toEqual([])
    expect(view.qa('[data-edge]')).toHaveLength(0)
  })

  test('dragging an edge resizes locally and stores once; the minimum size holds', async () => {
    const view = await mountOverlay({ state: { open: true, bounds: { x: 200, y: 150, width: 600, height: 400 } } })
    const edge = (name: string) => view.q(`[data-edge="${name}"]`)!
    await down(edge('se'), 800, 550)
    await moveTo(850, 600)
    expect(at(panel(view))).toEqual({ x: 200, y: 150, width: 650, height: 450 })
    await release(850, 600)
    expect(view.calls('setFloating')).toEqual([{ bounds: { x: 200, y: 150, width: 650, height: 450 } }])

    await down(edge('nw'), 200, 150)
    await moveTo(900, 900)
    await release(900, 900)
    expect(view.calls('setFloating')[1]).toEqual({ bounds: { x: 430, y: 320, width: 420, height: 280 } })
  })

  test('the panes do not get a size per frame: the workspace is held dragging until release', async () => {
    const view = await mountOverlay({ state: { open: true, bounds: { x: 200, y: 150, width: 600, height: 400 } }, floatingWorkspace: oneTab() })
    const controller = registry.controllerFor('floating')!
    await down(view.q('[data-edge="e"]')!, 800, 300)
    await moveTo(850, 300)
    expect(controller.getSnapshot().dragging).toBe(true)
    await release(850, 300)
    expect(controller.getSnapshot().dragging).toBe(false)
  })
})

describe('SC-55: the workspace in the panel', () => {
  test('an empty floating workspace shows New Terminal and Minimize with their keys', async () => {
    const view = await mountOverlay({ state: { open: true } })
    expect(view.qa('.qt-empty button').map((row) => row.textContent)).toEqual(['New Terminal⌘T', 'Minimize⌘W'])
    expect(view.q('.qc-strip')).toBeNull()
  })

  test('New Terminal opens a tab in the floating workspace; Minimize hides the panel', async () => {
    const view = await mountOverlay({ state: { open: true } })
    await click(view.qa('.qt-empty button')[0]!)
    expect(view.calls('newTab')).toEqual([{ workspace: 'floating', group: 'grp-1' }])
    await click(view.qa('.qt-empty button')[1]!)
    expect(view.calls('setFloating')).toEqual([{ open: false }])
    expect(panel(view)).toBeNull()
  })

  test('the quick-command button is not drawn in its tab strip, and the panel closing unmounts the workspace', async () => {
    const view = await mountOverlay({ state: { open: true }, floatingWorkspace: oneTab() })
    expect(view.q('.qt-strip')).not.toBeNull()
    expect(view.q('.qc-strip')).toBeNull()
    expect(registry.controllerFor('floating')).not.toBeNull()
    await click(button(view))
    await settle()
    expect(registry.controllerFor('floating')).toBeNull()
  })
})

describe('SC-58: keys inside the panel', () => {
  test('floatingFocus is set while focus is inside the panel and cleared when it leaves', async () => {
    const view = await mountOverlay({ state: { open: true } })
    expect(view.fake.contextValue('floatingFocus')).toBe(true)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    await act(async () => void outside.focus())
    expect(view.fake.contextValue('floatingFocus')).toBe(false)
    const inside = view.qa('.qt-empty button')[0]!
    await act(async () => void inside.focus())
    expect(view.fake.contextValue('floatingFocus')).toBe(true)
    await click(button(view))
    expect(view.fake.contextValue('floatingFocus')).toBe(false)
  })

  test('the app keys act on the floating workspace while it holds focus, and on the main view otherwise', async () => {
    const view = await mountOverlay({ state: { open: true }, withMain: true })
    await view.run('new-shell', 'quirky.session')
    await view.run('select-tab-1', 'quirky.session')
    expect(view.calls('newTab')).toEqual([{ workspace: 'floating' }])
    expect(view.calls('activateTab')).toEqual([])

    const outside = document.createElement('input')
    document.body.appendChild(outside)
    await act(async () => void outside.focus())
    await view.run('new-shell', 'quirky.session')
    expect(view.calls('newTab')[1]).toEqual({ workspace: 'wt-main' })
  })

  test('close with no tabs left minimizes the panel', async () => {
    const view = await mountOverlay({ state: { open: true }, withMain: true })
    await view.run('close-session', 'quirky.session')
    expect(view.calls('setFloating')).toEqual([{ open: false }])
    expect(view.calls('closeTab')).toEqual([])
    expect(panel(view)).toBeNull()
  })

  test('close with a tab closes the focused pane or tab of the floating workspace', async () => {
    const view = await mountOverlay({ state: { open: true }, withMain: true, floatingWorkspace: oneTab() })
    await view.run('close-session', 'quirky.session')
    expect(view.calls('closePane')).toHaveLength(1)
    expect(view.calls('setFloating')).toEqual([])
  })

  test('the tab digits select within the floating workspace', async () => {
    const view = await mountOverlay({ state: { open: true }, withMain: true, floatingWorkspace: oneTab() })
    await view.run('select-tab-2', 'quirky.session')
    expect(view.calls('activateTab')).toEqual([{ workspace: 'floating', index: 2 }])
  })
})

describe('SC-67: the overlay report and its events', () => {
  test('reports shown, the state, and the workspace layout, focused pane and panes while open', async () => {
    const view = await mountOverlay({ state: { open: true }, floatingWorkspace: oneTab() })
    const report = view.last()
    expect(report.shown).toBe(true)
    expect(report.state).toMatchObject({ enabled: true, open: true, maximized: false, bounds: null })
    expect(report.layout).toMatchObject({ id: 'floating', activeGroup: 'grp-1' })
    expect(report.focusedPane).toBe('pane-3')
    expect(report.panes.map((entry: any) => entry.pane).sort()).toEqual(['pane-2', 'pane-3', 'pane-4', 'pane-5'])
  })

  test('visibleSessions lists the panes the open panel shows and none while minimized', async () => {
    const open = await mountOverlay({ state: { open: true }, floatingWorkspace: oneTab() })
    expect(open.last().visibleSessions).toEqual(['s-2', 's-3', 's-4', 's-5'])
    await open.unmount()
    const closed = await mountOverlay({ floatingWorkspace: oneTab() })
    expect(closed.last().visibleSessions).toEqual([])
  })

  test('reports shown false with no layout while minimized', async () => {
    const view = await mountOverlay()
    const report = view.last()
    expect(report.shown).toBe(false)
    expect(report.state).toMatchObject({ open: false })
    expect(report.layout).toBeNull()
    expect(report.focusedPane).toBeNull()
    expect(report.panes).toEqual([])
    expect(report.visibleSessions).toEqual([])
    expect(report.focused).toBe(false)
  })

  test('a floating event shows or hides the panel and refreshes the report', async () => {
    const view = await mountOverlay()
    const open: FloatingState = { enabled: true, open: true, maximized: true, bounds: null, button: null }
    await view.fake.emit({ type: 'quirky.terminal/floating', data: { state: open } } as never)
    expect(panel(view)).not.toBeNull()
    expect(at(panel(view))).toMatchObject({ x: 12, y: 12 })
    expect(view.last()).toMatchObject({ shown: true, state: open })
    await view.fake.emit({ type: 'quirky.terminal/floating', data: { state: { ...open, open: false } } } as never)
    expect(panel(view)).toBeNull()
    expect(view.last()).toMatchObject({ shown: false })
  })

  test('the state is read again after the connection comes back', async () => {
    const view = await mountOverlay()
    await view.fake.setConnection('reconnecting')
    await act(async () => void (await view.fake.context.call('quirky.terminal/setFloating', { open: true })))
    await view.fake.setConnection('connected')
    await settle()
    expect(panel(view)).not.toBeNull()
  })

  test('unmounting clears the focus key and leaves no workspace mounted', async () => {
    const view = await mountOverlay({ state: { open: true } })
    await view.unmount()
    expect(view.fake.contextValue('floatingFocus')).toBe(false)
    expect(registry.controllerFor('floating')).toBeNull()
    expect(document.querySelector('[data-floating-button]')).toBeNull()
    expect(document.querySelector('[data-floating-panel]')).toBeNull()
  })
})
