import { describe, expect, test } from 'bun:test'
import { NOMINAL_FRAME_MS, type FrameTiming } from './contracts.ts'
import { extractFrameTiming, normalizeFrameTiming } from './frame-timing.ts'

const PID = 17
const TID = 23
const ORIGIN_US = 8_000_000

type MarkName = { kind: 'application-raf' | 'ready-to-frame'; requested: string; delivered: string }
type Span = { start: number; end: number; pid?: number; tid?: number }
type TraceOptions = {
  wallMs: number
  kind?: MarkName['kind'] | null
  requestedAt?: number
  deliveredAt?: number
  receiveAt?: number[]
  echoAt?: number[]
  tasks?: Span[]
  duplicateCandidateMarks?: boolean
  missing?: string[]
  markThreads?: Partial<Record<string, { pid?: number; tid?: number }>>
  coverBoundaries?: boolean
  dataLossOccurred?: boolean
}

function makeObservation(options: TraceOptions) {
  const wallMs = options.wallMs
  const requestedAt = options.requestedAt ?? 20
  const deliveredAt = options.deliveredAt ?? 80
  const candidate = options.kind === null ? undefined : {
    kind: options.kind ?? 'application-raf',
    requested: 'candidate-request',
    delivered: 'candidate-delivery',
  } as const
  const marks = {
    action: 'action-start',
    end: 'painted-end',
    ...(candidate === undefined ? {} : { candidate }),
    ...(options.echoAt === undefined ? {} : { echoReceived: 'echo-arrival' }),
  }
  const events: Record<string, unknown>[] = []
  const mark = (name: string, at: number): void => {
    if (options.missing?.includes(name)) return
    const thread = options.markThreads?.[name]
    events.push({
      cat: 'blink.user_timing',
      name,
      ph: 'I',
      ts: ORIGIN_US + at * 1000,
      pid: thread?.pid ?? PID,
      tid: thread?.tid ?? TID,
    })
  }
  mark(marks.action, 0)
  mark(marks.end, wallMs)
  for (const at of options.echoAt ?? []) mark('echo-arrival', at)
  if (candidate) {
    mark(candidate.requested, requestedAt)
    mark(candidate.delivered, deliveredAt)
    if (options.duplicateCandidateMarks) {
      mark(candidate.requested, requestedAt)
      mark(candidate.delivered, deliveredAt)
    }
  }
  for (const at of options.receiveAt ?? []) {
    events.push({ cat: 'devtools.timeline', name: 'WebSocketReceive', ph: 'I', ts: ORIGIN_US + at * 1000, pid: PID, tid: TID })
  }

  if (options.coverBoundaries !== false) {
    const boundarySpans: Span[] = [
      { start: -1, end: 0 },
      { start: wallMs, end: wallMs + 1 },
      ...(candidate ? [
        { start: requestedAt - 1, end: requestedAt },
        { start: deliveredAt, end: deliveredAt + 1 },
      ] : []),
      ...(options.receiveAt ?? []).map((at) => ({ start: at - 1, end: at })),
    ]
    options.tasks = [...boundarySpans, ...(options.tasks ?? [])]
  }
  for (const span of options.tasks ?? []) {
    const start = ORIGIN_US + span.start * 1000
    events.push({
      cat: 'toplevel',
      name: 'ThreadControllerImpl::RunTask',
      ph: 'X',
      ts: start,
      dur: (span.end - span.start) * 1000,
      pid: span.pid ?? PID,
      tid: span.tid ?? TID,
    })
  }

  const trace = JSON.stringify({ traceEvents: events, ...(options.dataLossOccurred ? { dataLossOccurred: true } : {}) })
  const startedAt = 1_000
  return {
    trace,
    observation: { startedAt, endedAt: startedAt + wallMs, marks },
  }
}

function account(options: TraceOptions) {
  const input = makeObservation(options)
  return extractFrameTiming(input.trace, input.observation)
}

function expectUnavailable(value: FrameTiming, reason: string, wallMs: number): void {
  expect(value).toMatchObject({
    status: 'unavailable',
    wallMs,
    effectiveMs: wallMs,
    deductionMs: 0,
    candidate: null,
  })
  expect(value.reason).toContain(reason)
}


describe('normalizeFrameTiming', () => {
  test('unions nested renderer tasks, clips intervals, and deducts only idle time beyond one frame', () => {
    const result = normalizeFrameTiming({
      startedAt: 0,
      endedAt: 100,
      candidate: {
        kind: 'ready-to-frame',
        requestedAt: 20,
        deliveredAt: 80,
        receiveCapAt: null,
        busySpans: [
          { start: 30, end: 40 },
          { start: 35, end: 45 },
          { start: 35, end: 45 },
          { start: 90, end: 110 },
        ],
      },
    })
    expect(result.status).toBe('complete')
    expect(result.wallMs).toBe(100)
    expect(result.deductionMs).toBeCloseTo(45 - NOMINAL_FRAME_MS, 9)
    expect(result.effectiveMs).toBeCloseTo(55 + NOMINAL_FRAME_MS, 9)
  })

  test('clips a candidate to raw bounds and its application receive cap', () => {
    const result = normalizeFrameTiming({
      startedAt: 10,
      endedAt: 110,
      candidate: {
        kind: 'application-raf',
        requestedAt: -20,
        deliveredAt: 130,
        receiveCapAt: 40,
        busySpans: [],
      },
    })
    expect(result.deductionMs).toBeCloseTo(70 - NOMINAL_FRAME_MS, 9)
    expect(result.effectiveMs).toBeCloseTo(30 + NOMINAL_FRAME_MS, 9)
    expect(result.candidate).toMatchObject({ receiveCapAt: 40 })
  })

  test('rejects invalid raw endpoints and out-of-order candidate boundaries', () => {
    for (const [startedAt, endedAt] of [[0, 0], [2, 1], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY]]) {
      expect(() => normalizeFrameTiming({ startedAt, endedAt, candidate: null })).toThrow()
    }
    expect(() => normalizeFrameTiming({
      startedAt: 0,
      endedAt: 100,
      candidate: { kind: 'ready-to-frame', requestedAt: 80, deliveredAt: 20, receiveCapAt: null, busySpans: [] },
    })).toThrow()
  })
})

describe('extractFrameTiming', () => {
  test('scenario 2: keeps raw duration for a normal native frame and caps only excess final-slot idle wait', () => {
    const oneFrame = 1000 / 60
    const normal = account({ wallMs: 40 + oneFrame, requestedAt: 20, deliveredAt: 20 + oneFrame, receiveAt: [10] })
    const delayed = account({ wallMs: 40 + 4 * oneFrame, requestedAt: 20, deliveredAt: 20 + 4 * oneFrame, receiveAt: [10] })

    expect(normal.status).toBe('complete')
    expect(normal.wallMs).toBeCloseTo(40 + oneFrame, 9)
    expect(normal.effectiveMs).toBeCloseTo(40 + oneFrame, 9)
    expect(normal.deductionMs).toBeCloseTo(0, 9)
    expect(delayed.status).toBe('complete')
    expect(delayed.wallMs).toBeCloseTo(40 + 4 * oneFrame, 9)
    expect(delayed.deductionMs).toBeCloseTo(3 * oneFrame, 9)
    expect(delayed.effectiveMs).toBeCloseTo(40 + oneFrame, 9)
  })

  test('scenario 3: renderer work and later inbound traffic remain charged', () => {
    const oneFrame = 1000 / 60
    const occupied = account({
      wallMs: 40 + 4 * oneFrame,
      requestedAt: 20,
      deliveredAt: 20 + 4 * oneFrame,
      receiveAt: [10],
      tasks: [{ start: 20, end: 70 }],
    })
    const laterReceive = account({
      wallMs: 40 + 4 * oneFrame,
      requestedAt: 20,
      deliveredAt: 20 + 4 * oneFrame,
      receiveAt: [10, 80],
    })

    expect(occupied.deductionMs).toBeCloseTo(0, 9)
    expect(occupied.effectiveMs).toBeCloseTo(occupied.wallMs, 9)
    expect(laterReceive.deductionMs).toBe(0)
    expect(laterReceive.effectiveMs).toBe(laterReceive.wallMs)
  })

  test('application rAF without an inbound receive is valid evidence but has no eligible candidate', () => {
    const result = account({ wallMs: 100, requestedAt: 20, deliveredAt: 80 })
    expect(result).toMatchObject({ status: 'complete', wallMs: 100, effectiveMs: 100, deductionMs: 0, candidate: null })
    expect(result.reason).toBeTruthy()
  })

  test('uses a stable ready-to-frame candidate without requiring WebSocket traffic', () => {
    const result = account({ wallMs: 100, kind: 'ready-to-frame', requestedAt: 20, deliveredAt: 80 })
    expect(result.status).toBe('complete')
    expect(result.deductionMs).toBeCloseTo(60 - NOMINAL_FRAME_MS, 9)
    expect(result.effectiveMs).toBeCloseTo(40 + NOMINAL_FRAME_MS, 9)
    expect(result.candidate?.kind).toBe('ready-to-frame')
  })

  test('nested and duplicate task/candidate marks contribute at most one final-slot deduction', () => {
    const result = account({
      wallMs: 100,
      requestedAt: 20,
      deliveredAt: 80,
      receiveAt: [10],
      duplicateCandidateMarks: true,
      tasks: [
        { start: 30, end: 40 },
        { start: 35, end: 45 },
        { start: 30, end: 40 },
      ],
    })
    expect(result.deductionMs).toBeCloseTo(45 - NOMINAL_FRAME_MS, 9)
    expect(result.effectiveMs).toBeCloseTo(55 + NOMINAL_FRAME_MS, 9)
  })

  test('ignores top-level task spans from another renderer thread', () => {
    const oneFrame = 1000 / 60
    const result = account({
      wallMs: 40 + 4 * oneFrame,
      requestedAt: 20,
      deliveredAt: 20 + 4 * oneFrame,
      receiveAt: [10],
      tasks: [{ start: 20, end: 70, pid: PID, tid: TID + 1 }],
    })
    expect(result.deductionMs).toBeCloseTo(3 * oneFrame, 9)
  })

  test('clips the selected task intersections to observation and candidate bounds', () => {
    const result = account({
      wallMs: 100,
      kind: 'ready-to-frame',
      requestedAt: -20,
      deliveredAt: 120,
      tasks: [{ start: -10, end: 5 }, { start: 30, end: 50 }, { start: 90, end: 110 }],
    })
    expect(result.status).toBe('complete')
    expect(result.effectiveMs).toBeCloseTo(100 - (65 - NOMINAL_FRAME_MS), 9)
    expect(result.candidate?.busySpans).toEqual([
      { start: 1_000, end: 1_005 },
      { start: 1_030, end: 1_050 },
      { start: 1_090, end: 1_100 },
    ])
  })

  test('falls back with explicit reasons for malformed, lost, oversized, or incomplete traces', () => {
    const valid = makeObservation({ wallMs: 80, receiveAt: [10] })
    expectUnavailable(extractFrameTiming('{not json', valid.observation), 'malformed-trace', 80)
    expectUnavailable(extractFrameTiming(makeObservation({ wallMs: 80, receiveAt: [10], dataLossOccurred: true }).trace, valid.observation), 'trace-data-loss', 80)
    expectUnavailable(extractFrameTiming(' '.repeat(32 * 1024 * 1024 + 1), valid.observation), 'trace-too-large', 80)

    for (const missing of ['action-start', 'painted-end']) {
      const input = makeObservation({ wallMs: 80, receiveAt: [10], missing: [missing] })
      expectUnavailable(extractFrameTiming(input.trace, input.observation), 'missing-mark', 80)
    }
  })

  test('falls back when boundary marks use inconsistent renderer threads or miss top-level task coverage', () => {
    const differentThreads = makeObservation({
      wallMs: 80,
      receiveAt: [10],
      markThreads: { 'painted-end': { pid: PID, tid: TID + 1 } },
    })
    expectUnavailable(extractFrameTiming(differentThreads.trace, differentThreads.observation), 'renderer-thread-mismatch', 80)

    const uncovered = makeObservation({ wallMs: 80, receiveAt: [10], coverBoundaries: false })
    expectUnavailable(extractFrameTiming(uncovered.trace, uncovered.observation), 'missing-task-coverage', 80)
  })

  test('rejects out-of-order trace marks as unavailable instead of clamping the accounting', () => {
    const input = makeObservation({ wallMs: 100, requestedAt: 80, deliveredAt: 20, receiveAt: [10] })
    expectUnavailable(extractFrameTiming(input.trace, input.observation), 'out-of-order-marks', 100)
  })

  test('invalid raw endpoints remain observation failures rather than accounting fallbacks', () => {
    const input = makeObservation({ wallMs: 80, receiveAt: [10] })
    expect(() => extractFrameTiming(input.trace, { ...input.observation, endedAt: input.observation.startedAt })).toThrow()
  })
})

describe('own echo arrival receive cap', () => {
  const input = {
    wallMs: 100, requestedAt: 20, deliveredAt: 90, receiveAt: [85], coverBoundaries: false,
    tasks: [0, 10, 20, 85, 90, 100].map(start => ({ start, end: start + 1 }))
  }
  test('retains unrelated receive busy work but caps at the own arrival under solo and flood traffic', () => {
    for (const receiveAt of [[85], [85, 85.2, 85.4, 85.8]]) {
      const value = account({ ...input, receiveAt, echoAt: [10] })
      expect(value).toMatchObject({
        status: 'complete', wallMs: 100,
        candidate: { receiveCapAt: 1010, receiveCapSource: 'echo-arrival', requestedAt: 1020,
          busySpans: [{ start: 1020, end: 1021 }, { start: 1085, end: 1086 }] }
      })
      expect(value.deductionMs).toBeCloseTo(51.33333333333333, 9)
      expect(value.effectiveMs).toBeCloseTo(48.66666666666667, 9)
    }
  })
  test('falls back to latest receive for absent, conflicting, wrong-thread, out-of-bounds or uncovered marks', () => {
    for (const options of [
      {}, { echoAt: [] }, { echoAt: [10, 11] },
      { echoAt: [10], markThreads: { 'echo-arrival': { tid: TID + 1 } } },
      { echoAt: [-1] }, { echoAt: [95] }, { echoAt: [101] }, { echoAt: [15] }
    ]) {
      const value = account({ ...input, ...options })
      expect(value).toMatchObject({
        status: 'complete', wallMs: 100, effectiveMs: 100, deductionMs: 0,
        candidate: { receiveCapAt: 1085, receiveCapSource: 'latest-receive' }
      })
    }
  })
  test('ready-to-frame keeps its semantics without a receive cap or provenance', () => {
    const value = account({ ...input, kind: 'ready-to-frame', echoAt: [10] })
    expect(value.candidate).toMatchObject({ receiveCapAt: null, receiveCapSource: null })
  })
})
