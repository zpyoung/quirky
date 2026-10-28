import { describe, expect, test } from 'bun:test'
import { makeWorkerStartHarness, workerStartParams } from './start-support'
import type { DispatchId, DispatchRow, TaskId } from '../../src/contracts'
import type { WorkerRecord } from '../../src/worker-contracts'
import { buildWorkerPreamble } from '../../src/workers/preamble'

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null
}

describe('worker start', () => {
  test('refuses an oversized UTF-8 brief before Task or launch effects', async () => {
    const harness = makeWorkerStartHarness()
    const oversized = '🧭'.repeat(303_617)

    let failure: unknown
    try {
      await harness.starter.start(workerStartParams({ spec: oversized }), harness.caller)
    } catch (error) {
      failure = error
    }

    expect(errorCode(failure)).toBe('worker_prompt_too_large')
    expect(harness.tasks.size).toBe(0)
    expect(harness.dispatches.size).toBe(0)
    expect(harness.records.size).toBe(0)
    expect(harness.runtime.validateCalls).toBe(0)
    expect(harness.runtime.placeCalls).toBe(0)
  })

  test('accepts Task, Dispatch and starting Worker before placement, records custody, then submits once', async () => {
    const harness = makeWorkerStartHarness()
    harness.runtime.afterCustody = dispatchId => {
      const task = harness.tasks.get(harness.dispatches.get(dispatchId)!.taskId)
      expect(task?.status).toBe('dispatched')
      expect(harness.dispatches.get(dispatchId)?.status).toBe('pending')
      expect(harness.records.get(dispatchId)?.state).toBe('starting')
      expect(harness.records.get(dispatchId)?.sessionId).toBe(harness.runtime.placement.session.id)
      expect(harness.repository.resource(dispatchId)).toMatchObject({
        ownerDispatchId: dispatchId,
        sessionId: harness.runtime.placement.identity.sessionId,
        processIncarnation: harness.runtime.placement.identity.processIncarnation,
        ownershipState: 'owned',
      })
    }

    const receipt = await harness.starter.start(workerStartParams(), harness.caller)
    const dispatchId = receipt.dispatchId

    expect(receipt.state).toBe('ready')
    expect(receipt.turnStart).toBe('observed')
    expect(harness.records.get(dispatchId)?.state).toBe('ready')
    expect(harness.records.get(dispatchId)?.runtimeEpoch).toBe('supervisor_epoch_1')
    expect(harness.records.get(dispatchId)?.processRuntimeEpoch).toBe('kernel_epoch_1')
    expect(harness.records.get(dispatchId)?.runtimeEpoch).not.toBe(harness.records.get(dispatchId)?.processRuntimeEpoch)
    expect(harness.dispatches.get(dispatchId)?.status).toBe('dispatched')
    expect(harness.tasks.get(receipt.taskId)?.status).toBe('dispatched')
    expect(harness.runtime.events).toEqual(['place', 'custody', 'ready', 'submit'])
    expect(harness.runtime.submitCalls).toBe(1)
    expect(harness.runtime.submittedOperations).toHaveLength(1)
  })

  test('reports unobserved accepted input as unknown without resubmitting', async () => {
    const harness = makeWorkerStartHarness()
    harness.runtime.submitResult = 'unobserved'

    const receipt = await harness.starter.start(workerStartParams(), harness.caller)

    expect(receipt.state).toBe('outcome_unknown')
    expect(receipt.turnStart).toBe('unobserved')
    expect(harness.records.get(receipt.dispatchId)?.state).toBe('start_unknown')
    expect(harness.dispatches.get(receipt.dispatchId)?.status).toBe('pending')
    expect(harness.runtime.submitCalls).toBe(1)
  })

  test('does not overwrite a worker report that settles while turn observation is pending', async () => {
    const harness = makeWorkerStartHarness()
    harness.runtime.submitResult = 'unobserved'
    harness.runtime.beforeSubmit = dispatchId => harness.reportFromWorker(dispatchId, 'succeeded')

    const receipt = await harness.starter.start(workerStartParams(), harness.caller)

    expect(receipt.state).toBe('ready')
    expect(receipt.workerOutcome).toBe('succeeded')
    expect(harness.records.get(receipt.dispatchId)?.state).toBe('succeeded')
    expect(harness.dispatches.get(receipt.dispatchId)?.status).toBe('completed')
    expect(harness.tasks.get(receipt.taskId)?.status).toBe('completed')
    expect(harness.runtime.submitCalls).toBe(1)
  })

  test('rejects conflicting launch selectors before host validation', async () => {
    const harness = makeWorkerStartHarness()
    let failure: unknown
    try {
      await harness.starter.start(workerStartParams({ terminal: 'session_worker' }), harness.caller)
    } catch (error) {
      failure = error
    }

    expect(errorCode(failure)).toBe('invalid_argument')
    expect(harness.tasks.size).toBe(0)
    expect(harness.dispatches.size).toBe(0)
    expect(harness.runtime.validateCalls).toBe(0)
    expect(harness.runtime.placeCalls).toBe(0)
  })

  test('keeps a created agent resource reclaimable after a known readiness failure', async () => {
    const harness = makeWorkerStartHarness()
    harness.runtime.readyError = new Error('Agent startup blocked: approval dialog')

    const receipt = await harness.starter.start(workerStartParams(), harness.caller)

    expect(receipt.state).toBe('failed')
    expect(receipt.failedStage).toBe('readiness')
    expect(receipt.recovery).toContain('worker-release')
    expect(harness.records.get(receipt.dispatchId)?.state).toBe('failed')
    expect(harness.dispatches.get(receipt.dispatchId)?.status).toBe('failed')
    expect(harness.repository.resource(receipt.dispatchId)?.ownershipState).toBe('owned')
    expect(harness.runtime.submitCalls).toBe(0)
  })

  test('reports asynchronous start-immediately setup completion once', async () => {
    const harness = makeWorkerStartHarness()
    harness.runtime.placement = {
      ...harness.runtime.placement,
      setup: { ...harness.runtime.placement.setup, hookFound: true, startupPolicy: 'start-immediately', state: 'running' },
      effects: [
        { kind: 'setup', action: 'started', role: 'setup', id: 'setup_session' },
        ...harness.runtime.placement.effects,
      ],
    }

    const receipt = await harness.starter.start(workerStartParams(), harness.caller)
    harness.emitSetupExit('setup_session', 0)

    expect(receipt.state).toBe('ready')
    expect(harness.records.get(receipt.dispatchId)?.setupState).toBe('succeeded')
    expect(harness.records.get(receipt.dispatchId)?.receipt?.setup.state).toBe('succeeded')
    expect(harness.setupStatuses).toHaveLength(1)
    expect(harness.setupStatuses[0]?.high).toBe(false)
  })

  test('rejects retry of an earlier settled attempt when a newer attempt is latest', async () => {
    const harness = makeWorkerStartHarness()
    const taskId = 'task_retry' as TaskId
    const priorId = 'ctx_prior' as DispatchId
    const latestId = 'ctx_latest' as DispatchId
    const priorAt = '2026-10-27T11:00:00.000Z'
    const latestAt = '2026-10-27T11:30:00.000Z'
    harness.tasks.set(taskId, {
      id: taskId, runId: harness.run.id, parentTaskId: null, dependencyTaskIds: [],
      createdBySessionId: harness.caller.callerSessionId, taskTitle: 'Retry the failed work',
      displayName: 'Retry the failed work', spec: 'Retry only the latest eligible attempt.',
      status: 'failed', result: null, createdAt: '2026-10-27T10:30:00.000Z', completedAt: latestAt,
    })
    const makeDispatch = (id: DispatchId, createdAt: string, failureCount: number, retryOfDispatchId: DispatchId | null): DispatchRow => ({
      id, runId: harness.run.id, taskId, contractVersion: 1, status: 'failed',
      assigneeSessionId: `session_${id}`, creatorSessionId: harness.caller.callerSessionId,
      creatorDispatchId: null, retryOfDispatchId, depth: 0, failureCount,
      lastFailure: 'infrastructure failure', terminationReason: null, consumerGeneration: 1,
      createdAt, dispatchedAt: createdAt, completedAt: createdAt, lastHeartbeatAt: null,
    })
    const makeWorker = (dispatchId: DispatchId, createdAt: string): WorkerRecord => ({
      dispatchId, state: 'failed', stage: 'start_failed', worktreeId: harness.runtime.placement.worktreeId, sessionId: null,
      setupState: 'not_applicable', effects: [], residualResources: [], lastError: 'prior failure',
      createdAt, updatedAt: createdAt, runtimeEpoch: 'prior_supervisor_epoch',
      processIncarnation: null, processRuntimeEpoch: null, mode: 'terminal',
      startOptions: workerStartParams(), receipt: null,
    })
    harness.dispatches.set(priorId, makeDispatch(priorId, priorAt, 1, null))
    harness.dispatches.set(latestId, makeDispatch(latestId, latestAt, 2, priorId))
    harness.records.set(priorId, makeWorker(priorId, priorAt))
    harness.records.set(latestId, makeWorker(latestId, latestAt))
    const { spec: _spec, ...base } = workerStartParams()

    let failure: unknown
    try {
      await harness.starter.start({ ...base, taskId, retryOfDispatchId: priorId }, harness.caller)
    } catch (error) {
      failure = error
    }

    expect(errorCode(failure)).toBe('task_not_startable')
    expect(harness.tasks.get(taskId)?.status).toBe('failed')
    expect(harness.dispatches.get(latestId)?.status).toBe('failed')
    expect(harness.records.size).toBe(2)
    expect(harness.runtime.placeCalls).toBe(0)
  })
  test('preserves physical input that raced terminal custody recording', async () => {
    const harness = makeWorkerStartHarness()
    harness.simulateUserInput('session_worker', 'worker-incarnation-1')

    const receipt = await harness.starter.start(workerStartParams(), harness.caller)
    const resource = harness.repository.resource(receipt.dispatchId)

    expect(receipt.state).toBe('ready')
    expect(resource?.ownershipState).toBe('user_owned')
    expect(resource?.releaseState).toBe('retained')
    expect(resource?.retainedReason).toBe('user_takeover')
  })
  test('scopes the preamble to its Dispatch and Run mailbox and gates sub-dispatch by depth', async () => {
    const harness = makeWorkerStartHarness()
    const receipt = await harness.starter.start(workerStartParams(), harness.caller)
    const task = harness.tasks.get(receipt.taskId)
    const dispatch = harness.dispatches.get(receipt.dispatchId)
    if (!task || !dispatch) throw new Error('accepted worker rows were not persisted')

    const preamble = buildWorkerPreamble(task, dispatch, harness.runtime.placement.identity, `run:${harness.run.id}`, 1)
    expect(preamble).toContain(`Your coordinator Run mailbox is: run:${harness.run.id}`)
    expect(preamble).not.toContain('Your coordinator session ID is:')
    expect(preamble).toContain(`--task-id ${task.id} --dispatch-id ${dispatch.id}`)
    expect(preamble).toContain('--outcome succeeded|failed')
    expect(preamble).toContain('orchestration ask --resume <messageId>')
    expect(preamble).toContain('=== SUB-DISPATCH ===')
    expect(preamble).toContain('=== TASK ===\n' + task.spec)

    const atMaximumDepth = buildWorkerPreamble(task, { ...dispatch, depth: 1 }, harness.runtime.placement.identity, harness.run.coordinatorSessionId!, 1)
    expect(atMaximumDepth).not.toContain('=== SUB-DISPATCH ===')
  })
  test('replays a completed receipt before revalidating the host catalog', async () => {
    const harness = makeWorkerStartHarness()
    const params = workerStartParams()
    const original = await harness.starter.start(params, harness.caller)
    harness.runtime.validateError = new Error('the host catalog is now unavailable')

    const replay = await harness.starter.start(params, harness.caller)

    expect(replay.mutation.replayed).toBe(true)
    expect(replay.dispatchId).toBe(original.dispatchId)
    expect(harness.runtime.validateCalls).toBe(1)
    expect(harness.runtime.placeCalls).toBe(1)
    expect(harness.runtime.submitCalls).toBe(1)
  })
  test('unsubscribes setup completion when the worker starter is disposed', async () => {
    const harness = makeWorkerStartHarness()
    harness.runtime.placement = {
      ...harness.runtime.placement,
      setup: { ...harness.runtime.placement.setup, hookFound: true, startupPolicy: 'start-immediately', state: 'running' },
      effects: [{ kind: 'setup', action: 'started', role: 'setup', id: 'setup_session' }, ...harness.runtime.placement.effects],
    }
    const receipt = await harness.starter.start(workerStartParams(), harness.caller)

    harness.starter.dispose()
    harness.emitSetupExit('setup_session', 0)

    expect(harness.records.get(receipt.dispatchId)?.setupState).toBe('running')
    expect(harness.setupStatuses).toHaveLength(0)
  })
})
