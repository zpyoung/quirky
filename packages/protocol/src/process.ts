/** How a one-shot command is run. */
export type RunOptions = {
  /** Working directory. Default: the daemon's. */
  cwd?: string
  /** The child's whole environment; nothing is merged in. Default: `process.env` at the time of the call. */
  env?: Record<string, string | undefined>
  /** Written to stdin, which is then closed. With no input, stdin is closed from the start. */
  input?: string | Uint8Array
  /**
   * Deadline in milliseconds, after which the process group is stopped. Default 30,000. Once a
   * leader exits the timer stops for that attempt's stall wait and no further rerun starts after
   * the deadline, so a call ends within about `timeoutMs + killGraceMs + one stall wait + one
   * second of process-group cleanup`.
   */
  timeoutMs?: number
  /** Stops the process group when aborted. */
  signal?: AbortSignal
  /** Per-stream in separate mode and shared in combined mode. Default: 16 MiB. */
  maxOutputBytes?: number
  /** Capture streams independently or append both to stdout. Default: 'separate'. */
  outputMode?: 'separate' | 'combined'
  /** Stop at the cap or keep draining while retaining bounded prefixes. Default: 'stop'. */
  overflow?: 'stop' | 'truncate'
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
  /** Present when members of the process group were still there one second after the command exited. */
  readonly groupSurvived?: true
  /** Present only when bytes were discarded from the captured output. */
  readonly truncated?: { readonly stdout: boolean; readonly stderr: boolean }
  /** Present when the command could not be started. */
  readonly spawnError?: { readonly code: string; readonly message: string }
  readonly durationMs: number
}

/** Runs subprocesses under one policy: a deadline, a process-group kill, an output cap and a live table. */
export type ProcessRunner = {
  /**
   * Runs `argv` to completion. Resolves for any exit code, a timeout, an abort, too much output and
   * a command that could not start. Rejects only for bad arguments, a disposed runner, output that
   * never ended after the command exited, and unexpected pipe or child-exit failures (after the
   * process group is killed).
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
  /** `'tail'` (default) keeps the end of stderr for `stderrTail()`; `'ignore'` discards it. `'pipe'` exposes raw stderr. */
  stderr?: 'tail' | 'ignore' | 'pipe'
  /** How many bytes of stderr are kept in tail mode. Default 16,384. */
  stderrTailBytes?: number
  /** Stops the process group when aborted. */
  signal?: AbortSignal
  /** Time between SIGTERM and SIGKILL when the child is stopped. Default 2,000 ms. */
  killGraceMs?: number
  /**
   * Gives the whole process group the grace period, not only the leader. After a stop request the
   * remaining members keep the rest of the grace once the leader has exited; when the leader exits
   * on its own they get SIGTERM and the grace. Piped output stays open until the group has ended,
   * and a stop asked for during that time is recorded and can shorten the grace. A SIGKILL stop and
   * disposal end everything at once. Default false.
   */
  groupGrace?: boolean
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
  /** Present when members of the process group were still there one second after the last kill began. */
  readonly groupSurvived?: true
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
  /**
   * The last `stderrTailBytes` of stderr so far, as UTF-8 text. Final once `exited` has resolved,
   * and always empty when `stderr` is `'pipe'`.
   */
  stderrTail(): string
  /**
   * Raw stderr when `stderr` is `'pipe'`, under the rules of `stdout`: read on demand, ended by a
   * stop, failing with `ProcessStalledError` only when the child ended on its own. Otherwise empty.
   */
  readonly stderr: ReadableStream<Uint8Array>
  /**
   * Sends `data` to stdin, in call order. Resolves `true` once it has been handed to the pipe, and
   * `false` when stdin is not piped, was closed, or the child is gone. Never rejects.
   */
  write(data: string | Uint8Array): Promise<boolean>
  /** Closes stdin after what was written. Safe to call again. Never rejects. */
  closeInput(): Promise<void>
  /** Resolves when the process group has ended or reached its cleanup bound. Never waits for a reader; never rejects. */
  readonly exited: Promise<SpawnExit>
  /**
   * Closes stdin and signals the process group. With `groupGrace`, a graceful stop keeps output open
   * through the grace; a SIGKILL stop and disposal end output at once. Resolves to what `exited`
   * resolves to. Safe to call again, and a later call asking for SIGKILL sends it at once.
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
