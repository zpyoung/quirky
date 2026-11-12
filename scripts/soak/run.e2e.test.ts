import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../soak.ts'
import type { Sample, SoakReport } from './contracts.ts'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('measures real workers, hooks, processes and probes and cleans up its daemon', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-e2e-'))
  try {
    const code = await main(['--minutes', '0.4', '--out', out, '--max-children', '1'])
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(code).toBe(1)
    expect(report.verdict).toBe('fail')
    expect(report.durationSeconds).toBeGreaterThanOrEqual(24)
    expect(report.durationSeconds).toBeLessThanOrEqual(40)
    expect(report.qualifies).toBe(false)
    expect(report.config.worktrees).toBe(7)
    expect(report.config.workers).toBe(7)
    expect(report.checks.children.ok).toBe(false)
    expect(report.checks.children.peak).toBeGreaterThanOrEqual(7)
    expect(report.checks.workers).toEqual({ ok: true, expected: 7, alive: 7, stale: [] })
    expect(report.checks.stalls.probes).toBeGreaterThanOrEqual(40)
    expect(report.checks.stalls.daemonExited).toBe(false)
    expect(report.checks.events.total).toBeGreaterThanOrEqual(1)
    expect(report.checks.events.byType.some(({ type }) => type === 'quirky.agent-status/changed')).toBe(true)
    expect(report.disqualified).toContain('ran 0.4 minutes, needs 30')
    expect(report.disqualified).toContain('0 windows connected, needs 2')
    expect(report.disqualified.some((reason) => reason.startsWith('limit loosened'))).toBe(false)
    const samples = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Sample)
    expect(samples.length).toBeGreaterThanOrEqual(20)
    for (const sample of samples) {
      expect(Number.isFinite(sample.at)).toBe(true)
      expect(Array.isArray(sample.owned)).toBe(true)
      expect(sample.daemonRssKb === null || Number.isFinite(sample.daemonRssKb)).toBe(true)
    }
    expect(existsSync(join(out, 'daemon.log'))).toBe(true)
    const pid = Number(readFileSync(join(out, 'daemon.pid'), 'utf8').trim())
    expect(pid).toBe(report.daemon.pid)
    expect(isAlive(pid)).toBe(false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 180_000)
