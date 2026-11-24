/**
 * Idle exit for an quirkyd a client launched over SSH, matching the relay: a host nobody has
 * used for 15 minutes stops its server, and the next connect starts it again.
 */
import { z } from 'zod'

/** Test-only quiet period; a client forwards it to the servers it launches. */
export const QUIRKYD_E2E_IDLE_TIMEOUT_ENV = 'QUIRKY_E2E_QUIRKYD_IDLE_TIMEOUT_MS'
export const QUIRKYD_IDLE_EXIT_TIMEOUT_MS = 15 * 60_000
const QUIRKYD_E2E_IDLE_TIMEOUT_MAX_MS = 60 * 60_000

/** The bounded test override, or null when unset or out of range. */
export function readQuirkydE2EIdleTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env[QUIRKYD_E2E_IDLE_TIMEOUT_ENV]
  const value = raw ? Number(raw) : Number.NaN
  return Number.isSafeInteger(value) && value >= 1 && value <= QUIRKYD_E2E_IDLE_TIMEOUT_MAX_MS
    ? value
    : null
}

/** Written to the data root just before an idle stop; the next start reports and clears it. */
export const QUIRKYD_IDLE_STOP_RECORD_FILENAME = 'quirkyd-idle-stop.json'

export const QuirkydIdleStopRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('quirkyd_idle_stop'),
  pid: z.number().int().positive(),
  version: z.string().max(255),
  quietSince: z.iso.datetime({ offset: true }),
  stoppedAt: z.iso.datetime({ offset: true }),
  idleTimeoutMs: z.number().int().positive()
})

export type QuirkydIdleStopRecord = z.infer<typeof QuirkydIdleStopRecordSchema>
