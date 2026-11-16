/** Distinguishes normal exits from termination by a signal. */
export type ChildExit = { exitCode: number | null; signal: string | null }

/** A child's open stdin, reduced to what the runner needs. */
export type ChildInput = {
  /** Queues bytes for the child's stdin, in call order. */
  write(chunk: Uint8Array): void
  /** Resolves when everything queued has been handed to the pipe. Rejects when the pipe is broken. */
  flush(): Promise<void>
  /** Closes stdin after what was queued. */
  end(): Promise<void>
}

/** A started child, reduced to what the runner needs. */
export type StartedChild = {
  pid: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<ChildExit>
  /** Present when the child was started with `stdin: 'pipe'`. */
  stdin?: ChildInput
  /** Signals the child's whole process group. Never throws; a group that is gone is ignored. */
  killGroup(signal: 'SIGTERM' | 'SIGKILL'): void
  /** Whether any member of the child's process group is left. A double without it has no group. */
  groupAlive?(): boolean
}

/** Starts a group leader with closed, byte-exact or writable stdin and selectable output pipes. */
export type StartChild = (argv: readonly string[], init: {
  cwd?: string
  env?: Record<string, string | undefined>
  input?: Uint8Array
  /** `'pipe'` keeps stdin open and returns `stdin`. Not combined with `input`. */
  stdin?: 'pipe' | 'ignore'
  /** `'ignore'` discards the stream; the returned stream is empty and closed. Default `'pipe'`. */
  stdout?: 'pipe' | 'ignore'
  stderr?: 'pipe' | 'ignore'
}) => StartedChild

/** Interval between process-group SIGKILL attempts. */
export const GROUP_KILL_INTERVAL_MS = 10
/** Maximum time spent trying to empty a process group after its leader exits. */
export const GROUP_KILL_BOUND_MS = 1_000

function validGroupPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1
}

function groupAlive(pid: number): boolean {
  if (!validGroupPid(pid)) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== 'ESRCH'
  }
}

/** Starts argv as a group leader; propagates spawn errors without registering a child. */
export const startChild: StartChild = (argv, init) => {
  const options = {
    cwd: init.cwd,
    env: init.env,
    stdin: init.input ?? init.stdin ?? 'ignore',
    stdout: init.stdout ?? 'pipe',
    stderr: init.stderr ?? 'pipe',
    detached: true
  } as const
  // installed bun typings predate detached, which makes descendant group kills possible
  const proc = Bun.spawn([...argv], options as unknown as Bun.SpawnOptions.OptionsObject<'pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'>)
  const input = typeof proc.stdin === 'object' ? proc.stdin : undefined
  return {
    pid: proc.pid,
    stdout: proc.stdout ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    stderr: proc.stderr ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    ...(input ? {
      stdin: {
        write(chunk: Uint8Array) { input.write(chunk) },
        async flush() { await input.flush() },
        async end() { await input.end() }
      }
    } : {}),
    exited: proc.exited.then(() => ({ exitCode: proc.exitCode, signal: proc.signalCode ?? null })),
    killGroup(signal) {
      if (!validGroupPid(proc.pid)) return
      try { process.kill(-proc.pid, signal) } catch {}
    },
    groupAlive: () => groupAlive(proc.pid),
  }
}

/** Repeats SIGKILL until the process group is gone or the cleanup bound expires. */
export async function killGroupUntilGone(child: StartedChild): Promise<boolean> {
  const startedAt = Date.now()
  for (;;) {
    try { child.killGroup('SIGKILL') } catch {}
    if (!child.groupAlive) return false
    let alive = true
    try { alive = child.groupAlive() } catch {}
    if (!alive) return false

    const remaining = GROUP_KILL_BOUND_MS - (Date.now() - startedAt)
    if (remaining <= 0) return true
    const { promise: delay, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, Math.min(GROUP_KILL_INTERVAL_MS, remaining))
    await delay
  }
}

/** Where a detached child's output goes: an open file descriptor, or nowhere. */
export type DetachedOutput = number | 'ignore'

/**
 * Starts a child that outlives its caller, with closed stdin and its own session and process group.
 * Returns without waiting; the child is never registered, signalled or waited on by this package.
 * Output descriptors remain open and owned by the caller. Spawn errors propagate synchronously.
 * Kernel code only: plugins cannot use this launcher.
 */
export function launchDetached(
  argv: readonly string[],
  init: {
    cwd?: string
    env?: Record<string, string | undefined>
    stdout?: DetachedOutput
    stderr?: DetachedOutput
  } = {}
): { pid: number } {
  if (argv.length === 0 || !argv[0]) throw new TypeError('argv must name a command')
  const child = Bun.spawn([...argv], {
    cwd: init.cwd,
    env: init.env,
    stdin: 'ignore',
    stdout: init.stdout ?? 'ignore',
    stderr: init.stderr ?? 'ignore',
    detached: true
  } as unknown as Bun.SpawnOptions.OptionsObject<'ignore', DetachedOutput, DetachedOutput>)
  child.unref()
  return { pid: child.pid }
}
