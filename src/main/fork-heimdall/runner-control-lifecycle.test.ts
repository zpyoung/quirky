import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import type { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { HeimdallLedgerStore } from './ledger-store'
import { WatcherRunnerControlLifecycle } from './runner-control-lifecycle'
import type { WatcherRunner } from './runner-state'

let root: string
let database: HeimdallDatabase
let ledger: HeimdallLedgerStore
let nowMs: number
let eventSequence: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-heimdall-runner-control-'))
  database = new HeimdallDatabase(root)
  ledger = new HeimdallLedgerStore(database)
  nowMs = 100
  eventSequence = 0
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function makeClock(): HeimdallBudgetClock {
  return new HeimdallBudgetClock(ledger, {
    now: () => nowMs,
    eventId: () => `clock-event-${++eventSequence}`,
    intervalId: () => `clock-interval-${eventSequence + 1}`
  })
}

function makeRunner(recovered = false): WatcherRunner {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal WatcherEnrollment double; suspend/stop/remove under test only read enrollment.watcherId.
    enrollment: { watcherId: 'watcher-1' } as WatcherEnrollment,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runner.kind is never read by the control-lifecycle methods under test.
    kind: {} as WatcherRunner['kind'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runner.status is only ever spread/overwritten by the methods under test, never read.
    status: {} as WatcherRunner['status'],
    timer: null,
    operationTail: Promise.resolve(),
    tickQueued: false,
    reconcileAgain: false,
    stopped: false,
    suspended: false,
    controlPending: null,
    recovered,
    forceFresh: false,
    consecutiveErrors: 0,
    consecutiveGateHolds: 0,
    lastFullResyncAtMs: null,
    lastSnapshot: null,
    traceSequence: 0,
    traces: [],
    leaseGuard: null,
    leaseRenewal: null,
    ownerBudgetInterval: null
  }
}

function makeLifecycle(clock: HeimdallBudgetClock): WatcherRunnerControlLifecycle {
  return new WatcherRunnerControlLifecycle({
    budgetClock: clock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherLedgerLifecycle is a class with private fields, so a structural test double can never satisfy it without this cast; only the two overridden methods are exercised by the code under test.
    dispatchLifecycle: {
      closeForContactLoss: vi.fn(),
      closeForShutdown: vi.fn()
    } as unknown as WatcherLedgerLifecycle,
    schedule: vi.fn(),
    clearTimer: vi.fn(),
    publish: vi.fn()
  })
}

function seedStaleInterval(): void {
  ledger.append({
    kind: 'interval-open',
    eventId: 'prior-open',
    watcherId: 'watcher-1',
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    intervalId: 'prior-interval',
    cause: 'worker-dispatched'
  })
  ledger.append({
    kind: 'interval-checkpoint',
    eventId: 'prior-checkpoint',
    watcherId: 'watcher-1',
    atMs: 40,
    origin: 'owner',
    class: 'fact',
    intervalId: 'prior-interval'
  })
}

describe('WatcherRunnerControlLifecycle budget teardown', () => {
  it('does not close a competing clock interval when suspended before the first pulse', () => {
    const ownerClock = makeClock()
    const handle = ownerClock.open('watcher-1', 'worker-dispatched')
    const controlClock = makeClock()
    const lifecycle = makeLifecycle(controlClock)
    const runner = makeRunner()

    lifecycle.suspend(runner)
    lifecycle.suspend(runner)

    expect(ownerClock.owned('watcher-1')).toEqual(handle)
    expect(controlClock.owned('watcher-1')).toBeNull()
    expect(controlClock.current('watcher-1')).toEqual(handle)
    expect(
      ledger.read('watcher-1').entries.filter((entry) => entry.kind === 'interval-close')
    ).toEqual([])

    ownerClock.close(handle, 'shutdown')
  })

  it('leaves a stale interval for the next lease-gated recovery', () => {
    seedStaleInterval()
    const clock = makeClock()
    const lifecycle = makeLifecycle(clock)
    const runner = makeRunner()

    lifecycle.suspend(runner)

    expect(clock.owned('watcher-1')).toBeNull()
    expect(clock.current('watcher-1')).toMatchObject({ intervalId: 'prior-interval' })
    expect(
      ledger.read('watcher-1').entries.filter((entry) => entry.kind === 'interval-close')
    ).toEqual([])

    expect(clock.recoverOnStart('watcher-1')).toBe(true)
    expect(
      ledger.read('watcher-1').entries.filter((entry) => entry.kind === 'interval-close')
    ).toEqual([
      expect.objectContaining({
        intervalId: 'prior-interval',
        closeReason: 'contact-lost',
        atMs: 40
      })
    ])
  })

  it('stops repeatedly before the first pulse when no interval exists', () => {
    const clock = makeClock()
    const lifecycle = makeLifecycle(clock)
    const runner = makeRunner()

    lifecycle.stop(runner)
    lifecycle.stop(runner)

    expect(runner.stopped).toBe(true)
    expect(ledger.read('watcher-1').entries).toEqual([])
    expect(clock.current('watcher-1')).toBeNull()
  })

  it('removes a runner by closing its owned interval with shutdown accounting', () => {
    const clock = makeClock()
    const lifecycle = makeLifecycle(clock)
    const runner = makeRunner()
    const interval = clock.open('watcher-1', 'action-in-flight')
    nowMs = 250

    lifecycle.remove(runner)
    lifecycle.remove(runner)

    expect(runner.stopped).toBe(true)
    expect(runner.controlPending).toBe('delete')
    expect(
      ledger.read('watcher-1').entries.filter((entry) => entry.kind === 'interval-close')
    ).toEqual([
      expect.objectContaining({
        intervalId: interval.intervalId,
        closeReason: 'shutdown',
        atMs: 250
      })
    ])
    expect(clock.current('watcher-1')).toBeNull()
  })

  it('surfaces an owned interval close failure and leaves the close retryable', () => {
    const clock = makeClock()
    const interval = clock.open('watcher-1', 'worker-dispatched')
    const append = ledger.append.bind(ledger)
    let failClose = true
    vi.spyOn(ledger, 'append').mockImplementation((entry, options) => {
      if (entry.kind === 'interval-close' && failClose) {
        failClose = false
        throw new Error('control close persistence failed')
      }
      return append(entry, options)
    })
    const lifecycle = makeLifecycle(clock)
    const runner = makeRunner()

    expect(() => lifecycle.stop(runner)).toThrow('control close persistence failed')
    expect(clock.owned('watcher-1')).toEqual(interval)
    expect(
      ledger.read('watcher-1').entries.filter((entry) => entry.kind === 'interval-close')
    ).toEqual([])

    expect(() => lifecycle.stop(runner)).not.toThrow()
    expect(
      ledger.read('watcher-1').entries.filter((entry) => entry.kind === 'interval-close')
    ).toEqual([
      expect.objectContaining({
        intervalId: interval.intervalId,
        closeReason: 'shutdown',
        atMs: 100
      })
    ])
  })

  it('removes a runner even when the owned interval cannot be released, logging instead of throwing', () => {
    const clock = makeClock()
    clock.open('watcher-1', 'worker-dispatched')
    const append = ledger.append.bind(ledger)
    vi.spyOn(ledger, 'append').mockImplementation((entry, options) => {
      if (entry.kind === 'interval-close') {
        throw new Error('control release persistence failed')
      }
      return append(entry, options)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lifecycle = makeLifecycle(clock)
    const runner = makeRunner()

    expect(() => lifecycle.remove(runner)).not.toThrow()

    expect(runner.stopped).toBe(true)
    expect(runner.controlPending).toBe('delete')
    expect(runner.ownerBudgetInterval).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('removes a runner even when worker interval teardown throws', () => {
    const clock = makeClock()
    const lifecycle = new WatcherRunnerControlLifecycle({
      budgetClock: clock,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherLedgerLifecycle is a class with private fields, so a structural test double can never satisfy it without this cast; only the two overridden methods are exercised by the code under test.
      dispatchLifecycle: {
        closeForContactLoss: vi.fn(() => {
          throw new Error('worker interval teardown failed')
        }),
        closeForShutdown: vi.fn()
      } as unknown as WatcherLedgerLifecycle,
      schedule: vi.fn(),
      clearTimer: vi.fn(),
      publish: vi.fn()
    })
    const runner = makeRunner()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => lifecycle.remove(runner)).not.toThrow()

    expect(runner.stopped).toBe(true)
    expect(runner.controlPending).toBe('delete')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
