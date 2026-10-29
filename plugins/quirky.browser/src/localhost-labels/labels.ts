import { NATIVE_BROWSER_LABEL_DOMAIN } from '@quirky/protocol'

export const LOCALHOST_LABEL_DOMAIN = NATIVE_BROWSER_LABEL_DOMAIN

const LABEL_MAX_LENGTH = 48
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::'])

export type LabelWorktree = { id: string; path: string; isMain: boolean }

export function slugifyLabel(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_MAX_LENGTH)
    .replace(/-+$/g, '')
  return slug || 'workspace'
}

/** The worktree folder's slug; a primary checkout becomes `<project>-main` so projects don't collide on "main". */
export function baseLabelForWorktree(worktree: LabelWorktree): string {
  const folder = worktree.path.split(/[\\/]/).map((part) => part.trim()).findLast(Boolean) ?? worktree.path
  return worktree.isMain ? slugifyLabel(`${folder}-main`) : slugifyLabel(folder)
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** An http URL on a loopback host with an explicit port, the only kind of link a label can stand in for. */
export function parseLabelTarget(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !url.port || url.username || url.password) return null
  return LOOPBACK_HOSTS.has(bareHost(url.hostname)) ? url : null
}

/** Wildcard binds aren't connectable destinations, so dial the matching loopback instead. */
export function connectableHost(hostname: string): string {
  const bare = bareHost(hostname)
  if (bare === '0.0.0.0') return '127.0.0.1'
  if (bare === '::') return '::1'
  return bare
}

/** The label a `<label>.quirky.localhost` host names, or null for any other host. */
export function labelFromHost(host: string): string | null {
  const hostname = bareHost(host.replace(/:\d+$/, ''))
  const suffix = `.${LOCALHOST_LABEL_DOMAIN}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) ? label : null
}
