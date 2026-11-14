import { expect, test } from 'bun:test'
import { measureSpeed } from './measure.ts'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../speed.ts'
import { chromiumPath } from '../soak/windows.ts'
import { METRICS, type EchoTiming, type SampleScheduler, type FrameTiming, type SpeedPair, type SpeedReport } from './contracts.ts'
import { summarizeScheduler, validateReport } from './report.ts'

const executable = chromiumPath()
if (executable === null) console.warn('Skipping speed smoke proof: Playwright Chromium is unavailable')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Attempt = {
  metric: typeof METRICS[number]
  side?: 'head' | 'base'
  phase: string
  error?: string
  durationMs?: number | null
  startedAt?: number | null
  endedAt?: number | null
  pacing: { intervalsMs: number[]; duplicateTimestamps: number; invalidTimestamps: number }
  frameTiming?: FrameTiming
  echoTiming?: EchoTiming
  scheduler?: SampleScheduler
  phases?: Record<string, number>
  fixture?: { worktrees?: number; sessions: string[]; worktreeIds: string[] }
  ownedPids?: number[]
}

function readAttempts(out: string, file: string): Attempt[] {
  return readFileSync(join(out, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function checkAttempt(row: Attempt): number {
  expect(row.durationMs).toBe(row.endedAt! - row.startedAt!)
  expect(row.pacing.intervalsMs.every(value => Number.isFinite(value) && value > 0)).toBe(true)
  expect(Number.isInteger(row.pacing.duplicateTimestamps)).toBe(true)
  if (row.metric === 'echo' || row.metric === 'floodEcho') {
    const echo = row.echoTiming!
    expect(echo).toBeDefined()
    expect(echo.receivedAt).not.toBeNull()
    expect(echo.receivedAt!).toBeGreaterThanOrEqual(row.startedAt!)
    expect(echo.receivedAt!).toBeLessThanOrEqual(row.endedAt!)
    if (echo.status === 'complete') {
      const phases = [echo.keystrokeToWorkerMs, echo.workerToPageMs, echo.pageToPaintMs]
      expect(phases.every(value => Number.isFinite(value) && value >= 0)).toBe(true)
      expect(phases.reduce((sum, value) => sum + value, 0)).toBeCloseTo(row.durationMs!, 3)
    } else {
      expect(echo.status).toBe('unavailable')
      expect(echo.reason).toBeTruthy()
      expect([echo.keystrokeToWorkerMs, echo.workerToPageMs, echo.pageToPaintMs]).toEqual([null, null, null])
    }
    const scheduler = row.scheduler!
    expect(scheduler).toBeDefined()
    if (row.metric === 'echo') expect(scheduler.floodWorker).toBeNull()
    else expect(scheduler.floodWorker).not.toBeNull()
    for (const window of [scheduler.harness, scheduler.floodWorker].filter(value => value !== null)) {
      expect(['complete', 'unavailable']).toContain(window.status)
      if (window.status === 'unavailable') expect(window).toMatchObject({ intervals: [], pendingLateAtEndMs: null })
      else expect(window.intervals.every(interval => Object.values(interval).every(Number.isFinite) && interval.lateMs >= 0)).toBe(true)
    }
  }
  expect(Number.isInteger(row.pacing.invalidTimestamps)).toBe(true)
  if (['echo', 'switch', 'floodEcho'].includes(row.metric)) {
    const timing = row.frameTiming!
    expect(timing).toBeDefined()
    expect(timing.wallMs).toBe(row.durationMs!)
    expect(timing.effectiveMs).toBeGreaterThan(0)
    expect(timing.effectiveMs).toBeLessThanOrEqual(timing.wallMs)
    expect(timing.wallMs - timing.deductionMs).toBeCloseTo(timing.effectiveMs, 9)
    if (timing.candidate) {
      const candidate = timing.candidate
      expect(candidate.requestedAt).toBeGreaterThanOrEqual(row.startedAt!)
      expect(candidate.deliveredAt).toBeLessThanOrEqual(row.endedAt!)
      expect(candidate.deliveredAt).toBeGreaterThanOrEqual(candidate.requestedAt)
      if (candidate.kind === 'application-raf') {
        expect(candidate.receiveCapAt).not.toBeNull()
        expect(candidate.requestedAt).toBeGreaterThanOrEqual(candidate.receiveCapAt!)
      }
      let busyMs = 0
      let busyEnd = candidate.requestedAt
      for (const span of [...candidate.busySpans].sort((a, b) => a.start - b.start)) {
        const start = Math.max(candidate.requestedAt, span.start, busyEnd)
        const end = Math.min(candidate.deliveredAt, span.end)
        busyMs += Math.max(0, end - start)
        busyEnd = Math.max(busyEnd, end)
      }
      const idleMs = candidate.deliveredAt - candidate.requestedAt - busyMs
      expect(timing.deductionMs).toBeCloseTo(Math.max(0, idleMs - 1000 / 60), 9)
    }
    if (timing.status === 'unavailable') {
      expect(timing).toMatchObject({ effectiveMs: timing.wallMs, deductionMs: 0, candidate: null })
      expect(timing.reason).toBeTruthy()
    } else expect(timing.status).toBe('complete')
    return timing.effectiveMs
  }
  if (row.metric === 'startup') {
    for (const phase of ['runtimePublicationMs', 'rendererNavigationAndAttachMs', 'readinessInputToPaintMs', 'postPaintVerificationMs']) {
      expect(Number.isFinite(row.phases?.[phase])).toBe(true)
      expect(row.phases![phase]!).toBeGreaterThanOrEqual(0)
    }
  }
  return row.durationMs!
}

function checkEvidence(out: string, report: SpeedReport, paired?: SpeedPair): void {
  const attempts = readAttempts(out, 'samples.jsonl')
  expect(validateReport(report)).toEqual(report)
  expect(report.profile).toMatchObject({ workloadVersion: 4, runnerPolicy: 'ci-macos-timer-experiment-v1' })
  expect(report.runnerLatency).toBeDefined()
  expect(['attempted', 'skipped', 'unavailable']).toContain(report.runnerLatency!.status)
  const pairAttempts = paired ? readAttempts(out, 'pair-samples.jsonl') : []
  const pacing = JSON.parse(readFileSync(join(out, 'diagnostics/frame-pacing.json'), 'utf8'))
  expect(pacing).toMatchObject({ version: 2, gpuCompositing: 'disabled_software' })
  for (const metric of METRICS) {
    for (const side of ['solo', 'head', 'base'] as const) {
      const rows = (side === 'solo' ? attempts : pairAttempts).filter(row =>
        row.metric === metric && (side === 'solo' || row.side === side))
      const successful = rows.filter(row => row.phase === 'sample' && !row.error && typeof row.durationMs === 'number')
      const values = successful.map(checkAttempt)
      const unavailable = successful.filter(row => row.frameTiming?.status === 'unavailable').length
      const aggregate = pacing.metrics[metric][side]
      expect(aggregate.unavailableSamples).toBe(unavailable)
      expect(aggregate.observedAttempts).toBe(successful.length)
      expect(aggregate.duplicateTimestamps).toBe(successful.reduce((sum, row) => sum + row.pacing.duplicateTimestamps, 0))
      expect(aggregate.invalidTimestamps).toBe(successful.reduce((sum, row) => sum + row.pacing.invalidTimestamps, 0))
      expect(aggregate.frames).toBe(successful.reduce((sum, row) => sum + row.pacing.intervalsMs.length, 0))
      if (side === 'solo') {
        expect(values).toEqual(report.metrics[metric].samplesMs)
        expect(successful.map(row => row.durationMs!)).toEqual(report.metrics[metric].wallSamplesMs!)
        expect(report.metrics[metric].unavailableSamples!).toBe(unavailable)
        if (metric === 'echo' || metric === 'floodEcho') {
          expect(report.metrics[metric].echoTiming!.samples).toEqual(successful.map(row => row.echoTiming!))
          expect(report.metrics[metric].scheduler).toEqual(summarizeScheduler(successful.map(row => row.scheduler)))
        }
      } else if (paired) expect(values).toEqual(paired.metrics[metric][side === 'head' ? 'headSamplesMs' : 'baseSamplesMs'])
    }
  }
  console.info(`Local smoke evidence (not runner performance): ${JSON.stringify({
    environment: report.profile,
    metrics: report.metrics,
    deductions: [...attempts, ...pairAttempts].filter(row => row.phase === 'sample').map(row =>
      ({ metric: row.metric, side: row.side ?? 'solo', frameTiming: row.frameTiming })),
    pacing,
  })}`)
}

test.skipIf(executable === null)('scenario 8: pairs real builds with a head-only seeded slowdown and cleans up both worlds', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-speed-smoke-'))
  try {
    const repoRoot = resolve(import.meta.dir, '../..')
    const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.toString().trim()
    const exitCode = await main(['--out', out, '--smoke', '--base-root', repoRoot, '--base-basis', 'parent', '--seed-echo-delay-ms', '1500'])
    expect(exitCode).toBe(0)
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as SpeedReport
    expect(report).toMatchObject({ status: 'complete', qualified: false, cleanup: 'complete' })
    expect(report.profile).toMatchObject({ workloadVersion: 4, compositor: 'software', frameTiming: 'native-final-frame-echo-arrival-cap-60hz', worktrees: 10, terminals: 20 })
    expect(report.evidence.diagnostics).toContain('diagnostics/frame-pacing.json')
    const pacing = JSON.parse(readFileSync(join(out, 'diagnostics/frame-pacing.json'), 'utf8'))
    expect(pacing.version).toBe(2)
    expect(pacing.preflight.frames).toBe(pacing.preflight.intervalsMs.length)
    expect(pacing.preflight.intervalsMs.every((value: number) => Number.isFinite(value) && value > 0)).toBe(true)
    if (pacing.preflight.frames === 0) {
      expect(pacing.preflight.error).toBeTruthy()
      for (const summary of ['medianIntervalMs', 'p90IntervalMs', 'maxIntervalMs']) expect(pacing.preflight[summary]).toBeNull()
    } else expect(pacing.preflight.error).toBeNull()
    expect(Object.values(report.metrics).map((metric) => metric.samplesMs.length)).toEqual([1, 1, 1, 1, 1])
    const pair = JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8')) as SpeedPair
    expect(pair).toMatchObject({ status: 'complete', qualified: false, head: { commit }, base: { commit, basis: 'parent' }, failures: [] })
    checkEvidence(out, report, pair)
    for (const metric of METRICS) {
      expect(pair.metrics[metric].headSamplesMs).toHaveLength(1)
      expect(pair.metrics[metric].baseSamplesMs).toHaveLength(1)
    }
    for (const metric of ['echo', 'floodEcho'] as const) {
      expect(pair.metrics[metric].headSamplesMs[0]! - pair.metrics[metric].baseSamplesMs[0]!).toBeGreaterThanOrEqual(500)
      const diagnostic = JSON.parse(readFileSync(join(out, `diagnostics/${metric}.json`), 'utf8'))
      expect(diagnostic.status).toBe('complete')
      expect(Number.isFinite(diagnostic.observation.echoTiming.receivedAt)).toBe(true)
      expect(typeof diagnostic.observation.marks.echoReceived).toBe('string')
      expect(diagnostic.observation.marks.echoReceived).not.toBe('')
    }
    const pairedAttempts = readAttempts(out, 'pair-samples.jsonl')
    for (const metric of METRICS) {
      for (const side of ['head', 'base']) expect(pairedAttempts.some(row => row.metric === metric && row.side === side)).toBe(true)
    }
    expect(pairedAttempts.filter(row => row.metric === 'startup' && row.phase === 'sample')).toHaveLength(2)
    expect(pairedAttempts.filter(row => row.metric === 'startup' && row.phase === 'warmup')).toHaveLength(0)

    const attempts = readAttempts(out, 'samples.jsonl')
    const echoes = attempts.filter((attempt) => (attempt.metric === 'echo' || attempt.metric === 'floodEcho') && attempt.phase === 'sample')
    expect(echoes).toHaveLength(2)
    for (const echo of echoes) {
      const phases = echo.phases!
      expect(Number.isFinite(phases.eventToDomMs)).toBe(true)
      expect(Number.isFinite(phases.domToPaintMs)).toBe(true)
      expect(phases.eventToDomMs).toBeGreaterThanOrEqual(0)
      expect(phases.domToPaintMs).toBeGreaterThanOrEqual(0)
      expect(phases.eventToDomMs! + phases.domToPaintMs!).toBeCloseTo(phases.browserEventToPaintMs!, 3)
    }
    const startup = attempts.filter((attempt) => attempt.metric === 'startup' && attempt.phase === 'sample')
    expect(attempts.filter((attempt) => attempt.metric === 'startup' && attempt.phase === 'warmup')).toHaveLength(0)
    expect(startup).toHaveLength(1)
    expect(startup[0]!.fixture).toMatchObject({ worktrees: 10 })
    expect(new Set(startup[0]!.fixture?.sessions).size).toBe(20)
    const pairedHeadStartup = pairedAttempts.find((attempt) => attempt.metric === 'startup' && attempt.phase === 'sample' && attempt.side === 'head')
    expect(pairedHeadStartup).toBeDefined()
    const soloFixture = startup[0]!.fixture!
    const pairedHeadFixture = pairedHeadStartup!.fixture!
    expect(pairedHeadFixture.sessions).toHaveLength(20)
    expect(pairedHeadFixture.worktreeIds).toHaveLength(10)
    expect(pairedHeadFixture.sessions.some((id) => soloFixture.sessions.includes(id))).toBe(false)
    expect(pairedHeadFixture.worktreeIds.some((id) => soloFixture.worktreeIds.includes(id))).toBe(false)
    console.info(`Paired startup evidence: ${JSON.stringify({
      seedEchoDelayMs: 1500,
      headMs: pair.metrics.startup.headSamplesMs[0],
      baseMs: pair.metrics.startup.baseSamplesMs[0],
      headPhases: pairedHeadStartup!.phases,
      basePhases: pairedAttempts.find(row => row.metric === 'startup' && row.phase === 'sample' && row.side === 'base')?.phases,
    })}`)
    const ownedPids = [...new Set([...attempts, ...pairedAttempts].flatMap((attempt) => attempt.ownedPids ?? []))]
    expect(ownedPids.length).toBeGreaterThan(0)
    expect(ownedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid))).toBe(true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 450_000)

test.skipIf(executable === null)('scenario 10: keeps the solo smoke complete on failed base setup and zero frame intervals', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-speed-zero-frame-pacing-'))

  try {
    const exitCode = await main(
      ['--out', out, '--smoke', '--base-root', import.meta.dir, '--base-basis', 'parent'],
      options => measureSpeed({ ...options, frameTimestamp: 1 }),
    )
    expect(exitCode).toBe(0)
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as SpeedReport
    expect(report).toMatchObject({ status: 'complete', qualified: false, cleanup: 'complete' })
    expect(report.failures).toEqual([])
    const pair = JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8')) as SpeedPair
    expect(pair).toMatchObject({ status: 'incomplete', qualified: false })
    expect(pair.failures[0]?.kind).toBe('pair-setup-failed')
    expect(report.evidence.diagnostics).toContain('diagnostics/frame-pacing.json')
    expect(Object.values(report.metrics).map((metric) => metric.samplesMs.length)).toEqual([1, 1, 1, 1, 1])

    const pacing = JSON.parse(readFileSync(join(out, 'diagnostics/frame-pacing.json'), 'utf8'))
    expect(pacing).toMatchObject({
      version: 2, gpuCompositing: 'disabled_software',
      preflight: {
        frames: 0, intervalsMs: [], duplicateTimestamps: 119, invalidTimestamps: 0,
        medianIntervalMs: null, p90IntervalMs: null, maxIntervalMs: null,
      },
    })
    expect(pacing.preflight.error).toBeTruthy()
    checkEvidence(out, report)

    const attempts = readAttempts(out, 'samples.jsonl')
    const echoes = attempts.filter((attempt) => (attempt.metric === 'echo' || attempt.metric === 'floodEcho') && attempt.phase === 'sample')
    expect(echoes).toHaveLength(2)
    for (const echo of echoes) {
      const phases = echo.phases!
      expect(Number.isFinite(phases.eventToDomMs)).toBe(true)
      expect(Number.isFinite(phases.domToPaintMs)).toBe(true)
      expect(phases.eventToDomMs).toBeGreaterThanOrEqual(0)
      expect(phases.domToPaintMs).toBeGreaterThanOrEqual(0)
      expect(phases.eventToDomMs! + phases.domToPaintMs!).toBeCloseTo(phases.browserEventToPaintMs!, 3)
    }
    const pairedHeadPids = ['daemon.pid', 'browser.pid'].map((name) =>
      Number(readFileSync(join(out, 'pair-head', name), 'utf8').trim())
    )
    expect(pairedHeadPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid))).toBe(true)
    const ownedPids = [...new Set([...attempts.flatMap((attempt) => attempt.ownedPids ?? []), ...pairedHeadPids])]
    expect(ownedPids.length).toBeGreaterThan(0)
    expect(ownedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid))).toBe(true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 300_000)

test('scenario 9: invalid paired options refuse before creating evidence or starting a daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-speed-invalid-'))
  const write = process.stderr.write
  let error = ''
  process.stderr.write = ((chunk: string | Uint8Array) => { error += String(chunk); return true }) as typeof write
  try {
    const out = join(root, 'out')
    const cases = [
      { args: ['--base-root', root, '--base-basis', 'parent', '--seed-echo-delay-ms', '1500'], reason: '--seed-echo-delay-ms requires --smoke and --base-root' },
      { args: ['--smoke', '--seed-echo-delay-ms', '1500'], reason: '--seed-echo-delay-ms requires --smoke and --base-root' },
      { args: ['--smoke', '--base-root', root], reason: '--base-root and --base-basis go together; basis is merge-base or parent' },
      { args: ['--smoke', '--base-basis', 'parent'], reason: '--base-root and --base-basis go together; basis is merge-base or parent' },
      { args: ['--smoke', '--base-root', root, '--base-basis', 'tip'], reason: '--base-root and --base-basis go together; basis is merge-base or parent' },
      { args: ['--smoke', '--base-root', root, '--base-basis', 'parent', '--seed-echo-delay-ms', '2001'], reason: '--seed-echo-delay-ms must be an integer from 1 to 2000' },
    ]
    for (const { args, reason } of cases) {
      error = ''
      expect(await main(['--out', out, ...args])).toBe(2)
      expect(error).toContain(reason)
      expect(existsSync(out)).toBe(false)
    }
  } finally {
    process.stderr.write = write
    rmSync(root, { recursive: true, force: true })
  }
})
