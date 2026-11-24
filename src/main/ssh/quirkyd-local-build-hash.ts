/** Shares the host build identity so activation verifies the shipped entry bytes. */
import { join } from 'node:path'
import { hashQuirkydLauncher } from '../../shared/quirkyd-build-identity'
import { QUIRKYD_LAUNCHER_FILENAME } from '../../shared/quirkyd-artifacts'

export function computeLocalQuirkydBuildHash(localQuirkydDir: string): string {
  return hashQuirkydLauncher(join(localQuirkydDir, QUIRKYD_LAUNCHER_FILENAME))
}
