import { useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties, type FormEvent } from 'react'
import { Badge, Button, ControlIcon, EmptyState, FormRow, IconButton, InlineAgentCard, InlineError, ListRow, NoticeLine, SectionHeader, TextField, ToolPanelFrame, ToolPanelTools, type UiStatus } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { ActivityThread } from './activity-types'
import { ActivityModel, groupActivityThreads, hasActivityFilters, type ActivitySnapshot, type ActivityViewInput, type GroupBy } from './activity-model'

const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden'
}
const EMBEDDED_PAGE_STYLE: CSSProperties = { ...PAGE_STYLE, display: 'block', overflowY: 'auto' }
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function useActivityModel(context: UiPluginContext, mode: 'sidebar' | 'center', input?: unknown) {
  const modelRef = useRef<ActivityModel | null>(null)
  if (!modelRef.current) modelRef.current = new ActivityModel(context, { mode, initialInput: input })
  const model = modelRef.current
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)

  useEffect(() => {
    model.start()
    return () => model.dispose()
  }, [model])
  useEffect(() => {
    model.syncInput(input)
  }, [input, model])

  return { model, snapshot }
}

function ActivityRailActions({ model, snapshot }: { model: ActivityModel; snapshot: ActivitySnapshot }) {
  function markAllRead(): void {
    void model.markAllRead()
  }

  function clearCompleted(): void {
    void model.clearCompleted()
  }

  return (
    <ToolPanelTools>
      <IconButton label="Mark all read" title="Mark all read" disabled={!snapshot.threads.some((thread) => thread.unread)} onClick={markAllRead}>
        <ControlIcon name="check" />
      </IconButton>
      <IconButton
        label="Clear completed activity"
        title="Clear completed"
        variant="destructive"
        disabled={snapshot.loading || snapshot.error !== null || !snapshot.threads.some((thread) => thread.display === 'done' || thread.display === 'failed' || thread.display === 'interrupted')}
        onClick={clearCompleted}
      >
        <ControlIcon name="x" />
      </IconButton>
    </ToolPanelTools>
  )
}

function ActivityFilterForm({ model, view, showWorktreeField }: { model: ActivityModel; view: ActivityViewInput; showWorktreeField: boolean }) {
  const controlId = useId()
  const [draftText, setDraftText] = useState(() => view.text ?? '')
  const [draftWorktree, setDraftWorktree] = useState(() => view.worktree ?? '')
  useEffect(() => {
    setDraftText(view.text ?? '')
    setDraftWorktree(view.worktree ?? '')
  }, [view.text, view.worktree])

  function changeDraftText(event: ChangeEvent<HTMLInputElement>): void {
    setDraftText(event.currentTarget.value)
  }

  function changeDraftWorktree(event: ChangeEvent<HTMLInputElement>): void {
    setDraftWorktree(event.currentTarget.value)
  }

  function applyActivityFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    model.updateView({ text: draftText, worktree: draftWorktree })
  }

  function toggleUnreadOnly(event: ChangeEvent<HTMLInputElement>): void {
    model.updateView({ text: draftText, worktree: draftWorktree, unreadOnly: event.currentTarget.checked })
  }

  function changeActivityGroup(event: ChangeEvent<HTMLSelectElement>): void {
    model.updateView({ text: draftText, worktree: draftWorktree, group: event.currentTarget.value as GroupBy })
  }

  return (
    <form style={FILTERS_STYLE} onSubmit={applyActivityFilters}>
      <TextField
        id={`${controlId}-search`}
        label="Search Activity"
        aria-label="Search Activity"
        type="search"
        value={draftText}
        onChange={changeDraftText}
      />
      {showWorktreeField ? (
        <TextField
          id={`${controlId}-worktree`}
          label="Worktree ID"
          aria-label="Worktree ID"
          type="search"
          value={draftWorktree}
          onChange={changeDraftWorktree}
        />
      ) : null}
      <FormRow label="Unread only" htmlFor={`${controlId}-unread`}>
        <input
          id={`${controlId}-unread`}
          aria-label="Unread only"
          type="checkbox"
          checked={view.unreadOnly === true}
          style={{ accentColor: 'var(--ui-accent)' }}
          onChange={toggleUnreadOnly}
        />
      </FormRow>
      <FormRow label="Group by" htmlFor={`${controlId}-group`}>
        <select
          id={`${controlId}-group`}
          aria-label="Group Activity by"
          className="ui-text-field__input"
          style={{ appearance: 'auto' }}
          value={view.group}
          onChange={changeActivityGroup}
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
  )
}

function ActivityFeedList({ context, model, snapshot }: { context: UiPluginContext; model: ActivityModel; snapshot: ActivitySnapshot }) {
  function openActivityCard(thread: ActivityThread): void {
    void context.executeCommand('command:quirky.agent-status/openActivityThread', { sessionId: thread.sessionId, worktreeId: thread.worktreeId, turn: thread.turn })
      .catch((cause) => context.toast('Could not open Activity thread', errorMessage(cause)))
  }

  function markActivityRead(thread: ActivityThread): void {
    void model.markRead(thread)
  }

  function toggleChildAgents(thread: ActivityThread): void {
    model.toggleChildAgents(thread)
  }

  const groups = groupActivityThreads(snapshot.threads, snapshot.view.group)
  return (
    <div className="ui-stack">
      {groups.map((group) => (
        <section className="ui-stack" data-activity-group={group.key} key={group.key}>
          {snapshot.view.group !== 'none' ? <SectionHeader title={group.label} /> : null}
          <ul style={THREAD_LIST_STYLE}>
            {group.threads.map((thread) => {
              const isExpanded = snapshot.expanded[thread.sessionId] === true
              const status = statusForDisplay(thread.display)
              return (
                <li className="ui-stack" data-session-id={thread.sessionId} key={thread.sessionId}>
                  <InlineAgentCard
                    title={thread.sessionName}
                    status={status}
                    action={{ label: 'Open', onAction: () => openActivityCard(thread) }}
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
                    <Button disabled={!thread.unread} onClick={() => markActivityRead(thread)}>
                      {thread.unread ? 'Mark read' : 'Read'}
                    </Button>
                    {thread.children.length > 0 ? (
                      <Button
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} child agents for ${thread.sessionId}`}
                        aria-expanded={isExpanded}
                        onClick={() => toggleChildAgents(thread)}
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
  )
}
export function ActivitySidebarView({ context }: { context: UiPluginContext }) {
  const { model, snapshot } = useActivityModel(context, 'sidebar')
  const hasSidebarFilters = hasActivityFilters(snapshot.view)

  function retrySidebarActivity(): void {
    void model.retry()
  }

  return (
    <ToolPanelFrame title="Activity">
      <ActivityRailActions model={model} snapshot={snapshot} />
      <main style={EMBEDDED_PAGE_STYLE}>
        <ActivityFilterForm model={model} view={snapshot.view} showWorktreeField={false} />
        <div style={RESULTS_STYLE}>
          {snapshot.error ? <InlineError message={snapshot.error} action={{ label: 'Retry', onAction: retrySidebarActivity }} /> : null}
          {snapshot.loading && snapshot.threads.length === 0 ? <NoticeLine>Loading Activity…</NoticeLine> : null}
          {!snapshot.loading && !snapshot.error && snapshot.threads.length === 0 ? (
            <div role="status">
              <EmptyState message={hasSidebarFilters ? 'No Activity threads match these filters.' : 'No Activity threads yet.'} />
            </div>
          ) : null}
          <ActivityFeedList context={context} model={model} snapshot={snapshot} />
        </div>
      </main>
    </ToolPanelFrame>
  )
}

export function ActivityView({ context, input }: { context: UiPluginContext; input?: unknown }) {
  const { model, snapshot } = useActivityModel(context, 'center', input)
  const hasFilters = hasActivityFilters(snapshot.view)

  function retryCenterActivity(): void {
    void model.retry()
  }

  return (
    <ToolPanelFrame title="Activity">
      <ActivityRailActions model={model} snapshot={snapshot} />
      <main style={PAGE_STYLE}>
        <ActivityFilterForm model={model} view={snapshot.view} showWorktreeField />
        <div style={RESULTS_STYLE}>
          {snapshot.error ? <InlineError message={snapshot.error} action={{ label: 'Retry', onAction: retryCenterActivity }} /> : null}
          {snapshot.loading && snapshot.threads.length === 0 ? <EmptyState message="Loading Activity…" /> : null}
          {!snapshot.loading && !snapshot.error && snapshot.threads.length === 0 ? (
            <div role="status">
              <EmptyState message={hasFilters ? 'No Activity threads match these filters.' : 'No Activity threads yet.'} />
            </div>
          ) : null}
          <ActivityFeedList context={context} model={model} snapshot={snapshot} />
        </div>
      </main>
    </ToolPanelFrame>
  )
}

