/** Largest stdout a run may produce before it is stopped. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

const KILL_GRACE_MS = 2000
const DRAIN_GRACE_MS = 1000
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
  /** Settles once the process is gone; it never rejects. */
  done: Promise<OneShotOutcome>
  /** Ends the run with `reason`: SIGTERM to the process group, SIGKILL after two seconds. The first reason wins. */
  stop(reason: StopReason): void
}

type Child = ReturnType<typeof Bun.spawn>

function signalGroup(child: Child, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** Reads `stream` to its end, calling `onChunk` for each piece; resolves early when `onChunk` returns false. */
async function drain(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => boolean): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !onChunk(value)) return
    }
  } catch {
    // a killed process can reset its pipe
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** Collects text but keeps only its first and last `STDERR_END_BYTES` once it outgrows twice that, so a runaway log costs no memory. */
function collectEnds(): { push(chunk: Uint8Array): void; text(): string } {
  let whole = Buffer.alloc(0)
  let head: Buffer | null = null
  let tail = Buffer.alloc(0)
  return {
    push(chunk) {
      if (head !== null) {
        tail = Buffer.concat([tail, chunk])
        if (tail.length > STDERR_END_BYTES) tail = tail.subarray(tail.length - STDERR_END_BYTES)
        return
      }
      whole = Buffer.concat([whole, chunk])
      if (whole.length <= STDERR_END_BYTES * 2) return
      head = whole.subarray(0, STDERR_END_BYTES)
      tail = whole.subarray(whole.length - STDERR_END_BYTES)
      whole = Buffer.alloc(0)
    },
    text: () => (head === null ? whole.toString('utf8') : `${head.toString('utf8')}\n${tail.toString('utf8')}`)
  }
}

/**
 * Starts `argv` once as the leader of its own process group, feeds it `stdin`, and collects its
 * output. A run ends when the process exits, after `timeoutMs`, when stdout passes
 * `MAX_OUTPUT_BYTES`, or on `stop`; every group member is then killed, so nothing the agent
 * started outlives the run.
 */
export function startOneShot(input: OneShotRunInput): OneShotRun {
  let child: Child
  try {
    // detached makes the child a group leader so a stop reaches its descendants; the installed bun typings predate the option
    const options = { cwd: input.cwd, env: input.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true } as const
    child = Bun.spawn(input.argv, options as unknown as Bun.SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'>)
  } catch (error) {
    return { done: Promise.resolve({ kind: 'not-started', error: error instanceof Error ? error.message : String(error) }), stop: () => {} }
  }
  const running = child
  let stopReason: StopReason | null = null
  let finished = false
  
  const stop = (reason: StopReason): void => {
    if (stopReason || finished) return
    stopReason = reason
    signalGroup(running, 'SIGTERM')
    setTimeout(() => signalGroup(running, 'SIGKILL'), KILL_GRACE_MS)
  }
  const timeout = setTimeout(() => stop('timeout'), input.timeoutMs)

  const feed = (async () => {
    const sink = running.stdin as Bun.FileSink
    try {
      if (input.stdin !== null) sink.write(input.stdin)
      await sink.end()
    } catch {
      // the agent may exit without reading its prompt
    }
  })()

  const stdout: Buffer[] = []
  let stdoutBytes = 0
  const out = drain(running.stdout as ReadableStream<Uint8Array>, (chunk) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      stop('too-much-output')
      return false
    }
    stdout.push(Buffer.from(chunk))
    return true
  })
  const stderr = collectEnds()
  const err = drain(running.stderr as ReadableStream<Uint8Array>, (chunk) => {
    stderr.push(chunk)
    return true
  })

  const done = (async (): Promise<OneShotOutcome> => {
    await running.exited
    clearTimeout(timeout)
    // a background child of the agent can hold the pipes open after the agent exits, so draining is bounded
    let grace: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<void>((resolve) => {
      grace = setTimeout(resolve, DRAIN_GRACE_MS)
    })
    await Promise.race([Promise.all([out, err, feed]), expired])
    clearTimeout(grace)
    finished = true
    if (stopReason !== null) return { kind: stopReason }
    signalGroup(running, 'SIGKILL')
    return { kind: 'exited', code: running.exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr.text() }
  })()

  return { done, stop }
}
