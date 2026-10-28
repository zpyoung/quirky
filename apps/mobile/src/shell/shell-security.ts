import type { MobileBundleManifest, MobileBundleRoute, MobileRoute } from '../contracts'

const ASSET_PART = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/

export function resolveBundleRoute(manifest: MobileBundleManifest, route: MobileRoute): MobileBundleRoute {
  if (route === null || typeof route !== 'object') throw new Error('page route is invalid')
  if (route.kind === 'workspaces') {
    if (Object.keys(route).length !== 1) throw new Error('workspace route contains unsupported parameters')
  } else if (route.kind === 'session') {
    if (Object.keys(route).some((key) => !['kind', 'worktreeId', 'sessionId'].includes(key)) ||
      typeof route.worktreeId !== 'string' || route.worktreeId.length === 0 || route.worktreeId.length > 1024 ||
      (route.sessionId !== undefined && (typeof route.sessionId !== 'string' || route.sessionId.length > 1024))) throw new Error('session route parameters are invalid')
  } else {
    throw new Error('page route is not available in this app bundle')
  }
  const found = manifest.routes.find((item) => item.kind === route.kind)
  if (!found) throw new Error('page route is not available in this app bundle')
  return found
}

function validAssetPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.includes('\\') || path.includes('%') || path.includes('\0')) return false
  return path.split('/').every((part) => {
    const last = part.charCodeAt(part.length - 1)
    return part.length > 0 && part !== '.' && part !== '..' && last !== 0x0a && last !== 0x0d &&
      last !== 0x2028 && last !== 0x2029 && ASSET_PART.test(part)
  })
}

export function resolvePageRequestPath(
  urlValue: string,
  expectedOrigin: string,
  method: string,
  allowedPaths: ReadonlySet<string>,
  rangeHeader?: string
): string | null {
  if (urlValue.length === 0 || urlValue.length > 8192 || urlValue.includes('%') || method !== 'GET' || rangeHeader !== undefined) return null
  let url: URL
  let origin: URL
  try {
    url = new URL(urlValue)
    origin = new URL(expectedOrigin)
  } catch {
    return null
  }
  if (url.protocol !== origin.protocol || url.hostname.toLowerCase() !== origin.hostname.toLowerCase() ||
    url.port !== origin.port || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  const schemeIndex = urlValue.indexOf('://')
  const rawPathStart = schemeIndex < 0 ? -1 : urlValue.indexOf('/', schemeIndex + 3)
  const rawPath = rawPathStart < 0 ? '/' : urlValue.slice(rawPathStart).split(/[?#]/, 1)[0]!
  if (rawPath.includes('%') || rawPath.includes('\\') || rawPath.startsWith('//')) return null
  const path = rawPath === '/' ? 'index.html' : rawPath.slice(1)
  if (!validAssetPath(path) || !allowedPaths.has(path)) return null
  return path
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.hostname === '') return null
    return url.href
  } catch {
    return null
  }
}
