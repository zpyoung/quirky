// The row that says why a quit or update cut a reply: the cut turn's own explanation, in the words
// every client already prints for a stopped agent, with the cause beside them for clients that
// name it (`AgentSessionQuirkyStop`).

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  AGENT_SESSION_QUIRKY_STOP_PRESENTATION,
  isAgentSessionQuirkyStopCause
} from '../../../shared/agent-session-quirky-stop'
import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { quirkyShutdownRowClientMessageId } from '../../../shared/native-chat-quirky-stop-cut'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type QuirkyStopRowJournal = Pick<AgentSessionJournal, 'snapshot' | 'appendItem'>

/** The row about an owner gone from under a turn: today's words and tone, which every client prints
 *  as it always has, and why Quirky stopped when it was Quirky, which a client that knows the cause names
 *  instead, muted. */
export function quirkyStopRowBody(
  context: AgentSessionFailureWordsContext | undefined,
  quirkyEnd: unknown
): AgentJournalStatusItem {
  return {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
      ...context,
      surface: 'row'
    }),
    tone: 'error',
    ...(isAgentSessionQuirkyStopCause(quirkyEnd)
      ? { presentation: AGENT_SESSION_QUIRKY_STOP_PRESENTATION, quirkyStop: { cause: quirkyEnd } }
      : {})
  }
}

/** The root turn running as the quit stops the child: the one its stop may cut. */
export function runningRootTurnItemId(
  journal: Pick<AgentSessionJournal, 'snapshot'>
): string | null {
  return (
    journal
      .snapshot()
      .items.findLast(
        (item) =>
          isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.state === 'running'
      )?.itemId ?? null
  )
}

function cutByNobody(item: AgentJournalRenderItem | undefined): boolean {
  const turn = item ? readAgentJournalTurn(item.body) : null
  return (
    turn !== null &&
    agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
      'interruption'
  )
}

/**
 * Once the quit's stop has settled: when the turn running at the stop now reads cut with nobody
 * asking (not finished, not a person's Stop), say why. Never throws: a row that cannot be written
 * must not keep the quit from releasing the chat.
 */
export async function recordStructuredAgentSessionShutdownCut(input: {
  journal: QuirkyStopRowJournal
  sessionId: string
  /** The stopped child's fence, which keys the row. */
  fence: number
  /** The fence the row is written at: the lease's, which the child's end moved past `fence`. */
  rowFence: number
  generation: string
  turnItemId: string | null
  trigger: AgentSessionResumeTrigger
  failureTextContext?: AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
}): Promise<void> {
  try {
    const { turnItemId } = input
    if (turnItemId === null) {
      return
    }
    const clientMessageId = quirkyShutdownRowClientMessageId(
      input.sessionId,
      input.fence,
      input.generation
    )
    const items = input.journal.snapshot().items
    const written = items.some((item) => {
      const identity = parseAgentJournalItemKey(item.itemId)
      return identity?.provider === 'quirky' && identity.clientMessageId === clientMessageId
    })
    if (written || !cutByNobody(items.find((item) => item.itemId === turnItemId))) {
      return
    }
    await input.journal.appendItem(
      { provider: 'quirky', clientMessageId },
      quirkyStopRowBody(input.failureTextContext, input.trigger),
      { fence: input.rowFence, turnScope: { kind: 'turn', turnItemId } }
    )
  } catch (error) {
    input.logger.warn('recording why a quit cut a reply failed', {
      scope: 'shutdown-cut-row',
      sessionId: input.sessionId,
      error
    })
  }
}
