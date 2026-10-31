import { randomUUID } from 'node:crypto'
import type { PluginContext, Session } from '@quirky/protocol'
import type { ActivityAcknowledgment, ActivityQuery, ActivityThread } from './activity-types'
import { displayOf } from './model'
import { ActivityStore, type StoredActivity } from './store'
import type { AgentDisplayState, AgentRow } from './types'

const ATTENTION_ORDER: Record<AgentDisplayState, number> = {
  waiting: 0,
  blocked: 1,
  permission: 2,
  failed: 3,
  unconfirmed: 4,
  working: 5,
  monitoring: 6,
  interrupted: 7,
  unverifiable: 8,
  done: 9,
  idle: 10
}

const COMPLETED: Partial<Record<AgentDisplayState, true>> = { done: true, failed: true, interrupted: true }

/** Derives Activity display from the retained row, marking a vanished live row interrupted. */
function displayOfSnapshot(snapshot: StoredActivity, now: number) {
  const row: AgentRow = !snapshot.live && snapshot.row.state !== 'done' ? { ...snapshot.row, state: 'done', interrupted: true } : snapshot.row
  return displayOf(row, now, snapshot.live)
}

/** Retains the latest status snapshot per terminal session, independently of its live status row. */
export class ActivityFeed {
  constructor(
    private readonly context: PluginContext,
    private readonly store: ActivityStore,
    private readonly now: () => number = Date.now
  ) {}

  /** Preserves receipts on ordinary updates; new turns use UUIDs because they can share a millisecond. */
  sync(session: Session, row: AgentRow | null, startsTurn = false): void {
    const previous = this.store.get(session.id)
    if (row === null) {
      if (previous) this.store.put(this.sessionSnapshot(previous, session))
      return
    }

    const turnChanged =
      previous === null ||
      startsTurn ||
      previous.agent !== row.agent ||
      (previous.row.turnStartedAt !== row.turnStartedAt && (previous.row.turnStartedAt !== null || row.turnStartedAt !== null))
    const next: StoredActivity = {
      sessionId: session.id,
      worktreeId: session.worktreeId,
      worktreeName: previous?.worktreeName || session.worktreeId,
      sessionName: session.name || session.title || session.id,
      agent: row.agent,
      turn: turnChanged ? randomUUID() : (previous?.turn ?? randomUUID()),
      turnStartedAt: turnChanged ? (row.turnStartedAt ?? this.now()) : (previous?.turnStartedAt ?? row.turnStartedAt ?? this.now()),
      updatedAt: this.now(),
      row,
      acknowledged: turnChanged ? false : (previous?.acknowledged ?? false),
      cleared: turnChanged ? false : (previous?.cleared ?? false),
      live: session.status !== 'exited'
    }
    this.store.put(next)
  }

  /** Imports an old row when its session record is already gone, or retains an existing snapshot. */
  importRow(row: AgentRow, updatedAt: number): void {
    const previous = this.store.get(row.sessionId)
    const turnChanged =
      previous === null ||
      previous.agent !== row.agent ||
      (previous.row.turnStartedAt !== row.turnStartedAt && (previous.row.turnStartedAt !== null || row.turnStartedAt !== null))
    this.store.put({
      sessionId: row.sessionId,
      worktreeId: previous?.worktreeId ?? '',
      worktreeName: previous?.worktreeName ?? '',
      sessionName: previous?.sessionName ?? row.sessionId,
      agent: row.agent,
      turn: turnChanged ? randomUUID() : (previous?.turn ?? randomUUID()),
      turnStartedAt: turnChanged ? (row.turnStartedAt ?? updatedAt) : (previous?.turnStartedAt ?? row.turnStartedAt ?? updatedAt),
      updatedAt,
      row,
      acknowledged: turnChanged ? false : (previous?.acknowledged ?? false),
      cleared: turnChanged ? false : (previous?.cleared ?? false),
      live: false
    })
  }

  /** Keeps snapshots current during startup and marks sessions that disappeared while the daemon was down. */
  async hydrate(rowFor: (sessionId: string) => AgentRow | null): Promise<void> {
    const sessions = (await this.context.call('quirky.session/list')) as Session[]
    const byId = new Map(sessions.map((session) => [session.id, session]))
    for (const snapshot of this.store.all()) {
      const session = byId.get(snapshot.sessionId)
      if (!session || session.kind !== 'terminal' || session.status === 'exited') {
        this.retire(snapshot.sessionId)
        continue
      }
      this.sync(session, rowFor(session.id))
    }
  }

  /** Queries retained snapshots with the same filters and ordering used by Activity views. */
  async query(query: ActivityQuery = {}): Promise<{ threads: ActivityThread[] }> {
    const worktreeSnapshots = this.store.all()
    const worktreeIds: string[] = []
    for (const snapshot of worktreeSnapshots) worktreeIds.push(snapshot.worktreeId)
    const worktreeNames = await this.resolveWorktreeNames(worktreeIds)
    const sessions = (await this.context.call('quirky.session/list')) as Session[]
    const byId = new Map<string, Session>()
    for (const session of sessions) byId.set(session.id, session)
    const snapshots = this.store.all()
    const text = query.text?.trim().toLowerCase() ?? ''
    const threads: ActivityThread[] = []

    for (const snapshot of snapshots) {
      const session = byId.get(snapshot.sessionId)
      const current = this.refreshMetadata(snapshot, session, worktreeNames)
      if (current.cleared || (query.worktree !== undefined && current.worktreeId !== query.worktree)) continue
      const { display, label, detail } = displayOfSnapshot(current, this.now())
      const unread = !current.acknowledged && !(current.row.sessionBoundary === true && display === 'idle')
      if (query.unreadOnly && !unread) continue

      const thread: ActivityThread = {
        sessionId: current.sessionId,
        worktreeId: current.worktreeId,
        worktreeName: current.worktreeName,
        sessionName: current.sessionName,
        agent: current.agent,
        turn: current.turn,
        turnStartedAt: current.turnStartedAt,
        updatedAt: current.updatedAt,
        display,
        label,
        prompt: current.row.prompt,
        detail,
        children: current.row.children,
        unread,
        live: current.live
      }
      if (
        text &&
        !(
          thread.sessionId.toLowerCase().includes(text) ||
          thread.worktreeId.toLowerCase().includes(text) ||
          thread.worktreeName.toLowerCase().includes(text) ||
          thread.sessionName.toLowerCase().includes(text) ||
          thread.agent.toLowerCase().includes(text) ||
          thread.prompt.toLowerCase().includes(text) ||
          thread.detail.toLowerCase().includes(text)
        )
      ) continue
      threads.push(thread)
    }

    threads.sort((left, right) => {
      const attention = ATTENTION_ORDER[left.display] - ATTENTION_ORDER[right.display]
      if (attention !== 0) return attention
      const newestTurn = right.turnStartedAt - left.turnStartedAt
      if (newestTurn !== 0) return newestTurn
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    })
    return { threads }
  }

  /** A receipt applies only to the currently stored turn; old tokens are harmless no-ops. */
  acknowledge(params: ActivityAcknowledgment): { acknowledged: number } {
    const candidates = params.all === true ? this.store.all() : params.session ? [this.store.get(params.session)].filter((row): row is StoredActivity => row !== null) : []
    const sessionIds: string[] = []
    for (const snapshot of candidates) {
      if (snapshot.cleared || snapshot.acknowledged || (params.turn !== undefined && snapshot.turn !== params.turn)) continue
      this.store.put({ ...snapshot, acknowledged: true })
      sessionIds.push(snapshot.sessionId)
    }
    if (sessionIds.length > 0) this.context.emit('activityChanged', { sessionIds })
    return { acknowledged: sessionIds.length }
  }

  /** Hides completed or interrupted Activity entries without deleting sessions, status rows, transcripts or receipts. */
  clearCompleted(worktree?: string): { cleared: number } {
    const sessionIds: string[] = []
    for (const snapshot of this.store.all()) {
      if (snapshot.cleared || (worktree !== undefined && snapshot.worktreeId !== worktree)) continue
      const { display } = displayOfSnapshot(snapshot, this.now())
      if (!COMPLETED[display]) continue
      this.store.put({ ...snapshot, cleared: true })
      sessionIds.push(snapshot.sessionId)
    }
    if (sessionIds.length > 0) this.context.emit('activityChanged', { sessionIds })
    return { cleared: sessionIds.length }
  }

  /** Retains a final snapshot when the terminal session exits or is removed. */
  retire(sessionId: string): void {
    const snapshot = this.store.get(sessionId)
    if (snapshot && snapshot.live) this.store.put({ ...snapshot, live: false })
  }

  private sessionSnapshot(snapshot: StoredActivity, session: Session): StoredActivity {
    return {
      ...snapshot,
      worktreeId: session.worktreeId,
      sessionName: session.name || session.title || session.id,
      live: session.status !== 'exited',
    }
  }

  private refreshMetadata(snapshot: StoredActivity, session: Session | undefined, worktreeNames: Map<string, string>): StoredActivity {
    const stored = this.store.get(snapshot.sessionId) ?? snapshot
    const currentSession = session?.kind === 'terminal' ? session : undefined
    const worktreeId = currentSession?.worktreeId ?? stored.worktreeId
    const next: StoredActivity = {
      ...stored,
      worktreeId,
      worktreeName: worktreeNames.get(worktreeId) ?? (worktreeId === stored.worktreeId ? stored.worktreeName : worktreeId),
      sessionName: currentSession ? currentSession.name || currentSession.title || currentSession.id : stored.sessionName,
      live: currentSession !== undefined && currentSession.status !== 'exited'
    }
    if (
      next.worktreeId !== stored.worktreeId ||
      next.worktreeName !== stored.worktreeName ||
      next.sessionName !== stored.sessionName ||
      next.live !== stored.live
    ) {
      this.store.put(next)
    }
    return next
  }

  private async resolveWorktreeNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id) => id !== ''))]
    const resolved = await Promise.all(
      unique.map(async (id): Promise<[string, string] | null> => {
        try {
          const worktree = (await this.context.call('quirky.worktree/resolve', { selector: `id:${id}` })) as { id?: unknown; name?: unknown }
          return worktree.id === id && typeof worktree.name === 'string' ? [id, worktree.name] : null
        } catch {
          return null
        }
      })
    )
    return new Map(resolved.filter((entry): entry is [string, string] => entry !== null))
  }
}
