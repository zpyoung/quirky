import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { DashboardQuery, DashboardSnapshot } from './dashboard-types'

const PLUGIN_ID = 'quirky.agent-status'
const DASHBOARD_VIEW_ID = 'view:quirky.agent-status/dashboard'

export const WORKSPACE_STATUSES = [
  { value: 'todo', label: 'Todo' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'in-review', label: 'In review' },
  { value: 'done', label: 'Done' }
] as const

export const REVIEW_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'draft', label: 'Draft' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'no-review', label: 'No review' }
] as const

export type DashboardState = {
  view: DashboardQuery
  snapshot: DashboardSnapshot | null
  loading: boolean
  error: string | null
}

function sameView(left: DashboardQuery, right: DashboardQuery): boolean {
  return left.text === right.text &&
    left.project === right.project &&
    left.workspaceStatus === right.workspaceStatus &&
    left.reviewStatus === right.reviewStatus &&
    left.showIdle === right.showIdle
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function dashboardViewInput(input: unknown): DashboardQuery {
  const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {}
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

function activityChanged(event: QuirkyEvent): boolean {
  return event.type === `${PLUGIN_ID}/changed` || event.type === `${PLUGIN_ID}/activityChanged`
}

/** Keeps Dashboard results available while the latest query loads or recovers from a failure. */
export class DashboardModel {
  private view: DashboardQuery
  private state: DashboardState
  private readonly listeners = new Set<() => void>()
  private requestSequence = 0
  private started = false
  private disposed = false
  private unsubscribeEvents: (() => void) | undefined
  private unsubscribeConnection: (() => void) | undefined

  constructor(private readonly context: UiPluginContext, initialInput?: unknown) {
    this.view = dashboardViewInput(initialInput)
    this.state = { view: this.view, snapshot: null, loading: true, error: null }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): DashboardState => this.state

  start(): void {
    if (this.started) return
    this.started = true
    this.disposed = false
    this.unsubscribeEvents = this.context.subscribe((event) => {
      if (activityChanged(event) || event.type === 'quirky.worktree/changed' || event.type === 'quirky.hosting/reviewCacheChanged') {
        void this.load()
      }
    })
    this.unsubscribeConnection = this.context.onConnection((status) => {
      if (status === 'connected') void this.load()
    })
    void this.load()
  }

  dispose(): void {
    if (!this.started && this.disposed) return
    this.started = false
    this.disposed = true
    this.requestSequence += 1
    this.unsubscribeEvents?.()
    this.unsubscribeConnection?.()
    this.unsubscribeEvents = undefined
    this.unsubscribeConnection = undefined
  }

  syncInput(input: unknown): void {
    const next = dashboardViewInput(input)
    if (sameView(this.view, next)) return
    this.view = next
    void this.load(next)
  }

  async load(nextView: DashboardQuery = this.view): Promise<void> {
    if (this.disposed) return
    const sequence = ++this.requestSequence
    this.view = nextView
    this.publish({ view: nextView, loading: true, error: null })
    try {
      const snapshot = await this.context.call('quirky.agent-status/dashboard', nextView) as DashboardSnapshot
      if (this.disposed || sequence !== this.requestSequence) return
      this.publish({ snapshot, loading: false, error: null })
    } catch (cause) {
      if (this.disposed || sequence !== this.requestSequence) return
      this.publish({ loading: false, error: errorMessage(cause) })
    }
  }

  retry(): Promise<void> {
    return this.load()
  }

  updateView(patch: Partial<DashboardQuery>): void {
    const next = dashboardViewInput({ ...this.view, ...patch })
    this.view = next
    void this.load(next)
    this.context.openView(DASHBOARD_VIEW_ID, next)
  }

  clearFilters(): void {
    this.updateView({ text: undefined, project: undefined, workspaceStatus: undefined, reviewStatus: undefined })
  }

  private publish(patch: Partial<DashboardState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
