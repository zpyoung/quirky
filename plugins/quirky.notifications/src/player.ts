import type { ProcessRunner } from '@quirky/protocol'

/**
 * The command that plays `file` at `volume` (0-100): the executable in `QUIRKY_SOUND_PLAYER`
 * called with the file and the volume, else macOS `afplay`.
 */
export function playerArgv(file: string, volume: number, env: Record<string, string | undefined> = process.env): string[] {
  const custom = env.QUIRKY_SOUND_PLAYER
  if (custom) return [custom, file, String(volume)]
  return ['afplay', '-v', String(volume / 100), file]
}

/** Starts the player without waiting for it; a failure to start or a nonzero exit is logged, never thrown. */
export function playSound(runner: ProcessRunner, file: string, volume: number, log: (message: string) => void): void {
  const argv = playerArgv(file, volume)
  const failed = (error: unknown) => log(`could not play ${file}: ${error instanceof Error ? error.message : String(error)}`)
  try {
    void runner.run(argv, {
      timeoutMs: 86_400_000, maxOutputBytes: 1, overflow: 'truncate', killGraceMs: 2000, env: { ...process.env }
    }).then((result) => {
      const reason = result.spawnError?.message
        ?? (result.stopped ? `process stopped: ${result.stopped}` : undefined)
        ?? (result.signal ? `process terminated by ${result.signal}` : undefined)
      if (reason !== undefined) log(`could not play ${file}: ${reason}`)
      else if (result.exitCode !== 0) log(`${argv[0]} exited with ${result.exitCode} playing ${file}`)
    }, failed)
  } catch (error) {
    failed(error)
  }
}
