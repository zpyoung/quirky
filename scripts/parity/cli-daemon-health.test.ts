import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import * as protocol from '@quirky/protocol/node'
import { CliWorldError, createCliWorld, type CliWorld } from './cli-world'

// real OS process stalls cannot be resumed by a fake clock

function resume(pid: number): void {
  try { process.kill(pid, 'SIGCONT') } catch {}
}

async function cleanup(world: CliWorld): Promise<void> {
  resume(world.daemonPid)
  await world.cleanup()
  expect(existsSync(world.home)).toBe(false)
  expect(() => process.kill(world.daemonPid, 0)).toThrow()
}

test('CLI readiness waits for startup settlement and tolerates an afterReady stall', async () => {
  let observed: CliWorld | undefined
  let world: CliWorld | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    world = await createCliWorld({ hooks: { afterReady: async (ready) => {
      observed = ready
      expect(await protocol.readDaemonHealth(protocol.readRuntime(ready.home), 1_500)).toMatchObject({
        pid: ready.daemonPid, startupSettled: true
      })
      process.kill(ready.daemonPid, 'SIGSTOP')
      timer = setTimeout(() => resume(ready.daemonPid), 1_000)
    } } })
    expect(world).toBe(observed!)
  } finally {
    clearTimeout(timer)
    if (world) await cleanup(world)
    else if (observed) {
      expect(existsSync(observed.home)).toBe(false)
      expect(() => process.kill(observed!.daemonPid, 0)).toThrow()
    }
  }
}, 90_000)

test('CLI guards retry stalls, drain interrupted probes, and refuse hung or dead daemons', async () => {
  const world = await createCliWorld()
  const argv = [process.execPath, world.paths.cliEntry, 'api', '--runtime', 'local', '--json']
  let timer: ReturnType<typeof setTimeout> | undefined
  let assertEnvironment: (() => void) | undefined
  try {
    process.kill(world.daemonPid, 'SIGSTOP')
    timer = setTimeout(() => resume(world.daemonPid), 1_000)
    const started = Date.now()
    const result = await world.execute(argv)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toHaveProperty('schemaVersion')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    clearTimeout(timer)

    process.env.G298_ENV_SENTINEL = 'outside-the-world'
    const spawnSyncBefore = Bun.spawnSync
    const homeBefore = process.env.QUIRKY_HOME
    assertEnvironment = () => {
      expect(Bun.spawnSync).toBe(spawnSyncBefore)
      expect(process.env.G298_ENV_SENTINEL).toBe('outside-the-world')
      expect(process.env.QUIRKY_HOME).toBe(homeBefore)
    }
    const controller = new AbortController()
    let abortedAt = 0
    process.kill(world.daemonPid, 'SIGSTOP')
    timer = setTimeout(() => {
      abortedAt = Date.now()
      controller.abort(new CliWorldError('interrupted', 'test interrupt'))
    }, 300)
    let interrupted: unknown
    try {
      await world.execute(argv, { signal: controller.signal })
    } catch (error) {
      assertEnvironment()
      interrupted = error
      expect(error).toMatchObject({ kind: 'interrupted' })
      expect(abortedAt).toBeGreaterThan(0)
      expect(Date.now() - abortedAt).toBeLessThan(1_500)
    } finally {
      clearTimeout(timer)
      resume(world.daemonPid)
    }
    expect(interrupted).toBeInstanceOf(CliWorldError)
    await Bun.sleep(400)
    assertEnvironment()

    process.kill(world.daemonPid, 'SIGSTOP')
    const hungAt = Date.now()
    try {
      await expect(world.execute(argv)).rejects.toMatchObject({
        kind: 'daemon-exited', message: 'owned daemon is not healthy; refusing CLI auto-start'
      })
      expect(Date.now() - hungAt).toBeGreaterThanOrEqual(4_900)
      expect(Date.now() - hungAt).toBeLessThan(8_000)
    } finally {
      resume(world.daemonPid)
    }

    process.kill(world.daemonPid, 'SIGKILL')
    const killedAt = Date.now()
    await expect(world.execute(argv)).rejects.toMatchObject({ kind: 'daemon-exited' })
    expect(Date.now() - killedAt).toBeLessThan(2_000)
  } finally {
    clearTimeout(timer)
    try {
      await cleanup(world)
      assertEnvironment?.()
    } finally {
      delete process.env.G298_ENV_SENTINEL
    }
  }
}, 90_000)
