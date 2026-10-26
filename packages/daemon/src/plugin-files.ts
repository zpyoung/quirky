import { realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { CONTENT_TYPES } from './static'

const PREFIX = '/plugins/'

function within(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/**
 * Serves one file out of a plugin's directory for `/plugins/<id>/<path>`. `lookup` maps a plugin ID
 * to its directory, or null when the plugin has none to serve. Answers 404 for an unknown plugin,
 * an empty path, a path that leaves the directory (directly or through a symlink), or anything that
 * is not a regular file; 400 when the path is not valid percent-encoding. Never falls back to an
 * index file. HEAD returns the headers with no body.
 */
export function servePluginFile(
  lookup: (pluginId: string) => { dir: string } | null,
  pathname: string,
  method: string
): Response {
  const notFound = () => new Response('not found', { status: 404 })
  if (!pathname.startsWith(PREFIX)) return notFound()
  const rest = pathname.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return notFound()

  let pluginId: string
  let relative: string
  try {
    pluginId = decodeURIComponent(rest.slice(0, slash))
    relative = decodeURIComponent(rest.slice(slash + 1))
  } catch {
    return new Response('bad request', { status: 400 })
  }
  if (relative === '') return notFound()

  const plugin = lookup(pluginId)
  if (!plugin) return notFound()
  const dir = resolve(plugin.dir)
  const candidate = resolve(dir, relative)
  if (candidate === dir || !within(dir, candidate)) return notFound()

  let target: string
  try {
    target = realpathSync(candidate)
    if (!within(realpathSync(dir), target)) return notFound()
    if (!statSync(target).isFile()) return notFound()
  } catch {
    return notFound()
  }
  const headers = { 'content-type': CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream' }
  return new Response(method === 'HEAD' ? null : Bun.file(target), { headers })
}
