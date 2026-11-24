import { z } from 'zod'

export const QUIRKYD_PROFILE_PREFLIGHT_FLAG = '--quirkyd-profile-state-preflight'
export const QUIRKYD_STARTUP_PREFLIGHT_FLAG = '--quirkyd-startup-preflight'
export const QUIRKYD_PROFILE_PREFLIGHT_TIMEOUT_MS = 90_000
// Server startup follows the disposable native/SQLite probe on every bundled launch.
export const QUIRKYD_STARTUP_READINESS_TIMEOUT_MS = QUIRKYD_PROFILE_PREFLIGHT_TIMEOUT_MS + 90_000

export const QUIRKYD_PREFLIGHT_RUNTIMES = ['node', 'bun'] as const

/** The runtime the caller launched; the candidate must prove it ran under exactly this one. */
export type QuirkydPreflightRuntimeIdentity = {
  runtime: (typeof QUIRKYD_PREFLIGHT_RUNTIMES)[number]
  runtimeVersion: string
}

export const quirkydProfilePreflightResponseSchema = z.object({
  type: z.literal('quirky_profile_state_ready'),
  nonce: z.string().uuid(),
  runtime: z.enum(QUIRKYD_PREFLIGHT_RUNTIMES),
  runtimeVersion: z.string().min(1),
  artifactVersion: z.string().regex(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/),
  sqliteVersion: z.string().min(1),
  revision: z.number().int().positive()
})

export type QuirkydProfilePreflightResponse = z.infer<typeof quirkydProfilePreflightResponseSchema>

/** A fresh challenge prevents stale or unrelated output from admitting a candidate. */
export function parseQuirkydProfilePreflight(
  output: string,
  nonce: string,
  expected: QuirkydPreflightRuntimeIdentity,
  artifactVersion?: string
): QuirkydProfilePreflightResponse {
  const response = quirkydProfilePreflightResponseSchema.parse(JSON.parse(output.trim()))
  if (
    response.nonce !== nonce ||
    response.runtime !== expected.runtime ||
    response.runtimeVersion !== expected.runtimeVersion ||
    (artifactVersion !== undefined && response.artifactVersion !== artifactVersion)
  ) {
    throw new Error('Profile preflight did not run under the expected candidate runtime')
  }
  return response
}
