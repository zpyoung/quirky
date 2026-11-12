import type { RunOptions, RunResult, RunStopped } from '@quirky/protocol'
import type { ChildExit, StartedChild, StartChild } from './child'
import { ProcessStalledError } from './errors'
import { PipeStalledError, readChunk } from './stall'

/** Default deadline for one-shot commands. */
export const DEFAULT_TIMEOUT_MS = 30_000
/** Default delay between SIGTERM and SIGKILL when stopping a command. */
export const DEFAULT_KILL_GRACE_MS = 2_000
/** Default byte limit for each captured output stream. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** Maximum number of starts allowed when rerunnable output stalls. */
export const MAX_STALL_ATTEMPTS = 3

const DEFAULT_RERUNNABLE_STALL_MS = 1_000
const DEFAULT_STALL_MS = 10_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

type OutputCapture = {
  byteLength: number
  append(chunk: Uint8Array, maxBytes: number): boolean
  bytes(): Uint8Array
}

type AttemptResult =
  | { kind: 'result'; result: RunResult }
  | { kind: 'stalled'; stdout: Uint8Array; stderr: Uint8Array; exit: ChildExit }

type AttemptConfig = {
  argv: readonly string[]
  options: RunOptions
  startedAt: number
  deadlineMs: number
  killGraceMs: number
  maxOutputBytes: number
  stallMs: number
  config: {
    start: StartChild
    isDisposed: () => boolean
    onStart: (child: StartedChild, stop: () => void) => () => void
  }
}

function capture(): OutputCapture {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  return {
    get byteLength() {
      return byteLength
    },
    append(chunk, maxBytes) {
      const remaining = maxBytes - byteLength
      const length = Math.min(chunk.byteLength, remaining)
      if (length > 0) chunks.push(length === chunk.byteLength ? chunk : chunk.subarray(0, length))
      byteLength += length
      return chunk.byteLength > remaining
    },
    bytes() {
      const result = new Uint8Array(byteLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
      }
      return result
    },
  }
}

function resultFromBytes(
  stdout: Uint8Array,
  stderr: Uint8Array,
  exitCode: number | null,
  signal: string | null,
  startedAt: number,
  stopped?: RunStopped
): RunResult {
  let decodedStdout: string | undefined
  return {
    stdout,
    get stdoutText() {
      if (decodedStdout === undefined) decodedStdout = new TextDecoder().decode(stdout)
      return decodedStdout
    },
    stderr: new TextDecoder().decode(stderr),
    exitCode,
    signal,
    ...(stopped === undefined ? {} : { stopped }),
    durationMs: Date.now() - startedAt,
  }
}

function emptyResult(stopped: RunStopped, durationMs: number): RunResult {
  return { stdout: new Uint8Array(), stdoutText: '', stderr: '', exitCode: null, signal: null, stopped, durationMs }
}

function spawnErrorResult(error: unknown, startedAt: number): RunResult {
  const details = error as { code?: unknown; message?: unknown }
  const code = typeof details?.code === 'string' ? details.code : 'UNKNOWN'
  const message = typeof details?.message === 'string' && details.message.length > 0 ? details.message : String(error)
  const empty = resultFromBytes(new Uint8Array(), new Uint8Array(), null, null, startedAt)
  return {
    stdout: empty.stdout,
    get stdoutText() {
      return empty.stdoutText
    },
    stderr: empty.stderr,
    exitCode: null,
    signal: null,
    spawnError: { code, message: message.length > 0 ? message : 'Process could not be started' },
    durationMs: empty.durationMs,
  }
}

function makeStoppedResult(stdout: Uint8Array, stderr: Uint8Array, exit: ChildExit, startedAt: number, stopped: RunStopped): RunResult {
  return resultFromBytes(stdout, stderr, null, exit.signal, startedAt, stopped)
}


function isPositiveTimerDelay(remaining: number): number {
  return Math.min(Math.max(remaining, 0), MAX_TIMER_DELAY_MS)
}

async function runAttempt({
  argv,
  options,
  startedAt,
  deadlineMs,
  killGraceMs,
  maxOutputBytes,
  stallMs,
  config,
}: AttemptConfig): Promise<AttemptResult> {
  let child: StartedChild
  try {
    const input = typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input
    child = config.start(argv, { cwd: options.cwd, env: options.env, input })
  } catch (error) {
    return { kind: 'result', result: spawnErrorResult(error, startedAt) }
  }

  const stdoutCapture = capture()
  const stderrCapture = capture()
  let exit: ChildExit | undefined
  let stopped: RunStopped | undefined
  let attemptFinished = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let unregister = () => {}
  const { promise: stopRequested, resolve: resolveStopRequested } = Promise.withResolvers<void>()
  const { promise: stallObserved, resolve: resolveStallObserved } = Promise.withResolvers<void>()
  let didStall = false

  const killGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
    try {
      child.killGroup(signal)
    } catch {}
  }
  const clearStopTimers = () => {
    clearTimeout(deadlineTimer)
    clearTimeout(graceTimer)
    deadlineTimer = undefined
    graceTimer = undefined
  }
  const armGraceTimer = (requestedAt: number) => {
    const remaining = killGraceMs - (Date.now() - requestedAt)
    if (remaining <= 0) {
      if (!exit) killGroup('SIGKILL')
      return
    }
    graceTimer = setTimeout(() => armGraceTimer(requestedAt), isPositiveTimerDelay(remaining))
  }
  const requestStop = (reason: RunStopped) => {
    if (attemptFinished || stopped !== undefined) return
    stopped = reason
    clearTimeout(deadlineTimer)
    deadlineTimer = undefined
    if (reason === 'overflow') {
      clearTimeout(graceTimer)
      graceTimer = undefined
      killGroup('SIGKILL')
    } else if (!exit) {
      killGroup('SIGTERM')
      armGraceTimer(Date.now())
    }
    resolveStopRequested()
  }
  const armDeadline = () => {
    const remaining = deadlineMs - Date.now()
    if (remaining <= 0) requestStop('timeout')
    else deadlineTimer = setTimeout(armDeadline, isPositiveTimerDelay(remaining))
  }
  const stopForDisposal = () => {
    if (attemptFinished) return
    stopped = 'aborted'
    clearStopTimers()
    killGroup('SIGKILL')
    resolveStopRequested()
  }

  unregister = config.onStart(child, stopForDisposal)

  const exited = child.exited.then(
    (childExit) => {
      exit = childExit
      clearTimeout(graceTimer)
      graceTimer = undefined
      // a one-shot command must not leave descendants alive or holding its output pipes open
      killGroup('SIGKILL')
      unregister()
      return childExit
    },
    (error) => {
      unregister()
      throw error
    }
  )

  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()

  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>, output: OutputCapture): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await readChunk(reader, exited, stallMs)
        if (done) return
        if (output.append(value, maxOutputBytes)) {
          requestStop('overflow')
          return
        }
      }
    } catch (error) {
      if (!(error instanceof PipeStalledError)) throw error
      didStall = true
      resolveStallObserved()
    }
  }
  const stdoutDone = drain(stdoutReader, stdoutCapture)
  const stderrDone = drain(stderrReader, stderrCapture)
  const allDone = Promise.all([exited, stdoutDone, stderrDone]).then(() => undefined)
  void allDone.catch(() => {})

  const abortSignal = options.signal
  const abortListener = () => requestStop('aborted')
  if (abortSignal) {
    abortSignal.addEventListener('abort', abortListener, { once: true })
    if (abortSignal.aborted) requestStop('aborted')
  }
  if (stopped === undefined) armDeadline()
  if (config.isDisposed()) stopForDisposal()

  try {
    await Promise.race([
      allDone.then(() => 'complete' as const),
      stopRequested.then(() => 'stopped' as const),
      stallObserved.then(() => 'stalled' as const),
    ])
    if (stopped !== undefined) {
      if (!exit) await exited
      stdoutReader.cancel().catch(() => {})
      stderrReader.cancel().catch(() => {})
      await Promise.allSettled([stdoutDone, stderrDone])
      attemptFinished = true
      return {
        kind: 'result',
        result: makeStoppedResult(stdoutCapture.bytes(), stderrCapture.bytes(), exit ?? { exitCode: null, signal: null }, startedAt, stopped),
      }
    }
    if (didStall) {
      stdoutReader.cancel().catch(() => {})
      stderrReader.cancel().catch(() => {})
      await Promise.allSettled([stdoutDone, stderrDone])
      if (stopped !== undefined) {
        attemptFinished = true
        return {
          kind: 'result',
          result: makeStoppedResult(stdoutCapture.bytes(), stderrCapture.bytes(), exit ?? { exitCode: null, signal: null }, startedAt, stopped),
        }
      }
      attemptFinished = true
      return {
        kind: 'stalled',
        stdout: stdoutCapture.bytes(),
        stderr: stderrCapture.bytes(),
        exit: exit ?? { exitCode: null, signal: null },
      }
    }
    attemptFinished = true
    const completedExit = exit ?? { exitCode: null, signal: null }
    return { kind: 'result', result: resultFromBytes(stdoutCapture.bytes(), stderrCapture.bytes(), completedExit.exitCode, completedExit.signal, startedAt) }
  } catch (error) {
    killGroup('SIGKILL')
    void stdoutReader.cancel().catch(() => {})
    void stderrReader.cancel().catch(() => {})
    await Promise.allSettled([exited, stdoutDone, stderrDone])
    throw error
  } finally {
    attemptFinished = true
    clearStopTimers()
    abortSignal?.removeEventListener('abort', abortListener)
    stdoutReader.releaseLock()
    stderrReader.releaseLock()
  }
}

/** Runs one-shot commands with deadlines, bounded output, group cleanup and guarded stream reads. */
export async function executeRun(
  argv: readonly string[],
  options: RunOptions,
  config: {
    start: StartChild
    stallMs?: number
    isDisposed: () => boolean
    onStart: (child: StartedChild, stop: () => void) => () => void
  }
): Promise<RunResult> {
  const startedAt = Date.now()
  if (options.signal?.aborted) return emptyResult('aborted', 0)

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const deadlineMs = startedAt + timeoutMs
  const stallMs = config.stallMs ?? (options.rerunnable ? DEFAULT_RERUNNABLE_STALL_MS : DEFAULT_STALL_MS)
  let attempts = 0
  let lastStall: Extract<AttemptResult, { kind: 'stalled' }> | undefined

  for (;;) {
    if (config.isDisposed() || options.signal?.aborted) {
      if (lastStall) return makeStoppedResult(lastStall.stdout, lastStall.stderr, lastStall.exit, startedAt, 'aborted')
      return emptyResult('aborted', Date.now() - startedAt)
    }
    if (Date.now() >= deadlineMs) {
      if (lastStall) return makeStoppedResult(lastStall.stdout, lastStall.stderr, lastStall.exit, startedAt, 'timeout')
      return emptyResult('timeout', Date.now() - startedAt)
    }

    attempts++
    const outcome = await runAttempt({
      argv,
      options,
      startedAt,
      deadlineMs,
      killGraceMs,
      maxOutputBytes,
      stallMs,
      config,
    })
    if (outcome.kind === 'result') return outcome.result
    lastStall = outcome
    if (config.isDisposed() || options.signal?.aborted) {
      return makeStoppedResult(outcome.stdout, outcome.stderr, outcome.exit, startedAt, 'aborted')
    }
    if (Date.now() >= deadlineMs) {
      return makeStoppedResult(outcome.stdout, outcome.stderr, outcome.exit, startedAt, 'timeout')
    }
    if (!options.rerunnable || attempts >= MAX_STALL_ATTEMPTS) throw new ProcessStalledError(argv[0] ?? '', attempts)
  }
}
