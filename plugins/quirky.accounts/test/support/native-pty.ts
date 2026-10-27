/** Bun 1.4's native terminal-attached subprocess API; @types/bun 1.3.1 omits these types. */
export type NativePtyTerminal = {
  write(data: string | Uint8Array): number
  resize(cols: number, rows: number): void
  close(): void
}

export type NativePtyProcess = {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly terminal: NativePtyTerminal
  kill(signal?: number | string): void
}

type NativePtySpawnOptions = {
  env: Record<string, string | undefined>
  terminal: {
    cols: number
    rows: number
    data(terminal: NativePtyTerminal, bytes: Uint8Array): void
  }
}

/** The assertion is limited to Bun.spawn's runtime PTY option and result shape. */
export function spawnNativePty(command: string[], options: NativePtySpawnOptions): NativePtyProcess {
  const spawn = Bun.spawn as unknown as (command: string[], options: NativePtySpawnOptions) => NativePtyProcess
  return spawn(command, options)
}
