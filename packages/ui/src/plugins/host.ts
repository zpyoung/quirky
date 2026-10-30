import { nativeBrowserCapabilityForWindow } from '../native-browser'
import {
  pluginApiCompatibilityError,
  DEFAULT_THEME,
  THEME_TOKENS,
  chordFromKeyEvent,
  evaluateWhen,
  whenMentions,
  type QuirkyEvent,
  type SettingInfo,
  type ToastKind,
  type ToastOptions,
  type UiCommandEntry,
  type UiKeybinding,
  type UiLayout,
  type UiModel,
  type UiPluginContext,
  type UiPluginModule,
  type UiSlotEntry,
  type UiState,
  type UiToolResize,
  type UiToolSlot,
  type WindowRoute,
  type NativeBrowserCapability,
  type DesktopWindowSummary
} from '@quirky/protocol'
import type { DesktopWindowRoute } from '../desktop-bridge'

/** What the host needs from its surroundings; the React shell wires these to `Connection` and the browser. */
export type HostDeps = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  onEvent(listener: (event: QuirkyEvent) => void): () => void
  importModule(url: string): Promise<unknown>
  /** Binary terminal frames for stream `streamId`; the returned function unsubscribes. */
  onStream(streamId: number, listener: (bytes: Uint8Array) => void): () => void
  /** Connection status changes as plugins see them; the returned function unsubscribes. */
  onConnection(listener: (status: 'connected' | 'reconnecting') => void): () => void
  /** The shell's confirm dialog; resolves true when the person confirms. */
  confirm(options: { title: string; body?: string; confirmLabel?: string }): Promise<boolean>
  toast(title: string, body: string, kind: ToastKind, options?: ToastOptions): void
  /** Dismisses the toast keyed `key` and runs its `onDismiss`, for the daemon's `ui.toast.dismiss`; nothing happens when none has it. */
  dismissToast?(key: string): void
  log(message: string): void
  readClipboardText?: () => Promise<string>
  /** Source paths of the window's latest native file drop; absent outside the desktop shell. */
  nativeDropPaths?: (fileNames: readonly string[]) => Promise<string[] | null>
  nativeBrowser?: NativeBrowserCapability
  /** Window focus, reported to the daemon so it can pick the window a routed command runs in. */
  windowFocus?: { hasFocus(): boolean; subscribe(listener: (focused: boolean) => void): () => void }
  /** User input in the window (pointer, key, wheel), reported to the daemon so it knows someone is at the machine. */
  windowActivity?: { subscribe(listener: () => void): () => void }
  /** Route-local state for an auxiliary native window, if this webview owns one. */
  windowRoute?: DesktopWindowRoute | null
  /** The clock for activity throttling; defaults to `Date.now`. */
  now?: () => number
  /** Covers a plugin's import plus `activate`; defaults to 10000. */
  activationTimeoutMs?: number
}

export type SlotStatus = { status: 'loading' } | { status: 'mounted' } | { status: 'error'; message: string }

export type PluginStatus = { state: 'idle' | 'loading' | 'active' | 'failed'; error?: string }

/** Everything the React shell renders; replaced by a new object whenever any part changes. */
export type HostState = {
  model: UiModel | null
  settings: SettingInfo[]
  plugins: Record<string, PluginStatus>
  /** Keyed by contribution ID. */
  slots: Record<string, SlotStatus>
  /** The daemon's layout; the host never changes it locally. */
  layout: UiLayout
  /** `layout.view`, kept as the same object while its ID and input are unchanged. */
  openView: { id: string; input?: unknown } | null
  /** Route-local view state for an auxiliary native window; null in the main shell. */
  windowRoute: DesktopWindowRoute | null
  openPanel: string | null
  /** Panel ID to the count its plugin shows on the panel's toggle. */
  badges: Record<string, number>
  /** Panel ID to the tooltip its plugin gave the badge; absent means the default. */
  badgeTitles: Record<string, string>
  /** `--<token>` to color for every theme token of the active theme. */
  themeVariables: Record<string, string>
}

const ACTIVITY_REPORT_INTERVAL_MS = 15_000

type KeyEventLike = Parameters<typeof chordFromKeyEvent>[0] & { preventDefault?(): void }

type Session = {
  readonly pluginId: string
  readonly allowed: ReadonlySet<string>
  readonly provided: Map<string, unknown>
  readonly listeners: Set<(event: QuirkyEvent) => void | Promise<void>>
  /** Undo for everything the session registered outside itself (stream, layout and connection listeners, badges). */
  readonly cleanups: Set<() => void>
  activating: boolean
  violation: string | null
  revoked: boolean
}
type CommandDragCapability = {
  readonly token: string
  readonly owner: Session
  readonly command: string
  readonly args: Record<string, unknown>
  dispose(): void
}

type Runtime = {
  module?: UiPluginModule
  moduleUrl?: string
  moduleApiVersion?: unknown
  session?: Session
  /** The session whose `activate` is running; it receives events before it becomes `session`. */
  pending?: Session
  loading?: Promise<void>
  /** The `deactivate` call of a session being torn down; a new load for the plugin waits for it. */
  tearingDown?: Promise<void>
  importAttempts: number
}

type MountHandle = {
  readonly id: string
  readonly plugin: string
  readonly module: UiSlotEntry['module']
  cleanup?: () => void
  afterCleanup?: () => void
  finishRelease?: () => void
  released: boolean
  /** The last state the slot reported, sent again after a reconnect. */
  report?: { state: unknown }
}

/** A view another plugin embedded with `mountView`; it has no slot status and no report. */
type EmbeddedHandle = {
  readonly id: string
  /** The plugin that owns the view. */
  readonly plugin: string
  cleanup?: () => void
  released: boolean
}

class LoadFailure extends Error {}

class NoCommand extends Error {
  constructor(id: string) {
    super(`no command ${id}`)
  }
}

/** The routed request id the daemon uses to dismiss a toast; no plugin command can have it. */
const TOAST_DISMISS = 'ui.toast.dismiss'

const DEFAULT_ACTIVATION_TIMEOUT_MS = 10000

function isPluginModule(value: unknown): value is UiPluginModule {
  return typeof value === 'object' && value !== null && typeof (value as UiPluginModule).activate === 'function'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function findSlot(model: UiModel, id: string): UiSlotEntry | undefined {
  return [...model.sidebarSections, ...model.activityItems, ...model.statusBars, ...model.panels, ...model.settingsSections, ...model.views, ...model.overlays].find((entry) => entry.id === id)
}

/** Context keys the kernel gives meaning to: with both true, terminal keys go to the terminal first. */
const TERMINAL_FOCUS = 'terminalFocus'
const TERMINAL_KEYS_FIRST = 'terminalKeysFirst'

function themeVariablesOf(model: UiModel): Record<string, string> {
  const theme = model.themes.find((candidate) => candidate.id === model.theme.active) ?? DEFAULT_THEME
  const variables: Record<string, string> = {}
  for (const token of THEME_TOKENS) variables[`--${token}`] = theme.colors[token] ?? DEFAULT_THEME.colors[token]
  return variables
}

function revoke(session: Session): void {
  session.revoked = true
  session.listeners.clear()
  session.provided.clear()
  for (const cleanup of [...session.cleanups]) cleanup()
  session.cleanups.clear()
}

const DEFAULT_LAYOUT: UiLayout = { view: null, panel: null, sidebar: true, focus: null }

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Loads every enabled plugin's UI module once the window has the UI model, keeps it active while
 * the plugin stays enabled, and mounts its contributions into elements the shell owns.
 * It holds no React and touches no DOM global: an element is a value passed through to the
 * plugin's mount function, never inspected. Global layout is daemon-owned; auxiliary view/input
 * state is read and updated through the exact daemon-owned window route.
 */
export class WindowPluginHost {
  private state: HostState = {
    model: null,
    settings: [],
    plugins: {},
    slots: {},
    layout: DEFAULT_LAYOUT,
    openView: null,
    windowRoute: null,
    openPanel: null,
    badges: {},
    badgeTitles: {},
    themeVariables: {}
  }
  private readonly listeners = new Set<() => void>()
  private readonly layoutListeners = new Set<(layout: UiLayout) => void>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly mounts = new Set<MountHandle>()
  private readonly embedded = new Set<EmbeddedHandle>()
  private readonly contextValues = new Map<string, boolean>()
  /** The session that last set each context key; only it clears the key when it is revoked. */
  private readonly contextOwners = new Map<string, Session>()
  private readonly unsubscribeEvents: () => void
  private readonly unsubscribeFocus: (() => void) | undefined
  private readonly unsubscribeActivity: (() => void) | undefined
  private lastInputAt: number | null = null
  private windowConnId: number | null = null
  private lastActivityReportAt: number | null = null
  private readonly nativeBrowser: NativeBrowserCapability

  private refreshChain: Promise<unknown> = Promise.resolve()
  /** Events are newer than any `ui.state` snapshot whose request was already in flight. */
  private layoutEventVersion = 0
  /** `setting.changed` values seen while a refresh fetches; they are newer than that refresh's snapshot. */
  private settingsSeenDuringFetch: Map<string, boolean | number | string> | null = null
  private stopped = false
  private commandDrag: CommandDragCapability | null = null
  constructor(private readonly deps: HostDeps) {
    const windowRoute = deps.windowRoute ?? null
    if (windowRoute) {
      this.state = {
        ...this.state,
        windowRoute,
        openView: windowRoute.view === null
          ? null
          : { id: windowRoute.view, ...(windowRoute.input === undefined ? {} : { input: windowRoute.input }) }
      }
    }
    this.nativeBrowser = deps.nativeBrowser ?? nativeBrowserCapabilityForWindow()
    this.unsubscribeEvents = deps.onEvent((event) => this.handleEvent(event))
    this.unsubscribeFocus = deps.windowFocus?.subscribe((focused) => this.reportFocus(focused))
    this.unsubscribeActivity = deps.windowActivity?.subscribe(() => this.noteInput())
  }

  getState = (): HostState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Runs after each (re)connect: tells the daemon whether this window has focus and, if there was
   * input in the last 15 seconds, that someone is here (the daemon forgets both with the old
   * connection), sends the
   * mounted slots' reports again (the daemon drops them with the old connection), then refreshes.
   */
  async connected(): Promise<void> {
    await this.resolveWindowConnId()
    if (this.deps.windowFocus?.hasFocus()) this.reportFocus(true)
    if (this.lastInputAt !== null && this.now() - this.lastInputAt < ACTIVITY_REPORT_INTERVAL_MS) this.reportActivity()
    for (const handle of this.mounts) {
      if (handle.report && !handle.released) this.sendReport(handle, handle.report.state)
    }
    await this.refresh()
  }

  /**
   * Fetches the UI model, settings and layout, then reconciles: mounted contributions that left or
   * changed owner are cleaned up, plugins that are no longer enabled are deactivated and newly
   * enabled ones start loading in the background. Refreshes run one after another; the last one's
   * data wins.
   */
  refresh(): Promise<void> {
    const run = this.refreshChain.then(() => this.fetchAndReconcile())
    this.refreshChain = run.catch(() => undefined)
    return run
  }

  /**
   * Mounts contribution `id` into `element`, loading its plugin's module first if needed. The
   * returned function cleans the mount up and is safe to call more than once. Failures end up in
   * `slots[id]`, never as a throw.
   * React-owned mounts can defer disposal until their parent commit has completed.
   */
  mount(
    id: string,
    element: HTMLElement,
    props?: { input?: unknown },
    options?: { deferCleanup?: boolean; afterCleanup?: () => void }
  ): () => void {
    const entry = this.state.model ? findSlot(this.state.model, id) : undefined
    if (!entry) {
      this.setSlot(id, { status: 'error', message: `no contribution ${id}` })
      let released = false
      return () => {
        if (released) return
        released = true
        const finish = () => {
          options?.afterCleanup?.()
          this.setSlot(id, null)
        }
        if (options?.deferCleanup) queueMicrotask(finish)
        else finish()
      }
    }
    const handle: MountHandle = {
      id,
      plugin: entry.plugin,
      module: entry.module,
      afterCleanup: options?.afterCleanup,
      released: false
    }
    this.mounts.add(handle)
    this.setSlot(id, { status: 'loading' })
    void this.runMount(handle, entry, element, props)
    return () => this.release(handle, options?.deferCleanup ?? false)
  }

  /**
   * Runs command `id`, loading its plugin first if needed. Rejects only with `no command <id>`;
   * a failing load or handler becomes an error toast and the promise still resolves.
   */
  async runCommand(id: string, args?: unknown): Promise<void> {
    const entry = this.requireCommand(id)
    try {
      await this.invokeCommand(entry, args)
    } catch (error) {
      if (error instanceof NoCommand) throw error
      this.deps.log(`${entry.plugin}: ${id} failed: ${messageOf(error)}`)
      this.deps.toast(`${id} failed: ${messageOf(error)}`, messageOf(error), 'error')
    }
  }

  /**
   * Runs command `id` like `runCommand` and returns what its handler returned. Rejects with the
   * load failure, the handler's error, or `no command <id>`; it never toasts.
   */
  async runCommandForResult(id: string, args?: unknown): Promise<unknown> {
    return this.invokeCommand(this.requireCommand(id), args)
  }

  /**
   * Routes a key press to an active keybinding on its chord whose `when` holds. A binding with a
   * `when` beats one without; otherwise the first in model order wins. When `terminalKeysFirst` and
   * `terminalFocus` are both set, only bindings whose `when` mentions `terminalFocus` may fire.
   * Skipped keys are prevented so the webview never acts on them, but remain unconsumed so the
   * terminal receives them. Returns whether the event was consumed.
   */
  handleKey(event: KeyEventLike): boolean {
    const chord = chordFromKeyEvent(event)
    if (chord === null) return false
    const applicable = (this.state.model?.keybindings ?? []).filter(
      (b) => b.status === 'active' && b.key === chord && (b.when === undefined || evaluateWhen(b.when, this.contextValues))
    )
    if (applicable.length === 0) return false
    const terminalFirst = this.contextValues.get(TERMINAL_KEYS_FIRST) === true && this.contextValues.get(TERMINAL_FOCUS) === true
    const allowed = terminalFirst
      ? applicable.filter((b) => b.when !== undefined && whenMentions(b.when, TERMINAL_FOCUS))
      : applicable
    const binding: UiKeybinding | undefined = allowed.find((b) => b.when !== undefined) ?? allowed[0]
    if (!binding) {
      event.preventDefault?.()
      return false
    }
    this.runCommand(binding.command).catch((error) => this.deps.log(`${binding.id}: ${messageOf(error)}`))
    return true
  }

  /** Commands whose title contains `filter` case-insensitively, in model order. */
  paletteCommands(filter: string): UiCommandEntry[] {
    const needle = filter.toLowerCase()
    return (this.state.model?.commands ?? []).filter((command) => command.title.toLowerCase().includes(needle))
  }

  /** Updates the view in this window without changing another window's navigation. */
  openView(id: string, input?: unknown): void {
    const route = this.state.windowRoute
    if (route) {
      this.layoutCall('desktop.window.update', { windowId: route.windowId, view: id, ...(input !== undefined ? { input } : {}) })
      return
    }
    this.callWindowLayout('ui.window.view.open', { id, ...(input !== undefined ? { input } : {}) })
  }

  closeView(): void {
    const route = this.state.windowRoute
    if (route) {
      this.layoutCall('desktop.window.update', { windowId: route.windowId, view: null })
      return
    }
    const current = this.state.layout.view
    if (current) this.callWindowLayout('ui.window.view.close', { expectedView: current })
  }

  /** Panel controls address the same resolved tool authority as the host's stripes. */
  togglePanel(id: string, open?: boolean): void {
    const tool = this.state.model?.tools?.find((candidate) => candidate.id === id || candidate.aliases.includes(id))
    if (!tool) return
    const placement = this.state.layout.tools?.placements[tool.id] ?? tool.defaultSlot
    const current = this.state.layout.tools?.open[placement]
    const wanted = open ?? current !== tool.id
    if (wanted) this.openTool(tool.id)
    else if (current === tool.id) this.closeTool(placement)
  }

  openTool(id: string): void {
    this.layoutCall('ui.tool.open', { id })
  }

  closeTool(slot: UiToolSlot): void {
    this.layoutCall('ui.tool.close', { slot })
  }

  moveTool(id: string, slot: UiToolSlot): void {
    this.layoutCall('ui.tool.move', { id, slot })
  }

  resizeTools(sizes: UiToolResize): void {
    this.layoutCall('ui.tool.resize', { ...sizes })
  }


  /** Opens or closes the shared palette; omitted `open` toggles its daemon-owned state. */
  setPalette(open?: boolean): void {
    this.layoutCall('ui.palette.set', open === undefined ? {} : { open })
  }

  /** Tells the daemon that the person put focus in `target`, unless it is already there. */
  focus(target: 'sidebar' | 'view' | 'panel'): void {
    if (this.state.layout.focus !== target) this.layoutCall('ui.focus', { target })
  }

  /**
   * Applies every plugin setting change and the theme choice, even when some are refused, and
   * returns each refusal's message keyed by setting ID (`theme` for the theme).
   */
  async saveSettings(changes: {
    settings: Record<string, unknown>
    theme?: string
  }): Promise<{ errors: Record<string, string> }> {
    const errors: Record<string, string> = {}
    for (const [id, value] of Object.entries(changes.settings)) {
      try {
        await this.deps.call('setting.set', { id, value })
      } catch (error) {
        errors[id] = messageOf(error)
      }
    }
    if (changes.theme !== undefined) {
      try {
        await this.deps.call('theme.set', { id: changes.theme })
      } catch (error) {
        errors.theme = messageOf(error)
      }
    }
    return { errors }
  }

  /** Stops listening to the daemon, cleans up every mount and deactivates every active plugin. */
  stop(): void {
    this.stopped = true
    this.commandDrag?.dispose()
    this.unsubscribeEvents()
    this.unsubscribeFocus?.()
    this.unsubscribeActivity?.()
    for (const handle of [...this.mounts]) this.release(handle)
    for (const handle of [...this.embedded]) this.releaseEmbedded(handle)
    for (const pluginId of this.runtimes.keys()) void this.deactivate(pluginId)
    this.listeners.clear()
    this.layoutListeners.clear()
  }

  private async fetchAndReconcile(): Promise<void> {
    const newer = new Map<string, boolean | number | string>()
    this.settingsSeenDuringFetch = newer
    let model: UiModel
    let snapshot: SettingInfo[]
    try {
      // A layout snapshot and its reports are for this exact live UI connection.
      const connId = this.windowConnId ?? await this.resolveWindowConnId()
      const layoutVersion = this.layoutEventVersion
      const layout = (this.deps.call('ui.window.state', { connId }) as Promise<UiState>).then((state) => {
        if (!this.stopped && layoutVersion === this.layoutEventVersion) this.setLayout(state.layout)
      })
      const [fetchedModel, fetchedSettings] = await Promise.all([
        this.deps.call('ui.contributions', {}) as Promise<UiModel>,
        this.deps.call('setting.list', {}) as Promise<SettingInfo[]>,
        layout
      ])
      model = fetchedModel
      snapshot = fetchedSettings
    } finally {
      this.settingsSeenDuringFetch = null
    }
    if (this.stopped) return
    const settings = snapshot.map((s) => (newer.has(s.id) ? { ...s, value: newer.get(s.id)! } : s))
    // Tear down nested plugin roots before React sees slots whose containers are disappearing.
    this.releaseStaleMounts(model)
    this.commit({ model, settings, themeVariables: themeVariablesOf(model) })
    await this.reconcile(model)
  }

  private async reconcile(model: UiModel): Promise<void> {
    const onPanel = ([id]: [string, unknown]) => model.panels.some((panel) => panel.id === id)
    const badges = Object.entries(this.state.badges).filter(onPanel)
    if (badges.length !== Object.keys(this.state.badges).length) {
      this.commit({ badges: Object.fromEntries(badges), badgeTitles: Object.fromEntries(Object.entries(this.state.badgeTitles).filter(onPanel)) })
    }
    for (const handle of [...this.embedded]) {
      const entry = model.views.find((view) => view.id === handle.id)
      if (!entry || entry.plugin !== handle.plugin) this.releaseEmbedded(handle)
    }
    let changedModules: Promise<void>[] | undefined
    for (const [pluginId, runtime] of this.runtimes) {
      const declared = model.modules[pluginId]
      if (
        declared === undefined ||
        runtime.module === undefined ||
        (runtime.moduleUrl === declared.url && runtime.moduleApiVersion === declared.apiVersion)
      ) {
        continue
      }
      changedModules ??= []
      changedModules.push(this.deactivate(pluginId).then(() => this.forgetModule(runtime)))
    }
    if (changedModules) await Promise.all(changedModules)

    const departed = [...this.runtimes.keys()].filter((id) => !this.enabled(id))
    for (const id of departed) {
      // a plugin that failed and was then disabled gets a clean start when it comes back
      if (this.state.plugins[id]?.state === 'failed') this.setPlugin(id, { state: 'idle' })
    }
    await Promise.all(departed.map((id) => this.deactivate(id)))
    this.startEnabled(model)
  }

  private releaseStaleMounts(model: UiModel): void {
    for (const handle of [...this.mounts]) {
      const entry = findSlot(model, handle.id)
      const previous = this.state.model?.modules[handle.plugin]
      const next = model.modules[handle.plugin]
      const moduleChanged = previous?.url !== next?.url || previous?.apiVersion !== next?.apiVersion
      if (!entry || entry.plugin !== handle.plugin || entry.module !== handle.module || moduleChanged) this.release(handle)
    }
    for (const handle of [...this.embedded]) {
      const view = model.views.find((entry) => entry.id === handle.id)
      const previous = this.state.model?.modules[handle.plugin]
      const next = model.modules[handle.plugin]
      if (!view || view.plugin !== handle.plugin || previous?.url !== next?.url || previous?.apiVersion !== next?.apiVersion) {
        this.releaseEmbedded(handle)
      }
    }
  }

  /** Whether the daemon's model lists a UI module for the plugin, i.e. it is enabled and has code-backed UI. */
  private enabled(pluginId: string): boolean {
    return this.state.model?.modules[pluginId] !== undefined
  }

  /**
   * Starts loading each enabled plugin that has no session yet, without waiting for them. A plugin
   * whose last load failed is not retried here, only by a mount or command that needs it.
   */
  private startEnabled(model: UiModel): void {
    for (const pluginId of Object.keys(model.modules)) {
      const runtime = this.runtimes.get(pluginId)
      if (runtime?.session || this.state.plugins[pluginId]?.state === 'failed') continue
      this.ensureLoaded(pluginId).catch(() => undefined)
    }
  }

  private async runMount(
    handle: MountHandle,
    entry: UiSlotEntry,
    element: HTMLElement,
    props?: { input?: unknown }
  ): Promise<void> {
    try {
      await this.ensureLoaded(entry.plugin)
    } catch (error) {
      if (!handle.released) this.setSlot(handle.id, { status: 'error', message: messageOf(error) })
      return
    }
    if (handle.released) return
    const session = this.runtimes.get(entry.plugin)?.session
    const implementation = session?.provided.get(handle.id)
    if (typeof implementation !== 'function') {
      this.failSlot(handle, `${entry.plugin} did not provide ${handle.id}`)
      return
    }
    let cleanup: unknown
    const report = (state: unknown) => {
      if (handle.released) return
      handle.report = { state }
      this.sendReport(handle, state)
    }
    try {
      cleanup = implementation(element, entry.kind === 'view' ? { input: props?.input, report } : { report })
    } catch (error) {
      if (!handle.released) this.failSlot(handle, `${entry.plugin}: ${messageOf(error)}`)
      return
    }
    const cleanupFn = typeof cleanup === 'function' ? (cleanup as () => void) : undefined
    // A breach or concurrent disposal may release the handle during the mount callback.
    if (handle.released || this.runtimes.get(entry.plugin)?.session !== session) {
      if (handle.released && handle.finishRelease) handle.cleanup = cleanupFn
      else this.runCleanup(handle.plugin, cleanupFn)
      return
    }
    handle.cleanup = cleanupFn
    this.setSlot(handle.id, { status: 'mounted' })
    // the daemon learns an overlay is mounted from a report, so one that stays silent still sends this
    if (entry.kind === 'overlay' && handle.report === undefined) report({})
  }

  private async runEmbedded(handle: EmbeddedHandle, entry: UiSlotEntry, element: HTMLElement, input: unknown): Promise<void> {
    try {
      await this.ensureLoaded(entry.plugin)
    } catch {
      return
    }
    if (handle.released) return
    const session = this.runtimes.get(entry.plugin)?.session
    const implementation = session?.provided.get(handle.id)
    if (typeof implementation !== 'function') {
      this.deps.log(`${entry.plugin} did not provide ${handle.id}`)
      return
    }
    let cleanup: unknown
    try {
      cleanup = implementation(element, { input })
    } catch (error) {
      if (!handle.released) this.deps.log(`${entry.plugin}: ${messageOf(error)}`)
      return
    }
    const cleanupFn = typeof cleanup === 'function' ? (cleanup as () => void) : undefined
    if (handle.released || this.runtimes.get(entry.plugin)?.session !== session) {
      this.runCleanup(entry.plugin, cleanupFn)
      return
    }
    handle.cleanup = cleanupFn
  }

  private releaseEmbedded(handle: EmbeddedHandle): void {
    handle.released = true
    this.embedded.delete(handle)
    const cleanup = handle.cleanup
    handle.cleanup = undefined
    this.runCleanup(handle.plugin, cleanup)
  }

  private failSlot(handle: MountHandle, message: string): void {
    this.setSlot(handle.id, { status: 'error', message })
    this.deps.log(message.startsWith(handle.plugin) ? message : `${handle.plugin}: ${message}`)
  }

  private runCleanup(pluginId: string, cleanup: (() => void) | undefined): void {
    try {
      cleanup?.()
    } catch (error) {
      this.deps.log(`${pluginId}: cleanup failed: ${messageOf(error)}`)
    }
  }

  private release(handle: MountHandle, deferCleanup = false): void {
    if (handle.released) {
      if (!deferCleanup) handle.finishRelease?.()
      return
    }
    handle.released = true
    const finish = () => {
      if (handle.finishRelease !== finish) return
      handle.finishRelease = undefined
      this.mounts.delete(handle)
      const cleanup = handle.cleanup
      handle.cleanup = undefined
      this.runCleanup(handle.plugin, cleanup)
      this.runCleanup(handle.plugin, handle.afterCleanup)
      handle.afterCleanup = undefined
      if (![...this.mounts].some((other) => other.id === handle.id && !other.released)) {
        this.setSlot(handle.id, null)
        if (handle.report) this.callQuietly('ui.report', { slot: handle.id, state: null })
      }
    }
    handle.finishRelease = finish
    if (deferCleanup) queueMicrotask(finish)
    else finish()
  }

  private requireCommand(id: string): UiCommandEntry {
    const entry = this.state.model?.commands.find((command) => command.id === id)
    if (!entry) throw new NoCommand(id)
    return entry
  }

  private async invokeCommand(entry: UiCommandEntry, args: unknown): Promise<unknown> {
    await this.ensureLoaded(entry.plugin)
    const session = this.runtimes.get(entry.plugin)?.session
    if (!session || this.state.model?.commands.find((c) => c.id === entry.id)?.plugin !== entry.plugin) {
      throw new NoCommand(entry.id)
    }
    const handler = session.provided.get(entry.id)
    if (typeof handler !== 'function') throw new Error(`${entry.plugin} did not provide ${entry.id}`)
    return handler(args)
  }

  private runtime(pluginId: string): Runtime {
    let runtime = this.runtimes.get(pluginId)
    if (!runtime) {
      runtime = { importAttempts: 0 }
      this.runtimes.set(pluginId, runtime)
    }
    return runtime
  }

  private forgetModule(runtime: Runtime): void {
    runtime.module = undefined
    runtime.moduleUrl = undefined
    runtime.moduleApiVersion = undefined
    runtime.importAttempts = 0
  }

  /**
   * Resolves once the plugin has an active session, or its load failed (rejects). A session torn
   * down by a deactivation the caller raced with is replaced by a fresh load while the plugin is
   * still enabled.
   */
  private async ensureLoaded(pluginId: string): Promise<void> {
    const runtime = this.runtime(pluginId)
    const declared = this.state.model?.modules[pluginId]
    if (declared) {
      const compatibilityError = pluginApiCompatibilityError(declared.apiVersion)
      if (compatibilityError) {
        await this.deactivate(pluginId)
        this.forgetModule(runtime)
        const message = `${pluginId}: ${compatibilityError}`
        this.fail(pluginId, message)
        this.deps.log(message)
        throw new LoadFailure(message)
      }
      if (runtime.module && (runtime.moduleUrl !== declared.url || runtime.moduleApiVersion !== declared.apiVersion)) {
        await this.deactivate(pluginId)
        this.forgetModule(runtime)
      }
    }
    for (;;) {
      if (runtime.tearingDown) {
        await runtime.tearingDown
        continue
      }
      if (runtime.session) return
      if (this.stopped) return
      if (!runtime.loading) {
        const loading = this.load(pluginId, runtime).finally(() => {
          runtime.loading = undefined
        })
        runtime.loading = loading
      }
      await runtime.loading
      if (runtime.session || this.stopped || !this.enabled(pluginId)) return
    }
  }

  private async load(pluginId: string, runtime: Runtime): Promise<void> {
    const declared = this.state.model?.modules[pluginId]
    if (!declared) {
      this.fail(pluginId, `${pluginId} has no ui module`)
      this.deps.log(`${pluginId} has no ui module`)
      throw new LoadFailure(`${pluginId} has no ui module`)
    }
    this.setPlugin(pluginId, { state: 'loading' })
    const session: Session = {
      pluginId,
      allowed: new Set(declared.provides),
      provided: new Map(),
      listeners: new Set(),
      cleanups: new Set(),
      activating: false,
      violation: null,
      revoked: false
    }
    runtime.pending = session
    try {
      await this.withTimeout(pluginId, this.importAndActivate(pluginId, runtime, declared.url, declared.apiVersion, session))
    } catch (error) {
      revoke(session)
      this.fail(pluginId, messageOf(error))
      this.deps.log(messageOf(error))
      throw error
    } finally {
      runtime.pending = undefined
    }
    if (this.stopped) {
      this.setPlugin(pluginId, { state: 'idle' })
      await this.retire(runtime, session)
      return
    }
    runtime.session = session
    this.setPlugin(pluginId, { state: 'active' })
    if (!this.enabled(pluginId)) await this.deactivate(pluginId)
  }

  private async importAndActivate(
    pluginId: string,
    runtime: Runtime,
    url: string,
    apiVersion: unknown,
    session: Session
  ): Promise<void> {
    const checkDeclaration = (): void => {
      const declared = this.state.model?.modules[pluginId]
      if (!declared) throw new LoadFailure(`${pluginId} has no ui module`)
      const compatibilityError = pluginApiCompatibilityError(declared.apiVersion)
      if (compatibilityError) throw new LoadFailure(`${pluginId}: ${compatibilityError}`)
      if (declared.url !== url || declared.apiVersion !== apiVersion) {
        throw new LoadFailure(`${pluginId} UI module metadata changed while loading`)
      }
    }
    checkDeclaration()
    if (runtime.module && (runtime.moduleUrl !== url || runtime.moduleApiVersion !== apiVersion)) {
      this.forgetModule(runtime)
    }
    if (!runtime.module) {
      const attempt = runtime.importAttempts++
      let imported: unknown
      try {
        imported = await this.deps.importModule(attempt === 0 ? url : `${url}?attempt=${attempt}`)
      } catch (error) {
        throw new LoadFailure(`${pluginId} failed to load: ${messageOf(error)}`)
      }
      if (session.revoked) return
      if (this.state.model?.modules[pluginId]) checkDeclaration()
      if (!isPluginModule(imported)) {
        throw new LoadFailure(`${pluginId} failed to load: module does not export activate`)
      }
      runtime.module = imported
      runtime.moduleUrl = url
      runtime.moduleApiVersion = apiVersion
    }
    session.activating = true
    try {
      await runtime.module.activate(this.contextFor(session))
    } catch (error) {
      throw new LoadFailure(session.violation ?? `${pluginId} failed to activate: ${messageOf(error)}`)
    } finally {
      session.activating = false
    }
    if (session.violation) throw new LoadFailure(session.violation)
  }

  private withTimeout(pluginId: string, work: Promise<void>): Promise<void> {
    return this.within(work, () => new LoadFailure(`${pluginId} failed to activate: activation timed out`))
  }

  /** Settles with `work`, or rejects with `onTimeout()` once `activationTimeoutMs` passes. */
  private within(work: Promise<unknown>, onTimeout: () => Error): Promise<void> {
    const ms = this.deps.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms)
    })
    return Promise.race([work, timeout]).then(() => undefined).finally(() => clearTimeout(timer))
  }

  private fail(pluginId: string, message: string): void {
    this.setPlugin(pluginId, { state: 'failed', error: message })
  }

  private async deactivate(pluginId: string): Promise<void> {
    const runtime = this.runtimes.get(pluginId)
    const session = runtime?.session
    if (!runtime || !session) return
    runtime.session = undefined
    this.setPlugin(pluginId, { state: 'idle' })
    const teardown = this.retire(runtime, session)
    runtime.tearingDown = teardown
    try {
      await teardown
    } finally {
      if (runtime.tearingDown === teardown) runtime.tearingDown = undefined
    }
  }

  /** Runs `deactivate` for at most `activationTimeoutMs`, then revokes the context whatever happened. */
  private async retire(runtime: Runtime, session: Session): Promise<void> {
    try {
      await this.within(
        new Promise((resolve) => resolve(runtime.module?.deactivate?.())),
        () => new Error('deactivate timed out')
      )
    } catch (error) {
      this.deps.log(`${session.pluginId}: deactivate failed: ${messageOf(error)}`)
    } finally {
      revoke(session)
    }
  }

  /** An active plugin broke the provide contract: fail it, show the error in its slots, and drop its context. */
  private breach(session: Session, message: string): void {
    const runtime = this.runtimes.get(session.pluginId)
    if (!runtime || runtime.session !== session) return
    runtime.session = undefined
    for (const handle of [...this.mounts]) {
      if (handle.plugin !== session.pluginId) continue
      if (handle.released) {
        this.release(handle)
        continue
      }
      this.mounts.delete(handle)
      handle.released = true
      const cleanup = handle.cleanup
      handle.cleanup = undefined
      try {
        cleanup?.()
      } catch (error) {
        this.deps.log(`${handle.plugin}: cleanup failed: ${messageOf(error)}`)
      }
      this.setSlot(handle.id, { status: 'error', message })
      if (handle.report) this.callQuietly('ui.report', { slot: handle.id, state: null })
    }
    for (const handle of [...this.embedded]) {
      if (handle.plugin === session.pluginId) this.releaseEmbedded(handle)
    }
    revoke(session)
    this.fail(session.pluginId, message)
  }

  private contextFor(session: Session): UiPluginContext {
    const pluginId = session.pluginId
    const live = <A extends unknown[], R>(fn: (...args: A) => R) => {
      return (...args: A): R => {
        if (session.revoked) throw new Error(`${pluginId} is not active`)
        return fn(...args)
      }
    }
    const badged = new Set<string>()
    let contextTracked = false
    const track = (cleanup: () => void): (() => void) => {
      const once = () => {
        if (session.cleanups.delete(once)) cleanup()
      }
      session.cleanups.add(once)
      return once
    }
    return {
      nativeBrowser: {
        available: this.nativeBrowser.available,
        clearPartitionAvailable: this.nativeBrowser.clearPartitionAvailable,
        previewAvailable: this.nativeBrowser.previewAvailable,
        mount: live((element, options) => {
          const handle = this.nativeBrowser.mount(element, options)
          track(() => handle.dispose())
          return handle
        }),
        clearPartition: live((partition) => this.nativeBrowser.clearPartition(partition))
      },
      pluginId,
      log: (message) => this.deps.log(`${pluginId}: ${message}`),
      provide: live((contributionId: string, implementation: unknown) => {
        const problem = this.provideProblem(session, contributionId, implementation)
        if (problem) {
          if (!session.activating) this.breach(session, problem.violation)
          else if (!session.violation) session.violation = problem.violation
          throw new Error(problem.error)
        }
        session.provided.set(contributionId, implementation)
      }),
      call: live((method: string, params?: Record<string, unknown>) => this.deps.call(method, params ?? {})),
      readClipboardText: live(async () => {
        if (this.deps.readClipboardText) return this.deps.readClipboardText()
        return (await navigator.clipboard?.readText()) ?? ''
      }),
      nativeDropPaths: live(async (files: ArrayLike<{ name: string }>) => {
        if (!this.deps.nativeDropPaths) return null
        return this.deps.nativeDropPaths(Array.from(files, (file) => file.name))
      }),
      subscribe: live((listener: (event: QuirkyEvent) => void | Promise<void>) => {
        session.listeners.add(listener)
        return () => {
          session.listeners.delete(listener)
        }
      }),
      getSetting: live((name: string) => this.getSetting(pluginId, name)),
      executeCommand: live(async (id: string, args?: unknown) => {
        const command = this.requireCommand(id)
        const route = this.state.windowRoute
        if (route) {
          await this.deps.call('desktop.window.runOwnerCommand', { windowId: route.windowId, id, args: args ?? {} })
          return
        }
        await this.invokeCommand(command, args)
      }),
      createCommandDrag: live((command: string, args?: Record<string, unknown>) => {
        const snapshot = structuredClone(args ?? {})
        const token = crypto.randomUUID()
        this.commandDrag?.dispose()
        let entry!: CommandDragCapability
        const dispose = track(() => {
          if (this.commandDrag === entry) this.commandDrag = null
        })
        entry = { token, owner: session, command, args: snapshot, dispose }
        this.commandDrag = entry
        return token
      }),
      consumeCommandDrag: live((token: string) => {
        const entry = this.commandDrag
        if (!entry || entry.token !== token || entry.owner.revoked) return null
        entry.dispose()
        return { command: entry.command, args: entry.args }
      }),
      cancelCommandDrag: live((token: string) => {
        const entry = this.commandDrag
        if (entry?.token === token && entry.owner === session) entry.dispose()
      }),
      openView: live((id: string, input?: unknown) => this.openView(id, input)),
      closeView: live(() => this.closeView()),
      togglePanel: live((id: string, open?: boolean) => this.togglePanel(id, open)),
      setPalette: live((open?: boolean) => this.setPalette(open)),
      getLayout: live(() => this.layoutForWindow()),
      onLayout: live((listener: (layout: UiLayout) => void) => {
        this.layoutListeners.add(listener)
        return track(() => this.layoutListeners.delete(listener))
      }),
      onStream: live((streamId: number, listener: (bytes: Uint8Array) => void) =>
        track(this.deps.onStream(streamId, listener))
      ),
      onConnection: live((listener: (status: 'connected' | 'reconnecting') => void) =>
        track(this.deps.onConnection(listener))
      ),
      confirm: live((options: { title: string; body?: string; confirmLabel?: string }) => this.deps.confirm(options)),
      toast: live((title: string, body: string, options?: ToastOptions) =>
        this.deps.toast(title, body, options?.kind ?? 'info', options)
      ),
      setContext: live((key: string, value: boolean | undefined) => {
        if (value === undefined) {
          this.contextValues.delete(key)
          this.contextOwners.delete(key)
          return
        }
        this.contextValues.set(key, value)
        this.contextOwners.set(key, session)
        if (!contextTracked) {
          contextTracked = true
          track(() => {
            for (const [name, owner] of [...this.contextOwners]) {
              if (owner !== session) continue
              this.contextOwners.delete(name)
              this.contextValues.delete(name)
            }
          })
        }
      }),
      mountView: live((viewId: string, element: HTMLElement, input?: unknown) => {
        const entry = this.state.model?.views.find((candidate) => candidate.id === viewId)
        if (!entry) throw new Error(`no contribution ${viewId}`)
        const handle: EmbeddedHandle = { id: viewId, plugin: entry.plugin, released: false }
        this.embedded.add(handle)
        void this.runEmbedded(handle, entry, element, input)
        return track(() => this.releaseEmbedded(handle))
      }),
      setPanelBadge: live((panelId: string, count: number | null, title?: string) => {
        if (this.state.model?.panels.find((panel) => panel.id === panelId)?.plugin !== pluginId) {
          throw new Error(`${panelId} is not a panel of ${pluginId}`)
        }
        this.setBadge(panelId, count, title)
        if (count !== null && !badged.has(panelId)) {
          badged.add(panelId)
          track(() => this.setBadge(panelId, null))
        }
      })
    }
  }

  private provideProblem(
    session: Session,
    contributionId: string,
    implementation: unknown
  ): { violation: string; error: string } | null {
    if (!session.allowed.has(contributionId)) {
      const message = `${session.pluginId} does not declare ${contributionId}`
      return { violation: message, error: message }
    }
    if (typeof implementation !== 'function') {
      const message = `${session.pluginId} must provide a function for ${contributionId}`
      return { violation: message, error: message }
    }
    return null
  }

  private getSetting(pluginId: string, name: string): unknown {
    const id = name.startsWith('setting:') ? name : `setting:${pluginId}/${name}`
    const setting = this.state.settings.find((candidate) => candidate.id === id)
    if (!setting) throw new Error(`no setting ${id}`)
    return setting.value
  }

  private handleEvent(event: QuirkyEvent): void {
    if (event.type === 'desktop.shell.request') return
    if (event.type === 'ui.state.changed') {
      this.layoutEventVersion++
      this.setLayout(event.layout)
    }
    if (event.type === 'desktop.window.changed') this.updateAuxiliaryWindowRoute(event.windows)
    if (event.type === 'ui.command.request') void this.answerCommand(event.requestId, event.id, event.args)
    if (event.type === 'setting.changed') this.applySetting(event.id, event.value)
    const visibility = event.type === 'setting.changed' && (this.state.model?.visibilitySettings?.includes(event.id) ?? false)
    if (visibility || event.type === 'plugin.changed' || event.type === 'theme.changed' || event.type === 'ui.keybindings.changed') {
      const deliver = () => setTimeout(() => this.deliver(event), 0)
      void this.refresh().then(deliver, (error) => {
        this.deps.log(`refresh failed: ${messageOf(error)}`)
        deliver()
      })
      return
    }
    setTimeout(() => this.deliver(event), 0)
  }

  private layoutCall(method: string, params: Record<string, unknown>): void {
    this.deps.call(method, params).catch((error) => this.deps.log(`${method} failed: ${messageOf(error)}`))
  }
  private async resolveWindowConnId(): Promise<number> {
    const route = await this.deps.call('ui.window.self', {}) as WindowRoute
    if (!Number.isSafeInteger(route.connId) || route.connId < 1) {
      throw new Error('the daemon did not identify this UI connection')
    }
    this.windowConnId = route.connId
    return route.connId
  }

  private callWindowLayout(method: string, params: Record<string, unknown>): void {
    const call = (connId: number) => this.layoutCall(method, { connId, ...params })
    if (this.windowConnId !== null) {
      call(this.windowConnId)
      return
    }
    void this.resolveWindowConnId().then(call, (error) => {
      this.deps.log(`${method} failed: ${messageOf(error)}`)
    })
  }

  /** Takes the daemon's layout; auxiliary window views stay local to their exact window route. */
  private setLayout(layout: UiLayout): void {
    const current = this.state.layout
    if (sameJson(current, layout)) return
    const view = sameJson(current.view, layout.view) ? current.view : layout.view
    const next = { ...layout, view }
    const localView = this.state.windowRoute ? this.routeView(this.state.windowRoute) : view
    const openView = sameJson(this.state.openView, localView) ? this.state.openView : localView
    this.commit({ layout: next, openView, openPanel: layout.panel })
    const visibleLayout = this.layoutForWindow(next)
    for (const listener of [...this.layoutListeners]) {
      try {
        listener(visibleLayout)
      } catch (error) {
        this.deps.log(`layout listener failed: ${messageOf(error)}`)
      }
    }
  }

  private routeView(route: DesktopWindowRoute | null): { id: string; input?: unknown } | null {
    if (!route || route.view === null) return null
    return { id: route.view, ...(route.input === undefined ? {} : { input: route.input }) }
  }

  private layoutForWindow(layout: UiLayout = this.state.layout, route: DesktopWindowRoute | null = this.state.windowRoute): UiLayout {
    return route ? { ...layout, view: this.routeView(route) } : layout
  }

  private setWindowRoute(route: DesktopWindowRoute): void {
    if (sameJson(this.state.windowRoute, route)) return
    const routeView = this.routeView(route)
    const openView = sameJson(this.state.openView, routeView) ? this.state.openView : routeView
    this.commit({ windowRoute: route, openView })
    const visibleLayout = this.layoutForWindow(this.state.layout, route)
    for (const listener of [...this.layoutListeners]) {
      try {
        listener(visibleLayout)
      } catch (error) {
        this.deps.log(`layout listener failed: ${messageOf(error)}`)
      }
    }
  }

  private updateAuxiliaryWindowRoute(windows: DesktopWindowSummary[]): void {
    const current = this.state.windowRoute
    if (!current) return
    const summary = windows.find((window) => window.windowId === current.windowId)
    if (!summary) {
      this.setWindowRoute({ ...current, attached: false })
      return
    }
    this.setWindowRoute({
      windowId: summary.windowId,
      ownerShellConnId: summary.ownerShell.connId,
      ...(summary.ownerShell.name ? { ownerShellName: summary.ownerShell.name } : {}),
      view: summary.view,
      ...(summary.input === undefined ? {} : { input: summary.input }),
      ...(summary.title === undefined ? {} : { title: summary.title }),
      attached: summary.attached
    })
  }

  private setBadge(panelId: string, count: number | null, title?: string): void {
    const { [panelId]: previous, ...rest } = this.state.badges
    const { [panelId]: previousTitle, ...restTitles } = this.state.badgeTitles
    const nextTitle = count === null ? undefined : title
    if (previous === (count ?? undefined) && previousTitle === nextTitle) return
    this.commit({
      badges: count === null ? rest : { ...rest, [panelId]: count },
      badgeTitles: nextTitle === undefined ? restTitles : { ...restTitles, [panelId]: nextTitle }
    })
  }

  private reportFocus(focused: boolean): void {
    // the daemon forgets focus with the connection, so a blur that fails to send costs nothing
    this.deps.call('ui.window.focused', { focused }).catch(() => undefined)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private noteInput(): void {
    this.lastInputAt = this.now()
    if (this.lastActivityReportAt === null || this.lastInputAt - this.lastActivityReportAt >= ACTIVITY_REPORT_INTERVAL_MS) {
      this.reportActivity()
    }
  }

  private reportActivity(): void {
    this.lastActivityReportAt = this.now()
    // the daemon forgets presence with the connection, so a report that fails to send costs nothing
    this.deps.call('ui.window.activity', {}).catch(() => undefined)
  }

  private sendReport(handle: MountHandle, state: unknown): void {
    this.deps.call('ui.report', { slot: handle.id, state: state ?? null }).catch((error) => {
      this.deps.log(`${handle.plugin}: report for ${handle.id} failed: ${messageOf(error)}`)
    })
  }

  private callQuietly(method: string, params: Record<string, unknown>): void {
    this.deps.call(method, params).catch(() => undefined)
  }

  /** Runs a command the daemon routed to this window and sends back what it returned or threw. */
  private async answerCommand(requestId: string, id: string, args: unknown): Promise<void> {
    let reply: Record<string, unknown>
    try {
      const result = id === TOAST_DISMISS ? this.dismissToast(args) : await this.runCommandForResult(id, args)
      JSON.stringify(result)
      reply = { requestId, ...(result !== undefined ? { result } : {}) }
    } catch (error) {
      reply = { requestId, error: { message: messageOf(error) } }
    }
    try {
      await this.deps.call('ui.command.reply', reply)
    } catch (error) {
      this.deps.log(`reply to ${id} failed: ${messageOf(error)}`)
    }
  }

  private dismissToast(args: unknown): null {
    const key = (args as { key?: unknown } | null)?.key
    if (typeof key === 'string') this.deps.dismissToast?.(key)
    return null
  }

  private applySetting(id: string, value: boolean | number | string): void {
    this.settingsSeenDuringFetch?.set(id, value)
    if (!this.state.settings.some((setting) => setting.id === id)) return
    this.commit({ settings: this.state.settings.map((s) => (s.id === id ? { ...s, value } : s)) })
  }

  private deliver(event: QuirkyEvent): void {
    for (const runtime of this.runtimes.values()) {
      const session = runtime.session ?? runtime.pending
      if (!session) continue
      for (const listener of [...session.listeners]) void this.notify(session, listener, event)
    }
  }

  private async notify(
    session: Session,
    listener: (event: QuirkyEvent) => void | Promise<void>,
    event: QuirkyEvent
  ): Promise<void> {
    if (session.revoked) return
    try {
      await listener(event)
    } catch (error) {
      this.deps.log(`${session.pluginId}: event listener failed: ${messageOf(error)}`)
    }
  }

  private setPlugin(pluginId: string, status: PluginStatus): void {
    const current = this.state.plugins[pluginId]
    if (current?.state === status.state && current.error === status.error) return
    this.commit({ plugins: { ...this.state.plugins, [pluginId]: status } })
  }

  private setSlot(id: string, status: SlotStatus | null): void {
    const current = this.state.slots[id]
    if (status === null) {
      if (!current) return
      const { [id]: _dropped, ...rest } = this.state.slots
      this.commit({ slots: rest })
      return
    }
    const same =
      current?.status === status.status &&
      (current.status !== 'error' || (status.status === 'error' && current.message === status.message))
    if (!same) this.commit({ slots: { ...this.state.slots, [id]: status } })
  }

  private commit(patch: Partial<HostState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
