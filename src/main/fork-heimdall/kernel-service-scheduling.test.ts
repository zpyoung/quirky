import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND } from '../../shared/fork-heimdall/budget'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import {
  action,
  authorized,
  enrollmentInput,
  harness,
  kind,
  runningDispatch,
  type World
} from './kernel-service-test-harness'
import { notifyHeimdallMailboxArrival } from './mailbox-wake-registry'

vi.mock('electron', () => ({}))

describe('Heimdall kernel enrollment and scheduling', () => {
  it('refuses duplicate workspaces and remote-host-owned enrollment without mutating a second row', async () => {
    const { service } = await harness()
    service.registerKind(kind())
    const first = await service.enroll(enrollmentInput())
    expect(first.status).toBe('enrolled')
    await expect(service.enroll(enrollmentInput())).resolves.toMatchObject({
      status: 'refused',
      reason: 'duplicate-workspace'
    })

    service.registerKind(
      kind({
        id: 'objective',
        authorizeEnrollment: async (input) => ({
          ...authorized({ ...input, kind: 'hosted-review' }, 'remote_host_service'),
          kind: 'objective'
        })
      })
    )
    await expect(
      service.enroll({ ...enrollmentInput(), kind: 'objective', repoId: 'repo-2' })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'owner-not-executable',
      schedulerOwner: 'remote_host_service'
    })
    expect(await service.list()).toHaveLength(1)
  })

  it('starts a fresh budget generation when enrolling after explicit disarm', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    ledgerStore.append({
      eventId: 'open',
      watcherId,
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-open',
      intervalId: 'interval-1',
      cause: 'action-in-flight'
    })
    ledgerStore.append({
      eventId: 'close',
      watcherId,
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-close',
      intervalId: 'interval-1',
      closeReason: 'settled'
    })
    ledgerStore.append({
      eventId: 'turn',
      watcherId,
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      dispatchId: 'dispatch-old'
    })
    for (const entry of runningDispatch(watcherId)) {
      ledgerStore.append(entry)
    }
    const active = (await service.fleet()).entries.find(
      (entry) => entry.target.watcherId === watcherId
    )!
    await expect(
      service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const rearmed = await service.enroll({
      ...enrollmentInput(),
      capabilities: { write: 'gated' },
      kindPayload: { label: 'Review 1 updated' }
    })
    expect(rearmed.status).toBe('re-armed')
    if (rearmed.status !== 're-armed') {
      throw new Error('expected re-armed enrollment')
    }
    expect(rearmed.entry.enrollment).toMatchObject({
      watcherId,
      budget: { wallClockActiveMs: 100, turns: 2 },
      capabilities: { write: 'gated' },
      kindPayload: { label: 'Review 1 updated' }
    })
    expect(rearmed.entry.status.budget).toEqual({ activeMs: 0, turns: 0, exhausted: null })
    expect(service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: 'open', kind: 'interval-open' }),
        expect.objectContaining({ eventId: 'close', kind: 'interval-close' }),
        expect.objectContaining({ eventId: 'turn', kind: 'turn' }),
        expect.objectContaining({ eventId: 'running-event', kind: 'attempt', state: 'running' }),
        expect.objectContaining({
          kind: 'evidence',
          evidenceKind: HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND,
          payload: { reason: 're-enrollment-after-explicit-disarm' }
        })
      ])
    )
    expect(
      service
        .ledger(watcherId)
        .entries.some((entry) => entry.kind === 'attempt-resolved' || entry.kind === 'terminal')
    ).toBe(false)

    ledgerStore.append({
      eventId: 'new-open',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-open',
      intervalId: 'interval-2',
      cause: 'action-in-flight'
    })
    ledgerStore.append({
      eventId: 'new-close',
      watcherId,
      atMs: 125,
      origin: 'owner',
      class: 'fact',
      kind: 'interval-close',
      intervalId: 'interval-2',
      closeReason: 'settled'
    })
    ledgerStore.append({
      eventId: 'new-turn',
      watcherId,
      atMs: 125,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      dispatchId: 'dispatch-new'
    })
    expect((await service.fleet()).entries[0]?.entry.status.budget).toEqual({
      activeMs: 25,
      turns: 1,
      exhausted: null
    })
  })

  it('preserves consumed usage when re-enrolling an automatically parked watcher', async () => {
    const { service, ledgerStore } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput({ wallClockActiveMs: null, turns: 1 }))
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    ledgerStore.append({
      eventId: 'spent-turn',
      watcherId,
      atMs: 50,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'child',
      dispatchId: 'spent-dispatch'
    })
    await service.reconcileForTesting(watcherId)

    const rearmed = await service.enroll(enrollmentInput())
    expect(rearmed.status).toBe('re-armed')
    if (rearmed.status !== 're-armed') {
      throw new Error('expected re-armed enrollment')
    }
    expect(rearmed.entry.enrollment.budget).toEqual({ wallClockActiveMs: 100, turns: 3 })
    expect(rearmed.entry.status.budget).toEqual({ activeMs: 0, turns: 1, exhausted: null })
    expect(
      service
        .ledger(watcherId)
        .entries.some(
          (entry) =>
            entry.kind === 'evidence' &&
            entry.evidenceKind === HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND
        )
    ).toBe(false)
  })

  it('refuses cross-authority rearm without transferring a disabled watcher', async () => {
    const desktop = await harness()
    desktop.service.registerKind(kind())
    const enrolled = await desktop.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const active = (await desktop.service.fleet()).entries[0]!
    await expect(
      desktop.service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await desktop.service.stopForShutdown()

    const runtime = await harness({
      directory: desktop.directory,
      storageAuthority: 'runtime'
    })
    runtime.service.registerKind(
      kind({
        authorizeEnrollment: async (input) => authorized(input, 'remote_host_service')
      })
    )
    await expect(runtime.service.enroll(enrollmentInput())).resolves.toEqual({
      status: 'refused',
      reason: 'owner-not-executable',
      schedulerOwner: 'local_host_service'
    })
    expect(runtime.enrollmentStore.get(enrolled.entry.enrollment.watcherId)).toMatchObject({
      enabled: false,
      schedulerOwner: 'local_host_service',
      commandRevision: 1
    })
    await runtime.service.stopForShutdown()
  })

  it('retains enrollment and retries when lease acquisition is refused', async () => {
    const { service, schedule } = await harness({
      lease: () => ({ status: 'refused', reason: 'held-by-other', holder: 'other', epoch: 7 })
    })
    service.registerKind(kind())
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    schedule.mockClear()
    await service.reconcileForTesting(result.entry.enrollment.watcherId)
    expect((await service.list())[0]?.enrollment.enabled).toBe(true)
    expect(schedule).toHaveBeenCalled()
  })

  it.each([
    { label: 'git worktree', worktreeId: 'worktree-1' },
    { label: 'folder workspace', worktreeId: null }
  ])(
    'terminates an enrolled $label removed from Quirky without retrying',
    async ({ worktreeId }) => {
      const world = await harness({
        lease: () => ({ status: 'workspace-removed', reason: 'workspace-removed' })
      })
      world.service.registerKind(kind())
      const input = { ...enrollmentInput(), worktreeId }
      const enrolled = await world.service.enroll(input)
      if (enrolled.status !== 'enrolled') {
        throw new Error('expected enrollment')
      }
      const watcherId = enrolled.entry.enrollment.watcherId
      world.schedule.mockClear()
      await world.service.reconcileForTesting(watcherId)

      expect(world.enrollmentStore.get(watcherId)).toMatchObject({
        enabled: false,
        terminalAtMs: 100
      })
      expect(world.service.ledger(watcherId).entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'terminal',
            state: 'workspace-removed',
            reason: 'Workspace removed from Quirky'
          })
        ])
      )
      expect(world.ledgerStore.readTerminalSummary(watcherId)).toMatchObject({
        terminalState: 'workspace-removed',
        reason: 'Workspace removed from Quirky',
        totals: { activeMs: 0, turns: 0, exhausted: null }
      })
      expect((await world.service.list())[0]).toMatchObject({
        status: { state: 'terminal', reason: 'Workspace removed from Quirky', nextPulseAtMs: null }
      })
      expect(world.schedule).not.toHaveBeenCalled()
      await expect(world.service.enroll(input)).resolves.toMatchObject({ status: 'enrolled' })
      await world.service.stopForShutdown()

      const restarted = await harness({ directory: world.directory })
      restarted.service.registerKind(kind())
      restarted.service.resume()
      expect(
        (await restarted.service.list()).find((entry) => entry.enrollment.watcherId === watcherId)
      ).toMatchObject({
        enrollment: { terminalAtMs: 100 },
        status: { state: 'terminal', reason: 'Workspace removed from Quirky' }
      })
      await restarted.service.stopForShutdown()
    }
  )

  it('does not claim a running worker exited when its registered workspace disappears', async () => {
    const world = await harness({
      lease: () => ({ status: 'workspace-removed', reason: 'workspace-removed' })
    })
    world.service.registerKind(kind())
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      world.ledgerStore.append(entry)
    }
    const interval = world.budgetClock.open(watcherId, 'owner-in-flight')
    const close = vi.spyOn(world.budgetClock, 'close')

    await world.service.reconcileForTesting(watcherId)

    expect(world.enrollmentStore.get(watcherId)?.terminalAtMs).toBe(100)
    expect(world.service.ledger(watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt', state: 'running', dispatchId: 'dispatch-1' })
      ])
    )
    expect(close).toHaveBeenCalledWith(interval, 'shutdown')
    expect(world.orchestration.stopWorker).not.toHaveBeenCalled()
    expect(world.orchestration.releaseWorker).not.toHaveBeenCalled()
    await world.service.stopForShutdown()
  })

  it('parks permanent lease configuration failures but retries transient host failures', async () => {
    const permanent = await harness({
      lease: () => ({
        status: 'configuration-error',
        reason: 'Resolved Git authority changed after Heimdall enrollment'
      })
    })
    permanent.service.registerKind(kind())
    const permanentEnrollment = await permanent.service.enroll(enrollmentInput())
    if (permanentEnrollment.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    permanent.schedule.mockClear()
    await permanent.service.reconcileForTesting(permanentEnrollment.entry.enrollment.watcherId)
    expect((await permanent.service.list())[0]).toMatchObject({
      enrollment: { enabled: false },
      status: {
        state: 'parked',
        phase: 'configuration-error',
        reason: 'Resolved Git authority changed after Heimdall enrollment',
        parkReason: {
          kind: 'configuration-error',
          reason: 'Resolved Git authority changed after Heimdall enrollment'
        }
      }
    })
    expect(permanent.schedule).not.toHaveBeenCalled()
    expect(
      permanent.service.ledger(permanentEnrollment.entry.enrollment.watcherId).entries
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'escalation',
          escalationKind: 'park-configuration-error',
          reason: 'Resolved Git authority changed after Heimdall enrollment'
        })
      ])
    )

    const transient = await harness({
      lease: () => ({ status: 'unverifiable', reason: 'host offline' })
    })
    transient.service.registerKind(kind())
    const transientEnrollment = await transient.service.enroll(enrollmentInput())
    if (transientEnrollment.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    transient.schedule.mockClear()
    await transient.service.reconcileForTesting(transientEnrollment.entry.enrollment.watcherId)
    expect((await transient.service.list())[0]).toMatchObject({
      enrollment: { enabled: true },
      status: { state: 'unreachable', phase: 'lease-unverifiable', reason: 'host offline' }
    })
    expect(transient.schedule).toHaveBeenCalled()
  })

  it('restores and dispatch-wakes a disabled watcher with an unresolved attempt', async () => {
    const first = await harness()
    first.service.registerKind(kind())
    const enrolled = await first.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    for (const entry of runningDispatch(watcherId)) {
      first.ledgerStore.append(entry)
    }
    const running = first.service
      .ledger(watcherId)
      .entries.findLast(
        (entry): entry is Extract<LedgerEntry, { kind: 'attempt' }> =>
          entry.kind === 'attempt' && entry.state === 'running'
      )
    if (!running) {
      throw new Error('expected running attempt')
    }
    first.ledgerStore.append({
      ...running,
      eventId: 'settled-before-restart',
      atMs: 12,
      state: 'settled',
      effect: 'indeterminate',
      reason: 'worker outcome pending'
    })
    const active = (await first.service.fleet()).entries[0]!
    await expect(
      first.service.command({
        target: active.target,
        expectedOwner: active.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await first.service.stopForShutdown()

    const restarted = await harness({ directory: first.directory })
    restarted.service.registerKind(kind())
    await restarted.service.list()
    expect(restarted.schedule).toHaveBeenCalled()

    restarted.service.start()
    restarted.schedule.mockClear()
    notifyHeimdallMailboxArrival('dispatch:dispatch-1', 'worker_done')
    expect(restarted.schedule).toHaveBeenCalledWith(expect.any(Function), 0)
    expect(restarted.orchestration.dispatchWorker).not.toHaveBeenCalled()
    await restarted.service.reconcileForTesting(watcherId)
    expect(restarted.orchestration.dispatchWorker).not.toHaveBeenCalled()
    await restarted.service.stopForShutdown()
  })

  it('disposes lease renewal on suspend and still releases the in-flight tick lease', async () => {
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let finishRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    const disposeRenewal = vi.fn()
    const world = await harness({
      lease: () => ({
        status: 'held',
        epoch: 3,
        guard: {
          epoch: 3,
          holder: 'test-holder',
          assertHeld: async () => {},
          renewLoop: () => ({ dispose: disposeRenewal })
        }
      })
    })
    world.service.registerKind(
      kind({
        read: async () => {
          markReadStarted()
          await readGate
          return {
            freshness: 'live',
            contentIdentity: 'revision-1',
            observedAtMs: 1,
            world: { revision: 'revision-1' }
          }
        }
      })
    )
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }

    const tick = world.service.reconcileForTesting(enrolled.entry.enrollment.watcherId)
    await readStarted
    world.service.suspend()
    expect(disposeRenewal).toHaveBeenCalledOnce()
    await expect(
      world.service.debugReport(enrolled.entry.enrollment.watcherId)
    ).resolves.toMatchObject({
      runner: {
        suspended: true,
        leaseEpoch: null,
        leaseRenewalArmed: false
      }
    })

    finishRead()
    await tick
    expect(world.leaseStore.release).toHaveBeenCalledWith(
      enrolled.entry.enrollment.workspaceKey,
      'test-holder',
      3
    )
  })

  it('re-reads live before external action and abandons a cached decision when identity moves', async () => {
    const reads: boolean[] = []
    let pulse = 0
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const snapshots: Snapshot<World>[] = [
      { freshness: 'live', contentIdentity: 'base', observedAtMs: 1, world: { revision: 'base' } },
      { freshness: 'cached', contentIdentity: 'old', observedAtMs: 2, world: { revision: 'old' } },
      { freshness: 'live', contentIdentity: 'new', observedAtMs: 3, world: { revision: 'new' } }
    ]
    const { service } = await harness()
    service.registerKind(
      kind({
        read: async (_enrollment, options) => {
          reads.push(options.fresh)
          return snapshots.shift()!
        },
        decide: (snapshot) => {
          pulse++
          if (pulse === 1) {
            return { action: null, reason: 'initial', considered: [] }
          }
          return { action: action(snapshot.contentIdentity) }
        },
        execute
      })
    )
    const result = await service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    await service.reconcileForTesting(result.entry.enrollment.watcherId)
    await service.reconcileForTesting(result.entry.enrollment.watcherId)
    expect(reads).toEqual([true, false, true])
    expect(execute).not.toHaveBeenCalled()
    expect(service.ledger(result.entry.enrollment.watcherId).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attempt-abandoned', reason: 'workspace-moved' })
      ])
    )
  })

  it('parks on a stop predicate but keeps transient read failures enrolled with backoff', async () => {
    const stopped = await harness()
    const stoppedKind = kind({
      read: async () => ({
        freshness: 'live',
        contentIdentity: 'stop',
        observedAtMs: 1,
        world: { revision: 'stop', stopped: true }
      }),
      stopPredicates: [
        {
          id: 'closed',
          evaluate: (snapshot) =>
            snapshot.world.stopped ? { stop: true, reason: 'review-closed' } : { stop: false }
        }
      ]
    })
    stopped.service.registerKind(stoppedKind)
    const enrolled = await stopped.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    await stopped.service.reconcileForTesting(enrolled.entry.enrollment.watcherId)
    expect((await stopped.service.list())[0]).toMatchObject({
      enrollment: { enabled: false },
      status: { state: 'parked', parkReason: { kind: 'stop-predicate', predicateId: 'closed' } }
    })

    await stopped.service.stopForShutdown()
    const restarted = await harness({ directory: stopped.directory })
    restarted.service.registerKind(stoppedKind)
    const restoredPark = (await restarted.service.fleet()).entries[0]!
    expect(restoredPark).toMatchObject({
      entry: {
        enrollment: { enabled: false },
        status: {
          state: 'parked',
          phase: 'parked',
          reason: 'review-closed',
          parkReason: {
            kind: 'stop-predicate',
            predicateId: 'closed',
            reason: 'review-closed'
          }
        }
      }
    })
    await expect(
      restarted.service.command({
        target: restoredPark.target,
        expectedOwner: restoredPark.ownerFence,
        command: { kind: 'disarm' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const disarmed = (await restarted.service.fleet()).entries[0]!
    expect(disarmed).toMatchObject({
      ownerFence: { revision: 1 },
      entry: { enrollment: { enabled: false }, status: { state: 'disabled' } }
    })
    await expect(
      restarted.service.command({
        target: disarmed.target,
        expectedOwner: disarmed.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })
    await restarted.service.stopForShutdown()

    const failing = await harness()
    failing.service.registerKind(
      kind({
        read: async () => {
          throw new Error('host offline')
        }
      })
    )
    const failingEnrollment = await failing.service.enroll(enrollmentInput())
    if (failingEnrollment.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    failing.schedule.mockClear()
    await failing.service.reconcileForTesting(failingEnrollment.entry.enrollment.watcherId)
    expect((await failing.service.list())[0]).toMatchObject({
      enrollment: { enabled: true },
      // an uncoded throw carries no evidence about the execution host, so it is not lost contact
      status: { state: 'held', phase: 'tick-error', reason: 'host offline' }
    })
    expect(failing.schedule).toHaveBeenCalled()
    await failing.service.stopForShutdown()
  })

  it('reports only a transport failure from the execution host as unreachable', async () => {
    const world = await harness()
    world.service.registerKind(
      kind({
        read: async () => {
          throw Object.assign(new Error('SSH link lost'), { code: 'CONNECTION_LOST' })
        }
      })
    )
    const enrolled = await world.service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    world.schedule.mockClear()
    await world.service.reconcileForTesting(enrolled.entry.enrollment.watcherId)
    expect((await world.service.list())[0]).toMatchObject({
      enrollment: { enabled: true },
      status: { state: 'unreachable', phase: 'error', reason: 'SSH link lost' }
    })
    expect(world.schedule).toHaveBeenCalled()
    await world.service.stopForShutdown()
  })
})
