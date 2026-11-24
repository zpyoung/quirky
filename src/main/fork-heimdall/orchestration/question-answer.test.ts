import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import {
  QuestionAlreadyAnsweredError,
  RuntimeHeimdallOrchestrationAdapter
} from './orchestration-adapter'

const COORDINATOR = {
  handle: 'term_coord',
  paneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
}

describe('Heimdall question answer delivery', () => {
  let db: OrchestrationDb
  let runtime: QuirkyRuntimeService
  let ensureRelay: MockInstance<(runId?: string) => void>

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new QuirkyRuntimeService()
    ensureRelay = vi
      .spyOn(runtime, 'ensureOrchestrationFederationRelay')
      .mockImplementation(() => {})
    runtime.setOrchestrationDb(db)
    ensureRelay.mockClear()
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('commits one local answer before waking the exact waiting Dispatch', async () => {
    const seeded = seedQuestion(db)
    const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {
      const answered = db.getQuestion(seeded.questionId)
      expect(answered?.status).toBe('answered')
      expect(db.getMessageById(answered!.answer_message_id!)).toBeDefined()
    })
    const adapter = createAdapter(runtime)

    await adapter.answerQuestion(seeded.enrollment, seeded.questionId, 'Use JSON.')
    const firstAnswerId = db.getQuestion(seeded.questionId)?.answer_message_id
    await adapter.answerQuestion(seeded.enrollment, seeded.questionId, 'Use JSON.')

    expect(db.getQuestion(seeded.questionId)?.answer_message_id).toBe(firstAnswerId)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(`dispatch:${seeded.dispatchId}`, 'status')
    await expect(
      adapter.answerQuestion(seeded.enrollment, seeded.questionId, 'Use text.')
    ).rejects.toBeInstanceOf(QuestionAlreadyAnsweredError)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('durably queues a federated reply before starting its Run relay', async () => {
    const seeded = seedQuestion(db)
    db.db
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint
         ) VALUES (?, ?, ?, ?)`
      )
      .run(seeded.dispatchId, 'remote-1', 'Remote One', 'peer-fingerprint')
    ensureRelay.mockImplementation((runId?: string) => {
      expect(runId).toBe(seeded.runId)
      expect(db.listPendingFederationRelay(seeded.dispatchId, 'to_worker')).toHaveLength(1)
    })
    const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const adapter = createAdapter(runtime)

    await adapter.answerQuestion(seeded.enrollment, seeded.questionId, 'Use JSON.')

    const [relay] = db.listPendingFederationRelay(seeded.dispatchId, 'to_worker')
    expect(relay).toMatchObject({ kind: 'reply' })
    expect(JSON.parse(relay!.payload)).toEqual({
      questionId: seeded.questionId,
      answerMessageId: db.getQuestion(seeded.questionId)?.answer_message_id,
      body: 'Use JSON.'
    })
    expect(ensureRelay).toHaveBeenCalledWith(seeded.runId)
    expect(notify).not.toHaveBeenCalled()
  })
})

function seedQuestion(db: OrchestrationDb): {
  runId: string
  dispatchId: string
  questionId: string
  enrollment: WatcherEnrollment
} {
  const run = db.createRun({
    objective: 'Answer delivery',
    coordinatorHandle: COORDINATOR.handle,
    coordinatorPaneKey: COORDINATOR.paneKey
  })
  const task = db.createTask({ spec: 'Ask for a format', runId: run.id })
  const dispatch = createRootDispatch(
    db,
    task.id,
    'term_worker',
    'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  )
  const question = db.createQuestion({
    runId: run.id,
    dispatchId: dispatch.id,
    askerHandle: 'term_worker',
    question: 'Which format?'
  })
  return {
    runId: run.id,
    dispatchId: dispatch.id,
    questionId: question.message.id,
    enrollment: {
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
      coordinatorIdentity: COORDINATOR,
      orchestrationRunId: run.id,
      createdAtMs: 1,
      terminalAtMs: null
    }
  }
}

function createAdapter(runtime: QuirkyRuntimeService): RuntimeHeimdallOrchestrationAdapter {
  return new RuntimeHeimdallOrchestrationAdapter(runtime, {
    persistOrchestrationRunId: async () => undefined
  })
}
