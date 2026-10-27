import type { AgentDisplayState, AgentStatusSummary, Session, SessionStatus } from '@quirky/protocol'

export type DisplayStatus = Exclude<SessionStatus, 'starting'>

const URGENCY: DisplayStatus[] = ['waiting', 'working', 'done', 'running', 'exited']

export function displayStatus(status: SessionStatus): DisplayStatus {
  return status === 'starting' ? 'running' : status
}

/** The status a worktree dot shows: waiting > working > done > running > exited; null when empty. */
export function mostUrgent(statuses: SessionStatus[]): DisplayStatus | null {
  let best: DisplayStatus | null = null
  for (const status of statuses) {
    const current = displayStatus(status)
    if (best === null || URGENCY.indexOf(current) < URGENCY.indexOf(best)) best = current
  }
  return best
}

export function worktreeStatus(sessions: Session[], worktreeId: string): DisplayStatus | null {
  return mostUrgent(sessions.filter((s) => s.worktreeId === worktreeId).map((s) => s.status))
}

export function isAlive(session: Session): boolean {
  return session.status !== 'exited'
}

/** How long an unfinished state may go without evidence before the window stops vouching for it. */
export const STALE_AFTER_MS = 30 * 60 * 1000

export type WindowDisplay = { display: AgentDisplayState; label: string }

/**
 * What a window draws for an agent-status summary at `now`: the summary's own display and label,
 * unless the state is unfinished and has had no evidence for 30 minutes. Window code can't import
 * plugin code, so `quirky.session/src/window/status.ts` carries a copy; keep the two in step.
 */
export function windowDisplay(summary: AgentStatusSummary, now: number, sessionRunning: boolean): WindowDisplay {
  if (summary.state !== 'done' && now - summary.evidenceAt > STALE_AFTER_MS) {
    return sessionRunning ? { display: 'unverifiable', label: 'No recent update' } : { display: 'idle', label: 'Idle' }
  }
  return { display: summary.display, label: summary.label }
}

const RING_STATES: AgentDisplayState[] = ['working', 'waiting', 'permission']

/** The whole-number percent (progress is already 0-100) a ring shows, or null when the state keeps its own glyph. */
export function ringPercent(summary: AgentStatusSummary, display: AgentDisplayState): number | null {
  if (summary.progress === null || !Number.isFinite(summary.progress) || !RING_STATES.includes(display)) return null
  return Math.round(Math.min(100, Math.max(0, summary.progress)))
}

/** What a worktree card draws: an agent display state with its label, or a coarse status. */
export type WorktreeGlyph =
  | { kind: 'agent'; display: AgentDisplayState; label: string; percent: number | null }
  | { kind: 'coarse'; status: DisplayStatus }

const GLYPH_URGENCY: (AgentDisplayState | DisplayStatus)[] = [
  'waiting',
  'permission',
  'blocked',
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  'unverifiable',
  'interrupted',
  'done',
  'idle',
  'running',
  'exited'
]

function glyphOf(session: Session, now: number): WorktreeGlyph {
  if (!session.agentStatus) return { kind: 'coarse', status: displayStatus(session.status) }
  const { display, label } = windowDisplay(session.agentStatus, now, session.status !== 'exited')
  return { kind: 'agent', display, label, percent: ringPercent(session.agentStatus, display) }
}

const rankOf = (glyph: WorktreeGlyph) => GLYPH_URGENCY.indexOf(glyph.kind === 'agent' ? glyph.display : glyph.status)

/**
 * The glyph for a worktree's most urgent session; null when it has none. A summary-driven glyph
 * wins a tie with a coarse one so its progress and label show.
 */
export function worktreeGlyph(sessions: Session[], worktreeId: string, now: number): WorktreeGlyph | null {
  let best: WorktreeGlyph | null = null
  for (const session of sessions) {
    if (session.worktreeId !== worktreeId) continue
    const glyph = glyphOf(session, now)
    if (best === null) best = glyph
    else if (rankOf(glyph) < rankOf(best) || (rankOf(glyph) === rankOf(best) && glyph.kind === 'agent' && best.kind === 'coarse')) best = glyph
  }
  return best
}
