import { useEffect, useState } from 'react'

const TICK_MS = 1000

/** The current time, refreshed once a second while `active` and whenever `refreshOn` changes. */
export function useClock(active: boolean, refreshOn: unknown): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
  }, [refreshOn])
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}
