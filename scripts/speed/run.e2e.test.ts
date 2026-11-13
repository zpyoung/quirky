import { expect, test } from 'bun:test'
import { chromium, type Browser } from 'playwright'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../speed.ts'
import { chromiumPath } from '../soak/windows.ts'

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

test.skipIf(executable === null)('runs the unqualified real-daemon smoke with ten worktrees and twenty cleaned-up sessions', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-speed-smoke-'))
  try {
    const exitCode = await main(['--out', out, '--smoke'])
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

    const attempts = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line) as { metric?: string; phase?: string; phases?: Record<string, number>; fixture?: { worktrees?: number; sessions?: string[] }; ownedPids?: number[] })
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
    const ownedPids = [...new Set(attempts.flatMap((attempt) => attempt.ownedPids ?? []))]
    expect(ownedPids.length).toBeGreaterThan(0)
    expect(ownedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid))).toBe(true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 300_000)

test.skipIf(executable === null)('keeps the real-daemon smoke complete when every animation frame has the same timestamp', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-speed-zero-frame-pacing-'))
  const originalConnect = chromium.connect
  chromium.connect = async (...args) => {
    const browser: Browser = await Reflect.apply(originalConnect, chromium, args)
    const originalNewContext = browser.newContext.bind(browser)
    browser.newContext = async (...contextArgs) => {
      const context = await originalNewContext(...contextArgs)
      await context.addInitScript(() => {
        const requestAnimationFrame = window.requestAnimationFrame
        window.requestAnimationFrame = (callback) => requestAnimationFrame.call(window, () => callback(1))
      })
      return context
    }
    return browser
  }

  try {
    const exitCode = await main(['--out', out, '--smoke'])
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
    const ownedPids = [...new Set(attempts.flatMap((attempt) => attempt.ownedPids ?? []))]
    expect(ownedPids.length).toBeGreaterThan(0)
    expect(ownedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && !isAlive(pid))).toBe(true)
  } finally {
    chromium.connect = originalConnect
    rmSync(out, { recursive: true, force: true })
  }
}, 300_000)
