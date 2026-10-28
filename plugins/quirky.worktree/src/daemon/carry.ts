import { chmodSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitApi } from '@quirky/git'
import { MAX_SHARED_DIRECTORIES, sharedEntryProblem, staysInside } from '../shared-paths'
export { MAX_SHARED_DIRECTORIES, sharedEntryProblem } from '../shared-paths'

export const INCLUDE_FILE = '.worktreeinclude'
export const MAX_INCLUDE_BYTES = 256 * 1024
export const MAX_CARRIED_FILES = 1000
export const MAX_CARRIED_BYTES = 500 * 1024 * 1024

const underGit = (path: string): boolean => path === '.git' || path.startsWith('.git/')


/**
 * The first existing directory between `root` and `path` (exclusive of `root` and of `path`
 * itself) that is a symlink, or null. A write through such a directory can land outside `root`.
 */
export function symlinkedAncestor(root: string, path: string): string | null {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const stat = lstatOrNull(current)
    if (stat === null) return null
    if (stat.isSymbolicLink()) return current
  }
  return null
}

/**
 * Copies the primary checkout's ignored files that `.worktreeinclude` names into the new worktree.
 * Candidates are the untracked, ignored files that also match the include file's patterns; `.git`
 * is never copied, an existing destination is kept, and a count and size budget bounds the work.
 * Returns warnings only and never throws.
 */
async function copyIncluded(primary: string, worktree: string): Promise<string[]> {
  const warnings: string[] = []
  const includeFile = join(primary, INCLUDE_FILE)
  let size: number
  try {
    size = statSync(includeFile).size
  } catch {
    return warnings
  }
  if (size > MAX_INCLUDE_BYTES) return [`${INCLUDE_FILE} is larger than ${MAX_INCLUDE_BYTES / 1024} KiB, so no files were carried over`]

  const git = gitApi()
  const ignored = new Set(await git.ignoredUntracked(primary))
  const matched = (await git.matchingExcludeFrom(primary, includeFile)).filter((path) => ignored.has(path) && !underGit(path) && staysInside(path))
  const candidates = matched.slice(0, MAX_CARRIED_FILES)
  if (matched.length > candidates.length) warnings.push(`${INCLUDE_FILE} matched ${matched.length} files; only the first ${MAX_CARRIED_FILES} were copied`)

  let copiedBytes = 0
  let skippedForBudget = 0
  for (const path of candidates) {
    const from = join(primary, path)
    const to = join(worktree, path)
    try {
      const linked = symlinkedAncestor(worktree, path)
      if (linked !== null) {
        warnings.push(`skipped ${path}: ${linked} is a symlink, so writing there could leave the worktree`)
        continue
      }
      if (lstatOrNull(to)) continue
      const stat = lstatSync(from)
      if (stat.isSymbolicLink()) {
        mkdirSync(dirname(to), { recursive: true })
        symlinkSync(readlinkSync(from), to)
        continue
      }
      if (!stat.isFile()) continue
      if (skippedForBudget > 0 || copiedBytes + stat.size > MAX_CARRIED_BYTES) {
        skippedForBudget++
        continue
      }
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to, constants.COPYFILE_EXCL)
      chmodSync(to, stat.mode & 0o777)
      copiedBytes += stat.size
    } catch (error) {
      warnings.push(`could not copy ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (skippedForBudget > 0) warnings.push(`stopped copying at ${MAX_CARRIED_BYTES / 1024 / 1024} MiB; ${skippedForBudget} files were skipped`)
  return warnings
}

/**
 * Links each shared directory of the hooks file into the new worktree, pointing at the primary
 * checkout's copy. Only a directory that exists there and that git ignores is linked; every other
 * entry is skipped with a warning naming why.
 */
async function linkShared(
  primary: string,
  worktree: string,
  entries: string[],
  onLinked?: (entry: string) => void
): Promise<string[]> {
  const warnings: string[] = []
  if (entries.length > MAX_SHARED_DIRECTORIES) warnings.push(`worktree.sharedDirectories lists ${entries.length} entries; only the first ${MAX_SHARED_DIRECTORIES} were used`)
  for (const entry of entries.slice(0, MAX_SHARED_DIRECTORIES)) {
    const skip = (why: string) => warnings.push(`shared directory "${entry}" was skipped: ${why}`)
    const problem = sharedEntryProblem(entry)
    if (problem !== null) {
      skip(problem)
      continue
    }
    const linkedAncestor = symlinkedAncestor(worktree, entry.replace(/\/+$/, ''))
    if (linkedAncestor !== null) {
      skip(`${linkedAncestor} is a symlink, so linking there could leave the worktree`)
      continue
    }
    const source = join(primary, entry)
    const target = join(worktree, entry)
    try {
      if (!existsSync(source)) skip(`it does not exist in ${primary}`)
      else if (!(await gitApi().isIgnored(primary, entry))) skip('it is not ignored by git')
      else if (lstatOrNull(target)) skip('it already exists in the worktree')
      else {
        mkdirSync(dirname(target), { recursive: true })
        symlinkSync(source, target)
        onLinked?.(entry)
      }
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error))
    }
  }
  return warnings
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * Carries local-only files from the primary checkout into a new worktree: the ignored files
 * `.worktreeinclude` selects are copied, and the hooks file's shared directories are linked.
 * Never throws; every problem is a returned warning.
 */
export async function carryFiles(
  primary: string,
  worktree: string,
  sharedDirectories: string[],
  onSharedDirectoryLinked?: (entry: string) => void
): Promise<string[]> {
  const warnings: string[] = []
  for (const step of [
    () => copyIncluded(primary, worktree),
    () => linkShared(primary, worktree, sharedDirectories, onSharedDirectoryLinked)
  ]) {
    try {
      warnings.push(...(await step()))
    } catch (error) {
      warnings.push(`could not carry files: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return warnings
}

