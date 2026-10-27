import type { Session } from '@quirky/protocol'
import { STALE_AFTER_MS } from './model'
import type { BlockedKind, Verdict } from './rules/types'
import type { AgentRow } from './types'

/** What a script sees for a session: whether it may type, must wait, or needs a person to act. */
export type ScriptState = 'working' | 'blocked' | 'idle' | 'unknown' | 'exited'

/** Which input decided a script state. */
export type DecidedBy = 'session' | 'rule' | 'row' | 'none'

export type ScriptStateResult = { state: ScriptState; kind?: BlockedKind; decidedBy: DecidedBy }

export type ScriptStateInput = { session: Session; row: AgentRow | null; verdict: Verdict | null; now: number }

/** A row whose evidence is within the freshness window and that a restart hasn't left unconfirmed. */
export const isFresh = (row: AgentRow, now: number): boolean => !row.restoredUnconfirmed && now - row.evidenceAt <= STALE_AFTER_MS

function ofRow(row: AgentRow): ScriptStateResult {
  switch (row.state) {
    case 'working':
      return { state: 'working', decidedBy: 'row' }
    case 'done':
      return { state: 'idle', decidedBy: 'row' }
    default:
      return { state: 'blocked', kind: row.question !== undefined ? 'question' : 'approval', decidedBy: 'row' }
  }
}

/**
 * The script state of a session, first applicable line winning: an exited process; a screen rule
 * that found an approval or question; a fresh hook or replay row; a screen rule that found
 * working or idle; a fresh title, OSC 7501 or inferred row; otherwise unknown. A stale or
 * unconfirmed row never reads as idle.
 */
export function scriptState({ session, row, verdict, now }: ScriptStateInput): ScriptStateResult {
  if (session.status === 'exited') return { state: 'exited', decidedBy: 'session' }
  if (verdict?.state === 'blocked') return { state: 'blocked', kind: verdict.kind ?? 'approval', decidedBy: 'rule' }
  const fresh = row !== null && isFresh(row, now)
  if (fresh && (row.source === 'hook' || row.source === 'replay')) return ofRow(row)
  if (verdict) return { state: verdict.state, decidedBy: 'rule' }
  if (fresh) return ofRow(row)
  return { state: 'unknown', decidedBy: 'none' }
}
