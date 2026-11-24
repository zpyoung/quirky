import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { QUIRKYD_LAUNCHER_FILENAME, QUIRKYD_SERVER_ENTRY_FILENAME } from './quirkyd-artifacts'

export const QUIRKYD_BUILD_HASH_LENGTH = 16

/** The launcher embeds its server digest, keeping the hash older clients calculate. */
export function hashQuirkydLauncher(entryPath: string): string {
  const entry = realpathSync(entryPath)
  const launcher =
    basename(entry) === QUIRKYD_SERVER_ENTRY_FILENAME
      ? join(dirname(entry), QUIRKYD_LAUNCHER_FILENAME)
      : entry
  return createHash('sha256')
    .update(readFileSync(launcher))
    .digest('hex')
    .slice(0, QUIRKYD_BUILD_HASH_LENGTH)
}
