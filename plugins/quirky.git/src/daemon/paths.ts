import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

/** A path that is absolute, climbs out with `..`, or resolves outside the worktree through a symlink. */
export class OutsideWorktreeError extends Error {
  constructor(readonly path: string) {
    super(`${path} is outside the worktree`)
    this.name = 'OutsideWorktreeError'
  }
}

/** A worktree-relative path that has been checked to stay inside the worktree. */
export type ContainedPath = {
  /** The normalised path relative to the worktree, without a trailing slash. */
  rel: string
  absolute: string
  /** `lstat` of the leaf (never followed), null when it does not exist. */
  leaf: Stats | null
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

/** The real path of the nearest existing ancestor of `absolute`; a symlink that cannot be resolved counts as outside. */
async function existingAncestor(absolute: string, original: string): Promise<string> {
  for (let at = absolute; ; at = dirname(at)) {
    try {
      return await realpath(at)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const info = await lstat(at).catch(() => null)
      if (info?.isSymbolicLink()) throw new OutsideWorktreeError(original)
      if (dirname(at) === at) throw new OutsideWorktreeError(original)
    }
  }
}

/**
 * Checks that `rel` names a place inside the worktree at `worktreePath` and returns it with its
 * leaf's `lstat`. Rejects (`OutsideWorktreeError`) absolute paths, any `..` segment left after
 * normalising, and a path whose parent directory resolves outside the worktree's real path, which
 * is how a symlinked folder leads out. The leaf itself is never followed.
 */
export async function containedPath(worktreePath: string, rel: string): Promise<ContainedPath> {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) throw new OutsideWorktreeError(String(rel))
  const normal = normalize(rel).replace(/\/+$/, '')
  if (normal === '' || normal === '.' || normal.split(sep).includes('..')) throw new OutsideWorktreeError(rel)

  const absolute = join(worktreePath, normal)
  const [root, parent] = await Promise.all([realpath(worktreePath), existingAncestor(dirname(absolute), rel)])
  if (!within(root, parent)) throw new OutsideWorktreeError(rel)
  return { rel: normal, absolute, leaf: await lstat(absolute).catch(() => null) }
}
