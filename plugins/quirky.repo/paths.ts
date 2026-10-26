import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

/** `path` with a leading `~` replaced by the home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * `path` with symlinks resolved. The deepest existing ancestor is resolved and the rest appended,
 * so a path that doesn't exist yet gets the same prefix git will report once it does.
 */
export function resolveRealPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(resolveRealPath(parent), basename(path))
  }
}

/** True when `child` is `parent` or lies inside it. */
export function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** The literal path and, when different, its resolved form, so either spelling can match. */
export function pathForms(path: string): string[] {
  const real = resolveRealPath(path)
  return real === path ? [path] : [path, real]
}
