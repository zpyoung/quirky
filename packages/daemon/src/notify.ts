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
