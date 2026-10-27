import { foldLead } from './fold'
import { readableDetail, STALE_AFTER_MS } from './model'
import type { AgentRow } from './types'

/** How long after a keypress the row must stay unchanged before the keypress counts as an interrupt. */
export const SETTLE_MS = 500

export type InterruptIntent = 'ctrl-c' | 'plain-escape'

/** What a baseline row looked like when the key was pressed; any later hook moves at least one of these. */
export type Baseline = { prompt: string; evidenceAt: number; stateStartedAt: number }

export const baselineOf = (row: AgentRow): Baseline => ({ prompt: row.prompt, evidenceAt: row.evidenceAt, stateStartedAt: row.stateStartedAt })

/** The interrupt key a write is, or null: only a lone Ctrl+C or lone Escape counts (an escape sequence starts with Esc too). */
export function interruptIntent(data: string): InterruptIntent | null {
  if (data === '\x03') return 'ctrl-c'
  if (data === '\x1b') return 'plain-escape'
  return null
}

// Ctrl+C can copy text or leave a side chat without cancelling the main turn
const CTRL_C_IGNORED = new Set(['codex', 'droid'])
// Escape also closes these TUIs' views, so only provider evidence ends the turn
const ESCAPE_NAVIGATES = new Set(['claude', 'codex', 'omp', 'pi', 'prime-agent'])
// these spend the first Escape on a cancel that can leave the turn running
const DOUBLE_ESCAPE = new Set(['opencode', 'opencode2', 'copilot'])

export const needsDoubleEscape = (agent: string, intent: InterruptIntent) => intent === 'plain-escape' && DOUBLE_ESCAPE.has(agent)

/** Whether this key can mean "stop" for this agent at all, before looking at the row. */
export function keyCanInterrupt(agent: string, intent: InterruptIntent): boolean {
  if (intent === 'ctrl-c') return !CTRL_C_IGNORED.has(agent)
  return !ESCAPE_NAVIGATES.has(agent)
}

/**
 * Whether a row is in a state an interrupt could have ended: a hook-fed row whose own lead (not
 * only its children) is working, confirmed this run, and not gone quiet.
 */
export function interruptible(row: AgentRow, now: number): boolean {
  return (
    row.lastHookAt !== null &&
    row.state === 'working' &&
    row.lead.state === 'working' &&
    row.restoredUnconfirmed !== true &&
    now - row.evidenceAt <= STALE_AFTER_MS
  )
}

export const sameBaseline = (row: AgentRow, baseline: Baseline) =>
  row.prompt === baseline.prompt && row.evidenceAt === baseline.evidenceAt && row.stateStartedAt === baseline.stateStartedAt

/** The row once its lead's turn is cancelled: children keep their work, and the fold decides what shows. */
export function interrupted(row: AgentRow, at: number): AgentRow {
  const next: AgentRow = { ...row, lead: { ...row.lead, state: 'done', stateStartedAt: at } }
  const folded = foldLead('done', next.children, false)
  next.state = folded.state
  if (folded.workingMode) next.workingMode = folded.workingMode
  else delete next.workingMode
  if (next.state !== row.state) next.stateStartedAt = at
  next.outcome = 'cancellation'
  next.interrupted = true
  delete next.heldPermission
  delete next.stashedState
  next.source = 'inference'
  next.evidenceAt = at
  next.detail = readableDetail(next)
  return next
}

/** Whether Enter can have answered the question a Claude row is waiting on. */
export const awaitsAnswer = (row: AgentRow) => row.agent === 'claude' && row.state === 'waiting' && !!row.question

/** The row after its question was answered at the terminal: the state it had before, else working. */
export function answered(row: AgentRow, at: number): AgentRow {
  const children = row.children.map((child) => (child.state === 'waiting' ? { ...child, state: 'working' as const } : child))
  const leadState = row.stashedState ?? 'working'
  const next: AgentRow = { ...row, children, lead: { ...row.lead, state: leadState, stateStartedAt: row.lead.state === leadState ? row.lead.stateStartedAt : at } }
  const folded = foldLead(leadState, children, false)
  next.state = folded.state
  if (folded.workingMode) next.workingMode = folded.workingMode
  else delete next.workingMode
  if (next.state !== row.state) next.stateStartedAt = at
  delete next.question
  delete next.heldPermission
  delete next.stashedState
  next.source = 'inference'
  next.evidenceAt = at
  next.detail = readableDetail(next)
  return next
}
