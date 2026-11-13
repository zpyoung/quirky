import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertCleanStop,
  assertNoSecrets,
  assertOwnedReadiness,
  assertServeRefusal,
  cleanupStartupChecks,
  parseServeLines
} from './cli-startup'
import { createServeEnvironment } from './cli-world'
import type { CliCheckContext } from './cli-checks'
import type { ServeReady, ServeStopped } from './cli-startup'

function expectRejected(assertion: () => void): void {
  expect(assertion).toThrow()
}

const ready = {
  event: 'ready', owned: true, pid: 4242, servePid: 3131, port: 4567,
  url: 'http://127.0.0.1:4567', socket: '/tmp/serve-ready.sock', home: '/tmp/serve-ready',
  daemonVersion: '1.2.3', protocolVersion: 4, startedAt: 1_800_000_000_000,
  safeMode: false, ptyHostPid: null, log: '/tmp/serve-ready/logs/daemon.log'
} satisfies ServeReady

const stopped = {
  event: 'stopped', reason: 'signal', signal: 'SIGTERM', pid: 4242,
  daemonExitCode: 0, daemonSignal: null, killed: false
} satisfies ServeStopped

const expectedRuntime = { pid: ready.pid, port: ready.port }

function line(value: unknown): string {
  return JSON.stringify(value)
}

test('startup JSONL parser accepts ready and stopped records', () => {
  expect(parseServeLines(`${line(ready)}\n${line(stopped)}\n`)).toEqual({ ready, stopped, lines: 2 })
})

test('startup JSONL parser rejects malformed, non-object, error, unknown and excess records', () => {
  for (const stdout of [
    '{not-json}\n',
    'null\n',
    `${line({ event: 'error', error: { code: 'conflict' } })}\n`,
    `${line({ event: 'unexpected' })}\n`,
    `${line(ready)}\n${line(stopped)}\n${line(stopped)}\n`
  ]) {
    expectRejected(() => parseServeLines(stdout))
  }
})

test('owned readiness binds ownership, process identity, home and requested port', () => {
  const expected = { home: ready.home, servePid: ready.servePid, runtime: expectedRuntime, port: ready.port }
  expect(() => assertOwnedReadiness(ready, expected)).not.toThrow()
  expectRejected(() => assertOwnedReadiness({ ...ready, owned: false }, expected))
  expectRejected(() => assertOwnedReadiness({ ...ready, pid: ready.pid + 1 }, expected))
  expectRejected(() => assertOwnedReadiness({ ...ready, port: ready.port + 1 }, expected))
})

test('secret check rejects either runtime credential in stdout', () => {
  const runtime = { token: 'runtime-token-secret', hookToken: 'hook-token-secret' }
  expect(() => assertNoSecrets('ready without credentials', runtime)).not.toThrow()
  expectRejected(() => assertNoSecrets(`leaked ${runtime.token}`, runtime))
  expectRejected(() => assertNoSecrets(`leaked ${runtime.hookToken}`, runtime))
})

test('clean stop requires a successful signal stop without escalation', () => {
  expect(() => assertCleanStop(stopped, { pid: stopped.pid, signal: 'SIGTERM' })).not.toThrow()
  expectRejected(() => assertCleanStop({ ...stopped, killed: true }, { pid: stopped.pid, signal: 'SIGTERM' }))
  expectRejected(() => assertCleanStop({ ...stopped, daemonExitCode: 1 }, { pid: stopped.pid, signal: 'SIGTERM' }))
  expectRejected(() => assertCleanStop({ ...stopped, reason: 'daemon-exited' }, { pid: stopped.pid, signal: 'SIGTERM' }))
})

test('serve refusal checks its conflict reason and named process or port', () => {
  const alreadyRunning = {
    code: 'conflict', message: 'a daemon already owns /tmp/home',
    data: { reason: 'already-running', pid: 4242, port: 4567, home: '/tmp/home' }
  }
  expect(() => assertServeRefusal(alreadyRunning, 'already-running', { pid: 4242, port: 4567, home: '/tmp/home' })).not.toThrow()
  expect(() => assertServeRefusal({
    code: 'conflict', message: 'port is in use', data: { reason: 'port-in-use', port: 4567 }
  }, 'port-in-use', { port: 4567 })).not.toThrow()
  expectRejected(() => assertServeRefusal({
    ...alreadyRunning, data: { ...alreadyRunning.data, reason: 'port-in-use' }
  }, 'already-running', { pid: 4242, port: 4567, home: '/tmp/home' }))
  expectRejected(() => assertServeRefusal({
    ...alreadyRunning, data: { ...alreadyRunning.data, pid: 4243 }
  }, 'already-running', { pid: 4242, port: 4567, home: '/tmp/home' }))
})

test('serveEnvironment keeps scope and checkout daemon entry, and refuses escaped homes', () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-cli-startup-env-'))
  try {
    const worldHome = join(root, 'world')
    mkdirSync(worldHome)
    const worldEnv = { QUIRKY_HOME: worldHome, QUIRKY_TEST_SCOPE: join(worldHome, 'scope.json'), KEEP: 'value' }
    const home = join(worldHome, 'serve-ready')
    const env = createServeEnvironment(home, worldHome, worldEnv, root)
    expect(env).toMatchObject({
      QUIRKY_HOME: home,
      QUIRKY_DAEMON_ENTRY: join(root, 'packages/daemon/src/main.ts'),
      QUIRKY_TEST_SCOPE: worldEnv.QUIRKY_TEST_SCOPE,
      KEEP: 'value'
    })
    expect(() => createServeEnvironment(join(root, 'outside'), worldHome, worldEnv, root)).toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup cleanup handles gone and live children without signaling the world daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-cli-startup-cleanup-'))
  const home = join(root, 'isolated-home')
  mkdirSync(home)
  const env = { HOME: home, QUIRKY_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: home, LANG: 'C', TZ: 'UTC' }
  const gone = Bun.spawn(['/bin/sleep', '60'], {
    env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  })
  const liveServe = Bun.spawn(['/bin/sleep', '60'], {
    env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  })
  const worldDaemon = Bun.spawn(['/bin/sleep', '60'], {
    env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
  })
  try {
    gone.kill('SIGTERM')
    await gone.exited
    const context = {
      state: {
        startupProcesses: [
          { servePid: gone.pid, home: join(home, 'serve-gone') },
          { servePid: liveServe.pid, home: join(home, 'serve-live') }
        ]
      },
      world: {
        home, daemonPid: worldDaemon.pid,
        serveEnvironment(candidate: string) { return createServeEnvironment(candidate, home, env, root) }
      }
    } as unknown as Pick<CliCheckContext, 'state' | 'world'>
    const errors: string[] = []
    await cleanupStartupChecks(context, errors)
    expect(errors).toEqual([])
    const liveServeExit = await liveServe.exited
    expect(liveServe.signalCode).toBe('SIGTERM')
    expect(liveServeExit).not.toBe(0)
    expect(() => process.kill(worldDaemon.pid, 0)).not.toThrow()
  } finally {
    for (const child of [gone, liveServe, worldDaemon]) {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
