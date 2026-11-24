/**
 * Best-effort retirement of the terminal daemon when a managed stop asks for it.
 *
 * The daemon normally outlives quirkyd so terminals survive a restart (D7). Retirement happens
 * only when the daemon itself proves it owns no live session across every generation; a busy
 * or unanswering daemon stays up, and quirkyd's own stop never waits on that outcome.
 */
import {
  listLiveDaemonSessions,
  releaseDaemonRetirementFence,
  requestIdleDaemonRetirement
} from '../daemon/daemon-provider-state'
import type { DaemonIdleRetirementResult } from '../daemon/daemon-pty-runtime-state'
import type { QuirkydDaemonRetirementVerdict } from '../../shared/quirkyd-stop-request'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { QUIRKYD_DAEMON_RETIREMENT_TIMEOUT_MS } from './quirkyd-stop-deadlines'

export type QuirkydDaemonRetirement = {
  retirement: QuirkydDaemonRetirementVerdict
  liveSessions: number | null
  reason: string | null
  /** After a timeout: whether the attempt still pending then went on to retire the daemon. */
  lateRetirement?: Promise<boolean>
}

/** Live sessions across every daemon generation, or `null` when any could not answer. */
export async function countLiveQuirkydDaemonSessions(): Promise<number | null> {
  try {
    // The inventory lists live sessions only.
    return (await listLiveDaemonSessions())?.length ?? null
  } catch {
    return null
  }
}

type RetirementPorts = {
  request: typeof requestIdleDaemonRetirement
  releaseFence: typeof releaseDaemonRetirementFence
  countLiveSessions: typeof countLiveQuirkydDaemonSessions
  timeoutMs: number
}

const DEFAULT_PORTS: RetirementPorts = {
  request: requestIdleDaemonRetirement,
  releaseFence: releaseDaemonRetirementFence,
  countLiveSessions: countLiveQuirkydDaemonSessions,
  timeoutMs: QUIRKYD_DAEMON_RETIREMENT_TIMEOUT_MS
}

export async function retireQuirkydDaemonIfIdle(
  ports: Partial<RetirementPorts> = {}
): Promise<QuirkydDaemonRetirement> {
  const { request, releaseFence, countLiveSessions, timeoutMs } = { ...DEFAULT_PORTS, ...ports }
  const attempt = request().catch(() => ({ state: 'unverifiable' as const }))
  const result = await withTimeout<DaemonIdleRetirementResult | { state: 'timed-out' }>(
    attempt,
    timeoutMs,
    { state: 'timed-out' }
  )
  // The fence cannot reopen while the attempt is pending; reopen it once a late refusal lands.
  const lateRetirement =
    result.state === 'timed-out'
      ? attempt.then((late) => {
          if (late.state !== 'retiring') {
            releaseFence()
          }
          return late.state === 'retiring'
        })
      : undefined
  if (result.state === 'retiring') {
    return { retirement: 'retired', liveSessions: 0, reason: null }
  }
  // A daemon that stays must not be left refusing new terminals.
  releaseFence()
  const liveSessions =
    result.state === 'busy' && result.liveSessions !== null
      ? result.liveSessions
      : await withTimeout(countLiveSessions(), timeoutMs, null)
  if (liveSessions !== null && liveSessions > 0) {
    return {
      retirement: 'live',
      liveSessions,
      reason:
        `${liveSessions} terminal ${liveSessions === 1 ? 'session is' : 'sessions are'} still ` +
        'live, so the daemon stays up and keeps them.'
    }
  }
  return {
    retirement: 'unverifiable',
    liveSessions,
    ...(lateRetirement ? { lateRetirement } : {}),
    reason:
      result.state === 'unsupported'
        ? 'The terminal daemon predates idle retirement, so it was left running.'
        : 'The host could not prove the daemon idle, so it was left running.'
  }
}
