import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RuntimeInfo } from '@quirky/protocol/node'
import { startWorld, type StartWorldDependencies } from './world.ts'

const homes: string[] = []

function fakeRuntimeInfo(pid: number): RuntimeInfo {
  return {
    pid,
    port: 30_000 + pid,
    token: `rpc-token-${pid}`,
    hookToken: `hook-token-${pid}`,
    daemonVersion: 'test',
    protocolVersion: 1,
    startedAt: Date.now()
  }
}

function makeWorld(options: {
  waitForShutdown?: StartWorldDependencies['waitForShutdown']
  failReplacement?: boolean
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'quirky-world-restart-'))
  homes.push(home)
  const owned = new Set<number>()
  const kills: { pid: number; signal: NodeJS.Signals }[] = []
  let spawns = 0
  let cleanupCalls = 0
  let readinessCalls = 0

  const createScope = () => ({
    home,
    env: {},
    spawn() {
      const pid = 500 + ++spawns
      const exited = Promise.withResolvers<number>()
      owned.add(pid)
      return {
        pid,
        exited: exited.promise,
        kill(signal: NodeJS.Signals) {
          kills.push({ pid, signal })
          exited.resolve(0)
        }
      }
    },
    track() {},
    async cleanup() { cleanupCalls++ },
    killNow() {}
  })
  const dependencies: StartWorldDependencies = {
    createScope: createScope as unknown as StartWorldDependencies['createScope'],
    prepareCaptureFixtureHome: async () => ({} as never),
    registerCaptureFixtures: async () => ({ worktrees: [] } as never),
    waitForDaemon: async (_home, daemon) => {
      readinessCalls++
      if (options.failReplacement && readinessCalls === 2) throw new Error('replacement readiness failed')
      return fakeRuntimeInfo(daemon.pid)
    },
    connectDaemon: async ({ home: daemonHome }) => ({
      async callAny(method: string) {
        return method === 'status.get' ? { home: daemonHome, ptyHost: { pid: null } } : {}
      },
      close() {}
    } as never),
    waitForShutdown: options.waitForShutdown ?? (async () => {})
  }
  return {
    home,
    owned,
    kills,
    get spawns() { return spawns },
    get cleanupCalls() { return cleanupCalls },
    async start() {
      return await startWorld({ out: join(home, 'out'), repoRoot: resolve(import.meta.dir, '../..'), workers: false }, dependencies)
    }
  }
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

test('restart defaults to TERM and calls the spawn callback once after ownership', async () => {
  const fixture = makeWorld()
  const world = await fixture.start()
  const callbackSpawns: number[] = []
  const restart = await world.restartDaemon(undefined, (spawn) => {
    expect(fixture.owned.has(spawn.pid)).toBe(true)
    callbackSpawns.push(spawn.pid)
  })

  expect(fixture.kills).toEqual([{ pid: 501, signal: 'SIGTERM' }])
  expect(callbackSpawns).toEqual([502])
  expect(restart).toEqual({ spawnedAt: expect.any(Number), killSignal: 'SIGTERM' })
  expect(world.daemonPid).toBe(502)
  await world.stop()
})

test('restart accepts SIGKILL as a trailing option without moving the callback', async () => {
  const fixture = makeWorld()
  const world = await fixture.start()
  const callbackSpawns: number[] = []
  const restart = await world.restartDaemon(undefined, (spawn) => callbackSpawns.push(spawn.pid), { killSignal: 'SIGKILL' })

  expect(fixture.kills).toEqual([{ pid: 501, signal: 'SIGKILL' }])
  expect(callbackSpawns).toEqual([502])
  expect(restart).toEqual({ spawnedAt: expect.any(Number), killSignal: 'SIGKILL' })
  await world.stop()
})

test('an aborted restart starts no replacement', async () => {
  const fixture = makeWorld()
  const world = await fixture.start()
  const controller = new AbortController()
  controller.abort()

  await expect(world.restartDaemon(controller.signal)).rejects.toThrow('interrupted')
  expect(fixture.kills).toEqual([])
  expect(fixture.spawns).toBe(1)
  await world.stop()
})

test('a failed shutdown starts no replacement and leaves cleanup usable', async () => {
  const fixture = makeWorld({ waitForShutdown: async () => { throw new Error('shutdown failed') } })
  const world = await fixture.start()

  await expect(world.restartDaemon()).rejects.toThrow('shutdown failed')
  expect(fixture.kills).toEqual([{ pid: 501, signal: 'SIGTERM' }])
  expect(fixture.spawns).toBe(1)
  await world.stop()
  expect(fixture.cleanupCalls).toBe(1)
})

test('a failed replacement remains owned by usable world cleanup', async () => {
  const fixture = makeWorld({ failReplacement: true })
  const world = await fixture.start()

  await expect(world.restartDaemon()).rejects.toThrow('replacement readiness failed')
  expect(fixture.spawns).toBe(2)
  await world.stop()
  expect(fixture.cleanupCalls).toBe(1)
})
