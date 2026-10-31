import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { readRuntime } from '@quirky/protocol/node'
import type { DesktopShellBridge, UiSlotState, UiState } from '@quirky/protocol'
import { startHeadlessWindow, type HeadlessWindow } from '../../../../packages/ui/test/fixtures/headless-window'
import type { ViewReport } from '../../src/window/workspace/controller'
import type { FloatingState, Workspace } from '../../src/layout/types'
import { cleanupAll, ensureWorkspace, layoutOf, leavesOf, openTab, startE2e, tabsOf, waitFor, waitReady, type E2eHarness } from '../e2e/support'

export { cleanupAll, ensureWorkspace, layoutOf, openTab, startE2e, waitFor, waitReady }
export type { E2eHarness, FloatingState, ViewReport, Workspace }
export {
  SCENARIO_MS,
  groupsOf,
  leavesOf,
  panesOf,
  restartDaemon,
  splitPane,
  tabsOf,
  terminal,
  tabTitle,
  typeAsPerson
} from '../e2e/support'

export const WORKTREE_VIEW = 'view:quirky.session/worktree'
export const FLOATING_OVERLAY = 'overlay:quirky.terminal/floating'
export const QUICK_COMMANDS_PANEL = 'panel:quirky.terminal/quick-commands'

/** Scenario tests start a daemon, a PTY host and a window, so they get more than Bun's 5 s default. */
export const FEATURE_MS = 100_000

// happy-dom swaps these for its own versions, which the CLI fixture's stream reads cannot use
const HTTP_GLOBALS = ['Response', 'Request', 'Headers'] as const
const STAGE = { width: 1000, height: 600 }

export type Clipboard = { writes: string[]; text: string }

/** The headless window and the instruments around it. */
export type WindowKit = {
  win: HeadlessWindow
  clipboard: Clipboard
  /** Every daemon call the window made since it started, oldest first; `settled` once it has been answered. */
  calls: { method: string; params: Record<string, any>; settled: boolean }[]
  /** Every xterm the window opened, oldest first. */
  terminals: Terminal[]
  /** The link providers each xterm registered. */
  linkProviders: Map<Terminal, ILinkProvider[]>
  /** Makes the window's calls to `method` fail with `message` until `restore` is called. */
  rejectCalls(method: string, message?: string): { restore(): void }
  startWindow(): Promise<void>
  stopWindow(): Promise<void>
}

/**
 * The search addon clears its line cache 15 s after a search, on a timer that outlives the addon.
 * Once the window is gone that timer finds no `window`, so the callback must tolerate it.
 */
function guardSearchTimer(module: typeof import('@xterm/addon-search')): void {
  const proto = module.SearchAddon.prototype as unknown as { _destroyLinesCache(): void; guarded?: boolean }
  if (proto.guarded) return
  const destroy = proto._destroyLinesCache
  proto._destroyLinesCache = function (this: unknown) {
    try {
      destroy.call(this)
    } catch {
      // the window this addon belonged to has been closed
    }
  }
  proto.guarded = true
}

/**
 * Starts and stops a headless window on the daemon of `home`. The clipboard, the 2d canvas and the
 * layout boxes happy-dom cannot provide are stubbed, and the xterm instances and link providers
 * the plugin creates are recorded.
 */
function createWindowKit(home: string, desktopBridge?: DesktopShellBridge): WindowKit {
  const clipboard: Clipboard = { writes: [], text: '' }
  const terminals: Terminal[] = []
  const calls: WindowKit['calls'] = []
  const linkProviders = new Map<Terminal, ILinkProvider[]>()
  const rejected = new Map<string, string>()
  let restoreStubs: (() => void) | null = null
  let restoreOpen: (() => void) | null = null
  let win: HeadlessWindow | null = null

  return {
    get win() {
      if (!win) throw new Error('the window is not running')
      return win
    },
    clipboard,
    calls,
    terminals,
    linkProviders,
    rejectCalls(method, message = 'refused for the test') {
      rejected.set(method, message)
      return { restore: () => void rejected.delete(method) }
    },
    async startWindow() {
      const runtime = readRuntime(home)
      if (!runtime) throw new Error('quirkyd is not running')
      const native = HTTP_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
      win = await startHeadlessWindow({ home, runtime, desktopBridge })
      for (const [name, value] of native) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
      restoreStubs = installStubs(clipboard)
      const connection = win.connection as unknown as { callAny(method: string, params: Record<string, unknown>): Promise<unknown> }
      const callAny = connection.callAny.bind(connection)
      connection.callAny = (method, params) => {
        const entry = { method, params, settled: false }
        calls.push(entry)
        const refusal = rejected.get(method)
        const answer = refusal === undefined ? callAny(method, params) : Promise.reject(new Error(refusal))
        const settle = () => void (entry.settled = true)
        answer.then(settle, settle)
        return answer
      }
      // xterm reads `window` when imported, so it loads only now that the window exists
      const { Terminal: XTerminal } = await import('@xterm/xterm')
      const open = XTerminal.prototype.open
      XTerminal.prototype.open = function (this: Terminal, element: HTMLElement) {
        terminals.push(this)
        return open.call(this, element)
      }
      guardSearchTimer(await import('@xterm/addon-search'))
      const register = XTerminal.prototype.registerLinkProvider
      XTerminal.prototype.registerLinkProvider = function (this: Terminal, provider: ILinkProvider) {
        linkProviders.set(this, [...(linkProviders.get(this) ?? []), provider])
        return register.call(this, provider)
      }
      restoreOpen = () => {
        XTerminal.prototype.open = open
        XTerminal.prototype.registerLinkProvider = register
      }
    },
    async stopWindow() {
      // an xterm that outlives its window fires addon timers into a window that no longer exists
      for (const term of terminals) {
        try {
          term.dispose()
        } catch {
          // already disposed by its pane
        }
      }
      restoreOpen?.()
      restoreOpen = null
      restoreStubs?.()
      restoreStubs = null
      terminals.length = 0
      calls.length = 0
      linkProviders.clear()
      rejected.clear()
      const closing = win
      win = null
      await closing?.stop()
    }
  }
}

export type Features = WindowKit & {
  h: E2eHarness
  /** The worktree ID of `main`, which the view input and the layout use. */
  worktree: string
  /** Where `openExternal` logs what it was asked to open. */
  openLog: string
  stop(): Promise<void>
}

const live = new Set<Features>()

/** `extra` with the kit's members, keeping the kit's `win` getter live. */
function withKit(kit: WindowKit, extra: Omit<Features, keyof WindowKit>): Features {
  return Object.defineProperties(extra, Object.getOwnPropertyDescriptors(kit)) as Features
}

export type StartOptions = {
  /** Extra variables for the daemon. */
  env?: Record<string, string>
  /** Open the worktree view in the window (default true). */
  open?: boolean
  /** Start the window at all (default true). */
  window?: boolean
  /** Native clipboard scenarios use the same trusted bridge as the desktop shell. */
  desktopBridge?: DesktopShellBridge
}

/**
 * A real daemon with its PTY host and built-in plugins, one worktree `main` with its first
 * terminal tab, and a headless window showing the workspace view. Every process is killed by `stop`.
 */
export async function startFeatures(options: StartOptions = {}): Promise<Features> {
  const logDir = mkdtempSync('/tmp/qo-')
  const openLog = join(logDir, 'open.log')
  const h = await startE2e({ env: { QUIRKY_TEST_OPEN_LOG: openLog, ...options.env } })
  const kit = createWindowKit(h.home, options.desktopBridge)
  const features = withKit(kit, {
    h,
    worktree: '',
    openLog,
    async stop() {
      live.delete(features)
      await kit.stopWindow().catch(() => {})
      await cleanupAll().catch(() => {})
      rmSync(logDir, { recursive: true, force: true })
    }
  })
  live.add(features)
  try {
    // happy-dom has no WebGL, and a pane that fails to start the addon leaves timers behind
    await h.ok(['setting', 'set', 'setting:quirky.terminal/gpu-acceleration', 'off'])
    const workspace = await ensureWorkspace(h)
    features.worktree = workspace.id
    await waitReady(h, firstSession(workspace))
    if (options.window !== false) {
      await features.startWindow()
      if (options.open !== false) await openWorktreeView(features)
    }
  } catch (error) {
    await features.stop()
    throw error
  }
  return features
}

/**
 * The same instruments over a daemon some other harness started (the fake-agent one): `daemon`
 * answers `call`, `cli` and `home`, and `stop` leaves that harness to its owner.
 */
export async function attachFeatures(daemon: { home: string; call(method: string, params?: Record<string, unknown>): Promise<unknown>; cli: E2eHarness['cli'] }): Promise<Features> {
  const driver = {
    home: daemon.home,
    call: daemon.call,
    cli: daemon.cli,
    async ok(args: string[]) {
      const result = await daemon.cli(args)
      if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
      return result.stdout
    },
    async json(args: string[]) {
      return JSON.parse(await driver.ok([...args, '--json']))
    }
  } as unknown as E2eHarness
  const kit = createWindowKit(daemon.home)
  const features = withKit(kit, {
    h: driver,
    worktree: '',
    openLog: '',
    async stop() {
      live.delete(features)
      await kit.stopWindow().catch(() => {})
    }
  })
  live.add(features)
  try {
    await driver.ok(['setting', 'set', 'setting:quirky.terminal/gpu-acceleration', 'off'])
    const { workspace } = (await daemon.call('quirky.terminal/workspace', { workspace: 'main', ensure: true })) as { workspace: Workspace }
    features.worktree = workspace.id
    await features.startWindow()
    await openWorktreeView(features)
  } catch (error) {
    await features.stop()
    throw error
  }
  return features
}

/** Stops every scenario started in this process; call from `afterEach`. */
export async function stopAll(): Promise<void> {
  for (const features of [...live]) await features.stop()
  await cleanupAll()
}

function firstSession(workspace: Workspace): string {
  return leavesOf(tabsOf(workspace)[0]!.root)[0]!.session
}

/** A 2d canvas context for xterm's overview ruler, a fixed size for every measured box, and a recording clipboard. */
function installStubs(clipboard: Clipboard): () => void {
  const getContext = HTMLCanvasElement.prototype.getContext
  const context2d = new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true })
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
    return type === '2d' ? context2d : null
  } as typeof getContext

  const rect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const domRect = (box: { left: number; top: number; width: number; height: number }) =>
      ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) }) as DOMRect
    if (this.classList.contains('qt-pane-header-band')) return domRect({ left: 0, top: 0, width: 0, height: 34 })
    const pane = this.classList.contains('qtd-host') ? this.closest<HTMLElement>('.qt-pane') : null
    if (pane) {
      return domRect({
        left: Number.parseFloat(pane.style.left) || 0,
        top: Number.parseFloat(pane.style.top) || 0,
        width: Number.parseFloat(pane.style.width) || 0,
        height: Number.parseFloat(pane.style.height) || 0
      })
    }
    if (!/\bqt-(panes|groups|body)\b/.test(this.getAttribute('class') ?? '')) return rect.call(this)
    return domRect({ left: 0, top: 0, ...STAGE })
  }

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboard.writes.push(text)
        clipboard.text = text
      },
      readText: async () => clipboard.text
    }
  })
  return () => {
    HTMLCanvasElement.prototype.getContext = getContext
    Element.prototype.getBoundingClientRect = rect
  }
}

// ---- ui state

/** Waits for the window's DOM to satisfy `check`; the headless window's own default of 8 s is short on a busy machine. */
export const until = <T>(f: Features, check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> => f.win.waitFor(check, timeoutMs)

/** `ui state` as the daemon answers it. */
export const uiState = (f: Features): Promise<UiState> => f.h.call<UiState>('ui.state')

export const slotOf = (state: UiState, id: string): UiSlotState | undefined => state.slots.find((slot) => slot.id === id)

/** Polls `ui state` until `check` holds for the slot's report, so a test never races the window's report. */
export async function reportOf<T>(f: Features, id: string, what: string, check: (report: T) => boolean = () => true, timeoutMs = 20_000): Promise<T> {
  let last: unknown
  try {
    return await waitFor(
      `${id} to report ${what}`,
      async () => {
        const report = slotOf(await uiState(f), id)?.report as T | undefined
        last = report
        return report !== undefined && report !== null && check(report) ? report : undefined
      },
      timeoutMs
    )
  } catch (error) {
    throw new Error(`${(error as Error).message}; last report: ${JSON.stringify(last)?.slice(0, 1500)}`)
  }
}

/** The worktree view's report once `check` holds. */
export const viewReport = (f: Features, what: string, check: (report: ViewReport) => boolean = () => true, timeoutMs?: number): Promise<ViewReport> =>
  reportOf<ViewReport>(f, WORKTREE_VIEW, what, check, timeoutMs)

export type FloatingReport = { shown: boolean; state: FloatingState | null; layout: Workspace | null; focusedPane: string | null; panes: ViewReport['panes'] }

/** The floating overlay's report once `check` holds. */
export const floatingReport = (f: Features, what: string, check: (report: FloatingReport) => boolean = () => true, timeoutMs?: number): Promise<FloatingReport> =>
  reportOf<FloatingReport>(f, FLOATING_OVERLAY, what, check, timeoutMs)

/** Opens the worktree view on `main` the way a caller does, and waits until its first pane has reported. */
export async function openWorktreeView(f: Features, input: Record<string, unknown> = {}): Promise<ViewReport> {
  await f.h.ok(['ui', 'open-view', WORKTREE_VIEW, '--input', JSON.stringify({ worktree: f.worktree, ...input })])
  await f.h.ok(['ui', 'focus', 'view'])
  return viewReport(f, 'a mounted pane', (report) => report.panes.length > 0 && report.panes.every((pane) => pane.cols > 0))
}

// ---- driving the window

/** `quirky ui run command:quirky.terminal/<name> --args <json>`, returning the command's JSON result. */
export async function runCommand(f: Features, command: string, args?: Record<string, unknown>): Promise<any> {
  const id = command.includes(':') ? command : `command:quirky.terminal/${command}`
  const out = await f.h.ok(['ui', 'run', id, ...(args ? ['--args', JSON.stringify(args)] : []), '--json'])
  return (JSON.parse(out) as { result: unknown }).result
}

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  '=': { key: '=', code: 'Equal', keyCode: 187 },
  '-': { key: '-', code: 'Minus', keyCode: 189 },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219 },
  ']': { key: ']', code: 'BracketRight', keyCode: 221 }
}

/** The keydown a chord such as `mod+shift+d` or `ctrl+tab` produces; `mod` is Cmd. */
export function keyEvent(chord: string): KeyboardEvent {
  const parts = chord.split('+')
  const name = parts.pop()!
  const spec = KEYS[name] ?? (/^[a-z]$/.test(name) ? { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0) } : /^[0-9]$/.test(name) ? { key: name, code: `Digit${name}`, keyCode: 48 + Number(name) } : null)
  if (!spec) throw new Error(`no key named ${name}`)
  return new KeyboardEvent('keydown', {
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    metaKey: parts.includes('mod'),
    ctrlKey: parts.includes('ctrl'),
    altKey: parts.includes('alt'),
    shiftKey: parts.includes('shift'),
    bubbles: true,
    cancelable: true
  })
}

/**
 * Presses a chord on `target` (default: the focused element), as the browser delivers it, and
 * returns the event so a test can see whether anything prevented its default.
 */
export async function press(chord: string, target?: Element): Promise<KeyboardEvent> {
  const event = keyEvent(chord)
  const element = target ?? document.activeElement ?? document.body
  element.dispatchEvent(event)
  await Bun.sleep(0)
  return event
}

/** The xterm showing `session`. */
export function termOf(f: Features, session: string): Terminal {
  const found = [...f.terminals].reverse().find((term) => term.element?.closest('[data-terminal-pane]')?.getAttribute('data-terminal-pane') === session && term.element.isConnected)
  if (!found) throw new Error(`no mounted terminal for ${session}`)
  return found
}

/** The hidden input of the terminal showing `session`, which is what has keyboard focus in a pane. */
export function textareaOf(f: Features, session: string): HTMLTextAreaElement {
  return termOf(f, session).textarea!
}

/** Focuses the terminal of `session` as a click into it would. */
export async function focusTerminal(f: Features, session: string): Promise<void> {
  textareaOf(f, session).focus()
  await Bun.sleep(20)
}

/** The plain text of xterm's buffer, one string per line. */
export function bufferLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '')
}

/** Waits until the window's xterm of `session` has a buffer line satisfying `match`. */
export function waitForScreen(f: Features, session: string, what: string, match: (lines: string[]) => boolean, timeoutMs = 20_000): Promise<string[]> {
  return waitFor(
    `${what} in the window's terminal ${session}`,
    () => {
      const lines = bufferLines(termOf(f, session))
      return match(lines) ? lines : undefined
    },
    timeoutMs
  )
}

/** The `openExternal` log as the objects it holds. */
export function openedLinks(f: Features): { target: string; reveal: boolean }[] {
  if (!existsSync(f.openLog)) return []
  return readFileSync(f.openLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { target: string; reveal: boolean })
}

/** The first pane of the focused tab as the view reports it. */
export const focusedSession = (report: ViewReport): string => report.panes.find((pane) => pane.pane === report.focusedPane)!.session

/** Every link on buffer row `row` (1-based) of the terminal showing `session`, from all its link providers. */
export async function linksOn(f: Features, session: string, row: number): Promise<ILink[]> {
  const term = termOf(f, session)
  const found = await Promise.all((f.linkProviders.get(term) ?? []).map((provider) => new Promise<ILink[]>((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))))
  return found.flat()
}

/** Types into a controlled React input; happy-dom lacks the `oninput` support React checks, so its change plugin needs focus and a keyup. */
export async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  input.focus()
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('keyup', { bubbles: true }))
  await Bun.sleep(30)
}
