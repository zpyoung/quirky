import type { ProjectGroup } from '@quirky/protocol'
import type { Env } from './env'

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
export function createGroup(env: Env, params: { name: string; parentPath?: string | null; createdFrom?: 'manual' | 'folder-scan' }): ProjectGroup {
  const name = cleanName(env, params.name)
  const last = env.store.get<{ top: number | null }>('SELECT MAX(sort_order) AS top FROM groups')?.top ?? -1
  const id = `grp_${randomId()}`
  env.store.run(
    'INSERT INTO groups (id, name, parent_path, collapsed, sort_order, created_from, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    id,
    name,
    params.parentPath ?? null,
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

export const groupCreate = (env: Env, params: { name: string; parentPath?: string }): ProjectGroup => createGroup(env, params)

export function groupRename(env: Env, params: { group: string; name: string }): ProjectGroup {
  const group = env.resolveGroup(params.group)
  env.store.run('UPDATE groups SET name = ? WHERE id = ?', cleanName(env, params.name), group.id)
  env.changed({ groupId: group.id })
  return load(env, group.id)
}

export function groupDelete(env: Env, params: { group: string }): { ok: true } {
  const group = env.resolveGroup(params.group)
  env.store.transaction(() => {
    env.store.run('UPDATE repos SET group_id = NULL WHERE group_id = ?', group.id)
    env.store.run('DELETE FROM groups WHERE id = ?', group.id)
  })
  env.changed({ groupId: group.id })
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
