import { describe, expect, test } from 'bun:test'
import type { WorkerArchive } from '../../src/worker-contracts'
import { controlParams, createLifecycleFixture, exactCaller } from './lifecycle-support'

describe('worker lifecycle', () => {
  test('a completion report accepted during starting settles once and cannot be resurrected', () => {
    const f = createLifecycleFixture({ state: 'starting' })
    try {
      const result = f.core.reportWorkerDone({
        taskId: f.task.id,
        dispatchId: f.dispatch.id,
        outcome: 'succeeded',
        messageId: 'msg_done' as never,
        subject: 'Finished',
        body: 'The task is complete.'
      }, exactCaller(f.worker))

      expect(result.status).toBe('accepted')
      expect(f.repo.get(f.dispatch.id)?.state).toBe('succeeded')
      expect(f.core.getDispatch(f.dispatch.id).status).toBe('completed')
      expect(f.core.getTask(f.task.id).status).toBe('completed')
      f.lifecycle.settleDispatch(f.store, f.dispatch.id, 'failed', '2026-10-27T00:01:00.000Z')
      expect(f.repo.get(f.dispatch.id)?.state).toBe('succeeded')
    } finally {
      f.close()
    }
  })
  test('an exact worker report recovers stop_unknown without reopening a settled attempt', () => {
    const f = createLifecycleFixture({ state: 'stop_unknown' })
    try {
      const result = f.core.reportWorkerDone({
        taskId: f.task.id,
        dispatchId: f.dispatch.id,
        outcome: 'succeeded',
        messageId: 'msg_recovered' as never,
        subject: 'Recovered',
        body: 'The exact worker completed.'
      }, exactCaller(f.worker))

      expect(result.status).toBe('accepted')
      expect(f.repo.get(f.dispatch.id)?.state).toBe('succeeded')
      expect(f.core.getDispatch(f.dispatch.id).status).toBe('completed')
      expect(f.core.getTask(f.task.id).status).toBe('completed')
    } finally {
      f.close()
    }
  })
  test('the worker transition hook preserves the core start-unknown state', () => {
    const f = createLifecycleFixture({ state: 'starting' })
    try {
      const transitioned = f.core.transitionWorker({
        dispatchId: f.dispatch.id,
        expectedState: 'starting',
        nextState: 'start_unknown'
      })

      expect(transitioned.state).toBe('start_unknown')
      expect(f.repo.get(f.dispatch.id)?.state).toBe('start_unknown')
    } finally {
      f.close()
    }
  })

  test('release commits an archive before closing only the exact owned incarnation and coalesces duplicates', async () => {
    const f = createLifecycleFixture({ state: 'succeeded' })
    try {
      f.setCloseHandler((target) => {
        expect(target.id).toBe('terminal-resource-1')
        expect(f.repo.archive(f.dispatch.id)).toMatchObject({ status: 'captured' })
        expect(f.repo.resource(f.dispatch.id)?.releaseState).toBe('releasing')
      })
      const params = controlParams(f.dispatch.id, 'release-one')
      const results = await Promise.all([
        f.lifecycle.release(params, f.caller),
        f.lifecycle.release(controlParams(f.dispatch.id, 'release-two'), f.caller)
      ])

      expect(f.captureCount()).toBe(1)
      expect(f.events).toEqual([`capture:${f.dispatch.id}`, `close:terminal-resource-1`])
      expect(f.closed).toHaveLength(1)
      expect(f.closed[0]).toMatchObject({
        id: 'terminal-resource-1',
        ownerDispatchId: f.dispatch.id,
        sessionId: f.worker.sessionId,
        processIncarnation: f.worker.processIncarnation
      })
      expect(f.repo.archive(f.dispatch.id)).toMatchObject({ status: 'captured', resourceId: 'terminal-resource-1' })
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ ownershipState: 'released', releaseState: 'released' })
      expect(results[0].state).toBe('released')
      expect(results[1].state).toBe('released')
    } finally {
      f.close()
    }
  })
  test('startup recovery finishes only a previously requested release', async () => {
    const f = createLifecycleFixture({ state: 'succeeded' })
    try {
      await f.lifecycle.recoverReleases()
      expect(f.captureCount()).toBe(0)
      expect(f.closed).toHaveLength(0)

      f.repo.putResource({
        ...f.repo.resource(f.dispatch.id)!,
        releaseState: 'requested',
        releaseRequestedAt: '2026-10-27T00:00:00.000Z'
      })
      await f.lifecycle.recoverReleases()

      expect(f.captureCount()).toBe(1)
      expect(f.closed).toHaveLength(1)
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ releaseState: 'released', ownershipState: 'released' })
    } finally {
      f.close()
    }
  })

  test('a user takeover during archive capture wins before release commits and invalidates the archive', async () => {
    const f = createLifecycleFixture({ state: 'succeeded' })
    try {
      const archive: WorkerArchive = {
        dispatchId: f.dispatch.id,
        resourceId: 'terminal-resource-1',
        kind: 'terminal_tail',
        content: 'late capture',
        sourceIdentity: `${f.worker.sessionId}:${f.worker.processIncarnation}`,
        status: 'captured',
        createdAt: '2026-10-27T00:00:00.000Z'
      }
      f.setCaptureHandler(async () => {
        expect(f.repo.resource(f.dispatch.id)?.releaseState).toBe('requested')
        expect(f.lifecycle.userInput({ session: f.worker.sessionId!, expectedIncarnation: f.worker.processIncarnation! }).takenOver).toBe(true)
        return archive
      })

      const result = await f.lifecycle.release(controlParams(f.dispatch.id, 'release-race'), f.caller)

      expect(result.state).toBe('retained')
      expect(f.closed).toHaveLength(0)
      expect(f.repo.archive(f.dispatch.id)).toBeNull()
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({
        ownershipState: 'user_owned',
        releaseState: 'retained',
        retainedReason: 'user_takeover'
      })
    } finally {
      f.close()
    }
  })
  test('disposal during archive capture does not close or touch revoked worker state', async () => {
    const f = createLifecycleFixture({ state: 'succeeded' })
    const started = Promise.withResolvers<void>()
    const capture = Promise.withResolvers<WorkerArchive>()
    try {
      f.setCaptureHandler((_dispatchId) => {
        started.resolve()
        return capture.promise
      })
      const pending = f.lifecycle.release(controlParams(f.dispatch.id, 'release-disposed'), f.caller)
      await started.promise
      f.lifecycle.dispose()
      capture.resolve({
        dispatchId: f.dispatch.id,
        resourceId: 'terminal-resource-1',
        kind: 'terminal_tail',
        content: 'captured after disposal',
        sourceIdentity: `${f.worker.sessionId}:${f.worker.processIncarnation}`,
        status: 'captured',
        createdAt: '2026-10-27T00:00:00.000Z'
      })
      const result = await pending

      expect(result.state).toBe('release_pending')
      expect(f.closed).toHaveLength(0)
      expect(f.repo.archive(f.dispatch.id)).toBeNull()
      expect(f.repo.resource(f.dispatch.id)?.releaseState).toBe('requested')
    } finally {
      f.close()
    }
  })

  test('an old dispatch cannot release a terminal after custody transfers to its retry', async () => {
    const f = createLifecycleFixture({ state: 'failed' })
    try {
      f.repo.putResource({
        ...f.repo.resource(f.dispatch.id)!,
        ownerDispatchId: 'ctx_retry' as typeof f.dispatch.id,
        priorOwnerDispatchIds: [f.dispatch.id],
        ownershipState: 'owned'
      })

      const result = await f.lifecycle.release(controlParams(f.dispatch.id, 'release-old'), f.caller)

      expect(result.state).toBe('retained')
      expect(f.closed).toHaveLength(0)
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ ownerDispatchId: 'ctx_retry', ownershipState: 'transferred' })
      expect(f.repo.resourceBySession(f.worker.sessionId!)).toMatchObject({ ownerDispatchId: 'ctx_retry', ownershipState: 'owned' })
    } finally {
      f.close()
    }
  })

  test('uncertain identity stays release_unknown and never closes a replacement', async () => {
    const f = createLifecycleFixture({ state: 'failed' })
    try {
      f.setObservation({ status: 'identity_changed', exactWorker: false, identity: null, reason: 'incarnation changed' })

      const result = await f.lifecycle.release(controlParams(f.dispatch.id, 'release-uncertain'), f.caller)

      expect(result.state).toBe('release_unknown')
      expect(f.closed).toHaveLength(0)
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ releaseState: 'unknown', ownershipState: 'owned' })
    } finally {
      f.close()
    }
  })

  test('startup reconciliation marks a stranded start unknown and leaves unrequested custody alone', () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.repo.update(f.dispatch.id, { state: 'starting', runtimeEpoch: 'old-epoch' }, 'ready')
      f.repo.reconcile('new-epoch')

      expect(f.repo.get(f.dispatch.id)).toMatchObject({ state: 'start_unknown', runtimeEpoch: 'old-epoch' })
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ ownershipState: 'owned', releaseState: 'not_requested' })
      expect(f.closed).toHaveLength(0)
    } finally {
      f.close()
    }
  })
  test('a stranded stop becomes stop_unknown on restart and can be retried with fresh exact evidence', async () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.repo.update(f.dispatch.id, { state: 'stopping', stage: 'stopping', runtimeEpoch: 'old-epoch' }, 'ready')
      f.repo.reconcile('new-epoch')
      expect(f.repo.get(f.dispatch.id)?.state).toBe('stop_unknown')
      f.setCloseHandler(() => {
        expect(f.repo.get(f.dispatch.id)).toMatchObject({ state: 'stop_unknown', stage: 'stopping' })
        expect(f.lifecycle.acceptReport(f.store, {
          dispatchId: f.dispatch.id,
          outcome: 'succeeded',
          caller: exactCaller(f.worker),
          at: '2026-10-27T00:00:01.000Z'
        })).toBeNull()
      })

      const result = await f.lifecycle.stop(controlParams(f.dispatch.id, 'stop-retry'), f.caller)

      expect(result.state).toBe('stopped')
      expect(f.closed).toHaveLength(1)
      expect(f.repo.get(f.dispatch.id)).toMatchObject({ state: 'stopped', runtimeEpoch: 'epoch-1' })
    } finally {
      f.close()
    }
  })

  test('a settled Dispatch abandons lingering active worker state without closing resources', () => {
    const f = createLifecycleFixture({ state: 'ready', dispatchStatus: 'failed', taskStatus: 'failed' })
    try {
      const row = f.repo.get(f.dispatch.id)
      expect(row).toMatchObject({ state: 'abandoned', stage: 'assignment_settled' })
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ releaseState: 'retained', retainedReason: 'assignment_settled' })
      expect(f.closed).toHaveLength(0)
    } finally {
      f.close()
    }
  })

  test('stop fences first and closes only its exact owned terminal, never neighboring resources', async () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.repo.putResource({
        ...f.repo.resource(f.dispatch.id)!,
        id: 'unrelated-setup-terminal',
        originDispatchId: 'ctx_setup' as typeof f.dispatch.id,
        ownerDispatchId: 'ctx_setup' as typeof f.dispatch.id,
        sessionId: 'setup-session',
        processIncarnation: 'setup-incarnation'
      })
      f.setCloseHandler((target) => {
        expect(target.id).toBe('terminal-resource-1')
        expect(f.repo.get(f.dispatch.id)?.state).toBe('stopping')
        expect(f.core.getDispatch(f.dispatch.id).consumerGeneration).toBe(2)
        expect(f.core.getTask(f.task.id).status).toBe('blocked')
        expect(f.closeQuestionCalls).toContain(f.dispatch.id)
      })

      const result = await f.lifecycle.stop(controlParams(f.dispatch.id, 'stop-one'), f.caller)

      expect(result.state).toBe('stopped')
      expect(f.closed).toHaveLength(1)
      expect(f.closed[0]).toMatchObject({ id: 'terminal-resource-1', sessionId: 'worker-session', processIncarnation: 'incarnation-1' })
      expect(f.repo.get(f.dispatch.id)?.state).toBe('stopped')
      expect(f.core.getTask(f.task.id).status).toBe('blocked')
      expect(f.closeQuestionCalls).toEqual([f.dispatch.id])
    } finally {
      f.close()
    }
  })
  test('service stop requires the exact owned identity before fencing or closing', async () => {
    const f = createLifecycleFixture({ state: 'ready' })
    const service = {
      kind: 'service',
      pluginId: 'quirky.orchestration-test',
      runId: f.dispatch.runId,
      authority: 'kernel_plugin'
    } as const
    try {
      await expect(f.lifecycle.stop(controlParams(f.dispatch.id, 'service-stop-missing-identity'), service))
        .rejects.toThrow('exact expected terminal identity')
      expect(f.repo.get(f.dispatch.id)?.state).toBe('ready')
      expect(f.core.getDispatch(f.dispatch.id).status).toBe('dispatched')
      expect(f.closed).toHaveLength(0)

      const result = await f.lifecycle.stop({
        ...controlParams(f.dispatch.id, 'service-stop-exact'),
        expectedIdentity: { sessionId: f.worker.sessionId!, processIncarnation: f.worker.processIncarnation! }
      }, service)

      expect(result.state).toBe('stopped')
      expect(f.closed).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  test('a mismatched Run alias is rejected before worker fencing', async () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      await expect(f.lifecycle.stop({
        ...controlParams(f.dispatch.id, 'stop-wrong-run'),
        runId: 'run_other' as typeof f.dispatch.runId
      }, f.caller)).rejects.toThrow('does not own this Dispatch')

      expect(f.repo.get(f.dispatch.id)?.state).toBe('ready')
      expect(f.core.getTask(f.task.id).status).toBe('dispatched')
      expect(f.closed).toHaveLength(0)
    } finally {
      f.close()
    }
  })

  test('ambiguous stop remains stop_unknown and duplicate stops issue one close', async () => {
    const f = createLifecycleFixture({ state: 'ready', closeResult: { closed: false, reason: 'endpoint did not confirm kill' } })
    try {
      const results = await Promise.all([
        f.lifecycle.stop(controlParams(f.dispatch.id, 'stop-one'), f.caller),
        f.lifecycle.stop(controlParams(f.dispatch.id, 'stop-two'), f.caller)
      ])

      expect(f.closed).toHaveLength(1)
      expect(f.repo.get(f.dispatch.id)?.state).toBe('stop_unknown')
      expect(results[0].state).toBe('stop_unknown')
      expect(results[1].state).toBe('stop_unknown')
      expect(f.core.getTask(f.task.id).status).toBe('blocked')
      expect(f.core.getDispatch(f.dispatch.id).status).toBe('dispatched')
      expect(f.lifecycle.hasLiveForTask(f.store, f.task.id)).toBe(true)
    } finally {
      f.close()
    }
  })

  test('abandon fences and retains possible live resources without a process action', async () => {
    const f = createLifecycleFixture({ state: 'start_unknown' })
    try {
      const result = await f.lifecycle.abandon(controlParams(f.dispatch.id, 'abandon-one'), f.caller)

      expect(result).toMatchObject({ state: 'abandoned', processAction: 'none' })
      expect(result.warning).toContain('Possibly-live resources were retained')
      expect(f.closed).toHaveLength(0)
      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ releaseState: 'retained', retainedReason: 'abandoned' })
      expect(f.core.getTask(f.task.id).status).toBe('blocked')
    } finally {
      f.close()
    }
  })

  test('unexpected exact exit fails infrastructure once and emits one high-priority escalation', () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.lifecycle.onExit(f.worker.sessionId!, f.worker.processIncarnation, 'exited', 17)
      f.lifecycle.onExit(f.worker.sessionId!, f.worker.processIncarnation, 'exited', 17)

      expect(f.repo.get(f.dispatch.id)).toMatchObject({ state: 'failed', stage: 'process_exited' })
      expect(f.core.getDispatch(f.dispatch.id)).toMatchObject({ status: 'failed', failureCount: 1, lastFailure: 'process_exited' })
      expect(f.core.getTask(f.task.id).status).toBe('ready')
      expect(f.statusEmissions).toHaveLength(1)
      expect(f.statusEmissions[0]).toMatchObject({ high: true })
    } finally {
      f.close()
    }
  })
  test('an old incarnation exit cannot settle a replacement worker', () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.repo.update(f.dispatch.id, { processIncarnation: 'replacement-incarnation' }, 'ready')
      f.repo.putResource({
        ...f.repo.resource(f.dispatch.id)!,
        processIncarnation: 'replacement-incarnation'
      })

      f.lifecycle.onExit(f.worker.sessionId!, 'incarnation-1', 'exited', 17)

      expect(f.repo.get(f.dispatch.id)).toMatchObject({ state: 'ready', processIncarnation: 'replacement-incarnation' })
      expect(f.core.getDispatch(f.dispatch.id).status).toBe('dispatched')
      expect(f.statusEmissions).toHaveLength(0)
    } finally {
      f.close()
    }
  })

  test('worker state changes made by a report hook roll back with the shared SQLite transaction', () => {
    const f = createLifecycleFixture({ state: 'starting' })
    try {
      expect(() => f.store.transaction(() => {
        f.lifecycle.acceptReport(f.store, {
          dispatchId: f.dispatch.id,
          outcome: 'succeeded',
          caller: exactCaller(f.worker),
          at: '2026-10-27T00:00:01.000Z'
        })
        throw new Error('rollback after worker transition')
      })).toThrow('rollback after worker transition')

      expect(f.repo.get(f.dispatch.id)?.state).toBe('starting')
    } finally {
      f.close()
    }
  })

  test('heartbeat observation is recorded only for a ready exact active attempt', () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.lifecycle.recordHeartbeat(f.store, { dispatchId: f.dispatch.id, caller: f.caller, at: '2026-10-27T00:00:01.000Z' })
      expect(f.observationCount(f.dispatch.id, 'heartbeat')).toBe(1)

      f.repo.update(f.dispatch.id, { state: 'stopping' }, 'ready')
      f.lifecycle.recordHeartbeat(f.store, { dispatchId: f.dispatch.id, caller: f.caller, at: '2026-10-27T00:00:02.000Z' })
      expect(f.observationCount(f.dispatch.id, 'heartbeat')).toBe(1)
    } finally {
      f.close()
    }
  })

  test('retain cannot downgrade a release already committed to releasing', async () => {
    const f = createLifecycleFixture({ state: 'succeeded' })
    try {
      f.repo.putResource({
        ...f.repo.resource(f.dispatch.id)!,
        releaseState: 'releasing',
        archiveSource: 'terminal_tail',
        archiveStatus: 'captured'
      })
      const result = await f.lifecycle.retain(controlParams(f.dispatch.id, 'retain-one'), f.caller)

      expect(f.repo.resource(f.dispatch.id)).toMatchObject({ releaseState: 'releasing', ownershipState: 'owned' })
      expect(result.state).toBe('releasing')
      expect(f.closed).toHaveLength(0)
    } finally {
      f.close()
    }
  })
  test('task reset removes worker records without closing tracked processes', () => {
    const f = createLifecycleFixture({ state: 'ready' })
    try {
      f.repo.putArchive({
        dispatchId: f.dispatch.id,
        resourceId: 'terminal-resource-1',
        kind: 'terminal_tail',
        content: 'saved output',
        sourceIdentity: `${f.worker.sessionId}:${f.worker.processIncarnation}`,
        status: 'captured',
        createdAt: '2026-10-27T00:00:00.000Z'
      })
      f.lifecycle.reset(f.store, 'messages', '2026-10-27T00:00:01.000Z')
      expect(f.repo.get(f.dispatch.id)).not.toBeNull()
      expect(f.repo.archive(f.dispatch.id)).not.toBeNull()

      f.lifecycle.reset(f.store, 'tasks', '2026-10-27T00:00:02.000Z')

      expect(f.repo.get(f.dispatch.id)).toBeNull()
      expect(f.repo.resourceBySession(f.worker.sessionId!)).toBeNull()
      expect(f.repo.archive(f.dispatch.id)).toBeNull()
      expect(f.closed).toHaveLength(0)
    } finally {
      f.close()
    }
  })
})
