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

const CLOCK_TICK_MS = 60_000

/** Timer seam so tests can drive the clock. */
export type BadgeClock = {
  now(): number
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const systemClock: BadgeClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

type Loaded = {
  worktrees: WorktreeControl[]
  sessions: Session[]
  pending: ReadonlyMap<string, number> | null
  checks: ReadonlyMap<string, ChecksState | null>
}

/**
 * Keeps the Worktrees section's rail badge equal to the number of worktrees needing you, over all
 * worktrees and independent of the active view or whether the section is mounted. Event-driven loads
 * are re-evaluated every minute so clock-driven marks (stale agent evidence) age out without a
 * refetch. Returns its dispose; after dispose, or once the host revokes the context, no work
 * escapes as an unhandled rejection and no further badge is set.
 */
export function startAttentionBadge(context: UiPluginContext, clock: BadgeClock = systemClock): () => void {
  let active = true
  let generation = 0
  let loaded: Loaded | null = null

  const evaluate = () => {
    if (!active || loaded === null) return
    const now = clock.now()
    let needing = 0
    let errored = 0
    for (const worktree of loaded.worktrees) {
      const mark = activityMark(worktree, loaded.sessions, loaded.pending, now)
      if (!needsYou(worktree, mark, loaded.checks.get(worktree.id) ?? null)) continue
      needing++
      if (mark === 'error') errored++
    }
    context.setPanelBadge(BADGE_PANEL, needing || null, needing > 0 ? title(needing, errored) : undefined, errored > 0 ? 'failing' : 'needs-you')
  }

  const refresh = async () => {
    try {
      const ticket = ++generation
      const [worktrees, sessions, asks, projection] = await Promise.all([
        optional(async () => context.call('quirky.worktree/list'), isArray),
        optional(async () => context.call('quirky.session/list'), isArray),
        optional(async () => context.call('quirky.ask/list', { pendingOnly: true }), isArray),
        optional(async () => context.call('quirky.sidebar-extras/projection'), (value): value is object => typeof value === 'object' && value !== null)
      ])
      if (!active || ticket !== generation || worktrees === null) return
      loaded = {
        worktrees: worktrees as WorktreeControl[],
        sessions: (sessions ?? []) as Session[],
        pending: pendingByWorktree(asks),
        checks: checksByWorktree(projection)
      }
      evaluate()
    } catch {
      // a revoked context throws from call/setPanelBadge; the badge is already being torn down
    }
  }

  const tick = () => {
    try {
      evaluate()
    } catch {
      // see refresh
    }
  }

  const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
    if (isRefreshEvent(event.type)) void refresh()
  })
  const unsubscribeConnection = context.onConnection((status) => {
    if (status === 'connected') void refresh()
  })
  const timer = clock.setInterval(tick, CLOCK_TICK_MS)
  void refresh()

  return () => {
    active = false
    generation += 1
    clock.clearInterval(timer)
    unsubscribeEvents()
    unsubscribeConnection()
  }
}
