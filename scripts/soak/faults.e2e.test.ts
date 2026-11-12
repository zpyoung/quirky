import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../soak.ts'
import type { FaultCheck, FaultKind, Sample, SoakReport } from './contracts.ts'

const FAULT_CHECK: Record<FaultKind, FaultCheck> = {
  leak: 'children',
  zombies: 'zombies',
  storm: 'events',
  block: 'stalls'
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lastSample(path: string): Sample {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as Sample
}

async function runFault(kind: FaultKind): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), `quirky-soak-fault-${kind}-`))
  try {
    const code = await main(['--minutes', '0.4', '--out', out, '--fault', kind])
    const report = JSON.parse(readFileSync(join(out, 'soak-report.json'), 'utf8')) as SoakReport
    expect(code).toBe(1)
    expect(report.verdict).toBe('fail')
    expect(report.qualifies).toBe(false)
    expect(report.disqualified).toContain(`fault injected: ${kind}`)

    expect(report.fault).not.toBeNull()
    if (report.fault === null) throw new Error(`missing ${kind} fault record`)
    const fault = report.fault
    expect(fault.kind).toBe(kind)
    expect(fault.check).toBe(FAULT_CHECK[kind])
    expect(fault.at).toBeGreaterThanOrEqual(2)
    expect(fault.at).toBeLessThanOrEqual(6)
    console.log(`fault ${kind}`, report.checks[fault.check])

    const daemonPid = Number(readFileSync(join(out, 'daemon.pid'), 'utf8').trim())
    expect(daemonPid).toBe(report.daemon.pid)
    expect(isAlive(daemonPid)).toBe(false)
    expect(fault.detail.pids.every((pid) => !isAlive(pid))).toBe(true)

    if (kind === 'leak') {
      const check = report.checks.children
      expect(check.ok).toBe(false)
      expect(check.peak).toBeGreaterThanOrEqual(61)
      expect(check.growth).toBeGreaterThan(5)
      expect(fault.detail.pids.length).toBeGreaterThanOrEqual(61)
      const ownedPids = new Set(lastSample(join(out, 'samples.jsonl')).owned.map(({ pid }) => pid))
      expect(fault.detail.pids.filter((pid) => ownedPids.has(pid)).length).toBeGreaterThanOrEqual(61)
    } else if (kind === 'zombies') {
      const check = report.checks.zombies
      expect(check.ok).toBe(false)
      expect(check.persistent).toBeGreaterThanOrEqual(10)
      expect(fault.detail.pids).toHaveLength(2)
      const holderPids = new Set(fault.detail.pids)
      const zombieRows = lastSample(join(out, 'samples.jsonl')).owned.filter(
        ({ ppid, state }) => state.startsWith('Z') && holderPids.has(ppid)
      )
      expect(zombieRows.length).toBeGreaterThanOrEqual(10)
    } else if (kind === 'storm') {
      const check = report.checks.events
      expect(check.ok).toBe(false)
      expect(check.peakType).toBe('soak.faults/changed')
      expect(check.peakPer5s).toBeGreaterThan(30)
      expect(fault.detail.refreshes).toBeGreaterThan(30)
    } else {
      const check = report.checks.stalls
      expect(check.ok).toBe(false)
      expect(check.stalls).toBeGreaterThanOrEqual(1)
      expect(check.maxMs).toBeGreaterThanOrEqual(2_000)
      expect(check.daemonExited).toBe(false)
      expect(fault.detail.blockedMs).toBeGreaterThanOrEqual(2_900)
      expect(check.worst.some(({ at, ms }) =>
        ms >= 2_000 && at >= fault.at - 1 && at <= fault.at + 4
      )).toBe(true)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

test('detects the injected child leak and cleans up its processes', async () => {
  await runFault('leak')
}, 180_000)

test('detects the injected zombies and cleans up their holders', async () => {
  await runFault('zombies')
}, 180_000)

test('detects the injected event storm', async () => {
  await runFault('storm')
}, 180_000)

test('detects the injected event-loop block', async () => {
  await runFault('block')
}, 180_000)
