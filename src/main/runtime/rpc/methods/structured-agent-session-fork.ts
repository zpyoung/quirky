// `agentSession.fork`: a new chat that continues this one. The provider conversation is copied
// through the same machinery "Resume in New CLI" uses (`copyStructuredChatRecordConversation`), the
// new chat adopts that copy through the ordinary create path, and its journal opens with a `fork`
// row ahead of the adopted history. Only agents whose chat makes the copy can fork; the rest
// answer `unsupported`. Additive: a host without it lacks the method, and a client hides Fork when
// the host does not advertise `agent-session.v1-chat-methods.v1`.

import { randomUUID } from 'node:crypto'
import { agentForksThroughChat } from '../../../../shared/agent-resume-argv'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session-journal-types'
import type { AgentJournalForkItem } from '../../../../shared/agent-session-journal-v1-items'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  AgentSessionForkParams,
  type AgentSessionForkResult
} from '../../../../shared/rpc-contract/structured-agent-session-params'
import { createStructuredAgentSessionId } from '../../../../shared/structured-agent-session-create'
import { copyStructuredChatRecordConversation } from '../../../ai-vault/structured-chat-conversation-copy'
import type { JournalReplacementItem } from '../../../native-chat/agent-session-journal/journal-epoch-replacement'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { defineMethod, type RpcContext } from '../core'
import { requireStructuredSessionHost, structuredCallerFor } from './structured-agent-session-gate'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'

export const FORK_ITEM_IDENTITY = { provider: 'quirky', clientMessageId: 'fork' } as const

/** What a fork needs from the host and the create path, so the decision order is testable alone. */
export type StructuredAgentSessionForkPorts = {
  record: (sessionId: string) => AgentSessionRecord | null
  isWorking: (sessionId: string) => Promise<boolean>
  /** Whether this chat's agent copies its conversation. */
  canCopy: (record: AgentSessionRecord) => boolean
  /** Copies the chat's provider conversation; answers the copy's id. */
  copy: (record: AgentSessionRecord) => Promise<{ providerSessionId: string }>
  /** Creates the chat adopting `providerSessionId`, its journal opening with `openingItems`. */
  create: (input: {
    sessionId: string
    record: AgentSessionRecord
    providerSessionId: string
    openingItems: JournalReplacementItem[]
  }) => Promise<void>
  /** Whether a record for the new chat exists now. */
  exists: (sessionId: string) => boolean
  rename: (sessionId: string, title: string) => Promise<void>
  newSessionId: (record: AgentSessionRecord) => string
}

export function forkOpeningItem(
  record: AgentSessionRecord,
  fromItemId: string | undefined
): JournalReplacementItem {
  const body: AgentJournalForkItem = {
    kind: 'fork',
    fromSessionId: record.sessionId,
    ...(fromItemId ? { fromItemId } : {}),
    ...(record.conversationName ? { fromTitle: record.conversationName } : {})
  }
  return {
    identity: FORK_ITEM_IDENTITY,
    body,
    observedAt: Date.now(),
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    ownerFence: 0
  }
}

/** The conversation is copied whole: `fromItemId` is recorded on the `fork` row, since no agent's
 *  copy can stop at an item. */
export async function forkStructuredAgentSession(
  ports: StructuredAgentSessionForkPorts,
  params: { sessionId: string; fromItemId?: string; title?: string }
): Promise<AgentSessionForkResult> {
  const record = ports.record(params.sessionId)
  if (!record) {
    return { ok: false, reason: 'failed' }
  }
  if (!ports.canCopy(record)) {
    return { ok: false, reason: 'unsupported' }
  }
  const newSessionId = ports.newSessionId(record)
  try {
    if (await ports.isWorking(params.sessionId)) {
      return { ok: false, reason: 'busy' }
    }
    const { providerSessionId } = await ports.copy(record)
    await ports.create({
      sessionId: newSessionId,
      record,
      providerSessionId,
      openingItems: [forkOpeningItem(record, params.fromItemId)]
    })
  } catch {
    // A refusal after the durable create (its tab unconfirmed) leaves a usable chat: that is the answer.
    return ports.exists(newSessionId)
      ? { ok: true, sessionId: newSessionId }
      : { ok: false, reason: 'failed' }
  }
  if (params.title) {
    await ports.rename(newSessionId, params.title).catch(() => undefined)
  }
  return { ok: true, sessionId: newSessionId }
}

function hostPorts(
  host: StructuredAgentSessionHost,
  ctx: RpcContext
): StructuredAgentSessionForkPorts {
  const { store } = host.deps
  return {
    record: (sessionId) => store.getRecord(sessionId),
    isWorking: (sessionId) => host.isWorking(sessionId),
    canCopy: (record) => agentForksThroughChat(record.provider),
    copy: async (record) => {
      const history = structuredAgentRuntimeMetadata(record.provider)?.sessionHistory
      const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
      if (!history || !head) {
        throw new Error('The chat has no provider conversation to copy.')
      }
      const copied = await copyStructuredChatRecordConversation(record, history.rowSessionId(head))
      if (!copied.forkedSession) {
        throw new Error('The agent made no copy of the conversation.')
      }
      return { providerSessionId: copied.forkedSession.sessionId }
    },
    create: async (input) => {
      const { record } = input
      const resumeFrom = { providerSessionId: input.providerSessionId }
      const options = {
        ...record.options,
        ...(record.permissionMode ? { permissionMode: record.permissionMode } : {})
      }
      const worktree = `id:${record.location.workspaceId}`
      const baseEnvelope = {
        sessionId: input.sessionId,
        clientOperationId: randomUUID(),
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
      const envelope = {
        ...baseEnvelope,
        payloadFingerprint: structuredAgentSessionCreateIntentFingerprint({
          envelope: baseEnvelope,
          worktree,
          agent: record.provider,
          resumeFrom,
          options
        })
      }
      const caller = structuredCallerFor(ctx)
      const prepared = await resolveUncommittedStructuredCreate(() =>
        prepareStructuredAgentSessionCreateForWorktree({
          runtime: ctx.runtime,
          ensureHost: async () => host,
          envelope,
          worktree,
          agent: record.provider,
          caller,
          resumeFrom,
          options,
          atRest: true
        })
      )
      if ('refusal' in prepared) {
        throw new Error(prepared.refusal.message)
      }
      const result = await commitStructuredAgentSessionCreate({
        runtime: ctx.runtime,
        caller,
        prepared: { ...prepared, openingItems: input.openingItems },
        activate: true
      })
      if (!result.ok) {
        throw new Error(result.refusal.message)
      }
    },
    exists: (sessionId) => store.getRecord(sessionId) !== null,
    rename: async (sessionId, title) => {
      await store.setConversationName(sessionId, title)
    },
    newSessionId: (record) => createStructuredAgentSessionId(record.provider, randomUUID)
  }
}

export const STRUCTURED_AGENT_SESSION_FORK_METHODS = [
  defineMethod({
    name: 'agentSession.fork',
    permission: 'workspace',
    params: AgentSessionForkParams,
    handler: async (params, ctx): Promise<AgentSessionForkResult> => {
      const { sessionId } = params.envelope
      const host = requireStructuredSessionHost(ctx, sessionId)
      return forkStructuredAgentSession(hostPorts(host, ctx), {
        sessionId,
        ...(params.fromItemId ? { fromItemId: params.fromItemId } : {}),
        ...(params.title ? { title: params.title } : {})
      })
    }
  })
]
