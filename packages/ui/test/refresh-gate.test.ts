import { expect, test } from 'bun:test'
import { createRefreshGate, type RefreshGateClock } from '../src/refresh-gate'

function deferred() {
  return Promise.withResolvers<void>()
}

function fakeClock() {
  const timers = new Map<object, { run: () => void; delay: number }>()
  const clock: RefreshGateClock = {
    setTimeout(run, delay) {
      const handle = {}
      timers.set(handle, { run, delay })
      return handle
    },
    clearTimeout(handle) { timers.delete(handle as object) },
  }
  const fire = () => {
    const [handle, timer] = timers.entries().next().value!
    timers.delete(handle)
    timer.run()
  }
  return { clock, timers, fire }
}

const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function setup() {
  const runs: PromiseWithResolvers<void>[] = []
  const time = fakeClock()
  const gate = createRefreshGate(() => {
    const run = deferred()
    runs.push(run)
    return run.promise
  }, { clock: time.clock, abandonAfterMs: 1000 })
  return { gate, runs, ...time }
}

test('an idle request starts before returning', async () => {
  const { gate, runs } = setup()
  const request = gate.request()
  expect(runs).toHaveLength(1)
  runs[0]!.resolve()
  await request
})

test('a burst waits for one trailing run', async () => {
  const { gate, runs } = setup()
  const first = gate.request()
  let settled = 0
  const burst = Array.from({ length: 30 }, () => gate.request().then(() => { settled++ }))
  expect(runs).toHaveLength(1)
  runs[0]!.resolve()
  await first
  await drain()
  expect(runs).toHaveLength(2)
  expect(settled).toBe(0)
  runs[1]!.resolve()
  await Promise.all(burst)
  expect(settled).toBe(30)
  expect(runs).toHaveLength(2)
})

test('the gate is idle again after the trailing run', async () => {
  const { gate, runs } = setup()
  const first = gate.request()
  const second = gate.request()
  runs[0]!.resolve()
  await first
  runs[1]!.resolve()
  await second
  const third = gate.request()
  expect(runs).toHaveLength(3)
  runs[2]!.resolve()
  await third
})

test('a rejected run resolves its requests and still reruns', async () => {
  const { gate, runs } = setup()
  const first = gate.request()
  const second = gate.request()
  runs[0]!.reject(new Error('boom'))
  await first
  expect(runs).toHaveLength(2)
  runs[1]!.resolve()
  await second
})

test('a synchronous throw leaves the gate usable', async () => {
  let calls = 0
  const gate = createRefreshGate(() => {
    if (++calls === 1) throw new Error('sync')
    return Promise.resolve()
  }, { clock: fakeClock().clock })
  await gate.request()
  await gate.request()
  expect(calls).toBe(2)
})

test('a hung run releases its slot and ignores late settlement', async () => {
  const { gate, runs, fire, timers } = setup()
  const first = gate.request()
  const second = gate.request()
  expect([...timers.values()][0]!.delay).toBe(1000)
  fire()
  await first
  expect(runs).toHaveLength(2)
  runs[0]!.resolve()
  await drain()
  expect(runs).toHaveLength(2)
  runs[1]!.resolve()
  await second
  const idleTimeout = gate.request()
  fire()
  await idleTimeout
  const next = gate.request()
  expect(runs).toHaveLength(4)
  runs[3]!.resolve()
  await next
})

test('settlement clears the abandon timer', async () => {
  const { gate, runs, timers } = setup()
  const request = gate.request()
  expect(timers.size).toBe(1)
  runs[0]!.resolve()
  await request
  expect(timers.size).toBe(0)
})

test('cancel resolves pending waiters and drops the rerun', async () => {
  const { gate, runs } = setup()
  const first = gate.request()
  const pending = [gate.request(), gate.request()]
  gate.cancel()
  await Promise.all(pending)
  expect(runs).toHaveLength(1)
  runs[0]!.resolve()
  await first
  expect(runs).toHaveLength(1)
  const later = gate.request()
  expect(runs).toHaveLength(2)
  runs[1]!.resolve()
  await later
})

test('a request inside run never nests runs', async () => {
  let calls = 0
  let running = 0
  let peak = 0
  let nested!: Promise<void>
  const gate = createRefreshGate(async () => {
    running++
    peak = Math.max(peak, running)
    if (++calls === 1) nested = gate.request()
    await Promise.resolve()
    running--
  }, { clock: fakeClock().clock })
  await gate.request()
  await nested
  expect(calls).toBe(2)
  expect(peak).toBe(1)
})
