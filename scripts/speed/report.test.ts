import { describe, expect, test } from 'bun:test'
import { BUDGETS, METRICS, PAIR_COUNTS, type Comparison, type Failure, type Metric, type MetricResult, type PairBasis, type SpeedPair, type SpeedReport } from './contracts'
import { comparePair, createMisses, median, pairedLowerBoundPercent, pairedRegression, renderSpeed, validateMisses, validatePair, validateReport } from './report'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const METRIC_LIST: Metric[] = [...METRICS]

function report(options: {
  commit?: string
  createdAt?: string
  status?: SpeedReport['status']
  qualified?: boolean
  samples?: Partial<Record<Metric, number[]>>
  failures?: SpeedReport['failures']
  diagnostics?: string[]
} = {}): SpeedReport {
  const metrics = Object.fromEntries(METRIC_LIST.map((metric) => {
    const samplesMs = options.samples?.[metric] ?? Array(20).fill(1)
    const medianMs = median(samplesMs)
    const result: MetricResult = {
      samplesMs,
      medianMs,
      budgetMs: BUDGETS[metric],
      budgetMiss: medianMs === null ? null : medianMs > BUDGETS[metric],
    }
    return [metric, result]
  })) as Record<Metric, MetricResult>
  return {
    version: 1,
    commit: options.commit ?? SHA_A,
    runId: 'run-123',
    createdAt: options.createdAt ?? '2026-11-12T12:00:00.000Z',
    status: options.status ?? 'complete',
    qualified: options.qualified ?? true,
    profile: {
      workloadVersion: 1,
      worktrees: 10,
      terminals: 20,
      diffAddedLines: 5000,
      renderer: 'dom',
      viewport: { width: 1400, height: 880 },
      startup: 'daemon-restart-persistent-pty-fresh-context',
      floodChunkBytes: 65536,
      floodIntervalMs: 16,
      runner: 'macos-15',
      os: 'macOS 15.6',
      arch: 'arm64',
      cpuModel: 'Apple M3',
      cpuCount: 8,
      bun: '1.3.1',
      chromium: 'Chromium 140.0',
      imageVersion: '20261101.1',
    },
    metrics,
    failures: options.failures ?? [],
    cleanup: 'complete',
    evidence: {
      samples: 'samples.jsonl',
      diagnostics: options.diagnostics ?? ['diagnostics/echo.json'],
      misses: 'misses.json',
    },
  }
}
function version3Report(options: {
  samples?: Partial<Record<Metric, number[]>>
  wallSamples?: Partial<Record<Metric, number[]>>
  unavailableSamples?: Partial<Record<Metric, number>>
} = {}): SpeedReport {
  const value = structuredClone(report({ samples: options.samples })) as unknown as {
    profile: Record<string, unknown>
    metrics: Record<Metric, { samplesMs: number[]; [key: string]: unknown }>
  }
  Object.assign(value.profile, {
    workloadVersion: 3,
    compositor: 'software',
    frameTiming: 'native-final-frame-idle-cap-60hz',
  })
  for (const metric of METRICS) {
    const result = value.metrics[metric]
    result.wallSamplesMs = options.wallSamples?.[metric] ?? [...result.samplesMs]
    result.unavailableSamples = options.unavailableSamples?.[metric] ?? 0
  }
  return value as unknown as SpeedReport
}

function mutableProfile(value: SpeedReport): Record<string, unknown> {
  const mutable = value as unknown as { profile: Record<string, unknown> }
  return mutable.profile
}

function mutableMetric(value: SpeedReport, metric: Metric): Record<string, unknown> {
  const mutable = value as unknown as { metrics: Record<Metric, Record<string, unknown>> }
  return mutable.metrics[metric]
}

function setEffectiveSamples(value: SpeedReport, metric: Metric, samples: number[]): void {
  const result = mutableMetric(value, metric)
  const medianMs = median(samples)
  result.samplesMs = samples
  result.medianMs = medianMs
  result.budgetMiss = medianMs === null ? null : medianMs > BUDGETS[metric]
}


function pair(options: {
  status?: SpeedPair['status']
  qualified?: boolean
  runId?: string
  headCommit?: string
  baseCommit?: string
  basis?: PairBasis
  scale?: number
  counts?: Partial<Record<Metric, number>>
  metrics?: Partial<Record<Metric, { headSamplesMs?: number[]; baseSamplesMs?: number[] }>>
  failures?: Failure[]
} = {}): SpeedPair {
  const metrics = Object.fromEntries(METRICS.map((metric) => {
    const count = options.counts?.[metric] ?? PAIR_COUNTS[metric]
    const baseSamplesMs = options.metrics?.[metric]?.baseSamplesMs ?? Array.from({ length: count }, (_, index) => 100 + index % 20)
    const headSamplesMs = options.metrics?.[metric]?.headSamplesMs ?? baseSamplesMs.map((sample) => sample * (options.scale ?? 1))
    return [metric, { headSamplesMs, baseSamplesMs }]
  })) as SpeedPair['metrics']
  const status = options.status ?? 'complete'
  const qualified = options.qualified ?? (
    status === 'complete' && METRICS.every((metric) => metrics[metric].headSamplesMs.length >= PAIR_COUNTS[metric])
  )
  return {
    version: 1,
    runId: options.runId ?? 'run-123',
    createdAt: '2026-11-12T12:00:00.000Z',
    status,
    qualified,
    head: { commit: options.headCommit ?? SHA_A },
    base: { commit: options.baseCommit ?? SHA_B, basis: options.basis ?? 'merge-base' },
    metrics,
    failures: options.failures ?? (status === 'complete' ? [] : [{ kind: 'pair-setup-failed', message: 'base failed' }]),
    evidence: { samples: 'pair-samples.jsonl' },
  }
}

function emptyComparison(status: 'error' | 'unavailable', reason: string): Comparison {
  return {
    status,
    head: null,
    baseline: null,
    reason,
    reasons: [reason],
    metrics: Object.fromEntries(METRICS.map((metric) => [metric, null])) as Record<Metric, null>,
  }
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function replayCounts(runs: { samplesMs: Record<Metric, number[]> }[], scale: number) {
  const rand = mulberry32(1)
  const flagged = { startup: 0, echo: 0, switch: 0, diff: 0, floodEcho: 0, any: 0 }
  for (const run of runs) {
    for (let trial = 0; trial < 50; trial += 1) {
      let any = false
      for (const metric of METRICS) {
        const samples = run.samplesMs[metric]
        const count = PAIR_COUNTS[metric]
        const baseSamples = Array.from({ length: count }, () => samples[Math.floor(rand() * samples.length)]!)
        const headSamples = Array.from({ length: count }, () => samples[Math.floor(rand() * samples.length)]! * scale)
        if (pairedRegression(headSamples, baseSamples)?.regression) {
          flagged[metric] += 1
          any = true
        }
      }
      if (any) flagged.any += 1
    }
  }
  return flagged
}

describe('median', () => {
  test('averages the middle pair of all twenty samples without rounding', () => {
    expect(median(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(10.5)
  })

  test('returns the middle item for odd-length input and null for no samples', () => {
    expect(median([9, 1, 5])).toBe(5)
    expect(median([])).toBeNull()
  })

  test('rejects zero and non-finite durations', () => {
    expect(median([0])).toBeNull()
    expect(median([Number.NaN])).toBeNull()
    expect(median([Number.POSITIVE_INFINITY])).toBeNull()
  })
})

describe('report validation', () => {
  test('accepts a complete qualified report with the fixed workload and budgets', () => {
    const value = report()
    expect(validateReport(value)).toEqual(value)
    expect(METRICS).toEqual(['startup', 'echo', 'switch', 'diff', 'floodEcho'])
    expect(BUDGETS).toEqual({ startup: 3000, echo: 50, switch: 200, diff: 1000, floodEcho: 100 })
  })

  test('rejects a qualified complete report with only nineteen samples', () => {
    const value = report({ samples: { echo: Array(19).fill(20) } })
    expect(validateReport(value)).toBeNull()
  })


  test('rejects a complete unqualified report with no samples', () => {
    const empty = Object.fromEntries(METRIC_LIST.map((metric) => [metric, []])) as Partial<Record<Metric, number[]>>
    const value = report({ qualified: false, samples: empty })
    expect(validateReport(value)).toBeNull()
  })

  test('requires matching counts for complete reports but accepts uneven partial counts', () => {
    const unevenComplete = report({ samples: { echo: Array(21).fill(2) } })
    const unevenPartial = report({
      status: 'incomplete',
      qualified: false,
      samples: { startup: [3], echo: [5, 6], switch: [], diff: [8], floodEcho: [] },
      failures: [{ kind: 'timeout', metric: 'switch', sample: 1, message: 'switch timed out' }],
    })
    expect(validateReport(unevenComplete)).toBeNull()
    expect(validateReport(unevenPartial)).toEqual(unevenPartial)
  })

  test('accepts structurally valid partial and smoke reports without qualifying them', () => {
    const partial = report({
      status: 'incomplete',
      qualified: false,
      samples: { startup: [7], echo: [] },
      failures: [{ kind: 'timeout', metric: 'echo', sample: 2, message: 'echo timed out' }],
    })
    const smoke = report({ qualified: false, samples: Object.fromEntries(METRIC_LIST.map((metric) => [metric, [5]])) })
    expect(validateReport(partial)).toEqual(partial)
    expect(validateReport(smoke)).toEqual(smoke)
    for (const current of [partial, smoke]) {
      expect(comparePair(current, pair())).toMatchObject({
        status: 'error', reason: 'current report is incomplete or unqualified',
      })
    }
  })

  test('rejects invalid durations, tampered medians, and inconsistent budget flags', () => {
    for (const invalid of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const value = report({ samples: { echo: [invalid] } })
      expect(validateReport(value)).toBeNull()
    }
    const changedMedian = report()
    changedMedian.metrics.echo.medianMs = 2
    expect(validateReport(changedMedian)).toBeNull()
    const changedFlag = report({ samples: { echo: Array(20).fill(51) } })
    changedFlag.metrics.echo.budgetMiss = false
    expect(validateReport(changedFlag)).toBeNull()
  })

  test('rejects missing metrics and altered fixed workload counts', () => {
    const missing = report() as unknown as Record<string, unknown>
    const { echo: _echo, ...metrics } = missing.metrics as Record<string, unknown>
    missing.metrics = metrics
    expect(validateReport(missing)).toBeNull()

    const wrongWorktrees = report()
    wrongWorktrees.profile.worktrees = 9 as 10
    expect(validateReport(wrongWorktrees)).toBeNull()
  })

  test('rejects unsupported versions and invalid report identity', () => {
    const wrongVersion = { ...report(), version: 2 }
    expect(validateReport(wrongVersion)).toBeNull()
    const wrongCommit = { ...report(), commit: 'not-a-commit' }
    expect(validateReport(wrongCommit)).toBeNull()
  })

  test('accepts software workload version 2 while rejecting mixed profile shapes', () => {
    const v1 = report()
    const v2: SpeedReport = {
      ...v1,
      profile: { ...v1.profile, workloadVersion: 2, compositor: 'software' },
    }
    expect(validateReport(v1)).toEqual(v1)
    expect(validateReport(v2)).toEqual(v2)

    const withoutCompositor = {
      ...v2,
      profile: Object.fromEntries(Object.entries(v2.profile).filter(([key]) => key !== 'compositor')),
    }
    const v1WithCompositor = {
      ...v1,
      profile: { ...v1.profile, compositor: 'software' },
    }
    expect(validateReport(withoutCompositor)).toBeNull()
    expect(validateReport(v1WithCompositor)).toBeNull()
  })
  test('accepts a strict v3 report with raw and effective samples', () => {
    const value = version3Report({
      samples: { echo: Array(20).fill(45) },
      wallSamples: { echo: Array(20).fill(80) },
    })
    expect(validateReport(value)).toEqual(value)
  })

  test('rejects malformed v3 clocks, counters, and frame timing modes', () => {
    const invalid: SpeedReport[] = []

    const missingWallSamples = version3Report()
    delete mutableMetric(missingWallSamples, 'echo').wallSamplesMs
    invalid.push(missingWallSamples)

    const missingUnavailableCount = version3Report()
    delete mutableMetric(missingUnavailableCount, 'echo').unavailableSamples
    invalid.push(missingUnavailableCount)

    const unequalArrays = version3Report()
    mutableMetric(unequalArrays, 'echo').wallSamplesMs = [1]
    invalid.push(unequalArrays)

    const nonFiniteWallSample = version3Report()
    mutableMetric(nonFiniteWallSample, 'echo').wallSamplesMs = [Number.NaN, ...Array(19).fill(1)]
    invalid.push(nonFiniteWallSample)

    const nonPositiveWallSample = version3Report()
    mutableMetric(nonPositiveWallSample, 'echo').wallSamplesMs = [0, ...Array(19).fill(1)]
    invalid.push(nonPositiveWallSample)

    const nonFiniteEffectiveSample = version3Report()
    setEffectiveSamples(nonFiniteEffectiveSample, 'echo', [Number.POSITIVE_INFINITY, ...Array(19).fill(1)])
    invalid.push(nonFiniteEffectiveSample)

    const nonPositiveEffectiveSample = version3Report()
    setEffectiveSamples(nonPositiveEffectiveSample, 'echo', [0, ...Array(19).fill(1)])
    invalid.push(nonPositiveEffectiveSample)

    const effectiveExceedsWall = version3Report({
      samples: { echo: Array(20).fill(80) },
      wallSamples: { echo: Array(20).fill(80) },
    })
    setEffectiveSamples(effectiveExceedsWall, 'echo', Array(20).fill(81))
    invalid.push(effectiveExceedsWall)

    const differentStartupClocks = version3Report({
      wallSamples: { startup: [2, ...Array(19).fill(1)] },
    })
    invalid.push(differentStartupClocks)

    const differentDiffClocks = version3Report({
      wallSamples: { diff: [2, ...Array(19).fill(1)] },
    })
    invalid.push(differentDiffClocks)

    for (const unavailableSamples of [-1, 0.5, 21]) {
      invalid.push(version3Report({ unavailableSamples: { echo: unavailableSamples } }))
    }

    invalid.push(version3Report({ unavailableSamples: { startup: 1 } }))
    invalid.push(version3Report({ unavailableSamples: { diff: 1 } }))

    const wrongFrameTiming = version3Report()
    mutableProfile(wrongFrameTiming).frameTiming = 'native'
    invalid.push(wrongFrameTiming)

    const missingFrameTiming = version3Report()
    delete mutableProfile(missingFrameTiming).frameTiming
    invalid.push(missingFrameTiming)

    const missingCompositor = version3Report()
    delete mutableProfile(missingCompositor).compositor
    invalid.push(missingCompositor)

    for (const value of invalid) expect(validateReport(value)).toBeNull()
  })

  test('forbids v3 profile and metric fields on legacy reports', () => {
    for (const workloadVersion of [1, 2] as const) {
      const profileField = structuredClone(report()) as unknown as { profile: Record<string, unknown> }
      profileField.profile.workloadVersion = workloadVersion
      if (workloadVersion === 2) profileField.profile.compositor = 'software'
      profileField.profile.frameTiming = 'native-final-frame-idle-cap-60hz'
      expect(validateReport(profileField)).toBeNull()

      const metricField = structuredClone(report()) as unknown as {
        profile: Record<string, unknown>
        metrics: Record<Metric, Record<string, unknown>>
      }
      metricField.profile.workloadVersion = workloadVersion
      if (workloadVersion === 2) metricField.profile.compositor = 'software'
      metricField.metrics.echo.unavailableSamples = 0
      expect(validateReport(metricField)).toBeNull()

      const wallMetricField = structuredClone(report()) as unknown as {
        profile: Record<string, unknown>
        metrics: Record<Metric, Record<string, unknown>>
      }
      wallMetricField.profile.workloadVersion = workloadVersion
      if (workloadVersion === 2) wallMetricField.profile.compositor = 'software'
      wallMetricField.metrics.echo.wallSamplesMs = Array(20).fill(1)
      expect(validateReport(wallMetricField)).toBeNull()
    }
  })

})


describe('paired regression rule', () => {
  test('rejects oversized paired evidence before computing confidence bounds', () => {
    const oversized = pair({ counts: { startup: 1001 } })
    expect(validatePair(oversized)).toBeNull()
    expect(comparePair(report(), oversized)).toMatchObject({ status: 'error', reason: 'pair report is malformed' })
    const row = oversized.metrics.startup
    expect(pairedLowerBoundPercent(row.headSamplesMs, row.baseSamplesMs)).toBeNull()
    expect(pairedRegression(row.headSamplesMs, row.baseSamplesMs)).toBeNull()
  })

  test('scenario 1: flags a clean 30% slowdown in every metric', () => {
    const comparison = comparePair(report(), pair({ scale: 1.3 }))
    expect(comparison.status).toBe('compared')
    for (const metric of METRICS) {
      const row = comparison.metrics[metric]!
      expect(row.baselineMedianMs).toBe(109.5)
      expect(row.changePercent.toFixed(1)).toBe('30.0')
      expect(row.lowerBoundPercent.toFixed(1)).toBe('30.0')
      expect(row.regression).toBe(true)
    }
  })

  test('scenario 2: does not flag exactly 25%', () => {
    const comparison = comparePair(report(), pair({ scale: 1.25 }))
    expect(comparison.status).toBe('compared')
    for (const metric of METRICS) {
      const row = comparison.metrics[metric]!
      expect(row.headMedianMs).toBe(136.875)
      expect(row.baselineMedianMs).toBe(109.5)
      expect(row.lowerBoundPercent.toFixed(1)).toBe('25.0')
      expect(row.regression).toBe(false)
    }
  })

  test('scenario 3: does not flag a median slowdown unsupported by paired samples', () => {
    const baseSamplesMs = Array(20).fill(100)
    const headSamplesMs = [...Array(11).fill(140), ...Array(9).fill(60)]
    const comparison = comparePair(report(), pair({ metrics: { startup: { baseSamplesMs, headSamplesMs } } }))
    expect(comparison.status).toBe('compared')
    const row = comparison.metrics.startup!
    expect(row.headMedianMs).toBe(140)
    expect(row.changePercent.toFixed(1)).toBe('40.0')
    expect(row.lowerBoundPercent.toFixed(1)).toBe('-8.3')
    expect(row.regression).toBe(false)
    expect(pairedLowerBoundPercent(headSamplesMs, baseSamplesMs)?.toFixed(1)).toBe('-8.3')
  })

  test('scenario 4: reproduces the exact recorded-noise regression counts', async () => {
    const fixture = await Bun.file(new URL('./testdata/main-runs.json', import.meta.url)).json() as {
      runs: { samplesMs: Record<Metric, number[]> }[]
    }
    const actual = [1, 1.3, 1.5].map((scale) => ({ scale, ...replayCounts(fixture.runs, scale) }))
    const expected = [
      { scale: 1, startup: 0, echo: 0, switch: 1, diff: 2, floodEcho: 2, any: 5 },
      { scale: 1.3, startup: 413, echo: 410, switch: 426, diff: 417, floodEcho: 416, any: 550 },
      { scale: 1.5, startup: 540, echo: 540, switch: 539, diff: 537, floodEcho: 539, any: 550 },
    ]
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Recorded-noise regression counts differ: ${JSON.stringify(actual)}`)
    }
    expect(actual).toEqual(expected)
  })

  test('scenario 5: validates qualification, durations, side lengths, and failures', () => {
    const complete = pair()
    expect(validatePair(complete)).toEqual(complete)

    const smoke = pair({ counts: Object.fromEntries(METRICS.map((metric) => [metric, 1])) as Record<Metric, number> })
    expect(smoke.qualified).toBe(false)
    expect(validatePair(smoke)).toEqual(smoke)

    const incomplete = pair({
      status: 'incomplete',
      failures: [{ kind: 'pair-setup-failed', message: 'could not start base' }],
    })
    expect(incomplete.qualified).toBe(false)
    expect(validatePair(incomplete)).toEqual(incomplete)


    const failedSetup = pair({
      status: 'incomplete',
      counts: Object.fromEntries(METRICS.map((metric) => [metric, 0])) as Record<Metric, number>,
      failures: [{ kind: 'pair-setup-failed', message: 'could not start base' }],
    })
    expect(METRICS.every((metric) => failedSetup.metrics[metric].headSamplesMs.length === 0 && failedSetup.metrics[metric].baseSamplesMs.length === 0)).toBe(true)
    expect(validatePair(failedSetup)).toEqual(failedSetup)

    const interruptedSide = pair({
      status: 'incomplete',
      metrics: { startup: { headSamplesMs: [101, 102], baseSamplesMs: [99] } },
    })
    expect(validatePair(interruptedSide)).toEqual(interruptedSide)

    const shortQualified = pair({ counts: { echo: 59 } })
    expect(shortQualified.qualified).toBe(false)
    expect(validatePair(shortQualified)).toEqual(shortQualified)

    const mismatchedLengths = structuredClone(complete)
    mismatchedLengths.metrics.echo.headSamplesMs.pop()
    const zeroDuration = structuredClone(complete)
    zeroDuration.metrics.startup.baseSamplesMs[0] = 0
    const nonFiniteDuration = structuredClone(complete)
    nonFiniteDuration.metrics.switch.headSamplesMs[0] = Number.POSITIVE_INFINITY
    const inconsistentQualification = structuredClone(complete)
    inconsistentQualification.qualified = false
    const failedComplete = structuredClone(complete)
    failedComplete.failures = [{ kind: 'pair-interrupted', message: 'unexpected failure' }]
    const failurelessIncomplete = structuredClone(incomplete)
    failurelessIncomplete.failures = []
    for (const malformed of [mismatchedLengths, zeroDuration, nonFiniteDuration, inconsistentQualification, failedComplete, failurelessIncomplete]) {
      expect(validatePair(malformed)).toBeNull()
    }
  })

  test('scenario 5: distinguishes absent, smoke, incomplete, mismatched, and malformed pairs', () => {
    expect(comparePair(report(), null)).toMatchObject({
      status: 'unavailable',
      reason: 'no paired base measurement',
    })
    expect(comparePair(report(), pair({ counts: Object.fromEntries(METRICS.map((metric) => [metric, 1])) as Record<Metric, number> }))).toMatchObject({
      status: 'unavailable',
      reason: 'smoke pair is not a qualifying comparison',
    })
    expect(comparePair(report(), pair({
      status: 'incomplete',
      baseCommit: SHA_B,
      failures: [{ kind: 'pair-setup-failed', message: 'could not start base' }],
    }))).toMatchObject({
      status: 'unavailable',
      reason: `base ${SHA_B.slice(0, 8)} could not be measured: pair-setup-failed could not start base`,
    })
    expect(comparePair(report(), pair({ headCommit: SHA_B }))).toMatchObject({
      status: 'error',
      reason: 'pair HEAD does not match the report',
    })
    const malformed = { ...pair(), head: { commit: 'invalid' } } as unknown as SpeedPair
    expect(comparePair(report(), malformed)).toMatchObject({
      status: 'error',
      reason: 'pair report is malformed',
    })
  })
})

describe('Speed markdown and misses', () => {
  test('scenario 6: renders parent and merge-base comparisons with absolute results', () => {
    const head = report({ commit: SHA_B, samples: { echo: Array(20).fill(51) } })
    const parentComparison = comparePair(head, pair({ headCommit: SHA_B, baseCommit: SHA_A, basis: 'parent', scale: 1.3 }))
    const parentMarkdown = renderSpeed(head, parentComparison)
    expect(parentMarkdown.split('\n')[2]).toBe(`Compared main \`${SHA_B}\` with its parent \`${SHA_A}\`, interleaved on one runner (run \`run-123\`).`)
    expect(parentMarkdown).toContain('| Metric | Pairs | Parent median (ms) | This commit median (ms) | Change | Lower bound (95%) | Result |')
    expect(parentMarkdown).toContain('| startup | 20 |')
    expect(parentMarkdown).toContain('| echo | 60 |')
    expect(parentMarkdown).toContain('REGRESSION means the median is more than 25% slower and the lower end of the 95% confidence interval is above zero.')
    expect(parentMarkdown).toContain('Absolute results for this commit:')
    expect(parentMarkdown).toContain('| Metric | Median (ms) | Samples | Budget (ms) | Budget result |')
    expect(parentMarkdown).not.toContain('with PR')

    const mergeBaseComparison = comparePair(head, pair({ headCommit: SHA_B, baseCommit: SHA_A, basis: 'merge-base', scale: 1.3 }))
    const mergeBaseMarkdown = renderSpeed(head, mergeBaseComparison)
    expect(mergeBaseMarkdown.split('\n')[2]).toBe(`Compared PR \`${SHA_B}\` with main at its merge base \`${SHA_A}\`, interleaved on one runner (run \`run-123\`).`)
    expect(mergeBaseMarkdown).toContain('| Metric | Pairs | Main median (ms) | PR median (ms) | Change | Lower bound (95%) | Result |')

    const notCompared = renderSpeed(head, comparePair(head, null))
    expect(notCompared).toContain('not compared: no paired base measurement')
    expect(notCompared).toContain(`Commit \`${SHA_B}\` (run \`run-123\`).`)
    expect(notCompared).not.toContain('PR commit')

    if (parentComparison.status === 'compared') {
      parentComparison.metrics.startup!.lowerBoundPercent = Number.POSITIVE_INFINITY
      expect(renderSpeed(head, parentComparison)).toContain('not measured: comparison data is malformed')
    }
  })

  test('shows current values and misses when no paired base measurement exists', () => {
    const head = report({ commit: SHA_B, samples: { echo: Array(20).fill(51) } })
    const markdown = renderSpeed(head, null)
    expect(markdown).toContain('not compared: no paired base measurement')
    expect(markdown).toContain('echo')
    expect(markdown).toContain('51')
    expect(markdown.toLowerCase()).toContain('budget miss')
    expect(markdown).not.toContain('REGRESSION')
  })

  test('renders named incomplete and lookup failures as not measured', () => {
    const incomplete = report({
      status: 'incomplete',
      qualified: false,
      samples: { echo: [12] },
      failures: [{ kind: 'selector-mismatch', metric: 'echo', sample: 3, message: 'primary terminal was not visible' }],
    })
    expect(renderSpeed(incomplete)).toContain('not measured: selector-mismatch echo sample 3: primary terminal was not visible')
    expect(renderSpeed(null, emptyComparison('error', 'baseline download failed'))).toContain('not measured: baseline download failed')
  })

  test('creates one evidence entry per missed metric and no entry at budget', () => {
    const value = report({
      samples: {
        startup: Array(20).fill(3000),
        echo: Array(20).fill(50.001),
        switch: Array(20).fill(200),
        diff: Array(20).fill(1000.001),
        floodEcho: Array(20).fill(100),
      },
      diagnostics: [
        'diagnostics/echo.json', 'traces/echo.json', 'timelines/echo.json',
        'diagnostics/diff.json', 'traces/diff.json', 'timelines/diff.json',
        'diagnostics/startup.json',
      ],
    })
    const misses = createMisses(value)
    expect(misses.map((miss) => miss.metric)).toEqual(['echo', 'diff'])
    expect(misses.map(({ metric, budgetMs, medianMs, samples, diagnostics }) => ({ metric, budgetMs, medianMs, samples, diagnostics }))).toEqual([
      { metric: 'echo', budgetMs: 50, medianMs: 50.001, samples: 'samples.jsonl', diagnostics: ['diagnostics/echo.json', 'traces/echo.json', 'timelines/echo.json'] },
      { metric: 'diff', budgetMs: 1000, medianMs: 1000.001, samples: 'samples.jsonl', diagnostics: ['diagnostics/diff.json', 'traces/diff.json', 'timelines/diff.json'] },
    ])
    expect(misses[0]?.finding.toLowerCase()).toContain('diagnosis unavailable')
    expect(misses[0]?.finding).toContain('diagnostics/echo.json')
    expect(misses[0]?.finding).not.toContain('diagnostics/diff.json')
    expect(misses[1]?.finding).toContain('diagnostics/diff.json')
    expect(misses[1]?.finding).not.toContain('diagnostics/echo.json')
  })

  test('validates and renders an observed miss finding', () => {
    const value = report({ commit: SHA_B, samples: { echo: Array(20).fill(51) } })
    const generated = createMisses(value)[0]!
    const observed = {
      ...generated,
      finding: 'Observed echo controllerUntilFreshPaintMs=12.500 ms; status.get probes=8, max=1.2 ms, ownLagMs=0.3 ms.',
    }

    expect(validateMisses([observed], value)).toEqual([observed])
    expect(renderSpeed(value, null, [observed])).toContain(observed.finding)
    expect(renderSpeed(value, comparePair(value, pair({ headCommit: SHA_B, baseCommit: SHA_A })), [observed])).toContain(observed.finding)
    expect(renderSpeed(value, emptyComparison('error', 'baseline download failed'), [observed])).toContain(observed.finding)
  })

  test('rejects forged miss identity, measurements, and unsafe or cross-metric paths', () => {
    const value = report({ commit: SHA_B, samples: { echo: Array(20).fill(51) } })
    const miss = createMisses(value)[0]!
    const forged = [
      { ...miss, metric: 'diff' },
      { ...miss, commit: SHA_A },
      { ...miss, budgetMs: 49 },
      { ...miss, medianMs: 52 },
      { ...miss, samples: 'other-samples.jsonl' },
      { ...miss, samples: '../samples.jsonl' },
      { ...miss, diagnostics: ['../../diagnostics/echo.json'] },
      { ...miss, diagnostics: ['diagnostics/diff.json'] },
    ]
    for (const candidate of forged) expect(validateMisses([candidate], value)).toBeNull()
    expect(validateMisses([], value)).toBeNull()
    expect(validateMisses([miss, miss], value)).toBeNull()
  })

  test('falls back to unavailable diagnosis and escapes bounded findings', () => {
    const value = report({ commit: SHA_B, qualified: false, samples: { echo: Array(20).fill(51) }, diagnostics: [] })
    const generated = createMisses(value)[0]!
    const invalid = { ...generated, commit: SHA_A, finding: 'forged diagnosis' }
    expect(validateMisses([invalid], value)).toBeNull()
    expect(renderSpeed(value)).toContain('Diagnosis unavailable')
    const fallback = renderSpeed(value, null, [invalid])
    expect(fallback).toContain('Diagnosis unavailable')
    expect(fallback).not.toContain('forged diagnosis')

    const observed = { ...generated, finding: `<phase|${'x'.repeat(350)} status.get probes=8 max=1.2 ms ownLagMs=0.3 ms` }
    expect(validateMisses([observed], value)).toEqual([observed])
    const markdown = renderSpeed(value, null, [observed])
    expect(markdown).toContain('status.get probes=8 max=1.2 ms ownLagMs=0.3 ms')
    expect(markdown).toContain('\\<phase\\|')
    expect(markdown).not.toContain('x'.repeat(400))
    expect(markdown.length).toBeLessThan(20_000)
  })

  test('states when diagnostic evidence is unavailable and bounds rendered failure text', () => {
    const value = report({
      qualified: false,
      samples: { echo: Array(20).fill(51) },
      diagnostics: [],
    })
    expect(createMisses(value)[0]?.finding).toContain('Diagnosis unavailable')
    const incomplete = report({
      status: 'incomplete',
      qualified: false,
      failures: [{ kind: 'timeout', metric: 'echo', sample: 1, message: 'x'.repeat(2_000) }],
    })
    const markdown = renderSpeed(incomplete)
    expect(markdown.startsWith('### Speed')).toBe(true)
    expect(markdown.length).toBeLessThan(20_000)
  })
  test('keeps version 2 reports on the legacy rendering contract', () => {
    const legacy = report()
    const value: SpeedReport = {
      ...legacy,
      profile: { ...legacy.profile, workloadVersion: 2, compositor: 'software' },
    }
    const markdown = renderSpeed(value)

    expect(validateReport(value)).toEqual(value)
    expect(markdown).toContain('| Metric | Median (ms) | Samples | Budget (ms) | Budget result |')
    expect(markdown).not.toContain('Raw wall median (ms)')
    expect(markdown).not.toContain('Echo, switch and floodEcho budget values')
  })

  test('scenario 8: renders v3 clocks in parent and merge-base comparisons', () => {
    const head = version3Report({
      samples: { echo: Array(20).fill(45) },
      wallSamples: { echo: Array(20).fill(80) },
    })
    head.commit = SHA_B
    const explanation = 'Echo, switch and floodEcho budget values cap only demonstrated final-frame idle wait at 16.667 ms; native wall latency is shown separately. Startup and diff use wall time. Unavailable accounting uses wall time without a deduction.'

    for (const basis of ['parent', 'merge-base'] as const) {
      const comparison = comparePair(head, pair({ headCommit: SHA_B, baseCommit: SHA_A, basis }))
      const markdown = renderSpeed(head, comparison)
      expect(comparison.status).toBe('compared')
      expect(markdown).toContain('| Metric | Raw wall median (ms) | Budget median (ms) | Unavailable accounting samples | Samples | Budget (ms) | Budget result |')
      expect(markdown).toContain('| echo | 80 | 45 | 0 | 20 | 50 | pass |')
      expect(markdown).toContain(explanation)
    }
  })

  test('keeps a complete qualified 20-sample all-fallback report budgeted on wall time', () => {
    const value = version3Report({
      samples: {
        startup: Array(20).fill(1000),
        echo: Array(20).fill(45),
        switch: Array(20).fill(150),
        diff: Array(20).fill(500),
        floodEcho: Array(20).fill(60),
      },
      unavailableSamples: { echo: 20, switch: 20, floodEcho: 20 },
    })
    const markdown = renderSpeed(value)

    expect(validateReport(value)).toEqual(value)
    expect(value.status).toBe('complete')
    expect(value.qualified).toBe(true)
    expect(markdown).toContain('| echo | 45 | 45 | 20 | 20 | 50 | pass |')
    expect(markdown).toContain('| switch | 150 | 150 | 20 | 20 | 200 | pass |')
    expect(markdown).toContain('| floodEcho | 60 | 60 | 20 | 20 | 100 | pass |')
    expect(markdown).toContain('Echo, switch and floodEcho budget values cap only demonstrated final-frame idle wait at 16.667 ms; native wall latency is shown separately. Startup and diff use wall time. Unavailable accounting uses wall time without a deduction.')
    expect(markdown).not.toContain('not measured:')
  })

})
