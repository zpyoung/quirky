import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ActivityQuery, ActivityThread } from './activity-types'

const PLUGIN_ID = 'quirky.agent-status'
const GROUPS = ['status', 'worktree', 'provider', 'none'] as const
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

type ActivityGroup = { key: string; label: string; threads: ActivityThread[] }
export type GroupBy = (typeof GROUPS)[number]
export type ActivityViewInput = ActivityQuery & { group: GroupBy }
export type ActivitySnapshot = {
  view: ActivityViewInput
  threads: ActivityThread[]
  expanded: Record<string, boolean>
  loading: boolean
  error: string | null
}

export function activityViewInput(input: unknown): ActivityViewInput {
  const value = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const group: GroupBy = GROUPS.includes(value.group as GroupBy) ? value.group as GroupBy : 'status'
  const worktree = typeof value.worktree === 'string' ? value.worktree.trim() : ''
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  return {
    group,
    ...(worktree ? { worktree } : {}),
    ...(text ? { text } : {}),
    ...(typeof value.unreadOnly === 'boolean' ? { unreadOnly: value.unreadOnly } : {})
  }
}

export function activityQueryInput(input: ActivityViewInput): ActivityQuery {
  const worktree = input.worktree?.trim()
  const text = input.text?.trim()
  return {
    ...(worktree ? { worktree } : {}),
    ...(text ? { text } : {}),
    ...(input.unreadOnly === true ? { unreadOnly: true } : {})
  }
}

export function groupActivityThreads(threads: ActivityThread[], by: GroupBy): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  const grouped = new Map<string, ActivityGroup>()
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

export function hasActivityFilters(view: ActivityViewInput): boolean {
  return Boolean(view.text?.trim() || view.worktree?.trim() || view.unreadOnly)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function changedActivity(event: QuirkyEvent): boolean {
  return event.type === `${PLUGIN_ID}/changed` || event.type === `${PLUGIN_ID}/activityChanged`
}

function sameView(left: ActivityViewInput, right: ActivityViewInput): boolean {
  return left.group === right.group && left.worktree === right.worktree && left.text === right.text && left.unreadOnly === right.unreadOnly
}

/** Keeps Activity surfaces on the latest query without discarding threads during recoverable failures. */
export class ActivityModel {
  private view: ActivityViewInput
  private snapshot: ActivitySnapshot
  private readonly listeners = new Set<() => void>()
  private unsubscribeActivity: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private generation = 0
  private started = false

  constructor(
    private readonly context: UiPluginContext,
    private readonly options: { mode: 'sidebar' | 'center'; initialInput?: unknown }
  ) {
    this.view = activityViewInput(options.initialInput)
    this.snapshot = { view: this.view, threads: [], expanded: {}, loading: true, error: null }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ActivitySnapshot => this.snapshot

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribeActivity = this.context.subscribe((event) => {
      if (this.started && changedActivity(event)) void this.load()
    })
    this.unsubscribeConnection = this.context.onConnection((status) => {
      if (this.started && status === 'connected') void this.load()
    })
    void this.load()
  }

  dispose(): void {
    this.started = false
    this.generation += 1
    this.unsubscribeActivity?.()
    this.unsubscribeConnection?.()
    this.unsubscribeActivity = null
    this.unsubscribeConnection = null
  }

  syncInput(input: unknown): void {
    const next = activityViewInput(input)
    if (sameView(this.view, next)) return
    this.view = next
    this.publish({ view: next })
    void this.load(next)
  }

  async load(nextView?: ActivityViewInput): Promise<void> {
    const target = nextView === undefined ? this.view : activityViewInput(nextView)
    if (!sameView(this.view, target)) {
      this.view = target
      this.publish({ view: target })
    }
    const current = ++this.generation
    this.publish({ loading: true, error: null })
    try {
      const result = await this.context.call('quirky.agent-status/activity', activityQueryInput(target)) as { threads: ActivityThread[] }
      if (current !== this.generation) return
      this.publish({ threads: result.threads })
    } catch (cause) {
      if (current !== this.generation) return
      this.publish({ error: errorMessage(cause) })
    } finally {
      if (current === this.generation) this.publish({ loading: false })
    }
  }

  retry(): Promise<void> {
    return this.load()
  }

  updateView(patch: Partial<ActivityViewInput>): void {
    const next = activityViewInput({ ...this.view, ...patch })
    this.view = next
    this.publish({ view: next })
    if (this.options.mode === 'center') this.context.openView('view:quirky.agent-status/activity', next)
    void this.load(next)
  }

  async markRead(thread: ActivityThread): Promise<void> {
    try {
      await this.context.call('quirky.agent-status/acknowledge', { session: thread.sessionId, turn: thread.turn })
      await this.load()
    } catch (cause) {
      this.publish({ error: errorMessage(cause) })
    }
  }

  async markAllRead(): Promise<void> {
    const observed = this.snapshot.threads.filter((thread) => thread.unread)
    try {
      await Promise.all(observed.map((thread) => this.context.call('quirky.agent-status/acknowledge', { session: thread.sessionId, turn: thread.turn })))
      await this.load()
    } catch (cause) {
      this.publish({ error: errorMessage(cause) })
    }
  }

  async clearCompleted(): Promise<void> {
    const worktree = this.view.worktree?.trim()
    try {
      await this.context.call('quirky.agent-status/clearCompleted', worktree ? { worktree } : {})
      await this.load()
    } catch (cause) {
      this.publish({ error: errorMessage(cause) })
    }
  }

  toggleChildAgents(thread: ActivityThread): void {
    const expanding = this.snapshot.expanded[thread.sessionId] !== true
    this.publish({ expanded: { ...this.snapshot.expanded, [thread.sessionId]: expanding } })
    if (expanding && thread.unread) void this.markRead(thread)
  }

  private publish(patch: Partial<ActivitySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}
