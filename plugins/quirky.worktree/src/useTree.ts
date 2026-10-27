import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectGroup, QuirkyEvent, Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'

function upsert(sessions: Session[], session: Session): Session[] {
  return sessions.some((s) => s.id === session.id)
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [...sessions, session]
}

export type TreeData = {
  repos: Repo[]
  groups: ProjectGroup[]
  worktrees: Worktree[]
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
  const [loaded, setLoaded] = useState(false)
  const latestTree = useRef(0)
  const latestSessions = useRef(0)
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

  useEffect(() => {
    void loadTree()
    void loadSessions()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      const data = (event as { data?: unknown }).data as { session?: Session; sessionId?: string } | undefined
      switch (event.type) {
        case 'quirky.repo/changed':
        case 'quirky.worktree/changed':
          void loadTree()
          break
        case 'quirky.session/changed':
          if (sessionsOff.current || !data?.session) void loadSessions()
          else setSessions((prev) => (prev ? upsert(prev, data.session!) : prev))
          break
        case 'quirky.session/removed':
          setSessions((prev) => (prev ? prev.filter((s) => s.id !== data?.sessionId) : prev))
          break
        case 'plugin.changed':
          void loadTree()
          void loadSessions()
          break
        default:
          if (event.type.startsWith('quirky.session/')) void loadSessions()
      }
    })
    const stopConnection = context.onConnection((status) => {
      if (status !== 'connected') return
      void loadTree()
      void loadSessions()
    })
    return () => {
      unsubscribe()
      stopConnection()
    }
  }, [context, loadTree, loadSessions])

  return { repos, groups, worktrees, sessions, loaded }
}
