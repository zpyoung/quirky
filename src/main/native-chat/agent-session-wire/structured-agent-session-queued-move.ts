// `agentSession.queuedMessageMove`: drag-reorder of one queued card. Moving sends nothing and the
// outcome is idempotent (the card ends at the asked index), so it keeps no operation receipt, as
// an edit hold keeps none. The journal's commit listener publishes the reordered queue.

import type { QueuedMessageMoveResult } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'

export function moveQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  params: { sessionId: string; messageId: string; toIndex: number; expectedRevision?: number }
): Promise<QueuedMessageMoveResult> {
  return context.serialize(params.sessionId, async () => {
    const session = await context.openConversation(params.sessionId)
    if (!session) {
      return { ok: false, reason: 'not-found' }
    }
    const outcome = await session.journal.queuedMessages.move({
      messageId: params.messageId,
      toIndex: params.toIndex,
      ...(params.expectedRevision === undefined
        ? {}
        : { expectedRevision: params.expectedRevision })
    })
    return outcome === 'moved' ? { ok: true } : { ok: false, reason: outcome }
  })
}
