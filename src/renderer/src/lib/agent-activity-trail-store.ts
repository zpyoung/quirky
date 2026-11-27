import type { AgentActivityEntry } from '../../../preload/api/agent-activity-bridge'
import type { AttributedCaller } from '../../../shared/public-rpc/caller-hint'

export const AGENT_ACTIVITY_MAX_ENTRIES = 500
export const AGENT_TOUCH_WINDOW_MS = 4000

/** Methods whose effect is a tab an agent opened or focused, so the tab bar can mark it. */
export const AGENT_TAB_TOUCH_METHODS: ReadonlySet<string> = new Set([
  'session.tabs.activate',
  'session.tabs.createTerminal',
  'ui.runAction'
])

export type { AgentActivityEntry }

type Listener = () => void

// oldest first; replaced rather than mutated so useSyncExternalStore sees a new snapshot
let entries: readonly AgentActivityEntry[] = []
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function recordAgentActivity(entry: AgentActivityEntry): void {
  const next = [...entries, entry]
  entries =
    next.length > AGENT_ACTIVITY_MAX_ENTRIES ? next.slice(-AGENT_ACTIVITY_MAX_ENTRIES) : next
  notify()
}

export function clearAgentActivity(): void {
  if (entries.length === 0) {
    return
  }
  entries = []
  notify()
}

export function subscribeAgentActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getAgentActivitySnapshot(): readonly AgentActivityEntry[] {
  return entries
}

/** Newest first, for one workspace when `workspaceId` is given. */
export function entriesFor(options: { workspaceId?: string } = {}): AgentActivityEntry[] {
  const { workspaceId } = options
  return entries
    .filter((entry) => workspaceId === undefined || entry.workspaceId === workspaceId)
    .toReversed()
}

/** The newest tab-touching entry for any of `tabIds`; a tab can be known by its unified and its entity id. */
export function latestTouchFor(
  snapshot: readonly AgentActivityEntry[],
  tabIds: readonly string[]
): AgentActivityEntry | null {
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    const entry = snapshot[i]
    if (
      entry?.tabId !== undefined &&
      tabIds.includes(entry.tabId) &&
      AGENT_TAB_TOUCH_METHODS.has(entry.method)
    ) {
      return entry
    }
  }
  return null
}

/** Tab ids agents touched in the last `AGENT_TOUCH_WINDOW_MS`, mapped to the newest toucher. */
export function recentTouches(now: number = Date.now()): Map<string, AttributedCaller> {
  const touches = new Map<string, { caller: AttributedCaller; at: number }>()
  for (const entry of entries) {
    if (
      entry.tabId === undefined ||
      !AGENT_TAB_TOUCH_METHODS.has(entry.method) ||
      now - entry.at > AGENT_TOUCH_WINDOW_MS
    ) {
      continue
    }
    const previous = touches.get(entry.tabId)
    if (!previous || entry.at >= previous.at) {
      touches.set(entry.tabId, { caller: entry.caller, at: entry.at })
    }
  }
  return new Map([...touches].map(([tabId, touch]) => [tabId, touch.caller]))
}
