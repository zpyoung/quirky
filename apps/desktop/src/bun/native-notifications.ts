import type { NativeNotificationCapabilities } from '@quirky/protocol'
import type { NativeNotification } from './events'

/** macOS's notification authorization as Electrobun reports it; `unsupported` covers older SDKs and other platforms. */
export type NotificationPermission = 'not-determined' | 'denied' | 'authorized' | 'provisional' | 'unsupported'

/** The part of Electrobun's `Utils` the shell uses. SDKs without the permission calls can't report clicks either. */
export type NotificationUtils = {
  showNotification(options: { title: string; body?: string; silent?: boolean; id?: string }): string | void
  getNotificationPermission?: () => Promise<NotificationPermission>
  requestNotificationPermission?: () => Promise<NotificationPermission>
}

export type NotificationTarget = Pick<NativeNotification, 'open' | 'key'>

export type NotificationClickActions = {
  showWindow(): void
  call(method: string, params: Record<string, unknown>): Promise<unknown>
}

const RETAINED_TARGETS = 256
const PERMISSION_READ_TIMEOUT_MS = 2000

/**
 * Reads the permission without prompting. A missing, failing or unanswered SDK call is `unsupported`,
 * never a guess; the shell awaits this before its first window, so it can't wait forever.
 */
export async function readNotificationPermission(
  utils: NotificationUtils,
  timeoutMs = PERMISSION_READ_TIMEOUT_MS
): Promise<NotificationPermission> {
  if (!utils.getNotificationPermission) return 'unsupported'
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<NotificationPermission>((resolve) => {
    timer = setTimeout(() => resolve('unsupported'), timeoutMs)
  })
  try {
    return await Promise.race([utils.getNotificationPermission(), timedOut])
  } catch {
    return 'unsupported'
  } finally {
    clearTimeout(timer)
  }
}

/** Asks macOS once, before the first banner needs it; a recorded decision is returned as is and never re-prompted. */
export async function registerNotificationPermission(
  utils: NotificationUtils,
  current: NotificationPermission
): Promise<NotificationPermission> {
  if (current !== 'not-determined' || !utils.requestNotificationPermission) return current
  try {
    return await utils.requestNotificationPermission()
  } catch {
    return 'unsupported'
  }
}

/** The capabilities the trusted preload reports: all or nothing, because one SDK API supplies all three. */
export function notificationCapabilities(permission: NotificationPermission): NativeNotificationCapabilities {
  const supported = permission !== 'unsupported'
  return { permission: supported, click: supported, dismiss: supported }
}

/** Prepended to the preload bundle so the bridge can report capabilities read in the Bun process. */
export function notificationCapabilitiesPreamble(capabilities: NativeNotificationCapabilities): string {
  return `globalThis.__quirkyNotificationCapabilities=${JSON.stringify(capabilities)};\n`
}

/** What the preload reports from the preamble; anything but three booleans reports nothing as supported. */
export function preloadNotificationCapabilities(value: unknown): NativeNotificationCapabilities {
  const declared = value as Partial<Record<keyof NativeNotificationCapabilities, unknown>> | null | undefined
  const flag = (key: keyof NativeNotificationCapabilities) => declared?.[key] === true
  return { permission: flag('permission'), click: flag('click'), dismiss: flag('dismiss') }
}

/**
 * Shows banners with ids and remembers where each should lead, so a click can open its target.
 * A target is released when its banner is clicked or dismissed; the oldest go first past the cap,
 * because macOS doesn't report banners that age out of Notification Center.
 */
export class NativeNotifications {
  private readonly targets = new Map<string, NotificationTarget>()

  constructor(
    private readonly utils: NotificationUtils,
    private readonly newId: () => string,
    private readonly limit = RETAINED_TARGETS
  ) {}

  /** Shows the banner. A keyed notification reuses its id, so a newer one replaces the banner like it replaces the toast. */
  show(notification: NativeNotification): string {
    const id = notification.key === undefined ? this.newId() : `key:${notification.key}`
    this.utils.showNotification({ title: notification.title, body: notification.body, silent: notification.silent, id })
    this.targets.delete(id)
    this.targets.set(id, { open: notification.open, key: notification.key })
    for (const oldest of this.targets.keys()) {
      if (this.targets.size <= this.limit) break
      this.targets.delete(oldest)
    }
    return id
  }

  /** Brings Quirky forward, opens the banner's target and retires its toast, as clicking the toast does. */
  async click(id: string, actions: NotificationClickActions): Promise<void> {
    const target = this.targets.get(id)
    this.targets.delete(id)
    actions.showWindow()
    if (!target) return
    if (target.open) await actions.call('ui.view.open', { id: target.open.view, input: target.open.input })
    if (target.key !== undefined) await actions.call('ui.toast.dismiss', { key: target.key }).catch(() => undefined)
  }

  dismiss(id: string): void {
    this.targets.delete(id)
  }

  get size(): number {
    return this.targets.size
  }
}

/** The id an Electrobun `notification-click` or `notification-dismiss` payload carries. */
export function notificationIdIn(payload: unknown): string | null {
  const id = (payload as { id?: unknown } | null)?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}
