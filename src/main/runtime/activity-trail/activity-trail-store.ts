import type { AttributedCaller } from '../../../shared/public-rpc/caller-hint'
import type { PublicEventBus } from '../public-events/public-event-bus'

export const ACTIVITY_TRAIL_MAX_ENTRIES = 1000
export const ACTIVITY_RECORDED_CHANNEL = 'activity:recorded'

export type ActivityEntry = {
  caller: AttributedCaller
  method: string
  summary: string
  workspaceId?: string
  /** The tab the call touched, when the call names or returns one. */
  tabId?: string
  at: number
}

/** The slice of an Electron window the trail needs; absent when the host has no window. */
export type ActivityWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: ActivityEntry): void }
}

type ActivityTrailDeps = {
  bus: PublicEventBus
  getWindow: () => ActivityWindow | null
}

/**
 * What agents and scripts did through the public API, newest 1000 only and never persisted. Each
 * entry is also announced as an `activity.recorded` event and pushed to the desktop window, so a
 * running window shows it live while a headless host just keeps the ring.
 */
export class ActivityTrailStore {
  private readonly entries: ActivityEntry[] = []

  constructor(private readonly deps: ActivityTrailDeps) {}

  record(entry: ActivityEntry): void {
    this.entries.push(entry)
    if (this.entries.length > ACTIVITY_TRAIL_MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - ACTIVITY_TRAIL_MAX_ENTRIES)
    }
    this.deps.bus.publish({
      topic: 'activity',
      type: 'activity.recorded',
      caller: entry.caller,
      data: {
        method: entry.method,
        summary: entry.summary,
        ...(entry.workspaceId === undefined ? {} : { worktreeId: entry.workspaceId }),
        ...(entry.tabId === undefined ? {} : { tabId: entry.tabId })
      }
    })
    const window = this.deps.getWindow()
    if (window && !window.isDestroyed()) {
      try {
        window.webContents.send(ACTIVITY_RECORDED_CHANNEL, entry)
      } catch {
        // a window closing mid-send must not fail the call that was just recorded
      }
    }
  }

  /** Newest first, optionally for one workspace and capped at `limit`. */
  list(options: { worktreeId?: string; limit?: number } = {}): ActivityEntry[] {
    const matching = this.entries
      .filter(
        (entry) => options.worktreeId === undefined || entry.workspaceId === options.worktreeId
      )
      .toReversed()
    return options.limit === undefined ? matching : matching.slice(0, Math.max(0, options.limit))
  }
}
