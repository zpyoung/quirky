import { useEffect, useRef, useState } from 'react'
import type { StructuredMessage } from '@quirky/protocol'

const TICK_MS = 1000

/** "12s" below a minute, then "1m 05s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * The current time in ms, refreshed once a second while `active`; the one clock a screen shares
 * between its timers. While inactive it reads the real time on each render, so a screen that resumes
 * (after a reconnect, say) never shows a moment from before it paused.
 */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return active ? now : Date.now()
}

/** When the newest user message was sent, or null when `messages` holds none; the start of the turn now running. */
export function newestUserAt(messages: readonly StructuredMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user' || message.item?.kind === 'user') return message.at
  }
  return null
}

/**
 * The start to time the running turn from: `sentAt` when the transcript knows it, else the moment
 * `working` last turned true. Null while idle.
 */
export function useTurnStart(working: boolean, sentAt: number | null | undefined): number | null {
  const seen = useRef<number | null>(null)
  if (!working) seen.current = null
  else if (seen.current === null) seen.current = Date.now()
  if (!working) return null
  return sentAt ?? seen.current
}
