import { existsSync } from 'node:fs'
import { join } from 'node:path'

const KIND_NAMES = {
  yaml: { quirky: 'quirky.yaml', orca: 'orca.yaml' },
  dir: { quirky: '.quirky', orca: '.orca' }
} as const

/**
 * Locates a repo's Quirky config, preferring the Quirky name and falling back to
 * the legacy Orca name so repos set up for Orca keep working. Returns null when
 * neither exists. Readers only: writers always use the Quirky name.
 */
export function resolveRepoConfigPath(repoPath: string, kind: 'yaml' | 'dir'): string | null {
  const names = KIND_NAMES[kind]
  const quirkyPath = join(repoPath, names.quirky)
  if (existsSync(quirkyPath)) {
    return quirkyPath
  }
  const orcaPath = join(repoPath, names.orca)
  return existsSync(orcaPath) ? orcaPath : null
}
