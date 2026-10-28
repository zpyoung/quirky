import { randomUUID } from 'node:crypto'
import type { PluginCaller, PluginContext } from '@quirky/protocol'
import type { PaneTab } from './pane-contract'
import type { BrowserStore } from './profiles/store'
import type { BrowserRuntime } from './runtime/driver'

/** Holds profile admission closed across the native-window and Chrome storage transaction. */
export class ProfileLifecycle {
  private active = true
  private readonly maintaining = new Set<string>()
  private readonly admissions = new Map<string, number>()
  private readonly pending = new Map<string, { profile: string; claimed: boolean }>()

  constructor(
    private readonly context: Pick<PluginContext, 'provide' | 'call' | 'error'>,
    private readonly store: BrowserStore,
    private readonly runtime: BrowserRuntime,
    private readonly listPanes: () => PaneTab[]
  ) {}

  activate(): void {
    this.context.provide('method:quirky.browser/profileClearNativeClaim', (params: Record<string, unknown>, caller: PluginCaller) => {
      if (!this.active || (caller.role !== 'ui' && caller.role !== 'desktop')) {
        throw this.context.error('conflict', 'browser_error: Only the desktop window can claim a pending native clear.')
      }
      const request = typeof params.request === 'string' ? params.request : ''
      const pending = this.pending.get(request)
      if (!pending) throw this.context.error('conflict', 'browser_error: No pending confirmed native profile clear.')
      this.pending.delete(request)
      pending.claimed = true
      return { partition: `persist:quirky-browser-${pending.profile}` }
    })
  }

  assertAvailable(profile: string): void {
    if (this.maintaining.has(profile)) throw this.context.error('conflict', 'browser_error: This profile is clearing or awaiting a known native-clear result; restart the daemon if the clear failed.')
  }

  async withProfileAdmission<T>(profile: string, operation: () => Promise<T>): Promise<T> {
    if (!this.active) throw this.context.error('conflict', 'browser_error: Browser is shutting down.')
    this.assertAvailable(profile)
    this.admissions.set(profile, (this.admissions.get(profile) ?? 0) + 1)
    try {
      return await operation()
    } finally {
      const remaining = (this.admissions.get(profile) ?? 1) - 1
      if (remaining === 0) this.admissions.delete(profile)
      else this.admissions.set(profile, remaining)
    }
  }

  async clearProfile(profile: string, remove: boolean): Promise<void> {
    if (!this.active) throw this.context.error('conflict', 'browser_error: Browser is shutting down.')
    this.store.getProfile(profile)
    this.assertAvailable(profile)
    if (remove && profile === 'default') throw this.context.error('invalid-params', 'browser_error: Default cannot be removed.')
    if (this.admissions.has(profile) || this.listPanes().some((pane) => pane.profileId === profile) || this.store.listPages().some((page) => page.profileId === profile)) {
      throw this.context.error('conflict', 'browser_error: Close this profile\'s panes and pages before clearing it.')
    }
    this.maintaining.add(profile)
    const request = randomUUID()
    const pending = { profile, claimed: false }
    this.pending.set(request, pending)
    let nativeComplete = false
    try {
      const reply = await this.context.call('ui.command.run', { id: 'command:quirky.browser/profileClearNative', args: { request } })
      if (!pending.claimed || reply === null || typeof reply !== 'object' || !('result' in reply) ||
        reply.result === null || typeof reply.result !== 'object' || !('cleared' in reply.result) || reply.result.cleared !== true) {
        throw this.context.error('conflict', 'browser_error: The desktop did not acknowledge the native profile clear.')
      }
      nativeComplete = true
      if (!this.active) throw this.context.error('conflict', 'browser_error: Browser stopped while clearing its native profile.')
      await this.runtime.withProfileMaintenance(profile, async () => {
        if (remove) this.store.deleteProfile(profile)
        else this.store.clearProfileDirectory(profile)
      })
    } catch (error) {
      if (pending.claimed && !nativeComplete && this.active) {
        const message = error instanceof Error ? error.message : String(error)
        throw this.context.error('conflict', `browser_error: Native clear completion is uncertain; this profile stays unavailable until daemon restart. ${message}`)
      }
      throw error
    } finally {
      this.pending.delete(request)
      // A timed-out, already-claimed command may still clear native storage. Do not admit new
      // profile users until a known completion, or a fresh daemon activation, makes that safe.
      if (!pending.claimed || nativeComplete || !this.active) this.maintaining.delete(profile)
    }
  }

  deactivate(): void {
    this.active = false
    this.pending.clear()
  }
}
