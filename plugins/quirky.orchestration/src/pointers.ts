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
import type { OrchestrationMessages } from './messaging'
import type { SessionIdentity } from './runtime-contracts'
type PointerFence = { lifecycle: number; tasks: number; sequence: number }
type SessionFlight = { mailboxKey: string; fence: PointerFence }

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
  private readonly scheduled = new Map<string, PointerFence>()
  private readonly processing = new Map<string, PointerFence>()
  private readonly rerun = new Set<string>()
  private readonly inFlightSessions = new Map<string, SessionFlight>()
  private readonly rescanSessions = new Set<string>()
  private readonly quietTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly quietRetryArmed = new Set<string>()
  private unsubscribeArrival: (() => void) | null = null
  private unsubscribeMailboxAvailable: (() => void) | null = null
  private unsubscribeEvents: (() => void) | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private startupPromise: Promise<void> | null = null
  private disposed = false
  private lifecycleGeneration = 0
  private taskGeneration = 0
  private fenceSequence = 0

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
      if (this.disposed) return
      this.startupTimer = null
      const scan = this.scanStartup()
      this.startupPromise = scan
      void scan.then(
        () => {
          if (this.startupPromise === scan) this.startupPromise = null
        },
        (error) => {
          if (this.startupPromise !== scan) return
          this.startupPromise = null
          if (!this.disposed) {
            this.log(`startup pointer scan failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      )
    }, STARTUP_DELAY_MS)
    this.startupTimer.unref()
  }

  reset(mode: 'messages' | 'tasks' | 'all'): void {
    if (mode === 'messages' || mode === 'all') {
      this.lifecycleGeneration += 1
      this.startupPromise = null
      this.scheduled.clear()
      this.processing.clear()
      this.rerun.clear()
      this.inFlightSessions.clear()
      this.rescanSessions.clear()
      for (const timer of this.quietTimers.values()) clearTimeout(timer)
      this.quietTimers.clear()
      this.quietRetryArmed.clear()
      return
    }

    this.taskGeneration += 1
    for (const key of this.scheduled.keys()) {
      if (key.startsWith('dispatch:')) this.scheduled.delete(key)
    }
    for (const key of this.processing.keys()) {
      if (key.startsWith('dispatch:')) this.processing.delete(key)
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
    for (const [sessionId, flight] of this.inFlightSessions) {
      if (!flight.mailboxKey.startsWith('dispatch:')) continue
      this.inFlightSessions.delete(sessionId)
      if (this.rescanSessions.delete(sessionId)) this.scheduleSession(sessionId)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifecycleGeneration += 1
    if (this.startupTimer !== null) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.startupPromise = null
    this.scheduled.clear()
    this.processing.clear()
    this.rerun.clear()
    this.inFlightSessions.clear()
    this.rescanSessions.clear()
    for (const timer of this.quietTimers.values()) clearTimeout(timer)
    this.quietTimers.clear()
    this.quietRetryArmed.clear()
    this.unsubscribeArrival?.()
    this.unsubscribeMailboxAvailable?.()
    this.unsubscribeEvents?.()
    this.unsubscribeArrival = null
    this.unsubscribeMailboxAvailable = null
    this.unsubscribeEvents = null
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
    if (this.disposed) return
    const key = mailboxKey(mailbox)
    const timer = this.quietTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.quietTimers.delete(key)
    this.quietRetryArmed.delete(key)
    this.scheduleMailbox(mailbox)
  }

  private createFence(mailbox: PointerMailbox): PointerFence {
    return {
      lifecycle: this.lifecycleGeneration,
      tasks: mailbox.kind === 'dispatch' ? this.taskGeneration : 0,
      sequence: ++this.fenceSequence
    }
  }

  private isCurrent(fence: PointerFence, mailbox: PointerMailbox): boolean {
    return !this.disposed &&
      fence.lifecycle === this.lifecycleGeneration &&
      (mailbox.kind !== 'dispatch' || fence.tasks === this.taskGeneration)
  }

  private retryAfterQuiet(mailbox: PointerMailbox, fence: PointerFence): void {
    if (!this.isCurrent(fence, mailbox)) return
    const key = mailboxKey(mailbox)
    if (this.quietRetryArmed.has(key) || this.quietTimers.size >= MAX_SCHEDULED_MAILBOXES) return
    this.quietRetryArmed.add(key)
    const timer = setTimeout(() => {
      if (this.quietTimers.get(key) !== timer) return
      this.quietTimers.delete(key)
      this.quietRetryArmed.delete(key)
      if (this.isCurrent(fence, mailbox)) this.scheduleMailbox(mailbox)
    }, QUIET_RECHECK_MS)
    timer.unref()
    this.quietTimers.set(key, timer)
  }

  scheduleMailbox(mailbox: PointerMailbox): void {
    if (this.disposed) return
    const key = mailboxKey(mailbox)
    const fence = this.createFence(mailbox)
    const processing = this.processing.get(key)
    if (processing && this.isCurrent(processing, mailbox)) {
      this.rerun.add(key)
      return
    }
    if (processing) this.processing.delete(key)
    const scheduled = this.scheduled.get(key)
    if (scheduled && this.isCurrent(scheduled, mailbox)) return
    if (scheduled) this.scheduled.delete(key)
    if (this.scheduled.size >= MAX_SCHEDULED_MAILBOXES) return
    this.scheduled.set(key, fence)
    queueMicrotask(() => {
      if (this.scheduled.get(key) !== fence) return
      this.scheduled.delete(key)
      if (!this.isCurrent(fence, mailbox)) return
      const active = this.processing.get(key)
      if (active && this.isCurrent(active, mailbox)) {
        this.rerun.add(key)
        return
      }
      if (active) this.processing.delete(key)
      const work = this.launchMailbox(mailbox, fence)
      void work.catch((error: unknown) => {
        if (this.isCurrent(fence, mailbox)) {
          this.log(`pointer scheduling failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    })
  }

  private async launchMailbox(mailbox: PointerMailbox, fence: PointerFence): Promise<void> {
    const key = mailboxKey(mailbox)
    if (!this.isCurrent(fence, mailbox)) return
    const current = this.processing.get(key)
    if (current && this.isCurrent(current, mailbox)) {
      this.rerun.add(key)
      return
    }
    if (current) this.processing.delete(key)
    this.processing.set(key, fence)
    let shouldDrain = false
    let sessionId: string | null = null
    let acquiredSession = false
    try {
      shouldDrain = await this.processMailbox(mailbox, fence, (id, acquired) => {
        sessionId = id
        acquiredSession = acquired
      })
      if (!this.isCurrent(fence, mailbox)) return
    } catch (error) {
      if (this.isCurrent(fence, mailbox)) {
        this.log(`pointer scheduling failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (this.processing.get(key) === fence) this.processing.delete(key)
      if (this.isCurrent(fence, mailbox)) {
        if (acquiredSession && sessionId !== null) {
          const flight = this.inFlightSessions.get(sessionId)
          if (flight?.fence === fence) {
            this.inFlightSessions.delete(sessionId)
            if (this.rescanSessions.delete(sessionId)) this.scheduleSession(sessionId)
          }
        }
        if (shouldDrain || this.rerun.delete(key)) this.scheduleMailbox(mailbox)
      }
    }
  }

  private async processMailbox(
    mailbox: PointerMailbox,
    fence: PointerFence,
    owner: (sessionId: string, acquired: boolean) => void
  ): Promise<boolean> {
    if (!this.isCurrent(fence, mailbox)) return false
    const pending = this.store.get<PointerRecord>(
      `SELECT * FROM pointer_operations WHERE mailbox_kind = ? AND mailbox_id = ? AND phase != 'settled' LIMIT 1`,
      mailbox.kind,
      mailboxId(mailbox)
    )
    if (!this.isCurrent(fence, mailbox)) return false
    if (pending) {
      owner(pending.session_id, false)
      if (pending.phase === 'reserved') {
        this.store.run(`DELETE FROM pointer_operations WHERE operation_id = ? AND phase = 'reserved'`, pending.operation_id)
        if (!this.isCurrent(fence, mailbox)) return false
      } else {
        if (this.inFlightSessions.has(pending.session_id)) {
          this.rescanSessions.add(pending.session_id)
          return false
        }
        this.inFlightSessions.set(pending.session_id, { mailboxKey: mailboxKey(mailbox), fence })
        owner(pending.session_id, true)
        const shouldDrain = await this.submitOperation(pending, mailbox, fence)
        if (!this.isCurrent(fence, mailbox)) return false
        return shouldDrain
      }
    }

    const identity = await this.recipientIdentity(mailbox, fence)
    if (!this.isCurrent(fence, mailbox) || !identity) return false
    owner(identity.sessionId, false)
    if (this.inFlightSessions.has(identity.sessionId)) {
      this.rescanSessions.add(identity.sessionId)
      return false
    }
    const eligible = await this.isEligible(mailbox, identity, fence)
    if (!this.isCurrent(fence, mailbox) || !eligible) return false
    if (this.inFlightSessions.has(identity.sessionId)) {
      this.rescanSessions.add(identity.sessionId)
      return false
    }

    const operation = this.reserveOperation(mailbox, identity, fence)
    if (!this.isCurrent(fence, mailbox) || !operation) return false
    this.inFlightSessions.set(identity.sessionId, { mailboxKey: mailboxKey(mailbox), fence })
    owner(identity.sessionId, true)
    const shouldDrain = await this.submitOperation(operation, mailbox, fence)
    if (!this.isCurrent(fence, mailbox)) return false
    return shouldDrain
  }

  private async recipientIdentity(mailbox: PointerMailbox, fence: PointerFence): Promise<SessionIdentity | null> {
    if (!this.isCurrent(fence, mailbox)) return null
    let sessionId: string | null = null
    let expectedIncarnation: string | null = null
    if (mailbox.kind === 'run') {
      const run = this.store.get<{ coordinator_session_id: string | null }>(
        `SELECT coordinator_session_id FROM runs WHERE id = ?`,
        mailbox.runId
      )
      if (!this.isCurrent(fence, mailbox)) return null
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
      if (!this.isCurrent(fence, mailbox)) return null
      if (!dispatch || dispatch.status !== 'dispatched' || dispatch.assignee_session_id === null) return null
      if (dispatch.supervised) {
        const worker = this.core.workerForDispatch(mailbox.dispatchId)
        if (!worker || worker.state !== 'ready') return null
      }
      sessionId = dispatch.assignee_session_id
      expectedIncarnation = dispatch.process_incarnation
    }
    if (sessionId === null || !this.isCurrent(fence, mailbox)) return null

    let value: unknown
    try {
      value = await this.context.call('quirky.session/identity', { session: sessionId })
    } catch (error) {
      if (!this.isCurrent(fence, mailbox)) return null
      throw error
    }
    if (!this.isCurrent(fence, mailbox)) return null
    const identity = this.sessionIdentity(value, sessionId)
    if (!identity || (expectedIncarnation !== null && identity.processIncarnation !== expectedIncarnation)) return null
    return identity
  }

  private sessionIdentity(value: unknown, expectedSessionId: string): SessionIdentity | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const candidate = value as Record<string, unknown>
    if (
      Object.keys(candidate).length !== 8 ||
      typeof candidate.sessionId !== 'string' ||
      candidate.sessionId.trim().length === 0 ||
      candidate.sessionId !== expectedSessionId ||
      candidate.live !== true ||
      typeof candidate.runtimeEpoch !== 'string' ||
      candidate.runtimeEpoch.trim().length === 0 ||
      typeof candidate.processIncarnation !== 'string' ||
      candidate.processIncarnation.trim().length === 0 ||
      (candidate.source !== 'terminal_launch' && candidate.source !== 'structured_lease' && candidate.source !== 'restored_authority') ||
      (candidate.kind !== 'terminal' && candidate.kind !== 'structured') ||
      (candidate.providerId !== null && typeof candidate.providerId !== 'string') ||
      typeof candidate.worktreeId !== 'string' ||
      candidate.worktreeId.trim().length === 0
    ) {
      return null
    }
    return value as SessionIdentity
  }

  private async isEligible(mailbox: PointerMailbox, identity: SessionIdentity, fence: PointerFence): Promise<boolean> {
    if (!this.isCurrent(fence, mailbox)) return false
    const method = identity.kind === 'structured' ? 'quirky.session/get' : 'quirky.agent-status/explain'
    let value: unknown
    try {
      value = await this.context.call(method, { session: identity.sessionId })
    } catch (error) {
      if (!this.isCurrent(fence, mailbox)) return false
      throw error
    }
    if (!this.isCurrent(fence, mailbox)) return false
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const explained = value as Record<string, unknown>
    if (identity.kind === 'structured') {
      return explained.status === 'running' || explained.status === 'done'
    }
    if (explained.state === 'blocked' || explained.kind === 'approval' || explained.kind === 'question') return false
    if (explained.state !== 'idle') return false
    if (typeof explained.screen !== 'object' || explained.screen === null || Array.isArray(explained.screen)) return false
    const screen = explained.screen as Record<string, unknown>
    if (screen.unavailable !== undefined) return false
    if (screen.pendingQuiet !== undefined) {
      this.retryAfterQuiet(mailbox, fence)
      return false
    }
    return true
  }
  private reserveOperation(
    mailbox: PointerMailbox,
    identity: SessionIdentity,
    fence: PointerFence
  ): PointerRecord | null {
    if (!this.isCurrent(fence, mailbox)) return null
    return this.store.transaction(() => {
      if (!this.isCurrent(fence, mailbox) || !this.recipientStillOwnsMailbox(mailbox, identity)) return null
      const candidates = this.messages.pointerCandidates(mailbox, this.messages.reservedTypes(mailbox))
      if (!this.isCurrent(fence, mailbox) || candidates.length === 0 || !this.pruneOperations()) return null
      const messageIds = candidates.map((message) => message.id)
      const at = timestamp()
      const operationId = randomUUID()
      const batchFingerprint = createHash('sha256').update(JSON.stringify(messageIds)).digest('hex')
      const messageIdsJson = JSON.stringify(messageIds)
      if (!this.isCurrent(fence, mailbox)) return null
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

  private async submitOperation(
    record: PointerRecord,
    mailbox: PointerMailbox,
    fence: PointerFence
  ): Promise<boolean> {
    if (!this.isCurrent(fence, mailbox)) return false
    const messageIds = this.messageIds(record)
    if (messageIds === null) return false
    const command = this.commandFor(mailbox, fence)
    if (command === null || !this.isCurrent(fence, mailbox)) return false
    if (record.phase === 'reserved') {
      const writeStarted = this.store.run(
        `UPDATE pointer_operations SET phase = 'write_attempted', updated_at = ? WHERE operation_id = ? AND phase = 'reserved'`,
        timestamp(),
        record.operation_id
      )
      if (!this.isCurrent(fence, mailbox) || writeStarted.changes !== 1) return false
    }

    let result: PointerOperationResult | null = null
    try {
      const value: unknown = await this.context.call('quirky.session/pointer', {
        session: record.session_id,
        expectedIncarnation: record.expected_incarnation,
        operationId: record.operation_id,
        text: command,
        purpose: 'mailbox_pointer'
      })
      if (!this.isCurrent(fence, mailbox)) return false
      result = this.pointerResult(value, record.operation_id)
    } catch (error) {
      if (!this.isCurrent(fence, mailbox)) return false
      this.log(`pointer operation ${record.operation_id} returned no settled result: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!this.isCurrent(fence, mailbox)) return false
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
      if (!this.isCurrent(fence, mailbox)) return false
      const update = this.store.run(
        `UPDATE pointer_operations SET phase = 'settled', result_json = ?, updated_at = ?
         WHERE operation_id = ? AND phase != 'settled'`,
        JSON.stringify(result),
        at,
        record.operation_id
      )
      if (!this.isCurrent(fence, mailbox) || update.changes !== 1) return false
      if (markDelivered && messageIds.length > 0) {
        this.store.run(
          `UPDATE messages SET delivered_at = COALESCE(delivered_at, ?)
           WHERE id IN (${messageIds.map(() => '?').join(',')}) AND read = 0`,
          at,
          ...messageIds
        )
      }
      return this.isCurrent(fence, mailbox) && shouldDrain
    })
  }

  private commandFor(mailbox: PointerMailbox, fence: PointerFence): string | null {
    if (!this.isCurrent(fence, mailbox)) return null
    const runId = mailbox.kind === 'run'
      ? mailbox.runId
      : this.store.get<{ run_id: string }>(
        `SELECT run_id FROM dispatches WHERE id = ?`,
        mailbox.dispatchId
      )?.run_id
    if (!this.isCurrent(fence, mailbox) || typeof runId !== 'string' || runId.length === 0) return null
    return `quirky orchestration check --run ${runId}`
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


  private async scanStartup(): Promise<void> {
    let kind = ''
    let id = ''
    const lifecycle = this.lifecycleGeneration
    while (!this.disposed && lifecycle === this.lifecycleGeneration) {
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
      if (this.disposed || lifecycle !== this.lifecycleGeneration) return
      if (rows.length === 0) return
      const last = rows[rows.length - 1]!
      kind = last.mailbox_kind
      id = last.mailbox_id
      const work = rows.flatMap((row) => {
        const mailbox = mailboxFor(row.mailbox_kind, row.mailbox_id)
        return mailbox === null ? [] : [this.launchMailbox(mailbox, this.createFence(mailbox))]
      })
      await Promise.allSettled(work)
      if (this.disposed || lifecycle !== this.lifecycleGeneration) return
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
