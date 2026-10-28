import type { PluginStore, Worktree } from '@quirky/protocol'
import type { CallerIdentity } from '../../selector'
import type { StockWorktreeOptions, WorktreeControl } from '../control-types'

const HISTORY_KEY = 'worktree-navigation-history'
const SESSION_VIEW = 'view:quirky.session/worktree'
const DIFF_VIEW = 'view:quirky.git/diff'

type NavigationHistory = { worktrees: string[]; index: number }
type NavigationTarget = 'terminal' | 'changes'
type NavigationEnv = {
  store: PluginStore
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string): Error
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  list(): Promise<WorktreeControl[]>
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: WorktreeControl; all: WorktreeControl[] }>
  options(): StockWorktreeOptions
  changed(data: { repoId: string; worktreeId: string }): void
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readHistory(store: PluginStore): NavigationHistory {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', HISTORY_KEY)
  if (!row) return { worktrees: [], index: -1 }
  try {
    const value = recordOf(JSON.parse(row.value) as unknown)
    if (!Array.isArray(value?.worktrees) || !value.worktrees.every((id) => typeof id === 'string') ||
      typeof value.index !== 'number' || !Number.isSafeInteger(value.index)) return { worktrees: [], index: -1 }
    const worktrees = value.worktrees as string[]
    return { worktrees, index: Math.min(worktrees.length - 1, Math.max(-1, value.index)) }
  } catch {
    return { worktrees: [], index: -1 }
  }
}

function writeHistory(store: PluginStore, history: NavigationHistory): void {
  store.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    HISTORY_KEY,
    JSON.stringify(history)
  )
}

async function activeLayout(env: NavigationEnv): Promise<Record<string, unknown>> {
  let state: unknown
  try {
    state = await env.call('ui.state')
  } catch (error) {
    throw env.fail('conflict', `Workspace navigation is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = recordOf(state)
  if (!value || !Array.isArray(value.windows) || !recordOf(value.layout)) {
    throw env.fail('conflict', 'Workspace navigation requires public window and layout state.')
  }
  if (value.windows.length !== 1) {
    throw env.fail('conflict', 'Workspace navigation is ambiguous because the public API cannot target one window when multiple windows are connected.')
  }
  return value.layout as Record<string, unknown>
}

function activeWorktree(layout: Record<string, unknown>): string | null {
  const view = recordOf(layout.view)
  const input = recordOf(view?.input)
  return typeof input?.worktree === 'string' ? input.worktree : null
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
    if (left.isMain !== right.isMain) return left.isMain ? -1 : 1
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

async function openView(env: NavigationEnv, worktree: Worktree, target: NavigationTarget): Promise<void> {
  await env.call('ui.view.open', target === 'terminal'
    ? { id: SESSION_VIEW, input: { worktree: worktree.id } }
    : { id: DIFF_VIEW, input: { worktree: worktree.id, mode: 'combined', area: 'all' } })
  if ('sleeping' in worktree && worktree.sleeping) {
    env.store.run('UPDATE worktrees SET sleeping = 0, sleep_changed_at = ? WHERE id = ?', Date.now(), worktree.id)
    env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  }
}

function pushHistory(store: PluginStore, id: string): void {
  const history = readHistory(store)
  const worktrees = history.worktrees.slice(0, history.index + 1)
  if (worktrees[worktrees.length - 1] !== id) worktrees.push(id)
  writeHistory(store, { worktrees, index: worktrees.length - 1 })
}

export async function navigate(
  env: NavigationEnv,
  params: { worktree: string; target?: unknown },
  identity: CallerIdentity
): Promise<{ worktreeId: string; target: NavigationTarget }> {
  if (typeof params.worktree !== 'string' || params.worktree.trim() === '') throw env.fail('invalid-params', 'worktree must be a selector')
  const target = targetOf(params.target, env.fail)
  await activeLayout(env)
  const { worktree } = await env.find(params.worktree, identity)
  await openView(env, worktree, target)
  pushHistory(env.store, worktree.id)
  return { worktreeId: worktree.id, target }
}

export async function openIn(
  env: NavigationEnv,
  params: { worktree: string; target: unknown },
  identity: CallerIdentity
): Promise<{ worktreeId: string; target: NavigationTarget }> {
  return navigate(env, params, identity)
}

export function navigationState(store: PluginStore): NavigationHistory {
  return readHistory(store)
}

export async function navigationHistoryMove(
  env: NavigationEnv,
  direction: 'back' | 'forward'
): Promise<{ worktreeId: string; target: 'terminal' }> {
  const layout = await activeLayout(env)
  const current = activeWorktree(layout)
  const listed = await env.list()
  const available = new Set(listed.map((worktree) => worktree.id))
  const history = readHistory(env.store)
  let worktrees = history.worktrees.filter((id) => available.has(id))
  let index = current === null ? -1 : worktrees.lastIndexOf(current)
  if (current !== null && index < 0) {
    worktrees = history.worktrees.slice(0, history.index + 1).filter((id) => available.has(id))
    worktrees.push(current)
    index = worktrees.length - 1
  } else if (current === null) {
    index = Math.min(history.index, worktrees.length - 1)
  }
  const nextIndex = index + (direction === 'back' ? -1 : 1)
  if (nextIndex < 0 || nextIndex >= worktrees.length) throw env.fail('not-found', `There is no workspace to navigate ${direction}.`)
  const id = worktrees[nextIndex]!
  const target = listed.find((worktree) => worktree.id === id)
  if (!target) throw env.fail('not-found', `Workspace ${id} no longer exists.`)
  await openView(env, target, 'terminal')
  writeHistory(env.store, { worktrees, index: nextIndex })
  return { worktreeId: id, target: 'terminal' }
}

export async function navigationStep(
  env: NavigationEnv,
  direction: 'previous' | 'next'
): Promise<{ worktreeId: string; target: 'terminal' }> {
  const layout = await activeLayout(env)
  const current = activeWorktree(layout)
  const worktrees = navigationOrder(await env.list(), env.options())
  const index = worktrees.findIndex((worktree) => worktree.id === current)
  if (index < 0) throw env.fail('not-found', 'The current view is not a listed worktree.')
  const next = index + (direction === 'previous' ? -1 : 1)
  const target = worktrees[next]
  if (!target) throw env.fail('not-found', `There is no ${direction} worktree.`)
  await openView(env, target, 'terminal')
  pushHistory(env.store, target.id)
  return { worktreeId: target.id, target: 'terminal' }
}

export async function navigationIndex(
  env: NavigationEnv,
  value: unknown
): Promise<{ worktreeId: string; target: 'terminal' }> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 9) {
    throw env.fail('invalid-params', 'index must be an integer from 1 through 9')
  }
  const worktrees = navigationOrder(await env.list(), env.options())
  const target = worktrees[value - 1]
  if (!target) throw env.fail('not-found', `Workspace index ${value} is not available.`)
  await activeLayout(env)
  await openView(env, target, 'terminal')
  pushHistory(env.store, target.id)
  return { worktreeId: target.id, target: 'terminal' }
}
