import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  formatContributionId,
  isPluginId,
  parseContributionId,
  type ContributionInfo,
  type PluginContext,
  type PluginDiagnostic,
  type PluginInfo,
  type PluginModule,
  type QuirkyEvent
} from '@quirky/protocol'
import { conflict, invalidParams, notFound } from '../errors'
import type { Store } from '../store'
import { resolveCliAliases, type CliAliasResolution } from './cli-catalog'
import { discoverPlugins, type DiscoveredPlugin } from './discover'
import { computeRegistry, type Registry, type RegistryPlugin } from './registry'

type ExtensionMembers = Pick<
  PluginContext,
  'dataDir' | 'emit' | 'subscribe' | 'call' | 'openStore' | 'getSetting' | 'error' | 'home' | 'pty' | 'notify' | 'launch'
> &
  Partial<Pick<PluginContext, 'storedSettingValue'>>

/** The daemon-side half of a plugin's context, created and torn down per activation attempt. */
export type ContextExtension = {
  /**
   * Runs once per activation attempt, before the module's `activate`. `isRevoked` turns true when
   * the attempt ends, so handles it returns can refuse use after that.
   */
  create(
    plugin: { id: string; dir: string },
    isRevoked: () => boolean
  ): ExtensionMembers
  /** Runs once per attempt that called `create`, after the module's `deactivate` settles. */
  revoke(pluginId: string): void
}

export type PluginHostOptions = {
  /** Directory of plugins shipped with Quirky, or null for none. */
  builtinDir: string | null
  /** Directory of user-installed plugins (`<home>/plugins`). */
  installedDir: string
  store: Pick<Store, 'listDisabledIds' | 'setDisabledId'>
  emit(event: QuirkyEvent): void
  log(message: string): void
  /** Bounds each activation and each deactivate; defaults to 10 seconds. */
  activationTimeoutMs?: number
  /** True in safe mode: only built-ins load and nothing stored disables or layers anything. */
  safeMode?: boolean
  /** IDs the installed distro turns off. */
  distroDisabled?: () => string[]
  /** Supplies the context members the host cannot; without it they throw or return defaults. */
  extension?: ContextExtension
  /**
   * Derives extra diagnostics, keyed by plugin ID, from every declaration and the plugin list as it
   * would be listed without them. Runs once per registry computation and never emits `plugin.changed`.
   */
  deriveDiagnostics?: (view: {
    declarations: ContributionInfo[]
    plugins: PluginInfo[]
  }) => Map<string, PluginDiagnostic[]>
}

const FUNCTION_KINDS = new Set(['method', 'job', 'launch-hook'])

const DEFAULT_TIMEOUT_MS = 10_000

type RuntimeState = 'inactive' | 'activating' | 'active' | 'failed'

/** One activation's context and the implementations it provided; revoked when it ends. */
type Attempt = {
  revoked: boolean
  /** True once `extension.create` ran for this attempt and `extension.revoke` has not. */
  extensionLive: boolean
  implementations: Map<string, unknown>
}

type Runtime = {
  state: RuntimeState
  error?: string
  warnings: PluginDiagnostic[]
  attempt?: Attempt
  module?: PluginModule
  inflight?: Promise<void>
}

class TimedOut extends Error {}

let hostSerial = 0

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(work: () => T | Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(message)), ms)
  })
  const run = (async () => work())()
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Owns the plugin registry and every plugin's runtime state. Plugin code is imported only when a
 * plugin activates: on resolve, `activate`, as a dependency of an activating plugin, or at
 * startup. Listing, `load` and enabling a lazy plugin never import anything.
 */
export class PluginHost {
  private discovered: DiscoveredPlugin[] = []
  private registry: Registry = computeRegistry([], new Set())
  private readonly runtimes = new Map<string, Runtime>()
  private derivedDiagnostics = new Map<string, PluginDiagnostic[]>()
  private cliAliases: CliAliasResolution = { accepted: new Map(), dropped: new Map() }
  private activationOrder: string[] = []
  /** Why each disabled plugin is off, as of the last recompute. */
  private disabledSets = { user: new Set<string>(), distro: new Set<string>(), safeMode: new Set<string>() }
  /** Plugins whose directory is being swapped; they can't activate until the rescan that follows. */
  private readonly replacing = new Set<string>()
  /**
   * Bumped when a plugin is released. Bun caches a module by its path, helpers included, so an
   * installed plugin's later generations import through a fresh symlink to its directory instead.
   */
  private readonly generations = new Map<string, number>()
  private readonly generationLinks = new Map<string, string>()
  private readonly serial = ++hostSerial
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private readonly timeoutMs: number

  constructor(private readonly options: PluginHostOptions) {
    this.timeoutMs = options.activationTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Discovers plugins and computes the registry. Runs no plugin code and never throws. */
  load(): void {
    this.discovered = discoverPlugins({ builtin: this.options.builtinDir, installed: this.options.installedDir })
    this.recompute()
  }

  /** Activates every enabled `startup` plugin. Failures are recorded on the plugin and logged, never thrown. */
  async activateStartup(): Promise<void> {
    await Promise.allSettled(this.startupCandidates().map((id) => this.activateQuietly(id)))
  }

  /**
   * Re-runs discovery and recomputes the registry, deactivates plugins that vanished, changed
   * version or are no longer enabled (and the plugins that depend on them), starts new `startup`
   * plugins and broadcasts `plugin.changed`. Calls run one at a time with `setEnabled`.
   */
  rescan(): Promise<void> {
    return this.enqueue(() => this.applyRescan())
  }

  /**
   * Deactivates `pluginId`, runs `change` (which replaces or deletes its directory), then rescans.
   * The plugin can't activate in between, so a same-version reinstall never runs half-swapped code,
   * and its next activation loads the code `change` left behind.
   */
  replacePlugin(pluginId: string, change: () => void | Promise<void>): Promise<void> {
    return this.replacePlugins([pluginId], change)
  }

  /** Like `replacePlugin` for several plugins swapped by one `change`, whatever their versions. */
  replacePlugins(pluginIds: string[], change: () => void | Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      for (const id of pluginIds) this.replacing.add(id)
      try {
        await this.release(new Set(pluginIds))
        await change()
      } finally {
        for (const id of pluginIds) this.replacing.delete(id)
        await this.applyRescan()
      }
    })
  }

  /** Every discovered entry sorted by ID, built-in first; a duplicate ID appears once per source. */
  list(): PluginInfo[] {
    return this.registry.entries.map((entry) => this.infoOf(entry))
  }

  /** The `cli` module path and declared `cliAliases` of a plugin's manifest; empty for an unknown or unparsable plugin. */
  cliOf(pluginId: string): { cli?: string; cliAliases: string[] } {
    const manifest = this.registry.plugins.get(pluginId)?.discovered.manifest
    return { ...(manifest?.cli === undefined ? {} : { cli: manifest.cli }), cliAliases: manifest?.cliAliases ?? [] }
  }

  /** The declared aliases of a plugin that lost a collision check, each with the reason. */
  droppedCliAliases(pluginId: string): { alias: string; reason: string }[] {
    return this.cliAliases.dropped.get(pluginId) ?? []
  }

  /** The contributions in effect, or every declaration with `all`, optionally narrowed by kind or declaring plugin. */
  contributions(filter: { kind?: string; pluginId?: string; all?: boolean } = {}): ContributionInfo[] {
    const source = filter.all ? this.registry.declarations : [...this.registry.effective.values()]
    return source
      .filter((item) => filter.kind === undefined || item.kind === filter.kind)
      .filter((item) => filter.pluginId === undefined || item.plugin === filter.pluginId)
      .sort((a, b) => compare(a.id, b.id) || compare(a.plugin, b.plugin))
  }

  /**
   * The directory and `ui` path of the usable plugin with this ID, or null when there is none, it
   * is invalid or it declares no `ui`. An invalid duplicate never hides a valid one.
   */
  pluginFiles(pluginId: string): { dir: string; ui: string } | null {
    const entry = this.registry.plugins.get(pluginId)
    const ui = entry?.discovered.manifest?.ui
    if (!entry || entry.status === 'invalid' || ui === undefined) return null
    return { dir: entry.discovered.dir, ui }
  }

  /**
   * Activates a plugin and its dependencies and returns its new state. Rejects NotFound for an
   * unknown ID and Conflict for a disabled, invalid or failing plugin.
   */
  async activate(pluginId: string): Promise<PluginInfo> {
    await this.activateInternal(pluginId)
    return this.infoOf(this.registry.plugins.get(pluginId)!)
  }

  /**
   * Looks up a contribution in effect, activates its owner and returns the declaration with the
   * implementation the owner provided (undefined when it provided none). NotFound unless the ID
   * is in effect.
   */
  async resolve(id: string): Promise<{ contribution: ContributionInfo; implementation: unknown }> {
    const contribution = this.registry.effective.get(id)
    if (!contribution) throw notFound(`no contribution ${id} is in effect`)
    await this.activateInternal(contribution.plugin)
    const current = this.registry.effective.get(id)
    const runtime = this.runtimeOf(contribution.plugin)
    if (current?.plugin !== contribution.plugin || runtime.state !== 'active') {
      throw notFound(`no contribution ${id} is in effect`)
    }
    return { contribution: current, implementation: runtime.attempt?.implementations.get(id) }
  }

  /** Like `resolve`, but Conflict when the owner activated without providing the implementation. */
  async resolveImplementation(id: string): Promise<unknown> {
    const { contribution, implementation } = await this.resolve(id)
    if (implementation === undefined) throw conflict(`${contribution.plugin} did not provide ${id}`)
    return implementation
  }

  /**
   * Enables or disables a plugin or a contribution ID and persists it. Calls run one at a time.
   * Disabling waits for an in-flight activation of an affected plugin and deactivates it;
   * enabling activates newly enabled startup plugins. Idempotent.
   */
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.enqueue(() => this.applyEnabled(id, enabled))
  }

  /** Appends a warning to a plugin's diagnostics until it next activates. Ignored for an unknown plugin. */
  addWarning(pluginId: string, message: string): void {
    if (!this.registry.plugins.has(pluginId)) return
    this.runtimeOf(pluginId).warnings.push({ level: 'warning', message })
    this.changed()
  }

  /** Waits for in-flight activations, then deactivates every active plugin in reverse activation order. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.queue
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.inflight))
    for (const id of [...this.activationOrder].reverse()) await this.deactivate(id)
    for (const id of [...this.generationLinks.keys()]) this.removeLink(id)
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private recompute(): void {
    const safeMode = this.options.safeMode === true
    const user = new Set(safeMode ? [] : this.options.store.listDisabledIds())
    const distro = new Set(safeMode ? [] : (this.options.distroDisabled?.() ?? []))
    const inSafeMode = new Set(
      safeMode ? this.discovered.filter((plugin) => plugin.source === 'installed' && plugin.errors.length === 0).map((plugin) => plugin.id) : []
    )
    this.disabledSets = { user, distro, safeMode: inSafeMode }
    this.registry = computeRegistry(this.discovered, new Set([...user, ...inSafeMode]), [...distro])
    this.cliAliases = this.resolveAliases()
    this.derivedDiagnostics = new Map()
    const derive = this.options.deriveDiagnostics
    if (!derive) return
    try {
      this.derivedDiagnostics = derive({ declarations: this.contributions({ all: true }), plugins: this.list() })
    } catch (error) {
      this.options.log(`deriving plugin diagnostics failed: ${messageOf(error)}`)
    }
  }

  /** Alias collisions among the plugins whose CLI group exists: those with a command or method in effect. */
  private resolveAliases(): CliAliasResolution {
    const owners = new Set(
      [...this.registry.effective.values()]
        .filter((item) => item.kind === 'cli-command' || item.kind === 'method')
        .map((item) => item.plugin)
    )
    const claimants = [...owners].flatMap((id) => {
      const entry = this.registry.plugins.get(id)
      if (!entry || entry.status === 'invalid') return []
      return [{ id, source: entry.discovered.source, aliases: entry.discovered.manifest?.cliAliases ?? [] }]
    })
    return resolveCliAliases(claimants)
  }

  private runtimeOf(id: string): Runtime {
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      runtime = { state: 'inactive', warnings: [] }
      this.runtimes.set(id, runtime)
    }
    return runtime
  }

  private isEnabled(id: string): boolean {
    return this.registry.plugins.get(id)?.status === 'enabled'
  }

  private changed(): void {
    this.options.emit({ type: 'plugin.changed' })
  }

  private setState(runtime: Runtime, state: RuntimeState): void {
    runtime.state = state
    this.changed()
  }

  private infoOf(entry: RegistryPlugin): PluginInfo {
    const { discovered, status } = entry
    const manifest = discovered.manifest
    const primary = this.registry.plugins.get(discovered.id) === entry
    const runtime = primary ? this.runtimes.get(discovered.id) : undefined
    const state = status === 'enabled' ? (runtime?.state ?? 'inactive') : status
    const reason = status === 'disabled' && primary ? this.disabledReasonOf(discovered.id) : undefined
    const diagnostics = entry.diagnostics.map((item) => this.explainDisable(item, reason))
    if (primary) diagnostics.push(...(this.derivedDiagnostics.get(discovered.id) ?? []))
    if (status === 'enabled' && runtime?.state === 'failed' && runtime.error) {
      diagnostics.push({ level: 'error', message: runtime.error })
    }
    diagnostics.push(...(runtime?.warnings ?? []))
    const aliases = primary ? (this.cliAliases.accepted.get(discovered.id) ?? []) : []
    return {
      id: discovered.id,
      name: manifest?.name ?? discovered.id,
      version: manifest?.version ?? '',
      ...(manifest?.description === undefined ? {} : { description: manifest.description }),
      source: discovered.source,
      dir: discovered.dir,
      activation: manifest?.activation ?? 'lazy',
      dependencies: manifest?.dependencies ?? [],
      ...(manifest?.ui === undefined ? {} : { ui: manifest.ui }),
      state,
      ...(aliases.length === 0 ? {} : { cliAliases: aliases }),
      ...(reason === undefined ? {} : { disabledReason: reason }),
      diagnostics
    }
  }

  private disabledReasonOf(id: string): NonNullable<PluginInfo['disabledReason']> {
    if (this.disabledSets.safeMode.has(id)) return 'safe-mode'
    if (this.disabledSets.user.has(id)) return 'user'
    if (this.disabledSets.distro.has(id)) return 'distro'
    return 'dependency'
  }

  /** The registry words every direct disable as the user's; say whose it actually is. */
  private explainDisable(item: PluginDiagnostic, reason: PluginInfo['disabledReason']): PluginDiagnostic {
    if (item.message !== 'disabled by the user') return item
    if (reason === 'safe-mode') return { ...item, message: 'disabled by safe mode' }
    if (reason === 'distro') return { ...item, message: 'disabled by the distro' }
    return item
  }

  private startupCandidates(): string[] {
    return [...this.registry.plugins.values()]
      .filter((entry) => entry.status === 'enabled' && entry.discovered.manifest?.activation === 'startup')
      .map((entry) => entry.discovered.id)
      .filter((id) => this.runtimeOf(id).state === 'inactive')
      .sort(compare)
  }

  private async activateQuietly(id: string): Promise<void> {
    try {
      await this.activateInternal(id)
    } catch (error) {
      this.options.log(`plugin ${id} did not start: ${messageOf(error)}`)
    }
  }

  private async activateInternal(id: string): Promise<void> {
    const entry = this.registry.plugins.get(id)
    if (!entry) throw notFound(`unknown plugin ${id}`)
    if (entry.status === 'disabled') throw conflict(`${id} is disabled`)
    if (entry.status === 'invalid') throw conflict(`${id} is invalid`)
    const runtime = this.runtimeOf(id)
    if (runtime.state === 'active') return
    if (runtime.state === 'activating') return runtime.inflight
    if (this.stopped) throw conflict('the plugin host is stopped')
    if (this.replacing.has(id)) throw conflict(`${id} is being replaced`)
    runtime.error = undefined
    runtime.warnings = []
    this.setState(runtime, 'activating')
    runtime.inflight = this.run(id, entry, runtime)
    return runtime.inflight
  }

  private async run(id: string, entry: RegistryPlugin, runtime: Runtime): Promise<void> {
    const attempt: Attempt = { revoked: false, extensionLive: false, implementations: new Map() }
    runtime.attempt = attempt
    const imported: { module?: PluginModule } = {}
    let disabledMidway = false
    try {
      this.assertEnabled(id)
      for (const dependency of entry.discovered.manifest?.dependencies ?? []) {
        try {
          await this.activateInternal(dependency)
        } catch (error) {
          this.assertEnabled(id)
          this.options.log(`plugin ${id}: dependency ${dependency} failed: ${messageOf(error)}`)
          throw new Error(`dependency ${dependency} failed to activate`)
        }
      }
      this.assertEnabled(id)
      await this.loadAndActivate(entry, attempt, imported)
      this.assertEnabled(id)
    } catch (error) {
      disabledMidway = !this.isEnabled(id)
      attempt.revoked = true
      attempt.implementations.clear()
      runtime.attempt = undefined
      runtime.module = undefined
      if (disabledMidway) {
        if (imported.module) await this.callDeactivate(id, imported.module, runtime)
        this.revokeExtension(id, attempt)
        this.setState(runtime, 'inactive')
        throw conflict(`${id} was disabled during activation`)
      }
      this.revokeExtension(id, attempt)
      runtime.error = messageOf(error)
      this.options.log(`plugin ${id} failed to activate: ${runtime.error}`)
      this.setState(runtime, 'failed')
      throw conflict(`${id} failed to activate: ${runtime.error}`)
    }
    runtime.module = imported.module
    this.activationOrder.push(id)
    this.setState(runtime, 'active')
  }

  private assertEnabled(id: string): void {
    if (!this.isEnabled(id)) throw new Error(`${id} was disabled during activation`)
  }

  /**
   * Records the module in `imported` as soon as it imports, so a failed or timed-out activate can
   * still be deactivated. An import that resolves after the attempt was revoked never activates.
   */
  private async loadAndActivate(entry: RegistryPlugin, attempt: Attempt, imported: { module?: PluginModule }): Promise<void> {
    const { discovered } = entry
    const manifest = discovered.manifest!
    if (manifest.main === undefined) return
    const context = this.contextFor(entry, attempt)
    const mainPath = join(this.importRootOf(entry), manifest.main)
    await withTimeout(
      async () => {
        const loaded = (await import(mainPath)) as Partial<PluginModule>
        if (attempt.revoked) return
        if (typeof loaded.activate !== 'function') throw new Error('main module has no activate export')
        imported.module = loaded as PluginModule
        await loaded.activate(context)
      },
      this.timeoutMs,
      `activation timed out after ${this.timeoutMs} ms`
    )
  }

  /** The directory to import a plugin's code from: its own for generation 0 and built-ins, else a link made for this generation. */
  private importRootOf({ discovered }: RegistryPlugin): string {
    const generation = this.generations.get(discovered.id) ?? 0
    if (generation === 0 || discovered.source !== 'installed') return discovered.dir
    const existing = this.generationLinks.get(discovered.id)
    if (existing !== undefined && existing.endsWith(`-${generation}`)) return existing
    const linkDir = join(this.options.installedDir, '.run')
    const link = join(linkDir, `${discovered.id}-${process.pid}-${this.serial}-${generation}`)
    mkdirSync(linkDir, { recursive: true })
    rmSync(link, { recursive: true, force: true })
    symlinkSync(discovered.dir, link, 'dir')
    this.removeLink(discovered.id)
    this.generationLinks.set(discovered.id, link)
    return link
  }

  private removeLink(id: string): void {
    const link = this.generationLinks.get(id)
    if (link === undefined) return
    this.generationLinks.delete(id)
    rmSync(link, { force: true })
  }

  private contextFor(entry: RegistryPlugin, attempt: Attempt): PluginContext {
    const { discovered } = entry
    const manifest = discovered.manifest!
    const id = discovered.id
    const allowed = new Set<string>()
    for (const [kind, items] of Object.entries(manifest.contributes ?? {})) {
      for (const item of items) allowed.add(formatContributionId(kind, id, item.id))
    }
    for (const override of manifest.overrides ?? []) allowed.add(override.id)
    // marked live before create runs: a create that throws after partial setup still needs its revoke
    if (this.options.extension) attempt.extensionLive = true
    const created = this.options.extension?.create({ id, dir: discovered.dir }, () => attempt.revoked)
    const unavailable = (member: string) => () => {
      throw new Error(`${id}: context.${member} is not available`)
    }
    const unavailableObject = <T extends object>(member: string): T =>
      new Proxy({} as T, {
        get() {
          throw new Error(`${id}: context.${member} is not available`)
        }
      })
    const defaults: Omit<ExtensionMembers, 'storedSettingValue'> & Pick<PluginContext, 'storedSettingValue' | 'workerEntrypoint'> = {
      dataDir: '',
      home: '',
      pty: unavailableObject<PluginContext['pty']>('pty'),
      launch: unavailableObject<PluginContext['launch']>('launch'),
      notify: unavailable('notify'),
      emit: () => {
        throw new Error(`${id}: context.emit is not available`)
      },
      subscribe: () => {
        throw new Error(`${id}: context.subscribe is not available`)
      },
      call: () => {
        throw new Error(`${id}: context.call is not available`)
      },
      openStore: () => {
        throw new Error(`${id}: context.openStore is not available`)
      },
      getSetting: () => {
        throw new Error(`${id}: context.getSetting is not available`)
      },
      storedSettingValue: () => {
        throw new Error(`${id}: context.storedSettingValue is not available`)
      },
      error: (_kind, message) => new Error(message),
      workerEntrypoint: (name) => {
        if (attempt.revoked) throw new Error(`${id} is no longer active`)
        const workers = manifest.workers
        const workerPath = workers?.[name]
        if (workerPath === undefined || !Object.hasOwn(workers, name)) throw new Error(`${id}: undeclared worker '${name}'`)
        return pathToFileURL(join(this.importRootOf(entry), workerPath)).href
      },
    }
    return {
      pluginId: id,
      dir: discovered.dir,
      ...defaults,
      ...created,
      log: (message) => {
        for (const line of String(message).split(/\r\n|\r|\n/)) this.options.log(`${id}: ${line}`)
      },
      provide: (contributionId, implementation) => {
        if (attempt.revoked) throw new Error(`${id} is no longer active`)
        if (!allowed.has(contributionId)) throw new Error(`${id} does not declare ${contributionId}`)
        const kind = parseContributionId(contributionId)?.kind
        if (kind !== undefined && FUNCTION_KINDS.has(kind) && typeof implementation !== 'function') {
          throw new Error(`${contributionId} must be provided as a function`)
        }
        attempt.implementations.set(contributionId, implementation)
      }
    }
  }

  private async applyEnabled(id: string, enabled: boolean): Promise<void> {
    if (!isPluginId(id) && !parseContributionId(id)) {
      throw invalidParams(`${id} is neither a plugin ID nor a contribution ID`)
    }
    const known = isPluginId(id)
      ? this.discovered.some((plugin) => plugin.id === id)
      : this.registry.declarations.some((declaration) => declaration.id === id)
    if (!known && !(enabled && this.options.store.listDisabledIds().includes(id))) {
      throw notFound(`no plugin or contribution ${id}`)
    }

    this.options.store.setDisabledId(id, !enabled)
    this.recompute()

    const affected = [...this.runtimes.keys()].filter((pluginId) => !this.isEnabled(pluginId))
    await Promise.allSettled(affected.map((pluginId) => this.runtimes.get(pluginId)!.inflight))
    for (const pluginId of [...this.activationOrder].reverse()) {
      if (affected.includes(pluginId)) await this.deactivate(pluginId)
    }
    for (const pluginId of affected) {
      const runtime = this.runtimes.get(pluginId)!
      if (runtime.state === 'failed') {
        runtime.state = 'inactive'
        runtime.error = undefined
      }
    }
    if (enabled) await Promise.allSettled(this.startupCandidates().map((pluginId) => this.activateQuietly(pluginId)))
    this.changed()
  }

  private async applyRescan(): Promise<void> {
    const previous = new Map(this.registry.plugins)
    this.load()
    const stale = new Set<string>()
    for (const id of this.runtimes.keys()) {
      const before = previous.get(id)?.discovered
      const entry = this.registry.plugins.get(id)
      const now = entry?.discovered
      if (
        !entry ||
        entry.status !== 'enabled' ||
        before?.manifest?.version !== now?.manifest?.version ||
        before?.source !== now?.source
      ) {
        stale.add(id)
      }
    }
    await this.release(stale)
    if (!this.stopped) await Promise.allSettled(this.startupCandidates().map((id) => this.activateQuietly(id)))
    this.changed()
  }

  /** Deactivates these plugins and every running plugin that depends on them, then forgets their runtime state. */
  private async release(ids: Set<string>): Promise<void> {
    const released = new Set(ids)
    for (let grew = true; grew; ) {
      grew = false
      for (const [id, runtime] of this.runtimes) {
        if (released.has(id) || runtime.state === 'inactive') continue
        const dependencies = this.registry.plugins.get(id)?.discovered.manifest?.dependencies ?? []
        if (dependencies.some((dependency) => released.has(dependency))) {
          released.add(id)
          grew = true
        }
      }
    }
    await Promise.allSettled([...released].map((id) => this.runtimes.get(id)?.inflight))
    for (const id of [...this.activationOrder].reverse()) {
      if (released.has(id)) await this.deactivate(id)
    }
    for (const id of released) {
      this.runtimes.delete(id)
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
      this.removeLink(id)
    }
  }

  private async deactivate(id: string): Promise<void> {
    const runtime = this.runtimeOf(id)
    const { module, attempt } = runtime
    if (attempt) {
      attempt.revoked = true
      attempt.implementations.clear()
    }
    this.activationOrder = this.activationOrder.filter((activeId) => activeId !== id)
    runtime.attempt = undefined
    runtime.module = undefined
    runtime.state = 'inactive'
    if (module) await this.callDeactivate(id, module, runtime)
    if (attempt) this.revokeExtension(id, attempt)
  }

  private revokeExtension(id: string, attempt: Attempt): void {
    if (!attempt.extensionLive) return
    attempt.extensionLive = false
    try {
      this.options.extension?.revoke(id)
    } catch (error) {
      this.options.log(`plugin ${id}: revoke failed: ${messageOf(error)}`)
    }
  }

  private async callDeactivate(id: string, module: PluginModule, runtime: Runtime): Promise<void> {
    if (typeof module.deactivate !== 'function') return
    try {
      await withTimeout(() => module.deactivate!(), this.timeoutMs, `deactivate timed out after ${this.timeoutMs} ms`)
    } catch (error) {
      const message = error instanceof TimedOut ? error.message : `deactivate failed: ${messageOf(error)}`
      runtime.warnings.push({ level: 'warning', message })
      this.options.log(`plugin ${id}: ${message}`)
    }
  }
}
