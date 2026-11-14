import { expect, test } from 'bun:test'
import { measureSpeed } from './measure.ts'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../speed.ts'
import { chromiumPath } from '../soak/windows.ts'
import { METRICS, type SpeedPair } from './contracts.ts'

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

test.skipIf(executable === null)('scenario 8: pairs real builds with a head-only seeded slowdown and cleans up both worlds', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-speed-smoke-'))
  try {
    const repoRoot = resolve(import.meta.dir, '../..')
    const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.toString().trim()
    const exitCode = await main(['--out', out, '--smoke', '--base-root', repoRoot, '--base-basis', 'parent', '--seed-echo-delay-ms', '1500'])
    expect(exitCode).toBe(0)
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as {
      status: string
      qualified: boolean
      cleanup: string
      profile: { workloadVersion: number; compositor: string; worktrees: number; terminals: number }
      evidence: { diagnostics: string[] }
      metrics: Record<string, { samplesMs: number[] }>
    }
    expect(report).toMatchObject({ status: 'complete', qualified: false, cleanup: 'complete' })
    expect(report.profile).toMatchObject({ workloadVersion: 2, compositor: 'software', worktrees: 10, terminals: 20 })
    expect(report.evidence.diagnostics).toContain('diagnostics/frame-pacing.json')
    const pacing = JSON.parse(readFileSync(join(out, 'diagnostics/frame-pacing.json'), 'utf8'))
    expect(pacing).toEqual({
      version: 1, frames: 60, gpuCompositing: 'disabled_software',
      medianIntervalMs: expect.any(Number), p90IntervalMs: expect.any(Number), maxIntervalMs: expect.any(Number),
      intervalsMs: expect.any(Array)
    })
    expect(pacing.intervalsMs).toHaveLength(60)
    for (const interval of pacing.intervalsMs) {
      expect(Number.isFinite(interval)).toBe(true)
      expect(interval).toBeGreaterThan(0)
    }
    for (const interval of [pacing.medianIntervalMs, pacing.p90IntervalMs, pacing.maxIntervalMs]) {
      expect(Number.isFinite(interval)).toBe(true)
      expect(interval).toBeGreaterThan(0)
    }
    expect(Object.values(report.metrics).map((metric) => metric.samplesMs.length)).toEqual([1, 1, 1, 1, 1])
    const pair = JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8')) as SpeedPair
    expect(pair).toMatchObject({ status: 'complete', qualified: false, head: { commit }, base: { commit, basis: 'parent' }, failures: [] })
    for (const metric of METRICS) {
      expect(pair.metrics[metric].headSamplesMs).toHaveLength(1)
      expect(pair.metrics[metric].baseSamplesMs).toHaveLength(1)
    }
    for (const metric of ['echo', 'floodEcho'] as const) {
      expect(pair.metrics[metric].headSamplesMs[0]! - pair.metrics[metric].baseSamplesMs[0]!).toBeGreaterThanOrEqual(500)
    }
    const pairedAttempts = readFileSync(join(out, 'pair-samples.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as { metric: string; side: string; phase: string; phases?: Record<string, number>; fixture?: { sessions: string[]; worktreeIds: string[] }; ownedPids?: number[] })
    for (const metric of METRICS) {
      for (const side of ['head', 'base']) expect(pairedAttempts.some(row => row.metric === metric && row.side === side)).toBe(true)
    }
    expect(pairedAttempts.filter(row => row.metric === 'startup' && row.phase === 'sample')).toHaveLength(2)
    expect(pairedAttempts.filter(row => row.metric === 'startup' && row.phase === 'warmup')).toHaveLength(0)

    const attempts = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line) as { metric?: string; phase?: string; phases?: Record<string, number>; fixture?: { worktrees?: number; sessions: string[]; worktreeIds: string[] }; ownedPids?: number[] })
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
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as {
      status: string
      qualified: boolean
      cleanup: string
      failures: unknown[]
      evidence: { diagnostics: string[] }
      metrics: Record<string, { samplesMs: number[] }>
    }
    expect(report).toMatchObject({ status: 'complete', qualified: false, cleanup: 'complete' })
    expect(report.failures).toEqual([])
    const pair = JSON.parse(readFileSync(join(out, 'pair.json'), 'utf8')) as SpeedPair
    expect(pair).toMatchObject({ status: 'incomplete', qualified: false })
    expect(pair.failures[0]?.kind).toBe('pair-setup-failed')
    expect(report.evidence.diagnostics).toContain('diagnostics/frame-pacing.json')
    expect(Object.values(report.metrics).map((metric) => metric.samplesMs.length)).toEqual([1, 1, 1, 1, 1])

    const pacing = JSON.parse(readFileSync(join(out, 'diagnostics/frame-pacing.json'), 'utf8')) as {
      version: number
      frames: number
      gpuCompositing: string
      intervalsMs: number[]
      error: string
    }
    expect(pacing).toMatchObject({
      version: 1,
      frames: 60,
      gpuCompositing: 'disabled_software',
      intervalsMs: Array.from({ length: 60 }, () => 0)
    })
    expect(pacing.error).toMatch(/^frame pacing needs positive finite intervals/)
    expect(pacing.error).toContain(JSON.stringify(pacing.intervalsMs))
    for (const summary of ['medianIntervalMs', 'p90IntervalMs', 'maxIntervalMs']) {
      expect(pacing).not.toHaveProperty(summary)
    }

    const attempts = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line) as { metric?: string; phase?: string; phases?: Record<string, number>; ownedPids?: number[] })
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
