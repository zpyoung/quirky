import {
  isTerminalAskEnvelope,
  type AskEnvelope,
  type AskPendingEnvelope,
  type AskRegisteredEnvelope
} from '../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskSpec } from '../../../shared/fork-ask-question-tool/ask-question-schema'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import {
  cancelHandoff,
  resolveForcedHandoff,
  waitHandoffChunk,
  type AskHandoffOrigin
} from '../../runtime/rpc/methods/fork-ask-question-tool/ask-handoff-lifecycle'
import { resolveStructuredWorkerIdentityForSession } from '../../runtime/structured-worker-authority'
import { getForcedHandoffPolicy } from '../forced-handoff-policy'

export type TerminalAskEnvelope = Exclude<AskEnvelope, AskRegisteredEnvelope | AskPendingEnvelope>

export type NativeSessionHandoff = {
  runtime: QuirkyRuntimeService
  origin: AskHandoffOrigin
  worktreeId: string
}

const NATIVE_REQUEST_PREFIX = 'native:'
// Short chunks bound how late an abandoned native question notices it is no longer wanted.
const NATIVE_WAIT_CHUNK_MS = 8_000
const activeNativeAskIds = new Set<string>()

export function nativeAskRequestId(
  provider: 'claude' | 'codex',
  sessionId: string,
  itemId: string
): string {
  return `${NATIVE_REQUEST_PREFIX}${provider}:${sessionId}:${itemId}`
}

/** The forced hand-off for a structured worker session, or null when its questions belong to the UI. */
export function resolveSessionHandoff(sessionId: string): NativeSessionHandoff | null {
  const policy = getForcedHandoffPolicy()
  if (!policy) {
    return null
  }
  try {
    const identity = resolveStructuredWorkerIdentityForSession(
      sessionId,
      policy.runtime.getOrchestrationDb()
    )
    if (!identity) {
      return null
    }
    const origin = resolveForcedHandoff(policy.runtime, {
      handle: identity.handle,
      paneKey: identity.paneKey
    })
    return origin ? { runtime: policy.runtime, origin, worktreeId: identity.worktreeId } : null
  } catch {
    // A lookup failure leaves the question on its normal path; it must never fail the provider callback.
    return null
  }
}

/**
 * Relays one native question to the owning run and blocks until the answer is terminal. Resolves
 * null once the provider abandons the question (abort, or `stillWanted` turning false), declining
 * the hand-off so no pending row outlives it.
 */
export async function runNativeQuestion(args: {
  handoff: NativeSessionHandoff
  spec: AskSpec
  requestId: string
  signal?: AbortSignal
  stillWanted?: () => boolean
}): Promise<TerminalAskEnvelope | null> {
  const { runtime, origin, worktreeId } = args.handoff
  const { db, registry } = runtime.getAskServices()
  const { askId } = await registry.register(
    args.spec,
    { paneKey: null, worktreeId, handoff: origin },
    { requestId: args.requestId }
  )
  activeNativeAskIds.add(askId)
  const signal = args.signal ?? new AbortController().signal
  try {
    while (true) {
      if (signal.aborted || args.stillWanted?.() === false) {
        cancelHandoff(runtime, db, askId)
        return null
      }
      const envelope = await waitHandoffChunk(runtime, db, askId, NATIVE_WAIT_CHUNK_MS, signal)
      if (isTerminalAskEnvelope(envelope)) {
        return envelope
      }
    }
  } finally {
    activeNativeAskIds.delete(askId)
  }
}

/**
 * Declines native hand-offs a previous process left pending: the provider callback that would
 * have consumed their answer died with it. The orchestration question itself stays open.
 */
export function sweepOrphanedNativeAsks(runtime: QuirkyRuntimeService): void {
  try {
    const { db } = runtime.getAskServices()
    for (const row of db.listPending()) {
      if (
        row.origin === 'handoff' &&
        row.request_id.startsWith(NATIVE_REQUEST_PREFIX) &&
        !activeNativeAskIds.has(row.ask_id)
      ) {
        cancelHandoff(runtime, db, row.ask_id)
      }
    }
  } catch {
    // An unavailable ask store has nothing to sweep, and kernel start must not fail on it.
  }
}
