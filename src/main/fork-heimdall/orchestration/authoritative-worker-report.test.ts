import { describe, expect, it, vi } from 'vitest'
import type {
  AttemptObservationFact,
  MessageRow,
  OrchestrationDb
} from '../../runtime/orchestration/db'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { readAuthoritativeWorkerReportEvidence } from './authoritative-worker-report'

const CREATED_AT = '2026-09-22T12:00:00.000Z'
const ENROLLMENT: WatcherEnrollment = {
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
  coordinatorIdentity: { handle: 'coordinator', paneKey: 'coordinator-pane' },
  orchestrationRunId: 'run-1',
  createdAtMs: 1,
  terminalAtMs: null
}

function reportFact(input: {
  messageId: string
  sequence: number
  status: 'accepted' | 'rejected'
  outcome?: 'succeeded' | 'failed'
  reason?: string
  receivedAt?: number
}): AttemptObservationFact {
  const reportId = `worker_report:${input.messageId}`
  return {
    id: reportId,
    dispatchId: 'dispatch-1',
    taskId: 'task-1',
    sequence: input.sequence,
    authorityId: 'run_home:run-1',
    authorityClock: 'home',
    facet: 'worker_report',
    payload:
      input.status === 'accepted'
        ? { status: input.status, outcome: input.outcome ?? 'succeeded', reportId }
        : { status: input.status, reason: input.reason, reportId },
    sourceObservedAt: null,
    executionReceivedAt: null,
    homeReceivedAt: input.receivedAt ?? Date.parse(CREATED_AT),
    createdAt: CREATED_AT
  }
}

function workerDoneMessage(input: {
  messageId: string
  body: string
  outcome: 'succeeded' | 'failed'
  reportPath?: string
  filesModified?: unknown
  rejection?: { code: string; reason: string; originalReason: string; originalBody: string }
}): MessageRow {
  return {
    id: input.messageId,
    run_id: 'run-1',
    delivery_contract: 'current_delivery',
    from_handle: 'worker-1',
    to_handle: 'coordinator',
    subject: 'Done',
    body: input.body,
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: JSON.stringify({
      dispatchId: 'dispatch-1',
      taskId: 'task-1',
      outcome: input.outcome,
      ...(input.reportPath ? { reportPath: input.reportPath } : {}),
      ...(input.filesModified === undefined ? {} : { filesModified: input.filesModified }),
      ...(input.rejection ? { _quirkyLifecycleRejection: input.rejection } : {})
    }),
    read: 1,
    sequence: 7,
    created_at: CREATED_AT,
    delivered_at: CREATED_AT,
    sender_pane_key: 'worker-pane-1'
  }
}

function fixture(input: {
  facts: AttemptObservationFact[]
  taskResult: Record<string, unknown>
  taskStatus?: 'completed' | 'failed'
  message?: MessageRow
}) {
  const getMessageById = vi.fn(() => input.message)
  const dbMethods = {
    getDispatchContextById: vi.fn(() => ({
      id: 'dispatch-1',
      run_id: 'run-1',
      task_id: 'task-1',
      status: input.taskStatus ?? 'completed'
    })),
    getAttemptObservationFacts: vi.fn(() => input.facts),
    getTask: vi.fn(() => ({
      id: 'task-1',
      run_id: 'run-1',
      status: input.taskStatus ?? 'completed',
      result: JSON.stringify(input.taskResult)
    })),
    getMessageById
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readAuthoritativeWorkerReportEvidence only calls getDispatchContextById/getAttemptObservationFacts/getTask/getMessageById; OrchestrationDb's much larger sqlite-backed surface is unused here.
  const db = dbMethods as unknown as OrchestrationDb
  return { db, getMessageById }
}

function readReport(db: OrchestrationDb) {
  return readAuthoritativeWorkerReportEvidence({
    db,
    enrollment: ENROLLMENT,
    runId: 'run-1',
    dispatchId: 'dispatch-1'
  })
}

describe('authoritative worker report recovery', () => {
  it('recovers the exact accepted report when a newer repeated report fact exists', () => {
    const first = reportFact({ messageId: 'message-1', sequence: 0, status: 'accepted' })
    const repeated = reportFact({
      messageId: 'message-2',
      sequence: 1,
      status: 'accepted',
      receivedAt: Date.parse(CREATED_AT) + 1
    })
    const { db } = fixture({
      facts: [first, repeated],
      taskResult: {
        provenance: 'worker_report',
        outcome: 'succeeded',
        messageId: 'message-1',
        body: 'Report accepted.',
        reportPath: '.quirky/report.json',
        filesModified: ['src/fix.ts']
      },
      message: workerDoneMessage({
        messageId: 'message-1',
        body: 'Report accepted.',
        outcome: 'succeeded',
        reportPath: '.quirky/report.json',
        filesModified: ['src/fix.ts']
      })
    })

    expect(readReport(db)).toEqual({
      eventId: 'orchestration-mail:message-1',
      watcherId: 'watcher-1',
      atMs: Date.parse(CREATED_AT),
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'worker_done',
        payload: {
          dispatchId: 'dispatch-1',
          taskId: 'task-1',
          outcome: 'succeeded',
          reportPath: '.quirky/report.json',
          filesModified: ['src/fix.ts'],
          result: 'Report accepted.'
        }
      }
    })
  })

  it('reconstructs a lifecycle-rejected report only from its exact rejected report fact', () => {
    const { db } = fixture({
      facts: [
        reportFact({
          messageId: 'message-1',
          sequence: 0,
          status: 'rejected',
          reason: 'missing required evidence'
        })
      ],
      taskStatus: 'failed',
      taskResult: {
        provenance: 'worker_report_rejected',
        outcome: 'failed',
        reportedOutcome: 'succeeded',
        messageId: 'message-1',
        body: 'Rejected report.',
        reportPath: '.quirky/report.json',
        filesModified: ['src/bad.ts'],
        preflightRejection: {
          code: 'invalid_report',
          reason: 'missing required evidence',
          correctiveResendAvailable: false
        }
      },
      message: workerDoneMessage({
        messageId: 'message-1',
        body: 'Quirky rejected worker_done. Original body: Rejected report.',
        outcome: 'succeeded',
        reportPath: '.quirky/report.json',
        filesModified: ['src/bad.ts'],
        rejection: {
          code: 'invalid_report',
          reason: 'terminal diagnostic',
          originalReason: 'missing required evidence',
          originalBody: 'Rejected report.'
        }
      })
    })

    expect(readReport(db)).toEqual({
      eventId: 'orchestration-mail:message-1',
      watcherId: 'watcher-1',
      atMs: Date.parse(CREATED_AT),
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'worker_done',
        payload: {
          dispatchId: 'dispatch-1',
          taskId: 'task-1',
          outcome: 'failed',
          reportPath: '.quirky/report.json',
          filesModified: ['src/bad.ts'],
          reportRejection: {
            code: 'invalid_report',
            reason: 'missing required evidence'
          },
          result: {
            body: 'Rejected report.',
            reportRejection: {
              code: 'invalid_report',
              reason: 'missing required evidence'
            }
          }
        }
      }
    })
  })

  it('does not trust terminal status, task result, or a report path without an authoritative fact', () => {
    const { db, getMessageById } = fixture({
      facts: [],
      taskResult: {
        provenance: 'worker_report',
        outcome: 'succeeded',
        messageId: 'message-1',
        body: 'Unproven report.',
        reportPath: '.quirky/report.json'
      }
    })

    expect(readReport(db)).toBeNull()
    expect(getMessageById).not.toHaveBeenCalled()
  })
})
