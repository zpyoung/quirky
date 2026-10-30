import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { NATIVE_BROWSER_PREVIEW_SCHEME, type NativeBrowserPreviewGrant } from '@quirky/protocol'

export type WorkspacePreviewHandler = (request: Request) => Promise<Response>

const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024

/**
 * The document's own promise to stay inside its grant. Electrobun's content rules and Lockdown Mode
 * are what actually stop outbound traffic; this only keeps a well-behaved page from trying.
 */
const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm'
}

function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  })
}

function within(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

/** Slash-joined decoded segments, or null for anything that could name a file outside the request. */
function requestedPath(url: URL, entry: string): string | null {
  if (url.pathname === '/' || url.pathname === '') return entry
  const segments: string[] = []
  for (const raw of url.pathname.split('/').slice(1)) {
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    // Dotfiles stay unreadable even inside the grant: `.env` and `.git` live next to documents.
    if (segment === '' || segment.startsWith('.') || /[/\\\0]/.test(segment)) return null
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Answers `quirky-preview://<grant>/<path>` from the grant's directory, or only its entry file when
 * the grant is entry-only. Symlinks, dotfiles, other grants and anything outside the root get 404;
 * every response is re-read from disk so reload shows the current file.
 */
export function createWorkspacePreviewHandler(grant: NativeBrowserPreviewGrant): WorkspacePreviewHandler {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'Method not allowed')
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return failure(404, 'Not found')
    }
    if (url.protocol !== `${NATIVE_BROWSER_PREVIEW_SCHEME}:` || url.host !== grant.id) return failure(404, 'Not found')
    const path = requestedPath(url, grant.entry)
    if (path === null || (grant.entryOnly && path !== grant.entry)) return failure(404, 'Not found')
    let root: string
    let candidate: string
    try {
      root = await realpath(grant.root)
      const requested = join(root, path)
      const info = await lstat(requested)
      if (!info.isFile() || info.isSymbolicLink()) return failure(404, 'Not found')
      candidate = await realpath(requested)
      if (!within(root, candidate)) return failure(404, 'Not found')
      if (info.size > MAX_PREVIEW_FILE_BYTES) return failure(413, 'File is too large to preview')
    } catch {
      return failure(404, 'Not found')
    }
    const headers = {
      'Content-Type': CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': PREVIEW_CONTENT_SECURITY_POLICY,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    try {
      return new Response(new Uint8Array(await readFile(candidate)), { status: 200, headers })
    } catch {
      return failure(404, 'Not found')
    }
  }
}
