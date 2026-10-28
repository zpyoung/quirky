/**
 * Inert public contracts for the future `quirky.orchestration` plugin.
 * RPC names are `quirky.orchestration/<method>`; the generated CLI alias is
 * `orchestration`, with the same names rendered as kebab-case verbs.
 * Persisted timestamps are ISO-8601 UTC strings. CLI `--retry-request` maps
 * to `requestId`; the transport supplies `contractVersion`.
 */

export type SessionId = string
export type UtcTimestamp = string
export type UUID = string
export type RunId = `run_${string}`
export type TaskId = `task_${string}`
export type DispatchId = `ctx_${string}`
export type MessageId = `msg_${string}`
export type DeliveryId = `delivery_${string}`
export type GateId = `gate_${string}`
export type QuestionId = MessageId
export type ThreadId = string
export type PointerOperationId = string
export type RunCursor = string

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * These aliases are equality assertions only. Authority always comes from the
 * runtime-attested caller below, never from `from` or `terminal` input fields.
 */
export interface DeclaredCallerAliases {
  from?: SessionId
  terminal?: SessionId
}

/**
 * Constructed only after independent runtime process/launch or structured-lease
 * attestation. Caller metadata plus a live session lookup is insufficient.
 * Provider IDs and request aliases are names, never credentials.
 */
export interface RuntimeCallerEvidence {
  callerSessionId: SessionId
  runtimeSessionId: SessionId
  runtimeOwned: true
  live: true
  attestation: {
    source: 'terminal_launch' | 'structured_lease' | 'restored_authority'
    runtimeEpoch: string
    processIncarnation: string
  }
}

export type ContractVersion = 1

/** Required on durable mutations; there is no caller fingerprint in client input. */
export interface MutationRequest {
  requestId: UUID
  contractVersion: ContractVersion
}

export interface MutationReplay {
  requestId: UUID
  replayed: boolean
}

/** Mutating RPC results retain their native result shape and add the receipt marker. */
export type MutationResult<T> = T & { mutation: MutationReplay }

export type RunCoordinatorAddress = SessionId

/** Public Run row; coordinator history uses stable Quirky session IDs. */
export interface RunRow {
  id: RunId
  objective: string
  coordinatorSessionId: SessionId | null
  coordinatorHistory: readonly RunCoordinatorAddress[]
  consumerGeneration: number
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
}

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
export type WorkerOutcome = 'succeeded' | 'failed'

export type TaskResult =
  | {
      kind: 'coordinator_update'
      text: string
      reportedBy: SessionId
      completedAt: UtcTimestamp
    }
  | {
      kind: 'worker_report'
      outcome: WorkerOutcome
      messageId: MessageId
      dispatchId: DispatchId
      reportedBy: SessionId
      subject: string
      body: string
      completedBy: SessionId
      filesModified: readonly string[]
      reportPath: string | null
      completedAt: UtcTimestamp
    }

/**
 * Public Task row. Dependencies and parent are immutable after creation;
 * dispatch/assignee details are a list projection, not Task authority fields.
 */
export interface TaskRow {
  id: TaskId
  runId: RunId
  parentTaskId: TaskId | null
  dependencyTaskIds: readonly TaskId[]
  createdBySessionId: SessionId
  taskTitle: string
  displayName: string
  spec: string
  status: TaskStatus
  result: TaskResult | null
  createdAt: UtcTimestamp
  completedAt: UtcTimestamp | null
}

export type TaskListRow = TaskRow & {
  dispatchId?: DispatchId
  assigneeSessionId?: SessionId
  /** Present only when the brief projection actually truncates `spec`. */
  specTruncated?: true
}

export type DispatchStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'circuit_broken'
export type DispatchTerminationReason = 'operator_close' | 'signaled' | 'exited' | 'unknown'

/** Public attempt row. Credential hashes, tokens, process incarnations and host stamps are private. */
export interface DispatchRow {
  id: DispatchId
  runId: RunId
  taskId: TaskId
  contractVersion: ContractVersion
  status: DispatchStatus
  /** Null until supervised authority attaches, including a settled pre-launch failure. */
  assigneeSessionId: SessionId | null
  creatorSessionId: SessionId | null
  creatorDispatchId: DispatchId | null
  retryOfDispatchId: DispatchId | null
  depth: number
  failureCount: number
  lastFailure: string | null
  terminationReason: DispatchTerminationReason | null
  consumerGeneration: number
  createdAt: UtcTimestamp
  dispatchedAt: UtcTimestamp | null
  completedAt: UtcTimestamp | null
  lastHeartbeatAt: UtcTimestamp | null
}

export type WorkerState =
  | 'starting'
  | 'ready'
  | 'start_unknown'
  | 'failed'
  | 'succeeded'
  | 'stopping'
  | 'stop_unknown'
  | 'stopped'
  | 'abandoned'

/** Supervised-attempt state; a context-only Dispatch intentionally has no WorkerRow. */
export interface WorkerRow {
  dispatchId: DispatchId
  state: WorkerState
  stage: string
  worktreeId: string | null
  sessionId: SessionId | null
  setupState: string
  effects: readonly JsonValue[]
  residualResources: readonly JsonValue[]
  lastError: string | null
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
}

export type MessageType =
  | 'status'
  | 'dispatch'
  | 'worker_done'
  | 'merge_ready'
  | 'escalation'
  | 'handoff'
  | 'decision_gate'
  | 'question'
  | 'heartbeat'

export type MessagePriority = 'normal' | 'high' | 'urgent'

/** Persisted mailbox addresses are resolved targets, not group selectors. */
export type MailboxAddress =
  | { kind: 'run'; runId: RunId }
  | { kind: 'dispatch'; dispatchId: DispatchId }
  | { kind: 'session'; sessionId: SessionId }

export type GroupAddress =
  | { kind: 'group'; group: 'all' | 'idle' }
  | { kind: 'group'; group: 'provider'; providerId: string }
  | { kind: 'group'; group: 'worktree'; worktreeId: string }

export type SendTarget = MailboxAddress | GroupAddress
export type GroupForbiddenMessageType = 'worker_done' | 'heartbeat' | 'escalation' | 'decision_gate'
export type GroupMessageType = Exclude<MessageType, GroupForbiddenMessageType>

/** Public message row; no internal FIFO sequence or pointer bookkeeping is exposed. */
export interface MessageRow {
  id: MessageId
  runId: RunId
  fromSessionId: SessionId
  /** Canonical role address: questions originate at a Dispatch, answers at a Run. */
  sender: MailboxAddress
  mailbox: MailboxAddress
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  threadId: ThreadId | null
  payload: JsonValue | null
  read: boolean
  createdAt: UtcTimestamp
  deliveredAt: UtcTimestamp | null
}

export type DeliveryStatus = 'outstanding' | 'acknowledged' | 'fenced'

/** One FIFO batch, replayed exactly until acknowledgement or generation fencing. */
export interface DeliveryRow {
  id: DeliveryId
  runId: RunId
  mailbox: MailboxAddress
  consumerGeneration: number
  messageIds: readonly MessageId[]
  status: DeliveryStatus
  createdAt: UtcTimestamp
  acknowledgedAt: UtcTimestamp | null
}

export type QuestionStatus = 'pending' | 'answered' | 'closed'

/** The question's message ID is its stable resumable question ID. */
export interface QuestionThreadRow {
  messageId: QuestionId
  runId: RunId
  dispatchId: DispatchId
  askerSessionId: SessionId
  status: QuestionStatus
  answerMessageId: MessageId | null
  answerBody: string | null
  answeredByGeneration: number | null
  createdAt: UtcTimestamp
  answeredAt: UtcTimestamp | null
  closedAt: UtcTimestamp | null
}

export type GateStatus = 'pending' | 'resolved' | 'timeout'

export interface GateRow {
  id: GateId
  runId: RunId
  taskId: TaskId
  question: string
  options: readonly string[]
  status: GateStatus
  resolution: string | null
  createdBySessionId: SessionId
  createdAt: UtcTimestamp
  resolvedAt: UtcTimestamp | null
}

/** The ledger persists pending/completed; accepted is an explicit checkpoint payload. */
export type MutationReceiptStatus = 'accepted' | 'pending' | 'completed'
export type StoredMutationState = Exclude<MutationReceiptStatus, 'accepted'>
export interface AcceptedAskCheckpoint {
  state: 'accepted'
  accepted: true
  answer: null
  messageId: MessageId
  threadId: ThreadId
  timeoutMs: number
}

/** Durable acceptance for a scoped worker mutation before external process/workspace effects. */
export interface AcceptedWorkerCheckpoint {
  state: 'accepted'
  accepted: true
  runId: RunId
  taskId: TaskId
  dispatchId: DispatchId
}

/** Accepted context-only dispatch before optional external prompt injection. */
export interface AcceptedDispatchCheckpoint {
  state: 'accepted'
  accepted: true
  runId: RunId
  taskId: TaskId
  dispatchId: DispatchId
}

/** Accepted acknowledgement/read boundary before a connection-aware mailbox wait. */
export interface AcceptedCheckCheckpoint {
  state: 'accepted'
  accepted: true
  mailbox: MailboxAddress
  runId: RunId | null
  consumerGeneration: number
  acknowledged: DeliveryId | null
}

export type MutationCheckpoint =
  | AcceptedAskCheckpoint
  | AcceptedWorkerCheckpoint
  | AcceptedDispatchCheckpoint
  | AcceptedCheckCheckpoint

export type MutatingOrchestrationMethod =
  | 'runCreate'
  | 'runUse'
  | 'taskCreate'
  | 'taskUpdate'
  | 'dispatch'
  | 'send'
  | 'check'
  | 'reply'
  | 'ask'
  | 'gateCreate'
  | 'gateResolve'
  | 'workerStart'
  | 'workerStop'
  | 'workerAbandon'
  | 'workerRelease'
  | 'workerRetain'
  | 'reset'

/** Public receipt projection intentionally omits caller fingerprints and payload hashes. */
export interface MutationReceiptRow {
  requestId: UUID
  method: MutatingOrchestrationMethod
  state: StoredMutationState
  checkpoint?: MutationCheckpoint
  result?: JsonValue
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
}

export type RequestShowResult =
  | {
      requestId: UUID
      state: 'completed'
      method: MutatingOrchestrationMethod
      createdAt: UtcTimestamp
      updatedAt: UtcTimestamp
      receipt: MutationReceiptRow
      interpretation: 'completed_and_replayable'
    }
  | {
      requestId: UUID
      state: 'pending'
      method: MutatingOrchestrationMethod
      createdAt: UtcTimestamp
      updatedAt: UtcTimestamp
      receipt: MutationReceiptRow
      interpretation: 'running_or_outcome_unknown'
    }
  | {
      requestId: UUID
      state: 'absent'
      interpretation: 'absence_does_not_prove_no_effect'
    }

export type ResetMode = 'messages' | 'tasks' | 'all'

export type PointerOperationPhase = 'reserved' | 'write_attempted' | 'enter_attempted' | 'settled'

export type PointerOperationResult =
  | { status: 'submitted'; transport: 'terminal_enter' | 'structured_session' }
  | { status: 'text_only'; reason: 'cursor_no_auto_enter' }
  | {
      status: 'deferred'
      reason: 'not_idle' | 'not_quiescent' | 'blocked_dialog' | 'waiter_reserved' | 'delivery_outstanding' | 'flight_active'
    }
  | { status: 'released'; reason: 'recipient_changed' | 'recipient_gone' }
  | {
      status: 'outcome_unknown'
      attemptedPhase: 'write_attempted' | 'enter_attempted'
      retryEnter: false
    }

export type PointerOperationProgress =
  | { phase: 'reserved'; result: null }
  | { phase: 'write_attempted'; result: null }
  | { phase: 'enter_attempted'; result: null }
  | { phase: 'settled'; result: PointerOperationResult }

/** Pointer rows contain command metadata only, never message bodies or session credentials. */
export type PointerOperationRow = {
  mailbox: Extract<MailboxAddress, { kind: 'run' | 'dispatch' }>
  sessionId: SessionId
  operationId: PointerOperationId
  messageIds: readonly MessageId[]
  updatedAt: UtcTimestamp
} & PointerOperationProgress

export type DispatchTransitionInput =
  | {
      dispatchId: DispatchId
      expectedState: 'pending'
      nextState: 'dispatched' | 'completed'
      at: UtcTimestamp
    }
  | {
      dispatchId: DispatchId
      expectedState: 'pending'
      nextState: 'failed'
      failureClass: 'infrastructure' | 'worker_report'
      failureReason?: string
      terminationReason?: DispatchTerminationReason
      at: UtcTimestamp
    }
  | {
      dispatchId: DispatchId
      expectedState: 'pending'
      nextState: 'circuit_broken'
      failureClass: 'infrastructure'
      failureReason?: string
      terminationReason?: DispatchTerminationReason
      at: UtcTimestamp
    }
  | {
      dispatchId: DispatchId
      expectedState: 'dispatched'
      nextState: 'completed'
      at: UtcTimestamp
    }
  | {
      dispatchId: DispatchId
      expectedState: 'dispatched'
      nextState: 'failed'
      failureClass: 'infrastructure' | 'worker_report'
      failureReason?: string
      terminationReason?: DispatchTerminationReason
      at: UtcTimestamp
    }
  | {
      dispatchId: DispatchId
      expectedState: 'dispatched'
      nextState: 'circuit_broken'
      failureClass: 'infrastructure'
      failureReason?: string
      terminationReason?: DispatchTerminationReason
      at: UtcTimestamp
    }

/** Task lifecycle is expected-state guarded; the store enforces active-attempt and worker invariants. */
export interface TaskTransitionInput {
  taskId: TaskId
  expectedState: TaskStatus
  nextState: TaskStatus
  result?: TaskResult | null
  at: UtcTimestamp
}

export type WorkerTransitionInput =
  | {
      dispatchId: DispatchId
      expectedState: 'starting'
      nextState: 'ready' | 'start_unknown' | 'failed' | 'stopping' | 'stopped' | 'abandoned'
    }
  | {
      dispatchId: DispatchId
      expectedState: 'start_unknown'
      nextState: 'ready' | 'failed' | 'stopping' | 'stopped' | 'abandoned'
    }
  | {
      dispatchId: DispatchId
      expectedState: 'ready'
      nextState: 'succeeded' | 'failed' | 'stopping' | 'abandoned'
    }
  | {
      dispatchId: DispatchId
      expectedState: 'stopping'
      nextState: 'stopped' | 'stop_unknown' | 'ready' | 'failed' | 'abandoned'
    }
  | {
      dispatchId: DispatchId
      expectedState: 'stop_unknown'
      nextState: 'ready' | 'failed' | 'stopped' | 'abandoned'
    }
  | {
      /** Sole correction: the worker's own report can correct an unobserved prompt-start failure. */
      dispatchId: DispatchId
      expectedState: 'failed'
      nextState: 'succeeded'
      correction: 'unobserved_prompt_report'
      report: WorkerDoneReportInput
      caller: RuntimeCallerEvidence
    }

export interface WorkerDoneReportInput {
  taskId: TaskId
  dispatchId: DispatchId
  outcome: WorkerOutcome
  messageId: MessageId
  subject: string
  body: string
  filesModified?: readonly string[]
  reportPath?: string
}

export interface WorkerHeartbeatInput {
  taskId: TaskId
  dispatchId: DispatchId
  phase?: string
}

export type WorkerReportRejection =
  | 'stale_dispatch'
  | 'inactive_dispatch'
  | 'worker_identity_changed'
  | 'dispatch_inactive'
  | 'invalid_payload'
  | 'missing_task_id'
  | 'missing_dispatch_id'
  | 'invalid_outcome'
  | 'unknown_task'
  | 'unknown_dispatch'
  | 'task_dispatch_mismatch'
  | 'sender_not_assignee'

export type WorkerReportResult =
  | { status: 'accepted'; task: TaskRow; dispatch: DispatchRow; worker: WorkerRow | null }
  | { status: 'duplicate'; task: TaskRow; dispatch: DispatchRow; worker: WorkerRow | null }
  | { status: 'rejected'; reason: WorkerReportRejection; audited: true }

export type HeartbeatResult =
  | { status: 'accepted'; lastHeartbeatAt: UtcTimestamp }
  | { status: 'rejected'; reason: WorkerReportRejection; lastHeartbeatAt: null }

export interface DispatchAdmissionInput {
  runId?: RunId
  taskId: TaskId
  assigneeSessionId: SessionId
  retryOfDispatchId?: DispatchId
}

export type DispatchAdmissionResult =
  | {
      admitted: true
      depth: number
      failureCount: number
      retryOfDispatchId: DispatchId | null
    }
  | {
      admitted: false
      reason: 'task_not_startable' | 'nested_worker_depth_exceeded'
      attemptedDepth?: number
      maximumDepth?: number
      failureCount?: number
    }

/** Shared synchronously by lifecycle and messaging slices for atomic CAS/report acceptance. */
/** Store adapters use the plugin's single public PluginStore; no parallel store facade is contracted. */
export interface LifecycleCorePort {
  admitDispatch(input: DispatchAdmissionInput, caller: RuntimeCallerEvidence): DispatchAdmissionResult
  transitionTask(input: TaskTransitionInput): TaskRow
  transitionDispatch(input: DispatchTransitionInput): DispatchRow
  transitionWorker(input: WorkerTransitionInput): WorkerRow
  reportWorkerDone(input: WorkerDoneReportInput, caller: RuntimeCallerEvidence): WorkerReportResult
  recordHeartbeat(input: WorkerHeartbeatInput, caller: RuntimeCallerEvidence): HeartbeatResult
}

/** Called by lifecycle/task settlement inside the same synchronous store transaction. */
export interface QuestionSettlementPort {
  closePendingForDispatch(dispatchId: DispatchId, closedAt: UtcTimestamp): readonly QuestionThreadRow[]
}

/** Called only after commit to wake a waiter or schedule a best-effort pointer. */
export interface MessageArrivalPort {
  onCommitted(input: { mailbox: MailboxAddress; messageId: MessageId; type: MessageType }): void | Promise<void>
}

export interface RunCreateParams extends MutationRequest, DeclaredCallerAliases {
  objective: string
}

export interface RunUseParams extends MutationRequest, DeclaredCallerAliases {
  runId: RunId
}

export interface RunCurrentParams extends DeclaredCallerAliases {}

/** The cursor is opaque and stable; page size is bounded to 1..100. */
export interface RunListParams {
  limit?: number
  cursor?: RunCursor
}

export interface RunShowParams {
  runId: RunId
}

/** Runtime enforces the 1,214,464 UTF-8-byte spec ceiling and display-label normalization. */
export interface TaskCreateParams extends MutationRequest, DeclaredCallerAliases {
  runId?: RunId
  spec: string
  taskTitle?: string
  displayName?: string
  dependencyTaskIds?: readonly TaskId[]
  parentTaskId?: TaskId
}

export type TaskListParams = DeclaredCallerAliases & {
  runId?: RunId
  brief?: boolean
} & (
  | { ready: true; status?: never }
  | { ready?: false; status?: TaskStatus }
)

export interface TaskUpdateParams extends MutationRequest, DeclaredCallerAliases {
  runId?: RunId
  taskId: TaskId
  status?: TaskStatus
  result?: string
}

export type DispatchParams = DeclaredCallerAliases
  & {
      runId?: RunId
      taskId: TaskId
      to: SessionId
      inject?: boolean
      returnPreamble?: boolean
    }
  & (
    | { dryRun: true; requestId?: never; contractVersion?: never }
    | { dryRun?: false; requestId: UUID; contractVersion: ContractVersion }
  )

export interface DispatchShowParams extends DeclaredCallerAliases {
  taskId: TaskId
  includePreamble?: boolean
}

export interface SendBase<Target extends SendTarget> extends MutationRequest, DeclaredCallerAliases {
  to?: Target
  runId?: RunId
  subject: string
  body?: string
  priority?: MessagePriority
  threadId?: ThreadId
}

/** Raw payload and structured flags are exclusive; only worker_done accepts an outcome. */
export type MessagePayloadInput =
  | {
      payload?: JsonValue
      taskId?: never
      dispatchId?: never
      filesModified?: never
      reportPath?: never
      phase?: never
    }
  | {
      payload?: never
      taskId?: TaskId
      dispatchId?: DispatchId
      filesModified?: readonly string[]
      reportPath?: string
      phase?: string
    }

export type DirectSendParams = SendBase<MailboxAddress> & MessagePayloadInput & {
  type?: Exclude<MessageType, 'worker_done' | 'heartbeat'>
  outcome?: never
}

export type GroupSendParams = Omit<SendBase<GroupAddress>, 'to'> & MessagePayloadInput & {
  to: GroupAddress
  type?: GroupMessageType
  outcome?: never
}

export type WorkerDoneSendParams = SendBase<MailboxAddress> & {
  type: 'worker_done'
  taskId: TaskId
  dispatchId: DispatchId
  outcome: WorkerOutcome
  filesModified?: readonly string[]
  reportPath?: string
  payload?: never
  phase?: never
}

export type HeartbeatSendParams = SendBase<MailboxAddress> & {
  type: 'heartbeat'
  taskId: TaskId
  dispatchId: DispatchId
  phase?: string
  payload?: never
  outcome?: never
  filesModified?: never
  reportPath?: never
}

/** Lifecycle raw payloads are validated before settlement; invalid reports remain auditable. */
export type LifecyclePayloadSendParams = SendBase<MailboxAddress> & {
  type: 'worker_done' | 'heartbeat'
  payload: JsonValue
  taskId?: never
  dispatchId?: never
  outcome?: never
  filesModified?: never
  reportPath?: never
  phase?: never
}

export type SendParams =
  | DirectSendParams
  | GroupSendParams
  | WorkerDoneSendParams
  | HeartbeatSendParams
  | LifecyclePayloadSendParams

export type SendResult =
  | MutationResult<{ kind: 'message'; messages: readonly MessageRow[]; threadId: ThreadId | null }>
  | MutationResult<{ kind: 'worker_report'; messages: readonly MessageRow[]; report: WorkerReportResult }>
  | MutationResult<{ kind: 'heartbeat'; messages: readonly MessageRow[]; heartbeat: HeartbeatResult }>

export interface CheckCommonParams extends DeclaredCallerAliases {
  runId?: RunId
  terminal?: SessionId
  format?: boolean
}

/** Consuming and acknowledging are durable; an explicit peek/history without ack is read-only. */
export type CheckParams =
  | (CheckCommonParams & MutationRequest & {
      mode: 'consume'
      ackDeliveryId?: DeliveryId
      wait?: boolean
      timeoutMs?: number
      types?: readonly MessageType[]
      limit?: never
    })
  | (CheckCommonParams & {
      mode: 'peek' | 'all'
      limit?: number
      types?: readonly MessageType[]
      wait?: boolean
      timeoutMs?: number
    } & (
      | { ackDeliveryId?: never; requestId?: never; contractVersion?: never }
      | (MutationRequest & { ackDeliveryId: DeliveryId })
    ))

export type WaitInterruptedReason = 'consumer_fenced' | 'waiter_exists' | 'outcome_unknown'

export interface CheckObservationResult {
  runId: RunId | null
  messages: readonly MessageRow[]
  count: number
  acknowledged: DeliveryId | null
  timedOut: boolean
  cancelled: boolean
  connectionLost: boolean
  formatted?: string
  waitInterrupted?: WaitInterruptedReason
}

export type CheckResult =
  | MutationResult<CheckObservationResult & {
      mode: 'consume'
      deliveryId: DeliveryId | null
      replayed: boolean
    }>
  | (CheckObservationResult & { mode: 'peek' | 'all'; mutation?: MutationReplay })

export interface ReplyParams extends MutationRequest, DeclaredCallerAliases {
  messageId: MessageId
  body: string
  runId?: RunId
}

export type ReplyResult = MutationResult<
  | {
      kind: 'question_answer'
      messageId: MessageId
      answerMessageId: MessageId
      threadId: ThreadId
      duplicate: boolean
    }
  | {
      kind: 'ordinary_reply'
      messageId: MessageId
      replyMessage: MessageRow
      threadId: ThreadId
    }
>

export interface InboxParams {
  limit?: number
  terminal?: SessionId
  full?: boolean
}

export type InboxMessageRow = Omit<MessageRow, 'body' | 'payload'> & {
  body?: string
  payload?: JsonValue | null
}

export type InboxResult =
  | { full: true; messages: readonly MessageRow[]; count: number }
  | { full?: false; messages: readonly InboxMessageRow[]; count: number }

/** `timeoutMs` is clamped to 0..1,800,000; question and resume modes are mutually exclusive. */
export type AskParams =
  | (MutationRequest & DeclaredCallerAliases & {
      mode: 'question'
      question: string
      options?: readonly string[]
      timeoutMs?: number
      runId?: RunId
      to?: Extract<MailboxAddress, { kind: 'run' }>
      messageId?: never
    })
  | (MutationRequest & DeclaredCallerAliases & {
      mode: 'resume'
      messageId: QuestionId
      timeoutMs?: number
      runId?: RunId
      to?: Extract<MailboxAddress, { kind: 'run' }>
      question?: never
      options?: never
    })

export type AskResult = MutationResult<
  | {
      state: 'answered'
      answer: string
      messageId: QuestionId
      answerMessageId: MessageId
      threadId: ThreadId
      timeoutMs: number
    }
  | {
      state: 'timedOut' | 'cancelled' | 'connectionLost'
      answer: null
      messageId: QuestionId
      threadId: ThreadId
      timeoutMs: number
    }
>

export interface GateCreateParams extends MutationRequest, DeclaredCallerAliases {
  taskId: TaskId
  question: string
  options?: readonly string[]
}

export interface GateResolveParams extends MutationRequest, DeclaredCallerAliases {
  gateId: GateId
  resolution: string
}

export interface GateListParams extends DeclaredCallerAliases {
  runId?: RunId
  taskId?: TaskId
  status?: GateStatus
}

export interface RequestShowParams {
  requestId: UUID
}

export type ResetParams = MutationRequest & DeclaredCallerAliases & { mode: ResetMode }

export type OrchestrationMethodInputs = {
  runCreate: RunCreateParams
  runUse: RunUseParams
  runCurrent: RunCurrentParams
  runList: RunListParams
  runShow: RunShowParams
  taskCreate: TaskCreateParams
  taskList: TaskListParams
  taskUpdate: TaskUpdateParams
  dispatch: DispatchParams
  dispatchShow: DispatchShowParams
  send: SendParams
  check: CheckParams
  reply: ReplyParams
  inbox: InboxParams
  ask: AskParams
  gateCreate: GateCreateParams
  gateResolve: GateResolveParams
  gateList: GateListParams
  requestShow: RequestShowParams
  reset: ResetParams
}

export type OrchestrationMethodResults = {
  runCreate: MutationResult<{ run: RunRow }>
  runUse: MutationResult<{ run: RunRow }>
  runCurrent: { run: RunRow | null }
  runList: { runs: readonly RunRow[]; nextCursor: RunCursor | null }
  runShow: { run: RunRow }
  taskCreate: MutationResult<{ task: TaskRow }>
  taskList: { runId: RunId; tasks: readonly TaskListRow[]; count: number }
  taskUpdate: MutationResult<{ task: TaskRow; unchanged: boolean }>
  dispatch:
    | { dryRun: true; dispatch: null; preamble?: string }
    | MutationResult<{ dryRun: false; dispatch: DispatchRow; preamble?: string }>
  dispatchShow: { dispatch: DispatchRow | null; worker: WorkerRow | null; preamble?: string }
  send: SendResult
  check: CheckResult
  reply: ReplyResult
  inbox: InboxResult
  ask: AskResult
  gateCreate: MutationResult<{ gate: GateRow; task: TaskRow }>
  gateResolve: MutationResult<{ gate: GateRow; task: TaskRow }>
  gateList: { runId: RunId; gates: readonly GateRow[]; count: number }
  requestShow: RequestShowResult
  reset: MutationResult<{ mode: ResetMode }>
}

export type OrchestrationMethod = keyof OrchestrationMethodInputs & keyof OrchestrationMethodResults
export type OrchestrationMethodInput<M extends OrchestrationMethod> = OrchestrationMethodInputs[M]
export type OrchestrationMethodResult<M extends OrchestrationMethod> = OrchestrationMethodResults[M]

/** Type-only handler contract for implementation modules; caller evidence is injected, not request data. */
export type OrchestrationMethodHandler<M extends OrchestrationMethod> = (
  params: OrchestrationMethodInput<M>,
  caller: RuntimeCallerEvidence,
) => OrchestrationMethodResult<M> | Promise<OrchestrationMethodResult<M>>
