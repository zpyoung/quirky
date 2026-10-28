import { isAbsolute, relative, resolve, sep } from 'node:path'
import { RpcErrorCode, type PluginContext, type PtySessionInfo, type Repo, type Session, type Worktree } from '@quirky/protocol'
import type { ExtrasState } from './state'

const DAY_MS = 86_400_000
const WINDOW_DAYS = { today: 1, week: 7, month: 30 } as const

type WorkspaceProjection = {
  worktreeId: string
  activityAt: number
  live: boolean | null
  reason: 'selected' | 'all' | 'recent' | 'old' | 'live' | 'sleeping' | 'main' | 'folder' | 'unknown'
  error?: string
}

export type ActivityProjection = ExtrasState & {
  visibleIds: string[]
  hiddenIds: string[]
  hiddenCount: number
  filterCount: number
  workspaces: WorkspaceProjection[]
}

type RuntimeFacts = {
  sessions: Session[]
  sessionsError?: string
  ptyError?: string
  liveWorktreeIds: Set<string>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMethodNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === RpcErrorCode.MethodNotFound
}

function positiveTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function containsPath(root: string, candidate: string): boolean {
  const within = relative(resolve(root), resolve(candidate))
  return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))
}

function workspaceForPath(path: string, worktrees: Worktree[]): Worktree | undefined {
  let owner: Worktree | undefined
  for (const worktree of worktrees) {
    if (containsPath(worktree.path, path) && (owner === undefined || worktree.path.length > owner.path.length)) {
      owner = worktree
    }
  }
  return owner
}

async function readSessions(context: PluginContext): Promise<{ sessions: Session[]; error?: string }> {
  try {
    const sessions = await context.call('quirky.session/list')
    if (!Array.isArray(sessions)) throw new Error('quirky.session/list returned an invalid session list')
    return { sessions: sessions as Session[] }
  } catch (error) {
    if (isMethodNotFound(error)) return { sessions: [] }
    return { sessions: [], error: messageOf(error) }
  }
}

async function readPtySessions(context: PluginContext): Promise<{ sessions: PtySessionInfo[]; error?: string }> {
  try {
    if (!context.pty.connected) throw new Error('PTY runtime provider is disconnected')
    const sessions = await context.pty.list()
    if (!Array.isArray(sessions)) throw new Error('PTY runtime provider returned an invalid session list')
    return { sessions }
  } catch (error) {
    return { sessions: [], error: messageOf(error) }
  }
}

async function runtimeFacts(context: PluginContext, worktrees: Worktree[]): Promise<RuntimeFacts> {
  const [sessionResult, ptyResult] = await Promise.all([readSessions(context), readPtySessions(context)])
  const bySessionId = new Map(sessionResult.sessions.map((session) => [session.id, session]))
  const liveWorktreeIds = new Set<string>()

  for (const session of sessionResult.sessions) {
    if (session.kind === 'structured' && session.status !== 'exited') {
      liveWorktreeIds.add(session.worktreeId)
    }
  }

  for (const pty of ptyResult.sessions) {
    if (pty.state !== 'running' || !pty.alive) continue
    const session = bySessionId.get(pty.sessionId)
    if (session !== undefined) {
      liveWorktreeIds.add(session.worktreeId)
      continue
    }
    const owner = workspaceForPath(pty.cwd, worktrees)
    if (owner !== undefined) liveWorktreeIds.add(owner.id)
  }

  return {
    sessions: sessionResult.sessions,
    ...(sessionResult.error === undefined ? {} : { sessionsError: sessionResult.error }),
    ...(ptyResult.error === undefined ? {} : { ptyError: ptyResult.error }),
    liveWorktreeIds
  }
}

function sessionActivity(sessions: Session[]): Map<string, number> {
  const activity = new Map<string, number>()
  for (const session of sessions) {
    const observed = Math.max(
      positiveTimestamp(session.lastActivityAt),
      positiveTimestamp(session.agentStatus?.evidenceAt)
    )
    if (observed > (activity.get(session.worktreeId) ?? 0)) activity.set(session.worktreeId, observed)
  }
  return activity
}

function cutoffFor(state: ExtrasState, now: number): number | null {
  const { workspaceActivityWindow: window, workspaceActivityCustomDays: customDays } = state.preferences
  if (window === 'all' || window === 'live-only') return null
  const days = window === 'custom' ? customDays : WINDOW_DAYS[window]
  const span = days * DAY_MS
  if (!Number.isFinite(span) || span >= now) return Number.NEGATIVE_INFINITY
  const cutoff = now - span
  return Number.isFinite(cutoff) ? cutoff : Number.NEGATIVE_INFINITY
}

function errorForUnknownRuntime(facts: RuntimeFacts): string | undefined {
  const errors = [facts.ptyError, facts.sessionsError].filter((error): error is string => error !== undefined)
  return errors.length === 0 ? undefined : errors.join('; ')
}

function activityAt(
  worktree: Worktree,
  repo: Repo | undefined,
  sessions: Map<string, number>,
  state: ExtrasState
): number {
  const identity = `${worktree.id}@${worktree.instanceId}`
  const observed = Math.max(
    positiveTimestamp(worktree.lastActivityAt),
    positiveTimestamp(sessions.get(worktree.id)),
    positiveTimestamp(state.visits[identity]),
    positiveTimestamp(state.exits[identity])
  )
  if (observed > 0) return observed
  const created = positiveTimestamp(worktree.createdAt)
  if (created > 0) return created
  return positiveTimestamp(repo?.addedAt)
}

/** Reads only canonical public APIs and projects their current facts for one client state snapshot. */
export async function projectActivity(
  context: PluginContext,
  state: ExtrasState,
  now: () => number
): Promise<ActivityProjection> {
  const [worktreeResult, repoResult] = await Promise.all([
    context.call('quirky.worktree/list'),
    context.call('quirky.repo/list')
  ])
  if (!Array.isArray(worktreeResult)) throw new Error('quirky.worktree/list returned an invalid workspace list')
  if (!Array.isArray(repoResult)) throw new Error('quirky.repo/list returned an invalid repository list')
  const worktrees = worktreeResult as Worktree[]
  const repos = repoResult as Repo[]
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const facts = await runtimeFacts(context, worktrees)
  const sessions = sessionActivity(facts.sessions)
  const cutoff = cutoffFor(state, now())
  const visibleIds: string[] = []
  const hiddenIds: string[] = []
  const workspaces: WorkspaceProjection[] = []

  for (const worktree of worktrees) {
    const active = state.active
    const selected = active?.worktreeId === worktree.id && active.instanceId === worktree.instanceId
    const live = facts.liveWorktreeIds.has(worktree.id)
      ? true
      : facts.ptyError !== undefined || facts.sessionsError !== undefined
        ? null
        : false
    const error = live === null ? errorForUnknownRuntime(facts) : undefined
    const activity = activityAt(worktree, repoById.get(worktree.repoId), sessions, state)
    let reason: WorkspaceProjection['reason']
    let visible: boolean

    if (selected) {
      reason = 'selected'
      visible = true
    } else if (state.preferences.workspaceActivityWindow === 'all') {
      reason = 'all'
      visible = true
    } else if (state.preferences.workspaceActivityWindow !== 'live-only') {
      visible = cutoff === null || activity >= cutoff
      reason = visible ? 'recent' : 'old'
    } else if (worktree.kind === 'folder') {
      reason = 'folder'
      visible = true
    } else if (live === true) {
      reason = 'live'
      visible = true
    } else if (worktree.isMain && state.preferences.alwaysShowDefaultBranchWorkspace) {
      reason = 'main'
      visible = true
    } else if (live === false) {
      reason = 'sleeping'
      visible = false
    } else {
      reason = 'unknown'
      visible = !worktree.isMain
    }

    workspaces.push({
      worktreeId: worktree.id,
      activityAt: activity,
      live,
      reason,
      ...(error === undefined ? {} : { error })
    })
    const destination = visible ? visibleIds : hiddenIds
    destination.push(worktree.id)
  }

  return {
    ...state,
    visibleIds,
    hiddenIds,
    hiddenCount: hiddenIds.length,
    filterCount: state.preferences.workspaceActivityWindow === 'all' ? 0 : 1,
    workspaces
  }
}
