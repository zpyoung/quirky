import { useEffect, useState } from 'react'
import type { UiStatus } from '@quirky/ui'
import type { AgentDisplayState } from '@quirky/protocol'
import type { DisplayStatus } from './status'
import type { ActivityMarkState } from './view-types'

const TICK_MS = 60_000

/** The current time, refreshed every minute so a state that has gone stale shows as such without an event. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function semanticStatus(value: AgentDisplayState | DisplayStatus): UiStatus {
  switch (value) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'waiting':
    case 'permission':
    case 'blocked':
      return 'needs-you'
    case 'failed':
      return 'failing'
    case 'done':
      return 'done'
    case 'running':
      return 'queued'
    case 'interrupted':
    case 'unverifiable':
    case 'unconfirmed':
    case 'idle':
    case 'exited':
      return 'idle'
  }
}


export const MARK_LABELS: Record<ActivityMarkState, string> = {
  running: 'Running',
  waiting: 'Waiting on you',
  error: 'Error',
  idle: 'Idle',
  asleep: 'Asleep'
}

/** The accessible name of a row's activity mark; a waiting mark says how many questions are pending. */
export function markLabel(state: ActivityMarkState, pendingAsks = 0): string {
  if (state === 'waiting' && pendingAsks > 0) return `${MARK_LABELS.waiting}: ${pendingAsks} pending ${pendingAsks === 1 ? 'question' : 'questions'}`
  return MARK_LABELS[state]
}

/** The small accent dot a worktree with unread activity carries. */
export function UnreadDot() {
  return <span className="worktree-unread-dot" role="img" aria-label="Unread" />
}
