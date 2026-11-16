import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertCleanStop,
  assertNoSecrets,
  assertOwnedReadiness,
  assertServeRefusal,
  captureStartupProcessIdentity,
  cleanupStartupChecks,
  parseServeLines,
  runStartupChecks
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
    const liveServeIdentity = captureStartupProcessIdentity(liveServe.pid)
    if (!liveServeIdentity) throw new Error('could not capture live serve test process identity')
    const context = {
      state: {
        startupProcesses: [
          { servePid: gone.pid, home: join(home, 'serve-gone') },
          { servePid: liveServe.pid, serveIdentity: liveServeIdentity, home: join(home, 'serve-live') }
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

test('startup cleanup refuses a PTY PID whose captured start identity is stale', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-cli-startup-stale-pty-'))
  const home = join(root, 'isolated-home')
  mkdirSync(home)
  const env = { HOME: home, QUIRKY_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: home, LANG: 'C', TZ: 'UTC' }
  const goneServe = Bun.spawn(['/bin/sleep', '60'], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const stalePty = Bun.spawn(['/bin/sleep', '60'], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const worldDaemon = Bun.spawn(['/bin/sleep', '60'], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  try {
    const stalePtyIdentity = captureStartupProcessIdentity(stalePty.pid)
    if (!stalePtyIdentity) throw new Error('could not capture stale PTY test process identity')
    goneServe.kill('SIGTERM')
    await goneServe.exited
    const context = {
      state: {
        startupProcesses: [{
          servePid: goneServe.pid,
          home: join(home, 'serve-stale-pty'),
          ptyHostPid: stalePty.pid,
          ptyHostIdentity: { ...stalePtyIdentity, started: 'Mon Jan 01 00:00:00 1990' }
        }]
      },
      world: {
        home, daemonPid: worldDaemon.pid,
        serveEnvironment(candidate: string) { return createServeEnvironment(candidate, home, env, root) }
      }
    } as unknown as Pick<CliCheckContext, 'state' | 'world'>
    const errors: string[] = []
    await cleanupStartupChecks(context, errors)
    expect(errors).toEqual([])
    expect(stalePty.signalCode).toBeNull()
    expect(() => process.kill(stalePty.pid, 0)).not.toThrow()
  } finally {
    for (const child of [goneServe, stalePty, worldDaemon]) {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)

test('startup checks stop before proving readiness when cancellation follows the already-running refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-cli-startup-cancel-'))
  const home = join(root, 'world-home')
  mkdirSync(home)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ pid: process.pid }))
  })
  const cancelled = new Error('startup checks cancelled')
  const proofs: string[] = []
  const imports: unknown[] = []
  let abort = false
  let spawnAttempts = 0
  try {
    const listening = Promise.withResolvers<void>()
    server.once('error', listening.reject)
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('health stand-in did not bind')
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({
      pid: process.pid,
      port: address.port,
      token: 'startup-token',
      hookToken: 'startup-hook-token',
      daemonVersion: 'test',
      protocolVersion: 1,
      startedAt: Date.now()
    }))
    const context = {
      state: {},
      world: {
        home,
        daemonPid: process.pid,
        serveEnvironment() { spawnAttempts += 1; throw new Error('unexpected serve spawn') }
      },
      check() { if (abort) throw cancelled },
      refuse() {
        abort = true
        return {
          code: 'conflict',
          message: 'already running',
          data: { reason: 'already-running', pid: process.pid, port: address.port, home }
        }
      },
      async call() { return { pid: process.pid, home } },
      prove(id: string) { proofs.push(id) },
      importActor(receipt: unknown) { imports.push(receipt) },
      importActorRefusal() { throw new Error('unexpected actor refusal import') }
    } as unknown as CliCheckContext

    await expect(runStartupChecks(context)).rejects.toBe(cancelled)
    expect(proofs).toEqual([])
    expect(imports).toEqual([])
    expect(context.state.startupProcesses).toBeUndefined()
    expect(spawnAttempts).toBe(0)
  } finally {
    if (server.listening) {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
