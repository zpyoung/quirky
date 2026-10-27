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
export function playSound(file: string, volume: number, log: (message: string) => void): void {
  const argv = playerArgv(file, volume)
  try {
    const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
    child.unref()
    void child.exited.then((code) => {
      if (code !== 0) log(`${argv[0]} exited with ${code} playing ${file}`)
    })
  } catch (error) {
    log(`could not play ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
