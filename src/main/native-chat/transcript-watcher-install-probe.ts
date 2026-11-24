import { transcriptFileStat } from './wsl-transcript-fs-access'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'

export async function transcriptWatcherPathIsInstallable(
  filePath: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await transcriptFileStat(filePath, 'exact', signal)
    return true
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return false
  }
}
