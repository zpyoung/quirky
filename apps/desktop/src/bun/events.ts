import { RpcError, RpcErrorCode, type Ask, type QuirkyEvent, type Session } from '@quirky/protocol'

const APP_NAME = 'Quirky'
const BADGE_CAP = 99

export type NativeNotification = { title: string; body: string }

/** The native notification for a daemon event; only `notify` events addressed to the desktop warrant one. */
export function notificationFor(event: QuirkyEvent): NativeNotification | null {
  if (event.type !== 'notify' || event.desktop !== true) return null
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

const BADGE_EVENTS: ReadonlySet<string> = new Set([
  'quirky.session/changed',
  'quirky.session/removed',
  'quirky.ask/created',
  'quirky.ask/resolved',
  'plugin.changed'
])

/** Whether the event can change the badge count. */
export function shouldRefreshBadge(event: QuirkyEvent): boolean {
  return BADGE_EVENTS.has(event.type)
}

/**
 * Reads the badge inputs through the session and ask plugins' methods. A list whose method does
 * not exist (its plugin is off) is empty; any other failure propagates.
 */
export async function loadBadgeInputs(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<{ sessions: Session[]; asks: Ask[] }> {
  const list = async <T>(method: string, params: Record<string, unknown>): Promise<T[]> => {
    try {
      return (await call(method, params)) as T[]
    } catch (error) {
      if (error instanceof RpcError && error.code === RpcErrorCode.MethodNotFound) return []
      throw error
    }
  }
  const [sessions, asks] = await Promise.all([
    list<Session>('quirky.session/list', {}),
    list<Ask>('quirky.ask/list', { pendingOnly: true })
  ])
  return { sessions, asks }
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
