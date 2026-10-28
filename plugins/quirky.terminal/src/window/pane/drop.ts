import { shellEscapePaths } from '../../shell-escape'
import { resolveAgainst } from './links'
type DroppedFile = { path?: unknown }

export const WORKTREE_PATHS_MIME = 'application/x-quirky-worktree-paths'

export type WorktreeDropRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; worktreeId: string; paths: string[] }

/** Reads the editor's ownership-tagged relative path payload, distinguishing absence from refusal. */
export function readWorktreePathsDrop(data: DropData): WorktreeDropRead {
  const serialized = data.getData(WORKTREE_PATHS_MIME)
  if (serialized === '') {
    const types = Array.from(data.types ?? [])
    return types.includes(WORKTREE_PATHS_MIME) ? { kind: 'invalid' } : { kind: 'absent' }
  }
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return { kind: 'invalid' }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('worktreeId' in value) ||
    !('paths' in value)
  ) {
    return { kind: 'invalid' }
  }
  const worktreeId = value.worktreeId
  const rawPaths = value.paths
  if (typeof worktreeId !== 'string' || worktreeId === '' || !Array.isArray(rawPaths) || rawPaths.length === 0) return { kind: 'invalid' }
  const paths: string[] = []
  for (const path of rawPaths) {
    if (typeof path !== 'string' || path === '') return { kind: 'invalid' }
    paths.push(path)
  }
  return { kind: 'valid', worktreeId, paths }
}

/** Resolves relative editor paths under the owner root, refusing absolute paths and traversal. */
export function resolveWorktreeDropPaths(root: string, paths: readonly string[]): string[] | null {
  if (!root.startsWith('/') || paths.length === 0) return null
  const normalizedRoot = resolveAgainst(root, '/')
  if (!normalizedRoot) return null
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`
  const resolved: string[] = []
  for (const path of paths) {
    if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').includes('..')) return null
    const absolute = resolveAgainst(path, normalizedRoot)
    if (!absolute || absolute === normalizedRoot || !absolute.startsWith(prefix)) return null
    resolved.push(absolute)
  }
  return [...new Set(resolved)]
}

/** The slice of a `DataTransfer` the drop handler reads. */
export type DropData = { files?: ArrayLike<object> | null; types?: ArrayLike<string> | null; getData(type: string): string }

function fromFileUrl(url: string): string | null {
  if (!/^file:\/\//i.test(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname) : null
  } catch {
    return null
  }
}

/**
 * The absolute file paths in a drop: dropped files that carry a path, and `file://` URLs from the
 * URI list or plain text. Duplicates and paths with control characters are left out.
 */
export function pathsFromDrop(data: DropData): string[] {
  const found: string[] = []
  for (const file of Array.from(data.files ?? []) as DroppedFile[]) {
    if (typeof file.path === 'string' && file.path) found.push(file.path)
  }
  for (const type of ['text/uri-list', 'text/plain']) {
    for (const line of data.getData(type).split(/\r?\n/)) {
      const path = fromFileUrl(line.trim())
      if (path) found.push(path)
    }
  }
  return [...new Set(found)].filter((path) => path.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(path))
}

/** The text typed at a prompt for a drop: its file paths, shell-escaped; empty when the drop carries none. */
export function dropText(data: DropData): string {
  return shellEscapePaths(pathsFromDrop(data))
}
