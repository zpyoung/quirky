import type { SpawnExit, SpawnOptions, SpawnStopped, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { GROUP_KILL_INTERVAL_MS, killGroupUntilGone, type ChildExit, type StartChild, type StartedChild } from './child'
import { ProcessStalledError } from './errors'
import { PipeStalledError } from './stall'

/** Default number of stderr bytes retained for a spawned child. */
export const DEFAULT_STDERR_TAIL_BYTES = 16_384
/** How long after process-group cleanup completes a pending spawned-output read waits before it is called stalled. */
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
    stderr: closedStream(),
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

type SpawnReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

class GroupEndSignal {
  private ended = false
  private readonly listeners = new Set<() => void>()

  constructor(groupEnded: Promise<unknown>) {
    void groupEnded.then(() => this.notify(), () => this.notify())
  }

  subscribe(listener: () => void): () => void {
    if (this.ended) {
      listener()
      return () => {}
    }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    if (this.ended) return
    this.ended = true
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}

class SpawnSource {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly pendingReads = new Set<Promise<SpawnReadResult>>()
  private ended = false
  private cancelRequested = false
  private released = false

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  async read(groupEnded: GroupEndSignal, stallMs: number): Promise<SpawnReadResult> {
    if (this.ended) return { done: true, value: undefined }
    const pending = this.reader.read()
    let readSettled = false
    this.pendingReads.add(pending)
    void pending.then(
      result => {
        readSettled = true
        this.pendingReads.delete(pending)
        if (result.done) this.ended = true
        this.releaseIfReady()
      },
      () => {
        readSettled = true
        this.pendingReads.delete(pending)
        this.ended = true
        this.releaseIfReady()
      },
    )

    const stalled = Promise.withResolvers<never>()
    stalled.promise.catch(() => {})
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = groupEnded.subscribe(() => {
      if (!readSettled) stallTimer = setTimeout(() => stalled.reject(new PipeStalledError()), stallMs)
    })
    try {
      const result = await Promise.race([pending, stalled.promise])
      if (result.done) this.ended = true
      this.releaseIfReady()
      return result
    } catch (error) {
      this.cancel()
      throw error
    } finally {
      unsubscribe()
      clearTimeout(stallTimer)
    }
  }

  cancel(): void {
    this.ended = true
    if (!this.cancelRequested) {
      this.cancelRequested = true
      try { void this.reader.cancel().catch(() => {}) } catch {}
    }
    this.releaseIfReady()
  }

  private releaseIfReady(): void {
    if (!this.ended || this.pendingReads.size > 0 || this.released) return
    this.released = true
    try { this.reader.releaseLock() } catch {}
  }
}

type ForwardedOutput = {
  stream: ReadableStream<Uint8Array>
  close(): void
}

function forwardOutput(
  source: SpawnSource,
  groupEnded: GroupEndSignal,
  stallMs: number,
  command: string,
  stopped: () => boolean,
): ForwardedOutput {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  const closeStream = () => {
    if (closed) return
    closed = true
    try { controller?.close() } catch {}
  }
  const close = () => {
    closeStream()
    source.cancel()
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    async pull(value) {
      if (closed) return
      try {
        const { done, value: chunk } = await source.read(groupEnded, stallMs)
        if (closed) return
        if (done) {
          closeStream()
          return
        }
        value.enqueue(chunk)
      } catch (error) {
        if (closed) return
        if (stopped()) {
          close()
          return
        }
        closed = true
        try {
          value.error(error instanceof PipeStalledError ? new ProcessStalledError(command, 1) : error)
        } catch {}
      }
    },
    cancel() {
      closed = true
      source.cancel()
    },
  }, { highWaterMark: 0 })
  return { stream, close }
}

/**
 * Starts a child with demand-driven output and coordinated process-group cleanup.
 * Requires the runner's validated kill grace for every stop path.
 */
export function executeSpawn(
  start: StartChild,
  argv: readonly string[],
  options: SpawnOptions & { killGraceMs: number },
  stallMs: number,
  config: SpawnConfig,
): SpawnedProcess {
  const startedAt = Date.now()
  if (options.signal?.aborted) {
    return inactiveProcess({ exitCode: null, signal: null, stopped: 'aborted', durationMs: 0 }, options.killGraceMs)
  }

  const stdoutMode = options.stdout ?? 'pipe'
  const stderrMode = options.stderr ?? 'tail'
  const stderrTail = stderrMode === 'tail'
    ? new ByteTail(options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES)
    : undefined
  let child: StartedChild
  try {
    child = start(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      stdout: stdoutMode === 'ignore' ? 'ignore' : 'pipe',
      stderr: stderrMode === 'ignore' ? 'ignore' : 'pipe',
    })
  } catch (error) {
    return inactiveProcess({
      exitCode: null,
      signal: null,
      spawnError: errorDetails(error),
      durationMs: Date.now() - startedAt,
    }, options.killGraceMs)
  }

  const stdoutSource = stdoutMode === 'pipe' ? new SpawnSource(child.stdout) : undefined
  const stderrTailSource = stderrMode === 'tail' ? new SpawnSource(child.stderr) : undefined
  const stderrPipeSource = stderrMode === 'pipe' ? new SpawnSource(child.stderr) : undefined
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
  const { promise: groupEnded, resolve: resolveGroupEnded } = Promise.withResolvers<void>()
  const groupEndSignal = new GroupEndSignal(groupEnded)
  let leaderDidExit = false
  let groupExitCompleted = false
  let leaderDurationMs = 0
  let leaderExitError: unknown
  let stopped: SpawnStopped | undefined
  let stopping = false
  let inputClosed = child.stdin === undefined
  let inputEndStarted = false
  let inputEndPromise: Promise<void> = Promise.resolve()
  let closeInputPromise: Promise<void> | undefined
  let writeQueue: Promise<void> = Promise.resolve()
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let gracefulOutputTimer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let graceDeadlineAt: number | undefined
  let groupCleanupPromise: Promise<boolean> | undefined
  let preExitHardKillSent = false
  let unregister = () => {}
  const encoder = new TextEncoder()

  const killGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
    try { child.killGroup(signal) } catch {}
  }
  const groupAlive = () => {
    if (!child.groupAlive) return false
    try { return child.groupAlive() } catch { return true }
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
  const stdoutForwarder = stdoutSource
    ? forwardOutput(stdoutSource, groupEndSignal, stallMs, argv[0] ?? '', () => stopped !== undefined)
    : undefined
  const stderrForwarder = stderrPipeSource
    ? forwardOutput(stderrPipeSource, groupEndSignal, stallMs, argv[0] ?? '', () => stopped !== undefined)
    : undefined
  const closeForwardedOutputsNow = () => {
    clearTimeout(gracefulOutputTimer)
    gracefulOutputTimer = undefined
    stdoutForwarder?.close()
    stderrForwarder?.close()
  }
  const closeAllOutputsNow = () => {
    closeForwardedOutputsNow()
    stderrTailSource?.cancel()
  }
  const startGroupKill = (): Promise<boolean> => {
    if (!groupCleanupPromise) groupCleanupPromise = killGroupUntilGone(child)
    return groupCleanupPromise
  }
  const forceStopNow = (): Promise<boolean> => {
    clearTimeout(graceTimer)
    graceTimer = undefined
    graceDeadlineAt = undefined
    closeAllOutputsNow()
    if (leaderDidExit) return startGroupKill()
    if (!preExitHardKillSent) {
      preExitHardKillSent = true
      killGroup('SIGKILL')
    }
    return Promise.resolve(false)
  }
  const sendGraceKillBeforeExit = (): Promise<boolean> => {
    if (leaderDidExit) return startGroupKill()
    if (!preExitHardKillSent) {
      preExitHardKillSent = true
      killGroup('SIGKILL')
    }
    return Promise.resolve(false)
  }
  const clearTimers = () => {
    clearTimeout(deadlineTimer)
    clearTimeout(graceTimer)
    deadlineTimer = undefined
    graceTimer = undefined
  }
  const scheduleGraceKill = () => {
    clearTimeout(graceTimer)
    graceTimer = undefined
    if (leaderDidExit || groupCleanupPromise || graceDeadlineAt === undefined) return
    const remaining = graceDeadlineAt - Date.now()
    if (remaining <= 0) {
      void sendGraceKillBeforeExit()
      return
    }
    graceTimer = setTimeout(scheduleGraceKill, Math.min(remaining, MAX_TIMER_DELAY_MS))
  }
  const waitForGracefulGroup = async (): Promise<boolean> => {
    for (;;) {
      if (groupCleanupPromise) return groupCleanupPromise
      if (!child.groupAlive) return startGroupKill()
      if (!groupAlive()) return false
      const remaining = (graceDeadlineAt ?? Date.now()) - Date.now()
      if (remaining <= 0) return startGroupKill()
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, Math.min(GROUP_KILL_INTERVAL_MS, remaining))
      await promise
    }
  }
  const finishGroupCleanup = async (): Promise<boolean> => {
    if (!options.groupGrace) return startGroupKill()
    if (groupCleanupPromise) return groupCleanupPromise
    if (stopped !== undefined) {
      if (!child.groupAlive) return startGroupKill()
      if (!groupAlive()) return false
      return waitForGracefulGroup()
    }
    if (!child.groupAlive) return startGroupKill()
    if (!groupAlive()) return false
    killGroup('SIGTERM')
    graceDeadlineAt = Date.now() + options.killGraceMs
    return waitForGracefulGroup()
  }
  const removeAbortListener = () => {
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    abortListener = undefined
  }
  const requestStop = (reason: SpawnStopped, signal: 'SIGTERM' | 'SIGKILL', graceMs: number) => {
    if (leaderDidExit) {
      if (options.groupGrace && !groupExitCompleted) {
        stopped ??= reason
        if (signal === 'SIGKILL') {
          void forceStopNow()
        } else if (reason === 'stop' && graceDeadlineAt !== undefined) {
          graceDeadlineAt = Math.min(graceDeadlineAt, Date.now() + graceMs)
        }
      } else {
        if (signal === 'SIGKILL' && !groupExitCompleted) void forceStopNow()
        else if (signal === 'SIGKILL') closeAllOutputsNow()
        else if (!options.groupGrace) closeForwardedOutputsNow()
      }
    return
    }
    if (stopping) {
      if (signal === 'SIGKILL') void forceStopNow()
      else if (options.groupGrace && reason === 'stop' && graceDeadlineAt !== undefined) {
        graceDeadlineAt = Math.min(graceDeadlineAt, Date.now() + graceMs)
        scheduleGraceKill()
      }
      return
    }

    stopping = true
    stopped = reason
    clearTimeout(deadlineTimer)
    deadlineTimer = undefined
    inputClosed = true
    void endInputNow()
    if (signal === 'SIGKILL') {
      void forceStopNow()
      return
    }

    killGroup('SIGTERM')
    graceDeadlineAt = Date.now() + graceMs
    if (!options.groupGrace) closeForwardedOutputsNow()
    scheduleGraceKill()
  }
  const stopForDisposal = () => requestStop('aborted', 'SIGKILL', 0)
  const stderrDrained = stderrTailSource && stderrTail
    ? (async () => {
      try {
        for (;;) {
          const { done, value } = await stderrTailSource.read(groupEndSignal, stallMs)
          if (done) return
          stderrTail.append(value)
        }
      } catch {
        stderrTailSource.cancel()
      }
    })()
    : Promise.resolve()
  void stderrDrained.catch(() => {})

  unregister = config.onStart(child, stopForDisposal, finished)
  const exitPromise = (async (): Promise<SpawnExit> => {
    let childExit: ChildExit
    try {
      childExit = await child.exited
    } catch (error) {
      childExit = { exitCode: null, signal: null }
      leaderExitError = error
    }
    leaderDidExit = true
    leaderDurationMs = Math.max(0, Date.now() - startedAt)
    clearTimers()
    if (!options.groupGrace) removeAbortListener()

    let groupSurvived = false
    try {
      groupSurvived = await finishGroupCleanup()
    } catch (error) {
      leaderExitError ??= error
      groupSurvived = true
    }
    groupExitCompleted = true
    if (groupSurvived) stderrTailSource?.cancel()
    resolveGroupEnded()
    if (options.groupGrace && stopped !== undefined) {
      gracefulOutputTimer = setTimeout(closeAllOutputsNow, stallMs)
    }
    await stderrDrained
    removeAbortListener()
    unregister()
    return {
      exitCode: childExit.exitCode,
      signal: childExit.signal,
      ...(stopped === undefined ? {} : { stopped }),
      ...(groupSurvived ? { groupSurvived: true as const } : {}),
      ...(leaderExitError === undefined ? {} : { spawnError: errorDetails(leaderExitError) }),
      durationMs: leaderDurationMs,
    }
  })().catch(error => ({
    exitCode: null,
    signal: null,
    ...(stopped === undefined ? {} : { stopped }),
    spawnError: errorDetails(error),
    durationMs: leaderDurationMs || Math.max(0, Date.now() - startedAt),
  }))
  void exitPromise.then(() => finish(), () => finish())

  const stop = (stopOptions?: StopOptions): Promise<SpawnExit> => {
    const requested = validateStopOptions(stopOptions, options.killGraceMs)
    requestStop('stop', requested.signal, requested.graceMs)
    return exitPromise
  }

  if (options.signal) {
    abortListener = () => requestStop('aborted', 'SIGTERM', options.killGraceMs)
    options.signal.addEventListener('abort', abortListener, { once: true })
    if (options.signal.aborted) abortListener()
  }
  if (!stopping && options.timeoutMs !== null) {
    const deadline = startedAt + options.timeoutMs
    const armDeadline = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) requestStop('timeout', 'SIGTERM', options.killGraceMs)
      else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS))
    }
    armDeadline()
  }

  return {
    pid: child.pid,
    stdout: stdoutForwarder?.stream ?? closedStream(),
    stderr: stderrForwarder?.stream ?? closedStream(),
    stderrTail: () => stderrTail?.text() ?? '',
    write(data) {
      if (!child.stdin || inputClosed || stopping || leaderDidExit) return Promise.resolve(false)
      const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data)
      const pending = writeQueue.then(async () => {
        if (stopping || leaderDidExit) return false
        try {
          child.stdin!.write(bytes)
          await child.stdin!.flush()
          return !stopping
        } catch {
          // A stopped child can reject a flush with EPIPE while a write is pending.
          return false
        }
      })
      writeQueue = pending.then(() => undefined, () => undefined)
      return pending
    },
    closeInput() {
      inputClosed = true
      if (!child.stdin || stopping || leaderDidExit) return Promise.resolve()
      if (!closeInputPromise) closeInputPromise = writeQueue.then(() => endInputNow(), () => undefined)
      return closeInputPromise
    },
    exited: exitPromise,
    stop,
  }
}
