import { createHash, randomBytes } from 'node:crypto'
import type { CallerConnection, OrchestrationSubmission, OrchestrationSubmissionVerdict, PluginCaller, PluginContext, PluginStore } from '@quirky/protocol'
import type {
  AskParams,
  AskResult,
  AcceptedCheckCheckpoint,
  CheckObservationResult,
  CheckParams,
  CheckResult,
  DeliveryId,
  DeliveryRow,
  DispatchId,
  GroupAddress,
  HeartbeatResult,
  InboxMessageRow,
  InboxParams,
  InboxResult,
  JsonValue,
  MailboxAddress,
  MessageId,
  MessageArrivalPort,
  MessagePriority,
  MessageRow,
  MessageType,
  MutationRequest,
  QuestionId,
  QuestionThreadRow,
  ReplyParams,
  ReplyResult,
  RunId, CoordinatorAuthority, RuntimeCallerEvidence, SendParams, SendResult,
  TaskId,
  UtcTimestamp,
  WorkerDoneReportInput,
  WorkerHeartbeatInput,
  WorkerReportRejection,
  WorkerReportResult
} from './contracts'
import { OrchestrationCore } from './core'
import type { DurableMutationOptions } from './worker-integration'
import { fail } from './errors'
import { targetIdentity, verifyCaller } from './identity'
import type { SessionIdentity } from './runtime-contracts'
import type {
  ServiceCheckParams, ServiceCoordinatorPrincipal, ServiceQuestionView, ServiceReplyParams, ServiceSendParams,
} from './services/contracts'

import type { FederationBinding, FederationRelayItem } from './federation/contracts'

export interface FederationMessagingHooks {
  afterMessage(message: MessageRow, caller: RuntimeCallerEvidence | null): void
  afterQuestionCreated(message: MessageRow, caller: RuntimeCallerEvidence): void
  afterQuestionAnswered(questionId: string, answer: MessageRow): void
  afterReply(originalMessageId: string, replyMessage: MessageRow, caller: RuntimeCallerEvidence): void
  beforeHeartbeat(input: WorkerHeartbeatInput, caller: RuntimeCallerEvidence): Promise<HeartbeatResult | null>
  reset(mode: 'messages' | 'tasks' | 'all'): void
}
const DELIVERY_BATCH_SIZE = 50
const READ_LIMIT_MAX = 100
const DEFAULT_CHECK_WAIT_MS = 120_000
const DEFAULT_ASK_WAIT_MS = 600_000
const MAX_ASK_WAIT_MS = 1_800_000
const MESSAGE_TYPES: Partial<Record<MessageType, true>> = {
  status: true,
  dispatch: true,
  worker_done: true,
  merge_ready: true,
  escalation: true,
  handoff: true,
  decision_gate: true,
  question: true,
  heartbeat: true
}
const GROUP_FORBIDDEN: Partial<Record<MessageType, true>> = {
  worker_done: true,
  heartbeat: true,
  escalation: true,
  decision_gate: true
}
const FEDERATION_SUBMISSION_PREFLIGHT = 'quirky.orchestration/federationSubmissionPreflight'

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`
const now = (): UtcTimestamp => new Date().toISOString()
const jsonText = (value: unknown): string => JSON.stringify(value) ?? 'null'
const jsonOf = <T>(value: string | null | undefined, fallback: T): T => (value == null ? fallback : (JSON.parse(value) as T))
const mailboxKey = (mailbox: MailboxAddress): string => `${mailbox.kind}:${mailbox.kind === 'run' ? mailbox.runId : mailbox.kind === 'dispatch' ? mailbox.dispatchId : mailbox.sessionId}`
const mailboxId = (mailbox: MailboxAddress): string => (mailbox.kind === 'run' ? mailbox.runId : mailbox.kind === 'dispatch' ? mailbox.dispatchId : mailbox.sessionId)
const mailboxKind = (mailbox: MailboxAddress): MailboxAddress['kind'] => mailbox.kind

const unboundRunId = 'run_unbound' as RunId

type MessageRecord = {
  sequence: number
  id: string
  run_id: string
  from_session_id: string | null
  sender_kind: MailboxAddress['kind']
  sender_id: string
  mailbox_kind: MailboxAddress['kind']
  mailbox_id: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  thread_id: string | null
  payload_json: string | null
  read: number
  created_at: string
  delivered_at: string | null
}

type DeliveryRecord = {
  id: string
  run_id: string
  mailbox_kind: MailboxAddress['kind']
  mailbox_id: string
  consumer_generation: number
  message_ids_json: string
  status: DeliveryRow['status']
  created_at: string
  acknowledged_at: string | null
}

type QuestionRecord = {
  message_id: string
  run_id: string
  dispatch_id: string
  asker_session_id: string
  status: QuestionThreadRow['status']
  answer_message_id: string | null
  answer_body: string | null
  answered_by_generation: number | null
  created_at: string
  answered_at: string | null
  closed_at: string | null
}

type RoutedTarget = { mailbox: MailboxAddress; runId: RunId; warning?: string }
type SenderContext = {
  sessionId: string
  runId: RunId | null
  coordinatorRunId: RunId | null
  dispatchId: string | null
  sender: MailboxAddress
}
type MessageArrival = { mailbox: MailboxAddress; messageId: MessageId; type: MessageType }
type ConsumerMailbox = { mailbox: MailboxAddress; runId: RunId | null; generation: number }
type ActiveDispatchRecord = {
  id: string
  run_id: string
  task_id: string
  status: string
  assignee_session_id: string | null
  consumer_generation: number
  supervised: number
  runtime_epoch: string | null
  process_incarnation: string | null
}
type CheckCoreResult = CheckObservationResult & {
  mode: 'consume'
  deliveryId: DeliveryId | null
  replayed: boolean
}
type ConsumeCheckParams =
  | Extract<CheckParams, { mode: 'consume' }>
  | (ServiceCheckParams & { format?: boolean })
type ReplyValue =
  | {
      kind: 'question_answer'
      messageId: MessageId
      answerMessageId: MessageId
      threadId: string
      duplicate: boolean
    }
  | {
      kind: 'ordinary_reply'
      messageId: MessageId
      replyMessage: MessageRow
      threadId: string
    }
type AskValue =
  | {
      state: 'answered'
      answer: string
      messageId: QuestionId
      answerMessageId: MessageId
      threadId: string
      timeoutMs: number
    }
  | {
      state: 'timedOut' | 'cancelled' | 'connectionLost'
      answer: null
      messageId: QuestionId
      threadId: string
      timeoutMs: number
    }
type WaitOutcome = 'message' | 'timeout' | 'connection' | 'fenced' | 'reset'
type MailboxWaiter = {
  id: number
  mailbox: MailboxAddress
  caller: CoordinatorAuthority
  types: Set<MessageType> | null
  wake(outcome: WaitOutcome): void
}
type AskWaiter = { id: number; wake(): void }

function mailboxOfRow(row: MessageRecord): MailboxAddress {
  if (row.mailbox_kind === 'run') return { kind: 'run', runId: row.mailbox_id as RunId }
  if (row.mailbox_kind === 'dispatch') return { kind: 'dispatch', dispatchId: row.mailbox_id as DispatchId }
  return { kind: 'session', sessionId: row.mailbox_id }
}

function senderOfRow(row: MessageRecord): MailboxAddress {
  if (row.sender_kind === 'run') return { kind: 'run', runId: row.sender_id as RunId }
  if (row.sender_kind === 'dispatch') return { kind: 'dispatch', dispatchId: row.sender_id as DispatchId }
  return { kind: 'session', sessionId: row.sender_id }
}

function messageRow(row: MessageRecord): MessageRow {
  return {
    id: row.id as MessageId,
    runId: row.run_id as RunId,
    fromSessionId: row.from_session_id,
    sender: senderOfRow(row),
    mailbox: mailboxOfRow(row),
    subject: row.subject,
    body: row.body,
    type: row.type,
    priority: row.priority,
    threadId: row.thread_id,
    payload: jsonOf<JsonValue | null>(row.payload_json, null),
    read: row.read === 1,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  }
}

function questionRow(row: QuestionRecord): QuestionThreadRow {
  return {
    messageId: row.message_id as QuestionId,
    runId: row.run_id as RunId,
    dispatchId: row.dispatch_id as QuestionThreadRow['dispatchId'],
    askerSessionId: row.asker_session_id,
    status: row.status,
    answerMessageId: row.answer_message_id as MessageId | null,
    answerBody: row.answer_body,
    answeredByGeneration: row.answered_by_generation,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    closedAt: row.closed_at
  }
}

function deliveryRow(row: DeliveryRecord): DeliveryRow {
  const mailbox: MailboxAddress =
    row.mailbox_kind === 'run'
      ? { kind: 'run', runId: row.mailbox_id as RunId }
      : row.mailbox_kind === 'dispatch'
        ? { kind: 'dispatch', dispatchId: row.mailbox_id as DispatchId }
        : { kind: 'session', sessionId: row.mailbox_id }
  return {
    id: row.id as DeliveryId,
    runId: row.run_id as RunId,
    mailbox,
    consumerGeneration: row.consumer_generation,
    messageIds: jsonOf<MessageId[]>(row.message_ids_json, []),
    status: row.status,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at
  }
}


function isGroup(target: SendParams['to']): target is GroupAddress {
  return target?.kind === 'group'
}


function formatMessage(message: MessageRow): string {
  const payload = message.payload === null ? '' : `\n[Payload: ${JSON.stringify(message.payload)}]`
  return `──── From: ${message.sender.kind.toUpperCase()} (${mailboxKey(message.sender)}) [${message.priority.toUpperCase()}] (${message.type}) ────\nSubject: ${message.subject}\n${message.body}${payload}\n────────────────────────────────────────────────────────────`
}

function acceptedCheck(
  mailbox: MailboxAddress,
  runId: RunId | null,
  generation: number,
  acknowledged: DeliveryId | null
): AcceptedCheckCheckpoint {
  return { state: 'accepted', accepted: true, mailbox, runId, consumerGeneration: generation, acknowledged }
}

export class OrchestrationMessages implements MessageArrivalPort {
  private readonly waiters = new Map<string, MailboxWaiter>()
  private readonly waiterReservations = new Map<string, symbol>()
  private readonly askWaiters = new Map<string, Set<AskWaiter>>()
  private readonly arrivalListeners = new Set<(arrival: MessageArrival) => void | Promise<void>>()
  private readonly mailboxAvailableListeners = new Set<(mailbox: MailboxAddress) => void>()
  private federationHooks: FederationMessagingHooks | null = null

  private get store(): PluginStore {
    return this.core.store
  }

  constructor(private readonly context: PluginContext, private readonly core: OrchestrationCore) {
    this.core.onBindingChanged((sessionId, runId) => {
      this.cancelRunWaiter(sessionId, runId, 'fenced')
      this.notifyMailboxAvailable({ kind: 'run', runId })
    })
    this.core.onQuestionsClosed((messageIds) => messageIds.forEach((messageId) => this.notifyQuestion(messageId)))
    this.core.onDispatchSettled((dispatchId) => this.cancelDispatchWaiter(dispatchId))
    this.core.onDispatchFenced((dispatchId) => this.cancelDispatchWaiter(dispatchId))
    this.core.onMessageCommitted((arrival) => this.onCommitted(arrival))
  }

  bindFederation(hooks: FederationMessagingHooks): void {
    if (this.federationHooks !== null && this.federationHooks !== hooks) {
      fail(this.context, 'lifecycle_conflict', 'federation mail hooks are already bound')
    }
    this.federationHooks = hooks
  }

  unbindFederation(hooks: FederationMessagingHooks): void {
    if (this.federationHooks === hooks) this.federationHooks = null
  }

  getFederatedMessage(id: MessageId): MessageRow {
    return this.getMessage(id)
  }

  notifyFederatedQuestion(messageId: string): void {
    this.notifyQuestion(messageId)
  }

  runFederatedSubmissionPreflight(submission: OrchestrationSubmission): Promise<OrchestrationSubmissionVerdict | null> {
    return this.runSubmissionPreflight(submission)
  }

  importFederatedItem(
    binding: FederationBinding,
    item: FederationRelayItem,
  ): { message: MessageRow; questionId: string | null } {
    const toHome = item.direction === 'to_home'
    if ((toHome && binding.side !== 'home') || (!toHome && binding.side !== 'host') || item.bindingId !== binding.id) {
      fail(this.context, 'consumer_fenced', 'federated message does not belong to this binding side')
    }
    const sourceRunId = toHome ? binding.hostRunId : binding.homeRunId
    const targetRunId = toHome ? binding.homeRunId : binding.hostRunId
    const sourceTaskId = toHome ? binding.hostTaskId : binding.homeTaskId
    const targetTaskId = toHome ? binding.homeTaskId : binding.hostTaskId
    const sourceDispatchId = toHome ? binding.hostDispatchId : binding.homeDispatchId
    const targetDispatchId = toHome ? binding.homeDispatchId : binding.hostDispatchId
    if (!sourceRunId || !targetRunId || !sourceTaskId || !targetTaskId || !sourceDispatchId || !targetDispatchId) {
      fail(this.context, 'consumer_fenced', 'federated message binding is not fully attached')
    }
    const rawMessage = item.payload.message
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      fail(this.context, 'invalid_argument', 'federated message item is missing its message envelope')
    }
    const source = rawMessage as Record<string, unknown>
    if (
      typeof source.id !== 'string' || source.id.length === 0 ||
      source.runId !== sourceRunId ||
      typeof source.subject !== 'string' || typeof source.body !== 'string' ||
      !this.isMessageType(source.type) ||
      (source.priority !== 'normal' && source.priority !== 'high' && source.priority !== 'urgent') ||
      typeof source.createdAt !== 'string' ||
      (source.threadId !== null && typeof source.threadId !== 'string')
    ) {
      fail(this.context, 'invalid_argument', 'federated message envelope is invalid')
    }
    if (source.id !== item.id ||
      (item.kind === 'lifecycle' && source.type !== item.payload.type) ||
      ((item.kind === 'question' || item.kind === 'reply') && source.type !== 'question') ||
      (item.kind === 'message' && (source.type === 'worker_done' || source.type === 'heartbeat'))) {
      fail(this.context, 'invalid_argument', 'federated message ID or type does not match its relay item')
    }
    const mapAddress = (raw: unknown): MailboxAddress => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        fail(this.context, 'invalid_argument', 'federated message address is invalid')
      }
      const address = raw as Record<string, unknown>
      if (address.kind === 'run' && address.runId === sourceRunId) return { kind: 'run', runId: targetRunId }
      if (address.kind === 'dispatch' && address.dispatchId === sourceDispatchId) {
        return { kind: 'dispatch', dispatchId: targetDispatchId }
      }
      fail(this.context, 'invalid_argument', 'federated message address is outside its exact binding')
    }
    const sender = mapAddress(source.sender)
    const mailbox = mapAddress(source.mailbox)
    const rawPayload = source.payload
    if (rawPayload !== null && (typeof rawPayload !== 'object' || Array.isArray(rawPayload))) {
      fail(this.context, 'invalid_argument', 'federated message payload must be an object or null')
    }
    let payload: JsonValue | null = rawPayload as JsonValue | null
    if (payload !== null) {
      const remapped: Record<string, JsonValue> = { ...(payload as Record<string, JsonValue>) }
      if (remapped.taskId === sourceTaskId) remapped.taskId = targetTaskId
      if (remapped.dispatchId === sourceDispatchId) remapped.dispatchId = targetDispatchId
      payload = remapped
    }
    const at = source.createdAt
    const senderId = mailboxId(sender)
    const targetId = mailboxId(mailbox)
    const messageId = source.id as MessageId
    const remoteSession = `federation:${binding.peer.id}`
    this.store.run(
      `INSERT OR IGNORE INTO messages (
        id, run_id, from_session_id, sender_kind, sender_id, mailbox_kind, mailbox_id,
        subject, body, type, priority, thread_id, payload_json, read, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
      messageId, targetRunId, remoteSession, sender.kind, senderId, mailbox.kind, targetId,
      source.subject, source.body, source.type, source.priority, source.threadId,
      payload === null ? null : jsonText(payload), at,
    )
    let imported = this.getMessage(messageId)
    if (
      imported.runId !== targetRunId || imported.sender.kind !== sender.kind ||
      mailboxId(imported.sender) !== senderId || imported.mailbox.kind !== mailbox.kind ||
      mailboxId(imported.mailbox) !== targetId || imported.body !== source.body || imported.type !== source.type
    ) {
      fail(this.context, 'lifecycle_conflict', `federated message ID ${messageId} conflicts with a local message`)
    }
    let questionId: string | null = null
    if (item.kind === 'question') {
      if (imported.type !== 'question' || sender.kind !== 'dispatch' || mailbox.kind !== 'run') {
        fail(this.context, 'invalid_argument', 'federated question must be sent by its exact Dispatch to its Run')
      }
      const existing = this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, messageId)
      if (!existing) {
        this.store.run(
          `INSERT INTO question_threads (
            message_id, run_id, dispatch_id, asker_session_id, status, answer_message_id, answer_body,
            answered_by_generation, created_at, answered_at, closed_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL)`,
          messageId, targetRunId, targetDispatchId, remoteSession, at,
        )
      } else if (existing.run_id !== targetRunId || existing.dispatch_id !== targetDispatchId) {
        fail(this.context, 'lifecycle_conflict', `federated question ${messageId} conflicts with an existing thread`)
      }
      questionId = messageId
    } else if (item.kind === 'reply') {
      const rawQuestionId = item.payload.questionId
      if (typeof rawQuestionId !== 'string') fail(this.context, 'invalid_argument', 'federated reply is missing its question ID')
      const question = this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, rawQuestionId)
      if (!question || question.run_id !== targetRunId || question.dispatch_id !== targetDispatchId) {
        fail(this.context, 'question_not_found', `federated question ${rawQuestionId} does not belong to this binding`)
      }
      if (question.status === 'closed') fail(this.context, 'dispatch_inactive', `federated question ${rawQuestionId} was closed`)
      if (question.status === 'answered') {
        if (question.answer_body !== imported.body) fail(this.context, 'answer_conflict', `federated question ${rawQuestionId} already has another answer`)
      } else {
        const update = this.store.run(
          `UPDATE question_threads SET status = 'answered', answer_message_id = ?, answer_body = ?,
           answered_by_generation = ?, answered_at = ? WHERE message_id = ? AND status = 'pending'`,
          messageId, imported.body, this.core.getRun(targetRunId).consumerGeneration, now(), rawQuestionId,
        )
        if (update.changes !== 1) fail(this.context, 'lifecycle_conflict', `federated question ${rawQuestionId} changed while importing its answer`)
      }
      questionId = rawQuestionId
    }
    imported = this.getMessage(messageId)
    return { message: imported, questionId }
  }

  markFederatedRejected(
    messageId: MessageId,
    originalType: MessageType,
    reason: string,
    code: string,
  ): void {
    const message = this.getMessage(messageId)
    this.markRejectedReport(messageId, originalType, message.subject, message.payload, reason, { action: 'rejected', code, reason })
  }

  onArrival(listener: (arrival: MessageArrival) => void | Promise<void>): () => void {
    this.arrivalListeners.add(listener)
    return () => this.arrivalListeners.delete(listener)
  }
  onCommitted(arrival: MessageArrival): void {
    this.notifyCommitted(arrival)
  }

  onMailboxAvailable(listener: (mailbox: MailboxAddress) => void): () => void {
    this.mailboxAvailableListeners.add(listener)
    return () => this.mailboxAvailableListeners.delete(listener)
  }

  private notifyMailboxAvailable(mailbox: MailboxAddress): void {
    for (const listener of this.mailboxAvailableListeners) {
      queueMicrotask(() => {
        try {
          listener(mailbox)
        } catch (error) {
          try {
            this.context.log(`mailbox availability listener failed: ${error instanceof Error ? error.message : String(error)}`)
          } catch {
            // A revoked plugin context cannot affect committed mailbox state.
          }
        }
      })
    }
  }

  hasWaiter(mailbox: MailboxAddress): boolean {
    return this.waiters.has(mailboxKey(mailbox))
  }

  isUnfilteredWaiter(mailbox: MailboxAddress): boolean {
    return this.waiters.get(mailboxKey(mailbox))?.types === null
  }

  reservedTypes(mailbox: MailboxAddress): ReadonlySet<MessageType> {
    return this.waiters.get(mailboxKey(mailbox))?.types ?? new Set<MessageType>()
  }

  private notifyCommitted(arrival: MessageArrival): void {
    const waiter = this.waiters.get(mailboxKey(arrival.mailbox))
    if (waiter && (waiter.types === null || waiter.types.has(arrival.type))) waiter.wake('message')
    for (const listener of this.arrivalListeners) {
      queueMicrotask(() => {
        void Promise.resolve(listener(arrival)).catch((error) => {
          try {
            this.context.log(`mail arrival listener failed: ${error instanceof Error ? error.message : String(error)}`)
          } catch {
            // A revoked plugin context cannot affect the committed message.
          }
        })
      })
    }
  }

  private notifyQuestion(messageId: string): void {
    const waiters = this.askWaiters.get(messageId)
    if (!waiters) return
    for (const waiter of waiters) waiter.wake()
  }


  private cancelRunWaiter(sessionId: string, runId: RunId, outcome: WaitOutcome): void {
    const key = mailboxKey({ kind: 'run', runId })
    const waiter = this.waiters.get(key)
    if (waiter && !('kind' in waiter.caller) && waiter.caller.runtimeSessionId === sessionId) waiter.wake(outcome)
  }

  private cancelDispatchWaiter(dispatchId: DispatchId): void {
    this.waiters.get(mailboxKey({ kind: 'dispatch', dispatchId }))?.wake('fenced')
  }

  async send(input: SendParams, caller: PluginCaller): Promise<SendResult> {
    const verified = await verifyCaller(this.context, caller, input)
    const type = input.type ?? 'status'
    if (!this.isMessageType(type)) fail(this.context, 'invalid_argument', `unsupported message type ${String(type)}`)
    if (isGroup(input.to) && GROUP_FORBIDDEN[type] === true) {
      fail(this.context, 'invalid_argument', `${type} messages must target one exact Dispatch`)
    }
    const payload = this.payloadOf(input)
    const threadId = input.threadId ?? (isGroup(input.to) ? `thread_${Date.now()}_${randomBytes(4).toString('hex')}` : null)
    let sender: SenderContext | null = null
    let targets: RoutedTarget[] | null = null
    let submissionVerdict: OrchestrationSubmissionVerdict | null = null
    let federatedHeartbeat: HeartbeatResult | null = null
    const beforeAccept = async (): Promise<void> => {
      const resolvedSender = this.senderContext(verified.evidence, type === 'worker_done' || type === 'heartbeat')
      sender = resolvedSender
      targets = await this.resolveTargets(input, type, resolvedSender, verified.evidence, payload)
      if (type === 'worker_done') {
        const parsed = this.workerDoneInput(input, payload, 'msg_preflight' as MessageId)
        if (typeof parsed !== 'string' && parsed.dispatchId === resolvedSender.dispatchId &&
          this.core.preflightWorkerDone(parsed, verified.evidence) === null) {
          const dispatch = this.core.getDispatch(parsed.dispatchId)
          submissionVerdict = await this.runSubmissionPreflight({
            runId: dispatch.runId,
            taskId: parsed.taskId,
            dispatchId: parsed.dispatchId,
            type,
            subject: parsed.subject,
            body: parsed.body,
            payload: this.submissionPayload(payload),
          })
        }
      } else if (type === 'status' && resolvedSender.dispatchId !== null) {
        const active = this.activeDispatchFor(resolvedSender.sessionId)
        if (active && active.id === resolvedSender.dispatchId) {
          this.assertDispatchOwner(active, verified.evidence)
          submissionVerdict = await this.runSubmissionPreflight({
            runId: active.run_id as RunId,
            taskId: active.task_id as TaskId,
            dispatchId: active.id as DispatchId,
            type,
            subject: input.subject,
            body: input.body ?? '',
            payload: this.submissionPayload(payload),
          })
        }
      } else if (type === 'heartbeat') {
        const parsed = this.heartbeatInput(payload)
        if (typeof parsed !== 'string') {
          federatedHeartbeat = await this.federationHooks?.beforeHeartbeat(parsed, verified.evidence) ?? null
        }
      }
    }
    const params = input as unknown as MutationRequest & Record<string, unknown>
    const result = await this.core.mutate('send', params, verified.evidence, () => {
      const acceptedSender = sender
      const acceptedTargets = targets
      if (!acceptedSender || !acceptedTargets) {
        fail(this.context, 'identity_unavailable', 'message routing was not resolved before acceptance')
      }
      if (type === 'status' && acceptedSender.dispatchId !== null) {
        const active = this.activeDispatchFor(acceptedSender.sessionId)
        if (!active || active.id !== acceptedSender.dispatchId) {
          fail(this.context, 'consumer_fenced', `caller no longer owns Dispatch ${acceptedSender.dispatchId}`, {
            dispatchId: acceptedSender.dispatchId,
          })
        }
        this.assertDispatchOwner(active, verified.evidence)
      }
      const messages: MessageRow[] = []
      let report: WorkerReportResult | null = null
      let heartbeat: HeartbeatResult | null = null
      let lifecycleRejection: { action: 'rejected'; code: string; reason: string } | undefined
      for (const target of acceptedTargets) {
        if (type !== 'worker_done' && type !== 'heartbeat') this.assertResolvedTarget(target)
        const lifecycle = type === 'worker_done' || type === 'heartbeat'
        const row = this.insertMessage({
          runId: lifecycle ? target.runId : (acceptedSender.runId ?? unboundRunId),
          fromSessionId: acceptedSender.sessionId,
          sender: this.messageSender(type, payload, acceptedSender),
          mailbox: target.mailbox,
          subject: input.subject,
          body: input.body ?? '',
          type,
          priority: input.priority ?? 'normal',
          threadId: type === 'question' && threadId === null ? 'pending-question-thread' : threadId,
          payload,
          read: false
        })
        if (type === 'worker_done') {
          const parsed = this.workerDoneInput(input, payload, row.id)
          if (typeof parsed === 'string') {
            report = { status: 'rejected', reason: parsed, audited: true }
          } else {
            const fence = this.core.preflightWorkerDone(parsed, verified.evidence)
            if (fence !== null) {
              report = fence
            } else if (submissionVerdict?.kind === 'rejected') {
              lifecycleRejection = {
                action: 'rejected',
                code: submissionVerdict.code,
                reason: submissionVerdict.reason,
              }
              report = {
                status: 'rejected',
                reason: 'submission_preflight_rejected',
                audited: true,
                lifecycle: lifecycleRejection,
              }
            } else {
              report = this.core.reportWorkerDone(parsed, verified.evidence)
            }
          }
          if (report.status === 'rejected') {
            this.markRejectedReport(row.id, type, input.subject, payload, report.reason, report.lifecycle)
          }
          messages.push(this.getMessage(row.id))
        } else if (type === 'heartbeat') {
          const parsed = this.heartbeatInput(payload)
          if (typeof parsed === 'string') {
            heartbeat = { status: 'rejected', reason: parsed, lastHeartbeatAt: null }
          } else if (federatedHeartbeat?.status === 'rejected') {
            heartbeat = federatedHeartbeat
          } else {
            heartbeat = this.core.recordHeartbeat(parsed, verified.evidence)
          }
          if (heartbeat.status === 'rejected') this.store.run(`UPDATE messages SET read = 1, delivered_at = ? WHERE id = ?`, now(), row.id)
          messages.push(this.getMessage(row.id))
        } else if (type === 'status' && submissionVerdict?.kind === 'rejected') {
          lifecycleRejection = {
            action: 'rejected',
            code: submissionVerdict.code,
            reason: submissionVerdict.reason,
          }
          this.markRejectedReport(row.id, type, input.subject, payload, 'submission_preflight_rejected', lifecycleRejection)
          messages.push(this.getMessage(row.id))
        } else {
          messages.push(row)
        }
      }
      if (type === 'question' && messages.length === 1) {
        const question = messages[0]!
        this.store.run(`UPDATE messages SET thread_id = ? WHERE id = ?`, question.id, question.id)
        messages[0] = this.getMessage(question.id)
      }
      if (type !== 'worker_done' && type !== 'heartbeat' && !(type === 'status' && acceptedSender.dispatchId !== null)) {
        for (const message of messages) this.federationHooks?.afterMessage(message, verified.evidence)
      }
      if (report !== null) return { kind: 'worker_report' as const, messages, report, threadId }
      if (heartbeat !== null) return { kind: 'heartbeat' as const, messages, heartbeat, threadId }
      return {
        kind: 'message' as const,
        messages,
        threadId,
        ...(lifecycleRejection ? { lifecycle: lifecycleRejection } : {}),
      }
    }, { beforeAccept })
    if (!result.mutation.replayed) {
      for (const message of result.messages) {
        if (!message.read) this.onCommitted({ mailbox: message.mailbox, messageId: message.id, type: message.type })
      }
    }
    return result
  }

  async sendService(
    input: ServiceSendParams,
    caller: ServiceCoordinatorPrincipal
  ): Promise<Extract<SendResult, { kind: 'message' }>> {
    this.core.requireCoordinator(caller, input.runId)
    let target: RoutedTarget | null = null
    const result = await this.core.mutate('send', input, caller, () => {
      const resolved = target
      if (!resolved) fail(this.context, 'lifecycle_conflict', 'service message routing was not resolved before acceptance')
      const dispatch = this.core.getDispatch(input.dispatchId)
      if (dispatch.runId !== caller.runId) {
        fail(this.context, 'dispatch_run_mismatch', `Dispatch ${input.dispatchId} belongs to Run ${dispatch.runId}, not ${caller.runId}`, {
          dispatchId: input.dispatchId,
          runId: caller.runId
        })
      }
      if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
        fail(this.context, 'dispatch_inactive', `Dispatch ${input.dispatchId} is no longer active`, { dispatchId: input.dispatchId, runId: dispatch.runId })
      }
      const message = this.insertMessage({
        runId: caller.runId,
        fromSessionId: null,
        sender: { kind: 'run', runId: caller.runId },
        mailbox: resolved.mailbox,
        subject: 'Coordinator guidance',
        body: input.body,
        type: 'status',
        priority: 'normal',
        threadId: null,
        payload: null,
        read: false
      })
      this.federationHooks?.afterMessage(message, null)
      return { kind: 'message' as const, messages: [message], threadId: null }
    }, {
      beforeAccept: async () => {
        target = await this.resolveDirectTarget({ kind: 'dispatch', dispatchId: input.dispatchId }, null)
        if (target.runId !== caller.runId) {
          fail(this.context, 'dispatch_run_mismatch', `Dispatch ${input.dispatchId} belongs to Run ${target.runId}, not ${caller.runId}`, {
            dispatchId: input.dispatchId,
            runId: caller.runId
          })
        }
      }
    })
    if (!result.mutation.replayed) {
      for (const message of result.messages) {
        if (!message.read) this.onCommitted({ mailbox: message.mailbox, messageId: message.id, type: message.type })
      }
    }
    return result
  }

  async check(input: CheckParams, caller: PluginCaller): Promise<CheckResult> {
    if (input.limit !== undefined && input.mode !== 'peek' && input.mode !== 'all') {
      fail(this.context, 'invalid_argument', 'limit is only valid with --peek or --all')
    }
    if (input.types !== undefined) this.validateMessageTypes(input.types)
    if (input.mode === 'peek' || input.mode === 'all') {
      if (input.wait) fail(this.context, 'invalid_argument', `${input.mode} cannot be combined with --wait`)
      if (input.ackDeliveryId !== undefined) {
        const verified = await verifyCaller(this.context, caller, input)
        return this.core.mutate('check', input as unknown as MutationRequest & Record<string, unknown>, verified.evidence, () => {
          const resolved = this.resolveConsumerMailbox(verified.evidence, input.runId, false)
          const acknowledged = this.acknowledge(input.ackDeliveryId!, resolved.mailbox, resolved.generation)
          this.notifyMailboxAvailable(resolved.mailbox)
          const messages = this.readMessages(resolved.mailbox, input.mode, input.limit, input.types)
          return {
            mode: input.mode,
            runId: resolved.runId,
            messages,
            count: messages.length,
            acknowledged,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            ...(input.format ? { formatted: messages.map(formatMessage).join('\\n\\n') } : {})
          }
        })
      }
      const resolved = await this.resolveReadMailbox(input.runId, caller)
      const messages = this.readMessages(resolved.mailbox, input.mode, input.limit, input.types)
      return {
        mode: input.mode,
        runId: resolved.runId,
        messages,
        count: messages.length,
        acknowledged: null,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        ...(input.format ? { formatted: messages.map(formatMessage).join('\\n\\n') } : {})
      }
    }

    if (input.mode !== 'consume') fail(this.context, 'invalid_argument', 'consume check mode is required')

    const verified = await verifyCaller(this.context, caller, input)
    const connection = this.requireConnection(caller)
    return this.consumeCheck(input, verified.evidence, connection)
  }

  async serviceCheck(
    input: ServiceCheckParams,
    caller: ServiceCoordinatorPrincipal
  ): Promise<CheckResult & { questions: readonly ServiceQuestionView[] }> {
    const result = await this.consumeCheck(input, caller, undefined)
    return { ...result, questions: this.serviceQuestions(caller.runId) }
  }

  serviceQuestions(runId: RunId): readonly ServiceQuestionView[] {
    return this.store.all<QuestionRecord & { body: string }>(
      `SELECT q.*, m.body FROM question_threads q
       JOIN messages m ON m.id = q.message_id
       WHERE q.run_id = ?
       ORDER BY q.created_at, q.message_id`,
      runId
    ).map((row) => ({ ...questionRow(row), body: row.body }))
  }

  private async consumeCheck(
    input: ConsumeCheckParams,
    caller: CoordinatorAuthority,
    connection: CallerConnection | undefined
  ): Promise<CheckResult> {
    if (input.types !== undefined) this.validateMessageTypes(input.types)
    const timeoutMs = input.timeoutMs ?? DEFAULT_CHECK_WAIT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_ASK_WAIT_MS) {
      fail(this.context, 'invalid_argument', 'check timeoutMs must be an integer between 0 and 1800000')
    }
    let resolvedSnapshot: ConsumerMailbox | null = null
    let waiterReservation: { key: string; token: symbol } | null = null
    let waiterExists = false
    const wait = input.wait === true
    try {
      return await this.core.mutate<CheckCoreResult>(
        'check',
        input,
        caller,
        () => {
          const resolved = resolvedSnapshot ?? this.resolveConsumerMailbox(caller, input.runId, false)
          resolvedSnapshot = resolved
          const acknowledged = input.ackDeliveryId !== undefined
            ? this.acknowledge(input.ackDeliveryId, resolved.mailbox, resolved.generation)
            : null
          if (acknowledged !== null) this.notifyMailboxAvailable(resolved.mailbox)
          const batch = waiterExists
            ? null
            : this.nextDelivery(resolved.mailbox, resolved.generation, resolved.runId, wait ? input.types : undefined)
          const messages = batch ? batch.messages : []
          return {
            mode: 'consume' as const,
            runId: resolved.runId,
            messages,
            count: messages.length,
            deliveryId: batch?.delivery.id ?? null,
            replayed: batch?.replayed ?? false,
            acknowledged,
            timedOut: false,
            cancelled: waiterExists,
            connectionLost: false,
            ...(waiterExists ? { waitInterrupted: 'waiter_exists' as const } : {}),
            ...(input.format ? { formatted: messages.map(formatMessage).join('\\n\\n') } : {})
          }
        },
        wait
          ? {
              beforeAccept: () => {
                const resolved = this.resolveConsumerMailbox(caller, input.runId, false)
                resolvedSnapshot = resolved
                const key = mailboxKey(resolved.mailbox)
                if (this.waiters.has(key) || this.waiterReservations.has(key)) {
                  if (input.ackDeliveryId === undefined) {
                    fail(this.context, 'waiter_exists', `mailbox ${key} already has an actionable waiter`)
                  }
                  waiterExists = true
                  return
                }
                const token = Symbol()
                waiterReservation = { key, token }
                this.waiterReservations.set(key, token)
              },
              acceptedCheckpoint: (accepted) => {
                const resolved = resolvedSnapshot
                if (!resolved) fail(this.context, 'lifecycle_conflict', 'check accepted before its mailbox was resolved')
                return acceptedCheck(resolved.mailbox, resolved.runId, resolved.generation, accepted.acknowledged)
              },
              afterCommit: async (accepted) => {
                const resolved = resolvedSnapshot
                if (!resolved) fail(this.context, 'lifecycle_conflict', 'check lost its mailbox after acceptance')
                if (accepted.waitInterrupted === 'waiter_exists' || accepted.deliveryId !== null) return accepted
                return this.waitForMailbox(
                  accepted,
                  resolved,
                  input.types,
                  timeoutMs,
                  connection,
                  input.format,
                  caller,
                  waiterReservation?.token ?? null
                )
              }
            }
          : undefined
      )
    } finally {
      // beforeAccept assigns this in-process reservation across an async callback boundary.
      const reservation = waiterReservation as { key: string; token: symbol } | null
      if (reservation && this.waiterReservations.get(reservation.key) === reservation.token) {
        this.waiterReservations.delete(reservation.key)
      }
    }
  }

  async reply(input: ReplyParams, caller: PluginCaller): Promise<ReplyResult> {
    const verified = await verifyCaller(this.context, caller, input)
    let ordinaryTarget: RoutedTarget | null = null
    const params = input as unknown as MutationRequest & Record<string, unknown>
    const result = await this.core.mutate(
      'reply',
      params,
      verified.evidence,
      () => {
        const question = this.store.get<QuestionRecord>('SELECT * FROM question_threads WHERE message_id = ?', input.messageId)
        if (question) return this.answerQuestion(question, input, verified.evidence)
        if (!ordinaryTarget) fail(this.context, 'lifecycle_not_found', `message ${input.messageId} was not routed before acceptance`, { messageId: input.messageId })
        return this.replyOrdinary(input, verified.evidence, ordinaryTarget)
      },
      {
        beforeAccept: async () => {
          const question = this.store.get<QuestionRecord>('SELECT * FROM question_threads WHERE message_id = ?', input.messageId)
          if (question) return
          const original = this.store.get<MessageRecord>('SELECT * FROM messages WHERE id = ?', input.messageId)
          if (!original) fail(this.context, 'question_not_found', `message ${input.messageId} does not exist`, { messageId: input.messageId })
          if (input.runId !== undefined && input.runId !== original.run_id) {
            fail(this.context, 'recipient_run_mismatch', `message ${input.messageId} belongs to Run ${original.run_id}, not ${input.runId}`, {
              messageId: input.messageId,
              runId: input.runId,
              recipientRunId: original.run_id
            })
          }
          ordinaryTarget = await this.resolveDirectTarget(senderOfRow(original), verified.evidence.runtimeSessionId)
        }
      }
    )
    if (!result.mutation.replayed) {
      if (result.kind === 'question_answer') {
        this.notifyQuestion(result.messageId)
      } else {
        this.onCommitted({ mailbox: result.replyMessage.mailbox, messageId: result.replyMessage.id, type: result.replyMessage.type })
      }
    }
    return result
  }

  async replyService(input: ServiceReplyParams, caller: ServiceCoordinatorPrincipal): Promise<ReplyResult> {
    this.core.requireCoordinator(caller, input.runId)
    const result = await this.core.mutate('reply', input, caller, () => {
      const question = this.store.get<QuestionRecord>(
        `SELECT * FROM question_threads WHERE message_id = ?`,
        input.messageId
      )
      if (!question || question.run_id !== caller.runId) {
        fail(this.context, 'question_not_found', `question ${input.messageId} does not belong to Run ${caller.runId}`, {
          messageId: input.messageId,
          runId: caller.runId
        })
      }
      return this.answerQuestion(question, input, caller)
    })
    if (!result.mutation.replayed && result.kind === 'question_answer') this.notifyQuestion(result.messageId)
    return result
  }

  async ask(input: AskParams, caller: PluginCaller): Promise<AskResult> {
    const verified = await verifyCaller(this.context, caller, input)
    const connection = this.requireConnection(caller)
    const timeoutMs = this.askTimeout(input.timeoutMs)
    const params = { ...input, timeoutMs } as unknown as MutationRequest & Record<string, unknown>
    return this.core.mutate(
      'ask',
      params,
      verified.evidence,
      () => this.beginAsk(input, verified.evidence, timeoutMs),
      {
        acceptedCheckpoint: (accepted) => ({
          state: 'accepted',
          accepted: true,
          answer: null,
          messageId: accepted.messageId,
          threadId: accepted.threadId,
          timeoutMs
        }),
        afterCommit: async (accepted) => {
          if (input.mode !== 'resume') {
            const question = this.getMessage(accepted.messageId)
            this.onCommitted({ mailbox: question.mailbox, messageId: question.id, type: question.type })
          }
          if (accepted.state === 'answered') return accepted
          return this.waitForAnswer(accepted, verified.evidence, timeoutMs, connection)
        }
      }
    )
  }

  inbox(input: InboxParams): InboxResult {
    const explicit = input.terminal !== undefined
    const limit = input.limit ?? (explicit ? 100 : 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > READ_LIMIT_MAX) {
      fail(this.context, 'invalid_argument', `inbox limit must be between 1 and ${READ_LIMIT_MAX}`)
    }
    const rows = this.store.all<MessageRecord>(
      `SELECT * FROM messages ${explicit ? 'WHERE mailbox_id = ?' : ''} ORDER BY sequence DESC LIMIT ?`,
      ...(explicit ? [input.terminal!, limit] : [limit])
    )
    const messages = rows.map(messageRow)
    if (input.full) return { full: true, messages, count: messages.length }
    return {
      full: false,
      messages: messages.map(({ body: _body, payload: _payload, ...row }): InboxMessageRow => row),
      count: messages.length
    }
  }

  resetWaiters(mode: 'messages' | 'tasks' | 'all', notifyFederation = true): void {
    for (const [key, waiter] of this.waiters) {
      if (mode === 'all' || mode === 'messages' || (mode === 'tasks' && waiter.mailbox.kind === 'dispatch')) {
        this.waiters.delete(key)
        waiter.wake('reset')
      }
    }
    if (mode === 'all' || mode === 'messages' || mode === 'tasks') {
      for (const [id, waiters] of this.askWaiters) {
        this.askWaiters.delete(id)
        for (const waiter of waiters) waiter.wake()
      }
    }
    if (notifyFederation) this.federationHooks?.reset(mode)
  }

  dispose(): void {
    this.resetWaiters('all', false)
    this.arrivalListeners.clear()
    this.mailboxAvailableListeners.clear()
  }

  pointerCandidates(
    mailbox: Extract<MailboxAddress, { kind: 'run' | 'dispatch' }>,
    reserved: ReadonlySet<MessageType>
  ): { id: MessageId; type: MessageType }[] {
    if (this.hasOutstandingDelivery(mailbox)) return []
    if (this.isUnfilteredWaiter(mailbox)) return []
    if (
      this.store.get<{ operation_id: string }>(
        `SELECT operation_id FROM pointer_operations WHERE mailbox_kind = ? AND mailbox_id = ? AND phase != 'settled' LIMIT 1`,
        mailbox.kind,
        mailboxId(mailbox)
      )
    ) {
      return []
    }
    const excluded = [...reserved]
    const typeClause = excluded.length === 0 ? '' : `AND type NOT IN (${excluded.map(() => '?').join(',')})`
    const rows = this.store.all<{ id: string; type: MessageType }>(
      `SELECT id, type FROM messages
       WHERE mailbox_kind = ? AND mailbox_id = ? AND read = 0 AND delivered_at IS NULL ${typeClause}
       ORDER BY sequence LIMIT ?`,
      mailbox.kind,
      mailboxId(mailbox),
      ...excluded,
      DELIVERY_BATCH_SIZE
    )
    return rows.map((row) => ({ id: row.id as MessageId, type: row.type }))
  }


  private payloadOf(input: SendParams): JsonValue | null {
    const raw = Object.hasOwn(input, 'payload') && input.payload !== undefined
    const structuredFields = ['taskId', 'dispatchId', 'outcome', 'filesModified', 'reportPath', 'phase'].some((key) => Object.hasOwn(input, key))
    if (raw && structuredFields) fail(this.context, 'invalid_argument', 'raw payload and structured message flags cannot be combined')
    if (raw) return input.payload ?? null
    const payload: Record<string, JsonValue> = {}
    for (const key of ['taskId', 'dispatchId', 'outcome', 'filesModified', 'reportPath', 'phase'] as const) {
      const value = input[key]
      if (value !== undefined) payload[key] = value as JsonValue
    }
    return Object.keys(payload).length === 0 ? null : payload
  }

  private workerDoneInput(input: SendParams, payload: JsonValue | null, messageId: MessageId): WorkerDoneReportInput | WorkerReportRejection {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid_payload'
    const record = payload as Record<string, unknown>
    if (typeof record.taskId !== 'string') return 'missing_task_id'
    if (typeof record.dispatchId !== 'string') return 'missing_dispatch_id'
    if (record.outcome !== 'succeeded' && record.outcome !== 'failed') return 'invalid_outcome'
    if (record.filesModified !== undefined && (!Array.isArray(record.filesModified) || !record.filesModified.every((value) => typeof value === 'string'))) {
      return 'invalid_payload'
    }
    if (record.reportPath !== undefined && typeof record.reportPath !== 'string') return 'invalid_payload'
    return {
      taskId: record.taskId as TaskId,
      dispatchId: record.dispatchId as DispatchId,
      outcome: record.outcome,
      messageId,
      subject: input.subject,
      body: input.body ?? '',
      ...(Array.isArray(record.filesModified) ? { filesModified: record.filesModified as string[] } : {}),
      ...(typeof record.reportPath === 'string' ? { reportPath: record.reportPath } : {})
    }
  }

  private submissionPayload(payload: JsonValue | null): Record<string, unknown> | null {
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null
  }


  private async runSubmissionPreflight(
    submission: OrchestrationSubmission,
  ): Promise<OrchestrationSubmissionVerdict | null> {
    const registration = this.store.get<{ owner_plugin_id: string; method: string }>(
      `SELECT owner_plugin_id, method FROM service_submission_preflights WHERE run_id = ?`,
      submission.runId,
    )
    if (!registration) return null
    if (!registration.method.startsWith(`${registration.owner_plugin_id}/`)) {
      return {
        kind: 'rejected',
        code: 'submission_preflight_unavailable',
        reason: 'Registered submission preflight is outside its owning plugin namespace.',
      }
    }
    try {
      this.core.requireOwnedRun(registration.owner_plugin_id, submission.runId as RunId)
    } catch {
      return {
        kind: 'rejected',
        code: 'submission_preflight_unavailable',
        reason: 'Registered submission preflight no longer belongs to this Run owner.',
      }
    }
    const { promise, reject } = Promise.withResolvers<never>()
    const timeoutMs = registration.method === FEDERATION_SUBMISSION_PREFLIGHT ? 35_000 : 5_000
    const timer = setTimeout(() => reject(new Error('submission preflight timed out')), timeoutMs)
    timer.unref()
    try {
      // This private callback receives the JSON object constructed by the authenticated send path.
      const params = submission as unknown as Record<string, unknown>
      const value = await Promise.race([this.context.call(registration.method, params), promise])
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
          kind: 'rejected',
          code: 'submission_preflight_invalid_response',
          reason: 'Registered submission preflight returned an invalid verdict.',
        }
      }
      const verdict = value as Record<string, unknown>
      if (verdict.kind === 'accepted') return null
      if (verdict.kind === 'rejected' && typeof verdict.code === 'string' && verdict.code.length > 0 &&
        typeof verdict.reason === 'string' && verdict.reason.length > 0) {
        return { kind: 'rejected', code: verdict.code, reason: verdict.reason }
      }
      return {
        kind: 'rejected',
        code: 'submission_preflight_invalid_response',
        reason: 'Registered submission preflight returned an invalid verdict.',
      }
    } catch {
      return {
        kind: 'rejected',
        code: 'submission_preflight_unavailable',
        reason: 'Registered submission preflight did not return an accepted verdict.',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private heartbeatInput(payload: JsonValue | null): WorkerHeartbeatInput | WorkerReportRejection {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid_payload'
    const record = payload as Record<string, unknown>
    if (typeof record.taskId !== 'string') return 'missing_task_id'
    if (typeof record.dispatchId !== 'string') return 'missing_dispatch_id'
    if (record.phase !== undefined && typeof record.phase !== 'string') return 'invalid_payload'
    return {
      taskId: record.taskId as TaskId,
      dispatchId: record.dispatchId as DispatchId,
      ...(typeof record.phase === 'string' ? { phase: record.phase } : {})
    }
  }

  private async resolveTargets(
    input: SendParams,
    type: MessageType,
    sender: SenderContext,
    caller: RuntimeCallerEvidence,
    payload: JsonValue | null
  ): Promise<RoutedTarget[]> {
    if (type === 'worker_done' || type === 'heartbeat') {
      if (isGroup(input.to)) fail(this.context, 'invalid_argument', `${type} messages cannot target a group`)
      const payloadRecord = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
      const reportedDispatchId = typeof payloadRecord?.dispatchId === 'string' ? payloadRecord.dispatchId as DispatchId : null
      const known = reportedDispatchId === null
        ? null
        : this.store.get<{ id: string; run_id: string }>(`SELECT id, run_id FROM dispatches WHERE id = ?`, reportedDispatchId)
      let runId = known?.run_id as RunId | undefined
      if (runId === undefined && input.to?.kind === 'run') runId = input.to.runId
      if (runId === undefined) runId = sender.runId ?? unboundRunId
      if (input.runId !== undefined && input.runId !== runId) {
        fail(this.context, 'dispatch_run_mismatch', `${type} report targets Run ${runId}, not ${input.runId}`, {
          dispatchId: reportedDispatchId,
          runId: input.runId
        })
      }
      if (input.to?.kind === 'run' && input.to.runId !== runId) {
        fail(this.context, 'dispatch_run_mismatch', `${type} report targets Run ${runId}, not ${input.to.runId}`, {
          dispatchId: reportedDispatchId,
          runId: input.to.runId
        })
      }
      if (input.to?.kind === 'dispatch' && reportedDispatchId !== null && input.to.dispatchId !== reportedDispatchId) {
        fail(this.context, 'dispatch_run_mismatch', `${type} report Dispatch does not match --to`, {
          dispatchId: input.to.dispatchId,
          reportedDispatchId
        })
      }
      if (input.to?.kind === 'dispatch') {
        const target = this.store.get<{ run_id: string }>(`SELECT run_id FROM dispatches WHERE id = ?`, input.to.dispatchId)
        if (target && target.run_id !== runId) fail(this.context, 'dispatch_run_mismatch', `${type} report and --to belong to different Runs`)
      }
      if (input.to?.kind === 'session') {
        const target = await this.resolveDirectTarget(input.to, sender.sessionId)
        if (target.runId !== runId) fail(this.context, 'dispatch_run_mismatch', `${type} report and --to belong to different Runs`)
      }
      return [{ mailbox: { kind: 'run', runId }, runId }]
    }
    if (input.to === undefined) {
      if (sender.dispatchId !== null) {
        if (sender.coordinatorRunId !== null) {
          const active = this.activeDispatchFor(sender.sessionId)
          if (!active || active.id !== sender.dispatchId) {
            fail(this.context, 'consumer_fenced', `caller no longer owns Dispatch ${sender.dispatchId}`, { dispatchId: sender.dispatchId })
          }
          this.assertDispatchOwner(active, caller)
        }
        const dispatch = this.core.getDispatch(sender.dispatchId as DispatchId)
        return [{ mailbox: { kind: 'run', runId: dispatch.runId }, runId: dispatch.runId }]
      }
      fail(this.context, 'run_required', 'send needs --to or an active Dispatch with an owning Run')
    }
    if (isGroup(input.to)) return this.resolveGroup(input, type, sender, caller, input.to)
    const target = await this.resolveDirectTarget(input.to, sender.sessionId)
    this.assertAddressRun(input, target, sender)
    return [target]
  }

  private async resolveDirectTarget(target: Exclude<SendParams['to'], GroupAddress | undefined>, senderSessionId: string | null): Promise<RoutedTarget> {
    if (target.kind === 'run') {
      if (target.runId === unboundRunId) return { mailbox: target, runId: unboundRunId }
      const run = this.core.getRun(target.runId)
      return { mailbox: target, runId: run.id }
    }
    if (target.kind === 'dispatch') {
      const dispatch = this.core.getDispatch(target.dispatchId)
      if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
        fail(this.context, 'dispatch_inactive', `Dispatch ${target.dispatchId} is no longer active`, { dispatchId: target.dispatchId, runId: dispatch.runId })
      }
      return { mailbox: target, runId: dispatch.runId }
    }
    const identity = await targetIdentity(this.context, target.sessionId)
    if (target.sessionId === senderSessionId) return { mailbox: target, runId: unboundRunId }
    const currentCoordinator = this.core.store.get<{ id: string }>(
      `SELECT id FROM runs WHERE coordinator_session_id = ? AND id != 'run_unbound' LIMIT 1`,
      target.sessionId
    )
    if (currentCoordinator) {
      const runId = currentCoordinator.id as RunId
      return { mailbox: { kind: 'run', runId }, runId }
    }
    const active = this.core.store.get<{ id: string; run_id: string }>(
      `SELECT id, run_id FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched') ORDER BY created_at DESC, id DESC LIMIT 1`,
      target.sessionId
    )
    if (active) {
      const dispatchId = active.id as MessageRow['sender'] extends { kind: 'dispatch'; dispatchId: infer D } ? D : never
      return { mailbox: { kind: 'dispatch', dispatchId }, runId: active.run_id as RunId }
    }
    const runs = this.core.store.all<{ id: string; coordinator_history_json: string }>(`SELECT id, coordinator_history_json FROM runs WHERE id != 'run_unbound'`)
    for (const run of runs) {
      if ((JSON.parse(run.coordinator_history_json) as string[]).includes(target.sessionId)) {
        return { mailbox: { kind: 'run', runId: run.id as RunId }, runId: run.id as RunId }
      }
    }
    return { mailbox: { kind: 'session', sessionId: identity.sessionId }, runId: unboundRunId }
  }

  private async resolveGroup(input: SendParams, type: MessageType, sender: SenderContext, caller: RuntimeCallerEvidence, target: GroupAddress): Promise<RoutedTarget[]> {
    if (GROUP_FORBIDDEN[type] === true) fail(this.context, 'invalid_argument', `${type} messages cannot target a group`)
    const groupRun = sender.coordinatorRunId !== null
      ? this.core.getRun(sender.coordinatorRunId)
      : sender.dispatchId !== null
        ? this.core.getRun(this.core.getDispatch(sender.dispatchId as never).runId)
        : null
    if (target.group !== 'worktree' && groupRun === null) fail(this.context, 'invalid_argument', 'group mail requires a Run-bound coordinator or worker')
    if (input.runId !== undefined && groupRun?.id !== input.runId) {
      fail(this.context, 'recipient_run_mismatch', `group membership is limited to the sender's Run`, { runId: input.runId, senderRunId: groupRun?.id ?? null })
    }
    const candidates: { sessionId: string; runId: RunId }[] = []
    if (target.group === 'worktree') {
      const sessions = (await this.context.call('quirky.session/list', { worktree: target.worktreeId })) as { id: string; status: string }[]
      for (const session of sessions) {
        if (session.status === 'exited') continue
        candidates.push({ sessionId: session.id, runId: groupRun?.id ?? unboundRunId })
      }
    } else {
      const dispatches = this.core.store.all<{ id: string; run_id: string; assignee_session_id: string | null }>(
        `SELECT id, run_id, assignee_session_id FROM dispatches WHERE run_id = ? AND status IN ('pending', 'dispatched') AND assignee_session_id IS NOT NULL ORDER BY created_at, id`,
        groupRun!.id
      )
      for (const dispatch of dispatches) {
        if (!dispatch.assignee_session_id || dispatch.assignee_session_id === sender.sessionId || dispatch.assignee_session_id === groupRun!.coordinatorSessionId) continue
        let identity: SessionIdentity
        try {
          identity = await targetIdentity(this.context, dispatch.assignee_session_id)
        } catch {
          continue
        }
        if (target.group === 'provider' && identity.providerId !== target.providerId) continue
        if (target.group === 'idle') {
          let explanation: unknown
          try {
            explanation = await this.context.call('quirky.agent-status/explain', { session: identity.sessionId })
          } catch {
            continue
          }
          if (typeof explanation !== 'object' || explanation === null || Array.isArray(explanation)) continue
          const explained = explanation as Record<string, unknown>
          if (
            explained.state !== 'idle' ||
            typeof explained.screen !== 'object' ||
            explained.screen === null ||
            Array.isArray(explained.screen)
          ) {
            continue
          }
          const screen = explained.screen as Record<string, unknown>
          if (screen.pendingQuiet !== undefined || screen.unavailable !== undefined) continue
        }
        candidates.push({ sessionId: identity.sessionId, runId: groupRun!.id })
      }
    }
    const unique = new Set<string>()
    const targets: RoutedTarget[] = []
    for (const candidate of candidates) {
      if (candidate.sessionId === sender.sessionId || candidate.sessionId === groupRun?.coordinatorSessionId) continue
      let routed: RoutedTarget
      try {
        routed = await this.resolveDirectTarget({ kind: 'session', sessionId: candidate.sessionId }, sender.sessionId)
      } catch {
        continue
      }
      const key = mailboxKey(routed.mailbox)
      if (unique.has(key)) continue
      unique.add(key)
      targets.push(routed)
    }
    if (targets.length === 0) fail(this.context, 'terminal_not_found', `group ${target.group} has no eligible live recipients`)
    void caller
    return targets
  }


  private messageSender(type: MessageType, payload: JsonValue | null, sender: SenderContext): MailboxAddress {
    if ((type === 'worker_done' || type === 'heartbeat') && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const dispatchId = (payload as Record<string, unknown>).dispatchId
      if (typeof dispatchId === 'string') return { kind: 'dispatch', dispatchId: dispatchId as DispatchId }
    }
    return sender.sender
  }

  private insertMessage(input: {
    id?: MessageId
    runId: RunId
    fromSessionId: string | null
    sender: MailboxAddress
    mailbox: MailboxAddress
    subject: string
    body: string
    type: MessageType
    priority: MessagePriority
    threadId: string | null
    payload: JsonValue | null
    read: boolean
  }): MessageRow {
    if (input.runId === unboundRunId) this.ensureUnboundRun()
    const id = input.id ?? (newId('msg') as MessageId)
    const at = now()
    this.store.run(
      `INSERT INTO messages (
        id, run_id, from_session_id, sender_kind, sender_id, mailbox_kind, mailbox_id,
        subject, body, type, priority, thread_id, payload_json, read, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.runId,
      input.fromSessionId,
      input.sender.kind,
      mailboxId(input.sender),
      input.mailbox.kind,
      mailboxId(input.mailbox),
      input.subject,
      input.body,
      input.type,
      input.priority,
      input.threadId,
      input.payload === null ? null : jsonText(input.payload),
      input.read ? 1 : 0,
      at
    )
    return this.getMessage(id)
  }

  private getMessage(id: MessageId): MessageRow {
    const row = this.store.get<MessageRecord>(`SELECT * FROM messages WHERE id = ?`, id)
    if (!row) fail(this.context, 'lifecycle_not_found', `message ${id} does not exist`, { messageId: id })
    return messageRow(row)
  }

  private ensureUnboundRun(): void {
    if (this.store.get<{ id: string }>(`SELECT id FROM runs WHERE id = ?`, unboundRunId)) return
    const at = now()
    this.store.run(
      `INSERT INTO runs (id, objective, coordinator_session_id, coordinator_history_json, consumer_generation, created_at, updated_at)
       VALUES (?, 'Mail from unbound senders', NULL, '[]', 0, ?, ?)`,
      unboundRunId,
      at,
      at
    )
  }

  private markRejectedReport(
    id: MessageId,
    originalType: MessageType,
    subject: string,
    payload: JsonValue | null,
    reason: string,
    lifecycle?: { action: 'rejected'; code: string; reason: string },
  ): void {
    const lifecycleMarker = lifecycle === undefined ? {} : { _orcaLifecycle: lifecycle }
    const rejectionPayload = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...(payload as Record<string, JsonValue>), _orcaLifecycleRejection: reason, ...lifecycleMarker }
      : { originalPayload: payload, _orcaLifecycleRejection: reason, ...lifecycleMarker }
    this.store.run(
      `UPDATE messages SET type = 'status', priority = 'high', subject = ?, body = ?, payload_json = ? WHERE id = ?`,
      `Rejected ${originalType}: ${subject}`,
      `Quirky rejected this ${originalType} report: ${reason}`,
      jsonText(rejectionPayload),
      id
    )
  }

  private readMessages(mailbox: MailboxAddress, mode: 'peek' | 'all', limit = READ_LIMIT_MAX, types?: readonly MessageType[]): MessageRow[] {
    const maximum = limit ?? READ_LIMIT_MAX
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > READ_LIMIT_MAX) {
      fail(this.context, 'invalid_argument', `message limit must be between 1 and ${READ_LIMIT_MAX}`)
    }
    const typeClause = types === undefined ? '' : types.length === 0 ? 'AND 0' : `AND type IN (${types.map(() => '?').join(',')})`
    const values: (string | number)[] = [mailbox.kind, mailboxId(mailbox), ...(types ?? []), maximum]
    const rows = this.store.all<MessageRecord>(
      `SELECT * FROM messages WHERE mailbox_kind = ? AND mailbox_id = ? ${mode === 'peek' ? 'AND read = 0' : ''} ${typeClause} ORDER BY sequence ${mode === 'all' ? 'DESC' : 'ASC'} LIMIT ?`,
      ...values
    )
    return rows.map(messageRow)
  }

  private async resolveReadMailbox(runId: RunId | undefined, caller: PluginCaller): Promise<{ mailbox: MailboxAddress; runId: RunId | null }> {
    if (runId !== undefined) {
      this.core.getRun(runId)
      return { mailbox: { kind: 'run', runId }, runId }
    }
    if (caller.role === 'plugin' || caller.sessionId === undefined) return { mailbox: { kind: 'session', sessionId: '' }, runId: null }
    const sessionId = caller.sessionId
    const bound = this.core.getBoundRun(sessionId)
    if (bound) return { mailbox: { kind: 'run', runId: bound.id }, runId: bound.id }
    const active = this.core.store.get<{ id: string; run_id: string }>(
      `SELECT id, run_id FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched') ORDER BY depth DESC, created_at DESC, id DESC LIMIT 1`,
      sessionId
    )
    if (active) return { mailbox: { kind: 'dispatch', dispatchId: active.id as MessageRow['sender'] extends { kind: 'dispatch'; dispatchId: infer D } ? D : never }, runId: active.run_id as RunId }
    return { mailbox: { kind: 'session', sessionId }, runId: unboundRunId }
  }


  private nextDelivery(
    mailbox: MailboxAddress,
    generation: number,
    runId: RunId | null,
    types?: readonly MessageType[]
  ): { delivery: DeliveryRow; messages: MessageRow[]; replayed: boolean } | null {
    const outstanding = this.store.all<DeliveryRecord>(
      `SELECT * FROM deliveries WHERE mailbox_kind = ? AND mailbox_id = ? AND status = 'outstanding' ORDER BY created_at`,
      mailbox.kind,
      mailboxId(mailbox)
    )
    for (const record of outstanding) {
      const ids = jsonOf<MessageId[]>(record.message_ids_json, [])
      const unread = ids.some((id) => this.store.get<{ read: number }>(`SELECT read FROM messages WHERE id = ?`, id)?.read === 0)
      if (record.consumer_generation !== generation) {
        this.store.run(`UPDATE deliveries SET status = 'fenced' WHERE id = ?`, record.id)
        continue
      }
      if (!unread) {
        this.store.run(`UPDATE deliveries SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?`, now(), record.id)
        continue
      }
      const rows = ids.map((id) => this.getMessage(id))
      return { delivery: deliveryRow(record), messages: rows, replayed: true }
    }
    if (types !== undefined) {
      if (types.length === 0) return null
      const matches = this.store.get<{ id: string }>(
        `SELECT id FROM messages
         WHERE mailbox_kind = ? AND mailbox_id = ? AND read = 0 AND type IN (${types.map(() => '?').join(',')})
         LIMIT 1`,
        mailbox.kind,
        mailboxId(mailbox),
        ...types
      )
      if (!matches) return null
    }

    const rows = this.store.all<MessageRecord>(
      `SELECT * FROM messages WHERE mailbox_kind = ? AND mailbox_id = ? AND read = 0 ORDER BY sequence ASC LIMIT ?`,
      mailbox.kind,
      mailboxId(mailbox),
      DELIVERY_BATCH_SIZE
    )
    if (rows.length === 0) return null
    const id = newId('delivery') as DeliveryId
    const at = now()
    const ids = rows.map((row) => row.id as MessageId)
    const deliveryRun = runId ?? (mailbox.kind === 'run' ? mailbox.runId : unboundRunId)
    this.store.run(
      `INSERT INTO deliveries (id, run_id, mailbox_kind, mailbox_id, consumer_generation, message_ids_json, status, created_at, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, 'outstanding', ?, NULL)`,
      id,
      deliveryRun,
      mailbox.kind,
      mailboxId(mailbox),
      generation,
      jsonText(ids),
      at
    )
    const record: DeliveryRecord = {
      id,
      run_id: deliveryRun,
      mailbox_kind: mailbox.kind,
      mailbox_id: mailboxId(mailbox),
      consumer_generation: generation,
      message_ids_json: jsonText(ids),
      status: 'outstanding',
      created_at: at,
      acknowledged_at: null
    }
    return { delivery: deliveryRow(record), messages: rows.map(messageRow), replayed: false }
  }

  private acknowledge(deliveryId: DeliveryId, mailbox: MailboxAddress, generation: number): DeliveryId {
    const delivery = this.store.get<DeliveryRecord>(`SELECT * FROM deliveries WHERE id = ?`, deliveryId)
    if (!delivery) fail(this.context, 'stale_delivery', `Delivery ${deliveryId} does not exist`, { deliveryId })
    if (delivery.mailbox_kind !== mailbox.kind || delivery.mailbox_id !== mailboxId(mailbox)) {
      fail(this.context, 'stale_delivery', `Delivery ${deliveryId} belongs to another mailbox`, { deliveryId })
    }
    if (delivery.status === 'fenced' || delivery.consumer_generation !== generation) {
      fail(this.context, 'consumer_fenced', `Delivery ${deliveryId} belongs to an earlier consumer generation`, { deliveryId })
    }
    if (delivery.status === 'acknowledged') return deliveryId
    const at = now()
    const ids = jsonOf<MessageId[]>(delivery.message_ids_json, [])
    for (const id of ids) this.store.run(`UPDATE messages SET read = 1 WHERE id = ?`, id)
    const update = this.store.run(
      `UPDATE deliveries SET status = 'acknowledged', acknowledged_at = ? WHERE id = ? AND status = 'outstanding' AND consumer_generation = ?`,
      at,
      deliveryId,
      generation
    )
    if (update.changes !== 1) fail(this.context, 'consumer_fenced', `Delivery ${deliveryId} changed before acknowledgement`, { deliveryId })
    return deliveryId
  }

  private hasOutstandingDelivery(mailbox: MailboxAddress): boolean {
    const deliveries = this.store.all<DeliveryRecord>(
      `SELECT * FROM deliveries WHERE mailbox_kind = ? AND mailbox_id = ? AND status = 'outstanding'`,
      mailbox.kind,
      mailboxId(mailbox)
    )
    return deliveries.some((delivery) => jsonOf<MessageId[]>(delivery.message_ids_json, []).some((id) => this.store.get<{ read: number }>(`SELECT read FROM messages WHERE id = ?`, id)?.read === 0))
  }

  private async waitForMailbox(
    accepted: CheckCoreResult,
    resolved: ConsumerMailbox,
    types: readonly MessageType[] | undefined,
    timeoutMs: number | undefined,
    connection: CallerConnection | undefined,
    format: boolean | undefined,
    caller: CoordinatorAuthority,
    reservationToken: symbol | null
  ): Promise<CheckCoreResult> {
    if (accepted.deliveryId !== null) return accepted
    const duration = timeoutMs ?? DEFAULT_CHECK_WAIT_MS
    if (!Number.isInteger(duration) || duration < 0 || duration > MAX_ASK_WAIT_MS) {
      fail(this.context, 'invalid_argument', 'check timeoutMs must be an integer between 0 and 1800000')
    }
    const key = mailboxKey(resolved.mailbox)
    const reservation = this.waiterReservations.get(key)
    if (this.waiters.has(key) || (reservation !== undefined && reservation !== reservationToken)) {
      return { ...accepted, waitInterrupted: 'waiter_exists', cancelled: true }
    }

    const deadline = Date.now() + duration
    let resolveWake: ((outcome: WaitOutcome) => void) | null = null
    let pendingOutcome: WaitOutcome | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    const waiter: MailboxWaiter = {
      id: this.nextWaiterId++,
      mailbox: resolved.mailbox,
      caller,
      types: types === undefined ? null : new Set(types),
      wake(outcome) {
        if (resolveWake !== null) {
          const resolve = resolveWake
          resolveWake = null
          resolve(outcome)
        } else if (pendingOutcome === null || outcome !== 'message') {
          pendingOutcome = outcome
        }
      }
    }
    this.waiters.set(key, waiter)
    timer = setTimeout(() => waiter.wake('timeout'), duration)
    if (connection) unsubscribe = connection.onClose(() => waiter.wake('connection'))

    const interrupted = (outcome: WaitOutcome): CheckCoreResult | null => {
      if (outcome === 'timeout') return { ...accepted, timedOut: true }
      if (outcome === 'connection') return { ...accepted, cancelled: true, connectionLost: true }
      if (outcome === 'fenced' || outcome === 'reset') {
        return { ...accepted, cancelled: true, waitInterrupted: 'consumer_fenced' }
      }
      return null
    }

    try {
      while (true) {
        let currentGeneration: number
        try {
          currentGeneration = this.currentGeneration(resolved.mailbox)
        } catch {
          return { ...accepted, cancelled: true, waitInterrupted: 'consumer_fenced' }
        }
        if (currentGeneration !== resolved.generation) {
          return { ...accepted, cancelled: true, waitInterrupted: 'consumer_fenced' }
        }
        const batch = this.store.transaction(() =>
          this.nextDelivery(resolved.mailbox, resolved.generation, resolved.runId, types)
        )
        if (batch) {
          return {
            ...accepted,
            messages: batch.messages,
            count: batch.messages.length,
            deliveryId: batch.delivery.id,
            replayed: batch.replayed,
            ...(format ? { formatted: batch.messages.map(formatMessage).join('\\n\\n') } : {})
          }
        }
        if (pendingOutcome !== null) {
          const outcome = pendingOutcome
          pendingOutcome = null
          const result = interrupted(outcome)
          if (result) return result
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) return { ...accepted, timedOut: true }
        const { promise, resolve } = Promise.withResolvers<WaitOutcome>()
        resolveWake = resolve
        if (pendingOutcome !== null) {
          const pending = pendingOutcome
          pendingOutcome = null
          const wake = resolveWake
          resolveWake = null
          wake?.(pending)
        }
        const outcome = await promise
        const result = interrupted(outcome)
        if (result) return result
      }
    } finally {
      clearTimeout(timer)
      unsubscribe()
      if (this.waiters.get(key) === waiter) this.waiters.delete(key)
      this.notifyMailboxAvailable(resolved.mailbox)
    }
  }

  private currentGeneration(mailbox: MailboxAddress): number {
    if (mailbox.kind === 'run') return this.core.getRun(mailbox.runId).consumerGeneration
    if (mailbox.kind === 'dispatch') return this.core.getDispatch(mailbox.dispatchId as never).consumerGeneration
    return 0
  }


  private requireConnection(caller: PluginCaller): CallerConnection {
    if (caller.role === 'plugin' || caller.connection === undefined) {
      fail(this.context, 'invalid_argument', 'this wait method requires a live client connection')
    }
    return caller.connection
  }

  private answerQuestion(question: QuestionRecord, input: ReplyParams, caller: CoordinatorAuthority): ReplyValue {
    if (input.runId !== undefined && input.runId !== question.run_id) {
      fail(this.context, 'dispatch_run_mismatch', `question ${question.message_id} belongs to Run ${question.run_id}, not ${input.runId}`, {
        messageId: question.message_id,
        runId: input.runId
      })
    }
    const run = this.core.requireCoordinator(caller, question.run_id as RunId)
    const original = this.store.get<MessageRecord>(`SELECT * FROM messages WHERE id = ?`, question.message_id)
    if (!original) fail(this.context, 'lifecycle_not_found', `question message ${question.message_id} does not exist`, { messageId: question.message_id })
    const threadId = original.thread_id ?? original.id
    if (question.status === 'answered') {
      if (question.answer_body !== input.body) {
        fail(this.context, 'answer_conflict', `question ${question.message_id} already has a different answer`, { messageId: question.message_id })
      }
      if (!question.answer_message_id) {
        fail(this.context, 'lifecycle_conflict', `question ${question.message_id} has no stored answer message`, { messageId: question.message_id })
      }
      return {
        kind: 'question_answer',
        messageId: question.message_id as QuestionId,
        answerMessageId: question.answer_message_id as MessageId,
        threadId,
        duplicate: true
      }
    }
    if (question.status === 'closed') {
      fail(this.context, 'dispatch_inactive', `question ${question.message_id} belongs to a settled Dispatch`, {
        messageId: question.message_id,
        dispatchId: question.dispatch_id
      })
    }
    const dispatch = this.core.getDispatch(question.dispatch_id as DispatchId)
    if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
      fail(this.context, 'dispatch_inactive', `Dispatch ${dispatch.id} is no longer active`, { dispatchId: dispatch.id })
    }
    const answer = this.insertMessage({
      runId: question.run_id as RunId,
      fromSessionId: 'kind' in caller ? null : caller.runtimeSessionId,
      sender: { kind: 'run', runId: run.id },
      mailbox: { kind: 'dispatch', dispatchId: question.dispatch_id as DispatchId },
      subject: 'Re: Question',
      body: input.body,
      type: 'question',
      priority: 'normal',
      threadId,
      payload: null,
      read: true
    })
    const at = now()
    const update = this.store.run(
      `UPDATE question_threads
       SET status = 'answered', answer_message_id = ?, answer_body = ?, answered_by_generation = ?, answered_at = ?
       WHERE message_id = ? AND status = 'pending'`,
      answer.id,
      input.body,
      run.consumerGeneration,
      at,
      question.message_id
    )
    if (update.changes !== 1) {
      fail(this.context, 'lifecycle_conflict', `question ${question.message_id} changed while it was being answered`, {
        messageId: question.message_id
      })
    }
    this.federationHooks?.afterQuestionAnswered(question.message_id, answer)
    return {
      kind: 'question_answer',
      messageId: question.message_id as QuestionId,
      answerMessageId: answer.id,
      threadId,
      duplicate: false
    }
  }

  private replyOrdinary(input: ReplyParams, caller: RuntimeCallerEvidence, target: RoutedTarget): ReplyValue {
    const original = this.store.get<MessageRecord>(`SELECT * FROM messages WHERE id = ?`, input.messageId)
    if (!original) fail(this.context, 'lifecycle_not_found', `message ${input.messageId} does not exist`, { messageId: input.messageId })
    if (input.runId !== undefined && input.runId !== original.run_id) {
      fail(this.context, 'recipient_run_mismatch', `message ${input.messageId} belongs to Run ${original.run_id}, not ${input.runId}`, {
        messageId: input.messageId,
        runId: input.runId,
        recipientRunId: original.run_id
      })
    }
    this.assertMailboxOwner(mailboxOfRow(original), caller)
    this.assertResolvedTarget(target)
    const threadId = original.thread_id ?? original.id
    const sender = this.senderContext(caller)
    this.store.run(`UPDATE messages SET read = 1 WHERE id = ?`, original.id)
    this.notifyMailboxAvailable(mailboxOfRow(original))
    const replyMessage = this.insertMessage({
      runId: sender.runId ?? unboundRunId,
      fromSessionId: caller.runtimeSessionId,
      sender: sender.sender,
      mailbox: target.mailbox,
      subject: `Re: ${original.subject}`,
      body: input.body,
      type: 'status',
      priority: 'normal',
      threadId,
      payload: null,
      read: false
    })
    this.federationHooks?.afterReply(input.messageId, replyMessage, caller)
    return { kind: 'ordinary_reply', messageId: original.id as MessageId, replyMessage, threadId }
  }

  private async waitQuestion(
    messageId: QuestionId,
    timeoutMs: number,
    connection: CallerConnection
  ): Promise<{ outcome: WaitOutcome; question: QuestionRecord | null }> {
    const initial = this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, messageId)
    if (!initial) fail(this.context, 'question_not_found', `question ${messageId} does not exist`, { messageId })
    if (initial.status !== 'pending') return { outcome: 'message', question: initial }
    let set = this.askWaiters.get(messageId)
    if (!set) this.askWaiters.set(messageId, (set = new Set()))
    const { promise, resolve } = Promise.withResolvers<WaitOutcome>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    let settled = false
    const finish = (outcome: WaitOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      set!.delete(waiter)
      if (set!.size === 0) this.askWaiters.delete(messageId)
      resolve(outcome)
    }
    const waiter: AskWaiter = { id: this.nextWaiterId++, wake: () => finish('message') }
    set.add(waiter)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    unsubscribe = connection.onClose(() => finish('connection'))
    if (settled) unsubscribe()
    const current = this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, messageId)
    if (!current || current.status !== 'pending') waiter.wake()
    const outcome = await promise
    return { outcome, question: this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, messageId) }
  }

  private beginAsk(input: AskParams, caller: RuntimeCallerEvidence, timeoutMs: number): AskValue {
    const dispatch = this.activeDispatchFor(caller.runtimeSessionId)
    if (!dispatch || dispatch.assignee_session_id !== caller.runtimeSessionId) {
      fail(this.context, 'dispatch_inactive', 'ask requires an active Dispatch owned by the caller')
    }
    this.assertDispatchOwner(dispatch, caller)
    if (input.runId !== undefined && input.runId !== dispatch.run_id) {
      fail(this.context, 'dispatch_run_mismatch', `ask from Dispatch ${dispatch.id} must target Run ${dispatch.run_id}`, {
        dispatchId: dispatch.id,
        runId: input.runId
      })
    }
    if (input.to !== undefined && input.to.runId !== dispatch.run_id) {
      fail(this.context, 'dispatch_run_mismatch', `ask from Dispatch ${dispatch.id} must target Run ${dispatch.run_id}`, {
        dispatchId: dispatch.id,
        runId: input.to.runId
      })
    }
    if (input.mode === 'resume') {
      const question = this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, input.messageId)
      if (!question || question.dispatch_id !== dispatch.id || question.run_id !== dispatch.run_id) {
        fail(this.context, 'question_not_found', `question ${input.messageId} does not belong to this Dispatch`, { messageId: input.messageId })
      }
      if (question.status === 'closed') {
        fail(this.context, 'dispatch_inactive', `Dispatch ${dispatch.id} settled while the question was pending`, { dispatchId: dispatch.id })
      }
      const message = this.getMessage(question.message_id as MessageId)
      if (question.status === 'answered') {
        return {
          state: 'answered',
          answer: question.answer_body!,
          messageId: question.message_id as QuestionId,
          answerMessageId: question.answer_message_id as MessageId,
          threadId: message.threadId ?? message.id,
          timeoutMs
        }
      }
      return {
        state: 'cancelled',
        answer: null,
        messageId: question.message_id as QuestionId,
        threadId: message.threadId ?? message.id,
        timeoutMs
      }
    }

    const messageId = newId('msg') as QuestionId
    const threadId = messageId
    const options = [...(input.options ?? [])]
    const at = now()
    const message = this.insertMessage({
      id: messageId,
      runId: dispatch.run_id as RunId,
      fromSessionId: caller.runtimeSessionId,
      sender: { kind: 'dispatch', dispatchId: dispatch.id as DispatchId },
      mailbox: { kind: 'run', runId: dispatch.run_id as RunId },
      subject: 'Question',
      body: input.question,
      type: 'question',
      priority: 'normal',
      threadId,
      payload: { taskId: dispatch.task_id as TaskId, dispatchId: dispatch.id as DispatchId, question: input.question, options },
      read: false
    })
    this.store.run(
      `INSERT INTO question_threads (message_id, run_id, dispatch_id, asker_session_id, status, answer_message_id, answer_body, answered_by_generation, created_at, answered_at, closed_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL)`,
      message.id,
      dispatch.run_id,
      dispatch.id,
      caller.runtimeSessionId,
      at
    )
    this.federationHooks?.afterQuestionCreated(message, caller)
    return { state: 'cancelled', answer: null, messageId, threadId, timeoutMs }
  }

  private async waitForAnswer(
    accepted: AskValue,
    caller: RuntimeCallerEvidence,
    timeoutMs: number,
    connection: CallerConnection
  ): Promise<AskValue> {
    const messageId = accepted.messageId
    const question = this.store.get<QuestionRecord>(`SELECT * FROM question_threads WHERE message_id = ?`, messageId)
    if (!question) fail(this.context, 'question_not_found', `question ${messageId} does not exist`, { messageId })
    if (question.status === 'answered') {
      return {
        state: 'answered',
        answer: question.answer_body!,
        messageId,
        answerMessageId: question.answer_message_id as MessageId,
        threadId: accepted.threadId,
        timeoutMs
      }
    }
    if (question.status === 'closed') return { ...accepted, state: 'cancelled', answer: null, timeoutMs }
    const dispatch = this.activeDispatchFor(caller.runtimeSessionId)
    if (!dispatch || question.dispatch_id !== dispatch.id || dispatch.assignee_session_id !== caller.runtimeSessionId) {
      return { ...accepted, state: 'cancelled', answer: null, timeoutMs }
    }
    if (dispatch.supervised) {
      const worker = this.core.workerForDispatch(dispatch.id as DispatchId)
      if (!worker || worker.state === 'stopping' || worker.state === 'stop_unknown' || worker.state === 'stopped' || worker.state === 'abandoned') {
        return { ...accepted, state: 'cancelled', answer: null, timeoutMs }
      }
    }
    const waited = await this.waitQuestion(messageId, timeoutMs, connection)
    if (!waited.question) {
      if (waited.outcome === 'connection') return { ...accepted, state: 'connectionLost', answer: null, timeoutMs }
      if (waited.outcome === 'timeout') return { ...accepted, state: 'timedOut', answer: null, timeoutMs }
      return { ...accepted, state: 'cancelled', answer: null, timeoutMs }
    }
    if (waited.question.status === 'answered') {
      return {
        state: 'answered',
        answer: waited.question.answer_body!,
        messageId,
        answerMessageId: waited.question.answer_message_id as MessageId,
        threadId: accepted.threadId,
        timeoutMs
      }
    }
    if (waited.question.status === 'closed') return { ...accepted, state: 'cancelled', answer: null, timeoutMs }
    if (waited.outcome === 'connection') return { ...accepted, state: 'connectionLost', answer: null, timeoutMs }
    if (waited.outcome === 'timeout') return { ...accepted, state: 'timedOut', answer: null, timeoutMs }
    return { ...accepted, state: 'cancelled', answer: null, timeoutMs }
  }

  private askTimeout(value: number | undefined): number {
    const timeout = value === undefined ? DEFAULT_ASK_WAIT_MS : Math.max(0, Math.min(MAX_ASK_WAIT_MS, Math.floor(value)))
    if (!Number.isFinite(timeout)) fail(this.context, 'invalid_argument', 'ask timeoutMs must be a finite number')
    return timeout
  }

  private senderContext(caller: RuntimeCallerEvidence, allowLifecycleAudit = false): SenderContext {
    const sessionId = caller.runtimeSessionId
    const bound = this.core.getBoundRun(sessionId)
    const active = this.activeDispatchFor(sessionId)
    if (active && !bound && !allowLifecycleAudit) this.assertDispatchOwner(active, caller)
    const sender: MailboxAddress = bound
      ? { kind: 'run', runId: bound.id }
      : active
        ? { kind: 'dispatch', dispatchId: active.id as MessageRow['sender'] extends { kind: 'dispatch'; dispatchId: infer D } ? D : never }
        : { kind: 'session', sessionId }
    return {
      sessionId,
      runId: bound?.id ?? (active?.run_id as RunId | undefined) ?? null,
      coordinatorRunId: bound?.id ?? null,
      dispatchId: active?.id ?? null,
      sender
    }
  }

  private activeDispatchFor(sessionId: string): ActiveDispatchRecord | null {
    return this.store.get<ActiveDispatchRecord>(
      `SELECT id, run_id, task_id, status, assignee_session_id, consumer_generation, supervised, runtime_epoch, process_incarnation
       FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched')
       ORDER BY depth DESC, created_at DESC, id DESC LIMIT 1`,
      sessionId
    )
  }

  private assertDispatchOwner(dispatch: ActiveDispatchRecord, caller: RuntimeCallerEvidence): void {
    if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
      fail(this.context, 'dispatch_inactive', `Dispatch ${dispatch.id} is no longer active`, { dispatchId: dispatch.id })
    }
    if (
      dispatch.assignee_session_id === null ||
      dispatch.assignee_session_id !== caller.callerSessionId ||
      dispatch.assignee_session_id !== caller.runtimeSessionId
    ) {
      fail(this.context, 'consumer_fenced', `caller does not own Dispatch ${dispatch.id}`, { dispatchId: dispatch.id })
    }
    if (
      dispatch.runtime_epoch === null ||
      dispatch.process_incarnation === null ||
      caller.attestation.runtimeEpoch !== dispatch.runtime_epoch ||
      caller.attestation.processIncarnation !== dispatch.process_incarnation
    ) {
      fail(this.context, 'worker_identity_changed', `caller identity no longer matches Dispatch ${dispatch.id}`, { dispatchId: dispatch.id })
    }
    if (!dispatch.supervised) return
    const worker = this.core.workerForDispatch(dispatch.id as DispatchId)
    if (!worker) fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${dispatch.id} has no worker record`)
    if (worker.state === 'stopping' || worker.state === 'failed' || worker.state === 'succeeded' || worker.state === 'stopped' || worker.state === 'abandoned') {
      fail(this.context, 'dispatch_inactive', `Dispatch ${dispatch.id} worker is ${worker.state}`, { dispatchId: dispatch.id, state: worker.state })
    }
    if (worker.state === 'stop_unknown') {
      fail(this.context, 'consumer_fenced', `Dispatch ${dispatch.id} has an unknown stop outcome`, { dispatchId: dispatch.id })
    }
  }

  private assertMailboxOwner(mailbox: MailboxAddress, caller: RuntimeCallerEvidence): void {
    if (mailbox.kind === 'run') {
      this.core.requireCoordinator(caller, mailbox.runId)
      return
    }
    if (mailbox.kind === 'session') {
      if (mailbox.sessionId !== caller.runtimeSessionId) {
        fail(this.context, 'consumer_fenced', `caller does not own session mailbox ${mailbox.sessionId}`, { sessionId: mailbox.sessionId })
      }
      return
    }
    const dispatch = this.store.get<ActiveDispatchRecord>(
      `SELECT id, run_id, task_id, status, assignee_session_id, consumer_generation, supervised, runtime_epoch, process_incarnation
       FROM dispatches WHERE id = ?`,
      mailbox.dispatchId
    )
    if (!dispatch) fail(this.context, 'dispatch_not_found', `Dispatch ${mailbox.dispatchId} does not exist`, { dispatchId: mailbox.dispatchId })
    this.assertDispatchOwner(dispatch, caller)
  }

  private resolveConsumerMailbox(caller: CoordinatorAuthority, explicitRunId: RunId | undefined, readOnly: boolean): ConsumerMailbox {
    if ('kind' in caller) {
      const run = this.core.requireCoordinator(caller, explicitRunId)
      return { mailbox: { kind: 'run', runId: run.id }, runId: run.id, generation: run.consumerGeneration }
    }
    const active = this.activeDispatchFor(caller.runtimeSessionId)
    if (active) this.assertDispatchOwner(active, caller)
    if (explicitRunId !== undefined) {
      const run = this.core.getRun(explicitRunId)
      if (!readOnly) this.core.requireCoordinator(caller, explicitRunId)
      return { mailbox: { kind: 'run', runId: explicitRunId }, runId: explicitRunId, generation: run.consumerGeneration }
    }
    const bound = this.core.getBoundRun(caller.runtimeSessionId)
    if (bound) return { mailbox: { kind: 'run', runId: bound.id }, runId: bound.id, generation: bound.consumerGeneration }
    if (active) {
      return {
        mailbox: { kind: 'dispatch', dispatchId: active.id as DispatchId },
        runId: active.run_id as RunId,
        generation: active.consumer_generation
      }
    }
    return { mailbox: { kind: 'session', sessionId: caller.runtimeSessionId }, runId: unboundRunId, generation: 0 }
  }

  private assertResolvedTarget(target: RoutedTarget): void {
    if (target.mailbox.kind === 'run') {
      if (target.mailbox.runId === unboundRunId) return
      this.core.getRun(target.mailbox.runId)
      return
    }
    if (target.mailbox.kind !== 'dispatch') return
    const dispatch = this.core.getDispatch(target.mailbox.dispatchId)
    if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') {
      fail(this.context, 'dispatch_inactive', `Dispatch ${dispatch.id} is no longer active`, {
        dispatchId: dispatch.id,
        runId: dispatch.runId
      })
    }
    if (dispatch.runId !== target.runId) {
      fail(this.context, 'dispatch_run_mismatch', `Dispatch ${dispatch.id} changed Runs before delivery`, {
        dispatchId: dispatch.id,
        runId: target.runId
      })
    }
  }

  private assertAddressRun(input: SendParams, target: RoutedTarget, sender: SenderContext): void {
    const recipientRunId = target.runId === unboundRunId ? sender.runId : target.runId
    if (input.runId !== undefined && input.runId !== recipientRunId) {
      fail(this.context, 'recipient_run_mismatch', `recipient belongs to Run ${recipientRunId ?? 'an unbound mailbox'}, not ${input.runId}`, {
        runId: input.runId,
        recipientRunId
      })
    }
  }

  private validateMessageTypes(types: unknown): void {
    if (!Array.isArray(types)) fail(this.context, 'invalid_argument', 'message types must be an array')
    for (const type of types) {
      if (!this.isMessageType(type)) fail(this.context, 'invalid_argument', `unsupported message type ${String(type)}`)
    }
  }

  private isMessageType(value: unknown): value is MessageType {
    return typeof value === 'string' && Object.hasOwn(MESSAGE_TYPES, value)
  }

}
