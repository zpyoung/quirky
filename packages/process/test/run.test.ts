import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from '../src/api'
import type { OwnedProcessRunner, ProcessRunnerOptions, RunOptions, RunResult } from '../src/api'

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

async function expectPidGone(pid: number, waitMs = 1_000): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0)
    } catch {
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
}, 15_000)

test('escalates from SIGTERM to SIGKILL when the process group ignores SIGTERM', async () => {
  const result = await makeRunner().run(['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"], {
    timeoutMs: 200,
    killGraceMs: 300,
  })
  expect(result.stopped).toBe('timeout')
  expect(result.signal).toBe('SIGKILL')
  expect(result.durationMs).toBeGreaterThanOrEqual(450)
  expect(result.durationMs).toBeLessThan(3_000)
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
  const stdoutOverflow = await runner.run(['/bin/sh', '-c', 'head -c 1048576 /dev/zero'], {
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  })
  const stderrOverflow = await runner.run(['/bin/sh', '-c', 'head -c 1048576 /dev/zero >&2'], {
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  })
  const byteOverflow = await runner.run(['/bin/sh', '-c', 'printf "éé"'], { timeoutMs: 10_000, maxOutputBytes: 3 })
  expect(stdoutOverflow.stopped).toBe('overflow')
  expect(stdoutOverflow.stdout.byteLength).toBe(1_024)
  expect(stderrOverflow.stopped).toBe('overflow')
  expect(Buffer.byteLength(stderrOverflow.stderr)).toBe(1_024)
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
}, 15_000)

test('kills a descendant holding stdout when its shell leader exits', async () => {
  const startedAt = Date.now()
  const result = await makeRunner().run(['/bin/sh', '-c', 'sleep 30 & echo $!'], { timeoutMs: 5_000 })
  const pid = trackPid(result.stdoutText)
  expect(Date.now() - startedAt).toBeLessThan(1_000)
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()
  expect(pid).toBeGreaterThan(0)
  await expectPidGone(pid)
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
      killGroup() {}
    })
  })
  const pending = runner.run(['fake'], { signal: abort.signal, timeoutMs: 1_000 })
    .then(() => null, error => error)
  abort.abort()
  const turn = Promise.withResolvers<void>()
  setImmediate(turn.resolve)
  await turn.promise
  output.error(pipeError)
  exited.resolve({ exitCode: null, signal: 'SIGTERM' })
  expect(await pending).toBe(pipeError)
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
