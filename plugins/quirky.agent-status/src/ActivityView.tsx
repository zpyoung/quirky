import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ActivityQuery, ActivityThread } from './activity-types'

const PLUGIN_ID = 'quirky.agent-status'
const VIEW_ID = `view:${PLUGIN_ID}/activity`
const OPEN_THREAD_COMMAND = `command:${PLUGIN_ID}/openActivityThread`
const DISPLAY_ORDER: ActivityThread['display'][] = [
  'waiting',
  'blocked',
  'permission',
  'failed',
  'unconfirmed',
  'working',
  'monitoring',
  'interrupted',
  'unverifiable',
  'done',
  'idle'
]

type GroupBy = 'status' | 'worktree' | 'provider' | 'none'
export type ActivityViewInput = ActivityQuery & { group: GroupBy }
type Group = { key: string; label: string; threads: ActivityThread[] }

function viewInput(input: unknown): ActivityViewInput {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const group: GroupBy = value.group === 'worktree' || value.group === 'provider' || value.group === 'none' ? value.group : 'status'
  return {
    group,
    ...(typeof value.worktree === 'string' ? { worktree: value.worktree } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.unreadOnly === 'boolean' ? { unreadOnly: value.unreadOnly } : {})
  }
}

function queryInput(input: ActivityViewInput): ActivityQuery {
  const worktree = input.worktree?.trim()
  const text = input.text?.trim()
  return {
    ...(worktree ? { worktree } : {}),
    ...(text ? { text } : {}),
    ...(input.unreadOnly === true ? { unreadOnly: true } : {})
  }
}

function groupsFor(threads: ActivityThread[], by: GroupBy): Group[] {
  const groups: Group[] = []
  const grouped = new Map<string, Group>()
  for (const thread of threads) {
    if (by === 'none') {
      if (groups.length === 0) groups.push({ key: 'all', label: 'Activity', threads: [] })
      groups[0]!.threads.push(thread)
      continue
    }
    const key = by === 'status' ? thread.display : by === 'worktree' ? thread.worktreeId : thread.agent
    let group = grouped.get(key)
    if (!group) {
      const label = by === 'status' ? thread.label : by === 'worktree' ? thread.worktreeName : thread.agent
      group = { key, label, threads: [] }
      grouped.set(key, group)
      groups.push(group)
    }
    group.threads.push(thread)
  }
  if (by === 'status') {
    groups.sort((left, right) => DISPLAY_ORDER.indexOf(left.threads[0]!.display) - DISPLAY_ORDER.indexOf(right.threads[0]!.display))
  }
  return groups
}

function changedActivity(event: QuirkyEvent): boolean {
  return event.type === `${PLUGIN_ID}/changed` || event.type === `${PLUGIN_ID}/activityChanged`
}

export function ActivityNavigation({ context }: { context: UiPluginContext }) {
  const [unread, setUnread] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const result = (await context.call('quirky.agent-status/activity', { unreadOnly: true })) as { threads: ActivityThread[] }
      setUnread(result.threads.length)
    } catch (error) {
      context.log(`could not load Activity count: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [context])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (changedActivity(event)) void refresh()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refresh()
    })
    void refresh()
    return () => {
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, refresh])

  return (
    <section className="activity-navigation-section">
      <button
        className="activity-navigation"
        type="button"
        aria-label={unread > 0 ? `Activity, ${unread} unread` : 'Activity'}
        onClick={() => void context.executeCommand(`command:${PLUGIN_ID}/openActivity`)}
      >
        <span>Activity</span>
        {unread > 0 ? <span className="activity-unread-count">{unread}</span> : null}
      </button>
    </section>
  )
}

export function ActivityView({ context, input }: { context: UiPluginContext; input?: unknown }) {
  const [view, setView] = useState(() => viewInput(input))
  const [draftText, setDraftText] = useState(() => view.text ?? '')
  const [draftWorktree, setDraftWorktree] = useState(() => view.worktree ?? '')
  const [threads, setThreads] = useState<ActivityThread[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = (await context.call('quirky.agent-status/activity', queryInput(view))) as { threads: ActivityThread[] }
      if (current !== generation.current) return
      setThreads(result.threads)
    } catch (cause) {
      if (current !== generation.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [context, view.group, view.text, view.unreadOnly, view.worktree])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (changedActivity(event)) void refresh()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refresh()
    })
    void refresh()
    return () => {
      generation.current += 1
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, refresh])

  const updateView = (patch: Partial<ActivityViewInput>) => {
    const next = { ...view, text: draftText, worktree: draftWorktree, ...patch }
    setView(next)
    context.openView(VIEW_ID, next)
  }

  const applyFilters = () => updateView({ text: draftText, worktree: draftWorktree })

  const markRead = async (thread: ActivityThread) => {
    try {
      await context.call('quirky.agent-status/acknowledge', { session: thread.sessionId, turn: thread.turn })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const markAllRead = async () => {
    const observed = threads.filter((thread) => thread.unread)
    try {
      await Promise.all(observed.map((thread) => context.call('quirky.agent-status/acknowledge', { session: thread.sessionId, turn: thread.turn })))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const clearCompleted = async () => {
    const worktree = view.worktree?.trim()
    try {
      await context.call('quirky.agent-status/clearCompleted', worktree ? { worktree } : {})
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openThread = (thread: ActivityThread) => {
    void context
      .executeCommand(OPEN_THREAD_COMMAND, { sessionId: thread.sessionId, worktreeId: thread.worktreeId, turn: thread.turn })
      .catch((cause) => context.toast('Could not open Activity thread', cause instanceof Error ? cause.message : String(cause)))
  }

  const text = draftText
  const worktree = draftWorktree
  const grouped = groupsFor(threads, view.group)
  const hasFilters = Boolean(view.text?.trim() || view.worktree?.trim() || view.unreadOnly)

  return (
    <main className="activity-view">
      <header className="activity-toolbar">
        <h1>Activity</h1>
        <div className="activity-actions">
          <button type="button" aria-label="Mark all read" disabled={!threads.some((thread) => thread.unread)} onClick={() => void markAllRead()}>
            Mark all read
          </button>
          <button type="button" aria-label="Clear completed activity" onClick={() => void clearCompleted()}>
            Clear completed
          </button>
        </div>
      </header>
      <form
        className="activity-filters"
        onSubmit={(event) => {
          event.preventDefault()
          applyFilters()
        }}
      >
        <label>
          Search Activity
          <input
            aria-label="Search Activity"
            type="search"
            value={draftText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftText(event.currentTarget.value)}
          />
        </label>
        <label>
          Worktree ID
          <input
            aria-label="Worktree ID"
            type="search"
            value={draftWorktree}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftWorktree(event.currentTarget.value)}
          />
        </label>
        <label>
          <input
            aria-label="Unread only"
            type="checkbox"
            checked={view.unreadOnly === true}
            onChange={(event: ChangeEvent<HTMLInputElement>) => updateView({ unreadOnly: event.currentTarget.checked })}
          />
          Unread only
        </label>
        <label>
          Group by
          <select
            aria-label="Group Activity by"
            value={view.group}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => updateView({ group: event.currentTarget.value as GroupBy })}
          >
            <option value="status">Status</option>
            <option value="worktree">Workspace</option>
            <option value="provider">Provider</option>
            <option value="none">No groups</option>
          </select>
        </label>
        <button type="submit" aria-label="Apply Activity filters">
          Apply
        </button>
      </form>
      {error ? <p className="activity-error" role="alert">{error}</p> : null}
      {loading && threads.length === 0 ? <p className="activity-loading" role="status">Loading Activity…</p> : null}
      {!loading && !error && threads.length === 0 ? (
        <p className="activity-empty" role="status">{hasFilters ? 'No Activity threads match these filters.' : 'No Activity threads yet.'}</p>
      ) : null}
      <div className="activity-groups">
        {grouped.map((group) => (
          <section className="activity-group" data-activity-group={group.key} key={group.key}>
            {view.group !== 'none' ? <h2>{group.label}</h2> : null}
            <ul>
              {group.threads.map((thread) => {
                const isExpanded = expanded[thread.sessionId] === true
                return (
                  <li className={`activity-thread${thread.unread ? ' unread' : ''}`} data-session-id={thread.sessionId} key={thread.sessionId}>
                    <div className="activity-thread-heading">
                      <button type="button" className="activity-thread-open" onClick={() => openThread(thread)}>
                        <span className="activity-thread-name">{thread.sessionName}</span>
                        <span className="activity-thread-state">{thread.label}</span>
                      </button>
                      {thread.unread ? <span className="activity-unread" aria-label="Unread">Unread</span> : null}
                    </div>
                    <p className="activity-thread-context">
                      {thread.worktreeName} · {thread.agent} · {thread.live ? 'Available' : 'Unavailable'}
                    </p>
                    {thread.prompt ? <p className="activity-thread-prompt">{thread.prompt}</p> : null}
                    {thread.detail ? <p className="activity-thread-detail">{thread.detail}</p> : null}
                    <div className="activity-thread-actions">
                      <button type="button" disabled={!thread.unread} onClick={() => void markRead(thread)}>
                        {thread.unread ? 'Mark read' : 'Read'}
                      </button>
                      {thread.children.length > 0 ? (
                        <button
                          type="button"
                          aria-label={`${isExpanded ? 'Hide' : 'Show'} child agents for ${thread.sessionId}`}
                          aria-expanded={isExpanded}
                          onClick={() => {
                            const expanding = !isExpanded
                            setExpanded((previous) => ({ ...previous, [thread.sessionId]: expanding }))
                            if (expanding && thread.unread) void markRead(thread)
                          }}
                        >
                          {isExpanded ? 'Hide child agents' : `Show ${thread.children.length} child agents`}
                        </button>
                      ) : null}
                    </div>
                    {isExpanded ? (
                      <ul className="activity-children">
                        {thread.children.map((child) => (
                          <li data-child-id={child.id} key={`${child.kind}:${child.id}`}>
                            <span>{child.id}</span> <span>{child.kind}</span> <span>{child.state}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
