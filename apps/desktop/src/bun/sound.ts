export type SpawnLike = (
  cmd: string[],
  options: { stdin: 'ignore'; stdout: 'ignore'; stderr: 'ignore' }
) => { unref(): void }

/**
 * Plays `file` at `volume` (0-100) without waiting for it: a detached child process whose
 * failure is ignored, so a missing player never disturbs the shell. `QUIRKY_SOUND_PLAYER`, when
 * set, replaces `afplay` and is invoked as `<player> <file> <volume>` so tests can record plays.
 */
export function playSound(
  file: string,
  volume: number,
  env: Record<string, string | undefined> = process.env,
  spawn: SpawnLike = Bun.spawn as unknown as SpawnLike
): void {
  const player = env.QUIRKY_SOUND_PLAYER
  const cmd = player ? [player, file, String(volume)] : ['afplay', '-v', String(Math.min(1, Math.max(0, volume / 100))), file]
  try {
    spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
  } catch (error) {
    console.warn('sound playback failed:', error)
  }
}
