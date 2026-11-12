import type { PluginEvent, QuirkyEvent } from '@quirky/protocol'
import { COALESCE_INTERVAL_MS, PluginEventCoalescer, readKeyPath } from './coalesce'
import type { PluginHost } from './host'

type Listener = (event: QuirkyEvent) => unknown
type Registration = { pluginId: string; listener: Listener; active: boolean }

const EVENT_PREFIX = 'event:'

/**
 * Carries events between plugins and the daemon's event stream: plugin emits become broadcasts to
 * clients, and every daemon event is delivered to plugin listeners.
 */
export class PluginEvents {
  private registrations: Registration[] = []
  private readonly coalescer: PluginEventCoalescer

  constructor(
    private readonly plugins: PluginHost,
    private readonly broadcast: (event: QuirkyEvent) => void,
    private readonly log: (message: string) => void,
    options?: { coalesceMs?: number; now?: () => number }
  ) {
    this.coalescer = new PluginEventCoalescer(
      (event) => this.broadcast(event),
      this.log,
      options?.coalesceMs ?? COALESCE_INTERVAL_MS,
      options?.now ?? Date.now
    )
  }

  /**
   * Emits a declared event and returns true; when its manifest declares `coalesce`, true means it
   * was sent or held as the latest event for its key. Returns false when disabled or overridden.
   * Throws when undeclared or when an immediate broadcast fails. Reads the registry only.
   */
  emit(pluginId: string, event: string, data: unknown): boolean {
    const id = event.includes(':') ? event : `${EVENT_PREFIX}${pluginId}/${event}`
    if (!id.startsWith(EVENT_PREFIX)) throw new Error(`${id} is not an event`)

    const declared = this.plugins
      .contributions({ all: true, kind: 'event', pluginId })
      .some((declaration) => declaration.id === id)
    if (!declared) throw new Error(`${pluginId} does not declare ${id}`)

    const effective = this.plugins.contributions({ kind: 'event' }).find((contribution) => contribution.id === id)
    if (effective?.plugin !== pluginId) return false

    const emitted: PluginEvent = { type: id.slice(EVENT_PREFIX.length) as `${string}/${string}`, data: data ?? null }
    const worktreePath = effective.data.worktree
    if (typeof worktreePath === 'string') {
      const worktreeId = readKeyPath(data, worktreePath)
      if (typeof worktreeId === 'string' && worktreeId.length > 0) emitted.worktreeId = worktreeId
    }

    const coalesce = effective.data.coalesce
    if (Array.isArray(coalesce)) this.coalescer.emit(pluginId, emitted, coalesce)
    else this.broadcast(emitted)
    return true
  }

  /** Registers `listener` for `pluginId` and returns a function that removes it. */
  subscribe(pluginId: string, listener: Listener): () => void {
    const registration: Registration = { pluginId, listener, active: true }
    this.registrations.push(registration)
    return () => this.remove((candidate) => candidate === registration)
  }

  /** Drops every listener and pending event `pluginId` owns. */
  removeAll(pluginId: string): void {
    this.coalescer.removeAll(pluginId)
    this.remove((candidate) => candidate.pluginId === pluginId)
  }

  /** Delivers every daemon event to plugin listeners; `Core.broadcast` calls it after the clients are served. */
  deliver(event: QuirkyEvent): void {
    this.deliverToPlugins(event)
  }

  /**
   * Hands `event` to every current listener in registration order, each on its own `setImmediate`
   * so no listener runs before the reply of the call that caused the event. Nothing is sent to
   * clients, which is how `hook.received` reaches plugins. Failures are logged.
   */
  deliverToPlugins(event: QuirkyEvent): void {
    for (const registration of [...this.registrations]) {
      setImmediate(() => {
        if (registration.active) void this.invoke(registration, event)
      })
    }
  }

  private async invoke({ pluginId, listener }: Registration, event: QuirkyEvent): Promise<void> {
    try {
      await listener(event)
    } catch (error) {
      this.log(`${pluginId}: listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private remove(match: (registration: Registration) => boolean): void {
    for (const registration of this.registrations) if (match(registration)) registration.active = false
    this.registrations = this.registrations.filter((registration) => registration.active)
  }
}
