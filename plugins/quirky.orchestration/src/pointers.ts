import { createHash, randomUUID } from 'node:crypto'
import type { PluginContext, PluginStore, QuirkyEvent } from '@quirky/protocol'
import type {
  DispatchId,
  MailboxAddress,
  MessageId,
  PointerOperationPhase,
  PointerOperationResult,
  RunId
} from './contracts'
import type { OrchestrationCore } from './core'
import { targetIdentity } from './identity'
import type { OrchestrationMessages } from './messaging'
import type { SessionIdentity } from './runtime-contracts'

type PointerMailbox = Extract<MailboxAddress, { kind: 'run' | 'dispatch' }>
type PointerRecord = {
  mailbox_kind: PointerMailbox['kind']
  mailbox_id: string
  session_id: string
  expected_incarnation: string
  operation_id: string
  batch_fingerprint: string
  message_ids_json: string
  phase: PointerOperationPhase
  result_json: string | null
  created_at: string
  updated_at: string
}

const STARTUP_DELAY_MS = 2_000
const QUIET_RECHECK_MS = 3_050
const STARTUP_PAGE_SIZE = 64
const MAX_SCHEDULED_MAILBOXES = 256
const MAX_RETAINED_OPERATIONS = 10_000
const POINTER_PRUNE_BATCH = 64
const POINTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const mailboxKey = (mailbox: PointerMailbox): string =>
  `${mailbox.kind}:${mailbox.kind === 'run' ? mailbox.runId : mailbox.dispatchId}`
const mailboxId = (mailbox: PointerMailbox): string =>
  mailbox.kind === 'run' ? mailbox.runId : mailbox.dispatchId
const mailboxFor = (kind: string, id: string): PointerMailbox | null => {
  if (kind === 'run') return { kind, runId: id as RunId }
  if (kind === 'dispatch') return { kind, dispatchId: id as DispatchId }
  return null
}
const timestamp = (): string => new Date().toISOString()

/** Best-effort pointers tell an idle recipient to check; they never consume or expose mail. */
export class OrchestrationPointers {
  private readonly scheduled = new Set<string>()
  private readonly processing = new Set<string>()
  private readonly rerun = new Set<string>()
  private readonly inFlightSessions = new Set<string>()
  private readonly rescanSessions = new Set<string>()
  private readonly work = new Set<Promise<void>>()
  private readonly quietTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly quietRetryArmed = new Set<string>()
  private unsubscribeArrival: (() => void) | null = null
  private unsubscribeMailboxAvailable: (() => void) | null = null
  private unsubscribeEvents: (() => void) | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private startupPromise: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore,
    private readonly core: OrchestrationCore,
    private readonly messages: OrchestrationMessages
  ) {
    this.unsubscribeArrival = messages.onArrival((arrival) => {
      if (arrival.mailbox.kind !== 'session') this.wakeMailbox(arrival.mailbox)
    })
    this.unsubscribeMailboxAvailable = messages.onMailboxAvailable((mailbox) => {
      if (mailbox.kind !== 'session') this.wakeMailbox(mailbox)
    })
    this.unsubscribeEvents = context.subscribe((event) => this.onEvent(event))
  }

  start(): void {
    if (this.disposed || this.startupTimer !== null || this.startupPromise !== null) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      const scan = this.scanStartup()
      this.startupPromise = scan
      void scan.then(
        () => {
          if (this.startupPromise === scan) this.startupPromise = null
        },
        (error) => {
          this.log(`startup pointer scan failed: ${error instanceof Error ? error.message : String(error)}`)
          if (this.startupPromise === scan) this.startupPromise = null
        }
      )
    }, STARTUP_DELAY_MS)
    this.startupTimer.unref()
  }

  reset(mode: 'messages' | 'tasks' | 'all'): void {
    if (mode === 'messages' || mode === 'all') {
      this.scheduled.clear()
      this.rerun.clear()
      this.rescanSessions.clear()
      for (const timer of this.quietTimers.values()) clearTimeout(timer)
      this.quietTimers.clear()
      this.quietRetryArmed.clear()
      return
    }
    for (const key of this.scheduled) {
      if (key.startsWith('dispatch:')) this.scheduled.delete(key)
    }
    for (const key of this.rerun) {
      if (key.startsWith('dispatch:')) this.rerun.delete(key)
    }
    for (const [key, timer] of this.quietTimers) {
      if (!key.startsWith('dispatch:')) continue
      clearTimeout(timer)
      this.quietTimers.delete(key)
      this.quietRetryArmed.delete(key)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.startupTimer !== null) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.scheduled.clear()
    this.rerun.clear()
    for (const timer of this.quietTimers.values()) clearTimeout(timer)
    this.quietTimers.clear()
    this.quietRetryArmed.clear()
    this.rescanSessions.clear()
    this.unsubscribeArrival?.()
    this.unsubscribeMailboxAvailable?.()
    this.unsubscribeEvents?.()
    this.unsubscribeArrival = null
    this.unsubscribeMailboxAvailable = null
    this.unsubscribeEvents = null
    const pending = [...this.work, ...(this.startupPromise === null ? [] : [this.startupPromise])]
    await Promise.allSettled(pending)
  }

  private onEvent(event: QuirkyEvent): void {
    let sessionId: unknown
    const data = 'data' in event ? event.data : undefined
    if (event.type === 'quirky.session/changed') {
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const session = (data as Record<string, unknown>).session
        if (typeof session === 'object' && session !== null && !Array.isArray(session)) {
          sessionId = (session as Record<string, unknown>).id
        }
      }
    } else if (event.type === 'quirky.agent-status/changed') {
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        sessionId = (data as Record<string, unknown>).sessionId
      }
    } else if (event.type === 'quirky.structured/message') {
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        const message = (data as Record<string, unknown>).message
        if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
          sessionId = (message as Record<string, unknown>).sessionId
        }
      }
    }
    if (typeof sessionId === 'string' && sessionId.length > 0) this.scheduleSession(sessionId)
  }

  private scheduleSession(sessionId: string): void {
    if (this.disposed) return
    const mailboxes = new Map<string, PointerMailbox>()
    const runs = this.store.all<{ id: string }>(
      `SELECT id FROM runs WHERE coordinator_session_id = ? AND id != 'run_unbound' LIMIT 2`,
      sessionId
    )
    for (const run of runs) {
      const mailbox: PointerMailbox = { kind: 'run', runId: run.id as RunId }
      mailboxes.set(mailboxKey(mailbox), mailbox)
    }
    const dispatches = this.store.all<{ id: string }>(
      `SELECT id FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched') LIMIT 16`,
      sessionId
    )
    for (const dispatch of dispatches) {
      const mailbox: PointerMailbox = { kind: 'dispatch', dispatchId: dispatch.id as DispatchId }
      mailboxes.set(mailboxKey(mailbox), mailbox)
    }
    const pending = this.store.all<{ mailbox_kind: string; mailbox_id: string }>(
      `SELECT mailbox_kind, mailbox_id FROM pointer_operations WHERE session_id = ? AND phase != 'settled' LIMIT 64`,
      sessionId
    )
    for (const row of pending) {
      const mailbox = mailboxFor(row.mailbox_kind, row.mailbox_id)
      if (mailbox) mailboxes.set(mailboxKey(mailbox), mailbox)
    }
    for (const mailbox of mailboxes.values()) this.wakeMailbox(mailbox)
  }

  private wakeMailbox(mailbox: PointerMailbox): void {
    const key = mailboxKey(mailbox)
    const timer = this.quietTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.quietTimers.delete(key)
    this.quietRetryArmed.delete(key)
    this.scheduleMailbox(mailbox)
  }

  private retryAfterQuiet(mailbox: PointerMailbox): void {
    if (this.disposed) return
    const key = mailboxKey(mailbox)
    if (this.quietRetryArmed.has(key) || this.quietTimers.size >= MAX_SCHEDULED_MAILBOXES) return
    this.quietRetryArmed.add(key)
    const timer = setTimeout(() => {
      this.quietTimers.delete(key)
      if (!this.disposed) this.scheduleMailbox(mailbox)
    }, QUIET_RECHECK_MS)
    timer.unref()
    this.quietTimers.set(key, timer)
  }

  scheduleMailbox(mailbox: PointerMailbox): void {
    if (this.disposed) return
    const key = mailboxKey(mailbox)
    if (this.processing.has(key)) {
      this.rerun.add(key)
      return
    }
    if (this.scheduled.has(key)) return
    if (this.scheduled.size >= MAX_SCHEDULED_MAILBOXES) return
    this.scheduled.add(key)
    queueMicrotask(() => {
      if (!this.scheduled.delete(key)) return
      if (this.disposed) return
      if (this.processing.has(key)) {
        this.rerun.add(key)
        return
      }
      const work = this.launchMailbox(mailbox)
      this.work.add(work)
      void work.then(
        () => this.work.delete(work),
        () => this.work.delete(work)
      )
    })
  }

  private async launchMailbox(mailbox: PointerMailbox): Promise<void> {
    const key = mailboxKey(mailbox)
    if (this.disposed || this.processing.has(key)) return
    this.processing.add(key)
    let shouldDrain = false
    let sessionId: string | null = null
    let acquiredSession = false
    try {
      shouldDrain = await this.processMailbox(mailbox, (id, acquired) => {
        sessionId = id
        acquiredSession = acquired
      })
    } catch (error) {
      this.log(`pointer scheduling failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.processing.delete(key)
      if (acquiredSession && sessionId !== null) {
        this.inFlightSessions.delete(sessionId)
        if (this.rescanSessions.delete(sessionId)) this.scheduleSession(sessionId)
      }
      if (!this.disposed && (shouldDrain || this.rerun.delete(key))) this.scheduleMailbox(mailbox)
    }
  }

  private async processMailbox(
    mailbox: PointerMailbox,
    owner: (sessionId: string, acquired: boolean) => void
  ): Promise<boolean> {
    if (this.disposed) return false
    const pending = this.store.get<PointerRecord>(
      `SELECT * FROM pointer_operations WHERE mailbox_kind = ? AND mailbox_id = ? AND phase != 'settled' LIMIT 1`,
      mailbox.kind,
      mailboxId(mailbox)
    )
    if (pending) {
      owner(pending.session_id, false)
      if (pending.phase === 'reserved') {
        this.store.run(`DELETE FROM pointer_operations WHERE operation_id = ? AND phase = 'reserved'`, pending.operation_id)
      } else {
        if (this.inFlightSessions.has(pending.session_id)) {
          this.rescanSessions.add(pending.session_id)
          return false
        }
        this.inFlightSessions.add(pending.session_id)
        owner(pending.session_id, true)
        return this.submitOperation(pending, mailbox)
      }
    }

    const identity = await this.recipientIdentity(mailbox)
    if (!identity || this.disposed) return false
    owner(identity.sessionId, false)
    if (this.inFlightSessions.has(identity.sessionId)) {
      this.rescanSessions.add(identity.sessionId)
      return false
    }
    if (!await this.isEligible(mailbox, identity)) return false
    if (this.disposed) return false
    if (this.inFlightSessions.has(identity.sessionId)) {
      this.rescanSessions.add(identity.sessionId)
      return false
    }

    const operation = this.reserveOperation(mailbox, identity)
    if (!operation) return false
    this.inFlightSessions.add(identity.sessionId)
    owner(identity.sessionId, true)
    return this.submitOperation(operation, mailbox)
  }

  private async recipientIdentity(mailbox: PointerMailbox): Promise<SessionIdentity | null> {
    let sessionId: string | null = null
    let expectedIncarnation: string | null = null
    if (mailbox.kind === 'run') {
      const run = this.store.get<{ coordinator_session_id: string | null }>(
        `SELECT coordinator_session_id FROM runs WHERE id = ?`,
        mailbox.runId
      )
      sessionId = run?.coordinator_session_id ?? null
    } else {
      const dispatch = this.store.get<{
        status: string
        assignee_session_id: string | null
        process_incarnation: string | null
        supervised: number
      }>(
        `SELECT status, assignee_session_id, process_incarnation, supervised FROM dispatches WHERE id = ?`,
        mailbox.dispatchId
      )
      if (!dispatch || dispatch.status !== 'dispatched' || dispatch.assignee_session_id === null) return null
      if (dispatch.supervised) {
        const worker = this.core.workerForDispatch(mailbox.dispatchId)
        if (!worker || worker.state !== 'ready') return null
      }
      sessionId = dispatch.assignee_session_id
      expectedIncarnation = dispatch.process_incarnation
    }
    if (sessionId === null) return null
    const identity = await targetIdentity(this.context, sessionId)
    if (expectedIncarnation !== null && identity.processIncarnation !== expectedIncarnation) return null
    return identity
  }

  private async isEligible(mailbox: PointerMailbox, identity: SessionIdentity): Promise<boolean> {
    if (identity.kind === 'structured') {
      const value: unknown = await this.context.call('quirky.session/get', { session: identity.sessionId })
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const status = (value as Record<string, unknown>).status
      return status === 'running' || status === 'done'
    }
    const value: unknown = await this.context.call('quirky.agent-status/explain', { session: identity.sessionId })
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const explained = value as Record<string, unknown>
    if (explained.state === 'blocked' || explained.kind === 'approval' || explained.kind === 'question') return false
    if (explained.state !== 'idle') return false
    if (typeof explained.screen !== 'object' || explained.screen === null || Array.isArray(explained.screen)) return false
    const screen = explained.screen as Record<string, unknown>
    if (screen.unavailable !== undefined) return false
    if (screen.pendingQuiet !== undefined) {
      this.retryAfterQuiet(mailbox)
      return false
    }
    return true
  }

  private reserveOperation(mailbox: PointerMailbox, identity: SessionIdentity): PointerRecord | null {
    return this.store.transaction(() => {
      if (!this.recipientStillOwnsMailbox(mailbox, identity)) return null
      const candidates = this.messages.pointerCandidates(mailbox, this.messages.reservedTypes(mailbox))
      if (candidates.length === 0 || !this.pruneOperations()) return null
      const messageIds = candidates.map((message) => message.id)
      const at = timestamp()
      const operationId = randomUUID()
      const batchFingerprint = createHash('sha256').update(JSON.stringify(messageIds)).digest('hex')
      const messageIdsJson = JSON.stringify(messageIds)
      this.store.run(
        `INSERT INTO pointer_operations (
          mailbox_kind, mailbox_id, session_id, expected_incarnation, operation_id,
          batch_fingerprint, message_ids_json, phase, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?)`,
        mailbox.kind,
        mailboxId(mailbox),
        identity.sessionId,
        identity.processIncarnation,
        operationId,
        batchFingerprint,
        messageIdsJson,
        at,
        at
      )
      return {
        mailbox_kind: mailbox.kind,
        mailbox_id: mailboxId(mailbox),
        session_id: identity.sessionId,
        expected_incarnation: identity.processIncarnation,
        operation_id: operationId,
        batch_fingerprint: batchFingerprint,
        message_ids_json: messageIdsJson,
        phase: 'reserved',
        result_json: null,
        created_at: at,
        updated_at: at
      }
    })
  }

  private recipientStillOwnsMailbox(mailbox: PointerMailbox, identity: SessionIdentity): boolean {
    if (mailbox.kind === 'run') {
      return this.store.get<{ coordinator_session_id: string | null }>(
        `SELECT coordinator_session_id FROM runs WHERE id = ?`,
        mailbox.runId
      )?.coordinator_session_id === identity.sessionId
    }
    const dispatch = this.store.get<{
      status: string
      assignee_session_id: string | null
      process_incarnation: string | null
      supervised: number
    }>(
      `SELECT status, assignee_session_id, process_incarnation, supervised FROM dispatches WHERE id = ?`,
      mailbox.dispatchId
    )
    if (
      !dispatch ||
      dispatch.status !== 'dispatched' ||
      dispatch.assignee_session_id !== identity.sessionId ||
      dispatch.process_incarnation !== identity.processIncarnation
    ) {
      return false
    }
    if (!dispatch.supervised) return true
    return this.core.workerForDispatch(mailbox.dispatchId)?.state === 'ready'
  }

  private pruneOperations(): boolean {
    const cutoff = new Date(Date.now() - POINTER_RETENTION_MS).toISOString()
    this.store.run(`DELETE FROM pointer_operations WHERE phase = 'settled' AND updated_at < ?`, cutoff)
    let count = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM pointer_operations')?.count ?? 0
    if (count < MAX_RETAINED_OPERATIONS) return true
    const oldest = this.store.all<{ operation_id: string }>(
      `SELECT operation_id FROM pointer_operations WHERE phase = 'settled' ORDER BY updated_at ASC LIMIT ?`,
      POINTER_PRUNE_BATCH
    )
    for (const row of oldest) this.store.run(`DELETE FROM pointer_operations WHERE operation_id = ? AND phase = 'settled'`, row.operation_id)
    count = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM pointer_operations')?.count ?? 0
    return count < MAX_RETAINED_OPERATIONS
  }

  private async submitOperation(record: PointerRecord, mailbox: PointerMailbox): Promise<boolean> {
    const messageIds = this.messageIds(record)
    if (messageIds === null) return false
    if (record.phase === 'reserved') {
      const writeStarted = this.store.run(
        `UPDATE pointer_operations SET phase = 'write_attempted', updated_at = ? WHERE operation_id = ? AND phase = 'reserved'`,
        timestamp(),
        record.operation_id
      )
      if (writeStarted.changes !== 1) return false
    }

    let result: PointerOperationResult | null = null
    try {
      const value: unknown = await this.context.call('quirky.session/pointer', {
        session: record.session_id,
        expectedIncarnation: record.expected_incarnation,
        operationId: record.operation_id,
        text: this.commandFor(mailbox),
        purpose: 'mailbox_pointer'
      })
      result = this.pointerResult(value, record.operation_id)
    } catch (error) {
      this.log(`pointer operation ${record.operation_id} returned no settled result: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result === null) {
      result = {
        status: 'outcome_unknown',
        attemptedPhase: record.phase === 'enter_attempted' ? 'enter_attempted' : 'write_attempted',
        retryEnter: false
      }
    }
    const markDelivered = result.status === 'submitted' || result.status === 'text_only' || result.status === 'outcome_unknown'
    const shouldDrain = result.status === 'submitted' || result.status === 'text_only'
    const at = timestamp()
    return this.store.transaction(() => {
      const update = this.store.run(
        `UPDATE pointer_operations SET phase = 'settled', result_json = ?, updated_at = ?
         WHERE operation_id = ? AND phase != 'settled'`,
        JSON.stringify(result),
        at,
        record.operation_id
      )
      if (update.changes !== 1) return false
      if (markDelivered && messageIds.length > 0) {
        this.store.run(
          `UPDATE messages SET delivered_at = COALESCE(delivered_at, ?)
           WHERE id IN (${messageIds.map(() => '?').join(',')}) AND read = 0`,
          at,
          ...messageIds
        )
      }
      return shouldDrain
    })
  }

  private messageIds(record: PointerRecord): MessageId[] | null {
    let value: unknown
    try {
      value = JSON.parse(record.message_ids_json)
    } catch {
      return null
    }
    if (!Array.isArray(value) || !value.every((messageId) => typeof messageId === 'string')) return null
    return value as MessageId[]
  }

  private pointerResult(value: unknown, operationId: string): PointerOperationResult | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const response = value as Record<string, unknown>
    if (response.operationId !== operationId || typeof response.result !== 'object' || response.result === null || Array.isArray(response.result)) {
      return null
    }
    const result = response.result as Record<string, unknown>
    if (result.status === 'submitted' && (result.transport === 'terminal_enter' || result.transport === 'structured_session')) {
      return result as unknown as PointerOperationResult
    }
    if (result.status === 'text_only' && result.reason === 'cursor_no_auto_enter') {
      return result as unknown as PointerOperationResult
    }
    if (result.status === 'deferred' && (
      result.reason === 'not_idle' ||
      result.reason === 'not_quiescent' ||
      result.reason === 'blocked_dialog' ||
      result.reason === 'waiter_reserved' ||
      result.reason === 'delivery_outstanding' ||
      result.reason === 'flight_active'
    )) {
      return result as unknown as PointerOperationResult
    }
    if (result.status === 'released' && (result.reason === 'recipient_changed' || result.reason === 'recipient_gone')) {
      return result as unknown as PointerOperationResult
    }
    if (
      result.status === 'outcome_unknown' &&
      (result.attemptedPhase === 'write_attempted' || result.attemptedPhase === 'enter_attempted') &&
      result.retryEnter === false
    ) {
      return result as unknown as PointerOperationResult
    }
    return null
  }

  private commandFor(mailbox: PointerMailbox): string {
    return `quirky orchestration check${mailbox.kind === 'run' ? ` --run ${mailbox.runId}` : ''}`
  }

  private async scanStartup(): Promise<void> {
    let kind = ''
    let id = ''
    while (!this.disposed) {
      const rows = this.store.all<{ mailbox_kind: string; mailbox_id: string }>(
        `SELECT mailbox_kind, mailbox_id FROM (
          SELECT mailbox_kind, mailbox_id FROM pointer_operations WHERE phase != 'settled'
          UNION
          SELECT mailbox_kind, mailbox_id FROM messages
          WHERE mailbox_kind IN ('run', 'dispatch') AND read = 0 AND delivered_at IS NULL
        ) AS candidates
        WHERE mailbox_kind > ? OR (mailbox_kind = ? AND mailbox_id > ?)
        ORDER BY mailbox_kind, mailbox_id LIMIT ?`,
        kind,
        kind,
        id,
        STARTUP_PAGE_SIZE
      )
      if (rows.length === 0) return
      const last = rows[rows.length - 1]!
      kind = last.mailbox_kind
      id = last.mailbox_id
      await Promise.all(rows.flatMap((row) => {
        const mailbox = mailboxFor(row.mailbox_kind, row.mailbox_id)
        return mailbox === null ? [] : [this.launchMailbox(mailbox)]
      }))
      if (rows.length < STARTUP_PAGE_SIZE) return
    }
  }

  private log(message: string): void {
    try {
      this.context.log(message)
    } catch {
      // A revoked plugin context cannot affect durable pointer state.
    }
  }

}
