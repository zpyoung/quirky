import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react'
import { Badge, Button, ControlIcon, EmptyState, FormRow, IconButton, InlineAgentCard, SectionHeader, StatusDot, TextField, ToolPanelActions, ToolPanelFrame, ToolPanelTools, type UiStatus } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ActivityThread } from './activity-types'
import type { DashboardBucket, DashboardQuery, DashboardSnapshot } from './dashboard-types'

const PLUGIN_ID = 'quirky.agent-status'
const VIEW_ID = `view:${PLUGIN_ID}/dashboard`
const OPEN_THREAD_COMMAND = `command:${PLUGIN_ID}/openActivityThread`
const TOGGLE_COMMAND = `command:${PLUGIN_ID}/toggleDashboard`
const WORKSPACE_STATUSES = [
  { value: 'todo', label: 'Todo' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'in-review', label: 'In review' },
  { value: 'done', label: 'Done' }
] as const
const REVIEW_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'draft', label: 'Draft' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'no-review', label: 'No review' }
] as const

const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden'
}
const HEADER_STYLE: CSSProperties = { padding: 'var(--ui-space-12)' }
const FILTERS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '0 0 auto',
  gap: 'var(--ui-space-8)',
  padding: '0 var(--ui-space-12) var(--ui-space-12)'
}
const ACTIONS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-8)' }
const RESULTS_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'auto'
}
const BOARD_STYLE: CSSProperties = {
  display: 'grid',
  gap: 'var(--ui-space-12)',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'auto',
  padding: 'var(--ui-space-12)'
}
const COLUMN_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-8)', minWidth: 0, minHeight: 0 }
const CARD_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  listStyle: 'none',
  margin: 0,
  padding: 0
}
const MESSAGE_STYLE: CSSProperties = {
  margin: 0,
  padding: 'var(--ui-space-8) var(--ui-space-12)',
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

export function dashboardViewInput(input: unknown): DashboardQuery {
  const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  const project = typeof value.project === 'string' ? value.project.trim() : ''
  const workspaceStatus = typeof value.workspaceStatus === 'string' ? value.workspaceStatus : ''
  const reviewStatus = typeof value.reviewStatus === 'string' ? value.reviewStatus : ''
  return {
    ...(text ? { text } : {}),
    ...(project ? { project } : {}),
    ...(WORKSPACE_STATUSES.some((entry) => entry.value === workspaceStatus) ? { workspaceStatus } : {}),
    ...(REVIEW_STATUSES.some((entry) => entry.value === reviewStatus) ? { reviewStatus } : {}),
    ...(typeof value.showIdle === 'boolean' ? { showIdle: value.showIdle } : {})
  }
}

const activityChanged = (event: QuirkyEvent) => event.type === `${PLUGIN_ID}/changed` || event.type === `${PLUGIN_ID}/activityChanged`

function DashboardCardView({ context, thread, bucket }: { context: UiPluginContext; thread: ActivityThread; bucket: DashboardBucket }) {
  return (
    <div data-dashboard-bucket={bucket} data-session-id={thread.sessionId}>
      <InlineAgentCard
        title={thread.sessionName}
        status={statusForDisplay(thread.display)}
        action={{
          label: 'Open',
          onAction: () => {
            void context.executeCommand(OPEN_THREAD_COMMAND, { sessionId: thread.sessionId, worktreeId: thread.worktreeId, turn: thread.turn }).catch((cause) => {
              context.toast('Could not open Dashboard thread', cause instanceof Error ? cause.message : String(cause))
            })
          }
        }}
        description={
          <div className="ui-stack">
            <div className="ui-cluster">
              <span>{thread.label}</span>
              <span>{thread.worktreeName} · {thread.agent} · {thread.live ? 'Available' : 'Session unavailable'}</span>
            </div>
            {thread.prompt ? <span>{thread.prompt}</span> : null}
            {thread.detail ? <span>{thread.detail}</span> : null}
          </div>
        }
      />
    </div>
  )
}

/** The experimental sidebar entry is controlled by the declared `dashboard-enabled` setting. */
export function DashboardNavigation({ context }: { context: UiPluginContext }) {
  const readEnabled = () => {
    try {
      return context.getSetting('dashboard-enabled') === true
    } catch {
      return false
    }
  }
  const [enabled, setEnabled] = useState(readEnabled)
  const [attention, setAttention] = useState(0)
  const [working, setWorking] = useState(0)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setAttention(0)
      setWorking(0)
      return
    }
    try {
      const snapshot = (await context.call('quirky.agent-status/dashboard', {})) as DashboardSnapshot
      setAttention(snapshot.cards.filter((card) => card.bucket === 'attention').length)
      setWorking(snapshot.cards.filter((card) => card.bucket === 'working').length)
    } catch (error) {
      context.log(`could not load Dashboard count: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [context, enabled])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'setting.changed' && event.id === `setting:${PLUGIN_ID}/dashboard-enabled`) {
        setEnabled(event.value === true)
      }
      if (activityChanged(event) || event.type === 'quirky.worktree/changed' || event.type === 'quirky.hosting/reviewCacheChanged') {
        void refresh()
      }
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

  if (!enabled) return null
  const total = attention + working
  const layoutView = context.getLayout().view
  const input = layoutView?.id === VIEW_ID ? dashboardViewInput(layoutView.input) : {}
  return (
    <Button
      className="ui-cluster"
      style={{ width: '100%', justifyContent: 'flex-start' }}
      aria-label={total > 0 ? `Agent Dashboard, ${attention} need you and ${working} working` : 'Agent Dashboard'}
      onClick={() => void context.executeCommand(TOGGLE_COMMAND, input).catch((error) => {
        context.toast('Could not toggle Agent Dashboard', error instanceof Error ? error.message : String(error))
      })}
    >
      <StatusDot status={attention > 0 ? 'needs-you' : working > 0 ? 'working' : 'idle'} />
      <span>Agent Dashboard</span>
      {total > 0 ? <Badge tone={attention > 0 ? 'needs-you' : 'working'}>{total}</Badge> : null}
    </Button>
  )
}

export function DashboardView({ context, input }: { context: UiPluginContext; input?: unknown }) {
  const [view, setView] = useState(() => dashboardViewInput(input))
  const [draftText, setDraftText] = useState(() => view.text ?? '')
  const [draftProject, setDraftProject] = useState(() => view.project ?? '')
  const [draftWorkspaceStatus, setDraftWorkspaceStatus] = useState(() => view.workspaceStatus ?? '')
  const [draftReviewStatus, setDraftReviewStatus] = useState(() => view.reviewStatus ?? '')
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = (await context.call('quirky.agent-status/dashboard', view)) as DashboardSnapshot
      if (current !== generation.current) return
      setSnapshot(result)
    } catch (cause) {
      if (current !== generation.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [context, view.text, view.project, view.workspaceStatus, view.reviewStatus, view.showIdle])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (activityChanged(event) || event.type === 'quirky.worktree/changed' || event.type === 'quirky.hosting/reviewCacheChanged') void refresh()
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

  const updateView = (patch: Partial<DashboardQuery>) => {
    const next = dashboardViewInput({ ...view, ...patch })
    setView(next)
    context.openView(VIEW_ID, next)
  }

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    updateView({
      text: draftText,
      project: draftProject,
      workspaceStatus: draftWorkspaceStatus || undefined,
      reviewStatus: draftReviewStatus || undefined
    })
  }

  const clearFilters = () => {
    const next = view.showIdle === true ? { showIdle: true } : {}
    setDraftText('')
    setDraftProject('')
    setDraftWorkspaceStatus('')
    setDraftReviewStatus('')
    setView(next)
    context.openView(VIEW_ID, next)
  }

  const columns: { bucket: DashboardBucket; label: string }[] = [
    { bucket: 'attention', label: 'Needs you' },
    { bucket: 'working', label: 'Working' },
    { bucket: 'done', label: 'Done' },
    ...(view.showIdle === true ? [{ bucket: 'idle' as const, label: 'Idle' }] : [])
  ]
  const hasFilters = Boolean(view.text || view.project || view.workspaceStatus || view.reviewStatus)

  return (
    <ToolPanelFrame title="Agent Dashboard">
      <ToolPanelActions>
        <IconButton
          label="Pop out"
          title="Pop out"
          onClick={() => {
            void context.executeCommand(`command:${PLUGIN_ID}/openDashboardWindow`, view).catch((cause: unknown) => {
              context.toast('Could not pop out the Dashboard', cause instanceof Error ? cause.message : String(cause))
            })
          }}
        >
          <ControlIcon name="arrows-out" />
        </IconButton>
      </ToolPanelActions>
      <ToolPanelTools>
        {snapshot && snapshot.hiddenIdle > 0 ? (
          <IconButton label={`Show idle threads (${snapshot.hiddenIdle})`} title={`Show idle (${snapshot.hiddenIdle})`} onClick={() => updateView({ showIdle: true })}>
            <ControlIcon name="funnel" />
          </IconButton>
        ) : view.showIdle === true ? (
          <IconButton label="Hide idle threads" title="Hide idle" onClick={() => updateView({ showIdle: false })}>
            <ControlIcon name="funnel" />
          </IconButton>
        ) : null}
      </ToolPanelTools>
      <main style={PAGE_STYLE}>
        {snapshot ? (
          <div style={HEADER_STYLE}>
            <Badge label="Dashboard total">
              {snapshot.total} total{snapshot.hiddenIdle > 0 ? ` · ${snapshot.hiddenIdle} idle hidden` : ''}
            </Badge>
          </div>
        ) : null}
        <form style={FILTERS_STYLE} onSubmit={applyFilters}>
          <TextField
            id="dashboard-search"
            label="Search"
            aria-label="Search dashboard"
            type="search"
            value={draftText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftText(event.currentTarget.value)}
          />
          <TextField
            id="dashboard-project"
            label="Project"
            aria-label="Project"
            type="search"
            value={draftProject}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftProject(event.currentTarget.value)}
          />
          <FormRow label="Workspace status" htmlFor="dashboard-workspace-status">
            <select
              aria-label="Workspace status"
              className="ui-text-field__input"
              style={{ appearance: 'auto' }}
              value={draftWorkspaceStatus}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setDraftWorkspaceStatus(event.currentTarget.value)}
            >
              <option value="">Any</option>
              {WORKSPACE_STATUSES.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
            </select>
          </FormRow>
          <FormRow label="GitHub review status" htmlFor="dashboard-review-status">
            <select
              aria-label="GitHub review status"
              className="ui-text-field__input"
              style={{ appearance: 'auto' }}
              value={draftReviewStatus}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setDraftReviewStatus(event.currentTarget.value)}
            >
              <option value="">Any</option>
              {REVIEW_STATUSES.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
            </select>
          </FormRow>
          <div style={ACTIONS_STYLE}>
            <Button type="submit" aria-label="Apply dashboard filters" variant="primary">Apply</Button>
            <Button aria-label="Clear dashboard filters" onClick={clearFilters}>Clear all filters</Button>
          </div>
        </form>
        <div style={RESULTS_STYLE}>
          {error ? <div className="ui-error-text" role="alert" style={MESSAGE_STYLE}>{error}</div> : null}
          {snapshot?.unavailable.map((message) => (
            <div className="ui-error-text" role="alert" style={MESSAGE_STYLE} key={message}>Unavailable: {message}</div>
          ))}
          {loading && snapshot === null ? <p className="ui-text-muted" role="status" style={MESSAGE_STYLE}>Loading Agent Dashboard…</p> : null}
          {!loading && !error && snapshot?.total === 0 ? (
            <div role="status">
              <EmptyState message={hasFilters ? 'No Activity threads match these filters.' : 'No Activity threads yet.'} />
            </div>
          ) : null}
          {snapshot ? (
            <div
              style={{
                ...BOARD_STYLE,
                gridTemplateColumns: view.showIdle === true
                  ? 'repeat(4, minmax(var(--ui-space-24), 1fr))'
                  : 'repeat(3, minmax(var(--ui-space-24), 1fr))'
              }}
            >
              {columns.map(({ bucket, label }) => (
                <section data-dashboard-column={bucket} key={bucket} style={COLUMN_STYLE}>
                  <SectionHeader title={label} />
                  <ul style={CARD_LIST_STYLE}>
                    {snapshot.cards.filter((card) => card.bucket === bucket).map((card) => (
                      <li key={card.thread.sessionId}>
                        <DashboardCardView context={context} thread={card.thread} bucket={card.bucket} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </main>
    </ToolPanelFrame>
  )
}

