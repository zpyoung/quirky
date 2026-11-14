import { describe, expect, test } from 'bun:test'
import type { Worktree } from '@quirky/protocol'
import { WORKTREE_REFRESH_SLOW_MS, WORKTREE_REFRESH_TIMEOUT_MS, WorktreeRefresh, type RefreshDiagnostic } from '../src/worktree-refresh'

const LOG_PREFIX = 'notification-worktree-refresh '
const START_AT = Date.parse('2026-11-14T00:00:01.000Z')

type Timer = { at: number; run: () => void }

class ManualClock {
  time = 0
  private nextId = 0
  readonly timers = new Map<number, Timer>()

  now = () => new Date(START_AT + this.time)
  monotonicNow = () => this.time

  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.nextId
    this.timers.set(id, { at: this.time + delay, run })
    return id
  }

  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number)
  }

  advanceTo(target: number): void {
    for (;;) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].run()
    }
    this.time = target
  }

  jumpTo(target: number): void {
    this.time = target
  }
  runDueAtCurrent(): void {
    for (;;) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.timers.delete(next[0])
      next[1].run()
    }
  }
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve()
}

function worktree(id: string, unread = true): Worktree {
  return { id, name: id, unread } as Worktree
}

function harness(read: () => Promise<Worktree[]>, clock = new ManualClock()) {
  const logs: string[] = []
  const snapshots: Worktree[][] = []
  const refresh = new WorktreeRefresh({
    read,
    onSnapshot: (value) => snapshots.push(value),
    log: (line) => logs.push(line),
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  })
  return { refresh, clock, logs, snapshots }
}

function diagnostics(logs: string[]): RefreshDiagnostic[] {
  return logs
    .filter((line) => line.startsWith(LOG_PREFIX))
    .map((line) => JSON.parse(line.slice(LOG_PREFIX.length)) as RefreshDiagnostic)
}

describe('WorktreeRefresh', () => {
  test('starts only on request and exposes owned copies after a successful read', async () => {
    const result = deferred<Worktree[]>()
    let calls = 0
    const { refresh, snapshots } = harness(() => {
      calls++
      return result.promise
    })

    expect(refresh.snapshot).toBeUndefined()
    expect(calls).toBe(0)
    refresh.request()
    expect(calls).toBe(1)

    const original = worktree('w1')
    const received = [original]
    result.resolve(received)
    await flushMicrotasks()

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toEqual(received)
    expect(snapshots[0]).not.toBe(received)
    expect(snapshots[0]![0]).not.toBe(original)
    snapshots[0]![0]!.unread = false
    original.name = 'changed at source'
    expect(refresh.snapshot?.[0]?.unread).toBe(true)
    expect(refresh.snapshot?.[0]?.name).toBe('w1')
    const returned = refresh.snapshot!
    returned[0]!.name = 'changed outside'
    expect(refresh.snapshot?.[0]?.name).toBe('w1')
  })

  test('a successful empty read establishes an empty snapshot without fast-success diagnostics', async () => {
    const result = deferred<Worktree[]>()
    const { refresh, clock, logs, snapshots } = harness(() => result.promise)

    refresh.request()
    expect(refresh.snapshot).toBeUndefined()
    result.resolve([])
    await flushMicrotasks()

    expect(refresh.snapshot).toEqual([])
    expect(snapshots).toEqual([[]])
    expect(diagnostics(logs)).toEqual([])
    expect(clock.timers.size).toBe(0)
  })

  test('coalesces requests, suppresses an invalidated result, and reads once more', async () => {
    const first = deferred<Worktree[]>()
    const second = deferred<Worktree[]>()
    const pending = [first, second]
    let calls = 0
    const { refresh, snapshots } = harness(() => pending[calls++]!.promise)

    refresh.request()
    for (let i = 0; i < 20; i++) refresh.request(i === 7)
    expect(calls).toBe(1)

    first.resolve([worktree('stale')])
    await flushMicrotasks()
    expect(calls).toBe(2)
    expect(snapshots).toEqual([])
    expect(refresh.snapshot).toBeUndefined()

    second.resolve([worktree('current')])
    await flushMicrotasks()
    expect(calls).toBe(2)
    expect(snapshots).toEqual([[worktree('current')]])
    expect(refresh.snapshot).toEqual([worktree('current')])
  })

  test('logs slow and successful completion with a shared id and measured duration', async () => {
    const result = deferred<Worktree[]>()
    const { refresh, clock, logs } = harness(() => result.promise)

    refresh.request()
    clock.advanceTo(WORKTREE_REFRESH_SLOW_MS - 1)
    expect(diagnostics(logs)).toEqual([])
    clock.advanceTo(WORKTREE_REFRESH_SLOW_MS)
    const slow = diagnostics(logs)
    expect(slow).toHaveLength(1)
    expect(slow[0]).toMatchObject({
      v: 1,
      event: 'slow',
      startedAt: '2026-11-14T00:00:01.000Z',
      elapsedMs: WORKTREE_REFRESH_SLOW_MS
    })
    expect(slow[0]).not.toHaveProperty('outcome')

    clock.advanceTo(2500)
    result.resolve([worktree('w1')])
    await flushMicrotasks()

    const records = diagnostics(logs)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({
      v: 1,
      id: records[0]!.id,
      event: 'finished',
      startedAt: '2026-11-14T00:00:01.000Z',
      elapsedMs: 2500,
      outcome: 'ok'
    })
    expect(clock.timers.size).toBe(0)
  })

  test('a settlement before delayed timers still detects slowness and records timer lateness', async () => {
    const result = deferred<Worktree[]>()
    const { refresh, clock, logs } = harness(() => result.promise)

    refresh.request()
    clock.jumpTo(2500)
    result.resolve([worktree('w1')])
    await flushMicrotasks()

    expect(diagnostics(logs).map(({ event }) => event)).toEqual(['slow', 'finished'])
    expect(diagnostics(logs).map(({ loopLagMs }) => loopLagMs)).toEqual([2400, 2400])
    expect(diagnostics(logs).map(({ elapsedMs }) => elapsedMs)).toEqual([2500, 2500])
    expect(clock.timers.size).toBe(0)
  })

  test('records lateness when an active timer callback is delayed', async () => {
    const result = deferred<Worktree[]>()
    const { refresh, clock, logs } = harness(() => result.promise)

    refresh.request()
    clock.jumpTo(2500)
    clock.runDueAtCurrent()
    expect(diagnostics(logs).map(({ event, elapsedMs, loopLagMs }) => ({ event, elapsedMs, loopLagMs }))).toEqual([
      { event: 'slow', elapsedMs: 2500, loopLagMs: 2400 }
    ])

    result.resolve([worktree('w1')])
    await flushMicrotasks()
    expect(diagnostics(logs).map(({ event, elapsedMs, loopLagMs }) => ({ event, elapsedMs, loopLagMs }))).toEqual([
      { event: 'slow', elapsedMs: 2500, loopLagMs: 2400 },
      { event: 'finished', elapsedMs: 2500, loopLagMs: 2400 }
    ])
    expect(clock.timers.size).toBe(0)
  })

  test('preserves the snapshot and emits a finished error diagnostic for a fast rejection', async () => {
    let callCount = 0
    const first = deferred<Worktree[]>()
    const second = deferred<Worktree[]>()
    const { refresh, logs } = harness(() => [first, second][callCount++]!.promise)

    refresh.request()
    first.resolve([worktree('w1')])
    await flushMicrotasks()
    refresh.request()
    second.reject(new Error('list fixture failed'))
    await flushMicrotasks()

    expect(refresh.snapshot).toEqual([worktree('w1')])
    expect(diagnostics(logs)).toHaveLength(1)
    expect(diagnostics(logs)[0]).toMatchObject({ event: 'finished', outcome: 'error', elapsedMs: 0 })
    expect(logs.some((line) => line === 'quirky.worktree/list failed: list fixture failed')).toBe(true)
  })

  test('treats settlement at the hard deadline as timeout without adopting its result', async () => {
    const result = deferred<Worktree[]>()
    const { refresh, clock, logs } = harness(() => result.promise)

    refresh.request()
    clock.jumpTo(WORKTREE_REFRESH_TIMEOUT_MS)
    result.resolve([worktree('too-late')])
    await flushMicrotasks()

    expect(diagnostics(logs).map(({ event }) => event)).toEqual(['slow', 'finished'])
    expect(diagnostics(logs)[0]).not.toHaveProperty('outcome')
    expect(diagnostics(logs)[1]).toMatchObject({ outcome: 'timeout', elapsedMs: WORKTREE_REFRESH_TIMEOUT_MS })
    expect(logs.filter((line) => line === 'quirky.worktree/list failed: quirky.worktree/list did not answer within 30000ms')).toHaveLength(1)
    expect(clock.timers.size).toBe(0)
  })

  test('times out once at 30000ms but retains the raw lock until settlement', async () => {
    const result = deferred<Worktree[]>()
    const followUp = deferred<Worktree[]>()
    let calls = 0
    const { refresh, clock, logs } = harness(() => (calls++ === 0 ? result.promise : followUp.promise))

    refresh.request()
    clock.advanceTo(WORKTREE_REFRESH_TIMEOUT_MS - 1)
    expect(diagnostics(logs).map(({ event }) => event)).toEqual(['slow'])
    expect(diagnostics(logs)[0]).toMatchObject({ elapsedMs: WORKTREE_REFRESH_SLOW_MS })
    expect(logs.filter((line) => line === 'quirky.worktree/list failed: quirky.worktree/list did not answer within 30000ms')).toHaveLength(0)
    clock.advanceTo(WORKTREE_REFRESH_TIMEOUT_MS)
    expect(diagnostics(logs).map(({ event }) => event)).toEqual(['slow', 'finished'])
    expect(diagnostics(logs)[1]).toMatchObject({ outcome: 'timeout', elapsedMs: WORKTREE_REFRESH_TIMEOUT_MS })
    expect(logs.filter((line) => line === 'quirky.worktree/list failed: quirky.worktree/list did not answer within 30000ms')).toHaveLength(1)
    expect(clock.timers.size).toBe(0)

    refresh.request()
    refresh.request(true)
    expect(calls).toBe(1)
    result.resolve([worktree('late')])
    await flushMicrotasks()
    expect(diagnostics(logs).map(({ event }) => event)).toEqual(['slow', 'finished'])
    expect(refresh.snapshot).toBeUndefined()
    expect(calls).toBe(2)
    refresh.stop()
    expect(clock.timers.size).toBe(0)
  })

  test('contains synchronous read throws and records fast failures', async () => {
    const { refresh, logs } = harness(() => {
      throw new Error('sync fixture failed')
    })

    expect(() => refresh.request()).not.toThrow()
    await flushMicrotasks()
    expect(diagnostics(logs).map(({ outcome }) => outcome)).toEqual(['error'])
    expect(logs.some((line) => line === 'quirky.worktree/list failed: sync fixture failed')).toBe(true)
  })

  test('stop clears timers and suppresses late adoption, logging, and follow-up', async () => {
    const result = deferred<Worktree[]>()
    let calls = 0
    const { refresh, clock, logs, snapshots } = harness(() => {
      calls++
      return result.promise
    })

    refresh.request()
    refresh.request(true)
    refresh.stop()
    expect(clock.timers.size).toBe(0)
    result.resolve([worktree('late')])
    await flushMicrotasks()
    refresh.request()

    expect(calls).toBe(1)
    expect(snapshots).toEqual([])
    expect(refresh.snapshot).toBeUndefined()
    expect(logs).toEqual([])
    expect(clock.timers.size).toBe(0)
  })
})
