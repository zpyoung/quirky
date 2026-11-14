import { useEffect, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties, type FormEvent } from 'react'
import { Badge, Button, ControlIcon, EmptyState, FormRow, IconButton, InlineAgentCard, InlineError, SectionHeader, StatusDot, TextField, ToolPanelActions, ToolPanelFrame, ToolPanelTools, type UiStatus } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ActivityThread } from './activity-types'
import type { DashboardBucket, DashboardSnapshot } from './dashboard-types'
import { DashboardModel, dashboardViewInput, REVIEW_STATUSES, WORKSPACE_STATUSES } from './dashboard-model'

const PLUGIN_ID = 'quirky.agent-status'
const VIEW_ID = 'view:quirky.agent-status/dashboard'
const OPEN_THREAD_COMMAND = 'command:quirky.agent-status/openActivityThread'
const TOGGLE_COMMAND = 'command:quirky.agent-status/toggleDashboard'
const OPEN_DASHBOARD_WINDOW_COMMAND = 'command:quirky.agent-status/openDashboardWindow'

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


const activityChanged = (event: QuirkyEvent) => event.type === `${PLUGIN_ID}/changed` || event.type === `${PLUGIN_ID}/activityChanged`
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function DashboardCardView({ context, thread, bucket }: { context: UiPluginContext; thread: ActivityThread; bucket: DashboardBucket }) {
  const openDashboardCard = () => {
    void context.executeCommand(OPEN_THREAD_COMMAND, { sessionId: thread.sessionId, worktreeId: thread.worktreeId, turn: thread.turn }).catch((cause: unknown) => {
      context.toast('Could not open Dashboard thread', errorMessage(cause))
    })
  }
  return (
    <div data-dashboard-bucket={bucket} data-session-id={thread.sessionId}>
      <InlineAgentCard
        title={thread.sessionName}
        status={statusForDisplay(thread.display)}
        action={{ label: 'Open', onAction: openDashboardCard }}
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

  useEffect(() => {
    const refresh = async () => {
      if (!enabled) {
        setAttention(0)
        setWorking(0)
        return
      }
      try {
        const snapshot = await context.call('quirky.agent-status/dashboard', {}) as DashboardSnapshot
        setAttention(snapshot.cards.filter((card) => card.bucket === 'attention').length)
        setWorking(snapshot.cards.filter((card) => card.bucket === 'working').length)
      } catch (error) {
        context.log(`could not load Dashboard count: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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
  }, [context, enabled])

  const toggleDashboard = () => {
    const layoutView = context.getLayout().view
    const input = layoutView?.id === VIEW_ID ? dashboardViewInput(layoutView.input) : {}
    void context.executeCommand(TOGGLE_COMMAND, input).catch((cause: unknown) => {
      context.toast('Could not toggle Agent Dashboard', cause instanceof Error ? cause.message : String(cause))
    })
  }

  if (!enabled) return null
  const total = attention + working
  return (
    <Button
      className="ui-cluster"
      style={{ width: '100%', justifyContent: 'flex-start' }}
      aria-label={total > 0 ? `Agent Dashboard, ${attention} need you and ${working} working` : 'Agent Dashboard'}
      onClick={toggleDashboard}
    >
      <StatusDot status={attention > 0 ? 'needs-you' : working > 0 ? 'working' : 'idle'} />
      <span>Agent Dashboard</span>
      {total > 0 ? <Badge tone={attention > 0 ? 'needs-you' : 'working'}>{total}</Badge> : null}
    </Button>
  )
}

export function DashboardView({ context, input }: { context: UiPluginContext; input?: unknown }) {
  const [model] = useState(() => new DashboardModel(context, input))
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
  const { view, snapshot, loading, error } = state
  const [draftText, setDraftText] = useState(() => view.text ?? '')
  const [draftProject, setDraftProject] = useState(() => view.project ?? '')
  const [draftWorkspaceStatus, setDraftWorkspaceStatus] = useState(() => view.workspaceStatus ?? '')
  const [draftReviewStatus, setDraftReviewStatus] = useState(() => view.reviewStatus ?? '')

  useEffect(() => {
    model.start()
    return () => model.dispose()
  }, [model])

  useEffect(() => {
    const previous = model.getSnapshot().view
    model.syncInput(input)
    const next = model.getSnapshot().view
    if (previous === next) return
    setDraftText(next.text ?? '')
    setDraftProject(next.project ?? '')
    setDraftWorkspaceStatus(next.workspaceStatus ?? '')
    setDraftReviewStatus(next.reviewStatus ?? '')
  }, [input, model])

  const showIdleThreads = () => model.updateView({ showIdle: true })
  const hideIdleThreads = () => model.updateView({ showIdle: false })
  const applyDashboardFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    model.updateView({
      text: draftText,
      project: draftProject,
      workspaceStatus: draftWorkspaceStatus || undefined,
      reviewStatus: draftReviewStatus || undefined
    })
  }
  const clearDashboardFilters = () => {
    setDraftText('')
    setDraftProject('')
    setDraftWorkspaceStatus('')
    setDraftReviewStatus('')
    model.clearFilters()
  }
  const retryDashboard = () => {
    void model.retry()
  }
  const retryUnavailableDashboard = () => {
    void model.retry()
  }
  const popOutDashboard = () => {
    void context.executeCommand(OPEN_DASHBOARD_WINDOW_COMMAND, view).catch((cause: unknown) => {
      context.toast('Could not pop out the Dashboard', errorMessage(cause))
    })
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
        <IconButton label="Pop out" title="Pop out" onClick={popOutDashboard}>
          <ControlIcon name="arrows-out" />
        </IconButton>
      </ToolPanelActions>
      <ToolPanelTools>
        {snapshot && snapshot.hiddenIdle > 0 ? (
          <IconButton label={`Show idle threads (${snapshot.hiddenIdle})`} title={`Show idle (${snapshot.hiddenIdle})`} onClick={showIdleThreads}>
            <ControlIcon name="funnel" />
          </IconButton>
        ) : view.showIdle === true ? (
          <IconButton label="Hide idle threads" title="Hide idle" onClick={hideIdleThreads}>
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
        <form style={FILTERS_STYLE} onSubmit={applyDashboardFilters}>
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
            <Button aria-label="Clear dashboard filters" onClick={clearDashboardFilters}>Clear all filters</Button>
          </div>
        </form>
        <div style={RESULTS_STYLE}>
          {error ? <InlineError message={error} action={{ label: 'Retry', onAction: retryDashboard }} /> : null}
          {snapshot?.unavailable.map((message) => (
            <InlineError
              key={message}
              message={`Unavailable: ${message}`}
              action={{ label: 'Retry', onAction: retryUnavailableDashboard }}
            />
          ))}
          {loading && snapshot === null ? <EmptyState message="Loading Agent Dashboard…" /> : null}
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

