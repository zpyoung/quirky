/** Helpers for repositories with huge untracked dependency or build folders. */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NotAllowedError } from './conflicts'
import { runGit } from './run'

/** The only folders `hugeFolders` reports and `appendIgnore` will ignore. */
export const HUGE_FOLDER_NAMES = ['node_modules', '.next', 'dist', 'build', 'target', 'vendor'] as const

/** The `HUGE_FOLDER_NAMES` that are directories at `cwd` and not already ignored, in list order. */
export async function hugeFolders(cwd: string): Promise<string[]> {
  const flags = await Promise.all(
    HUGE_FOLDER_NAMES.map(async (name) => {
      const info = await lstat(join(cwd, name)).catch(() => null)
      if (!info?.isDirectory()) return false
      return (await runGit(cwd, ['check-ignore', '-q', '--', name], { readOnly: true })).exitCode !== 0
    })
  )
  return HUGE_FOLDER_NAMES.filter((_, i) => flags[i])
}

/**
 * Adds `<folder>/` as its own line to `<cwd>/.gitignore`, creating the file if needed. Only the
 * `HUGE_FOLDER_NAMES` are accepted (else `NotAllowedError`). `added` is false when the line
 * was already there.
 */
export async function appendIgnore(cwd: string, folder: string): Promise<{ added: boolean }> {
  if (!(HUGE_FOLDER_NAMES as readonly string[]).includes(folder)) {
    throw new NotAllowedError(`${folder} cannot be ignored from here`)
  }
  const file = join(cwd, '.gitignore')
  const line = `${folder}/`
  const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (existing.split(/\r?\n/).includes(line)) return { added: false }
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await writeFile(file, `${existing}${separator}${line}\n`)
  return { added: true }
}
