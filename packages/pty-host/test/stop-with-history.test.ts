import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, type CreateParams, type SessionManagerOptions } from '../src/session'
import {
  heldRunner,
  onCleanup,
  recordProcessKillTargets,
  runCleanups,
  scopeForHome,
  tempHome,
  trackSessionProcesses,
  waitFor
} from './helpers'

afterEach(runCleanups)

const ENV = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
const shell = (script: string) => ['/bin/sh', '-c', script]

function createParams(sessionId: string, cwd: string, script: string): CreateParams {
  return { sessionId, cwd, argv: shell(script), env: ENV, cols: 80, rows: 24 }
}

function managerFor(home = tempHome(), options: Partial<SessionManagerOptions> = {}): SessionManager {
  const manager = new SessionManager({ home, ...options })
  trackSessionProcesses(manager, scopeForHome(home))
  onCleanup(() => manager.shutdown())
  return manager
}

describe('stop with history', () => {
  test('stops the root and descendants, retains output, and restores the same history', async () => {
    const home = tempHome()
    const pidFile = join(home, 'child.pid')
    const manager = managerFor(home)
    const expectedOutput = ['SLEEP_HISTORY_MARKER', ...Array.from({ length: 30 }, (_, i) => `history-row-${i}`), 'SLEEP_LIVE_MARKER']
    // history() excludes the 24-row live screen; scroll the first marker off it.
    // Keep a separate visible marker to verify that stop/restore preserves both surfaces.
    const root = await manager.create(
      createParams('sleep-history', '/tmp', `printf 'SLEEP_HISTORY_MARKER\\n'; i=0; while [ "$i" -lt 30 ]; do printf 'history-row-%s\\n' "$i"; i=$((i + 1)); done; printf 'SLEEP_LIVE_MARKER'; (exec sleep 600) & echo $! > '${pidFile}'; wait`)
    )
    await waitFor(() => existsSync(pidFile), 5000, 'descendant pid')
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    await waitFor(async () => (await manager.history('sleep-history')).lines.some((line) => line.includes('SLEEP_HISTORY_MARKER')), 5000, 'history output')
    await waitFor(async () => (await manager.snapshot('sleep-history')).ansi.includes('SLEEP_LIVE_MARKER'), 5000, 'live screen output')

    await manager.stopWithHistory('sleep-history')

    expect((await manager.list()).find((entry) => entry.sessionId === 'sleep-history')).toMatchObject({ state: 'restorable', alive: false })
    expect(() => process.kill(root.pid, 0)).toThrow()
    expect(() => process.kill(childPid, 0)).toThrow()
    expect((await manager.history('sleep-history')).lines).toContain('SLEEP_HISTORY_MARKER')
    expect((await manager.read('sleep-history', 200)).lines).toEqual(expectedOutput)
    expect((await manager.snapshot('sleep-history')).ansi).toContain('SLEEP_LIVE_MARKER')
    const restored = await manager.create({ ...createParams('sleep-history', '/tmp', 'sleep 600'), restore: true })
    expect(restored.restored).toBe(true)
    expect((await manager.history('sleep-history')).lines).toContain('SLEEP_HISTORY_MARKER')
    expect((await manager.read('sleep-history', 200)).lines).toEqual(expectedOutput)
    expect((await manager.snapshot('sleep-history')).ansi).toContain('SLEEP_LIVE_MARKER')
  })

  test('escalates a descendant that ignores the graceful stop before reporting success', async () => {
    const home = tempHome()
    const pidFile = join(home, 'stubborn.pid')
    const manager = managerFor(home)
    await manager.create(
      createParams('sleep-stubborn', '/tmp', `(/bin/sh -c 'trap "" TERM; exec sleep 600') & echo $! > '${pidFile}'; wait`)
    )
    await waitFor(() => existsSync(pidFile), 5000, 'stubborn descendant pid')
    const childPid = Number(readFileSync(pidFile, 'utf8'))

    await manager.stopWithHistory('sleep-stubborn')

    expect(() => process.kill(childPid, 0)).toThrow()
    expect((await manager.list()).find((entry) => entry.sessionId === 'sleep-stubborn')).toMatchObject({ state: 'restorable', alive: false })
  })

  test('S14: stops a job in its own process group before retaining history', async () => {
    const home = tempHome()
    const pidFile = join(home, 'job.pid')
    const manager = managerFor(home)
    const root = await manager.create(
      createParams('sleep-job', '/tmp', `set -m; sleep 7777 & echo bg=$!; echo $! > '${pidFile}'; wait`)
    )
    await waitFor(() => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null, 5000, 'job pid')
    const jobPid = Number(readFileSync(pidFile, 'utf8'))

    await manager.stopWithHistory('sleep-job')

    expect(() => process.kill(root.pid, 0)).toThrow()
    expect(() => process.kill(jobPid, 0)).toThrow()
    expect((await manager.list()).find((session) => session.sessionId === 'sleep-job')).toMatchObject({
      state: 'restorable',
      exitCause: 'stopped'
    })
  })

  test('S15: stops requested in one turn share one scan before any signal', async () => {
    const home = tempHome()
    const scans = heldRunner({ hold: true })
    const kills = recordProcessKillTargets()
    const manager = managerFor(home, { processRunner: scans.runner })
    const jobs: Array<{ sessionId: string; rootPid: number; jobPid: number }> = []
    for (let i = 0; i < 4; i++) {
      const sessionId = `storm-${i}`
      const pidFile = join(home, `${sessionId}.pid`)
      const root = await manager.create(
        createParams(sessionId, '/tmp', `set -m; sleep 7777 & echo bg=$!; echo $! > '${pidFile}'; wait`)
      )
      await waitFor(() => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null, 5000, `${sessionId} job pid`)
      jobs.push({ sessionId, rootPid: root.pid, jobPid: Number(readFileSync(pidFile, 'utf8')) })
    }

    const stopping = jobs.map(({ sessionId }) => manager.stopWithHistory(sessionId))
    const allStopped = Promise.all(stopping)
    await waitFor(() => scans.calls.length === 1 || null, 5000, 'first held stop scan')
    expect(scans.calls).toHaveLength(1)
    expect(scans.inFlight).toBe(1)
    for (const job of jobs) {
      expect(() => process.kill(job.rootPid, 0)).not.toThrow()
      expect(() => process.kill(job.jobPid, 0)).not.toThrow()
    }
    expect(kills.targets.filter((target) => target.signal !== 0)).toEqual([])

    const startedAt = Date.now()
    try {
      scans.release()
      await allStopped
    } finally {
      scans.release()
      await Promise.allSettled(stopping)
      kills.restore()
    }
    const elapsedMs = Date.now() - startedAt

    expect(scans.highestInFlight).toBe(1)
    expect(scans.calls.length).toBeLessThanOrEqual(Math.ceil(elapsedMs / 50) + 8)
    for (const job of jobs) {
      expect(() => process.kill(job.rootPid, 0)).toThrow()
      expect(() => process.kill(job.jobPid, 0)).toThrow()
    }
    expect((await manager.list()).filter((session) => session.state === 'restorable')).toHaveLength(4)
  })
})
