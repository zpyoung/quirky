import type { QuirkyEvent } from '@quirky/protocol'
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

  constructor(
    private readonly plugins: PluginHost,
    private readonly broadcast: (event: QuirkyEvent) => void,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Broadcasts `event` for `pluginId` and returns true. Returns false when the event is disabled
   * or another plugin's override replaced it. Throws when the plugin neither declares nor
   * overrides the event, or when `broadcast` throws (for example on non-serializable `data`).
   * Reads the registry only; never activates a plugin.
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

    this.broadcast({ type: id.slice(EVENT_PREFIX.length) as `${string}/${string}`, data: data ?? null })
    return true
  }

  /** Registers `listener` for `pluginId` and returns a function that removes it. */
  subscribe(pluginId: string, listener: Listener): () => void {
    const registration: Registration = { pluginId, listener, active: true }
    this.registrations.push(registration)
    return () => this.remove((candidate) => candidate === registration)
  }

  /** Drops every listener `pluginId` registered. */
  removeAll(pluginId: string): void {
    this.remove((candidate) => candidate.pluginId === pluginId)
  }

  /**
   * Hands `event` to every current listener in registration order, each on its own `setImmediate`
   * so no listener runs before the reply of the call that caused the event. Failures are logged.
   */
  deliver(event: QuirkyEvent): void {
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
