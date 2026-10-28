import { createHash } from 'node:crypto'
import type { OrchestrationSubmission, OrchestrationSubmissionVerdict, PluginContext, RuntimePeerReply } from '@quirky/protocol'
import type {
  DispatchId,
  RuntimeCallerEvidence,
  HeartbeatResult,
  JsonValue,
  MessageId,
  MessageRow,
  MessageType,
  WorkerDoneReportInput,
  WorkerHeartbeatInput,
  WorkerReportRejection,
  WorkerReportResult,
  ResetMode,
} from '../contracts'
import type { OrchestrationCore } from '../core'
import type { OrchestrationMessages, FederationMessagingHooks } from '../messaging'
import type {
  FederationBinding,
  FederationEngine,
  FederationInboundHandler,
  FederationMail,
  FederationPeerPrincipal,
  FederationRelayItem,
} from './contracts'
import { FederationMailStore, type MailDirection } from './mail-store'

const PULL_METHOD = 'quirky.orchestration/federationPull'
const ACK_METHOD = 'quirky.orchestration/federationAck'
const IMPORT_METHOD = 'quirky.orchestration/federationImport'
const PAGE_SIZE = 50
const PAGES_PER_TICK = 6
const SYNC_INTERVAL_MS = 1_000
const LIFECYCLE_IMPORT_TIMEOUT_MS = 40_000
const UNAVAILABLE = 'The paired home could not commit the federated worker report.'

type MessageEnvelope = {
  id: string
  runId: string
  fromSessionId: string | null
  sender: MessageRow['sender']
  mailbox: MessageRow['mailbox']
  subject: string
  body: string
  type: MessageType
  priority: MessageRow['priority']
  threadId: string | null
  payload: JsonValue | null
  read: boolean
  createdAt: string
  deliveredAt: string | null
}
type ImportResult = { sequence: number; id: string; result: unknown; duplicate: boolean }
type AppliedImport = { result: unknown; message: MessageRow | null; questionId: string | null }

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Federation mail payload is not JSON serializable')
  return JSON.parse(encoded) as JsonValue
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Federation mail identity is not JSON serializable')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function stableMessageId(value: unknown): MessageId {
  const digest = createHash('sha256').update(canonical(value)).digest('hex')
  return `msg_federated_${digest}` as MessageId
}

function outboundDirection(binding: FederationBinding): MailDirection {
  return binding.side === 'host' ? 'to_home' : 'to_worker'
}

function inboundDirection(binding: FederationBinding): MailDirection {
  return binding.side === 'home' ? 'to_home' : 'to_worker'
}

function assertSubmissionResult(value: unknown): OrchestrationSubmissionVerdict {
  const result = objectRecord(value)
  if (result?.kind === 'accepted') return { kind: 'accepted' }
  if (result?.kind === 'rejected' && typeof result.code === 'string' && result.code.length > 0 &&
    typeof result.reason === 'string' && result.reason.length > 0) {
    return { kind: 'rejected', code: result.code, reason: result.reason }
  }
  throw new Error('Home returned an invalid federated submission verdict')
}

function assertHeartbeatResult(value: unknown): HeartbeatResult {
  const result = objectRecord(value)
  if (result?.status === 'accepted' && typeof result.lastHeartbeatAt === 'string') {
    return { status: 'accepted', lastHeartbeatAt: result.lastHeartbeatAt }
  }
  if (result?.status === 'rejected' && typeof result.reason === 'string' && result.lastHeartbeatAt === null) {
    return { status: 'rejected', reason: result.reason as WorkerReportRejection, lastHeartbeatAt: null }
  }
  throw new Error('Home returned an invalid federated heartbeat verdict')
}

function assertRelayItem(value: unknown, bindingId: string, direction: MailDirection): FederationRelayItem {
  const item = objectRecord(value)
  if (!item || item.bindingId !== bindingId || item.direction !== direction ||
    !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 ||
    typeof item.id !== 'string' || item.id.length === 0 ||
    (item.kind !== 'message' && item.kind !== 'question' && item.kind !== 'reply' && item.kind !== 'lifecycle') ||
    !objectRecord(item.payload)) {
    throw new Error('Peer returned an invalid federation relay item')
  }
  return item as unknown as FederationRelayItem
}


function assertImportReply(value: unknown, items: readonly FederationRelayItem[]): { through: number; results: ImportResult[] } {
  const record = objectRecord(value)
  if (!record || !Number.isSafeInteger(record.through) || !Array.isArray(record.results) || record.results.length !== items.length) {
    throw new Error('Peer returned an invalid federation import receipt')
  }
  const results: ImportResult[] = []
  for (let index = 0; index < items.length; index += 1) {
    const raw = objectRecord(record.results[index])
    const item = items[index]!
    if (!raw || raw.sequence !== item.sequence || raw.id !== item.id || typeof raw.duplicate !== 'boolean' || !Object.hasOwn(raw, 'result')) {
      throw new Error(`Peer returned an invalid receipt for federation item ${item.id}`)
    }
    results.push({ sequence: item.sequence, id: item.id, result: raw.result, duplicate: raw.duplicate })
  }
  const lastSequence = items.at(-1)?.sequence ?? 0
  if ((record.through as number) < lastSequence) throw new Error('Peer acknowledged federation import before committing the full page')
  return { through: record.through as number, results }
}

function reportRejection(
  result: Extract<WorkerReportResult, { status: 'rejected' }>,
): Extract<OrchestrationSubmissionVerdict, { kind: 'rejected' }> {
  const lifecycle = result.lifecycle
  return {
    kind: 'rejected',
    code: lifecycle?.code ?? 'federated_worker_report_rejected',
    reason: lifecycle?.reason ?? `Home rejected the worker report: ${result.reason}`,
  }
}

export interface FederationMailComponent extends FederationMail {
  submissionPreflight(submission: OrchestrationSubmission): Promise<OrchestrationSubmissionVerdict>
  reset(mode: ResetMode): void
}
export function createFederationMail(
  context: PluginContext,
  core: OrchestrationCore,
  messages: OrchestrationMessages,
  engine: FederationEngine,
): FederationMailComponent {
  const store = new FederationMailStore(core.store)
  const syncPromises = new Map<string, Promise<void>>()
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null
  const fencedBindings = new Set<string>()
  let resetGeneration = 0

  const log = (message: string): void => {
    try {
      context.log(message)
    } catch {
      // A revoked plugin context does not affect durable relay state.
    }
  }

  const assertBindingCurrent = (binding: FederationBinding, generation: number): void => {
    if (disposed || generation !== resetGeneration || fencedBindings.has(binding.id)) {
      throw new Error(`Federation relay ${binding.id} was fenced by reset or disposal`)
    }
  }

  const requireBinding = async (bindingId: string, principal: FederationPeerPrincipal): Promise<FederationBinding> => {
    const binding = fencedBindings.has(bindingId) ? undefined : engine.bindings().find((candidate) => candidate.id === bindingId)
    if (!binding || binding.peer.id !== principal.peerId || binding.peer.fingerprint !== principal.fingerprint ||
      binding.peer.pairingRevision !== principal.pairingRevision || binding.peerIncarnation !== principal.incarnation) {
      throw new Error('Federation mail principal does not match its bound peer incarnation')
    }
    await engine.assertBinding(binding)
    return binding
  }

  const requirePeerReply = async (binding: FederationBinding, reply: RuntimePeerReply): Promise<unknown> => {
    if (reply.peer.id !== binding.peer.id || reply.peer.fingerprint !== binding.peer.fingerprint ||
      reply.peer.pairingRevision !== binding.peer.pairingRevision || reply.status.fingerprint !== binding.peer.fingerprint ||
      reply.status.incarnation !== binding.peerIncarnation) {
      throw new Error('Federation mail peer identity changed during relay')
    }
    await engine.assertBinding(binding)
    return reply.result
  }

  const callPeer = async (
    binding: FederationBinding,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> => {
    await engine.assertBinding(binding)
    let requestId: string | undefined
    if (method === IMPORT_METHOD || method === ACK_METHOD) {
      const digest = createHash('sha256').update(canonical({ bindingId: binding.id, method, params })).digest('hex')
      // UUIDv8 retains a stable operation identity across reconnects and daemon restarts.
      requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    }
    const reply = await engine.remote(binding, method, params, requestId, timeoutMs)
    return requirePeerReply(binding, reply)
  }

  const makeEnvelope = (
    binding: FederationBinding,
    direction: MailDirection,
    input: {
      id: string
      subject: string
      body: string
      type: MessageType
      payload: unknown
      createdAt: string
    },
  ): MessageEnvelope => {
    const hostRunId = binding.hostRunId
    const hostDispatchId = binding.hostDispatchId
    const homeRunId = binding.homeRunId
    const homeDispatchId = binding.homeDispatchId
    if (!hostRunId || !hostDispatchId || !homeRunId || !homeDispatchId) {
      throw new Error('Federated message requires a fully attached binding')
    }
    const hostToHome = direction === 'to_home'
    return {
      id: input.id,
      runId: hostToHome ? hostRunId : homeRunId,
      fromSessionId: null,
      sender: hostToHome
        ? { kind: 'dispatch', dispatchId: hostDispatchId }
        : { kind: 'run', runId: homeRunId },
      mailbox: hostToHome
        ? { kind: 'run', runId: hostRunId }
        : { kind: 'dispatch', dispatchId: homeDispatchId },
      subject: input.subject,
      body: input.body,
      type: input.type,
      priority: 'normal',
      threadId: input.type === 'question' ? input.id : null,
      payload: input.payload === null ? null : jsonValue(input.payload),
      read: false,
      createdAt: input.createdAt,
      deliveredAt: null,
    }
  }

  const scheduleSync = (binding: FederationBinding): void => {
    if (disposed) return
    queueMicrotask(() => {
      void sync(binding).catch((error: unknown) => log(`federation mail sync failed for ${binding.id}: ${error instanceof Error ? error.message : String(error)}`))
    })
  }

  const queueItem = (binding: FederationBinding, direction: MailDirection, id: string, kind: FederationRelayItem['kind'], payload: Record<string, JsonValue>): FederationRelayItem => {
    if (fencedBindings.has(binding.id)) throw new Error(`Federation binding ${binding.id} was fenced by reset`)
    const item = store.enqueue(binding.id, direction, id, kind, payload)
    scheduleSync(binding)
    return item
  }

  const payloadMessage = (message: MessageRow): Record<string, JsonValue> => ({
    message: jsonValue(message) as Record<string, JsonValue>,
  })

  const findBinding = (bindingId: string): FederationBinding => {
    if (fencedBindings.has(bindingId)) throw new Error(`Federation binding ${bindingId} was fenced by reset`)
    const binding = engine.bindings().find((candidate) => candidate.id === bindingId)
    if (!binding) throw new Error(`Federation binding ${bindingId} no longer exists`)
    return binding
  }

  const hostBindingForVerifiedCaller = (
    dispatchId: DispatchId,
    caller: RuntimeCallerEvidence,
  ): FederationBinding | null => {
    const binding = engine.host(dispatchId)
    if (!binding) return null
    const dispatch = core.store.get<{
      id: string
      run_id: string
      task_id: string
      status: string
      assignee_session_id: string | null
      runtime_epoch: string | null
      process_incarnation: string | null
    }>(
      `SELECT id, run_id, task_id, status, assignee_session_id, runtime_epoch, process_incarnation
       FROM dispatches WHERE id = ?`,
      dispatchId,
    )
    const workerRow = core.store.get<{ record_json: string }>(
      `SELECT record_json FROM worker_dispatches WHERE dispatch_id = ?`,
      dispatchId,
    )
    const worker = workerRow ? objectRecord(JSON.parse(workerRow.record_json)) : null
    if (
      binding.side !== 'host' || binding.hostDispatchId !== dispatchId || !binding.hostRunId ||
      !binding.hostTaskId || !binding.sessionId || !binding.processIncarnation || !binding.processRuntimeEpoch ||
      (binding.state !== 'active' && binding.state !== 'unknown') ||
      caller.runtimeOwned !== true || caller.live !== true ||
      caller.callerSessionId !== caller.runtimeSessionId ||
      caller.runtimeSessionId !== binding.sessionId ||
      caller.attestation.processIncarnation !== binding.processIncarnation ||
      !dispatch || dispatch.run_id !== binding.hostRunId || dispatch.task_id !== binding.hostTaskId ||
      dispatch.assignee_session_id !== caller.runtimeSessionId ||
      (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
      dispatch.runtime_epoch !== caller.attestation.runtimeEpoch ||
      dispatch.process_incarnation !== caller.attestation.processIncarnation ||
      !worker || worker.sessionId !== binding.sessionId ||
      worker.processIncarnation !== binding.processIncarnation ||
      worker.processRuntimeEpoch !== binding.processRuntimeEpoch ||
      worker.state === 'stopping' || worker.state === 'stop_unknown' || worker.state === 'stopped' ||
      worker.state === 'abandoned' || worker.state === 'failed' || worker.state === 'succeeded'
    ) {
      throw new Error(`Verified worker caller does not match exact host federation binding ${binding.id}`)
    }
    return binding
  }

  const enqueueObservedHostExits = (binding: FederationBinding): void => {
    if (binding.side !== 'host' || !binding.hostDispatchId || !binding.hostTaskId ||
      !binding.sessionId || !binding.processIncarnation || !binding.processRuntimeEpoch ||
      fencedBindings.has(binding.id)) return
    const workerRow = core.store.get<{ record_json: string }>(
      `SELECT record_json FROM worker_dispatches WHERE dispatch_id = ?`, binding.hostDispatchId,
    )
    const worker = workerRow ? objectRecord(JSON.parse(workerRow.record_json)) : null
    if (!worker || worker.state !== 'failed' || worker.stage !== 'process_exited' ||
      worker.sessionId !== binding.sessionId || worker.processIncarnation !== binding.processIncarnation ||
      worker.processRuntimeEpoch !== binding.processRuntimeEpoch) return
    const observations = core.store.all<{ payload_json: string; created_at: string }>(
      `SELECT payload_json, created_at FROM worker_observations
       WHERE dispatch_id = ? AND facet = 'process_exit' ORDER BY id`,
      binding.hostDispatchId,
    )
    for (const observation of observations) {
      let payload: Record<string, unknown> | null
      try {
        payload = objectRecord(JSON.parse(observation.payload_json) as unknown)
      } catch {
        continue
      }
      if (!payload || payload.sessionId !== binding.sessionId ||
        payload.incarnation !== binding.processIncarnation ||
        payload.runtimeEpoch !== worker.runtimeEpoch ||
        typeof payload.reason !== 'string' ||
        (payload.exitCode !== null && (!Number.isSafeInteger(payload.exitCode) || typeof payload.exitCode !== 'number')) ||
        typeof observation.created_at !== 'string') continue
      const id = `exit_${createHash('sha256')
        .update(`${binding.id}\\u0000${binding.hostDispatchId}\\u0000${binding.processIncarnation}`)
        .digest('hex')}`
      queueItem(binding, 'to_home', id, 'lifecycle', {
        action: 'process_exit',
        hostDispatchId: binding.hostDispatchId,
        hostTaskId: binding.hostTaskId,
        sessionId: binding.sessionId,
        processIncarnation: binding.processIncarnation,
        processRuntimeEpoch: binding.processRuntimeEpoch,
        reason: payload.reason,
        exitCode: payload.exitCode as JsonValue,
        at: observation.created_at,
      })
      return
    }
  }

  const outgoingMessage = (message: MessageRow, caller: RuntimeCallerEvidence | null): void => {
    if (message.type === 'worker_done' || message.type === 'heartbeat') return
    const hostBinding = caller !== null && message.sender.kind === 'dispatch'
      ? hostBindingForVerifiedCaller(message.sender.dispatchId, caller)
      : null
    if (hostBinding) {
      if (!hostBinding.hostDispatchId || !hostBinding.hostRunId || message.sender.kind !== 'dispatch' ||
        message.sender.dispatchId !== hostBinding.hostDispatchId || message.runId !== hostBinding.hostRunId) {
        throw new Error('Verified host worker message does not match its federation binding')
      }
      if (message.type === 'status') return
      queueItem(hostBinding, 'to_home', message.id, 'message', payloadMessage(message))
      return
    }
    if (message.mailbox.kind !== 'dispatch') return
    const homeBinding = engine.home(message.mailbox.dispatchId)
    if (!homeBinding) return
    if (homeBinding.side !== 'home' || message.runId !== homeBinding.homeRunId ||
      message.mailbox.dispatchId !== homeBinding.homeDispatchId) {
      throw new Error('Coordinator message does not match its federation binding')
    }
    queueItem(homeBinding, 'to_worker', message.id, 'message', payloadMessage(message))
  }

  const afterQuestionCreated = (message: MessageRow, caller: RuntimeCallerEvidence): void => {
    if (message.sender.kind !== 'dispatch') throw new Error('Verified remote question has no Dispatch sender')
    const binding = hostBindingForVerifiedCaller(message.sender.dispatchId, caller)
    if (!binding) return
    if (message.sender.dispatchId !== binding.hostDispatchId || message.runId !== binding.hostRunId ||
      message.mailbox.kind !== 'run' || message.mailbox.runId !== binding.hostRunId) {
      throw new Error('Verified remote question does not match its federation binding')
    }
    store.bindQuestion(binding.id, message.id, 'to_home')
    queueItem(binding, 'to_home', message.id, 'question', payloadMessage(message))
  }

  const afterQuestionAnswered = (questionId: string, answer: MessageRow): void => {
    const linked = store.questionBinding(questionId)
    if (!linked) return
    const binding = findBinding(linked.binding_id)
    if (binding.side !== 'home' || linked.direction !== 'to_home' || answer.mailbox.kind !== 'dispatch' ||
      answer.mailbox.dispatchId !== binding.homeDispatchId || answer.runId !== binding.homeRunId) {
      throw new Error(`Answer to federated question ${questionId} does not match its home binding`)
    }
    const payload = { questionId, message: jsonValue(answer) } as Record<string, JsonValue>
    queueItem(binding, 'to_worker', answer.id, 'reply', payload)
  }

  const afterReply = (originalMessageId: string, replyMessage: MessageRow, caller: RuntimeCallerEvidence): void => {
    const hostBinding = replyMessage.sender.kind === 'dispatch'
      ? hostBindingForVerifiedCaller(replyMessage.sender.dispatchId, caller)
      : null
    if (hostBinding) {
      if (!hostBinding.hostRunId || replyMessage.runId !== hostBinding.hostRunId ||
        replyMessage.sender.kind !== 'dispatch' || replyMessage.sender.dispatchId !== hostBinding.hostDispatchId) {
        throw new Error('Verified host worker reply does not match its federation binding')
      }
      queueItem(hostBinding, 'to_home', replyMessage.id, 'message', payloadMessage(replyMessage))
      return
    }
    const linked = store.importedBinding(originalMessageId)
    if (!linked) return
    const binding = findBinding(linked.binding_id)
    if (binding.side !== 'home' || linked.direction !== 'to_home' || replyMessage.mailbox.kind !== 'dispatch' ||
      replyMessage.mailbox.dispatchId !== binding.homeDispatchId) return
    queueItem(binding, 'to_worker', replyMessage.id, 'message', payloadMessage(replyMessage))
  }

  const buildHostSubmissionItem = async (submission: OrchestrationSubmission): Promise<{ binding: FederationBinding; item: FederationRelayItem }> => {
    const binding = engine.host(submission.dispatchId as DispatchId)
    if (!binding || binding.side !== 'host' || submission.runId !== binding.hostRunId ||
      submission.taskId !== binding.hostTaskId || submission.dispatchId !== binding.hostDispatchId ||
      !binding.hostRunId || !binding.hostTaskId || !binding.hostDispatchId) {
      throw new Error('Federated submission does not match an exact host binding')
    }
    await engine.assertBinding(binding)
    const fingerprint = { bindingId: binding.id, ...submission }
    const messageId = stableMessageId(fingerprint)
    const dispatch = core.getDispatch(binding.hostDispatchId)
    const createdAt = dispatch.dispatchedAt ?? dispatch.createdAt
    const sourcePayload = submission.payload
    const payload = sourcePayload === null ? null : jsonValue(sourcePayload)
    const homePayload = sourcePayload === null ? null : { ...sourcePayload }
    if (homePayload !== null) {
      if (homePayload.taskId === binding.hostTaskId) homePayload.taskId = binding.homeTaskId
      if (homePayload.dispatchId === binding.hostDispatchId) homePayload.dispatchId = binding.homeDispatchId
    }
    const homeSubmission: OrchestrationSubmission = {
      ...submission,
      runId: binding.homeRunId,
      taskId: binding.homeTaskId,
      dispatchId: binding.homeDispatchId,
      payload: homePayload,
    }
    const message = makeEnvelope(binding, 'to_home', {
      id: messageId,
      subject: submission.subject,
      body: submission.body,
      type: submission.type,
      payload,
      createdAt,
    })
    const itemPayload: Record<string, JsonValue> = {
      type: submission.type,
      submission: jsonValue(homeSubmission) as Record<string, JsonValue>,
      message: jsonValue(message) as Record<string, JsonValue>,
    }
    if (submission.type === 'worker_done') {
      const record = submission.payload
      const outcome = record?.outcome
      if (!record || (outcome !== 'succeeded' && outcome !== 'failed') ||
        record.taskId !== binding.hostTaskId || record.dispatchId !== binding.hostDispatchId) {
        throw new Error('Federated worker completion does not name its exact host attempt')
      }
      const report: WorkerDoneReportInput = {
        taskId: binding.homeTaskId,
        dispatchId: binding.homeDispatchId,
        outcome,
        messageId,
        subject: submission.subject,
        body: submission.body,
        ...(Array.isArray(record.filesModified) && record.filesModified.every((value) => typeof value === 'string')
          ? { filesModified: record.filesModified as string[] }
          : {}),
        ...(typeof record.reportPath === 'string' ? { reportPath: record.reportPath } : {}),
      }
      itemPayload.report = jsonValue(report)
    }
    const item = queueItem(binding, 'to_home', messageId, 'lifecycle', itemPayload)
    return { binding, item }
  }

  const submissionPreflight = async (submission: OrchestrationSubmission): Promise<OrchestrationSubmissionVerdict> => {
    const { binding, item } = await buildHostSubmissionItem(submission)
    const cached = store.result(binding.id, 'to_home', item.id)
    if (cached !== null) return assertSubmissionResult(cached)
    await sync(binding)
    const result = store.result(binding.id, 'to_home', item.id)
    if (result === null) {
      throw new Error(UNAVAILABLE)
    }
    return assertSubmissionResult(result)
  }

  const beforeHeartbeat = async (input: WorkerHeartbeatInput, caller: RuntimeCallerEvidence): Promise<HeartbeatResult | null> => {
    const binding = hostBindingForVerifiedCaller(input.dispatchId, caller)
    if (!binding) return null
    if (binding.side !== 'host' || input.dispatchId !== binding.hostDispatchId || input.taskId !== binding.hostTaskId ||
      !binding.hostRunId || !binding.hostTaskId || !binding.hostDispatchId) {
      throw new Error('Verified host heartbeat does not match its federation binding')
    }
    await engine.assertBinding(binding)
    const messageId = stableMessageId({ bindingId: binding.id, type: 'heartbeat', input })
    const dispatch = core.getDispatch(binding.hostDispatchId)
    const payload: Record<string, JsonValue> = {
      type: 'heartbeat',
      heartbeat: jsonValue({
        taskId: binding.homeTaskId,
        dispatchId: binding.homeDispatchId,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
      }),
      message: jsonValue(makeEnvelope(binding, 'to_home', {
        id: messageId,
        subject: 'Worker heartbeat',
        body: input.phase ?? '',
        type: 'heartbeat',
        payload: { taskId: binding.hostTaskId, dispatchId: binding.hostDispatchId, ...(input.phase === undefined ? {} : { phase: input.phase }) },
        createdAt: dispatch.dispatchedAt ?? dispatch.createdAt,
      })) as Record<string, JsonValue>,
    }
    queueItem(binding, 'to_home', messageId, 'lifecycle', payload)
    await sync(binding)
    const result = store.result(binding.id, 'to_home', messageId)
    if (result === null) throw new Error(UNAVAILABLE)
    return assertHeartbeatResult(result)
  }

  const applyLifecycle = async (binding: FederationBinding, item: FederationRelayItem): Promise<AppliedImport> => {
    if (binding.side !== 'home' || item.direction !== 'to_home') throw new Error('Lifecycle reports can only be imported by their home binding')
    if (item.payload.action === 'process_exit') {
      const exit = item.payload
      if (!binding.hostDispatchId || !binding.hostTaskId || !binding.sessionId ||
        !binding.processIncarnation || !binding.processRuntimeEpoch ||
        exit.hostDispatchId !== binding.hostDispatchId || exit.hostTaskId !== binding.hostTaskId ||
        exit.sessionId !== binding.sessionId || exit.processIncarnation !== binding.processIncarnation ||
        exit.processRuntimeEpoch !== binding.processRuntimeEpoch || typeof exit.reason !== 'string' ||
        (exit.exitCode !== null && (typeof exit.exitCode !== 'number' || !Number.isSafeInteger(exit.exitCode))) ||
        typeof exit.at !== 'string') {
        throw new Error('Federated process exit does not match the exact attached host worker')
      }
      const result = core.reportFederatedWorkerExit({
        dispatchId: binding.homeDispatchId,
        taskId: binding.homeTaskId,
        processIncarnation: binding.processIncarnation,
        reason: exit.reason,
        exitCode: exit.exitCode as number | null,
        at: exit.at,
      }, engine.reportAuthority(binding))
      return { result, message: null, questionId: null }
    }
    const type = item.payload.type
    if (type !== 'worker_done' && type !== 'status' && type !== 'heartbeat') throw new Error('Unsupported federated lifecycle report type')
    const imported = messages.importFederatedItem(binding, item)
    const message = imported.message
    if (type === 'status') {
      const raw = objectRecord(item.payload.submission)
      if (!raw || raw.runId !== binding.homeRunId || raw.taskId !== binding.homeTaskId || raw.dispatchId !== binding.homeDispatchId ||
        raw.type !== 'status' || typeof raw.subject !== 'string' || typeof raw.body !== 'string') {
        throw new Error('Federated status submission does not match its home binding')
      }
      if (raw.payload !== null && !objectRecord(raw.payload)) throw new Error('Federated status payload must be an object or null')
      const payload = raw.payload === null ? null : objectRecord(raw.payload)
      const verdict = await messages.runFederatedSubmissionPreflight({
        runId: binding.homeRunId,
        taskId: binding.homeTaskId,
        dispatchId: binding.homeDispatchId,
        type: 'status',
        subject: raw.subject,
        body: raw.body,
        payload: payload,
      })
      if (verdict?.kind === 'rejected') {
        messages.markFederatedRejected(message.id, 'status', verdict.reason, verdict.code)
        return { result: verdict, message: messages.getFederatedMessage(message.id), questionId: null }
      }
      return { result: { kind: 'accepted' }, message, questionId: null }
    }
    if (type === 'heartbeat') {
      const raw = objectRecord(item.payload.heartbeat)
      if (!raw || raw.taskId !== binding.homeTaskId || raw.dispatchId !== binding.homeDispatchId ||
        (raw.phase !== undefined && typeof raw.phase !== 'string')) {
        throw new Error('Federated heartbeat does not match its home binding')
      }
      const result = core.recordFederatedHeartbeat({
        taskId: binding.homeTaskId,
        dispatchId: binding.homeDispatchId,
        ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
      }, engine.reportAuthority(binding))
      if (result.status === 'rejected') {
        core.store.run(`UPDATE messages SET read = 1, delivered_at = ? WHERE id = ?`, new Date().toISOString(), message.id)
      }
      return { result, message: result.status === 'rejected' ? null : message, questionId: null }
    }
    const rawReport = objectRecord(item.payload.report)
    if (!rawReport || rawReport.taskId !== binding.homeTaskId || rawReport.dispatchId !== binding.homeDispatchId ||
      rawReport.messageId !== message.id || (rawReport.outcome !== 'succeeded' && rawReport.outcome !== 'failed') ||
      typeof rawReport.subject !== 'string' || typeof rawReport.body !== 'string') {
      throw new Error('Federated worker report does not match its home binding')
    }
    const report: WorkerDoneReportInput = {
      taskId: binding.homeTaskId,
      dispatchId: binding.homeDispatchId,
      outcome: rawReport.outcome,
      messageId: message.id,
      subject: rawReport.subject,
      body: rawReport.body,
      ...(Array.isArray(rawReport.filesModified) && rawReport.filesModified.every((value) => typeof value === 'string')
        ? { filesModified: rawReport.filesModified as string[] }
        : {}),
      ...(typeof rawReport.reportPath === 'string' ? { reportPath: rawReport.reportPath } : {}),
    }
    let result = core.preflightFederatedWorkerDone(report, engine.reportAuthority(binding))
    if (result?.status === 'rejected') {
      const verdict = reportRejection(result)
      messages.markFederatedRejected(message.id, 'worker_done', verdict.reason, verdict.kind === 'rejected' ? verdict.code : 'federated_worker_report_rejected')
      return { result: verdict, message: messages.getFederatedMessage(message.id), questionId: null }
    }
    if (result?.status === 'duplicate') return { result: { kind: 'accepted' }, message, questionId: null }
    const rawSubmission = objectRecord(item.payload.submission)
    if (!rawSubmission || rawSubmission.runId !== binding.homeRunId || rawSubmission.taskId !== binding.homeTaskId ||
      rawSubmission.dispatchId !== binding.homeDispatchId || rawSubmission.type !== 'worker_done' ||
      typeof rawSubmission.subject !== 'string' || typeof rawSubmission.body !== 'string' ||
      (rawSubmission.payload !== null && !objectRecord(rawSubmission.payload))) {
      throw new Error('Federated worker submission does not match its home binding')
    }
    const ownerPayload = rawSubmission.payload === null ? null : objectRecord(rawSubmission.payload)
    const verdict = await messages.runFederatedSubmissionPreflight({
      runId: binding.homeRunId,
      taskId: binding.homeTaskId,
      dispatchId: binding.homeDispatchId,
      type: 'worker_done',
      subject: report.subject,
      body: report.body,
      payload: ownerPayload,
    })
    if (verdict?.kind === 'rejected') {
      messages.markFederatedRejected(message.id, 'worker_done', verdict.reason, verdict.code)
      return { result: verdict, message: messages.getFederatedMessage(message.id), questionId: null }
    }
    result = core.reportFederatedWorkerDone(report, engine.reportAuthority(binding))
    if (result.status === 'rejected') {
      const rejection = reportRejection(result)
      messages.markFederatedRejected(message.id, 'worker_done', rejection.reason, rejection.kind === 'rejected' ? rejection.code : 'federated_worker_report_rejected')
      return { result: rejection, message: messages.getFederatedMessage(message.id), questionId: null }
    }
    return { result: { kind: 'accepted', report: result }, message, questionId: null }
  }

  const applyItem = async (binding: FederationBinding, item: FederationRelayItem): Promise<AppliedImport> => {
    if (item.kind === 'lifecycle') return applyLifecycle(binding, item)
    const imported = messages.importFederatedItem(binding, item)
    return {
      result: { kind: 'accepted', messageId: imported.message.id },
      message: imported.message,
      questionId: imported.questionId,
    }
  }

  const importQueues = new Map<string, Promise<void>>()
  const applyImports = async (binding: FederationBinding, items: readonly FederationRelayItem[]): Promise<{ through: number; results: ImportResult[] }> => {
    if (items.length > PAGE_SIZE) throw new Error(`Federation import page exceeds ${PAGE_SIZE} items`)
    const generation = resetGeneration
    assertBindingCurrent(binding, generation)
    const results: ImportResult[] = []
    for (const item of items) {
      if (item.bindingId !== binding.id || item.direction !== inboundDirection(binding)) {
        throw new Error('Federation import item is outside its bound peer direction')
      }
      await engine.assertBinding(binding)
      assertBindingCurrent(binding, generation)
      const existing = store.prepareImport(item)
      if (existing.duplicate) {
        results.push({ sequence: item.sequence, id: item.id, result: existing.result, duplicate: true })
        continue
      }
      const applied = await applyItem(binding, item)
      assertBindingCurrent(binding, generation)
      await engine.assertBinding(binding)
      assertBindingCurrent(binding, generation)
      store.commitImport(item, applied.result, applied.questionId ?? undefined)
      if (applied.message && !applied.message.read) {
        messages.onCommitted({ mailbox: applied.message.mailbox, messageId: applied.message.id, type: applied.message.type })
      }
      if (applied.questionId !== null) messages.notifyFederatedQuestion(applied.questionId)
      results.push({ sequence: item.sequence, id: item.id, result: applied.result, duplicate: false })
    }
    return { through: store.cursor(binding.id, inboundDirection(binding)), results }
  }

  const importItems = (binding: FederationBinding, items: readonly FederationRelayItem[]) => {
    const prior = importQueues.get(binding.id) ?? Promise.resolve()
    const operation = prior.then(() => applyImports(binding, items))
    const settled = operation.then(() => undefined, () => undefined)
    importQueues.set(binding.id, settled)
    void settled.then(() => {
      if (importQueues.get(binding.id) === settled) importQueues.delete(binding.id)
    })
    return operation
  }

  const inbound: FederationInboundHandler = async (method, params, principal, _requestId) => {
    const bindingId = params.bindingId
    if (typeof bindingId !== 'string' || bindingId.length === 0) throw new Error('Federation mail request is missing its binding ID')
    const binding = await requireBinding(bindingId, principal)
    if (method === PULL_METHOD) {
      const direction = params.direction
      const after = params.after
      const limit = params.limit
      if ((direction !== 'to_home' && direction !== 'to_worker') || direction !== outboundDirection(binding) ||
        !Number.isSafeInteger(after) || (after as number) < 0 || !Number.isInteger(limit) ||
        (limit as number) < 1 || (limit as number) > PAGE_SIZE) {
        throw new Error('Federation pull request has an invalid direction, cursor, or page limit')
      }
      const mailDirection = direction as MailDirection
      const items = store.listOutbox(binding.id, mailDirection, after as number, limit as number)
      return { items, through: items.at(-1)?.sequence ?? after }
    }
    if (method === ACK_METHOD) {
      const direction = params.direction
      const through = params.through
      if ((direction !== 'to_home' && direction !== 'to_worker') || direction !== outboundDirection(binding) ||
        !Number.isSafeInteger(through) || (through as number) < 0) {
        throw new Error('Federation acknowledgement has an invalid direction or cursor')
      }
      const mailDirection = direction as MailDirection
      return { through: store.acknowledge(binding.id, mailDirection, through as number) }
    }
    if (method === IMPORT_METHOD) {
      const direction = params.direction
      const rawItems = params.items
      if ((direction !== 'to_home' && direction !== 'to_worker') || direction !== inboundDirection(binding) ||
        !Array.isArray(rawItems) || rawItems.length > PAGE_SIZE) {
        throw new Error('Federation import has an invalid direction or page size')
      }
      const mailDirection = direction as MailDirection
      const items = rawItems.map((item) => assertRelayItem(item, binding.id, mailDirection))
      return importItems(binding, items)
    }
    throw new Error(`Unsupported federation mail method ${method}`)
  }

  const synchronize = async (binding: FederationBinding, generation: number): Promise<void> => {
    assertBindingCurrent(binding, generation)
    if (binding.side === 'host') enqueueObservedHostExits(binding)
    assertBindingCurrent(binding, generation)
    await engine.assertBinding(binding)
    assertBindingCurrent(binding, generation)
    const outgoing = outboundDirection(binding)
    const incoming = inboundDirection(binding)
    let pages = 0
    while (pages < PAGES_PER_TICK) {
      const after = store.outboxCursor(binding.id, outgoing)
      const items = store.listOutbox(binding.id, outgoing, after, PAGE_SIZE)
      if (items.length === 0) break
      const timeoutMs = items.some((item) => item.kind === 'lifecycle') ? LIFECYCLE_IMPORT_TIMEOUT_MS : undefined
      const raw = await callPeer(binding, IMPORT_METHOD, { bindingId: binding.id, direction: outgoing, items }, timeoutMs)
      assertBindingCurrent(binding, generation)
      const receipt = assertImportReply(raw, items)
      for (const result of receipt.results) store.complete(binding.id, outgoing, result.id, result.result)
      store.acknowledge(binding.id, outgoing, receipt.through)
      pages += 1
      if (items.length < PAGE_SIZE) break
    }
    while (pages < PAGES_PER_TICK) {
      const after = store.cursor(binding.id, incoming)
      const raw = objectRecord(await callPeer(binding, PULL_METHOD, {
        bindingId: binding.id,
        direction: incoming,
        after,
        limit: PAGE_SIZE,
      }))
      assertBindingCurrent(binding, generation)
      if (!raw || !Array.isArray(raw.items)) throw new Error('Peer returned an invalid federation pull page')
      const items = raw.items.map((item) => assertRelayItem(item, binding.id, incoming))
      if (items.length === 0) break
      if (items.length > PAGE_SIZE) throw new Error(`Peer returned more than ${PAGE_SIZE} federation items`)
      await importItems(binding, items)
      assertBindingCurrent(binding, generation)
      const through = items.at(-1)!.sequence
      const ack = objectRecord(await callPeer(binding, ACK_METHOD, { bindingId: binding.id, direction: incoming, through }))
      assertBindingCurrent(binding, generation)
      if (ack?.through !== through) throw new Error('Peer refused the committed federation mail acknowledgement')
      pages += 1
      if (items.length < PAGE_SIZE) break
    }
  }

  const sync = (binding: FederationBinding): Promise<void> => {
    if (disposed || fencedBindings.has(binding.id)) return Promise.resolve()
    const pending = syncPromises.get(binding.id)
    if (pending) return pending
    const generation = resetGeneration
    const operation = synchronize(binding, generation).finally(() => {
      if (syncPromises.get(binding.id) === operation) syncPromises.delete(binding.id)
    })
    syncPromises.set(binding.id, operation)
    return operation
  }

  const scheduleKnownBindings = (): void => {
    if (disposed) return
    for (const binding of engine.bindings()) {
      if (fencedBindings.has(binding.id)) continue
      if (binding.side === 'host' && binding.state !== 'settled') {
        try {
          enqueueObservedHostExits(binding)
        } catch (error) {
          log(`federation process-exit observation failed for ${binding.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (binding.state === 'active' || store.hasUnfinished(binding.id)) scheduleSync(binding)
    }
  }

  const startTimer = (): void => {
    if (disposed) return
    if (timer !== null) clearInterval(timer)
    timer = setInterval(scheduleKnownBindings, SYNC_INTERVAL_MS)
    timer.unref?.()
    scheduleKnownBindings()
  }

  const resetMail = (mode: ResetMode): void => {
    if (mode === 'messages') {
      startTimer()
      return
    }
    const bindingIds = new Set(engine.bindings().map((binding) => binding.id))
    for (const id of bindingIds) fencedBindings.add(id)
    resetGeneration += 1
    if (timer !== null) clearInterval(timer)
    timer = null
    for (const id of store.clearAll()) fencedBindings.add(id)
    startTimer()
  }

  const hooks: FederationMessagingHooks = {
    afterMessage: outgoingMessage,
    afterQuestionCreated,
    afterQuestionAnswered,
    afterReply,
    beforeHeartbeat,
    reset: resetMail,
  }
  messages.bindFederation(hooks)
  startTimer()

  return {
    inbound,
    sync,
    submissionPreflight,
    reset: resetMail,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      resetGeneration += 1
      if (timer !== null) clearInterval(timer)
      timer = null
      messages.unbindFederation(hooks)
      await Promise.allSettled(syncPromises.values())
      syncPromises.clear()
    },
  }
}
