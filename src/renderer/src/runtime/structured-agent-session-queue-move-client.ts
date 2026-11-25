import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import type { QueuedMessageMoveResult } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { callStructuredAgentSession } from './structured-agent-session-client'

const METHOD = 'agentSession.queuedMessageMove'

export type QueuedMessageMoveOutcome =
  | { ok: true }
  | {
      ok: false
      reason: 'not-found' | 'stale' | 'sending' | 'refused' | 'failed'
      message?: string
    }

export type QueuedMessageMoveRequest = {
  target: RuntimeClientTarget
  sessionId: string
  /** The runtime fence the queue was read under; null means the session is not live yet. */
  fence: number | null
  messageId: string
  toIndex: number
  expectedRevision?: number
}

type MoveReply = AgentSessionMutationResult<QueuedMessageMoveResult> | QueuedMessageMoveResult

function isWrapped(reply: MoveReply): reply is AgentSessionMutationResult<QueuedMessageMoveResult> {
  return 'refusal' in reply || 'value' in reply
}

/**
 * Moves one queued card to `toIndex`. Resolves to a typed outcome and never rejects, so the caller
 * can leave the list order untouched and say why. The caller gates on
 * `AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY`; an older host would answer method-not-found.
 */
export async function moveStructuredAgentSessionQueuedMessage(
  request: QueuedMessageMoveRequest
): Promise<QueuedMessageMoveOutcome> {
  if (request.fence === null) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'auto.runtime.structuredAgentSessionQueueMoveClient.notConnected',
        'The chat is not connected yet.'
      )
    }
  }
  const fields = {
    messageId: request.messageId,
    toIndex: request.toIndex,
    ...(request.expectedRevision === undefined
      ? {}
      : { expectedRevision: request.expectedRevision })
  }
  try {
    const reply = await callStructuredAgentSession<MoveReply>(request.target, METHOD, {
      envelope: {
        sessionId: request.sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(createBrowserUuid),
        expectedRuntimeFence: request.fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: METHOD,
          sessionId: request.sessionId,
          fields
        })
      },
      ...fields
    })
    if (isWrapped(reply)) {
      if (!reply.ok) {
        return { ok: false, reason: 'refused' }
      }
      return reply.value.ok ? { ok: true } : { ok: false, reason: reply.value.reason }
    }
    return reply.ok ? { ok: true } : { ok: false, reason: reply.reason }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** The sentence a toast shows when a move did not happen. */
export function queuedMessageMoveFailureText(
  outcome: Extract<QueuedMessageMoveOutcome, { ok: false }>
): string {
  switch (outcome.reason) {
    case 'not-found':
      return 'That message already left the queue.'
    case 'stale':
      return 'The queue changed. Try the move again.'
    case 'sending':
      return 'That message is already being sent.'
    case 'refused':
      return 'The host refused the move.'
    case 'failed':
      return outcome.message ?? 'Could not move the message.'
  }
}
