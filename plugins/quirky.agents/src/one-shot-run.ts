import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '@quirky/protocol'

/** Largest stdout a run may produce before it is stopped. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

const KILL_GRACE_MS = 2_000
const DRAIN_GRACE_MS = 1_000
const STDERR_END_BYTES = 16 * 1024

export type OneShotRunInput = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  /** Written to the process's stdin; null closes stdin at once. */
  stdin: string | null
  timeoutMs: number
}

export type StopReason = 'timeout' | 'too-much-output' | 'cancelled'

/** How a run ended: the process exited (`code` is null when a signal ended it), was stopped, or never started. */
export type OneShotOutcome =
  | { kind: 'exited'; code: number | null; stdout: string; stderr: string }
  | { kind: StopReason }
  | { kind: 'not-started'; error: string }

export type OneShotRun = {
  /** Settles once the process and everything in its group is gone; it never rejects. */
  done: Promise<OneShotOutcome>
  /** Ends the run with `reason`: SIGTERM to the process group, SIGKILL after two seconds. The first reason wins. */
  stop(reason: StopReason): void
}

/** Reads a stream to completion, preserving read errors for the caller to classify. */
function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => boolean,
  onError?: (error: unknown) => void
): { done: Promise<void>; cancel(): void } {
  const reader = stream.getReader()
  const done = (async () => {
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done || !onChunk(result.value)) return
      }
    } catch (error) {
      onError?.(error)
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  })()
  return {
    done,
    cancel: () => {
      void reader.cancel().catch(() => undefined)
    }
  }
}

/** Keeps the original first and last `STDERR_END_BYTES` after stderr outgrows twice that. */
function collectEnds(): { push(chunk: Uint8Array): void; text(): string } {
  let whole = Buffer.alloc(0)
  let head: Buffer | null = null
  let tail = Buffer.alloc(0)
  return {
    push(chunk) {
      if (head !== null) {
        const combined = Buffer.concat([tail, chunk])
        tail = Buffer.from(combined.subarray(Math.max(0, combined.length - STDERR_END_BYTES)))
        return
      }
      whole = Buffer.concat([whole, chunk])
      if (whole.length <= STDERR_END_BYTES * 2) return
      head = Buffer.from(whole.subarray(0, STDERR_END_BYTES))
      tail = Buffer.from(whole.subarray(whole.length - STDERR_END_BYTES))
      whole = Buffer.alloc(0)
    },
    text: () => (head === null ? whole.toString('utf8') : `${head.toString('utf8')}\n${tail.toString('utf8')}`)
  }
}

/** Starts one agent process, collecting bounded output and delegating group cleanup to the shared runner. */
export function startOneShot(spawner: ProcessSpawner, input: OneShotRunInput): OneShotRun {
  let handle: SpawnedProcess
  try {
    handle = spawner.spawn(input.argv, {
      cwd: input.cwd,
      env: input.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeoutMs: input.timeoutMs,
      killGraceMs: KILL_GRACE_MS,
      groupGrace: true
    })
  } catch (error) {
    return {
      done: Promise.resolve({ kind: 'not-started', error: error instanceof Error ? error.message : String(error) }),
      stop: () => {}
    }
  }

  let stopReason: StopReason | null = null
  let finished = false
  let stdoutReadError = false
  let stdoutErrorStopRequested = false
  let exitResult: SpawnExit | undefined
  let stopPromise: Promise<void> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const stopHandle = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = handle.stop({ signal: 'SIGTERM', graceMs: KILL_GRACE_MS }).then(
        () => undefined,
        () => undefined
      )
    }
    return stopPromise
  }
  const stop = (reason: StopReason): void => {
    if (stopReason !== null || finished) return
    stopReason = reason
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    void stopHandle()
  }
  timeoutTimer = setTimeout(() => stop('timeout'), input.timeoutMs)

  const exited = handle.exited.then((exit) => {
    exitResult = exit
    return exit
  })
  const stdout: Buffer[] = []
  let stdoutBytes = 0
  let overflowed = false
  const out = drain(handle.stdout, (chunk) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      overflowed = true
      stop('too-much-output')
      return false
    }
    stdout.push(Buffer.from(chunk))
    return true
  }, (error) => {
    if (error instanceof Error && error.name === 'ProcessStalledError') return
    stdoutReadError = true
    if (stopReason === null && exitResult?.stopped === undefined) {
      stdoutErrorStopRequested = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      void stopHandle()
    }
  })
  const stderr = collectEnds()
  const err = drain(handle.stderr, (chunk) => {
    stderr.push(chunk)
    return true
  })

  if (input.stdin !== null) {
    void handle.write(input.stdin).then(() => handle.closeInput()).catch(() => undefined)
  } else {
    void handle.closeInput().catch(() => undefined)
  }

  const done = (async (): Promise<OneShotOutcome> => {
    const exit = await exited
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)

    if (handle.pid === null || exit.spawnError !== undefined) {
      out.cancel()
      err.cancel()
      finished = true
      return { kind: 'not-started', error: exit.spawnError?.message ?? 'Process could not start.' }
    }

    const { promise: drainExpired, resolve: expireDrain } = Promise.withResolvers<void>()
    const drainTimer = setTimeout(expireDrain, DRAIN_GRACE_MS)
    await Promise.race([Promise.all([out.done, err.done]), drainExpired])
    clearTimeout(drainTimer)
    out.cancel()
    err.cancel()

    if (overflowed || stopReason !== null || stdoutReadError) await stopHandle()
    finished = true

    if (overflowed || stopReason === 'too-much-output') return { kind: 'too-much-output' }
    if (stopReason === 'cancelled') return { kind: 'cancelled' }
    if (stopReason === 'timeout' || exit.stopped === 'timeout') return { kind: 'timeout' }
    if (exit.stopped === 'aborted' || (exit.stopped === 'stop' && !stdoutErrorStopRequested)) return { kind: 'cancelled' }
    if (stdoutReadError) {
      return {
        kind: 'exited',
        code: exit.exitCode !== null && exit.exitCode !== 0 ? exit.exitCode : 1,
        stdout: '',
        stderr: stderr.text()
      }
    }
    return { kind: 'exited', code: exit.exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr.text() }
  })()

  return { done, stop }
}
