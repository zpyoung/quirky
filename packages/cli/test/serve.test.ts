import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION, QuirkyClient, RpcError, RpcErrorCode } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'
import { CommandFailed } from '../src/args'
import { createServe, type ServeSignals } from '../src/commands/serve'
import type { Context } from '../src/commands/types'
import { Printer } from '../src/output'
import { run, type Runtime } from '../src/main'
import { parseArgs } from '../src/args'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'

const STAND_IN = join(import.meta.dir, 'fixtures', 'serve-daemon.ts')
const LOG_PATH = 'logs/daemon.log'

let scope: ProcessScope

beforeEach(() => {
  scope = createProcessScope()
})

afterEach(async () => {
  const startsPath = join(scope.home, 'serve-daemon-starts.log')
  if (existsSync(startsPath)) {
    for (const match of readFileSync(startsPath, 'utf8').matchAll(/^pid=(\d+)/gm)) scope.track(Number(match[1]))
  }
  await scope.cleanup()
})

function daemonEnv(options: { mode?: string; port?: string; entry?: string } = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...scope.env }
  delete env.QUIRKY_PORT
  env.QUIRKY_HOME = scope.home
  env.QUIRKY_DAEMON_ENTRY = options.entry ?? STAND_IN
  env.SERVE_DAEMON_MODE = options.mode ?? 'ready'
  if (options.port !== undefined) env.QUIRKY_PORT = options.port
  return env
}

function captureRun(argv: readonly string[], env = daemonEnv()) {
  const output = { stdout: '', stderr: '', calls: 0 }
  const link = {
    requestBase: 'serve-unit-test',
    async call() {
      output.calls++
      throw new Error('serve must not use the CLI daemon link')
    },
    async callAny() {
      output.calls++
      throw new Error('serve must not use the CLI daemon link')
    },
    async reconnect() {},
    close() {}
  } as unknown as Runtime['link']
  const pending = run({
    argv: [...argv],
    env,
    cwd: scope.home,
    writer: {
      stdout(text) { output.stdout += text },
      stderr(text) { output.stderr += text }
    },
    link,
    openDesktopApp: async () => ({ ok: false, reason: 'unused' })
  })
  return { output, pending }
}

class TestSignals implements ServeSignals {
  private readonly handlers = new Map<'SIGINT' | 'SIGTERM' | 'SIGHUP', () => void>()

  on(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void {
    this.handlers.set(signal, handler)
  }

  off(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void {
    if (this.handlers.get(signal) === handler) this.handlers.delete(signal)
  }

  emit(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    this.handlers.get(signal)?.()
  }

  get size(): number {
    return this.handlers.size
  }
}

function directServe(
  argv: string[],
  env = daemonEnv(),
  options: Parameters<typeof createServe>[0] = {},
  signals = new TestSignals()
) {
  const command = createServe({ ...options, signals })
  const args = parseArgs(argv, command.flags, command.name)
  const output = { stdout: '', stderr: '' }
  const rpc = {
    requestBase: 'serve-unit-test',
    async call() { throw new Error('serve must not use the CLI daemon link') },
    async callAny() { throw new Error('serve must not use the CLI daemon link') },
    async reconnect() {},
    close() {}
  } as unknown as Context['rpc']
  const context: Context = {
    rpc,
    requestBase: 'serve-unit-test',
    out: new Printer({
      stdout(text) { output.stdout += text },
      stderr(text) { output.stderr += text }
    }, args.flags.json === true),
    env,
    cwd: scope.home,
    readFile: () => '',
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    openDesktopApp: async () => ({ ok: false, reason: 'unused' })
  }
  const done = command.run(args, context).then(() => undefined, (error: unknown) => error)
  return { output, done, signals }
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for serve test condition`)
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) records.push(value as Record<string, unknown>)
    } catch {}
  }
  return records
}

async function waitForReady(output: { stdout: string }): Promise<Record<string, unknown>> {
  return waitFor(() => jsonLines(output.stdout).find((record) => record.event === 'ready'))
}

async function startStandalone(mode = 'ready', env = daemonEnv({ mode })) {
  const child = scope.spawn([process.execPath, STAND_IN], {
    cwd: scope.home,
    env: { ...env, SERVE_DAEMON_MODE: mode },
    stdout: 'ignore',
    stderr: 'ignore'
  })
  const runtime = await waitFor(async () => {
    const info = readRuntime(scope.home)
    if (!info || info.pid !== child.pid) return undefined
    return (await isDaemonAlive(info, 100)) ? info : undefined
  })
  return { child, runtime }
}

function starts(): string[] {
  const path = join(scope.home, 'serve-daemon-starts.log')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : []
}

function daemonSignals(): string[] {
  const path = join(scope.home, 'serve-daemon-signals.log')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
}

function startedPids(): number[] {
  return starts().map((line) => Number(/^pid=(\d+)/.exec(line)?.[1])).filter(Number.isSafeInteger)
}

async function freePort(): Promise<number> {
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
  const port = listener.port as number
  listener.stop(true)
  return port
}

function errorData(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(RpcError)
  const data = (error as RpcError).data
  expect(data).toBeDefined()
  return data as Record<string, unknown>
}

describe('serve command', () => {
  test('owns and reports the child only after runtime, health and status agree', async () => {
    const env = daemonEnv()
    env.CLAUDECODE = 'agent-session'
    env.CLAUDE_CODE_SESSION_ID = 'session-secret'
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '1234'
    const execution = directServe(['--json'], env)
    const ready = await waitForReady(execution.output) as {
      event: string; owned: boolean; pid: number; servePid: number; port: number; url: string
      socket: string; home: string; daemonVersion: string; protocolVersion: number; startedAt: number
      safeMode: boolean; ptyHostPid: number | null; log: string
    }
    const runtime = readRuntime(scope.home) as RuntimeInfo
    expect(Object.keys(ready).sort()).toEqual([
      'daemonVersion', 'event', 'home', 'log', 'owned', 'pid', 'port', 'protocolVersion', 'ptyHostPid',
      'safeMode', 'servePid', 'socket', 'startedAt', 'url'
    ])
    expect(ready).toEqual({
      event: 'ready', owned: true, pid: runtime.pid, servePid: process.pid, port: runtime.port,
      url: `http://127.0.0.1:${runtime.port}`, socket: runtime.socket as string, home: scope.home,
      daemonVersion: runtime.daemonVersion, protocolVersion: runtime.protocolVersion, startedAt: runtime.startedAt,
      safeMode: false, ptyHostPid: null, log: join(scope.home, LOG_PATH)
    })
    expect(ready.pid).toBe(startedPids()[0])
    expect(ready.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(execution.output.stdout).not.toContain(runtime.token)
    expect(execution.output.stdout).not.toContain(runtime.hookToken)
    expect(starts()[0]).toContain(`argv=${JSON.stringify([STAND_IN, `--exit-with-parent=${process.pid}`])}`)
    expect(starts()[0]).toContain('QUIRKY_PORT=absent')
    const childEnv = JSON.parse(readFileSync(join(scope.home, 'serve-daemon-env.json'), 'utf8')) as Record<string, string | undefined>
    expect(childEnv).not.toHaveProperty('CLAUDECODE')
    expect(childEnv).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
    expect(childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('1234')
    expect(statSync(join(scope.home, LOG_PATH)).mode & 0o777).toBe(0o600)
    expect(statSync(join(scope.home, 'logs')).mode & 0o777).toBe(0o700)

    const health = await fetch(`http://127.0.0.1:${runtime.port}/health`).then((response) => response.json()) as { pid: number }
    expect(health.pid).toBe(ready.pid)
    const client = await QuirkyClient.connectSocket(runtime.socket as string, { role: 'cli', name: 'serve-test', token: runtime.token })
    try {
      const status = await client.call('status.get', {})
      expect(status.pid).toBe(ready.pid)
      expect(status.home).toBe(scope.home)
    } finally {
      client.close()
    }

    execution.signals.emit('SIGTERM')
    expect(await execution.done).toBeUndefined()
    expect(jsonLines(execution.output.stdout).map((record) => record.event)).toEqual(['ready', 'stopped'])
    expect(daemonSignals()).toEqual(['SIGTERM'])
    expect(execution.signals.size).toBe(0)
    expect(jsonLines(execution.output.stdout)[1]).toEqual({
      event: 'stopped', reason: 'signal', signal: 'SIGTERM', pid: ready.pid,
      daemonExitCode: 0, daemonSignal: null, killed: false
    })
  }, 15_000)

  test.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('forwards %s as one daemon SIGTERM', async (signal) => {
    const execution = directServe(['--json'])
    const ready = await waitForReady(execution.output)
    execution.signals.emit(signal)
    expect(await execution.done).toBeUndefined()
    expect(daemonSignals()).toEqual(['SIGTERM'])
    expect(jsonLines(execution.output.stdout)[1]).toMatchObject({ event: 'stopped', reason: 'signal', signal, killed: false })
  }, 15_000)

  test('ignores repeated stop signals after the first signal', async () => {
    const execution = directServe(['--json'])
    const ready = await waitForReady(execution.output)
    execution.signals.emit('SIGTERM')
    execution.signals.emit('SIGINT')
    execution.signals.emit('SIGHUP')
    expect(await execution.done).toBeUndefined()
    expect(daemonSignals()).toEqual(['SIGTERM'])
    expect(jsonLines(execution.output.stdout)).toHaveLength(2)
    expect(jsonLines(execution.output.stdout)[1]).toMatchObject({ signal: 'SIGTERM', pid: ready.pid })
  }, 15_000)

  test('kills a daemon that ignores SIGTERM and rejects after its stop record', async () => {
    const execution = directServe(['--json'], daemonEnv({ mode: 'ignore-term' }), { timings: { stopMs: 300, killMs: 2_000 } })
    const ready = await waitForReady(execution.output)
    execution.signals.emit('SIGTERM')
    const failure = await execution.done
    expect(failure).toBeInstanceOf(CommandFailed)
    expect(daemonSignals()).toEqual(['SIGTERM'])
    expect(jsonLines(execution.output.stdout)).toHaveLength(2)
    expect(jsonLines(execution.output.stdout)[1]).toEqual({
      event: 'stopped', reason: 'signal', signal: 'SIGTERM', pid: ready.pid,
      daemonExitCode: null, daemonSignal: 'SIGKILL', killed: true
    })
    expect(execution.signals.size).toBe(0)
  }, 15_000)

  test.each([['0', 0], ['3', 3]] as const)('reports a daemon that exits on its own with code %s', async (exitCode, expectedCode) => {
    const execution = directServe(['--json'], daemonEnv({ mode: 'exit-after-ready' }))
    const ready = await waitForReady(execution.output)
    writeFileSync(join(scope.home, 'serve-daemon-exit'), exitCode)
    const failure = await execution.done
    expect(jsonLines(execution.output.stdout)[1]).toEqual({
      event: 'stopped', reason: 'daemon-exited', signal: null, pid: ready.pid,
      daemonExitCode: expectedCode, daemonSignal: null, killed: false
    })
    if (expectedCode === 0) expect(failure).toBeUndefined()
    else expect(failure).toBeInstanceOf(CommandFailed)
  }, 15_000)

  test('stops when the command parent exits and reports a clean stop', async () => {
    const parentPid = process.ppid
    let parentExited = false
    const execution = directServe(['--json'], daemonEnv(), {
      timings: { parentPollMs: 10 },
      readPpid: () => parentExited ? 1 : parentPid
    })
    const ready = await waitForReady(execution.output)
    parentExited = true
    const failure = await execution.done
    expect(failure).toBeUndefined()
    expect(daemonSignals()).toEqual(['SIGTERM'])
    expect(jsonLines(execution.output.stdout)[1]).toEqual({
      event: 'stopped', reason: 'parent-exited', signal: null, pid: ready.pid,
      daemonExitCode: 0, daemonSignal: null, killed: false
    })
  }, 15_000)

  test('refuses an already running daemon before checking a missing entry', async () => {
    const existing = await startStandalone()
    const missingEntry = join(scope.home, 'absent.ts')
    const result = captureRun(['serve', '--json'], daemonEnv({ entry: missingEntry }))
    expect(await result.pending).toBe(1)
    const error = JSON.parse(result.output.stdout).error
    expect(error).toEqual({
      code: 'conflict',
      message: `a daemon already owns ${scope.home} (pid ${existing.runtime.pid}); nothing was started`,
      reason: 'already-running',
      data: { reason: 'already-running', pid: existing.runtime.pid, port: existing.runtime.port, home: scope.home }
    })
    expect(starts()).toHaveLength(1)
    expect(daemonSignals()).toEqual([])
    expect(result.output.calls).toBe(0)
  }, 15_000)

  test('refuses a start race and names the healthy sibling without stopping it', async () => {
    const result = captureRun(['serve', '--json'], daemonEnv({ mode: 'yield' }))
    expect(await result.pending).toBe(1)
    const error = JSON.parse(result.output.stdout).error
    expect(error.code).toBe('conflict')
    expect(error.reason).toBe('already-running')
    expect(error.data.pid).toBe(startedPids()[1])
    expect(starts()).toHaveLength(2)
    expect(daemonSignals()).toEqual([])
  }, 15_000)

  test('refuses an occupied explicit port without spawning', async () => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') })
    try {
      const result = captureRun(['serve', '--port', String(listener.port), '--json'])
      expect(await result.pending).toBe(1)
      expect(JSON.parse(result.output.stdout).error).toEqual({
        code: 'conflict',
        message: `port ${listener.port} is already in use; nothing was started`,
        reason: 'port-in-use',
        data: { reason: 'port-in-use', port: listener.port }
      })
      expect(existsSync(join(scope.home, 'serve-daemon-starts.log'))).toBe(false)
      expect(existsSync(join(scope.home, LOG_PATH))).toBe(false)
    } finally {
      listener.stop(true)
    }
  })

  test.each([['0', '--port must be between 1 and 65535'], ['65536', '--port must be between 1 and 65535'], ['-1', '--port must be between 1 and 65535'], ['extra', 'unexpected argument "extra"']] as const)(
    'rejects invalid serve argument %s as usage', async (argument, message) => {
      const argv = argument === 'extra' ? ['serve', argument, '--json'] : ['serve', '--port', argument, '--json']
      const result = captureRun(argv)
      expect(await result.pending).toBe(2)
      expect(JSON.parse(result.output.stdout)).toEqual({ error: { code: 'usage', message } })
      expect(existsSync(join(scope.home, 'serve-daemon-starts.log'))).toBe(false)
    }
  )

  test('reports a missing daemon entry as an internal refusal', async () => {
    const entry = join(scope.home, 'absent.ts')
    const result = captureRun(['serve', '--json'], daemonEnv({ entry }))
    expect(await result.pending).toBe(1)
    expect(JSON.parse(result.output.stdout)).toEqual({
      error: { code: 'internal', message: `quirkyd entry not found: ${entry}`, reason: 'entry-missing', data: { reason: 'entry-missing' } }
    })
    expect(existsSync(join(scope.home, 'serve-daemon-starts.log'))).toBe(false)
  })

  test('includes the new daemon stderr in an early-exit refusal', async () => {
    const result = captureRun(['serve', '--json'], daemonEnv({ mode: 'exit-1' }))
    expect(await result.pending).toBe(1)
    const error = JSON.parse(result.output.stdout).error
    expect(error.code).toBe('internal')
    expect(error.reason).toBe('daemon-exited-early')
    expect(error.data).toMatchObject({
      reason: 'daemon-exited-early', daemonExitCode: 1, daemonSignal: null, log: join(scope.home, LOG_PATH)
    })
    expect(error.data.logTail).toContain('serve-daemon: exit-1 requested')
  }, 15_000)

  test.each(['runtime-garbage', 'runtime-other-pid'])('times out when %s never names the child', async (mode) => {
    const execution = directServe(['--json'], daemonEnv({ mode }), { timings: { readyMs: 1_500, pollMs: 10 } })
    const startedAt = Date.now()
    const failure = await execution.done
    const data = errorData(failure)
    expect((failure as RpcError).code).toBe(RpcErrorCode.Timeout)
    expect(data.reason).toBe('readiness-timeout')
    expect((failure as Error).message).toBe(`quirkyd was not ready within 1.5s; it was stopped; see ${join(scope.home, LOG_PATH)}`)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(jsonLines(execution.output.stdout)).toEqual([])
    expect(daemonSignals()).toEqual(['SIGTERM'])
  }, 10_000)

  test.each([
    ['runtime-bad-port', 'port'],
    ['health-wrong-pid', 'health pid'],
    ['status-wrong-pid', 'status pid'],
    ['status-wrong-home', 'status home']
  ] as const)('stops the child immediately when %s contradicts readiness', async (mode, detail) => {
    const execution = directServe(['--json'], daemonEnv({ mode }), { timings: { readyMs: 5_000, pollMs: 10 } })
    const startedAt = Date.now()
    const failure = await execution.done
    const data = errorData(failure)
    expect((failure as RpcError).code).toBe(RpcErrorCode.Internal)
    expect(data.reason).toBe('readiness-invalid')
    expect(data.detail).toContain(detail)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(jsonLines(execution.output.stdout)).toEqual([])
    expect(daemonSignals()).toEqual(['SIGTERM'])
  }, 10_000)

  test('rejects a runtime port different from the requested port', async () => {
    const port = await freePort()
    const execution = directServe(['--json', '--port', String(port)], daemonEnv({ mode: 'wrong-port' }), {
      timings: { readyMs: 5_000, pollMs: 10 }
    })
    const failure = await execution.done
    const data = errorData(failure)
    const runtimePort = Number(readFileSync(join(scope.home, 'serve-daemon-bound-port'), 'utf8'))
    expect((failure as RpcError).code).toBe(RpcErrorCode.Internal)
    expect(data.reason).toBe('readiness-invalid')
    expect(data.detail).toBe(`runtime port ${runtimePort} does not match requested port ${port}`)
    expect(jsonLines(execution.output.stdout)).toEqual([])
    expect(daemonSignals()).toEqual(['SIGTERM'])
  }, 10_000)

  test('stops promptly when a signal arrives before readiness', async () => {
    const execution = directServe(['--json'], daemonEnv({ mode: 'slow-ready' }), { timings: { readyMs: 5_000, pollMs: 10 } })
    await waitFor(() => existsSync(join(scope.home, 'serve-daemon-signal-handler')) ? true : undefined)
    expect(existsSync(join(scope.home, 'runtime.json'))).toBe(false)
    execution.signals.emit('SIGTERM')
    const failure = await execution.done
    const data = errorData(failure)
    expect((failure as RpcError).code).toBe(RpcErrorCode.Internal)
    expect(data).toMatchObject({ reason: 'interrupted', signal: 'SIGTERM', pid: startedPids()[0] })
    expect(jsonLines(execution.output.stdout)).toEqual([])
    expect(daemonSignals()).toEqual(['SIGTERM'])
    expect(execution.signals.size).toBe(0)
  }, 10_000)

  test.each([
    [['serve', '--runtime', 'box', '--json'], {}],
    [['serve', '--json'], { QUIRKY_RUNTIME: 'box' }]
  ] as const)('rejects paired-runtime selection as local-only', async (argv, changes) => {
    const env = { ...daemonEnv(), ...changes }
    const result = captureRun(argv, env)
    expect(await result.pending).toBe(2)
    expect(JSON.parse(result.output.stdout)).toEqual({
      error: { code: 'usage', message: 'serve is local-only; select --runtime local explicitly' }
    })
    expect(result.output.calls).toBe(0)
    expect(existsSync(join(scope.home, 'serve-daemon-starts.log'))).toBe(false)
  })

  test('prints the required human readiness and stop lines', async () => {
    const execution = directServe([])
    const ready = await waitFor(() => execution.output.stdout.split('\n').find((line) => line.startsWith('quirkyd is ready on ')))
    const runtime = readRuntime(scope.home) as RuntimeInfo
    expect(ready).toBe(
      `quirkyd is ready on http://127.0.0.1:${runtime.port} (pid ${runtime.pid}); logs in ${join(scope.home, LOG_PATH)}; Ctrl-C stops it`
    )
    execution.signals.emit('SIGTERM')
    expect(await execution.done).toBeUndefined()
    expect(execution.output.stdout.split('\n').filter(Boolean)).toEqual([
      ready,
      `quirkyd stopped (pid ${runtime.pid})`
    ])
  }, 15_000)

  test.each(['0', '9'] as const)('lets --port override inherited QUIRKY_PORT (%s)', async (callerPort) => {
    const port = await freePort()
    const env = daemonEnv({ port: callerPort })
    const execution = directServe(['--json', '--port', String(port), '--disable-plugins'], env)
    const ready = await waitForReady(execution.output)
    expect(ready.port).toBe(port)
    expect(ready.url).toBe(`http://127.0.0.1:${port}`)
    expect(ready.safeMode).toBe(true)
    expect(starts()[0]).toContain(`QUIRKY_PORT=${port}`)
    expect(starts()[0]).toContain(JSON.stringify([STAND_IN, `--exit-with-parent=${process.pid}`, '--disable-plugins']))
    execution.signals.emit('SIGTERM')
    expect(await execution.done).toBeUndefined()
  }, 15_000)

  test.each(['0', undefined] as const)('passes inherited QUIRKY_PORT through unchanged (%s)', async (port) => {
    const execution = directServe(['--json'], daemonEnv({ ...(port === undefined ? {} : { port }) }))
    const ready = await waitForReady(execution.output)
    const runtime = readRuntime(scope.home) as RuntimeInfo
    expect(starts()[0]).toContain(`QUIRKY_PORT=${port ?? 'absent'}`)
    expect(ready.port).toBe(runtime.port)
    expect(runtime.port).toBeGreaterThan(0)
    execution.signals.emit('SIGTERM')
    expect(await execution.done).toBeUndefined()
  }, 15_000)
})
