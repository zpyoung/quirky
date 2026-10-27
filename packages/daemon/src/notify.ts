import type { PluginNotification, QuirkyEvent } from '@quirky/protocol'

/** What a notification asks to sound like: `file: null` is the system sound, `volume` is 0-100. */
export type NotificationSound = { file: string | null; volume: number }

export type Notifier = (n: { title: string; body: string; sound?: NotificationSound }) => void

function escapeAppleScript(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').replace(/\r?\n/g, ' ')
}

/** The AppleScript that shows a macOS notification; it sounds only for the system sound (`file: null`), never a file. */
export function notificationScript(title: string, body: string, sound?: NotificationSound): string {
  const base = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
  return sound?.file === null ? `${base} sound name "default"` : base
}

/** Shows a macOS notification through `osascript`; failures are ignored. */
export const osascriptNotifier: Notifier = ({ title, body, sound }) => {
  try {
    Bun.spawn(['osascript', '-e', notificationScript(title, body, sound)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }).unref()
  } catch {
    return
  }
}

export type NotifyDeps = {
  broadcast(event: QuirkyEvent): void
  hasDesktopClient(): boolean
  notifier: Notifier
}

/**
 * Tells clients about `n` and, when no desktop client is connected to show it natively, falls back
 * to the OS notifier. `desktop: false` suppresses the native notification both ways. The event
 * carries `desktop` so the desktop shell knows whether to show one.
 */
export function sendNotification(deps: NotifyDeps, n: PluginNotification): void {
  const desktop = n.desktop !== false
  deps.broadcast({
    type: 'notify',
    title: n.title,
    body: n.body,
    ...(n.sessionId !== undefined ? { sessionId: n.sessionId } : {}),
    ...(n.worktreeId !== undefined ? { worktreeId: n.worktreeId } : {}),
    ...(n.open !== undefined ? { open: n.open } : {}),
    desktop,
    ...(n.sound !== undefined ? { sound: n.sound } : {}),
    ...(n.toast !== undefined ? { toast: n.toast } : {})
  })
  if (!desktop || deps.hasDesktopClient()) return
  try {
    deps.notifier({ title: n.title, body: n.body, ...(n.sound !== undefined ? { sound: n.sound } : {}) })
  } catch {
    return
  }
}
