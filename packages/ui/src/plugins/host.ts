import {
  DEFAULT_THEME,
  RESERVED_CHORDS,
  THEME_TOKENS,
  chordFromKeyEvent,
  type QuirkyEvent,
  type SettingInfo,
  type UiCommandEntry,
  type UiModel,
  type UiPluginContext,
  type UiPluginModule,
  type UiSlotEntry
} from '@quirky/protocol'

/** What the host needs from its surroundings; the React shell wires these to `Connection` and the browser. */
export type HostDeps = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  onEvent(listener: (event: QuirkyEvent) => void): () => void
  importModule(url: string): Promise<unknown>
  toast(title: string, body: string): void
  log(message: string): void
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
  openView: { id: string; input?: unknown } | null
  openPanel: string | null
  /** `--<token>` to color for every theme token of the active theme. */
  themeVariables: Record<string, string>
}

type KeyEventLike = Parameters<typeof chordFromKeyEvent>[0]

type Session = {
  readonly pluginId: string
  readonly allowed: ReadonlySet<string>
  readonly provided: Map<string, unknown>
  readonly listeners: Set<(event: QuirkyEvent) => void | Promise<void>>
  activating: boolean
  violation: string | null
  revoked: boolean
}

type Runtime = {
  module?: UiPluginModule
  session?: Session
  /** The session whose `activate` is running; it receives events before it becomes `session`. */
  pending?: Session
  loading?: Promise<void>
  importAttempts: number
}

type MountHandle = {
  readonly id: string
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

const DEFAULT_ACTIVATION_TIMEOUT_MS = 10000

function isPluginModule(value: unknown): value is UiPluginModule {
  return typeof value === 'object' && value !== null && typeof (value as UiPluginModule).activate === 'function'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function findSlot(model: UiModel, id: string): UiSlotEntry | undefined {
  return [...model.sidebarSections, ...model.panels, ...model.views].find((entry) => entry.id === id)
}

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
}

/**
 * Loads plugin UI modules on demand and mounts their contributions into elements the shell owns.
 * It holds no React and touches no DOM global: an element is a value passed through to the
 * plugin's mount function, never inspected. All state the shell renders is in `getState()`.
 */
export class WindowPluginHost {
  private state: HostState = {
    model: null,
    settings: [],
    plugins: {},
    slots: {},
    openView: null,
    openPanel: null,
    themeVariables: {}
  }
  private readonly listeners = new Set<() => void>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly mounts = new Set<MountHandle>()
  private readonly unsubscribeEvents: () => void
  private refreshChain: Promise<unknown> = Promise.resolve()
  /** `setting.changed` values seen while a refresh fetches; they are newer than that refresh's snapshot. */
  private settingsSeenDuringFetch: Map<string, boolean | number | string> | null = null
  private stopped = false

  constructor(private readonly deps: HostDeps) {
    this.unsubscribeEvents = deps.onEvent((event) => this.handleEvent(event))
  }

  getState = (): HostState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Fetches the UI model and settings, then reconciles: mounted contributions that left or changed
   * owner are cleaned up, an open view or panel that left is closed, and plugins owning nothing are
   * deactivated. Refreshes run one after another; the last one's data wins.
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
   */
  mount(id: string, element: HTMLElement, props?: { input?: unknown }): () => void {
    const entry = this.state.model ? findSlot(this.state.model, id) : undefined
    if (!entry) {
      this.setSlot(id, { status: 'error', message: `no contribution ${id}` })
      return () => this.setSlot(id, null)
    }
    const handle: MountHandle = { id, plugin: entry.plugin, released: false }
    this.mounts.add(handle)
    this.setSlot(id, { status: 'loading' })
    void this.runMount(handle, entry, element, props)
    return () => this.release(handle)
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
      this.deps.toast(`${id} failed: ${messageOf(error)}`, messageOf(error))
    }
  }

  /**
   * Routes a key press to the `active` keybinding on its chord and runs that binding's command
   * without waiting for it. Returns whether the event was consumed; reserved chords never are.
   */
  handleKey(event: KeyEventLike): boolean {
    const chord = chordFromKeyEvent(event)
    if (chord === null || RESERVED_CHORDS.includes(chord)) return false
    const binding = this.state.model?.keybindings.find((b) => b.status === 'active' && b.key === chord)
    if (!binding) return false
    this.runCommand(binding.command).catch((error) => this.deps.log(`${binding.id}: ${messageOf(error)}`))
    return true
  }

  /** Commands whose title contains `filter` case-insensitively, in model order. */
  paletteCommands(filter: string): UiCommandEntry[] {
    const needle = filter.toLowerCase()
    return (this.state.model?.commands ?? []).filter((command) => command.title.toLowerCase().includes(needle))
  }

  /** Shows view `id` in place of any open view; the mount itself is the shell's `PluginSlot`. */
  openView(id: string, input?: unknown): void {
    if (!this.state.model?.views.some((view) => view.id === id)) {
      this.deps.log(`no view ${id}`)
      return
    }
    this.commit({ openView: { id, input } })
  }

  closeView(): void {
    if (this.state.openView) this.commit({ openView: null })
  }

  /** Opens panel `id` and closes any other open panel; with no `open`, toggles it. */
  togglePanel(id: string, open?: boolean): void {
    if (!this.state.model?.panels.some((panel) => panel.id === id)) {
      this.deps.log(`no panel ${id}`)
      return
    }
    const wanted = open ?? this.state.openPanel !== id
    if (wanted) this.commit({ openPanel: id })
    else if (this.state.openPanel === id) this.commit({ openPanel: null })
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
    this.unsubscribeEvents()
    for (const handle of [...this.mounts]) this.release(handle)
    for (const pluginId of this.runtimes.keys()) void this.deactivate(pluginId)
    this.listeners.clear()
  }

  private async fetchAndReconcile(): Promise<void> {
    const newer = new Map<string, boolean | number | string>()
    this.settingsSeenDuringFetch = newer
    let model: UiModel
    let snapshot: SettingInfo[]
    try {
      ;[model, snapshot] = await Promise.all([
        this.deps.call('ui.contributions', {}) as Promise<UiModel>,
        this.deps.call('setting.list', {}) as Promise<SettingInfo[]>
      ])
    } finally {
      this.settingsSeenDuringFetch = null
    }
    if (this.stopped) return
    const settings = snapshot.map((s) => (newer.has(s.id) ? { ...s, value: newer.get(s.id)! } : s))
    this.commit({ model, settings, themeVariables: themeVariablesOf(model) })
    await this.reconcile(model)
  }

  private async reconcile(model: UiModel): Promise<void> {
    const { openView, openPanel } = this.state
    if (openView && !model.views.some((view) => view.id === openView.id)) this.commit({ openView: null })
    if (openPanel && !model.panels.some((panel) => panel.id === openPanel)) this.commit({ openPanel: null })
    for (const handle of [...this.mounts]) {
      const entry = findSlot(model, handle.id)
      if (!entry || entry.plugin !== handle.plugin) this.release(handle)
    }
    const orphaned = [...this.runtimes.keys()].filter((id) => !this.owns(id))
    await Promise.all(orphaned.map((id) => this.deactivate(id)))
  }

  private owns(pluginId: string): boolean {
    const model = this.state.model
    if (!model) return false
    const entries = [...model.sidebarSections, ...model.panels, ...model.views, ...model.commands]
    return entries.some((entry) => entry.plugin === pluginId)
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
    const implementation = this.runtimes.get(entry.plugin)?.session?.provided.get(handle.id)
    if (typeof implementation !== 'function') {
      this.setSlot(handle.id, { status: 'error', message: `${entry.plugin} did not provide ${handle.id}` })
      return
    }
    try {
      const cleanup = implementation(element, entry.kind === 'view' ? { input: props?.input } : {})
      if (typeof cleanup === 'function') handle.cleanup = cleanup as () => void
    } catch (error) {
      this.setSlot(handle.id, { status: 'error', message: `${entry.plugin}: ${messageOf(error)}` })
      return
    }
    this.setSlot(handle.id, { status: 'mounted' })
  }

  private release(handle: MountHandle): void {
    handle.released = true
    this.mounts.delete(handle)
    const cleanup = handle.cleanup
    handle.cleanup = undefined
    if (cleanup) {
      try {
        cleanup()
      } catch (error) {
        this.deps.log(`${handle.plugin}: cleanup failed: ${messageOf(error)}`)
      }
    }
    if (![...this.mounts].some((other) => other.id === handle.id)) this.setSlot(handle.id, null)
  }

  private requireCommand(id: string): UiCommandEntry {
    const entry = this.state.model?.commands.find((command) => command.id === id)
    if (!entry) throw new NoCommand(id)
    return entry
  }

  private async invokeCommand(entry: UiCommandEntry, args: unknown): Promise<void> {
    await this.ensureLoaded(entry.plugin)
    const session = this.runtimes.get(entry.plugin)?.session
    if (!session || this.state.model?.commands.find((c) => c.id === entry.id)?.plugin !== entry.plugin) {
      throw new NoCommand(entry.id)
    }
    const handler = session.provided.get(entry.id)
    if (typeof handler !== 'function') throw new Error(`${entry.plugin} did not provide ${entry.id}`)
    await handler(args)
  }

  private runtime(pluginId: string): Runtime {
    let runtime = this.runtimes.get(pluginId)
    if (!runtime) {
      runtime = { importAttempts: 0 }
      this.runtimes.set(pluginId, runtime)
    }
    return runtime
  }

  private ensureLoaded(pluginId: string): Promise<void> {
    const runtime = this.runtime(pluginId)
    if (runtime.session) return Promise.resolve()
    if (runtime.loading) return runtime.loading
    const loading = this.load(pluginId, runtime).finally(() => {
      runtime.loading = undefined
    })
    runtime.loading = loading
    return loading
  }

  private async load(pluginId: string, runtime: Runtime): Promise<void> {
    const declared = this.state.model?.modules[pluginId]
    if (!declared) {
      this.fail(pluginId, `${pluginId} has no ui module`)
      throw new LoadFailure(`${pluginId} has no ui module`)
    }
    this.setPlugin(pluginId, { state: 'loading' })
    const session: Session = {
      pluginId,
      allowed: new Set(declared.provides),
      provided: new Map(),
      listeners: new Set(),
      activating: false,
      violation: null,
      revoked: false
    }
    runtime.pending = session
    try {
      await this.withTimeout(pluginId, this.importAndActivate(pluginId, runtime, declared.url, session))
    } catch (error) {
      revoke(session)
      this.fail(pluginId, messageOf(error))
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
    if (!this.owns(pluginId)) await this.deactivate(pluginId)
  }

  private async importAndActivate(pluginId: string, runtime: Runtime, url: string, session: Session): Promise<void> {
    if (!runtime.module) {
      const attempt = runtime.importAttempts++
      let imported: unknown
      try {
        imported = await this.deps.importModule(attempt === 0 ? url : `${url}?attempt=${attempt}`)
      } catch (error) {
        throw new LoadFailure(`${pluginId} failed to load: ${messageOf(error)}`)
      }
      if (session.revoked) return
      if (!isPluginModule(imported)) {
        throw new LoadFailure(`${pluginId} failed to load: module does not export activate`)
      }
      runtime.module = imported
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
    await this.retire(runtime, session)
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
    return {
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
      subscribe: live((listener: (event: QuirkyEvent) => void | Promise<void>) => {
        session.listeners.add(listener)
        return () => {
          session.listeners.delete(listener)
        }
      }),
      getSetting: live((name: string) => this.getSetting(pluginId, name)),
      executeCommand: live(async (id: string, args?: unknown) => {
        await this.invokeCommand(this.requireCommand(id), args)
      }),
      openView: live((id: string, input?: unknown) => this.openView(id, input)),
      closeView: live(() => this.closeView()),
      togglePanel: live((id: string, open?: boolean) => this.togglePanel(id, open))
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
    if (event.type === 'setting.changed') this.applySetting(event.id, event.value)
    if (event.type === 'plugin.changed' || event.type === 'theme.changed') {
      this.refresh().catch((error) => this.deps.log(`refresh failed: ${messageOf(error)}`))
    }
    setTimeout(() => this.deliver(event), 0)
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
