import type { PointerOperationResult, RuntimeCallerEvidence } from './contracts'

/** Kernel-verified on hello from a launch-scoped secret, never client session metadata. */
export type SessionAuthority = RuntimeCallerEvidence['attestation'] & {
  sessionId: string
  live: true
}

/** Public `quirky.session/identity` result. Does not expose authentication material. */
export interface SessionIdentity {
  sessionId: string
  live: boolean
  runtimeEpoch: string
  processIncarnation: string
  source: SessionAuthority['source']
  kind: 'terminal' | 'structured'
  providerId: string | null
  worktreeId: string
}

/** Public `quirky.session/pointer` input. Repeating an operation cannot submit twice. */
export interface SessionPointerParams {
  session: string
  expectedIncarnation: string
  operationId: string
  text: string
}

/** Unknown sends remain unknown, not automatically replayed after restart. */
export interface SessionPointerResult {
  operationId: string
  result: PointerOperationResult
}

/** Integration contract: PluginCaller gains optional kernel-verified sessionAuthority.
 * CLI hello sends sessionToken from QUIRKY_SESSION_TOKEN, separately from sessionId.
 * Only launch-owned live terminal/structured sessions can receive authority.
 * Methods names above are contributions of the existing session plugin; orchestration
 * invokes them via context.call and never imports its private runtime.
 */
export interface AuthorityBearingCaller {
  sessionId?: string
  sessionAuthority?: SessionAuthority
}
