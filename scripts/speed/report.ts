import { BUDGETS, CONFIDENCE_Z, METRICS, PAIR_COUNTS, REGRESSION_RATIO, type Comparison, type EchoTiming, type EchoTimingSummary, type Failure, type Metric, type MetricComparison, type PairBasis, type RunnerLatency, type RunnerSetting, type SchedulerSummary, type SpeedMiss, type SpeedPair, type SpeedProfile, type SpeedReport, type TimerInterval, type TimerWindow, type TimerWindowSummary } from './contracts'

const REPORT_KEYS = ['version', 'commit', 'runId', 'createdAt', 'status', 'qualified', 'profile', 'metrics', 'failures', 'cleanup', 'evidence']
const REPORT_V4_KEYS = [...REPORT_KEYS, 'runnerLatency']
const PROFILE_KEYS = ['workloadVersion', 'worktrees', 'terminals', 'diffAddedLines', 'renderer', 'viewport', 'startup', 'floodChunkBytes', 'floodIntervalMs', 'runner', 'os', 'arch', 'cpuModel', 'cpuCount', 'bun', 'chromium', 'imageVersion']
const PROFILE_V2_KEYS = [...PROFILE_KEYS, 'compositor']
const METRIC_RESULT_KEYS = ['samplesMs', 'medianMs', 'budgetMs', 'budgetMiss']
const PROFILE_V3_KEYS = [...PROFILE_V2_KEYS, 'frameTiming']
const PROFILE_V4_KEYS = [...PROFILE_V3_KEYS, 'runnerPolicy']
const METRIC_RESULT_V3_KEYS = [...METRIC_RESULT_KEYS, 'wallSamplesMs', 'unavailableSamples']
const METRIC_RESULT_V4_KEYS = [...METRIC_RESULT_V3_KEYS, 'echoTiming', 'scheduler']
const FRAME_TIMING_MODE = 'native-final-frame-idle-cap-60hz'
const FRAME_TIMING_V4_MODE = 'native-final-frame-echo-arrival-cap-60hz'
const RUNNER_POLICY_V4 = 'ci-macos-timer-experiment-v1'
const EVIDENCE_KEYS = ['samples', 'diagnostics', 'misses']
const PAIR_KEYS = ['version', 'runId', 'createdAt', 'status', 'qualified', 'head', 'base', 'metrics', 'failures', 'evidence']
const PAIR_EVIDENCE_KEYS = ['samples']
const MAX_FAILURES = 100
const MAX_EVIDENCE_PATHS = 100
const MAX_PAIR_SAMPLES = 1000
const MAX_TIMER_INTERVALS = 8192
const MAX_MARKDOWN_CHARS = 16_000
const MAX_CELL_CHARS = 300

export function median(samples: readonly number[]): number | null {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) return null
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (lower === undefined || upper === undefined) return null
  return lower + (upper - lower) / 2
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isBoundedText(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function isSafeEvidencePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function medianNonNegative(samples: readonly number[]): number | null {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) return null
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (sorted.length % 2 === 1) return upper ?? null
  if (lower === undefined || upper === undefined) return null
  return lower + (upper - lower) / 2
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.001
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

const ECHO_TIMING_KEYS = [
  'status', 'reason', 'workerReadEpochMs', 'pageTimeOriginMs', 'receivedAt',
  'keystrokeToWorkerMs', 'workerToPageMs', 'pageToPaintMs',
]

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function validEchoTimingShape(value: unknown): value is EchoTiming {
  if (!isRecord(value) || !hasExactKeys(value, ECHO_TIMING_KEYS)) return false
  if (value.status === 'unavailable') {
    return isBoundedText(value.reason)
      && finiteOrNull(value.workerReadEpochMs)
      && finiteOrNull(value.pageTimeOriginMs)
      && finiteOrNull(value.receivedAt)
      && value.keystrokeToWorkerMs === null
      && value.workerToPageMs === null
      && value.pageToPaintMs === null
  }
  if (value.status !== 'complete'
    || value.reason !== null
    || typeof value.workerReadEpochMs !== 'number' || !Number.isFinite(value.workerReadEpochMs)
    || typeof value.pageTimeOriginMs !== 'number' || !Number.isFinite(value.pageTimeOriginMs)
    || typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt) || value.receivedAt < 0
    || typeof value.keystrokeToWorkerMs !== 'number' || !Number.isFinite(value.keystrokeToWorkerMs) || value.keystrokeToWorkerMs < 0
    || typeof value.workerToPageMs !== 'number' || !Number.isFinite(value.workerToPageMs) || value.workerToPageMs < 0
    || typeof value.pageToPaintMs !== 'number' || !Number.isFinite(value.pageToPaintMs) || value.pageToPaintMs < 0) return false
  const arrivalEpochMs = value.pageTimeOriginMs + value.receivedAt
  return Number.isFinite(arrivalEpochMs)
    && value.workerReadEpochMs <= arrivalEpochMs
    && approximatelyEqual(value.workerToPageMs, arrivalEpochMs - value.workerReadEpochMs)
}

function unavailableEchoTiming(): EchoTiming {
  return {
    status: 'unavailable', reason: 'invalid-echo-timing',
    workerReadEpochMs: null, pageTimeOriginMs: null, receivedAt: null,
    keystrokeToWorkerMs: null, workerToPageMs: null, pageToPaintMs: null,
  }
}

/** Aggregates valid phase evidence; malformed supplemental samples become explicitly unavailable. */
export function summarizeEchoTiming(samples: readonly unknown[]): EchoTimingSummary {
  const normalized = Array.isArray(samples)
    ? samples.map((sample) => validEchoTimingShape(sample) ? sample : unavailableEchoTiming())
    : []
  const complete = normalized.filter((sample) => sample.status === 'complete')
  return {
    samples: normalized,
    completeSamples: complete.length,
    unavailableSamples: normalized.length - complete.length,
    medians: {
      keystrokeToWorkerMs: medianNonNegative(complete.map((sample) => sample.keystrokeToWorkerMs)),
      workerToPageMs: medianNonNegative(complete.map((sample) => sample.workerToPageMs)),
      pageToPaintMs: medianNonNegative(complete.map((sample) => sample.pageToPaintMs)),
    },
  }
}

const TIMER_INTERVAL_KEYS = ['requestedEpochMs', 'dueEpochMs', 'wokeEpochMs', 'lateMs']

function validTimerInterval(value: unknown): value is TimerInterval {
  if (!isRecord(value) || !hasExactKeys(value, TIMER_INTERVAL_KEYS)) return false
  const { requestedEpochMs, dueEpochMs, wokeEpochMs, lateMs } = value
  return [requestedEpochMs, dueEpochMs, wokeEpochMs, lateMs].every((number) => typeof number === 'number' && Number.isFinite(number))
    && requestedEpochMs <= dueEpochMs
    && dueEpochMs <= wokeEpochMs
    && lateMs >= 0
    && approximatelyEqual(lateMs, wokeEpochMs - dueEpochMs)
}

function validTimerWindow(value: unknown): value is TimerWindow {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'reason', 'intervals', 'pendingLateAtEndMs'])) return false
  if (value.status === 'unavailable') {
    return isBoundedText(value.reason)
      && Array.isArray(value.intervals) && value.intervals.length === 0
      && value.pendingLateAtEndMs === null
  }
  return value.status === 'complete'
    && value.reason === null
    && Array.isArray(value.intervals)
    && value.intervals.length <= MAX_TIMER_INTERVALS
    && value.intervals.every(validTimerInterval)
    && (value.pendingLateAtEndMs === null
      || (typeof value.pendingLateAtEndMs === 'number' && Number.isFinite(value.pendingLateAtEndMs) && value.pendingLateAtEndMs >= 0))
}

function unavailableWindowSummary(reason = 'invalid-timer-window'): TimerWindowSummary {
  return { status: 'unavailable', reason, intervals: 0, medianLateMs: null, maxLateMs: null, pendingLateAtEndMs: null }
}

function summarizeTimerWindow(value: unknown): TimerWindowSummary {
  if (!validTimerWindow(value)) return unavailableWindowSummary()
  if (value.status === 'unavailable') return unavailableWindowSummary(value.reason)
  const lateValues = value.intervals.map((interval) => interval.lateMs)
  return {
    status: 'complete',
    reason: null,
    intervals: value.intervals.length,
    medianLateMs: medianNonNegative(lateValues),
    maxLateMs: lateValues.length === 0 ? null : Math.max(...lateValues),
    pendingLateAtEndMs: value.pendingLateAtEndMs,
  }
}

/** Reduces per-sample timer captures to bounded summaries, excluding unavailable windows from medians. */
export function summarizeScheduler(samples: readonly unknown[]): SchedulerSummary {
  const unavailable = unavailableWindowSummary()
  const normalized = Array.isArray(samples) ? samples.map((sample) => {
    if (!isRecord(sample) || !hasExactKeys(sample, ['harness', 'floodWorker'])) {
      return { harness: unavailable, floodWorker: unavailable }
    }
    return {
      harness: summarizeTimerWindow(sample.harness),
      floodWorker: sample.floodWorker === null ? null : summarizeTimerWindow(sample.floodWorker),
    }
  }) : []
  const harnessMaxLate = normalized
    .map((sample) => sample.harness.status === 'complete' ? sample.harness.maxLateMs : null)
    .filter((late): late is number => late !== null)
  const harnessPendingLate = normalized
    .map((sample) => sample.harness.status === 'complete' ? sample.harness.pendingLateAtEndMs : null)
    .filter((late): late is number => late !== null)
  const floodWorkerMaxLate = normalized
    .map((sample) => sample.floodWorker?.status === 'complete' ? sample.floodWorker.maxLateMs : null)
    .filter((late): late is number => late !== null)
  return {
    samples: normalized,
    medians: {
      harnessMaxLateMs: medianNonNegative(harnessMaxLate),
      harnessPendingLateAtEndMs: medianNonNegative(harnessPendingLate),
      floodWorkerMaxLateMs: medianNonNegative(floodWorkerMaxLate),
    },
  }
}

function validTimerWindowSummary(value: unknown): value is TimerWindowSummary {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'reason', 'intervals', 'medianLateMs', 'maxLateMs', 'pendingLateAtEndMs'])) return false
  if (!Number.isSafeInteger(value.intervals) || (value.intervals as number) < 0 || (value.intervals as number) > MAX_TIMER_INTERVALS) return false
  if (value.status === 'unavailable') {
    return isBoundedText(value.reason)
      && value.intervals === 0
      && value.medianLateMs === null
      && value.maxLateMs === null
      && value.pendingLateAtEndMs === null
  }
  if (value.status !== 'complete' || value.reason !== null) return false
  const medianLate = value.medianLateMs
  const maxLate = value.maxLateMs
  const pending = value.pendingLateAtEndMs
  if (pending !== null && (typeof pending !== 'number' || !Number.isFinite(pending) || pending < 0)) return false
  if (value.intervals === 0) return medianLate === null && maxLate === null
  return typeof medianLate === 'number' && Number.isFinite(medianLate) && medianLate >= 0
    && typeof maxLate === 'number' && Number.isFinite(maxLate) && maxLate >= medianLate
}

function validEchoTimingSummary(value: unknown, wallSamples: readonly number[]): value is EchoTimingSummary {
  if (!isRecord(value)
    || !hasExactKeys(value, ['samples', 'completeSamples', 'unavailableSamples', 'medians'])
    || !Array.isArray(value.samples)
    || value.samples.length !== wallSamples.length) return false
  for (let index = 0; index < value.samples.length; index += 1) {
    const sample = value.samples[index]
    const wall = wallSamples[index]
    if (wall === undefined || !validEchoTimingShape(sample)) return false
    if (sample.status === 'complete'
      && !approximatelyEqual(sample.keystrokeToWorkerMs + sample.workerToPageMs + sample.pageToPaintMs, wall)) return false
  }
  return sameValue(value, summarizeEchoTiming(value.samples as EchoTiming[]))
}

function validSchedulerSummary(value: unknown, metric: 'echo' | 'floodEcho', sampleCount: number): value is SchedulerSummary {
  if (!isRecord(value)
    || !hasExactKeys(value, ['samples', 'medians'])
    || !Array.isArray(value.samples)
    || value.samples.length !== sampleCount) return false
  for (const sample of value.samples) {
    if (!isRecord(sample) || !hasExactKeys(sample, ['harness', 'floodWorker'])
      || !validTimerWindowSummary(sample.harness)) return false
    if (metric === 'echo' ? sample.floodWorker !== null : !validTimerWindowSummary(sample.floodWorker)) return false
    if (sample.floodWorker !== null
      && (!validTimerWindowSummary(sample.floodWorker) || sample.floodWorker.pendingLateAtEndMs !== null)) return false
  }
  return sameSchedulerMedians(value)
}
function validProfile(value: unknown): value is SpeedProfile {
  if (!isRecord(value)) return false
  const keys = value.workloadVersion === 1
    ? PROFILE_KEYS
    : value.workloadVersion === 2 ? PROFILE_V2_KEYS
      : value.workloadVersion === 3 ? PROFILE_V3_KEYS
        : value.workloadVersion === 4 ? PROFILE_V4_KEYS : null
  if (!keys || !hasExactKeys(value, keys)) return false
  const viewport = value.viewport
  const validBase = value.worktrees === 10
    && value.terminals === 20
    && value.diffAddedLines === 5000
    && value.renderer === 'dom'
    && isRecord(viewport)
    && hasExactKeys(viewport, ['width', 'height'])
    && viewport.width === 1400
    && viewport.height === 880
    && value.startup === 'daemon-restart-persistent-pty-fresh-context'
    && value.floodChunkBytes === 65536
    && value.floodIntervalMs === 16
    && isBoundedText(value.runner)
    && isBoundedText(value.os)
    && isBoundedText(value.arch)
    && isBoundedText(value.cpuModel)
    && Number.isSafeInteger(value.cpuCount)
    && (value.cpuCount as number) > 0
    && isBoundedText(value.bun)
    && isBoundedText(value.chromium)
    && isBoundedText(value.imageVersion)
  if (!validBase) return false
  if (value.workloadVersion === 1) return true
  if (value.compositor !== 'software') return false
  if (value.workloadVersion === 2) return true
  return value.workloadVersion === 3
    ? value.frameTiming === FRAME_TIMING_MODE
    : value.frameTiming === FRAME_TIMING_V4_MODE && value.runnerPolicy === RUNNER_POLICY_V4
}

function sameSchedulerMedians(value: Record<string, unknown>): boolean {
  const samples = value.samples as Array<Record<string, unknown>>
  const harnessMaxLate = samples
    .map((sample) => {
      const window = sample.harness as Record<string, unknown>
      return window.status === 'complete' ? window.maxLateMs : null
    })
    .filter((late): late is number => typeof late === 'number')
  const harnessPendingLate = samples
    .map((sample) => {
      const window = sample.harness as Record<string, unknown>
      return window.status === 'complete' ? window.pendingLateAtEndMs : null
    })
    .filter((late): late is number => typeof late === 'number')
  const floodWorkerMaxLate = samples
    .map((sample) => {
      const window = sample.floodWorker as Record<string, unknown> | null
      return window?.status === 'complete' ? window.maxLateMs : null
    })
    .filter((late): late is number => typeof late === 'number')
  return sameValue(value.medians, {
    harnessMaxLateMs: medianNonNegative(harnessMaxLate),
    harnessPendingLateAtEndMs: medianNonNegative(harnessPendingLate),
    floodWorkerMaxLateMs: medianNonNegative(floodWorkerMaxLate),
  })
}

function validRunnerSetting(value: unknown, requested: 0 | 1): value is RunnerSetting {
  if (!isRecord(value) || !hasExactKeys(value, ['requested', 'before', 'after', 'status', 'errors'])
    || value.requested !== requested
    || ![value.before, value.after].every((reading) => reading === null || reading === 0 || reading === 1)
    || !Array.isArray(value.errors) || value.errors.length > 8
    || !value.errors.every((error) => isBoundedText(error, 512))) return false
  if (value.status === 'applied') return value.after === requested
  if (value.status === 'set-failed') return value.errors.length > 0
  if (value.status === 'not-applied') return value.after !== null && value.after !== requested
  if (value.status === 'readback-unavailable') return value.after === null && value.errors.length > 0
  return false
}

/** Validates runner-settings evidence without importing the OS-command module. */
export function validateRunnerLatency(value: unknown): RunnerLatency | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'runId', 'runner', 'status', 'reason', 'coalescing', 'appNap', 'timerCoalesceBgNsMax',
  ]) || value.version !== 1
    || !(value.runId === null || isBoundedText(value.runId, 128))
    || !isBoundedText(value.runner, 128)
    || !(value.timerCoalesceBgNsMax === null
      || (Number.isSafeInteger(value.timerCoalesceBgNsMax) && (value.timerCoalesceBgNsMax as number) >= 0))) return null
  if (value.status === 'attempted') {
    if (value.runner !== 'macos-15' || value.reason !== null
      || !validRunnerSetting(value.coalescing, 0) || !validRunnerSetting(value.appNap, 1)) return null
  } else if (value.status === 'skipped') {
    if (value.reason !== 'not-github-macos' || value.coalescing !== null || value.appNap !== null || value.timerCoalesceBgNsMax !== null) return null
  } else if (value.status === 'unavailable') {
    if (!isBoundedText(value.reason) || value.coalescing !== null || value.appNap !== null || value.timerCoalesceBgNsMax !== null) return null
  } else return null
  return value as unknown as RunnerLatency
}


function validFailure(value: unknown): value is Failure {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ['kind', 'metric', 'sample', 'message'].includes(key))) return false
  if (!Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'message')) return false
  if (!isBoundedText(value.kind) || !isBoundedText(value.message, 2048)) return false
  if (Object.hasOwn(value, 'metric') && !METRICS.includes(value.metric as Metric)) return false
  if (Object.hasOwn(value, 'sample') && (!Number.isSafeInteger(value.sample) || (value.sample as number) < 0)) return false
  return true
}

function validDurationSamples(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > MAX_PAIR_SAMPLES) return false
  for (let index = 0; index < value.length; index += 1) {
    const sample = value[index]
    if (typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0) return false
  }
  return true
}

export function validatePair(value: unknown): SpeedPair | null {
  if (!isRecord(value) || !hasExactKeys(value, PAIR_KEYS)) return null
  if (value.version !== 1 || !isBoundedText(value.runId, 128) || !isIsoTimestamp(value.createdAt)) return null
  if (value.status !== 'complete' && value.status !== 'incomplete') return null
  if (typeof value.qualified !== 'boolean') return null
  if (!isRecord(value.head) || !hasExactKeys(value.head, ['commit']) || typeof value.head.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(value.head.commit)) return null
  if (!isRecord(value.base) || !hasExactKeys(value.base, ['commit', 'basis'])) return null
  if (typeof value.base.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(value.base.commit)) return null
  if (value.base.basis !== 'merge-base' && value.base.basis !== 'parent') return null
  if (!isRecord(value.metrics) || !hasExactKeys(value.metrics, METRICS)) return null
  const counts = {} as Record<Metric, number>
  for (const metric of METRICS) {
    const result = value.metrics[metric]
    if (!isRecord(result) || !hasExactKeys(result, ['headSamplesMs', 'baseSamplesMs'])) return null
    if (!validDurationSamples(result.headSamplesMs) || !validDurationSamples(result.baseSamplesMs)) return null
    if (value.status === 'complete' && result.headSamplesMs.length !== result.baseSamplesMs.length) return null
    counts[metric] = result.headSamplesMs.length
  }
  if (!Array.isArray(value.failures) || value.failures.length > MAX_FAILURES) return null
  for (let index = 0; index < value.failures.length; index += 1) {
    if (!validFailure(value.failures[index])) return null
  }
  if (value.status === 'complete' && value.failures.length !== 0) return null
  if (value.status === 'incomplete' && value.failures.length === 0) return null
  if (!isRecord(value.evidence) || !hasExactKeys(value.evidence, PAIR_EVIDENCE_KEYS) || !isSafeEvidencePath(value.evidence.samples)) return null
  const expectedQualified = value.status === 'complete' && METRICS.every((metric) => counts[metric] >= PAIR_COUNTS[metric])
  if (value.qualified !== expectedQualified) return null
  return value as unknown as SpeedPair
}

function validReportSamples(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const sample = value[index]
    if (typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0) return false
  }
  return true
}

function validMetricResult(value: unknown, metric: Metric, workloadVersion: number): boolean {
  if (!isRecord(value)) return false
  const version4 = workloadVersion === 4
  const hasWallTiming = workloadVersion === 3 || version4
  if (!hasExactKeys(value, version4 ? METRIC_RESULT_V4_KEYS : hasWallTiming ? METRIC_RESULT_V3_KEYS : METRIC_RESULT_KEYS)) return false
  if (value.budgetMs !== BUDGETS[metric] || !validReportSamples(value.samplesMs)) return false
  const expectedMedian = median(value.samplesMs)
  if (value.medianMs !== expectedMedian) return false
  if (expectedMedian === null ? value.budgetMiss !== null : value.budgetMiss !== (expectedMedian > BUDGETS[metric])) return false
  if (!hasWallTiming) return true
  if (!validReportSamples(value.wallSamplesMs) || value.wallSamplesMs.length !== value.samplesMs.length) return false
  const wallSamples = value.wallSamplesMs
  if (typeof value.unavailableSamples !== 'number' || !Number.isSafeInteger(value.unavailableSamples) || value.unavailableSamples < 0 || value.unavailableSamples > value.samplesMs.length) return false
  let identicalSamples = 0
  for (let index = 0; index < value.samplesMs.length; index += 1) {
    const sample = value.samplesMs[index]
    const wallSample = wallSamples[index]
    if (sample === undefined || wallSample === undefined || sample > wallSample) return false
    if (sample === wallSample) identicalSamples += 1
    if ((metric === 'startup' || metric === 'diff') && sample !== wallSample) return false
  }
  if (value.unavailableSamples > identicalSamples) return false
  if ((metric === 'startup' || metric === 'diff') && value.unavailableSamples !== 0) return false
  if (!version4) return true
  if (metric === 'startup' || metric === 'diff' || metric === 'switch') {
    return value.echoTiming === null && value.scheduler === null
  }
  return validEchoTimingSummary(value.echoTiming, wallSamples)
    && validSchedulerSummary(value.scheduler, metric, wallSamples.length)
}


/** Validates the report shape and all aggregates without discarding partial or smoke evidence. */
export function validateReport(value: unknown): SpeedReport | null {
  if (!isRecord(value)) return null
  const version4 = isRecord(value.profile) && value.profile.workloadVersion === 4
  if (!hasExactKeys(value, version4 ? REPORT_V4_KEYS : REPORT_KEYS)) return null
  if (value.version !== 1 || typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(value.commit)) return null
  if (!isBoundedText(value.runId, 128) || !isIsoTimestamp(value.createdAt)) return null
  if (value.status !== 'complete' && value.status !== 'incomplete') return null
  if (typeof value.qualified !== 'boolean' || !validProfile(value.profile)) return null
  if (version4) {
    const runnerLatency = validateRunnerLatency(value.runnerLatency)
    if (!runnerLatency
      || runnerLatency.runId !== value.runId
      || runnerLatency.runner !== value.profile.runner
      || (runnerLatency.status === 'attempted' && value.profile.runner !== 'macos-15')) return null
  }
  if (value.cleanup !== 'complete' && value.cleanup !== 'failed') return null
  if (value.status === 'complete' && (value.cleanup !== 'complete' || !Array.isArray(value.failures) || value.failures.length !== 0)) return null
  if (value.status === 'incomplete' && value.qualified) return null
  if (!Array.isArray(value.failures) || value.failures.length > MAX_FAILURES || !value.failures.every(validFailure)) return null
  if (value.status === 'incomplete' && value.failures.length === 0) return null
  if (!isRecord(value.evidence) || !hasExactKeys(value.evidence, EVIDENCE_KEYS)) return null
  if (!isSafeEvidencePath(value.evidence.samples) || !isSafeEvidencePath(value.evidence.misses)) return null
  if (!Array.isArray(value.evidence.diagnostics) || value.evidence.diagnostics.length > MAX_EVIDENCE_PATHS || !value.evidence.diagnostics.every(isSafeEvidencePath)) return null
  if (!isRecord(value.metrics) || !hasExactKeys(value.metrics, METRICS)) return null
  const workloadVersion = value.profile.workloadVersion
  for (const metric of METRICS) {
    if (!validMetricResult(value.metrics[metric], metric, workloadVersion)) return null
  }

  const counts = METRICS.map((metric) => (value.metrics as Record<Metric, { samplesMs: unknown[] }>)[metric].samplesMs.length)
  if (value.status === 'complete') {
    const completeCount = counts[0]
    if (completeCount === undefined || completeCount < 1 || counts.some((count) => count !== completeCount)) return null
    if (value.qualified && completeCount < 20) return null
  }
  return value as unknown as SpeedReport
}

function metadata(report: SpeedReport): Comparison['head'] {
  return { commit: report.commit, runId: report.runId, createdAt: report.createdAt }
}

function metricNulls(): Record<Metric, null> {
  return { startup: null, echo: null, switch: null, diff: null, floodEcho: null }
}

function comparisonStatus(
  current: SpeedReport,
  status: 'unavailable' | 'error',
  reason: string,
  baseline: Comparison['baseline'] = null,
): Comparison {
  return {
    status,
    head: metadata(current),
    baseline,
    reason,
    reasons: [reason],
    metrics: metricNulls(),
  }
}

function percentageChange(head: number, base: number): number | null {
  const change = (head / base - 1) * 100
  return Number.isFinite(change) ? change : null
}

export function pairedLowerBoundPercent(head: readonly number[], base: readonly number[]): number | null {
  const count = head.length
  if (count === 0 || count > MAX_PAIR_SAMPLES || count !== base.length) return null
  const differences = new Array<number>(count)
  for (let index = 0; index < count; index += 1) {
    const headSample = head[index]
    const baseSample = base[index]
    if (headSample === undefined || baseSample === undefined
      || !Number.isFinite(headSample) || headSample <= 0
      || !Number.isFinite(baseSample) || baseSample <= 0) return null
    const difference = Math.log(headSample / baseSample)
    if (!Number.isFinite(difference)) return null
    differences[index] = difference
  }
  const criticalIndex = Math.floor(
    count * (count + 1) / 4
      - CONFIDENCE_Z * Math.sqrt(count * (count + 1) * (2 * count + 1) / 24),
  )
  if (criticalIndex < 0) return null
  const walshAverages: number[] = []
  for (let left = 0; left < count; left += 1) {
    for (let right = left; right < count; right += 1) {
      const average = ((differences[left] ?? Number.NaN) + (differences[right] ?? Number.NaN)) / 2
      if (!Number.isFinite(average)) return null
      walshAverages.push(average)
    }
  }
  walshAverages.sort((left, right) => left - right)
  const lowerLogRatio = walshAverages[criticalIndex]
  if (lowerLogRatio === undefined) return null
  const lowerBoundPercent = (Math.exp(lowerLogRatio) - 1) * 100
  return Number.isFinite(lowerBoundPercent) ? lowerBoundPercent : null
}

export function pairedRegression(head: readonly number[], base: readonly number[]): MetricComparison | null {
  if (head.length > MAX_PAIR_SAMPLES || base.length > MAX_PAIR_SAMPLES) return null
  const headMedianMs = median(head)
  const baselineMedianMs = median(base)
  if (headMedianMs === null || baselineMedianMs === null || head.length !== base.length) return null
  const lowerBoundPercent = pairedLowerBoundPercent(head, base)
  const changePercent = percentageChange(headMedianMs, baselineMedianMs)
  if (lowerBoundPercent === null || changePercent === null) return null
  return {
    headMedianMs,
    baselineMedianMs,
    pairs: head.length,
    changePercent,
    lowerBoundPercent,
    regression: headMedianMs > baselineMedianMs * REGRESSION_RATIO && lowerBoundPercent > 0,
  }
}

export function comparePair(current: SpeedReport, pair: SpeedPair | null): Comparison {
  if (!validateReport(current)) {
    const reason = 'current report is malformed'
    return { status: 'error', head: null, baseline: null, reason, reasons: [reason], metrics: metricNulls() }
  }
  if (current.status !== 'complete' || !current.qualified) {
    return comparisonStatus(current, 'error', 'current report is incomplete or unqualified')
  }
  if (pair === null) return comparisonStatus(current, 'unavailable', 'no paired base measurement')
  const validPair = validatePair(pair)
  if (!validPair) return comparisonStatus(current, 'error', 'pair report is malformed')
  const baseline = { commit: validPair.base.commit, basis: validPair.base.basis }
  if (validPair.head.commit !== current.commit) {
    return comparisonStatus(current, 'error', 'pair HEAD does not match the report', baseline)
  }
  if (validPair.runId !== current.runId) {
    return comparisonStatus(current, 'error', 'pair run does not match the report', baseline)
  }
  if (validPair.status === 'incomplete') {
    const failure = validPair.failures[0]!
    return comparisonStatus(current, 'unavailable', `base ${validPair.base.commit.slice(0, 8)} could not be measured: ${failureText(failure)}`, baseline)
  }
  if (!validPair.qualified) {
    return comparisonStatus(current, 'unavailable', 'smoke pair is not a qualifying comparison', baseline)
  }

  const rows = {} as Record<Metric, MetricComparison>
  for (const metric of METRICS) {
    const result = validPair.metrics[metric]
    const row = pairedRegression(result.headSamplesMs, result.baseSamplesMs)
    if (row === null) return comparisonStatus(current, 'error', 'pair report is malformed', baseline)
    rows[metric] = row
  }
  return {
    status: 'compared',
    head: metadata(current),
    baseline,
    reason: null,
    reasons: [],
    metrics: rows,
  }
}

function isSafeComparison(value: Comparison, current: SpeedReport): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'head', 'baseline', 'reason', 'reasons', 'metrics'])) return false
  if (value.status !== 'compared' || !isRecord(value.head) || !hasExactKeys(value.head, ['commit', 'runId', 'createdAt'])) return false
  if (!isRecord(value.baseline) || !hasExactKeys(value.baseline, ['commit', 'basis'])) return false
  if (value.head.commit !== current.commit || value.head.runId !== current.runId || value.head.createdAt !== current.createdAt) return false
  if (typeof value.baseline.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(value.baseline.commit)) return false
  if (value.baseline.basis !== 'merge-base' && value.baseline.basis !== 'parent') return false
  if (value.reason !== null || !Array.isArray(value.reasons) || value.reasons.length !== 0) return false
  if (!isRecord(value.metrics) || !hasExactKeys(value.metrics, METRICS)) return false
  for (const metric of METRICS) {
    const row = value.metrics[metric]
    if (!isRecord(row) || !hasExactKeys(row, ['headMedianMs', 'baselineMedianMs', 'pairs', 'changePercent', 'lowerBoundPercent', 'regression'])) return false
    if (![row.headMedianMs, row.baselineMedianMs, row.changePercent, row.lowerBoundPercent].every((number) => typeof number === 'number' && Number.isFinite(number))) return false
    if ((row.headMedianMs as number) <= 0 || (row.baselineMedianMs as number) <= 0) return false
    if (!Number.isSafeInteger(row.pairs) || (row.pairs as number) < 20 || typeof row.regression !== 'boolean') return false
    const expectedChange = percentageChange(row.headMedianMs as number, row.baselineMedianMs as number)
    if (expectedChange === null || row.changePercent !== expectedChange) return false
    const expectedRegression = (row.headMedianMs as number) > (row.baselineMedianMs as number) * REGRESSION_RATIO
      && (row.lowerBoundPercent as number) > 0
    if (row.regression !== expectedRegression) return false
  }
  return true
}

function escaped(value: string, maxLength = MAX_CELL_CHARS): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|`<>]/g, (character) => `\\${character}`)
    .slice(0, maxLength)
}

function displayNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'not available' : String(value)
}

function v4ObservationRows(report: SpeedReport): string[] {
  const runner = report.runnerLatency
  const lines = ['', `Runner settings experiment (${RUNNER_POLICY_V4}):`]
  if (!runner) {
    lines.push('Runner settings: unavailable')
    return lines
  }
  lines.push(`Runner settings status: ${escaped(runner.status)}${runner.reason ? `; reason ${escaped(runner.reason)}` : ''}; runner ${escaped(runner.runner)}; run ${escaped(runner.runId ?? 'not available')}.`)
  lines.push(
    '',
    '| Setting | Requested | Before | After | Status | Errors |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  )
  for (const [name, setting] of [
    ['kern.timer.coalescing_enabled', runner.coalescing],
    ['NSAppSleepDisabled', runner.appNap],
  ] as const) {
    const errors = setting?.errors.map((error) => escaped(error, 512)).join('; ') || 'none'
    lines.push(`| ${name} | ${setting ? `requested ${setting.requested}` : 'not available'} | ${setting ? `before ${displayNumber(setting.before)}` : 'not available'} | ${setting ? `after ${displayNumber(setting.after)}` : 'not available'} | ${setting ? escaped(setting.status) : 'not available'} | ${errors} |`)
  }
  lines.push(`Coalescing background timer maximum: ${displayNumber(runner.timerCoalesceBgNsMax)} ns.`)

  lines.push(
    '',
    '| Metric | Keystroke to worker (ms) | Worker to page (ms) | Page to paint (ms) | Complete / unavailable splits |',
    '| --- | ---: | ---: | ---: | ---: |',
  )
  for (const metric of ['echo', 'floodEcho'] as const) {
    const summary = report.metrics[metric].echoTiming
    lines.push(summary
      ? `| ${metric} | ${displayNumber(summary.medians.keystrokeToWorkerMs)} | ${displayNumber(summary.medians.workerToPageMs)} | ${displayNumber(summary.medians.pageToPaintMs)} | ${summary.completeSamples} complete / ${summary.unavailableSamples} unavailable |`
      : `| ${metric} | not available | not available | not available | not available |`)
  }
  lines.push(
    '',
    '| Metric | Controller timer max-lateness median (ms) | Controller pending-lateness median (ms) | Flood worker sleep max-lateness median (ms) | Controller windows | Flood worker windows |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  )
  for (const metric of ['echo', 'floodEcho'] as const) {
    const summary = report.metrics[metric].scheduler
    if (!summary) {
      lines.push(`| ${metric} | not available | not available | not available | not available | not available |`)
      continue
    }
    const controllerCounts = summary.samples.reduce((counts, sample) => {
      counts[sample.harness.status] += 1
      return counts
    }, { complete: 0, unavailable: 0 })
    const floodCounts = summary.samples.reduce((counts, sample) => {
      if (sample.floodWorker) counts[sample.floodWorker.status] += 1
      return counts
    }, { complete: 0, unavailable: 0 })
    const controllerWindows = `${controllerCounts.complete} complete / ${controllerCounts.unavailable} unavailable`
    const floodWindows = metric === 'echo' ? 'not applicable' : `${floodCounts.complete} complete / ${floodCounts.unavailable} unavailable`
    lines.push(`| ${metric} | ${displayNumber(summary.medians.harnessMaxLateMs)} | ${displayNumber(summary.medians.harnessPendingLateAtEndMs)} | ${displayNumber(summary.medians.floodWorkerMaxLateMs)} | ${controllerWindows} | ${floodWindows} |`)
  }
  lines.push(
    '',
    'The first two include scheduling. The last includes rendering and frame scheduling. These are not an exact measure of Quirky-only CPU and are not a proven cause of any miss.',
  )
  return lines
}

function currentRows(report: SpeedReport): string[] {
  const version3 = report.profile.workloadVersion === 3 || report.profile.workloadVersion === 4
  const version4 = report.profile.workloadVersion === 4
  const lines = version3
    ? [
        '| Metric | Raw wall median (ms) | Budget median (ms) | Unavailable accounting samples | Samples | Budget (ms) | Budget result |',
        '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
      ]
    : [
        '| Metric | Median (ms) | Samples | Budget (ms) | Budget result |',
        '| --- | ---: | ---: | ---: | --- |',
      ]
  for (const metric of METRICS) {
    const result = report.metrics[metric]
    const value = median(result.samplesMs)
    const budgetMiss = value !== null && value > BUDGETS[metric]
    if (version3) {
      const wallMedian = median(result.wallSamplesMs ?? [])
      lines.push(`| ${metric} | ${displayNumber(wallMedian)} | ${displayNumber(value)} | ${result.unavailableSamples ?? 0} | ${result.samplesMs.length} | ${BUDGETS[metric]} | ${budgetMiss ? 'BUDGET MISS' : value === null ? 'not measured' : 'pass'} |`)
    } else {
      lines.push(`| ${metric} | ${displayNumber(value)} | ${result.samplesMs.length} | ${BUDGETS[metric]} | ${budgetMiss ? 'BUDGET MISS' : value === null ? 'not measured' : 'pass'} |`)
    }
  }
  if (version3) {
    lines.push(
      '',
      'Echo, switch and floodEcho budget values cap only demonstrated final-frame idle wait at 16.667 ms; native wall latency is shown separately. Startup and diff use wall time. Unavailable accounting uses wall time without a deduction.',
    )
  }
  if (version4) lines.push(...v4ObservationRows(report))
  return lines
}

function comparedRows(comparison: Comparison): string[] {
  const isParent = comparison.baseline!.basis === 'parent'
  const lines = [
    isParent
      ? '| Metric | Pairs | Parent median (ms) | This commit median (ms) | Change | Lower bound (95%) | Result |'
      : '| Metric | Pairs | Main median (ms) | PR median (ms) | Change | Lower bound (95%) | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const metric of METRICS) {
    const row = comparison.metrics[metric]!
    const relative = row.regression ? 'REGRESSION' : 'no regression'
    const change = `${row.changePercent >= 0 ? '+' : ''}${row.changePercent.toFixed(1)}%`
    const lowerBound = `${row.lowerBoundPercent >= 0 ? '+' : ''}${row.lowerBoundPercent.toFixed(1)}%`
    lines.push(`| ${metric} | ${row.pairs} | ${row.baselineMedianMs} | ${row.headMedianMs} | ${change} | ${lowerBound} | ${relative} |`)
  }
  return lines
}

function failureText(failure: Failure): string {
  const location = failure.metric ? ` ${failure.metric}${failure.sample === undefined ? '' : ` sample ${failure.sample}`}:` : ''
  return `${failure.kind}${location} ${failure.message}`
}

function missLines(report: SpeedReport, misses: readonly SpeedMiss[]): string[] {
  if (misses.length === 0) return []
  return [
    '',
    `Miss evidence: \`${escaped(report.evidence.misses)}\`.`,
    ...misses.map((miss) => {
      const shownDiagnostics = miss.diagnostics.slice(0, 5)
      const diagnostics = shownDiagnostics.length > 0 ? shownDiagnostics.map((path) => `\`${escaped(path)}\``).join(', ') : 'no diagnostic paths'
      const remaining = miss.diagnostics.length > shownDiagnostics.length ? ` (+${miss.diagnostics.length - shownDiagnostics.length} more)` : ''
      const echoTiming = report.profile.workloadVersion === 4 ? miss.echoTiming : null
      const scheduler = report.profile.workloadVersion === 4 ? miss.scheduler : null
      const timing = echoTiming
        ? `; phase medians (ms): Keystroke to worker ${displayNumber(echoTiming.medians.keystrokeToWorkerMs)}, Worker to page ${displayNumber(echoTiming.medians.workerToPageMs)}, Page to paint ${displayNumber(echoTiming.medians.pageToPaintMs)}; ${echoTiming.completeSamples} complete / ${echoTiming.unavailableSamples} unavailable`
        : ''
      const scheduling = scheduler
        ? `; Controller timer max-lateness median ${displayNumber(scheduler.medians.harnessMaxLateMs)} ms; Flood worker sleep max-lateness median ${displayNumber(scheduler.medians.floodWorkerMaxLateMs)} ms`
        : ''
      return `- ${miss.metric}: ${miss.medianMs} ms over ${miss.budgetMs} ms; samples \`${escaped(miss.samples)}\`; diagnostics ${diagnostics}${remaining}; ${escaped(miss.finding, 2048)}${timing}${scheduling}`
    }),
  ]
}

function boundedMarkdown(lines: string[]): string {
  const result: string[] = []
  let length = 0
  for (const line of lines) {
    const added = line.length + (result.length === 0 ? 0 : 1)
    if (length + added > MAX_MARKDOWN_CHARS) {
      result.push('Evidence output truncated.')
      break
    }
    result.push(line)
    length += added
  }
  return `${result.join('\n')}\n`
}

/** Renders bounded advisory Markdown without turning absent or invalid evidence into a pass. */
export function renderSpeed(current: SpeedReport | null, comparison?: Comparison | null, misses?: SpeedMiss[]): string {
  const lines = ['### Speed', '']
  const comparisonReason = comparison?.reason ?? comparison?.reasons?.[0] ?? null
  if (current === null) {
    lines.push(`not measured: ${escaped(comparison?.status === 'error' ? comparisonReason ?? 'speed evidence could not be read' : 'no usable speed report')}`)
    return boundedMarkdown(lines)
  }
  if (!validateReport(current)) {
    lines.push('not measured: current speed report is malformed')
    return boundedMarkdown(lines)
  }
  const fallbackMisses = calculatedMisses(current)
  const selectedMisses = misses === undefined ? fallbackMisses : validateMissesAgainstReport(misses, current, fallbackMisses) ?? fallbackMisses
  if (current.status === 'incomplete') {
    const failure = current.failures[0]
    lines.push(`not measured: ${escaped(failure ? failureText(failure) : 'benchmark run incomplete')}`, '')
    lines.push(...currentRows(current), ...missLines(current, selectedMisses))
    return boundedMarkdown(lines)
  }
  if (!current.qualified) {
    lines.push('not measured: smoke report is unqualified', '')
    lines.push(...currentRows(current), ...missLines(current, selectedMisses))
    return boundedMarkdown(lines)
  }

  if (comparison?.status === 'error') {
    lines.push(`not measured: ${escaped(comparisonReason ?? 'comparison evidence could not be read')}`, '')
    lines.push(...currentRows(current), ...missLines(current, selectedMisses))
    return boundedMarkdown(lines)
  }
  if (comparison?.status === 'compared') {
    if (!isSafeComparison(comparison, current)) {
      lines.push('not measured: comparison data is malformed', '')
      lines.push(...currentRows(current), ...missLines(current, selectedMisses))
      return boundedMarkdown(lines)
    }
    const head = comparison.head!
    const baseline = comparison.baseline!
    const comparedLine = baseline.basis === 'parent'
      ? `Compared main \`${head.commit}\` with its parent \`${baseline.commit}\`, interleaved on one runner (run \`${escaped(head.runId)}\`).`
      : `Compared PR \`${head.commit}\` with main at its merge base \`${baseline.commit}\`, interleaved on one runner (run \`${escaped(head.runId)}\`).`
    lines.push(comparedLine, '', ...comparedRows(comparison))
    lines.push(
      'REGRESSION means the median is more than 25% slower and the lower end of the 95% confidence interval is above zero.',
      '',
      'Absolute results for this commit:',
      '',
      ...currentRows(current),
      ...missLines(current, selectedMisses),
    )
    return boundedMarkdown(lines)
  }

  const reason = comparisonReason ?? 'no paired base measurement'
  lines.push(`not compared: ${escaped(reason)}`, `Commit \`${current.commit}\` (run \`${escaped(current.runId)}\`).`, '')
  lines.push(...currentRows(current), ...missLines(current, selectedMisses))
  return boundedMarkdown(lines)
}

/** Derives the expected miss records from an already validated report. */
function calculatedMisses(report: SpeedReport): SpeedMiss[] {
  if (report.status !== 'complete') return []
  const version4 = report.profile.workloadVersion === 4
  const misses: SpeedMiss[] = []
  for (const metric of METRICS) {
    const medianMs = median(report.metrics[metric].samplesMs)
    if (medianMs === null || medianMs <= BUDGETS[metric]) continue
    const diagnostics = report.evidence.diagnostics.filter((path) => path.endsWith(`/${metric}.json`))
    const base = {
      metric,
      budgetMs: BUDGETS[metric],
      medianMs,
      commit: report.commit,
      runId: report.runId,
      samples: report.evidence.samples,
      diagnostics,
      finding: diagnostics.length > 0
        ? `Diagnosis unavailable; recorded diagnostic paths: ${diagnostics.join(', ')}.`
        : 'Diagnosis unavailable: no diagnostic paths were recorded.',
    }
    if (version4) {
      misses.push({
        ...base,
        echoTiming: report.metrics[metric].echoTiming ?? null,
        scheduler: report.metrics[metric].scheduler ?? null,
      })
    } else {
      misses.push(base)
    }
  }
  return misses
}

/** Creates evidence references only for completed metrics whose recomputed median exceeds its fixed budget. */
export function createMisses(report: SpeedReport): SpeedMiss[] {
  if (!validateReport(report)) return []
  return calculatedMisses(report)
}

function validateMissesAgainstReport(value: unknown, report: SpeedReport, expected: SpeedMiss[]): SpeedMiss[] | null {
  if (!Array.isArray(value) || value.length !== expected.length) return null
  const version4 = report.profile.workloadVersion === 4
  const keys = ['metric', 'budgetMs', 'medianMs', 'commit', 'runId', 'samples', 'diagnostics', 'finding']
  if (version4) keys.push('echoTiming', 'scheduler')
  const validated: SpeedMiss[] = []
  for (let index = 0; index < value.length; index++) {
    const candidate = value[index]
    const miss = expected[index]
    if (!miss || !isRecord(candidate) || !hasExactKeys(candidate, keys)) return null
    if (candidate.metric !== miss.metric
      || candidate.budgetMs !== miss.budgetMs
      || candidate.medianMs !== miss.medianMs
      || candidate.commit !== report.commit
      || candidate.runId !== report.runId
      || candidate.samples !== report.evidence.samples
      || !isSafeEvidencePath(candidate.samples)
      || !Array.isArray(candidate.diagnostics)
      || !candidate.diagnostics.every(isSafeEvidencePath)
      || candidate.diagnostics.length !== miss.diagnostics.length
      || candidate.diagnostics.some((path, pathIndex) => path !== miss.diagnostics[pathIndex])
      || !isBoundedText(candidate.finding, 2048)
      || (version4 && (!sameValue(candidate.echoTiming, miss.echoTiming) || !sameValue(candidate.scheduler, miss.scheduler)))) return null
    validated.push(candidate as unknown as SpeedMiss)
  }
  return validated
}

/** Validates serialized miss evidence against a report and its metric-specific paths. */
export function validateMisses(value: unknown, report: SpeedReport): SpeedMiss[] | null {
  if (!validateReport(report)) return null
  return validateMissesAgainstReport(value, report, calculatedMisses(report))
}
