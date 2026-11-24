import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { RuntimeHeimdallOrchestrationAdapter } from './orchestration-adapter'
import { mailboxEvidenceForMessage } from './mailbox-drain'

const upstream = vi.hoisted(() => ({
  checkRunMailbox: vi.fn(),
  resolveRunScope: vi.fn()
}))

vi.mock('../../runtime/rpc/methods/orchestration/messaging/check-run', () => ({
  checkRunMailbox: upstream.checkRunMailbox
}))
vi.mock('../../runtime/rpc/methods/orchestration/runs/run-scope', () => ({
  resolveRunScope: upstream.resolveRunScope
}))

const IDENTITY = { handle: 'heimdall-coordinator', paneKey: 'heimdall-pane' }

const ENROLLMENT = {
  watcherId: 'watcher-1',
  kind: 'hosted-review',
  workspaceKey: 'local::/repo',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: 'repo-1::/repo',
  workspacePath: '/repo',
  schedulerOwner: 'local_host_service',
  enabled: true,
  paused: false,
  commandRevision: 0,
  capabilities: {},
  budget: { wallClockActiveMs: null, turns: null },
  kindPayload: {},
  coordinatorIdentity: IDENTITY,
  orchestrationRunId: 'run-1',
  createdAtMs: 1,
  terminalAtMs: null
} satisfies WatcherEnrollment

function message(id: string, sequence: number, body: string) {
  return {
    id,
    run_id: 'run-1',
    delivery_contract: 'current_delivery' as const,
    from_handle: 'term-worker',
    to_handle: 'run:run-1',
    subject: `subject-${sequence}`,
    body,
    type: 'worker_done' as const,
    priority: 'normal' as const,
    thread_id: null,
    payload: null,
    read: 0,
    sequence,
    created_at: '2026-09-14T12:00:00.000Z',
    delivered_at: null,
    sender_pane_key: 'worker-pane'
  }
}

function normalizedPayload(entry: { payload: unknown }): object {
  const envelope = entry.payload
  if (!envelope || typeof envelope !== 'object' || !('payload' in envelope)) {
    throw new Error('Expected normalized mailbox envelope')
  }
  const payload = envelope.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Expected normalized mailbox payload')
  }
  return payload
}

describe('Heimdall orchestration mailbox drain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    upstream.resolveRunScope.mockReturnValue({
      id: 'run-1',
      consumer_generation: 3,
      coordinator_handle: IDENTITY.handle,
      coordinator_pane_key: IDENTITY.paneKey
    })
  })

  it('records one batch before acknowledging it on the next drain and dedupes a redelivery by sequence', async () => {
    const events: string[] = []
    const first = {
      ...message('message-7', 7, 'finished once'),
      payload: JSON.stringify({
        dispatchId: 'dispatch-7',
        outcome: 'succeeded',
        taskId: 'task-7',
        reportPath: '/repo/.quirky/reports/node-7.json',
        filesModified: ['src/node.ts']
      })
    }
    const second = {
      ...message('message-8', 8, 'finished next'),
      payload: JSON.stringify({
        dispatchId: 'dispatch-8',
        outcome: 'failed',
        taskId: 'task-8',
        reportPath: '/repo/.quirky/reports/node-8.json',
        filesModified: ['src/failed.ts']
      })
    }
    const rows = {
      [first.id]: first,
      [second.id]: second
    }
    const db = {
      getMessageById: vi.fn((id: string) => rows[id])
    }
    const runtime = { getOrchestrationDb: vi.fn(() => db) }
    upstream.checkRunMailbox
      .mockImplementationOnce(async ({ params }: { params: { ack?: string } }) => {
        events.push(`check:${params.ack ?? 'none'}`)
        return {
          runId: 'run-1',
          deliveryId: 'delivery-1',
          messages: [{ id: first.id }],
          count: 1,
          replayed: false
        }
      })
      .mockImplementationOnce(async ({ params }: { params: { ack?: string } }) => {
        events.push(`check:${params.ack ?? 'none'}`)
        return {
          runId: 'run-1',
          deliveryId: 'delivery-1',
          messages: [{ id: first.id }],
          count: 1,
          replayed: true
        }
      })
      .mockImplementationOnce(async ({ params }: { params: { ack?: string } }) => {
        events.push(`check:${params.ack ?? 'none'}`)
        return {
          runId: 'run-1',
          deliveryId: 'delivery-2',
          messages: [{ id: second.id }],
          count: 1,
          replayed: false,
          acknowledged: params.ack ?? null
        }
      })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large QuirkyRuntimeService class; drainMailbox only calls runtime.getOrchestrationDb().
    const adapter = new RuntimeHeimdallOrchestrationAdapter(runtime as never, {
      persistOrchestrationRunId: async () => undefined
    })

    const delivered = await adapter.drainMailbox({
      enrollment: ENROLLMENT,
      cursor: { previousDeliveryId: null, lastSequence: -1 }
    })
    for (const entry of delivered) {
      events.push(`record:${entry.kind === 'evidence' ? entry.source?.sequence : 'missing'}`)
    }

    // A crash that loses only the pending acknowledgement re-opens the same durable Delivery id.
    // Its message is harmless because the ledger's sequence cursor was already committed.
    const replayed = await adapter.drainMailbox({
      enrollment: ENROLLMENT,
      cursor: { previousDeliveryId: null, lastSequence: 7 }
    })
    const recovered = await adapter.drainMailbox({
      enrollment: ENROLLMENT,
      cursor: { previousDeliveryId: 'delivery-1', lastSequence: 7 }
    })

    expect(events).toEqual(['check:none', 'record:7', 'check:none', 'check:delivery-1'])
    expect(delivered).toEqual([
      expect.objectContaining({
        watcherId: 'watcher-1',
        kind: 'evidence',
        evidenceKind: 'orchestration-mailbox',
        source: {
          kind: 'orchestration',
          sequence: 7,
          messageId: 'message-7',
          deliveryId: 'delivery-1'
        },
        payload: {
          type: 'worker_done',
          payload: {
            dispatchId: 'dispatch-7',
            taskId: 'task-7',
            outcome: 'succeeded',
            reportPath: '/repo/.quirky/reports/node-7.json',
            filesModified: ['src/node.ts'],
            result: 'finished once'
          }
        }
      })
    ])
    expect(replayed).toEqual([])
    expect(recovered).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ sequence: 8, messageId: 'message-8' }),
        payload: {
          type: 'worker_done',
          payload: {
            dispatchId: 'dispatch-8',
            taskId: 'task-8',
            outcome: 'failed',
            reportPath: '/repo/.quirky/reports/node-8.json',
            filesModified: ['src/failed.ts'],
            result: 'finished next'
          }
        }
      })
    ])
    expect(upstream.checkRunMailbox.mock.calls[1]![0].params.ack).toBeUndefined()
    expect(upstream.checkRunMailbox.mock.calls[2]![0].params.ack).toBe('delivery-1')
  })

  it('normalizes a lifecycle-rejected completion as failed with durable rejection detail', () => {
    const row = {
      ...message('message-rejected', 9, 'Quirky rejected worker report.'),
      payload: JSON.stringify({
        dispatchId: 'dispatch-9',
        outcome: 'succeeded',
        taskId: 'task-9',
        reportPath: '/repo/.quirky/reports/node-9.json',
        filesModified: ['src/rejected.ts'],
        _quirkyLifecycleRejection: {
          code: 'invalid_report',
          reason: 'terminal diagnostic',
          originalReason: 'missing required evidence',
          originalBody: 'worker claimed success'
        }
      })
    }

    expect(mailboxEvidenceForMessage(ENROLLMENT, 'delivery-9', row)).toEqual(
      expect.objectContaining({
        source: expect.objectContaining({
          sequence: 9,
          messageId: 'message-rejected',
          deliveryId: 'delivery-9'
        }),
        payload: {
          type: 'worker_done',
          payload: {
            dispatchId: 'dispatch-9',
            taskId: 'task-9',
            outcome: 'failed',
            reportPath: '/repo/.quirky/reports/node-9.json',
            filesModified: ['src/rejected.ts'],
            reportRejection: {
              code: 'invalid_report',
              reason: 'missing required evidence'
            },
            result: {
              body: 'worker claimed success',
              reportRejection: {
                code: 'invalid_report',
                reason: 'missing required evidence'
              }
            }
          }
        }
      })
    )
  })

  it('preserves supplied malformed files evidence while leaving omission absent', () => {
    const malformed = mailboxEvidenceForMessage(ENROLLMENT, null, {
      ...message('message-malformed-files', 10, 'finished'),
      payload: JSON.stringify({
        dispatchId: 'dispatch-10',
        taskId: 'task-10',
        outcome: 'succeeded',
        filesModified: ['src/valid.ts', 42]
      })
    })
    const omitted = mailboxEvidenceForMessage(ENROLLMENT, null, {
      ...message('message-omitted-files', 11, 'finished'),
      payload: JSON.stringify({
        dispatchId: 'dispatch-11',
        taskId: 'task-11',
        outcome: 'succeeded'
      })
    })
    const malformedPayload = normalizedPayload(malformed)
    const omittedPayload = normalizedPayload(omitted)

    expect(malformedPayload).toHaveProperty('filesModified', ['src/valid.ts', 42])
    expect(omittedPayload).not.toHaveProperty('filesModified')
  })

  it('does not acknowledge the batch it is returning', async () => {
    const row = message('message-1', 1, 'result')
    const db = { getMessageById: vi.fn(() => row) }
    upstream.checkRunMailbox.mockResolvedValue({
      runId: 'run-1',
      deliveryId: 'delivery-current',
      messages: [{ id: row.id }],
      count: 1
    })
    const adapter = new RuntimeHeimdallOrchestrationAdapter(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large QuirkyRuntimeService class; drainMailbox only calls runtime.getOrchestrationDb().
      { getOrchestrationDb: () => db } as never,
      { persistOrchestrationRunId: async () => undefined }
    )

    await adapter.drainMailbox({
      enrollment: ENROLLMENT,
      cursor: { previousDeliveryId: 'delivery-previous', lastSequence: 0 }
    })

    expect(upstream.checkRunMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ ack: 'delivery-previous' })
      })
    )
    expect(upstream.checkRunMailbox.mock.calls[0]![0].params.ack).not.toBe('delivery-current')
  })

  it('stores a question as a cited semantic fact instead of copying the orchestration row', async () => {
    const row = {
      ...message('message-question', 9, 'Which implementation should I use?'),
      type: 'question' as const,
      subject: 'Need a decision',
      payload: JSON.stringify({
        dispatchId: 'dispatch-9',
        taskId: 'task-9',
        reportPath: '/must/not/pass',
        filesModified: ['must-not-pass.ts']
      })
    }
    const db = { getMessageById: vi.fn(() => row) }
    upstream.checkRunMailbox.mockResolvedValue({
      runId: 'run-1',
      deliveryId: 'delivery-question',
      messages: [{ id: row.id }],
      count: 1
    })
    const adapter = new RuntimeHeimdallOrchestrationAdapter(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large QuirkyRuntimeService class; drainMailbox only calls runtime.getOrchestrationDb().
      { getOrchestrationDb: () => db } as never,
      { persistOrchestrationRunId: async () => undefined }
    )

    const [entry] = await adapter.drainMailbox({
      enrollment: ENROLLMENT,
      cursor: { previousDeliveryId: null, lastSequence: 8 }
    })

    expect(entry).toMatchObject({
      source: { messageId: 'message-question', sequence: 9 },
      payload: {
        type: 'question',
        body: 'Which implementation should I use?',
        payload: { dispatchId: 'dispatch-9', taskId: 'task-9' }
      }
    })
    if (!entry || entry.kind !== 'evidence') {
      throw new Error('Expected mailbox evidence')
    }
    expect(entry.payload).not.toHaveProperty('subject')
    expect(entry.payload).not.toHaveProperty('messageId')
    const fact = normalizedPayload(entry)
    expect(fact).not.toHaveProperty('reportPath')
    expect(fact).not.toHaveProperty('filesModified')
  })

  it.each([
    'status',
    'dispatch',
    'merge_ready',
    'escalation',
    'handoff',
    'decision_gate',
    'heartbeat'
  ] as const)('passes taskId through %s facts without worker report fields', async (type) => {
    const row = {
      ...message(`message-${type}`, 10, 'worker update'),
      type,
      payload: JSON.stringify({
        taskId: `task-${type}`,
        reportPath: '/must/not/pass',
        filesModified: ['must-not-pass.ts']
      })
    }
    const db = { getMessageById: vi.fn(() => row) }
    upstream.checkRunMailbox.mockResolvedValue({
      runId: 'run-1',
      deliveryId: `delivery-${type}`,
      messages: [{ id: row.id }],
      count: 1
    })
    const adapter = new RuntimeHeimdallOrchestrationAdapter(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large QuirkyRuntimeService class; drainMailbox only calls runtime.getOrchestrationDb().
      { getOrchestrationDb: () => db } as never,
      { persistOrchestrationRunId: async () => undefined }
    )

    const [entry] = await adapter.drainMailbox({
      enrollment: ENROLLMENT,
      cursor: { previousDeliveryId: null, lastSequence: 9 }
    })

    expect(entry).toMatchObject({
      payload: {
        type,
        payload: { taskId: `task-${type}` },
        ...(type === 'escalation' ? { subject: 'subject-10', body: 'worker update' } : {})
      }
    })
    if (!entry || entry.kind !== 'evidence') {
      throw new Error('Expected mailbox evidence')
    }
    const fact = normalizedPayload(entry)
    expect(fact).not.toHaveProperty('reportPath')
    expect(fact).not.toHaveProperty('filesModified')
  })
})
