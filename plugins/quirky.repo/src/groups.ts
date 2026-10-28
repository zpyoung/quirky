import type { ProjectGroup } from '@quirky/protocol'
import type { Env } from './env'
import { guardLedgerRemoval } from './projects'

const randomId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 12)

function cleanName(env: Env, name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw env.fail('invalid-params', 'group name must not be empty')
  return trimmed
}

function load(env: Env, id: string): ProjectGroup {
  return env.groups().find((group) => group.id === id)!
}

/** The group with exactly this name, or null; several of that name is a conflict. */
export function findGroupByName(env: Env, name: string): ProjectGroup | null {
  const matches = env.groups().filter((group) => group.name === name)
  if (matches.length > 1) throw env.fail('conflict', `${name} matches ${matches.length} groups: ${matches.map((group) => group.id).join(', ')}`, { matches: matches.map((group) => group.id) })
  return matches[0] ?? null
}

/** Adds an empty group after the existing ones. */
export function createGroup(
  env: Env,
  params: { name: string; parentPath?: string | null; parentId?: string | null; createdFrom?: 'manual' | 'folder-scan' }
): ProjectGroup {
  const name = cleanName(env, params.name)
  const last = env.store.get<{ top: number | null }>('SELECT MAX(sort_order) AS top FROM groups')?.top ?? -1
  const id = `grp_${randomId()}`
  env.store.run(
    'INSERT INTO groups (id, name, parent_path, parent_id, collapsed, sort_order, created_from, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
    id,
    name,
    params.parentPath ?? null,
    params.parentId ?? null,
    last + 1,
    params.createdFrom ?? 'manual',
    Date.now()
  )
  env.changed({ groupId: id })
  return load(env, id)
}

/** Puts the repos in the group; a repo already in another group moves, since a project has one group. */
export function setGroupMembers(env: Env, groupId: string, repoIds: string[]): void {
  env.store.transaction(() => {
    for (const id of repoIds) env.store.run('UPDATE repos SET group_id = ? WHERE id = ?', groupId, id)
  })
  env.changed({ groupId })
}

export const groupList = (env: Env): ProjectGroup[] => env.groups()

export const groupDeletedIds = (env: Env): string[] =>
  env.store.all<{ id: string }>('SELECT id FROM deleted_groups ORDER BY deleted_at, id').map((row) => row.id)

export function groupCreate(env: Env, params: { name: string; parentPath?: string; parent?: string | null }): ProjectGroup {
  if (params.parent !== undefined && params.parent !== null && typeof params.parent !== 'string') {
    throw env.fail('invalid-params', 'parent must be a group ID, exact name or null')
  }
  const parentId = params.parent == null ? null : env.resolveGroup(params.parent).id
  return createGroup(env, { name: params.name, parentPath: params.parentPath, parentId })
}


export function groupSetParent(env: Env, params: { group: string; parent: string | null }): ProjectGroup {
  if (params.parent !== null && typeof params.parent !== 'string') {
    throw env.fail('invalid-params', 'parent must be a group ID, exact name or null')
  }
  const group = env.resolveGroup(params.group)
  const parent = params.parent === null ? null : env.resolveGroup(params.parent)
  if (parent !== null) {
    const byId = new Map(env.groups().map((entry) => [entry.id, entry]))
    for (let current: ProjectGroup | undefined = parent; current; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
      if (current.id === group.id) {
        throw env.fail('invalid-params', 'a group cannot be its own ancestor', { reason: 'parent-cycle' })
      }
    }
  }
  env.store.run('UPDATE groups SET parent_id = ? WHERE id = ?', parent?.id ?? null, group.id)
  env.changed({ groupId: group.id })
  return load(env, group.id)
}

export function groupRename(env: Env, params: { group: string; name: string }): ProjectGroup {
  const group = env.resolveGroup(params.group)
  env.store.run('UPDATE groups SET name = ? WHERE id = ?', cleanName(env, params.name), group.id)
  env.changed({ groupId: group.id })
  return load(env, group.id)
}

export function groupSubtreeIds(groups: readonly ProjectGroup[], rootId: string): string[] {
  const removed = new Set([rootId])
  const pending = [rootId]
  while (pending.length > 0) {
    const parentId = pending.pop()!
    for (const group of groups) {
      if (group.parentId === parentId && !removed.has(group.id)) {
        removed.add(group.id)
        pending.push(group.id)
      }
    }
  }
  return [...removed]
}

export async function groupDelete(
  env: Env,
  params: { group: string; expectedLedgers?: { ledgerId: string; revision: number }[] }
): Promise<{ ok: true }> {
  const root = env.resolveGroup(params.group)
  const ids = groupSubtreeIds(env.groups(), root.id)
  await guardLedgerRemoval(env.context, {
    groupIds: ids,
    ...(params.expectedLedgers !== undefined ? { expectedLedgers: params.expectedLedgers } : {})
  })
  const deletedAt = Date.now()
  env.store.transaction(() => {
    for (const id of ids) {
      env.store.run('UPDATE repos SET group_id = NULL WHERE group_id = ?', id)
      env.store.run('INSERT OR IGNORE INTO deleted_groups (id, deleted_at) VALUES (?, ?)', id, deletedAt)
    }
    for (const id of ids.reverse()) env.store.run('DELETE FROM groups WHERE id = ?', id)
  })
  env.changed({ groupId: root.id })
  return { ok: true }
}

export function groupAdd(env: Env, params: { group: string; repo: string }): ProjectGroup {
  const group = env.resolveGroup(params.group)
  const repo = env.resolve(params.repo)
  env.store.run('UPDATE repos SET group_id = ? WHERE id = ?', group.id, repo.id)
  env.changed({ repoId: repo.id, groupId: group.id })
  return load(env, group.id)
}

/** Takes the repo out of the group; a repo that isn't in it is left as it is. */
export function groupRemove(env: Env, params: { group: string; repo: string }): ProjectGroup {
  const group = env.resolveGroup(params.group)
  const repo = env.resolve(params.repo)
  if (repo.groupId === group.id) {
    env.store.run('UPDATE repos SET group_id = NULL WHERE id = ?', repo.id)
    env.changed({ repoId: repo.id, groupId: group.id })
  }
  return load(env, group.id)
}

export function groupCollapse(env: Env, params: { group: string; collapsed?: boolean }): ProjectGroup {
  const group = env.resolveGroup(params.group)
  env.store.run('UPDATE groups SET collapsed = ? WHERE id = ?', params.collapsed === false ? 0 : 1, group.id)
  env.changed({ groupId: group.id })
  return load(env, group.id)
}
