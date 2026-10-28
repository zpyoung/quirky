import type { PanelRoute } from './contracts'

const ROUTE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'source-control': ['kind', 'worktreeId', 'tab'],
  review: ['kind', 'worktreeId', 'path'],
  files: ['kind', 'worktreeId', 'path'],
  'file-preview': ['kind', 'worktreeId', 'path'],
  tasks: ['kind'],
  accounts: ['kind'],
  'agent-history': ['kind', 'worktreeId'],
  notifications: ['kind', 'worktreeId']
}

/** Shared by native navigation and both sides of the page bridge; no route can add grants. */
export function validatePanelRoute(value: unknown): PanelRoute {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('panel route must be an object')
  const route = value as Record<string, unknown>
  if (typeof route.kind !== 'string' || !Object.hasOwn(ROUTE_FIELDS, route.kind)) throw new Error('unsupported panel route')
  if (Object.keys(route).some(key => !ROUTE_FIELDS[route.kind as string]!.includes(key))) throw new Error('panel route contains unsupported parameters')
  const hostOnly = route.kind === 'tasks' || route.kind === 'accounts' || route.kind === 'notifications'
  if ((!hostOnly || route.worktreeId !== undefined) &&
    (typeof route.worktreeId !== 'string' || route.worktreeId.length === 0 || route.worktreeId.length > 1024 || route.worktreeId.includes('\0'))) {
    throw new Error('panel route requires a bounded worktree id')
  }
  if (route.path !== undefined || route.kind === 'file-preview') {
    if (typeof route.path !== 'string' || route.path.length === 0 || route.path.length > 1024 || route.path.includes('\0') ||
      route.path.startsWith('/') || route.path.startsWith('\\') || /^[A-Za-z]:/.test(route.path) ||
      route.path.split(/[\\/]+/).some(part => part === '..' || (part === '.' && !(route.kind === 'files' && route.path === '.')))) {
      throw new Error('panel file path must be bounded and worktree-relative')
    }
  }
  if (route.tab !== undefined && (typeof route.tab !== 'string' || !['changes', 'pull-request', 'commits'].includes(route.tab))) throw new Error('unsupported source control tab')
  return route as PanelRoute
}
