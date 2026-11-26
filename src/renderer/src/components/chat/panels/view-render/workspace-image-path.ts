export type WorkspaceImagePath =
  | { ok: true; relativePath: string; absolutePath: string }
  | { ok: false; reason: string }

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Resolves an image path from a spec against the workspace root. Only a relative path that stays
 * inside the root resolves; absolute paths, URLs and `..` escapes are refused.
 */
export function resolveWorkspaceImagePath(
  workspaceRoot: string | null,
  path: string
): WorkspaceImagePath {
  if (workspaceRoot === null || workspaceRoot.trim() === '') {
    return { ok: false, reason: 'there is no workspace to read it from' }
  }
  const text = path.trim()
  if (text === '' || text.includes('\0') || text.includes('\\')) {
    return { ok: false, reason: 'the path is empty or has characters that are not allowed' }
  }
  if (text.startsWith('/') || text.startsWith('~') || URL_SCHEME.test(text)) {
    return { ok: false, reason: 'it must be a path relative to the workspace' }
  }
  const kept: string[] = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (kept.pop() === undefined) {
        return { ok: false, reason: 'the path leaves the workspace' }
      }
      continue
    }
    kept.push(segment)
  }
  if (kept.length === 0) {
    return { ok: false, reason: 'the path names no file' }
  }
  const relativePath = kept.join('/')
  return {
    ok: true,
    relativePath,
    absolutePath: `${workspaceRoot.replace(/\/+$/, '')}/${relativePath}`
  }
}
