import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react'
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
  overflow: 'hidden',
  color: 'var(--text, inherit)'
}
const TOOLBAR_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: 12 }
const FILTERS_STYLE: CSSProperties = { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: '8px 12px', padding: '0 12px 12px' }
const FIELD_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', flex: '1 1 200px', gap: 4, minWidth: 160 }
const ACTIONS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const BOARD_STYLE: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))', gap: 12, flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'auto', padding: 12 }
const COLUMN_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0 }
const CARD_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid var(--border, #7774)', borderRadius: 8, background: 'var(--bg-raised, transparent)' }
const CARD_BUTTON_STYLE: CSSProperties = { border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', fontWeight: 600, textAlign: 'left', cursor: 'pointer' }
const CARD_CONTEXT_STYLE: CSSProperties = { margin: 0, color: 'var(--muted, #8a909e)' }
const CARD_TEXT_STYLE: CSSProperties = { margin: 0, overflowWrap: 'anywhere' }

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
    <article className="dashboard-card" data-dashboard-bucket={bucket} data-session-id={thread.sessionId} style={CARD_STYLE}>
      <button
        type="button"
        aria-label={`Open dashboard thread ${thread.sessionId}`}
        style={CARD_BUTTON_STYLE}
        onClick={() => {
          void context.executeCommand(OPEN_THREAD_COMMAND, { sessionId: thread.sessionId, worktreeId: thread.worktreeId, turn: thread.turn }).catch((cause) => {
            context.toast('Could not open Dashboard thread', cause instanceof Error ? cause.message : String(cause))
          })
        }}
      >
        <span>{thread.sessionName}</span> · <span>{thread.label}</span>
      </button>
      <p className="dashboard-card-context" style={CARD_CONTEXT_STYLE}>
        {thread.worktreeName} · {thread.agent} · {thread.live ? 'Available' : 'Session unavailable'}
      </p>
      {thread.prompt ? <p className="dashboard-card-prompt" style={CARD_TEXT_STYLE}>{thread.prompt}</p> : null}
      {thread.detail ? <p className="dashboard-card-detail" style={CARD_TEXT_STYLE}>{thread.detail}</p> : null}
    </article>
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
    <section className="dashboard-navigation-section">
      <button
        className="dashboard-navigation"
        type="button"
        aria-label={total > 0 ? `Agent Dashboard, ${attention} need you and ${working} working` : 'Agent Dashboard'}
        onClick={() => void context.executeCommand(TOGGLE_COMMAND, input).catch((error) => {
          context.toast('Could not toggle Agent Dashboard', error instanceof Error ? error.message : String(error))
        })}
      >
        <span>Agent Dashboard</span>
        {total > 0 ? <span className={attention > 0 ? 'dashboard-count needs-you' : 'dashboard-count working'}>{total}</span> : null}
      </button>
    </section>
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
    <main className="dashboard-view" style={PAGE_STYLE}>
      <header className="dashboard-toolbar" style={TOOLBAR_STYLE}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Agent Dashboard</h1>
        <div className="dashboard-actions" style={ACTIONS_STYLE}>
          <button type="button" onClick={() => {
            void context.executeCommand(`command:${PLUGIN_ID}/openDashboardWindow`, view).catch((cause: unknown) => {
              context.toast('Could not pop out the Dashboard', cause instanceof Error ? cause.message : String(cause))
            })
          }}>Pop out</button>
          {snapshot ? (
            <span className="dashboard-total" aria-label="Dashboard total">
              {snapshot.total} total{snapshot.hiddenIdle > 0 ? ` · ${snapshot.hiddenIdle} idle hidden` : ''}
            </span>
          ) : null}
          {snapshot && snapshot.hiddenIdle > 0 ? (
            <button type="button" aria-label={`Show idle threads (${snapshot.hiddenIdle})`} onClick={() => updateView({ showIdle: true })}>
              Show idle ({snapshot.hiddenIdle})
            </button>
          ) : view.showIdle === true ? (
            <button type="button" aria-label="Hide idle threads" onClick={() => updateView({ showIdle: false })}>Hide idle</button>
          ) : null}
        </div>
      </header>
      <form className="dashboard-filters" style={FILTERS_STYLE} onSubmit={applyFilters}>
        <label style={FIELD_STYLE}>
          Search
          <input aria-label="Search dashboard" type="search" value={draftText} onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftText(event.currentTarget.value)} />
        </label>
        <label style={FIELD_STYLE}>
          Project
          <input aria-label="Project" type="search" value={draftProject} onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftProject(event.currentTarget.value)} />
        </label>
        <label style={FIELD_STYLE}>
          Workspace status
          <select aria-label="Workspace status" value={draftWorkspaceStatus} onChange={(event: ChangeEvent<HTMLSelectElement>) => setDraftWorkspaceStatus(event.currentTarget.value)}>
            <option value="">Any</option>
            {WORKSPACE_STATUSES.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label style={FIELD_STYLE}>
          GitHub review status
          <select aria-label="GitHub review status" value={draftReviewStatus} onChange={(event: ChangeEvent<HTMLSelectElement>) => setDraftReviewStatus(event.currentTarget.value)}>
            <option value="">Any</option>
            {REVIEW_STATUSES.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <div className="dashboard-filter-actions" style={ACTIONS_STYLE}>
          <button type="submit" aria-label="Apply dashboard filters">Apply</button>
          <button type="button" aria-label="Clear dashboard filters" onClick={clearFilters}>Clear all filters</button>
        </div>
      </form>
      {error ? <p className="dashboard-error" role="alert">{error}</p> : null}
      {snapshot?.unavailable.map((message) => <p className="dashboard-unavailable" role="alert" key={message}>Unavailable: {message}</p>)}
      {loading && snapshot === null ? <p role="status">Loading Agent Dashboard…</p> : null}
      {!loading && !error && snapshot?.total === 0 ? (
        <p className="dashboard-empty" role="status">{hasFilters ? 'No Activity threads match these filters.' : 'No Activity threads yet.'}</p>
      ) : null}
      {snapshot ? (
        <div className="dashboard-board" style={{ ...BOARD_STYLE, ...(view.showIdle === true ? { gridTemplateColumns: 'repeat(4, minmax(260px, 1fr))' } : {}) }}>
          {columns.map(({ bucket, label }) => (
            <section className="dashboard-column" data-dashboard-column={bucket} key={bucket} style={COLUMN_STYLE}>
              <h2 style={{ margin: 0, fontSize: 16 }}>{label}</h2>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
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
    </main>
  )
}
