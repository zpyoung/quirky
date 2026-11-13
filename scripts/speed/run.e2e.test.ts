import { expect, test } from 'bun:test'
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
      profile: { worktrees: number; terminals: number }
      metrics: Record<string, { samplesMs: number[] }>
    }
    expect(report).toMatchObject({ status: 'complete', qualified: false, cleanup: 'complete' })
    expect(report.profile).toMatchObject({ worktrees: 10, terminals: 20 })
    expect(Object.values(report.metrics).map((metric) => metric.samplesMs.length)).toEqual([1, 1, 1, 1, 1])

    const attempts = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line) as { metric?: string; phase?: string; fixture?: { worktrees?: number; sessions?: string[] }; ownedPids?: number[] })
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
