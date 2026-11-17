import { expect, test } from 'bun:test'
import type {
  EventRecord, PanelRefreshRecord, PhaseRecord, ProcessRow, Sample, SoakConfig, SoakReport,
  SwitchRecord, TaskInteractionRecord, WindowBeat, WorkerBeat,
} from './contracts'
import { DEFAULT_LIMITS } from './contracts'
import { daySchedule } from './day.ts'
import type { SoakEvidence } from './verdict'
import { countDaemonLog, isPanelRefreshRequest, judge, panelOfRequest, windowAlive } from './verdict'
type EvidenceFixture = SoakEvidence & {
  switches: SwitchRecord[]
  phases: PhaseRecord[]
  taskInteractions: TaskInteractionRecord[]
}

type ConfigOverrides = {
  minutes?: number
  out?: string
  windows?: number
  limits?: Partial<SoakConfig['limits']>
  fault?: SoakConfig['fault']
}

function config(overrides: ConfigOverrides = {}): SoakConfig {
  return {
    minutes: overrides.minutes ?? 30,
    out: overrides.out ?? '/tmp/soak-verdict-test',
    windows: overrides.windows ?? 3,
    limits: {
      maxChildren: 60,
      maxGrowth: 5,
      maxZombies: 0,
      maxEventsPer5s: 30,
      maxStallMs: 1000,
      maxUnanswered: 0,
      maxWindowRequestsPerMinute: 2500,
      ...overrides.limits,
    },
    ...(overrides.fault === undefined ? {} : { fault: overrides.fault }),
  }
}

function windowBeat(worktree: string, overrides: Partial<WindowBeat> = {}): WindowBeat {
  return { worktree, open: true, shown: true, lastRequestAgeSeconds: 0, ...overrides }
}

function healthyWorkers(): WorkerBeat[] {
  return Array.from({ length: 7 }, (_, index) => ({
    worktree: `worktree-${index}`,
    lastBeatAgeSeconds: 30,
  }))
}
function healthyPanelRefreshes(windowBeats: WindowBeat[]): PanelRefreshRecord[] {
  return windowBeats.flatMap((beat, index) => windowAlive(beat)
    ? [{ at: 0, index, worktree: beat.worktree, method: 'quirky.git/status' }]
    : [])
}

function panelRefresh(index: number, worktree: string, at: number, method = 'quirky.git/status'): PanelRefreshRecord {
  return { at, index, worktree, method }
}

function evidence(overrides: Partial<SoakEvidence> = {}): EvidenceFixture {
  const durationSeconds = overrides.durationSeconds ?? 1800
  const windowBeats = overrides.windowBeats
    ?? Array.from({ length: 3 }, (_, index) => windowBeat(`worktree-${index}`))
  const windows = windowBeats.map((beat, index) => ({ index, worktree: beat.worktree }))
  const dayWorktrees = [...new Set(windows.map((window) => window.worktree))]
  if (dayWorktrees.length === 0) dayWorktrees.push('worktree-0')
  const defaultDay = { enabled: true, windows, worktrees: dayWorktrees }
  const day = Object.hasOwn(overrides, 'day') ? overrides.day : defaultDay
  const scheduleInputs = day ?? defaultDay
  const schedule = daySchedule({
    seconds: durationSeconds,
    windows: scheduleInputs.windows,
    worktrees: scheduleInputs.worktrees,
  })
  const currentWorktrees = new Map(scheduleInputs.windows.map((window) => [window.index, window.worktree]))
  const switches = schedule.flatMap((action) => {
    if (action.kind !== 'switch') return []
    const from = currentWorktrees.get(action.index) ?? ''
    currentWorktrees.set(action.index, action.to)
    return [{
      at: action.at,
      seq: action.seq,
      index: action.index,
      from,
      requested: action.to,
      settled: action.to,
      proof: { at: action.at, method: 'quirky.git/status', worktree: action.to },
      ok: true,
      followMs: 0,
      error: null,
    }]
  })
  const phases = schedule.flatMap((action) => action.kind === 'phase' ? [{
    at: action.at,
    seq: action.seq,
    phase: action.phase,
    ok: true,
    applyMs: 0,
    missing: [],
    error: null,
  }] : [])

  const taskInteractions = schedule.flatMap((action) => action.kind === 'task' ? [{
    kind: 'task' as const,
    at: action.at,
    seq: action.seq,
    index: action.index,
    method: 'quirky.tasks/preferences',
    ok: true,
    proof: { at: action.at, method: 'quirky.tasks/state' },
    error: null,
  }] : [])
  const panelRefreshes = overrides.panelRefreshes ?? healthyPanelRefreshes(windowBeats)
  const panelRequests = overrides.panelRequests ?? panelRefreshes.flatMap((record) => {
    const panel = panelOfRequest(record.method, {})
    return panel === null ? [] : [{ at: record.at, index: record.index, panel }]
  })
  return {
    durationSeconds,
    windows: overrides.windows ?? windowBeats.length,
    windowBeats,
    samples: [],
    events: [],
    probes: [],
    workers: healthyWorkers(),
    daemonExited: false,
    panelRefreshes,
    windowRequestSeconds: windowBeats.map(() => []),
    panelRequests,
    gitProbes: [{
      at: 0,
      ms: 10,
      ownLagMs: 0,
      timedOut: false,
      failed: false,
      worktree: dayWorktrees[0]!,
    }],
    terminalProbes: [{ at: 0, ms: 10, ownLagMs: 0, timedOut: false, failed: false }],
    day,
    ...overrides,
    switches: overrides.switches ?? switches,
    phases: overrides.phases ?? phases,
    taskInteractions: overrides.taskInteractions ?? taskInteractions,
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

test('window scenario 22: the verdict passes only when every check passes', () => {
  const pass = judge(evidence(), config())
  expect(pass.verdict).toBe('pass')
  expect(Object.values(pass.checks).every((check) => check.ok)).toBe(true)

  const fail = judge(evidence({ windowBeats: [windowBeat('lost-window', { open: false })] }), config())
  expect(fail.checks.windows).toEqual({ ok: false, expected: 1, alive: 0, lost: ['lost-window'] })
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

test('a fault disqualifies an otherwise qualifying run', () => {
  const result = judge(evidence(), config({ fault: 'storm' }))

  expect(result.verdict).toBe('pass')
  expect(Object.values(result.checks).every((check) => check.ok)).toBe(true)
  expect(result.disqualified).toEqual(['fault injected: storm'])
  expect(result.qualifies).toBe(false)
})

test('a run without a fault has no fault disqualification', () => {
  const result = judge(evidence(), config())

  expect(result.disqualified).not.toContain('fault injected: storm')
  expect(result.qualifies).toBe(true)
})
function expectOnlyCheckFails(
  result: Pick<SoakReport, 'checks' | 'verdict'>,
  failed: keyof SoakReport['checks'],
): void {
  expect(result.checks.children.ok).toBe(failed !== 'children')
  expect(result.checks.zombies.ok).toBe(failed !== 'zombies')
  expect(result.checks.events.ok).toBe(failed !== 'events')
  expect(result.checks.stalls.ok).toBe(failed !== 'stalls')
  expect(result.checks.workers.ok).toBe(failed !== 'workers')
  expect(result.checks.refreshes.ok).toBe(failed !== 'refreshes')
  expect(result.verdict).toBe('fail')
}

test('child peak passes at 60 and fails at 61', () => {
  const at = 61
  const pass = judge(evidence({ samples: [sample(at, rowsForSample(at, 60))] }), config())
  const fail = judge(evidence({ samples: [sample(at, rowsForSample(at, 61))] }), config())

  expect(pass.checks.children).toMatchObject({ ok: true, peak: 60, peakAt: at })
  expect(fail.checks.children).toMatchObject({ ok: false, peak: 61, peakAt: at })
})

test('child growth passes at 5 and fails at 6', () => {
  const resultForGrowth = (growth: number) => {
    const samples = Array.from({ length: 10 }, (_, index) => {
      const at = 20 + index
      const count = index < 2 ? 14 : index >= 8 ? 14 + growth : 16
      return sample(at, rowsForSample(at, count))
    })
    return judge(evidence({ durationSeconds: 100, samples }), config())
  }

  expect(resultForGrowth(5).checks.children).toMatchObject({ ok: true, growth: 5 })
  expect(resultForGrowth(6).checks.children).toMatchObject({ ok: false, growth: 6 })
})

test('post-warm-up growth is numeric at ten samples and null at nine', () => {
  const resultForSamples = (count: number) => {
    const samples = Array.from({ length: count }, (_, index) => {
      const at = 61 + index
      return sample(at, rowsForSample(at, 4))
    })
    return judge(evidence({ samples }), config())
  }

  expect(resultForSamples(10).checks.children).toMatchObject({
    medianFirst: 4,
    medianLast: 4,
    growth: 0,
  })
  expect(resultForSamples(9).checks.children).toMatchObject({
    medianFirst: null,
    medianLast: null,
    growth: null,
  })
})

test('the short-run warm-up boundary sample at 20 seconds is judged', () => {
  const result = judge(
    evidence({
      durationSeconds: 100,
      samples: [sample(19, rowsForSample(19, 100)), sample(20, rowsForSample(20, 61))],
    }),
    config(),
  )

  expect(result.checks.children).toMatchObject({ ok: false, peak: 61, peakAt: 20 })
})

test('the 60-second warm-up boundary sample is judged', () => {
  const result = judge(
    evidence({
      durationSeconds: 300,
      samples: [sample(59, rowsForSample(59, 100)), sample(60, rowsForSample(60, 61))],
    }),
    config(),
  )

  expect(result.checks.children).toMatchObject({ ok: false, peak: 61, peakAt: 60 })
})

test('peak commands are sorted by frequency and cut to the top five', () => {
  const owned: ProcessRow[] = []
  const commandCounts = [
    ['golf', 2],
    ['charlie', 6],
    ['foxtrot', 1],
    ['echo', 4],
    ['alpha', 7],
    ['beta', 3],
    ['delta', 5],
  ] as const
  let pid = 30_000
  for (const [command, count] of commandCounts) {
    for (let index = 0; index < count; index++) owned.push(processRow(pid++, command))
  }
  const result = judge(evidence({ samples: [sample(61, owned)] }), config())

  expect(result.checks.children.peakCommands).toEqual([
    { command: 'alpha', count: 7 },
    { command: 'charlie', count: 6 },
    { command: 'delta', count: 5 },
    { command: 'echo', count: 4 },
    { command: 'beta', count: 3 },
  ])
})

test('a zombie with the same pid but a new start time resets its identity', () => {
  const result = judge(evidence({
    samples: [
      sample(0, [processRow(4301, 'reused-pid', 'Z', 4001, 'start-a')]),
      sample(1, [processRow(4301, 'reused-pid', 'Z', 4001, 'start-b')]),
      sample(2, [processRow(4301, 'reused-pid', 'Z', 4001, 'start-c')]),
    ],
  }), config())

  expect(result.checks.zombies).toMatchObject({ ok: true, peak: 1, persistent: 0, examples: [] })
})

test('a Z, Z, gone, Z sequence is not a persistent zombie', () => {
  const zombie = processRow(4401, 'interrupted-zombie', 'Z', 4001, 'same-start')
  const result = judge(evidence({
    samples: [sample(0, [zombie]), sample(1, [zombie]), sample(2, []), sample(3, [zombie])],
  }), config())

  expect(result.checks.zombies).toMatchObject({ ok: true, peak: 1, persistent: 0, examples: [] })
})

test('event windows include 5000 ms at zero and 4.3 seconds, but exclude 5001 ms', () => {
  const atOrigin = judge(evidence({ events: eventsWithin('exact-origin', 31, 0, 5) }), config())
  const shifted = judge(evidence({ events: eventsWithin('exact-shifted', 31, 4.3, 5) }), config())
  const outside = judge(evidence({ events: eventsWithin('outside', 31, 0, 5.001) }), config())

  expect(atOrigin.checks.events).toMatchObject({ ok: false, peakPer5s: 31, peakAt: 0 })
  expect(shifted.checks.events).toMatchObject({ ok: false, peakPer5s: 31, peakAt: 4.3 })
  expect(outside.checks.events).toMatchObject({ ok: true, peakPer5s: 30 })
})

test('event peakAt identifies the later span with the larger peak', () => {
  const events = [
    ...eventsWithin('later-peak', 30, 0, 4.9),
    ...eventsWithin('later-peak', 31, 10, 4.9),
  ]
  const result = judge(evidence({ events }), config())

  expect(result.checks.events).toMatchObject({
    ok: false,
    peakPer5s: 31,
    peakType: 'later-peak',
    peakAt: 10,
  })
})

test('own timer lag of 500 ms is a stall and 501 ms is host busy', () => {
  const result = judge(evidence({
    probes: [
      { at: 1, ms: 1001, ownLagMs: 500, timedOut: false },
      { at: 2, ms: 1001, ownLagMs: 501, timedOut: false },
    ],
  }), config())

  expect(result.checks.stalls).toMatchObject({ stalls: 1, hostBusy: 1 })
})

test('host-busy probes at exactly five percent do not disqualify, just over does', () => {
  const probesForCount = (count: number) => [
    { at: 1, ms: 5000, ownLagMs: 3000, timedOut: false },
    ...Array.from({ length: count - 1 }, (_, index) => ({
      at: index + 2,
      ms: 500,
      ownLagMs: 0,
      timedOut: false,
    })),
  ]
  const exact = judge(evidence({ probes: probesForCount(20) }), config())
  const over = judge(evidence({ probes: probesForCount(19) }), config())

  expect(exact.checks.stalls.hostBusy).toBe(1)
  expect(exact.disqualified).toEqual([])
  expect(exact.qualifies).toBe(true)
  expect(over.checks.stalls.hostBusy).toBe(1)
  expect(over.disqualified).toContain('host too busy to judge stalls: 1 of 19 probes')
  expect(over.qualifies).toBe(false)
})

test('a 30-second heartbeat is alive, while 30.001 seconds and null are stale', () => {
  const workers = healthyWorkers()
  workers[1] = { worktree: 'worktree-1', lastBeatAgeSeconds: 30.001 }
  workers[2] = { worktree: 'worktree-2', lastBeatAgeSeconds: null }
  const result = judge(evidence({ workers }), config())

  expect(result.checks.workers).toEqual({
    ok: false,
    expected: 7,
    alive: 5,
    stale: ['worktree-1', 'worktree-2'],
  })
})

test('a children-only failure makes the verdict fail', () => {
  const result = judge(evidence({ samples: [sample(61, rowsForSample(61, 61))] }), config())

  expectOnlyCheckFails(result, 'children')
})

test('a zombies-only failure makes the verdict fail', () => {
  const zombie = processRow(4501, 'persistent-zombie', 'Z', 4001, 'same-start')
  const result = judge(evidence({
    samples: [sample(61, [zombie]), sample(62, [zombie]), sample(63, [zombie])],
  }), config())

  expectOnlyCheckFails(result, 'zombies')
})

test('an events-only failure makes the verdict fail', () => {
  const result = judge(evidence({ events: eventsWithin('storm', 31, 0, 4.9) }), config())

  expectOnlyCheckFails(result, 'events')
})

test('a stalls-only failure makes the verdict fail', () => {
  const result = judge(evidence({
    probes: [{ at: 1, ms: 1001, ownLagMs: 0, timedOut: false }],
  }), config())

  expectOnlyCheckFails(result, 'stalls')
})

test('a workers-only failure makes the verdict fail', () => {
  const workers = healthyWorkers()
  workers[0] = { worktree: 'worktree-0', lastBeatAgeSeconds: null }
  const result = judge(evidence({ workers }), config())

  expectOnlyCheckFails(result, 'workers')
})

test('loosening maxChildren passes its check but disqualifies by name', () => {
  const result = judge(
    evidence({ samples: [sample(61, rowsForSample(61, 61))] }),
    config({ limits: { maxChildren: 61 } }),
  )

  expect(result.checks.children.ok).toBe(true)
  expect(result.disqualified).toEqual(['limit loosened: maxChildren 61 > 60'])
  expect(result.qualifies).toBe(false)
})

test('loosening maxGrowth passes its check but disqualifies by name', () => {
  const samples = Array.from({ length: 10 }, (_, index) => {
    const at = 61 + index
    const count = index < 2 ? 14 : index >= 8 ? 20 : 16
    return sample(at, rowsForSample(at, count))
  })
  const result = judge(
    evidence({ samples }),
    config({ limits: { maxGrowth: 6 } }),
  )

  expect(result.checks.children).toMatchObject({ ok: true, growth: 6 })
  expect(result.disqualified).toEqual(['limit loosened: maxGrowth 6 > 5'])
  expect(result.qualifies).toBe(false)
})

test('loosening maxZombies passes its check but disqualifies by name', () => {
  const zombie = processRow(4601, 'persistent-zombie', 'Z', 4001, 'same-start')
  const result = judge(
    evidence({ samples: [sample(61, [zombie]), sample(62, [zombie]), sample(63, [zombie])] }),
    config({ limits: { maxZombies: 1 } }),
  )

  expect(result.checks.zombies.ok).toBe(true)
  expect(result.disqualified).toEqual(['limit loosened: maxZombies 1 > 0'])
  expect(result.qualifies).toBe(false)
})

test('loosening maxEventsPer5s passes its check but disqualifies by name', () => {
  const result = judge(
    evidence({ events: eventsWithin('loosened', 31, 0, 4.9) }),
    config({ limits: { maxEventsPer5s: 31 } }),
  )

  expect(result.checks.events.ok).toBe(true)
  expect(result.disqualified).toEqual(['limit loosened: maxEventsPer5s 31 > 30'])
  expect(result.qualifies).toBe(false)
})

test('loosening maxStallMs passes its check but disqualifies by name', () => {
  const result = judge(
    evidence({ probes: [{ at: 1, ms: 1001, ownLagMs: 0, timedOut: false }] }),
    config({ limits: { maxStallMs: 1001 } }),
  )

  expect(result.checks.stalls.ok).toBe(true)
  expect(result.disqualified).toEqual(['limit loosened: maxStallMs 1001 > 1000'])
  expect(result.qualifies).toBe(false)
})

test('window scenario 17: a window is alive only when open, shown and recently active', () => {
  expect(windowAlive(windowBeat('active'))).toBe(true)
  expect(windowAlive(windowBeat('closed', { open: false }))).toBe(false)
  expect(windowAlive(windowBeat('blank', { shown: false }))).toBe(false)
  expect(windowAlive(windowBeat('silent', { lastRequestAgeSeconds: 31 }))).toBe(false)
})

test('window scenario 18: all alive windows pass with the exact ordered check', () => {
  const result = judge(evidence({
    windowBeats: ['first', 'second', 'third'].map((id) => windowBeat(id)),
  }), config())

  expect(result.checks.windows).toEqual({ ok: true, expected: 3, alive: 3, lost: [] })
})

test('window scenario 19: a closed or crashed page is listed as lost', () => {
  const result = judge(evidence({
    windowBeats: [
      windowBeat('first'),
      windowBeat('closed-window', { open: false }),
      windowBeat('third'),
    ],
  }), config())

  expect(result.checks.windows).toEqual({
    ok: false,
    expected: 3,
    alive: 2,
    lost: ['closed-window'],
  })
})

test('window scenario 20: an open page without a daemon worktree is lost', () => {
  const result = judge(evidence({
    windowBeats: [windowBeat('blank-window', { shown: false })],
  }), config())

  expect(result.checks.windows).toEqual({
    ok: false,
    expected: 1,
    alive: 0,
    lost: ['blank-window'],
  })
})

test('window scenario 21: age 30 is alive but stale, absent and non-finite ages are lost', () => {
  const result = judge(evidence({
    windowBeats: [
      windowBeat('age-31', { lastRequestAgeSeconds: 31 }),
      windowBeat('age-30', { lastRequestAgeSeconds: 30 }),
      windowBeat('never-requested', { lastRequestAgeSeconds: null }),
      windowBeat('infinite-age', { lastRequestAgeSeconds: Number.POSITIVE_INFINITY }),
      windowBeat('not-a-number', { lastRequestAgeSeconds: Number.NaN }),
    ],
  }), config())

  expect(result.checks.windows).toEqual({
    ok: false,
    expected: 5,
    alive: 1,
    lost: ['age-31', 'never-requested', 'infinite-age', 'not-a-number'],
  })
})

test('empty window evidence does not require day rotation', () => {
  const result = judge(
    evidence({ windows: 0, windowBeats: [], day: undefined, switches: [], phases: [] }),
    config({ windows: 0 }),
  )

  expect(result.checks.windows).toEqual({ ok: true, expected: 0, alive: 0, lost: [] })
  expect(result.checks.day).toMatchObject({ ok: true, enabled: false, expectedSwitches: 0, expectedPhases: 0 })
  expect(result.qualifies).toBe(false)
})

test('window scenario 23: qualification keeps using the alive-window evidence count', () => {
  const beats = [
    windowBeat('first'),
    windowBeat('second'),
    windowBeat('third', { open: false }),
  ]
  const twoAlive = judge(evidence({ windows: 2, windowBeats: beats }), config())
  expect(twoAlive.checks.windows).toEqual({
    ok: false,
    expected: 3,
    alive: 2,
    lost: ['third'],
  })
  expect(twoAlive.verdict).toBe('fail')
  expect(twoAlive.disqualified).not.toContain('2 windows connected, needs 2')

  const oneAlive = judge(evidence({ windows: 1, windowBeats: beats }), config())
  expect(oneAlive.disqualified).toContain('1 windows connected, needs 2')
})
const judgeDaemonLog = [
  '[quirkyd] quirky.notifications: could not mark worktree wt_f7e2309c73f1: quirky.worktree/set did not answer within 2000ms',
  '[quirkyd] quirky.notifications: could not mark worktree wt_37d2a04e4041: quirky.worktree/set did not answer within 2000ms',
  '[quirkyd] quirky.notifications: quirky.worktree/resolve failed: quirky.worktree/resolve did not answer within 2000ms',
  '[quirkyd] quirky.notifications: could not mark worktree wt_f7e2309c73f1: quirky.worktree/set did not answer within 2000ms',
  '[quirkyd] quirky.notifications: quirky.worktree/list failed: quirky.worktree/list did not answer within 2000ms',
].join('\n')

test('scenario 15: counts unanswered calls by method and git timeout lines', () => {
  expect(countDaemonLog(judgeDaemonLog)).toEqual({
    unanswered: 5,
    byMethod: [
      { method: 'quirky.worktree/set', count: 3 },
      { method: 'quirky.worktree/list', count: 1 },
      { method: 'quirky.worktree/resolve', count: 1 },
    ],
    gitTimeouts: 0,
  })
  expect(countDaemonLog('[quirkyd] quirky.worktree: could not list the workspaces of harbor-api: git worktree timed out after 30000ms').gitTimeouts).toBe(1)
})

test('scenario 15: counts dispatcher timeout lines under their method', () => {
  expect(countDaemonLog('method quirky.x/y in quirky.x did not answer within 300000 ms')).toMatchObject({
    unanswered: 1,
    byMethod: [{ method: 'quirky.x/y', count: 1 }],
  })
})

test('scenario 16: calls fails above the default unanswered limit', () => {
  const result = judge(evidence({ daemonLog: judgeDaemonLog }), config())

  expect(result.checks.calls).toEqual({
    ok: false,
    unanswered: 5,
    byMethod: [
      { method: 'quirky.worktree/set', count: 3 },
      { method: 'quirky.worktree/list', count: 1 },
      { method: 'quirky.worktree/resolve', count: 1 },
    ],
    gitTimeouts: 0,
    refreshes: { slow: 0, completed: 0, failed: 0, pending: 0, invalid: 0, examples: [] },
  })
  expect(result.verdict).toBe('fail')
})
test('scenario 16: legacy two-line warnings retain unanswered counts', () => {
  const log = [
    'quirky.worktree/list failed: quirky.worktree/list did not answer within 2000ms',
    'quirky.worktree/list failed: quirky.worktree/list did not answer within 2000ms',
  ].join('\n')
  const result = judge(evidence({ daemonLog: log }), config())

  expect(result.checks.calls).toMatchObject({
    ok: false,
    unanswered: 2,
    byMethod: [{ method: 'quirky.worktree/list', count: 2 }],
  })
})

test('scenario 6: an unfinished slow refresh fails calls without an unanswered warning', () => {
  const diagnostic = {
    v: 1,
    id: 'pending-refresh',
    event: 'slow',
    startedAt: '2026-11-14T00:00:01.000Z',
    at: '2026-11-14T00:00:03.000Z',
    elapsedMs: 2000,
    loopLagMs: 0,
  }
  const result = judge(
    evidence({ daemonLog: `notification-worktree-refresh ${JSON.stringify(diagnostic)}` }),
    config(),
  )

  expect(result.checks.calls).toMatchObject({
    ok: false,
    unanswered: 0,
    refreshes: { slow: 1, completed: 0, failed: 0, pending: 1, invalid: 0 },
  })
  expect(result.verdict).toBe('fail')
})

test('scenario 6: a completed slow refresh is reported without failing calls', () => {
  const startedAt = '2026-11-14T00:00:00.000Z'
  const refresh = {
    v: 1,
    id: 'completed-refresh',
    startedAt: '2026-11-14T00:00:01.000Z',
    elapsedMs: 2500,
    loopLagMs: 0,
  }
  const log = [
    `notification-worktree-refresh ${JSON.stringify({ ...refresh, event: 'slow', at: '2026-11-14T00:00:03.000Z' })}`,
    `notification-worktree-refresh ${JSON.stringify({ ...refresh, event: 'finished', at: '2026-11-14T00:00:03.500Z', outcome: 'ok' })}`,
  ].join('\n')
  const result = judge(evidence({ startedAt, daemonLog: log }), config())

  expect(result.checks.calls).toMatchObject({
    ok: true,
    unanswered: 0,
    refreshes: { slow: 1, completed: 1, failed: 0, pending: 0, invalid: 0 },
  })
})

test('scenario 6: error finishes fail calls, including a fast error without a slow record', () => {
  const diagnostic = {
    v: 1,
    id: 'failed-refresh',
    event: 'finished',
    startedAt: '2026-11-14T00:00:01.000Z',
    at: '2026-11-14T00:00:01.040Z',
    elapsedMs: 40,
    loopLagMs: 0,
    outcome: 'error',
  }
  const result = judge(
    evidence({ daemonLog: `notification-worktree-refresh ${JSON.stringify(diagnostic)}` }),
    config(),
  )

  expect(result.checks.calls).toMatchObject({
    ok: false,
    refreshes: { slow: 0, completed: 0, failed: 1, pending: 0, invalid: 0 },
  })
  expect(result.verdict).toBe('fail')
})

test('scenario 16: empty and omitted daemon logs pass calls', () => {
  expect(judge(evidence({ daemonLog: '' }), config()).checks.calls.ok).toBe(true)
  expect(judge(evidence(), config()).checks.calls.ok).toBe(true)
})

test('scenario 16: loosening maxUnanswered disqualifies the run', () => {
  const result = judge(
    evidence({ daemonLog: judgeDaemonLog }),
    config({ limits: { maxUnanswered: 3 } }),
  )

  expect(result.disqualified).toContain('limit loosened: maxUnanswered 3 > 0')
})

test('unanswered calls from third-party plugins fail the calls check', () => {
  const daemonLog = '[quirkyd] method acme.tools/read in acme.tools did not answer within 1000 ms (1 unanswered)'
  const result = judge(evidence({ daemonLog }), config())
  expect(result.checks.calls).toEqual({
    ok: false,
    unanswered: 1,
    byMethod: [{ method: 'acme.tools/read', count: 1 }],
    gitTimeouts: 0,
    refreshes: { slow: 0, completed: 0, failed: 0, pending: 0, invalid: 0, examples: [] },
  })
  expect(result.verdict).toBe('fail')
})

test('scenario 6: timeout failures keep the ordinary unanswered warning counted once', () => {
  const slow = {
    v: 1, id: 'timeout', event: 'slow', startedAt: '2026-11-14T00:00:01.000Z',
    at: '2026-11-14T00:00:03.000Z', elapsedMs: 2000, loopLagMs: 0,
  }
  const finished = {
    v: 1, id: 'timeout', event: 'finished', startedAt: slow.startedAt,
    at: '2026-11-14T00:00:31.000Z', elapsedMs: 30_000, loopLagMs: 0, outcome: 'timeout',
  }
  const daemonLog = [
    `notification-worktree-refresh ${JSON.stringify(slow)}`,
    `notification-worktree-refresh ${JSON.stringify(finished)}`,
    'quirky.worktree/list failed: quirky.worktree/list did not answer within 30000ms',
  ].join('\n')
  const result = judge(evidence({ daemonLog }), config())

  expect(result.checks.calls).toMatchObject({
    ok: false,
    unanswered: 1,
    byMethod: [{ method: 'quirky.worktree/list', count: 1 }],
    refreshes: { slow: 1, failed: 1, pending: 0, invalid: 0 },
  })
})

test('scenario 6: setup refresh failures receive the same calls failure treatment', () => {
  const diagnostic = {
    v: 1,
    id: 'setup-pending',
    event: 'slow',
    startedAt: '2026-11-13T23:59:58.000Z',
    at: '2026-11-14T00:00:00.000Z',
    elapsedMs: 2000,
    loopLagMs: 0,
  }
  const result = judge(
    evidence({
      startedAt: '2026-11-14T00:00:00.000Z',
      daemonLog: `notification-worktree-refresh ${JSON.stringify(diagnostic)}`,
    }),
    config(),
  )

  expect(result.checks.calls).toMatchObject({
    ok: false,
    refreshes: { slow: 1, pending: 1, invalid: 0, examples: [{ phase: 'setup' }] },
  })
})

test('scenario 6: malformed diagnostics fail the calls check', () => {
  const result = judge(
    evidence({ daemonLog: 'notification-worktree-refresh {broken' }),
    config(),
  )

  expect(result.checks.calls).toMatchObject({
    ok: false,
    refreshes: { slow: 0, failed: 0, pending: 0, invalid: 1 },
  })
  expect(result.verdict).toBe('fail')
})
test('refresh scenario 1: rejects seventeen refreshes shared across two windows without fault disqualification', () => {
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const panelRefreshes = Array.from({ length: 17 }, (_, index) => {
    const owner = index % 2
    return panelRefresh(owner, owner === 0 ? 'a' : 'b', 10 + 4.9 * index / 16)
  })
  const events = eventsWithin('feedback.changed', 17, 10, 4.9)
  const result = judge(evidence({ windows: 2, windowBeats, panelRefreshes, events }), config({ windows: 2 }))

  expect(result.checks.refreshes).toEqual({
    ok: false,
    total: 17,
    limitPer5s: 8,
    peakPer5s: 9,
    peakAt: 10,
    peakWindow: 0,
    peakWorktree: 'a',
    missingWindows: [],
    byWindow: [
      { index: 0, worktree: 'a', total: 9, peakPer5s: 9 },
      { index: 1, worktree: 'b', total: 8, peakPer5s: 8 },
    ],
    byPanel: [
      { index: 0, panel: 'changes', total: 9, peakPer5s: 9 },
      { index: 1, panel: 'changes', total: 8, peakPer5s: 8 },
    ],
  })
  expect(result.checks.events).toMatchObject({ ok: true, peakPer5s: 17 })
  expect(result.verdict).toBe('fail')
  expect(result.qualifies).toBe(true)
  expect(result.disqualified).toEqual([])
})

test('refresh scenario 2: compares rounded milliseconds over an inclusive sliding five-second window', () => {
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const recordsAcross = (start: number, span: number) => Array.from({ length: 17 }, (_, index) => {
    const owner = index % 2
    return panelRefresh(owner, owner === 0 ? 'a' : 'b', start + span * index / 16)
  })
  const judgeRefreshes = (records: PanelRefreshRecord[]) => judge(
    evidence({ windowBeats, panelRefreshes: records }),
    config({ windows: 2 }),
  ).checks.refreshes

  expect(judgeRefreshes(recordsAcross(10, 5))).toMatchObject({ ok: false, peakPer5s: 9, peakAt: 10 })
  expect(judgeRefreshes(recordsAcross(14.3, 5))).toMatchObject({ ok: false, peakPer5s: 9, peakAt: 14.3 })
  expect(judgeRefreshes(recordsAcross(10, 5.001))).toMatchObject({ ok: true, peakPer5s: 8 })
  const shuffled = recordsAcross(10, 4.9).reverse()
  expect(judgeRefreshes(shuffled)).toMatchObject({ ok: false, peakPer5s: 9, peakAt: 10 })
})

test('refresh scenario 3: budgets are independent by stable window index', () => {
  const windowBeats = Array.from({ length: 7 }, (_, index) => windowBeat(`w${index}`))
  const eightEach = windowBeats.flatMap((beat, index) =>
    Array.from({ length: 8 }, (_, offset) => panelRefresh(index, beat.worktree, 1 + offset * 0.01)))
  const boundedEvents = eventsWithin('bounded.event', 30, 1, 4.9)
  const sevenWindowResult = judge(
    evidence({ windows: 7, windowBeats, panelRefreshes: eightEach, events: boundedEvents }),
    config({ windows: 7 }),
  )
  expect(sevenWindowResult.checks.refreshes).toMatchObject({
    ok: true, total: 56, peakPer5s: 8, missingWindows: [],
  })
  expect(sevenWindowResult.checks.events).toMatchObject({ ok: true, peakPer5s: 30 })
  expect(sevenWindowResult.checks.refreshes.byWindow).toHaveLength(7)
  expect(sevenWindowResult.checks.refreshes.byWindow).toEqual(windowBeats.map((beat, index) => ({
    index, worktree: beat.worktree, total: 8, peakPer5s: 8,
  })))

  const threeBeats = windowBeats.slice(0, 3)
  const distributed = [6, 6, 5].flatMap((count, index) =>
    Array.from({ length: count }, (_, offset) => panelRefresh(index, threeBeats[index]!.worktree, 2 + offset * 0.01)))
  const distributedResult = judge(evidence({
    windows: 3,
    windowBeats: threeBeats,
    panelRefreshes: distributed,
    events: eventsWithin('distributed.event', 17, 2, 4.9),
  }), config({ windows: 3 }))
  expect(distributedResult.checks.refreshes)
    .toMatchObject({ ok: true, total: 17, peakPer5s: 6, missingWindows: [] })
  expect(distributedResult.checks.events).toMatchObject({ ok: true, peakPer5s: 17 })

  const twoBeats = threeBeats.slice(0, 2)
  const sixteen = Array.from({ length: 16 }, (_, index) => {
    const owner = index % 2
    return panelRefresh(owner, twoBeats[owner]!.worktree, 3 + index * 0.01)
  })
  const sixteenResult = judge(evidence({
    windows: 2,
    windowBeats: twoBeats,
    panelRefreshes: sixteen,
    events: eventsWithin('sixteen.event', 16, 3, 4.9),
  }), config({ windows: 2 }))
  expect(sixteenResult.checks.refreshes).toMatchObject({ ok: true, total: 16, peakPer5s: 8 })
  expect(sixteenResult.checks.events).toMatchObject({ ok: true, peakPer5s: 16 })

})

test('refresh scenario 4: counted methods combine under the assigned window regardless of params', () => {
  const methods = [
    'quirky.git/status',
    'quirky.reviews/checksRefresh',
    'soak.faults/feedbackRefresh',
  ]
  const windowBeats = [windowBeat('assigned')]
  const panelRefreshes = Array.from({ length: 9 }, (_, index) =>
    panelRefresh(0, 'assigned', index * 0.1, methods[index % methods.length]!))

  expect(judge(evidence({ windowBeats, panelRefreshes }), config({ windows: 1 })).checks.refreshes)
    .toMatchObject({ ok: false, total: 9, peakPer5s: 9, peakWindow: 0, peakWorktree: 'assigned' })
  expect(isPanelRefreshRequest('quirky.git/status', { worktree: 'other' })).toBe(true)
  expect(isPanelRefreshRequest('quirky.reviews/checksRefresh', { force: true })).toBe(true)
  expect(isPanelRefreshRequest('quirky.reviews/checksRefresh', { force: 1 })).toBe(false)
  expect(isPanelRefreshRequest('quirky.reviews/checksRefresh', {})).toBe(false)
  expect(isPanelRefreshRequest('soak.faults/feedbackRefresh', null)).toBe(true)
  expect(isPanelRefreshRequest('quirky.reviews/state', {})).toBe(false)
  expect(isPanelRefreshRequest('quirky.worktree/list', {})).toBe(false)
  expect(isPanelRefreshRequest('ui.report', {})).toBe(false)
})

test('refresh scenario 6: missing coverage fails, while empty window evidence has a zero peak', () => {
  const windowBeats = [windowBeat('missing')]
  const missing = judge(evidence({ windowBeats, panelRefreshes: [] }), config({ windows: 1 }))
  expect(missing.checks.refreshes).toMatchObject({
    ok: false, total: 0, peakPer5s: 0, peakAt: null, peakWindow: null,
    peakWorktree: null, missingWindows: ['missing'],
  })

  const empty = judge(evidence({ windows: 0, windowBeats: [], panelRefreshes: [] }), config({ windows: 0 }))
  expect(empty.checks.refreshes).toEqual({
    ok: true, total: 0, limitPer5s: 8, peakPer5s: 0, peakAt: null,
    peakWindow: null, peakWorktree: null, missingWindows: [], byWindow: [], byPanel: [],
  })
  expect(empty.qualifies).toBe(false)

  const absent = { ...evidence({ windowBeats }), panelRefreshes: undefined } as unknown as SoakEvidence
  expect(judge(absent, config({ windows: 1 })).checks.refreshes)
    .toMatchObject({ ok: false, missingWindows: ['missing'] })
})

test('refresh attribution cannot supply coverage or split an index budget', () => {
  const windowBeats = [windowBeat('assigned')]
  const panelRefreshes = Array.from({ length: 9 }, (_, index) =>
    panelRefresh(0, 'unassigned', index * 0.1))
  const check = judge(evidence({ windowBeats, panelRefreshes }), config({ windows: 1 })).checks.refreshes

  expect(check).toMatchObject({
    ok: false, total: 9, peakPer5s: 9, peakWindow: 0, peakWorktree: 'assigned',
    missingWindows: ['assigned'],
    byWindow: [{ index: 0, worktree: 'assigned', total: 9, peakPer5s: 9 }],
  })
})

test('refresh peak ties prefer earliest span then the lowest window index', () => {
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const records = [
    ...Array.from({ length: 9 }, (_, index) => panelRefresh(1, 'b', 2 + index * 0.1)),
    ...Array.from({ length: 9 }, (_, index) => panelRefresh(0, 'a', 2 + index * 0.1)),
    ...Array.from({ length: 9 }, (_, index) => panelRefresh(0, 'a', 9 + index * 0.1)),
  ]
  const check = judge(evidence({ windowBeats, panelRefreshes: records }), config({ windows: 2 })).checks.refreshes
  expect(check).toMatchObject({ peakPer5s: 9, peakAt: 2, peakWindow: 0, peakWorktree: 'a' })
})
test('refresh diagnostics sort by stable index and missing worktree name', () => {
  const windowBeats = [windowBeat('z'), windowBeat('a')]
  const check = judge(
    evidence({ windows: 2, windowBeats, panelRefreshes: [] }),
    config({ windows: 2 }),
  ).checks.refreshes

  expect(check.missingWindows).toEqual(['a', 'z'])
  expect(check.byWindow.map(({ index }) => index)).toEqual([0, 1])
})
test('scenario 5: schedules staggered switches and phases with their own grace periods', () => {
  expect(daySchedule({
    seconds: 300,
    windows: [{ index: 0, worktree: 'a' }, { index: 1, worktree: 'c' }],
    worktrees: ['a', 'b', 'c', 'd'],
  })).toEqual([
    { at: 15, kind: 'task', seq: 0, index: 0 },
    { at: 20, kind: 'task', seq: 0, index: 1 },
    { at: 60, kind: 'switch', seq: 0, index: 0, to: 'b' },
    { at: 90, kind: 'switch', seq: 0, index: 1, to: 'd' },
    { at: 120, kind: 'phase', seq: 1, phase: 1 },
    { at: 120, kind: 'switch', seq: 1, index: 0, to: 'c' },
    { at: 150, kind: 'switch', seq: 1, index: 1, to: 'a' },
    { at: 180, kind: 'switch', seq: 2, index: 0, to: 'd' },
    { at: 210, kind: 'switch', seq: 2, index: 1, to: 'b' },
    { at: 240, kind: 'phase', seq: 2, phase: 0 },
    { at: 240, kind: 'switch', seq: 3, index: 0, to: 'a' },
    { at: 270, kind: 'switch', seq: 3, index: 1, to: 'c' },
  ])
})

test('panelOfRequest classifies every named panel and rejects non-refresh variants', () => {
  expect([
    panelOfRequest('quirky.git/status', null),
    panelOfRequest('quirky.reviews/checksRefresh', { force: true }),
    panelOfRequest('quirky.reviews/state', { worktree: 'wt-a' }),
    panelOfRequest('quirky.editor/explorer', { action: 'list' }),
    panelOfRequest('quirky.editor/explorer', { action: 'refresh' }),
    panelOfRequest('quirky.tasks/state', null),
    panelOfRequest('quirky.tasks/prepare', null),
    panelOfRequest('quirky.session-info/get', null),
    panelOfRequest('soak.faults/feedbackRefresh', null),
  ]).toEqual(['changes', 'checks', 'checks', 'explorer', 'explorer', 'tasks', 'tasks', 'session-info', 'feedback'])
  expect(panelOfRequest('quirky.reviews/checksRefresh', { force: 1 })).toBeNull()
  expect(panelOfRequest('quirky.reviews/state', { worktree: 1 })).toBeNull()
  expect(panelOfRequest('quirky.editor/explorer', { action: 'open' })).toBeNull()
  expect(panelOfRequest('quirky.worktree/list', {})).toBeNull()
})

test('scenario 14: refresh limits are independent per panel and pass at eight', () => {
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const requests = (count: number) => Array.from({ length: count }, (_, index) => ({
    at: index * 0.5,
    index: 1,
    panel: 'explorer' as const,
  }))
  const panelRequests = [
    { at: 0, index: 0, panel: 'changes' as const },
    { at: 0, index: 1, panel: 'changes' as const },
    ...requests(9),
  ]
  const over = judge(evidence({ windowBeats, panelRequests }), config({ windows: 2 }))
  const atLimit = judge(evidence({
    windowBeats,
    panelRequests: [...panelRequests.slice(0, 2), ...requests(8)],
  }), config({ windows: 2 }))

  expect(over.checks.refreshes.ok).toBe(false)
  expect(over.checks.refreshes.byPanel).toContainEqual({
    index: 1, panel: 'explorer', total: 9, peakPer5s: 9,
  })
  expect(atLimit.checks.refreshes).toMatchObject({
    ok: true,
    byPanel: [
      { index: 0, panel: 'changes', total: 1, peakPer5s: 1 },
      { index: 1, panel: 'changes', total: 1, peakPer5s: 1 },
      { index: 1, panel: 'explorer', total: 8, peakPer5s: 8 },
    ],
  })
})

test('scenario 16: reports rolling per-window request peaks and gates only a configured budget', () => {
  const counts = Array.from({ length: 2 }, () => Array(70).fill(0) as number[])
  for (let second = 10; second < 70; second += 1) counts[0]![second] = 50
  counts[0]![10] = 51
  for (let second = 10; second < 70; second += 1) counts[1]![second] = second < 30 ? 9 : 8
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const run = (limit: number | null) => judge(
    evidence({ windowBeats, windowRequestSeconds: counts }),
    config({ windows: 2, limits: { maxWindowRequestsPerMinute: limit } }),
  )
  const reportOnly = run(null)
  expect(reportOnly.checks.requests).toMatchObject({
    ok: true,
    limitPerMinute: null,
    peakPerMinute: 3001,
    peakAt: 10,
    peakWindow: 0,
    byWindow: [
      { index: 0, total: 3001, peakPerMinute: 3001, peakAt: 10 },
      { index: 1, total: 500, peakPerMinute: 500, peakAt: 10 },
    ],
  })
  expect(run(3000).checks.requests.ok).toBe(false)
  expect(run(3001).checks.requests.ok).toBe(true)
  expect(run(3001).disqualified).toEqual(['limit loosened: maxWindowRequestsPerMinute 3001 > 2500'])
})

test('scenario 20: judges git stalls, failures and host-busy rates independently', () => {
  const gitProbe = (ms: number, ownLagMs = 0, failed = false, timedOut = false) => ({
    at: 1, ms, ownLagMs, timedOut, failed, worktree: 'w1',
  })
  const over = judge(evidence({ gitProbes: [gitProbe(1001)] }), config())
  const boundary = judge(evidence({ gitProbes: [gitProbe(1000)] }), config())
  const loopLagBoundary = judge(evidence({ gitProbes: [gitProbe(1001, 500)] }), config())
  const hostBusy = judge(evidence({ gitProbes: [gitProbe(1001, 501)] }), config())
  const timedOut = judge(evidence({ gitProbes: [gitProbe(1000, 0, false, true)] }), config())
  const failed = judge(evidence({ gitProbes: [gitProbe(3, 0, true)] }), config())
  expect(over.checks.stalls).toMatchObject({
    ok: false,
    git: {
      probes: 1, stalls: 1, failed: 0, p50Ms: 1001, p95Ms: 1001, maxMs: 1001,
      worst: [{ at: 1, ms: 1001, worktree: 'w1' }],
      byWorktree: [{ worktree: 'w1', probes: 1, maxMs: 1001 }],
    },
  })
  expect(boundary.checks.stalls).toMatchObject({ ok: true, git: { stalls: 0 } })
  expect(loopLagBoundary.checks.stalls.git).toMatchObject({ stalls: 1, hostBusy: 0 })
  expect(hostBusy.checks.stalls.git).toMatchObject({ stalls: 0, hostBusy: 1 })
  expect(timedOut.checks.stalls).toMatchObject({ ok: false, git: { stalls: 1 } })
  expect(failed.checks.stalls).toMatchObject({ ok: false, git: { failed: 1 } })

  const probes = (total: number) => [
    gitProbe(1001, 501),
    ...Array.from({ length: total - 1 }, (_, index) => gitProbe(index + 1)),
  ]
  const exact = judge(evidence({ gitProbes: probes(20) }), config())
  const overFivePercent = judge(evidence({ gitProbes: probes(19) }), config())
  expect(exact.disqualified).toEqual([])
  expect(overFivePercent.disqualified).toContain('host too busy to judge git stalls: 1 of 19 probes')
})

test('scenario 6: verifies every scheduled day identity and caps all five diagnostics with counts', () => {
  const complete = evidence()
  const check = judge(complete, config()).checks.day
  expect(check).toMatchObject({
    ok: true, enabled: true, expectedSwitches: 87, expectedPhases: 14, expectedTaskInteractions: 3,
    switches: 87, phases: 14, taskInteractions: 3,
    counts: { missing: 0, duplicates: 0, unscheduled: 0, wrongTarget: 0, failed: 0 },
  })

  const switches = [
    ...complete.switches.slice(12, 24),
    ...complete.switches.slice(24, 36).map((record) => ({ ...record, requested: 'wrong-target' })),
    ...complete.switches.slice(36),
    ...complete.switches.slice(12, 24),
    ...Array.from({ length: 12 }, (_, index) => ({
      ...complete.switches[0]!,
      seq: 1000 + index,
      requested: 'unscheduled-target',
    })),
  ]
  const phases = complete.phases.map((record, index) => index < 12 ? { ...record, ok: false } : record)
  const capped = judge(evidence({ switches, phases }), config()).checks.day
  expect(capped.counts).toEqual({
    missing: 12, duplicates: 12, unscheduled: 12, wrongTarget: 12, failed: 12,
  })
  expect(capped.missing).toHaveLength(10)
  expect(capped.duplicates).toHaveLength(10)
  expect(capped.unscheduled).toHaveLength(10)
  expect(capped.wrongTarget).toHaveLength(10)
  expect(capped.failed).toHaveLength(10)
})

test('day verdict reports a missing task interaction identity', () => {
  const complete = evidence()
  const check = judge(evidence({
    taskInteractions: complete.taskInteractions.slice(1),
  }), config()).checks.day

  expect(check).toMatchObject({
    ok: false,
    expectedTaskInteractions: 3,
    taskInteractions: 2,
    missing: ['task:0:0'],
    counts: { missing: 1 },
  })
})

test('day verdict detects duplicate task interaction identities', () => {
  const complete = evidence()
  const first = complete.taskInteractions[0]!
  const check = judge(evidence({
    taskInteractions: [...complete.taskInteractions, first],
  }), config()).checks.day

  expect(check).toMatchObject({
    ok: false,
    taskInteractions: 4,
    missing: [],
    duplicates: ['task:0:0'],
    counts: { duplicates: 1 },
  })
})

test('day verdict detects failed task interactions', () => {
  const complete = evidence()
  const check = judge(evidence({
    taskInteractions: complete.taskInteractions.map((record, index) => index === 0
      ? { ...record, ok: false }
      : record),
  }), config()).checks.day

  expect(check).toMatchObject({
    ok: false,
    failed: ['task:0:0'],
    counts: { failed: 1 },
  })
})

test('day verdict detects unscheduled task interaction identities', () => {
  const complete = evidence()
  const first = complete.taskInteractions[0]!
  const check = judge(evidence({
    taskInteractions: [...complete.taskInteractions, { ...first, seq: 1 }],
  }), config()).checks.day

  expect(check).toMatchObject({
    ok: false,
    unscheduled: ['task:0:1'],
    counts: { unscheduled: 1 },
  })
})

test('task method is diagnostic rather than part of task identity', () => {
  const complete = evidence()
  const first = complete.taskInteractions[0]!
  const check = judge(evidence({
    taskInteractions: [
      { ...first, method: 'quirky.tasks/state' },
      ...complete.taskInteractions.slice(1),
    ],
  }), config()).checks.day

  expect(check).toMatchObject({ ok: true, missing: [], unscheduled: [], wrongTarget: [] })
})

test('scenario 6: completed actions outside the truncated grace window remain scheduled', () => {
  const complete = evidence({ durationSeconds: 70 })
  const day = complete.day!
  const fullSchedule = daySchedule({
    seconds: 30 * 60,
    windows: day.windows,
    worktrees: day.worktrees,
  })
  const action = fullSchedule.find((candidate) => candidate.kind === 'switch')
  if (!action || action.kind !== 'switch') throw new Error('expected a scheduled switch')
  const record: SwitchRecord = {
    at: action.at,
    seq: action.seq,
    index: action.index,
    from: day.windows.find((window) => window.index === action.index)!.worktree,
    requested: action.to,
    settled: action.to,
    proof: { at: action.at, method: 'quirky.git/status', worktree: action.to },
    ok: true,
    followMs: 4,
    error: null,
  }
  const valid = judge(evidence({
    durationSeconds: 70,
    switches: [record],
    phases: [],
  }), config())
  const wrongTarget = judge(evidence({
    durationSeconds: 70,
    switches: [{ ...record, requested: 'wrong-target' }],
    phases: [],
  }), config())

  expect(valid.checks.day).toMatchObject({
    expectedSwitches: 0, switches: 1, missing: [], unscheduled: [], wrongTarget: [],
  })
  expect(wrongTarget.checks.day.wrongTarget).toEqual(['switch:0:0'])
})

test('scenario 6: reports omitted phases, duplicate identities, unscheduled records and wrong targets', () => {
  const complete = evidence()
  const noPhases = judge(evidence({ phases: [] }), config()).checks.day
  expect(noPhases).toMatchObject({
    ok: false, expectedPhases: 14, phases: 0, counts: { missing: 14 },
  })
  expect(noPhases.missing).toHaveLength(10)

  const firstSwitch = complete.switches[0]!
  const duplicates = judge(evidence({
    switches: Array.from({ length: 29 }, () => firstSwitch),
    phases: [],
  }), config()).checks.day
  expect(duplicates.duplicates).toEqual(['switch:0:0'])
  expect(duplicates.counts.duplicates).toBe(1)

  const completePlusDuplicate = judge(evidence({
    switches: [...complete.switches, firstSwitch],
  }), config()).checks.day
  expect(completePlusDuplicate).toMatchObject({ missing: [], duplicates: ['switch:0:0'] })

  const unscheduled = judge(evidence({
    switches: [...complete.switches, { ...firstSwitch, seq: 1000 }],
  }), config()).checks.day
  expect(unscheduled.unscheduled).toEqual(['switch:0:1000'])

  const wrongSwitchTarget = judge(evidence({
    switches: [{ ...firstSwitch, requested: 'wrong-target' }, ...complete.switches.slice(1)],
  }), config()).checks.day
  const wrongPhase = judge(evidence({
    phases: [{ ...complete.phases[0]!, phase: 0 }, ...complete.phases.slice(1)],
  }), config()).checks.day
  expect(wrongSwitchTarget.ok).toBe(false)
  expect(wrongSwitchTarget.wrongTarget).toEqual(['switch:0:0'])
  expect(wrongPhase.ok).toBe(false)
  expect(wrongPhase.wrongTarget).toEqual(['phase:1'])
})

test('scenario 6: disabled and absent day instrumentation fail normal runs', () => {
  const complete = evidence()
  const disabled = judge(evidence({
    day: { ...complete.day!, enabled: false },
    switches: [],
    phases: [],
  }), config())
  expect(disabled.checks.day).toMatchObject({ ok: false, enabled: false })
  expect(disabled.disqualified).toContain('day rotation did not run')

  const { day: _day, ...withoutDay } = complete
  const absent = judge(withoutDay as SoakEvidence, config())
  expect(absent.checks.day.ok).toBe(false)
  expect(absent.disqualified).toContain('missing instrumentation: day')
})

test('scenario 11: a day drain error fails the stop identity', () => {
  const result = judge(evidence({ dayDrainError: 'active action did not drain' }), config())
  expect(result.checks.day.failed).toContain('stop')
  expect(result.checks.day.counts.failed).toBe(1)
  expect(result.checks.day.ok).toBe(false)
})

test('scenario 12: fault runs do not disqualify disabled day instrumentation', () => {
  const complete = evidence()
  const disabled = evidence({
    day: { ...complete.day!, enabled: false },
    switches: [],
    phases: [],
  })
  const result = judge(disabled, config({ fault: 'storm' }))
  expect(result.checks.day).toMatchObject({ ok: true, enabled: false })
  expect(result.disqualified).toEqual(['fault injected: storm'])
})

test('scenario 13: absent git probes disqualify a normal run', () => {
  const { gitProbes: _gitProbes, ...absent } = evidence()
  expect(judge(absent as SoakEvidence, config()).disqualified)
    .toContain('missing instrumentation: gitProbes')
})

test('scenario 13: empty git probes disqualify a normal run', () => {
  expect(judge(evidence({ gitProbes: [] }), config()).disqualified)
    .toContain('missing instrumentation: gitProbes')
})

test('scenario 13: a missing window record disqualifies a normal run', () => {
  const complete = evidence()
  const result = judge(evidence({
    windowBeats: [windowBeat('a'), windowBeat('b')],
    windowRequestSeconds: complete.windowRequestSeconds,
    day: complete.day,
  }), config())
  expect(result.disqualified).toEqual(['window records missing: 2 of 3'])
})

test('scenario 13: absent per-window request buckets disqualify a normal run', () => {
  expect(judge(evidence({ windowRequestSeconds: undefined }), config()).disqualified)
    .toContain('missing instrumentation: windowRequestSeconds')
})

test('scenario 13: a wrong per-window request bucket count disqualifies a normal run', () => {
  expect(judge(evidence({ windowRequestSeconds: [[], []] }), config()).disqualified)
    .toContain('missing instrumentation: windowRequestSeconds')
})

test('scenario 13: absent panel request records disqualify a normal run', () => {
  expect(judge(evidence({ panelRequests: undefined }), config()).disqualified)
    .toContain('missing instrumentation: panelRequests')
})

test('scenario 13: absent day inputs disqualify a normal run', () => {
  expect(judge(evidence({ day: undefined }), config()).disqualified)
    .toContain('missing instrumentation: day')
})

test('scenario 13: disabled day rotation disqualifies a normal run', () => {
  const complete = evidence()
  expect(judge(evidence({ day: { ...complete.day!, enabled: false } }), config()).disqualified)
    .toContain('day rotation did not run')
})

test('scenario 13: day inputs need exactly the configured window indexes', () => {
  const complete = evidence()
  expect(judge(evidence({
    day: { ...complete.day!, windows: complete.day!.windows.slice(1) },
  }), config()).disqualified).toContain('day schedule inputs do not match the windows')
})

test('scenario 13: day window indexes must be integers', () => {
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const complete = evidence({ windows: 2, windowBeats })
  const day = {
    ...complete.day!,
    windows: [
      { index: 0.5, worktree: 'a' },
      { index: 1.5, worktree: 'b' },
    ],
  }
  const result = judge(
    evidence({ windows: 2, windowBeats, day }),
    config({ windows: 2 }),
  )

  expect(result.disqualified).toEqual(['day schedule inputs do not match the windows'])
})

test('scenario 13: day inputs need a non-empty worktree list', () => {
  const complete = evidence()
  expect(judge(evidence({
    day: { ...complete.day!, worktrees: [] },
  }), config()).disqualified).toContain('day schedule inputs do not match the windows')
})

test('scenario 13: every starting worktree must be in the schedule worktree list', () => {
  const complete = evidence()
  expect(judge(evidence({
    day: { ...complete.day!, worktrees: ['not-a-starting-worktree'] },
  }), config()).disqualified).toContain('day schedule inputs do not match the windows')
})

test('scenario 13 instrumentation disqualifications are suppressed for fault runs', () => {
  const { day: _day, ...withoutDay } = evidence({
    gitProbes: [],
    windowRequestSeconds: undefined,
    panelRequests: undefined,
  })
  const result = judge(withoutDay as SoakEvidence, config({ fault: 'storm' }))
  expect(result.disqualified).toEqual(['fault injected: storm'])
})

test('g2-96: the calibrated default accepts 2500 and rejects 2501 in one window only', () => {
  const windowBeats = [windowBeat('a'), windowBeat('b')]
  const run = (peak: number) => judge(
    evidence({ windowBeats, windowRequestSeconds: [[peak], [100]] }),
    config({ windows: 2, limits: { ...DEFAULT_LIMITS } }),
  )
  expect(run(2500).checks.requests).toMatchObject({ ok: true, limitPerMinute: 2500 })
  const over = run(2501)
  expect(over.checks.requests).toMatchObject({
    ok: false, limitPerMinute: 2500, peakPerMinute: 2501, peakWindow: 0, peakWorktree: 'a',
  })
  expect(over.verdict).toBe('fail')
  for (const [name, check] of Object.entries(over.checks)) {
    if (name !== 'requests') expect(check.ok).toBe(true)
  }
})

test('g2-96: loosening or disabling the default request budget cannot qualify', () => {
  for (const limit of [2501, null]) {
    const result = judge(evidence(), config({ limits: { maxWindowRequestsPerMinute: limit } }))
    expect(result.checks.requests.ok).toBe(true)
    expect(result.disqualified).toEqual([`limit loosened: maxWindowRequestsPerMinute ${limit} > 2500`])
    expect(result.qualifies).toBe(false)
  }
  for (const limit of [2500, 2499, 1]) {
    const result = judge(evidence(), config({ limits: { maxWindowRequestsPerMinute: limit } }))
    expect(result.disqualified).toEqual([])
    expect(result.qualifies).toBe(true)
  }
})

test('g2-96 calibration: all nine rotated-soak window peaks fit 50% rounded headroom', () => {
  const measured = [
    {
      run: '43918886589', commit: 'a63edf893a35f4ffd5b024d26070a06489f3ee18', source: 'PR #634',
      windows: [
        { index: 0, worktree: 'wt_58e460f79e59', peak: 1554 },
        { index: 1, worktree: 'wt_b1eef1d681be', peak: 1602 },
        { index: 2, worktree: 'wt_4f355db13c86', peak: 1594 },
      ],
    },
    {
      run: '43926394725', commit: '1aef44fbede9b6739b4ceed758b416e2841838f0', source: 'PR #634',
      windows: [
        { index: 0, worktree: 'wt_4924ede9d3d1', peak: 1565 },
        { index: 1, worktree: 'wt_dba611fb4302', peak: 1576 },
        { index: 2, worktree: 'wt_fc5e193aa479', peak: 1588 },
      ],
    },
    {
      run: '44021605080', commit: '6ca5e1b745ae757c979a47681e9d4bf8aa1d4a97', source: 'main default-input dispatch',
      windows: [
        { index: 0, worktree: 'wt_7ed9c91e4621', peak: 1534 },
        { index: 1, worktree: 'wt_26233fbe9444', peak: 1551 },
        { index: 2, worktree: 'wt_26ef7fc53415', peak: 1559 },
      ],
    },
  ]
  const maximum = Math.max(...measured.flatMap(({ windows }) => windows.map(({ peak }) => peak)))
  expect(DEFAULT_LIMITS.maxWindowRequestsPerMinute).toBe(Math.ceil(maximum * 1.5 / 100) * 100)
  expect(DEFAULT_LIMITS.maxWindowRequestsPerMinute! - maximum).toBe(898)
  for (const { windows } of measured) {
    const result = judge(evidence({
      windowBeats: windows.map(({ worktree }) => windowBeat(worktree)),
      windowRequestSeconds: windows.map(({ peak }) => [peak]),
    }), config({ limits: { ...DEFAULT_LIMITS } }))
    expect(result.checks.requests.ok).toBe(true)
    expect(result.checks.requests.byWindow.map(({ index, worktree, peakPerMinute }) => ({ index, worktree, peak: peakPerMinute })))
      .toEqual(windows)
  }
})

test('g2-96: flood ticks are not panel requests or panel refreshes', () => {
  const params = { owner: 'a', sequence: 1 }
  expect(panelOfRequest('soak.faults/floodTick', params)).toBeNull()
  expect(isPanelRefreshRequest('soak.faults/floodTick', params)).toBe(false)
})

test('terminal stalls preserve status-only counters and report terminal latency percentiles', () => {
  const terminalProbes = Array.from({ length: 20 }, (_, index) => ({
    at: index, ms: (index + 1) * 10, ownLagMs: 0, timedOut: false, failed: false,
  }))
  const result = judge(evidence({ terminalProbes }), config())
  expect(result.checks.stalls).toMatchObject({
    ok: true, probes: 0, stalls: 0, hostBusy: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, worst: [],
  })
  expect(result.checks.stalls.terminal).toEqual({
    probes: 20, stalls: 0, failed: 0, hostBusy: 0, p50Ms: 105, p95Ms: 190, maxMs: 200,
    worst: terminalProbes.slice(-10).reverse().map(({ at, ms }) => ({ at, ms })),
  })
  expect(result.checks.stalls.git).toMatchObject({ probes: 1, maxMs: 10 })
})

test('terminal stalls and failures enforce the same latency and host-lag boundaries as git', () => {
  const check = (ms: number, ownLagMs = 0, failed = false, timedOut = false) => judge(
    evidence({ terminalProbes: [{ at: 1, ms, ownLagMs, failed, timedOut }] }), config(),
  ).checks.stalls
  expect(check(1000)).toMatchObject({ ok: true, terminal: { stalls: 0, failed: 0 } })
  expect(check(1001, 500)).toMatchObject({ ok: false, terminal: { stalls: 1, hostBusy: 0 } })
  expect(check(1500, 600)).toMatchObject({ ok: true, terminal: { stalls: 0, hostBusy: 1 } })
  expect(check(5, 0, true)).toMatchObject({ ok: false, terminal: { stalls: 0, failed: 1 } })
  expect(check(30_000, 600, false, true)).toMatchObject({ ok: false, terminal: { stalls: 1, hostBusy: 0 } })
})

test('qualification requires terminal instrumentation except in fault runs', () => {
  for (const terminalProbes of [undefined, []]) {
    const result = judge(evidence({ terminalProbes }), config())
    expect(result.disqualified).toContain('missing instrumentation: terminalProbes')
    const fault = judge(evidence({ terminalProbes }), config({ fault: 'storm' }))
    expect(fault.disqualified).toEqual(['fault injected: storm'])
  }
})

test('terminal host-busy qualification applies strictly above five percent and never to faults', () => {
  const probes = (total: number) => Array.from({ length: total }, (_, index) => ({
    at: index, ms: index === 0 ? 1500 : 10, ownLagMs: index === 0 ? 600 : 0,
    timedOut: false, failed: false,
  }))
  expect(judge(evidence({ terminalProbes: probes(20) }), config()).disqualified).toEqual([])
  expect(judge(evidence({ terminalProbes: probes(19) }), config()).disqualified)
    .toContain('host too busy to judge terminal stalls: 1 of 19 probes')
  expect(judge(evidence({ terminalProbes: probes(19) }), config({ fault: 'storm' })).disqualified)
    .toEqual(['fault injected: storm'])
})
