import { afterEach, expect, test } from 'bun:test'
import { cleanupUi, leavesOf, mouse, openTab, startUi, tabsOf, waitFor, WORKTREE_VIEW, type Ui, type Workspace } from './support'

const FLOATING_OVERLAY = 'overlay:quirky.terminal/floating'

type DockState = {
  pane: string
  session: string
  enabled: boolean
  supported: boolean
  agent: string | null
  docked: boolean
  mounted: boolean
  passthrough: boolean
  gutterRows: number
}

type DockPaneReport = { pane: string; dock?: DockState | null }
type DockViewReport = { focusedPane: string | null; menu: { kind: string; target: string | null; items: { label: string; key: string | null }[] } | null; panes: DockPaneReport[] }
type FocusedViewReport = {
  shown?: boolean
  focused?: boolean
  focusSequence?: number
  focusedPane?: string | null
  panes?: DockPaneReport[]
}

function paneReport(view: { panes: unknown[] } | undefined, pane: string): DockPaneReport | undefined {
  if (!view) return undefined
  const dockView = view as DockViewReport
  return dockView.panes.find((entry) => entry.pane === pane)
}

function dockFor(ui: Ui, pane: string): Promise<DockState> {
  return ui.h.call<DockState>('quirky.terminal-dock/get', { pane })
}

function waitForDock(ui: Ui, pane: string, session: string, check: (state: DockState) => boolean, what: string): Promise<DockState> {
  return waitFor(`dock for ${pane} to ${what}`, async () => {
    const state = await dockFor(ui, pane)
    return state.session === session && check(state) ? state : undefined
  })
}

function windowContext(ui: Ui): Map<string, boolean> {
  const host = ui.win.host as unknown as { contextValues: Map<string, boolean> }
  return host.contextValues
}

afterEach(cleanupUi)

test(
  'terminal host mounts the recognized agent dock, routes focus and menu actions, preserves pane focus, and applies hysteretic geometry',
  async () => {
    const ui = await startUi({ agents: ['claude'] })
    ui.win.setFocus(true)
    // Agent fixtures use a plain sh wrapper, whose shell-ready state is unsupported.
    const initialWorkspace = await ui.waitLayout('its initial terminal pane', (workspace) => tabsOf(workspace).length > 0)
    const shell = { pane: leavesOf(tabsOf(initialWorkspace)[0]!.root)[0]! }
    const shellBeforeEnable = await dockFor(ui, shell.pane.id)
    expect(shellBeforeEnable.enabled).toBe(false)

    await ui.h.ok(['setting', 'set', 'setting:quirky.terminal-dock/enabled', 'true'])
    await ui.contextMenu(`[data-pane="${shell.pane.id}"]`)
    const shellMenu = await ui.waitView('a plain shell context menu', (view) => view.menu?.kind === 'pane')
    expect(shellMenu.menu!.items.map((item) => item.label)).not.toContain('Show agent composer')
    await ui.run('close-menu')

    const agent = await openTab(ui.h, ['--agent', 'claude'], { ready: false })
    await ui.waitView('the recognized Claude pane', (view) => view.tabs.some((tab) => tab.session === agent.session && tab.agent === 'claude'))
    const requested = await waitForDock(ui, agent.pane.id, agent.session, (state) => state.enabled && state.supported && state.docked, 'to auto-open')
    expect(requested.gutterRows).toBe(5)

    const composer = await ui.el<HTMLElement>('.qtd-composer')
    const editor = await ui.el<HTMLTextAreaElement>('.qtd-editor')
    await waitForDock(ui, agent.pane.id, agent.session, (state) => state.mounted, 'to mount')
    await ui.waitView('the mounted dock report', (view) => paneReport(view, agent.pane.id)?.dock?.mounted === true)
    await waitFor('composer editor focus', () => ui.win.document.activeElement === editor ? true : undefined)
    await waitFor(
      'active dock context keys',
      () =>
        windowContext(ui).get('terminalDockEligible') === true &&
        windowContext(ui).get('terminalDockMounted') === true &&
        windowContext(ui).get('terminalDockFocus') === true
          ? true
          : undefined
    )
    expect(composer.classList.contains('qtd-passthrough')).toBe(false)
    expect(ui.win.document.activeElement).toBe(editor)
    expect(windowContext(ui).get('terminalDockEligible')).toBe(true)
    expect(windowContext(ui).get('terminalDockMounted')).toBe(true)
    expect(windowContext(ui).get('terminalDockFocus')).toBe(true)

    await ui.refit()
    const resizeCalls = ui.callsTo('resize').length
    await ui.fill(editor, 'Review **this**\nplease')
    await ui.refit()
    expect(ui.callsTo('resize')).toHaveLength(resizeCalls)

    await ui.contextMenu(`[data-pane="${agent.pane.id}"]`)
    const shownMenu = await ui.waitView('the recognized pane menu', (view) => view.menu?.kind === 'pane' && view.menu.target === agent.pane.id)
    const hideItem = shownMenu.menu!.items.find((item) => item.label === 'Hide agent composer')
    expect(hideItem?.key).toBe('⌘⇧K')
    await ui.pick('Hide agent composer')
    await ui.gone('.qtd-composer')
    const hidden = await waitForDock(ui, agent.pane.id, agent.session, (state) => !state.docked && !state.mounted, 'to close without losing recognition')
    expect(hidden.supported).toBe(true)
    const terminal = ui.term(agent.pane.id)!
    const terminalTextarea = terminal.textarea
    if (!terminalTextarea) throw new Error('Expected the terminal textarea to exist for focus assertions.')
    await waitFor('terminal focus after closing the dock', () => ui.win.document.activeElement === terminalTextarea ? true : undefined)

    await ui.contextMenu(`[data-pane="${agent.pane.id}"]`)
    const hiddenMenu = await ui.waitView('the closed dock menu item', (view) => view.menu?.kind === 'pane' && view.menu.target === agent.pane.id)
    expect(hiddenMenu.menu!.items.map((item) => item.label)).toContain('Show agent composer')
    await ui.pick('Show agent composer')
    const reopenedEditor = await ui.el<HTMLElement>('.qtd-editor')
    await waitForDock(ui, agent.pane.id, agent.session, (state) => state.docked && state.mounted, 'to reopen')
    await waitFor('reopened composer focus', () => ui.win.document.activeElement === reopenedEditor ? true : undefined)
    expect(ui.win.document.activeElement).toBe(reopenedEditor)

    const written = Promise.withResolvers<void>()
    terminal.write('selectable text\r\n', written.resolve)
    await written.promise
    terminal.select(0, 0, 'selectable'.length)
    const terminalHost = ui.q(`[data-terminal-pane="${agent.session}"]`)!
    terminalHost.dispatchEvent(mouse('mouseup', { bubbles: true }))
    await ui.settle()
    await waitFor('selection redirected to composer', () => ui.win.document.activeElement === reopenedEditor ? true : undefined)
    expect(terminal.getSelection()).toBe('selectable')
    expect(ui.win.document.activeElement).toBe(reopenedEditor)

    await ui.run('command:quirky.terminal-dock/passthrough', { pane: agent.pane.id })
    await ui.waitView('passthrough on the dock report', (view) => paneReport(view, agent.pane.id)?.dock?.passthrough === true)
    await waitFor('passthrough terminal focus', () => ui.win.document.activeElement === terminalTextarea ? true : undefined)
    expect((await ui.el<HTMLElement>('.qtd-composer')).classList.contains('qtd-passthrough')).toBe(true)
    expect(ui.win.document.activeElement).toBe(terminalTextarea)
    expect(windowContext(ui).get('terminalDockMounted')).toBe(true)
    expect(windowContext(ui).get('terminalDockFocus')).toBe(false)

    await ui.run('command:quirky.terminal-dock/passthrough', { pane: agent.pane.id })
    const activeEditor = await ui.el<HTMLElement>('.qtd-editor')
    await ui.waitView('passthrough cleared', (view) => paneReport(view, agent.pane.id)?.dock?.passthrough === false)
    await waitFor('composer focus restored after passthrough', () => ui.win.document.activeElement === activeEditor ? true : undefined)
    expect(ui.win.document.activeElement).toBe(activeEditor)
    expect(windowContext(ui).get('terminalDockFocus')).toBe(true)

    const paneArea = ui.q(`[data-panes="${agent.tab.id}"]`)!
    ui.setRect(paneArea, { left: 0, top: 0, width: 1000, height: 239 })
    await ui.refit()
    await ui.waitView('unmounted below gutter plus sixty', (view) => paneReport(view, agent.pane.id)?.dock?.mounted === false)
    expect((await waitForDock(ui, agent.pane.id, agent.session, (state) => !state.mounted, 'to unmount below its lower boundary')).docked).toBe(true)
    await ui.gone('.qtd-composer')

    ui.setRect(paneArea, { left: 0, top: 0, width: 1000, height: 260 })
    await ui.refit()
    expect(paneReport(await ui.view(), agent.pane.id)?.dock?.mounted).toBe(false)
    ui.setRect(paneArea, { left: 0, top: 0, width: 1000, height: 280 })
    await ui.refit()
    await ui.el('.qtd-composer')
    await waitForDock(ui, agent.pane.id, agent.session, (state) => state.mounted, 'to remount at gutter plus one hundred')

    const handle = await ui.el<HTMLElement>('.qtd-resize-handle')
    const targetWindow = ui.win.document.defaultView!
    handle.dispatchEvent(mouse('mousedown', { button: 0, clientY: 200 }))
    await ui.settle()
    targetWindow.dispatchEvent(mouse('mousemove', { clientY: 160 }))
    ui.setRect(paneArea, { left: 0, top: 0, width: 1000, height: 239 })
    await ui.refit()
    expect(paneReport(await ui.view(), agent.pane.id)?.dock?.mounted).toBe(true)
    targetWindow.dispatchEvent(mouse('mouseup', { clientY: 160 }))
    await ui.waitView('unmounted after the frozen drag ends', (view) => paneReport(view, agent.pane.id)?.dock?.mounted === false)
    const resized = await waitForDock(ui, agent.pane.id, agent.session, (state) => state.gutterRows === 7 && state.docked && !state.mounted, 'to commit two rows and unmount')
    expect(resized.gutterRows).toBe(7)
    expect(resized.docked).toBe(true)

    ui.setRect(paneArea, { left: 0, top: 0, width: 1000, height: 320 })
    await ui.refit()
    await ui.waitView('the seven-row composer remounted', (view) => paneReport(view, agent.pane.id)?.dock?.mounted === true)
    expect((await waitForDock(ui, agent.pane.id, agent.session, (state) => state.gutterRows === 7 && state.mounted, 'to remount with seven rows')).gutterRows).toBe(7)
    const { workspace: splitWorkspace } = await ui.h.json<{ workspace: Workspace }>(['terminal', 'pane', 'split', agent.pane.id, '--direction', 'right'])
    const splitTab = tabsOf(splitWorkspace).find((tab) => tab.id === agent.tab.id)!
    const split = { pane: leavesOf(splitTab.root).find((pane) => pane.id !== agent.pane.id)! }
    await ui.waitView('the new split focused', (view) => view.focusedPane === split.pane.id)
    const shellTerminal = ui.term(split.pane.id)!
    const shellTextarea = shellTerminal.textarea
    if (!shellTextarea) throw new Error('Expected the shell terminal textarea to exist for focus assertions.')
    shellTextarea.focus()
    await ui.settle()
    expect(ui.win.document.activeElement).toBe(shellTextarea)
    await ui.h.call('quirky.terminal-dock/set', { pane: agent.pane.id, gutterRows: 8 })
    await waitForDock(ui, agent.pane.id, agent.session, (state) => state.gutterRows === 8, 'to update in a background split')
    await ui.settle()
    expect(ui.win.document.activeElement).toBe(shellTextarea)
  },
  100_000
)

test(
  'floating dock host reports actual focus and sequence beside the main terminal view',
  async () => {
    const ui = await startUi({ agents: ['claude'] })
    ui.win.setFocus(true)
    await ui.h.ok(['setting', 'set', 'setting:quirky.terminal-dock/enabled', 'true'])
    await ui.h.ok(['terminal', 'floating', 'show'])
    await ui.el('[data-floating-panel]')

    const agent = await openTab(ui.h, ['--worktree', 'floating', '--agent', 'claude'], { ready: false, selector: 'floating' })
    await waitForDock(ui, agent.pane.id, agent.session, (state) => state.enabled && state.supported && state.docked, 'to auto-open in the floating workspace')
    await ui.el('.qtd-composer')
    const floating = await waitFor('floating dock focus report', async () => {
      const slot = await ui.slot(FLOATING_OVERLAY)
      const report = slot?.report as FocusedViewReport | undefined
      return report?.shown && report.focused === true && typeof report.focusSequence === 'number' && report.panes?.some((pane) => pane.pane === agent.pane.id && pane.dock?.mounted)
        ? report
        : undefined
    })
    const main = await waitFor('main view focus report cleared', async () => {
      const slot = await ui.slot(WORKTREE_VIEW)
      const report = slot?.report as FocusedViewReport | undefined
      return report?.focused === false ? report : undefined
    })
    expect(main.focused).toBe(false)
    expect(floating.focusedPane).toBe(agent.pane.id)
    expect(floating.focusSequence).toBeGreaterThan(main?.focusSequence ?? 0)
  },
  100_000
)
