import { describe, expect, test } from 'bun:test'
import { BUDGETS, METRICS, type Metric, type MetricResult, type SpeedReport } from './contracts'
import { compareReports, compatibleProfiles, createMisses, median, renderSpeed, validateReport } from './report'

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
    expect(compareReports(smoke, report({ commit: SHA_B })).status).toBe('error')
    expect(compareReports(partial, report({ commit: SHA_B })).status).toBe('error')
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
})

describe('profile compatibility and comparison', () => {
  test('accepts identical measurement profiles and detects any incompatible runner field', () => {
    const main = report({ commit: SHA_A })
    const head = report({ commit: SHA_B })
    expect(compatibleProfiles(main.profile, head.profile)).toBe(true)
    head.profile.chromium = 'Chromium 141.0'
    expect(compatibleProfiles(main.profile, head.profile)).toBe(false)
    expect(compareReports(main, head).status).toBe('unavailable')
  })

  test('uses the strict unrounded greater-than-25-percent rule', () => {
    const main = report({ commit: SHA_A, createdAt: '2026-11-12T10:00:00.000Z', samples: { echo: Array(20).fill(40) } })
    const atBoundary = report({ commit: SHA_B, samples: { echo: Array(20).fill(50) } })
    const aboveBoundary = report({ commit: SHA_B, samples: { echo: Array(20).fill(50.001) } })
    const boundaryComparison = compareReports(atBoundary, main)
    const regressionComparison = compareReports(aboveBoundary, main)
    expect(boundaryComparison.status).toBe('compared')
    expect(boundaryComparison.metrics.echo?.regression).toBe(false)
    expect(boundaryComparison.metrics.echo?.changePercent).toBe(25)
    expect(regressionComparison.metrics.echo?.regression).toBe(true)
    expect(regressionComparison.metrics.echo?.changePercent).toBeCloseTo(25.0025)
    expect(regressionComparison.baseline?.ageMs).toBe(2 * 60 * 60 * 1000)
  })

  test('flags a relative regression independently of the absolute metric budget', () => {
    const main = report({ commit: SHA_A, samples: { echo: Array(20).fill(80) } })
    const head = report({ commit: SHA_B, samples: { echo: Array(20).fill(101) } })
    const comparison = compareReports(head, main)
    expect(comparison.metrics.echo?.regression).toBe(true)
    expect(comparison.metrics.echo?.budgetMiss).toBe(true)
    expect(comparison.metrics.echo?.baselineBudgetMiss).toBe(true)
  })
})

describe('Speed markdown and misses', () => {
  test('renders every metric, both identities, counts, age and relative result', () => {
    const main = report({ commit: SHA_A, createdAt: '2026-11-12T10:00:00.000Z', samples: { echo: Array(20).fill(40) } })
    const head = report({ commit: SHA_B, samples: { echo: Array(20).fill(50.001) } })
    const markdown = renderSpeed(head, compareReports(head, main))
    expect(markdown.startsWith('### Speed')).toBe(true)
    expect(markdown).toContain(SHA_A.slice(0, 7))
    expect(markdown).toContain(SHA_B.slice(0, 7))
    expect(markdown).toContain('2 hours')
    for (const metric of METRICS) expect(markdown).toContain(metric)
    expect(markdown).toContain('20')
    expect(markdown).toContain('REGRESSION')
  })

  test('shows current values and misses when no compatible baseline exists', () => {
    const head = report({ commit: SHA_B, samples: { echo: Array(20).fill(51) } })
    const markdown = renderSpeed(head, null)
    expect(markdown).toContain('not compared: no compatible baseline')
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
    expect(renderSpeed(null, {
      status: 'error', head: null, baseline: null, reason: 'baseline download failed',
      reasons: ['baseline download failed'], metrics: Object.fromEntries(METRIC_LIST.map((metric) => [metric, null])) as Record<Metric, null>,
    })).toContain('not measured: baseline download failed')
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
      diagnostics: ['diagnostics/echo.json', 'diagnostics/diff.json'],
    })
    const misses = createMisses(value)
    expect(misses.map((miss) => miss.metric)).toEqual(['echo', 'diff'])
    expect(misses.map(({ metric, budgetMs, medianMs, samples, diagnostics }) => ({ metric, budgetMs, medianMs, samples, diagnostics }))).toEqual([
      { metric: 'echo', budgetMs: 50, medianMs: 50.001, samples: 'samples.jsonl', diagnostics: ['diagnostics/echo.json', 'diagnostics/diff.json'] },
      { metric: 'diff', budgetMs: 1000, medianMs: 1000.001, samples: 'samples.jsonl', diagnostics: ['diagnostics/echo.json', 'diagnostics/diff.json'] },
    ])
    expect(misses[0]?.finding).toContain('diagnostics/echo.json')
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
})
