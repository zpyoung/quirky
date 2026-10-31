import { RpcErrorCode, type AgentDisplayState, type AgentKind, type QuirkyEvent, type Session, type UiPluginContext, type Worktree } from '@quirky/protocol'
import { displayStatus, windowDisplay, type DisplayStatus } from './status'

export const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'

/** What the view shows to `ui.state`: the worktree's tabs and the active one. `display` and `label` are present for a tab drawn from an agent-status summary. */
export type SessionViewReport = {
  worktree: string
  tabs: { session: string; title: string; agent: AgentKind; status: DisplayStatus; display?: AgentDisplayState; label?: string }[]
  active: string | null
  /** The sessions on screen, which the notifications plugin treats as viewed: the active tab, or none. */
  visibleSessions: string[]
}

export type ViewSnapshot = {
  /** `missing` when the worktree no longer resolves. */
  status: 'loading' | 'ready' | 'missing'
  worktree: Pick<Worktree, 'id' | 'name' | 'path'> | null
  sessions: Session[]
  active: Session | null
}

const lastActiveByWorktree = new Map<string, string>()

/** Forgets which session was last active in each worktree. */
export function resetSessionMemory(): void {
  lastActiveByWorktree.clear()
}

/**
 * The tab to show: the requested session when it exists, else the one last active in the
 * worktree, else the first.
 */
export function pickActive(sessions: Session[], requested: string | undefined, remembered: string | undefined): Session | null {
  const byId = (id: string | undefined) => (id === undefined ? undefined : sessions.find((session) => session.id === id))
  return byId(requested) ?? byId(remembered) ?? sessions[0] ?? null
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The sessions of one worktree as one mounted view shows them: loaded from the daemon, kept
 * current by session events, with the actions the tabs, the menu and the UI commands share.
 * The view ends it with `stop()`.
 */
export class WorktreeSessions {
  private snapshot: ViewSnapshot = { status: 'loading', worktree: null, sessions: [], active: null }
  private listeners = new Set<() => void>()
  private unsubscribes: (() => void)[] = []
  private requested: string | undefined
  private requestedSeen = false
  private published: string | undefined
  private loading = false
  private reloadAfter = false
  private queued: QuirkyEvent[] = []
  private stopped = false
  private wasReconnecting = false

  constructor(
    private readonly context: UiPluginContext,
    private readonly selector: string,
    requestedSession?: string
  ) {
    this.requested = requestedSession
  }

  /** Subscribes to events and connection changes and loads the worktree and its sessions. */
  start(): void {
    this.unsubscribes.push(
      this.context.subscribe((event) => this.onEvent(event)),
      this.context.onConnection((status) => {
        if (status === 'reconnecting') this.wasReconnecting = true
        else if (this.wasReconnecting) {
          this.wasReconnecting = false
          void this.load()
        }
      })
    )
    void this.load()
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    this.listeners.clear()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ViewSnapshot => this.snapshot

  report(): SessionViewReport {
    const { worktree, sessions, active } = this.snapshot
    return {
      worktree: worktree?.id ?? this.selector,
      tabs: sessions.map((session) => ({
        session: session.id,
        title: session.title,
        agent: session.agent,
        status: displayStatus(session.status),
        ...(session.agentStatus ? windowDisplay(session.agentStatus, Date.now(), session.status !== 'exited') : {})
      })),
      active: active?.id ?? null,
      visibleSessions: active ? [active.id] : []
    }
  }

  /** Opens the view on `session` (or, with none, on the worktree's default tab). */
  open(session?: string): void {
    const worktree = this.snapshot.worktree?.id ?? this.selector
    this.context.openView(WORKTREE_VIEW_ID, session === undefined ? { worktree } : { worktree, session })
  }

  /** Starts and opens a session; returns whether it succeeded, showing failures as a toast. */
  async create(agent: AgentKind, prompt: string, background: boolean): Promise<boolean> {
    const worktree = this.snapshot.worktree?.id ?? this.selector
    const text = prompt.trim()
    try {
      const session = (
        background
          ? await this.context.call('quirky.structured/create', { worktree, agent, prompt: text })
          : await this.context.call('quirky.session/create', { worktree, agent, ...(text === '' ? {} : { prompt: text }) })
      ) as Session
      this.open(session.id)
      return true
    } catch (error) {
      this.context.toast('Could not start session', messageOf(error))
      return false
    }
  }

  /** Closes `session` after a confirmation when its process is still running. */
  async close(session: Session): Promise<void> {
    if (session.status !== 'exited') {
      const ok = await this.context.confirm({
        title: 'Close session',
        body: `"${session.title}" is still running. Close it?`,
        confirmLabel: 'Close'
      })
      if (!ok) return
    }
    try {
      await this.context.call('quirky.session/close', { session: session.id })
    } catch (error) {
      this.context.toast('Could not close session', messageOf(error))
    }
  }

  /** The session at 1-based tab `index`, if there is one. */
  tab(index: number): Session | undefined {
    return Number.isInteger(index) ? this.snapshot.sessions[index - 1] : undefined
  }

  private async load(): Promise<void> {
    if (this.loading) {
      this.reloadAfter = true
      return
    }
    this.loading = true
    try {
      do {
        this.reloadAfter = false
        await this.loadOnce()
      } while (this.reloadAfter && !this.stopped)
    } finally {
      this.loading = false
    }
  }

  private async loadOnce(): Promise<void> {
    let worktree: Worktree
    let sessions: Session[]
    try {
      worktree = (await this.context.call('quirky.worktree/resolve', { selector: this.selector })) as Worktree
      sessions = (await this.context.call('quirky.session/list', { worktree: worktree.id })) as Session[]
    } catch (error) {
      if (this.stopped) return
      const gone = (error as { code?: unknown } | null)?.code === RpcErrorCode.NotFound
      this.queued = []
      if (gone) this.commit({ status: 'missing', worktree: null, sessions: [] })
      else this.context.toast('Could not load sessions', messageOf(error))
      return
    }
    if (this.stopped) return
    const byId = new Map(sessions.map((session) => [session.id, session]))
    for (const event of this.queued.splice(0)) this.applyToMap(byId, event, worktree.id)
    this.commit({
      status: 'ready',
      worktree: { id: worktree.id, name: worktree.name, path: worktree.path },
      sessions: [...byId.values()]
    })
  }

  private onEvent(event: QuirkyEvent): void {
    if (this.stopped) return
    if (event.type === 'quirky.worktree/changed') {
      void this.load()
      return
    }
    if (event.type !== 'quirky.session/changed' && event.type !== 'quirky.session/removed') return
    const worktree = this.snapshot.worktree
    if (this.loading || !worktree) {
      this.queued.push(event)
      return
    }
    const byId = new Map(this.snapshot.sessions.map((session) => [session.id, session]))
    if (this.applyToMap(byId, event, worktree.id)) this.commit({ sessions: [...byId.values()] })
  }

  private applyToMap(byId: Map<string, Session>, event: QuirkyEvent, worktreeId: string): boolean {
    const data = (event as { data?: unknown }).data as { session?: Session; sessionId?: string } | undefined
    if (event.type === 'quirky.session/changed' && data?.session) {
      if (data.session.worktreeId !== worktreeId) return false
      byId.set(data.session.id, data.session)
      return true
    }
    if (event.type === 'quirky.session/removed' && data?.sessionId !== undefined) return byId.delete(data.sessionId)
    return false
  }

  private commit(next: Partial<ViewSnapshot>): void {
    const previousActive = this.snapshot.active?.id
    const merged = { ...this.snapshot, ...next }
    const sessions = [...merged.sessions].sort((a, b) => a.createdAt - b.createdAt)
    const worktreeId = merged.worktree?.id
    const active = pickActive(sessions, this.requested, worktreeId === undefined ? undefined : lastActiveByWorktree.get(worktreeId))
    if (worktreeId !== undefined && active) lastActiveByWorktree.set(worktreeId, active.id)
    this.snapshot = { ...merged, sessions, active }
    this.syncDaemonLayout(previousActive)
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Keeps the daemon's view input, which every window shows, naming the active session: a tab
   * picked without one in the input, or the replacement for a session that is gone, is published
   * there.
   */
  private syncDaemonLayout(previousActive: string | undefined): void {
    const { status, sessions, active } = this.snapshot
    if (status !== 'ready') return
    if (this.requested !== undefined) {
      if (sessions.some((session) => session.id === this.requested)) {
        this.requestedSeen = true
        return
      }
      this.requested = undefined
      if (this.requestedSeen) this.open(active?.id)
      return
    }
    if (active === null) {
      const lostActive = previousActive !== undefined && !sessions.some((session) => session.id === previousActive)
      if (lostActive) this.open()
      return
    }
    if (active.id === this.published) return
    this.published = active.id
    this.open(active.id)
  }
}
