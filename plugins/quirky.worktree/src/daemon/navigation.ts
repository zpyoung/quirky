import type { PluginStore, Worktree } from '@quirky/protocol'
import type { CallerIdentity } from '../../selector'
import type { StockWorktreeOptions, WorktreeControl } from '../control-types'
import { openWindowView, selectWindow, type SelectedWindow, type WindowEnv } from './window'
import { resolveWorkspaceViewOwner } from './view-owner'

const HISTORY_KEY = 'worktree-navigation-history'
const WINDOW_HISTORY_KEY = 'worktree-navigation-history-by-window'
const SESSION_VIEW = 'view:quirky.session/worktree'
const DIFF_VIEW = 'view:quirky.git/diff'

type NavigationHistory = { worktrees: string[]; index: number }
type NavigationTarget = 'terminal' | 'changes'
type NavigationEnv = WindowEnv & {
  store: PluginStore
  list(): Promise<WorktreeControl[]>
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: WorktreeControl; all: WorktreeControl[] }>
  options(): StockWorktreeOptions
  changed(data: { repoId: string; worktreeId: string }): void
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function emptyHistory(): NavigationHistory {
  return { worktrees: [], index: -1 }
}

function historyOf(value: unknown): NavigationHistory | null {
  const record = recordOf(value)
  if (!Array.isArray(record?.worktrees) || !record.worktrees.every((id) => typeof id === 'string') ||
    typeof record.index !== 'number' || !Number.isSafeInteger(record.index)) return null
  const worktrees = record.worktrees as string[]
  return { worktrees, index: Math.min(worktrees.length - 1, Math.max(-1, record.index)) }
}

function readLegacyHistory(store: PluginStore): NavigationHistory {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', HISTORY_KEY)
  if (!row) return emptyHistory()
  try {
    return historyOf(JSON.parse(row.value)) ?? emptyHistory()
  } catch {
    return emptyHistory()
  }
}

function readWindowHistories(store: PluginStore): Record<string, NavigationHistory> {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', WINDOW_HISTORY_KEY)
  if (!row) return {}
  try {
    const raw = recordOf(JSON.parse(row.value))
    if (!raw) return {}
    const histories: Record<string, NavigationHistory> = {}
    for (const [connId, value] of Object.entries(raw)) {
      if (!/^[1-9]\d*$/.test(connId)) continue
      const history = historyOf(value)
      if (history) histories[connId] = history
    }
    return histories
  } catch {
    return {}
  }
}

function readHistory(store: PluginStore, selected: SelectedWindow): NavigationHistory {
  const histories = readWindowHistories(store)
  const key = String(selected.connId)
  if (histories[key]) return histories[key]!
  return selected.windowCount === 1 ? readLegacyHistory(store) : emptyHistory()
}

function writeHistory(store: PluginStore, selected: SelectedWindow, history: NavigationHistory): void {
  const histories = readWindowHistories(store)
  histories[String(selected.connId)] = history
  const value = JSON.stringify(histories)
  store.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    WINDOW_HISTORY_KEY,
    value
  )
  if (selected.windowCount === 1) {
    store.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      HISTORY_KEY,
      JSON.stringify(history)
    )
  }
}

/**
 * The worktree the selected view belongs to, or null when no listed worktree uniquely owns it.
 * Navigation only needs this as a history position, so a stale view can always be left.
 */
function activeWorktree(view: unknown, worktrees: WorktreeControl[]): string | null {
  const resolution = resolveWorkspaceViewOwner(view, worktrees)
  return resolution.kind === 'owned' ? resolution.owner.worktreeId : null
}

function navigationOrder(worktrees: WorktreeControl[], options: StockWorktreeOptions): WorktreeControl[] {
  const visible = worktrees.filter((worktree) =>
    (options.filterRepoIds.length === 0 || options.filterRepoIds.includes(worktree.repoId)) &&
    !(options.hideCliCreated && worktree.createdBy === 'cli') &&
    !(options.hideDefaultBranch && worktree.isMain) &&
    !(options.hideDetached && worktree.kind === 'git' && !worktree.isMain && worktree.branch === null) &&
    !(options.hideArchived && worktree.archivedAt !== null) &&
    worktree.externalVisible !== false &&
    (options.showSleeping || !worktree.sleeping)
  )
  return visible.sort((left, right) => {
    if (!(options.groupBy === 'none' && options.sortBy === 'name') && left.isMain !== right.isMain) return left.isMain ? -1 : 1
    if (options.sortBy === 'name') return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    if (options.sortBy === 'manual') return right.manualOrder - left.manualOrder || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    if (options.sortBy === 'project') {
      const project = left.repoId.localeCompare(right.repoId)
      if (project !== 0) return project
    }
    const activity = Math.max(right.lastActivityAt, right.createdAt) - Math.max(left.lastActivityAt, left.createdAt)
    return activity || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  })
}

function targetOf(value: unknown, fail: NavigationEnv['fail']): NavigationTarget {
  if (value === undefined || value === 'terminal') return 'terminal'
  if (value === 'changes') return 'changes'
  throw fail('invalid-params', 'target must be terminal or changes')
}

/**
 * Returns the panel to All projects when `worktree` sits outside the project filter, so a worktree
 * opened from anywhere (a toast, history, the palette) is never hidden by the narrowing.
 */
async function showProjectOf(env: NavigationEnv, worktree: Worktree): Promise<void> {
  const { filterRepoIds } = env.options()
  if (filterRepoIds.length === 0 || filterRepoIds.includes(worktree.repoId)) return
  await env.call('quirky.worktree/setOptions', { filterRepoIds: [] })
}

async function openView(env: NavigationEnv, selected: SelectedWindow, worktree: Worktree, target: NavigationTarget): Promise<void> {
  await showProjectOf(env, worktree)
  await openWindowView(env, selected.connId, target === 'terminal' ? SESSION_VIEW : DIFF_VIEW,
    target === 'terminal'
      ? { worktree: worktree.id }
      : { worktree: worktree.id, mode: 'combined', area: 'all' })
  if ('sleeping' in worktree && worktree.sleeping) {
    env.store.run('UPDATE worktrees SET sleeping = 0, sleep_changed_at = ? WHERE id = ?', Date.now(), worktree.id)
    env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  }
}

function pushHistory(store: PluginStore, selected: SelectedWindow, id: string, previous?: string | null): void {
  const history = readHistory(store, selected)
  const worktrees = history.worktrees.slice(0, history.index + 1)
  if (previous !== undefined && previous !== null && worktrees[worktrees.length - 1] !== previous) worktrees.push(previous)
  if (worktrees[worktrees.length - 1] !== id) worktrees.push(id)
  writeHistory(store, selected, { worktrees, index: worktrees.length - 1 })
}

export async function navigate(
  env: NavigationEnv,
  params: { worktree: string; target?: unknown; window?: unknown },
  identity: CallerIdentity
): Promise<{ worktreeId: string; target: NavigationTarget }> {
  if (typeof params.worktree !== 'string' || params.worktree.trim() === '') throw env.fail('invalid-params', 'worktree must be a selector')
  const target = targetOf(params.target, env.fail)
  const selected = await selectWindow(env, params.window)
  const { worktree, all } = await env.find(params.worktree, identity)
  const previous = activeWorktree(selected.view, all)
  await openView(env, selected, worktree, target)
  pushHistory(env.store, selected, worktree.id, previous)
  return { worktreeId: worktree.id, target }
}

export async function openIn(
  env: NavigationEnv,
  params: { worktree: string; target: unknown; window?: unknown },
  identity: CallerIdentity
): Promise<{ worktreeId: string; target: NavigationTarget }> {
  return navigate(env, params, identity)
}

export async function navigationState(env: NavigationEnv, window?: unknown): Promise<NavigationHistory> {
  return readHistory(env.store, await selectWindow(env, window))
}

export async function navigationHistoryMove(
  env: NavigationEnv,
  direction: 'back' | 'forward',
  window?: unknown
): Promise<{ worktreeId: string; target: 'terminal' }> {
  const selected = await selectWindow(env, window)
  const listed = await env.list()
  const current = activeWorktree(selected.view, listed)
  const available = new Set(listed.map((worktree) => worktree.id))
  const history = readHistory(env.store, selected)
  let worktrees = history.worktrees.filter((id) => available.has(id))
  let index = current === null ? -1 : worktrees.lastIndexOf(current)
  if (current !== null && index < 0) {
    worktrees = history.worktrees.slice(0, history.index + 1).filter((id) => available.has(id))
    worktrees.push(current)
    index = worktrees.length - 1
  } else if (current === null) {
    // not an off-by-one: a cursor past the survivors means the view being left followed them, so back still reaches the last
    index = Math.min(history.index, worktrees.length)
  }
  const nextIndex = index + (direction === 'back' ? -1 : 1)
  if (nextIndex < 0 || nextIndex >= worktrees.length) throw env.fail('not-found', `There is no workspace to navigate ${direction}.`)
  const id = worktrees[nextIndex]!
  const target = listed.find((worktree) => worktree.id === id)
  if (!target) throw env.fail('not-found', `Workspace ${id} no longer exists.`)
  await openView(env, selected, target, 'terminal')
  writeHistory(env.store, selected, { worktrees, index: nextIndex })
  return { worktreeId: id, target: 'terminal' }
}

export async function navigationStep(
  env: NavigationEnv,
  direction: 'previous' | 'next',
  window?: unknown
): Promise<{ worktreeId: string; target: 'terminal' }> {
  const selected = await selectWindow(env, window)
  const listed = await env.list()
  const current = activeWorktree(selected.view, listed)
  const worktrees = navigationOrder(listed, env.options())
  const index = worktrees.findIndex((worktree) => worktree.id === current)
  if (index < 0) throw env.fail('not-found', 'The current view is not a listed worktree.')
  const next = index + (direction === 'previous' ? -1 : 1)
  const target = worktrees[next]
  if (!target) throw env.fail('not-found', `There is no ${direction} worktree.`)
  await openView(env, selected, target, 'terminal')
  pushHistory(env.store, selected, target.id, current)
  return { worktreeId: target.id, target: 'terminal' }
}

export async function navigationIndex(
  env: NavigationEnv,
  value: unknown,
  window?: unknown
): Promise<{ worktreeId: string; target: 'terminal' }> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 9) {
    throw env.fail('invalid-params', 'index must be an integer from 1 through 9')
  }
  const selected = await selectWindow(env, window)
  const listed = await env.list()
  const previous = activeWorktree(selected.view, listed)
  const worktrees = navigationOrder(listed, env.options())
  const target = worktrees[value - 1]
  if (!target) throw env.fail('not-found', `Workspace index ${value} is not available.`)
  await openView(env, selected, target, 'terminal')
  pushHistory(env.store, selected, target.id, previous)
  return { worktreeId: target.id, target: 'terminal' }
}
