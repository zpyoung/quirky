import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  forkStructuredAgentSession,
  type StructuredAgentSessionForkPorts
} from './structured-agent-session-fork'

const SOURCE: AgentSessionRecord = {
  schemaVersion: 2,
  sessionId: 'omp_source',
  provider: 'omp',
  conversationName: 'Parser work',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'repo_1::/tmp/wt-a',
    workspaceKind: 'folder'
  },
  providerHandleChain: [],
  accountHome: { variable: 'OMP_HOME', path: '/home/work/.omp' },
  lease: {
    sessionId: 'omp_source',
    runtimeKind: 'native',
    runtimeFence: 1,
    handoffStage: null,
    provenHandleLinkId: null,
    ownerProcess: null,
    reservedSpawnToken: null,
    leaseDeadlineAt: 0,
    lastRenewedAt: 0,
    handoffOperationId: null,
    claimKeyId: 'key-1',
    claimStatus: 'live',
    unreconciled: false,
    deathEvidence: null
  },
  createdAt: 1,
  updatedAt: 1
}

function ports(overrides: Partial<StructuredAgentSessionForkPorts> = {}) {
  const created: Parameters<StructuredAgentSessionForkPorts['create']>[0][] = []
  const value: StructuredAgentSessionForkPorts = {
    record: () => SOURCE,
    isWorking: async () => false,
    canCopy: () => true,
    copy: async () => ({ providerSessionId: 'copy-1' }),
    create: async (input) => {
      created.push(input)
    },
    exists: () => false,
    rename: vi.fn(async () => undefined),
    newSessionId: () => 'omp_fork',
    ...overrides
  }
  return { value, created }
}

describe('agentSession.fork', () => {
  it('refuses while a turn is running, before copying anything', async () => {
    const copy = vi.fn(async () => ({ providerSessionId: 'copy-1' }))
    const { value } = ports({ isWorking: async () => true, copy })
    await expect(
      forkStructuredAgentSession(value, { sessionId: SOURCE.sessionId })
    ).resolves.toEqual({
      ok: false,
      reason: 'busy'
    })
    expect(copy).not.toHaveBeenCalled()
  })

  it('answers unsupported for an agent that cannot copy its conversation', async () => {
    const { value, created } = ports({ canCopy: () => false })
    await expect(
      forkStructuredAgentSession(value, { sessionId: SOURCE.sessionId })
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported'
    })
    expect(created).toEqual([])
  })

  it('creates the chat from the copy with the fork row first', async () => {
    const { value, created } = ports()
    const result = await forkStructuredAgentSession(value, {
      sessionId: SOURCE.sessionId,
      fromItemId: 'item-9',
      title: 'Fork'
    })
    expect(result).toEqual({ ok: true, sessionId: 'omp_fork' })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ sessionId: 'omp_fork', providerSessionId: 'copy-1' })
    expect(created[0]?.openingItems[0]?.body).toEqual({
      kind: 'fork',
      fromSessionId: SOURCE.sessionId,
      fromItemId: 'item-9',
      fromTitle: 'Parser work'
    })
    expect(value.rename).toHaveBeenCalledWith('omp_fork', 'Fork')
  })

  it('answers failed, with no record, when the copy or the create throws', async () => {
    const { value } = ports({
      copy: async () => {
        throw new Error('boom')
      }
    })
    await expect(
      forkStructuredAgentSession(value, { sessionId: SOURCE.sessionId })
    ).resolves.toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('keeps a chat the create left durable even when it then refused', async () => {
    const { value } = ports({
      create: async () => {
        throw new Error('tab unconfirmed')
      },
      exists: () => true
    })
    await expect(
      forkStructuredAgentSession(value, { sessionId: SOURCE.sessionId })
    ).resolves.toEqual({
      ok: true,
      sessionId: 'omp_fork'
    })
  })
})
