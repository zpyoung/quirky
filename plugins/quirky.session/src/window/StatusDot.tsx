import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentDisplayState, AgentStatusSummary, Session, SessionUnread } from '@quirky/protocol'
import { Badge, StatusDot as SharedStatusDot, type UiStatus } from '@quirky/ui'
import { ringPercent, windowDisplay, displayStatus, type DisplayStatus } from './status'

const TICK_MS = 60_000

/** The current time, refreshed every minute so a state that starts to go stale is redrawn. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export type SessionStatusPresentation = { status: UiStatus; label: string; progress: number | null }

const displayStatusMap: Record<AgentDisplayState, UiStatus> = {
  working: 'working',
  monitoring: 'working',
  waiting: 'needs-you',
  permission: 'needs-you',
  blocked: 'needs-you',
  failed: 'failing',
  interrupted: 'idle',
  done: 'done',
  unverifiable: 'idle',
  idle: 'idle',
  unconfirmed: 'queued'
}

const coarseStatusMap: Record<DisplayStatus, UiStatus> = {
  running: 'working',
  working: 'working',
  waiting: 'needs-you',
  done: 'done',
  exited: 'idle'
}

/** Semantic color is derived from detail at the boundary; the detailed label remains authoritative. */
export function sessionStatusPresentation(session: Session, now: number): SessionStatusPresentation {
  const summary: AgentStatusSummary | null | undefined = session.agentStatus
  if (summary) {
    const { display, label } = windowDisplay(summary, now, session.status !== 'exited')
    return { status: displayStatusMap[display], label, progress: ringPercent(summary, display) }
  }
  const status = displayStatus(session.status)
  return { status: coarseStatusMap[status], label: status, progress: null }
}

/** A shared semantic dot with the original, detailed status retained as its tooltip and label. */
export function StatusDot({ session, now }: { session: Session; now: number }) {
  const { status, label } = sessionStatusPresentation(session, now)
  return (
    <span title={label}>
      <SharedStatusDot status={status} label={label} />
    </span>
  )
}

export const UNREAD_LABELS: Record<SessionUnread, string> = {
  agent: 'Unread agent completion',
  bell: 'Unread bell',
  notification: 'Unread notification'
}

/** The shared needs-you badge for a session marked unread, labelled by its reason. */
export function UnreadBell({ reason }: { reason: SessionUnread }) {
  const label = UNREAD_LABELS[reason]
  return <span title={label}><Badge tone="needs-you" label={label}>Unread</Badge></span>
}
