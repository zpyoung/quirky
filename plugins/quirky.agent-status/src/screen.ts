import type { PluginPty } from '@quirky/protocol'
import { evaluateForAgent, type Matcher } from './rules/matcher'
import type { RuleSources } from './rules/sources'
import type { IgnoredSource, Origin, Verdict } from './rules/types'

/** One look at a session's screen: its title, visible lines, output offset and how long the output has been quiet. */
export type Sample = {
  title: string
  lines: string[]
  offset: number
  /** Null until the offset has been seen at least twice, so quiet can't be told yet. */
  quietForMs: number | null
}

type Seen = { offset: number; since: number }

/**
 * Reads sessions' screens on demand and remembers when each session's output offset was first
 * seen, which is how long its output has been quiet. Nothing samples in the background.
 */
export class ScreenSampler {
  private readonly seen = new Map<string, Seen>()

  /**
   * `timeScale` shrinks waits in tests: quiet time is reported as if the clock ran `1 / timeScale`
   * times faster, so a rule's `quietMs` keeps its meaning while the test waits less.
   */
  constructor(
    private readonly pty: Pick<PluginPty, 'read' | 'list' | 'snapshot'>,
    private readonly lastTitle: (sessionId: string) => string | undefined,
    private readonly now: () => number,
    private readonly timeScale = 1
  ) {}

  /** Reads the session's screen with wrapped rows joined; rejects when the PTY host can't. */
  async sample(sessionId: string): Promise<Sample> {
    const [screen, sessions] = await Promise.all([this.pty.read(sessionId, 0, { unwrap: true }), this.pty.list()])
    const title = this.lastTitle(sessionId) ?? (await this.pty.snapshot(sessionId).then((snap) => snap.title, () => null)) ?? ''
    const info = sessions.find((entry) => entry.sessionId === sessionId)
    if (!info) return { title, lines: screen.lines, offset: 0, quietForMs: null }
    return { title, lines: screen.lines, offset: info.offset, quietForMs: this.observe(sessionId, info.offset) }
  }

  /** Forgets a session once it is gone. */
  forget(sessionId: string): void {
    this.seen.delete(sessionId)
  }

  private observe(sessionId: string, offset: number): number | null {
    const now = this.now()
    const known = this.seen.get(sessionId)
    if (!known) {
      this.seen.set(sessionId, { offset, since: now })
      return null
    }
    if (known.offset !== offset) {
      this.seen.set(sessionId, { offset, since: now })
      return 0
    }
    return (now - known.since) / this.timeScale
  }
}

/** What the screen rules say about one session now. */
export type ScreenReading = {
  origin: Origin | null
  verdict: Verdict | null
  /** A rule that matches except that the screen hasn't been quiet long enough. */
  pendingQuiet?: string
  ignored: IgnoredSource[]
  /** Why rules could not be run (the matcher process or the screen read failed). */
  unavailable?: string
  sample: Sample | null
}

export type ScreenDeps = { sources: RuleSources; matcher: Matcher; sampler: ScreenSampler; timeScale: number; now: () => number }

const QUIET_MARGIN_MS = 10

/**
 * Reads `agent`'s rules against the session's screen. Without a rule file the screen is not
 * read. When a rule matches except for quiet, waits out the missing quiet time once and looks
 * again, so a caller never answers "no verdict" for a screen that is merely too new to judge.
 * With a `deadline` (epoch ms) it never sleeps past it: when the quiet can't be established by
 * then, the reading carries `pendingQuiet` and nothing from that rule.
 */
export async function readScreen(deps: ScreenDeps, sessionId: string, agent: string | null, deadline?: number): Promise<ScreenReading> {
  const { sources, matcher, sampler, timeScale, now } = deps
  const ignoredOf = async () => (agent === null ? [] : ((await sources.listing(agent))?.ignored ?? []))
  if (agent === null || agent === 'shell' || (await sources.effective(agent)) === null) {
    return { origin: null, verdict: null, ignored: await ignoredOf(), sample: null }
  }
  let sample: Sample
  try {
    sample = await sampler.sample(sessionId)
  } catch (error) {
    return { origin: null, verdict: null, ignored: await ignoredOf(), unavailable: `could not read the screen: ${error instanceof Error ? error.message : String(error)}`, sample: null }
  }
  let judged = await evaluateForAgent(sources, matcher, agent, sample)
  if (judged.pendingQuiet !== undefined && judged.verdict?.state !== 'blocked' && judged.source) {
    const needed = judged.source.set.rules.find((rule) => rule.id === judged.pendingQuiet)?.quietMs ?? 0
    const missing = needed - (sample.quietForMs ?? 0)
    const sleepMs = Math.ceil(missing * timeScale) + QUIET_MARGIN_MS
    if (missing > 0 && (deadline === undefined || now() + sleepMs <= deadline)) {
      await Bun.sleep(sleepMs)
      try {
        sample = await sampler.sample(sessionId)
        judged = await evaluateForAgent(sources, matcher, agent, sample)
      } catch {
        // the first look stands
      }
    }
  }
  return {
    origin: judged.source?.origin ?? null,
    verdict: judged.verdict,
    ...(judged.pendingQuiet !== undefined ? { pendingQuiet: judged.pendingQuiet } : {}),
    ignored: await ignoredOf(),
    ...(judged.unavailable !== undefined ? { unavailable: judged.unavailable } : {}),
    sample
  }
}
