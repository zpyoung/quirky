import { join } from 'node:path'
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
import { discoverPlugins, type DiscoveredPlugin } from './discover'
import { computeRegistry, type Registry, type RegistryPlugin } from './registry'

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
}

const DEFAULT_TIMEOUT_MS = 10_000

type RuntimeState = 'inactive' | 'activating' | 'active' | 'failed'

/** One activation's context and the implementations it provided; revoked when it ends. */
type Attempt = {
  revoked: boolean
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
  private activationOrder: string[] = []
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

  /** Every discovered entry sorted by ID, built-in first; a duplicate ID appears once per source. */
  list(): PluginInfo[] {
    return this.registry.entries.map((entry) => this.infoOf(entry))
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
    return { contribution, implementation: this.runtimeOf(contribution.plugin).attempt?.implementations.get(id) }
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
    const run = this.queue.then(() => this.applyEnabled(id, enabled))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Waits for in-flight activations, then deactivates every active plugin in reverse activation order. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.queue
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.inflight))
    for (const id of [...this.activationOrder].reverse()) await this.deactivate(id)
  }

  private recompute(): void {
    this.registry = computeRegistry(this.discovered, new Set(this.options.store.listDisabledIds()))
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
    const diagnostics = [...entry.diagnostics]
    if (status === 'enabled' && runtime?.state === 'failed' && runtime.error) {
      diagnostics.push({ level: 'error', message: runtime.error })
    }
    diagnostics.push(...(runtime?.warnings ?? []))
    return {
      id: discovered.id,
      name: manifest?.name ?? discovered.id,
      version: manifest?.version ?? '',
      ...(manifest?.description === undefined ? {} : { description: manifest.description }),
      source: discovered.source,
      dir: discovered.dir,
      activation: manifest?.activation ?? 'lazy',
      dependencies: manifest?.dependencies ?? [],
      state,
      diagnostics
    }
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
    runtime.error = undefined
    runtime.warnings = []
    this.setState(runtime, 'activating')
    runtime.inflight = this.run(id, entry, runtime)
    return runtime.inflight
  }

  private async run(id: string, entry: RegistryPlugin, runtime: Runtime): Promise<void> {
    const attempt: Attempt = { revoked: false, implementations: new Map() }
    runtime.attempt = attempt
    let module: PluginModule | undefined
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
      module = await this.loadAndActivate(entry, attempt)
      this.assertEnabled(id)
    } catch (error) {
      disabledMidway = !this.isEnabled(id)
      attempt.revoked = true
      attempt.implementations.clear()
      runtime.attempt = undefined
      runtime.module = undefined
      if (disabledMidway) {
        if (module) await this.callDeactivate(id, module, runtime)
        this.setState(runtime, 'inactive')
        throw conflict(`${id} was disabled during activation`)
      }
      runtime.error = messageOf(error)
      this.options.log(`plugin ${id} failed to activate: ${runtime.error}`)
      this.setState(runtime, 'failed')
      throw conflict(`${id} failed to activate: ${runtime.error}`)
    }
    runtime.module = module
    this.activationOrder.push(id)
    this.setState(runtime, 'active')
  }

  private assertEnabled(id: string): void {
    if (!this.isEnabled(id)) throw new Error(`${id} was disabled during activation`)
  }

  private async loadAndActivate(entry: RegistryPlugin, attempt: Attempt): Promise<PluginModule | undefined> {
    const { discovered } = entry
    const manifest = discovered.manifest!
    if (manifest.main === undefined) return undefined
    const context = this.contextFor(entry, attempt)
    const mainPath = join(discovered.dir, manifest.main)
    return withTimeout(
      async () => {
        const loaded = (await import(mainPath)) as Partial<PluginModule>
        if (typeof loaded.activate !== 'function') throw new Error('main module has no activate export')
        await loaded.activate(context)
        return loaded as PluginModule
      },
      this.timeoutMs,
      `activation timed out after ${this.timeoutMs} ms`
    )
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
    return {
      pluginId: id,
      dir: discovered.dir,
      log: (message) => this.options.log(`${id}: ${message}`),
      provide: (contributionId, implementation) => {
        if (attempt.revoked) throw new Error(`${id} is no longer active`)
        if (!allowed.has(contributionId)) throw new Error(`${id} does not declare ${contributionId}`)
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
