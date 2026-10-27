import type { PluginContext, Session } from '@quirky/protocol'
import type { Matcher } from './rules/matcher'
import { unsafePatternReason } from './rules/safety'
import type { BlockedKind } from './rules/types'
import type { DecidedBy, ScriptState } from './script-state'
import type { Inspection } from './service'

/** How often a wait looks again when nothing woke it, before the test time scale. */
const POLL_MS = 250

export const DEFAULT_WAIT_MS = 60_000
export const DEFAULT_OUTPUT_LINES = 200

export type WaitResult = {
  status: 'matched' | 'pending'
  /** The script state at the last look. */
  state: ScriptState
  kind?: BlockedKind
  decidedBy: DecidedBy
  /** The screen rule that decided, when one did. */
  rule?: string
  at: number
}

export type OutputWaitResult = { status: 'matched'; line: string; match: string; groups: string[]; at: number } | { status: 'pending'; at: number }

export type OutputWaitOptions = { pattern: string; ignoreCase: boolean; lines: number; timeoutMs: number }

/** What the waits need from the service that owns the rows and the matcher. */
export type WaitHost = {
  context: Pick<PluginContext, 'error' | 'pty'>
  matcher: Pick<Matcher, 'matchLines'>
  /** Reads the session; a `deadline` (epoch ms) keeps the screen read from waiting past it. */
  inspect(sessionId: string, deadline?: number): Promise<Inspection>
  /** Looks a session up by ID or name; rejects `not-found`. */
  session(ref: string): Promise<Session>
  /** Calls `listener` when the session's row commits or the session exits; the returned function stops it. */
  onWake(sessionId: string, listener: () => void): () => void
  now(): number
  /** Test scale for every wait here; 1 in production. */
  scale: number
}

/** A pause that ends early when the session wakes it, and tells the caller whether it did. */
function napper(host: WaitHost, sessionId: string): { nap(ms: number): Promise<void>; stop(): void } {
  let woken = false
  let wake: (() => void) | null = null
  const stop = host.onWake(sessionId, () => {
    woken = true
    wake?.()
  })
  return {
    nap(ms) {
      if (woken) {
        woken = false
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        const timer = setTimeout(done, Math.max(1, ms))
        function done() {
          clearTimeout(timer)
          wake = null
          woken = false
          resolve()
        }
        wake = done
      })
    },
    stop
  }
}

/** The two long-poll waits: until a session reaches a script state, and until its text matches a pattern. */
export class Waits {
  constructor(private readonly host: WaitHost) {}

  /**
   * Resolves `matched` once the session's script state is one of `until`, or `pending` after
   * `timeoutMs`. Looks again on each row commit, when the session exits, and every 250 ms, so a
   * row going stale is noticed too. Rejects `conflict` with reason `session-exited` when the
   * session has exited and `exited` is not wanted.
   */
  async wait(ref: string, until: ScriptState[], timeoutMs: number): Promise<WaitResult> {
    const { id } = await this.host.session(ref)
    const deadline = this.host.now() + timeoutMs
    const sleeper = napper(this.host, id)
    try {
      for (;;) {
        const found = await this.host.inspect(id, deadline)
        const { state, kind, decidedBy } = found.result
        const rule = decidedBy === 'rule' ? found.reading.verdict?.rule : undefined
        const outcome = { state, ...(kind !== undefined ? { kind } : {}), decidedBy, ...(rule !== undefined ? { rule } : {}), at: this.host.now() }
        if (until.includes(state)) return { status: 'matched', ...outcome }
        if (state === 'exited') throw this.exited(id)
        const left = deadline - this.host.now()
        if (left <= 0) return { status: 'pending', ...outcome }
        await sleeper.nap(Math.min(POLL_MS * this.host.scale, left))
      }
    } finally {
      sleeper.stop()
    }
  }

  /**
   * Resolves `matched` with the newest line of the session's recent text that matches the
   * pattern, or `pending` after `timeoutMs`; a match request still queued at the matcher when
   * that time is up counts as no match. Reads wrapped rows as one line and looks again only
   * when the session's output has grown. A session that has exited gets one last read: its final
   * text is matched before the exit counts, and only then does this reject `conflict` with
   * reason `session-exited`. Rejects `invalid-params` for an unsafe pattern or one that runs too long.
   */
  async waitOutput(ref: string, options: OutputWaitOptions): Promise<OutputWaitResult> {
    const { pattern, ignoreCase, lines, timeoutMs } = options
    const reason = unsafePatternReason(pattern)
    if (reason !== null) throw this.host.context.error('invalid-params', `pattern ${reason}`)
    const { id } = await this.host.session(ref)
    const deadline = this.host.now() + timeoutMs
    const sleeper = napper(this.host, id)
    let seenOffset: number | null = null
    try {
      for (;;) {
        const exited = (await this.host.session(id)).status === 'exited'
        const offset = await this.offsetOf(id)
        if (exited || offset === null || offset !== seenOffset) {
          seenOffset = offset
          const text = await this.read(id, lines, exited)
          if (text !== null) {
            const found = await this.host.matcher.matchLines(pattern, ignoreCase, text, deadline)
            if (found !== null && !('expired' in found)) {
              if ('timedOut' in found) throw this.host.context.error('invalid-params', `pattern is too slow: ${pattern}`)
              if ('unavailable' in found) throw new Error(`cannot match the pattern: ${found.unavailable}`)
              return { status: 'matched', ...found, at: this.host.now() }
            }
          }
        }
        if (exited) throw this.exited(id)
        const left = deadline - this.host.now()
        if (left <= 0) return { status: 'pending', at: this.host.now() }
        await sleeper.nap(Math.min(POLL_MS * this.host.scale, left))
      }
    } finally {
      sleeper.stop()
    }
  }

  private exited(sessionId: string): Error {
    return Object.assign(this.host.context.error('conflict', `session ${sessionId} has exited`), { data: { reason: 'session-exited' } })
  }

  /** The session's output offset, or null when the PTY host does not list it. */
  private async offsetOf(sessionId: string): Promise<number | null> {
    const listed = await this.host.context.pty.list().catch(() => [])
    return listed.find((entry) => entry.sessionId === sessionId)?.offset ?? null
  }

  /** The recent text, or null when an exited session's text can no longer be read. */
  private async read(sessionId: string, lines: number, exited: boolean): Promise<string[] | null> {
    try {
      return (await this.host.context.pty.read(sessionId, lines, { unwrap: true })).lines
    } catch (error) {
      if (exited) return null
      throw error
    }
  }
}
