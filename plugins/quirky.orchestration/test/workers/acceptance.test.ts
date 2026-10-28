import { afterEach, expect, test } from 'bun:test'
import type { MessageRow, MutationResult, RunRow, TaskRow } from '../../src/contracts'
import type { WorkerControlResult, WorkerListResult, WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './acceptance-support'

let harness: WorkerAcceptance | undefined
afterEach(async () => { await harness?.cleanup(); harness = undefined })

async function startRun() {
  harness = await startWorkerAcceptance()
  const result = await harness.callAs<MutationResult<{ run: RunRow }>>(harness.coordinator.id, 'run-create', ['--objective', 'Isolated real worker lifecycle acceptance'])
  return { h: harness, run: result.run }
}
async function startWorker(h: WorkerAcceptance, spec = 'Choose blue and report the exact outcome.', extra: string[] = []) {
  const receipt = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', ['--spec', spec, '--task-title', 'Worker color choice', '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '3000', ...extra])
  expect(receipt.state).toBe('ready')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(shown.worker?.sessionId).toBeDefined()
  return { receipt, session: shown.worker!.sessionId!, shown }
}
async function report(h: WorkerAcceptance, session: string, receipt: WorkerStartReceipt, outcome: 'succeeded' | 'failed' = 'succeeded') {
  return h.callAs<{ kind: string; report: { status: string } }>(session, 'send', ['--type', 'worker_done', '--task-id', receipt.taskId, '--dispatch-id', receipt.dispatchId, '--outcome', outcome, '--subject', `Color task ${outcome}`, '--body', 'Chose blue. Verified the value. No additional work remains.'])
}

test('a real launched worker receives its scoped brief, reports via CLI, and is archived before exact release', async () => {
  const { h, run } = await startRun()
  const { receipt, session } = await startWorker(h)
  expect(receipt.runId).toBe(run.id)
  expect(receipt.mode.mode).toBe('terminal')
  expect((await h.session(session)).title).toContain('Worker color choice')
  const input = await eventually(() => h.events(session).filter((e) => e.type === 'input').map((e) => Buffer.from(e.base64 as string, 'base64').toString()).join(''), (text) => text.includes(receipt.dispatchId), 'actual worker preamble delivery')
  expect(input).toContain(receipt.taskId)
  expect(input).toContain('Choose blue and report the exact outcome.')
  const completion = await report(h, session, receipt)
  expect(completion.report.status).toBe('accepted')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(shown.worker?.state).toBe('succeeded')
  expect(shown.dispatch.status).toBe('completed')
  const fleet = await h.callAs<WorkerListResult>(h.coordinator.id, 'worker-list', ['--run', run.id, '--terminal-state', 'reclaimable'])
  expect(fleet.workers.map((row) => row.dispatchId)).toContain(receipt.dispatchId)
  const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  expect(released.state).toBe('released')
  expect(released.processAction).toBe('closed_agent_terminal')
  expect(await h.ptyAlive(session)).toBe(false)
  expect((await h.session(h.coordinator.id)).status).not.toBe('exited')
  const archived = await h.callAs<WorkerReadResult>(h.coordinator.id, 'worker-read', ['--dispatch', receipt.dispatchId])
  expect(archived.archived).toBe(true)
  expect(archived.content).toContain('Working')
  const again = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  expect(again.processAction).toBe('none')
}, 90_000)

test('stop fences the actual attempt, explicit retry preserves lineage, and abandon never closes its replacement', async () => {
  const { h } = await startRun()
  const first = await startWorker(h)
  const stopped = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-stop', ['--dispatch', first.receipt.dispatchId])
  expect(stopped.state).toBe('stopped')
  expect(await h.ptyAlive(first.session)).toBe(false)
  const retry = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', ['--task', first.receipt.taskId, '--retry-of', first.receipt.dispatchId, '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '3000'])
  expect(retry.state).toBe('ready')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: retry.dispatchId }) as WorkerShowResult
  expect(shown.dispatch.retryOfDispatchId).toBe(first.receipt.dispatchId)
  const abandoned = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-abandon', ['--dispatch', retry.dispatchId])
  expect(abandoned.state).toBe('abandoned')
  expect(abandoned.processAction).toBe('none')
  expect((await h.session(shown.worker!.sessionId!)).status).not.toBe('exited')
  const retained = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', retry.dispatchId])
  expect(retained.state).toBe('retained')
  expect(retained.processAction).toBe('none')
}, 90_000)

test('explicit takeover retains the actual settled worker, never an unrelated terminal', async () => {
  const { h } = await startRun()
  const worker = await startWorker(h)
  const identity = await h.fixture.call('quirky.session/identity', { session: worker.session }) as { processIncarnation: string }
  const takeover = await h.fixture.call('quirky.terminal/userInput', { session: worker.session, expectedIncarnation: identity.processIncarnation }) as { ok: boolean }
  expect(takeover.ok).toBe(true)
  await report(h, worker.session, worker.receipt)
  const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', worker.receipt.dispatchId])
  expect(released.state).toBe('retained')
  expect(released.processAction).toBe('none')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: worker.receipt.dispatchId }) as WorkerShowResult
  expect(shown.terminalResource?.ownershipState).toBe('user_owned')
  expect(shown.terminalResource?.retainedReason).toBe('user_takeover')
  expect((await h.session(worker.session)).status).not.toBe('exited')
}, 60_000)

test('invalid start and coordinator-terminal injection refuse without creating a Task or worker', async () => {
  const { h, run } = await startRun()
  const before = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
  const invalid = await h.cli(h.coordinator.id, ['orchestration', 'worker-start', '--task', 'task_nonexistent', '--spec', 'Conflicting source', '--agent', 'claude', '--worktree', 'current'])
  expect(invalid.code).toBe(1)
  const self = await h.cli(h.coordinator.id, ['orchestration', 'worker-start', '--spec', 'Must not type into coordinator', '--terminal', h.coordinator.id, '--worktree', 'current'])
  expect(self.code).toBe(1)
  const after = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
  expect(after.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id))
  expect((await h.session(h.coordinator.id)).status).not.toBe('exited')
}, 60_000)

test('low-level dry run has no effects and context-only release never closes the attached agent', async () => {
  const { h } = await startRun()
  const task = await h.callAs<MutationResult<{ task: TaskRow }>>(h.coordinator.id, 'task-create', ['--spec', 'Context-only task'])
  const target = await h.fixture.call('quirky.session/create', { worktree: `path:${h.fixture.repo}`, agent: 'claude', title: 'External target' }) as { id: string }
  await eventually(() => h.events(target.id), (events) => events.some((event) => event.type === 'started'), 'external target provider process')
  const preview = await h.callAs<{ dryRun: boolean; dispatch: null }>(h.coordinator.id, 'dispatch', ['--task', task.task.id, '--to', target.id, '--dry-run'])
  expect(preview.dryRun).toBe(true)
  expect(preview.dispatch).toBeNull()
  const dispatch = await h.callAs<MutationResult<{ dispatch: { id: string } }>>(h.coordinator.id, 'dispatch', ['--task', task.task.id, '--to', target.id])
  const abandoned = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-abandon', ['--dispatch', dispatch.dispatch.id])
  expect(abandoned.processAction).toBe('none')
  expect((await h.session(target.id)).status).not.toBe('exited')
  const inspected = await h.callAs<{ dispatch: { id: string }; worker: null }>(h.coordinator.id, 'dispatch-show', ['--task', task.task.id])
  expect(inspected.dispatch.id).toBe(dispatch.dispatch.id)
  expect(inspected.worker).toBeNull()
}, 60_000)

test('fleet continuation stays on its captured Run snapshot while another worker is inserted', async () => {
  const { h, run } = await startRun()
  const first = await startWorker(h, 'First fleet worker')
  const second = await startWorker(h, 'Second fleet worker')
  const initial = await h.callAs<WorkerListResult>(h.coordinator.id, 'worker-list', ['--run', run.id, '--limit', '1'])
  expect(initial.workers).toHaveLength(1)
  expect(initial.page.nextCursor).not.toBeNull()
  const late = await startWorker(h, 'Worker added after snapshot capture')
  const next = await h.callAs<WorkerListResult>(h.coordinator.id, 'worker-list', ['--run', run.id, '--limit', '1', '--cursor', initial.page.nextCursor!])
  const captured = [...initial.workers, ...next.workers].map((row) => row.dispatchId).sort()
  expect(captured).toEqual([first.receipt.dispatchId, second.receipt.dispatchId].sort())
  expect(captured).not.toContain(late.receipt.dispatchId)
  expect(next.page.nextCursor).toBeNull()
}, 90_000)

test('a deferred native structured worker starts one turn and reports through its real CLI tool environment', async () => {
  const { h } = await startRun()
  const flags = ['--spec', '[hold] Native worker holds until its exact CLI report.', '--task-title', 'Native worker', '--worktree', 'current', '--agent', 'codex', '--mode', 'structured', '--model', 'gpt-5.6-luna', '--effort', 'high', '--timeout-ms', '3000']
  const receipt = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', flags)
  expect(receipt.state).toBe('ready')
  expect(receipt.mode.mode).toBe('structured')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  const session = shown.worker!.sessionId!
  expect((await h.session(session)).kind).toBe('structured')
  await eventually(() => h.events(session), (events) => events.some((event) => event.type === 'started'), 'real native provider process with its launch environment')
  const replayed = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', [...flags, '--retry-request', receipt.mutation.requestId])
  expect(replayed.mutation.replayed).toBe(true)
  expect(replayed.dispatchId).toBe(receipt.dispatchId)
  const nativeTurns = h.native.requests().filter((request) => request.method === 'turn/start')
  expect(nativeTurns).toHaveLength(1)
  expect(h.native.requests().find((request) => request.method === 'thread/start')?.params?.model).toBe('gpt-5.6-luna')
  expect(nativeTurns[0]?.params?.model).toBe('gpt-5.6-luna')
  expect(nativeTurns[0]?.params?.effort).toBe('high')
  const completed = await report(h, session, receipt)
  expect(completed.report.status).toBe('accepted')
  const read = await h.callAs<WorkerReadResult>(h.coordinator.id, 'worker-read', ['--dispatch', receipt.dispatchId])
  expect(read.source).toBe('structured')
  expect(read.content).toContain('Native worker holds until its exact CLI report.')
  const released = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  expect(released.state).toBe('released')
  expect(released.processAction).toBe('closed_agent_terminal')
  const archived = await h.callAs<WorkerReadResult>(h.coordinator.id, 'worker-read', ['--dispatch', receipt.dispatchId])
  expect(archived.archived).toBe(true)
  expect(archived.content).toContain('Native worker holds until its exact CLI report.')
}, 90_000)

test('a certified unexpected worker exit records its cause and wakes the coordinator with an escalation', async () => {
  const { h, run } = await startRun()
  const worker = await startWorker(h)
  const started = h.events(worker.session).find((event) => event.type === 'started')
  if (!started || typeof started.pid !== 'number') throw new Error('the isolated worker has no owned process receipt')
  const before = await h.fixture.call('quirky.session/identity', { session: worker.session }) as { sessionId: string; processIncarnation: string; live: boolean }
  expect(before.sessionId).toBe(worker.session)
  expect(before.live).toBe(true)
  expect(before.processIncarnation).toBe(worker.shown.terminalResource?.processIncarnation)
  process.kill(started.pid, 'SIGKILL')
  const failed = await eventually(
    () => h.fixture.call('quirky.orchestration/workerShow', { dispatchId: worker.receipt.dispatchId }) as Promise<WorkerShowResult>,
    (shown) => shown.worker?.stage === 'process_exited',
    'exact worker exit lifecycle settlement'
  )
  expect(failed.worker?.state).toBe('failed')
  expect(failed.dispatch.terminationReason).toBe('signaled')
  expect(failed.projection.liveness.status).toBe('exited')
  const delivery = await h.callAs<{ messages: MessageRow[]; deliveryId: string }>(h.coordinator.id, 'check', ['--types', 'escalation', '--wait', '--timeout-ms', '3000'])
  expect(delivery.messages).toContainEqual(expect.objectContaining({
    type: 'escalation',
    priority: 'high',
    payload: expect.objectContaining({ taskId: worker.receipt.taskId, dispatchId: worker.receipt.dispatchId, exitCause: 'signaled', handle: worker.session })
  }))
  const tasks = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
  expect(tasks.tasks.find((task) => task.id === worker.receipt.taskId)?.status).toBe('ready')
  const retained = await h.callAs<MutationResult<WorkerControlResult>>(h.coordinator.id, 'worker-retain', ['--dispatch', worker.receipt.dispatchId])
  expect(retained.state).toBe('retained')
  await h.callAs(h.coordinator.id, 'check', ['--ack', delivery.deliveryId])
}, 90_000)

test('an explicit failed worker report settles without consuming infrastructure retry budget', async () => {
  const { h, run } = await startRun()
  const worker = await startWorker(h, 'Report an explicit task failure.')
  const completion = await report(h, worker.session, worker.receipt, 'failed')
  expect(completion.report.status).toBe('accepted')
  const failed = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: worker.receipt.dispatchId }) as WorkerShowResult
  expect(failed.worker?.state).toBe('failed')
  expect(failed.dispatch.status).toBe('failed')
  expect(failed.dispatch.failureCount).toBe(0)
  const tasks = await h.callAs<{ tasks: TaskRow[] }>(h.coordinator.id, 'task-list', ['--run', run.id])
  expect(tasks.tasks.find((task) => task.id === worker.receipt.taskId)?.result).toMatchObject({ kind: 'worker_report', outcome: 'failed', dispatchId: worker.receipt.dispatchId })
  const retry = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', ['--task', worker.receipt.taskId, '--retry-of', worker.receipt.dispatchId, '--worktree', 'current', '--agent', 'claude', '--timeout-ms', '3000'])
  expect(retry.state).toBe('ready')
  const retried = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: retry.dispatchId }) as WorkerShowResult
  expect(retried.dispatch.retryOfDispatchId).toBe(worker.receipt.dispatchId)
  expect(retried.dispatch.failureCount).toBe(0)
  expect(await h.ptyAlive(worker.session)).toBe(false)
  await h.callAs(h.coordinator.id, 'worker-abandon', ['--dispatch', retry.dispatchId])
}, 90_000)
