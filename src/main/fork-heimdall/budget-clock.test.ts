import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWallClockActiveMs } from '../../shared/fork-heimdall/budget'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import { HeimdallLedgerStore } from './ledger-store'

let root: string
let database: HeimdallDatabase
let ledger: HeimdallLedgerStore
let eventSequence: number

function makeClock(): HeimdallBudgetClock {
  return new HeimdallBudgetClock(ledger, {
    eventId: () => `event-${++eventSequence}`,
    intervalId: () => `interval-${eventSequence + 1}`
  })
}

function entries(watcherId = 'watcher-1'): LedgerEntry[] {
  return [...ledger.read(watcherId).entries]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  root = mkdtempSync(join(tmpdir(), 'quirky-heimdall-budget-'))
  database = new HeimdallDatabase(root)
  ledger = new HeimdallLedgerStore(database)
  eventSequence = 0
})

afterEach(() => {
  database.close()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('Heimdall budget clock', () => {
  it('measures overlapping activity as one union interval', () => {
    const clock = makeClock()
    const first = clock.open('watcher-1', 'action-in-flight')
    const second = clock.open('watcher-1', 'worker-dispatched')

    expect(second).toEqual(first)
    expect(entries().filter((entry) => entry.kind === 'interval-open')).toHaveLength(1)
    clock.close(first, 'settled')
    expect(entries().filter((entry) => entry.kind === 'interval-close')).toHaveLength(0)
    expect(clock.current('watcher-1')).toEqual(second)
    clock.close(second, 'settled')
    expect(entries().filter((entry) => entry.kind === 'interval-close')).toHaveLength(1)
    expect(clock.current('watcher-1')).toBeNull()
  })

  it('samples every 15 seconds but durably checkpoints at most once per 60 seconds', () => {
    const clock = makeClock()
    clock.open('watcher-1', 'action-in-flight')

    vi.advanceTimersByTime(15_000)
    expect(entries().filter((entry) => entry.kind === 'interval-checkpoint')).toHaveLength(0)

    vi.advanceTimersByTime(45_000)
    expect(
      entries()
        .filter((entry) => entry.kind === 'interval-checkpoint')
        .map((entry) => entry.atMs)
    ).toEqual([60_000])

    vi.advanceTimersByTime(59_999)
    expect(entries().filter((entry) => entry.kind === 'interval-checkpoint')).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(
      entries()
        .filter((entry) => entry.kind === 'interval-checkpoint')
        .map((entry) => entry.atMs)
    ).toEqual([60_000, 120_000])
    expect(makeClock().recoverOnStart('watcher-1')).toBe(true)
    expect(getWallClockActiveMs({ watcherId: 'watcher-1', entries: entries() })).toBe(120_000)
  })
  it('retries a transient checkpoint write while surfacing the pending failure', () => {
    const append = ledger.append.bind(ledger)
    let failNextCheckpoint = true
    vi.spyOn(ledger, 'append').mockImplementation((entry) => {
      if (entry.kind === 'interval-checkpoint' && failNextCheckpoint) {
        failNextCheckpoint = false
        throw new Error('database busy')
      }
      return append(entry)
    })
    const clock = makeClock()
    clock.open('watcher-1', 'action-in-flight')

    vi.advanceTimersByTime(60_000)
    expect(() => clock.checkpoint('watcher-1')).toThrow('database busy')
    expect(entries().filter((entry) => entry.kind === 'interval-checkpoint')).toHaveLength(0)

    vi.advanceTimersByTime(15_000)
    expect(
      entries()
        .filter((entry) => entry.kind === 'interval-checkpoint')
        .map((entry) => entry.atMs)
    ).toEqual([75_000])
    expect(() => clock.checkpoint('watcher-1')).not.toThrow()
  })

  it('closes contact-lost intervals at the last durable checkpoint', () => {
    const clock = makeClock()
    const handle = clock.open('watcher-1', 'worker-dispatched')
    vi.advanceTimersByTime(60_000)
    vi.setSystemTime(95_000)

    clock.close(handle, 'contact-lost')

    const watcherEntries = entries()
    expect(watcherEntries.at(-1)).toMatchObject({
      kind: 'interval-close',
      intervalId: handle.intervalId,
      closeReason: 'contact-lost',
      atMs: 60_000
    })
    expect(getWallClockActiveMs({ watcherId: 'watcher-1', entries: watcherEntries })).toBe(60_000)
  })

  it('recovers a stale open interval by closing it at its last checkpoint', () => {
    ledger.append({
      kind: 'interval-open',
      eventId: 'open',
      watcherId: 'watcher-1',
      atMs: 10_000,
      origin: 'owner',
      class: 'fact',
      intervalId: 'stale',
      cause: 'action-in-flight'
    })
    ledger.append({
      kind: 'interval-checkpoint',
      eventId: 'checkpoint',
      watcherId: 'watcher-1',
      atMs: 25_000,
      origin: 'owner',
      class: 'fact',
      intervalId: 'stale'
    })
    vi.setSystemTime(100_000)

    expect(makeClock().recoverOnStart('watcher-1')).toBe(true)
    expect(entries().at(-1)).toMatchObject({
      kind: 'interval-close',
      intervalId: 'stale',
      closeReason: 'contact-lost',
      atMs: 25_000
    })
  })
  it('retires stale ownership when another clock has already closed the interval', () => {
    const original = makeClock()
    const handle = original.open('watcher-1', 'worker-dispatched')
    expect(makeClock().recoverOnStart('watcher-1')).toBe(true)

    expect(() => original.close(handle, 'settled')).toThrow()
    expect(original.current('watcher-1')).toBeNull()
    expect(entries().filter((entry) => entry.kind === 'interval-close')).toHaveLength(1)
  })

  it('exposes only local ownership and keeps direct close fenced to that clock', () => {
    const owner = makeClock()
    const handle = owner.open('watcher-1', 'worker-dispatched')
    const foreign = makeClock()

    expect(owner.owned('watcher-1')).toEqual(handle)
    expect(foreign.owned('watcher-1')).toBeNull()
    expect(foreign.current('watcher-1')).toEqual(handle)
    expect(() => foreign.close(handle, 'shutdown')).toThrow('not owned by this clock')
    expect(entries().filter((entry) => entry.kind === 'interval-close')).toHaveLength(0)

    owner.close(handle, 'shutdown')
    expect(owner.owned('watcher-1')).toBeNull()
    expect(entries().filter((entry) => entry.kind === 'interval-close')).toHaveLength(1)
  })

  it('never changes an interval after it has closed', () => {
    const clock = makeClock()
    const handle = clock.open('watcher-1', 'action-in-flight')
    vi.setSystemTime(10_000)
    clock.close(handle, 'settled')
    const closed = entries()

    expect(() => clock.close(handle, 'shutdown')).toThrow('already closed')
    expect(() => clock.checkpoint('watcher-1')).toThrow('no open interval')
    expect(entries()).toEqual(closed)
  })

  it('opens no interval while merely waiting', () => {
    makeClock()
    vi.advanceTimersByTime(5 * 60_000)

    expect(entries()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('no-ops release on an interval already durably closed, unlike strict close', () => {
    const clock = makeClock()
    const handle = clock.open('watcher-1', 'action-in-flight')
    vi.setSystemTime(10_000)
    clock.close(handle, 'settled')
    const closed = entries()

    expect(() => clock.release(handle, 'shutdown')).not.toThrow()
    expect(entries()).toEqual(closed)
    expect(() => clock.close(handle, 'shutdown')).toThrow('already closed')
  })

  it('releases a live interval exactly like a strict close', () => {
    const clock = makeClock()
    const handle = clock.open('watcher-1', 'worker-dispatched')
    vi.setSystemTime(10_000)

    clock.release(handle, 'settled')

    expect(entries().at(-1)).toMatchObject({
      kind: 'interval-close',
      intervalId: handle.intervalId,
      closeReason: 'settled'
    })
    expect(clock.current('watcher-1')).toBeNull()
  })

  it('still rejects release of an interval this clock never owned', () => {
    const owner = makeClock()
    const handle = owner.open('watcher-1', 'worker-dispatched')
    const foreign = makeClock()

    expect(() => foreign.release(handle, 'shutdown')).toThrow('not owned by this clock')
  })

  it('no-ops release when another clock already closed the interval durably, unlike strict close', () => {
    const original = makeClock()
    const handle = original.open('watcher-1', 'worker-dispatched')
    expect(makeClock().recoverOnStart('watcher-1')).toBe(true)

    expect(() => original.release(handle, 'settled')).not.toThrow()
    expect(original.owned('watcher-1')).toBeNull()
    expect(entries().filter((entry) => entry.kind === 'interval-close')).toHaveLength(1)
  })
})
