import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOME_LOST, SessionManager, type CreateParams, type SessionManagerOptions } from '../src/session'
import { claimHome } from '../src/ownership'
import { groupGone, heldRunner, onCleanup, runCleanups, scopeForHome, tempHome, trackSessionProcesses, waitFor } from './helpers'

afterEach(runCleanups)

const ENV = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
const dirOf = (home: string, sessionId: string) => join(home, 'sessions', sessionId)
const params = (sessionId: string, script = 'sleep 600'): CreateParams => ({
  sessionId,
  cwd: '/tmp',
  argv: ['/bin/sh', '-c', script],
  env: ENV,
  cols: 80,
  rows: 24
})

function managerFor(home: string, options: Partial<SessionManagerOptions> = {}): SessionManager {
  const manager = new SessionManager({ home, ...options })
  trackSessionProcesses(manager, scopeForHome(home))
  onCleanup(() => manager.shutdown())
  return manager
}

function ownedManager(home: string, options: Partial<SessionManagerOptions> = {}): SessionManager {
  const claim = claimHome(home)
  return managerFor(home, { ...options, ownsHome: () => claim.check() === null })
}

function filesUnder(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.set(path.slice(root.length + 1), readFileSync(path).toString('hex'))
    }
  }
  visit(root)
  return files
}

async function waitForGroupGone(pid: number, what: string): Promise<void> {
  await waitFor(() => {
    try {
      return groupGone(pid)
    } catch (error) {
      // On Darwin, EPERM can be transient while a killed, zombie-only group is reaped.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
      throw error
    }
  }, 5000, what)
}

describe('session manager home guard', () => {
  test('homeLost disables logs, preserves files, and rejects every request that writes paths', async () => {
    const home = tempHome()
    const manager = ownedManager(home, { checkpointIntervalMs: 50 })
    const { pid } = await manager.create(params('s1', 'while :; do echo x; sleep 0.05; done'))
    const sessionDir = dirOf(home, 's1')
    await waitFor(
      () => existsSync(join(sessionDir, 'checkpoint.json')) && existsSync(join(sessionDir, 'meta.json')),
      5000,
      'checkpoint and metadata'
    )

    manager.homeLost()
    const before = filesUnder(home)
    // A real interval and child output exercise pending scheduler and fd writes after homeLost().
    await Bun.sleep(300)
    expect(filesUnder(home)).toEqual(before)

    await expect(manager.create(params('s2'))).rejects.toThrow(HOME_LOST)
    await expect(manager.clear('s1')).rejects.toThrow(HOME_LOST)
    await expect(manager.resetModes('s1')).rejects.toThrow(HOME_LOST)
    await expect(manager.forget('s1')).rejects.toThrow(HOME_LOST)
    await expect(manager.stopWithHistory('s1')).rejects.toThrow(HOME_LOST)
    expect(existsSync(dirOf(home, 's2'))).toBe(false)
    expect(existsSync(sessionDir)).toBe(true)

    await manager.shutdown()
    await waitForGroupGone(pid, 'session process group to stop')
    expect(filesUnder(home)).toEqual(before)
  }, 20000)

  test('create in a deleted home does not recreate it and disables existing log appends', async () => {
    const home = tempHome()
    const manager = ownedManager(home)
    await manager.create(params('s1', 'while :; do echo x; sleep 0.05; done'))
    const output = join(dirOf(home, 's1'), 'output.log')
    await waitFor(() => statSync(output).size > 25, 5000, 'session output')

    const observer = `${home}.observed-output.log`
    linkSync(output, observer)
    onCleanup(() => rmSync(observer, { force: true }))
    const before = readFileSync(observer)
    rmSync(home, { recursive: true, force: true })

    await expect(manager.create(params('s2'))).rejects.toThrow(HOME_LOST)
    // The live shell keeps writing to the fd; the hard link detects any append to the unlinked inode.
    await Bun.sleep(250)

    expect(existsSync(home)).toBe(false)
    expect(existsSync(dirOf(home, 's2'))).toBe(false)
    expect(readFileSync(observer)).toEqual(before)
    await manager.shutdown()
  }, 20000)

  test('forget cannot remove a replacement session after its process-table await', async () => {
    const home = tempHome()
    const held = heldRunner({ hold: true })
    const managerA = ownedManager(home, { processRunner: held.runner })
    onCleanup(() => held.release())
    const { pid } = await managerA.create(params('s1', 'exec /bin/sleep 600'))
    expect(pid).toBeGreaterThan(0)
    await waitFor(() => {
      const command = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='])
      return command.exitCode === 0 && command.stdout.toString().trim().endsWith('sleep')
    }, 5000, 'session process to exec')
    const forgetting = managerA.forget('s1')
    void forgetting.catch(() => {})
    await waitFor(() => held.inFlight > 0, 5000, 'forget process-table scan')

    const moved = `${home}.moved`
    renameSync(home, moved)
    onCleanup(() => rmSync(moved, { recursive: true, force: true }))
    mkdirSync(home, { recursive: true, mode: 0o700 })
    onCleanup(() => rmSync(home, { recursive: true, force: true }))
    const managerB = managerFor(home)
    await managerB.create(params('s1'))

    held.release()
    await expect(forgetting).rejects.toThrow(HOME_LOST)
    await waitForGroupGone(pid, 'old session process group to stop')
    expect(existsSync(dirOf(home, 's1'))).toBe(true)
    expect(managerB.isAlive('s1')).toBe(true)
  }, 20000)

  test('stopWithHistory cannot rewrite replacement metadata after its process-table awaits', async () => {
    const home = tempHome()
    const held = heldRunner({ hold: true })
    const managerA = ownedManager(home, { processRunner: held.runner })
    onCleanup(() => held.release())
    const { pid } = await managerA.create(params('s1', 'exec /bin/sleep 600'))
    expect(pid).toBeGreaterThan(0)
    await waitFor(() => {
      const command = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='])
      return command.exitCode === 0 && command.stdout.toString().trim().endsWith('sleep')
    }, 5000, 'session process to exec')
    const stopping = managerA.stopWithHistory('s1')
    void stopping.catch(() => {})
    await waitFor(() => held.inFlight > 0, 5000, 'stop process-table scan')

    const moved = `${home}.moved`
    renameSync(home, moved)
    onCleanup(() => rmSync(moved, { recursive: true, force: true }))
    mkdirSync(home, { recursive: true, mode: 0o700 })
    onCleanup(() => rmSync(home, { recursive: true, force: true }))
    const managerB = managerFor(home)
    await managerB.create(params('s1'))
    const replacementMeta = readFileSync(join(dirOf(home, 's1'), 'meta.json'))

    held.release()
    await expect(stopping).rejects.toThrow(HOME_LOST)
    await waitForGroupGone(pid, 'old session process group to stop')
    expect(managerB.isAlive('s1')).toBe(true)
    expect(readFileSync(join(dirOf(home, 's1'), 'meta.json'))).toEqual(replacementMeta)
  }, 20000)
})
