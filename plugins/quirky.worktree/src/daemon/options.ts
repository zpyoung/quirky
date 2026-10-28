import type { PluginStore, Worktree } from '@quirky/protocol'
import { DEFAULT_STOCK_OPTIONS, type StockWorktreeOptions } from '../control-types'

const OPTIONS_KEY = 'stock-worktree-options'
const GROUPS: readonly StockWorktreeOptions['groupBy'][] = ['project', 'status', 'none']
const SORTS: readonly StockWorktreeOptions['sortBy'][] = ['recent', 'name', 'manual']
const OPTION_KEYS: Record<string, true> = {
  groupBy: true,
  sortBy: true,
  compact: true,
  showBranch: true,
  showComment: true,
  showSleeping: true
}


type OptionsEnv = {
  store: PluginStore
  fail(kind: 'invalid-params', message: string): Error
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function normalize(value: unknown): StockWorktreeOptions {
  const record = recordOf(value)
  return {
    groupBy: GROUPS.includes(record?.groupBy as StockWorktreeOptions['groupBy']) ? record!.groupBy as StockWorktreeOptions['groupBy'] : DEFAULT_STOCK_OPTIONS.groupBy,
    sortBy: SORTS.includes(record?.sortBy as StockWorktreeOptions['sortBy']) ? record!.sortBy as StockWorktreeOptions['sortBy'] : DEFAULT_STOCK_OPTIONS.sortBy,
    compact: record?.compact === true,
    showBranch: typeof record?.showBranch === 'boolean' ? record.showBranch : DEFAULT_STOCK_OPTIONS.showBranch,
    showComment: typeof record?.showComment === 'boolean' ? record.showComment : DEFAULT_STOCK_OPTIONS.showComment,
    showSleeping: typeof record?.showSleeping === 'boolean' ? record.showSleeping : DEFAULT_STOCK_OPTIONS.showSleeping
  }
}

export function readStockOptions(store: PluginStore): StockWorktreeOptions {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', OPTIONS_KEY)
  if (!row) return { ...DEFAULT_STOCK_OPTIONS }
  try {
    return normalize(JSON.parse(row.value) as unknown)
  } catch {
    return { ...DEFAULT_STOCK_OPTIONS }
  }
}

export function setStockOptions(env: OptionsEnv, params: Record<string, unknown>): StockWorktreeOptions {
  const extra = Object.keys(params).find((key) => OPTION_KEYS[key] !== true)
  if (extra !== undefined) throw env.fail('invalid-params', `unknown stock option "${extra}"`)
  if (Object.keys(params).length === 0) throw env.fail('invalid-params', 'at least one stock option is required')
  if (params.groupBy !== undefined && !GROUPS.includes(params.groupBy as StockWorktreeOptions['groupBy'])) {
    throw env.fail('invalid-params', `groupBy must be one of ${GROUPS.join(', ')}`)
  }
  if (params.sortBy !== undefined && !SORTS.includes(params.sortBy as StockWorktreeOptions['sortBy'])) {
    throw env.fail('invalid-params', `sortBy must be one of ${SORTS.join(', ')}`)
  }
  for (const key of ['compact', 'showBranch', 'showComment', 'showSleeping'] as const) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') {
      throw env.fail('invalid-params', `${key} must be a boolean`)
    }
  }
  const next = normalize({ ...readStockOptions(env.store), ...params })
  env.store.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    OPTIONS_KEY,
    JSON.stringify(next)
  )
  return next
}

export function reorderWorktrees(
  env: OptionsEnv,
  all: Worktree[],
  ids: unknown
): { ok: true } {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw env.fail('invalid-params', 'worktrees must be a non-empty array of worktree IDs')
  }
  const orderedIds = ids as string[]
  if (new Set(orderedIds).size !== orderedIds.length) throw env.fail('invalid-params', 'worktrees cannot contain duplicates')
  const selected = orderedIds.map((id) => all.find((worktree) => worktree.id === id))
  if (selected.some((worktree) => worktree === undefined)) throw env.fail('invalid-params', 'every reordered worktree must still exist')
  const siblings = selected as Worktree[]
  const first = siblings[0]!
  if (first.isMain || siblings.some((worktree) =>
    worktree.repoId !== first.repoId || worktree.parentId !== first.parentId || worktree.projectGroupId !== first.projectGroupId || worktree.isMain
  )) {
    throw env.fail('invalid-params', 'reordered worktrees must be non-primary siblings in the same project group')
  }
  const current = all.filter((worktree) =>
    worktree.repoId === first.repoId && worktree.parentId === first.parentId && worktree.projectGroupId === first.projectGroupId && !worktree.isMain
  )
  if (current.length !== orderedIds.length || current.some((worktree) => !orderedIds.includes(worktree.id))) {
    throw env.fail('invalid-params', 'reorder must include every sibling exactly once')
  }
  env.store.transaction(() => {
    orderedIds.forEach((id, index) => env.store.run('UPDATE worktrees SET manual_order = ? WHERE id = ?', orderedIds.length - index, id))
  })
  return { ok: true }
}
