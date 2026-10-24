import type { Ask, QuirkyEvent, Session } from '@quirky/protocol'

const APP_NAME = 'Quirky'
const BADGE_CAP = 99

export type NativeNotification = { title: string; body: string }

/** The native notification for a daemon event, or null when the event does not warrant one. */
export function notificationFor(event: QuirkyEvent): NativeNotification | null {
  if (event.type !== 'notify') return null
  return { title: event.title.trim() || APP_NAME, body: event.body }
}

/** Sessions that need the user plus asks nobody has answered yet. */
export function badgeCount(sessions: Session[], pendingAsks: Ask[]): number {
  return sessions.filter((session) => session.status === 'waiting').length + pendingAsks.length
}

export function badgeLabel(count: number): string {
  if (count <= 0) return ''
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count)
}

export function shouldRefreshBadge(event: QuirkyEvent): boolean {
  return (
    event.type === 'session.changed' ||
    event.type === 'session.removed' ||
    event.type === 'ask.created' ||
    event.type === 'ask.resolved'
  )
}

/**
 * Recomputes the badge from the daemon's lists. Refreshes requested while one is in flight
 * collapse into a single follow-up reload, so a burst of events costs at most two loads. A failed
 * load leaves the current badge as it is.
 */
export function createBadgeUpdater(options: {
  load: () => Promise<{ sessions: Session[]; asks: Ask[] }>
  apply: (count: number) => void
}) {
  let running: Promise<void> | null = null
  let again = false

  const run = async () => {
    do {
      again = false
      try {
        const { sessions, asks } = await options.load()
        options.apply(badgeCount(sessions, asks))
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
