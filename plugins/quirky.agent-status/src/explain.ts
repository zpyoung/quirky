import type { Session } from '@quirky/protocol'
import { displayOf, STALE_AFTER_MS } from './model'
import type { IgnoredSource, Origin, Verdict } from './rules/types'
import { isFresh, type DecidedBy, type ScriptState, type ScriptStateResult } from './script-state'
import type { ScreenReading } from './screen'
import type { AgentDisplayState, AgentRow, AgentState, Because, EvidenceSource } from './types'

/** Why a session's script state is what it is: the row, the screen rules and which of them decided. */
export type Explanation = {
  session: string
  name: string | null
  agent: string | null
  state: ScriptState
  kind?: 'approval' | 'question'
  decidedBy: DecidedBy
  row: null | {
    state: AgentState
    display: AgentDisplayState
    label: string
    detail: string
    source: EvidenceSource
    fresh: boolean
    ageMs: number
    because: Because | null
    lead: { state: AgentState; since: number }
    children: { agent: number; shell: number; cron: number }
  }
  screen: {
    origin: Origin | null
    verdict: Verdict | null
    pendingQuiet?: string
    ignored: IgnoredSource[]
    /** Why the rules could not be run, when they could not. */
    unavailable?: string
  }
  exit?: { code: number | null; signal: string | null }
  /** The one sentence the CLI prints first. */
  summary: string
}

export type ExplainInput = { session: Session; row: AgentRow | null; reading: ScreenReading; result: ScriptStateResult; now: number }

const minutes = (ms: number) => {
  const whole = Math.floor(ms / 60_000)
  return `${whole} minute${whole === 1 ? '' : 's'}`
}

function evidenceName(row: AgentRow): string {
  const because = row.because
  if (because?.event !== undefined) return `hook event ${because.event}`
  return because ? because.rule : `${row.source} evidence`
}

function blockedPhrase(kind: 'approval' | 'question' | undefined, detail: string): string {
  if (kind === 'question') return detail ? `waiting for an answer to "${detail}"` : 'waiting for an answer'
  return detail ? `waiting for approval of ${detail}` : 'waiting for approval'
}

function unknownReason({ row, reading, now }: ExplainInput): string {
  if (!row) {
    const rules = reading.origin ? 'no screen rule matched' : 'no screen rules apply'
    return `no hook, title or OSC 7501 report has arrived, and ${rules}`
  }
  if (row.restoredUnconfirmed) return `the row was restored after a restart and nothing has confirmed it (last evidence: ${evidenceName(row)})`
  return `last evidence (${evidenceName(row)}) is ${minutes(now - row.evidenceAt)} old, past the ${minutes(STALE_AFTER_MS)} limit, and no screen rule matched`
}

function summarize(input: ExplainInput): string {
  const { session, row, reading, result } = input
  const byRule = result.decidedBy === 'rule' ? ` (screen rule ${reading.verdict?.rule})` : ''
  switch (result.state) {
    case 'exited': {
      if (session.exitSignal) return `exited: the process ended on ${session.exitSignal}`
      return session.exitCode === null ? 'exited: the process ended' : `exited: the process ended with code ${session.exitCode}`
    }
    case 'blocked': {
      const detail = result.decidedBy === 'row' && row ? displayOf(row, input.now, true).detail : ''
      return `blocked: ${blockedPhrase(result.kind, detail)}${byRule}`
    }
    case 'working': {
      const detail = result.decidedBy === 'row' && row ? displayOf(row, input.now, true).detail : ''
      return `working${detail ? `: ${detail}` : ''}${byRule}`
    }
    case 'idle':
      return `idle${byRule}`
    case 'unknown':
      return `unknown: ${unknownReason(input)}`
  }
}

/** Builds the explanation for a session from what was read: its row, its screen rules and the state they gave. */
export function explanationOf(input: ExplainInput): Explanation {
  const { session, row, reading, result, now } = input
  const live = (kind: 'agent' | 'shell' | 'cron') => (row ? row.children.filter((child) => child.kind === kind && child.state !== 'done').length : 0)
  const shown = row ? displayOf(row, now, session.status !== 'exited') : null
  return {
    session: session.id,
    name: session.name ?? null,
    agent: row?.agent ?? session.agent,
    state: result.state,
    ...(result.kind ? { kind: result.kind } : {}),
    decidedBy: result.decidedBy,
    row:
      row && shown
        ? {
            state: row.state,
            display: shown.display,
            label: shown.label,
            detail: shown.detail,
            source: row.source,
            fresh: isFresh(row, now),
            ageMs: now - row.evidenceAt,
            because: row.because ?? null,
            lead: { state: row.lead.state, since: row.lead.stateStartedAt },
            children: { agent: live('agent'), shell: live('shell'), cron: live('cron') }
          }
        : null,
    screen: {
      origin: reading.origin,
      verdict: reading.verdict,
      ...(reading.pendingQuiet !== undefined ? { pendingQuiet: reading.pendingQuiet } : {}),
      ignored: reading.ignored,
      ...(reading.unavailable !== undefined ? { unavailable: reading.unavailable } : {})
    },
    ...(session.status === 'exited' ? { exit: { code: session.exitCode, signal: session.exitSignal } } : {}),
    summary: summarize(input)
  }
}
