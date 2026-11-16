import { afterEach, expect, test } from 'bun:test'
import { createSupervision } from '../src/index'
import type { Session, StructuredMessage } from '@quirky/protocol'
import type { StructuredSample, SupervisionContext, SupervisionEngine } from '../src/index'

const target = { sessionId: 's1', worktreeId: 'w1', agent: 'claude' }
const CONTINUE = { kind: 'continue' } as const
const engines: SupervisionEngine[] = []

type HostCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type EventListener = (event: { type: string; data?: unknown }) => void | Promise<void>
type ManualClock = {
  now(): number
  setTimer(callback: () => void, ms: number): () => void
  advance(ms: number): Promise<void>
  pending(): number
}

function manualClock(): ManualClock {
  let time = 0
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimer(callback, ms) {
      const id = ++nextId
      timers.set(id, { at: time + ms, callback })
      return () => { timers.delete(id) }
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

function session(overrides: Record<string, unknown> = {}): Session {
  return {
    id: 's1', kind: 'structured', agent: 'claude', worktreeId: 'w1', cwd: '/w1', title: 'worker',
    status: 'working', createdAt: 1, lastActivityAt: 1, exitCode: null, exitSignal: null,
    exitCause: null, restorable: false, ...overrides
  } as Session
}

function message(seq: number, overrides: Record<string, unknown> = {}): StructuredMessage {
  return { sessionId: 's1', seq, role: 'user', text: `message ${seq}`, at: seq, ...overrides } as StructuredMessage
}

function engineFor(
  call: HostCall,
  options: { clock?: ManualClock; subscribe?: (listener: EventListener) => () => void; log?: (message: string) => void } = {}
) {
  const context = {
    call,
    ...(options.subscribe ? { subscribe: options.subscribe } : {}),
    ...(options.log ? { log: options.log } : {})
  } as unknown as SupervisionContext
  const engine = createSupervision(context, options.clock ? { clock: options.clock } : undefined)
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

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
})

test('watch samples pre-existing rows at the caller cursor and never advances that cursor', async () => {
  const initial = [message(8), message(9, { role: 'assistant' }), message(10, { role: 'result' })]
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  let journal = initial
  const clock = manualClock()
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    if (method === 'quirky.session/get') return session()
    if (method === 'quirky.structured/messages') return journal
    throw new Error(`unexpected RPC ${method}`)
  }, { clock })
  const observed: { sample: StructuredSample }[] = []
  const firstSampled = deferred<void>()
  const result = engine.watchStructured({
    target,
    journal: () => ({ afterSeq: 7, limit: 300, tail: true }),
    onSample(sample) {
      observed.push({ sample })
      if (observed.length === 1) {
        firstSampled.resolve()
        return CONTINUE
      }
      return { kind: 'done', value: 'finished' }
    }
  })

  await firstSampled.promise
  journal = []
  engine.wake('s1')
  expect(await result).toBe('finished')
  expect(observed).toHaveLength(2)
  expect(observed[0]!.sample).toMatchObject({
    target, afterSeq: 7, session: { ok: true },
    journal: { ok: true, value: { messages: initial, maxSeq: 10 } }
  })
  expect(observed[1]!.sample).toMatchObject({
    target, afterSeq: 7, journal: { ok: true, value: { messages: [], maxSeq: 7 } }
  })
  expect(calls.filter((call) => call.method === 'quirky.structured/messages').map((call) => call.params)).toEqual([
    { session: 's1', afterSeq: 7, limit: 300, tail: true },
    { session: 's1', afterSeq: 7, limit: 300, tail: true }
  ])
  expect(clock.pending()).toBe(0)
})

test('readMessages forwards bounded requests and leaves omitted history options omitted', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const rows = [message(8)]
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    return rows
  })

  expect(await engine.readMessages({ session: 's1', afterSeq: 7, limit: 300, tail: true })).toEqual(rows)
  expect(await engine.readMessages({ session: 's1' })).toEqual(rows)
  expect(calls).toEqual([
    { method: 'quirky.structured/messages', params: { session: 's1', afterSeq: 7, limit: 300, tail: true } },
    { method: 'quirky.structured/messages', params: { session: 's1' } }
  ])
})

test('watch serializes event storms into one immediate catch-up sample', async () => {
  const firstJournal = deferred<unknown>()
  const timers = manualClock()
  const callbackGate = deferred<void>()
  const listeners: EventListener[] = []
  const calls: string[] = []
  let journalReads = 0
  let callbacks = 0
  const started = Promise.withResolvers<void>()
  const callbackStarted = started.resolve
  const engine = engineFor(async (method) => {
    calls.push(method)
    if (method === 'quirky.session/get') return session()
    if (method === 'quirky.structured/messages') {
      journalReads++
      if (journalReads === 1) return firstJournal.promise
      return []
    }
    throw new Error(`unexpected RPC ${method}`)
  }, { clock: timers, subscribe: (listener) => { listeners.push(listener); return () => {} } })

  const watch = engine.watchStructured({
    target, pollMs: 1000, journal: () => ({ afterSeq: 7 }),
    onSample() {
      callbacks++
      if (callbacks === 1) {
        callbackStarted()
        return callbackGate.promise.then(() => CONTINUE)
      }
      return { kind: 'done', value: callbacks }
    }
  })
  await flush()
  expect(journalReads).toBe(1)
  expect(listeners).toHaveLength(1)
  await listeners[0]!({ type: 'quirky.structured/message', data: { message: { sessionId: 'other' } } })
  for (let i = 0; i < 100; i++) {
    const events = [
      { type: 'quirky.structured/message', data: { message: { sessionId: 's1' } } },
      { type: 'quirky.structured/settled', data: { sessionId: 's1' } },
      { type: 'quirky.session/changed', data: { session: { id: 's1' } } }
    ]
    await listeners[0]!(events[i % events.length]!)
  }
  await listeners[0]!({ type: 'quirky.session/removed', data: { sessionId: 's1' } })
  await listeners[0]!({ type: 'quirky.ask/created', data: {} })
  await listeners[0]!({ type: 'quirky.ask/resolved', data: {} })
  expect(journalReads).toBe(1)

  firstJournal.resolve([])
  await started.promise
  expect(callbacks).toBe(1)
  expect(journalReads).toBe(1)
  for (let i = 0; i < 100; i++) {
    await listeners[0]!({ type: 'quirky.structured/settled', data: { sessionId: 's1' } })
  }
  expect(journalReads).toBe(1)
  callbackGate.resolve()
  expect(await watch).toBe(2)
  expect(journalReads).toBe(2)
  expect(callbacks).toBe(2)
  expect(calls.filter((method) => method === 'quirky.structured/messages')).toHaveLength(2)
  expect(timers.pending()).toBe(0)
})

test('unrelated session events do not wake another session watch', async () => {
  const listeners: EventListener[] = []
  const timers = manualClock()
  let reads = 0
  let samples = 0
  const engine = engineFor(async (method) => {
    if (method === 'quirky.session/get') return session()
    if (method === 'quirky.structured/messages') { reads++; return [] }
    throw new Error(`unexpected RPC ${method}`)
  }, { clock: timers, subscribe: (listener) => { listeners.push(listener); return () => {} } })
  const watch = engine.watchStructured({
    target, pollMs: 1000, journal: () => ({ afterSeq: 0 }),
    onSample() {
      samples++
      return samples === 1 ? CONTINUE : { kind: 'done', value: samples }
    }
  })
  await flush()
  expect(reads).toBe(1)
  await listeners[0]!({ type: 'quirky.session/changed', data: { session: { id: 'other' } } })
  await listeners[0]!({ type: 'quirky.structured/settled', data: { sessionId: 'other' } })
  await listeners[0]!({ type: 'quirky.structured/message', data: { message: { sessionId: 'other' } } })
  await flush()
  expect(reads).toBe(1)
  expect(samples).toBe(1)
  engine.wake('s1')
  expect(await watch).toBe(2)
  expect(reads).toBe(2)
  expect(timers.pending()).toBe(0)
})

test('call-only contexts poll and optional logging cannot mask a transport error', async () => {
  const clock = manualClock()
  let reads = 0
  const engine = engineFor(async (method) => {
    if (method === 'quirky.session/get') return session()
    if (method === 'quirky.structured/messages') { reads++; return [] }
    throw new Error(`unexpected RPC ${method}`)
  }, { clock })
  const watch = engine.watchStructured({
    target, journal: () => ({ afterSeq: 0 }),
    onSample() { return reads === 1 ? CONTINUE : { kind: 'done', value: reads } }
  })
  await flush()
  expect(reads).toBe(1)
  expect(clock.pending()).toBe(1)
  await clock.advance(1000)
  expect(await watch).toBe(2)
  expect(clock.pending()).toBe(0)

  const transportError = new Error('original RPC error')
  const noLog = engineFor(async () => { throw transportError })
  await expect(noLog.create({ worktree: 'w1', agent: 'codex' })).rejects.toBe(transportError)
})

test('invalid polling intervals reject before reading', async () => {
  let calls = 0
  const engine = engineFor(async () => { calls++; return [] })
  for (const pollMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(engine.watchStructured({
      target, pollMs, journal: () => ({ afterSeq: 0 }), onSample: () => CONTINUE
    })).rejects.toBeInstanceOf(Error)
  }
  expect(calls).toBe(0)
})

test('event subscription is lazy, shared by watches, and released after the last watch', async () => {
  const listeners: EventListener[] = []
  let subscribed = 0
  let unsubscribed = 0
  const clock = manualClock()
  const engine = engineFor(async (method) => {
    if (method === 'quirky.session/get') return session()
    if (method === 'quirky.structured/messages') return []
    return { ok: true }
  }, {
    clock,
    subscribe(listener) { subscribed++; listeners.push(listener); return () => { unsubscribed++ } }
  })

  await engine.create({ worktree: 'w1', agent: 'codex' })
  await engine.readMessages({ session: 's1' })
  expect(subscribed).toBe(0)

  const firstGate = deferred<void>()
  const firstEntered = deferred<void>()
  const a = engine.watchStructured({
    target, journal: () => ({ afterSeq: 0 }),
    onSample() {
      firstEntered.resolve()
      return firstGate.promise.then(() => ({ kind: 'done', value: 'a' } as const))
    }
  })
  const b = engine.watchStructured({ target, journal: () => ({ afterSeq: 0 }), onSample: () => ({ kind: 'done', value: 'b' }) })
  expect(subscribed).toBe(1)
  expect(await b).toBe('b')
  await firstEntered.promise
  expect(unsubscribed).toBe(0)
  firstGate.resolve()
  expect(await a).toBe('a')
  expect(unsubscribed).toBe(1)
  expect(clock.pending()).toBe(0)
  engine.dispose()
  engine.dispose()
  expect(unsubscribed).toBe(1)
  expect(listeners).toHaveLength(1)
})

test('abort and disposal fence late journal replies and release timers and listeners', async () => {
  for (const mode of ['abort', 'dispose'] as const) {
    const clock = manualClock()
    const held = deferred<unknown>()
    const listeners: EventListener[] = []
    let removed = 0
    let callbacks = 0
    const engine = engineFor(async (method) => {
      if (method === 'quirky.session/get') return session()
      if (method === 'quirky.structured/messages') return held.promise
      throw new Error(`unexpected RPC ${method}`)
    }, {
      clock,
      subscribe(listener) { listeners.push(listener); return () => { removed++ } }
    })
    const controller = new AbortController()
    const watch = engine.watchStructured({
      target, signal: controller.signal, pollMs: 1000, journal: () => ({ afterSeq: 0 }),
      onSample() { callbacks++; return CONTINUE }
    })
    await flush()
    expect(listeners).toHaveLength(1)
    if (mode === 'abort') controller.abort()
    else engine.dispose()
    await rejectWith(watch, { name: 'AbortError' })
    expect(callbacks).toBe(0)
    expect(removed).toBe(1)
    expect(clock.pending()).toBe(0)
    held.resolve([])
    await flush()
    expect(callbacks).toBe(0)
    expect(clock.pending()).toBe(0)
  }
})

test('a callback receives the watch signal and can observe cancellation after awaiting', async () => {
  const gate = deferred<void>()
  const entered = deferred<void>()
  const controller = new AbortController()
  let observedAbort = false
  const engine = engineFor(async (method) => method === 'quirky.session/get' ? session() : [], { clock: manualClock() })
  const watch = engine.watchStructured({
    target, signal: controller.signal, journal: () => ({ afterSeq: 0 }),
    async onSample(_sample, signal) {
      entered.resolve()
      await gate.promise
      observedAbort = signal.aborted
      return CONTINUE
    }
  })
  await entered.promise
  controller.abort()
  gate.resolve()
  await rejectWith(watch, { name: 'AbortError' })
  await flush()
  expect(observedAbort).toBe(true)
})

test('malformed journal rows reject as invalid-response instead of becoming empty evidence', async () => {
  const valid = message(8)
  const invalidResponses: unknown[] = [
    null,
    [message(8, { sessionId: 'other' })],
    [message(0)],
    [message(-1)],
    [message(8.5)],
    [message(Number.NaN)],
    [message(Number.POSITIVE_INFINITY)],
    [message(Number.MAX_SAFE_INTEGER + 1)],
    [message(8), message(8)],
    [message(9), message(8)],
    [message(8, { role: 'mystery' })],
    [message(8, { text: 42 })],
    [message(8, { at: Number.NaN })],
    [message(8, { at: Number.POSITIVE_INFINITY })]
  ]
  let response: unknown = [valid]
  const engine = engineFor(async () => response)
  expect(await engine.readMessages({ session: 's1' })).toEqual([valid])
  for (const invalid of invalidResponses) {
    response = invalid
    await rejectWith(engine.readMessages({ session: 's1' }), { code: 'invalid-response' })
  }
  response = [message(8), message(10)]
  expect(await engine.readMessages({ session: 's1' })).toHaveLength(2)
})

test('watch exposes invalid journal and session identities as failed probes, preserving transport errors', async () => {
  const mismatch = [
    { id: 'other' }, { agent: 'codex' }, { worktreeId: 'other-worktree' }, { kind: 'terminal' }
  ]
  for (const overrides of mismatch) {
    let sample: StructuredSample | undefined
    const engine = engineFor(async (method) => method === 'quirky.session/get' ? session(overrides) : [], { clock: manualClock() })
    await engine.watchStructured({
      target, journal: () => ({ afterSeq: 4 }),
      onSample(value) { sample = value; return { kind: 'done', value: undefined } }
    })
    expect(sample?.session).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
    expect(sample?.journal).toMatchObject({ ok: true, value: { messages: [], maxSeq: 4 } })
  }

  let invalidSample: StructuredSample | undefined
  const invalidJournal = engineFor(async (method) => method === 'quirky.session/get' ? session() : null, { clock: manualClock() })
  await invalidJournal.watchStructured({
    target, journal: () => ({ afterSeq: 4 }),
    onSample(value) { invalidSample = value; return { kind: 'done', value: undefined } }
  })
  expect(invalidSample?.journal).toMatchObject({ ok: false, error: { code: 'invalid-response' } })

  let sample: { journal: { ok: boolean; error?: unknown } } | undefined
  const transportError = new Error('journal transport down')
  const clock = manualClock()
  const engine = engineFor(async (method) => {
    if (method === 'quirky.session/get') return session()
    throw transportError
  }, { clock })
  await engine.watchStructured({
    target, journal: () => ({ afterSeq: 0 }),
    onSample(value) { sample = value; return { kind: 'done', value: undefined } }
  })
  expect(sample?.journal.ok).toBe(false)
  expect(sample?.journal.error).toBe(transportError)
  await expect(engine.readMessages({ session: 's1' })).rejects.toBe(transportError)
})

test('create, resume, and send forward guarded effects exactly once and retain raw acknowledgements', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const createAck = { id: 's-new', provider: { opaque: true } }
  const resumeAck = { id: 's-resumed', promptDelivery: { status: 'pending' } }
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    if (method === 'quirky.structured/create') return createAck
    if (method === 'quirky.structured/resume') return resumeAck
    return { ok: true }
  })

  expect(await engine.create({ worktree: 'w1', agent: 'codex', title: 'Worker: task-1', deferStart: true })).toEqual(createAck)
  expect(await engine.create({ worktree: 'w1', agent: 'claude', prompt: 'hello' })).toEqual(createAck)
  expect(await engine.create({ worktree: 'w1', agent: 'claude', title: 'Task', deferStart: false, prompt: 'hello' })).toEqual(createAck)
  expect(await engine.resume({ session: 's1' })).toEqual(resumeAck)
  expect(await engine.resume({ session: 's1', lifetime: 'plugin', lifetimeKey: 'watcher-1' })).toEqual(resumeAck)
  expect(await engine.resume({ session: 's1', prompt: 'continue', lifetime: 'plugin', lifetimeKey: 'watcher-1' })).toEqual(resumeAck)
  expect(await engine.send({
    session: 's1', text: 'continue', requireIdle: true, expectedAfterSeq: 7,
    expectedIncarnation: 'inc-1', operationId: 'op-1'
  })).toEqual({ ok: true })
  expect(calls).toEqual([
    { method: 'quirky.structured/create', params: { worktree: 'w1', agent: 'codex', title: 'Worker: task-1', deferStart: true } },
    { method: 'quirky.structured/create', params: { worktree: 'w1', agent: 'claude', prompt: 'hello' } },
    { method: 'quirky.structured/create', params: { worktree: 'w1', agent: 'claude', title: 'Task', deferStart: false, prompt: 'hello' } },
    { method: 'quirky.structured/resume', params: { session: 's1' } },
    { method: 'quirky.structured/resume', params: { session: 's1', lifetime: 'plugin', lifetimeKey: 'watcher-1' } },
    { method: 'quirky.structured/resume', params: { session: 's1', prompt: 'continue', lifetime: 'plugin', lifetimeKey: 'watcher-1' } },
    { method: 'quirky.structured/send', params: {
      session: 's1', text: 'continue', requireIdle: true, expectedAfterSeq: 7,
      expectedIncarnation: 'inc-1', operationId: 'op-1'
    } }
  ])
})

test('disposal preserves issued acknowledgements and allows explicit cleanup stops', async () => {
  const createReply = deferred<unknown>()
  const resumeReply = deferred<unknown>()
  const sendReply = deferred<unknown>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const stopReceipt = { ok: false, reason: 'incarnation_changed' }
  const ownedReceipt = { stopped: [], unknown: ['s1'] }
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    if (method === 'quirky.structured/create') return createReply.promise
    if (method === 'quirky.structured/resume') return resumeReply.promise
    if (method === 'quirky.structured/send') return sendReply.promise
    if (method === 'quirky.structured/stop') return stopReceipt
    if (method === 'quirky.structured/stopOwned') return ownedReceipt
    throw new Error(`unexpected RPC ${method}`)
  })
  const creating = engine.create({ worktree: 'w1', agent: 'codex', prompt: 'start' })
  const resuming = engine.resume({ session: 's1', prompt: 'continue' })
  const sending = engine.send({ session: 's1', text: 'next' })
  await flush()
  engine.dispose()
  createReply.resolve({ id: 'late-create' })
  resumeReply.resolve({ id: 'late-resume' })
  sendReply.resolve({ ok: true })
  expect(await creating).toEqual({ id: 'late-create' })
  expect(await resuming).toEqual({ id: 'late-resume' })
  expect(await sending).toEqual({ ok: true })
  expect(await engine.stop({ kind: 'structured', session: 's1', expectedIncarnation: 'inc-1' })).toEqual(stopReceipt)
  expect(await engine.stopOwned({ key: 'watcher-1' })).toEqual(ownedReceipt)

  await expect(engine.create({ worktree: 'w1', agent: 'codex' })).rejects.toMatchObject({ name: 'AbortError' })
  await expect(engine.resume({ session: 's1' })).rejects.toMatchObject({ name: 'AbortError' })
  await expect(engine.send({ session: 's1', text: 'new' })).rejects.toMatchObject({ name: 'AbortError' })
  await expect(engine.runCheck({ checkId: 'run-1', command: 'true', cwd: '/w1', timeoutSeconds: 1 }))
    .rejects.toMatchObject({ name: 'AbortError' })
  await expect(engine.waitTerminal({ session: 's1', until: ['idle'], timeoutMs: 0 }))
    .rejects.toMatchObject({ name: 'AbortError' })
  await expect(engine.watchStructured({
    target, journal: () => ({ afterSeq: 0 }), onSample: () => CONTINUE
  })).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls.map((call) => call.method)).toEqual([
    'quirky.structured/create', 'quirky.structured/resume', 'quirky.structured/send',
    'quirky.structured/stop', 'quirky.structured/stopOwned'
  ])
})

test('send refusals retain their receipt, malformed acknowledgements fail, and conflicts pass through', async () => {
  let receipt: unknown = { ok: false, reason: 'operation_unknown' }
  let calls = 0
  const conflict = Object.assign(new Error('stale cursor'), { code: 'conflict' })
  const engine = engineFor(async () => {
    calls++
    if (receipt === 'conflict') throw conflict
    return receipt
  })

  for (const refused of [
    { ok: false, reason: 'operation_unknown' },
    { ok: false, reason: 'recipient_gone' },
    { ok: false, reason: 'recipient_changed' }
  ]) {
    receipt = refused
    await rejectWith(engine.send({ session: 's1', text: 'one' }), { code: 'send-refused', data: refused })
  }
  for (const malformed of [null, {}, { ok: false }, { ok: 'yes' }, { ok: true, extra: true }]) {
    receipt = malformed
    await rejectWith(engine.send({ session: 's1', text: 'one' }), { code: 'invalid-response' })
  }
  receipt = 'conflict'
  await expect(engine.send({ session: 's1', text: 'one' })).rejects.toBe(conflict)
  expect(calls).toBe(9)
})

test('stops forward exact incarnation guards and preserve scoped stop receipts', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const structuredReceipt = { ok: true, stopped: true, sessionId: 's1', processIncarnation: 'inc-1' }
  const terminalReceipt = { ok: false, reason: 'incarnation_changed' }
  const ownedReceipt = { stopped: ['s1'], unknown: ['s2'] }
  const engine = engineFor(async (method, params) => {
    calls.push({ method, params })
    if (method === 'quirky.structured/stop') return structuredReceipt
    if (method === 'quirky.session/close') return terminalReceipt
    if (method === 'quirky.structured/stopOwned') return ownedReceipt
    throw new Error(`unexpected RPC ${method}`)
  })

  expect(await engine.stop({ kind: 'structured', session: 's1', expectedIncarnation: 'inc-1' })).toEqual(structuredReceipt)
  expect(await engine.stop({ kind: 'terminal', session: 't1', expectedIncarnation: 'term-inc' })).toEqual(terminalReceipt)
  expect(await engine.stopOwned({ key: 'watcher-1' })).toEqual(ownedReceipt)
  expect(calls).toEqual([
    { method: 'quirky.structured/stop', params: { session: 's1', expectedIncarnation: 'inc-1' } },
    { method: 'quirky.session/close', params: { session: 't1', expectedIncarnation: 'term-inc' } },
    { method: 'quirky.structured/stopOwned', params: { key: 'watcher-1' } }
  ])
})
