/** Helpers for repositories with huge untracked dependency or build folders. */
import { randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
 * `HUGE_FOLDER_NAMES` are accepted (else `NotAllowedError`), and a `.gitignore` that is a symlink
 * or not a regular file is refused so the write never lands outside the worktree. `added` is
 * false when the line was already there.
 */
export async function appendIgnore(cwd: string, folder: string): Promise<{ added: boolean }> {
  if (!(HUGE_FOLDER_NAMES as readonly string[]).includes(folder)) {
    throw new NotAllowedError(`${folder} cannot be ignored from here`)
  }
  const file = join(cwd, '.gitignore')
  const line = `${folder}/`
  let existing = ''
  let mode: number | undefined
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink()) throw new NotAllowedError('.gitignore is a symlink')
    if (!info.isFile()) throw new NotAllowedError('.gitignore is not a regular file')
    mode = info.mode & 0o7777
    existing = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing.split(/\r?\n/).includes(line)) return { added: false }
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  const temp = join(cwd, `.gitignore.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, `${existing}${separator}${line}\n`, { flag: 'wx' })
    if (mode !== undefined) await chmod(temp, mode)
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  return { added: true }
}
