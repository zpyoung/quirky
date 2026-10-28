import type { PacingTier } from './contracts'

export const FULL_RESYNC_INTERVAL_MS = 15 * 60_000
export const RAPID_PACING_MS = 15_000
export const ACTIVE_PACING_MS = 60_000
export const IDLE_PACING_MS = 5 * 60_000
export const MAX_BACKOFF_MS = 15 * 60_000

export function tierDelayMs(tier: PacingTier): number | null {
  switch (tier) {
    case 'rapid': return RAPID_PACING_MS
    case 'active': return ACTIVE_PACING_MS
    case 'idle': return IDLE_PACING_MS
    case 'stopped': return null
  }
}

export function backoffMs(consecutiveCount: number): number {
  if (consecutiveCount <= 0) return 0
  return Math.min(30_000 * 2 ** Math.min(consecutiveCount - 1, 5), MAX_BACKOFF_MS)
}

export function pacingDelay(input: {
  tier: PacingTier
  nowMs: number
  lastLiveReadAtMs: number | null
  consecutiveErrors: number
  consecutiveGateHolds: number
}): number | null {
  const { tier, nowMs, lastLiveReadAtMs, consecutiveErrors, consecutiveGateHolds } = input
  const baseDelay = tierDelayMs(tier)
  if (baseDelay === null) return null
  const errorDelay = backoffMs(consecutiveErrors)
  const holdDelay = backoffMs(consecutiveGateHolds)
  let delay = Math.max(baseDelay ?? 0, errorDelay, holdDelay)
  if (delay === 0) return null
  const resyncAtMs = lastLiveReadAtMs === null ? nowMs + FULL_RESYNC_INTERVAL_MS : lastLiveReadAtMs + FULL_RESYNC_INTERVAL_MS
  const untilResyncMs = resyncAtMs - nowMs
  if (untilResyncMs > 0) delay = Math.min(delay, untilResyncMs)
  return delay
}
