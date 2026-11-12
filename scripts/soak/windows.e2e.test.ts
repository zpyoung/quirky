import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main } from '../soak.ts'
import type { Sample, SoakReport } from './contracts.ts'
import { windowAlive } from './verdict.ts'
import { chromiumPath, openWindows, type SoakWindows } from './windows.ts'
import { startWorld, type SoakWorld } from './world.ts'

const executable = chromiumPath()
if (executable === null) console.warn('Skipping soak window proof: run bunx playwright install chromium')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(executable === null)('measures two real renderer windows without counting browser processes and cleans up', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-windows-'))
  try {
    await main(['--minutes', '0.4', '--out', out, '--windows', '2'])
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(report.config.windows).toBe(2)
    expect(report.checks.windows).toEqual({ ok: true, expected: 2, alive: 2, lost: [] })
    expect(report.disqualified).toContain('ran 0.4 minutes, needs 30')
    expect(report.disqualified.some((reason) => reason.includes('windows connected'))).toBe(false)
    expect(report.windows).toHaveLength(2)
    expect(report.windows[0]!.worktree).not.toBe(report.windows[1]!.worktree)
    expect(report.windows[0]!.connId).not.toBe(report.windows[1]!.connId)
    for (const record of report.windows) {
      expect(record.open).toBe(true)
      expect(record.shown).toBe(true)
      expect(record.requests).toBeGreaterThanOrEqual(10)
      expect(record.sockets).toBeGreaterThanOrEqual(1)
    }
    expect(report.windowRequests.find(({ method }) => method === 'quirky.git/status')?.total).toBeGreaterThanOrEqual(6)
    const browserPid = Number(readFileSync(join(out, 'browser.pid'), 'utf8').trim())
    const daemonPid = Number(readFileSync(join(out, 'daemon.pid'), 'utf8').trim())
    const samples = readFileSync(join(out, 'samples.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Sample)
    for (const sample of samples) {
      for (const row of sample.owned) {
        expect(row.pid).not.toBe(browserPid)
        expect(row.ppid).not.toBe(browserPid)
      }
    }
    expect(isAlive(browserPid)).toBe(false)
    expect(isAlive(daemonPid)).toBe(false)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 240_000)

test.skipIf(executable === null)('marks a closed window lost while the other renderer keeps polling', async () => {
  const out = mkdtempSync(join(tmpdir(), 'quirky-soak-window-loss-'))
  let world: SoakWorld | undefined
  let windows: SoakWindows | undefined
  try {
    world = await startWorld({ out, repoRoot: resolve(import.meta.dir, '../..'), windows: 2 })
    windows = await openWindows({ world, count: 2, executable: executable!, out, signal: new AbortController().signal })
    await windows.pages[0]!.context().close()
    // real renderer sockets and daemon disconnects cannot advance on fake timers
    await Bun.sleep(1000)
    const result = await windows.finish()
    expect(result.records[0]!.open).toBe(false)
    expect(windowAlive(result.records[0]!)).toBe(false)
    expect(result.records[1]!.open).toBe(true)
    expect(result.records[1]!.shown).toBe(true)
    expect(windowAlive(result.records[1]!)).toBe(true)
  } finally {
    try {
      await windows?.stop()
    } finally {
      await world?.stop()
      rmSync(out, { recursive: true, force: true })
    }
  }
}, 240_000)
