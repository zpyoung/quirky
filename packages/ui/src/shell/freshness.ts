import { useEffect, useState } from 'react'
import type { Session } from '@quirky/protocol'

const STALE_AFTER_MS = 30 * 60 * 1000
const CLOCK_TICK_MS = 60_000

/** Returns the current time, refreshing it every minute for freshness checks. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Whether the status evidence is stale at `now`. */
export function isAgentStatusStale(summary: NonNullable<Session['agentStatus']>, now: number): boolean {
  return summary.state !== 'done' && !summary.restoredUnconfirmed && now - summary.evidenceAt > STALE_AFTER_MS
}
