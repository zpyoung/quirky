import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { HeartbeatResult, MutationResult, RunRow, TaskRow, WorkerReportResult } from '../../src/contracts'
import type { WorkerControlResult, WorkerListResult, WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './acceptance-support'

const SILENT_AGENT = join(import.meta.dir, 'acceptance-silent-agent.ts')

type WorkerReportSend = MutationResult<{ kind: string; report: WorkerReportResult }>

async function createRun(h: WorkerAcceptance): Promise<RunRow> {
  const result = await h.callAs<MutationResult<{ run: RunRow }>>(h.coordinator.id, 'run-create', ['--objective', 'Isolated worker recovery acceptance'])
  return result.run
}

async function startWorker(h: WorkerAcceptance, spec: string) {
  const receipt = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', [
    '--spec', spec, '--task-title', 'Recovery acceptance worker', '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '3000'
  ])
  expect(receipt.state).toBe('ready')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(shown.worker?.sessionId).toBeDefined()
  return { receipt, session: shown.worker!.sessionId!, shown }
}

async function report(h: WorkerAcceptance, session: string, receipt: WorkerStartReceipt, outcome: 'succeeded' | 'failed' = 'succeeded'): Promise<WorkerReportSend> {
  return h.callAs<WorkerReportSend>(session, 'send', [
    '--type', 'worker_done', '--task-id', receipt.taskId, '--dispatch-id', receipt.dispatchId,
    '--outcome', outcome, '--subject', `Recovery report ${outcome}`,
    '--body', 'The exact worker completed this report through its inherited CLI environment.'
  ])
}

function inputText(h: WorkerAcceptance, session: string): string {
  return h.events(session)
    .filter((event) => event.type === 'input' && typeof event.base64 === 'string')
    .map((event) => Buffer.from(event.base64 as string, 'base64').toString())
    .join('')
}

async function expectCliReason(h: WorkerAcceptance, session: string, args: string[], reason: string): Promise<void> {
  const result = await h.cli(session, ['orchestration', ...args])
  expect(result.code).not.toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { reason } })
}

test('idle readiness with an accepted but unobserved preamble stays unknown and recovers only through exact evidence', async () => {
  const h = await startWorkerAcceptance()
  try {
    const run = await createRun(h)
    const launcher = join(h.fixture.fakebin, 'claude')
    writeFileSync(launcher, `#!${process.execPath}\nimport ${JSON.stringify(SILENT_AGENT)}\n`)
    chmodSync(launcher, 0o755)

    const requestId = crypto.randomUUID()
    const startFlags = [
      '--spec', 'Wait for exact report after accepting the initial preamble.',
      '--task-title', 'Unobserved preamble recovery', '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '3000'
    ]
    const initialResult = await h.cli(h.coordinator.id, ['orchestration', 'worker-start', ...startFlags, '--retry-request', requestId])
    expect(initialResult.code).toBe(1)
    const initial = JSON.parse(initialResult.stdout) as MutationResult<WorkerStartReceipt>
    expect(initial).toMatchObject({
      state: 'outcome_unknown', stage: 'turn_unobserved', turnStart: 'unobserved',
      mutation: { requestId, replayed: false }
    })
    expect(initial.effects).toContainEqual(expect.objectContaining({ kind: 'dispatch_input', action: 'accepted_unobserved' }))

    const uncertain = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: initial.dispatchId }) as WorkerShowResult
    expect(uncertain.worker).toMatchObject({ state: 'start_unknown', stage: 'turn_unobserved' })
    expect(uncertain.worker?.sessionId).toBeDefined()
    expect(uncertain.projection.outcome).toBe('outcome_unknown')
    const session = uncertain.worker!.sessionId!
    const submitted = inputText(h, session)
    expect(submitted).toContain(initial.taskId)
    expect(submitted).toContain(initial.dispatchId)
    expect(h.events(session).some((event) => event.type === 'turn_started')).toBe(false)
    const tasks = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
    expect(tasks.tasks.find((task) => task.id === initial.taskId)?.status).toBe('blocked')

    const sessionsBeforeReplay = await h.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
    const replayResult = await h.cli(h.coordinator.id, ['orchestration', 'worker-start', ...startFlags, '--retry-request', requestId])
    expect(replayResult.code).toBe(1)
    const replay = JSON.parse(replayResult.stdout) as MutationResult<WorkerStartReceipt>
    expect(replay.dispatchId).toBe(initial.dispatchId)
    expect(replay.taskId).toBe(initial.taskId)
    expect(replay.mutation).toMatchObject({ requestId, replayed: true })
    expect(inputText(h, session)).toBe(submitted)
    const sessionsAfterReplay = await h.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
    expect(sessionsAfterReplay.map((item) => item.id).sort()).toEqual(sessionsBeforeReplay.map((item) => item.id).sort())

    const mismatchResult = await h.cli(h.coordinator.id, [
      'orchestration', 'worker-start', '--spec', 'A changed payload must not replay the uncertain operation.',
      ...startFlags.slice(2), '--retry-request', requestId
    ])
    expect(mismatchResult.code).not.toBe(0)
    expect(JSON.parse(mismatchResult.stdout)).toMatchObject({ error: { reason: 'request_mismatch' } })
    expect(inputText(h, session)).toBe(submitted)
    const sessionsAfterMismatch = await h.fixture.call('quirky.session/list', {}) as Array<{ id: string }>
    expect(sessionsAfterMismatch.map((item) => item.id).sort()).toEqual(sessionsBeforeReplay.map((item) => item.id).sort())

    const fleet = await h.callAs<WorkerListResult>(h.coordinator.id, 'worker-list')
    expect(fleet.scope).toEqual({ runId: run.id, source: 'bound' })
    expect(fleet.workers.find((row) => row.dispatchId === initial.dispatchId)?.projection.outcome).toBe('outcome_unknown')

    const firstPage = await h.callAs<WorkerReadResult>(h.coordinator.id, 'worker-read', ['--dispatch', initial.dispatchId, '--source', 'terminal'])
    expect(firstPage.source).toBe('terminal')
    expect(firstPage.sourceExact).toBe(true)
    expect(firstPage.nextCursor).not.toBeNull()
    await expectCliReason(h, h.coordinator.id, [
      'worker-read', '--dispatch', initial.dispatchId, '--source', 'transcript', '--cursor', firstPage.nextCursor!
    ], 'source_changed')
    await expectCliReason(h, h.coordinator.id, ['worker-read', '--dispatch', initial.dispatchId, '--cursor', 'not-a-cursor'], 'cursor_invalid')

    let cursor = firstPage.nextCursor
    const identities = [firstPage.sourceIdentity]
    for (let pageIndex = 0; cursor !== null && pageIndex < 16; pageIndex++) {
      const page = await h.callAs<WorkerReadResult>(h.coordinator.id, 'worker-read', [
        '--dispatch', initial.dispatchId, '--source', 'terminal', '--cursor', cursor
      ])
      expect(page.source).toBe('terminal')
      identities.push(page.sourceIdentity)
      cursor = page.nextCursor
    }
    expect(cursor).toBeNull()
    expect(identities.every((identity) => identity === firstPage.sourceIdentity)).toBe(true)

    const outsider = await h.fixture.call('quirky.session/create', {
      worktree: `path:${h.fixture.repo}`, agent: 'claude', title: 'Unrelated report sender'
    }) as { id: string }
    await eventually(() => h.events(outsider.id), (events) => events.some((event) => event.type === 'started'), 'unrelated launched reporter')
    const copied = await report(h, outsider.id, initial)
    expect(copied.report).toMatchObject({ status: 'rejected', reason: 'sender_not_assignee' })
    const remainsUnknown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: initial.dispatchId }) as WorkerShowResult
    expect(remainsUnknown.worker?.state).toBe('start_unknown')
    expect(remainsUnknown.dispatch.status).toBe('pending')

    const completed = await report(h, session, initial)
    expect(completed.report).toMatchObject({ status: 'accepted', worker: { state: 'succeeded' } })
    const duplicate = await report(h, session, initial)
    expect(duplicate.report).toMatchObject({ status: 'duplicate' })
    const conflict = await report(h, session, initial, 'failed')
    expect(conflict.report).toMatchObject({ status: 'rejected', reason: 'inactive_dispatch' })
    const settled = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: initial.dispatchId }) as WorkerShowResult
    expect(settled.worker?.state).toBe('succeeded')
    expect(settled.dispatch.status).toBe('completed')
  } finally {
    await h.cleanup()
  }
}, 120_000)

test('an exact worker heartbeat leaves its attempt dispatched and retry budget unchanged', async () => {
  const h = await startWorkerAcceptance()
  try {
    const run = await createRun(h)
    const worker = await startWorker(h, 'Report a heartbeat before completing this task.')
    const heartbeat = await h.callAs<MutationResult<{ kind: string; heartbeat: HeartbeatResult }>>(worker.session, 'send', [
      '--type', 'heartbeat', '--task-id', worker.receipt.taskId, '--dispatch-id', worker.receipt.dispatchId,
      '--subject', 'Checkpoint', '--body', 'The exact worker remains active.'
    ])
    expect(heartbeat.heartbeat.status).toBe('accepted')

    const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: worker.receipt.dispatchId }) as WorkerShowResult
    expect(shown.worker?.state).toBe('ready')
    expect(shown.dispatch.status).toBe('dispatched')
    expect(shown.dispatch.failureCount).toBe(0)
    expect(shown.dispatch.lastHeartbeatAt).toBeTruthy()
    const tasks = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
    expect(tasks.tasks.find((task) => task.id === worker.receipt.taskId)).toMatchObject({ status: 'dispatched', result: null })

    const fleet = await h.callAs<WorkerListResult>(h.coordinator.id, 'worker-list')
    expect(fleet.scope).toEqual({ runId: run.id, source: 'bound' })
    const row = fleet.workers.find((item) => item.dispatchId === worker.receipt.dispatchId)
    expect(row?.projection.outcome).toBe('in_progress')
    expect(row?.projection.attention.requiresAction).toBe(false)

    await report(h, worker.session, worker.receipt)
    const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', worker.receipt.dispatchId])
    expect(released.state).toBe('released')
  } finally {
    await h.cleanup()
  }
}, 90_000)

test('a live abandoned prior process cannot report into its retry Dispatch', async () => {
  const h = await startWorkerAcceptance()
  try {
    await createRun(h)
    const first = await startWorker(h, 'Keep this process alive while its retry starts.')
    const abandoned = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-abandon', ['--dispatch', first.receipt.dispatchId])
    expect(abandoned.state).toBe('abandoned')
    expect(abandoned.processAction).toBe('none')
    expect(await h.ptyAlive(first.session)).toBe(true)

    const retry = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', [
      '--task', first.receipt.taskId, '--retry-of', first.receipt.dispatchId,
      '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '3000'
    ])
    expect(retry.state).toBe('ready')
    const stale = await report(h, first.session, first.receipt)
    expect(stale.report).toMatchObject({ status: 'rejected', reason: 'stale_dispatch' })

    const current = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: retry.dispatchId }) as WorkerShowResult
    expect(current.worker?.state).toBe('ready')
    expect(current.dispatch.status).toBe('dispatched')
    expect(current.dispatch.taskId).toBe(first.receipt.taskId)
    const newWorker = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: retry.dispatchId }) as WorkerShowResult
    expect(newWorker.worker?.sessionId).toBeDefined()
    const currentReport = await report(h, newWorker.worker!.sessionId!, retry)
    expect(currentReport.report.status).toBe('accepted')
  } finally {
    await h.cleanup()
  }
}, 90_000)
