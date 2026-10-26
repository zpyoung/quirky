import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuirkyEvent, Repo, Session, UiLayout, UiPluginContext, Worktree } from '@quirky/protocol'
import { removeWorktree, SESSION_VIEW } from './actions'
import { AddRepoForm } from './AddRepoForm'
import { NewWorktreeDialog } from './NewWorktreeDialog'
import { buildReport, type WorktreesReport } from './report'
import { StatusDot } from './StatusDot'
import { worktreeStatus } from './status'

type Props = { context: UiPluginContext; report?(state: unknown): void }

/** The worktree the open view is about: its `input.worktree`, whichever view that is. */
function selectedWorktree(layout: UiLayout): string | null {
  const input = layout.view?.input
  const id = input && typeof input === 'object' ? (input as { worktree?: unknown }).worktree : undefined
  return typeof id === 'string' ? id : null
}

function upsert(sessions: Session[], session: Session): Session[] {
  return sessions.some((s) => s.id === session.id)
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [...sessions, session]
}

/** Repos, worktrees and sessions kept current from the daemon's events; `sessions` is null while `quirky.session` is off. */
function useTree(context: UiPluginContext) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [loaded, setLoaded] = useState(false)
  const latestTree = useRef(0)
  const latestSessions = useRef(0)
  const sessionsOff = useRef(true)

  const loadTree = useCallback(async () => {
    const ticket = ++latestTree.current
    try {
      const [nextRepos, nextWorktrees] = await Promise.all([
        context.call('quirky.repo/list') as Promise<Repo[]>,
        context.call('quirky.worktree/list') as Promise<Worktree[]>
      ])
      if (ticket !== latestTree.current) return
      setRepos(nextRepos)
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

  return { repos, worktrees, sessions, loaded }
}

function WorktreeRow({
  context,
  worktree,
  sessions,
  selected
}: {
  context: UiPluginContext
  worktree: Worktree
  sessions: Session[] | null
  selected: boolean
}) {
  return (
    <li className={`worktree${selected ? ' selected' : ''}`}>
      <button
        className="worktree-main"
        onClick={() => context.openView(SESSION_VIEW, { worktree: worktree.id })}
        title={worktree.path}
      >
        <StatusDot status={sessions === null ? null : worktreeStatus(sessions, worktree.id)} />
        <span className="worktree-name">{worktree.name}</span>
      </button>
      {!worktree.isMain && (
        <button
          className="icon-button"
          aria-label={`Remove worktree ${worktree.name}`}
          title="Remove worktree"
          onClick={() => void removeWorktree(context, worktree)}
        >
          ×
        </button>
      )}
    </li>
  )
}

function RepoSection({
  context,
  repo,
  worktrees,
  sessions,
  selectedId
}: {
  context: UiPluginContext
  repo: Repo
  worktrees: Worktree[]
  sessions: Session[] | null
  selectedId: string | null
}) {
  const [creating, setCreating] = useState(false)

  return (
    <section className="repo">
      <header className="repo-header">
        <span className="repo-name" title={repo.path}>
          {repo.name}
        </span>
        <button
          className="icon-button"
          aria-label={`New worktree in ${repo.name}`}
          title="New worktree"
          onClick={() => setCreating(true)}
        >
          +
        </button>
      </header>
      <ul className="worktree-list">
        {worktrees.map((worktree) => (
          <WorktreeRow
            key={worktree.id}
            context={context}
            worktree={worktree}
            sessions={sessions}
            selected={worktree.id === selectedId}
          />
        ))}
      </ul>
      {creating && <NewWorktreeDialog context={context} repo={repo} onClose={() => setCreating(false)} />}
    </section>
  )
}

/** The sidebar's repo and worktree tree with add-repo, new-worktree and remove. */
export function WorktreesSection({ context, report }: Props) {
  const { repos, worktrees, sessions, loaded } = useTree(context)
  const [layout, setLayout] = useState(() => context.getLayout())
  const lastReport = useRef('')

  useEffect(() => {
    setLayout(context.getLayout())
    return context.onLayout(setLayout)
  }, [context])

  const selectedId = selectedWorktree(layout)
  const state: WorktreesReport = useMemo(
    () => buildReport(repos, worktrees, sessions, selectedId),
    [repos, worktrees, sessions, selectedId]
  )

  useEffect(() => {
    if (!loaded) return
    const text = JSON.stringify(state)
    if (text === lastReport.current) return
    lastReport.current = text
    report?.(state)
  }, [loaded, state, report])

  return (
    <>
      <div className="repo-scroll">
        {repos.length === 0 && <p className="muted pad">No repositories yet.</p>}
        {repos.map((repo) => (
          <RepoSection
            key={repo.id}
            context={context}
            repo={repo}
            worktrees={worktrees.filter((worktree) => worktree.repoId === repo.id)}
            sessions={sessions}
            selectedId={selectedId}
          />
        ))}
      </div>
      <AddRepoForm context={context} />
    </>
  )
}
