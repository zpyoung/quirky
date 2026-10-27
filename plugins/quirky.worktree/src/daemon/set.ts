import type { PluginStore, Worktree, WorktreeStatus } from '@quirky/protocol'
import type { CallerIdentity } from '../../selector'
import { joinMetadata } from './list'
import { insertRow, rowOf, STATUSES } from './store'

/** What `set` and `show` need from the plugin: the store, error building and selector resolution. */
export type SetEnv = {
  store: PluginStore
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
  /** The one workspace a selector names, with every listed workspace for reading relations. */
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: Worktree; all: Worktree[] }>
  /** `unread` is present only when the change came from a `set` that asked for it. */
  changed(data: { repoId: string; worktreeId: string; unread?: boolean }): void
}

export type SetParams = {
  worktree: string
  displayName?: string
  comment?: string
  status?: WorktreeStatus
  pinned?: boolean
  unread?: boolean
  parent?: string
  noParent?: boolean
  baseRef?: string | null
}

/**
 * Changes a workspace's metadata and returns the joined record. An empty `displayName` clears it;
 * `parent` names the workspace to nest under and `noParent` clears the link. A parent that is the
 * workspace itself or one of its descendants is refused as `parent-cycle`. `baseRef` sets the
 * workspace's own compare and rebase target; null or a blank string clears it.
 */
export async function setWorktree(env: SetEnv, params: SetParams, identity: CallerIdentity): Promise<Worktree> {
  if (params.parent !== undefined && params.noParent === true) {
    throw env.fail('invalid-params', 'parent and noParent cannot be used together')
  }
  if (params.status !== undefined && !STATUSES.includes(params.status)) {
    throw env.fail('invalid-params', `status must be one of ${STATUSES.join(', ')}`)
  }
  if (params.baseRef !== undefined && params.baseRef !== null && typeof params.baseRef !== 'string') {
    throw env.fail('invalid-params', 'baseRef must be a string or null')
  }
  const { worktree } = await env.find(params.worktree, identity)

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

  const row = env.store.transaction(() => {
    if (!rowOf(env.store, worktree.id)) {
      insertRow(env.store, { id: worktree.id, repoId: worktree.repoId, kind: worktree.kind, path: worktree.path, createdAt: worktree.createdAt || Date.now(), createdBy: 'external', groupId: worktree.groupId })
    }
    if (assignments.length > 0) env.store.run(`UPDATE worktrees SET ${assignments.join(', ')} WHERE id = ?`, ...values, worktree.id)
    return rowOf(env.store, worktree.id)!
  })
  env.changed({ repoId: worktree.repoId, worktreeId: worktree.id, ...(params.unread === undefined ? {} : { unread: params.unread }) })
  return joinMetadata(worktree, row, worktree.removing)
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
