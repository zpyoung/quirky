import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import type { PluginContext } from '@quirky/protocol'

/** The most entries one list may hold, and the most characters one entry may hold. */
const MAX_ENTRIES = 200
const MAX_ENTRY_LENGTH = 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?)?$/

export interface MarkdownAssetsResult {
  files: Record<string, { path: string; line?: number } | null>
  images: Record<string, string | null>
}

interface Deps {
  context: Pick<PluginContext, 'call' | 'createFileResource' | 'error'>
  /** The working directory and worktree of the session `ref`; throws `not-found` for an unknown session. */
  sessionOf(ref: string): { cwd: string; worktreeId: string }
}

const FLOATING = 'floating'

/** The entries of `value` when it is a list of at most 200 strings of at most 1024 characters. */
function entriesOf(deps: Deps, name: string, value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw deps.context.error('invalid-params', `${name} must be a list of strings`)
  if (value.length > MAX_ENTRIES) throw deps.context.error('invalid-params', `${name} takes at most ${MAX_ENTRIES} entries`)
  if (value.some((entry: string) => entry.length > MAX_ENTRY_LENGTH)) throw deps.context.error('invalid-params', `${name} entries take at most ${MAX_ENTRY_LENGTH} characters`)
  return value as string[]
}

/**
 * The file `entry` names when it is a regular file inside `root` once symlinks are resolved, else null.
 * A relative `entry` means what it means to the agent, so it resolves from `base`, the session's
 * directory, which may sit below `root`. Absolute paths, `..` and symlinks all pass through the same
 * containment check, and `relativePath` is relative to `root`.
 */
async function resolveInside(root: string, base: string, entry: string): Promise<{ canonical: string; relativePath: string; mtimeMs: number } | null> {
  if (entry === '' || entry.includes('\0') || SCHEME.test(entry) || entry.startsWith('//')) return null
  try {
    const canonical = await realpath(isAbsolute(entry) ? entry : join(base, entry))
    const relativePath = relative(root, canonical)
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null
    const info = await stat(canonical)
    if (!info.isFile()) return null
    return { canonical, relativePath: sep === '/' ? relativePath : relativePath.split(sep).join('/'), mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/**
 * The `quirky.session/markdownAssets` handler: tells the chat which paths named in an agent reply
 * are real files of the session's worktree and gives it a displayable url for worktree images.
 * Paths resolve from the session's directory, but the worktree root bounds containment and the
 * returned file `path` is relative to it, which is what `quirky.editor/open` expects. A floating
 * session has no worktree to open files in, so its files answer null and its images stay inside
 * its directory. It never throws for a file that is missing or outside the root, only for malformed
 * params or an unknown session. Image resources are kept per file and modification time for the
 * daemon's life.
 */
export function createMarkdownAssets(deps: Deps): (params: Record<string, unknown>) => Promise<MarkdownAssetsResult> {
  const resources = new Map<string, Promise<string | null>>()

  const imageUrl = (found: { canonical: string; mtimeMs: number }): Promise<string | null> | null => {
    const contentType = IMAGE_TYPES[extname(found.canonical).toLowerCase()]
    if (!contentType) return null
    const key = `${found.canonical}\0${found.mtimeMs}`
    let url = resources.get(key)
    if (!url) {
      url = deps.context
        .createFileResource({ path: found.canonical, contentType, disposition: 'inline' })
        .then((resource) => resource.url)
        .catch(() => {
          resources.delete(key)
          return null
        })
      resources.set(key, url)
    }
    return url
  }

  return async (params) => {
    if (typeof params.session !== 'string' || params.session === '') throw deps.context.error('invalid-params', 'session is required')
    const files = entriesOf(deps, 'files', params.files)
    const images = entriesOf(deps, 'images', params.images)
    const { cwd, worktreeId } = deps.sessionOf(params.session)
    let base: string
    let root: string
    try {
      base = await realpath(cwd)
      root = worktreeId === FLOATING ? base : await realpath(((await deps.context.call('quirky.worktree/resolve', { selector: `id:${worktreeId}` })) as { path: string }).path)
    } catch {
      return { files: Object.fromEntries(files.map((entry) => [entry, null])), images: Object.fromEntries(images.map((entry) => [entry, null])) }
    }

    const result: MarkdownAssetsResult = { files: {}, images: {} }
    await Promise.all([
      ...files.map(async (entry) => {
        const match = LINE_SUFFIX.exec(entry)
        const found = worktreeId === FLOATING ? null : await resolveInside(root, base, match?.[1] ?? entry)
        result.files[entry] = found ? { path: found.relativePath, ...(match?.[2] ? { line: Number(match[2]) } : {}) } : null
      }),
      ...images.map(async (entry) => {
        const found = await resolveInside(root, base, entry)
        result.images[entry] = found ? ((await imageUrl(found)) ?? null) : null
      })
    ])
    return result
  }
}
