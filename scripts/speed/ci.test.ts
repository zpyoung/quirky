import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUDGETS, METRICS, type SpeedReport } from './contracts'
import { readSpeedEvidence, runCi } from './ci'
import { createMisses, renderSpeed, summarizeEchoTiming, summarizeScheduler, validateReport } from './report'

const roots: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'speed-ci-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha = (n: number) => n.toString(16).padStart(40, '0')
function report(commit = sha(1), echo = 40): SpeedReport {
  return {
    version: 1, commit, runId: '123', createdAt: '2026-11-12T00:00:00Z', status: 'complete', qualified: true,
    profile: { workloadVersion: 1, worktrees: 10, terminals: 20, diffAddedLines: 5000, renderer: 'dom', viewport: { width: 1400, height: 880 }, startup: 'daemon-restart-persistent-pty-fresh-context', floodChunkBytes: 65536, floodIntervalMs: 16, runner: 'macos-15', os: 'darwin', arch: 'arm64', cpuModel: 'test CPU', cpuCount: 4, bun: '1.4.0', chromium: 'test', imageVersion: 'test' },
    metrics: Object.fromEntries(METRICS.map(metric => [metric, { samplesMs: Array(20).fill(metric === 'echo' ? echo : 10), medianMs: metric === 'echo' ? echo : 10, budgetMs: BUDGETS[metric], budgetMiss: (metric === 'echo' ? echo : 10) > BUDGETS[metric] }])) as SpeedReport['metrics'],
    failures: [], cleanup: 'complete', evidence: { samples: 'samples.jsonl', diagnostics: [], misses: 'misses.json' },
  }
}
function stage(current: SpeedReport) {
  const out = temp(); writeFileSync(join(out, 'report.json'), JSON.stringify(current)); return out
}
const PAIR_COUNTS = { startup: 20, echo: 60, switch: 60, diff: 20, floodEcho: 60 } as const

type PairOptions = { baseCommit?: string; basis?: 'merge-base' | 'parent'; headCommit?: string; runId?: string }
function pair(current: SpeedReport, options: PairOptions = {}) {
  return {
    version: 1,
    runId: options.runId ?? current.runId,
    createdAt: current.createdAt,
    status: 'complete',
    qualified: true,
    head: { commit: options.headCommit ?? current.commit },
    base: { commit: options.baseCommit ?? sha(2), basis: options.basis ?? 'merge-base' },
    metrics: Object.fromEntries(METRICS.map(metric => {
      const baseline = metric === 'echo' ? 40 : 10
      const pairs = PAIR_COUNTS[metric]
      return [metric, { headSamplesMs: Array(pairs).fill(baseline * 1.3), baseSamplesMs: Array(pairs).fill(baseline) }]
    })),
    failures: [],
    evidence: { samples: 'pair-samples.jsonl' },
  }
}

function compareArgs(currentPath: string, pairPath: string, out: string, head: string) {
  return ['compare', '--current', currentPath, '--pair', pairPath, '--out', out, '--head', head]
}

test('compare requires all local evidence arguments', async () => {
  const errors: string[] = []
  expect(await runCi(['compare', '--current', 'report.json', '--pair', 'pair.json', '--out', 'out'], {
    cwd: temp(), err: text => errors.push(text),
  })).toBe(2)
  expect(errors.join('')).toContain('40-hex --head')
})

test('absent and malformed evidence are not measured', () => {
  const out = temp()
  expect(readSpeedEvidence(out, sha(1))).toContain('not measured:')
  writeFileSync(join(out, 'report.json'), '{')
  expect(readSpeedEvidence(out, sha(1))).toContain('not measured:')
})

test('a report from another head is not measured', () => {
  expect(readSpeedEvidence(stage(report()), sha(2))).toContain('not measured:')
})

test('a missing pair is unavailable and keeps the absolute report advisory', async () => {
  const current = report(sha(1), 51)
  const input = stage(current)
  const out = temp()
  const pairPath = join(input, 'pair.json')
  expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  expect(comparison.status).toBe('unavailable')
  expect(comparison.reason).toBe('no paired base measurement')
  expect(existsSync(join(out, 'baseline.json'))).toBe(false)
  expect(readSpeedEvidence(out, current.commit)).toContain('not compared: no paired base measurement')
  expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('echo')
  expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('MISS')
})

test('a malformed pair is an evidence error with the specified reason', async () => {
  const current = report()
  const input = stage(current)
  const pairPath = join(input, 'pair.json')
  writeFileSync(pairPath, '{}')
  const out = temp()
  expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  expect(comparison.status).toBe('error')
  expect(comparison.reason).toBe('pair report is malformed')
  expect(readSpeedEvidence(out, current.commit)).toContain('not measured: pair report is malformed')
})

test('a pair for another head is rejected instead of comparing its samples', async () => {
  const current = report()
  const input = stage(current)
  const pairPath = join(input, 'pair.json')
  writeFileSync(pairPath, JSON.stringify(pair(current, { headCommit: sha(2) })))
  const out = temp()
  expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  expect(comparison.status).toBe('error')
  expect(comparison.reason).toBe('pair HEAD does not match the report')
})

test('paired CI comparison uses local samples without GitHub configuration', async () => {
  const current = report(sha(1), 50.001)
  const input = stage(current)
  const pairPath = join(input, 'pair.json')
  const localPair = pair(current, { baseCommit: sha(3) })
  writeFileSync(pairPath, JSON.stringify(localPair))
  const out = temp()
  const code = await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp() })
  expect(code).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  expect(comparison.status).toBe('compared')
  expect(comparison.head).toMatchObject({ commit: current.commit, runId: current.runId })
  expect(comparison.baseline).toEqual({ commit: sha(3), basis: 'merge-base' })
  expect(JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8'))).toEqual(localPair)
  expect(existsSync(join(out, 'baseline.json'))).toBe(false)
  const text = readSpeedEvidence(out, current.commit)
  expect(text).toContain(`Compared PR \`${current.commit}\` with main at its merge base \`${sha(3)}\`, interleaved on one runner (run \`${current.runId}\`).`)
  expect(text).toContain('| Metric | Pairs | Main median (ms) | PR median (ms) | Change | Lower bound (95%) | Result |')
  expect(text).toContain('REGRESSION means the median is more than 25% slower and the lower end of the 95% confidence interval is above zero.')
  expect(text).toContain('Absolute results for this commit:')
})

test('the evidence reader rejects stored comparison rows that disagree with paired samples', async () => {
  const current = report()
  const out = stage(current)
  const pairPath = join(out, 'pair.json')
  writeFileSync(pairPath, JSON.stringify(pair(current)))
  expect(await runCi(compareArgs(join(out, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparisonPath = join(out, 'comparison.json')
  const saved = JSON.parse(readFileSync(comparisonPath, 'utf8'))
  const incorrectRows = structuredClone(saved)
  incorrectRows.metrics.echo.changePercent += 1
  writeFileSync(comparisonPath, JSON.stringify(incorrectRows))
  expect(readSpeedEvidence(out, current.commit)).toContain('not measured: speed evidence: comparison disagrees with paired samples')

  for (const status of ['unavailable', 'error']) {
    const hiddenRegression = structuredClone(saved)
    hiddenRegression.status = status
    hiddenRegression.reason = 'forged unavailable result'
    hiddenRegression.reasons = [hiddenRegression.reason]
    hiddenRegression.baseline = null
    hiddenRegression.metrics = Object.fromEntries(METRICS.map(metric => [metric, null]))
    writeFileSync(comparisonPath, JSON.stringify(hiddenRegression))
    expect(readSpeedEvidence(out, current.commit)).toContain('not measured: speed evidence: comparison disagrees with paired samples')
  }
})

test('the evidence reader verifies paired comparison head, run, basis and base', async () => {
  const current = report()
  const out = stage(current)
  const pairPath = join(out, 'pair.json')
  writeFileSync(pairPath, JSON.stringify(pair(current)))
  expect(await runCi(compareArgs(join(out, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparisonPath = join(out, 'comparison.json')
  const saved = JSON.parse(readFileSync(comparisonPath, 'utf8'))
  const alterations = [
    (value: typeof saved) => { value.head.commit = sha(8) },
    (value: typeof saved) => { value.head.runId = 'other-run' },
    (value: typeof saved) => { value.baseline.basis = 'parent' },
    (value: typeof saved) => { value.baseline.commit = sha(8) },
  ]
  for (const alter of alterations) {
    const forged = structuredClone(saved)
    alter(forged)
    writeFileSync(comparisonPath, JSON.stringify(forged))
    expect(readSpeedEvidence(out, current.commit)).toContain('not measured: speed evidence: comparison disagrees with paired samples')
  }
})

test('duplicate metric keys cannot become a qualifying imported measurement', () => {
  const value = report()
  const out = stage(value)
  const echo = `"echo":${JSON.stringify(value.metrics.echo)}`
  writeFileSync(join(out, 'report.json'), JSON.stringify(value).replace(echo, `${echo},${echo}`))
  expect(readSpeedEvidence(out, value.commit)).toContain('not measured:')
})

test('the local pair is authoritative even when no compatible cross-run profile exists', async () => {
  const current = report(sha(1), 51)
  current.profile.cpuModel = 'different CPU'
  const input = stage(current)
  const pairPath = join(input, 'pair.json')
  writeFileSync(pairPath, JSON.stringify(pair(current, { baseCommit: sha(4), basis: 'parent' })))
  const out = temp()
  expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  expect(comparison.status).toBe('compared')
  expect(comparison.baseline).toEqual({ commit: sha(4), basis: 'parent' })
  expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('| echo | 51 | 20 |')
  expect(readSpeedEvidence(out, current.commit)).not.toContain('not measured:')
})

test('paired evidence preserves the version-2 report and absolute medians', async () => {
  const v1 = report(sha(1), 51)
  const current = { ...v1, profile: { ...v1.profile, workloadVersion: 2, compositor: 'software' } } as unknown as SpeedReport
  const input = stage(current)
  const pairPath = join(input, 'pair.json')
  writeFileSync(pairPath, JSON.stringify(pair(current)))
  const out = temp()
  expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  const comparison = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'))
  const summary = readFileSync(join(out, 'summary.md'), 'utf8')
  expect(comparison.status).toBe('compared')
  expect(summary).toContain('| echo | 51 | 20 |')
  expect(summary).not.toContain('not measured:')
  expect(readSpeedEvidence(out, current.commit)).not.toContain('not measured:')
})

test('runCi carries a report-correlated miss and paired evidence from an external current directory', async () => {
  const current = report(sha(1), 51)
  current.evidence.diagnostics = ['diagnostics/echo.json']
  const input = stage(current)
  const pairPath = join(input, 'pair.json')
  const localPair = pair(current)
  writeFileSync(pairPath, JSON.stringify(localPair))
  const out = temp()
  const finding = 'Observed echo acknowledgement delay in the diagnostic trial.'
  const misses = [{
    metric: 'echo',
    budgetMs: BUDGETS.echo,
    medianMs: 51,
    commit: current.commit,
    runId: current.runId,
    samples: current.evidence.samples,
    diagnostics: ['diagnostics/echo.json'],
    finding,
  }]
  writeFileSync(join(input, 'misses.json'), JSON.stringify(misses))

  expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
  expect(JSON.parse(readFileSync(join(out, 'misses.json'), 'utf8'))).toEqual(misses)
  expect(JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8'))).toEqual(localPair)
  expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain(finding)
  expect(readSpeedEvidence(out, current.commit)).toContain(finding)
})

test('missing, malformed, and report-mismatched misses use report-derived unavailable diagnoses', async () => {
  for (const evidence of ['missing', 'malformed', 'mismatched']) {
    const current = report(sha(1), 51)
    current.evidence.diagnostics = ['diagnostics/echo.json']
    const input = stage(current)
    const out = temp()
    const pairPath = join(input, 'pair.json')
    const forged = 'FORGED finding must not be rendered.'
    if (evidence === 'malformed') writeFileSync(join(input, 'misses.json'), '{')
    if (evidence === 'mismatched') writeFileSync(join(input, 'misses.json'), JSON.stringify([{
      metric: 'echo', budgetMs: BUDGETS.echo, medianMs: 51, commit: sha(2), runId: current.runId,
      samples: current.evidence.samples, diagnostics: ['diagnostics/echo.json'], finding: forged,
    }]))

    expect(await runCi(compareArgs(join(input, 'report.json'), pairPath, out, current.commit), { cwd: temp(), err: () => {} })).toBe(0)
    const summary = readFileSync(join(out, 'summary.md'), 'utf8')
    expect(summary).toContain('not compared:')
    expect(summary).toContain('Diagnosis unavailable')
    expect(summary).not.toContain(forged)
  }
})


test('v4 CI evidence retains attribution and failed runner experiments without changing qualification', async () => {
  const current = report()
  current.profile = { ...current.profile, workloadVersion: 4, compositor: 'software',
    frameTiming: 'native-final-frame-echo-arrival-cap-60hz', runnerPolicy: 'ci-macos-timer-experiment-v1' }
  current.runnerLatency = {
    version: 1, runId: current.runId, runner: 'macos-15', status: 'attempted', reason: null,
    coalescing: { requested: 0, before: 1, after: 1, status: 'set-failed', errors: ['sysctl unsupported'] },
    appNap: { requested: 1, before: 0, after: null, status: 'readback-unavailable', errors: ['key missing'] },
    timerCoalesceBgNsMax: 100000000
  }
  const unavailable = { status: 'unavailable', reason: 'probe-unavailable', intervals: [], pendingLateAtEndMs: null }
  for (const metric of METRICS) {
    const result = current.metrics[metric]
    const raw = BUDGETS[metric] + 1
    Object.assign(result, { samplesMs: Array(20).fill(raw), medianMs: raw, budgetMiss: true,
      wallSamplesMs: Array(20).fill(raw), unavailableSamples: 0, echoTiming: null, scheduler: null })
    if (metric !== 'echo' && metric !== 'floodEcho') continue
    result.echoTiming = summarizeEchoTiming(Array.from({ length: 20 }, () => ({
      status: 'complete', reason: null, workerReadEpochMs: 100012, pageTimeOriginMs: 100000,
      receivedAt: 18, keystrokeToWorkerMs: 2, workerToPageMs: 6, pageToPaintMs: raw - 8
    })))
    result.scheduler = summarizeScheduler(Array.from({ length: 20 }, () => ({
      harness: unavailable, floodWorker: metric === 'floodEcho' ? unavailable : null
    })))
  }
  expect(validateReport(current)).toEqual(current)
  const input = stage(current)
  const misses = createMisses(current)
  writeFileSync(join(input, 'misses.json'), JSON.stringify(misses))
  const out = temp()
  expect(await runCi(compareArgs(join(input, 'report.json'), join(input, 'pair.json'), out, current.commit),
    { cwd: temp(), err: () => {} })).toBe(0)
  const retained = JSON.parse(readFileSync(join(out, 'misses.json'), 'utf8'))
  expect(retained).toEqual(misses)
  expect(retained.find((miss: { metric: string }) => miss.metric === 'echo').echoTiming).toEqual(current.metrics.echo.echoTiming)
  const text = readSpeedEvidence(out, current.commit)
  for (const evidence of ['Keystroke to worker', 'Worker to page', 'Page to paint',
    '20 complete / 0 unavailable', 'sysctl unsupported', 'Controller timer', 'Flood worker sleep']) {
    expect(text).toContain(evidence)
  }
  expect(text).toContain('BUDGET MISS')
  const published = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
  expect(published).toMatchObject({ status: 'complete', qualified: true, runnerLatency: current.runnerLatency })

  for (const kind of ['smoke', 'incomplete'] as const) {
    const partial = structuredClone(current)
    partial.qualified = false
    if (kind === 'incomplete') {
      partial.status = 'incomplete'
      partial.failures = [{ kind: 'measurement-failed', message: 'fixture interruption' }]
    }
    const partialText = kind === 'smoke' ? renderSpeed(partial) : readSpeedEvidence(stage(partial), partial.commit)
    expect(partialText).toContain('not measured:')
    expect(partialText).toContain('Keystroke to worker')
    expect(partialText).toContain('sysctl unsupported')
  }
})
