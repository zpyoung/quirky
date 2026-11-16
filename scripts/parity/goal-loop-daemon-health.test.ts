import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import * as protocol from '@quirky/protocol/node'
import { createGoalLoopWorld } from './goal-loop-world'

function resume(pid: number): void {
  try { process.kill(pid, 'SIGCONT') } catch {}
}

test('goal-loop readiness is settled and CLI guards wait for transient but not permanent stalls', async () => {
  let readyObserved = false
  const world = await createGoalLoopWorld({ deadline: Date.now() + 120_000, hooks: {
    afterReady: async (ready) => {
      expect(await protocol.readDaemonHealth(protocol.readRuntime(ready.root), 1_500)).toMatchObject({
        pid: ready.daemonPid, startupSettled: true
      })
      readyObserved = true
    }
  } })
  let daemonPid: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await world.start()
    daemonPid = world.daemonPid
    expect(readyObserved).toBe(true)
    // real OS process stalls cannot be resumed by a fake clock
    process.kill(daemonPid, 'SIGSTOP')
    timer = setTimeout(() => resume(world.daemonPid), 1_000)
    const started = Date.now()
    const result = await world.cli(['repo', 'add', world.repoPath])
    expect(result.exitCode, result.stderr + result.stdout).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'git', path: world.repoPath })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    clearTimeout(timer)

    process.kill(daemonPid, 'SIGSTOP')
    const hungAt = Date.now()
    try {
      await expect(world.cli(['repo', 'add', world.repoPath])).rejects.toMatchObject({ kind: 'daemon-exited' })
      expect(Date.now() - hungAt).toBeGreaterThanOrEqual(4_900)
      expect(Date.now() - hungAt).toBeLessThan(8_000)
    } finally {
      resume(daemonPid)
    }
  } finally {
    clearTimeout(timer)
    if (daemonPid) resume(daemonPid)
    await world.cleanup()
    expect(existsSync(world.root)).toBe(false)
    if (daemonPid) expect(() => process.kill(daemonPid!, 0)).toThrow()
  }
}, 90_000)
