import type { MobileGrant } from '../contracts'
import type { PanelRoute } from './contracts'

export const PANEL_ROUTE_FIELDS: Readonly<Record<PanelRoute['kind'], readonly string[]>> = {
  'source-control': ['kind', 'worktreeId', 'tab'],
  review: ['kind', 'worktreeId', 'path'],
  files: ['kind', 'worktreeId', 'path'],
  'file-preview': ['kind', 'worktreeId', 'path'],
  'terminal-artifacts': ['kind', 'worktreeId', 'sessionId'],
  'terminal-artifact': ['kind', 'worktreeId', 'sessionId', 'artifactId', 'grant'],
  tasks: ['kind'],
  accounts: ['kind'],
  'agent-history': ['kind', 'worktreeId'],
  notifications: ['kind', 'worktreeId']
}

export type PanelBundleRouteMetadata = {
  kind: PanelRoute['kind']
  path: string
  grants: readonly MobileGrant[]
}

export const PANEL_BUNDLE_ROUTES: readonly PanelBundleRouteMetadata[] = [
  { kind: 'source-control', path: '/source-control', grants: ['rpc', 'storage', 'navigate', 'clipboard.write', 'externalLink'] },
  { kind: 'review', path: '/review', grants: ['rpc', 'storage', 'navigate', 'clipboard.write', 'externalLink'] },
  { kind: 'files', path: '/files', grants: ['rpc', 'storage', 'navigate', 'clipboard.write', 'externalLink'] },
  { kind: 'file-preview', path: '/files/preview', grants: ['rpc', 'storage', 'navigate', 'clipboard.write', 'externalLink'] },
  { kind: 'terminal-artifacts', path: '/terminal-artifacts', grants: ['rpc', 'storage', 'navigate'] },
  { kind: 'terminal-artifact', path: '/terminal-artifact', grants: ['rpc', 'storage', 'navigate'] },
  { kind: 'tasks', path: '/tasks', grants: ['rpc', 'storage', 'navigate', 'clipboard.write', 'externalLink'] },
  { kind: 'accounts', path: '/accounts', grants: ['rpc', 'storage', 'navigate'] },
  { kind: 'agent-history', path: '/agent-history', grants: ['rpc', 'storage', 'navigate'] },
  { kind: 'notifications', path: '/notifications', grants: ['rpc', 'storage', 'navigate'] }
]

/** Shared by native navigation and both sides of the page bridge; no route can add grants. */
export function validatePanelRoute(value: unknown): PanelRoute {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('panel route must be an object')
  const route = value as Record<string, unknown>
  if (typeof route.kind !== 'string' || !Object.hasOwn(PANEL_ROUTE_FIELDS, route.kind)) throw new Error('unsupported panel route')
  if (Object.keys(route).some(key => !PANEL_ROUTE_FIELDS[route.kind as PanelRoute['kind']]!.includes(key))) throw new Error('panel route contains unsupported parameters')
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
  if (route.kind === 'terminal-artifacts' || route.kind === 'terminal-artifact') {
    if (typeof route.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(route.sessionId)) {
      throw new Error('terminal artifact route requires a bounded session id')
    }
    if (route.kind === 'terminal-artifact' &&
      (typeof route.artifactId !== 'string' || route.artifactId.length === 0 || route.artifactId.length > 128 || /[\x00-\x1f\x7f]/u.test(route.artifactId) ||
        typeof route.grant !== 'string' || route.grant.length === 0 || route.grant.length > 1024 || /[\u0000-\u001f\u007f]/u.test(route.grant))) {
      throw new Error('terminal artifact route requires a bounded artifact capability')
    }
  }
  if (route.tab !== undefined && (typeof route.tab !== 'string' || !['changes', 'pull-request', 'commits'].includes(route.tab))) throw new Error('unsupported source control tab')
  return route as PanelRoute
}
