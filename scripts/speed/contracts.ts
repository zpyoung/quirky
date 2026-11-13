export const METRICS = ['startup', 'echo', 'switch', 'diff', 'floodEcho'] as const
export type Metric = (typeof METRICS)[number]

export const BUDGETS = {
  startup: 3000,
  echo: 50,
  switch: 200,
  diff: 1000,
  floodEcho: 100,
} as const satisfies Readonly<Record<Metric, number>>

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
}

export type SpeedProfile = {
  workloadVersion: 1
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
}

export type MetricComparison = {
  headMedianMs: number
  baselineMedianMs: number
  headSamples: number
  baselineSamples: number
  changePercent: number
  budgetMs: number
  budgetMiss: boolean
  baselineBudgetMiss: boolean
  regression: boolean
}

export type Comparison = {
  status: 'compared' | 'unavailable' | 'error'
  head: { commit: string; runId: string; createdAt: string } | null
  baseline: { commit: string; runId: string; createdAt: string; ageMs: number } | null
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
}
