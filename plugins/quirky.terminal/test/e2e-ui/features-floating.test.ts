import { afterEach, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import {
  FEATURE_MS,
  floatingReport,
  focusTerminal,
  focusedSession,
  groupsOf,
  layoutOf,
  leavesOf,
  press,
  restartDaemon,
  runCommand,
  startFeatures,
  stopAll,
  tabsOf,
  textareaOf,
  until,
  viewReport,
  waitFor,
  waitReady,
  type FloatingState,
  type Features
} from './features-support'

afterEach(stopAll)

const panel = () => document.querySelector<HTMLElement>('[data-floating-panel]')
const button = () => document.querySelector<HTMLElement>('[data-floating-button]')
const titlebar = () => document.querySelector<HTMLElement>('[data-floating-titlebar]')
const control = (label: string) => document.querySelector<HTMLButtonElement>(`[data-floating-panel] button[aria-label="${label}"]`)
const box = (element: HTMLElement) => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) })
const floatingState = (f: Features) => f.h.json<FloatingState>(['terminal', 'floating', 'state'])
const setFloatingCalls = (f: Features) => f.calls.filter((call) => call.method === 'quirky.terminal/setFloating')
const mouse = (type: string, init: MouseEventInit = {}) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })

/** A mouse drag by (dx, dy) from `element`: down on it, moves on the window, up on the window. */
async function drag(element: Element, dx: number, dy: number, from = { x: 500, y: 400 }): Promise<void> {
  element.dispatchEvent(mouse('mousedown', { clientX: from.x, clientY: from.y }))
  for (const step of [0.25, 0.5, 1]) window.dispatchEvent(mouse('mousemove', { clientX: from.x + dx * step, clientY: from.y + dy * step }))
  window.dispatchEvent(mouse('mouseup', { clientX: from.x + dx, clientY: from.y + dy }))
  await Bun.sleep(150)
}

const floatingTabs = async (f: Features) => tabsOf(await layoutOf(f.h, 'floating'))
/** The active tab of the floating workspace, which has one group. */
const activeFloatingTab = async (f: Features) => groupsOf(await layoutOf(f.h, 'floating'))[0]!.activeTab

test(
  'SC-55: opening the floating workspace',
  async () => {
    const f = await startFeatures()
    const { h } = f
    expect(panel()).toBeNull()
    await until(f, button)

    expect((await press('mod+alt+a')).defaultPrevented).toBe(true)
    await until(f, panel)
    const opened = await floatingReport(f, 'an open panel', (report) => report.shown)
    expect(opened.state).toMatchObject({ enabled: true, open: true, maximized: false })
    // 920x560, 24 px from the right and 84 px from the bottom of the window
    expect(box(panel()!)).toEqual({ x: window.innerWidth - 920 - 24, y: window.innerHeight - 560 - 84, width: 920, height: 560 })
    const empty = [...document.querySelectorAll('[data-floating-panel] .qt-empty button')].map((row) => row.textContent)
    expect(empty).toEqual(['New Terminal⌘T', 'Minimize⌘W'])
    expect(await h.ok(['terminal', 'floating', 'state'])).toMatch(/open: true\nmaximized: false\nbounds: default/)

    document.querySelector<HTMLButtonElement>('[data-floating-panel] .qt-empty button')!.click()
    const shown = await floatingReport(f, 'the first floating terminal', (report) => report.layout !== null && tabsOf(report.layout).length === 1 && report.panes.length === 1)
    const tab = tabsOf(shown.layout!)[0]!
    expect(tab.defaultTitle).toBe('Terminal 1')
    const session = leavesOf(tab.root)[0]!.session
    await waitReady(h, session)
    expect(realpathSync((await h.hostRow(session))!.cwd)).toBe(realpathSync(h.home))
    expect(await h.sessionRecord(session)).toMatchObject({ worktreeId: 'floating', kind: 'terminal' })
    expect(document.querySelector('[data-floating-panel] .qc-strip')).toBeNull()
    expect(document.querySelector('[data-floating-panel] .qt-tab-title')?.textContent).toBe('Terminal 1')
    expect(tabsOf(await layoutOf(h, f.worktree))).toHaveLength(1)

    // the CLI reaches the same state: hide, show, open another floating tab
    expect(await h.json<FloatingState>(['terminal', 'floating', 'hide'])).toMatchObject({ open: false })
    await waitFor('the panel to go', () => (panel() ? undefined : true))
    expect(await h.json<FloatingState>(['terminal', 'floating', 'show'])).toMatchObject({ open: true, maximized: false })
    await until(f, panel)
    await h.json(['terminal', 'tab', 'new', '--workspace', 'floating'])
    await floatingReport(f, 'a second floating terminal', (report) => report.layout !== null && tabsOf(report.layout).length === 2)
    expect([...document.querySelectorAll('[data-floating-panel] .qt-tab-title')].map((title) => title.textContent)).toEqual(['Terminal 1', 'Terminal 2'])
  },
  FEATURE_MS
)

test(
  'SC-56: maximize, minimize, move and resize',
  async () => {
    const f = await startFeatures()
    const { h } = f
    await press('mod+alt+a')
    await until(f, panel)

    // Maximize fills the window with a 12 px margin
    control('Maximize')!.click()
    await floatingReport(f, 'a maximized panel', (report) => report.state?.maximized === true)
    expect(box(panel()!)).toEqual({ x: 12, y: 12, width: window.innerWidth - 24, height: window.innerHeight - 24 })
    expect(await floatingState(f)).toMatchObject({ open: true, maximized: true })

    // Minimize hides it, and the key reopens it maximized
    control('Minimize')!.click()
    await waitFor('the panel to hide', () => (panel() ? undefined : true))
    expect(await floatingState(f)).toMatchObject({ open: false, maximized: true })
    await press('mod+alt+a')
    await until(f, panel)
    expect(await floatingState(f)).toMatchObject({ open: true, maximized: true })

    // Restore, then move by the title bar: one stored change when the drag ends
    control('Restore')!.click()
    await floatingReport(f, 'a restored panel', (report) => report.state?.maximized === false)
    const start = box(panel()!)
    const before = setFloatingCalls(f).length
    await drag(titlebar()!, -50, -40)
    await waitFor('the moved bounds', async () => ((await floatingState(f)).bounds?.x === start.x - 50 ? true : undefined))
    expect((await floatingState(f)).bounds).toEqual({ x: start.x - 50, y: start.y - 40, width: start.width, height: start.height })
    expect(setFloatingCalls(f)).toHaveLength(before + 1)
    expect(box(panel()!)).toEqual({ x: start.x - 50, y: start.y - 40, width: start.width, height: start.height })

    // an edge resizes it, never below 420x280, and also costs one stored change
    const resizes = setFloatingCalls(f).length
    await drag(document.querySelector('[data-edge="e"]')!, -2000, 0)
    await waitFor('the narrowest panel', async () => ((await floatingState(f)).bounds?.width === 420 ? true : undefined))
    await drag(document.querySelector('[data-edge="s"]')!, 0, -2000)
    await waitFor('the shortest panel', async () => ((await floatingState(f)).bounds?.height === 280 ? true : undefined))
    expect(setFloatingCalls(f)).toHaveLength(resizes + 2)
    expect((await floatingState(f)).bounds).toMatchObject({ width: 420, height: 280 })

    // the CLI maximizes, and Cmd+Option+Shift+A opens it maximized from hidden
    expect(await h.json<FloatingState>(['terminal', 'floating', 'hide'])).toMatchObject({ open: false })
    await waitFor('the panel to hide', () => (panel() ? undefined : true))
    await f.h.json<FloatingState>(['terminal', 'floating', 'restore'])
    await press('mod+alt+shift+a')
    await until(f, panel)
    expect(await floatingState(f)).toMatchObject({ open: true, maximized: true })
    await h.json(['terminal', 'floating', 'restore'])
    await waitFor('a restored panel', () => (panel()?.classList.contains('qf-maximized') ? undefined : true))
    expect(await h.json<FloatingState>(['terminal', 'floating', 'maximize'])).toMatchObject({ open: true, maximized: true })
    await waitFor('a maximized panel', () => (panel()?.classList.contains('qf-maximized') ? true : undefined))
    expect(box(panel()!)).toEqual({ x: 12, y: 12, width: window.innerWidth - 24, height: window.innerHeight - 24 })
  },
  FEATURE_MS
)

test(
  'SC-57: the floating workspace survives a relaunch',
  async () => {
    const f = await startFeatures()
    const { h } = f
    await h.json(['terminal', 'floating', 'show'])
    await h.json(['terminal', 'floating', 'maximize'])
    const opened = await h.json<{ workspace: { root: unknown } }>(['terminal', 'tab', 'new', '--workspace', 'floating'])
    expect(opened.workspace.root).toBeDefined()
    const floating = await floatingReport(f, 'a floating terminal', (report) => report.panes.length === 1)
    const session = floating.panes[0]!.session
    await waitReady(h, session)
    await h.run(session, 'echo still-here')
    await until(f, () => ([...f.terminals].some((term) => term.buffer.active.getLine(0) && term.element?.isConnected && term.element.closest('[data-floating-panel]')) ? true : undefined))

    await f.stopWindow()
    await restartDaemon(h)
    await f.startWindow()
    await until(f, panel)
    const back = await floatingReport(f, 'the panel back', (report) => report.shown && report.panes.length === 1 && report.panes[0]!.cols > 0)
    expect(back.state).toMatchObject({ open: true, maximized: true })
    expect(panel()!.classList.contains('qf-maximized')).toBe(true)
    expect(back.panes[0]!.session).toBe(session)
    await waitFor('the screen to be restored', () => {
      const term = f.terminals.find((candidate) => candidate.element?.isConnected && candidate.element.closest('[data-floating-panel]'))
      return term && Array.from({ length: term.buffer.active.length }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true)).includes('still-here') ? true : undefined
    })

    // saved bounds that no longer fit the window are pulled inside it
    await h.json(['terminal', 'floating', 'restore'])
    await h.json(['terminal', 'floating', 'bounds', '--x', '900', '--y', '700', '--width', '800', '--height', '500'])
    await f.stopWindow()
    await restartDaemon(h)
    await f.startWindow()
    await until(f, panel)
    expect(await floatingState(f)).toMatchObject({ open: true, maximized: false, bounds: { x: 900, y: 700, width: 800, height: 500 } })
    expect(box(panel()!)).toEqual({ x: window.innerWidth - 800, y: window.innerHeight - 500, width: 800, height: 500 })
    expect((await floatingTabs(f)).length).toBe(1)
  },
  FEATURE_MS
)

test(
  'SC-58: keys inside the floating panel',
  async () => {
    const f = await startFeatures()
    const { h } = f
    const mainSession = focusedSession(await viewReport(f, 'the main pane'))
    await focusTerminal(f, mainSession)
    await press('mod+alt+a')
    await until(f, panel)
    await waitFor('focus inside the panel', () => (panel()!.contains(document.activeElement) ? true : undefined))

    // Cmd+T opens a tab in the floating workspace and not the main view
    await press('mod+t')
    await waitFor('a floating tab', async () => ((await floatingTabs(f)).length === 1 ? true : undefined))
    expect(tabsOf(await layoutOf(h, f.worktree))).toHaveLength(1)
    const first = tabsOf(await layoutOf(h, 'floating'))[0]!
    await floatingReport(f, 'its pane', (report) => report.panes.length === 1 && report.panes[0]!.cols > 0)
    const firstSession = leavesOf(first.root)[0]!.session
    await waitFor('the floating terminal to have focus', () => (document.activeElement === textareaOf(f, firstSession) ? true : undefined))
    await waitReady(h, firstSession)

    await press('mod+t')
    await waitFor('a second floating tab', async () => ((await floatingTabs(f)).length === 2 ? true : undefined))
    const second = (await floatingTabs(f))[1]!
    await waitFor('the second tab active', async () => ((await activeFloatingTab(f)) === second.id ? true : undefined))
    await waitFor('focus in the second terminal', () => (panel()!.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA' ? true : undefined))

    // Cmd+1 selects the first tab of the floating workspace, not the main view's; the command does the same through the CLI
    await runCommand(f, 'command:quirky.session/select-tab-1')
    await waitFor('the first tab active through the command', async () => ((await activeFloatingTab(f)) === first.id ? true : undefined))
    await runCommand(f, 'command:quirky.session/select-tab-2')
    await waitFor('the second tab active again', async () => ((await activeFloatingTab(f)) === second.id ? true : undefined))
    await waitFor('focus in the second terminal again', () => (panel()!.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA' ? true : undefined))
    await press('mod+1')
    await waitFor('the first tab active', async () => ((await activeFloatingTab(f)) === first.id ? true : undefined))
    const mainGroup = groupsOf(await layoutOf(h, f.worktree))[0]!
    expect(mainGroup.tabs).toHaveLength(1)
    expect(mainGroup.activeTab).toBe(mainGroup.tabs[0]!.id)

    // Cmd+W closes the focused tab there, and closing the last one minimizes the panel
    await waitFor('focus in a floating terminal', () => (panel()!.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA' ? true : undefined))
    await press('mod+w')
    await waitFor('one floating tab left', async () => ((await floatingTabs(f)).length === 1 ? true : undefined))
    await waitFor('focus in the other terminal', () => (panel()!.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA' ? true : undefined))
    await press('mod+w')
    await waitFor('no floating tabs', async () => ((await floatingTabs(f)).length === 0 ? true : undefined))
    await waitFor('the panel to minimize', () => (panel() ? undefined : true))
    expect(await floatingState(f)).toMatchObject({ open: false })
    expect(tabsOf(await layoutOf(h, f.worktree))).toHaveLength(1)
  },
  FEATURE_MS
)

test(
  'SC-59: the floating button',
  async () => {
    const f = await startFeatures()
    const { h } = f
    const start = box(button()!)
    expect(start).toMatchObject({ x: window.innerWidth - 36 - 24, y: window.innerHeight - 36 - 72, width: 36, height: 36 })

    // dragging to another corner stores the place once, and a relaunch keeps it
    const before = setFloatingCalls(f).length
    await drag(button()!, -900, -600)
    await waitFor('the stored button place', async () => ((await floatingState(f)).button !== null ? true : undefined))
    const saved = (await floatingState(f)).button!
    expect(saved).toEqual({ x: start.x - 900, y: Math.max(8, start.y - 600) })
    expect(setFloatingCalls(f)).toHaveLength(before + 1)
    expect(panel()).toBeNull()
    expect(box(button()!)).toMatchObject(saved)

    await f.stopWindow()
    await restartDaemon(h)
    await f.startWindow()
    await until(f, button)
    expect(box(button()!)).toMatchObject(saved)

    // Hide Floating Workspace turns the setting off, which removes the button and the key
    button()!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))
    const hide = await until(f, () => [...document.querySelectorAll<HTMLElement>('.qt-menu-label')].find((label) => label.textContent === 'Hide Floating Workspace')?.closest('button'))
    hide.click()
    await waitFor('the button to go', () => (button() ? undefined : true))
    expect(await floatingState(f)).toMatchObject({ enabled: false })
    expect(JSON.parse(await h.ok(['setting', 'get', 'setting:quirky.terminal/floating-enabled', '--json'])).value).toBe(false)
    const refused = await runCommand(f, 'toggle-floating')
    expect(refused).toMatchObject({ ok: false })
    await press('mod+alt+a')
    await Bun.sleep(300)
    expect(panel()).toBeNull()
    expect(await floatingState(f)).toMatchObject({ open: false })

    await h.ok(['setting', 'set', 'setting:quirky.terminal/floating-enabled', 'true'])
    await until(f, button)
    expect(box(button()!)).toMatchObject(saved)
    await press('mod+alt+a')
    await until(f, panel)
  },
  FEATURE_MS
)
