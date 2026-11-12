import { DEFAULT_LIMITS, QUALIFYING_MINUTES, QUALIFYING_WINDOWS } from './contracts'
import type {
  EventRecord,
  ProbeRecord,
  ProcessRow,
  Sample,
  SoakConfig,
  SoakLimits,
  SoakReport,
  WorkerBeat,
} from './contracts'

export type SoakEvidence = {
  durationSeconds: number
  windows: number
  samples: Sample[]
  events: EventRecord[]
  probes: ProbeRecord[]
  workers: WorkerBeat[]
  daemonExited: boolean
}

const EXPECTED_WORKERS = 7
const EVENT_WINDOW_MS = 5000
const ZOMBIE_PERSISTENCE_SAMPLES = 3
const WORKER_FRESHNESS_SECONDS = 30
const HOST_LAG_LIMIT_MS = 500
const TOP_COUNT = 10

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function processIdentity(row: ProcessRow): string {
  return JSON.stringify([row.pid, row.started])
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  values.sort((left, right) => left - right)
  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle]
}

function commandCounts(rows: ProcessRow[]): { command: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.command, (counts.get(row.command) ?? 0) + 1)
  return [...counts]
    .map(([command, count]) => ({ command, count }))
    .sort((left, right) => right.count - left.count || compareText(left.command, right.command))
    .slice(0, 5)
}

function judgeChildren(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['children'] {
  const chronologicalSamples = [...evidence.samples].sort((left, right) => left.at - right.at)
  const warmupSeconds = Math.min(60, evidence.durationSeconds / 5)
  const judgedSamples = chronologicalSamples.filter((sample) => sample.at >= warmupSeconds)

  let peak = 0
  let peakAt = 0
  let peakCommands: { command: string; count: number }[] = []
  for (let index = 0; index < judgedSamples.length; index++) {
    const sample = judgedSamples[index]
    if (index === 0 || sample.owned.length > peak) {
      peak = sample.owned.length
      peakAt = sample.at
      peakCommands = commandCounts(sample.owned)
    }
  }

  let medianFirst: number | null = null
  let medianLast: number | null = null
  let growth: number | null = null
  if (judgedSamples.length >= 10) {
    const fifthSize = Math.ceil(judgedSamples.length / 5)
    medianFirst = median(judgedSamples.slice(0, fifthSize).map((sample) => sample.owned.length))
    medianLast = median(judgedSamples.slice(-fifthSize).map((sample) => sample.owned.length))
    growth = medianLast - medianFirst
  }

  const identities = new Set<string>()
  for (const sample of chronologicalSamples) {
    for (const row of sample.owned) identities.add(processIdentity(row))
  }
  const spawned = identities.size
  const spawnedPerMinute = evidence.durationSeconds > 0
    ? spawned / (evidence.durationSeconds / 60)
    : 0

  return {
    ok: peak <= config.limits.maxChildren && (growth === null || growth <= config.limits.maxGrowth),
    peak,
    peakAt,
    peakCommands,
    medianFirst,
    medianLast,
    growth,
    spawned,
    spawnedPerMinute,
  }
}

type ZombieTracker = {
  row: ProcessRow
  lastSampleIndex: number
  streak: number
  maxStreak: number
  seconds: number
}

function judgeZombies(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['zombies'] {
  const chronologicalSamples = [...evidence.samples].sort((left, right) => left.at - right.at)
  const trackers = new Map<string, ZombieTracker>()
  let peak = 0

  for (let sampleIndex = 0; sampleIndex < chronologicalSamples.length; sampleIndex++) {
    const sample = chronologicalSamples[sampleIndex]
    const zombies = new Set<string>()
    for (const row of sample.owned) {
      if (!row.state.startsWith('Z')) continue
      const identity = processIdentity(row)
      if (zombies.has(identity)) continue
      zombies.add(identity)

      const tracker = trackers.get(identity)
      if (!tracker) {
        trackers.set(identity, {
          row,
          lastSampleIndex: sampleIndex,
          streak: 1,
          maxStreak: 1,
          seconds: 1,
        })
      } else {
        tracker.streak = tracker.lastSampleIndex === sampleIndex - 1 ? tracker.streak + 1 : 1
        tracker.lastSampleIndex = sampleIndex
        tracker.maxStreak = Math.max(tracker.maxStreak, tracker.streak)
        tracker.seconds++
        tracker.row = row
      }
    }
    peak = Math.max(peak, zombies.size)
  }

  const persistentTrackers = [...trackers.values()]
    .filter((tracker) => tracker.maxStreak >= ZOMBIE_PERSISTENCE_SAMPLES)
    .sort((left, right) => right.seconds - left.seconds
      || left.row.pid - right.row.pid
      || compareText(left.row.started, right.row.started))

  return {
    ok: persistentTrackers.length <= config.limits.maxZombies,
    peak,
    persistent: persistentTrackers.length,
    examples: persistentTrackers.slice(0, 5).map(({ row, seconds }) => ({
      pid: row.pid,
      ppid: row.ppid,
      command: row.command,
      seconds,
    })),
  }
}

type EventPeak = { count: number; at: number }

function eventPeak(records: EventRecord[]): EventPeak {
  let first = 0
  let best: EventPeak = { count: 0, at: 0 }
  for (let last = 0; last < records.length; last++) {
    const lastAtMs = Math.round(records[last].at * 1000)
    while (lastAtMs - Math.round(records[first].at * 1000) > EVENT_WINDOW_MS) first++
    const count = last - first + 1
    if (count > best.count) best = { count, at: records[first].at }
  }
  return best
}

function judgeEvents(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['events'] {
  const chronologicalEvents = [...evidence.events].sort((left, right) =>
    left.at - right.at || compareText(left.type, right.type))
  const eventsByType = new Map<string, EventRecord[]>()
  for (const event of chronologicalEvents) {
    const records = eventsByType.get(event.type)
    if (records) records.push(event)
    else eventsByType.set(event.type, [event])
  }

  const typePeaks = [...eventsByType].map(([type, records]) => ({
    type,
    total: records.length,
    peak: eventPeak(records),
  }))
  let peakPer5s = 0
  let peakType: string | null = null
  let peakAt: number | null = null
  for (const { type, peak } of typePeaks) {
    if (peak.count > peakPer5s
      || (peak.count === peakPer5s && peak.count > 0
        && (peakAt === null || peak.at < peakAt
          || (peak.at === peakAt && peakType !== null && compareText(type, peakType) < 0)))) {
      peakPer5s = peak.count
      peakType = type
      peakAt = peak.at
    }
  }

  const byType = typePeaks
    .sort((left, right) => right.total - left.total || compareText(left.type, right.type))
    .slice(0, TOP_COUNT)
    .map(({ type, total, peak }) => ({ type, total, peakPer5s: peak.count }))

  return {
    ok: peakPer5s <= config.limits.maxEventsPer5s,
    total: chronologicalEvents.length,
    peakPer5s,
    peakType,
    peakAt,
    byType,
  }
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0
  return sortedValues[Math.ceil(sortedValues.length * fraction) - 1]
}

function judgeStalls(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['stalls'] {
  const chronologicalProbes = [...evidence.probes].sort((left, right) => left.at - right.at)
  const latencies = chronologicalProbes.map((probe) => probe.ms)
  const sortedLatencies = [...latencies].sort((left, right) => left - right)
  let stalls = 0
  let hostBusy = 0

  for (const probe of chronologicalProbes) {
    if (probe.timedOut) {
      stalls++
    } else if (probe.ms > config.limits.maxStallMs) {
      if (probe.ownLagMs > HOST_LAG_LIMIT_MS) hostBusy++
      else stalls++
    }
  }

  const worst = [...chronologicalProbes]
    .sort((left, right) => right.ms - left.ms || left.at - right.at)
    .slice(0, TOP_COUNT)
    .map(({ at, ms }) => ({ at, ms }))

  return {
    ok: stalls === 0 && !evidence.daemonExited,
    probes: chronologicalProbes.length,
    stalls,
    hostBusy,
    p50Ms: median([...latencies]),
    p95Ms: percentile(sortedLatencies, 0.95),
    maxMs: sortedLatencies.length === 0 ? 0 : sortedLatencies[sortedLatencies.length - 1],
    worst,
    daemonExited: evidence.daemonExited,
  }
}

function judgeWorkers(workers: WorkerBeat[]): SoakReport['checks']['workers'] {
  const stale = workers
    .filter((worker) => worker.lastBeatAgeSeconds === null
      || worker.lastBeatAgeSeconds > WORKER_FRESHNESS_SECONDS)
    .map((worker) => worker.worktree)
    .sort(compareText)
  const alive = workers.length - stale.length
  return {
    ok: alive === EXPECTED_WORKERS && stale.length === 0,
    expected: EXPECTED_WORKERS,
    alive,
    stale,
  }
}

function disqualifications(evidence: SoakEvidence, config: SoakConfig, hostBusy: number, probes: number): string[] {
  const reasons: string[] = []
  const runMinutes = Math.min(config.minutes, evidence.durationSeconds / 60)
  if (runMinutes < QUALIFYING_MINUTES) {
    const reportedMinutes = Math.round(runMinutes * 1000) / 1000
    reasons.push(`ran ${reportedMinutes} minutes, needs ${QUALIFYING_MINUTES}`)
  }
  if (evidence.windows < QUALIFYING_WINDOWS) {
    reasons.push(`${evidence.windows} windows connected, needs ${QUALIFYING_WINDOWS}`)
  }
  if (probes > 0 && hostBusy / probes > 0.05) {
    reasons.push(`host too busy to judge stalls: ${hostBusy} of ${probes} probes`)
  }

  const limitKeys: (keyof SoakLimits)[] = [
    'maxChildren',
    'maxGrowth',
    'maxZombies',
    'maxEventsPer5s',
    'maxStallMs',
  ]
  for (const key of limitKeys) {
    if (config.limits[key] > DEFAULT_LIMITS[key]) {
      reasons.push(`limit loosened: ${key} ${config.limits[key]} > ${DEFAULT_LIMITS[key]}`)
    }
  }
  return reasons
}

export function judge(
  evidence: SoakEvidence,
  config: SoakConfig,
): Pick<SoakReport, 'verdict' | 'qualifies' | 'disqualified' | 'checks'> {
  const checks = {
    children: judgeChildren(evidence, config),
    zombies: judgeZombies(evidence, config),
    events: judgeEvents(evidence, config),
    stalls: judgeStalls(evidence, config),
    workers: judgeWorkers(evidence.workers),
  }
  const disqualified = disqualifications(
    evidence,
    config,
    checks.stalls.hostBusy,
    checks.stalls.probes,
  )

  return {
    verdict: Object.values(checks).every((check) => check.ok) ? 'pass' : 'fail',
    qualifies: disqualified.length === 0,
    disqualified,
    checks,
  }
}
