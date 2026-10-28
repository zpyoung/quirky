import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, type CreateParams, type SessionManagerOptions } from '../src/session'
import { onCleanup, runCleanups, scopeForHome, tempHome, trackSessionProcesses, waitFor } from './helpers'

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
    await manager.create(
      createParams('sleep-history', '/tmp', `printf 'SLEEP_HISTORY_MARKER\\n'; (exec sleep 600) & echo $! > '${pidFile}'; wait`)
    )
    await waitFor(() => existsSync(pidFile), 5000, 'descendant pid')
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    await waitFor(async () => (await manager.history('sleep-history')).lines.some((line) => line.includes('SLEEP_HISTORY_MARKER')), 5000, 'history output')

    await manager.stopWithHistory('sleep-history')

    expect(manager.list().find((entry) => entry.sessionId === 'sleep-history')).toMatchObject({ state: 'restorable', alive: false })
    expect(() => process.kill(childPid, 0)).toThrow()
    expect((await manager.history('sleep-history')).lines.join('\n')).toContain('SLEEP_HISTORY_MARKER')
    const restored = await manager.create({ ...createParams('sleep-history', '/tmp', 'sleep 600'), restore: true })
    expect(restored.restored).toBe(true)
    expect((await manager.history('sleep-history')).lines.join('\n')).toContain('SLEEP_HISTORY_MARKER')
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
    expect(manager.list().find((entry) => entry.sessionId === 'sleep-stubborn')).toMatchObject({ state: 'restorable', alive: false })
  })
})
