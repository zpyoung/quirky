import { RpcError, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'

const APP_NAME = 'Quirky'
const BADGE_CAP = 99
const DEFAULT_VOLUME = 100

export type NativeNotification = {
  title: string
  body: string
  silent: boolean
  soundFile: string | null
  volume: number
}

/**
 * The native notification for a daemon event; only `notify` events addressed to the desktop
 * warrant one. The banner is silent exactly when the daemon chose a sound file to play instead
 * (`soundFile` set); System Default and an absent sound leave the banner's own sound on.
 */
export function notificationFor(event: QuirkyEvent): NativeNotification | null {
  if (event.type !== 'notify' || event.desktop !== true) return null
  const { sound } = event
  return {
    title: event.title.trim() || APP_NAME,
    body: event.body,
    silent: sound !== undefined && sound.file !== null,
    soundFile: sound && typeof sound.file === 'string' ? sound.file : null,
    volume: sound?.volume ?? DEFAULT_VOLUME
  }
}

export function badgeLabel(count: number): string {
  if (count <= 0) return ''
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count)
}

const BADGE_EVENTS: ReadonlySet<string> = new Set(['quirky.notifications/changed', 'plugin.changed'])

/** Whether the event can change the badge count. */
export function shouldRefreshBadge(event: QuirkyEvent): boolean {
  return BADGE_EVENTS.has(event.type)
}

/**
 * Reads the badge from the notifications plugin. When the plugin is off its method does not
 * exist and the badge is zero; any other failure propagates.
 */
export async function loadBadge(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<number> {
  try {
    const status = (await call('quirky.notifications/status', {})) as { badge?: unknown } | null
    return typeof status?.badge === 'number' && Number.isFinite(status.badge) ? status.badge : 0
  } catch (error) {
    if (error instanceof RpcError && error.code === RpcErrorCode.MethodNotFound) return 0
    throw error
  }
}

/**
 * Recomputes the badge from the daemon. Refreshes requested while one is in flight collapse into
 * a single follow-up reload, so a burst of events costs at most two loads. A failed load leaves
 * the current badge as it is.
 */
export function createBadgeUpdater(options: { load: () => Promise<number>; apply: (count: number) => void }) {
  let running: Promise<void> | null = null
  let again = false

  const run = async () => {
    do {
      again = false
      try {
        options.apply(await options.load())
      } catch {
        // daemon unreachable; the reconnect path refreshes once it is back
      }
    } while (again)
  }

  return {
    refresh(): Promise<void> {
      if (running) {
        again = true
        return running
      }
      running = run().finally(() => {
        running = null
      })
      return running
    },
    reset(): void {
      options.apply(0)
    }
  }
}

export type TrayState = { visible: boolean; dot: boolean }

export type TrayInput =
  | { type: 'attention'; windowVisible: boolean }
  | { type: 'focus' }
  | { type: 'showMenuBarIcon'; value: boolean }

/**
 * The tray item's next state. The dot lights when something wants attention while the window is
 * hidden or minimized and clears when the window takes focus; hiding the menu bar icon keeps the
 * dot so it is still lit if the icon returns before the window is focused.
 */
export function trayState(prev: TrayState, input: TrayInput): TrayState {
  switch (input.type) {
    case 'attention':
      return input.windowVisible ? { ...prev } : { ...prev, dot: true }
    case 'focus':
      return { ...prev, dot: false }
    case 'showMenuBarIcon':
      return { ...prev, visible: input.value }
  }
}

export type TrayMenuItem = { type: 'normal'; label: string; action: string } | { type: 'divider' }

export const TRAY_MENU: TrayMenuItem[] = [
  { type: 'normal', label: 'Show Quirky', action: 'show' },
  { type: 'divider' },
  { type: 'normal', label: 'Settings…', action: 'settings' },
  { type: 'divider' },
  { type: 'normal', label: 'Quit Quirky', action: 'quit' }
]

export const SHOW_MENU_BAR_ICON_ID = 'setting:quirky.notifications/showMenuBarIcon'

/** Whether the event announces that something wants the user's attention. */
export function attentionIn(event: QuirkyEvent): boolean {
  return event.type === 'quirky.notifications/attention'
}

/** The sound to play for a `quirky.notifications/sound` event; none for the system sound. */
export function soundIn(event: QuirkyEvent): { file: string; volume: number } | null {
  if (event.type !== 'quirky.notifications/sound') return null
  const data = event.data as { file?: unknown; volume?: unknown } | null
  if (!data || typeof data.file !== 'string') return null
  return { file: data.file, volume: typeof data.volume === 'number' ? data.volume : DEFAULT_VOLUME }
}

/**
 * Reads Show Menu Bar Icon. The icon shows (true) when the setting does not exist because its
 * plugin is off; any other failure propagates.
 */
export async function loadShowMenuBarIcon(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<boolean> {
  try {
    const info = (await call('setting.get', { id: SHOW_MENU_BAR_ICON_ID })) as { value?: unknown } | null
    return typeof info?.value === 'boolean' ? info.value : true
  } catch (error) {
    if (error instanceof RpcError && (error.code === RpcErrorCode.NotFound || error.code === RpcErrorCode.MethodNotFound))
      return true
    throw error
  }
}

/** The new Show Menu Bar Icon value when the event changes that setting, else null. */
export function showMenuBarIconIn(event: QuirkyEvent): boolean | null {
  if (event.type !== 'setting.changed' || event.id !== SHOW_MENU_BAR_ICON_ID) return null
  return typeof event.value === 'boolean' ? event.value : null
}
