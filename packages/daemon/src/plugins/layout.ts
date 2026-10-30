import { isAbsolute } from 'node:path'
import {
  DESKTOP_AWAY_MS,
  UI_TOOL_SLOTS,
  parseContributionId,
  validateValue,
  type DesktopShellAction,
  type DesktopShellReply,
  type DesktopShellResult,
  type DesktopWindowAttachRequest,
  type DesktopWindowCloseResult,
  type DesktopWindowClosedRequest,
  type DesktopWindowOwner,
  type DesktopWindowRequest,
  type DesktopWindowSummary,
  type DesktopWindowUpdateRequest,
  type DesktopWindowRunOwnerCommandRequest,
  type DesktopWindowRunOwnerCommandResult,
  type DesktopWindowResult,
  type FolderPickerRequest,
  type FolderPickerResult,
  type NativeDesktopCapabilities,
  type QuirkyEvent,
  type Schema,
  type UiLayout,
  type UiModel,
  type UiSlotState,
  type UiState,
  type UiToastState,
  type UiToolEntry,
  type UiToolLayout,
  type UiToolSlot,
  type UiWindowInfo,
  type WindowRoute,
  type WindowRouteState,
} from '@quirky/protocol'
import { conflict, invalidParams, notFound } from '../errors'
import type { Store } from '../store'
import type { ClientConn } from '../types'
import type { PluginHost } from './host'
import { isRecord, resolveToolLayout, TOOL_SIZE_FIELDS, validToolSize } from './tool-layout'

const LAYOUT_KEY = 'layout'
const MAX_JSON_LENGTH = 64 * 1024
const COMMAND_TIMEOUT_MS = 30_000
const TOAST_DISMISS = 'ui.toast.dismiss'
const FOCUS_TARGETS = ['sidebar', 'view', 'panel'] as const
const PANEL_WIDTH_MIN = 220
const PANEL_WIDTH_MAX = 4096

const DEFAULT_LAYOUT: UiLayout = { view: null, worktree: null, panel: null, sidebar: true, focus: null }

export type LayoutServiceOptions = {
  plugins: Pick<PluginHost, 'contributions' | 'addWarning'>
  store: Pick<Store, 'getUiState' | 'setUiState'>
  /** The UI model the layout is checked against; read on every call. */
  ui: { contributions(): UiModel }
  /** Every connected client; windows are the ones with role `ui`. */
  clients: () => Iterable<ClientConn>
  broadcast: (event: QuirkyEvent) => void
  /** Sends shared layout updates to non-window clients while UI windows receive their own effective layout. */
  broadcastNonWindows: (event: QuirkyEvent) => void
  sendTo: (conn: ClientConn, event: QuirkyEvent) => void
  /** How long a routed command waits for its window; defaults to 30 seconds. */
  commandTimeoutMs?: number
  /** How long without input before a window stops counting as present; defaults to `DESKTOP_AWAY_MS`. */
  awayMs?: number
  /** The clock for presence; defaults to `Date.now`. */
  now?: () => number
}

type Report = { state: unknown; order: number }

type ToastReport = { toasts: UiToastState[]; order: number }
type WindowLayoutOverride = {
  view: UiLayout['view']
  viewTabs: NonNullable<UiLayout['viewTabs']>
  worktree: string | null
  focus?: UiLayout['focus']
}

type PendingCommand = {
  conn: ClientConn
  resolve(value: { result: unknown }): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type PendingDesktopRequest = {
  conn: ClientConn
  action: DesktopShellAction
  resolve(result: DesktopShellResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type AuxiliaryWindowRoute = {
  windowId: string
  view: string | null
  worktree: string | null
  viewTabs: ViewTab[]
  input?: unknown
  title?: string
  ownerShell: DesktopWindowOwner
  rendererConnId: number | null
}

const DEFAULT_DESKTOP_CAPABILITIES: NativeDesktopCapabilities = {
  directoryPicker: false,
  auxiliaryWindows: false,
  revealItem: false,
  notifications: { permission: false, click: false, dismiss: false }
}

const unanswered = () => conflict('the window did not answer')


function nativeResultMatches(action: DesktopShellAction, value: unknown): value is DesktopShellResult {
  if (!isRecord(value)) return false
  switch (action.kind) {
    case 'folder-picker':
      return typeof value.cancelled === 'boolean' && Array.isArray(value.paths) &&
        value.paths.every((path) => typeof path === 'string') && value.cancelled === (value.paths.length === 0)
    case 'window-open':
      return typeof value.windowId === 'string' && value.windowId.length > 0
    case 'window-close':
      return typeof value.closed === 'boolean'
    case 'window-activate-owner':
      return typeof value.activated === 'boolean'
    case 'reveal-item':
      return value.requested === true
  }
}

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

function isPanelWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PANEL_WIDTH_MIN && value <= PANEL_WIDTH_MAX
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

type OpenView = NonNullable<UiLayout['view']>
type ViewTab = NonNullable<UiLayout['viewTabs']>[number]

function viewTabOpened(tabs: ViewTab[], view: OpenView): ViewTab[] {
  const index = tabs.findIndex((tab) => tab.id === view.id)
  const next = [...tabs]
  if (index === -1) next.push(view)
  else next[index] = view
  return next
}

function viewTabClosed(tabs: ViewTab[], view: OpenView | null): ViewTab[] {
  return view === null ? tabs : tabs.filter((tab) => tab.id !== view.id)
}

function lastViewTab(tabs: ViewTab[]): OpenView | null {
  return tabs[tabs.length - 1] ?? null
}

function worktreeOf(view: OpenView | null): string | null | undefined {
  if (view === null || !isRecord(view.input)) return undefined
  const worktree = view.input.worktree
  if (worktree === null) return null
  return typeof worktree === 'string' && worktree.length > 0 ? worktree : undefined
}

function worktreeAfterViewChange(next: OpenView | null, current: string | null): string | null {
  if (next === null) return null
  const worktree = worktreeOf(next)
  return worktree === undefined ? current : worktree
}

function focusTargetOfTool(tool: UiToolEntry): 'sidebar' | 'view' | 'panel' | undefined {
  const kind = parseContributionId(tool.contributionId ?? '')?.kind
  if (kind === 'sidebar-section') return 'sidebar'
  if (kind === 'view') return 'view'
  if (kind === 'panel') return 'panel'
  return undefined
}

function readStored(value: unknown): UiLayout {
  if (!isRecord(value)) return { ...DEFAULT_LAYOUT }
  const stored = value
  const storedView = stored.view
  const view =
    isRecord(storedView) && typeof storedView.id === 'string'
      ? { id: storedView.id, ...(storedView.input !== undefined ? { input: storedView.input } : {}) }
      : null
  const storedWidths = stored.panelWidths
  const panelWidths: Record<string, number> = {}
  let hasPanelWidths = false
  if (isRecord(storedWidths)) {
    for (const id in storedWidths) {
      if (!Object.hasOwn(storedWidths, id)) continue
      const width = storedWidths[id]
      if (parseContributionId(id)?.kind !== 'panel' || !isPanelWidth(width)) continue
      panelWidths[id] = width
      hasPanelWidths = true
    }
  }
  const viewTabs = new Map<string, NonNullable<UiLayout['viewTabs']>[number]>()
  if (Array.isArray(stored.viewTabs)) {
    for (const tab of stored.viewTabs) {
      if (!isRecord(tab) || typeof tab.id !== 'string') continue
      viewTabs.set(tab.id, { id: tab.id, ...(tab.input !== undefined ? { input: tab.input } : {}) })
    }
  }
  const worktree =
    typeof stored.worktree === 'string'
      ? stored.worktree
      : stored.worktree === null
        ? null
        : worktreeOf(view) ?? null
  return {
    view,
    viewTabs: [...viewTabs.values()],
    worktree,
    panel: typeof stored.panel === 'string' ? stored.panel : null,
    sidebar: typeof stored.sidebar === 'boolean' ? stored.sidebar : true,
    focus: FOCUS_TARGETS.find((target) => target === stored.focus) ?? null,
    ...(hasPanelWidths ? { panelWidths } : {}),
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
  private readonly toastReports = new Map<number, ToastReport>()
  private readonly pending = new Map<string, PendingCommand>()
  private readonly pendingDesktop = new Map<string, PendingDesktopRequest>()
  private readonly desktopCapabilitiesByWindow = new Map<number, NativeDesktopCapabilities>()
  private readonly auxiliaryWindows = new Map<string, AuxiliaryWindowRoute>()
  private readonly windowViews = new Map<number, WindowLayoutOverride>()
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
   * is an object whose boolean `shown` says otherwise. `toasts` is the focused window's list (empty
   * until it reports), else, with no window focused, the list reported last.
   */
  state(): UiState {
    return this.stateFor(this.focusedConn()?.id, true)
  }
  /** Returns only the current live UI connection's kernel-authenticated identity. */
  windowSelf(conn: ClientConn): WindowRoute {
    const target = this.requireWindowById(conn.id)
    if (target !== conn) throw conflict('the calling UI connection is no longer live')
    this.windowViewFor(target.id)
    return {
      connId: target.id,
      ...(target.desktopClientId === undefined ? {} : { desktopClientId: target.desktopClientId })
    }
  }

  /** Reads the full effective state for one exact live UI connection. */
  windowState(connId: number): WindowRouteState {
    const target = this.requireWindowById(connId)
    return { ...this.stateFor(target.id, false), connId: target.id }
  }

  private stateFor(connId: number | undefined, fallbackReports: boolean): UiState {
    const layout = connId === undefined ? this.layout() : this.windowLayout(connId)
    const model = this.options.ui.contributions()
    const windows = this.windows()
    const routeViewId = connId === undefined ? undefined : this.auxiliaryView(connId)?.view ?? undefined
    const toolIds = new Set(layout.tools ? Object.values(layout.tools.open).filter((id): id is string => id !== null) : [])
    const shownToolBodies = new Set(
      (model.tools ?? [])
        .filter((tool) => toolIds.has(tool.id) && tool.contributionId !== null)
        .map((tool) => tool.contributionId!)
    )
    const aliasedActivityItems = new Set(
      (model.tools ?? []).flatMap((tool) => tool.aliases.filter((id) => id !== tool.contributionId))
    )
    const activeViews = new Set([layout.view?.id, routeViewId].filter((id): id is string => id !== undefined))
    const slots: UiSlotState[] = [
      ...model.activityItems.map((entry) => ({
        entry,
        shown: () => entry.module !== null &&
          (shownToolBodies.has(entry.id) || aliasedActivityItems.has(entry.id))
      })),
      ...model.sidebarSections.map((entry) => ({ entry, shown: () => shownToolBodies.has(entry.id) })),
      ...model.statusBars.map((entry) => ({ entry, shown: () => true })),
      ...model.panels.map((entry) => ({ entry, shown: () => shownToolBodies.has(entry.id) })),
      ...model.views.map((entry) => ({ entry, shown: () => shownToolBodies.has(entry.id) || activeViews.has(entry.id) })),
      ...model.overlays.map((entry) => ({ entry, shown: (report?: Report) => overlayShown(report) }))
    ].map(({ entry, shown }) => {
      const report = this.reportFor(entry.id, connId, fallbackReports)
      return {
        id: entry.id,
        kind: entry.kind,
        plugin: entry.plugin,
        title: entry.title,
        shown: shown(report),
        ...(report ? { report: report.state } : {})
      }
    })
    return { windows, layout, slots, toasts: this.toastsOf(connId)?.toasts ?? [] }
  }

  /**
   * Opens an effective view with an optional input. NotFound for an unknown ID, InvalidParams for
   * another kind of contribution or an input over 64 KiB of JSON.
   */
  openView(id: string, input?: unknown): UiLayout {
    const windows = this.openWindows()
    if (windows.length > 1) throw conflict('multiple Quirky windows are open; specify connId')
    if (windows.length === 1) return this.openWindowView(windows[0]!.id, id, input)
    this.requireSlot(id, 'view')
    if (jsonLength(input) > MAX_JSON_LENGTH) throw invalidParams('input is over 64 KiB')
    const view = { id, ...(input !== undefined ? { input } : {}) }
    return this.change((layout) => {
      const worktree = worktreeOf(view)
      return {
        ...layout,
        view,
        viewTabs: viewTabOpened(layout.viewTabs ?? [], view),
        worktree: worktree === undefined ? layout.worktree ?? null : worktree
      }
    })
  }

  closeView(): UiLayout {
    const windows = this.openWindows()
    if (windows.length > 1) throw conflict('multiple Quirky windows are open; specify connId')
    if (windows.length === 1) return this.closeWindowView(windows[0]!.id)
    return this.change((layout) => {
      const viewTabs = viewTabClosed(layout.viewTabs ?? [], layout.view)
      const view = layout.view === null ? null : lastViewTab(viewTabs)
      return {
        ...layout,
        view,
        viewTabs,
        worktree: worktreeAfterViewChange(view, layout.worktree ?? null),
        focus: layout.view !== null && layout.focus === 'view' ? null : layout.focus
      }
    })
  }

  /** Opens a view only in the exact live UI connection. */
  openWindowView(connId: number, id: string, input?: unknown): UiLayout {
    const target = this.requireWindowById(connId)
    this.requireSlot(id, 'view')
    if (jsonLength(input) > MAX_JSON_LENGTH) throw invalidParams('input is over 64 KiB')
    const view = { id, ...(input !== undefined ? { input } : {}) }
    this.windowLayout(target.id)
    const auxiliary = this.auxiliaryView(target.id)
    if (auxiliary) {
      auxiliary.view = id
      auxiliary.viewTabs = viewTabOpened(auxiliary.viewTabs, view)
      const auxiliaryWorktree = worktreeOf(view)
      auxiliary.worktree = auxiliaryWorktree === undefined ? auxiliary.worktree : auxiliaryWorktree
      if (input === undefined) delete auxiliary.input
      else auxiliary.input = input
      this.options.sendTo(target, { type: 'desktop.window.changed', windows: [this.auxiliaryWindowSummary(auxiliary)] })
      return this.windowLayout(target.id)
    }

    const previous = this.windowViewFor(target.id)
    const viewTabs = viewTabOpened(previous.viewTabs, view)
    const worktreeUpdate = worktreeOf(view)
    const worktree = worktreeUpdate === undefined ? previous.worktree : worktreeUpdate
    if (this.openWindows().length === 1) {
      this.windowViews.delete(target.id)
      return this.change((layout) => ({ ...layout, view, viewTabs, worktree }))
    }
    this.windowViews.set(target.id, { ...previous, view, viewTabs, worktree })
    const next = this.windowLayout(target.id)
    this.options.sendTo(target, { type: 'ui.state.changed', layout: next })
    return next
  }

  /** Closes the exact live window's current view only if `expectedView` still matches in full. */
  closeWindowView(connId: number, expectedView?: NonNullable<UiLayout['view']>): UiLayout {
    const target = this.requireWindowById(connId)
    const currentLayout = this.windowLayout(target.id)
    const current = currentLayout.view
    if (expectedView !== undefined && !sameValue(current, expectedView)) {
      throw conflict('the window view changed before it could be closed')
    }
    const auxiliary = this.auxiliaryView(target.id)
    if (auxiliary) {
      const viewTabs = viewTabClosed(auxiliary.viewTabs, current)
      const view = current === null ? null : lastViewTab(viewTabs)
      auxiliary.viewTabs = viewTabs
      auxiliary.view = view?.id ?? null
      auxiliary.worktree = worktreeAfterViewChange(view, auxiliary.worktree)
      if (view?.input === undefined) delete auxiliary.input
      else auxiliary.input = view.input
      this.options.sendTo(target, { type: 'desktop.window.changed', windows: [this.auxiliaryWindowSummary(auxiliary)] })
      return this.windowLayout(target.id)
    }

    const previous = this.windowViewFor(target.id)
    const viewTabs = viewTabClosed(previous.viewTabs, current)
    const view = current === null ? null : lastViewTab(viewTabs)
    const worktree = worktreeAfterViewChange(view, previous.worktree)
    const focus = current !== null && currentLayout.focus === 'view' ? null : previous.focus
    if (this.openWindows().length === 1) {
      this.windowViews.delete(target.id)
      return this.change((layout) => ({
        ...layout,
        view,
        viewTabs,
        worktree,
        focus: current !== null && currentLayout.focus === 'view' ? null : layout.focus
      }))
    }
    this.windowViews.set(target.id, { view, viewTabs, worktree, ...(focus === undefined ? {} : { focus }) })
    const next = this.windowLayout(target.id)
    this.options.sendTo(target, { type: 'ui.state.changed', layout: next })
    return next
  }

  /** Opens the tool that hosts an effective panel, retaining the legacy panel field as a projection. */
  openPanel(id: string): UiLayout {
    this.requireSlot(id, 'panel')
    const tool = this.toolForContribution(id)
    if (!tool) throw notFound(`no tool for panel ${id}`)
    return this.change((layout) => {
      const slot = layout.tools!.placements[tool.id]!
      const tools = { ...layout.tools!, open: { ...layout.tools!.open, [slot]: tool.id } }
      return { ...layout, tools, panel: id }
    })
  }

  /** Configures the desired width for an effective panel. */
  configurePanel(id: string, width?: number): UiLayout {
    if (typeof id !== 'string' || id.length === 0) throw invalidParams('id must be a non-empty string')
    if (width === undefined) throw invalidParams('width must be provided')
    if (!isPanelWidth(width)) {
      throw invalidParams(`width must be an integer from ${PANEL_WIDTH_MIN} to ${PANEL_WIDTH_MAX}`)
    }
    this.requireSlot(id, 'panel')
    if (!this.toolForContribution(id)) throw notFound(`no tool for panel ${id}`)
    return this.change((layout) => ({
      ...layout,
      panelWidths: { ...layout.panelWidths, [id]: width }
    }))
  }

  closePanel(): UiLayout {
    return this.change((layout) => {
      const panelTool = layout.panel === null ? undefined : this.toolForContribution(layout.panel)
      const slot = panelTool ? layout.tools!.placements[panelTool.id] : undefined
      const open = { ...layout.tools!.open }
      if (slot && open[slot] === panelTool?.id) open[slot] = null
      const tools = { ...layout.tools!, open }
      const panel = this.panelForOpen(tools, null)
      return {
        ...layout,
        tools,
        panel,
        focus: layout.focus === 'panel' && panel === null ? null : layout.focus
      }
    })
  }

  setSidebar(visible: boolean): UiLayout {
    return this.change((layout) => {
      const worktrees = this.options.ui.contributions().tools?.find(({ id }) => id === 'sidebar-section:quirky.worktree/worktrees')
      const open = { ...layout.tools!.open }
      let actualVisible = false
      if (worktrees) {
        const slot = layout.tools!.placements[worktrees.id]!
        if (visible) open[slot] = worktrees.id
        else if (open[slot] === worktrees.id) open[slot] = null
        actualVisible = open[slot] === worktrees.id
      }
      const tools = { ...layout.tools!, open }
      return {
        ...layout,
        tools,
        sidebar: actualVisible,
        panel: this.panelForOpen(tools, layout.panel),
        focus: !actualVisible && layout.focus === 'sidebar' ? null : layout.focus
      }
    })
  }

  openTool(id: string): UiLayout {
    const tool = this.requireTool(id)
    return this.change((layout) => {
      const slot = layout.tools!.placements[id]!
      const open = { ...layout.tools!.open, [slot]: id }
      const tools = { ...layout.tools!, open }
      const panel = this.panelForOpen(
        tools,
        parseContributionId(tool.contributionId ?? '')?.kind === 'panel' ? tool.contributionId : layout.panel
      )
      const isWorktrees = id === 'sidebar-section:quirky.worktree/worktrees'
      return {
        ...layout,
        tools,
        panel,
        ...(isWorktrees ? { sidebar: true } : {})
      }
    })
  }

  closeTool(slot: UiToolSlot): UiLayout {
    this.requireToolSlot(slot)
    return this.change((layout) => {
      const closed = layout.tools!.open[slot]
      const open = { ...layout.tools!.open, [slot]: null }
      const tools = { ...layout.tools!, open }
      const panel = this.panelForOpen(tools, layout.panel)
      const closedTool = closed === null ? undefined : this.options.ui.contributions().tools?.find(({ id }) => id === closed)
      const focusTarget = closedTool ? focusTargetOfTool(closedTool) : undefined
      return {
        ...layout,
        tools,
        panel,
        ...(closed === 'sidebar-section:quirky.worktree/worktrees' ? { sidebar: false } : {}),
        focus: focusTarget !== undefined && layout.focus === focusTarget &&
          (focusTarget !== 'panel' || panel === null)
          ? null
          : layout.focus
      }
    })
  }

  moveTool(id: string, slot: UiToolSlot): UiLayout {
    const tool = this.requireTool(id)
    this.requireToolSlot(slot)
    return this.change((layout) => {
      const previousSlot = layout.tools!.placements[id]!
      const wasOpen = layout.tools!.open[previousSlot] === id
      const open = { ...layout.tools!.open }
      if (wasOpen) {
        open[previousSlot] = null
        open[slot] = id
      }
      const tools = {
        ...layout.tools!,
        placements: { ...layout.tools!.placements, [id]: slot },
        open
      }
      const panel = this.panelForOpen(
        tools,
        wasOpen && parseContributionId(tool.contributionId ?? '')?.kind === 'panel' ? tool.contributionId : layout.panel
      )
      return { ...layout, tools, panel }
    })
  }

  resizeTools(patch: unknown): UiLayout {
    if (!isRecord(patch)) throw invalidParams('resize params must be an object')
    const keys = Object.keys(patch)
    if (keys.length === 0) throw invalidParams('at least one tool size field must be provided')
    const sizes: Partial<UiToolLayout['sizes']> = {}
    for (const key of keys) {
      if (!(TOOL_SIZE_FIELDS as readonly string[]).includes(key)) {
        throw invalidParams(`unexpected tool size field ${key}`)
      }
      const sizeKey = key as keyof UiToolLayout['sizes']
      if (!validToolSize(sizeKey, patch[key])) {
        throw invalidParams(`${key} is outside its valid geometry range`)
      }
      sizes[sizeKey] = patch[key]
    }
    return this.change((layout) => ({
      ...layout,
      tools: { ...layout.tools!, sizes: { ...layout.tools!.sizes, ...sizes } }
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
    for (const [connId, override] of this.windowViews) {
      if (override.focus !== undefined) {
        const { focus: _focus, ...shared } = override
        this.windowViews.set(connId, shared)
      }
    }
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
    try {
      this.validateCommand(id, args)
    } catch (error) {
      return Promise.reject(error as Error)
    }
    const windows = this.openWindows()
    if (windows.length === 0) return Promise.reject(conflict('no Quirky window is open'))
    if (windows.length > 1) return Promise.reject(conflict('multiple Quirky windows are open; specify connId'))
    return this.route(windows[0]!, id, args)
  }

  /** Routes a UI command to the exact live target connection and preserves that connection for its reply. */
  runCommandOnWindow(connId: number, id: string, args: unknown): Promise<{ result: unknown }> {
    const target = this.requireWindowById(connId)
    this.validateCommand(id, args)
    return this.route(target, id, args)
  }

  /** Records capabilities reported by this exact UI window's trusted native preload. */
  setDesktopCapabilities(conn: ClientConn, capabilities: NativeDesktopCapabilities): void {
    this.requireWindow(conn)
    if (capabilities.notifications.permission || capabilities.notifications.click || capabilities.notifications.dismiss) {
      throw invalidParams('native notification permission and callbacks are unavailable in this SDK')
    }
    this.desktopCapabilitiesByWindow.set(conn.id, {
      directoryPicker: capabilities.directoryPicker,
      auxiliaryWindows: capabilities.auxiliaryWindows,
      revealItem: capabilities.revealItem,
      notifications: { ...DEFAULT_DESKTOP_CAPABILITIES.notifications }
    })
  }

  /** Reports the exact calling window's capabilities, or the currently focused window for a CLI caller. */
  desktopCapabilities(conn?: ClientConn): NativeDesktopCapabilities {
    const target = conn?.role === 'ui' ? conn : this.targetWindow()
    if (!target) return { ...DEFAULT_DESKTOP_CAPABILITIES, notifications: { ...DEFAULT_DESKTOP_CAPABILITIES.notifications } }
    const value = this.desktopCapabilitiesByWindow.get(target.id) ?? DEFAULT_DESKTOP_CAPABILITIES
    return { ...value, notifications: { ...value.notifications } }
  }

  pickFolder(conn: ClientConn, request: FolderPickerRequest): Promise<FolderPickerResult> {
    return this.requestDesktopShell(conn, { kind: 'folder-picker', request }) as Promise<FolderPickerResult>
  }

  openDesktopWindow(conn: ClientConn, request: DesktopWindowRequest): Promise<DesktopWindowResult> {
    this.requireSlot(request.view, 'view')
    if (jsonLength(request.input) > MAX_JSON_LENGTH) throw invalidParams('input is over 64 KiB')
    return this.requestDesktopShell(conn, { kind: 'window-open', request }) as Promise<DesktopWindowResult>
  }

  listDesktopWindows(conn?: ClientConn): DesktopWindowSummary[] {
    const routes = [...this.auxiliaryWindows.values()].filter((route) =>
      conn?.role !== 'ui' || route.ownerShell.connId === conn.id
    )
    return routes.map((route) => this.auxiliaryWindowSummary(route))
      .sort((left, right) => left.windowId.localeCompare(right.windowId))
  }

  attachDesktopWindow(conn: ClientConn, request: DesktopWindowAttachRequest): DesktopWindowSummary {
    this.requireWindow(conn)
    const route = this.auxiliaryWindows.get(request.windowId)
    if (!route) throw notFound(`no auxiliary window ${request.windowId}`)
    if (route.ownerShell.connId !== request.ownerShellConnId) throw conflict('auxiliary window owner does not match')
    if (route.rendererConnId !== null && route.rendererConnId !== conn.id) throw conflict('auxiliary window is attached to another UI connection')
    route.rendererConnId = conn.id
    this.announceDesktopWindows()
    return this.auxiliaryWindowSummary(route)
  }

  updateDesktopWindow(conn: ClientConn, request: DesktopWindowUpdateRequest): DesktopWindowSummary {
    this.requireWindow(conn)
    const route = this.auxiliaryWindows.get(request.windowId)
    if (!route || route.rendererConnId !== conn.id) throw conflict('this UI connection does not own the auxiliary window route')
    this.windowLayout(conn.id)
    if (request.view !== null) {
      this.requireSlot(request.view, 'view')
      if (jsonLength(request.input) > MAX_JSON_LENGTH) throw invalidParams('input is over 64 KiB')
      const view = { id: request.view, ...(request.input !== undefined ? { input: request.input } : {}) }
      route.viewTabs = viewTabOpened(route.viewTabs, view)
      route.view = request.view
      const worktreeUpdate = worktreeOf(view)
      route.worktree = worktreeUpdate === undefined ? route.worktree : worktreeUpdate
      if (request.input === undefined) delete route.input
      else route.input = request.input
    } else {
      const current = route.view === null ? null : { id: route.view, ...(route.input === undefined ? {} : { input: route.input }) }
      route.viewTabs = viewTabClosed(route.viewTabs, current)
      const view = current === null ? null : lastViewTab(route.viewTabs)
      route.view = view?.id ?? null
      route.worktree = worktreeAfterViewChange(view, route.worktree)
      if (view?.input === undefined) delete route.input
      else route.input = view.input
    }
    if (request.title !== undefined) route.title = request.title
    this.announceDesktopWindows()
    return this.auxiliaryWindowSummary(route)
  }

  desktopWindowClosed(conn: ClientConn, request: DesktopWindowClosedRequest): DesktopWindowCloseResult {
    if (conn.role !== 'desktop') throw invalidParams('only the native desktop shell can close an auxiliary window')
    const route = this.auxiliaryWindows.get(request.windowId)
    if (!route || route.ownerShell.connId !== request.ownerShellConnId) return { closed: false }
    this.auxiliaryWindows.delete(request.windowId)
    this.announceDesktopWindows()
    return { closed: true }
  }
  async runOwnerCommand(conn: ClientConn, request: DesktopWindowRunOwnerCommandRequest): Promise<DesktopWindowRunOwnerCommandResult> {
    const route = this.requireAttachedAuxiliaryWindow(conn, request.windowId)
    const owner = this.openWindows().find((window) => window.id === route.ownerShell.connId)
    if (!owner) throw conflict('the owning Quirky window is not connected')
    if (!this.options.ui.contributions().commands.some((command) => command.id === request.id)) {
      throw notFound(`no UI command ${request.id}`)
    }
    const args = request.args ?? {}
    const problem = validateValue(this.argsSchema(request.id), args, 'args')
    if (problem !== null) throw invalidParams(problem)
    const result = await this.route(owner, request.id, args)
    const activation = await this.requestDesktopShell(conn, {
      kind: 'window-activate-owner',
      request: { windowId: request.windowId }
    })
    if (!isRecord(activation) || !('activated' in activation) || activation.activated !== true) {
      throw conflict('the owning native window could not be activated')
    }
    return { result: result.result, activated: true }
  }


  closeDesktopWindow(conn: ClientConn, windowId: string): Promise<DesktopWindowCloseResult> {
    if (windowId.length === 0) throw invalidParams('windowId must be a non-empty string')
    const route = this.auxiliaryWindows.get(windowId)
    if (!route) throw notFound(`no auxiliary window ${windowId}`)
    const owner = conn.role === 'ui' ? conn : this.openWindows().find((window) => window.id === route.ownerShell.connId)
    if (!owner) throw conflict('the owning Quirky window is not connected')
    if (owner.id !== route.ownerShell.connId) throw conflict('auxiliary window belongs to another shell')
    return this.requestDesktopShell(owner, { kind: 'window-close', request: { windowId } }) as Promise<DesktopWindowCloseResult>
  }

  revealDesktopItem(conn: ClientConn, path: string): Promise<{ requested: true }> {
    if (!isAbsolute(path)) throw invalidParams('path must be absolute')
    return this.requestDesktopShell(conn, { kind: 'reveal-item', request: { path } }) as Promise<{ requested: true }>
  }


  /**
   * Keeps the toasts a window shows, replacing its earlier list. InvalidParams for a connection
   * that is not a window, a list that is not an array or one over 64 KiB of JSON.
   */
  reportToasts(conn: ClientConn, toasts: unknown): void {
    this.requireWindow(conn)
    if (!Array.isArray(toasts)) throw invalidParams('toasts must be an array')
    if (jsonLength(toasts) > MAX_JSON_LENGTH) throw invalidParams('toasts are over 64 KiB')
    this.toastReports.set(conn.id, { toasts: toasts as UiToastState[], order: ++this.reportCounter })
  }

  /**
   * Dismisses the toast with `key` in the window whose toasts `ui.state` lists, which runs its
   * onDismiss command. Conflict when no window is open, the window disconnects or stays silent;
   * NotFound when that window shows no toast with `key`.
   */
  async dismissToast(key: string): Promise<void> {
    if (!this.targetWindow()) throw conflict('no Quirky window is open')
    const shown = this.toastsOf(this.focusedConn()?.id)
    const target = shown ? this.openWindows().find((conn) => conn.id === shown.connId) : undefined
    if (!shown || !target || !shown.toasts.some((toast) => toast.key === key)) throw notFound(`no toast ${key}`)
    await this.route(target, TOAST_DISMISS, { key })
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

  /** Completes a native request only when the reply comes from the exact shell that received it. */
  desktopShellReply(conn: ClientConn, reply: DesktopShellReply): void {
    this.requireWindow(conn)
    const pending = this.pendingDesktop.get(reply.requestId)
    if (!pending || pending.conn !== conn) return
    if (reply.error) {
      this.settleDesktop(reply.requestId, (request) => request.reject(conflict(reply.error!.message)))
      return
    }
    const result = reply.result
    if (!nativeResultMatches(pending.action, result)) {
      this.settleDesktop(reply.requestId, (request) => request.reject(conflict('native desktop shell returned an invalid result')))
      return
    }
    if (pending.action.kind === 'window-open' && 'windowId' in result) {
      const request = pending.action.request
      if (this.auxiliaryWindows.has(result.windowId)) {
        this.settleDesktop(reply.requestId, (request) => request.reject(conflict('native desktop window identity was already registered')))
        return
      }
      const view = { id: request.view, ...(request.input === undefined ? {} : { input: request.input }) }
      this.auxiliaryWindows.set(result.windowId, {
        windowId: result.windowId,
        view: request.view,
        viewTabs: [view],
        worktree: worktreeOf(view) ?? null,
        ...(request.input === undefined ? {} : { input: request.input }),
        ...(request.title === undefined ? {} : { title: request.title }),
        ownerShell: { connId: conn.id, ...(conn.name ? { name: conn.name } : {}) },
        rendererConnId: null
      })
      this.announceDesktopWindows()
    } else if (pending.action.kind === 'window-close' && 'closed' in result && result.closed) {
      const route = this.auxiliaryWindows.get(pending.action.request.windowId)
      if (route?.ownerShell.connId === conn.id) {
        this.auxiliaryWindows.delete(route.windowId)
        this.announceDesktopWindows()
      }
    }
    this.settleDesktop(reply.requestId, (request) => request.resolve(result))
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
    this.toastReports.delete(conn.id)
    this.windowViews.delete(conn.id)
    for (const [requestId, pending] of this.pending) {
      if (pending.conn === conn) this.settle(requestId, (settled) => settled.reject(unanswered()))
    }
    this.desktopCapabilitiesByWindow.delete(conn.id)
    for (const [requestId, pending] of this.pendingDesktop) {
      if (pending.conn === conn) {
        this.settleDesktop(requestId, (request) => request.reject(conflict('the native desktop window disconnected before replying')))
      }
    }
    let auxiliaryRoutesChanged = false
    for (const [windowId, route] of this.auxiliaryWindows) {
      if (route.ownerShell.connId === conn.id || route.rendererConnId === conn.id) {
        this.auxiliaryWindows.delete(windowId)
        auxiliaryRoutesChanged = true
      }
    }
    if (auxiliaryRoutesChanged) this.announceDesktopWindows()
    if (conn.role === 'ui') {
      const windows = this.openWindows()
      const survivor = windows.length === 1 ? windows[0] : undefined
      if (survivor && !this.auxiliaryView(survivor.id)) {
        const override = this.windowViewFor(survivor.id)
        this.change((layout) => ({
          ...layout,
          view: override.view,
          viewTabs: override.viewTabs,
          worktree: override.worktree
        }))
      }
      this.announceWindows()
    }
  }



  private requestDesktopShell(conn: ClientConn, action: DesktopShellAction): Promise<DesktopShellResult> {
    const target = conn.role === 'ui' ? conn : this.targetDesktopWindow(action.kind)
    if (!target || target.closed || !this.supportsDesktopAction(this.desktopCapabilitiesByWindow.get(target.id), action.kind)) {
      throw conflict(`no capable native desktop window supports ${this.desktopActionLabel(action.kind)}`)
    }
    const requestId = crypto.randomUUID()
    const { promise, resolve, reject } = Promise.withResolvers<DesktopShellResult>()
    const timer = setTimeout(
      () => this.settleDesktop(requestId, (pending) => pending.reject(conflict('the native desktop window did not respond'))),
      this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
    )
    this.pendingDesktop.set(requestId, { conn: target, action, resolve, reject, timer })
    try {
      this.options.sendTo(target, {
        type: 'desktop.shell.request',
        requestId,
        action,
        ownerShell: { connId: target.id, ...(target.name ? { name: target.name } : {}) }
      })
    } catch {
      this.settleDesktop(requestId, (pending) => pending.reject(conflict('the native desktop request could not be delivered')))
    }
    return promise
  }

  private settleDesktop(requestId: string, finish: (pending: PendingDesktopRequest) => void): void {
    const pending = this.pendingDesktop.get(requestId)
    if (!pending) return
    this.pendingDesktop.delete(requestId)
    clearTimeout(pending.timer)
    finish(pending)
  }

  private targetDesktopWindow(kind: DesktopShellAction['kind']): ClientConn | undefined {
    const capable = this.openWindows().filter((conn) =>
      this.supportsDesktopAction(this.desktopCapabilitiesByWindow.get(conn.id), kind)
    )
    const focused = capable.filter((conn) => conn.focusedAt !== undefined)
    if (focused.length > 0) {
      return focused.reduce((best, conn) => (conn.focusedAt! > best.focusedAt! ? conn : best))
    }
    return capable.length === 1 ? capable[0] : undefined
  }

  private supportsDesktopAction(
    capabilities: NativeDesktopCapabilities | undefined,
    kind: DesktopShellAction['kind']
  ): boolean {
    if (!capabilities) return false
    switch (kind) {
      case 'folder-picker': return capabilities.directoryPicker
      case 'window-open':
      case 'window-close':
      case 'window-activate-owner': return capabilities.auxiliaryWindows
      case 'reveal-item': return capabilities.revealItem
    }
  }

  private desktopActionLabel(kind: DesktopShellAction['kind']): string {
    switch (kind) {
      case 'folder-picker': return 'directory selection'
      case 'window-open':
      case 'window-close':
      case 'window-activate-owner': return 'auxiliary windows'
      case 'reveal-item': return 'item reveal'
    }
  }
  private route(target: ClientConn, id: string, args: unknown): Promise<{ result: unknown }> {
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

  private requireAttachedAuxiliaryWindow(conn: ClientConn, windowId: string): AuxiliaryWindowRoute {
    this.requireWindow(conn)
    const route = this.auxiliaryWindows.get(windowId)
    if (!route) throw notFound(`no auxiliary window ${windowId}`)
    if (route.rendererConnId !== conn.id) throw conflict('this UI connection does not own the auxiliary window route')
    return route
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
  private requireWindowById(connId: number): ClientConn {
    if (!Number.isInteger(connId) || connId < 1) throw invalidParams('connId must be a positive integer')
    const target = [...this.options.clients()].find((conn) => conn.id === connId && !conn.closed)
    if (!target) throw conflict(`UI window connection ${connId} is not open`)
    if (target.role !== 'ui') throw invalidParams(`connection ${connId} is not a UI window`)
    return target
  }

  private auxiliaryView(connId: number): AuxiliaryWindowRoute | undefined {
    return [...this.auxiliaryWindows.values()].find((route) => route.rendererConnId === connId)
  }

  private windowViewFor(connId: number): WindowLayoutOverride {
    const existing = this.windowViews.get(connId)
    if (existing) return existing

    const windows = this.openWindows()
    const persisted = this.layout()
    const firstWindow = windows.reduce<ClientConn | undefined>(
      (first, conn) => (first === undefined || conn.id < first.id ? conn : first),
      undefined
    )
    const anotherOwnsView = [...this.windowViews].some(([id, override]) => id !== connId && override.view !== null)
    const usePersistedView = windows.length <= 1 || (firstWindow?.id === connId && !anotherOwnsView)
    const override = usePersistedView
      ? { view: persisted.view, viewTabs: persisted.viewTabs ?? [], worktree: persisted.worktree ?? null }
      : { view: null, viewTabs: [], worktree: null }
    this.windowViews.set(connId, override)
    return override
  }

  private windowLayout(connId: number): UiLayout {
    const layout = this.layout()
    const auxiliary = this.auxiliaryView(connId)
    if (auxiliary) {
      const model = this.options.ui.contributions()
      const effectiveViews = new Set(model.views.map((entry) => entry.id))
      const viewTabs = auxiliary.viewTabs.filter((tab) => effectiveViews.has(tab.id))
      let view =
        auxiliary.view !== null && effectiveViews.has(auxiliary.view)
          ? viewTabs.find((tab) => tab.id === auxiliary.view) ??
            { id: auxiliary.view, ...(auxiliary.input === undefined ? {} : { input: auxiliary.input }) }
          : null
      if (view === null && auxiliary.view !== null) view = lastViewTab(viewTabs)
      if (view !== null && !viewTabs.some((tab) => tab.id === view!.id)) viewTabs.push(view)
      auxiliary.viewTabs = viewTabs
      auxiliary.view = view?.id ?? null
      auxiliary.worktree = worktreeAfterViewChange(view, auxiliary.worktree)
      if (view?.input === undefined) delete auxiliary.input
      else auxiliary.input = view.input
      const auxiliaryLayout: UiLayout = {
        ...layout,
        view,
        viewTabs,
        worktree: auxiliary.worktree,
        panel: null,
        sidebar: false,
        focus: view === null ? null : 'view'
      }
      delete auxiliaryLayout.tools
      delete auxiliaryLayout.panelWidths
      delete auxiliaryLayout.palette
      return auxiliaryLayout
    }
    const override = this.windowViewFor(connId)
    const effectiveViews = new Set(this.options.ui.contributions().views.map((entry) => entry.id))
    const viewTabs = override.viewTabs.filter((tab) => effectiveViews.has(tab.id))
    let view = override.view !== null && effectiveViews.has(override.view.id) ? override.view : null
    if (view === null && override.view !== null) view = lastViewTab(viewTabs)
    if (view !== null && !viewTabs.some((tab) => tab.id === view!.id)) viewTabs.push(view)
    const nextOverride = {
      ...override,
      view,
      viewTabs,
      worktree: worktreeAfterViewChange(view, override.worktree)
    }
    if (!sameValue(override, nextOverride)) this.windowViews.set(connId, nextOverride)
    return {
      ...layout,
      view,
      viewTabs,
      worktree: nextOverride.worktree,
      ...(override.focus === undefined ? {} : { focus: override.focus })
    }
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

  private announceDesktopWindows(): void {
    this.options.broadcast({ type: 'desktop.window.changed', windows: this.listDesktopWindows() })
  }

  private auxiliaryWindowSummary(route: AuxiliaryWindowRoute): DesktopWindowSummary {
    return {
      windowId: route.windowId,
      view: route.view,
      ...(route.input === undefined ? {} : { input: route.input }),
      ...(route.title === undefined ? {} : { title: route.title }),
      ownerShell: { ...route.ownerShell },
      attached: route.rendererConnId !== null
    }
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

  private toastsOf(focusedConn: number | undefined): { connId: number; toasts: UiToastState[] } | undefined {
    if (focusedConn !== undefined) return { connId: focusedConn, toasts: this.toastReports.get(focusedConn)?.toasts ?? [] }
    let latest: { connId: number; toasts: UiToastState[]; order: number } | undefined
    for (const [connId, report] of this.toastReports) {
      if (!latest || report.order > latest.order) latest = { connId, ...report }
    }
    return latest
  }

  private reportFor(slot: string, connId: number | undefined, fallback: boolean): Report | undefined {
    const bySlot = this.reports.get(slot)
    if (!bySlot) return undefined
    const own = connId !== undefined ? bySlot.get(connId) : undefined
    if (own || !fallback) return own
    return [...bySlot.values()].reduce<Report | undefined>((best, report) => (!best || report.order > best.order ? report : best), undefined)
  }

  private argsSchema(commandId: string): Schema {
    const declaration = this.options.plugins.contributions({ kind: 'command' }).find((item) => item.id === commandId)
    const args = declaration?.data.args
    return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Schema) : { type: 'object' }
  }
  private validateCommand(id: string, args: unknown): void {
    if (!this.options.ui.contributions().commands.some((command) => command.id === id)) {
      throw notFound(`no UI command ${id}`)
    }
    const problem = validateValue(this.argsSchema(id), args ?? {}, 'args')
    if (problem !== null) throw invalidParams(problem)
  }


  /** The stored layout normalized against the current effective tool and view contributions. */
  private layout(): UiLayout {
    const raw = this.options.store.getUiState(LAYOUT_KEY)
    const stored = readStored(raw)
    const model = this.options.ui.contributions()
    const hasStoredTools = isRecord(raw) && Object.hasOwn(raw, 'tools')
    const tools = resolveToolLayout(model.tools ?? [], hasStoredTools && isRecord(raw) ? raw.tools : undefined, {
      hasStoredTools,
      hasStoredLayout: isRecord(raw),
      sidebar: stored.sidebar,
      panel: stored.panel
    })
    const effectiveViews = new Set(model.views.map((view) => view.id))
    let view = stored.view !== null && effectiveViews.has(stored.view.id) ? stored.view : null
    const viewTabs = (stored.viewTabs ?? []).filter((tab) => effectiveViews.has(tab.id))
    if (view === null && stored.view !== null) view = lastViewTab(viewTabs)
    if (view !== null && !viewTabs.some((tab) => tab.id === view!.id)) viewTabs.push(view)
    const worktree = worktreeAfterViewChange(view, stored.worktree ?? null)
    const worktrees = model.tools?.find(({ id }) => id === 'sidebar-section:quirky.worktree/worktrees')
    const sidebar = worktrees !== undefined && Object.values(tools.open).includes(worktrees.id)
    const layout: UiLayout = {
      ...stored,
      view,
      viewTabs,
      worktree,
      panel: this.panelForOpen(tools, stored.panel),
      sidebar,
      tools
    }
    if (!sameValue(raw, layout)) this.options.store.setUiState(LAYOUT_KEY, layout)
    return layout
  }

  private requireSlot(id: string, kind: 'view' | 'panel'): void {
    const parsed = parseContributionId(id)
    if (parsed && parsed.kind !== kind) throw invalidParams(`${id} is a ${parsed.kind}, not a ${kind}`)
    const model = this.options.ui.contributions()
    const effective = kind === 'view' ? model.views : model.panels
    if (!effective.some((entry) => entry.id === id)) throw notFound(`no ${kind} ${id}`)
  }

  private toolForContribution(id: string): UiToolEntry | undefined {
    return this.options.ui.contributions().tools?.find((tool) => tool.contributionId === id || tool.aliases.includes(id))
  }

  private requireTool(id: string): UiToolEntry {
    const tool = this.options.ui.contributions().tools?.find((entry) => entry.id === id)
    if (!tool) throw notFound(`no UI tool ${id}`)
    return tool
  }

  private requireToolSlot(slot: unknown): asserts slot is UiToolSlot {
    if (typeof slot !== 'string' || !(UI_TOOL_SLOTS as readonly string[]).includes(slot)) {
      throw invalidParams(`slot must be one of ${UI_TOOL_SLOTS.join(', ')}`)
    }
  }

  private panelForOpen(tools: UiToolLayout, preferred: string | null): string | null {
    const model = this.options.ui.contributions()
    const openIds = new Set(Object.values(tools.open).filter((id): id is string => id !== null))
    if (preferred !== null) {
      const tool = model.tools?.find((entry) => entry.contributionId === preferred || entry.aliases.includes(preferred))
      if (tool && openIds.has(tool.id) && parseContributionId(tool.contributionId ?? '')?.kind === 'panel') {
        return tool.contributionId
      }
    }
    for (const slot of UI_TOOL_SLOTS) {
      const id = tools.open[slot]
      const tool = id === null ? undefined : model.tools?.find((entry) => entry.id === id)
      if (tool && parseContributionId(tool.contributionId ?? '')?.kind === 'panel') return tool.contributionId
    }
    return null
  }

  private publishGlobalLayout(layout: UiLayout): void {
    this.options.broadcastNonWindows({ type: 'ui.state.changed', layout })
    for (const conn of this.openWindows()) {
      if (!conn.subscribed) continue
      this.options.sendTo(conn, { type: 'ui.state.changed', layout: this.windowLayout(conn.id) })
    }
  }

  private change(update: (layout: UiLayout) => UiLayout): UiLayout {
    const next = update(this.layout())
    this.options.store.setUiState(LAYOUT_KEY, next)
    this.publishGlobalLayout(next)
    return next
  }
}
