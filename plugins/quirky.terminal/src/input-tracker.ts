/**
 * Remembers which sessions received driving input (typed, sent or written by a quick command).
 * The layout's exit rule reads it: a lone pane whose shell exits 0 is kept only if nobody ever
 * typed into it, so a failing startup stays visible.
 */
export class InputTracker {
  private readonly driven = new Set<string>()

  mark(sessionId: string): void {
    this.driven.add(sessionId)
  }

  has(sessionId: string): boolean {
    return this.driven.has(sessionId)
  }

  /** Drops sessions that no longer exist so the set doesn't grow without bound. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const id of this.driven) if (!sessionIds.has(id)) this.driven.delete(id)
  }
}
