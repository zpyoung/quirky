import { NOMINAL_FRAME_MS, type FrameTiming } from './contracts.ts'

const MAX_TRACE_BYTES = 32 * 1024 * 1024
const TRACE_CLOCK_TOLERANCE_MS = 2

export type FrameTimingObservation = {
  startedAt: number
  endedAt: number
  marks: {
    action: string
    end: string
    echoReceived?: string
    candidate?: {
      kind: 'application-raf' | 'ready-to-frame'
      requested: string
      delivered: string
    }
  }
}

type TraceEvent = Record<string, unknown> & {
  cat?: string
  name?: string
  ph?: string
  ts?: number
  dur?: number
  pid?: number
  tid?: number
}
type TaskSpan = { start: number; end: number }

class EvidenceFault extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

function evidenceFault(reason: string): never {
  throw new EvidenceFault(reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function categoryHas(event: TraceEvent, category: string): boolean {
  return typeof event.cat === 'string' && event.cat.split(',').includes(category)
}

function validRawBounds(startedAt: number, endedAt: number): number {
  const wallMs = endedAt - startedAt
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || !Number.isFinite(wallMs) || wallMs <= 0) {
    throw new Error('Frame timing requires finite, increasing raw endpoints')
  }
  return wallMs
}

function unavailable(wallMs: number, reason: string): FrameTiming {
  return { status: 'unavailable', wallMs, effectiveMs: wallMs, deductionMs: 0, candidate: null, reason }
}

function mergeSpans(spans: { start: number; end: number }[]): { start: number; end: number }[] {
  spans.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: { start: number; end: number }[] = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

export function normalizeFrameTiming(input: {
  startedAt: number
  endedAt: number
  candidate: FrameTiming['candidate']
}): FrameTiming {
  const wallMs = validRawBounds(input.startedAt, input.endedAt)
  if (input.candidate === null) {
    return {
      status: 'complete',
      wallMs,
      effectiveMs: wallMs,
      deductionMs: 0,
      candidate: null,
      reason: 'no-eligible-final-frame-candidate',
    }
  }

  const candidate = input.candidate
  if (
    candidate.kind !== 'application-raf' && candidate.kind !== 'ready-to-frame' ||
    !Number.isFinite(candidate.requestedAt) ||
    !Number.isFinite(candidate.deliveredAt) ||
    candidate.receiveCapAt !== null && !Number.isFinite(candidate.receiveCapAt) ||
    !Array.isArray(candidate.busySpans) ||
    candidate.kind === 'application-raf' && candidate.receiveCapAt === null ||
    candidate.kind === 'ready-to-frame' && candidate.receiveCapAt !== null
  ) {
    throw new Error('Invalid final-frame candidate evidence')
  }

  const requestedAt = Math.max(input.startedAt, candidate.requestedAt, candidate.receiveCapAt ?? Number.NEGATIVE_INFINITY)
  const deliveredAt = Math.min(input.endedAt, candidate.deliveredAt)
  if (requestedAt > deliveredAt) throw new Error('Final-frame candidate boundaries are out of order')

  const intersections: { start: number; end: number }[] = []
  for (const span of candidate.busySpans) {
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end) || span.start > span.end) {
      throw new Error('Invalid top-level task intersection')
    }
    const start = Math.max(requestedAt, span.start)
    const end = Math.min(deliveredAt, span.end)
    if (start < end) intersections.push({ start, end })
  }
  const busySpans = mergeSpans(intersections)
  let busyMs = 0
  for (const span of busySpans) busyMs += span.end - span.start

  const idleMs = deliveredAt - requestedAt - busyMs
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new Error('Invalid final-frame idle accounting')
  const deductionMs = Math.max(0, idleMs - NOMINAL_FRAME_MS)
  const effectiveMs = wallMs - deductionMs
  if (!Number.isFinite(effectiveMs) || effectiveMs <= 0 || effectiveMs > wallMs) {
    throw new Error('Invalid normalized frame duration')
  }

  return {
    status: 'complete',
    wallMs,
    effectiveMs,
    deductionMs,
    candidate: { ...candidate, requestedAt, deliveredAt, busySpans,
      receiveCapSource: candidate.kind === 'application-raf' ? candidate.receiveCapSource ?? 'latest-receive' : null },
    reason: null,
  }
}

function parseTrace(trace: string): TraceEvent[] {
  if (Buffer.byteLength(trace, 'utf8') > MAX_TRACE_BYTES) evidenceFault('trace-too-large')
  let parsed: unknown
  try {
    parsed = JSON.parse(trace)
  } catch {
    evidenceFault('malformed-trace')
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isRecord)) evidenceFault('malformed-trace')
    return parsed as TraceEvent[]
  }
  if (!isRecord(parsed)) evidenceFault('malformed-trace')
  if (parsed.dataLossOccurred === true || isRecord(parsed.metadata) && parsed.metadata.dataLossOccurred === true) {
    evidenceFault('trace-data-loss')
  }
  if (!Array.isArray(parsed.traceEvents) || !parsed.traceEvents.every(isRecord)) evidenceFault('malformed-trace')
  return parsed.traceEvents as TraceEvent[]
}

function markEvent(events: TraceEvent[], name: string): TraceEvent {
  if (!name) evidenceFault('missing-mark')
  const matches = events.filter((event) => event.name === name && categoryHas(event, 'blink.user_timing') && event.ph === 'I')
  if (matches.length === 0) evidenceFault('missing-mark')

  const unique = new Map<string, TraceEvent>()
  for (const event of matches) {
    if (!Number.isFinite(event.ts) || !Number.isFinite(event.pid) || !Number.isFinite(event.tid)) evidenceFault('invalid-mark')
    const key = `${event.pid}:${event.tid}:${event.ts}`
    unique.set(key, event)
  }
  if (unique.size !== 1) evidenceFault('ambiguous-mark')
  return unique.values().next().value as TraceEvent
}

function taskEvents(events: TraceEvent[], pid: number, tid: number): { event: TraceEvent; start: number; end: number }[] {
  const spans: { event: TraceEvent; start: number; end: number }[] = []
  for (const event of events) {
    if (event.name !== 'ThreadControllerImpl::RunTask' || !categoryHas(event, 'toplevel') || event.ph !== 'X') continue
    if (event.pid !== pid || event.tid !== tid) continue
    if (!Number.isFinite(event.ts) || !Number.isFinite(event.dur) || (event.dur as number) < 0) {
      evidenceFault('invalid-task-span')
    }
    const start = event.ts as number
    const end = start + (event.dur as number)
    if (!Number.isFinite(end)) evidenceFault('invalid-task-span')
    spans.push({ event, start, end })
  }
  return spans
}

function eventTimestamp(event: TraceEvent): number {
  if (!Number.isFinite(event.ts)) evidenceFault('invalid-trace-event')
  return event.ts as number
}

export function extractFrameTiming(trace: string, observation: FrameTimingObservation): FrameTiming {
  const wallMs = validRawBounds(observation.startedAt, observation.endedAt)
  try {
    const events = parseTrace(trace)
    const action = markEvent(events, observation.marks.action)
    const end = markEvent(events, observation.marks.end)
    const actionTs = eventTimestamp(action)
    const endTs = eventTimestamp(end)
    if (action.pid !== end.pid || action.tid !== end.tid) evidenceFault('renderer-thread-mismatch')
    if (endTs <= actionTs) evidenceFault('out-of-order-marks')

    const traceWallMs = (endTs - actionTs) / 1000
    if (Math.abs(traceWallMs - wallMs) > Math.max(TRACE_CLOCK_TOLERANCE_MS, wallMs * 0.01)) {
      evidenceFault('trace-clock-mismatch')
    }

    let requested: TraceEvent | undefined
    let delivered: TraceEvent | undefined
    const markBoundaries: TraceEvent[] = [action, end]
    if (observation.marks.candidate) {
      requested = markEvent(events, observation.marks.candidate.requested)
      delivered = markEvent(events, observation.marks.candidate.delivered)
      if (requested.pid !== action.pid || requested.tid !== action.tid || delivered.pid !== action.pid || delivered.tid !== action.tid) {
        evidenceFault('renderer-thread-mismatch')
      }
      if (eventTimestamp(delivered) < eventTimestamp(requested)) evidenceFault('out-of-order-marks')
      markBoundaries.push(requested, delivered)
    }

    const tasks = taskEvents(events, action.pid as number, action.tid as number)
    for (const mark of markBoundaries) {
      const ts = eventTimestamp(mark)
      if (!tasks.some((task) => task.start <= ts && ts <= task.end)) evidenceFault('missing-task-coverage')
    }

    const mapTimestamp = (timestampUs: number): number => observation.startedAt + (timestampUs - actionTs) / 1000
    if (!requested || !delivered || !observation.marks.candidate) {
      return normalizeFrameTiming({ startedAt: observation.startedAt, endedAt: observation.endedAt, candidate: null })
    }

    const requestedTs = eventTimestamp(requested)
    const deliveredTs = eventTimestamp(delivered)
    const kind = observation.marks.candidate.kind
    let receiveCapAt: number | null = null
    let receiveCapSource: 'echo-arrival' | 'latest-receive' | null = null
    if (kind === 'application-raf') {
      let latestReceiveTs: number | null = null
      for (const event of events) {
        if (event.name !== 'WebSocketReceive' || !categoryHas(event, 'devtools.timeline') || event.pid !== action.pid || event.tid !== action.tid) continue
        const timestamp = eventTimestamp(event)
        if (timestamp > actionTs && timestamp <= deliveredTs && (latestReceiveTs === null || timestamp > latestReceiveTs)) {
          latestReceiveTs = timestamp
        }
      }
      let ownArrivalTs: number | null = null
      if (observation.marks.echoReceived) {
        try {
          const own = markEvent(events, observation.marks.echoReceived)
          const timestamp = eventTimestamp(own)
          if (own.pid === action.pid && own.tid === action.tid
            && timestamp >= actionTs && timestamp <= Math.min(endTs, deliveredTs)
            && tasks.some(task => task.start <= timestamp && timestamp <= task.end)) ownArrivalTs = timestamp
        } catch (error) {
          if (!(error instanceof EvidenceFault)) throw error
        }
      }
      const selected = ownArrivalTs ?? latestReceiveTs
      if (selected === null) {
        return normalizeFrameTiming({ startedAt: observation.startedAt, endedAt: observation.endedAt, candidate: null })
      }
      if (!tasks.some(task => task.start <= selected && selected <= task.end)) evidenceFault('missing-task-coverage')
      receiveCapAt = mapTimestamp(selected)
      receiveCapSource = ownArrivalTs === null ? 'latest-receive' : 'echo-arrival'
    }

    const clippedRequestedAt = Math.max(observation.startedAt, mapTimestamp(requestedTs), receiveCapAt ?? Number.NEGATIVE_INFINITY)
    const clippedDeliveredAt = Math.min(observation.endedAt, mapTimestamp(deliveredTs))
    if (clippedRequestedAt > clippedDeliveredAt) evidenceFault('out-of-order-marks')

    const busySpans: TaskSpan[] = []
    for (const task of tasks) {
      const start = Math.max(clippedRequestedAt, mapTimestamp(task.start))
      const finish = Math.min(clippedDeliveredAt, mapTimestamp(task.end))
      if (start < finish) busySpans.push({ start, end: finish })
    }

    return normalizeFrameTiming({
      startedAt: observation.startedAt,
      endedAt: observation.endedAt,
      candidate: {
        kind,
        requestedAt: clippedRequestedAt,
        deliveredAt: clippedDeliveredAt,
        receiveCapAt,
        receiveCapSource,
        busySpans,
      },
    })
  } catch (error) {
    if (error instanceof EvidenceFault) return unavailable(wallMs, error.reason)
    return unavailable(wallMs, 'invalid-accounting-evidence')
  }
}
