import type { PluginStore } from '@quirky/protocol'
import { isSafeIcon } from '../safe-icon'
import type { WorktreeStatusDefinition } from '../parity-types'

const STATUS_KEY = 'worktree-status-definitions'
export const DEFAULT_WORKTREE_STATUSES: readonly WorktreeStatusDefinition[] = [
  { id: 'todo', label: 'Todo', color: '#8b8b8b' },
  { id: 'in-progress', label: 'In progress', color: '#3478c5' },
  { id: 'in-review', label: 'In review', color: '#a57de8' },
  { id: 'done', label: 'Done', color: '#48a878' }
]

export function readStatusDefinitions(store: PluginStore): WorktreeStatusDefinition[] {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', STATUS_KEY)
  if (!row) return DEFAULT_WORKTREE_STATUSES.map((status) => ({ ...status }))
  try {
    const value: unknown = JSON.parse(row.value)
    if (!Array.isArray(value)) return DEFAULT_WORKTREE_STATUSES.map((status) => ({ ...status }))
    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const status = item as Record<string, unknown>
      if (typeof status.id !== 'string' || typeof status.label !== 'string' || typeof status.color !== 'string') return []
      const icon = typeof status.icon === 'string' && isSafeIcon(status.icon) ? status.icon.trim() : ''
      return [{ id: status.id, label: status.label, color: status.color, ...(icon ? { icon } : {}) }]
    })
  } catch {
    return DEFAULT_WORKTREE_STATUSES.map((status) => ({ ...status }))
  }
}

export function setStatusDefinitions(
  store: PluginStore,
  fail: (kind: 'invalid-params' | 'conflict', message: string) => Error,
  value: unknown
): WorktreeStatusDefinition[] {
  if (!Array.isArray(value) || value.length < DEFAULT_WORKTREE_STATUSES.length) {
    throw fail('invalid-params', 'statuses must include the four built-in statuses and may add custom statuses')
  }
  const statuses: WorktreeStatusDefinition[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('invalid-params', 'each status must be an object')
    const status = raw as Record<string, unknown>
    const keys = Object.keys(status)
    if (keys.some((key) => key !== 'id' && key !== 'label' && key !== 'color' && key !== 'icon') ||
      !Object.hasOwn(status, 'id') || !Object.hasOwn(status, 'label') || !Object.hasOwn(status, 'color')) {
      throw fail('invalid-params', 'each status must contain only id, label, color, and optional icon')
    }
    if (
      typeof status.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(status.id) ||
      typeof status.label !== 'string' || status.label.trim() === '' || status.label.length > 50 ||
      typeof status.color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(status.color)
    ) throw fail('invalid-params', 'status IDs, labels, or colors are invalid')
    if (status.icon !== undefined && (typeof status.icon !== 'string' || !isSafeIcon(status.icon))) {
      throw fail('invalid-params', 'status icon must be a safe plain-text emoji or symbol; URLs, markup, and control characters are not allowed')
    }
    if (ids.has(status.id)) throw fail('invalid-params', `duplicate status ID "${status.id}"`)
    ids.add(status.id)
    statuses.push({
      id: status.id,
      label: status.label.trim(),
      color: status.color.toLowerCase(),
      ...(typeof status.icon === 'string' && status.icon.trim() ? { icon: status.icon.trim() } : {})
    })
  }
  for (const builtin of DEFAULT_WORKTREE_STATUSES) {
    if (!ids.has(builtin.id)) throw fail('invalid-params', `statuses must retain built-in status "${builtin.id}"`)
  }
  const allowed = new Set(statuses.map((status) => status.id))
  const inUse = store.all<{ status: string }>('SELECT DISTINCT status FROM worktrees')
    .map((row) => row.status)
    .filter((id) => !allowed.has(id))
  if (inUse.length > 0) throw fail('conflict', `cannot remove statuses that are in use: ${[...new Set(inUse)].join(', ')}`)
  store.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    STATUS_KEY,
    JSON.stringify(statuses)
  )
  return statuses
}
