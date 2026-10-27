import { useEffect, useState, type CSSProperties } from 'react'
import type { Session } from '@quirky/protocol'
import { displayStatus, ringPercent, windowDisplay } from './model'

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

/** A tab's glyph: the agent's display state when its session has a summary, else the coarse status dot. */
export function StatusGlyph({ session, now }: { session: Session | undefined; now: number }) {
  const summary = session?.agentStatus
  if (session && summary) {
    const { display, label } = windowDisplay(summary, now, session.status !== 'exited')
    const percent = ringPercent(summary, display)
    return (
      <span
        className={`glyph glyph-${display}${percent === null ? '' : ' glyph-ring'}`}
        style={percent === null ? undefined : ({ '--progress': `${percent}%` } as CSSProperties)}
        title={label}
        role="img"
        aria-label={label}
      />
    )
  }
  const status = session ? displayStatus(session.status) : 'running'
  return <span className={`qt-dot qt-dot-${status}`} role="img" aria-label={status} />
}
