import type { PluginContext } from '@quirky/protocol'
import { displayOf } from './model'
import type { BlockedKind } from './rules/types'
import type { Inspection } from './service'
import type { AgentRow } from './types'

/** How long a send watches for the agent to start, unless the caller says otherwise. */
export const DEFAULT_START_TIMEOUT_MS = 5000

const OBSERVER_POLL_MS = 100

/** How `quirky.agents` would submit a prompt; the fallback when it does not know the agent. */
type SubmitPlan = { enterWithPaste: boolean; delayMs: number; retryMs: number | null }

const UNKNOWN_AGENT_PLAN: SubmitPlan = { enterWithPaste: false, delayMs: 500, retryMs: null }

export type SendResult = {
  session: string
  /** What the agent was doing when the send settled. */
  state: 'working' | 'blocked' | 'idle'
  kind?: BlockedKind
  /** When the first Enter was written. */
  sentAt: number
  /** When the agent was seen to have taken the prompt. */
  startedAt: number
}

/** What a send needs from the service that owns the rows. */
export type SendHost = {
  context: Pick<PluginContext, 'call' | 'pty' | 'error'>
  /** Reads the session; a `deadline` (epoch ms) keeps the screen read from waiting past it. */
  inspect(sessionId: string, deadline?: number): Promise<Inspection>
  row(sessionId: string): AgentRow | null
  /** Calls `listener` after each row commit of the session; the returned function stops it. */
  onCommit(sessionId: string, listener: () => void): () => void
  /** Resolves true at the session's next row commit, false after `timeoutMs`. */
  nextCommit(sessionId: string, timeoutMs: number): Promise<boolean>
  /** Resolves once every event already queued for the session has been handled. */
  settled(sessionId: string): Promise<void>
  now(): number
  /** Test scale for every wait here; 1 in production. */
  scale: number
}

type StartedAs = 'working' | 'blocked'

/** A commit observer: `seen()` is how the first commit since the Enter showed the agent took the prompt. */
type Watch = { seen(): StartedAs | null; stop(): void }

/** The bytes a terminal's own paste would send: line breaks as CR, ESC defused so the text cannot close the frame. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\r').replaceAll('\x1b', '␛')}\x1b[201~`
}

function blockedMessage(found: Inspection, pasted: boolean): string {
  const { result, row, reading, now } = found
  const detail = result.decidedBy === 'row' && row ? displayOf(row, now, true).detail : ''
  const rule = result.decidedBy === 'rule' && reading.verdict ? ` (screen rule ${reading.verdict.rule})` : ''
  const wanted =
    result.kind === 'question' ? (detail ? `an answer to "${detail}"` : 'an answer') : detail ? `approval of ${detail}` : 'approval'
  return pasted
    ? `the text was pasted but not submitted: the agent is now waiting for ${wanted}${rule}`
    : `the agent is waiting for ${wanted}${rule}; nothing was typed`
}

/**
 * Types a prompt into an agent only while it is not waiting for a person, and reports whether the
 * agent took it. Every write is preceded by a fresh look at the session: nothing is typed into a
 * blocked agent, and no Enter is written once an approval has appeared since the last look.
 */
export class Sender {
  constructor(private readonly host: SendHost) {}

  /**
   * Sends `text` to the session and settles with the state the agent reached after taking it.
   * Rejects `conflict` with a `reason` of `agent-blocked` (nothing typed, or typed but not
   * submitted), `prompt-stalled` (typed and submitted, no start within `startTimeoutMs`),
   * `not-an-agent` or `session-exited`. Callers serialize sends per session.
   */
  async send(sessionId: string, text: string, startTimeoutMs: number = DEFAULT_START_TIMEOUT_MS * this.host.scale): Promise<SendResult> {
    const first = await this.look(sessionId)
    if (first.result.state === 'exited') throw this.fail('session-exited', `session ${sessionId} has exited; nothing was typed`)
    const agent = first.session.agent === 'shell' ? (first.row?.agent ?? 'shell') : first.session.agent
    if (agent === 'shell') throw this.fail('not-an-agent', `session ${sessionId} runs a shell, not an agent; nothing was typed`)
    if (first.result.state === 'blocked') throw this.fail('agent-blocked', blockedMessage(first, false))
    const wasWorking = first.result.state === 'working'

    const { plan, known } = await this.planFor(agent, text)
    // an Enter written with the paste must not be followed by a retry nobody re-checks
    const deliverEnter = known && plan.enterWithPaste && plan.retryMs === null
    const pasteEnter = plan.enterWithPaste && !deliverEnter
    const withEnter = deliverEnter || pasteEnter
    let enterAt = this.host.now()
    // a delivery that carries the Enter can see the whole turn go by before it returns, so the watch starts before it
    let watch = withEnter ? this.watch(sessionId, enterAt) : null
    try {
      await this.paste(sessionId, agent, text, known, deliverEnter, pasteEnter)

      if (!withEnter) {
        await Bun.sleep(plan.delayMs)
        const second = await this.look(sessionId)
        if (second.result.state === 'exited') throw this.fail('session-exited', `session ${sessionId} exited before the text was submitted`)
        if (second.result.state === 'blocked') throw this.fail('agent-blocked', blockedMessage(second, true))
        enterAt = this.host.now()
        watch = this.watch(sessionId, enterAt)
        this.write(sessionId, '\r')
      }
      if (wasWorking) return await this.settle(sessionId, enterAt, 'working')
      return await this.confirm(sessionId, watch!, enterAt, startTimeoutMs, plan.retryMs)
    } finally {
      watch?.stop()
    }
  }

  private fail(reason: string, message: string): Error {
    return Object.assign(this.host.context.error('conflict', message), { data: { reason } })
  }

  /** The session as it is now, after the events already queued for it have been handled. */
  private async look(sessionId: string): Promise<Inspection> {
    await this.host.settled(sessionId)
    return this.host.inspect(sessionId)
  }

  private write(sessionId: string, data: string): void {
    try {
      this.host.context.pty.write(sessionId, data)
    } catch {
      throw this.fail('session-exited', `session ${sessionId} ended while the text was being typed`)
    }
  }

  private async planFor(agent: string, text: string): Promise<{ plan: SubmitPlan; known: boolean }> {
    const scale = this.host.scale
    try {
      const plan = (await this.host.context.call('quirky.agents/submitPlan', { agent, text })) as SubmitPlan
      return {
        known: true,
        plan: { enterWithPaste: plan.enterWithPaste, delayMs: plan.delayMs * scale, retryMs: plan.retryMs === null ? null : plan.retryMs * scale }
      }
    } catch {
      return { known: false, plan: { ...UNKNOWN_AGENT_PLAN, delayMs: UNKNOWN_AGENT_PLAN.delayMs * scale } }
    }
  }

  private async paste(sessionId: string, agent: string, text: string, known: boolean, deliverEnter: boolean, pasteEnter: boolean): Promise<void> {
    if (!known || pasteEnter) {
      this.write(sessionId, bracketedPaste(text) + (pasteEnter ? '\r' : ''))
      return
    }
    const outcome = (await this.host.context.call('quirky.agents/deliver', { sessionId, agent, text, submit: deliverEnter, ready: true })) as {
      delivery: string
    }
    if (outcome.delivery === 'not-delivered') throw this.fail('session-exited', `session ${sessionId} ended before the text could be typed`)
  }

  /** Reads every row commit of the session from now on, since one can come and go between two looks. */
  private watch(sessionId: string, enterAt: number): Watch {
    let seen: StartedAs | null = null
    const stop = this.host.onCommit(sessionId, () => {
      seen ??= this.startedByRow(sessionId, enterAt)
    })
    return { seen: () => seen, stop }
  }

  /** How a committed row shows the agent took the prompt written at `enterAt`, if it does. */
  private startedByRow(sessionId: string, enterAt: number): StartedAs | null {
    const row = this.host.row(sessionId)
    if (!row) return null
    if (row.evidenceAt >= enterAt && row.state !== 'done') return row.state === 'working' ? 'working' : 'blocked'
    return row.turnStartedAt !== null && row.turnStartedAt >= enterAt ? 'working' : null
  }

  private startedByScreen(found: Inspection): StartedAs | null {
    const state = found.reading.verdict?.state
    return state === 'working' || state === 'blocked' ? state : null
  }

  /**
   * Watches from the first Enter for the agent to take the prompt: a row committed since, a turn
   * that started since (even one that already ended), or a screen rule that reads working or
   * blocked. Writes the one allowed Enter retry when nothing has shown by `retryMs` and the
   * session still is not blocked. Settles one poll after the start, so a turn that ends within
   * it is reported as the idle it reached.
   */
  private async confirm(sessionId: string, watch: Watch, enterAt: number, startTimeoutMs: number, retryMs: number | null): Promise<SendResult> {
    const poll = OBSERVER_POLL_MS * this.host.scale
    const deadline = enterAt + startTimeoutMs
    const retryAt = retryMs !== null && enterAt + retryMs < deadline ? enterAt + retryMs : null
    let retried = false
    for (;;) {
      const found = await this.host.inspect(sessionId, deadline)
      if (found.result.state === 'exited') throw this.fail('session-exited', `session ${sessionId} exited after the text was typed`)
      const started =
        watch.seen() ?? this.startedByRow(sessionId, enterAt) ?? this.startedByScreen(found) ?? (found.result.state === 'blocked' ? 'blocked' : null)
      if (started) {
        await Bun.sleep(poll)
        return await this.settle(sessionId, enterAt, started)
      }
      const now = this.host.now()
      if (retryAt !== null && !retried && now >= retryAt) {
        retried = true
        this.write(sessionId, '\r')
        continue
      }
      if (now >= deadline) {
        throw this.fail('prompt-stalled', `the text was typed and submitted, but the agent did not start within ${startTimeoutMs} ms; it may still pick it up`)
      }
      const next = retryAt !== null && !retried ? Math.min(retryAt, deadline) : deadline
      await this.host.nextCommit(sessionId, Math.max(1, Math.min(poll, next - now)))
    }
  }

  private async settle(sessionId: string, enterAt: number, startedAs: StartedAs): Promise<SendResult> {
    const startedAt = this.host.now()
    const found = await this.look(sessionId)
    const { state, kind } = found.result
    if (state === 'exited') throw this.fail('session-exited', `session ${sessionId} exited after taking the text`)
    const reached = state === 'working' || state === 'blocked' || state === 'idle' ? state : startedAs
    return { session: sessionId, state: reached, ...(reached === 'blocked' ? { kind: kind ?? 'approval' } : {}), sentAt: enterAt, startedAt }
  }
}
