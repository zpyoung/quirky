import { useEffect, useState, type CSSProperties } from 'react'
import type { DisplayStatus, WorktreeGlyph } from './status'

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

/** A worktree's dot: the agent's display state when a session reports one, else the coarse status. */
export function StatusDot({ glyph }: { glyph: WorktreeGlyph | null }) {
  if (!glyph) return <span className="dot dot-none" aria-hidden />
  if (glyph.kind === 'agent') {
    const { display, label, percent } = glyph
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
  const status: DisplayStatus = glyph.status
  return <span className={`dot dot-${status}`} title={status} role="img" aria-label={status} />
}

/** The card's glyph for a worktree marked unread: a filled amber bell. */
export function UnreadBell() {
  return <span className="glyph glyph-unread" title="Unread" role="img" aria-label="Unread" />
}
