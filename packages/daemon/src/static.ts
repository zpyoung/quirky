import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

/** File extension to content type for everything the daemon serves over HTTP. */
export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Serves the built UI from `dir`. Paths that are not files and have no extension get
 * `index.html`, so client-side routes load the app. Returns 404 when the UI is not built.
 */
export function serveStatic(dir: string, pathname: string, method: string): Response {
  if (!existsSync(dir)) return new Response('UI is not built', { status: 404 })
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response('bad request', { status: 400 })
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, '')
  const candidate = join(dir, relative)
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return new Response('not found', { status: 404 })

  let target = candidate
  if (!isFile(target)) {
    const lastSegment = relative.split(/[/\\]/).pop() ?? ''
    if (lastSegment.includes('.')) return new Response('not found', { status: 404 })
    target = join(dir, 'index.html')
    if (!isFile(target)) return new Response('not found', { status: 404 })
  }
  const headers = { 'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' }
  return new Response(method === 'HEAD' ? null : Bun.file(target), { headers })
}
