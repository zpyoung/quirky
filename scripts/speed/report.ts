import { BUDGETS, CONFIDENCE_Z, METRICS, PAIR_COUNTS, REGRESSION_RATIO, type Comparison, type Failure, type Metric, type MetricComparison, type PairBasis, type SpeedMiss, type SpeedPair, type SpeedProfile, type SpeedReport } from './contracts'

const REPORT_KEYS = ['version', 'commit', 'runId', 'createdAt', 'status', 'qualified', 'profile', 'metrics', 'failures', 'cleanup', 'evidence']
const PROFILE_KEYS = ['workloadVersion', 'worktrees', 'terminals', 'diffAddedLines', 'renderer', 'viewport', 'startup', 'floodChunkBytes', 'floodIntervalMs', 'runner', 'os', 'arch', 'cpuModel', 'cpuCount', 'bun', 'chromium', 'imageVersion']
const PROFILE_V2_KEYS = [...PROFILE_KEYS, 'compositor']
const METRIC_RESULT_KEYS = ['samplesMs', 'medianMs', 'budgetMs', 'budgetMiss']
const EVIDENCE_KEYS = ['samples', 'diagnostics', 'misses']
const PAIR_KEYS = ['version', 'runId', 'createdAt', 'status', 'qualified', 'head', 'base', 'metrics', 'failures', 'evidence']
const PAIR_EVIDENCE_KEYS = ['samples']
const MAX_FAILURES = 100
const MAX_EVIDENCE_PATHS = 100
const MAX_PAIR_SAMPLES = 1000
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

function validProfile(value: unknown): value is SpeedProfile {
  if (!isRecord(value)) return false
  const keys = value.workloadVersion === 1
    ? PROFILE_KEYS
    : value.workloadVersion === 2 ? PROFILE_V2_KEYS : null
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
  return validBase && (value.workloadVersion === 1 || value.compositor === 'software')
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

function validMetricResult(value: unknown, metric: Metric): boolean {
  if (!isRecord(value) || !hasExactKeys(value, METRIC_RESULT_KEYS)) return false
  if (value.budgetMs !== BUDGETS[metric] || !Array.isArray(value.samplesMs)) return false
  if (!value.samplesMs.every((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample > 0)) return false
  const expectedMedian = median(value.samplesMs as number[])
  if (value.medianMs !== expectedMedian) return false
  if (expectedMedian === null) return value.budgetMiss === null
  return value.budgetMiss === (expectedMedian > BUDGETS[metric])
}

/** Validates the report shape and all aggregates without discarding partial or smoke evidence. */
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
      return `- ${miss.metric}: ${miss.medianMs} ms over ${miss.budgetMs} ms; samples \`${escaped(miss.samples)}\`; diagnostics ${diagnostics}${remaining}; ${escaped(miss.finding, 2048)}`
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
  const misses: SpeedMiss[] = []
  for (const metric of METRICS) {
    const medianMs = median(report.metrics[metric].samplesMs)
    if (medianMs === null || medianMs <= BUDGETS[metric]) continue
    const diagnostics = report.evidence.diagnostics.filter((path) => path.endsWith(`/${metric}.json`))
    misses.push({
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
    })
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
  const validated: SpeedMiss[] = []
  for (let index = 0; index < value.length; index++) {
    const candidate = value[index]
    const miss = expected[index]
    if (!miss || !isRecord(candidate) || !hasExactKeys(candidate, ['metric', 'budgetMs', 'medianMs', 'commit', 'runId', 'samples', 'diagnostics', 'finding'])) return null
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
      || !isBoundedText(candidate.finding, 2048)) return null
    validated.push(candidate as unknown as SpeedMiss)
  }
  return validated
}

/** Validates serialized miss evidence against a report and its metric-specific paths. */
export function validateMisses(value: unknown, report: SpeedReport): SpeedMiss[] | null {
  if (!validateReport(report)) return null
  return validateMissesAgainstReport(value, report, calculatedMisses(report))
}
