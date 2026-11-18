import type { Ask, QuirkyEvent, Session, UiPluginContext } from '@quirky/protocol'
import type { WorktreeControl } from './control-types'
import { activityMark, needsYou, type ChecksState } from './view-model'

const BADGE_PANEL = 'sidebar-section:quirky.worktree/worktrees'

type ReloadDomains = {
  worktrees: boolean
  sessions: boolean
  asks: boolean
  projection: boolean
}

const ALL_DOMAINS: ReloadDomains = { worktrees: true, sessions: true, asks: true, projection: true }
const NO_DOMAINS: ReloadDomains = { worktrees: false, sessions: false, asks: false, projection: false }

function refreshDomainsForEvent(type: string): ReloadDomains | null {
  if (type === 'plugin.changed' || type.startsWith('quirky.repo/') || type.startsWith('quirky.worktree/')) return ALL_DOMAINS
  if (type.startsWith('quirky.session/')) return { ...NO_DOMAINS, sessions: true }
  if (type.startsWith('quirky.ask/')) return { ...NO_DOMAINS, asks: true }
  if (type.startsWith('quirky.hosting/') || type.startsWith('quirky.sidebar-extras/')) return { ...NO_DOMAINS, projection: true }
  return null
}

function unionDomains(left: ReloadDomains, right: ReloadDomains): ReloadDomains {
  return {
    worktrees: left.worktrees || right.worktrees,
    sessions: left.sessions || right.sessions,
    asks: left.asks || right.asks,
    projection: left.projection || right.projection
  }
}

function hasDomains(domains: ReloadDomains): boolean {
  return domains.worktrees || domains.sessions || domains.asks || domains.projection
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
  let loaded: Loaded | null = null
  let dirty = NO_DOMAINS
  let runner: Promise<void> | null = null

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

  const load = async (domains: ReloadDomains) => {
    try {
      const [worktrees, sessions, asks, projection] = await Promise.all([
        domains.worktrees ? optional(async () => context.call('quirky.worktree/list'), isArray) : Promise.resolve(undefined),
        domains.sessions ? optional(async () => context.call('quirky.session/list'), isArray) : Promise.resolve(undefined),
        domains.asks ? optional(async () => context.call('quirky.ask/list', { pendingOnly: true }), isArray) : Promise.resolve(undefined),
        domains.projection
          ? optional(async () => context.call('quirky.sidebar-extras/projection'), (value): value is object => typeof value === 'object' && value !== null)
          : Promise.resolve(undefined)
      ])
      if (!active || (domains.worktrees && worktrees === null)) return
      const previous = loaded
      if (previous === null && !domains.worktrees) return
      loaded = {
        worktrees: domains.worktrees ? worktrees as WorktreeControl[] : previous!.worktrees,
        sessions: domains.sessions ? (sessions ?? []) as Session[] : previous?.sessions ?? [],
        pending: domains.asks ? pendingByWorktree(asks ?? null) : previous?.pending ?? null,
        checks: domains.projection ? checksByWorktree(projection ?? null) : previous?.checks ?? new Map()
      }
      evaluate()
    } catch {
      // a revoked context throws from call/setPanelBadge; the badge is already being torn down
    }
  }

  const drain = async () => {
    while (active && hasDomains(dirty)) {
      const domains = dirty
      dirty = NO_DOMAINS
      await load(domains)
    }
  }

  const refresh = (domains: ReloadDomains) => {
    if (!active) return
    dirty = unionDomains(dirty, loaded === null ? ALL_DOMAINS : domains)
    if (runner !== null) return
    const task = drain()
    runner = task
    const settle = () => {
      if (runner !== task) return
      runner = null
      if (active && hasDomains(dirty)) refresh(NO_DOMAINS)
    }
    void task.then(settle, settle)
  }

  const tick = () => {
    try {
      evaluate()
    } catch {
      // see refresh
    }
  }

  const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
    const domains = refreshDomainsForEvent(event.type)
    if (domains !== null) refresh(domains)
  })
  const unsubscribeConnection = context.onConnection((status) => {
    if (status === 'connected') refresh(ALL_DOMAINS)
  })
  const timer = clock.setInterval(tick, CLOCK_TICK_MS)
  refresh(ALL_DOMAINS)

  return () => {
    active = false
    dirty = NO_DOMAINS
    clock.clearInterval(timer)
    unsubscribeEvents()
    unsubscribeConnection()
  }
}
