import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { PluginCaller, PluginContext, ProjectGroup, Repo, Worktree } from '@quirky/protocol'
import { gitApi } from '@quirky/git'
import type { LedgerOwner, LedgerTarget } from '../types'

export type OwnerCatalog = { repos: Repo[]; groups: ProjectGroup[]; worktrees: Worktree[] }
export type LiveOwner = { owner: LedgerOwner; name: string; path?: string; repoId?: string }
export type WorkspaceContext = { workspace: Worktree; repo: Repo; group: ProjectGroup | null }

export async function readOwnerCatalog(context: PluginContext): Promise<OwnerCatalog> {
  const [repos, groups, worktrees] = await Promise.all([
    context.call('quirky.repo/list') as Promise<Repo[]>,
    context.call('quirky.repo/groupList') as Promise<ProjectGroup[]>,
    context.call('quirky.worktree/list') as Promise<Worktree[]>
  ])
  if (!Array.isArray(repos) || !Array.isArray(groups) || !Array.isArray(worktrees)) throw new Error('owner catalog returned an invalid response')
  return { repos, groups, worktrees }
}

export function liveOwners(catalog: OwnerCatalog): LiveOwner[] {
  const groups = catalog.groups.map((group) => ({ owner: { tier: 'group' as const, id: group.id }, name: group.name }))
  const projects = catalog.repos.filter((repo) => repo.kind === 'git').map((repo) => ({
    owner: { tier: 'project' as const, id: repo.id },
    name: repo.displayName || repo.name,
    path: repo.path,
    repoId: repo.id
  }))
  return [...projects, ...groups].sort((a, b) => a.name.localeCompare(b.name) || a.owner.tier.localeCompare(b.owner.tier) || a.owner.id.localeCompare(b.owner.id))
}

export function ownerFor(catalog: OwnerCatalog, owner: LedgerOwner): LiveOwner | null {
  if (owner.tier === 'project') {
    const repo = catalog.repos.find((item) => item.id === owner.id && item.kind === 'git')
    return repo ? { owner, name: repo.displayName || repo.name, path: repo.path, repoId: repo.id } : null
  }
  const group = catalog.groups.find((item) => item.id === owner.id)
  return group ? { owner, name: group.name } : null
}

export function workspaceFor(catalog: OwnerCatalog, workspaceId: string): WorkspaceContext | null {
  const workspace = catalog.worktrees.find((item) => item.id === workspaceId)
  if (!workspace) return null
  const repo = catalog.repos.find((item) => item.id === workspace.repoId)
  if (!repo) return null
  const groupId = workspace.groupId ?? repo.groupId
  const group = groupId ? catalog.groups.find((item) => item.id === groupId) ?? null : null
  return { workspace, repo, group }
}

export async function resolveWorkspace(
  context: PluginContext,
  workspaceSelector: string | undefined,
  caller: PluginCaller
): Promise<Worktree> {
  const client: { cwd?: string; worktreeId?: string } = caller.role === 'plugin' ? {} : caller
  const selector = workspaceSelector === undefined || workspaceSelector === 'active' || workspaceSelector === 'current' ? 'current' : workspaceSelector
  const result = (await context.call('quirky.worktree/resolve', {
    selector,
    ...(client.cwd ? { cwd: client.cwd } : {}),
    ...(client.worktreeId ? { worktreeId: client.worktreeId } : {})
  })) as Worktree
  if (!result || typeof result.id !== 'string' || typeof result.repoId !== 'string') throw new Error('worktree resolver returned an invalid response')
  return result
}

export function validateTargetSelectors(target: LedgerTarget | undefined, fail: (domain: string, message: string) => never): void {
  if (!target) return
  const own = [target.workspaceId !== undefined, target.owner !== undefined, target.ledgerId !== undefined, target.group === true || target.groupSelector !== undefined]
  const count = own.filter(Boolean).length
  if (count > 1 && !(target.workspaceId !== undefined && (target.group === true || target.groupSelector !== undefined) && target.owner === undefined && target.ledgerId === undefined)) {
    fail('invalid-target', 'target selectors conflict')
  }
  if (target.group === false && target.groupSelector !== undefined) fail('invalid-target', 'group=false cannot be combined with groupSelector')
  if (target.group === true && target.groupSelector !== undefined) fail('invalid-target', 'group and groupSelector cannot be combined')
  if (target.owner && (!['project', 'group'].includes(target.owner.tier) || !target.owner.id.trim())) fail('invalid-target', 'owner must contain a valid tier and id')
  if (target.workspaceId !== undefined && !target.workspaceId.trim()) fail('invalid-target', 'workspaceId must not be empty')
  if (target.ledgerId !== undefined && !target.ledgerId.trim()) fail('invalid-target', 'ledgerId must not be empty')
  if (target.groupSelector !== undefined && !target.groupSelector.trim()) fail('invalid-target', 'groupSelector must not be empty')
}

export function selectWorkspaceOwner(
  target: LedgerTarget,
  workspace: WorkspaceContext,
  catalog: OwnerCatalog,
  fail: (domain: string, message: string, data?: Record<string, unknown>) => never
): LiveOwner | null {
  const selectedGroup = target.group === true || target.groupSelector !== undefined
  if (selectedGroup) {
    const membership = workspace.group
    if (!membership) fail('group-missing', 'workspace has no group')
    if (target.groupSelector !== undefined) {
      const eligible = [membership]
      const byId = eligible.filter((item) => item.id === target.groupSelector)
      const matches = byId.length ? byId : eligible.filter((item) => item.name === target.groupSelector)
      const choices = eligible.map(({ id, name }) => ({ id, name }))
      if (matches.length === 0) fail('group-ambiguous', `${target.groupSelector} matches no eligible group`, { eligible: choices })
      if (matches.length > 1) fail('group-ambiguous', `${target.groupSelector} matches more than one eligible group`, { eligible: choices })
      const selected = matches[0]!
      return ownerFor(catalog, { tier: 'group', id: selected.id })
    }
    return ownerFor(catalog, { tier: 'group', id: membership.id })
  }
  if (workspace.repo.kind === 'folder') {
    if (!workspace.group) fail('group-missing', 'workspace has no group')
    return ownerFor(catalog, { tier: 'group', id: workspace.group.id })
  }
  return ownerFor(catalog, { tier: 'project', id: workspace.repo.id })
}

function realPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function localRemotePath(raw: string, root: string): string | null {
  let value = raw.trim()
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null
  const scpLike = /^[^/\\:]+@[^/\\:]+:.+/.test(value)
  if (scpLike) return null
  if (!isAbsolute(value)) value = resolve(root, value)
  return realPath(value).replace(/[\\/]+$/, '') || '/'
}

/** Canonical origin-or-root identity; repo-id mappings make this result sticky after first observation. */
export async function canonicalRepositoryIdentity(repo: Repo): Promise<string> {
  const root = realPath(repo.path)
  let remote: string | null = null
  try {
    remote = await gitApi().getConfig(repo.path, 'remote.origin.url')
  } catch {
    remote = null
  }
  if (!remote?.trim()) return `local:${root}`
  const value = remote.trim()
  const scp = value.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/)
  if (scp && !value.includes('://') && !value.startsWith('/') && !value.startsWith('./') && !value.startsWith('../')) {
    const host = scp[1]!.toLowerCase()
    let path = scp[2]!.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (host === 'github.com') path = path.toLowerCase()
    if (path) return `remote:${host}/${path}`
  }
  try {
    const url = new URL(value)
    if (['ssh:', 'http:', 'https:'].includes(url.protocol)) {
      const host = url.hostname.toLowerCase()
      const defaultPort = url.protocol === 'ssh:' ? '22' : url.protocol === 'http:' ? '80' : '443'
      const port = url.port && url.port !== defaultPort ? `:${url.port}` : ''
      let path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
      if (host === 'github.com') path = path.toLowerCase()
      if (path) return `remote:${host}${port}/${path}`
    }
  } catch {
    // A local path or a malformed non-URL remote is handled below without using network access.
  }
  const local = localRemotePath(value, repo.path)
  return local ? `local:${local}` : `local:${root}`
}

