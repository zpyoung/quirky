import type { Ask, AskAnswer, AskEnvelope, AskPartial, AskRegistration, AskSpec, PluginSessionAuthority, PluginStore } from '@quirky/protocol'
import type { AskHandoffIdentity } from './runtime-types'
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
  reason: string | null
  seq: number
  created_seq: number
  owner_plugin_id: string | null
  request_id: string | null
  handoff_identity: string | null
  handoff_question_id: string | null
  owner_identity: string | null
}
type AskOwnerIdentity = Pick<PluginSessionAuthority, 'sessionId' | 'processIncarnation' | 'source'>
type AskOutcome = {
  status: AskEnvelope['status']
  answers: Record<string, AskAnswer>
  skipped: string[]
  summary: string
  reason?: string
}

function toAsk(row: AskRow, queued: boolean): Ask {
  const common = {
    askId: row.id,
    answers: JSON.parse(row.answers),
    skipped: JSON.parse(row.skipped),
    summary: row.summary
  }
  const envelope: AskEnvelope = row.status === 'unavailable'
    ? { ...common, status: 'unavailable', reason: row.reason ?? 'The exact asker session is no longer available.' }
    : { ...common, status: row.status }
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as AskSpec,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
    envelope,
    seq: row.seq,
    queued,
    ...(row.handoff_question_id === null ? {} : { handoff: true }),
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
    options: {
      timeoutMs?: number
      checkCredentialText: boolean
      ownerPluginId?: string
      requestId?: string
      handoffIdentity?: AskHandoffIdentity
      handoffQuestionId?: string
      ownerIdentity?: AskOwnerIdentity
    }
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
        `INSERT INTO asks
          (id, spec, session_id, worktree_id, created_at, status, answers, skipped, partial, expires_at, summary, seq, created_seq, owner_plugin_id, request_id, handoff_identity, handoff_question_id, owner_identity)
         VALUES (?, ?, ?, ?, ?, 'pending', '{}', '[]', '{}', ?, '', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        JSON.stringify(checked.spec),
        sessionId,
        worktreeId,
        createdAt,
        expiresAt,
        next,
        next,
        options.ownerPluginId ?? null,
        options.requestId ?? null,
        options.handoffIdentity === undefined ? null : JSON.stringify(options.handoffIdentity),
        options.handoffQuestionId ?? null,
        options.ownerIdentity === undefined ? null : JSON.stringify(options.ownerIdentity)
      )
      return next
    })
    this.armDeadline(id, expiresAt)
    const row = this.store.get<AskRow>('SELECT * FROM asks WHERE id = ?', id)!
    if (row.handoff_question_id === null) this.hooks.created(toAsk(row, this.isQueued(row)), seq)
    return this.get(id)
  }

  /** Returns a persisted registration only when its request, asker identity and spec still match. */
  registration(
    requestId: string,
    specInput: unknown,
    sessionId: string | null,
    worktreeId: string | null,
    ownerIdentity?: AskOwnerIdentity
  ): AskRegistration | null {
    if (requestId.trim() === '' || requestId.length > 256) {
      throw this.errors.invalidParams('requestId must be a non-empty string of at most 256 characters')
    }
    const checked = validateAskSpec(specInput, { checkCredentialText: true })
    if (!checked.ok) throw this.errors.invalidParams(formatSpecErrors(checked.errors))
    const row = this.store.get<AskRow>('SELECT * FROM asks WHERE request_id = ?', requestId)
    if (!row) return null
    const storedOwner = row.owner_identity === null ? undefined : JSON.parse(row.owner_identity) as AskOwnerIdentity
    const storedSessionId = storedOwner?.sessionId ?? row.session_id
    const sameOwner = ownerIdentity === undefined
      ? storedOwner === undefined
      : storedOwner?.sessionId === ownerIdentity.sessionId && storedOwner.processIncarnation === ownerIdentity.processIncarnation
    if (
      row.spec !== JSON.stringify(checked.spec) ||
      storedSessionId !== sessionId ||
      row.worktree_id !== worktreeId ||
      !sameOwner
    ) {
      throw this.errors.conflict(`requestId ${requestId} was already registered with different asker or question data`)
    }
    return { askId: row.id }
  }

  /** Durable Ask registration with an optional exact orchestration handoff. */
  register(
    specInput: unknown,
    sessionId: string | null,
    worktreeId: string | null,
    options: {
      requestId: string
      timeoutMs?: number
      ownerIdentity?: AskOwnerIdentity
      handoff?: { identity: AskHandoffIdentity; questionId: string }
    }
  ): AskRegistration {
    if (options.handoff && options.handoff.identity.sessionId !== sessionId) {
      throw this.errors.invalidParams('handoff session identity does not match the registered asker')
    }
    const existing = this.registration(options.requestId, specInput, sessionId, worktreeId, options.ownerIdentity)
    if (existing) return existing
    try {
      const ask = this.create(specInput, sessionId, worktreeId, {
        requestId: options.requestId,
        checkCredentialText: true,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.ownerIdentity === undefined ? {} : { ownerIdentity: options.ownerIdentity }),
        ...(options.handoff === undefined ? {} : {
          handoffIdentity: options.handoff.identity,
          handoffQuestionId: options.handoff.questionId
        })
      })
      return { askId: ask.id }
    } catch (error) {
      const concurrent = this.registration(options.requestId, specInput, sessionId, worktreeId, options.ownerIdentity)
      if (concurrent) return concurrent
      throw error
    }
  }


  /** Exact session identities for pending client-owned asks; plugin-owned asks have no session authority. */
  pendingOwners(sessionId: string): { askId: string; identity: AskOwnerIdentity }[] {
    return this.store.all<{ id: string; owner_identity: string }>(
      "SELECT id, owner_identity FROM asks WHERE status = 'pending' AND owner_identity IS NOT NULL ORDER BY created_seq"
    ).flatMap((row) => {
      const identity = JSON.parse(row.owner_identity) as AskOwnerIdentity
      return identity.sessionId === sessionId ? [{ askId: row.id, identity }] : []
    })
  }

  /** Session IDs with a pending client-owned Ask, including handoffs hidden from the Questions panel. */
  pendingOwnerSessions(): string[] {
    const owners = this.store.all<{ owner_identity: string }>(
      "SELECT owner_identity FROM asks WHERE status = 'pending' AND owner_identity IS NOT NULL"
    )
    return [...new Set(owners.map((row) => (JSON.parse(row.owner_identity) as AskOwnerIdentity).sessionId))]
  }


  /** The durable handoff marker, or null for a local Ask. */
  handoff(askId: string): { identity: AskHandoffIdentity; questionId: string } | null {
    const row = this.store.get<Pick<AskRow, 'handoff_identity' | 'handoff_question_id'>>(
      'SELECT handoff_identity, handoff_question_id FROM asks WHERE id = ?',
      askId
    )
    if (!row || row.handoff_identity === null || row.handoff_question_id === null) return null
    const identity = JSON.parse(row.handoff_identity) as AskHandoffIdentity
    return { identity, questionId: row.handoff_question_id }
  }

  /** The ask with its deadline applied; NotFound for an unknown ID. */
  get(askId: string): Ask {
    const row = this.settle(askId)
    return toAsk(row, this.isQueued(row))
  }

  /** Every local Ask in creation order; coordinator handoffs are available only to their exact waiter. */
  list(pendingOnly: boolean, includeHandoff = false): Ask[] {
    this.settleOverdue(true)
    const handoffFilter = includeHandoff ? '' : ' AND handoff_question_id IS NULL'
    const rows = this.store.all<AskRow>(
      pendingOnly
        ? `SELECT * FROM asks WHERE status = 'pending'${handoffFilter} ORDER BY created_seq, id`
        : `SELECT * FROM asks WHERE 1 = 1${handoffFilter} ORDER BY created_seq, id`
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

  /** Runs one bounded orchestration wait under the same four-wait capacity gate as local asks. */
  async waitHandoff(
    askId: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    poll: (handoff: { identity: AskHandoffIdentity; questionId: string }, timeoutMs: number) => Promise<AskEnvelope>
  ): Promise<AskEnvelope> {
    if (this.stopped) throw new Error('quirky.ask has shut down')
    const ask = this.get(askId)
    if (signal?.aborted) throw new Error('ask wait connection closed')
    const handoff = this.handoff(askId)
    if (!handoff) throw this.errors.conflict(`ask ${askId} has no orchestration handoff`)
    const limit = Math.max(0, Math.min(timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS))
    if (ask.envelope.status !== 'pending' || limit === 0) return ask.envelope
    if (this.activeWaits >= MAX_WAIT_CONCURRENCY) throw this.errors.busy('ask wait capacity is busy')
    this.activeWaits++
    try {
      return await poll(handoff, limit)
    } finally {
      this.activeWaits--
    }
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

  /** A coordinator's explicit non-answer is partial, not an invalid card submit or implied consent. */
  answerHandoff(askId: string, answersInput: unknown, skippedInput: unknown): AskEnvelope {
    const ask = this.get(askId)
    if (!this.handoff(askId)) throw this.errors.conflict(`ask ${askId} is not a coordinator handoff`)
    if (ask.envelope.status !== 'pending') return ask.envelope
    const spec = { ...ask.spec, questions: ask.spec.questions.map((question) => ({ ...question, required: false })) }
    const checked = validateAnswerSubmission(spec, answersInput, skippedInput)
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

  /** Terminally refuses only the exact client-owned incarnation proven to have ended. */
  unavailableForSession(sessionId: string, reason: string, processIncarnation?: string): void {
    for (const owner of this.pendingOwners(sessionId)) {
      if (processIncarnation !== undefined && owner.identity.processIncarnation !== processIncarnation) continue
      this.unavailable(owner.askId, reason, false)
    }
  }

  /** Unavailable is a terminal refusal, never an answer or approval. */
  unavailable(askId: string, reason: string, promote = true): AskEnvelope {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') return ask.envelope
    const safeReason = reason.trim().slice(0, 1_024)
    return this.resolve(ask, {
      status: 'unavailable',
      reason: safeReason || `The exact asker session ${ask.sessionId ?? 'unknown'} is no longer available.`,
      answers: {},
      skipped: ask.spec.questions.map((question) => question.id),
      summary: ''
    }, promote)
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
    if (row.status !== 'pending' || row.session_id === null || row.handoff_question_id !== null) return false
    return this.store.get(
      "SELECT 1 FROM asks WHERE status = 'pending' AND handoff_question_id IS NULL AND session_id = ? AND created_seq < ? LIMIT 1",
      row.session_id,
      row.created_seq
    ) !== null
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

  private resolve(ask: Ask, outcome: AskOutcome, promote = true): AskEnvelope {
    const envelope: AskEnvelope = outcome.status === 'unavailable'
      ? { ...outcome, status: 'unavailable', reason: outcome.reason ?? 'The exact asker session is no longer available.', askId: ask.id }
      : { ...outcome, status: outcome.status, askId: ask.id }
    const wasLive = ask.sessionId !== null && !ask.queued
    const seq = this.store.transaction(() => {
      const next = this.nextSeq()
      this.store.run(
        "UPDATE asks SET status = ?, answers = ?, skipped = ?, summary = ?, reason = ?, seq = ? WHERE id = ? AND status = 'pending'",
        envelope.status,
        JSON.stringify(envelope.answers),
        JSON.stringify(envelope.skipped),
        envelope.summary,
        envelope.status === 'unavailable' ? envelope.reason : null,
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
        "SELECT * FROM asks WHERE status = 'pending' AND handoff_question_id IS NULL AND session_id = ? ORDER BY created_seq LIMIT 1",
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
