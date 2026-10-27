import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { AgentInfo, AgentListing, PermissionMode } from '../core/types'

export const SETTINGS_VIEW_ID = 'view:quirky.agents/settings'
export const TRUST_SETTING_ID = 'setting:quirky.agents/workspace-trust'

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ViewSnapshot = {
  status: 'loading' | 'ready' | 'error'
  listing: AgentListing | null
  /** Why the first load failed; null otherwise. */
  error: string | null
  refreshing: boolean
}

/** What a field edit changes on one agent; each key maps to a `configure` parameter. */
export type ConfigureChange = { command?: string; args?: string; env?: Record<string, string>; reset?: ('command' | 'args' | 'env')[] }

/**
 * The agent listing as one mounted Agents view shows it: loaded from the daemon, kept current by
 * `quirky.agents/changed` and setting events, with the actions the controls call. The view
 * ends it with `stop()`.
 */
export class AgentsStore {
  private snapshot: ViewSnapshot = { status: 'loading', listing: null, error: null, refreshing: false }
  private listeners = new Set<() => void>()
  private unsubscribes: (() => void)[] = []
  private loading = false
  private reloadAfter = false
  private stopped = false
  private wasReconnecting = false

  constructor(private readonly context: UiPluginContext) {}

  start(): void {
    this.unsubscribes.push(
      this.context.subscribe((event) => this.onEvent(event)),
      this.context.onConnection((status) => {
        if (status === 'reconnecting') this.wasReconnecting = true
        else if (this.wasReconnecting) {
          this.wasReconnecting = false
          void this.load()
        }
      })
    )
    void this.load()
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.listeners.clear()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ViewSnapshot => this.snapshot

  /** Fetches the listing again, as the "Try again" action after a failed first load. */
  retry(): void {
    this.commit({ status: 'loading', error: null })
    void this.load()
  }

  /** Detects installed agents again; the button shows the wait through `refreshing`. */
  async refresh(): Promise<void> {
    if (this.snapshot.refreshing) return
    this.commit({ refreshing: true })
    try {
      const listing = (await this.context.call('quirky.agents/refresh', {})) as AgentListing
      if (!this.stopped) this.commit({ status: 'ready', listing, error: null })
    } catch (error) {
      this.context.toast('Could not refresh agents', messageOf(error))
    } finally {
      if (!this.stopped) this.commit({ refreshing: false })
    }
  }

  /** Sets the default agent to `auto`, `shell` or an agent ID. */
  setDefault(agent: string): Promise<void> {
    return this.act('Could not set the default agent', () => this.context.call('quirky.agents/setDefault', { agent }))
  }

  setEnabled(agent: string, enabled: boolean): Promise<void> {
    return this.act('Could not change the agent', () => this.context.call('quirky.agents/setEnabled', { agent, enabled }))
  }

  /** Applies `mode` to every preset agent, or to `agent` alone (replacing custom arguments with `replaceCustom`). */
  setPermissions(mode: PermissionMode, agent?: string, replaceCustom?: boolean): Promise<void> {
    return this.act('Could not change permissions', () =>
      this.context.call('quirky.agents/setPermissions', {
        mode,
        ...(agent === undefined ? {} : { agent }),
        ...(replaceCustom ? { replaceCustom } : {})
      })
    )
  }

  setTrust(value: boolean): Promise<void> {
    return this.act('Could not change the setting', () => this.context.call('setting.set', { id: TRUST_SETTING_ID, value }))
  }

  /** Saves a field edit; resolves with the daemon's message when it refuses, else null. */
  async configure(agent: string, change: ConfigureChange): Promise<string | null> {
    try {
      await this.context.call('quirky.agents/configure', { agent, ...change })
    } catch (error) {
      return messageOf(error)
    }
    void this.load()
    return null
  }

  private async act(title: string, call: () => Promise<unknown>): Promise<void> {
    try {
      await call()
    } catch (error) {
      this.context.toast(title, messageOf(error))
      return
    }
    void this.load()
  }

  private onEvent(event: QuirkyEvent): void {
    if (this.stopped) return
    if (event.type === 'quirky.agents/changed' || event.type === 'setting.changed') void this.load()
  }

  private async load(): Promise<void> {
    if (this.loading) {
      this.reloadAfter = true
      return
    }
    this.loading = true
    try {
      do {
        this.reloadAfter = false
        try {
          const listing = (await this.context.call('quirky.agents/list', {})) as AgentListing
          if (!this.stopped) this.commit({ status: 'ready', listing, error: null })
        } catch (error) {
          if (!this.stopped && this.snapshot.listing === null) this.commit({ status: 'error', error: messageOf(error) })
          else if (!this.stopped) this.context.toast('Could not load agents', messageOf(error))
        }
      } while (this.reloadAfter && !this.stopped)
    } finally {
      this.loading = false
    }
  }

  private commit(change: Partial<ViewSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of [...this.listeners]) listener()
  }
}

/** Agents the person can start now: installed and enabled, in listing order. */
export const startable = (agents: AgentInfo[]): AgentInfo[] => agents.filter((agent) => agent.installed && agent.enabled)

/** The mode "Replace with" offers for custom arguments: the one the global control implies, else Yolo. */
export function replacementMode(listing: AgentListing, hasAuto: boolean): PermissionMode {
  const { summary, nonAuto } = listing.permissions
  const preset = nonAuto === 'manual' || nonAuto === 'yolo' ? nonAuto : 'yolo'
  if (summary === 'manual' || summary === 'yolo') return summary
  if (summary === 'auto' && hasAuto) return 'auto'
  return preset
}

export const MODE_LABEL: Record<PermissionMode, string> = { manual: 'Manual', auto: 'Auto', yolo: 'Yolo' }
