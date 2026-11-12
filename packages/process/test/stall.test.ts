import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessRunner, ProcessStalledError } from '../src/api'
import type { OwnedProcessRunner, ProcessRunnerOptions } from '../src/api'

const runners: OwnedProcessRunner[] = []
let homeDir = ''
let previousQuirkyHome: string | undefined
let nextFakePid = 700_000

beforeEach(() => {
  previousQuirkyHome = process.env.QUIRKY_HOME
  homeDir = mkdtempSync(join(tmpdir(), 'quirky-stall-test-'))
  process.env.QUIRKY_HOME = homeDir
})

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()))
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  rmSync(homeDir, { recursive: true, force: true })
})

function makeRunner(options: Omit<ProcessRunnerOptions, 'owner'> = {}) {
  const runner = createProcessRunner({ owner: `stall-test-${nextFakePid++}`, ...options })
  runners.push(runner)
  return runner
}

type FakeChild = {
  pid: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<{ exitCode: number | null; signal: string | null }>
  killGroup: (signal: 'SIGTERM' | 'SIGKILL') => void
}

function stream(chunks: readonly Uint8Array[] = [], close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    },
  })
}

function fakeChild(options: {
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exited?: Promise<{ exitCode: number | null; signal: string | null }>
  killGroup?: (signal: 'SIGTERM' | 'SIGKILL') => void
} = {}): FakeChild {
  return {
    pid: nextFakePid++,
    stdout: options.stdout ?? stream(),
    stderr: options.stderr ?? stream(),
    exited: options.exited ?? Promise.resolve({ exitCode: 0, signal: null }),
    killGroup: options.killGroup ?? (() => {}),
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

test('rejects a stalled output stream when the command is not rerunnable', async () => {
  let starts = 0
  const child = fakeChild({ stdout: stream([], false) })
  const runner = makeRunner({ stallMs: 50, start: () => { starts++; return child } })
  const error = await runner.run(['/fake/stalled'], { timeoutMs: 1_000 }).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ProcessStalledError)
  expect((error as ProcessStalledError).attempts).toBe(1)
  expect((error as Error).message).toBe('/fake/stalled exited but its output did not end')
  expect(starts).toBe(1)
}, 15_000)

test('retries stalled rerunnable output up to three times', async () => {
  let successStarts = 0
  const successRunner = makeRunner({
    stallMs: 30,
    start: () => {
      successStarts++
      return successStarts < 3
        ? fakeChild({ stdout: stream([], false) })
        : fakeChild({ stdout: stream([new TextEncoder().encode('ok')]) })
    },
  })
  const result = await successRunner.run(['/fake/retry'], { rerunnable: true, timeoutMs: 1_000 })
  expect(result.stdoutText).toBe('ok')
  expect(successStarts).toBe(3)

  let stalledStarts = 0
  const stalledRunner = makeRunner({
    stallMs: 30,
    start: () => {
      stalledStarts++
      return fakeChild({ stdout: stream([], false) })
    },
  })
  const error = await stalledRunner.run(['/fake/stalled-three-times'], { rerunnable: true, timeoutMs: 1_000 }).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(ProcessStalledError)
  expect((error as ProcessStalledError).attempts).toBe(3)
  expect(stalledStarts).toBe(3)
}, 15_000)

test('returns partial output for a stopped stalled run without retrying it', async () => {
  let starts = 0
  const { promise: exited, resolve } = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const signals: Array<'SIGTERM' | 'SIGKILL'> = []
  const child = fakeChild({
    stdout: stream([new TextEncoder().encode('partial')], false),
    stderr: stream([], false),
    exited,
    killGroup: (signal) => {
      signals.push(signal)
      resolve({ exitCode: null, signal })
    },
  })
  const runner = makeRunner({ stallMs: 20, start: () => { starts++; return child } })
  const result = await runner.run(['/fake/stopped-stall'], {
    rerunnable: true,
    timeoutMs: 100,
    killGraceMs: 50,
  })
  expect(result.stopped).toBe('timeout')
  expect(result.stdoutText).toBe('partial')
  expect(starts).toBe(1)
  expect(signals).toContain('SIGTERM')
}, 15_000)

test('stops the deadline once the leader exits so a stall longer than timeoutMs rejects or retries', async () => {
  let oneShotStarts = 0
  const oneShotRunner = makeRunner({
    stallMs: 250,
    start: () => {
      oneShotStarts++
      return fakeChild({ stdout: stream([], false) })
    }
  })
  const oneShotError = await withTimeout(
    oneShotRunner.run(['/fake/stalled-past-deadline'], { timeoutMs: 80 }).then(
      () => undefined,
      (reason: unknown) => reason
    ),
    5_000,
    'non-rerunnable stalled run'
  )
  expect(oneShotError).toBeInstanceOf(ProcessStalledError)
  expect((oneShotError as ProcessStalledError).attempts).toBe(1)
  expect((oneShotError as Error).message).toBe('/fake/stalled-past-deadline exited but its output did not end')
  expect(oneShotStarts).toBe(1)

  let firstAttemptStarts = 0
  const firstAttemptRunner = makeRunner({
    stallMs: 150,
    start: () => {
      firstAttemptStarts++
      return fakeChild({ stdout: stream([], false) })
    }
  })
  const firstAttemptError = await withTimeout(
    firstAttemptRunner.run(['/fake/rerunnable-past-deadline'], { rerunnable: true, timeoutMs: 80 }).then(
      () => undefined,
      (reason: unknown) => reason
    ),
    5_000,
    'single rerunnable stall past deadline'
  )
  expect(firstAttemptError).toBeInstanceOf(ProcessStalledError)
  expect((firstAttemptError as ProcessStalledError).attempts).toBe(1)
  expect((firstAttemptError as Error).message).toBe('/fake/rerunnable-past-deadline exited but its output did not end')
  expect(firstAttemptStarts).toBe(1)

  let secondAttemptStarts = 0
  const secondAttemptRunner = makeRunner({
    stallMs: 1_000,
    start: () => {
      secondAttemptStarts++
      return fakeChild({ stdout: stream([], false) })
    }
  })
  const secondAttemptError = await withTimeout(
    secondAttemptRunner.run(['/fake/two-stalls-past-deadline'], { rerunnable: true, timeoutMs: 1_900 }).then(
      () => undefined,
      (reason: unknown) => reason
    ),
    5_000,
    'second rerunnable stall past deadline'
  )
  expect(secondAttemptError).toBeInstanceOf(ProcessStalledError)
  expect((secondAttemptError as ProcessStalledError).attempts).toBe(2)
  expect(secondAttemptStarts).toBe(2)

  let eventualSuccessStarts = 0
  const eventualSuccessRunner = makeRunner({
    stallMs: 150,
    start: () => {
      eventualSuccessStarts++
      return eventualSuccessStarts < 3
        ? fakeChild({ stdout: stream([], false) })
        : fakeChild({ stdout: stream([new TextEncoder().encode('ok')]) })
    }
  })
  const result = await withTimeout(
    eventualSuccessRunner.run(['/fake/three-attempt-success'], { rerunnable: true, timeoutMs: 5_000 }),
    5_000,
    'successful rerunnable run'
  )
  expect(result.stdoutText).toBe('ok')
  expect(result.exitCode).toBe(0)
  expect(result.stopped).toBeUndefined()
  expect(eventualSuccessStarts).toBe(3)
}, 15_000)
