import { expect, test } from 'bun:test'
import type { EventRecord, ProcessRow, Sample, SoakConfig, WorkerBeat } from './contracts'
import type { SoakEvidence } from './verdict'
import { judge } from './verdict'

type ConfigOverrides = {
  minutes?: number
  out?: string
  limits?: Partial<SoakConfig['limits']>
}

function config(overrides: ConfigOverrides = {}): SoakConfig {
  return {
    minutes: overrides.minutes ?? 30,
    out: overrides.out ?? '/tmp/soak-verdict-test',
    limits: {
      maxChildren: 60,
      maxGrowth: 5,
      maxZombies: 0,
      maxEventsPer5s: 30,
      maxStallMs: 1000,
      ...overrides.limits,
    },
  }
}

function healthyWorkers(): WorkerBeat[] {
  return Array.from({ length: 7 }, (_, index) => ({
    worktree: `worktree-${index}`,
    lastBeatAgeSeconds: 30,
  }))
}

function evidence(overrides: Partial<SoakEvidence> = {}): SoakEvidence {
  return {
    durationSeconds: 1800,
    windows: 2,
    samples: [],
    events: [],
    probes: [],
    workers: healthyWorkers(),
    daemonExited: false,
    ...overrides,
  }
}

function processRow(
  pid: number,
  command = 'worker',
  state = 'S',
  ppid = 1,
  started = `start-${pid}`,
): ProcessRow {
  return { pid, ppid, state, rssKb: 100, started, command }
}

function rowsForSample(at: number, count: number, command = 'worker', state = 'S'): ProcessRow[] {
  const firstPid = 10_000 + Math.round(at * 1000)
  return Array.from({ length: count }, (_, index) => processRow(firstPid + index, command, state))
}

function sample(at: number, owned: ProcessRow[]): Sample {
  return { at, owned, daemonRssKb: null }
}

function eventsWithin(type: string, count: number, start: number, span: number): EventRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    at: Math.round((start + (count === 1 ? 0 : (span * index) / (count - 1))) * 1000) / 1000,
    type,
  }))
}

test('scenario 9: excludes warm-up and passes bounded peak and first-to-last-fifth growth', () => {
  const samples = Array.from({ length: 100 }, (_, at) => {
    const count = at < 20 ? 100 : at < 36 ? 10 : at < 84 ? 12 : 13
    return sample(at, rowsForSample(at, count))
  })

  const result = judge(evidence({ durationSeconds: 100, samples }), config())

  expect(result.checks.children).toMatchObject({
    ok: true,
    peak: 13,
    peakAt: 84,
    medianFirst: 10,
    medianLast: 13,
    growth: 3,
  })
})

test('scenario 10: reports the highest sample and its five most common commands', () => {
  const owned: ProcessRow[] = []
  const commandCounts = [
    ['alpha', 20],
    ['bravo', 15],
    ['charlie', 12],
    ['delta', 8],
    ['echo', 6],
  ] as const
  let pid = 20_000
  for (const [command, count] of commandCounts) {
    for (let index = 0; index < count; index++) owned.push(processRow(pid++, command))
  }
  const result = judge(evidence({ samples: [sample(0, rowsForSample(0, 100)), sample(61, owned)] }), config())

  expect(result.checks.children).toMatchObject({
    ok: false,
    peak: 61,
    peakAt: 61,
    peakCommands: [
      { command: 'alpha', count: 20 },
      { command: 'bravo', count: 15 },
      { command: 'charlie', count: 12 },
      { command: 'delta', count: 8 },
      { command: 'echo', count: 6 },
    ],
  })
})

test('scenario 11: fails when first-to-last-fifth growth is 26 below the peak limit', () => {
  const samples = Array.from({ length: 100 }, (_, at) => {
    const count = at < 20 ? 100 : at < 36 ? 14 : at < 84 ? 20 : 40
    return sample(at, rowsForSample(at, count))
  })

  const result = judge(evidence({ durationSeconds: 100, samples }), config())

  expect(result.checks.children).toMatchObject({
    ok: false,
    peak: 40,
    peakAt: 84,
    medianFirst: 14,
    medianLast: 40,
    growth: 26,
  })
})

test('scenario 12: with fewer than ten post-warm-up samples, only the peak rule is judged', () => {
  const samples = [sample(0, rowsForSample(0, 100)), ...Array.from({ length: 9 }, (_, index) => {
    const at = 61 + index
    return sample(at, rowsForSample(at, 61))
  })]

  const result = judge(evidence({ samples }), config({ limits: { maxChildren: 70 } }))

  expect(result.checks.children).toMatchObject({
    ok: true,
    peak: 61,
    peakAt: 61,
    medianFirst: null,
    medianLast: null,
    growth: null,
  })
})

test('scenario 13: a zombie present in only two consecutive samples is transient', () => {
  const zombie = processRow(4101, 'transient-zombie', 'Z', 4001, 'Mon Jan 01 00:00:00 2024')
  const result = judge(evidence({ samples: [sample(0, [zombie]), sample(1, [zombie]), sample(2, [])] }), config())

  expect(result.checks.zombies).toMatchObject({ ok: true, peak: 1, persistent: 0, examples: [] })
})

test('scenario 14: three consecutive zombie samples report persistent identity details', () => {
  const zombie = processRow(4201, 'persistent-zombie', 'Z+', 4001, 'Mon Jan 01 00:00:00 2024')
  const result = judge(evidence({ samples: [sample(0, [zombie]), sample(1, [zombie]), sample(2, [zombie])] }), config())

  expect(result.checks.zombies).toMatchObject({
    ok: false,
    peak: 1,
    persistent: 1,
    examples: [{ pid: 4201, ppid: 4001, command: 'persistent-zombie', seconds: 3 }],
  })
})

test('scenario 15: a ten-minute climb to 300 zombies fails both zombie and child checks', () => {
  const samples = Array.from({ length: 11 }, (_, minute) => {
    const owned = Array.from({ length: minute * 30 }, (_, index) =>
      processRow(50_000 + index, 'daemon-zombie', 'Z', 900, 'Mon Jan 01 00:00:00 2024'))
    return sample(minute * 60, owned)
  })
  const result = judge(evidence({ durationSeconds: 600, samples }), config())

  expect(result.checks.zombies.ok).toBe(false)
  expect(result.checks.children.ok).toBe(false)
  expect(result.checks.children.peak).toBe(300)
})

test('scenario 16: thirty events of one type in a sliding five-second span pass', () => {
  const result = judge(evidence({ events: eventsWithin('quiet.changed', 30, 1, 4.9) }), config())

  expect(result.checks.events.ok).toBe(true)
  expect(result.checks.events.peakPer5s).toBe(30)
})

test('scenario 17: thirty-one events of one type fail and identify the peak span', () => {
  const result = judge(evidence({ events: eventsWithin('storm.changed', 31, 10, 4.9) }), config())

  expect(result.checks.events).toMatchObject({
    ok: false,
    peakPer5s: 31,
    peakType: 'storm.changed',
    peakAt: 10,
  })
})

test('scenario 18: the 52-event Checks incident exceeds the event limit', () => {
  const type = 'quirky.reviews/changed'
  const result = judge(evidence({ events: eventsWithin(type, 52, 0, 4.9) }), config())

  expect(result.checks.events).toMatchObject({ ok: false, total: 52, peakPer5s: 52, peakType: type, peakAt: 0 })
})

test('scenario 19: a burst split across fixed bucket edges is counted in the sliding span', () => {
  const events = [
    ...eventsWithin('boundary.changed', 26, 4, 0.9),
    ...eventsWithin('boundary.changed', 26, 5, 0.9),
  ]
  const result = judge(evidence({ events }), config())

  expect(result.checks.events).toMatchObject({
    ok: false,
    total: 52,
    peakPer5s: 52,
    peakType: 'boundary.changed',
    peakAt: 4,
  })
})

test('scenario 20: separate event types do not combine toward the limit', () => {
  const events = [...eventsWithin('type-A', 20, 0, 4.9), ...eventsWithin('type-B', 20, 0, 4.9)]
  const result = judge(evidence({ events }), config())

  expect(result.checks.events.ok).toBe(true)
  expect(result.checks.events.total).toBe(40)
  expect(result.checks.events.peakPer5s).toBe(20)
})

test('scenario 21: probes at or below 1000 ms are not stalls', () => {
  const probes = [
    { at: 1, ms: 700, ownLagMs: 0, timedOut: false },
    { at: 2, ms: 1000, ownLagMs: 200, timedOut: false },
    { at: 3, ms: 450, ownLagMs: 500, timedOut: false },
  ]
  const result = judge(evidence({ probes }), config())

  expect(result.checks.stalls).toMatchObject({ ok: true, probes: 3, stalls: 0, hostBusy: 0 })
})

test('scenario 22: a 1001 ms probe with at most 500 ms own lag is a stall', () => {
  const result = judge(evidence({ probes: [{ at: 1, ms: 1001, ownLagMs: 500, timedOut: false }] }), config())

  expect(result.checks.stalls).toMatchObject({ ok: false, probes: 1, stalls: 1, hostBusy: 0, maxMs: 1001 })
})

test('scenario 23: a late host timer classifies a 5000 ms probe as host busy, not a stall', () => {
  const result = judge(evidence({ probes: [{ at: 1, ms: 5000, ownLagMs: 3000, timedOut: false }] }), config())

  expect(result.checks.stalls).toMatchObject({ probes: 1, stalls: 0, hostBusy: 1 })
})

test('scenario 24: more than five percent host-busy probes disqualify judging stalls', () => {
  const probes = [
    { at: 1, ms: 5000, ownLagMs: 3000, timedOut: false },
    ...Array.from({ length: 9 }, (_, index) => ({ at: index + 2, ms: 500, ownLagMs: 0, timedOut: false })),
  ]
  const result = judge(evidence({ probes }), config())

  expect(result.checks.stalls.hostBusy).toBe(1)
  expect(result.disqualified).toContain('host too busy to judge stalls: 1 of 10 probes')
  expect(result.qualifies).toBe(false)
})

test('scenario 25: daemon loss fails the stall check and is reported', () => {
  const result = judge(evidence({ daemonExited: true, probes: [{ at: 1, ms: 100, ownLagMs: 0, timedOut: false }] }), config())

  expect(result.checks.stalls).toMatchObject({ ok: false, daemonExited: true })
})

test('scenario 26: a timed-out probe is a stall even above the limit and during host lag', () => {
  const result = judge(
    evidence({ probes: [{ at: 1, ms: 30_000, ownLagMs: 3000, timedOut: true }] }),
    config({ limits: { maxStallMs: 30_001 } }),
  )

  expect(result.checks.stalls).toMatchObject({ ok: false, probes: 1, stalls: 1, maxMs: 30_000 })
})

test('scenario 27: seven fresh worker heartbeats are all alive', () => {
  const result = judge(evidence({ workers: healthyWorkers() }), config())

  expect(result.checks.workers).toEqual({ ok: true, expected: 7, alive: 7, stale: [] })
})

test('scenario 28: a worker heartbeat older than thirty seconds is stale', () => {
  const workers = healthyWorkers()
  workers[6] = { worktree: 'worktree-6', lastBeatAgeSeconds: 31 }
  const result = judge(evidence({ workers }), config())

  expect(result.checks.workers).toEqual({ ok: false, expected: 7, alive: 6, stale: ['worktree-6'] })
})

test('scenario 29: the verdict passes only when all five checks pass', () => {
  const pass = judge(evidence(), config())
  expect(pass.verdict).toBe('pass')
  expect(Object.values(pass.checks).every((check) => check.ok)).toBe(true)

  const workers = healthyWorkers()
  workers[0] = { worktree: 'worktree-0', lastBeatAgeSeconds: 31 }
  const fail = judge(evidence({ workers }), config())
  expect(fail.checks.workers.ok).toBe(false)
  expect(fail.verdict).toBe('fail')
})

test('scenario 30: a loosened event limit is applied and disqualifies the run', () => {
  const result = judge(
    evidence({ events: eventsWithin('loosened.changed', 52, 0, 4.9) }),
    config({ limits: { maxEventsPer5s: 100 } }),
  )

  expect(result.checks.events.ok).toBe(true)
  expect(result.checks.events.peakPer5s).toBe(52)
  expect(result.disqualified).toEqual(['limit loosened: maxEventsPer5s 100 > 30'])
  expect(result.qualifies).toBe(false)
})

test('scenario 31: a tightened child limit is applied without disqualifying the run', () => {
  const result = judge(
    evidence({ samples: [sample(61, rowsForSample(61, 2))] }),
    config({ limits: { maxChildren: 1 } }),
  )

  expect(result.checks.children).toMatchObject({ ok: false, peak: 2 })
  expect(result.disqualified).toEqual([])
  expect(result.qualifies).toBe(true)
})

test('scenario 32: qualification requires no disqualification and is independent of verdict', () => {
  const result = judge(evidence({ durationSeconds: 24, windows: 0 }), config({ minutes: 0.4 }))

  expect(result.verdict).toBe('pass')
  expect(result.qualifies).toBe(false)
  expect(result.disqualified).toHaveLength(2)
  expect(result.disqualified).toContain('ran 0.4 minutes, needs 30')
  expect(result.disqualified).toContain('0 windows connected, needs 2')
})
