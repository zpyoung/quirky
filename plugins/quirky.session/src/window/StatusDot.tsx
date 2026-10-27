import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentStatusSummary } from '@quirky/protocol'
import { ringPercent, windowDisplay, type DisplayStatus } from './status'

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

type Props = { status: DisplayStatus | null; summary?: AgentStatusSummary | null; now?: number; running?: boolean }

/** The tab's glyph: the agent's display state when there is a summary, else the coarse status. */
export function StatusDot({ status, summary, now = Date.now(), running = true }: Props) {
  if (summary) {
    const { display, label } = windowDisplay(summary, now, running)
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
  if (!status) return <span className="dot dot-none" aria-hidden />
  return <span className={`dot dot-${status}`} title={status} role="img" aria-label={status} />
}
