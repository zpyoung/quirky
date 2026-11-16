import {
  DEFAULT_LIMITS,
  MAX_PANEL_REFRESHES_PER5S,
  QUALIFYING_MINUTES,
  QUALIFYING_WINDOWS,
  WINDOW_SILENCE_SECONDS,
} from './contracts'
import type {
  DayInputs,
  EventRecord,
  GitProbeRecord,
  PanelKey,
  PanelRefreshRecord,
  PanelRequestRecord,
  PhaseRecord,
  TaskInteractionRecord,
  ProcessRow,
  Sample,
  SoakConfig,
  SoakLimits,
  SoakReport,
  SwitchRecord,
  WindowBeat,
  WorkerBeat,
} from './contracts'
import { dayIdentity, daySchedule, panelOfRequest } from './day.ts'
export { panelOfRequest }
import { summarizeWorktreeRefreshes } from './worktree-refresh'


export type SoakEvidence = {
  startedAt?: string
  durationSeconds: number
  windows: number
  windowBeats: WindowBeat[]
  samples: Sample[]
  events: EventRecord[]
  panelRefreshes: PanelRefreshRecord[]
  probes: ProbeRecord[]
  workers: WorkerBeat[]
  daemonExited: boolean
  daemonLog?: string
  windowRequestSeconds?: number[][]
  panelRequests?: PanelRequestRecord[]
  gitProbes?: GitProbeRecord[]
  day?: DayInputs
  switches?: SwitchRecord[]
  taskInteractions?: TaskInteractionRecord[]
  dayDrainError?: string | null
}

/** Returns whether a renderer RPC attempt belongs to the panel-refresh budget. */
export function isPanelRefreshRequest(method: string, params: unknown): boolean {
  if (method === 'quirky.git/status' || method === 'soak.faults/feedbackRefresh') return true
  if (method !== 'quirky.reviews/checksRefresh' || params === null || typeof params !== 'object' || Array.isArray(params)) {
    return false
  }
  return (params as Record<string, unknown>).force === true
}

/** Counts caller and dispatcher timeouts across plugin namespaces for the soak's calls check. */
export function countDaemonLog(text: string): {
  unanswered: number
  byMethod: { method: string; count: number }[]
  gitTimeouts: number
} {
  const counts = new Map<string, number>()
  let unanswered = 0
  let gitTimeouts = 0
  const unansweredPattern = /\b(?:method\s+)?([\w.-]+\/[\w.-]+)(?:\s+in\s+[\w.-]+)? did not answer within \d+\s*ms\b/
  const gitTimeoutPattern = /\bgit \w+ timed out after \d+ms\b/

  for (const line of text.split(/\r?\n/)) {
    const match = unansweredPattern.exec(line)
    if (match) {
      unanswered += 1
      const method = match[1]!
      counts.set(method, (counts.get(method) ?? 0) + 1)
    }
    if (gitTimeoutPattern.test(line)) gitTimeouts += 1
  }

  const byMethod = Array.from(counts, ([method, count]) => ({ method, count }))
    .sort((left, right) => right.count - left.count || compareText(left.method, right.method))
  return { unanswered, byMethod, gitTimeouts }
}

const EXPECTED_WORKERS = 7
const EVENT_WINDOW_MS = 5000
const ZOMBIE_PERSISTENCE_SAMPLES = 3
const WORKER_FRESHNESS_SECONDS = 30
const HOST_LAG_LIMIT_MS = 500
const TOP_COUNT = 10

/** Identifies renderers that still show their worktree and send requests. */
export function windowAlive(beat: WindowBeat): boolean {
  const age = beat.lastRequestAgeSeconds
  return beat.open
    && beat.shown
    && age !== null
    && Number.isFinite(age)
    && age <= WINDOW_SILENCE_SECONDS
}

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

type PanelRefreshPeak = { count: number; at: number | null; index: number; worktree: string }

function panelRefreshPeak(records: PanelRefreshRecord[], index: number, worktree: string): PanelRefreshPeak {
  let first = 0
  let best: PanelRefreshPeak = { count: 0, at: null, index, worktree }
  for (let last = 0; last < records.length; last++) {
    const lastAtMs = Math.round(records[last]!.at * 1000)
    while (lastAtMs - Math.round(records[first]!.at * 1000) > 5000) first++
    const count = last - first + 1
    const at = records[first]!.at
    if (count > best.count
      || (count === best.count && count > 0 && best.at !== null
        && Math.round(at * 1000) < Math.round(best.at * 1000))) {
      best = { count, at, index, worktree }
    }
  }
  return best
}


function panelRequestPeak(records: PanelRequestRecord[]): number {
  const chronological = [...records].sort((left, right) => left.at - right.at)
  let first = 0
  let peak = 0
  for (let last = 0; last < chronological.length; last += 1) {
    const lastAtMs = Math.round(chronological[last]!.at * 1000)
    while (lastAtMs - Math.round(chronological[first]!.at * 1000) > 5000) first += 1
    peak = Math.max(peak, last - first + 1)
  }
  return peak
}
function judgeRefreshes(evidence: SoakEvidence): SoakReport['checks']['refreshes'] {
  const chronologicalRecords = [...(evidence.panelRefreshes ?? [])].sort((left, right) =>
    left.at - right.at || left.index - right.index)
  const recordsByWindow = new Map<number, PanelRefreshRecord[]>()
  const coveredWindows = new Set<number>()
  for (const record of chronologicalRecords) {
    const beat = evidence.windowBeats[record.index]
    if (!beat) continue
    const records = recordsByWindow.get(record.index)
    if (records) records.push(record)
    else recordsByWindow.set(record.index, [record])
    if (beat.worktree === record.worktree) coveredWindows.add(record.index)
  }

  const byWindow = evidence.windowBeats.map((beat, index) => {
    const records = recordsByWindow.get(index) ?? []
    return {
      index,
      worktree: beat.worktree,
      total: records.length,
      peakPer5s: panelRefreshPeak(records, index, beat.worktree).count,
    }
  })
  const missingWindows = evidence.windowBeats
    .flatMap((beat, index) => windowAlive(beat) && !coveredWindows.has(index) ? [beat.worktree] : [])
    .sort(compareText)

  let best: PanelRefreshPeak = { count: 0, at: null, index: 0, worktree: '' }
  for (const beat of byWindow) {
    const peak = panelRefreshPeak(recordsByWindow.get(beat.index) ?? [], beat.index, beat.worktree)
    if (peak.count > best.count
      || (peak.count === best.count && peak.count > 0 && peak.at !== null && best.at !== null
        && (Math.round(peak.at * 1000) < Math.round(best.at * 1000)
          || (Math.round(peak.at * 1000) === Math.round(best.at * 1000) && peak.index < best.index)))) {
      best = peak
    }
  }
  const byPanel = new Map<number, Map<PanelKey, PanelRequestRecord[]>>()
  for (const record of evidence.panelRequests ?? []) {
    const panels = byPanel.get(record.index)
    const records = panels?.get(record.panel)
    if (records) {
      records.push(record)
    } else if (panels) {
      panels.set(record.panel, [record])
    } else {
      byPanel.set(record.index, new Map([[record.panel, [record]]]))
    }
  }
  const panelTotals = Array.from(byPanel, ([index, panels]) =>
    Array.from(panels, ([panel, records]) => ({
      index,
      panel,
      total: records.length,
      peakPer5s: panelRequestPeak(records),
    }))).flat()
    .sort((left, right) => left.index - right.index || compareText(left.panel, right.panel))
  const total = (evidence.panelRefreshes ?? []).length

  return {
    ok: best.count <= MAX_PANEL_REFRESHES_PER5S
      && missingWindows.length === 0
      && panelTotals.every((panel) => panel.peakPer5s <= MAX_PANEL_REFRESHES_PER5S),
    total,
    limitPer5s: MAX_PANEL_REFRESHES_PER5S,
    peakPer5s: best.count,
    peakAt: best.at,
    peakWindow: best.count === 0 ? null : best.index,
    peakWorktree: best.count === 0 ? null : best.worktree,
    missingWindows,
    byWindow,
    byPanel: panelTotals,
  }
}


function judgeRequests(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['requests'] {
  const seconds = evidence.windowRequestSeconds ?? []
  const byWindow = Array.from({ length: config.windows }, (_, index) => {
    const counts = seconds[index] ?? []
    const total = counts.reduce((sum, count) => sum + count, 0)
    const width = Math.min(60, counts.length)
    let peakPerMinute = 0
    let peakAt: number | null = null
    if (width > 0) {
      let rolling = 0
      for (let second = 0; second < width; second += 1) rolling += counts[second]!
      peakPerMinute = rolling
      peakAt = 0
      for (let start = 1; start <= counts.length - width; start += 1) {
        rolling += counts[start + width - 1]! - counts[start - 1]!
        if (rolling > peakPerMinute) {
          peakPerMinute = rolling
          peakAt = start
        }
      }
    }
    if (peakPerMinute === 0) peakAt = null
    return {
      index,
      worktree: evidence.day?.windows.find((window) => window.index === index)?.worktree
        ?? evidence.windowBeats[index]?.worktree
        ?? '',
      total,
      peakPerMinute,
      peakAt,
    }
  })

  let peakPerMinute = 0
  let peakAt: number | null = null
  let peakWindow: number | null = null
  let peakWorktree: string | null = null
  for (const window of byWindow) {
    if (window.peakAt === null) continue
    if (peakWindow === null || window.peakPerMinute > peakPerMinute
      || (window.peakPerMinute === peakPerMinute
        && (window.peakAt < peakAt! || (window.peakAt === peakAt && window.index < peakWindow)))) {
      peakPerMinute = window.peakPerMinute
      peakAt = window.peakAt
      peakWindow = window.index
      peakWorktree = window.worktree || null
    }
  }
  const limitPerMinute = config.limits.maxWindowRequestsPerMinute
  return {
    ok: limitPerMinute === null || peakPerMinute <= limitPerMinute,
    limitPerMinute,
    peakPerMinute,
    peakAt,
    peakWindow,
    peakWorktree,
    byWindow,
  }
}
function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0
  return sortedValues[Math.ceil(sortedValues.length * fraction) - 1]
}

function judgeGitStalls(
  records: GitProbeRecord[],
  maxStallMs: number,
): SoakReport['checks']['stalls']['git'] {
  const chronological = [...records].sort((left, right) => left.at - right.at)
  const latencies = chronological.map((probe) => probe.ms)
  const sortedLatencies = [...latencies].sort((left, right) => left - right)
  const byWorktree = new Map<string, { probes: number; maxMs: number }>()
  let stalls = 0
  let failed = 0
  let hostBusy = 0

  for (const probe of chronological) {
    if (probe.failed) failed += 1
    if (probe.timedOut) {
      stalls += 1
    } else if (probe.ms > maxStallMs) {
      if (probe.ownLagMs > HOST_LAG_LIMIT_MS) hostBusy += 1
      else stalls += 1
    }
    const stats = byWorktree.get(probe.worktree)
    if (stats) {
      stats.probes += 1
      stats.maxMs = Math.max(stats.maxMs, probe.ms)
    } else {
      byWorktree.set(probe.worktree, { probes: 1, maxMs: probe.ms })
    }
  }

  return {
    probes: chronological.length,
    stalls,
    failed,
    hostBusy,
    p50Ms: median([...latencies]),
    p95Ms: percentile(sortedLatencies, 0.95),
    maxMs: sortedLatencies.length === 0 ? 0 : sortedLatencies[sortedLatencies.length - 1]!,
    worst: [...chronological]
      .sort((left, right) => right.ms - left.ms || left.at - right.at || compareText(left.worktree, right.worktree))
      .slice(0, TOP_COUNT)
      .map(({ at, ms, worktree }) => ({ at, ms, worktree })),
    byWorktree: Array.from(byWorktree, ([worktree, stats]) => ({ worktree, ...stats }))
      .sort((left, right) => compareText(left.worktree, right.worktree)),
  }
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

  const git = judgeGitStalls(evidence.gitProbes ?? [], config.limits.maxStallMs)
  return {
    ok: stalls === 0 && git.stalls === 0 && git.failed === 0 && !evidence.daemonExited,
    probes: chronologicalProbes.length,
    stalls,
    hostBusy,
    p50Ms: median([...latencies]),
    p95Ms: percentile(sortedLatencies, 0.95),
    maxMs: sortedLatencies.length === 0 ? 0 : sortedLatencies[sortedLatencies.length - 1],
    worst,
    daemonExited: evidence.daemonExited,
    git,
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

function judgeWindows(windowBeats: WindowBeat[]): SoakReport['checks']['windows'] {
  const lost: string[] = []
  let alive = 0

  for (const beat of windowBeats) {
    if (windowAlive(beat)) alive += 1
    else lost.push(beat.worktree)
  }

  return { ok: lost.length === 0, expected: windowBeats.length, alive, lost }
}


function dayInputsMatchWindows(day: DayInputs | undefined, windowCount: number): boolean {
  if (!day || day.windows.length !== windowCount || day.worktrees.length === 0) return false
  const indexes = new Set<number>()
  for (const window of day.windows) {
    if (!Number.isInteger(window.index) || window.index < 0 || window.index >= windowCount
      || indexes.has(window.index) || !day.worktrees.includes(window.worktree)) return false
    indexes.add(window.index)
  }
  return indexes.size === windowCount
}

function judgeDay(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['day'] {
  if (config.fault !== undefined || config.windows === 0) {
    return {
      ok: true,
      enabled: false,
      expectedSwitches: 0,
      expectedPhases: 0,
      expectedTaskInteractions: 0,
      switches: 0,
      phases: 0,
      taskInteractions: 0,
      missing: [],
      duplicates: [],
      unscheduled: [],
      wrongTarget: [],
      failed: [],
      slowestFollowMs: null,
      counts: { missing: 0, duplicates: 0, unscheduled: 0, wrongTarget: 0, failed: 0 },
    }
  }

  const day = evidence.day
  const expectedActions = day ? daySchedule({
    seconds: Math.min(config.minutes * 60, evidence.durationSeconds),
    windows: day.windows,
    worktrees: day.worktrees,
  }) : []
  const scheduledActions = day ? daySchedule({
    seconds: config.minutes * 60,
    windows: day.windows,
    worktrees: day.worktrees,
  }) : []
  const expected = new Map(scheduledActions.map((action) => [dayIdentity(action), action]))
  const switches = evidence.switches ?? []
  const phases = evidence.phases ?? []
  const taskInteractions = evidence.taskInteractions ?? []
  const actual: (SwitchRecord | PhaseRecord | TaskInteractionRecord)[] = [
    ...switches,
    ...phases,
    ...taskInteractions,
  ]
  const identityCounts = new Map<string, number>()
  for (const record of actual) {
    const identity = dayIdentity(record)
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1)
  }

  const missing = expectedActions
    .filter((action) => !identityCounts.has(dayIdentity(action)))
    .map((action) => dayIdentity(action))
  const duplicates = Array.from(new Set(actual
    .map((record) => dayIdentity(record))
    .filter((identity) => (identityCounts.get(identity) ?? 0) > 1)))
  const unscheduled = Array.from(new Set(actual
    .filter((record) => !expected.has(dayIdentity(record)))
    .map((record) => dayIdentity(record))))
  const wrongTarget = Array.from(new Set(actual.flatMap((record) => {
    const identity = dayIdentity(record)
    const action = expected.get(identity)
    if (!action) return []
    const wrong = 'phase' in record
      ? action.kind !== 'phase' || action.phase !== record.phase
      : 'requested' in record
        ? action.kind !== 'switch' || action.to !== record.requested
        : action.kind !== 'task' || action.index !== record.index
    return wrong ? [identity] : []
  })))
  const failed = Array.from(new Set([
    ...actual.filter((record) => !record.ok).map((record) => dayIdentity(record)),
    ...(evidence.dayDrainError === undefined || evidence.dayDrainError === null ? [] : ['stop']),
  ]))
  const counts = {
    missing: missing.length,
    duplicates: duplicates.length,
    unscheduled: unscheduled.length,
    wrongTarget: wrongTarget.length,
    failed: failed.length,
  }
  let slowestFollowMs: number | null = null
  for (const record of switches) {
    if (record.followMs !== null && (slowestFollowMs === null || record.followMs > slowestFollowMs)) {
      slowestFollowMs = record.followMs
    }
  }
  const inputsMatch = dayInputsMatchWindows(day, config.windows)
  const enabled = day?.enabled === true

  return {
    ok: enabled && inputsMatch
      && Object.values(counts).every((count) => count === 0),
    enabled,
    expectedSwitches: expectedActions.filter((action) => action.kind === 'switch').length,
    expectedPhases: expectedActions.filter((action) => action.kind === 'phase').length,
    expectedTaskInteractions: expectedActions.filter((action) => action.kind === 'task').length,
    switches: switches.length,
    phases: phases.length,
    taskInteractions: taskInteractions.length,
    missing: missing.slice(0, TOP_COUNT),
    duplicates: duplicates.slice(0, TOP_COUNT),
    unscheduled: unscheduled.slice(0, TOP_COUNT),
    wrongTarget: wrongTarget.slice(0, TOP_COUNT),
    failed: failed.slice(0, TOP_COUNT),
    slowestFollowMs,
    counts,
  }
}
function disqualifications(
  evidence: SoakEvidence,
  config: SoakConfig,
  hostBusy: number,
  probes: number,
  gitHostBusy: number,
  gitProbes: number,
): string[] {
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
  if (gitProbes > 0 && gitHostBusy / gitProbes > 0.05) {
    reasons.push(`host too busy to judge git stalls: ${gitHostBusy} of ${gitProbes} probes`)
  }

  const limitKeys: (keyof SoakLimits)[] = [
    'maxChildren',
    'maxGrowth',
    'maxZombies',
    'maxEventsPer5s',
    'maxStallMs',
    'maxUnanswered',
    'maxWindowRequestsPerMinute',
  ]
  for (const key of limitKeys) {
    const defaultLimit = DEFAULT_LIMITS[key]
    if (defaultLimit === null) continue
    const configuredLimit = config.limits[key]
    if (configuredLimit === null || configuredLimit > defaultLimit) {
      reasons.push(`limit loosened: ${key} ${configuredLimit} > ${defaultLimit}`)
    }
  }

  if (config.fault === undefined) {
    if (!evidence.gitProbes || evidence.gitProbes.length === 0) {
      reasons.push('missing instrumentation: gitProbes')
    }
    if (config.windows > 0 && evidence.windowBeats.length !== config.windows) {
      reasons.push(`window records missing: ${evidence.windowBeats.length} of ${config.windows}`)
    }
    if (config.windows > 0
      && (!evidence.windowRequestSeconds || evidence.windowRequestSeconds.length !== config.windows)) {
      reasons.push('missing instrumentation: windowRequestSeconds')
    }
    if (config.windows > 0 && evidence.panelRequests === undefined) {
      reasons.push('missing instrumentation: panelRequests')
    }
    if (config.windows > 0 && evidence.day === undefined) {
      reasons.push('missing instrumentation: day')
    }
    if (config.windows > 0 && evidence.day?.enabled === false) {
      reasons.push('day rotation did not run')
    }
    if (evidence.day !== undefined && !dayInputsMatchWindows(evidence.day, config.windows)) {
      reasons.push('day schedule inputs do not match the windows')
    }
  }
  if (config.fault !== undefined) reasons.push(`fault injected: ${config.fault}`)
  return reasons
}

function judgeCalls(evidence: SoakEvidence, config: SoakConfig): SoakReport['checks']['calls'] {
  const text = evidence.daemonLog ?? ''
  const result = countDaemonLog(text)
  const refreshes = summarizeWorktreeRefreshes(text, evidence.startedAt, evidence.probes)
  return {
    ...result,
    refreshes,
    ok: result.unanswered <= config.limits.maxUnanswered &&
      refreshes.failed === 0 &&
      refreshes.pending === 0 &&
      refreshes.invalid === 0,
  }
}

export function judge(
  evidence: SoakEvidence,
  config: SoakConfig,
): Pick<SoakReport, 'verdict' | 'qualifies' | 'disqualified' | 'checks'> {
  const checks = {
    children: judgeChildren(evidence, config),
    zombies: judgeZombies(evidence, config),
    events: judgeEvents(evidence, config),
    refreshes: judgeRefreshes(evidence),
    requests: judgeRequests(evidence, config),
    stalls: judgeStalls(evidence, config),
    day: judgeDay(evidence, config),
    calls: judgeCalls(evidence, config),
    workers: judgeWorkers(evidence.workers),
    windows: judgeWindows(evidence.windowBeats),
  }
  const disqualified = disqualifications(
    evidence,
    config,
    checks.stalls.hostBusy,
    checks.stalls.probes,
    checks.stalls.git.hostBusy,
    checks.stalls.git.probes,
  )

  return {
    verdict: Object.values(checks).every((check) => check.ok) ? 'pass' : 'fail',
    qualifies: disqualified.length === 0,
    disqualified,
    checks,
  }
}
