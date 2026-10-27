/**
 * Remembers which sessions received driving input (typed, sent or written by a quick command).
 * The layout's exit rule reads it: a lone pane whose shell exits 0 is kept only if nobody ever
 * typed into it, so a failing startup stays visible. The layout service stores the first mark of
 * each session on its pane and restores it here on startup, so the rule outlives a daemon restart.
 */
export class InputTracker {
  private readonly driven = new Set<string>()

  private readonly listeners: ((sessionId: string) => void)[] = []

  /** Calls `listener` the first time each session is marked. */
  onFirstMark(listener: (sessionId: string) => void): void {
    this.listeners.push(listener)
  }

  mark(sessionId: string): void {
    if (this.driven.has(sessionId)) return
    this.driven.add(sessionId)
    for (const listener of this.listeners) listener(sessionId)
  }

  has(sessionId: string): boolean {
    return this.driven.has(sessionId)
  }

  /** Drops sessions that no longer exist so the set doesn't grow without bound. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const id of this.driven) if (!sessionIds.has(id)) this.driven.delete(id)
  }
}
