import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HOOK_TOKEN_HEADER } from '@quirky/protocol'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type {
  AskResult,
  CheckResult,
  DispatchRow,
  GateRow,
  InboxResult,
  MessageRow,
  RequestShowResult,
  RunRow,
  SendResult,
  TaskRow
} from '../src/contracts'
import {
  call,
  expectReason,
  mutation,
  startOrchestrationFixture,
  type OrchestrationFixture,
  type OrchestrationParty
} from './fixture'

const RUN = 'quirky.orchestration/runCreate'
const RUN_USE = 'quirky.orchestration/runUse'
const RUN_CURRENT = 'quirky.orchestration/runCurrent'
const RUN_LIST = 'quirky.orchestration/runList'
const RUN_SHOW = 'quirky.orchestration/runShow'
const TASK_CREATE = 'quirky.orchestration/taskCreate'
const TASK_LIST = 'quirky.orchestration/taskList'
const TASK_UPDATE = 'quirky.orchestration/taskUpdate'
const DISPATCH = 'quirky.orchestration/dispatch'
const DISPATCH_SHOW = 'quirky.orchestration/dispatchShow'
const SEND = 'quirky.orchestration/send'
const CHECK = 'quirky.orchestration/check'
const REPLY = 'quirky.orchestration/reply'
const INBOX = 'quirky.orchestration/inbox'
const ASK = 'quirky.orchestration/ask'
const GATE_CREATE = 'quirky.orchestration/gateCreate'
const GATE_RESOLVE = 'quirky.orchestration/gateResolve'
const GATE_LIST = 'quirky.orchestration/gateList'
const REQUEST_SHOW = 'quirky.orchestration/requestShow'
const RESET = 'quirky.orchestration/reset'

type MutationMarker = { requestId: string; replayed: boolean }
type RunMutation = { run: RunRow; mutation: MutationMarker }
type TaskMutation = { task: TaskRow; mutation: MutationMarker }
type TaskUpdateResult = { task: TaskRow; unchanged: boolean; mutation: MutationMarker }
type DispatchResult = { dryRun: false; dispatch: DispatchRow; mutation: MutationMarker }
type ConsumeResult = Extract<CheckResult, { mode: 'consume' }>
type GateMutation = { gate: GateRow; task: TaskRow; mutation: MutationMarker }

let fixture: OrchestrationFixture
beforeEach(async () => {
  fixture = await startOrchestrationFixture()
})
afterEach(async () => {
  await fixture?.cleanup()
  fixture = undefined!
})

const createRun = async (party: OrchestrationParty, objective = 'test objective', requestId?: string) =>
  call<RunMutation>(party, RUN, { ...mutation(requestId), objective })

const createTask = async (
  party: OrchestrationParty,
  runId: string,
  spec: string,
  extra: Record<string, unknown> = {}
) => call<TaskMutation>(party, TASK_CREATE, { ...mutation(), runId, spec, ...extra })

const createDispatch = async (party: OrchestrationParty, runId: string, taskId: string, to: string) =>
  call<DispatchResult>(party, DISPATCH, { ...mutation(), runId, taskId, to })

const send = async (party: OrchestrationParty, fields: Record<string, unknown>) =>
  call<SendResult>(party, SEND, { ...mutation(), subject: 'test message', ...fields })

const consume = async (party: OrchestrationParty, fields: Record<string, unknown> = {}) =>
  call<ConsumeResult>(party, CHECK, { ...mutation(), mode: 'consume', ...fields })

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  let error: unknown
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  expect(error).toBeDefined()
  return error
}
async function waitForAcceptedRequest(party: OrchestrationParty, requestId: string) {
  return waitForAsync(async () => {
    const receipt = await call<{
      state: string
      receipt?: { checkpoint?: { state?: string; messageId?: string } }
    }>(party, REQUEST_SHOW, { requestId })
    return receipt.receipt?.checkpoint?.state === 'accepted' ? receipt : undefined
  }, 5000)
}
async function markIdle(party: OrchestrationParty): Promise<{ state: string }> {
  const endpoint = new URL(`http://127.0.0.1:${fixture.harness.runtime.port}/hook/claude`)
  endpoint.searchParams.set('session', party.id)
  endpoint.searchParams.set('event', 'Stop')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      [HOOK_TOKEN_HEADER]: fixture.harness.runtime.hookToken,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ hook_event_name: 'Stop' })
  })
  expect(response.status).toBe(200)
  return waitForAsync(async () => {
    const status = await call<{ state: string }>(party, 'quirky.agent-status/explain', { session: party.id })
    return status.state === 'idle' ? status : undefined
  }, 5000)
}

type ReceiptSeed = { requestId: string; state: 'pending' | 'completed'; createdAt: string }

function seedReceipts(path: string, callerFingerprint: string, rows: readonly ReceiptSeed[]): void {
  const database = new Database(path)
  try {
    const insert = database.prepare(`
      INSERT INTO mutation_receipts
        (caller_fingerprint, request_id, method, payload_hash, state, checkpoint_json, result_json, created_at, updated_at)
      VALUES (?, ?, 'runCreate', ?, ?, NULL, ?, ?, ?)
    `)
    database.transaction(() => {
      for (const row of rows) {
        insert.run(
          callerFingerprint,
          row.requestId,
          '0'.repeat(64),
          row.state,
          row.state === 'completed' ? JSON.stringify({ run: { id: 'run_fixture' }, mutation: { requestId: row.requestId, replayed: false } }) : null,
          row.createdAt,
          row.createdAt
        )
      }
    })()
  } finally {
    database.close()
  }
}

async function primeReceiptCallerFingerprint(party: OrchestrationParty, path: string): Promise<string> {
  const primer = await consume(party)
  expect(primer.messages).toHaveLength(0)
  const database = new Database(path)
  try {
    const receipt = database.prepare(
      'SELECT caller_fingerprint FROM mutation_receipts WHERE request_id = ?'
    ).get(primer.mutation.requestId) as { caller_fingerprint: string } | null | undefined
    if (receipt === undefined || receipt === null) throw new Error('the safe consume mutation did not create a receipt')
    database.prepare('DELETE FROM mutation_receipts WHERE request_id = ?').run(primer.mutation.requestId)
    return receipt.caller_fingerprint
  } finally {
    database.close()
  }
}
describe('quirky.orchestration daemon API acceptance', () => {
  test('AC1 binds, transfers and inspects Runs without letting inspection change ownership', async () => {
    const coordinator = await fixture.createParty('coordinator-c')
    const nextCoordinator = await fixture.createParty('coordinator-d')
    const first = await createRun(coordinator, 'first run')
    const firstGeneration = first.run.consumerGeneration

    await send(coordinator, {
      to: { kind: 'run', runId: first.run.id },
      type: 'status',
      subject: 'pre-transfer mail',
      body: 'unread before takeover'
    })
    const oldDelivery = await consume(coordinator)
    expect(oldDelivery.deliveryId).not.toBeNull()

    const second = await createRun(coordinator, 'second run')
    expect(second.run.coordinatorSessionId).toBe(coordinator.id)
    const transfer = await call<RunMutation>(nextCoordinator, RUN_USE, {
      ...mutation(),
      runId: first.run.id
    })
    expect(transfer.run.coordinatorSessionId).toBe(nextCoordinator.id)
    expect(transfer.run.consumerGeneration).toBeGreaterThan(firstGeneration)
    expect(transfer.run.coordinatorHistory).toContain(coordinator.id)

    const oldAck = await expectReason(consume(nextCoordinator, { ackDeliveryId: oldDelivery.deliveryId }), 'consumer_fenced')
    expect(oldAck).toBeDefined()
    const coordinatorCurrent = await call<{ run: RunRow | null }>(coordinator, RUN_CURRENT)
    const nextCurrent = await call<{ run: RunRow | null }>(nextCoordinator, RUN_CURRENT)
    expect(coordinatorCurrent.run?.id).toBe(second.run.id)
    expect(nextCurrent.run?.id).toBe(first.run.id)

    const inspected = await call<{ run: RunRow }>(coordinator, RUN_SHOW, { runId: first.run.id })
    expect(inspected.run.coordinatorSessionId).toBe(nextCoordinator.id)
    expect((await call<{ run: RunRow | null }>(coordinator, RUN_CURRENT)).run?.id).toBe(second.run.id)

    const firstPage = await call<{ runs: RunRow[]; nextCursor: string | null }>(coordinator, RUN_LIST, { limit: 1 })
    expect(firstPage.runs.map((run) => run.id)).toEqual([second.run.id])
    expect(firstPage.nextCursor).toBeTruthy()
    const secondPage = await call<{ runs: RunRow[]; nextCursor: string | null }>(coordinator, RUN_LIST, {
      limit: 1,
      cursor: firstPage.nextCursor!
    })
    expect(secondPage.runs.map((run) => run.id)).toEqual([first.run.id])
    expect(secondPage.nextCursor).toBeNull()
    await expectReason(call(coordinator, RUN_SHOW, { runId: 'run_000000000000' }), 'run_not_found')
    await expectReason(call(nextCoordinator, RUN_USE, { ...mutation(), runId: 'run_unbound' }), 'run_not_found')
  }, 30_000)

  test('AC1 declared session aliases never grant a different caller authority', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const caller = await fixture.createParty('caller')
    const owned = await createRun(coordinator, 'owned run')

    await expectReason(call(caller, RUN, { ...mutation(), objective: 'forged run', from: coordinator.id }), 'consumer_fenced')
    expect((await call<{ run: RunRow | null }>(coordinator, RUN_CURRENT)).run?.id).toBe(owned.run.id)
    expect((await call<{ run: RunRow | null }>(caller, RUN_CURRENT)).run).toBeNull()
  }, 30_000)

  test('AC2 creates a dependency DAG atomically, promotes only completed dependencies, and bounds display fields', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const { run } = await createRun(coordinator, 'DAG')
    const longSpec = 'specification '.repeat(24)
    const longTitle = '  repeated   task title '.repeat(8)
    const longDisplay = '  readable   label '.repeat(18)
    const a = await createTask(coordinator, run.id, longSpec, { taskTitle: longTitle, displayName: longDisplay })
    const b = await createTask(coordinator, run.id, 'dependent B', { dependencyTaskIds: [a.task.id] })
    const failed = await createTask(coordinator, run.id, 'dependency that fails')
    const remainsPending = await createTask(coordinator, run.id, 'must remain pending', {
      dependencyTaskIds: [failed.task.id]
    })

    expect(a.task.status).toBe('ready')
    expect(a.task.taskTitle).toHaveLength(80)
    expect(a.task.taskTitle.endsWith('...')).toBe(true)
    expect(a.task.taskTitle).not.toMatch(/\s{2,}/)
    expect(a.task.displayName).toHaveLength(160)
    expect(a.task.displayName.endsWith('...')).toBe(true)
    expect(b.task.status).toBe('pending')
    await Promise.allSettled([call(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: b.task.id,
      dependencyTaskIds: []
    })])
    const immutableB = await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: false })
    expect(immutableB.tasks.find((task) => task.id === b.task.id)?.dependencyTaskIds).toEqual([a.task.id])

    const completed = await call<TaskUpdateResult>(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: a.task.id,
      status: 'completed',
      result: 'A completed'
    })
    expect(completed.task.status).toBe('completed')
    const ready = await call<{ tasks: TaskRow[]; count: number }>(coordinator, TASK_LIST, { runId: run.id, ready: true })
    expect(ready.tasks.map((task) => task.id)).toContain(b.task.id)
    expect(ready.tasks.map((task) => task.id)).not.toContain(a.task.id)

    await call<TaskUpdateResult>(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: failed.task.id,
      status: 'failed',
      result: 'dependency failed'
    })
    const pending = await call<{ tasks: TaskRow[]; count: number }>(coordinator, TASK_LIST, {
      runId: run.id,
      status: 'pending'
    })
    expect(pending.tasks.map((task) => task.id)).toContain(remainsPending.task.id)

    const secondCoordinator = await fixture.createParty('other-coordinator')
    const runTwo = await createRun(secondCoordinator, 'other run')
    const foreign = await createTask(secondCoordinator, runTwo.run.id, 'foreign dependency')
    const before = (await call<{ tasks: TaskRow[]; count: number }>(coordinator, TASK_LIST, {
      runId: run.id,
      ready: false
    })).count
    const invalidReferences = [
      { dependencyTaskIds: ['task_000000000000'] },
      { parentTaskId: 'task_000000000000' },
      { dependencyTaskIds: [foreign.task.id] },
      { parentTaskId: foreign.task.id }
    ]
    for (const reference of invalidReferences) {
      await expectReason(createTask(coordinator, run.id, 'invalid edge must roll back', reference), 'task_not_found')
      const after = await call<{ count: number }>(coordinator, TASK_LIST, { runId: run.id, ready: false })
      expect(after.count).toBe(before)
    }

    const briefs = await call<{ tasks: (TaskRow & { specTruncated?: true })[] }>(coordinator, TASK_LIST, {
      runId: run.id,
      brief: true,
      ready: false
    })
    const briefA = briefs.tasks.find((task) => task.id === a.task.id)!
    expect(briefA.spec).toHaveLength(160)
    expect(briefA.specTruncated).toBe(true)
  }, 30_000)

  test('AC3 no-op and invalid Task transitions preserve active-attempt invariants', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await createRun(coordinator, 'task updates')
    const active = await createTask(coordinator, run.id, 'active Task')
    const unrelated = await createTask(coordinator, run.id, 'ready Task')
    const dependent = await createTask(coordinator, run.id, 'after active', { dependencyTaskIds: [active.task.id] })

    const noOp = await call<TaskUpdateResult>(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: unrelated.task.id
    })
    expect(noOp.unchanged).toBe(true)
    expect(noOp.task.status).toBe('ready')

    const dry = await call<{ dryRun: true; dispatch: null }>(coordinator, DISPATCH, {
      runId: run.id,
      taskId: active.task.id,
      to: worker.id,
      dryRun: true
    })
    expect(dry.dispatch).toBeNull()
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: true })).tasks.map((t) => t.id)).toContain(active.task.id)

    const dispatch = await createDispatch(coordinator, run.id, active.task.id, worker.id)
    const askRequest = mutation()
    const pendingQuestion = call<AskResult>(worker, ASK, {
      ...askRequest,
      mode: 'question',
      question: 'settle this with the Task',
      timeoutMs: 1000
    })
    const accepted = await waitForAcceptedRequest(worker, askRequest.requestId)
    expect(accepted.receipt?.checkpoint?.messageId).toBeTruthy()
    await expectReason(call(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: active.task.id,
      status: 'ready'
    }), 'task_not_startable')
    await expectReason(call(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: unrelated.task.id,
      status: 'dispatched'
    }), 'task_not_startable')
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, status: 'dispatched' })).tasks.map((t) => t.id)).toEqual([active.task.id])

    const settled = await call<TaskUpdateResult>(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: active.task.id,
      status: 'completed',
      result: 'coordinator completion'
    })
    expect(settled.task.status).toBe('completed')
    const attempt = await call<{ dispatch: DispatchRow | null; worker: unknown }>(coordinator, DISPATCH_SHOW, {
      taskId: active.task.id
    })
    expect(attempt.dispatch?.status).toBe('completed')
    expect(attempt.worker).toBeNull()
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: true })).tasks.map((t) => t.id)).toContain(dependent.task.id)
    expect((await pendingQuestion).state).toBe('cancelled')

    const failed = await createTask(coordinator, run.id, 'failed context attempt')
    const pendingChild = await createTask(coordinator, run.id, 'wait for failed Task', {
      dependencyTaskIds: [failed.task.id]
    })
    const failedDispatch = await createDispatch(coordinator, run.id, failed.task.id, worker.id)
    const failureAskRequest = mutation()
    const pendingOnFailure = call<AskResult>(worker, ASK, {
      ...failureAskRequest,
      mode: 'question',
      question: 'close this on failure',
      timeoutMs: 1000
    })
    await waitForAcceptedRequest(worker, failureAskRequest.requestId)
    const failureUpdate = await call<TaskUpdateResult>(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: failed.task.id,
      status: 'failed',
      result: 'coordinator failed this context attempt'
    })
    expect(failureUpdate.task.status).toBe('failed')
    expect((await pendingOnFailure).state).toBe('cancelled')
    expect((await call<{ dispatch: DispatchRow | null }>(coordinator, DISPATCH_SHOW, { taskId: failed.task.id })).dispatch?.status).toBe('failed')
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, status: 'pending' })).tasks.map((task) => task.id)).toContain(pendingChild.task.id)
    expect(failedDispatch.dispatch.taskId).toBe(failed.task.id)
  }, 30_000)

  test('AC4 low-level Dispatch admission is atomic under active-assignee contention', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await createRun(coordinator, 'attempt admission')
    const taskCountBeforeOversize = (await call<{ count: number }>(coordinator, TASK_LIST, { runId: run.id, ready: false })).count
    await expectReason(createTask(coordinator, run.id, 'x'.repeat(1_214_465)), 'invalid_argument')
    expect((await call<{ count: number }>(coordinator, TASK_LIST, { runId: run.id, ready: false })).count).toBe(taskCountBeforeOversize)
    const first = await createTask(coordinator, run.id, 'first')
    const second = await createTask(coordinator, run.id, 'second')

    const beforeInputs = fixture.harness.pty.inputs.length
    await call(coordinator, DISPATCH, { runId: run.id, taskId: first.task.id, to: worker.id, dryRun: true })
    expect(fixture.harness.pty.inputs).toHaveLength(beforeInputs)
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: true })).tasks.map((t) => t.id)).toEqual([first.task.id, second.task.id])

    const attempt = await createDispatch(coordinator, run.id, first.task.id, worker.id)
    await expectReason(createDispatch(coordinator, run.id, second.task.id, worker.id), 'task_not_startable')
    await expectReason(createDispatch(coordinator, run.id, first.task.id, worker.id), 'task_not_startable')
    const rows = await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: false })
    expect(rows.tasks.find((task) => task.id === first.task.id)?.status).toBe('dispatched')
    expect(rows.tasks.find((task) => task.id === second.task.id)?.status).toBe('ready')
    const projection = await call<{ dispatch: DispatchRow | null; worker: unknown }>(coordinator, DISPATCH_SHOW, { taskId: first.task.id })
    expect(projection.dispatch?.id).toBe(attempt.dispatch.id)
    expect(projection.dispatch?.assigneeSessionId).toBe(worker.id)
    expect(projection.worker).toBeNull()
    const nestedRun = await createRun(worker, 'a new Run does not reset active depth')
    const nestedTask = await createTask(worker, nestedRun.run.id, 'nested attempt')
    await expectReason(
      createDispatch(worker, nestedRun.run.id, nestedTask.task.id, coordinator.id),
      'nested_worker_depth_exceeded'
    )
  }, 30_000)

  test('AC5 context Dispatch reports require the exact assignee and do not disguise rejections', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const outsider = await fixture.createParty('outsider')
    const { run } = await createRun(coordinator, 'worker reports')
    const task = await createTask(coordinator, run.id, 'reported task')
    const dependent = await createTask(coordinator, run.id, 'promoted by report', { dependencyTaskIds: [task.task.id] })
    const dispatch = await createDispatch(coordinator, run.id, task.task.id, worker.id)

    const heartbeat = await send(worker, {
      to: { kind: 'run', runId: run.id },
      type: 'heartbeat',
      taskId: task.task.id,
      dispatchId: dispatch.dispatch.id,
      phase: 'working'
    })
    expect(heartbeat.kind).toBe('heartbeat')
    if (heartbeat.kind !== 'heartbeat') throw new Error('expected a heartbeat result')
    expect(heartbeat.heartbeat.status).toBe('accepted')

    const escalation = await send(worker, {
      to: { kind: 'run', runId: run.id },
      type: 'escalation',
      subject: 'needs attention',
      body: 'mail only'
    })
    expect(escalation.kind).toBe('message')
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, status: 'dispatched' })).tasks.map((row) => row.id).includes(task.task.id)).toBe(true)
    expect((await call<{ gates: GateRow[] }>(coordinator, GATE_LIST, { runId: run.id })).gates).toHaveLength(0)

    const accepted = await send(worker, {
      to: { kind: 'run', runId: run.id },
      type: 'worker_done',
      taskId: task.task.id,
      dispatchId: dispatch.dispatch.id,
      outcome: 'succeeded',
      filesModified: ['src/a.ts'],
      subject: 'finished',
      body: 'completed successfully'
    })
    expect(accepted.kind).toBe('worker_report')
    if (accepted.kind !== 'worker_report') throw new Error('expected a worker report result')
    expect(accepted.report.status).toBe('accepted')
    if (accepted.report.status !== 'accepted') throw new Error('expected an accepted worker report')
    const acceptedTaskResult = accepted.report.task.result
    if (acceptedTaskResult?.kind !== 'worker_report') throw new Error('expected a worker report task result')
    expect(acceptedTaskResult).toMatchObject({ kind: 'worker_report', reportedBy: worker.id, outcome: 'succeeded' })
    expect(acceptedTaskResult.filesModified).toEqual(['src/a.ts'])

    const duplicate = await send(worker, {
      to: { kind: 'run', runId: run.id },
      type: 'worker_done',
      taskId: task.task.id,
      dispatchId: dispatch.dispatch.id,
      outcome: 'succeeded',
      filesModified: ['src/a.ts'],
      subject: 'finished',
      body: 'completed successfully'
    })
    expect(duplicate.kind).toBe('worker_report')
    if (duplicate.kind !== 'worker_report') throw new Error('expected a worker report result')
    expect(duplicate.report.status).toBe('duplicate')

    const promoted = await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: true })
    expect(promoted.tasks.map((row) => row.id)).toContain(dependent.task.id)
    const settled = await call<{ dispatch: DispatchRow | null }>(coordinator, DISPATCH_SHOW, { taskId: task.task.id })
    expect(settled.dispatch?.failureCount).toBe(0)
    const heartbeatAfterSettlement = await send(worker, {
      to: { kind: 'run', runId: run.id },
      type: 'heartbeat',
      taskId: task.task.id,
      dispatchId: dispatch.dispatch.id,
      phase: 'late'
    })
    expect(heartbeatAfterSettlement.kind).toBe('heartbeat')
    if (heartbeatAfterSettlement.kind !== 'heartbeat') throw new Error('expected a heartbeat result')
    expect(heartbeatAfterSettlement.heartbeat).toMatchObject({ status: 'rejected', lastHeartbeatAt: null })

    const wrongOwner = await createTask(coordinator, run.id, 'wrong owner report')
    const wrongDispatch = await createDispatch(coordinator, run.id, wrongOwner.task.id, worker.id)
    const rejectedReport = await send(outsider, {
      to: { kind: 'run', runId: run.id },
      type: 'worker_done',
      taskId: wrongOwner.task.id,
      dispatchId: wrongDispatch.dispatch.id,
      outcome: 'succeeded',
      subject: 'forged completion',
      body: 'not from the assignee'
    })
    expect(rejectedReport.kind).toBe('worker_report')
    if (rejectedReport.kind !== 'worker_report') throw new Error('expected an auditable worker report rejection')
    expect(rejectedReport.report).toEqual({ status: 'rejected', reason: 'sender_not_assignee', audited: true })
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, status: 'dispatched' })).tasks.map((row) => row.id)).toContain(wrongOwner.task.id)
    const reportedFailureTask = await createTask(coordinator, run.id, 'worker-reported failure')
    const reportedFailureDispatch = await createDispatch(coordinator, run.id, reportedFailureTask.task.id, outsider.id)
    const workerFailure = await send(outsider, {
      to: { kind: 'run', runId: run.id },
      type: 'worker_done',
      taskId: reportedFailureTask.task.id,
      dispatchId: reportedFailureDispatch.dispatch.id,
      outcome: 'failed',
      subject: 'worker failed',
      body: 'reported failure is not an infrastructure failure'
    })
    expect(workerFailure.kind).toBe('worker_report')
    if (workerFailure.kind !== 'worker_report') throw new Error('expected a worker report result')
    expect(workerFailure.report.status).toBe('accepted')
    if (workerFailure.report.status !== 'accepted') throw new Error('expected an accepted worker report')
    const failedAttempt = await call<{ dispatch: DispatchRow | null; worker: unknown }>(coordinator, DISPATCH_SHOW, {
      taskId: reportedFailureTask.task.id
    })
    expect(failedAttempt.dispatch).toMatchObject({ status: 'failed', failureCount: 0 })
    expect(failedAttempt.worker).toBeNull()
    const workerFailureTaskResult = workerFailure.report.task.result
    if (workerFailureTaskResult?.kind !== 'worker_report') throw new Error('expected a worker report task result')
    expect(workerFailureTaskResult).toMatchObject({ kind: 'worker_report', outcome: 'failed' })
  }, 30_000)

  test('AC6 routes direct, Run and Dispatch addresses and fans groups out once per eligible mailbox', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const other = await fixture.createParty('other')
    const provider = await fixture.createParty('provider', 'claude')
    const { run } = await createRun(coordinator, 'routing')
    const task = await createTask(coordinator, run.id, 'routed task')
    const dispatch = await createDispatch(coordinator, run.id, task.task.id, worker.id)
    const providerTask = await createTask(coordinator, run.id, 'provider mailbox target')
    const providerDispatch = await createDispatch(coordinator, run.id, providerTask.task.id, provider.id)

    const runMail = await send(coordinator, {
      to: { kind: 'run', runId: run.id },
      type: 'status',
      subject: 'Run route',
      body: 'run mailbox'
    })
    expect(runMail.kind).toBe('message')
    if (runMail.kind !== 'message') throw new Error('expected an ordinary message')
    expect(runMail.messages[0]?.mailbox).toEqual({ kind: 'run', runId: run.id })

    const dispatchMail = await send(coordinator, {
      to: { kind: 'dispatch', dispatchId: dispatch.dispatch.id },
      runId: run.id,
      type: 'status',
      subject: 'Dispatch route',
      body: 'dispatch mailbox'
    })
    expect(dispatchMail.kind).toBe('message')
    if (dispatchMail.kind !== 'message') throw new Error('expected a Dispatch-addressed message')
    expect(dispatchMail.messages[0]?.mailbox).toEqual({ kind: 'dispatch', dispatchId: dispatch.dispatch.id })

    const workerDefault = await send(worker, {
      type: 'status',
      subject: 'default destination',
      body: 'defaults to owning Run'
    })
    expect(workerDefault.kind).toBe('message')
    if (workerDefault.kind !== 'message') throw new Error('expected a default worker message')
    expect(workerDefault.messages[0]?.mailbox).toEqual({ kind: 'run', runId: run.id })

    const direct = await send(coordinator, {
      to: { kind: 'session', sessionId: other.id },
      runId: run.id,
      type: 'status',
      subject: 'direct address',
      body: 'direct mailbox'
    })
    expect(direct.kind).toBe('message')
    if (direct.kind !== 'message') throw new Error('expected a direct message')
    expect(direct.messages[0]?.mailbox).toEqual({ kind: 'session', sessionId: other.id })

    const all = await send(coordinator, {
      to: { kind: 'group', group: 'all' },
      runId: run.id,
      type: 'status',
      subject: 'group all',
      body: 'fan out'
    })
    expect(all.kind).toBe('message')
    if (all.kind !== 'message') throw new Error('expected group fan-out')
    const allMailboxes = all.messages.map((message) => JSON.stringify(message.mailbox))
    expect(new Set(allMailboxes).size).toBe(allMailboxes.length)
    expect(all.messages.every((message) => message.fromSessionId === coordinator.id)).toBe(true)
    expect(all.messages.some((message) => message.mailbox.kind === 'session' && message.mailbox.sessionId === coordinator.id)).toBe(false)
    expect(all.threadId).toBeTruthy()
    expect(new Set(all.messages.map((message) => message.threadId)).size).toBe(1)
    const workerGroup = await send(worker, {
      to: { kind: 'group', group: 'all' },
      runId: run.id,
      type: 'status',
      subject: 'worker group all',
      body: 'coordinator exclusion'
    })
    expect(workerGroup.kind).toBe('message')
    if (workerGroup.kind !== 'message') throw new Error('expected worker group fan-out')
    expect(workerGroup.messages.some((message) => message.mailbox.kind === 'session' && message.mailbox.sessionId === worker.id)).toBe(false)
    expect(workerGroup.messages.some((message) => message.mailbox.kind === 'run' && message.mailbox.runId === run.id)).toBe(false)

    const workspace = await send(coordinator, {
      to: { kind: 'group', group: 'worktree', worktreeId: worker.worktreeId },
      runId: run.id,
      type: 'status',
      subject: 'workspace group',
      body: 'same worktree'
    })
    expect(workspace.kind).toBe('message')
    if (workspace.kind !== 'message') throw new Error('expected workspace group result')
    expect(new Set(workspace.messages.map((message) => JSON.stringify(message.mailbox))).size).toBe(workspace.messages.length)

    const providerIdentity = await call<{ providerId: string | null }>(provider, 'quirky.session/identity', { session: provider.id })
    if (providerIdentity.providerId === null) throw new Error('Claude test session must publish its provider identity')
    const providerGroup = await send(coordinator, {
      to: { kind: 'group', group: 'provider', providerId: providerIdentity.providerId },
      runId: run.id,
      type: 'status',
      subject: 'matching provider group',
      body: 'provider-specific fanout'
    })
    expect(providerGroup.kind).toBe('message')
    if (providerGroup.kind !== 'message') throw new Error('expected provider group fan-out')
    expect(providerGroup.messages.map((message) => message.mailbox)).toEqual([{ kind: 'dispatch', dispatchId: providerDispatch.dispatch.id }])

    await markIdle(provider)
    const idleGroup = await send(coordinator, {
      to: { kind: 'group', group: 'idle' },
      runId: run.id,
      type: 'status',
      subject: 'matching idle group',
      body: 'idle-only fanout'
    })
    expect(idleGroup.kind).toBe('message')
    if (idleGroup.kind !== 'message') throw new Error('expected idle group fan-out')
    expect(idleGroup.messages.map((message) => message.mailbox)).toEqual([{ kind: 'dispatch', dispatchId: providerDispatch.dispatch.id }])
    await expectReason(send(coordinator, {
      to: { kind: 'group', group: 'provider', providerId: 'no-provider-shell' },
      runId: run.id,
      type: 'status',
      subject: 'empty provider group',
      body: 'no active Dispatch publishes this provider identity'
    }), 'terminal_not_found')

    const messagesBeforeRefusal = (await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })).messages.length
    await rejected(send(coordinator, {
      to: { kind: 'group', group: 'all' },
      runId: run.id,
      type: 'heartbeat',
      taskId: task.task.id,
      dispatchId: dispatch.dispatch.id,
      phase: 'forbidden group lifecycle'
    }))
    const messagesAfterRefusal = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    expect(messagesAfterRefusal.messages).toHaveLength(messagesBeforeRefusal)
    await expectReason(send(other, { type: 'status', subject: 'no active Run' }), 'run_required')
    const unboundMail = await send(other, {
      to: { kind: 'run', runId: 'run_unbound' },
      type: 'status',
      subject: 'unbound direct mail',
      body: 'mail-only unbound mailbox'
    })
    expect(unboundMail.kind).toBe('message')
    if (unboundMail.kind !== 'message') throw new Error('expected mail to the run_unbound namespace')
    expect(unboundMail.messages[0]?.mailbox).toEqual({ kind: 'run', runId: 'run_unbound' })

    await call(other, RUN_USE, { ...mutation(), runId: run.id })
    const historicAddress = await send(other, {
      to: { kind: 'session', sessionId: coordinator.id },
      runId: run.id,
      type: 'status',
      subject: 'historic coordinator address',
      body: 'the old address remains routable'
    })
    expect(historicAddress.kind).toBe('message')
    if (historicAddress.kind !== 'message') throw new Error('expected historical address delivery')
    expect(historicAddress.messages[0]?.mailbox).toEqual({ kind: 'run', runId: run.id })
    expect((await call<{ run: RunRow }>(other, RUN_SHOW, { runId: run.id })).run.coordinatorHistory).toContain(coordinator.id)
  }, 30_000)

  test('AC7 consumes a mixed FIFO batch of 50, replays until ack, then advances exactly once', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const { run } = await createRun(coordinator, 'FIFO')
    for (let index = 0; index < 51; index += 1) {
      await send(coordinator, {
        to: { kind: 'run', runId: run.id },
        type: index % 2 === 0 ? 'status' : 'question',
        subject: `fifo-${index}`,
        body: `body-${index}`
      })
    }

    const first = await consume(coordinator, { types: ['question'] })
    expect(first.messages).toHaveLength(50)
    expect(first.messages.map((message) => message.subject)).toEqual(Array.from({ length: 50 }, (_, index) => `fifo-${index}`))
    expect(new Set(first.messages.map((message) => message.type))).toEqual(new Set(['status', 'question']))
    expect(first.deliveryId).toBeTruthy()

    const replay = await consume(coordinator, { types: ['status'] })
    expect(replay.deliveryId).toBe(first.deliveryId)
    expect(replay.messages).toEqual(first.messages)
    const next = await consume(coordinator, { ackDeliveryId: first.deliveryId })
    expect(next.acknowledged).toBe(first.deliveryId)
    expect(next.messages.map((message) => message.subject)).toEqual(['fifo-50'])
    const repeatedAck = await consume(coordinator, { ackDeliveryId: first.deliveryId })
    expect(repeatedAck.acknowledged).toBe(first.deliveryId)
    expect(repeatedAck.messages.map((message) => message.subject)).toEqual(['fifo-50'])

    const peek = await call<CheckResult>(coordinator, CHECK, { mode: 'peek', runId: run.id, limit: 100, types: ['status'] })
    expect(peek.mode).toBe('peek')
    expect(peek.messages.every((message) => message.type === 'status')).toBe(true)
    const history = await call<CheckResult>(coordinator, CHECK, {
      mode: 'all',
      runId: run.id,
      limit: 100,
      types: ['question']
    })
    expect(history.mode).toBe('all')
    expect(history.messages).toHaveLength(25)
    expect(history.messages.every((message) => message.type === 'question')).toBe(true)
    const inbox = await call<InboxResult>(coordinator, INBOX, {})
    expect(inbox.messages).toHaveLength(20)
    expect(inbox.count).toBe(20)
    const full = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    expect(full.count).toBe(51)
    expect(full.messages).toHaveLength(51)
    expect(full.messages.every((message) => message.body?.startsWith('body-') === true)).toBe(true)

    const secondCoordinator = await fixture.createParty('second-coordinator')
    const otherRun = await createRun(secondCoordinator, 'foreign mailbox')
    await expectReason(consume(secondCoordinator, { ackDeliveryId: next.deliveryId }), 'stale_delivery')
    expect(otherRun.run.coordinatorSessionId).toBe(secondCoordinator.id)
  }, 60_000)

  test('AC8 filtered waits ignore status wakeups, enforce one waiter, and return the full FIFO batch', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const { run } = await createRun(coordinator, 'filtered wait')
    const waiterRequest = mutation()
    const waiting = consume(coordinator, {
      ...waiterRequest,
      wait: true,
      timeoutMs: 800,
      types: ['question']
    })
    await waitForAcceptedRequest(coordinator, waiterRequest.requestId)
    await expectReason(consume(coordinator, { wait: true, timeoutMs: 100, types: ['question'] }), 'waiter_exists')
    await send(coordinator, { to: { kind: 'run', runId: run.id }, type: 'status', subject: 'status first', body: 'does not match filter' })
    const afterStatus = await call<{ state: string }>(coordinator, REQUEST_SHOW, { requestId: waiterRequest.requestId })
    expect(afterStatus.state).toBe('pending')
    await send(coordinator, { to: { kind: 'run', runId: run.id }, type: 'question', subject: 'question second', body: 'matches filter' })
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.messages.map((message) => message.subject)).toEqual(['status first', 'question second'])
    expect(result.deliveryId).toBeTruthy()
    await consume(coordinator, { ackDeliveryId: result.deliveryId })

    const timeout = await consume(coordinator, { wait: true, timeoutMs: 35, types: ['dispatch'] })
    expect(timeout.timedOut).toBe(true)
    expect(timeout.messages).toHaveLength(0)
    await rejected(call(coordinator, CHECK, {
      ...mutation(),
      mode: 'consume',
      limit: 1
    }))
    await rejected(call(coordinator, CHECK, { mode: 'peek', types: ['not-a-message-type'] }))
    await expectReason(call(coordinator, CHECK, { mode: 'all', wait: true }), 'invalid_argument')
  }, 30_000)

  test('AC8 preserves a committed acknowledgement when rebinding interrupts the following wait', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const nextCoordinator = await fixture.createParty('next-coordinator')
    const { run } = await createRun(coordinator, 'wait cancellation')
    await send(coordinator, { to: { kind: 'run', runId: run.id }, type: 'status', subject: 'ack me', body: 'committed' })
    const delivery = await consume(coordinator)
    expect(delivery.deliveryId).toBeTruthy()

    const followingRequest = mutation()
    const followingWait = consume(coordinator, {
      ...followingRequest,
      ackDeliveryId: delivery.deliveryId,
      wait: true,
      timeoutMs: 1000
    })
    await waitForAcceptedRequest(coordinator, followingRequest.requestId)
    await createRun(coordinator, 'new binding')
    const interrupted = await followingWait
    expect(interrupted.acknowledged).toBe(delivery.deliveryId)
    expect(interrupted.cancelled || interrupted.waitInterrupted === 'consumer_fenced').toBe(true)

    await call(nextCoordinator, RUN_USE, { ...mutation(), runId: run.id })
    await expectReason(consume(nextCoordinator, { ackDeliveryId: delivery.deliveryId }), 'consumer_fenced')
  }, 30_000)

  test('AC8 disconnecting a live consumer wait rejects honestly without consuming mail', async () => {
    const coordinator = await fixture.createParty('coordinator')
    await createRun(coordinator, 'disconnect while waiting')
    const request = mutation()
    const waiting = consume(coordinator, { ...request, wait: true, timeoutMs: 1000 })
    await waitForAcceptedRequest(coordinator, request.requestId)
    await coordinator.client.close()
    const error = await rejected(waiting)
    expect(error).toMatchObject({ name: 'ConnectionLost' })
  }, 30_000)


  test('AC10 timed-out questions resume by their original ID, answer once, and reject conflicts', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const otherCoordinator = await fixture.createParty('other-coordinator')
    const { run } = await createRun(coordinator, 'ask/reply')
    const task = await createTask(coordinator, run.id, 'question task')
    const dispatch = await createDispatch(coordinator, run.id, task.task.id, worker.id)
    const firstRequest = mutation()
    const timedOut = await call<AskResult>(worker, ASK, {
      ...firstRequest,
      mode: 'question',
      runId: run.id,
      to: { kind: 'run', runId: run.id },
      question: 'Choose one',
      options: ['left', 'right'],
      timeoutMs: 30
    })
    expect(timedOut.state).toBe('timedOut')
    expect(timedOut.answer).toBeNull()
    expect(timedOut.timeoutMs).toBe(30)
    const questionId = timedOut.messageId
    const questionReceipt = await call<{ state: string; interpretation?: string }>(worker, REQUEST_SHOW, {
      requestId: firstRequest.requestId
    })
    expect(questionReceipt.state).toBe('completed')

    const foreignRun = await createRun(otherCoordinator, 'not this coordinator')
    const beforeWrongRun = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    await rejected(call(worker, ASK, {
      ...mutation(),
      mode: 'question',
      runId: foreignRun.run.id,
      to: { kind: 'run', runId: foreignRun.run.id },
      question: 'must not route across Runs',
      timeoutMs: 800
    }))
    const afterWrongRun = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    expect(afterWrongRun.count).toBe(beforeWrongRun.count)
    await rejected(call(otherCoordinator, REPLY, {
      ...mutation(),
      messageId: questionId,
      body: 'wrong coordinator'
    }))
    const resumedRequest = mutation()
    const resumed = call<AskResult>(worker, ASK, {
      ...resumedRequest,
      mode: 'resume',
      messageId: questionId,
      timeoutMs: 800
    })
    await waitForAcceptedRequest(worker, resumedRequest.requestId)
    const answer = await call<{ kind: 'question_answer'; duplicate: boolean; answerMessageId: MessageRow['id'] }>(coordinator, REPLY, {
      ...mutation(),
      runId: run.id,
      messageId: questionId,
      body: 'right'
    })
    expect(answer.kind).toBe('question_answer')
    expect(answer.duplicate).toBe(false)
    const answered = await resumed
    if (answered.state !== 'answered') throw new Error('expected an answered request')
    expect(answered).toMatchObject({ state: 'answered', answer: 'right', messageId: questionId })
    expect(answered.answerMessageId).toBe(answer.answerMessageId)

    const sameAnswer = await call<{ duplicate: boolean }>(coordinator, REPLY, {
      ...mutation(),
      runId: run.id,
      messageId: questionId,
      body: 'right'
    })
    expect(sameAnswer.duplicate).toBe(true)
    await expectReason(call(coordinator, REPLY, {
      ...mutation(),
      runId: run.id,
      messageId: questionId,
      body: 'left'
    }), 'answer_conflict')
    const repeatedResume = await call<AskResult>(worker, ASK, {
      ...mutation(),
      mode: 'resume',
      messageId: questionId,
      timeoutMs: 0
    })
    expect(repeatedResume).toMatchObject({ state: 'answered', answer: 'right', messageId: questionId })
    const inbox = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    expect(inbox.messages.filter((message) => message.id === questionId)).toHaveLength(1)
    expect(inbox.messages.find((message) => message.id === answer.answerMessageId)?.read).toBe(true)
    expect(dispatch.dispatch.status).toBe('dispatched')
  }, 30_000)

  test('AC11 ordinary replies are threaded and gates keep dependent Tasks blocked until resolution', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const foreignCoordinator = await fixture.createParty('foreign-coordinator')
    const { run } = await createRun(coordinator, 'gates')
    const source = await send(coordinator, {
      to: { kind: 'run', runId: run.id },
      type: 'status',
      subject: 'review requested',
      body: 'please review'
    })
    if (source.kind !== 'message') throw new Error('expected original ordinary message')
    const original = source.messages[0]!
    const reply = await call<{
      kind: 'ordinary_reply'
      messageId: string
      threadId: string
      replyMessage: MessageRow
    }>(coordinator, REPLY, { ...mutation(), messageId: original.id, body: 'reviewed' })
    expect(reply.kind).toBe('ordinary_reply')
    expect(reply.threadId).toBeTruthy()
    expect(reply.replyMessage.subject).toBe('Re: review requested')
    const readInbox = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    expect(readInbox.messages.find((message) => message.id === original.id)?.read).toBe(true)
    expect(reply.replyMessage.threadId).toBe(original.threadId ?? reply.threadId)

    const a = await createTask(coordinator, run.id, 'precondition A')
    const b = await createTask(coordinator, run.id, 'gated B', { dependencyTaskIds: [a.task.id] })
    const gate = await call<GateMutation>(coordinator, GATE_CREATE, {
      ...mutation(),
      taskId: b.task.id,
      question: 'approve B?',
      options: ['approve', 'decline']
    })
    expect(gate.task.status).toBe('blocked')
    await call<TaskUpdateResult>(coordinator, TASK_UPDATE, {
      ...mutation(),
      runId: run.id,
      taskId: a.task.id,
      status: 'completed',
      result: 'A complete'
    })
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, status: 'blocked' })).tasks.map((task) => task.id)).toContain(b.task.id)

    await createRun(foreignCoordinator, 'foreign gate context')
    await rejected(call(foreignCoordinator, GATE_RESOLVE, {
      ...mutation(),
      gateId: gate.gate.id,
      resolution: 'foreign resolution'
    }))
    expect((await call<{ gates: GateRow[] }>(coordinator, GATE_LIST, { runId: run.id, status: 'pending' })).gates.map((row) => row.id)).toContain(gate.gate.id)

    const resolved = await call<GateMutation>(coordinator, GATE_RESOLVE, {
      ...mutation(),
      gateId: gate.gate.id,
      resolution: 'approved'
    })
    expect(resolved.gate.status).toBe('resolved')
    expect(resolved.gate.resolution).toBe('approved')
    expect(resolved.gate.resolvedAt).toBeTruthy()
    expect(resolved.task.status).toBe('ready')
    expect((await call<{ gates: GateRow[] }>(coordinator, GATE_LIST, { runId: run.id, taskId: b.task.id, status: 'resolved' })).gates).toHaveLength(1)
  }, 30_000)

  test('an unsupported mutation contract leaves the bound Run and durable ledger unchanged', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const valid = await createRun(coordinator, 'valid contract before rejection')
    const requestId = crypto.randomUUID()
    await expect(call(coordinator, RUN, {
      requestId,
      contractVersion: 2,
      objective: 'unsupported contract version'
    })).rejects.toBeInstanceOf(Error)
    const listed = await call<{ runs: RunRow[] }>(coordinator, RUN_LIST, { limit: 100 })
    expect(listed.runs).toEqual([valid.run])
    const current = await call<{ run: RunRow | null }>(coordinator, RUN_CURRENT)
    expect(current.run?.id).toBe(valid.run.id)
    const receipt = await call<RequestShowResult>(coordinator, REQUEST_SHOW, { requestId })
    expect(receipt).toEqual({ requestId, state: 'absent', interpretation: 'absence_does_not_prove_no_effect' })
  })

  test('AC12 durable receipts join concurrent retries, fence mismatched requests, and survive reconnect/restart', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const requestId = crypto.randomUUID()
    const params = { ...mutation(requestId), objective: 'single durable operation' }
    const [first, concurrent] = await Promise.all([
      call<RunMutation>(coordinator, RUN, params),
      call<RunMutation>(coordinator, RUN, params)
    ])
    expect(first.run.id).toBe(concurrent.run.id)
    const list = await call<{ runs: RunRow[] }>(coordinator, RUN_LIST, { limit: 100 })
    expect(list.runs.filter((run) => run.id === first.run.id)).toHaveLength(1)

    const disconnectedClient = coordinator.client
    await disconnectedClient.close()
    const reconnected = await fixture.reconnect(coordinator)
    const replay = await call<RunMutation>(reconnected, RUN, params)
    expect(replay.run.id).toBe(first.run.id)
    expect(replay.mutation).toEqual({ requestId, replayed: true })
    await expectReason(call(reconnected, RUN, { ...params, objective: 'different input' }), 'request_mismatch')
    const receipt = await call<{ state: string; interpretation: string }>(reconnected, REQUEST_SHOW, { requestId })
    expect(receipt).toMatchObject({ state: 'completed', interpretation: 'completed_and_replayable' })

    const absentId = crypto.randomUUID()
    const absent = await call<RequestShowResult>(reconnected, REQUEST_SHOW, { requestId: absentId })
    expect(absent).toEqual({
      requestId: absentId,
      state: 'absent',
      interpretation: 'absence_does_not_prove_no_effect'
    })

    const task = await createTask(reconnected, first.run.id, 'survives restart')
    const messageReceipt = await send(reconnected, {
      to: { kind: 'run', runId: first.run.id },
      type: 'status',
      subject: 'before restart',
      body: 'durable mail'
    })
    expect(messageReceipt.mutation.requestId).toBeTruthy()
    await fixture.restart()
    const afterRestart = await fixture.reconnect(coordinator)
    const replayAfterRestart = await call<RunMutation>(afterRestart, RUN, params)
    expect(replayAfterRestart.run.id).toBe(first.run.id)
    expect(replayAfterRestart.mutation).toEqual({ requestId, replayed: true })
    const durable = await call<{ state: string; interpretation: string }>(afterRestart, REQUEST_SHOW, { requestId })
    expect(durable).toMatchObject({ state: 'completed', interpretation: 'completed_and_replayable' })
    expect((await call<{ run: RunRow }>(afterRestart, RUN_SHOW, { runId: first.run.id })).run.id).toBe(first.run.id)
    expect((await call<{ tasks: TaskRow[] }>(afterRestart, TASK_LIST, { runId: first.run.id, ready: false })).tasks.map((row) => row.id)).toContain(task.task.id)
  }, 45_000)

  test('AC12 pending asks expose an accepted receipt checkpoint without minting replacement work', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await createRun(coordinator, 'accepted ask checkpoint')
    const task = await createTask(coordinator, run.id, 'pending question')
    await createDispatch(coordinator, run.id, task.task.id, worker.id)
    const askRequest = mutation()
    const askParams = {
      ...askRequest,
      mode: 'question' as const,
      question: 'keep pending through checkpoint',
      timeoutMs: 1500
    }
    const pendingAsk = call<AskResult>(worker, ASK, askParams)
    const pendingReceipt = await waitForAcceptedRequest(worker, askRequest.requestId)
    expect(pendingReceipt.state).toBe('pending')
    const checkpointMessageId = pendingReceipt.receipt?.checkpoint?.messageId
    expect(checkpointMessageId).toBeTruthy()
    const countBefore = (await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })).count
    const joinedAsk = call<AskResult>(worker, ASK, askParams)
    const joinedReceipt = await waitForAcceptedRequest(worker, askRequest.requestId)
    expect(joinedReceipt.state).toBe('pending')
    expect(joinedReceipt.receipt?.checkpoint?.messageId).toBe(checkpointMessageId)
    const [timedOut, joined] = await Promise.all([pendingAsk, joinedAsk])
    expect(timedOut.state).toBe('timedOut')
    expect(checkpointMessageId).toBe(timedOut.messageId)
    expect(joined).toMatchObject({ state: 'timedOut', messageId: checkpointMessageId })
    const countAfter = (await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })).count
    expect(countAfter).toBe(countBefore)
  }, 30_000)

  test('AC12 real mutations expire 30-day receipts and prune the oldest completed batch of 64', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const absentBefore = crypto.randomUUID()
    await call(coordinator, REQUEST_SHOW, { requestId: absentBefore })
    const databasePath = join(fixture.home, 'plugin-data', 'quirky.orchestration', 'store.db')
    const callerFingerprint = await primeReceiptCallerFingerprint(coordinator, databasePath)
    const expiredId = crypto.randomUUID()
    const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    seedReceipts(databasePath, callerFingerprint, [{ requestId: expiredId, state: 'completed', createdAt: expiredAt }])
    expect(await call(coordinator, REQUEST_SHOW, { requestId: expiredId })).toMatchObject({ state: 'completed' })
    await createRun(coordinator, 'triggers expired receipt pruning')
    expect(await call<RequestShowResult>(coordinator, REQUEST_SHOW, { requestId: expiredId })).toEqual({
      requestId: expiredId,
      state: 'absent',
      interpretation: 'absence_does_not_prove_no_effect'
    })

    const completed = Array.from({ length: 10_000 }, (_, index) => ({
      requestId: crypto.randomUUID(),
      state: 'completed' as const,
      createdAt: new Date(Date.now() - 20_000 + index).toISOString()
    }))
    seedReceipts(databasePath, callerFingerprint, completed)
    const afterBatch = await createRun(coordinator, 'prunes oldest completed receipt batch')
    expect((await call<RequestShowResult>(coordinator, REQUEST_SHOW, { requestId: completed[0]!.requestId })).state).toBe('absent')
    expect((await call<RequestShowResult>(coordinator, REQUEST_SHOW, { requestId: completed[63]!.requestId })).state).toBe('absent')
    expect((await call<RequestShowResult>(coordinator, REQUEST_SHOW, { requestId: completed[64]!.requestId })).state).toBe('completed')
    expect((await call<RequestShowResult>(coordinator, REQUEST_SHOW, { requestId: afterBatch.mutation.requestId })).state).toBe('completed')
  }, 60_000)

  test('AC12 unresolved receipt saturation refuses effects with mutation_ledger_full', async () => {
    const coordinator = await fixture.createParty('coordinator')
    await call(coordinator, REQUEST_SHOW, { requestId: crypto.randomUUID() })
    const databasePath = join(fixture.home, 'plugin-data', 'quirky.orchestration', 'store.db')
    const callerFingerprint = await primeReceiptCallerFingerprint(coordinator, databasePath)
    const pending = Array.from({ length: 10_000 }, () => ({
      requestId: crypto.randomUUID(),
      state: 'pending' as const,
      createdAt: new Date().toISOString()
    }))
    seedReceipts(databasePath, callerFingerprint, pending)
    await expectReason(createRun(coordinator, 'must not cross unresolved ledger saturation'), 'mutation_ledger_full')
    expect((await call<{ runs: RunRow[] }>(coordinator, RUN_LIST, { limit: 100 })).runs).toHaveLength(0)
    expect(await call(coordinator, REQUEST_SHOW, { requestId: pending[0]!.requestId })).toMatchObject({ state: 'pending' })
  }, 60_000)

  test('AC13 reset modes preserve the scoped survivors and retain mutation receipts', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await createRun(coordinator, 'reset scopes')
    const task = await createTask(coordinator, run.id, 'survivor in messages reset')
    const gate = await call<GateMutation>(coordinator, GATE_CREATE, {
      ...mutation(),
      taskId: task.task.id,
      question: 'gate survives message reset'
    })
    const firstMail = await send(coordinator, {
      to: { kind: 'run', runId: run.id },
      type: 'status',
      subject: 'mail before message reset',
      body: 'remove this'
    })
    if (firstMail.kind !== 'message') throw new Error('expected mail before reset')
    const delivery = await consume(coordinator)

    const messagesReset = await call<{ mode: string; mutation: MutationMarker }>(coordinator, RESET, {
      ...mutation(),
      yes: true,
      mode: 'messages'
    })
    expect(messagesReset.mode).toBe('messages')
    expect((await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })).messages).toHaveLength(0)
    expect((await call<{ runs: RunRow[] }>(coordinator, RUN_LIST, { limit: 100 })).runs.map((row) => row.id)).toContain(run.id)
    expect((await call<{ tasks: TaskRow[] }>(coordinator, TASK_LIST, { runId: run.id, ready: false })).tasks.map((row) => row.id)).toContain(task.task.id)
    expect((await call<{ gates: GateRow[] }>(coordinator, GATE_LIST, { runId: run.id })).gates.map((row) => row.id)).toContain(gate.gate.id)
    await expectReason(consume(coordinator, { ackDeliveryId: delivery.deliveryId }), 'stale_delivery')

    await send(coordinator, {
      to: { kind: 'run', runId: run.id },
      type: 'status',
      subject: 'mail survives tasks reset',
      body: 'preserve this'
    })
    await rejected(call(coordinator, RESET, { ...mutation(), yes: true }))
    const questionTask = await createTask(coordinator, run.id, 'question closes on task reset')
    const questionDispatch = await createDispatch(coordinator, run.id, questionTask.task.id, worker.id)
    const questionRequest = mutation()
    const pendingQuestion = call<AskResult>(worker, ASK, {
      ...questionRequest,
      mode: 'question',
      question: 'close when Tasks reset',
      timeoutMs: 1000
    })
    const questionReceipt = await waitForAcceptedRequest(worker, questionRequest.requestId)
    const questionId = questionReceipt.receipt?.checkpoint?.messageId
    expect(questionId).toBeTruthy()
    expect(questionDispatch.dispatch.taskId).toBe(questionTask.task.id)
    const tasksReset = await call<{ mode: string; mutation: MutationMarker }>(coordinator, RESET, {
      ...mutation(),
      yes: true,
      mode: 'tasks'
    })
    expect(tasksReset.mode).toBe('tasks')
    expect((await pendingQuestion).state).toBe('cancelled')
    expect((await call<{ runs: RunRow[] }>(coordinator, RUN_LIST, { limit: 100 })).runs.map((row) => row.id)).toContain(run.id)
    expect((await call<{ tasks: TaskRow[]; count: number }>(coordinator, TASK_LIST, { runId: run.id, ready: false })).count).toBe(0)
    expect((await call<{ gates: GateRow[] }>(coordinator, GATE_LIST, { runId: run.id })).gates).toHaveLength(0)
    const preserved = await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })
    expect(preserved.messages.map((row) => row.subject)).toContain('mail survives tasks reset')
    expect(preserved.messages.some((message) => message.id === questionId)).toBe(true)

    const allReceipt = mutation()
    await call(coordinator, RESET, { ...allReceipt, yes: true, mode: 'all' })
    expect((await call<{ runs: RunRow[] }>(coordinator, RUN_LIST, { limit: 100 })).runs).toHaveLength(0)
    expect((await call<InboxResult>(coordinator, INBOX, { full: true, limit: 100 })).messages).toHaveLength(0)
    expect(await call(coordinator, REQUEST_SHOW, { requestId: allReceipt.requestId })).toMatchObject({ state: 'completed' })
    expect((await call<{ id: string }[]>(coordinator, 'quirky.session/list', {})).map((session) => session.id)).toContain(worker.id)
  }, 45_000)

  test('AC13 a fresh daemon restart fences old deliveries without inventing a live attempt', async () => {
    const coordinator = await fixture.createParty('coordinator')
    const worker = await fixture.createParty('worker')
    const { run } = await createRun(coordinator, 'restart fences')
    const task = await createTask(coordinator, run.id, 'context-only dispatch')
    await createDispatch(coordinator, run.id, task.task.id, worker.id)
    await send(coordinator, {
      to: { kind: 'run', runId: run.id },
      type: 'status',
      subject: 'before restart',
      body: 'mail survives'
    })
    const delivery = await consume(coordinator)
    await fixture.restart()

    const restoredCoordinator = await fixture.createParty('restored-coordinator')
    await call(restoredCoordinator, RUN_USE, { ...mutation(), runId: run.id })
    await expectReason(consume(restoredCoordinator, { ackDeliveryId: delivery.deliveryId }), 'consumer_fenced')
    const restored = await call<{ tasks: TaskRow[] }>(restoredCoordinator, TASK_LIST, { runId: run.id, ready: false })
    expect(restored.tasks.map((row) => row.id)).toContain(task.task.id)
    const attempt = await call<{ dispatch: DispatchRow | null; worker: unknown }>(restoredCoordinator, DISPATCH_SHOW, { taskId: task.task.id })
    expect(attempt.dispatch?.status).toBe('dispatched')
    expect(attempt.worker).toBeNull()
    expect((await call<InboxResult>(restoredCoordinator, INBOX, { full: true, limit: 100 })).messages.map((row) => row.subject)).toContain('before restart')
  }, 45_000)
})
