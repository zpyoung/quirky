import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readRuntime } from '@quirky/protocol/node'
import type { UiSlotState, UiState } from '@quirky/protocol'
import { startHeadlessWindow } from '../../../../packages/ui/test/fixtures/headless-window'
import { cleanupAll, leavesOf, openTab, restartDaemon, startE2e, tabsOf, terminal, waitFor, waitReady, layoutOf, type StartOptions, type Workspace } from '../e2e/support'

export * from '../e2e/support'

export const WORKTREE_VIEW = 'view:quirky.session/worktree'

/** The size every workspace container reports, since happy-dom does no layout. */
export const AREA = { width: 1000, height: 600 }
/** The cell size the stubbed fit uses to turn a pane's pixels into columns and rows. */
export const CELL = { width: 10, height: 20 }
/** How soon the window must treat a close as a double click of the one before. */
export const DOUBLE_CLICK_MS = 350

export type PaneReport = {
  pane: string
  session: string
  cols: number
  rows: number
  fontSize: number
  webgl: boolean
  search: { query: string; regex: boolean; caseSensitive: boolean; current: number; total: number; more: boolean } | null
  exitOverlay: boolean
}

/** What the worktree view reports through `quirky ui state`. */
export type ViewReport = {
  worktree: string | null
  active: string | null
  tabs: { session: string; title: string; agent: string; status: string; tab: string; group: string; pane: string }[]
  layout: Workspace | null
  focusedPane: string | null
  panes: PaneReport[]
  menu: { kind: string; target: string | null; items: { label: string; key: string | null; enabled: boolean; separator: boolean }[] } | null
  dialog: { kind: string; title: string } | null
}

export type WindowCall = { method: string; params: Record<string, unknown> }

type Rect = { left: number; top: number; width: number; height: number }

const HTTP_GLOBALS = ['Response', 'Request', 'Headers'] as const
// the daemon's health probe hands fetch an AbortSignal, which must be the runtime's own
const ABORT_GLOBALS = ['AbortSignal', 'AbortController'] as const
const MEASURED = /\bqt-(panes|groups|body)\b/
const FAKE_AGENT = resolve(import.meta.dir, '../../../quirky.agents/test/support/fake-agent.ts')

export type Ui = Awaited<ReturnType<typeof startUi>>

const open = new Set<{ stop(): Promise<void> }>()
const scratchDirs = new Set<string>()

/** Stops every window this process opened, then everything the harnesses started. */
export async function cleanupUi(): Promise<void> {
  for (const entry of [...open]) {
    open.delete(entry)
    await entry.stop()
  }
  await cleanupAll()
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs.clear()
}

const jsonOf = (text: string) => JSON.parse(text) as unknown

/**
 * Fake agent CLIs first on `PATH` and a login shell that keeps the system profile from putting a
 * real agent ahead of them, so no real agent can start in a test that asks for agents.
 */
function fakeAgents(names: string[]): { shell: string; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync('/tmp/qf-'))
  scratchDirs.add(root)
  const fakebin = join(root, 'bin')
  const shells = join(root, 'sh')
  mkdirSync(fakebin)
  mkdirSync(shells)
  const shell = join(shells, 'sh')
  writeFileSync(shell, '#!/bin/sh\n[ "$1" = "-l" ] && shift\nexec /bin/sh "$@"\n')
  chmodSync(shell, 0o755)
  for (const name of names) {
    const path = join(fakebin, name)
    writeFileSync(path, `#!${process.execPath}\nimport ${JSON.stringify(FAKE_AGENT)}\n`)
    chmodSync(path, 0o755)
  }
  return { shell, env: { PATH: `${fakebin}:/usr/bin:/bin`, QUIRKY_AGENT_SEARCH_DIRS: '' } }
}

export type UiOptions = StartOptions & {
  /** Open the worktree view for `main` (with this session focused), or leave the window empty; default open. */
  view?: boolean | { session?: string }
  /** Install fake agent CLIs of these names and use a plain `sh` login shell. */
  agents?: string[]
}

/**
 * A real daemon with its PTY host and built-in plugins, and the real window on it (happy-dom, the
 * plugin's own `ui.tsx`). Layout is stubbed in the window: workspace containers measure `AREA`,
 * `setRect` overrides single elements, and an xterm fits its pane's box at `CELL` px per cell
 * whenever the window's resize observers fire (every 30 ms here). Everything the window sends to
 * the daemon is recorded in `calls`.
 */
export async function startUi(options: UiOptions = {}) {
  const { view: openView = true, agents, ...harnessOptions } = options
  const openLog = mkdtempSync('/tmp/qo-')
  scratchDirs.add(openLog)
  harnessOptions.env = { QUIRKY_TEST_OPEN_LOG: join(openLog, 'open.log'), ...harnessOptions.env }
  if (agents) {
    const fakes = fakeAgents(agents)
    harnessOptions.shell = fakes.shell
    harnessOptions.env = { ...fakes.env, ...harnessOptions.env }
  }
  const h = await startE2e(harnessOptions)
  const natives = HTTP_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
  const nativeAbort = ABORT_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
  const win = await startHeadlessWindow({ home: h.home, runtime: readRuntime(h.home)! })
  for (const [name, value] of natives) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

  const calls: WindowCall[] = []
  const callAny = win.connection.callAny.bind(win.connection)
  win.connection.callAny = (method, params) => {
    calls.push({ method, params })
    return callAny(method, params)
  }

  const clipboard = { written: [] as string[], text: '' }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => void clipboard.written.push(text),
      readText: async () => clipboard.text
    }
  })

  const restoreLayout = stubLayout()
  const restoreCanvas = stubCanvas()
  const fit = await stubFit()
  const terminals = await recordTerminals()

  let stopped = false
  const entry = {
    async stop() {
      if (stopped) return
      stopped = true
      terminals.restore()
      fit.restore()
      restoreCanvas()
      restoreLayout()
      await win.stop()
    }
  }
  open.add(entry)

  const ui = {
    h,
    win,
    calls,
    clipboard,

    /** The window calls made to a `quirky.terminal` method, with the params of each. */
    callsTo: (method: string) => calls.filter((call) => call.method === `quirky.terminal/${method}`).map((call) => call.params),

    /** `quirky ui state --json`. */
    async state(): Promise<UiState> {
      return jsonOf(await h.ok(['ui', 'state', '--json'])) as UiState
    },

    async slot(id: string): Promise<UiSlotState | undefined> {
      return ((await h.call<UiState>('ui.state')).slots as UiSlotState[]).find((slot) => slot.id === id)
    },

    /** The worktree view's latest report, or undefined while it has none. */
    async view(): Promise<ViewReport | undefined> {
      return (await ui.slot(WORKTREE_VIEW))?.report as ViewReport | undefined
    },

    /** Polls the view's report until `check` holds for it. */
    waitView(what: string, check: (view: ViewReport) => boolean, timeoutMs = 20_000): Promise<ViewReport> {
      return waitFor(
        `the view to report ${what}`,
        async () => {
          const report = await ui.view()
          return report && check(report) ? report : undefined
        },
        timeoutMs
      )
    },

    /** Polls the daemon's layout until `check` holds for it. */
    waitLayout(what: string, check: (ws: Workspace) => boolean, timeoutMs = 20_000): Promise<Workspace> {
      return waitFor(
        `the layout to have ${what}`,
        async () => {
          const ws = await layoutOf(h)
          return check(ws) ? ws : undefined
        },
        timeoutMs
      )
    },

    /** Waits until the window reports the layout at (or past) `revision`. */
    waitRevision: (revision: number) => ui.waitView(`revision ${revision}`, (report) => (report.layout?.revision ?? 0) >= revision),

    /** Stops the daemon and starts a new one (the PTY host and the sessions keep running); the window reconnects on its own. */
    async restartDaemon(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
      const inWindow = ABORT_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
      for (const [name, value] of nativeAbort) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
      try {
        await restartDaemon(h, signal)
      } finally {
        for (const [name, value] of inWindow) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
      }
    },

    /** Waits until the window has drawn the daemon's current layout, so what it reports follows the change just made. */
    async sync(): Promise<ViewReport> {
      const { revision } = await layoutOf(h)
      return ui.waitRevision(revision)
    },

    /** `quirky ui open-view` on the worktree view, then focus to the view. */
    async openView(input: { worktree?: string; session?: string } = {}): Promise<void> {
      await h.ok(['ui', 'open-view', WORKTREE_VIEW, '--input', JSON.stringify({ worktree: 'main', ...input })])
      await h.call('ui.focus', { target: 'view' })
    },

    /** `quirky ui run command:<id> --args <json>`; a bare name is a `quirky.terminal` command. Returns the command's result. */
    async run(command: string, args?: unknown): Promise<any> {
      const id = command.startsWith('command:') ? command : command.includes('/') ? `command:${command}` : `command:quirky.terminal/${command}`
      const reply = jsonOf(await h.ok(['ui', 'run', id, ...(args === undefined ? [] : ['--args', JSON.stringify(args)]), '--json'])) as { result?: unknown }
      h.noteProcesses()
      return reply.result
    },

    /** The first tab the window opened for `main`, once its shell is at the prompt. */
    async firstTab() {
      const ws = await ui.waitLayout('its first tab', (candidate) => tabsOf(candidate).length >= 1)
      const tab = tabsOf(ws)[0]!
      const pane = leavesOf(tab.root)[0]!
      await waitReady(h, pane.session)
      return { tab, pane, session: pane.session }
    },

    /** The mounted DOM. */
    q: <T extends Element = HTMLElement>(selector: string) => win.document.querySelector<T>(selector),
    qa: <T extends Element = HTMLElement>(selector: string) => [...win.document.querySelectorAll<T>(selector)],

    /** Waits for an element to exist and returns it. */
    el: <T extends Element = HTMLElement>(selector: string, timeoutMs = 20_000) =>
      waitFor(`an element ${selector}`, () => win.document.querySelector<T>(selector), timeoutMs),

    /** Waits for an element to go away. */
    gone: (selector: string, timeoutMs = 20_000) => waitFor(`${selector} to go away`, () => win.document.querySelector(selector) === null, timeoutMs),

    /** The labels of a tab strip, in order, as the DOM draws them. */
    tabTitles: (group?: string) =>
      [...win.document.querySelectorAll<HTMLElement>(`${group ? `[data-group="${group}"] ` : ''}[data-tab] .qt-tab-title`)].map((element) => element.textContent ?? ''),

    /** The row of the open menu (or its open submenu) with this label. */
    menuRow: (label: string) =>
      [...win.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) => row.querySelector('.qt-menu-label')?.textContent === label) ?? null,

    /** Clicks a menu row by label, waiting for it to exist. */
    async pick(label: string): Promise<void> {
      const row = await waitFor(`a menu row ${label}`, () => ui.menuRow(label))
      row.click()
      await ui.settle()
    },

    /** Right-clicks an element. */
    async contextMenu(selector: string, init: MouseEventInit = {}): Promise<void> {
      const target = await ui.el(selector)
      fire(target, mouse('contextmenu', init))
      await ui.settle()
    },

    /** The open dialog's element, once there is one. */
    dialog: (timeoutMs?: number) => ui.el<HTMLElement>('[role="dialog"]', timeoutMs),

    /** A button of the open dialog, by its text. */
    dialogButton: (label: string) => [...win.document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((button) => button.textContent === label) ?? null,

    /** The toasts on screen, by title. */
    toasts: () => [...win.document.querySelectorAll('.toast .toast-title')].map((element) => element.textContent ?? ''),

    /** Types into a controlled input the way a keyboard does, then lets React take it. */
    async fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
      input.focus()
      const proto = input instanceof win.document.defaultView!.HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('keyup', { bubbles: true }))
      await ui.settle()
    },

    /** A key press on an element (or the window). */
    async key(target: EventTarget, name: string, init: KeyboardEventInit = {}): Promise<void> {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
      await ui.settle()
    },

    /**
     * Presses a chord such as `mod+shift+t` on the focused element, as the keyboard does, so it goes
     * through the window's keybindings. Resolves once React has rendered what it started.
     */
    async chord(chord: string): Promise<void> {
      const parts = chord.split('+')
      const name = parts.pop()!
      const code = /^[a-z]$/.test(name) ? `Key${name.toUpperCase()}` : /^[0-9]$/.test(name) ? `Digit${name}` : CHORD_CODES[name] ?? name
      const key = CHORD_KEYS[name] ?? name
      const target = win.document.activeElement ?? win.document.body
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code,
          metaKey: parts.includes('mod'),
          ctrlKey: parts.includes('ctrl'),
          altKey: parts.includes('alt'),
          shiftKey: parts.includes('shift'),
          bubbles: true,
          cancelable: true
        })
      )
      await ui.settle()
    },

    /** Releases a key on the window, as lifting Ctrl ends the tab switcher. */
    async keyup(name: string): Promise<void> {
      win.document.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }))
      await ui.settle()
    },

    /** The xterm of a pane, once mounted. */
    term: (pane: string) => terminals.of(pane),

    /** What a pane's xterm shows: the whole buffer as trimmed lines. */
    paneText(pane: string): string[] {
      const term = terminals.of(pane)
      if (!term) return []
      const lines: string[] = []
      for (let row = 0; row < term.buffer.active.length; row += 1) lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? '')
      return lines
    },

    /** What the view last reported about one pane. */
    async paneInfo(pane: string): Promise<PaneReport | undefined> {
      return (await ui.view())?.panes.find((entry) => entry.pane === pane)
    },

    /** Lets React render what an event started. */
    settle: () => Bun.sleep(60),

    /** Lets the resize observers fire and the panes refit. */
    refit: () => Bun.sleep(120),

    /** Gives an element a fixed bounding box, for drags across it. */
    setRect(element: Element, rect: Rect): void {
      rects.set(element, rect)
    },

    async stop(): Promise<void> {
      open.delete(entry)
      await entry.stop()
    }
  }

  if (openView) {
    await ui.openView(typeof openView === 'object' ? openView : {})
    await ui.waitView('a layout', (report) => report.layout !== null)
  }
  return ui
}

/** Opens a tab without waiting for its shell and gives it the custom title `name`. */
export async function namedTab(ui: Ui, name: string, extra: string[] = []) {
  const opened = await openTab(ui.h, extra, { ready: false })
  await terminal(ui.h, 'tab', 'rename', opened.tab.id, name)
  return opened
}

/** A bubbling, cancelable mouse event, also used for drag events. */
export function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
}

export function fire(target: EventTarget, event: Event): void {
  target.dispatchEvent(event)
}

const CHORD_CODES: Record<string, string> = { enter: 'Enter', tab: 'Tab', pagedown: 'PageDown', pageup: 'PageUp', '[': 'BracketLeft', ']': 'BracketRight', '=': 'Equal', '-': 'Minus' }
const CHORD_KEYS: Record<string, string> = { enter: 'Enter', tab: 'Tab', pagedown: 'PageDown', pageup: 'PageUp' }

const rects = new WeakMap<Element, Rect>()

/** Makes workspace containers measure `AREA` and honours `setRect`; returns the function that undoes it. */
function stubLayout(): () => void {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const own = rects.get(this)
    const measured: Rect | null = own ?? (MEASURED.test(this.getAttribute('class') ?? '') ? { left: 0, top: 0, ...AREA } : null)
    if (!measured) return original.call(this)
    return {
      ...measured,
      x: measured.left,
      y: measured.top,
      right: measured.left + measured.width,
      bottom: measured.top + measured.height,
      toJSON: () => ({})
    } as DOMRect
  }
  return () => {
    Element.prototype.getBoundingClientRect = original
  }
}

/** xterm's overview ruler needs a 2d context to open; WebGL stays unavailable so panes use the DOM renderer. */
function stubCanvas(): () => void {
  const getContext = HTMLCanvasElement.prototype.getContext
  const context2d = new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true })
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    return type === '2d' ? context2d : (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest)
  } as typeof getContext
  return () => {
    HTMLCanvasElement.prototype.getContext = getContext
  }
}

/**
 * happy-dom never fires a ResizeObserver and measures no text, so xterm would stay 80x24. This
 * collects the window's observers and calls them every 30 ms, as a browser does after a layout
 * change, and has the fit addon size a terminal from its pane's inline box at `CELL` px per cell.
 */
async function stubFit() {
  const callbacks = new Set<() => void>()
  const globals = globalThis as { ResizeObserver?: unknown }
  const originalObserver = globals.ResizeObserver
  globals.ResizeObserver = class {
    private readonly callback: () => void
    constructor(callback: () => void) {
      this.callback = callback
    }
    observe() {
      callbacks.add(this.callback)
    }
    unobserve() {}
    disconnect() {
      callbacks.delete(this.callback)
    }
  }
  const timer = setInterval(() => [...callbacks].forEach((callback) => callback()), 30)

  const { FitAddon } = await import('@xterm/addon-fit')
  const proposed = FitAddon.prototype.proposeDimensions
  FitAddon.prototype.proposeDimensions = function (this: { _terminal?: { element?: HTMLElement } }) {
    const box = this._terminal?.element?.closest<HTMLElement>('.qt-pane')
    const width = Number.parseFloat(box?.style.width ?? '')
    const height = Number.parseFloat(box?.style.height ?? '')
    if (!(width > 0) || !(height > 0)) return undefined
    return { cols: Math.max(2, Math.floor(width / CELL.width)), rows: Math.max(1, Math.floor(height / CELL.height)) }
  }
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const boxOf = (element: HTMLElement, side: 'width' | 'height') => Number.parseFloat(element.closest<HTMLElement>('.qt-pane')?.style[side] ?? '') || 0
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return boxOf(this, 'width') } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return boxOf(this, 'height') } })
  return {
    restore() {
      clearInterval(timer)
      globals.ResizeObserver = originalObserver
      FitAddon.prototype.proposeDimensions = proposed
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
    }
  }
}

/** Remembers every xterm the window opens, so a test can read what a pane shows. */
async function recordTerminals() {
  const xterm = await import('@xterm/xterm')
  const opened: InstanceType<typeof xterm.Terminal>[] = []
  const open = xterm.Terminal.prototype.open
  xterm.Terminal.prototype.open = function (this: InstanceType<typeof xterm.Terminal>, element: HTMLElement) {
    opened.push(this)
    return open.call(this, element)
  }
  return {
    /** The newest terminal inside the pane's element. */
    of(pane: string) {
      const host = document.querySelector(`[data-pane="${pane}"]`)
      return [...opened].reverse().find((term) => term.element !== undefined && host?.contains(term.element)) ?? null
    },
    restore() {
      xterm.Terminal.prototype.open = open
    }
  }
}

