import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, liveProcesses } from '../src/api'
import type { OwnedProcessRunner, ProcessRunnerOptions, RunOptions, RunResult } from '../src/api'
import { startChild } from '../src/child'


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
test('truncate preserves exact-cap separate output and flags each discarded stream independently', async () => {
  let stdoutText = 'abcd'
  let stderrText = 'UVWX'
  const runner = makeRunner({
    start: () => completedChild(stdoutText, stderrText),
  })
  const exact = await runner.run(['/fake/truncate'], { maxOutputBytes: 4, overflow: 'truncate' })
  expect(exact.stdoutText).toBe('abcd')
  expect(exact.stderr).toBe('UVWX')
  expect(exact.truncated).toBeUndefined()

  stdoutText = 'abcde'
  stderrText = 'UVWXY'
  const over = await runner.run(['/fake/truncate'], { maxOutputBytes: 4, overflow: 'truncate' })
  expect(over.stdoutText).toBe('abcd')
  expect(over.stderr).toBe('UVWX')
  expect(over.exitCode).toBe(0)
  expect(over.stopped).toBeUndefined()
  expect(over.truncated).toEqual({ stdout: true, stderr: true })
})

test('combined output drains ordered streams under one exact byte cap', async () => {
  async function runCombined(lastChunk: string) {
    const stdout = controlledOutput()
    const stderr = controlledOutput()
    const runner = makeRunner({
      start: () => ({
        pid: 910_001,
        stdout: stdout.stream,
        stderr: stderr.stream,
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        killGroup() {},
      }),
    })
    const pending = runner.run(['/fake/combined'], {
      maxOutputBytes: 5,
      outputMode: 'combined',
      overflow: 'truncate',
    })
    await withTimeout(Promise.all([stdout.waitForRead(), stderr.waitForRead()]), 1_000, 'initial combined reads')
    await withTimeout(stdout.push('ab'), 1_000, 'first stdout chunk')
    await withTimeout(stderr.push('CD'), 1_000, 'stderr chunk')
    await withTimeout(stdout.push(lastChunk), 1_000, 'final stdout chunk')
    stdout.close()
    stderr.close()
    return withTimeout(pending, 1_000, 'combined truncation')
  }

  const exact = await runCombined('e')
  expect(exact.stdoutText).toBe('abCDe')
  expect(exact.stdout).toEqual(new TextEncoder().encode('abCDe'))
  expect(exact.stderr).toBe('')
  expect(exact.exitCode).toBe(0)
  expect(exact.stopped).toBeUndefined()
  expect(exact.truncated).toBeUndefined()

  const over = await runCombined('ef')
  expect(over.stdoutText).toBe('abCDe')
  expect(over.stderr).toBe('')
  expect(over.exitCode).toBe(0)
  expect(over.stopped).toBeUndefined()
  expect(over.truncated).toEqual({ stdout: true, stderr: false })
})

test('truncation copies only the bounded prefix of a much larger child chunk', async () => {
  const oversized = new Uint8Array(1_048_576).fill(0x41)
  const stdout = controlledOutput()
  const runner = makeRunner({
    start: () => ({
      pid: 910_002,
      stdout: stdout.stream,
      stderr: outputStream([]),
      exited: Promise.resolve({ exitCode: 0, signal: null }),
      killGroup() {},
    }),
  })
  const pending = runner.run(['/fake/large-chunk'], { maxOutputBytes: 4, overflow: 'truncate' })
  await withTimeout(stdout.waitForRead(), 1_000, 'large chunk read')
  await withTimeout(stdout.push(oversized), 1_000, 'large chunk consumption')
  oversized.fill(0x42, 0, 4)
  stdout.close()

  const result = await withTimeout(pending, 1_000, 'large chunk completion')
  expect(result.stdout).toEqual(new Uint8Array([0x41, 0x41, 0x41, 0x41]))
  expect(result.stdout.buffer.byteLength).toBe(4)
  expect(result.truncated).toEqual({ stdout: true, stderr: false })
})

test('truncation defaults to separate streams and stop-on-overflow remains the default', async () => {
  const separateRunner = makeRunner({ start: () => completedChild('out', 'err') })
  const separate = await separateRunner.run(['/fake/default-separate'])
  expect(separate.stdoutText).toBe('out')
  expect(separate.stderr).toBe('err')
  expect(separate.truncated).toBeUndefined()

  const stopped = await makeRunner({ start: () => completedChild('abcde', '') })
    .run(['/fake/default-overflow'], { maxOutputBytes: 4 })
  expect(stopped.stdoutText).toBe('abcd')
  expect(stopped.stopped).toBe('overflow')
  expect(stopped.truncated).toEqual({ stdout: true, stderr: false })
})

test('truncate continues draining a real noisy child through its final marker', async () => {
  const marker = join(homeDir, 'completed')
  const result = await makeRunner().run([
    '/bin/sh',
    '-c',
    'i=0; while [ "$i" -lt 10000 ]; do printf 0123456789; i=$((i+1)); done; printf done > "$1"',
    'sh',
    marker,
  ], {
    timeoutMs: 10_000,
    maxOutputBytes: 8,
    overflow: 'truncate',
  })
  expect(result.stdoutText).toBe('01234567')
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()
  expect(result.truncated).toEqual({ stdout: true, stderr: false })
  expect(readFileSync(marker, 'utf8')).toBe('done')
}, 15_000)

test('truncate retains timeout, abort and owner-disposal containment', async () => {
  const argv = ['/bin/sh', '-c', 'while :; do printf 0123456789; done'] as const
  const outputOptions = { maxOutputBytes: 4, overflow: 'truncate' as const, killGraceMs: 0 }
  // The real process deadline must fire while the child continuously floods its pipe.
  const timeout = await makeRunner().run(['/bin/sh', '-c', 'while :; do printf 0123456789; done'], {
    ...outputOptions,
    timeoutMs: 100,
  })
  expect(timeout.stopped).toBe('timeout')
  expect(timeout.stdout.byteLength).toBe(4)
  expect(timeout.truncated).toEqual({ stdout: true, stderr: false })

  const abort = new AbortController()
  const abortRunner = makeRunner()
  const aborting = abortRunner.run(argv, { ...outputOptions, signal: abort.signal, timeoutMs: 10_000 })
  // Real child output has no runner-visible readiness event; allow the flood to begin before abort and disposal.
  await Bun.sleep(50)
  abort.abort()
  const aborted = await withTimeout(aborting, 2_000, 'truncated process abort')
  expect(aborted.stopped).toBe('aborted')
  expect(aborted.stdout.byteLength).toBe(4)
  expect(aborted.truncated).toEqual({ stdout: true, stderr: false })

  const disposalRunner = makeRunner()
  const disposing = disposalRunner.run(argv, { ...outputOptions, timeoutMs: 10_000 })
  await Bun.sleep(50)
  await disposalRunner.dispose()
  const disposed = await withTimeout(disposing, 2_000, 'truncated process disposal')
  expect(disposed.stopped).toBe('aborted')
  expect(disposed.stdout.byteLength).toBe(4)
  expect(disposed.truncated).toEqual({ stdout: true, stderr: false })
}, 15_000)

test('rejects invalid output policies before starting a child', async () => {
  let starts = 0
  const runner = makeRunner({
    start: () => {
      starts++
      throw new Error('invalid output policy must not start a child')
    },
  })
  const invalidOptions: RunOptions[] = [
    { outputMode: 'merged' as RunOptions['outputMode'] },
    { outputMode: null as unknown as RunOptions['outputMode'] },
    { outputMode: 1 as unknown as RunOptions['outputMode'] },
    { overflow: 'discard' as RunOptions['overflow'] },
    { overflow: null as unknown as RunOptions['overflow'] },
    { overflow: 1 as unknown as RunOptions['overflow'] },
  ]
  for (const options of invalidOptions) {
    const error = await runner.run(['/fake/invalid-policy'], options).then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(error).toBeInstanceOf(TypeError)
  }
  expect(starts).toBe(0)
}, 15_000)

test('sharing keys distinguish output policies but normalize explicit defaults', async () => {
  async function exerciseDifferentPolicies(firstOptions: RunOptions, secondOptions: RunOptions): Promise<void> {
    let starts = 0
    const finishes: Array<() => void> = []
    const runner = makeRunner({
      start: () => {
        starts++
        let stdout!: ReadableStreamDefaultController<Uint8Array>
        let stderr!: ReadableStreamDefaultController<Uint8Array>
        const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
        finishes.push(() => {
          stdout.close()
          stderr.close()
          exited.resolve({ exitCode: 0, signal: null })
        })
        return {
          pid: 910_003 + starts,
          stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller } }),
          stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller } }),
          exited: exited.promise,
          killGroup() {},
        }
      },
    })
    const first = runner.run(['/fake/shared-policy'], { share: true, ...firstOptions })
    const second = runner.run(['/fake/shared-policy'], { share: true, ...secondOptions })
    const startCount = starts
    for (const finish of finishes) finish()
    await withTimeout(Promise.all([first, second]), 1_000, 'separate policy runs')
    expect(startCount).toBe(2)
  }

  await exerciseDifferentPolicies({ outputMode: 'separate' }, { outputMode: 'combined' })
  await exerciseDifferentPolicies({ overflow: 'stop' }, { overflow: 'truncate' })

  let starts = 0
  const finishes: Array<() => void> = []
  const runner = makeRunner({
    start: () => {
      starts++
      let stdout!: ReadableStreamDefaultController<Uint8Array>
      let stderr!: ReadableStreamDefaultController<Uint8Array>
      const exited = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
      finishes.push(() => {
        stdout.close()
        stderr.close()
        exited.resolve({ exitCode: 0, signal: null })
      })
      return {
        pid: 910_010,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller } }),
        exited: exited.promise,
        killGroup() {},
      }
    },
  })
  const omitted = runner.run(['/fake/default-sharing'], { share: true })
  const explicit = runner.run(['/fake/default-sharing'], {
    share: true,
    outputMode: 'separate',
    overflow: 'stop',
  })
  const startCount = starts
  for (const finish of finishes) finish()
  await withTimeout(Promise.all([omitted, explicit]), 1_000, 'normalized default sharing')
  expect(startCount).toBe(1)
}, 15_000)

test('retries a post-exit stalled truncated attempt without carrying capture forward', async () => {
  let starts = 0
  let firstOutput!: ControlledOutput
  const runner = makeRunner({
    stallMs: 10,
    start: () => {
      starts++
      if (starts === 1) {
        firstOutput = controlledOutput()
        return {
          pid: 910_020,
          stdout: firstOutput.stream,
          stderr: outputStream([]),
          exited: Promise.resolve({ exitCode: 0, signal: null }),
          killGroup() {},
        }
      }
      return completedChild('z', '')
    },
  })
  const pending = runner.run(['/fake/stalled-truncation'], {
    maxOutputBytes: 1,
    overflow: 'truncate',
    rerunnable: true,
    timeoutMs: 1_000,
  })
  await withTimeout(firstOutput.waitForRead(), 1_000, 'first attempt read')
  await withTimeout(firstOutput.push('first'), 1_000, 'first attempt output')
  const result = await withTimeout(pending, 1_000, 'post-exit stall retry')
  expect(starts).toBe(2)
  expect(result.stdoutText).toBe('z')
  expect(result.exitCode).toBe(0)
  expect(result.truncated).toBeUndefined()
}, 15_000)

test('preserves truncation flags when disposal follows a post-exit pipe stall', async () => {
  const stdout = controlledOutput()
  const exitedByRunner = Promise.withResolvers<void>()
  const runner = makeRunner({
    stallMs: 100,
    start: () => ({
      pid: 910_021,
      stdout: stdout.stream,
      stderr: outputStream([]),
      exited: Promise.resolve({ exitCode: 0, signal: null }),
      killGroup(signal) {
        if (signal === 'SIGKILL') exitedByRunner.resolve()
      },
    }),
  })
  const pending = runner.run(['/fake/stalled-disposal'], {
    maxOutputBytes: 1,
    overflow: 'truncate',
    rerunnable: true,
    timeoutMs: 1_000,
  })
  await withTimeout(stdout.waitForRead(), 1_000, 'stalled attempt read')
  await withTimeout(Promise.all([stdout.push('oversized'), exitedByRunner.promise]), 1_000, 'post-exit pipe setup')
  await runner.dispose()
  const result = await withTimeout(pending, 1_000, 'stalled truncation disposal')
  expect(result.stopped).toBe('aborted')
  expect(result.stdoutText).toBe('o')
  expect(result.truncated).toEqual({ stdout: true, stderr: false })
}, 15_000)

function outputStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

function completedChild(stdout: string, stderr: string) {
  return {
    pid: 910_000,
    stdout: outputStream([stdout]),
    stderr: outputStream([stderr]),
    exited: Promise.resolve({ exitCode: 0, signal: null }),
    killGroup() {},
  }
}
type ControlledOutput = {
  stream: ReadableStream<Uint8Array>
  waitForRead(): Promise<void>
  push(chunk: string | Uint8Array): Promise<void>
  close(): void
}

function controlledOutput(): ControlledOutput {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let requested = Promise.withResolvers<void>()
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    pull() {
      requested.resolve()
    },
  }, { highWaterMark: 0 })
  return {
    stream,
    async waitForRead() {
      await requested.promise
      requested = Promise.withResolvers<void>()
    },
    async push(chunk: string | Uint8Array) {
      const consumed = Promise.withResolvers<void>()
      requested = consumed
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      await consumed.promise
    },
    close() {
      controller.close()
    },
  }
}
