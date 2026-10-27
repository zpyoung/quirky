import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { DEFAULT_VALUES, PLUGIN_ID, SETTING_NAMES, settingId, type SettingName, type Values } from './copy'

const TEST = `${PLUGIN_ID}/test`
const PREVIEW = `${PLUGIN_ID}/preview`

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type Snapshot = {
  values: Values
  /** Whether the custom sound path field is showing. */
  customOpen: boolean
  /** Why the last custom file was refused; null before a try and after a built-in sound. */
  customError: string | null
  busy: boolean
}

/**
 * The notification settings as one mounted view shows them: read through `getSetting`, kept
 * current by `setting.changed`, with the actions the controls call. The view ends it with `stop()`.
 */
export class NotificationsStore {
  private snapshot: Snapshot
  private listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private lastReport = ''

  constructor(
    private readonly context: UiPluginContext,
    private readonly report: (state: unknown) => void = () => {}
  ) {
    this.snapshot = { values: this.read(), customOpen: false, customError: null, busy: false }
  }

  start(): void {
    this.unsubscribe = this.context.subscribe((event) => this.onEvent(event))
    this.sendReport()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.listeners.clear()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): Snapshot => this.snapshot

  /** Saves one setting; a refusal is toasted and the shown value stays what the daemon holds. */
  async set(name: SettingName, value: boolean | number | string): Promise<boolean> {
    try {
      await this.context.call('setting.set', { id: settingId(name), value })
    } catch (error) {
      this.context.toast('Could not change the setting', messageOf(error))
      return false
    }
    this.refresh()
    return true
  }

  /** Picks a sound from the select: a built-in is saved and previewed, Custom opens the path field. */
  async chooseSound(sound: string): Promise<void> {
    if (sound === 'custom') {
      this.commit({ customOpen: true, customError: null })
      return
    }
    this.commit({ customOpen: false, customError: null })
    if (!(await this.set('sound', sound)) || sound === 'system') return
    try {
      const result = (await this.context.call(PREVIEW, { sound })) as { played: boolean; reason?: string }
      if (!result.played && result.reason) this.context.toast('Could not play the sound', result.reason)
    } catch (error) {
      this.context.toast('Could not play the sound', messageOf(error))
    }
  }

  openCustom(): void {
    this.commit({ customOpen: true, customError: null })
  }

  /** Tries `path` as the notification sound; it is saved only when the daemon plays it. */
  async useCustom(path: string): Promise<void> {
    if (this.snapshot.busy) return
    this.commit({ busy: true })
    try {
      const result = (await this.context.call(PREVIEW, { path, volume: this.snapshot.values.volume })) as { played: boolean; reason?: string }
      if (this.stopped) return
      if (!result.played) {
        this.commit({ customError: result.reason ?? 'The file could not be played' })
        return
      }
      if (!(await this.set('customSoundPath', path)) || !(await this.set('sound', 'custom'))) return
      this.commit({ customOpen: false, customError: null })
    } catch (error) {
      if (!this.stopped) this.commit({ customError: messageOf(error) })
    } finally {
      if (!this.stopped) this.commit({ busy: false })
    }
  }

  /** Sends the test notification and answers with exactly one toast. */
  async sendTest(): Promise<void> {
    if (this.snapshot.busy) return
    this.commit({ busy: true })
    try {
      const result = (await this.context.call(TEST)) as { delivered?: boolean; reason?: string }
      if (result.delivered === true) {
        this.context.toast('Test notification requested', 'If no macOS banner appeared, turn on Allow notifications for Quirky in System Settings.')
      } else if (result.reason === 'disabled') {
        this.context.toast('Notifications are disabled', '')
      } else {
        this.context.toast('Test notification was not delivered', '')
      }
    } catch (error) {
      this.context.toast('Test notification was not delivered', messageOf(error))
    } finally {
      if (!this.stopped) this.commit({ busy: false })
    }
  }

  private onEvent(event: QuirkyEvent): void {
    if (this.stopped || event.type !== 'setting.changed' || !event.id.startsWith(`setting:${PLUGIN_ID}/`)) return
    this.refresh()
  }

  private refresh(): void {
    if (!this.stopped) this.commit({ values: this.read() })
  }

  private read(): Values {
    const values: Record<string, unknown> = { ...DEFAULT_VALUES }
    for (const name of SETTING_NAMES) {
      try {
        values[name] = this.context.getSetting(name)
      } catch {
        // an undeclared setting keeps its default
      }
    }
    return values as Values
  }

  private commit(change: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of [...this.listeners]) listener()
    this.sendReport()
  }

  private sendReport(): void {
    const state = { settings: this.snapshot.values, customPathOpen: this.snapshot.customOpen, customPathError: this.snapshot.customError }
    const text = JSON.stringify(state)
    if (text === this.lastReport) return
    this.lastReport = text
    this.report(state)
  }
}
