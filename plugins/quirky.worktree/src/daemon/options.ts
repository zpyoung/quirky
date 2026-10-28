import type { PluginStore, Repo, Worktree } from '@quirky/protocol'
import { DEFAULT_STOCK_OPTIONS, type StockWorktreeOptions, type WorktreeCardProperty } from '../control-types'

const OPTIONS_KEY = 'stock-worktree-options'
const PROJECT_ORDER_KEY = 'stock-project-order'
const GROUPS: readonly StockWorktreeOptions['groupBy'][] = ['project', 'status', 'none', 'pr']
const SORTS: readonly StockWorktreeOptions['sortBy'][] = ['recent', 'name', 'manual', 'agent-activity', 'project']
const PROPERTIES: readonly WorktreeCardProperty[] = ['branch', 'notes', 'pullRequest', 'issue', 'automation', 'activity']
const OPTION_KEYS: Record<keyof StockWorktreeOptions, true> = {
  groupBy: true,
  sortBy: true,
  projectOrderBy: true,
  compact: true,
  showBranch: true,
  showComment: true,
  showSleeping: true,
  hideCliCreated: true,
  hideDefaultBranch: true,
  hideDetached: true,
  hideArchived: true,
  filterRepoIds: true,
  showProperties: true,
  externalVisibilityDefault: true
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
  const groupBy = GROUPS.includes(record?.groupBy as StockWorktreeOptions['groupBy']) ? record!.groupBy as StockWorktreeOptions['groupBy'] : DEFAULT_STOCK_OPTIONS.groupBy
  const sortBy = SORTS.includes(record?.sortBy as StockWorktreeOptions['sortBy']) ? record!.sortBy as StockWorktreeOptions['sortBy'] : DEFAULT_STOCK_OPTIONS.sortBy
  let showProperties = Array.isArray(record?.showProperties) &&
    record.showProperties.every((property) => PROPERTIES.includes(property as WorktreeCardProperty))
      ? [...new Set(record.showProperties as WorktreeCardProperty[])]
      : [...DEFAULT_STOCK_OPTIONS.showProperties]
  let showBranch = typeof record?.showBranch === 'boolean' ? record.showBranch : DEFAULT_STOCK_OPTIONS.showBranch
  let showComment = typeof record?.showComment === 'boolean' ? record.showComment : DEFAULT_STOCK_OPTIONS.showComment
  if (Array.isArray(record?.showProperties) && record.showProperties.every((property) => PROPERTIES.includes(property as WorktreeCardProperty))) {
    showBranch = showProperties.includes('branch')
    showComment = showProperties.includes('notes')
  } else {
    if (!showBranch) showProperties = showProperties.filter((property) => property !== 'branch')
    if (!showComment) showProperties = showProperties.filter((property) => property !== 'notes')
  }
  const filterRepoIds = Array.isArray(record?.filterRepoIds) && record.filterRepoIds.every((id) => typeof id === 'string')
    ? [...new Set(record.filterRepoIds as string[])]
    : []
  return {
    groupBy,
    sortBy,
    projectOrderBy: record?.projectOrderBy === 'recent' ? 'recent' : 'manual',
    compact: record?.compact === true,
    showBranch,
    showComment,
    showSleeping: typeof record?.showSleeping === 'boolean' ? record.showSleeping : DEFAULT_STOCK_OPTIONS.showSleeping,
    hideCliCreated: record?.hideCliCreated === true,
    hideDefaultBranch: record?.hideDefaultBranch === true,
    hideDetached: record?.hideDetached === true,
    hideArchived: typeof record?.hideArchived === 'boolean' ? record.hideArchived : DEFAULT_STOCK_OPTIONS.hideArchived,
    filterRepoIds,
    showProperties,
    externalVisibilityDefault: record?.externalVisibilityDefault === 'show' ? 'show' : 'hide'
  }
}

export function readStockOptions(store: PluginStore): StockWorktreeOptions {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', OPTIONS_KEY)
  if (!row) return { ...DEFAULT_STOCK_OPTIONS, filterRepoIds: [], showProperties: [...DEFAULT_STOCK_OPTIONS.showProperties] }
  try {
    return normalize(JSON.parse(row.value) as unknown)
  } catch {
    return { ...DEFAULT_STOCK_OPTIONS, filterRepoIds: [], showProperties: [...DEFAULT_STOCK_OPTIONS.showProperties] }
  }
}

export function setStockOptions(env: OptionsEnv, params: Record<string, unknown>): StockWorktreeOptions {
  const extra = Object.keys(params).find((key) => OPTION_KEYS[key as keyof StockWorktreeOptions] !== true)
  if (extra !== undefined) throw env.fail('invalid-params', `unknown stock option "${extra}"`)
  if (Object.keys(params).length === 0) throw env.fail('invalid-params', 'at least one stock option is required')
  if (params.groupBy !== undefined && !GROUPS.includes(params.groupBy as StockWorktreeOptions['groupBy'])) {
    throw env.fail('invalid-params', `groupBy must be one of ${GROUPS.join(', ')}`)
  }
  if (params.sortBy !== undefined && !SORTS.includes(params.sortBy as StockWorktreeOptions['sortBy'])) {
    throw env.fail('invalid-params', `sortBy must be one of ${SORTS.join(', ')}`)
  }
  if (params.projectOrderBy !== undefined && params.projectOrderBy !== 'manual' && params.projectOrderBy !== 'recent') {
    throw env.fail('invalid-params', 'projectOrderBy must be manual or recent')
  }
  for (const key of ['compact', 'showBranch', 'showComment', 'showSleeping', 'hideCliCreated', 'hideDefaultBranch', 'hideDetached', 'hideArchived'] as const) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') throw env.fail('invalid-params', `${key} must be a boolean`)
  }
  if (params.externalVisibilityDefault !== undefined && params.externalVisibilityDefault !== 'show' && params.externalVisibilityDefault !== 'hide') {
    throw env.fail('invalid-params', 'externalVisibilityDefault must be show or hide')
  }
  if (params.filterRepoIds !== undefined &&
    (!Array.isArray(params.filterRepoIds) || !params.filterRepoIds.every((id) => typeof id === 'string' && id.trim() !== ''))) {
    throw env.fail('invalid-params', 'filterRepoIds must be an array of non-empty project IDs')
  }
  if (params.showProperties !== undefined &&
    (!Array.isArray(params.showProperties) || !params.showProperties.every((property) => PROPERTIES.includes(property as WorktreeCardProperty)))) {
    throw env.fail('invalid-params', `showProperties must contain only ${PROPERTIES.join(', ')}`)
  }
  const current = readStockOptions(env.store)
  const merged: Record<string, unknown> = { ...current, ...params }
  if (params.showProperties === undefined && (params.showBranch !== undefined || params.showComment !== undefined)) {
    const properties = new Set(current.showProperties)
    if (params.showBranch === true) properties.add('branch')
    else if (params.showBranch === false) properties.delete('branch')
    if (params.showComment === true) properties.add('notes')
    else if (params.showComment === false) properties.delete('notes')
    merged.showProperties = [...properties]
  }
  const next = normalize(merged)
  env.store.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    OPTIONS_KEY,
    JSON.stringify(next)
  )
  return next
}

export function readProjectOrder(store: PluginStore, repos: Repo[]): string[] {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', PROJECT_ORDER_KEY)
  let saved: string[] = []
  if (row) {
    try {
      const value: unknown = JSON.parse(row.value)
      if (Array.isArray(value) && value.every((id) => typeof id === 'string')) saved = value as string[]
    } catch {
      saved = []
    }
  }
  const liveIds = new Set(repos.map((repo) => repo.id))
  const ordered: string[] = []
  for (const id of saved) if (liveIds.delete(id)) ordered.push(id)
  for (const repo of repos) if (liveIds.delete(repo.id)) ordered.push(repo.id)
  return ordered
}

export function reorderProjects(env: OptionsEnv, repos: Repo[], ids: unknown): { ok: true } {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw env.fail('invalid-params', 'projects must be a non-empty array of project IDs')
  }
  const orderedIds = ids as string[]
  const current = repos.map((repo) => repo.id)
  if (new Set(orderedIds).size !== orderedIds.length || orderedIds.length !== current.length || current.some((id) => !orderedIds.includes(id))) {
    throw env.fail('invalid-params', 'project order must include every current project exactly once')
  }
  env.store.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    PROJECT_ORDER_KEY,
    JSON.stringify(orderedIds)
  )
  return { ok: true }
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
