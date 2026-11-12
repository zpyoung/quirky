/** Distinguishes normal exits from termination by a signal. */
export type ChildExit = { exitCode: number | null; signal: string | null }

/** A started child, reduced to what the runner needs. */
export type StartedChild = {
  pid: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<ChildExit>
  /** Signals the child's whole process group; groups that are gone are ignored. */
  killGroup(signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Starts a group leader with closed stdin or byte-exact input and independent output pipes. */
export type StartChild = (argv: readonly string[], init: { cwd?: string; env?: Record<string, string | undefined>; input?: Uint8Array }) => StartedChild

/** Starts argv as a group leader; propagates spawn errors without registering a child. */
export const startChild: StartChild = (argv, init) => {
  const options = {
    cwd: init.cwd,
    env: init.env,
    stdin: init.input ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true
  } as const
  // installed bun typings predate detached, which makes descendant group kills possible
  const proc = Bun.spawn([...argv], options as unknown as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>)
  return {
    pid: proc.pid,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited.then(() => ({ exitCode: proc.exitCode, signal: proc.signalCode ?? null })),
    killGroup(signal) {
      try { process.kill(-proc.pid, signal) } catch {}
    }
  }
}
