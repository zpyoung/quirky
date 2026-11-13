import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, liveProcesses } from '../src/api'
import type { OwnedProcessRunner, ProcessRunnerOptions, RunOptions, RunResult } from '../src/api'
import { startChild, type StartedChild, type StartChild } from '../src/child'


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}
const runners: OwnedProcessRunner[] = []
const descendantPids = new Set<number>()
let nextOwner = 0
let homeDir = ''
let previousQuirkyHome: string | undefined

beforeEach(() => {
  previousQuirkyHome = process.env.QUIRKY_HOME
  homeDir = mkdtempSync(join(tmpdir(), 'quirky-run-test-'))
  process.env.QUIRKY_HOME = homeDir
})

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()))
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  descendantPids.clear()
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  rmSync(homeDir, { recursive: true, force: true })
})

function makeRunner(options: Omit<ProcessRunnerOptions, 'owner'> = {}) {
  const runner = createProcessRunner({ owner: `run-test-${nextOwner++}`, ...options })
  runners.push(runner)
  return runner
}

function trackPid(stdoutText: string): number {
  const pid = Number.parseInt(stdoutText.trim(), 10)
  if (Number.isInteger(pid) && pid > 0) descendantPids.add(pid)
  return pid
}

function trackPidFile(path: string): number | undefined {
  try {
    return trackPid(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function expectPidGone(pid: number, waitMs = 2_000): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      descendantPids.delete(pid)
      return
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 20)
    await promise
  }
  throw new Error(`process ${pid} remained alive after ${waitMs}ms`)
}

function groupDouble(options: {
  pid?: number
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exit?: Promise<{ exitCode: number | null; signal: string | null }>
  groupAlive?: () => boolean
  onSignal?: (signal: 'SIGTERM' | 'SIGKILL') => void
} = {}): StartedChild & {
  finish(exitCode?: number | null, signal?: string | null): void
  signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }>
} {
  const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: Array<{ signal: 'SIGTERM' | 'SIGKILL'; at: number }> = []
  const child = {
    pid: options.pid ?? 900_020,
    stdout: options.stdout ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    stderr: options.stderr ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    exited: options.exit ?? exit.promise,
    signals,
    finish(exitCode: number | null = 0, signal: string | null = null) { exit.resolve({ exitCode, signal }) },
    killGroup(signal: 'SIGTERM' | 'SIGKILL') {
      signals.push({ signal, at: Date.now() })
      options.onSignal?.(signal)
    },
    ...(options.groupAlive ? { groupAlive: options.groupAlive } : {}),
  }
  return child
}

function asStart(child: StartedChild): StartChild {
  return () => child
}

test('resolves successful stdout and stderr with a whole-millisecond duration', async () => {
  const result = await makeRunner().run(['/bin/sh', '-c', 'printf hello; printf oops >&2'], { timeoutMs: 10_000 })
  expect(result.exitCode).toBe(0)
  expect(result.signal).toBeNull()
  expect(result.stdoutText).toBe('hello')
  expect(result.stdout.byteLength).toBe(5)
  expect(result.stderr).toBe('oops')
  expect(result.stopped).toBeUndefined()
  expect(result.spawnError).toBeUndefined()
  expect(Number.isInteger(result.durationMs)).toBe(true)
  expect(result.durationMs).toBeGreaterThanOrEqual(0)
}, 15_000)

test('resolves a non-zero exit code without stopping the command', async () => {
  const result = await makeRunner().run(['/bin/sh', '-c', 'exit 3'], { timeoutMs: 10_000 })
  expect(result.exitCode).toBe(3)
  expect(result.stopped).toBeUndefined()
}, 15_000)

test('reports a signal sent by the command without marking it stopped', async () => {
  const result = await makeRunner().run(['/bin/sh', '-c', 'kill -TERM $$'], { timeoutMs: 10_000 })
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBe('SIGTERM')
  expect(result.stopped).toBeUndefined()
}, 15_000)

test('writes string and byte input, and closes stdin when input is omitted', async () => {
  const runner = makeRunner()
  const stringInput = await runner.run(['/bin/cat'], { input: 'abc', timeoutMs: 10_000 })
  const closedInput = await runner.run(['/bin/cat'], { timeoutMs: 10_000 })
  const byteInput = await runner.run(['/bin/cat'], { input: new Uint8Array([0, 255, 65]), timeoutMs: 10_000 })
  expect(stringInput.stdoutText).toBe('abc')
  expect(closedInput.stdoutText).toBe('')
  expect(closedInput.exitCode).toBe(0)
  expect(byteInput.stdout).toEqual(new Uint8Array([0, 255, 65]))
}, 15_000)

test('runs in the requested working directory', async () => {
  const result = await makeRunner().run(['/bin/pwd'], { cwd: homeDir, timeoutMs: 10_000 })
  expect(result.stdoutText.trim()).toBe(realpathSync(homeDir))
}, 15_000)

test('uses an explicit whole environment and snapshots the default environment at call time', async () => {
  const runner = makeRunner()
  const explicit = await runner.run(['/usr/bin/env'], { env: { ONLY: '1' }, timeoutMs: 10_000 })
  const key = 'QUIRKY_RUN_ENV_SNAPSHOT'
  const originalValue = process.env[key]
  process.env[key] = 'at-call'
  let snapshot: RunResult
  try {
    const pending = runner.run(['/usr/bin/env'], { timeoutMs: 10_000 })
    process.env[key] = 'after-call'
    snapshot = await pending
  } finally {
    if (originalValue === undefined) delete process.env[key]
    else process.env[key] = originalValue
  }
  expect(explicit.stdoutText).toBe('ONLY=1\n')
  expect(snapshot!.stdoutText.split('\n')).toContain(`${key}=at-call`)
  expect(snapshot!.stdoutText.split('\n')).not.toContain(`${key}=after-call`)
}, 15_000)

test('resolves command and working-directory startup failures as spawn errors', async () => {
  const runner = makeRunner()
  const missingCommand = await runner.run(['/nonexistent/quirky-no-such-binary'], { timeoutMs: 10_000 })
  const missingDirectory = await runner.run(['/bin/pwd'], { cwd: join(homeDir, 'missing'), timeoutMs: 10_000 })
  for (const result of [missingCommand, missingDirectory]) {
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.stdout.byteLength).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.spawnError?.code).toBe('ENOENT')
    expect(result.spawnError?.message.length).toBeGreaterThan(0)
  }

  const originalCwd = process.cwd()
  const deletedDir = mkdtempSync(join(tmpdir(), 'quirky-run-deleted-cwd-'))
  try {
    process.chdir(deletedDir)
    rmdirSync(deletedDir)
    const deletedCwd = await withTimeout(
      runner.run(['/bin/pwd'], { timeoutMs: 10_000 }),
      10_000,
      'run with a deleted daemon cwd'
    )
    expect(deletedCwd.exitCode).toBeNull()
    expect(deletedCwd.signal).toBeNull()
    expect(deletedCwd.stdout.byteLength).toBe(0)
    expect(deletedCwd.stderr).toBe('')
    expect(deletedCwd.spawnError?.code).toBe('ENOENT')
    expect(deletedCwd.spawnError?.message.length).toBeGreaterThan(0)

    const explicitCwd = await withTimeout(
      runner.run(['/bin/pwd'], { cwd: homeDir, timeoutMs: 10_000 }),
      10_000,
      'run with an explicit cwd after daemon cwd deletion'
    )
    expect(explicitCwd.exitCode).toBe(0)
    expect(explicitCwd.stdoutText.trim()).toBe(realpathSync(homeDir))

    const abort = new AbortController()
    abort.abort()
    const aborted = await withTimeout(
      runner.run(['/bin/pwd'], { signal: abort.signal, timeoutMs: 10_000 }),
      10_000,
      'already-aborted run with a deleted daemon cwd'
    )
    expect(aborted.stopped).toBe('aborted')
    expect(aborted.spawnError).toBeUndefined()
    expect(aborted.exitCode).toBeNull()
    expect(aborted.signal).toBeNull()
  } finally {
    process.chdir(originalCwd)
    rmSync(deletedDir, { recursive: true, force: true })
  }
  expect(runner.live()).toEqual([])
  expect(liveProcesses()).toEqual([])
}, 15_000)

test('stops a command at its timeout with SIGTERM', async () => {
  const startedAt = Date.now()
  const result = await makeRunner().run(['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 200 })
  expect(Date.now() - startedAt).toBeLessThan(2_000)
  expect(result.stopped).toBe('timeout')
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBe('SIGTERM')
}, 15_000)

test('exports the non-optional default deadline', () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
})

test('a timeout kills descendants in the process group', async () => {
  const result = await makeRunner().run(['/bin/sh', '-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 300 })
  const pid = trackPid(result.stdoutText)
  expect(result.stopped).toBe('timeout')
  expect(pid).toBeGreaterThan(0)
  await expectPidGone(pid)
  expect(descendantPids.has(pid)).toBe(false)
}, 15_000)

test('escalates from SIGTERM to SIGKILL when the process group ignores SIGTERM', async () => {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const runner = makeRunner({
    start(argv, init) {
      const child = startChild(argv, init)
      const killGroup = child.killGroup.bind(child)
      child.killGroup = signal => {
        signals.push(signal)
        killGroup(signal)
      }
      return child
    }
  })
  const result = await runner.run(['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"], {
    timeoutMs: 200,
    killGraceMs: 300,
  })
  expect(result.stopped).toBe('timeout')
  expect(result.signal).toBe('SIGKILL')
  expect(result.durationMs).toBeGreaterThanOrEqual(450)
  expect(result.durationMs).toBeLessThan(3_000)
  expect(signals.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL'])
}, 15_000)

test('aborting stops an unresponsive process group with SIGKILL after the grace period', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  let result: RunResult | undefined
  try {
    result = await makeRunner().run(['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"], {
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 100,
    })
  } finally {
    clearTimeout(timer)
  }
  expect(result?.stopped).toBe('aborted')
  expect(result?.signal).toBe('SIGKILL')
}, 15_000)

test('an already-aborted signal resolves without starting a child', async () => {
  let starts = 0
  const runner = makeRunner({
    start: () => {
      starts++
      throw new Error('must not start')
    },
  })
  const controller = new AbortController()
  controller.abort()
  const result = await runner.run(['/bin/sh', '-c', 'exit 0'], { signal: controller.signal })
  expect(starts).toBe(0)
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBeNull()
  expect(result.stopped).toBe('aborted')
  expect(result.durationMs).toBe(0)
  expect(result.stdout.byteLength).toBe(0)
  expect(result.stderr).toBe('')
}, 15_000)

test('enforces independent byte caps on stdout and stderr and exports the default cap', async () => {
  const runner = makeRunner()
  const stdoutOverflow = await runner.run(['/bin/sh', '-c', 'head -c 1048576 /dev/zero; sleep 30'], {
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  })
  const stderrOverflow = await runner.run(['/bin/sh', '-c', 'head -c 1048576 /dev/zero >&2; sleep 30'], {
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  })
  const byteOverflow = await runner.run(['/bin/sh', '-c', 'printf "éé"'], { timeoutMs: 10_000, maxOutputBytes: 3 })
  expect(stdoutOverflow.stopped).toBe('overflow')
  expect(stdoutOverflow.stdout.byteLength).toBe(1_024)
  expect(stderrOverflow.stopped).toBe('overflow')
  expect(Buffer.byteLength(stderrOverflow.stderr)).toBe(1_024)
  expect(stdoutOverflow.signal).toBe('SIGKILL')
  expect(stderrOverflow.signal).toBe('SIGKILL')
  expect(byteOverflow.stopped).toBe('overflow')
  expect(byteOverflow.stdout).toEqual(new TextEncoder().encode('éé').subarray(0, 3))
  expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(16_777_216)
}, 15_000)

test('kills a quiet descendant when its shell leader exits', async () => {
  const result = await makeRunner().run(['/bin/sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { timeoutMs: 5_000 })
  const pid = trackPid(result.stdoutText)
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()
  expect(pid).toBeGreaterThan(0)
  await expectPidGone(pid)
  expect(descendantPids.has(pid)).toBe(false)
}, 15_000)

test('kills a descendant holding stdout when its shell leader exits', async () => {
  const startedAt = Date.now()
  const result = await makeRunner().run(['/bin/sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 5_000 })
  const pid = trackPid(result.stdoutText)
  expect(Date.now() - startedAt).toBeLessThan(3_000)
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()
  expect(pid).toBeGreaterThan(0)
  await expectPidGone(pid)
  expect(descendantPids.has(pid)).toBe(false)
}, 15_000)

test('rejects invalid arguments and owner names before starting a child', async () => {
  let starts = 0
  const runner = makeRunner({
    start: () => {
      starts++
      throw new Error('invalid arguments must not start a child')
    },
  })
  const invalidCalls: Array<{ argv: readonly string[]; options: RunOptions; error: typeof TypeError | typeof RangeError; message: string }> = [
    { argv: [], options: {}, error: TypeError, message: 'argv must name a command' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { timeoutMs: 0 }, error: RangeError, message: 'timeoutMs must be a positive finite number' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { timeoutMs: -1 }, error: RangeError, message: 'timeoutMs must be a positive finite number' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { timeoutMs: Number.NaN }, error: RangeError, message: 'timeoutMs must be a positive finite number' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { timeoutMs: Number.POSITIVE_INFINITY }, error: RangeError, message: 'timeoutMs must be a positive finite number' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { maxOutputBytes: 0 }, error: RangeError, message: 'maxOutputBytes must be a positive integer' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { maxOutputBytes: 1.5 }, error: RangeError, message: 'maxOutputBytes must be a positive integer' },
    { argv: ['/bin/sh', '-c', 'exit 0'], options: { killGraceMs: -1 }, error: RangeError, message: 'killGraceMs must be zero or a positive finite number' },
  ]
  for (const invalidCall of invalidCalls) {
    const error = await runner.run(invalidCall.argv, invalidCall.options).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(invalidCall.error)
    expect((error as Error).message).toBe(invalidCall.message)
  }
  let ownerError: unknown
  try {
    createProcessRunner({ owner: '' })
  } catch (error) {
    ownerError = error
  }
  expect(ownerError).toBeInstanceOf(TypeError)
  expect((ownerError as Error).message).toBe('owner must be a non-empty string')
  expect(starts).toBe(0)
}, 15_000)
test('propagates output stream errors and kills the unfinished process group', async () => {
  const streamError = new Error('stdout pipe failed')
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const runner = makeRunner({
    start: () => ({
      pid: 900_001,
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.error(streamError) }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: exited.promise,
      killGroup(signal) {
        signals.push(signal)
        exited.resolve({ exitCode: null, signal })
      },
    }),
  })
  const error = await runner.run(['/fake/stream-error'], { timeoutMs: 1_000 }).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBe(streamError)
  expect(signals[0]).toBe('SIGKILL')
}, 15_000)

test('propagates unexpected child exit promise rejections', async () => {
  const exitError = new Error('child exit failed')
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const runner = makeRunner({
    start: () => ({
      pid: 900_002,
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: Promise.reject(exitError),
      killGroup(signal) {
        signals.push(signal)
      },
    }),
  })
  const error = await runner.run(['/fake/exit-error'], { timeoutMs: 1_000 }).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBe(exitError)
  expect(signals).toContain('SIGKILL')
}, 15_000)

test('propagates a pipe failure that arrives after an abort starts waiting for exit', async () => {
  const pipeError = new Error('pipe failed during shutdown')
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  let output!: ReadableStreamDefaultController<Uint8Array>
  const abort = new AbortController()
  const runner = makeRunner({
    start: () => ({
      pid: 900_003,
      stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      exited: exited.promise,
      killGroup(signal) {
        if (signal === 'SIGKILL') exited.resolve({ exitCode: null, signal })
      }
    })
  })
  const pending = runner.run(['fake'], { signal: abort.signal, timeoutMs: 1_000 })
    .then(() => null, error => error)
  abort.abort()
  const turn = Promise.withResolvers<void>()
  setImmediate(turn.resolve)
  await withTimeout(turn.promise, 1_000, 'abort dispatch before pipe failure')
  output.error(pipeError)
  const error = await withTimeout(pending, 1_000, 'pipe failure propagation after abort')
  expect(error).toBe(pipeError)
}, 15_000)

test('does not send a second SIGKILL when overflow or a stream error happens after the leader exited', async () => {
  async function exercise(
    action: 'overflow' | 'error'
  ): Promise<{
    result: RunResult | undefined
    error: unknown
    failure: unknown
    signals: string[]
    lateError: Error
  }> {
    const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
    exited.resolve({ exitCode: 0, signal: null })
    const signals: string[] = []
    const lateError = new Error('late pipe failure')
    let output!: ReadableStreamDefaultController<Uint8Array>
    try {
      const runner = makeRunner({
        start: () => ({
          pid: action === 'overflow' ? 900_005 : 900_006,
          stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller } }),
          stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
          exited: exited.promise,
          killGroup(signal) {
            signals.push(signal)
            if (signal === 'SIGKILL') exited.resolve({ exitCode: null, signal })
          }
        })
      })
      const options = action === 'overflow'
        ? { timeoutMs: 1_000, maxOutputBytes: 1 }
        : { timeoutMs: 1_000 }
      const pending: Promise<{ result: RunResult | undefined; error: unknown }> = runner
        .run(['/fake/post-exit-failure'], options)
        .then(
          result => ({ result, error: undefined }),
          error => ({ result: undefined, error })
        )
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await withTimeout(turn.promise, 1_000, `${action} after leader exit`)
      if (action === 'overflow') output.enqueue(new Uint8Array([1, 2]))
      else output.error(lateError)
      const outcome = await withTimeout(pending, 1_000, `${action} settlement after leader exit`)
      return { ...outcome, failure: undefined, signals, lateError }
    } catch (failure) {
      return { result: undefined, error: undefined, failure, signals, lateError }
    }
  }

  const overflow = await exercise('overflow')
  const streamFailure = await exercise('error')
  expect(overflow.failure).toBeUndefined()
  expect(overflow.result?.stopped).toBe('overflow')
  expect(overflow.result?.stdout.byteLength).toBe(1)
  expect(overflow.result?.exitCode).toBeNull()
  expect(overflow.result?.signal).toBeNull()
  expect(overflow.signals).toEqual(['SIGKILL'])
  expect(streamFailure.failure).toBeUndefined()
  expect(streamFailure.error).toBe(streamFailure.lateError)
  expect(streamFailure.signals).toEqual(['SIGKILL'])
}, 15_000)

test('overflow escalates an already-aborted group immediately without replacing the abort reason', async () => {
  const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  let output!: ReadableStreamDefaultController<Uint8Array>
  const signals: string[] = []
  const abort = new AbortController()
  const runner = makeRunner({
    start: () => ({
      pid: 900_004,
      stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      exited: exited.promise,
      killGroup(signal) {
        signals.push(signal)
        if (signal === 'SIGKILL') exited.resolve({ exitCode: null, signal })
      }
    })
  })
  const pending = runner.run(['fake'], {
    signal: abort.signal, timeoutMs: 1_000, killGraceMs: 1_000, maxOutputBytes: 1
  })
  abort.abort()
  output.enqueue(new Uint8Array([1, 2]))
  const turn = Promise.withResolvers<void>()
  setImmediate(turn.resolve)
  await turn.promise
  expect(signals[0]).toBe('SIGTERM')
  expect(signals[1]).toBe('SIGKILL')
  const result = await pending
  expect(result.stopped).toBe('aborted')
  expect(result.signal).toBe('SIGKILL')
  expect(result.stdout.byteLength).toBe(1)
}, 15_000)

test('1: run waits for repeated group kills before settling and unregistering', async () => {
  let aliveUntil = 0
  let aliveCalls = 0
  let settled = false
  const child = groupDouble({
    groupAlive: () => { aliveCalls++; return Date.now() < aliveUntil },
  })
  const runner = makeRunner({ start: asStart(child) })
  const pending = runner.run(['fake'], { timeoutMs: 5_000 })
  void pending.then(() => { settled = true })
  aliveUntil = Date.now() + 45
  child.finish(4)
  await Bun.sleep(25)
  expect(settled).toBe(false)
  expect(runner.live()).toHaveLength(1)
  const result = await pending
  expect(result.exitCode).toBe(4)
  expect(child.signals.length).toBeGreaterThanOrEqual(3)
  expect(child.signals.every(call => call.signal === 'SIGKILL')).toBe(true)
  expect(runner.live()).toEqual([])
  const signals = child.signals.length
  const aliveCount = aliveCalls
  await Bun.sleep(60)
  expect(child.signals).toHaveLength(signals)
  expect(aliveCalls).toBe(aliveCount)
}, 5_000)

test('2: run reports a surviving group with the leader exit code at the cleanup bound', async () => {
  const child = groupDouble({ groupAlive: () => true })
  const runner = makeRunner({ start: asStart(child) })
  const startedAt = Date.now()
  const pending = runner.run(['fake'], { timeoutMs: 5_000 })
  child.finish(7)
  const result = await pending
  const cleanupMs = Date.now() - startedAt
  expect(cleanupMs).toBeGreaterThanOrEqual(1_000)
  expect(cleanupMs).toBeLessThanOrEqual(1_300)
  expect(result.exitCode).toBe(7)
  expect(result.groupSurvived).toBe(true)
  expect(runner.live()).toEqual([])
}, 5_000)

test.each(['timeout', 'aborted', 'disposal', 'overflow'] as const)('2a: a stopped run keeps %s and groupSurvived', async reason => {
  let finish!: (exitCode?: number | null, signal?: string | null) => void
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined
  const output = reason === 'overflow'
    ? new ReadableStream<Uint8Array>({ start(controller) { outputController = controller } })
    : new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  const child = groupDouble({
    stdout: output,
    groupAlive: () => true,
    onSignal(signal) { finish(null, signal) },
  })
  finish = child.finish
  let starts = 0
  const runner = makeRunner({ start: () => { starts++; return child }, stallMs: 20 })
  const abort = new AbortController()
  const options: RunOptions = {
    timeoutMs: reason === 'timeout' ? 25 : 5_000,
    killGraceMs: 0,
    rerunnable: true,
    maxOutputBytes: 1,
    ...(reason === 'aborted' ? { signal: abort.signal } : {}),
  }
  const pending = runner.run(['fake'], options)
  if (reason === 'aborted') abort.abort()
  if (reason === 'disposal') {
    const disposal = runner.dispose()
    const result = await pending
    await disposal
    expect(result.stopped).toBe('aborted')
    expect(result.groupSurvived).toBe(true)
    expect(starts).toBe(1)
  }
  if (reason === 'overflow') outputController!.enqueue(new Uint8Array([1, 2]))
  const result = await pending
  expect(result.stopped).toBe(reason === 'timeout' || reason === 'overflow' ? reason : 'aborted')
  expect(result.groupSurvived).toBe(true)
  expect(runner.live()).toEqual([])
  expect(starts).toBe(1)
}, 5_000)

test('2a: rerunnable held output on a surviving group returns captured bytes without retrying', async () => {
  let stdoutCancellations = 0
  let stderrCancellations = 0
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  const firstRead = Promise.withResolvers<void>()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller },
    pull() { firstRead.resolve() },
    cancel() { stdoutCancellations++ },
  })
  const stderr = new ReadableStream<Uint8Array>({ cancel() { stderrCancellations++ } })
  const child = groupDouble({ stdout, stderr, groupAlive: () => true })
  let starts = 0
  const runner = makeRunner({
    stallMs: 20,
    start: () => { starts++; return child },
  })
  const pending = runner.run(['fake'], { timeoutMs: 5_000, rerunnable: true })
  await firstRead.promise
  stdoutController.enqueue(new TextEncoder().encode('early\n'))
  child.finish(0)
  const result = await pending
  expect(result.stdoutText).toBe('early\n')
  expect(result.exitCode).toBe(0)
  expect(result.groupSurvived).toBe(true)
  expect(starts).toBe(1)
  expect(stdoutCancellations).toBe(1)
  expect(stderrCancellations).toBe(1)
}, 5_000)

test('2a: rerunnable pipe stalls wait for each attempt group cleanup before retrying', async () => {
  let firstCleanupDeadline: number | undefined
  let firstCleanupDone = false
  let startedBeforeCleanup = false
  let starts = 0
  const first = groupDouble({
    stdout: new ReadableStream<Uint8Array>({ start() {} }),
    groupAlive: () => {
      firstCleanupDeadline ??= Date.now() + 40
      const alive = Date.now() < firstCleanupDeadline
      if (!alive) firstCleanupDone = true
      return alive
    },
  })
  const second = groupDouble({
    stdout: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('second'))
      controller.close()
    } }),
    exit: Promise.resolve({ exitCode: 0, signal: null }),
    groupAlive: () => false,
  })
  const runner = makeRunner({
    stallMs: 20,
    start: () => {
      starts++
      if (starts === 1) return first
      if (!firstCleanupDone) startedBeforeCleanup = true
      return second
    },
  })
  const pending = runner.run(['fake'], { timeoutMs: 5_000, rerunnable: true })
  first.finish(0)
  const result = await pending
  expect(result.stdoutText).toBe('second')
  expect(starts).toBe(2)
  expect(firstCleanupDone).toBe(true)
  expect(startedBeforeCleanup).toBe(false)
}, 5_000)

test('2a: child-exit rejection waits for bounded group cleanup before unregistering', async () => {
  const exitError = new Error('fake exit rejection')
  const aliveUntil = Date.now() + 70
  let aliveCalls = 0
  const child = groupDouble({
    exit: Promise.reject(exitError),
    groupAlive: () => { aliveCalls++; return Date.now() < aliveUntil },
  })
  const runner = makeRunner({ start: asStart(child) })
  const pending = runner.run(['fake'], { timeoutMs: 5_000 }).then(
    () => undefined,
    error => error,
  )
  await Bun.sleep(25)
  expect(runner.live()).toHaveLength(1)
  const error = await pending
  expect(error).toBe(exitError)
  expect(aliveCalls).toBeGreaterThan(1)
  expect(runner.live()).toEqual([])
}, 5_000)

test('4: run disposal during natural-exit cleanup returns aborted after cleanup', async () => {
  let aliveUntil: number | undefined
  const child = groupDouble({
    groupAlive: () => {
      aliveUntil ??= Date.now() + 80
      return Date.now() < aliveUntil
    },
  })
  const runner = makeRunner({ start: asStart(child) })
  const pending = runner.run(['fake'], { timeoutMs: 5_000 })
  child.finish(0)
  while (child.signals.length === 0) await Bun.sleep(1)
  const disposal = runner.dispose()
  const [result] = await Promise.all([pending, disposal])
  expect(result.stopped).toBe('aborted')
  expect(result.groupSurvived).toBeUndefined()
  expect(runner.live()).toEqual([])
}, 5_000)

test('6: rerunnable run cleans up the leader fork race on every invocation', async () => {
  const runner = makeRunner()
  const pidFile = join(homeDir, 'run-race-descendant.pid')
  const countFile = join(homeDir, 'run-race-count.txt')
  const command = 'printf x >> \"$COUNT_FILE\"; (exec /bin/sleep 5) & echo $! > \"$PID_FILE\"; echo early; exit 0'
  for (let index = 0; index < 5; index++) {
    rmSync(pidFile, { recursive: false, force: true })
    let pid: number | undefined
    try {
      const result = await withTimeout(
        runner.run(['/bin/sh', '-c', command], {
          env: { COUNT_FILE: countFile, PID_FILE: pidFile },
          timeoutMs: 10_000,
          rerunnable: true,
        }),
        900,
        'fork-race run',
      )
      pid = trackPidFile(pidFile)
      expect(result.stdoutText).toBe('early\n')
      expect(result.exitCode).toBe(0)
      expect(result.groupSurvived).toBeUndefined()
      expect(pid).toBeGreaterThan(1)
      await expectPidGone(pid!, 900)
    } finally {
      pid ??= trackPidFile(pidFile)
    }
  }
  expect(readFileSync(countFile, 'utf8')).toBe('xxxxx')
}, 10_000)

test('2a: surviving-group cleanup cancels held readers before the stall wait', async () => {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stdoutCancellations = 0
  let stderrCancellations = 0
  const firstRead = Promise.withResolvers<void>()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller },
    pull() { firstRead.resolve() },
    cancel() { stdoutCancellations++ },
  }, { highWaterMark: 0 })
  const stderr = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() { stderrCancellations++ },
  }, { highWaterMark: 0 })
  const child = groupDouble({ stdout, stderr, groupAlive: () => true })
  let starts = 0
  const runner = makeRunner({
    start: () => { starts++; return child },
    stallMs: 10_000,
  })
  const pending = runner.run(['fake'], { timeoutMs: 5_000, rerunnable: true })
  await firstRead.promise
  stdoutController.enqueue(new TextEncoder().encode('early\n'))
  const leaderExitAt = Date.now()
  child.finish(0)
  const result = await withTimeout(pending, 1_300, 'surviving-group cleanup')
  expect(Date.now() - leaderExitAt).toBeGreaterThanOrEqual(1_000)
  expect(Date.now() - leaderExitAt).toBeLessThanOrEqual(1_300)
  expect(result.stdoutText).toBe('early\n')
  expect(result.groupSurvived).toBe(true)
  expect(starts).toBe(1)
  expect(stdoutCancellations).toBe(1)
  expect(stderrCancellations).toBe(1)
}, 5_000)
