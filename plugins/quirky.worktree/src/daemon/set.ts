import { RpcErrorCode, type PluginStore, type ProjectGroup, type Repo, type Worktree } from '@quirky/protocol'
import type { CallerIdentity } from '../../selector'
import { joinMetadata } from './list'
import { filesystemIdentitySource, instanceIdFor, stillNamesHeldDirectory, type DirectoryHandle, type DirectoryIdentitySource } from './identity'
import { insertRow, rowOf } from './store'
import { readStatusDefinitions } from './statuses'

/** What `set` and `show` need from the plugin: the store, error building and selector resolution. */
export type SetEnv = {
  store: PluginStore
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
  /** The one workspace a selector names, with every listed workspace for reading relations. */
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: Worktree; all: Worktree[] }>
  resolveRepo(selector: string): Promise<Repo>
  groups(): Promise<ProjectGroup[]>
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  identitySource?: DirectoryIdentitySource
  /** `unread` is present only when the change came from a `set` that asked for it. */
  changed(data: { repoId: string; worktreeId: string; unread?: boolean }): void
}

export type SetParams = {
  worktree: string
  displayName?: string
  comment?: string
  status?: string
  pinned?: boolean
  unread?: boolean
  parent?: string
  noParent?: boolean
  baseRef?: string | null
  projectGroupId?: string | null
  expectedInstanceId?: string
  expectedProjectGroupId?: string | null
}

export type CreateGroupParams = {
  worktree: string
  name: string
  expectedInstanceId: string
  expectedProjectGroupId: string | null
}

type DirectoryGuard = {
  source: DirectoryIdentitySource
  handle: DirectoryHandle
  path: string
}

function expectedConflict(env: SetEnv, message: string): Error {
  return Object.assign(env.fail('conflict', message, { reason: 'stale-assignment' }), { staleAssignment: true })
}

function isStaleAssignment(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'staleAssignment' in error && error.staleAssignment === true
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.NotFound
}

function assertExpected(env: SetEnv, worktree: Worktree, params: SetParams): void {
  if (params.expectedInstanceId !== undefined && worktree.instanceId !== params.expectedInstanceId) {
    throw expectedConflict(env, 'the worktree filesystem instance changed before the update')
  }
  if (params.expectedProjectGroupId !== undefined && worktree.projectGroupId !== params.expectedProjectGroupId) {
    throw expectedConflict(env, 'the worktree project-group membership changed before the update')
  }
}

/**
 * Changes a workspace's metadata and returns the joined record. An empty `displayName` clears it;
 * `parent` names the workspace to nest under and `noParent` clears the link. A parent that is the
 * workspace itself or one of its descendants is refused as `parent-cycle`. `baseRef` sets the
 * workspace's own compare and rebase target; null or a blank string clears it.
 */
export async function setWorktree(
  env: SetEnv,
  params: SetParams,
  identity: CallerIdentity,
  guard?: DirectoryGuard
): Promise<Worktree> {
  if (params.parent !== undefined && params.noParent === true) {
    throw env.fail('invalid-params', 'parent and noParent cannot be used together')
  }
  const statuses = readStatusDefinitions(env.store)
  if (params.status !== undefined && (typeof params.status !== 'string' || !statuses.some((status) => status.id === params.status))) {
    throw env.fail('invalid-params', `status must be one of ${statuses.map((status) => status.id).join(', ')}`)
  }
  if (params.baseRef !== undefined && params.baseRef !== null && typeof params.baseRef !== 'string') {
    throw env.fail('invalid-params', 'baseRef must be a string or null')
  }
  if (params.projectGroupId !== undefined && params.projectGroupId !== null &&
    (typeof params.projectGroupId !== 'string' || params.projectGroupId.trim() === '')) {
    throw env.fail('invalid-params', 'projectGroupId must be a group ID or null')
  }
  if (params.expectedInstanceId !== undefined &&
    (typeof params.expectedInstanceId !== 'string' || params.expectedInstanceId.trim() === '')) {
    throw env.fail('invalid-params', 'expectedInstanceId must be a non-empty string')
  }
  if (params.expectedProjectGroupId !== undefined && params.expectedProjectGroupId !== null &&
    (typeof params.expectedProjectGroupId !== 'string' || params.expectedProjectGroupId.trim() === '')) {
    throw env.fail('invalid-params', 'expectedProjectGroupId must be a group ID or null')
  }

  let worktree = (await env.find(params.worktree, identity)).worktree
  assertExpected(env, worktree, params)

  const assignments: string[] = []
  const values: (string | number | null)[] = []
  const assign = (column: string, value: string | number | null) => {
    assignments.push(`${column} = ?`)
    values.push(value)
  }
  if (params.displayName !== undefined) assign('display_name', params.displayName.trim() === '' ? null : params.displayName.trim())
  if (params.comment !== undefined) assign('comment', params.comment)
  if (params.status !== undefined) assign('status', params.status)
  if (params.pinned !== undefined) assign('pinned', params.pinned ? 1 : 0)
  if (params.unread !== undefined) assign('unread', params.unread ? 1 : 0)
  if (params.baseRef !== undefined) assign('base_ref', params.baseRef === null || params.baseRef.trim() === '' ? null : params.baseRef.trim())
  if (params.noParent === true) assign('parent_id', null)
  if (params.parent !== undefined) {
    const { worktree: parent } = await env.find(params.parent, identity)
    if (parent.id === worktree.id) throw env.fail('invalid-params', "a worktree can't be its own parent", { reason: 'parent-cycle' })
    if (isAncestor(env.store, worktree.id, parent.id)) {
      throw env.fail('invalid-params', `${parent.name} is a descendant of ${worktree.name}, so it can't be its parent`, { reason: 'parent-cycle' })
    }
    assign('parent_id', parent.id)
  }

  if (params.projectGroupId !== undefined) {
    if (params.projectGroupId === null) {
      assign('project_group_id', null)
    } else {
      if (worktree.kind !== 'git') {
        throw env.fail('invalid-params', 'only Git worktrees of Git projects can belong to a project group', { reason: 'project-group-requires-git' })
      }
      const repo = await env.resolveRepo(worktree.repoId)
      if (repo.kind !== 'git') {
        throw env.fail('invalid-params', 'only Git worktrees of Git projects can belong to a project group', { reason: 'project-group-requires-git' })
      }
      const groups = await env.groups()
      if (!groups.some((group) => group.id === params.projectGroupId)) {
        throw env.fail('not-found', `no project group has ID ${params.projectGroupId}`)
      }
      assign('project_group_id', params.projectGroupId)
    }
  }

  if (params.expectedInstanceId !== undefined || params.expectedProjectGroupId !== undefined ||
    params.projectGroupId !== undefined || guard !== undefined) {
    worktree = (await env.find(worktree.id, identity)).worktree
    assertExpected(env, worktree, params)
    if (params.projectGroupId !== undefined && params.projectGroupId !== null) {
      if (worktree.kind !== 'git') throw expectedConflict(env, 'the selected worktree is no longer a Git workspace')
      const repo = await env.resolveRepo(worktree.repoId)
      if (repo.kind !== 'git') throw expectedConflict(env, 'the selected worktree is no longer owned by a Git project')
      if (!(await env.groups()).some((group) => group.id === params.projectGroupId)) {
        throw env.fail('not-found', `no project group has ID ${params.projectGroupId}`)
      }
      worktree = (await env.find(worktree.id, identity)).worktree
      assertExpected(env, worktree, params)
    }
  }

  if (guard && !stillNamesHeldDirectory(guard.source, guard.handle, guard.path)) {
    throw expectedConflict(env, 'the worktree path now refers to a different filesystem object')
  }

  const row = env.store.transaction(() => {
    if (params.expectedInstanceId !== undefined || params.expectedProjectGroupId !== undefined) {
      const current = rowOf(env.store, worktree.id)
      if (!current ||
        (params.expectedInstanceId !== undefined && current.instance_id !== params.expectedInstanceId) ||
        (params.expectedProjectGroupId !== undefined && current.project_group_id !== params.expectedProjectGroupId)) {
        throw expectedConflict(env, 'the worktree changed before the update could be stored')
      }
    }
    if (!rowOf(env.store, worktree.id)) {
      insertRow(env.store, {
        id: worktree.id,
        repoId: worktree.repoId,
        kind: worktree.kind,
        path: worktree.path,
        createdAt: worktree.createdAt || Date.now(),
        createdBy: 'external',
        groupId: worktree.groupId,
        projectGroupId: worktree.projectGroupId,
        lastActivityAt: worktree.lastActivityAt,
        instanceId: worktree.instanceId
      })
    }
    if (assignments.length > 0) env.store.run(`UPDATE worktrees SET ${assignments.join(', ')} WHERE id = ?`, ...values, worktree.id)
    return rowOf(env.store, worktree.id)!
  })
  env.changed({ repoId: worktree.repoId, worktreeId: worktree.id, ...(params.unread === undefined ? {} : { unread: params.unread }) })
  return joinMetadata(worktree, row, worktree.removing, env.store)
}

/** Creates a group through quirky.repo, then conditionally moves only the selected worktree. */
export async function createGroupForWorktree(
  env: SetEnv,
  params: CreateGroupParams,
  identity: CallerIdentity
): Promise<{ group: ProjectGroup; worktree: Worktree; assigned: boolean; reason?: string }> {
  if (typeof params.expectedInstanceId !== 'string' || params.expectedInstanceId.trim() === '') {
    throw env.fail('invalid-params', 'expectedInstanceId must be a non-empty string')
  }
  if (params.expectedProjectGroupId !== null &&
    (typeof params.expectedProjectGroupId !== 'string' || params.expectedProjectGroupId.trim() === '')) {
    throw env.fail('invalid-params', 'expectedProjectGroupId must be a group ID or null')
  }
  const initial = (await env.find(params.worktree, identity)).worktree
  const repo = await env.resolveRepo(initial.repoId)
  if (initial.kind !== 'git' || repo.kind !== 'git') {
    throw env.fail('invalid-params', 'only Git worktrees of Git projects can belong to a project group', { reason: 'project-group-requires-git' })
  }
  if (initial.instanceId !== params.expectedInstanceId || initial.projectGroupId !== params.expectedProjectGroupId) {
    throw env.fail('conflict', 'the worktree identity or project-group membership changed before group creation', { reason: 'stale-assignment' })
  }

  const source = env.identitySource ?? filesystemIdentitySource
  let handle: DirectoryHandle
  try {
    handle = source.open(initial.path)
  } catch {
    throw env.fail('conflict', 'cannot verify the worktree filesystem identity for delayed assignment', { reason: 'identity-unavailable' })
  }

  try {
    if (handle.identity === null || instanceIdFor(handle.identity) !== params.expectedInstanceId) {
      throw env.fail('conflict', 'cannot verify the expected worktree filesystem identity for delayed assignment', { reason: 'identity-unavailable' })
    }
    const group = await env.call('quirky.repo/groupCreate', { name: params.name }) as ProjectGroup
    const guard: DirectoryGuard = { source, handle, path: initial.path }
    try {
      const worktree = await setWorktree(env, {
        worktree: initial.id,
        projectGroupId: group.id,
        expectedInstanceId: params.expectedInstanceId,
        expectedProjectGroupId: params.expectedProjectGroupId
      }, identity, guard)
      return { group, worktree, assigned: true }
    } catch (error) {
      if (!isStaleAssignment(error) && !isNotFound(error)) throw error
      let current = initial
      try {
        current = (await env.find(initial.id, identity)).worktree
      } catch (lookupError) {
        if (!isNotFound(lookupError)) throw lookupError
      }
      return { group, worktree: current, assigned: false, reason: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    handle.close()
  }
}


/** The record with the IDs of the workspaces nested directly under it. */
export async function showWorktree(env: SetEnv, params: { worktree: string }, identity: CallerIdentity): Promise<Worktree & { children: string[] }> {
  const { worktree, all } = await env.find(params.worktree, identity)
  return { ...worktree, children: all.filter((other) => other.parentId === worktree.id).map((other) => other.id) }
}

/** True when `ancestorId` is `id` or appears above it in the stored parent chain. */
function isAncestor(store: PluginStore, ancestorId: string, id: string): boolean {
  const seen = new Set<string>()
  for (let current: string | null = id; current !== null && !seen.has(current); ) {
    if (current === ancestorId) return true
    seen.add(current)
    current = rowOf(store, current)?.parent_id ?? null
  }
  return false
}
