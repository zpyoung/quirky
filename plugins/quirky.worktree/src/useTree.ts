import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectGroup, QuirkyEvent, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'

function upsert(sessions: Session[], session: Session): Session[] {
  return sessions.some((s) => s.id === session.id)
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [...sessions, session]
}

export type HeimdallWorktreeStatus = {
  watcherId: string
  watcherName: string
  state: string
  ownerContact: 'live' | 'unverifiable'
  observedAtMs: number
  reason?: string
  detail?: string
  consecutiveErrors?: number
}

type HeimdallFleetRow = {
  enrollment: { worktreeId?: string | null }
  status: { state: string; reason?: string; detail?: string; consecutiveErrors?: number }
  ownerContact: 'live' | 'unverifiable'
  observedAtMs: number
  name: string
  target: { watcherId: string; connectionId?: string | null; pairingRevision?: number | null }
}

type HeimdallFleetSnapshot = { generatedAtMs: number; rows: HeimdallFleetRow[] }

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseHeimdallSnapshot(value: unknown): HeimdallFleetSnapshot | null {
  const snapshot = objectRecord(value)
  if (!snapshot || typeof snapshot.generatedAtMs !== 'number' || !Number.isFinite(snapshot.generatedAtMs) || !Array.isArray(snapshot.rows)) return null
  const rows: HeimdallFleetRow[] = []
  for (const item of snapshot.rows) {
    const row = objectRecord(item)
    const enrollment = objectRecord(row?.enrollment)
    const status = objectRecord(row?.status)
    const target = objectRecord(row?.target)
    const worktreeId = enrollment?.worktreeId
    if (
      !row || !enrollment || !status || !target || typeof target.watcherId !== 'string' ||
      (target.connectionId !== undefined && target.connectionId !== null && typeof target.connectionId !== 'string') ||
      (target.pairingRevision !== undefined && target.pairingRevision !== null && (typeof target.pairingRevision !== 'number' || !Number.isFinite(target.pairingRevision))) ||
      (worktreeId !== undefined && worktreeId !== null && typeof worktreeId !== 'string') ||
      typeof status.state !== 'string' || (row.ownerContact !== 'live' && row.ownerContact !== 'unverifiable') ||
      typeof row.observedAtMs !== 'number' || !Number.isFinite(row.observedAtMs) || typeof row.name !== 'string'
    ) continue
    rows.push({
      target: {
        watcherId: target.watcherId,
        ...(typeof target.connectionId === 'string' ? { connectionId: target.connectionId } : {}),
        ...(typeof target.pairingRevision === 'number' ? { pairingRevision: target.pairingRevision } : {})
      },
      enrollment: { worktreeId },
      status: {
        state: status.state,
        ...(typeof status.reason === 'string' ? { reason: status.reason } : {}),
        ...(typeof status.detail === 'string' ? { detail: status.detail } : {}),
        ...(typeof status.consecutiveErrors === 'number' ? { consecutiveErrors: status.consecutiveErrors } : {})
      },
      ownerContact: row.ownerContact,
      observedAtMs: row.observedAtMs,
      name: row.name
    })
  }
  return { generatedAtMs: snapshot.generatedAtMs, rows }
}

function statusByWorktree(rows: readonly HeimdallFleetRow[]): Record<string, HeimdallWorktreeStatus> {
  const statuses: Record<string, HeimdallWorktreeStatus> = {}
  for (const row of rows) {
    if (row.target.connectionId != null || row.target.pairingRevision != null) continue
    const worktreeId = row.enrollment.worktreeId
    if (!worktreeId) continue
    const previous = statuses[worktreeId]
    if (previous && previous.observedAtMs > row.observedAtMs) continue
    statuses[worktreeId] = {
      watcherId: row.target.watcherId,
      watcherName: row.name,
      state: row.status.state,
      ownerContact: row.ownerContact,
      observedAtMs: row.observedAtMs,
      ...(row.status.reason ? { reason: row.status.reason } : {}),
      ...(row.status.detail ? { detail: row.status.detail } : {}),
      ...(row.status.consecutiveErrors === undefined ? {} : { consecutiveErrors: row.status.consecutiveErrors })
    }
  }
  return statuses
}

export type HeimdallAwareWorktree = Worktree & { heimdallStatus: HeimdallWorktreeStatus | null }

export type TreeData = {
  repos: Repo[]
  groups: ProjectGroup[]
  worktrees: HeimdallAwareWorktree[]
  /** Null while `quirky.session` is off. */
  sessions: Session[] | null
  loaded: boolean
}

/**
 * Projects, groups, workspaces and sessions kept current from the daemon's events. Each load takes
 * a ticket so a slow response never overwrites a newer one.
 */
export function useTree(context: UiPluginContext): TreeData {
  const [repos, setRepos] = useState<Repo[]>([])
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [heimdallByWorktree, setHeimdallByWorktree] = useState<Record<string, HeimdallWorktreeStatus>>({})
  const [loaded, setLoaded] = useState(false)
  const latestTree = useRef(0)
  const latestSessions = useRef(0)
  const latestHeimdall = useRef(Number.NEGATIVE_INFINITY)
  const sessionsOff = useRef(true)

  const loadTree = useCallback(async () => {
    const ticket = ++latestTree.current
    try {
      const [nextRepos, nextGroups, nextWorktrees] = await Promise.all([
        context.call('quirky.repo/list') as Promise<Repo[]>,
        context.call('quirky.repo/groupList') as Promise<ProjectGroup[]>,
        context.call('quirky.worktree/list') as Promise<Worktree[]>
      ])
      if (ticket !== latestTree.current) return
      setRepos(nextRepos)
      setGroups(nextGroups)
      setWorktrees(nextWorktrees)
      setLoaded(true)
    } catch (error) {
      context.log(`could not load worktrees: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [context])

  const loadSessions = useCallback(async () => {
    const ticket = ++latestSessions.current
    let next: Session[] | null
    try {
      next = (await context.call('quirky.session/list')) as Session[]
    } catch {
      next = null
    }
    if (ticket !== latestSessions.current) return
    sessionsOff.current = next === null
    setSessions(next)
  }, [context])

  const loadHeimdall = useCallback(async () => {
    try {
      const incoming = parseHeimdallSnapshot(await context.call('quirky.heimdall/fleet', {}))
      if (!incoming || incoming.generatedAtMs <= latestHeimdall.current) return
      latestHeimdall.current = incoming.generatedAtMs
      setHeimdallByWorktree(statusByWorktree(incoming.rows))
    } catch {
      // Heimdall is optional from the worktree sidebar's perspective.
    }
  }, [context])

  useEffect(() => {
    void loadTree()
    void loadSessions()
    void loadHeimdall()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      const data = (event as { data?: unknown }).data
      switch (event.type) {
        case 'quirky.repo/changed':
        case 'quirky.worktree/changed':
          void loadTree()
          break
        case 'quirky.session/changed': {
          const sessionData = data as { session?: Session } | undefined
          if (sessionsOff.current || !sessionData?.session) void loadSessions()
          else setSessions((previous) => (previous ? upsert(previous, sessionData.session!) : previous))
          break
        }
        case 'quirky.session/removed': {
          const sessionData = data as { sessionId?: string } | undefined
          setSessions((previous) => (previous ? previous.filter((session) => session.id !== sessionData?.sessionId) : previous))
          break
        }
        case 'plugin.changed':
          void loadTree()
          void loadSessions()
          void loadHeimdall()
          break
        case 'quirky.heimdall/fleetChanged': {
          const incoming = parseHeimdallSnapshot(data)
          if (!incoming || incoming.generatedAtMs <= latestHeimdall.current) break
          latestHeimdall.current = incoming.generatedAtMs
          setHeimdallByWorktree(statusByWorktree(incoming.rows))
          break
        }
        default:
          if (event.type.startsWith('quirky.session/')) void loadSessions()
      }
    })
    const stopConnection = context.onConnection((status) => {
      if (status !== 'connected') return
      void loadTree()
      void loadSessions()
      void loadHeimdall()
    })
    return () => {
      unsubscribe()
      stopConnection()
    }
  }, [context, loadTree, loadSessions, loadHeimdall])

  const worktreesWithHeimdall = useMemo<HeimdallAwareWorktree[]>(
    () => worktrees.map((worktree) => ({ ...worktree, heimdallStatus: heimdallByWorktree[worktree.id] ?? null })),
    [heimdallByWorktree, worktrees]
  )

  return { repos, groups, worktrees: worktreesWithHeimdall, sessions, loaded }
}
