import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { PassScheduler } from '../src/passes'

function rig() {
  let active = 0
  let maxActive = 0
  const runs: { resolve(): void; reject(error: Error): void }[] = []
  const errors: unknown[] = []
  const scheduler = new PassScheduler(() => {
    active++
    maxActive = Math.max(maxActive, active)
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    runs.push({
      resolve: () => { active--; resolve() },
      reject: (error) => { active--; reject(error) }
    })
    return promise
  }, 5, (error) => errors.push(error))
  return { scheduler, runs, errors, maxActive: () => maxActive }
}
const timers = jest as typeof jest & { advanceTimersByTime(ms: number): void }
beforeEach(() => { timers.useFakeTimers() })
afterEach(() => { timers.useRealTimers() })
async function pause() {
  timers.advanceTimersByTime(20)
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('joins an idle burst into one settled pass', async () => {
  const { scheduler, runs } = rig()
  for (let i = 0; i < 10; i++) scheduler.request()
  expect(runs).toHaveLength(0)
  await pause()
  expect(runs).toHaveLength(1)
  runs[0]!.resolve()
  scheduler.stop()
})

test('requests during a pass make exactly one non-overlapping follow-up', async () => {
  const { scheduler, runs, maxActive } = rig()
  const first = scheduler.now()
  for (let i = 0; i < 10; i++) scheduler.request()
  await pause()
  for (let i = 0; i < 10; i++) scheduler.request()
  await pause()
  expect(runs).toHaveLength(1)
  runs[0]!.resolve()
  await first
  await pause()
  expect(runs).toHaveLength(2)
  runs[1]!.resolve()
  await pause()
  expect(runs).toHaveLength(2)
  expect(maxActive()).toBe(1)
  scheduler.stop()
})

test('awaiting callers share a pass started after they asked', async () => {
  const { scheduler, runs, maxActive } = rig()
  const first = scheduler.now()
  const second = scheduler.now()
  const third = scheduler.now()
  expect(second).toBe(third)
  let settled = false
  void second.then(() => { settled = true })
  runs[0]!.resolve()
  await first
  expect(runs).toHaveLength(2)
  expect(settled).toBe(false)
  runs[1]!.resolve()
  await second
  expect(maxActive()).toBe(1)
  expect(runs).toHaveLength(2)
  scheduler.stop()
})

test('recovers from rejection and reports only background failures', async () => {
  const { scheduler, runs, errors } = rig()
  const first = scheduler.now()
  const second = scheduler.now()
  runs[0]!.reject(new Error('boom'))
  await expect(first).rejects.toThrow('boom')
  expect(runs).toHaveLength(2)
  runs[1]!.resolve()
  await second
  scheduler.request()
  await pause()
  runs[2]!.reject(new Error('background'))
  await pause()
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe('background')
  scheduler.stop()
})

test('cancel permits later work and stop releases waiters without another pass', async () => {
  const { scheduler, runs } = rig()
  scheduler.request()
  scheduler.cancel()
  await pause()
  expect(runs).toHaveLength(0)
  scheduler.request()
  await pause()
  expect(runs).toHaveLength(1)
  const waiting = scheduler.now()
  scheduler.request()
  scheduler.stop()
  runs[0]!.resolve()
  await waiting
  await scheduler.now()
  scheduler.request()
  await pause()
  expect(runs).toHaveLength(1)
})
