import type { PanelRoute } from '../panels/contracts'
import { validatePanelRoute } from '../panels/routes'

export type ParsedPanelDeepLink = { hostId: string; route: PanelRoute }

type LinkQuery = { path?: string } | null

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function parseQuery(value: string | undefined): LinkQuery {
  if (value === undefined) return {}
  if (value.length === 0) return null
  const separator = value.indexOf('=')
  if (separator < 0 || value.indexOf('&') >= 0) return null
  const key = decodeSegment(value.slice(0, separator).replace(/\+/g, ' '))
  const path = decodeSegment(value.slice(separator + 1).replace(/\+/g, ' '))
  if (key !== 'path' || path === null) return null
  return { path }
}

function validatedRoute(value: unknown): PanelRoute | null {
  try {
    return validatePanelRoute(value)
  } catch {
    return null
  }
}

/** Parse a strict host-bound panel link without resolving unknown hosts or granting new authority. */
export function parsePanelDeepLink(url: string, pairedHostIds: readonly string[]): ParsedPanelDeepLink | null {
  const match = /^quirky:\/\/h\/([^?#]*)(?:\?([^#]*))?$/.exec(url)
  if (!match) return null

  const rawSegments = match[1]!.split('/')
  if (rawSegments.some((segment) => segment.length === 0)) return null
  const hostId = decodeSegment(rawSegments[0]!)
  if (!hostId || !pairedHostIds.includes(hostId)) return null

  const segments = rawSegments.slice(1).map(decodeSegment)
  if (segments.some((segment) => segment === null)) return null
  const routeSegments = segments as string[]
  const query = parseQuery(match[2])
  if (query === null) return null

  let route: unknown
  if (routeSegments.length === 1 && routeSegments[0] === 'tasks' && query.path === undefined) {
    route = { kind: 'tasks' }
  } else if (routeSegments.length === 1 && routeSegments[0] === 'accounts' && query.path === undefined) {
    route = { kind: 'accounts' }
  } else if (routeSegments[0] === 'notifications' && query.path === undefined && routeSegments.length <= 2) {
    route = { kind: 'notifications', ...(routeSegments[1] === undefined ? {} : { worktreeId: routeSegments[1] }) }
  } else if (routeSegments.length === 2 && routeSegments[0] === 'source-control' && query.path === undefined) {
    route = { kind: 'source-control', worktreeId: routeSegments[1] }
  } else if (routeSegments.length === 2 && routeSegments[0] === 'pr' && query.path === undefined) {
    route = { kind: 'source-control', worktreeId: routeSegments[1], tab: 'pull-request' }
  } else if (routeSegments.length === 2 && routeSegments[0] === 'history' && query.path === undefined) {
    route = { kind: 'source-control', worktreeId: routeSegments[1], tab: 'commits' }
  } else if (routeSegments.length === 2 && routeSegments[0] === 'agent-history' && query.path === undefined) {
    route = { kind: 'agent-history', worktreeId: routeSegments[1] }
  } else if (routeSegments.length === 2 && routeSegments[0] === 'review') {
    route = { kind: 'review', worktreeId: routeSegments[1], ...(query.path === undefined ? {} : { path: query.path }) }
  } else if (routeSegments.length === 2 && routeSegments[0] === 'files') {
    route = { kind: 'files', worktreeId: routeSegments[1], ...(query.path === undefined ? {} : { path: query.path }) }
  } else if (routeSegments.length === 3 && routeSegments[0] === 'files' && routeSegments[1] === 'preview' && query.path !== undefined) {
    route = { kind: 'file-preview', worktreeId: routeSegments[2], path: query.path }
  }

  const validated = validatedRoute(route)
  return validated ? { hostId, route: validated } : null
}
