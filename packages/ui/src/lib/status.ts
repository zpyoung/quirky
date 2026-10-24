import type { Session, SessionStatus } from '@quirky/protocol'

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
