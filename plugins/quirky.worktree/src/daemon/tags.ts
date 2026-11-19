import { randomBytes } from 'node:crypto'
import type { PluginStore } from '@quirky/protocol'
import { TAG_COLORS, type Tag, type TagColor } from '../view-types'

const MAX_NAME_LENGTH = 40

type TagsEnv = {
  store: PluginStore
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string): Error
}

type TagRow = { id: string; name: string; color: string | null }

const tagOf = (row: TagRow): Tag => ({ id: row.id, name: row.name, color: row.color as TagColor | null })

function nameOf(env: TagsEnv, value: unknown): string {
  if (typeof value !== 'string') throw env.fail('invalid-params', 'name must be a string')
  const name = value.trim()
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) throw env.fail('invalid-params', `name must be 1 to ${MAX_NAME_LENGTH} characters`)
  return name
}

function colorOf(env: TagsEnv, value: unknown): TagColor | null {
  if (value === null || value === undefined) return null
  if (TAG_COLORS.includes(value as TagColor)) return value as TagColor
  throw env.fail('invalid-params', `color must be null or one of ${TAG_COLORS.join(', ')}`)
}

function requireTag(env: TagsEnv, id: unknown): TagRow {
  if (typeof id !== 'string' || id === '') throw env.fail('invalid-params', 'id must be a tag ID')
  const row = env.store.get<TagRow>('SELECT id, name, color FROM tags WHERE id = ?', id)
  if (!row) throw env.fail('not-found', `no tag has the ID ${id}`)
  return row
}

/** Every tag and, for each worktree that has any, the IDs of its tags. */
export function listTags(store: PluginStore): { tags: Tag[]; assignments: Record<string, string[]> } {
  const tags = store.all<TagRow>('SELECT id, name, color FROM tags ORDER BY name_key, id').map(tagOf)
  const assignments: Record<string, string[]> = {}
  for (const row of store.all<{ worktree_id: string; tag_id: string }>(
    'SELECT worktree_tags.worktree_id, worktree_tags.tag_id FROM worktree_tags JOIN tags ON tags.id = worktree_tags.tag_id ORDER BY tags.name_key, tags.id'
  )) {
    ;(assignments[row.worktree_id] ??= []).push(row.tag_id)
  }
  return { tags, assignments }
}

/** The IDs of the tags on one worktree, in tag-name order. */
export function tagIdsOf(store: PluginStore, worktreeId: string): string[] {
  return store
    .all<{ tag_id: string }>(
      'SELECT worktree_tags.tag_id FROM worktree_tags JOIN tags ON tags.id = worktree_tags.tag_id WHERE worktree_tags.worktree_id = ? ORDER BY tags.name_key, tags.id',
      worktreeId
    )
    .map((row) => row.tag_id)
}

/** A tag with this name in any case is returned as it is, with `created` false. */
export function createTag(env: TagsEnv, params: Record<string, unknown>): { tag: Tag; created: boolean } {
  const name = nameOf(env, params.name)
  const color = colorOf(env, params.color)
  const key = name.toLowerCase()
  const existing = env.store.get<TagRow>('SELECT id, name, color FROM tags WHERE name_key = ?', key)
  if (existing) return { tag: tagOf(existing), created: false }
  const id = `tag_${randomBytes(6).toString('hex')}`
  env.store.run('INSERT INTO tags (id, name, name_key, color, created_at) VALUES (?, ?, ?, ?, ?)', id, name, key, color, Date.now())
  return { tag: { id, name, color }, created: true }
}

/** Renames or recolors a tag; `color: null` makes it grey and an absent field changes nothing. */
export function updateTag(env: TagsEnv, params: Record<string, unknown>): Tag {
  const current = requireTag(env, params.id)
  const name = params.name === undefined ? current.name : nameOf(env, params.name)
  const color = params.color === undefined ? (current.color as TagColor | null) : colorOf(env, params.color)
  const key = name.toLowerCase()
  const clash = env.store.get<TagRow>('SELECT id, name, color FROM tags WHERE name_key = ? AND id != ?', key, current.id)
  if (clash) throw env.fail('conflict', `a tag named "${clash.name}" already exists`)
  env.store.run('UPDATE tags SET name = ?, name_key = ?, color = ? WHERE id = ?', name, key, color, current.id)
  return { id: current.id, name, color }
}

export function deleteTag(env: TagsEnv, params: Record<string, unknown>): void {
  const tag = requireTag(env, params.id)
  env.store.transaction(() => {
    env.store.run('DELETE FROM worktree_tags WHERE tag_id = ?', tag.id)
    env.store.run('DELETE FROM tags WHERE id = ?', tag.id)
  })
}

/** Adds or removes one tag on each of the given worktrees; IDs of worktrees that no longer exist are skipped. */
export function assignTag(env: TagsEnv, params: Record<string, unknown>): void {
  const tag = requireTag(env, params.tagId)
  const ids = params.worktreeIds
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) {
    throw env.fail('invalid-params', 'worktreeIds must be an array of worktree IDs')
  }
  if (typeof params.assigned !== 'boolean') throw env.fail('invalid-params', 'assigned must be a boolean')
  env.store.transaction(() => {
    for (const id of new Set(ids as string[])) {
      if (params.assigned === false) {
        env.store.run('DELETE FROM worktree_tags WHERE worktree_id = ? AND tag_id = ?', id, tag.id)
      } else if (env.store.get('SELECT 1 FROM worktrees WHERE id = ?', id)) {
        env.store.run('INSERT OR IGNORE INTO worktree_tags (worktree_id, tag_id) VALUES (?, ?)', id, tag.id)
      }
    }
  })
}
