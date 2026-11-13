import { BUDGETS, METRICS, type Comparison, type Failure, type Metric, type MetricComparison, type SpeedMiss, type SpeedProfile, type SpeedReport } from './contracts'

const REPORT_KEYS = ['version', 'commit', 'runId', 'createdAt', 'status', 'qualified', 'profile', 'metrics', 'failures', 'cleanup', 'evidence']
const PROFILE_KEYS = ['workloadVersion', 'worktrees', 'terminals', 'diffAddedLines', 'renderer', 'viewport', 'startup', 'floodChunkBytes', 'floodIntervalMs', 'runner', 'os', 'arch', 'cpuModel', 'cpuCount', 'bun', 'chromium', 'imageVersion']
const METRIC_RESULT_KEYS = ['samplesMs', 'medianMs', 'budgetMs', 'budgetMiss']
const EVIDENCE_KEYS = ['samples', 'diagnostics', 'misses']
const PROFILE_FIELDS: readonly (keyof SpeedProfile)[] = [
  'workloadVersion', 'worktrees', 'terminals', 'diffAddedLines', 'renderer', 'startup',
  'floodChunkBytes', 'floodIntervalMs', 'runner', 'os', 'arch', 'cpuModel', 'cpuCount',
  'bun', 'chromium', 'imageVersion',
]
const MAX_FAILURES = 100
const MAX_EVIDENCE_PATHS = 100
const MAX_MARKDOWN_CHARS = 16_000
const MAX_CELL_CHARS = 300

export function median(samples: number[]): number | null {
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

function validProfile(value: unknown): value is SpeedProfile {
  if (!isRecord(value) || !hasExactKeys(value, PROFILE_KEYS)) return false
  const viewport = value.viewport
  return value.workloadVersion === 1
    && value.worktrees === 10
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

function validMetricResult(value: unknown, metric: Metric): boolean {
  if (!isRecord(value) || !hasExactKeys(value, METRIC_RESULT_KEYS)) return false
  if (value.budgetMs !== BUDGETS[metric] || !Array.isArray(value.samplesMs)) return false
  if (!value.samplesMs.every((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample > 0)) return false
  const expectedMedian = median(value.samplesMs as number[])
  if (value.medianMs !== expectedMedian) return false
  if (expectedMedian === null) return value.budgetMiss === null
  return value.budgetMiss === (expectedMedian > BUDGETS[metric])
}

/** Validates the version-1 report shape and all aggregates without discarding partial or smoke evidence. */
export function validateReport(value: unknown): SpeedReport | null {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) return null
  if (value.version !== 1 || typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(value.commit)) return null
  if (!isBoundedText(value.runId, 128) || !isIsoTimestamp(value.createdAt)) return null
  if (value.status !== 'complete' && value.status !== 'incomplete') return null
  if (typeof value.qualified !== 'boolean' || !validProfile(value.profile)) return null
  if (value.cleanup !== 'complete' && value.cleanup !== 'failed') return null
  if (value.status === 'complete' && (value.cleanup !== 'complete' || !Array.isArray(value.failures) || value.failures.length !== 0)) return null
  if (value.status === 'incomplete' && value.qualified) return null
  if (!Array.isArray(value.failures) || value.failures.length > MAX_FAILURES || !value.failures.every(validFailure)) return null
  if (value.status === 'incomplete' && value.failures.length === 0) return null
  if (!isRecord(value.evidence) || !hasExactKeys(value.evidence, EVIDENCE_KEYS)) return null
  if (!isSafeEvidencePath(value.evidence.samples) || !isSafeEvidencePath(value.evidence.misses)) return null
  if (!Array.isArray(value.evidence.diagnostics) || value.evidence.diagnostics.length > MAX_EVIDENCE_PATHS || !value.evidence.diagnostics.every(isSafeEvidencePath)) return null
  if (!isRecord(value.metrics) || !hasExactKeys(value.metrics, METRICS)) return null
  for (const metric of METRICS) {
    if (!validMetricResult(value.metrics[metric], metric)) return null
  }

  const counts = METRICS.map((metric) => (value.metrics as Record<Metric, { samplesMs: unknown[] }>)[metric].samplesMs.length)
  if (value.status === 'complete' && counts.some((count) => value.qualified ? count < 20 : count < 1)) return null
  return value as unknown as SpeedReport
}

function metadata(report: SpeedReport): Comparison['head'] {
  return { commit: report.commit, runId: report.runId, createdAt: report.createdAt }
}

function metricNulls(): Record<Metric, null> {
  return { startup: null, echo: null, switch: null, diff: null, floodEcho: null }
}

function profileDifferences(left: SpeedProfile, right: SpeedProfile): string[] {
  const changed = PROFILE_FIELDS.filter((field) => left[field] !== right[field])
  if (left.viewport.width !== right.viewport.width || left.viewport.height !== right.viewport.height) changed.push('viewport')
  return changed.map((field) => String(field))
}

export function compatibleProfiles(a: SpeedProfile, b: SpeedProfile): boolean {
  return profileDifferences(a, b).length === 0
}

function failureReason(report: SpeedReport, name: 'current' | 'baseline'): string {
  const failure = report.failures[0]
  if (failure) {
    const where = failure.metric ? `${failure.metric}${failure.sample === undefined ? '' : ` sample ${failure.sample}`}: ` : ''
    return `${name} report is incomplete (${where}${failure.message})`
  }
  return `${name} report is not qualified`
}

function invalidComparison(current: SpeedReport, baseline: SpeedReport, reason: string): Comparison {
  return {
    status: 'error',
    head: metadata(current),
    baseline: { ...metadata(baseline)!, ageMs: Date.parse(current.createdAt) - Date.parse(baseline.createdAt) },
    reason,
    reasons: [reason],
    metrics: metricNulls(),
  }
}

function percentageChange(current: number, baseline: number): number {
  const ratio = current / baseline
  return Number.isFinite(ratio) ? (ratio - 1) * 100 : Number.MAX_VALUE
}

export function compareReports(current: SpeedReport, baseline: SpeedReport): Comparison {
  const currentValid = validateReport(current)
  const baselineValid = validateReport(baseline)
  if (!currentValid || !baselineValid) {
    const reason = !currentValid ? 'current report is malformed' : 'baseline report is malformed'
    return invalidComparison(current, baseline, reason)
  }
  if (current.status !== 'complete' || !current.qualified) return invalidComparison(current, baseline, failureReason(current, 'current'))
  if (baseline.status !== 'complete' || !baseline.qualified) return invalidComparison(current, baseline, failureReason(baseline, 'baseline'))

  const differences = profileDifferences(current.profile, baseline.profile)
  if (differences.length > 0) {
    const reason = `measurement profiles differ: ${differences.join(', ')}`
    return {
      status: 'unavailable',
      head: metadata(current),
      baseline: { ...metadata(baseline)!, ageMs: Date.parse(current.createdAt) - Date.parse(baseline.createdAt) },
      reason,
      reasons: [reason],
      metrics: metricNulls(),
    }
  }

  const rows = {} as Record<Metric, MetricComparison>
  for (const metric of METRICS) {
    const headResult = current.metrics[metric]
    const baselineResult = baseline.metrics[metric]
    const headMedianMs = median(headResult.samplesMs)
    const baselineMedianMs = median(baselineResult.samplesMs)
    if (headMedianMs === null || baselineMedianMs === null) return invalidComparison(current, baseline, `${metric} has no usable samples`)
    rows[metric] = {
      headMedianMs,
      baselineMedianMs,
      headSamples: headResult.samplesMs.length,
      baselineSamples: baselineResult.samplesMs.length,
      changePercent: percentageChange(headMedianMs, baselineMedianMs),
      budgetMs: BUDGETS[metric],
      budgetMiss: headMedianMs > BUDGETS[metric],
      baselineBudgetMiss: baselineMedianMs > BUDGETS[metric],
      regression: headMedianMs > baselineMedianMs * 1.25,
    }
  }

  const baselineMetadata = metadata(baseline)!
  return {
    status: 'compared',
    head: metadata(current),
    baseline: { ...baselineMetadata, ageMs: Date.parse(current.createdAt) - Date.parse(baseline.createdAt) },
    reason: null,
    reasons: [],
    metrics: rows,
  }
}

function isSafeComparison(value: Comparison, current: SpeedReport): boolean {
  if (value.status !== 'compared' || value.head === null || value.baseline === null) return false
  if (value.head.commit !== current.commit || value.head.runId !== current.runId || value.head.createdAt !== current.createdAt) return false
  if (!/^[0-9a-f]{40}$/i.test(value.baseline.commit) || !isBoundedText(value.baseline.runId, 128) || !isIsoTimestamp(value.baseline.createdAt)) return false
  const expectedAge = Date.parse(current.createdAt) - Date.parse(value.baseline.createdAt)
  if (value.baseline.ageMs !== expectedAge || !Number.isFinite(value.baseline.ageMs)) return false
  if (value.reason !== null || value.reasons.length !== 0) return false
  for (const metric of METRICS) {
    const row = value.metrics[metric]
    const currentMedian = median(current.metrics[metric].samplesMs)
    if (!row || currentMedian === null || row.headMedianMs !== currentMedian) return false
    if (!Number.isFinite(row.baselineMedianMs) || row.baselineMedianMs <= 0) return false
    if (row.headSamples !== current.metrics[metric].samplesMs.length || !Number.isSafeInteger(row.baselineSamples) || row.baselineSamples < 20) return false
    if (row.budgetMs !== BUDGETS[metric] || row.budgetMiss !== (currentMedian > BUDGETS[metric])) return false
    if (row.baselineBudgetMiss !== (row.baselineMedianMs > BUDGETS[metric])) return false
    if (row.changePercent !== percentageChange(currentMedian, row.baselineMedianMs)) return false
    if (row.regression !== (currentMedian > row.baselineMedianMs * 1.25)) return false
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

function ageText(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'unknown age'
  if (ageMs < 0) return `baseline timestamp is ${ageText(-ageMs)} newer`
  if (ageMs < 60_000) return 'less than a minute old'
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} ${Math.floor(ageMs / 60_000) === 1 ? 'minute' : 'minutes'} old`
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)} ${Math.floor(ageMs / 3_600_000) === 1 ? 'hour' : 'hours'} old`
  return `${Math.floor(ageMs / 86_400_000)} ${Math.floor(ageMs / 86_400_000) === 1 ? 'day' : 'days'} old`
}

function currentRows(report: SpeedReport): string[] {
  const lines = [
    '| Metric | Median (ms) | Samples | Budget (ms) | Budget result |',
    '| --- | ---: | ---: | ---: | --- |',
  ]
  for (const metric of METRICS) {
    const result = report.metrics[metric]
    const value = median(result.samplesMs)
    const budgetMiss = value !== null && value > BUDGETS[metric]
    lines.push(`| ${metric} | ${displayNumber(value)} | ${result.samplesMs.length} | ${BUDGETS[metric]} | ${budgetMiss ? 'BUDGET MISS' : value === null ? 'not measured' : 'pass'} |`)
  }
  return lines
}

function comparedRows(comparison: Comparison): string[] {
  const lines = [
    '| Metric | Main median (n) | PR median (n) | Change | Main budget | PR budget | Relative result |',
    '| --- | ---: | ---: | ---: | --- | --- | --- |',
  ]
  for (const metric of METRICS) {
    const row = comparison.metrics[metric]!
    const relative = row.regression ? 'REGRESSION' : 'no regression'
    const change = `${row.changePercent >= 0 ? '+' : ''}${row.changePercent.toFixed(1)}%`
    lines.push(`| ${metric} | ${row.baselineMedianMs} (${row.baselineSamples}) | ${row.headMedianMs} (${row.headSamples}) | ${change} | ${row.baselineBudgetMiss ? 'BUDGET MISS' : 'pass'} | ${row.budgetMiss ? 'BUDGET MISS' : 'pass'} | ${relative} |`)
  }
  return lines
}

function failureText(failure: Failure): string {
  const location = failure.metric ? ` ${failure.metric}${failure.sample === undefined ? '' : ` sample ${failure.sample}`}:` : ''
  return `${failure.kind}${location} ${failure.message}`
}

function missLines(report: SpeedReport): string[] {
  const misses = createMisses(report)
  if (misses.length === 0) return []
  return [
    '',
    `Miss evidence: \`${escaped(report.evidence.misses)}\`.`,
    ...misses.map((miss) => {
      const shownDiagnostics = miss.diagnostics.slice(0, 5)
      const diagnostics = shownDiagnostics.length > 0 ? shownDiagnostics.map((path) => `\`${escaped(path)}\``).join(', ') : 'no diagnostic paths'
      const remaining = miss.diagnostics.length > shownDiagnostics.length ? ` (+${miss.diagnostics.length - shownDiagnostics.length} more)` : ''
      return `- ${miss.metric}: ${miss.medianMs} ms over ${miss.budgetMs} ms; samples \`${escaped(miss.samples)}\`; diagnostics ${diagnostics}${remaining}; ${escaped(miss.finding)}`
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
export function renderSpeed(current: SpeedReport | null, comparison?: Comparison | null): string {
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
  if (current.status === 'incomplete') {
    const failure = current.failures[0]
    lines.push(`not measured: ${escaped(failure ? failureText(failure) : 'benchmark run incomplete')}`, '')
    lines.push(...currentRows(current))
    return boundedMarkdown(lines)
  }
  if (!current.qualified) {
    lines.push('not measured: smoke report is unqualified', '')
    lines.push(...currentRows(current))
    return boundedMarkdown(lines)
  }

  if (comparison?.status === 'error') {
    lines.push(`not measured: ${escaped(comparisonReason ?? 'comparison evidence could not be read')}`, '')
    lines.push(...currentRows(current), ...missLines(current))
    return boundedMarkdown(lines)
  }
  if (comparison?.status === 'compared') {
    if (!isSafeComparison(comparison, current)) {
      lines.push('not measured: comparison data is malformed', '')
      lines.push(...currentRows(current), ...missLines(current))
      return boundedMarkdown(lines)
    }
    lines.push(`Compared main \`${comparison.baseline!.commit}\` (${escaped(ageText(comparison.baseline!.ageMs))}, run \`${escaped(comparison.baseline!.runId)}\`) with PR \`${comparison.head!.commit}\` (run \`${escaped(comparison.head!.runId)}\`).`, '')
    lines.push(...comparedRows(comparison), ...missLines(current))
    return boundedMarkdown(lines)
  }

  const reason = comparisonReason ?? 'no compatible baseline'
  lines.push(`not compared: ${escaped(reason)}`, `PR commit \`${current.commit}\` (run \`${escaped(current.runId)}\`).`, '')
  lines.push(...currentRows(current), ...missLines(current))
  return boundedMarkdown(lines)
}

/** Creates evidence references only for completed metrics whose recomputed median exceeds its fixed budget. */
export function createMisses(report: SpeedReport): SpeedMiss[] {
  if (report.status !== 'complete' || !validateReport(report)) return []
  const misses: SpeedMiss[] = []
  for (const metric of METRICS) {
    const medianMs = median(report.metrics[metric].samplesMs)
    if (medianMs === null || medianMs <= BUDGETS[metric]) continue
    const diagnostics = [...report.evidence.diagnostics]
    misses.push({
      metric,
      budgetMs: BUDGETS[metric],
      medianMs,
      commit: report.commit,
      runId: report.runId,
      samples: report.evidence.samples,
      diagnostics,
      finding: diagnostics.length > 0
        ? `Diagnostic paths: ${diagnostics.join(', ')}.`
        : 'Diagnosis unavailable: no diagnostic paths were recorded.',
    })
  }
  return misses
}
