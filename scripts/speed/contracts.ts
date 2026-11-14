export const METRICS = ['startup', 'echo', 'switch', 'diff', 'floodEcho'] as const
export type Metric = (typeof METRICS)[number]

export const BUDGETS = {
  startup: 3000,
  echo: 50,
  switch: 200,
  diff: 1000,
  floodEcho: 100,
} as const satisfies Readonly<Record<Metric, number>>
export const NOMINAL_FRAME_MS = 1000 / 60
export type EchoTiming =
  | {
      status: 'complete'
      reason: null
      workerReadEpochMs: number
      pageTimeOriginMs: number
      receivedAt: number
      keystrokeToWorkerMs: number
      workerToPageMs: number
      pageToPaintMs: number
    }
  | {
      status: 'unavailable'
      reason: string
      workerReadEpochMs: number | null
      pageTimeOriginMs: number | null
      receivedAt: number | null
      keystrokeToWorkerMs: null
      workerToPageMs: null
      pageToPaintMs: null
    }

export type TimerInterval = {
  requestedEpochMs: number
  dueEpochMs: number
  wokeEpochMs: number
  lateMs: number
}

export type TimerWindow = {
  status: 'complete' | 'unavailable'
  reason: string | null
  intervals: TimerInterval[]
  pendingLateAtEndMs: number | null
}

export type SampleScheduler = { harness: TimerWindow; floodWorker: TimerWindow | null }

export type EchoTimingSummary = {
  samples: EchoTiming[]
  completeSamples: number
  unavailableSamples: number
  medians: {
    keystrokeToWorkerMs: number | null
    workerToPageMs: number | null
    pageToPaintMs: number | null
  }
}

export type TimerWindowSummary = {
  status: 'complete' | 'unavailable'
  reason: string | null
  intervals: number
  medianLateMs: number | null
  maxLateMs: number | null
  pendingLateAtEndMs: number | null
}

export type SchedulerSummary = {
  samples: { harness: TimerWindowSummary; floodWorker: TimerWindowSummary | null }[]
  medians: {
    harnessMaxLateMs: number | null
    harnessPendingLateAtEndMs: number | null
    floodWorkerMaxLateMs: number | null
  }
}

export type RunnerSetting = {
  requested: 0 | 1
  before: number | null
  after: number | null
  status: 'applied' | 'set-failed' | 'not-applied' | 'readback-unavailable'
  errors: string[]
}

export type RunnerLatency = {
  version: 1
  runId: string | null
  runner: string
  status: 'attempted' | 'skipped' | 'unavailable'
  reason: string | null
  coalescing: RunnerSetting | null
  appNap: RunnerSetting | null
  timerCoalesceBgNsMax: number | null
}

export type FloodSleepCapture = {
  version: 1
  workerId: string
  sessionId: string
  runId: string
  status: 'complete' | 'unavailable'
  reason: string | null
  intervals: TimerInterval[]
}




export const REGRESSION_RATIO = 1.25
export const CONFIDENCE_Z = 1.96
export const PAIR_COUNTS = { startup: 20, echo: 60, switch: 60, diff: 20, floodEcho: 60 } as const satisfies Readonly<Record<Metric, number>>

export type Failure = {
  kind: string
  metric?: Metric
  sample?: number
  message: string
}

export type MetricResult = {
  samplesMs: number[]
  medianMs: number | null
  budgetMs: number
  budgetMiss: boolean | null
  wallSamplesMs?: number[]
  unavailableSamples?: number
  echoTiming?: EchoTimingSummary | null
  scheduler?: SchedulerSummary | null
}

export type FrameTiming = {
  status: 'complete' | 'unavailable'
  wallMs: number
  effectiveMs: number
  deductionMs: number
  candidate: null | {
    kind: 'application-raf' | 'ready-to-frame'
    requestedAt: number
    deliveredAt: number
    receiveCapAt: number | null
    busySpans: { start: number; end: number }[]
  }
  reason: string | null
}

type SpeedProfileBase = {
  worktrees: 10
  terminals: 20
  diffAddedLines: 5000
  renderer: 'dom'
  viewport: { width: 1400; height: 880 }
  startup: 'daemon-restart-persistent-pty-fresh-context'
  floodChunkBytes: 65536
  floodIntervalMs: 16
  runner: string
  os: string
  arch: string
  cpuModel: string
  cpuCount: number
  bun: string
  chromium: string
  imageVersion: string
}

export type SpeedProfileV1 = SpeedProfileBase & { workloadVersion: 1 }
export type SpeedProfileV2 = SpeedProfileBase & { workloadVersion: 2; compositor: 'software' }
export type SpeedProfileV3 = SpeedProfileBase & {
  workloadVersion: 3
  compositor: 'software'
  frameTiming: 'native-final-frame-idle-cap-60hz'
}
export type SpeedProfileV4 = SpeedProfileBase & {
  workloadVersion: 4
  compositor: 'software'
  frameTiming: 'native-final-frame-echo-arrival-cap-60hz'
  runnerPolicy: 'ci-macos-timer-experiment-v1'
}
export type SpeedProfile = SpeedProfileV1 | SpeedProfileV2 | SpeedProfileV3 | SpeedProfileV4

export type SpeedReport = {
  version: 1
  commit: string
  runId: string
  createdAt: string
  status: 'complete' | 'incomplete'
  qualified: boolean
  profile: SpeedProfile
  metrics: Record<Metric, MetricResult>
  failures: Failure[]
  cleanup: 'complete' | 'failed'
  evidence: { samples: string; diagnostics: string[]; misses: string }
  runnerLatency?: RunnerLatency
}
export type MetricResultV4 = MetricResult & {
  wallSamplesMs: number[]
  unavailableSamples: number
  echoTiming: EchoTimingSummary | null
  scheduler: SchedulerSummary | null
}

export type SpeedReportV4 = Omit<SpeedReport, 'profile' | 'metrics' | 'runnerLatency'> & {
  profile: SpeedProfileV4
  metrics: Record<Metric, MetricResultV4>
  runnerLatency: RunnerLatency
}


export type PairSide = 'head' | 'base'
export type PairBasis = 'merge-base' | 'parent'

export type SpeedPair = {
  version: 1
  runId: string
  createdAt: string
  status: 'complete' | 'incomplete'
  qualified: boolean
  head: { commit: string }
  base: { commit: string; basis: PairBasis }
  metrics: Record<Metric, { headSamplesMs: number[]; baseSamplesMs: number[] }>
  failures: Failure[]
  evidence: { samples: string }
}

export type MetricComparison = {
  headMedianMs: number
  baselineMedianMs: number
  pairs: number
  changePercent: number
  lowerBoundPercent: number
  regression: boolean
}

export type Comparison = {
  status: 'compared' | 'unavailable' | 'error'
  head: { commit: string; runId: string; createdAt: string } | null
  baseline: { commit: string; basis: PairBasis } | null
  reason: string | null
  reasons: string[]
  metrics: Record<Metric, MetricComparison | null>
}

export type SpeedMiss = {
  metric: Metric
  budgetMs: number
  medianMs: number
  commit: string
  runId: string
  samples: string
  diagnostics: string[]
  finding: string
  echoTiming?: EchoTimingSummary | null
  scheduler?: SchedulerSummary | null
}

export type SpeedMissV4 = Omit<SpeedMiss, 'echoTiming' | 'scheduler'> & {
  echoTiming: EchoTimingSummary | null
  scheduler: SchedulerSummary | null
}
