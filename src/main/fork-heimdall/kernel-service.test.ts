import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { HeimdallDatabase } from './database'
import { HeimdallEnrollmentStore } from './enrollment-store'
import {
  action,
  authorized,
  enrollmentInput,
  harness,
  kind,
  runningDispatch,
  type World
} from './kernel-service-test-harness'
import {
  heimdallMailboxAddressForDispatch,
  heimdallMailboxAddressForRun,
  notifyHeimdallMailboxArrival,
  setHeimdallMailboxWake
} from './mailbox-wake-registry'
import {
  clearForcedHandoffPolicy,
  getForcedHandoffPolicy
} from '../fork-ask-question-tool/forced-handoff-policy'

vi.mock('electron', () => ({}))

afterEach(() => {
  setHeimdallMailboxWake(null)
  clearForcedHandoffPolicy()
})

describe('Heimdall kernel service', () => {
  it('settles on worker_done even while a worker process is live', async () => {
    let watcherId = ''
    const { service, ledgerStore, budgetClock, orchestration } = await harness({
      mailbox: () => [
        {
          eventId: 'mail-done',
          watcherId,
          atMs: 20,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          source: {
            kind: 'orchestration',
            sequence: 1,
            messageId: 'message-done',
            deliveryId: 'delivery-1'
          },
          payload: {
            type: 'worker_done',
            body: 'complete',
            payload: JSON.stringify({ dispatchId: 'dispatch-1', outcome: 'succeeded' })
          }
        }
      ]
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    budgetClock.open(watcherId, 'worker-dispatched')
    await service.reconcileForTesting(watcherId)
    expect(budgetClock.current(watcherId)).toBeNull()
    expect(orchestration.readDispatch).not.toHaveBeenCalled()
    expect(service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt', state: 'settled', effect: 'landed' })
      ])
    )
  })

  it('parks a worker question, records its message id, and pauses budget without losing dispatch identity', async () => {
    let watcherId = ''
    const { service, ledgerStore, budgetClock, orchestration } = await harness({
      mailbox: () => [
        {
          eventId: 'mail-question',
          watcherId,
          atMs: 20,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          source: {
            kind: 'orchestration',
            sequence: 1,
            messageId: 'message-question',
            deliveryId: 'delivery-1'
          },
          payload: {
            type: 'question',
            body: 'Which branch?',
            payload: JSON.stringify({ dispatchId: 'dispatch-1' })
          }
        }
      ]
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    budgetClock.open(watcherId, 'worker-dispatched')
    await service.reconcileForTesting(watcherId)
    expect(budgetClock.current(watcherId)).toBeNull()
    expect(orchestration.readDispatch).not.toHaveBeenCalled()
    expect((await service.list())[0]).toMatchObject({
      status: {
        state: 'parked',
        parkReason: { kind: 'worker-question', messageId: 'message-question' }
      }
    })
    expect(service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt', state: 'running', dispatchId: 'dispatch-1' }),
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'worker-question',
          reason: expect.stringContaining('message-question')
        })
      ])
    )
    const parkedEntry = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: parkedEntry.target,
        expectedOwner: parkedEntry.ownerFence,
        command: {
          kind: 'answer-question',
          messageId: 'message-question',
          body: 'Use the current branch'
        }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(orchestration.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId }),
      'message-question',
      'Use the current branch'
    )
    await service.reconcileForTesting(watcherId)
    expect((await service.fleet()).entries[0]).toMatchObject({
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: true }, status: { state: 'watching' } }
    })
    const latestQuestion = service
      .ledger(watcherId)
      .entries.findLast(
        (entry) => entry.kind === 'escalation' && entry.escalationKind === 'worker-question'
      )
    expect(latestQuestion).toMatchObject({ status: 'resolved' })
  })

  it('parks once for a durable worker escalation and resumes after operator acknowledgement', async () => {
    let watcherId = ''
    const { service, ledgerStore, budgetClock, orchestration } = await harness({
      mailbox: () => [
        {
          eventId: 'mail-escalation',
          watcherId,
          atMs: 20,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          source: {
            kind: 'orchestration',
            sequence: 1,
            messageId: 'message-escalation',
            deliveryId: 'delivery-escalation'
          },
          payload: {
            type: 'escalation',
            subject: 'Blocked',
            body: 'Credentials are required',
            payload: { dispatchId: 'dispatch-1' }
          }
        }
      ]
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    budgetClock.open(watcherId, 'worker-dispatched')

    await service.reconcileForTesting(watcherId)
    expect(budgetClock.current(watcherId)).toBeNull()
    expect(orchestration.readDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId }),
      'dispatch-1'
    )
    expect((await service.fleet()).entries[0]).toMatchObject({
      entry: {
        enrollment: { enabled: false },
        status: {
          state: 'parked',
          reason: 'Blocked: Credentials are required',
          parkReason: {
            kind: 'worker-escalation',
            escalationId: 'worker-escalation:dispatch-1:message-escalation',
            messageId: 'message-escalation'
          }
        }
      }
    })

    await service.reconcileForTesting(watcherId)
    const openRevisions = service
      .ledger(watcherId)
      .entries.filter(
        (entry) =>
          entry.kind === 'escalation' &&
          entry.escalationKind === 'worker-escalation' &&
          entry.status === 'open'
      )
    expect(openRevisions).toHaveLength(1)
    expect(budgetClock.current(watcherId)).toBeNull()

    const parkedEntry = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: parkedEntry.target,
        expectedOwner: parkedEntry.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    const revisions = service
      .ledger(watcherId)
      .entries.filter(
        (entry): entry is Extract<LedgerEntry, { kind: 'escalation' }> =>
          entry.kind === 'escalation' && entry.escalationKind === 'worker-escalation'
      )
    expect(revisions).toHaveLength(2)
    expect(new Set(revisions.map((entry) => entry.escalationId)).size).toBe(1)
    expect(revisions.at(-1)).toMatchObject({ status: 'acknowledged', foldCount: 2 })
    expect(
      service
        .ledger(watcherId)
        .entries.findLast(
          (entry) =>
            entry.kind === 'escalation' && entry.escalationKind === 'park-worker-escalation'
        )
    ).toMatchObject({ status: 'acknowledged' })

    await service.reconcileForTesting(watcherId)
    expect(budgetClock.current(watcherId)).not.toBeNull()
    expect((await service.fleet()).entries[0]).toMatchObject({
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: true }, status: { state: 'watching' } }
    })
  })

  it('keeps polling after a disarm that leaves work in flight so the lease is released', async () => {
    const { service, ledgerStore, leaseStore, schedule } = await harness()
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput({ wallClockActiveMs: 100_000, turns: 100 }))
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }

    const active = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    // the in-flight branch deliberately holds the lease so the worker can still be reconciled
    expect(leaseStore.release).not.toHaveBeenCalled()
    expect((await service.list())[0]).toMatchObject({
      status: { enabled: false, state: 'disabled', phase: 'disarmed' }
    })

    schedule.mockClear()
    await service.reconcileForTesting(watcherId)
    expect(schedule).toHaveBeenCalled()
  })
  it('honors explicit not-landed executor evidence but pins an untyped throw as indeterminate', async () => {
    const run = async (thrown: unknown) => {
      const { service } = await harness()
      service.registerKind(
        kind({
          decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
          execute: async () => {
            throw thrown
          }
        })
      )
      const result = await service.enroll(enrollmentInput())
      if (result.status !== 'enrolled') {
        throw new Error('expected enrollment')
      }
      await service.reconcileForTesting(result.entry.enrollment.watcherId)
      return service
        .ledger(result.entry.enrollment.watcherId)
        .entries.findLast((entry) => entry.kind === 'attempt' && entry.state === 'settled')
    }

    await expect(
      run({ effect: 'not-landed', reason: 'precondition-refused' })
    ).resolves.toMatchObject({
      effect: 'not-landed',
      reason: 'precondition-refused'
    })
    await expect(run(new Error('transport reset'))).resolves.toMatchObject({
      effect: 'indeterminate',
      reason: 'transport reset'
    })
  })

  it('writes recovery expectations before execution and resolves a crashed external effect without replay', async () => {
    const { service } = await harness()
    const externalAction: KernelAction = {
      ...action('revision-1'),
      visibility: 'external',
      expectedState: { target: 'review-1', before: 'before-1' }
    }
    const execute = vi.fn(
      async (
        _action: KernelAction,
        context: Parameters<WatcherKind<World, KernelAction>['execute']>[1]
      ) => {
        expect(context.ledger.entries).toContainEqual(
          expect.objectContaining({
            kind: 'attempt',
            state: 'attempted',
            expectedBefore: 'before-1',
            expectedAfter: 'after-1'
          })
        )
        throw new Error('process lost after external effect')
      }
    )
    const resolveOutcome = vi.fn(() => ({ effect: 'landed' as const }))
    service.registerKind(
      kind({
        decide: () => ({ action: externalAction }),
        attemptExpectation: () => ({
          expectedBefore: 'before-1',
          expectedAfter: 'after-1'
        }),
        execute,
        resolveOutcome
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId

    await service.reconcileForTesting(watcherId)
    expect(service.ledger(watcherId).entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'settled',
        effect: 'indeterminate',
        expectedBefore: 'before-1',
        expectedAfter: 'after-1'
      })
    )

    await service.reconcileForTesting(watcherId)
    expect(resolveOutcome).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(service.ledger(watcherId).entries).toContainEqual(
      expect.objectContaining({ kind: 'attempt-resolved', effect: 'landed' })
    )
  })

  it('does not settle an attempt twice when dispatch and executor report the same outcome', async () => {
    const outcomes = [
      {
        dispatch: {
          status: 'refused' as const,
          reason: 'placement-unavailable' as const,
          detail: 'workspace unavailable'
        },
        effect: 'not-landed'
      },
      {
        dispatch: {
          status: 'indeterminate' as const,
          requestId: 'heimdall-request'
        },
        effect: 'indeterminate'
      }
    ]
    for (const expected of outcomes) {
      const { service, orchestration } = await harness()
      orchestration.dispatchWorker = vi.fn(async () => expected.dispatch)
      service.registerKind(
        kind({
          decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
          execute: async (_action, context) => {
            const result = await context.dispatchWorker({ spec: 'Fix the review.' })
            return result.status === 'refused'
              ? { effect: 'not-landed' as const, reason: result.reason }
              : { effect: 'indeterminate' as const, reason: 'operation-unknown' }
          }
        })
      )
      const result = await service.enroll(enrollmentInput())
      if (result.status !== 'enrolled') {
        throw new Error('expected enrollment')
      }

      await service.reconcileForTesting(result.entry.enrollment.watcherId)

      const settled = service
        .ledger(result.entry.enrollment.watcherId)
        .entries.filter(
          (entry): entry is Extract<LedgerEntry, { kind: 'attempt' }> =>
            entry.kind === 'attempt' && entry.state === 'settled'
        )
      expect(settled).toHaveLength(1)
      expect(settled.find((entry) => entry.effect === expected.effect)).toMatchObject({
        effect: expected.effect
      })
    }
  })

  it('retries an absent write-ahead receipt only after a fresh gated re-decision', async () => {
    const { service, orchestration } = await harness()
    orchestration.dispatchWorker = vi
      .fn()
      .mockRejectedValueOnce(new Error('crash before receipt'))
      .mockResolvedValueOnce({ status: 'dispatched', dispatchId: 'dispatch-recovered' })
    orchestration.recoverDispatch = vi.fn(async () => ({ status: 'absent' as const }))
    service.registerKind(
      kind({
        decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
        execute: async (_action, context) => {
          const result = await context.dispatchWorker({ spec: 'Fix the review.' })
          return result.status === 'dispatched'
            ? { effect: 'landed' as const }
            : { effect: 'indeterminate' as const, reason: 'dispatch-not-confirmed' }
        }
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId

    await service.reconcileForTesting(watcherId)
    await service.reconcileForTesting(watcherId)

    expect(orchestration.recoverDispatch).toHaveBeenCalledOnce()
    expect(orchestration.dispatchWorker).toHaveBeenCalledTimes(2)
    const attempts = service.ledger(watcherId).entries.filter((entry) => entry.kind === 'attempt')
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(1)
    expect(attempts).toContainEqual(
      expect.objectContaining({
        state: 'running',
        dispatchId: 'dispatch-recovered'
      })
    )
    expect(service.ledger(watcherId).entries.filter((entry) => entry.kind === 'turn')).toHaveLength(
      1
    )
  })

  it('quarantines malformed persisted payload JSON without blocking valid watchers', async () => {
    const { service, database, enrollmentStore } = await harness()
    const base = {
      ...authorized(enrollmentInput()),
      enabled: true,
      paused: false,
      commandRevision: 0,
      coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    }
    enrollmentStore.insert({ ...base, watcherId: 'malformed-watcher' })
    enrollmentStore.insert({
      ...base,
      watcherId: 'valid-watcher',
      workspaceKey: 'local::/workspace/review-2',
      worktreeId: 'worktree-2',
      workspacePath: '/workspace/review-2'
    })
    const rawPayload = '{"label":"truncated"'
    database
      .connection()
      .prepare('UPDATE heimdall_enrollment SET kind_payload_json = ? WHERE watcher_id = ?')
      .run(rawPayload, 'malformed-watcher')
    const read = vi.fn(kind().read)
    service.registerKind(kind({ read }))

    const listed = await service.list()
    await service.reconcileForTesting('valid-watcher')
    const malformedReport = await service.debugReport('malformed-watcher')

    expect(listed).toHaveLength(2)
    expect(
      listed.find((entry) => entry.enrollment.watcherId === 'malformed-watcher')
    ).toMatchObject({
      enrollment: { kindPayload: rawPayload },
      status: {
        enabled: false,
        state: 'escalated',
        phase: 'invalid-kind-payload'
      }
    })
    expect(malformedReport).toMatchObject({
      malformedPayload: true,
      status: { state: 'escalated', phase: 'invalid-kind-payload' },
      runner: null,
      workers: [],
      workersError: null
    })
    expect(
      service
        .ledger('malformed-watcher')
        .entries.filter(
          (entry) => entry.kind === 'escalation' && entry.escalationKind === 'invalid-kind-payload'
        )
    ).toHaveLength(1)
    expect(read).toHaveBeenCalled()
    expect(
      database
        .connection()
        .prepare('SELECT kind_payload_json FROM heimdall_enrollment WHERE watcher_id = ?')
        .get('malformed-watcher')
    ).toEqual({ kind_payload_json: rawPayload })
  })

  it('allocates strictly increasing fleet generations when the clock does not advance', async () => {
    const { service } = await harness()

    const first = await service.fleet()
    const second = await service.fleet()

    expect(first.generatedAtMs).toBe(100)
    expect(second.generatedAtMs).toBe(101)
  })

  it('keeps per-watcher fleet stamps stable while advancing enrollment and ledger changes', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(
      kind({
        authorizeEnrollment: async (input) => ({
          ...authorized(input),
          workspaceKey: `local::/workspace/${input.repoId}`,
          workspacePath: `/workspace/${input.repoId}`
        })
      })
    )
    const enrolledA = await service.enroll({
      ...enrollmentInput(),
      repoId: 'repo-a',
      worktreeId: 'worktree-a'
    })
    const enrolledB = await service.enroll({
      ...enrollmentInput(),
      repoId: 'repo-b',
      worktreeId: 'worktree-b'
    })
    if (enrolledA.status !== 'enrolled' || enrolledB.status !== 'enrolled') {
      throw new Error('expected both watchers to enroll')
    }
    const watcherA = enrolledA.entry.enrollment.watcherId
    const watcherB = enrolledB.entry.enrollment.watcherId
    const initial = await service.fleet()
    const initialA = initial.entries.find((entry) => entry.target.watcherId === watcherA)!
    const initialB = initial.entries.find((entry) => entry.target.watcherId === watcherB)!
    const repeated = await service.fleet()
    expect(
      repeated.entries.find((entry) => entry.target.watcherId === watcherA)?.observedAtMs
    ).toBe(initialA.observedAtMs)
    expect(
      repeated.entries.find((entry) => entry.target.watcherId === watcherB)?.observedAtMs
    ).toBe(initialB.observedAtMs)

    await service.command({
      target: initialA.target,
      expectedOwner: initialA.ownerFence,
      command: { kind: 'pause' }
    })
    const afterPause = await service.fleet()
    const pausedA = afterPause.entries.find((entry) => entry.target.watcherId === watcherA)!
    const unchangedB = afterPause.entries.find((entry) => entry.target.watcherId === watcherB)!
    expect(pausedA.observedAtMs).toBeGreaterThan(initialA.observedAtMs)
    expect(unchangedB.observedAtMs).toBe(initialB.observedAtMs)

    ledgerStore.append({
      eventId: 'watcher-a-ledger-only',
      watcherId: watcherA,
      atMs: 101,
      origin: 'client',
      class: 'observation',
      kind: 'client-observation',
      what: 'ledger-only-change'
    })
    const afterLedger = await service.fleet()
    expect(
      afterLedger.entries.find((entry) => entry.target.watcherId === watcherA)?.observedAtMs
    ).toBeGreaterThan(pausedA.observedAtMs)
    expect(
      afterLedger.entries.find((entry) => entry.target.watcherId === watcherB)?.observedAtMs
    ).toBe(initialB.observedAtMs)
  })

  it('fences an in-flight decision with a durable pause before its commit point', async () => {
    let enterPreflight!: () => void
    const enteredPreflight = new Promise<void>((resolve) => {
      enterPreflight = resolve
    })
    let finishPreflight!: () => void
    const preflightFinished = new Promise<void>((resolve) => {
      finishPreflight = resolve
    })
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const { service, leaseStore } = await harness()
    service.registerKind(
      kind({
        decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
        preflight: async () => {
          enterPreflight()
          await preflightFinished
          return { verdict: 'allow' as const }
        },
        execute
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    const row = (await service.fleet()).entries[0]!

    const reconciliation = service.reconcileForTesting(watcherId)
    await enteredPreflight
    const pause = service.command({
      target: row.target,
      expectedOwner: row.ownerFence,
      command: { kind: 'pause' }
    })
    await Promise.resolve()
    await Promise.resolve()
    finishPreflight()
    await reconciliation
    await expect(pause).resolves.toMatchObject({ status: 'applied' })

    expect(execute).not.toHaveBeenCalled()
    expect(leaseStore.release).toHaveBeenCalledWith(
      result.entry.enrollment.workspaceKey,
      'test-holder',
      1
    )
    expect((await service.fleet()).entries[0]).toMatchObject({
      paused: true,
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: true, budget: enrollmentInput().budget } }
    })
    expect(service.ledger(watcherId).entries.some((entry) => entry.kind === 'attempt')).toBe(false)
  })
  it('blocks worker dispatch when pause is requested at an async pre-dispatch boundary', async () => {
    let enterBoundary!: () => void
    const enteredBoundary = new Promise<void>((resolve) => {
      enterBoundary = resolve
    })
    let releaseBoundary!: () => void
    const boundaryReleased = new Promise<void>((resolve) => {
      releaseBoundary = resolve
    })
    const { service, orchestration, leaseStore } = await harness()
    leaseStore.describeLocation = () => ({
      executionHostId: 'local',
      leaseDirectory: '/workspace/review-1/.quirky/heimdall/lease',
      pathSeparator: '/'
    })
    service.registerKind(
      kind({
        decide: (snapshot) => ({ action: action(snapshot.contentIdentity) }),
        execute: async (_action, context) => {
          enterBoundary()
          await boundaryReleased
          await context.lease.assertHeld()
          await context.dispatchWorker({ spec: 'must-not-dispatch' })
          return { effect: 'landed' as const }
        }
      })
    )
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const row = (await service.fleet()).entries[0]!
    const reconciliation = service.reconcileForTesting(row.target.watcherId)
    await enteredBoundary
    const pause = service.command({
      target: row.target,
      expectedOwner: row.ownerFence,
      command: { kind: 'pause' }
    })
    await Promise.resolve()
    await Promise.resolve()
    const pendingReport = await service.debugReport(row.target.watcherId)
    expect(pendingReport).toMatchObject({
      pendingControlOperation: true,
      runner: { controlPending: 'pause', actionInFlight: true }
    })
    expect(pendingReport.pointers).toContainEqual({
      role: 'lease-holder',
      host: 'local',
      path: '/workspace/review-1/.quirky/heimdall/lease/epoch-1/holder.json',
      status: 'resolved'
    })
    releaseBoundary()
    await reconciliation
    await expect(pause).resolves.toMatchObject({ status: 'applied' })

    expect(orchestration.dispatchWorker).not.toHaveBeenCalled()
    expect((await service.fleet()).entries[0]).toMatchObject({
      paused: true,
      entry: { status: { state: 'held', phase: 'paused' } }
    })
  })

  it('preserves consumed budget across pause, policy adjustment, and resume', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    ledgerStore.append({
      eventId: 'turn-1',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'planner',
      dispatchId: 'dispatch-1'
    })
    const initial = (await service.fleet()).entries[0]!
    await service.command({
      target: initial.target,
      expectedOwner: initial.ownerFence,
      command: { kind: 'pause' }
    })
    const paused = (await service.fleet()).entries[0]!
    await service.command({
      target: paused.target,
      expectedOwner: paused.ownerFence,
      command: {
        kind: 'adjust-budget',
        budget: { wallClockActiveMs: 120_000, turns: 8 }
      }
    })
    const adjusted = (await service.fleet()).entries[0]!

    expect(adjusted).toMatchObject({
      paused: true,
      ownerFence: { revision: 2 },
      entry: {
        enrollment: { budget: { wallClockActiveMs: 120_000, turns: 8 } },
        status: { budget: { turns: 1 } }
      }
    })
    await service.command({
      target: adjusted.target,
      expectedOwner: adjusted.ownerFence,
      command: { kind: 'resume' }
    })
    expect((await service.fleet()).entries[0]).toMatchObject({
      paused: false,
      ownerFence: { revision: 3 },
      entry: {
        enrollment: { budget: { wallClockActiveMs: 120_000, turns: 8 } },
        status: { budget: { turns: 1 } }
      }
    })
  })

  it('keeps an adjusted budget park durable until explicit resume', async () => {
    const parked = await harness()
    const registeredKind = kind()
    parked.service.registerKind(registeredKind)
    const enrolled = await parked.service.enroll(
      enrollmentInput({ wallClockActiveMs: null, turns: 1 })
    )
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    parked.ledgerStore.append({
      eventId: 'budget-turn',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'planner',
      dispatchId: 'budget-dispatch'
    })
    await parked.service.reconcileForTesting(watcherId)
    const exhausted = (await parked.service.fleet()).entries[0]!
    await expect(
      parked.service.command({
        target: exhausted.target,
        expectedOwner: exhausted.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })
    await parked.service.command({
      target: exhausted.target,
      expectedOwner: exhausted.ownerFence,
      command: {
        kind: 'adjust-budget',
        budget: { wallClockActiveMs: null, turns: 2 }
      }
    })
    await parked.service.stopForShutdown()

    const restarted = await harness({ directory: parked.directory })
    restarted.service.registerKind(registeredKind)
    const stillParked = (await restarted.service.fleet()).entries[0]!
    expect(stillParked).toMatchObject({
      ownerFence: { revision: 1 },
      entry: {
        enrollment: { enabled: false, budget: { wallClockActiveMs: null, turns: 2 } },
        status: {
          state: 'parked',
          parkReason: { kind: 'budget', exhaustion: { kind: 'turns' } },
          budget: { turns: 1, exhausted: null }
        }
      }
    })
    await expect(
      restarted.service.command({
        target: stillParked.target,
        expectedOwner: stillParked.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect((await restarted.service.fleet()).entries[0]).toMatchObject({
      ownerFence: { revision: 2 },
      entry: { enrollment: { enabled: true }, status: { state: 'watching', phase: 'resumed' } }
    })
    await restarted.service.stopForShutdown()
  })

  it('retains pause across storage restart and refuses stale revision or owner fences', async () => {
    const { service, directory } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const row = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'pause' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await expect(
      service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'stale-revision' })
    await expect(
      service.command({
        target: row.target,
        expectedOwner: { ...row.ownerFence, workspaceKey: 'local::/different-worktree' },
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'owner-conflict' })

    await service.stopForShutdown()
    const reopenedDatabase = new HeimdallDatabase(directory)
    const reopenedEnrollments = new HeimdallEnrollmentStore(reopenedDatabase)
    expect(reopenedEnrollments.get(row.target.watcherId)).toMatchObject({
      enabled: true,
      paused: true,
      commandRevision: 1,
      budget: enrollmentInput().budget
    })
    reopenedDatabase.close()
  })
})

describe('Heimdall kernel service mailbox wake', () => {
  function liveEnrollmentRow(
    watcherId: string,
    overrides: { orchestrationRunId?: string | null; owner?: { agent: string } } = {}
  ) {
    return {
      ...authorized(enrollmentInput()),
      watcherId,
      enabled: true,
      paused: false,
      commandRevision: 0,
      coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
      orchestrationRunId: overrides.orchestrationRunId ?? null,
      ...(overrides.owner ? { owner: overrides.owner } : {}),
      createdAtMs: 1,
      terminalAtMs: null
    }
  }

  it('wakes the runner enrolled on the matching run address', async () => {
    const { service, enrollmentStore, schedule } = await harness()
    service.registerKind(kind())
    enrollmentStore.insert(liveEnrollmentRow('watcher-run', { orchestrationRunId: 'run-1' }))

    service.start()
    schedule.mockClear()
    notifyHeimdallMailboxArrival(heimdallMailboxAddressForRun('run-1'), 'worker_done')

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 0)
  })

  it('does not wake a runner enrolled on a different run', async () => {
    const { service, enrollmentStore, schedule } = await harness()
    service.registerKind(kind())
    enrollmentStore.insert(liveEnrollmentRow('watcher-run', { orchestrationRunId: 'run-1' }))

    service.start()
    schedule.mockClear()
    notifyHeimdallMailboxArrival(heimdallMailboxAddressForRun('run-2'), 'worker_done')

    expect(schedule).not.toHaveBeenCalled()
  })

  it('wakes the runner holding a matching in-flight dispatch', async () => {
    const { service, enrollmentStore, ledgerStore, schedule } = await harness()
    service.registerKind(kind())
    enrollmentStore.insert(liveEnrollmentRow('watcher-dispatch'))
    for (const entry of runningDispatch('watcher-dispatch')) {
      ledgerStore.append(entry)
    }

    service.start()
    schedule.mockClear()
    notifyHeimdallMailboxArrival(heimdallMailboxAddressForDispatch('dispatch-1'), 'worker_done')

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 0)
  })

  it('wakes nobody for a dispatch address with no matching in-flight dispatch', async () => {
    const { service, enrollmentStore, ledgerStore, schedule } = await harness()
    service.registerKind(kind())
    enrollmentStore.insert(liveEnrollmentRow('watcher-dispatch'))
    for (const entry of runningDispatch('watcher-dispatch')) {
      ledgerStore.append(entry)
    }

    service.start()
    schedule.mockClear()
    notifyHeimdallMailboxArrival(
      heimdallMailboxAddressForDispatch('dispatch-unrelated'),
      'worker_done'
    )

    expect(schedule).not.toHaveBeenCalled()
  })

  it("forces worker questions to an owned watcher's run and no other", async () => {
    const { service, enrollmentStore } = await harness()
    service.registerKind(kind())
    enrollmentStore.insert(
      liveEnrollmentRow('watcher-owned', {
        orchestrationRunId: 'run-owned',
        owner: { agent: 'claude' }
      })
    )
    enrollmentStore.insert({
      ...liveEnrollmentRow('watcher-unowned', { orchestrationRunId: 'run-free' }),
      workspaceKey: 'local::/workspace/review-2'
    })

    // The desktop app never calls start(); loading the kernel through any read must arm the policy.
    await service.list()
    const policy = getForcedHandoffPolicy()

    expect(policy?.isForcedRun('run-owned')).toBe(true)
    expect(policy?.isForcedRun('run-free')).toBe(false)
    expect(policy?.isForcedRun('run-unknown')).toBe(false)
  })

  it('does not force questions to a paused owned watcher, whose owner cannot answer', async () => {
    const { service, enrollmentStore } = await harness()
    service.registerKind(kind())
    enrollmentStore.insert({
      ...liveEnrollmentRow('watcher-paused', {
        orchestrationRunId: 'run-paused',
        owner: { agent: 'claude' }
      }),
      paused: true
    })

    await service.list()

    expect(getForcedHandoffPolicy()?.isForcedRun('run-paused')).toBe(false)
  })

  it('clears the forced hand-off policy on shutdown', async () => {
    const { service } = await harness()
    service.registerKind(kind())

    service.start()
    expect(getForcedHandoffPolicy()).not.toBeNull()
    await service.stopForShutdown()

    expect(getForcedHandoffPolicy()).toBeNull()
  })
})
