import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Badge, Button, EmptyState, FormRow, InlineAgentCard, ListRow, SectionHeader, TextField, type UiStatus } from '@quirky/ui'
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
const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden'
}
const EMBEDDED_PAGE_STYLE: CSSProperties = { ...PAGE_STYLE, display: 'block', overflowY: 'auto' }
const HEADER_STYLE: CSSProperties = { padding: 'var(--ui-space-12)' }
const ACTIONS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-8)' }
const FILTERS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  padding: '0 var(--ui-space-12) var(--ui-space-12)'
}
const RESULTS_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  padding: '0 var(--ui-space-12) var(--ui-space-16)'
}
const THREAD_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  listStyle: 'none',
  margin: 0,
  padding: 0
}
const CHILDREN_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-4)',
  listStyle: 'none',
  margin: 0,
  padding: '0 0 0 var(--ui-space-16)'
}
const MESSAGE_STYLE: CSSProperties = {
  margin: 0,
  padding: 'var(--ui-space-8) 0',
  overflowWrap: 'anywhere'
}

function statusForDisplay(display: ActivityThread['display']): UiStatus {
  switch (display) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'waiting':
    case 'blocked':
    case 'permission':
      return 'needs-you'
    case 'failed':
      return 'failing'
    case 'done':
      return 'done'
    case 'interrupted':
    case 'idle':
    case 'unconfirmed':
    case 'unverifiable':
      return 'idle'
    default:
      return 'idle'
  }
}

function viewInput(input: unknown): ActivityViewInput {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const group: GroupBy = value.group === 'worktree' || value.group === 'provider' || value.group === 'none' ? value.group : 'status'
  const worktree = typeof value.worktree === 'string' ? value.worktree.trim() : ''
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  return {
    group,
    ...(worktree ? { worktree } : {}),
    ...(text ? { text } : {}),
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


export function ActivityView({ context, input, embedded }: { context: UiPluginContext; input?: unknown; embedded?: boolean }) {
  const [view, setView] = useState(() => viewInput(input))
  const controlId = useId()
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
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

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
    const next = { ...view, ...patch }
    const text = typeof patch.text === 'string' ? patch.text.trim() : draftText.trim()
    const worktree = typeof patch.worktree === 'string' ? patch.worktree.trim() : draftWorktree.trim()
    if (text) next.text = text
    else delete next.text
    if (worktree) next.worktree = worktree
    else delete next.worktree
    setView(next)
    if (!embedded) context.openView(VIEW_ID, next)
  }

  const applyFilters = () => updateView({ text: draftText, worktree: draftWorktree })

  const markRead = async (thread: ActivityThread) => {
    try {
      await context.call('quirky.agent-status/acknowledge', { session: thread.sessionId, turn: thread.turn })
      await refreshRef.current()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const markAllRead = async () => {
    const observed = threads.filter((thread) => thread.unread)
    try {
      await Promise.all(observed.map((thread) => context.call('quirky.agent-status/acknowledge', { session: thread.sessionId, turn: thread.turn })))
      await refreshRef.current()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const clearCompleted = async () => {
    const worktree = view.worktree?.trim()
    try {
      await context.call('quirky.agent-status/clearCompleted', worktree ? { worktree } : {})
      await refreshRef.current()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openThread = (thread: ActivityThread) => {
    void context
      .executeCommand(OPEN_THREAD_COMMAND, { sessionId: thread.sessionId, worktreeId: thread.worktreeId, turn: thread.turn })
      .catch((cause) => context.toast('Could not open Activity thread', cause instanceof Error ? cause.message : String(cause)))
  }

  const grouped = groupsFor(threads, view.group)
  const hasFilters = Boolean(view.text?.trim() || view.worktree?.trim() || view.unreadOnly)

  return (
    <main style={embedded ? EMBEDDED_PAGE_STYLE : PAGE_STYLE}>
      <div style={HEADER_STYLE}>
        <SectionHeader
          title="Activity"
          actions={
            <div style={ACTIONS_STYLE}>
              <Button aria-label="Mark all read" disabled={!threads.some((thread) => thread.unread)} onClick={() => void markAllRead()}>
                Mark all read
              </Button>
              <Button aria-label="Clear completed activity" variant="destructive" disabled={loading || error !== null || !threads.some((thread) => thread.display === 'done' || thread.display === 'failed' || thread.display === 'interrupted')} onClick={() => void clearCompleted()}>
                Clear completed
              </Button>
            </div>
          }
        />
      </div>
      <form
        style={FILTERS_STYLE}
        onSubmit={(event) => {
          event.preventDefault()
          applyFilters()
        }}
      >
        <TextField
          id={`${controlId}-search`}
          label="Search Activity"
          aria-label="Search Activity"
          type="search"
          value={draftText}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftText(event.currentTarget.value)}
        />
        {embedded ? null : (
          <TextField
            id={`${controlId}-worktree`}
            label="Worktree ID"
            aria-label="Worktree ID"
            type="search"
            value={draftWorktree}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftWorktree(event.currentTarget.value)}
          />
        )}
        <FormRow label="Unread only" htmlFor={`${controlId}-unread`}>
          <input
            id={`${controlId}-unread`}
            aria-label="Unread only"
            type="checkbox"
            checked={view.unreadOnly === true}
            style={{ accentColor: 'var(--ui-accent)' }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => updateView({ unreadOnly: event.currentTarget.checked })}
          />
        </FormRow>
        <FormRow label="Group by" htmlFor={`${controlId}-group`}>
          <select
            id={`${controlId}-group`}
            aria-label="Group Activity by"
            className="ui-text-field__input"
            style={{ appearance: 'auto' }}
            value={view.group}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => updateView({ group: event.currentTarget.value as GroupBy })}
          >
            <option value="status">Status</option>
            <option value="worktree">Workspace</option>
            <option value="provider">Provider</option>
            <option value="none">No groups</option>
          </select>
        </FormRow>
        <Button type="submit" aria-label="Apply Activity filters" variant="primary">
          Apply
        </Button>
      </form>
      <div style={RESULTS_STYLE}>
        {error ? <div className="ui-error-text" role="alert" style={MESSAGE_STYLE}>{error}</div> : null}
        {loading && threads.length === 0 ? <p className="ui-text-muted" role="status" style={MESSAGE_STYLE}>Loading Activity…</p> : null}
        {!loading && !error && threads.length === 0 ? (
          <div role="status">
            <EmptyState message={hasFilters ? 'No Activity threads match these filters.' : 'No Activity threads yet.'} />
          </div>
        ) : null}
        <div className="ui-stack">
          {grouped.map((group) => (
            <section className="ui-stack" data-activity-group={group.key} key={group.key}>
              {view.group !== 'none' ? <SectionHeader title={group.label} /> : null}
              <ul style={THREAD_LIST_STYLE}>
                {group.threads.map((thread) => {
                  const isExpanded = expanded[thread.sessionId] === true
                  const status = statusForDisplay(thread.display)
                  return (
                    <li className="ui-stack" data-session-id={thread.sessionId} key={thread.sessionId}>
                      <InlineAgentCard
                        title={thread.sessionName}
                        status={status}
                        action={{ label: 'Open', onAction: () => openThread(thread) }}
                        description={
                          <div className="ui-stack">
                            <div className="ui-cluster">
                              <span>{thread.label}</span>
                              {thread.unread ? <Badge tone="needs-you" label="Unread">Unread</Badge> : null}
                              <span>{thread.worktreeName} · {thread.agent} · {thread.live ? 'Available' : 'Unavailable'}</span>
                            </div>
                            {thread.prompt ? <span>{thread.prompt}</span> : null}
                            {thread.detail ? <span>{thread.detail}</span> : null}
                          </div>
                        }
                      />
                      <div className="ui-cluster">
                        <Button disabled={!thread.unread} onClick={() => void markRead(thread)}>
                          {thread.unread ? 'Mark read' : 'Read'}
                        </Button>
                        {thread.children.length > 0 ? (
                          <Button
                            aria-label={`${isExpanded ? 'Hide' : 'Show'} child agents for ${thread.sessionId}`}
                            aria-expanded={isExpanded}
                            onClick={() => {
                              const expanding = !isExpanded
                              setExpanded((previous) => ({ ...previous, [thread.sessionId]: expanding }))
                              if (expanding && thread.unread) void markRead(thread)
                            }}
                          >
                            {isExpanded ? 'Hide child agents' : `Show ${thread.children.length} child agents`}
                          </Button>
                        ) : null}
                      </div>
                      {isExpanded ? (
                        <ul style={CHILDREN_STYLE}>
                          {thread.children.map((child) => (
                            <li data-child-id={child.id} key={`${child.kind}:${child.id}`}>
                              <ListRow
                                title={child.id}
                                description={`${child.kind} · ${child.state}`}
                                status={child.state === 'working' ? 'working' : child.state === 'waiting' ? 'needs-you' : 'done'}
                              />
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
      </div>
    </main>
  )
}

