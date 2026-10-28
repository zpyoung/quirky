import type { Ask, AskAnswer, AskEnvelope, AskPartial, AskSpec, PluginStore } from '@quirky/protocol'
import { buildSummary, validateAnswerSubmission } from './src/core/answers'
import { validatePartial } from './src/core/partial'
import { formatSpecErrors, validateAskSpec } from './src/core/spec'
import { buildTimeoutResult } from './src/core/timeout'

/** Longest a single `wait` holds the connection. */
export const MAX_WAIT_MS = 60000

/** Largest epoch-ms value a `Date` represents; deadlines are clamped to it. */
const MAX_DEADLINE_MS = 8640000000000000

/** Largest delay `setTimeout` honours; longer deadlines re-arm in steps of this size. */
const MAX_TIMER_DELAY_MS = 2147483647
/** Maximum number of concurrent pending `wait` calls in one AskService. */
export const MAX_WAIT_CONCURRENCY = 4

/** Builds InvalidParams, NotFound, Conflict, and typed busy-conflict errors for the RPC layer. */
export type AskErrors = {
  invalidParams(message: string): Error
  notFound(message: string): Error
  conflict(message: string): Error
  busy(message: string): Error
}

/** The time source of an `AskService`; tests substitute one they can move by hand. */
export type AskClock = {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: AskClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

type AskRow = {
  id: string
  spec: string
  session_id: string | null
  worktree_id: string | null
  created_at: number
  status: AskEnvelope['status']
  answers: string
  skipped: string
  partial: string
  expires_at: number | null
  summary: string
  seq: number
  created_seq: number
  owner_plugin_id: string | null
}

function toAsk(row: AskRow, queued: boolean): Ask {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as AskSpec,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
    envelope: {
      status: row.status,
      askId: row.id,
      answers: JSON.parse(row.answers),
      skipped: JSON.parse(row.skipped),
      summary: row.summary
    },
    seq: row.seq,
    queued,
    partial: JSON.parse(row.partial) as AskPartial,
    expiresAt: row.expires_at
  }
}

/**
 * What an `AskService` tells the rest of the daemon, each call carrying the `seq` the change was
 * stamped with. `surfaced` fires only when a queued ask becomes its session's live question; an ask
 * that is live from the start is announced through `created`.
 */
export type AskServiceHooks = {
  created(ask: Ask, seq: number): void
  surfaced(ask: Ask, seq: number): void
  updated(askId: string, partial: AskPartial, seq: number): void
  resolved(askId: string, envelope: AskEnvelope, seq: number): void
}

type Waiter = { resolve(envelope: AskEnvelope): void; reject(error: Error): void; timer: unknown }

/**
 * Asks persisted in the plugin's store, with long-poll waiters and deadline timers held in memory.
 * Every change takes the next value of the store-wide `seq` counter inside the same transaction as
 * its row change, so a window can order events and a promoted ask never reuses an old value.
 */
export class AskService {
  private readonly waiters = new Map<string, Set<Waiter>>()
  private readonly deadlines = new Map<string, unknown>()
  private activeWaits = 0
  private stopped = false

  constructor(
    private readonly store: PluginStore,
    private readonly errors: AskErrors,
    private readonly hooks: AskServiceHooks,
    private readonly clock: AskClock = systemClock
  ) {}

  /**
   * Stores a pending ask for a spec and arms its deadline. `created` always fires first, with the
   * ask as stored; a deadline already passed resolves it afterwards. `checkCredentialText` is false
   * for asks a plugin registers on the person's behalf, whose wording the plugin doesn't control.
   */
  create(
    specInput: unknown,
    sessionId: string | null,
    worktreeId: string | null,
    options: { timeoutMs?: number; checkCredentialText: boolean; ownerPluginId?: string }
  ): Ask {
    const checked = validateAskSpec(specInput, { checkCredentialText: options.checkCredentialText })
    if (!checked.ok) throw this.errors.invalidParams(formatSpecErrors(checked.errors))
    const { timeoutMs } = options
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      throw this.errors.invalidParams('timeoutMs must be an integer of at least 1')
    }
    const id = `ask_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    const createdAt = this.clock.now()
    const expiresAt = timeoutMs === undefined ? null : Math.min(createdAt + timeoutMs, MAX_DEADLINE_MS)
    const seq = this.store.transaction(() => {
      const next = this.nextSeq()
      this.store.run(
        `INSERT INTO asks (id, spec, session_id, worktree_id, created_at, status, answers, skipped, partial, expires_at, summary, seq, created_seq, owner_plugin_id)
         VALUES (?, ?, ?, ?, ?, 'pending', '{}', '[]', '{}', ?, '', ?, ?, ?)`,
        id,
        JSON.stringify(checked.spec),
        sessionId,
        worktreeId,
        createdAt,
        expiresAt,
        next,
        next,
        options.ownerPluginId ?? null
      )
      return next
    })
    this.armDeadline(id, expiresAt)
    const row = this.store.get<AskRow>('SELECT * FROM asks WHERE id = ?', id)!
    this.hooks.created(toAsk(row, this.isQueued(row)), seq)
    return this.get(id)
  }

  /** The ask with its deadline applied; NotFound for an unknown ID. */
  get(askId: string): Ask {
    const row = this.settle(askId)
    return toAsk(row, this.isQueued(row))
  }

  /** Every ask in creation order, optionally only those still pending. */
  list(pendingOnly: boolean): Ask[] {
    this.settleOverdue(true)
    const rows = this.store.all<AskRow>(
      pendingOnly ? "SELECT * FROM asks WHERE status = 'pending' ORDER BY created_seq, id" : 'SELECT * FROM asks ORDER BY created_seq, id'
    )
    return rows.map((row) => toAsk(row, this.isQueued(row)))
  }

  /**
   * Resolves when the ask becomes terminal, or returns it still pending after `timeoutMs`; at most
   * four waits run concurrently. Shutdown or caller disconnect rejects and releases the slot
   * without reading a store the host is about to close or resolving the ask.
   */
  async wait(askId: string, timeoutMs = MAX_WAIT_MS, signal?: AbortSignal): Promise<AskEnvelope> {
    if (this.stopped) throw new Error('quirky.ask has shut down')
    const ask = this.get(askId)
    if (signal?.aborted) throw new Error('ask wait connection closed')
    const limit = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS))
    if (ask.envelope.status !== 'pending' || limit === 0) return ask.envelope
    if (this.activeWaits >= MAX_WAIT_CONCURRENCY) throw this.errors.busy('ask wait capacity is busy')
    const { promise, resolve, reject } = Promise.withResolvers<AskEnvelope>()
    this.activeWaits++
    let released = false
    let abortListener: (() => void) | undefined
    const release = () => {
      if (released) return false
      released = true
      this.activeWaits--
      return true
    }
    const removeAbortListener = () => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
    const waiter: Waiter = {
      resolve: (envelope) => {
        if (!release()) return
        this.clock.clearTimeout(waiter.timer)
        removeAbortListener()
        resolve(envelope)
      },
      reject: (error) => {
        if (!release()) return
        this.clock.clearTimeout(waiter.timer)
        removeAbortListener()
        reject(error)
      },
      timer: undefined
    }
    try {
      waiter.timer = this.clock.setTimeout(() => {
        this.removeWaiter(askId, waiter)
        try {
          waiter.resolve(this.get(askId).envelope)
        } catch (error) {
          waiter.reject(error as Error)
        }
      }, limit)
      this.addWaiter(askId, waiter)
      if (signal) {
        abortListener = () => {
          this.removeWaiter(askId, waiter)
          waiter.reject(new Error('ask wait connection closed'))
        }
        if (signal.aborted) abortListener()
        else signal.addEventListener('abort', abortListener, { once: true })
      }
    } catch (error) {
      this.removeWaiter(askId, waiter)
      waiter.reject(error as Error)
    }
    return promise
  }

  /** Clears every timer and rejects each pending waiter; call before the store closes. */
  shutdown(): void {
    this.stopped = true
    for (const handle of this.deadlines.values()) this.clock.clearTimeout(handle)
    this.deadlines.clear()
    const pending = [...this.waiters.values()].flatMap((set) => [...set])
    this.waiters.clear()
    for (const waiter of pending) waiter.reject(new Error('quirky.ask shut down while the wait was pending'))
  }

  /**
   * Arms every pending deadline and resolves the ones that passed while nothing was running,
   * without surfacing or announcing an overdue ask; call once after construction.
   */
  start(): void {
    this.sweep()
    const rows = this.store.all<AskRow>("SELECT * FROM asks WHERE status = 'pending' AND expires_at IS NOT NULL")
    for (const row of rows) this.armDeadline(row.id, row.expires_at)
  }

  /**
   * Resolves every overdue pending ask, oldest first and without promoting, then promotes each
   * session whose live question was among them. A queued ask that is overdue is therefore timed
   * out before it could ever be surfaced.
   */
  sweep(): void {
    if (this.stopped) return
    const sessions = this.settleOverdue(false)
    for (const sessionId of sessions) this.promote(sessionId)
  }

  /** Validates and records an answer; NotFound, Conflict when finished, InvalidParams when refused. */
  answer(askId: string, answersInput: unknown, skippedInput: unknown): AskEnvelope {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') throw this.errors.conflict(`ask ${askId} is already ${ask.envelope.status}`)
    const checked = validateAnswerSubmission(ask.spec, answersInput, skippedInput)
    if (!checked.ok) throw this.errors.invalidParams(checked.message)
    return this.resolve(ask, {
      status: checked.skipped.length > 0 ? 'partial' : 'answered',
      answers: checked.answers,
      skipped: checked.skipped,
      summary: buildSummary(ask.spec, checked.answers)
    })
  }

  /** Declines a pending ask; an ask that already finished is returned unchanged. */
  cancel(askId: string): AskEnvelope {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') return ask.envelope
    return this.resolve(ask, { status: 'declined', answers: {}, skipped: [], summary: '' })
  }

  /** Declines pending asks created by plugins whose owners are no longer active. */
  cancelOwnedByInactivePlugins(activePluginIds: ReadonlySet<string>): void {
    this.cancelPendingOwned((ownerPluginId) => ownerPluginId !== null && !activePluginIds.has(ownerPluginId))
  }

  /** Declines every pending plugin-owned ask during service shutdown or crash recovery. */
  cancelPluginOwned(): void {
    this.cancelPendingOwned((ownerPluginId) => ownerPluginId !== null)
  }

  private cancelPendingOwned(shouldCancel: (ownerPluginId: string | null) => boolean): void {
    if (this.stopped) return
    const rows = this.store.all<{ id: string; owner_plugin_id: string | null }>(
      "SELECT id, owner_plugin_id FROM asks WHERE status = 'pending' AND owner_plugin_id IS NOT NULL ORDER BY created_seq"
    )
    for (const row of rows) {
      if (shouldCancel(row.owner_plugin_id)) this.cancel(row.id)
    }
  }

  /** Times a pending ask out now, exactly as its deadline would; a finished ask is returned unchanged. */
  expire(askId: string): AskEnvelope {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') return ask.envelope
    return this.timeOut(ask, true)
  }

  /** Replaces a pending ask's draft; `ok` is false for an ask that already finished. */
  updatePartial(askId: string, partialInput: unknown): { ok: boolean } {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') return { ok: false }
    const checked = validatePartial(ask.spec, partialInput)
    if (!checked.ok) throw this.errors.invalidParams(checked.message)
    const seq = this.store.transaction(() => {
      const next = this.nextSeq()
      this.store.run("UPDATE asks SET partial = ?, seq = ? WHERE id = ? AND status = 'pending'", JSON.stringify(checked.partial), next, askId)
      return next
    })
    this.hooks.updated(askId, checked.partial, seq)
    return { ok: true }
  }

  private nextSeq(): number {
    this.store.run('UPDATE ask_seq SET value = value + 1 WHERE id = 1')
    return this.store.get<{ value: number }>('SELECT value FROM ask_seq WHERE id = 1')!.value
  }

  private overdue(row: AskRow): boolean {
    return row.status === 'pending' && row.expires_at !== null && row.expires_at <= this.clock.now()
  }

  private isQueued(row: AskRow): boolean {
    if (row.status !== 'pending' || row.session_id === null) return false
    return (
      this.store.get(
        "SELECT 1 FROM asks WHERE status = 'pending' AND session_id = ? AND created_seq < ? LIMIT 1",
        row.session_id,
        row.created_seq
      ) !== null
    )
  }

  /** The row for an ask, after timing it out if its deadline has passed. */
  private settle(askId: string): AskRow {
    const row = this.store.get<AskRow>('SELECT * FROM asks WHERE id = ?', askId)
    if (!row) throw this.errors.notFound(`no such ask: ${askId}`)
    if (!this.overdue(row)) return row
    this.timeOut(toAsk(row, this.isQueued(row)), true)
    return this.store.get<AskRow>('SELECT * FROM asks WHERE id = ?', askId)!
  }

  /**
   * Times out every overdue pending ask, oldest first, re-reading each so one already timed out by
   * a promotion is not resolved twice. Returns the sessions whose live question was resolved,
   * which the caller promotes when it asked for `promote: false`.
   */
  private settleOverdue(promote: boolean): Set<string> {
    const sessions = new Set<string>()
    const candidates = this.store.all<{ id: string }>(
      "SELECT id FROM asks WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY created_seq",
      this.clock.now()
    )
    for (const { id } of candidates) {
      const row = this.store.get<AskRow>('SELECT * FROM asks WHERE id = ?', id)
      if (!row || !this.overdue(row)) continue
      const queued = this.isQueued(row)
      this.timeOut(toAsk(row, queued), promote)
      if (!promote && !queued && row.session_id !== null) sessions.add(row.session_id)
    }
    return sessions
  }

  private timeOut(ask: Ask, promote: boolean): AskEnvelope {
    const result = buildTimeoutResult(ask.spec, ask.partial)
    return this.resolve(ask, { status: 'timed_out', ...result }, promote)
  }

  private resolve(
    ask: Ask,
    outcome: Pick<AskEnvelope, 'status' | 'answers' | 'skipped' | 'summary'>,
    promote = true
  ): AskEnvelope {
    const envelope: AskEnvelope = { ...outcome, askId: ask.id }
    const wasLive = ask.sessionId !== null && !ask.queued
    const seq = this.store.transaction(() => {
      const next = this.nextSeq()
      this.store.run(
        "UPDATE asks SET status = ?, answers = ?, skipped = ?, summary = ?, seq = ? WHERE id = ? AND status = 'pending'",
        envelope.status,
        JSON.stringify(envelope.answers),
        JSON.stringify(envelope.skipped),
        envelope.summary,
        next,
        ask.id
      )
      return next
    })
    this.disarmDeadline(ask.id)
    this.hooks.resolved(ask.id, envelope, seq)
    const waiting = this.waiters.get(ask.id)
    this.waiters.delete(ask.id)
    for (const waiter of waiting ?? []) waiter.resolve(envelope)
    if (promote && wasLive) this.promote(ask.sessionId!)
    return envelope
  }

  /** Surfaces the session's earliest pending ask under a fresh `seq`, timing out any overdue ones first. */
  private promote(sessionId: string): void {
    for (;;) {
      const row = this.store.get<AskRow>(
        "SELECT * FROM asks WHERE status = 'pending' AND session_id = ? ORDER BY created_seq LIMIT 1",
        sessionId
      )
      if (!row) return
      if (this.overdue(row)) {
        this.timeOut(toAsk(row, false), false)
        continue
      }
      const surfaced = this.store.transaction(() => {
        if (this.overdue(row)) return null
        const next = this.nextSeq()
        this.store.run("UPDATE asks SET seq = ? WHERE id = ? AND status = 'pending'", next, row.id)
        return { ask: toAsk({ ...row, seq: next }, false), seq: next }
      })
      if (!surfaced) continue
      this.hooks.surfaced(surfaced.ask, surfaced.seq)
      return
    }
  }

  private armDeadline(askId: string, expiresAt: number | null): void {
    this.disarmDeadline(askId)
    if (expiresAt === null || this.stopped) return
    const remaining = Math.max(0, expiresAt - this.clock.now())
    const handle = this.clock.setTimeout(() => this.fireDeadline(askId, expiresAt), Math.min(remaining, MAX_TIMER_DELAY_MS))
    this.deadlines.set(askId, handle)
  }

  private fireDeadline(askId: string, expiresAt: number): void {
    this.deadlines.delete(askId)
    if (this.stopped) return
    if (expiresAt > this.clock.now()) {
      this.armDeadline(askId, expiresAt)
      return
    }
    try {
      this.settle(askId)
    } catch {
      // the host may close the store between the timer firing and this read
    }
  }

  private disarmDeadline(askId: string): void {
    const handle = this.deadlines.get(askId)
    if (handle === undefined) return
    this.clock.clearTimeout(handle)
    this.deadlines.delete(askId)
  }

  private addWaiter(askId: string, waiter: Waiter): void {
    const set = this.waiters.get(askId) ?? new Set()
    set.add(waiter)
    this.waiters.set(askId, set)
  }

  private removeWaiter(askId: string, waiter: Waiter): void {
    const set = this.waiters.get(askId)
    set?.delete(waiter)
    if (set?.size === 0) this.waiters.delete(askId)
  }
}
