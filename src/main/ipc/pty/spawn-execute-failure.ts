import type { PtyRegistrationClaim } from '../../runtime/runtime-terminal-state-records'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { normalizeNodePtySpawnError } from './provider/liveness'
import { ptySizes } from './delivery/visibility-state'
import { clearProviderPtyState } from './provider/state-cleanup'

/** What both spawn lanes' execute step claims before the provider call, under the same names. */
type PtySpawnExecuteState = {
  deps: { runtime?: OrcaRuntimeService }
  isClaudeLaunch: boolean
  effectiveSessionAppId: string | undefined
  hadSessionSizeBeforeAttach: boolean
  sessionSizeBeforeAttach: { cols: number; rows: number } | undefined
  preparedProvisionalExecutionContext: boolean
  pendingRegistrationPtyId: string | null
  pendingRegistrationClaim?: PtyRegistrationClaim
  rejectedRegistrationCandidate: PtySpawnResult | null
}

/** Undoes what the execute step claimed for a start that threw, and returns the error to rethrow. */
export function failPtySpawnExecute(
  ctx: PtySpawnExecuteState,
  err: unknown,
  lane: {
    sessionId: string | undefined
    /** This spawn minted the session id, so the state built for it must go. */
    ownsNewSession: boolean
    telemetry: { agent_kind?: unknown } | undefined
    /** This request awaited another request's claimed start, whose own catch records its failure. */
    joinedAnotherStart?: boolean
  }
): Error {
  const runtime = ctx.deps.runtime
  if (
    (lane.ownsNewSession || ctx.preparedProvisionalExecutionContext) &&
    ctx.effectiveSessionAppId
  ) {
    runtime?.preparePtyExecutionContext?.(ctx.effectiveSessionAppId, null, {
      resetIncarnation: true
    })
  }
  if (ctx.pendingRegistrationPtyId) {
    runtime?.cancelPendingPtyRegistration?.(
      ctx.pendingRegistrationPtyId,
      ctx.rejectedRegistrationCandidate?.incarnationId,
      ctx.pendingRegistrationClaim
    )
    ctx.pendingRegistrationPtyId = null
  }
  const spawnError = normalizeNodePtySpawnError(err)
  const exitedBeforeSpawnReply = ctx.rejectedRegistrationCandidate?.exitedBeforeSpawnReply === true
  if (ctx.effectiveSessionAppId !== undefined) {
    if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach && !exitedBeforeSpawnReply) {
      ptySizes.set(ctx.effectiveSessionAppId, ctx.sessionSizeBeforeAttach)
    } else {
      ptySizes.delete(ctx.effectiveSessionAppId)
    }
  }
  // Why: provider state the env build materialized for this minted id leaks if spawn failed.
  if (lane.ownsNewSession && lane.sessionId !== undefined) {
    clearProviderPtyState(lane.sessionId)
  }
  return spawnError
}
