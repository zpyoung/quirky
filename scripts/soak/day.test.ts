import { afterEach, expect, jest, spyOn, test } from 'bun:test'
import { UI_TOOL_SLOTS, type QuirkyClient } from '@quirky/protocol'
import { applyPhase, daySchedule, PANEL_PHASES, startDay, STOP_DRAIN_MS, TASK_FOLLOW_MS } from './day.ts'
import type { SoakWindows } from './windows.ts'
import type { SwitchRecord } from './contracts.ts'

type RequestProof = { at: number; method: string; params: unknown } | null

const timers = jest as unknown as { advanceTimersByTime(ms: number): void }
const flush = async () => { for (let i = 0; i < 256; i++) await Promise.resolve() }
afterEach(() => jest.useRealTimers())

function fixture(count = 2) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const open: Record<string, string | null> = {}
  const waits: { index: number; panels: string[]; options: { since: number; timeoutMs: number; signal: AbortSignal } }[] = []
  const control = { callAny: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'ui.tool.open') {
      const move = calls.findLast(({ method, params: p }) => method === 'ui.tool.move' && p.id === params.id)!
      open[String(move.params.slot)] = String(params.id)
    }
    return { layout: { tools: { open }, worktree: 'a' } }
  } } as unknown as QuirkyClient
  const windows: SoakWindows = {
    pages: [], browserPid: 1, stop: async () => {}, finish: async () => ({ records: [], requests: [] }),
    liveness: () => Array.from({ length: count }, (_, index) => ({ index, connId: 10 + index, worktree: 'a', open: true })),
    waitForRequest: async (index, matches, options) => {
      const candidates = [
        ['checks', 'quirky.reviews/state', { worktree: 'a' }],
        ['explorer', 'quirky.editor/explorer', { action: 'list' }],
        ['tasks', 'quirky.tasks/state', {}]
      ] as const
      waits.push({ index, panels: candidates.filter(([, method, params]) => matches(method, params)).map(([panel]) => panel), options })
      return { at: performance.now(), method: 'ready', params: {} }
    }
  }
  return { control, windows, calls, waits, open }
}

test('phase zero applies all six slots in order and proves all three panels per window', async () => {
  const f = fixture()
  const result = await applyPhase({ ...f, phase: 0, previous: null, signal: new AbortController().signal })
  expect(result.missing).toEqual([])
  expect(result.error).toBeNull()
  expect(f.calls.slice(0, 12)).toEqual(UI_TOOL_SLOTS.flatMap((slot) => [
    { method: 'ui.tool.move', params: { id: PANEL_PHASES[0]!.tools[slot], slot } },
    { method: 'ui.tool.open', params: { id: PANEL_PHASES[0]!.tools[slot] } }
  ]))
  expect(f.calls.slice(12)).toEqual([10, 11].map((connId) => ({ method: 'ui.window.state', params: { connId } })))
  expect(f.waits.map(({ index, panels }) => [index, ...panels])).toEqual([
    [0, 'checks'], [0, 'explorer'], [0, 'tasks'], [1, 'checks'], [1, 'explorer'], [1, 'tasks']
  ])
})

test('phase swaps only require named panels that were previously closed', async () => {
  const f = fixture()
  await applyPhase({ ...f, phase: 1, previous: 0, signal: new AbortController().signal })
  expect(f.waits).toEqual([])
  expect(f.open).toEqual(PANEL_PHASES[1]!.tools)
  await applyPhase({ ...f, phase: 0, previous: 1, signal: new AbortController().signal })
  expect(f.waits.map(({ index, panels }) => [index, ...panels])).toEqual([[0, 'checks'], [0, 'explorer'], [1, 'checks'], [1, 'explorer']])
})

test('layout mismatch names the window and slot and fails setup', async () => {
  const f = fixture(1)
  const call = f.control.callAny.bind(f.control)
  f.control.callAny = async (...args: Parameters<typeof call>) => {
    const result = await call(...args)
    if (args[0] === 'ui.window.state') f.open['bottom-right'] = null
    return result
  }
  await expect(applyPhase({ ...f, phase: 0, previous: null, signal: new AbortController().signal })).rejects.toThrow('window 0: bottom-right shows null, expected panel:quirky.editor/explorer')
})

test('missing tasks names its window and all waits share the phase deadline', async () => {
  jest.useFakeTimers()
  const f = fixture(3)
  f.windows.waitForRequest = async (index, matches, options) => {
    if (index !== 1 || !matches('quirky.tasks/state', {})) return { at: performance.now(), method: 'ready', params: {} }
    const pending = Promise.withResolvers<RequestProof>()
    setTimeout(() => pending.resolve(null), options.timeoutMs)
    return pending.promise
  }
  const started = performance.now()
  const result = applyPhase({ ...f, phase: 0, previous: 1, signal: new AbortController().signal })
  await result
  const setup = applyPhase({ ...f, phase: 0, previous: null, signal: new AbortController().signal })
  const rejection = setup.then(() => null, (error: unknown) => error)
  await flush()
  timers.advanceTimersByTime(30_000)
  await flush()
  expect(await rejection).toEqual(new Error('window 1: tasks panel did not mount within 30000ms'))
  expect(performance.now() - started).toBe(30_000)
})

test('three missed runtime panel mounts finish concurrently within thirty seconds', async () => {
  jest.useFakeTimers()
  const f = fixture(3)
  f.windows.waitForRequest = async (_index, _matches, options) => {
    const pending = Promise.withResolvers<RequestProof>()
    setTimeout(() => pending.resolve(null), options.timeoutMs)
    return pending.promise
  }
  const result = applyPhase({ ...f, phase: 0, previous: 1, signal: new AbortController().signal })
  await flush()
  timers.advanceTimersByTime(30_000)
  await flush()
  expect((await result).missing).toHaveLength(6)
  expect((await result).applyMs).toBe(30_000)
})

test('a hung layout RPC consumes the same single phase deadline', async () => {
  jest.useFakeTimers()
  const f = fixture(1)
  f.control.callAny = () => Promise.withResolvers<never>().promise
  const result = applyPhase({ ...f, phase: 1, previous: 0, signal: new AbortController().signal })
  await flush()
  timers.advanceTimersByTime(30_000)
  await flush()
  expect((await result).error).toContain('30000ms')
  expect((await result).applyMs).toBe(30_000)
})

test('the day records scheduled sequences and immediately catches up after consecutive overruns', async () => {
  jest.useFakeTimers()
  const f = fixture(1)
  const navigated: string[] = []
  f.windows.navigate = async (index: number, requested: string) => {
    navigated.push(requested)
    const pending = Promise.withResolvers<void>()
    setTimeout(pending.resolve, 2_000)
    await pending.promise
    return { index, from: 'a', requested, settled: requested, proof: { at: performance.now(), method: 'quirky.git/status', worktree: requested }, ok: true, followMs: 2_000, error: null }
  }
  const driver = startDay({ ...f, startedAt: performance.now(), signal: new AbortController().signal, schedule: [
    { at: 0, kind: 'switch', seq: 7, index: 0, to: 'b' },
    { at: 1, kind: 'switch', seq: 8, index: 0, to: 'c' },
    { at: 2, kind: 'phase', seq: 9, phase: 1 }
  ] })
  await flush()
  timers.advanceTimersByTime(2_000); await flush()
  expect(navigated).toEqual(['b', 'c'])
  timers.advanceTimersByTime(2_000); await flush()
  const records = await driver.stop()
  expect(records.switches.map(({ seq }) => seq)).toEqual([7, 8])
  expect(records.phases.map(({ seq }) => seq)).toEqual([9])
  expect(records.drainError).toBeNull()
})

test('stop awaits active reconciliation and seals records even after a late result', async () => {
  const f = fixture(1)
  const reconciliation = Promise.withResolvers<Omit<SwitchRecord, 'at' | 'seq'>>()
  let aborted = false
  f.windows.navigate = async (_index: number, _to: string, { signal }: { signal: AbortSignal }) => {
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
    return reconciliation.promise
  }
  const driver = startDay({ ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'switch', seq: 0, index: 0, to: 'b' }] })
  await flush()
  let stopped = false
  const draining = driver.stop().then((result) => { stopped = true; return result })
  await flush()
  expect(aborted).toBe(true)
  expect(stopped).toBe(false)
  reconciliation.resolve({ index: 0, from: 'a', requested: 'b', settled: 'b', proof: null, ok: true, followMs: null, error: null })
  const result = await draining
  expect(result.switches).toEqual([])
  expect(result.drainError).toBeNull()
  expect(await driver.stop()).toEqual(result)
})

test('stop caps a non-draining action and never publishes its eventual result', async () => {
  jest.useFakeTimers()
  const f = fixture(1)
  const late = Promise.withResolvers<Omit<SwitchRecord, 'at' | 'seq'>>()
  f.windows.navigate = () => late.promise
  const driver = startDay({ ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'switch', seq: 0, index: 0, to: 'b' }] })
  await flush()
  const stopped = driver.stop()
  timers.advanceTimersByTime(STOP_DRAIN_MS); await flush()
  const records = await stopped
  expect(records.drainError).toBe('active action did not drain within 10000ms')
  late.resolve({ index: 0, from: 'a', requested: 'b', settled: 'b', proof: null, ok: true, followMs: null, error: null }); await flush()
  expect(records.switches).toEqual([])
  expect((await driver.stop()).switches).toEqual([])
})

test('the exact staggered day schedule leaves each action its own grace', () => {
  const schedule = daySchedule({ seconds: 300, windows: [{ index: 0, worktree: 'a' }, { index: 1, worktree: 'c' }], worktrees: ['a', 'b', 'c', 'd'] })
  expect(schedule).toEqual([
    { at: 15, kind: 'task', seq: 0, index: 0 }, { at: 20, kind: 'task', seq: 0, index: 1 },
    { at: 60, kind: 'switch', seq: 0, index: 0, to: 'b' }, { at: 90, kind: 'switch', seq: 0, index: 1, to: 'd' },
    { at: 120, kind: 'phase', seq: 1, phase: 1 }, { at: 120, kind: 'switch', seq: 1, index: 0, to: 'c' },
    { at: 150, kind: 'switch', seq: 1, index: 1, to: 'a' }, { at: 180, kind: 'switch', seq: 2, index: 0, to: 'd' },
    { at: 210, kind: 'switch', seq: 2, index: 1, to: 'b' }, { at: 240, kind: 'phase', seq: 2, phase: 0 },
    { at: 240, kind: 'switch', seq: 3, index: 0, to: 'a' }, { at: 270, kind: 'switch', seq: 3, index: 1, to: 'c' }
  ])
})

test('stop aborts phase mount waits and suppresses the unfinished phase record', async () => {
  const f = fixture(1)
  let mountStarted = false
  f.windows.waitForRequest = async (_index, _matches, { signal }) => {
    mountStarted = true
    const pending = Promise.withResolvers<RequestProof>()
    signal.addEventListener('abort', () => pending.resolve(null), { once: true })
    return pending.promise
  }
  const driver = startDay({
    ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'phase', seq: 1, phase: 1 }, { at: 0, kind: 'phase', seq: 2, phase: 0 }]
  })
  await flush()
  expect(mountStarted).toBe(true)
  const result = await driver.stop()
  expect(result.phases.map(({ seq }) => seq)).toEqual([1])
  expect(result.drainError).toBeNull()
})

test('layout writes and mount proof consume one shared deadline', async () => {
  jest.useFakeTimers()
  const f = fixture(1)
  const firstWrite = Promise.withResolvers<void>()
  const call = f.control.callAny.bind(f.control)
  let first = true
  f.control.callAny = async (...args: Parameters<typeof call>) => {
    if (first) {
      first = false
      await firstWrite.promise
    }
    return call(...args)
  }
  const applying = applyPhase({ ...f, phase: 0, previous: null, signal: new AbortController().signal })
  timers.advanceTimersByTime(20_000)
  firstWrite.resolve()
  await flush()
  await applying
  expect(f.waits).toHaveLength(3)
  for (const { options } of f.waits) expect(options.timeoutMs).toBe(10_000)
})

test('rejects a late final readback even when the timeout callback has not run', async () => {
  jest.useFakeTimers()
  const f = fixture(1)
  let now = performance.now()
  const initial = now
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  const call = f.control.callAny.bind(f.control)
  f.control.callAny = async (...args: Parameters<typeof call>) => {
    const result = await call(...args)
    if (args[0] === 'ui.window.state') now = initial + 30_001
    return result
  }
  try {
    const result = await applyPhase({ ...f, phase: 1, previous: 0, signal: new AbortController().signal })
    expect(result.error).toContain('30000ms')
  } finally {
    clock.mockRestore()
  }
})

test('rejects a late drain even when its timeout callback has not run', async () => {
  jest.useFakeTimers()
  const f = fixture(1)
  let now = performance.now()
  const initial = now
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  const navigation = Promise.withResolvers<Omit<SwitchRecord, 'at' | 'seq'>>()
  f.windows.navigate = () => navigation.promise
  const driver = startDay({
    ...f, startedAt: now, signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'switch', seq: 0, index: 0, to: 'b' }]
  })
  try {
    await flush()
    const result = driver.stop()
    now = initial + STOP_DRAIN_MS + 1
    navigation.resolve({ index: 0, from: 'a', requested: 'b', settled: 'b', proof: null, ok: true, followMs: null, error: null })
    expect((await result).drainError).toBe('active action did not drain within 10000ms')
  } finally {
    clock.mockRestore()
  }
})

test('a failed phase readback does not skip the next remount proofs', async () => {
  const f = fixture(1)
  let first = true
  const call = f.control.callAny.bind(f.control)
  f.control.callAny = async (...args: Parameters<typeof call>) => {
    if (args[0] === 'ui.window.state' && first) {
      first = false
      throw new Error('readback failed after layout applied')
    }
    return call(...args)
  }
  let proofWaits = 0
  f.windows.waitForRequest = async () => { proofWaits++; return null }
  const driver = startDay({
    ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'phase', seq: 1, phase: 1 }, { at: 0, kind: 'phase', seq: 2, phase: 0 }]
  })
  await flush()
  const result = await driver.stop()
  expect(result.phases).toHaveLength(2)
  expect(result.phases[0]!.ok).toBe(false)
  expect(result.phases[1]!.ok).toBe(false)
  expect(result.phases[1]!.missing).toEqual([{ index: 0, panel: 'checks' }, { index: 0, panel: 'explorer' }])
  expect(proofWaits).toBe(2)
})

function tasksFixture(mutationSucceeds = true) {
  const f = fixture(2)
  let preset = 'all'
  let revision = 0
  const methods: string[] = []
  const patches: unknown[] = []
  f.control.callAny = async (method, params) => {
    methods.push(method)
    if (method === 'quirky.tasks/preferences') {
      patches.push(params)
      if (mutationSucceeds && params !== null && typeof params === 'object' && 'defaultTaskViewPreset' in params
        && typeof params.defaultTaskViewPreset === 'string') {
        preset = params.defaultTaskViewPreset
        revision++
      }
    }
    return { revision, preferences: { defaultTaskViewPreset: preset } }
  }
  f.windows.waitForRequest = async (_index, matches) => {
    expect(matches('quirky.tasks/state', {})).toBe(true)
    expect(matches('quirky.git/status', {})).toBe(false)
    return { at: performance.now(), method: 'quirky.tasks/state', params: {} }
  }
  return { ...f, methods, patches }
}

test('records a real distinct Tasks preference write and renderer follow per target window', async () => {
  const f = tasksFixture()
  const driver = startDay({
    ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'task', seq: 0, index: 0 }, { at: 0, kind: 'task', seq: 0, index: 1 }]
  })
  await flush()
  const result = await driver.stop()
  expect(f.methods).toEqual([
    'quirky.tasks/state', 'quirky.tasks/preferences', 'quirky.tasks/state',
    'quirky.tasks/state', 'quirky.tasks/preferences', 'quirky.tasks/state'
  ])
  expect(f.patches).toEqual([{ defaultTaskViewPreset: 'issues' }, { defaultTaskViewPreset: 'all' }])
  expect(result.taskInteractions.map(({ index, seq, ok, method, proof }) => ({ index, seq, ok, method, proofMethod: proof?.method }))).toEqual([
    { index: 0, seq: 0, ok: true, method: 'quirky.tasks/preferences', proofMethod: 'quirky.tasks/state' },
    { index: 1, seq: 0, ok: true, method: 'quirky.tasks/preferences', proofMethod: 'quirky.tasks/state' }
  ])
})

test('does not accept a Tasks mutation whose fresh state did not change', async () => {
  const f = tasksFixture(false)
  const driver = startDay({
    ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'task', seq: 0, index: 0 }]
  })
  await flush()
  const result = await driver.stop()
  expect(result.taskInteractions[0]).toMatchObject({ ok: false, proof: null, error: 'Tasks preference change was not confirmed' })
})

test('bounds missing Tasks follow proof by the single interaction deadline', async () => {
  jest.useFakeTimers()
  const f = tasksFixture()
  f.windows.waitForRequest = () => Promise.withResolvers<RequestProof>().promise
  const driver = startDay({
    ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'task', seq: 0, index: 0 }]
  })
  await flush()
  timers.advanceTimersByTime(TASK_FOLLOW_MS)
  await flush()
  const result = await driver.stop()
  expect(result.taskInteractions[0]).toMatchObject({ ok: false, proof: null })
  expect(result.taskInteractions[0]!.error).toContain('10000ms')
})

test('stop suppresses an interrupted Tasks action and drops late readback', async () => {
  const f = tasksFixture()
  const late = Promise.withResolvers<unknown>()
  f.control.callAny = () => late.promise
  const driver = startDay({
    ...f, startedAt: performance.now(), signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'task', seq: 0, index: 0 }]
  })
  await flush()
  const result = await driver.stop()
  expect(result.taskInteractions).toEqual([])
  late.resolve({ revision: 1, preferences: { defaultTaskViewPreset: 'all' } })
  await flush()
  expect(f.patches).toEqual([])
  expect(result.taskInteractions).toEqual([])
})

test('Tasks interactions leave their own ten-second completion grace', () => {
  const inputs = { windows: [{ index: 0, worktree: 'a' }, { index: 1, worktree: 'b' }], worktrees: ['a', 'b'] }
  expect(daySchedule({ ...inputs, seconds: 24 })).toEqual([])
  expect(daySchedule({ ...inputs, seconds: 25 })).toEqual([{ at: 15, kind: 'task', seq: 0, index: 0 }])
  expect(daySchedule({ ...inputs, seconds: 30 })).toEqual([
    { at: 15, kind: 'task', seq: 0, index: 0 }, { at: 20, kind: 'task', seq: 0, index: 1 }
  ])
})

test('does not count a renderer Tasks request sent before the preference mutation', async () => {
  jest.useFakeTimers()
  const f = tasksFixture()
  let now = performance.now()
  const initial = now
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  const call = f.control.callAny.bind(f.control)
  let first = true
  f.control.callAny = async (...args: Parameters<typeof call>) => {
    const result = await call(...args)
    if (first) {
      first = false
      now = initial + 100
    }
    return result
  }
  f.windows.waitForRequest = async (_index, matches, { since }) => {
    const old = { at: initial + 50, method: 'quirky.tasks/state', params: {} }
    return old.at >= since && matches(old.method, old.params) ? old : null
  }
  const driver = startDay({
    ...f, startedAt: now, signal: new AbortController().signal,
    schedule: [{ at: 0, kind: 'task', seq: 0, index: 0 }]
  })
  try {
    await flush()
    expect((await driver.stop()).taskInteractions[0]).toMatchObject({ ok: false, proof: null })
  } finally {
    clock.mockRestore()
  }
})
