import type { Ask, QuirkyEvent, Session, UiPluginContext } from '@quirky/protocol'
import type { WorktreeControl } from './control-types'
import { activityMark, needsYou, type ChecksState } from './view-model'

const BADGE_PANEL = 'sidebar-section:quirky.worktree/worktrees'

function isRefreshEvent(type: string): boolean {
  return type === 'plugin.changed' ||
    type.startsWith('quirky.repo/') ||
    type.startsWith('quirky.worktree/') ||
    type.startsWith('quirky.session/') ||
    type.startsWith('quirky.ask/') ||
    type.startsWith('quirky.hosting/') ||
    type.startsWith('quirky.sidebar-extras/')
}

async function optional<T>(load: () => Promise<unknown>, valid: (value: unknown) => value is T): Promise<T | null> {
  try {
    const value = await load()
    return valid(value) ? value : null
  } catch {
    return null
  }
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

function pendingByWorktree(asks: unknown[] | null): ReadonlyMap<string, number> | null {
  if (asks === null) return null
  const counts = new Map<string, number>()
  for (const ask of asks as Ask[]) {
    if (ask.envelope?.status !== 'pending' || typeof ask.worktreeId !== 'string') continue
    counts.set(ask.worktreeId, (counts.get(ask.worktreeId) ?? 0) + 1)
  }
  return counts
}

function checksByWorktree(projection: unknown): ReadonlyMap<string, ChecksState | null> {
  const checks = new Map<string, ChecksState | null>()
  const workspaces = (projection as { workspaces?: unknown } | null)?.workspaces
  if (!Array.isArray(workspaces)) return checks
  for (const entry of workspaces as { worktreeId?: unknown; checks?: ChecksState | null }[]) {
    if (typeof entry?.worktreeId === 'string') checks.set(entry.worktreeId, entry.checks ?? null)
  }
  return checks
}

function title(needing: number, errored: number): string {
  const base = `${needing} ${needing === 1 ? 'worktree needs' : 'worktrees need'} you`
  return errored > 0 ? `${base}, ${errored} errored` : base
}

/**
 * Keeps the Worktrees section's rail badge equal to the number of worktrees needing you, over all
 * worktrees and independent of the active view or whether the section is mounted. Returns its dispose.
 */
export function startAttentionBadge(context: UiPluginContext): () => void {
  let active = true
  let generation = 0

  const refresh = async () => {
    const ticket = ++generation
    const [worktrees, sessions, asks, projection] = await Promise.all([
      optional(async () => context.call('quirky.worktree/list'), isArray),
      optional(async () => context.call('quirky.session/list'), isArray),
      optional(async () => context.call('quirky.ask/list', { pendingOnly: true }), isArray),
      optional(async () => context.call('quirky.sidebar-extras/projection'), (value): value is object => typeof value === 'object' && value !== null)
    ])
    if (!active || ticket !== generation || worktrees === null) return

    const pending = pendingByWorktree(asks)
    const checks = checksByWorktree(projection)
    const now = Date.now()
    let needing = 0
    let errored = 0
    for (const worktree of worktrees as WorktreeControl[]) {
      const mark = activityMark(worktree, (sessions ?? []) as Session[], pending, now)
      if (!needsYou(worktree, mark, checks.get(worktree.id) ?? null)) continue
      needing++
      if (mark === 'error') errored++
    }
    context.setPanelBadge(BADGE_PANEL, needing || null, needing > 0 ? title(needing, errored) : undefined, errored > 0 ? 'failing' : 'needs-you')
  }

  const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
    if (isRefreshEvent(event.type)) void refresh()
  })
  const unsubscribeConnection = context.onConnection((status) => {
    if (status === 'connected') void refresh()
  })
  void refresh()

  return () => {
    active = false
    generation += 1
    unsubscribeEvents()
    unsubscribeConnection()
  }
}
