/** The part of Bun's terminal-attached subprocess API that Bun's published types don't cover. */
export type PtyTerminal = {
  write(data: string | Uint8Array): number
  resize(cols: number, rows: number): void
  close(): void
}

export type PtyProcess = {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly terminal: PtyTerminal
  kill(signal?: number | string): void
}

export type PtySpawnOptions = {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  onData(bytes: Uint8Array): void
  onClose(): void
}

/** Spawns `argv` attached to a new PTY; the child leads its own session and process group. */
export function spawnPty(argv: string[], options: PtySpawnOptions): PtyProcess {
  const spawn = Bun.spawn as unknown as (cmd: string[], init: object) => PtyProcess
  return spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data: (_terminal: unknown, bytes: Uint8Array) => options.onData(bytes),
      exit: () => options.onClose()
    }
  })
}
