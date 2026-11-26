import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import type {
  AgentSessionForkResult,
  AgentSessionTurnDiffResult
} from '../../../shared/rpc-contract/structured-agent-session-params'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { callStructuredAgentSession } from './structured-agent-session-client'

const FORK_FAILED: AgentSessionForkResult = { ok: false, reason: 'failed' }
const TURN_DIFF_FAILED: AgentSessionTurnDiffResult = { ok: false, reason: 'failed' }

async function readRuntimeFence(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<number | null> {
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    target,
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  return typeof fence === 'number' ? fence : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The fork result from either reply shape a host may send: bare, or inside the mutation envelope
 *  every other `agentSession` write answers with. Anything else reads as a failure. */
function readForkResult(reply: unknown): AgentSessionForkResult {
  if (!isRecord(reply)) {
    return FORK_FAILED
  }
  const payload = 'value' in reply ? reply.value : reply
  if (!isRecord(payload)) {
    return FORK_FAILED
  }
  if (payload.ok === true && typeof payload.sessionId === 'string') {
    return { ok: true, sessionId: payload.sessionId }
  }
  if (payload.reason === 'unsupported' || payload.reason === 'busy') {
    return { ok: false, reason: payload.reason }
  }
  return FORK_FAILED
}

/** Forks the session into a new one continuing it, from `fromItemId` when given. A thrown error or
 *  a refusal reads as `failed`; call only against a host advertising
 *  `AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY`. */
export async function forkStructuredAgentSession(
  target: RuntimeClientTarget,
  sessionId: string,
  fields: { fromItemId?: string; title?: string } = {}
): Promise<AgentSessionForkResult> {
  try {
    const fence = await readRuntimeFence(target, sessionId)
    if (fence === null) {
      return FORK_FAILED
    }
    const reply = await callStructuredAgentSession<unknown>(target, 'agentSession.fork', {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(createBrowserUuid),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.fork',
          sessionId,
          fields
        })
      },
      ...fields
    })
    return readForkResult(reply)
  } catch {
    return FORK_FAILED
  }
}

/** One file's patch from a turn's `turn-changes` item. A thrown error reads as `failed`. */
export async function readStructuredAgentSessionTurnDiff(
  target: RuntimeClientTarget,
  sessionId: string,
  turnId: string,
  path: string
): Promise<AgentSessionTurnDiffResult> {
  try {
    const reply = await callStructuredAgentSession<unknown>(target, 'agentSession.turnDiff', {
      sessionId,
      turnId,
      path
    })
    if (!isRecord(reply)) {
      return TURN_DIFF_FAILED
    }
    if (reply.ok === true && typeof reply.patch === 'string') {
      return { ok: true, patch: reply.patch, truncated: reply.truncated === true }
    }
    if (reply.reason === 'gone' || reply.reason === 'not-git') {
      return { ok: false, reason: reply.reason }
    }
    return TURN_DIFF_FAILED
  } catch {
    return TURN_DIFF_FAILED
  }
}
