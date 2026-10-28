import { afterEach, expect, test } from 'bun:test'
import type { MutationResult, RunRow, TaskRow, DispatchRow } from '../src/contracts'
import type { WorkerReadResult, WorkerShowResult, WorkerStartReceipt } from '../src/worker-contracts'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from './workers/acceptance-support'
import { createHomeRun, pairDaemons, startRemote } from './federation-surface-support'

let harness: WorkerAcceptance | undefined
afterEach(async () => { await harness?.cleanup(); harness = undefined })

test('task-terminal resolves context-only assignment and refuses an old task after the terminal is reassigned', async () => {
  const h = harness = await startWorkerAcceptance()
  await h.callAs<MutationResult<{ run: RunRow }>>(h.coordinator.id, 'run-create', ['--objective', 'Public task navigation'])
  const task = await h.callAs<MutationResult<{ task: TaskRow }>>(h.coordinator.id, 'task-create', ['--spec', 'Context-only navigable task'])
  const target = await h.fixture.call('quirky.session/create', { worktree: `path:${h.fixture.repo}`, agent: 'claude', title: 'Context-only target' }) as { id: string; worktreeId: string }
  await eventually(() => h.events(target.id), events => events.some(event => event.type === 'started'), 'target provider process')
  const assigned = await h.callAs<MutationResult<{ dispatch: DispatchRow }>>(h.coordinator.id, 'dispatch', ['--task', task.task.id, '--to', target.id])
  const result = await h.fixture.cli(['orchestration', 'task-terminal', '--task-id', task.task.id, '--json'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ taskId: task.task.id, dispatchId: assigned.dispatch.id, sessionId: target.id, worktreeId: target.worktreeId })
  await h.callAs<unknown>(h.coordinator.id, 'task-update', ['--id', task.task.id, '--status', 'completed'])
  const next = await h.callAs<MutationResult<{ task: TaskRow }>>(h.coordinator.id, 'task-create', ['--spec', 'New owner of same terminal'])
  await h.callAs<unknown>(h.coordinator.id, 'dispatch', ['--task', next.task.id, '--to', target.id])
  await expect(h.fixture.call('quirky.orchestration/taskTerminal', { taskId: task.task.id })).rejects.toMatchObject({ data: { reason: 'worker_identity_changed' } })
  expect(await h.ptyAlive(target.id)).toBe(true)
}, 90_000)

test('task-terminal resolves a live supervised worker and rejects its released terminal', async () => {
  const h = harness = await startWorkerAcceptance()
  await h.callAs<unknown>(h.coordinator.id, 'run-create', ['--objective', 'Supervised task navigation'])
  const receipt = await h.callAs<MutationResult<WorkerStartReceipt>>(h.coordinator.id, 'worker-start', ['--spec', 'Remain available for navigation', '--agent', 'claude', '--worktree', 'current', '--timeout-ms', '3000'])
  expect(receipt.state).toBe('ready')
  const shown = await h.fixture.call('quirky.orchestration/workerShow', { dispatchId: receipt.dispatchId }) as WorkerShowResult
  expect(await h.fixture.call('quirky.orchestration/taskTerminal', { taskId: receipt.taskId })).toEqual({ taskId: receipt.taskId, dispatchId: receipt.dispatchId, sessionId: shown.worker?.sessionId, worktreeId: shown.worker?.worktreeId })
  await h.callAs<unknown>(shown.worker!.sessionId!, 'send', ['--type', 'worker_done', '--task-id', receipt.taskId, '--dispatch-id', receipt.dispatchId, '--outcome', 'succeeded', '--subject', 'Navigation done', '--body', 'Finished the navigation proof.'])
  await h.callAs<unknown>(h.coordinator.id, 'worker-release', ['--dispatch', receipt.dispatchId])
  await expect(h.fixture.call('quirky.orchestration/taskTerminal', { taskId: receipt.taskId })).rejects.toMatchObject({ data: { reason: 'terminal_not_found' } })
  const empty = await h.callAs<MutationResult<{ task: TaskRow }>>(h.coordinator.id, 'task-create', ['--spec', 'No dispatch yet'])
  await expect(h.fixture.call('quirky.orchestration/taskTerminal', { taskId: empty.task.id })).rejects.toMatchObject({ data: { reason: 'terminal_not_found' } })
}, 90_000)

test('task-terminal routes a remote Dispatch to its read-only output view instead of a local terminal', async () => {
  const paired = await pairDaemons()
  try {
    await createHomeRun(paired)
    const receipt = await startRemote(paired, 'Remain available for remote output navigation.')
    const target = await paired.home.fixture.call('quirky.orchestration/taskTerminal', { taskId: receipt.taskId }) as {
      kind: string; taskId: string; dispatchId: string; viewId: string; input: { dispatchId: string }
    }

    expect(target).toEqual({
      kind: 'remote_output',
      taskId: receipt.taskId,
      dispatchId: receipt.dispatchId,
      viewId: 'view:quirky.orchestration/remote-worker-output',
      input: { dispatchId: receipt.dispatchId }
    })
    const output = await paired.home.fixture.call('quirky.orchestration/workerRead', {
      dispatchId: target.input.dispatchId, source: 'terminal'
    }) as WorkerReadResult
    expect(output.dispatchId).toBe(receipt.dispatchId)
    expect(output.sourceExact).toBe(true)
    expect(output.remote).toMatchObject({ peerId: paired.peerId, hostDispatchId: expect.any(String) })
    expect((await paired.home.fixture.call('quirky.session/list', {}) as Array<{ id: string }>).map(({ id }) => id))
      .not.toContain(output.sessionId)
  } finally {
    await paired.cleanup()
  }
}, 120_000)
