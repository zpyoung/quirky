const MAX_PATHS = 5
const MAX_SESSIONS = 256

/**
 * The transcript paths each session has reported, newest first. Claude reports a new provider
 * session id before it writes the file, so an earlier path may be the only one that exists yet.
 * Memory only; sessions beyond the cap are dropped least recently updated first.
 */
export class PathHistory {
  private readonly bySession = new Map<string, string[]>()

  record(sessionId: string, transcriptPath: string): void {
    if (!transcriptPath) return
    const kept = (this.bySession.get(sessionId) ?? []).filter((path) => path !== transcriptPath)
    this.bySession.delete(sessionId)
    this.bySession.set(sessionId, [transcriptPath, ...kept].slice(0, MAX_PATHS))
    while (this.bySession.size > MAX_SESSIONS) this.bySession.delete(this.bySession.keys().next().value as string)
  }

  /** The session's paths, newest first; empty when none were recorded. */
  get(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }
}
