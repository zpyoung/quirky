/** How a one-shot command is run. */
export type RunOptions = {
  /** Working directory. Default: the daemon's. */
  cwd?: string
  /** The child's whole environment; nothing is merged in. Default: `process.env` at the time of the call. */
  env?: Record<string, string | undefined>
  /** Written to stdin, which is then closed. With no input, stdin is closed from the start. */
  input?: string | Uint8Array
  /** Deadline in milliseconds, after which the process group is stopped. Default 30,000. */
  timeoutMs?: number
  /** Stops the process group when aborted. */
  signal?: AbortSignal
  /** Per stream. A run that writes more is killed. Default 16 MiB. */
  maxOutputBytes?: number
  /** Time between SIGTERM and SIGKILL when a run is stopped. Default 2,000. */
  killGraceMs?: number
  /** The command keeps no state between runs, so it may be run again when its output stalls after it exited. */
  rerunnable?: boolean
  /**
   * Join an identical call that is already running instead of starting another child. Only for a
   * read whose answer may be a moment old: a caller that has just changed what the command reads
   * must not share. Cannot be combined with `input` or `signal`.
   */
  share?: boolean
}

/** Why the runner ended a command that did not end on its own. */
export type RunStopped = 'timeout' | 'aborted' | 'overflow'

/** The outcome of a one-shot command. Shared runs hand the same object to every caller: treat it as read-only. */
export type RunResult = {
  readonly stdout: Uint8Array
  /** `stdout` decoded as UTF-8, computed on first read. */
  readonly stdoutText: string
  readonly stderr: string
  /** Null when the command was killed by a signal or never started. */
  readonly exitCode: number | null
  readonly signal: string | null
  /** Present when the runner stopped the command; output is then incomplete. */
  readonly stopped?: RunStopped
  /** Present when the command could not be started. */
  readonly spawnError?: { readonly code: string; readonly message: string }
  readonly durationMs: number
}

/** Runs subprocesses under one policy: a deadline, a process-group kill, an output cap and a live table. */
export type ProcessRunner = {
  /**
   * Runs `argv` to completion. Resolves for any exit code, a timeout, an abort, too much output and
   * a command that could not start. Rejects only for bad arguments, a disposed runner, and output
   * that never ended after the command exited. Unexpected pipe or child-exit failures reject
   * with their original error after the process group is killed.
   */
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
}

/** How a streaming or long-lived child is started. */
export type SpawnOptions = {
  /**
   * Deadline in milliseconds after which the child is stopped, or `null` for a child that lives
   * until it exits, is stopped, or its owner is disposed. Required, so every spawn says which.
   */
  timeoutMs: number | null
  /** Working directory. Default: the daemon's. */
  cwd?: string
  /** The child's whole environment; nothing is merged in. Default: `process.env` at the time of the call. */
  env?: Record<string, string | undefined>
  /** `'pipe'` keeps stdin open for `write()`. Default `'ignore'`: stdin is closed from the start. */
  stdin?: 'pipe' | 'ignore'
  /**
   * `'pipe'` (default) delivers stdout through `stdout`; `'ignore'` discards it. Pipe only what is
   * read: an unread pipe fills and the child blocks.
   */
  stdout?: 'pipe' | 'ignore'
  /** `'tail'` (default) keeps the end of stderr for `stderrTail()`; `'ignore'` discards it. */
  stderr?: 'tail' | 'ignore'
  /** How many bytes of stderr are kept. Default 16,384. */
  stderrTailBytes?: number
  /** Stops the process group when aborted. */
  signal?: AbortSignal
  /** Time between SIGTERM and SIGKILL when the child is stopped. Default 2,000. */
  killGraceMs?: number
}

/** Why the runner ended a child: the caller's `stop()`, its deadline, or an abort or disposal. */
export type SpawnStopped = 'stop' | 'timeout' | 'aborted'

/** How a spawned child ended. */
export type SpawnExit = {
  /** Null when the child was killed by a signal or never started. */
  readonly exitCode: number | null
  readonly signal: string | null
  /** Present when a stop was asked for before the child had exited. */
  readonly stopped?: SpawnStopped
  /** Present when the command could not be started. */
  readonly spawnError?: { readonly code: string; readonly message: string }
  /** Whole milliseconds from the call to the child's exit. */
  readonly durationMs: number
}

/** Controls how a spawned child's process group is stopped. */
export type StopOptions = {
  /** The first signal sent to the process group. Default `'SIGTERM'`. */
  signal?: 'SIGTERM' | 'SIGKILL'
  /** Time until SIGKILL follows a SIGTERM. Default: the spawn's `killGraceMs`. */
  graceMs?: number
}

/** A child that is running, or that has ended, or that never started. Every member is safe to use in all three states. */
export type SpawnedProcess = {
  /** Null when the command could not be started. */
  readonly pid: number | null
  /**
   * The child's stdout, read from the pipe only as fast as it is read here. It ends when the child's
   * output ends or the child is stopped, and rejects with `ProcessStalledError` when the child ended
   * on its own and its output did not. Empty when stdout is ignored or the child never started.
   */
  readonly stdout: ReadableStream<Uint8Array>
  /** The last `stderrTailBytes` of stderr so far, as UTF-8 text. Final once `exited` has resolved. */
  stderrTail(): string
  /**
   * Sends `data` to stdin, in call order. Resolves `true` once it has been handed to the pipe, and
   * `false` when stdin is not piped, was closed, or the child is gone. Never rejects.
   */
  write(data: string | Uint8Array): Promise<boolean>
  /** Closes stdin after what was written. Safe to call again. Never rejects. */
  closeInput(): Promise<void>
  /** Resolves when the child has exited, its process group has been killed and stderr has ended. Never rejects. */
  readonly exited: Promise<SpawnExit>
  /**
   * Closes stdin, signals the process group, and sends SIGKILL after the grace period. Resolves to
   * what `exited` resolves to. Ends `stdout`, dropping what was not read. Safe to call again, and
   * a later call asking for SIGKILL sends it at once.
   */
  stop(options?: StopOptions): Promise<SpawnExit>
}

/** Starts streaming and long-lived children under the same policy as `ProcessRunner`. */
export type ProcessSpawner = {
  /**
   * Starts `argv` and returns at once. Throws only for bad arguments and a disposed runner; a
   * command that cannot start is reported through `exited`.
   */
  spawn(argv: readonly string[], options: SpawnOptions): SpawnedProcess
}
