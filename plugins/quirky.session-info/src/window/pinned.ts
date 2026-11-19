/**
 * The session the Session info panel was explicitly opened on. It holds until terminal focus moves,
 * after which the panel follows focus again.
 */
let pinned: string | null = null
const listeners = new Set<() => void>()

export function pinnedSession(): string | null {
  return pinned
}

export function setPinnedSession(session: string | null): void {
  if (pinned === session) return
  pinned = session
  for (const listener of [...listeners]) listener()
}

export function subscribePinnedSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
