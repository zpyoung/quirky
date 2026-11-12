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
