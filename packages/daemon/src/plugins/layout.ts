import {
  DESKTOP_AWAY_MS,
  parseContributionId,
  validateValue,
  type QuirkyEvent,
  type Schema,
  type UiLayout,
  type UiModel,
  type UiSlotState,
  type UiState,
  type UiWindowInfo
} from '@quirky/protocol'
import { conflict, invalidParams, notFound } from '../errors'
import type { Store } from '../store'
import type { ClientConn } from '../types'
import type { PluginHost } from './host'

const LAYOUT_KEY = 'layout'
const MAX_JSON_LENGTH = 64 * 1024
const COMMAND_TIMEOUT_MS = 30_000
const FOCUS_TARGETS = ['sidebar', 'view', 'panel'] as const

const DEFAULT_LAYOUT: UiLayout = { view: null, panel: null, sidebar: true, focus: null }

export type LayoutServiceOptions = {
  plugins: Pick<PluginHost, 'contributions' | 'addWarning'>
  store: Pick<Store, 'getUiState' | 'setUiState'>
  /** The UI model the layout is checked against; read on every call. */
  ui: { contributions(): UiModel }
  /** Every connected client; windows are the ones with role `ui`. */
  clients: () => Iterable<ClientConn>
  broadcast: (event: QuirkyEvent) => void
  sendTo: (conn: ClientConn, event: QuirkyEvent) => void
  /** How long a routed command waits for its window; defaults to 30 seconds. */
  commandTimeoutMs?: number
  /** How long without input before a window stops counting as present; defaults to `DESKTOP_AWAY_MS`. */
  awayMs?: number
  /** The clock for presence; defaults to `Date.now`. */
  now?: () => number
}

type Report = { state: unknown; order: number }

type PendingCommand = {
  conn: ClientConn
  resolve(value: { result: unknown }): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const unanswered = () => conflict('the window did not answer')

function overlayShown(report: Report | undefined): boolean {
  if (!report) return false
  const state = report.state
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return true
  const shown = (state as { shown?: unknown }).shown
  return typeof shown === 'boolean' ? shown : true
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]))
}

function readStored(value: unknown): UiLayout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_LAYOUT }
  const stored = value as Record<string, unknown>
  const view = stored.view as { id?: unknown; input?: unknown } | null | undefined
  return {
    view:
      view && typeof view === 'object' && typeof view.id === 'string'
        ? { id: view.id, ...(view.input !== undefined ? { input: view.input } : {}) }
        : null,
    panel: typeof stored.panel === 'string' ? stored.panel : null,
    sidebar: typeof stored.sidebar === 'boolean' ? stored.sidebar : true,
    focus: FOCUS_TARGETS.find((target) => target === stored.focus) ?? null,
    ...(stored.palette === true ? { palette: true } : {})
  }
}

/**
 * The daemon's record of the window layout, the connected windows and their slot reports, and the
 * router that runs a plugin's UI command in one open window. The layout survives restarts in the
 * store; reports and pending commands live only as long as their window's connection.
 */
export class LayoutService {
  private readonly reports = new Map<string, Map<number, Report>>()
  private readonly pending = new Map<string, PendingCommand>()
  private reportCounter = 0
  private lastFocusedAt = 0
  private awayMs: number

  constructor(private readonly options: LayoutServiceOptions) {
    this.awayMs = options.awayMs ?? DESKTOP_AWAY_MS
  }

  /** Replaces the away threshold; the daemon sets it once at startup. */
  setAwayMs(awayMs: number): void {
    this.awayMs = awayMs
  }

  /**
   * The effective layout, the connected windows, and every slot of the UI model with what it shows
   * and reports. An overlay is shown while a window has reported for it, unless the latest report
   * is an object whose boolean `shown` says otherwise.
   */
  state(): UiState {
    const layout = this.layout()
    const model = this.options.ui.contributions()
    const windows = this.windows()
    const focusedConn = windows.find((window) => window.focused)?.connId
    const slots: UiSlotState[] = [
      ...model.sidebarSections.map((entry) => ({ entry, shown: () => layout.sidebar })),
      ...model.panels.map((entry) => ({ entry, shown: () => layout.panel === entry.id })),
      ...model.views.map((entry) => ({ entry, shown: () => layout.view?.id === entry.id })),
      ...model.overlays.map((entry) => ({ entry, shown: (report?: Report) => overlayShown(report) }))
    ].map(({ entry, shown }) => {
      const report = this.reportFor(entry.id, focusedConn)
      return {
        id: entry.id,
        kind: entry.kind,
        plugin: entry.plugin,
        title: entry.title,
        shown: shown(report),
        ...(report ? { report: report.state } : {})
      }
    })
    return { windows, layout, slots }
  }

  /**
   * Opens an effective view with an optional input. NotFound for an unknown ID, InvalidParams for
   * another kind of contribution or an input over 64 KiB of JSON.
   */
  openView(id: string, input?: unknown): UiLayout {
    this.requireSlot(id, 'view')
    if (jsonLength(input) > MAX_JSON_LENGTH) throw invalidParams('input is over 64 KiB')
    return this.change((layout) => ({ ...layout, view: { id, ...(input !== undefined ? { input } : {}) } }))
  }

  closeView(): UiLayout {
    return this.change((layout) => ({ ...layout, view: null, focus: layout.focus === 'view' ? null : layout.focus }))
  }

  /** Opens an effective panel. NotFound for an unknown ID, InvalidParams for another kind. */
  openPanel(id: string): UiLayout {
    this.requireSlot(id, 'panel')
    return this.change((layout) => ({ ...layout, panel: id }))
  }

  closePanel(): UiLayout {
    return this.change((layout) => ({ ...layout, panel: null, focus: layout.focus === 'panel' ? null : layout.focus }))
  }

  setSidebar(visible: boolean): UiLayout {
    return this.change((layout) => ({
      ...layout,
      sidebar: visible,
      focus: !visible && layout.focus === 'sidebar' ? null : layout.focus
    }))
  }

  /** Sets the shared palette state atomically; omitting `open` toggles its current value. */
  setPalette(open?: boolean): UiLayout {
    return this.change((layout) => {
      const shouldOpen = open === undefined ? layout.palette !== true : open
      if (shouldOpen) return { ...layout, palette: true }
      const closed = { ...layout }
      delete closed.palette
      return closed
    })
  }

  /** Moves focus to the sidebar, the view or the panel. InvalidParams for any other target. */
  focus(target: 'sidebar' | 'view' | 'panel'): UiLayout {
    if (!FOCUS_TARGETS.includes(target)) throw invalidParams(`focus target must be one of ${FOCUS_TARGETS.join(', ')}`)
    return this.change((layout) => ({ ...layout, focus: target }))
  }

  /**
   * Keeps a window's report for a slot, replacing its earlier one; `null` clears it. InvalidParams
   * for a connection that is not a window, a slot that is not a contribution ID, or a report over
   * 64 KiB of JSON (which also warns the slot's plugin and keeps the earlier report).
   */
  report(conn: ClientConn, slot: string, state: unknown): void {
    this.requireWindow(conn)
    const parsed = parseContributionId(slot)
    if (!parsed) throw invalidParams(`slot must be a contribution ID, got ${slot}`)
    if (jsonLength(state) > MAX_JSON_LENGTH) {
      this.options.plugins.addWarning(parsed.namespace, `the report for ${slot} was over 64 KiB and was refused`)
      throw invalidParams('report is over 64 KiB')
    }
    if (state === null) {
      const existed = this.reports.get(slot)?.delete(conn.id)
      if (existed) this.options.broadcast({ type: 'ui.report.changed', slot, connId: conn.id })
      return
    }
    const bySlot = this.reports.get(slot) ?? new Map<number, Report>()
    const previous = bySlot.get(conn.id)
    const unchanged = previous !== undefined && sameValue(previous.state, state)
    bySlot.set(conn.id, { state, order: ++this.reportCounter })
    this.reports.set(slot, bySlot)
    if (!unchanged) this.options.broadcast({ type: 'ui.report.changed', slot, connId: conn.id })
  }

  /** Records that a window gained (`true`) or lost focus; the latest window to gain it is the focused one. */
  windowFocused(conn: ClientConn, focused: boolean): void {
    this.requireWindow(conn)
    const before = this.focusedConn()
    if (focused) {
      this.lastFocusedAt = Math.max(Date.now(), this.lastFocusedAt + 1)
      conn.focusedAt = this.lastFocusedAt
    } else {
      delete conn.focusedAt
    }
    if (this.focusedConn() !== before) this.announceWindows()
  }

  /**
   * Records input in a window, keeping it present. Announces the windows only when this turns the
   * window from away to present. InvalidParams for a connection that is not a window.
   */
  windowActivity(conn: ClientConn): void {
    this.requireWindow(conn)
    const wasPresent = this.isPresent(conn)
    conn.inputAt = this.now()
    if (!wasPresent) this.announceWindows()
  }

  /**
   * Routes a UI command to one open window and resolves with its reply. NotFound for an unknown
   * command, InvalidParams for args its schema refuses; Conflict when no window is open, the window
   * disconnects or stays silent, or its code throws.
   */
  runCommand(id: string, args: unknown): Promise<{ result: unknown }> {
    if (!this.options.ui.contributions().commands.some((command) => command.id === id)) {
      return Promise.reject(notFound(`no UI command ${id}`))
    }
    const problem = validateValue(this.argsSchema(id), args ?? {}, 'args')
    if (problem !== null) return Promise.reject(invalidParams(problem))
    const target = this.targetWindow()
    if (!target) return Promise.reject(conflict('no Quirky window is open'))

    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(requestId, (pending) => pending.reject(unanswered())),
        this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
      )
      this.pending.set(requestId, { conn: target, resolve, reject, timer })
      this.options.sendTo(target, { type: 'ui.command.request', requestId, id, args: args ?? {} })
    })
  }

  /** Completes a routed command. Ignored unless it comes from the window the command went to. */
  commandReply(conn: ClientConn, requestId: string, reply: { result?: unknown; error?: { message: string } }): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.conn !== conn) return
    this.settle(requestId, (settled) => {
      if (reply.error) settled.reject(conflict(reply.error.message))
      else settled.resolve({ result: reply.result ?? null })
    })
  }

  /**
   * Forgets a disconnected window's reports, telling plugins about each one removed, fails commands
   * routed to it, and announces the remaining windows.
   */
  dropConnection(conn: ClientConn): void {
    for (const [slot, bySlot] of this.reports) {
      const existed = bySlot.delete(conn.id)
      if (bySlot.size === 0) this.reports.delete(slot)
      if (existed) this.options.broadcast({ type: 'ui.report.changed', slot, connId: conn.id })
    }
    for (const [requestId, pending] of this.pending) {
      if (pending.conn === conn) this.settle(requestId, (settled) => settled.reject(unanswered()))
    }
    if (conn.role === 'ui') this.announceWindows()
  }

  private settle(requestId: string, finish: (pending: PendingCommand) => void): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    finish(pending)
  }

  private requireWindow(conn: ClientConn): void {
    if (conn.role !== 'ui') throw invalidParams('only a window (role ui) can do this')
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private isPresent(conn: ClientConn): boolean {
    return conn.inputAt !== undefined && this.now() - conn.inputAt < this.awayMs
  }

  private openWindows(): ClientConn[] {
    return [...this.options.clients()].filter((conn) => conn.role === 'ui' && !conn.closed)
  }

  private focusedConn(): ClientConn | undefined {
    return this.openWindows().reduce<ClientConn | undefined>(
      (best, conn) => (conn.focusedAt !== undefined && conn.focusedAt > (best?.focusedAt ?? 0) ? conn : best),
      undefined
    )
  }

  private announceWindows(): void {
    this.options.broadcast({ type: 'ui.window.changed', windows: this.windows() })
  }

  private windows(): UiWindowInfo[] {
    const latest = this.focusedConn()
    return this.openWindows().map((conn) => ({
      connId: conn.id,
      ...(conn.name ? { name: conn.name } : {}),
      focused: conn === latest,
      inputAt: conn.inputAt ?? null,
      present: this.isPresent(conn)
    }))
  }

  private targetWindow(): ClientConn | undefined {
    const open = [...this.options.clients()].filter((conn) => conn.role === 'ui' && !conn.closed)
    const focused = open.filter((conn) => conn.focusedAt !== undefined)
    if (focused.length > 0) return focused.reduce((best, conn) => (conn.focusedAt! > best.focusedAt! ? conn : best))
    return open[open.length - 1]
  }

  private reportFor(slot: string, focusedConn: number | undefined): Report | undefined {
    const bySlot = this.reports.get(slot)
    if (!bySlot) return undefined
    const own = focusedConn !== undefined ? bySlot.get(focusedConn) : undefined
    if (own) return own
    return [...bySlot.values()].reduce<Report | undefined>((best, report) => (!best || report.order > best.order ? report : best), undefined)
  }

  private argsSchema(commandId: string): Schema {
    const declaration = this.options.plugins.contributions({ kind: 'command' }).find((item) => item.id === commandId)
    const args = declaration?.data.args
    return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Schema) : { type: 'object' }
  }

  /** The stored layout with a view or panel that is no longer effective dropped. */
  private layout(): UiLayout {
    const stored = readStored(this.options.store.getUiState(LAYOUT_KEY))
    const model = this.options.ui.contributions()
    return {
      ...stored,
      view: stored.view && model.views.some((view) => view.id === stored.view!.id) ? stored.view : null,
      panel: stored.panel !== null && model.panels.some((panel) => panel.id === stored.panel) ? stored.panel : null
    }
  }

  private requireSlot(id: string, kind: 'view' | 'panel'): void {
    const parsed = parseContributionId(id)
    if (parsed && parsed.kind !== kind) throw invalidParams(`${id} is a ${parsed.kind}, not a ${kind}`)
    const model = this.options.ui.contributions()
    const effective = kind === 'view' ? model.views : model.panels
    if (!effective.some((entry) => entry.id === id)) throw notFound(`no ${kind} ${id}`)
  }

  private change(update: (layout: UiLayout) => UiLayout): UiLayout {
    const next = update(this.layout())
    this.options.store.setUiState(LAYOUT_KEY, next)
    this.options.broadcast({ type: 'ui.state.changed', layout: next })
    return next
  }
}
