import type { PluginNotification, QuirkyEvent } from '@quirky/protocol'

export type Notifier = (title: string, body: string) => void

function escapeAppleScript(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').replace(/\r?\n/g, ' ')
}

/** The AppleScript that shows a macOS notification. */
export function notificationScript(title: string, body: string): string {
  return `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
}

/** Shows a macOS notification through `osascript`; failures are ignored. */
export const osascriptNotifier: Notifier = (title, body) => {
  try {
    Bun.spawn(['osascript', '-e', notificationScript(title, body)], {
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
    desktop
  })
  if (!desktop || deps.hasDesktopClient()) return
  try {
    deps.notifier(n.title, n.body)
  } catch {
    return
  }
}
