import type { SpawnExit, SpawnOptions, SpawnStopped, SpawnedProcess, StopOptions } from '@quirky/protocol'
import type { ChildExit, StartChild, StartedChild } from './child'
import { ProcessStalledError } from './errors'
import { PipeStalledError, readChunk } from './stall'

/** Default number of stderr bytes retained for a spawned child. */
export const DEFAULT_STDERR_TAIL_BYTES = 16_384
/** How long after a child exits a pending spawned-output read waits before it is called stalled. */
export const SPAWN_STALL_MS = 1_000

const MAX_TIMER_DELAY_MS = 2_147_483_647

type SpawnConfig = {
  onStart: (child: StartedChild, stop: () => void, finished: Promise<void>) => () => void
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
}

function errorDetails(error: unknown): { code: string; message: string } {
  const details = error as { code?: unknown; message?: unknown } | null
  const code = typeof details?.code === 'string' ? details.code : 'UNKNOWN'
  const message = typeof details?.message === 'string' && details.message.length > 0 ? details.message : String(error)
  return { code, message: message.length > 0 ? message : 'Process could not be started' }
}

function validateStopOptions(options: StopOptions | undefined, defaultGraceMs: number): { signal: 'SIGTERM' | 'SIGKILL'; graceMs: number } {
  const graceMs = options?.graceMs === undefined ? defaultGraceMs : options.graceMs
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError('graceMs must be zero or a positive finite number')
  const signal = options?.signal ?? 'SIGTERM'
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new TypeError('signal must be "SIGTERM" or "SIGKILL"')
  return { signal, graceMs }
}

function inactiveProcess(exit: SpawnExit, defaultGraceMs: number): SpawnedProcess {
  const exited = Promise.resolve(exit)
  return {
    pid: null,
    stdout: closedStream(),
    stderrTail: () => '',
    write: () => Promise.resolve(false),
    closeInput: () => Promise.resolve(),
    exited,
    stop(options) {
      validateStopOptions(options, defaultGraceMs)
      return exited
    },
  }
}

class ByteTail {
  private readonly buffer: Uint8Array
  private length = 0
  private writeIndex = 0
  private truncated = false

  constructor(capacity: number) {
    this.buffer = new Uint8Array(capacity)
  }

  append(chunk: Uint8Array): void {
    const capacity = this.buffer.byteLength
    if (this.length + chunk.byteLength > capacity) this.truncated = true
    if (chunk.byteLength >= capacity) {
      this.buffer.set(chunk.subarray(chunk.byteLength - capacity), 0)
      this.length = capacity
      this.writeIndex = 0
      return
    }

    const firstLength = Math.min(chunk.byteLength, capacity - this.writeIndex)
    this.buffer.set(chunk.subarray(0, firstLength), this.writeIndex)
    const remaining = chunk.byteLength - firstLength
    if (remaining > 0) this.buffer.set(chunk.subarray(firstLength), 0)
    this.writeIndex = (this.writeIndex + chunk.byteLength) % capacity
    this.length = Math.min(capacity, this.length + chunk.byteLength)
  }

  text(): string {
    if (this.length === 0) return ''
    const bytes = new Uint8Array(this.length)
    const start = this.length === this.buffer.byteLength ? this.writeIndex : 0
    const firstLength = Math.min(this.length, this.buffer.byteLength - start)
    bytes.set(this.buffer.subarray(start, start + firstLength), 0)
    if (firstLength < this.length) bytes.set(this.buffer.subarray(0, this.length - firstLength), firstLength)
    let prefix = 0
    if (this.truncated) {
      while (prefix < bytes.byteLength && (bytes[prefix]! & 0xc0) === 0x80) prefix++
    }
    return new TextDecoder().decode(bytes.subarray(prefix))
  }
}

/** Starts a child with demand-driven stdout, a bounded stderr tail and coordinated lifecycle controls. */
export function executeSpawn(
  start: StartChild,
  argv: readonly string[],
  options: SpawnOptions,
  stallMs: number,
  config: SpawnConfig,
): SpawnedProcess {
  const startedAt = Date.now()
  if (options.signal?.aborted) {
    return inactiveProcess({ exitCode: null, signal: null, stopped: 'aborted', durationMs: 0 }, options.killGraceMs ?? 2_000)
  }

  const stderr = new ByteTail(options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES)
  let child: StartedChild
  try {
    child = start(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      stdout: options.stdout === 'ignore' ? 'ignore' : 'pipe',
      stderr: options.stderr === 'ignore' ? 'ignore' : 'pipe',
    })
  } catch (error) {
    return inactiveProcess({
      exitCode: null,
      signal: null,
      spawnError: errorDetails(error),
      durationMs: Date.now() - startedAt,
    }, options.killGraceMs ?? 2_000)
  }

  // taking the source reader now prevents Bun from buffering an unread pipe without limit
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
  const { promise: leaderExit, resolve: resolveLeaderExit } = Promise.withResolvers<ChildExit>()
  const pendingReadExits = new Set<() => void>()
  let leaderDidExit = false
  let leaderDurationMs: number | undefined
  let leaderExitError: unknown
  let stopped: SpawnStopped | undefined
  let stopping = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let unregister = () => {}
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined
  let outputClosed = false
  let outputCancelled = false
  let inputClosed = child.stdin === undefined
  let inputEndStarted = false
  let inputEndPromise: Promise<void> = Promise.resolve()
  let closeInputPromise: Promise<void> | undefined
  let writeQueue: Promise<void> = Promise.resolve()
  const encoder = new TextEncoder()

  const killGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
    try {
      child.killGroup(signal)
    } catch {}
  }
  const clearTimers = () => {
    clearTimeout(deadlineTimer)
    clearTimeout(graceTimer)
    deadlineTimer = undefined
    graceTimer = undefined
  }
  const endInputNow = (): Promise<void> => {
    if (!child.stdin || inputEndStarted) return inputEndPromise
    inputEndStarted = true
    try {
      inputEndPromise = Promise.resolve(child.stdin.end()).then(() => undefined, () => undefined)
    } catch {
      inputEndPromise = Promise.resolve()
    }
    return inputEndPromise
  }
  const closeOutput = () => {
    outputCancelled = true
    if (!outputClosed) {
      outputClosed = true
      try {
        outputController?.close()
      } catch {}
    }
    void stdoutReader.cancel().catch(() => {})
  }
  const armGrace = (requestedAt: number, graceMs: number) => {
    const remaining = graceMs - (Date.now() - requestedAt)
    if (remaining <= 0) {
      if (!leaderDidExit) killGroup('SIGKILL')
      return
    }
    graceTimer = setTimeout(() => armGrace(requestedAt, graceMs), Math.min(remaining, MAX_TIMER_DELAY_MS))
  }
  const requestStop = (reason: SpawnStopped, signal: 'SIGTERM' | 'SIGKILL', graceMs: number) => {
    if (leaderDidExit) {
      closeOutput()
      return
    }
    if (stopping) {
      if (signal === 'SIGKILL') {
        clearTimeout(graceTimer)
        graceTimer = undefined
        killGroup('SIGKILL')
      }
      return
    }

    stopping = true
    stopped = reason
    clearTimeout(deadlineTimer)
    deadlineTimer = undefined
    inputClosed = true
    void endInputNow()
    closeOutput()
    if (signal === 'SIGKILL') {
      killGroup('SIGKILL')
      return
    }
    killGroup('SIGTERM')
    armGrace(Date.now(), graceMs)
  }
  const stopForDisposal = () => requestStop('aborted', 'SIGKILL', 0)
  const removeAbortListener = () => {
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    abortListener = undefined
  }
  const onLeaderExit = (exit: ChildExit, error?: unknown) => {
    leaderDidExit = true
    leaderDurationMs = Math.max(0, Date.now() - startedAt)
    leaderExitError = error
    clearTimers()
    removeAbortListener()
    // a spawned child must not leave descendants alive or holding its output pipes open
    killGroup('SIGKILL')
    unregister()
    resolveLeaderExit(exit)
    for (const notify of pendingReadExits) notify()
    pendingReadExits.clear()
  }

  unregister = config.onStart(child, stopForDisposal, finished)
  void child.exited.then(
    exit => onLeaderExit(exit),
    error => onLeaderExit({ exitCode: null, signal: null }, error),
  )

  /** Keeps stall-guard subscriptions bounded to reads that are still pending. */
  const readOutput = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const readExit = Promise.withResolvers<void>()
    if (leaderDidExit) readExit.resolve()
    else pendingReadExits.add(readExit.resolve)
    try {
      return await readChunk(reader, readExit.promise, stallMs)
    } finally {
      pendingReadExits.delete(readExit.resolve)
      readExit.resolve()
    }
  }

  const drainStderr = async () => {
    try {
      for (;;) {
        const { done, value } = await readOutput(stderrReader)
        if (done) return
        stderr.append(value)
      }
    } catch {
      void stderrReader.cancel().catch(() => {})
    } finally {
      try {
        stderrReader.releaseLock()
      } catch {}
    }
  }
  const stderrDrained = drainStderr()
  void stderrDrained.catch(() => {})

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller
      if (options.stdout === 'ignore') {
        outputClosed = true
        controller.close()
      }
    },
    async pull(controller) {
      if (outputClosed || outputCancelled || stopping) {
        if (!outputClosed) {
          outputClosed = true
          controller.close()
        }
        return
      }
      try {
        const { done, value } = await readOutput(stdoutReader)
        if (outputClosed || outputCancelled || stopping) {
          if (!outputClosed) {
            outputClosed = true
            controller.close()
          }
          return
        }
        if (done) {
          outputClosed = true
          controller.close()
          try {
            stdoutReader.releaseLock()
          } catch {}
          return
        }
        controller.enqueue(value)
      } catch (error) {
        if (outputClosed || outputCancelled || stopping) {
          if (!outputClosed) {
            outputClosed = true
            controller.close()
          }
          return
        }
        outputClosed = true
        controller.error(error instanceof PipeStalledError ? new ProcessStalledError(argv[0] ?? '', 1) : error)
      }
    },
    cancel() {
      outputCancelled = true
      outputClosed = true
    },
  }, { highWaterMark: 0 })

  const write = (data: string | Uint8Array): Promise<boolean> => {
    if (!child.stdin || inputClosed || stopping || leaderDidExit) return Promise.resolve(false)
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    const pending = writeQueue.then(async () => {
      if (stopping || leaderDidExit) return false
      try {
        child.stdin!.write(bytes)
        await child.stdin!.flush()
        return !stopping && !leaderDidExit
      } catch {
        // a stopped child can reject a flush with EPIPE while a write is pending
        return false
      }
    })
    writeQueue = pending.then(() => undefined, () => undefined)
    return pending
  }
  const closeInput = (): Promise<void> => {
    inputClosed = true
    if (!child.stdin || stopping || leaderDidExit) return Promise.resolve()
    if (!closeInputPromise) closeInputPromise = writeQueue.then(() => endInputNow(), () => undefined)
    return closeInputPromise
  }
  const exitPromise = (async (): Promise<SpawnExit> => {
    const childExit = await leaderExit
    await stderrDrained
    const durationMs = leaderDurationMs ?? Math.max(0, Date.now() - startedAt)
    const details = leaderExitError === undefined ? undefined : errorDetails(leaderExitError)
    return {
      exitCode: childExit.exitCode,
      signal: childExit.signal,
      ...(stopped === undefined ? {} : { stopped }),
      ...(details === undefined ? {} : { spawnError: details }),
      durationMs,
    }
  })().catch(error => ({
    exitCode: null,
    signal: null,
    ...(stopped === undefined ? {} : { stopped }),
    spawnError: errorDetails(error),
    durationMs: leaderDurationMs ?? Math.max(0, Date.now() - startedAt),
  }))
  void exitPromise.then(() => finish(), () => finish())

  const stop = (stopOptions?: StopOptions): Promise<SpawnExit> => {
    const requested = validateStopOptions(stopOptions, options.killGraceMs ?? 2_000)
    requestStop('stop', requested.signal, requested.graceMs)
    return exitPromise
  }

  if (options.signal) {
    abortListener = () => requestStop('aborted', 'SIGTERM', options.killGraceMs ?? 2_000)
    options.signal.addEventListener('abort', abortListener, { once: true })
    if (options.signal.aborted) abortListener()
  }
  if (!stopping && options.timeoutMs !== null) {
    const deadline = startedAt + options.timeoutMs
    const armDeadline = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) requestStop('timeout', 'SIGTERM', options.killGraceMs ?? 2_000)
      else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS))
    }
    armDeadline()
  }

  return {
    pid: child.pid,
    stdout,
    stderrTail: () => stderr.text(),
    write,
    closeInput,
    exited: exitPromise,
    stop,
  }
}
