import type { AgentDisplayState, AgentStatusSummary, SessionStatus } from '@quirky/protocol'

export type DisplayStatus = Exclude<SessionStatus, 'starting'>

/** A starting session shows as running; every other status shows as itself. */
export function displayStatus(status: SessionStatus): DisplayStatus {
  return status === 'starting' ? 'running' : status
}

/** How long an unfinished state may go without evidence before the window stops vouching for it. */
export const STALE_AFTER_MS = 30 * 60 * 1000

export type WindowDisplay = { display: AgentDisplayState; label: string }

/**
 * What a window draws for an agent-status summary at `now`: the summary's own display and label,
 * unless the state is unfinished and has had no evidence for 30 minutes. A restored-unconfirmed
 * summary never decays: only fresh evidence confirms it. Window code can't import
 * plugin code, so `quirky.worktree/src/status.ts` carries a copy; keep the two in step.
 */
export function windowDisplay(summary: AgentStatusSummary, now: number, sessionRunning: boolean): WindowDisplay {
  if (summary.state !== 'done' && !summary.restoredUnconfirmed && now - summary.evidenceAt > STALE_AFTER_MS) {
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
