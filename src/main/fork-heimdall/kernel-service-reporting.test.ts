import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION } from './debug-report'
import { enrollmentInput, harness, kind } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

describe('Heimdall kernel service reporting', () => {
  it('reports live runner state, clock state, workers, snapshots, and static pointers', async () => {
    const { service, database, budgetClock, orchestration, leaseStore } = await harness()
    leaseStore.describeLocation = () => ({
      executionHostId: 'local',
      leaseDirectory: '/workspace/review-1/.quirky/heimdall/lease',
      pathSeparator: '/'
    })
    vi.mocked(orchestration.listWorkers).mockResolvedValue([
      {
        dispatchId: 'dispatch-debug',
        task: 'Inspect the watcher',
        dispatchedAtMs: 90,
        lastContactAtMs: 100,
        liveness: 'live',
        reason: null,
        question: null
      }
    ])
    service.registerKind(
      kind({
        debug: {
          pointers: () => [
            {
              role: 'kind-database',
              host: 'kernel',
              path: '/var/quirky/kind.db',
              status: 'resolved'
            }
          ]
        }
      })
    )
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    await service.reconcileForTesting(watcherId)
    const interval = budgetClock.open(watcherId, 'worker-dispatched')

    const report = await service.debugReport(watcherId)

    expect(report).toMatchObject({
      schemaVersion: HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION,
      budgetClock: { openIntervalId: interval.intervalId },
      malformedPayload: false,
      pendingControlOperation: false,
      runner: {
        kindId: 'hosted-review',
        stopped: false,
        suspended: false,
        recovered: true,
        leaseEpoch: null,
        leaseRenewalArmed: false,
        snapshot: {
          freshness: 'live',
          observedAtMs: 1,
          contentIdentity: 'revision-1',
          summary: {
            freshness: 'live',
            contentIdentity: 'revision-1',
            summary: 'revision-1'
          }
        }
      }
    })
    expect(report.pointers).toEqual(
      expect.arrayContaining([
        {
          role: 'kernel-database',
          host: 'kernel',
          path: database.databasePath(),
          status: 'resolved'
        },
        {
          role: 'kind-database',
          host: 'kernel',
          path: '/var/quirky/kind.db',
          status: 'resolved'
        },
        {
          role: 'workspace',
          host: 'local',
          path: '/workspace/review-1',
          status: 'resolved'
        },
        {
          role: 'lease-holder',
          host: 'local',
          path: '/workspace/review-1/.quirky/heimdall/lease/epoch-1/holder.json',
          status: 'resolved',
          detail: 'Last observed lease epoch; current ownership not verified'
        }
      ])
    )
    budgetClock.close(interval, 'settled')
  })

  it('keeps detail and debug reads available when orchestration worker listing fails', async () => {
    const { service, orchestration } = await harness()
    service.registerKind(kind())
    const enrolled = await service.enroll(enrollmentInput())
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    vi.mocked(orchestration.listWorkers).mockRejectedValue(
      new Error('seat lost with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    )

    const report = await service.debugReport(enrolled.entry.enrollment.watcherId)
    const detail = await service.detail({
      watcherId: enrolled.entry.enrollment.watcherId,
      connectionId: null,
      pairingRevision: null
    })

    expect(report.workers).toEqual([])
    expect(report.workersError).toContain('seat lost')
    expect(report.workersError).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(detail.workers).toEqual([])
  })
})
