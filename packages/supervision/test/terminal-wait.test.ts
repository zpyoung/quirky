import { afterEach, expect, test } from 'bun:test'
import { createSupervision } from '../src/index'
import type { SupervisionContext, SupervisionEngine, TerminalWaitResult } from '../src/index'

const engines: SupervisionEngine[] = []

type HostCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type Clock = {
  now(): number
  setTimer(callback: () => void, ms: number): () => void
  advance(ms: number): Promise<void>
  pending(): number
}

function clock(): Clock {
  let time = 0
  let id = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimer(callback, ms) {
      const key = ++id
      timers.set(key, { at: time + ms, callback })
      return () => { timers.delete(key) }
    },
    async advance(ms) {
      time += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        due[1].callback()
        await flush()
      }
    },
    pending: () => timers.size
  }
}

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function engineFor(call: HostCall, timers?: Clock): SupervisionEngine {
  const context = { call } as unknown as SupervisionContext
  const engine = createSupervision(context, timers ? { clock: timers } : undefined)
  engines.push(engine)
  return engine
}

async function rejectWith(promise: Promise<unknown>, expected: Record<string, unknown>) {
  try {
    await promise
    throw new Error('expected promise to reject')
  } catch (error) {
    expect(error).toMatchObject(expected)
    return error
  }
}

function matched(state: TerminalWaitResult['state']): TerminalWaitResult {
  return { status: 'matched', state, kind: 'permission', at: 123, decidedBy: 'rule', rule: 'fresh evidence' }
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
})

test('terminal waits request bounded slices and return pending at the total timeout', async () => {
  const timers = clock()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    const pending = deferred<unknown>()
    timers.setTimer(() => pending.resolve({ status: 'pending', state: 'working', at: timers.now() }), Number(params?.timeoutMs))
    return pending.promise
  }, timers)

  const result = engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 2500, sliceMs: 1000 })
  await flush()
  expect(calls.map((call) => call.params?.timeoutMs)).toEqual([1000])
  await timers.advance(1000)
  expect(calls.map((call) => call.params?.timeoutMs)).toEqual([1000, 1000])
  await timers.advance(1000)
  expect(calls.map((call) => call.params?.timeoutMs)).toEqual([1000, 1000, 500])
  await timers.advance(500)

  expect(await result).toEqual({ status: 'pending', state: 'working', at: 2500 })
  expect(calls.map((call) => call.method)).toEqual(Array(3).fill('quirky.agent-status/wait'))
  expect(calls.map((call) => call.params)).toEqual([
    { session: 's1', until: ['idle'], timeoutMs: 1000 },
    { session: 's1', until: ['idle'], timeoutMs: 1000 },
    { session: 's1', until: ['idle'], timeoutMs: 500 }
  ])
  expect(timers.pending()).toBe(0)
})

test('zero-timeout terminal waits inspect exactly once with a zero RPC timeout', async () => {
  const calls: Record<string, unknown>[] = []
  const reply = { status: 'pending', state: 'unknown', at: 9 }
  const engine = engineFor(async (_method, params) => { calls.push(params ?? {}); return reply })

  expect(await engine.waitTerminal({ session: 's1', until: [], timeoutMs: 0 })).toEqual(reply)
  expect(calls).toEqual([{ session: 's1', until: [], timeoutMs: 0 }])
})

test('terminal waits default to one-second slices', async () => {
  const calls: Record<string, unknown>[] = []
  const reply = matched('idle')
  const engine = engineFor(async (_method, params) => {
    calls.push(params ?? {})
    return reply
  })

  expect(await engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 5000 })).toEqual(reply)
  expect(calls).toEqual([{ session: 's1', until: ['idle'], timeoutMs: 1000 }])
})

test('matched terminal states are returned unchanged when they are requested', async () => {
  for (const state of ['blocked', 'idle', 'working', 'exited'] as const) {
    const reply = matched(state)
    let calls = 0
    const engine = engineFor(async () => { calls++; return reply })
    expect(await engine.waitTerminal({ session: 's1', until: [state], timeoutMs: 5000 })).toEqual(reply)
    expect(calls).toBe(1)
  }
})

test('rejected stale matched evidence waits a slice before trying again', async () => {
  const timers = clock()
  const calls: number[] = []
  const idle = matched('idle')
  const engine = engineFor(async (_method, params) => {
    calls.push(Number(params?.timeoutMs))
    return idle
  }, timers)
  let accepts = 0
  const result = engine.waitTerminal({
    session: 's1', until: ['idle'], timeoutMs: 2500, sliceMs: 1000,
    accept: async () => ++accepts > 1
  })
  await flush()
  expect(calls).toEqual([1000])
  expect(timers.pending()).toBe(1)
  await timers.advance(1000)
  expect(await result).toEqual(idle)
  expect(calls).toEqual([1000, 1000])
  expect(accepts).toBe(2)
  expect(timers.pending()).toBe(0)
})

test('abort stops a held terminal RPC promptly and ignores its late reply', async () => {
  const timers = clock()
  const reply = deferred<unknown>()
  const calls: number[] = []
  const controller = new AbortController()
  const engine = engineFor(async (_method, params) => {
    calls.push(Number(params?.timeoutMs))
    return reply.promise
  }, timers)
  const waiting = engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 2000, sliceMs: 1000, signal: controller.signal })
  await flush()
  expect(calls).toEqual([1000])
  controller.abort()
  await rejectWith(waiting, { name: 'AbortError' })
  reply.resolve(matched('idle'))
  await flush()
  await timers.advance(2000)
  expect(calls).toEqual([1000])
  expect(timers.pending()).toBe(0)
})

test('an already-aborted wait and invalid local timeout arguments make no RPC', async () => {
  const calls: string[] = []
  const engine = engineFor(async (method) => { calls.push(method); return matched('idle') })
  const controller = new AbortController()
  controller.abort()
  await rejectWith(engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 100, signal: controller.signal }), { name: 'AbortError' })
  for (const input of [
    { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: Number.NaN }, { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 100, sliceMs: 0 }, { timeoutMs: 100, sliceMs: -1 }, { timeoutMs: 100, sliceMs: 2.5 },
    { timeoutMs: 100, sliceMs: Number.NaN }, { timeoutMs: 100, sliceMs: Number.POSITIVE_INFINITY }
  ]) {
    const { timeoutMs, ...rest } = input
    await expect(engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: timeoutMs!, ...rest })).rejects.toBeInstanceOf(Error)
  }
  expect(calls).toEqual([])
})

test('malformed terminal replies reject as invalid-response while transport errors keep their identity', async () => {
  let response: unknown = matched('idle')
  const engine = engineFor(async () => response)
  expect(await engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 500 })).toMatchObject({ state: 'idle' })
  for (const malformed of [
    null,
    {},
    { status: 'finished', state: 'idle' },
    { status: 'matched', state: 'stopped' },
    { status: 'pending', state: 'working', at: Number.NaN },
    { status: 'matched', state: 'idle', kind: 3 },
    { status: 'matched', state: 'idle', decidedBy: false }
  ]) {
    response = malformed
    await rejectWith(engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 500 }), { code: 'invalid-response' })
  }

  const transportError = Object.assign(new Error('wait RPC missing'), { code: 'method-not-found' })
  const failing = engineFor(async () => { throw transportError })
  await expect(failing.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 1 })).rejects.toBe(transportError)
})
