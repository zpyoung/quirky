import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { PluginContext } from '@quirky/protocol'
import type {
  Attempt,
  DispatchResult,
  Enrollment,
  Json,
  JournalEntry,
  KernelStore,
  KernelWorkerObservation,
  OrchestrationPort,
  WorkerMessage,
  WorkerRequest
} from './contracts'
import { isCoordinatorSeatLostError, workerObservationsFromRun } from './worker-evidence'

const CONTRACT_VERSION = 1 as const
const MAILBOX_EVENT = 'quirky.orchestration/message-arrived'
const MAILBOX_TYPES = ['worker_done', 'question', 'escalation'] as const
const MAILBOX_JOURNAL_KIND = 'orchestration-mailbox-check'
const RELEASE_JOURNAL_KIND = 'orchestration-worker-release'

type JsonRecord = Record<string, unknown>
type PreparedCheck = JournalEntry & {
  state: 'prepared'
  requestId: string
  sequence: number
  ackDeliveryId?: string
}
type CompletedCheck = JournalEntry & {
  state: 'completed'
  requestId: string
  ackDeliveryId?: string
  acknowledged?: string | null
  deliveryId?: string | null
  messages: unknown[]
  questions: unknown[]
}

/** UUIDv8 uses the first 128 SHA-256 bits; version and RFC variant bits are set after hashing. */
export function orchestrationRequestIdForAttemptFingerprint(fingerprint: string): string {
  return uuidV8(sha256(`heimdall-dispatch-v1\0${fingerprint}`))
}
function indeterminateWorkerResult(requestId: string, detail: string, error?: unknown): DispatchResult {
  return {
    kind: 'indeterminate',
    requestId,
    detail,
    ...(error !== undefined && isCoordinatorSeatLostError(error) ? { reason: 'coordinator-seat-lost' } : {})
  }
}

export function createOrchestrationAdapter(
  context: PluginContext,
  store: KernelStore,
  onWake: (watcherId: string) => void
): OrchestrationPort {
  let disposed = false
  const unsubscribe = store.readOnly ? () => {} : context.subscribe((event) => {
    if (disposed || event.type !== MAILBOX_EVENT || !isRecord(event.data)) return
    const { runId, type } = event.data
    if (typeof runId !== 'string' || !isMailboxWakeType(type)) return
    const matches = store.list().filter((enrollment) =>
      enrollment.orchestrationRunId === runId && enrollment.terminalAtMs === null
    )
    if (matches.length === 1) onWake(matches[0]!.watcherId)
  })

  async function ensureRun(enrollment: Enrollment): Promise<string> {
    if (disposed) throw new Error('orchestration adapter is disposed')
    if (enrollment.orchestrationRunId !== null) return enrollment.orchestrationRunId
    if (!enrollment.coordinator.handle || !enrollment.coordinator.paneKey) {
      throw new Error('the enrollment has no minted coordinator identity')
    }
    const requestId = deterministicRequestId(`heimdall-run-create-v1\0${enrollment.watcherId}`)
    const key = enrollment.watcherId
    const objective = `Heimdall ${enrollment.kind} watcher ${enrollment.watcherId}`
    const preparedEventId = recordEventId(`run-create-prepared:${enrollment.watcherId}:${requestId}`)
    const existing = store.journal(enrollment.watcherId).find((entry) => entry.eventId === preparedEventId)
    if (existing) {
      if (existing.kind !== 'orchestration-run-create' || existing.requestId !== requestId || existing.key !== key || existing.objective !== objective) {
        throw new Error('persisted orchestration run request does not match its stable identity')
      }
    } else {
      store.append(enrollment.watcherId, {
        eventId: preparedEventId,
        atMs: Date.now(),
        class: 'fact',
        origin: 'owner',
        kind: 'orchestration-run-create',
        resolved: false,
        state: 'prepared',
        requestId,
        key,
        objective
      })
    }
    const value = await context.call('quirky.orchestration/serviceRunCreate', {
      requestId,
      contractVersion: CONTRACT_VERSION,
      key,
      objective
    })
    if (disposed) throw new Error('orchestration adapter was disposed during run creation')
    if (!hasMutationReceipt(value, requestId)) throw new Error('run creation receipt is missing or mismatched')
    if (!isRecord(value) || !isRecord(value.run) || typeof value.run.id !== 'string' || !value.run.id.startsWith('run_')) {
      throw new Error('run creation returned no valid run identity')
    }
    const runId = value.run.id
    const current = store.get(enrollment.watcherId)
    if (!current) throw new Error('the enrollment disappeared before its orchestration run was recorded')
    if (current.orchestrationRunId !== null && current.orchestrationRunId !== runId) {
      throw new Error('the enrollment already belongs to a different orchestration run')
    }
    store.transaction(() => {
      if (current.orchestrationRunId === null) store.save({ ...current, orchestrationRunId: runId })
      store.append(enrollment.watcherId, {
        eventId: recordEventId(`run-create-completed:${enrollment.watcherId}:${requestId}`),
        atMs: Date.now(),
        class: 'fact',
        origin: 'owner',
        kind: 'orchestration-run-create',
        resolved: true,
        state: 'created',
        requestId,
        key,
        objective,
        runId
      })
    })
    return runId
  }

  async function startWorker(requestId: string, runId: string, request: WorkerRequest): Promise<DispatchResult> {
    if (disposed) return { kind: 'refused', reason: 'adapter-disposed', detail: 'orchestration adapter is disposed' }
    let value: unknown
    try {
      value = await context.call('quirky.orchestration/serviceWorkerStart', {
        ...workerStartParams(request),
        runId,
        requestId,
        contractVersion: CONTRACT_VERSION
      })
    } catch (error) {
      return indeterminateWorkerResult(requestId, `worker start reply is unknown: ${errorMessage(error)}`, error)
    }
    if (disposed) return { kind: 'indeterminate', requestId, detail: 'worker start completed after the shutdown fence' }
    if (!hasMutationReceipt(value, requestId) || !isRecord(value)) {
      return { kind: 'indeterminate', requestId, detail: 'worker start returned no matching mutation receipt' }
    }
    if (value.runId !== runId) {
      return { kind: 'indeterminate', requestId, detail: 'worker start receipt belongs to a different run' }
    }
    if (value.state === 'failed') {
      return {
        kind: 'refused',
        reason: typeof value.failedStage === 'string' ? value.failedStage : 'worker-start-failed',
        ...(typeof value.lastError === 'string' ? { detail: value.lastError } : {})
      }
    }
    if (value.state === 'outcome_unknown') {
      return {
        kind: 'indeterminate', requestId,
        detail: typeof value.lastError === 'string' ? value.lastError : 'worker start outcome is unknown'
      }
    }
    if (value.state !== 'ready' || typeof value.dispatchId !== 'string' || value.dispatchId.length === 0) {
      return { kind: 'indeterminate', requestId, detail: 'worker start receipt does not prove a dispatch identity' }
    }
    return { kind: 'dispatched', dispatchId: value.dispatchId }
  }
  async function completeCheck(enrollment: Enrollment, runId: string, prepared: PreparedCheck): Promise<CompletedCheck> {
    if (disposed) throw new Error('orchestration adapter is disposed')
    const params: Record<string, unknown> = {
      runId,
      requestId: prepared.requestId,
      contractVersion: CONTRACT_VERSION,
      wait: false,
      types: [...MAILBOX_TYPES]
    }
    if (prepared.ackDeliveryId !== undefined) params.ackDeliveryId = prepared.ackDeliveryId
    const value = await context.call('quirky.orchestration/serviceCheck', params)
    if (disposed) throw new Error('mailbox check completed after the shutdown fence')
    if (!hasMutationReceipt(value, prepared.requestId) || !isRecord(value) || value.mode !== 'consume' || value.runId !== runId) {
      throw new Error('mailbox check returned no matching consuming receipt')
    }
    if (value.cancelled === true || value.connectionLost === true || value.waitInterrupted !== undefined) {
      throw new Error('mailbox check was interrupted; its delivery remains unresolved')
    }
    if (!Array.isArray(value.messages) || !Array.isArray(value.questions)) {
      throw new Error('mailbox check returned malformed message evidence')
    }
    if (prepared.ackDeliveryId !== undefined && value.acknowledged !== prepared.ackDeliveryId) {
      throw new Error(`mailbox did not confirm acknowledgement of ${prepared.ackDeliveryId}`)
    }
    const deliveryId = value.deliveryId
    if (deliveryId !== null && typeof deliveryId !== 'string') {
      throw new Error('mailbox check returned an invalid delivery identity')
    }
    if (deliveryId === null && value.messages.length > 0) {
      throw new Error('mailbox messages arrived without a durable delivery identity')
    }
    const eventId = recordEventId(`mailbox-completed:${enrollment.watcherId}:${prepared.requestId}`)
    let row!: CompletedCheck
    store.transaction(() => {
      row = store.append(enrollment.watcherId, {
        eventId,
        atMs: Date.now(),
        class: 'fact',
        origin: 'owner',
        kind: MAILBOX_JOURNAL_KIND,
        resolved: true,
        state: 'completed',
        requestId: prepared.requestId,
        ...(prepared.ackDeliveryId === undefined ? {} : { ackDeliveryId: prepared.ackDeliveryId }),
        acknowledged: typeof value.acknowledged === 'string' ? value.acknowledged : null,
        deliveryId: typeof deliveryId === 'string' ? deliveryId : null,
        messages: value.messages,
        questions: value.questions
      }) as CompletedCheck
    })
    return row
  }

  function prepareCheck(enrollment: Enrollment, ackDeliveryId?: string): PreparedCheck {
    const entries = store.journal(enrollment.watcherId).filter((entry) => entry.kind === MAILBOX_JOURNAL_KIND)
    const completed = new Set(entries.filter((entry) => entry.state === 'completed').map((entry) => entry.requestId))
    const pending = [...entries].reverse().find((entry): entry is PreparedCheck =>
      entry.state === 'prepared' && typeof entry.requestId === 'string' && !completed.has(entry.requestId) &&
      (ackDeliveryId === undefined || entry.ackDeliveryId === ackDeliveryId)
    )
    if (pending) return pending
    const sequence = entries.filter((entry) => entry.state === 'prepared').length + 1
    const requestId = deterministicRequestId(
      `heimdall-mailbox-check-v1\0${enrollment.watcherId}\0${enrollment.orchestrationRunId}\0${sequence}\0${ackDeliveryId ?? ''}`
    )
    return store.append(enrollment.watcherId, {
      eventId: recordEventId(`mailbox-prepared:${enrollment.watcherId}:${requestId}`),
      atMs: Date.now(),
      class: 'fact',
      origin: 'owner',
      kind: MAILBOX_JOURNAL_KIND,
      resolved: false,
      state: 'prepared',
      requestId,
      sequence,
      ...(ackDeliveryId === undefined ? {} : { ackDeliveryId })
    }) as PreparedCheck
  }

  function pendingDelivery(enrollment: Enrollment): CompletedCheck | null {
    const entries = store.journal(enrollment.watcherId)
    const acknowledged = new Set<string>()
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!
      if (entry.kind !== MAILBOX_JOURNAL_KIND || entry.state !== 'completed') continue
      if (typeof entry.ackDeliveryId === 'string' && entry.acknowledged === entry.ackDeliveryId) {
        acknowledged.add(entry.ackDeliveryId)
      }
      if (typeof entry.deliveryId === 'string' && !acknowledged.has(entry.deliveryId)) return entry as CompletedCheck
    }
    return null
  }

  function decodeMessages(completed: CompletedCheck): WorkerMessage[] {
    const sourceMessages = completed.messages.map((message) => {
      if (!isRecord(message) || typeof message.id !== 'string' || typeof message.type !== 'string' || typeof message.body !== 'string') {
        throw new Error('mailbox contains a malformed worker message')
      }
      return message
    })
    const questions = completed.questions.flatMap((question) => {
      if (!isRecord(question) || typeof question.messageId !== 'string' || typeof question.dispatchId !== 'string') return []
      if (question.status !== 'pending' && question.status !== 'answered' && question.status !== 'closed') return []
      return [question]
    })
    const questionById = new Map(questions.map((question) => [question.messageId as string, question]))
    const seen = new Set<string>()
    const result: WorkerMessage[] = sourceMessages.map((message) => {
      seen.add(message.id as string)
      return workerMessage(message, questionById.get(message.id as string))
    })
    for (const question of questions) {
      if (seen.has(question.messageId as string)) continue
      result.push({
        id: question.messageId as string,
        type: 'question',
        dispatchId: question.dispatchId as string,
        body: typeof question.answerBody === 'string' ? question.answerBody : typeof question.body === 'string' ? question.body : typeof question.question === 'string' ? question.question : '',
        resolved: question.status === 'answered' || question.status === 'closed',
        raw: question as unknown as Json
      })
    }
    return result
  }

  function workerMessage(message: JsonRecord, question?: JsonRecord): WorkerMessage {
    const sender = isRecord(message.sender) ? message.sender : null
    const payload = isRecord(message.payload) ? message.payload : null
    const senderDispatch = sender?.kind === 'dispatch' && typeof sender.dispatchId === 'string' ? sender.dispatchId : undefined
    const payloadDispatch = payload && typeof payload.dispatchId === 'string' ? payload.dispatchId : undefined
    const dispatchId = senderDispatch !== undefined && payloadDispatch !== undefined && senderDispatch !== payloadDispatch
      ? undefined
      : senderDispatch ?? payloadDispatch
    const outcome = message.type === 'worker_done' && payload?.outcome === 'succeeded'
      ? 'succeeded'
      : message.type === 'worker_done' && payload?.outcome === 'failed' ? 'failed' : undefined
    return {
      id: message.id as string,
      type: message.type as string,
      body: message.body as string,
      ...(dispatchId === undefined ? {} : { dispatchId }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(question === undefined ? {} : { resolved: question.status === 'answered' || question.status === 'closed' }),
      raw: message as unknown as Json
    }
  }


  return {
    async dispatch(enrollment, attempt, request) {
      if (disposed) return { kind: 'refused', reason: 'adapter-disposed', detail: 'orchestration adapter is disposed' }
      const requestId = preparedRequestId(attempt)
      if (requestId === null || !attempt.workerRequest || !sameJson(attempt.workerRequest, request)) {
        return { kind: 'refused', reason: 'invalid-prepared-request', detail: 'worker request does not match its persisted attempt' }
      }
      if (!enrollment.coordinator.handle || !enrollment.coordinator.paneKey) {
        return { kind: 'refused', reason: 'coordinator-not-minted', detail: 'the enrollment has no minted coordinator identity' }
      }
      if (!validWorkerRequest(request)) {
        return { kind: 'refused', reason: 'invalid-worker-request', detail: 'worker request requires string spec and worktree' }
      }
      try {
        const runId = await ensureRun(enrollment)
        return await startWorker(requestId, runId, request)
      } catch (error) {
        return indeterminateWorkerResult(requestId, `orchestration run creation or dispatch is uncertain: ${errorMessage(error)}`, error)
      }
    },
    async recover(enrollment, attempt) {
      const request = attempt.workerRequest
      if (store.readOnly || disposed || !request) return null
      const requestId = preparedRequestId(attempt)
      if (requestId === null || !validWorkerRequest(request)) {
        return { kind: 'indeterminate', requestId: attempt.requestId ?? 'unknown', detail: 'persisted worker replay data is incomplete' }
      }
      try {
        const runId = await ensureRun(enrollment)
        if (disposed) return { kind: 'indeterminate', requestId, detail: 'worker recovery completed after the shutdown fence' }
        return await startWorker(requestId, runId, request)
      } catch (error) {
        return indeterminateWorkerResult(requestId, `worker recovery is uncertain: ${errorMessage(error)}`, error)
      }
    },
    async observeWorkers(enrollment): Promise<KernelWorkerObservation[]> {
      if (store.readOnly || disposed || enrollment.orchestrationRunId === null) return []
      const runId = enrollment.orchestrationRunId
      const value = await context.call('quirky.orchestration/serviceRunShow', { runId })
      if (disposed) throw new Error('worker observation completed after orchestration shutdown')
      return workerObservationsFromRun(value, runId)
    },
    async mailbox(enrollment) {
      if (store.readOnly || disposed || enrollment.orchestrationRunId === null) return []
      const runId = enrollment.orchestrationRunId
      const delivery = pendingDelivery(enrollment)
      if (delivery) return decodeMessages(delivery)
      const prepared = prepareCheck(enrollment)
      const completed = await completeCheck(enrollment, runId, prepared)
      return decodeMessages(completed)
    },
    async acknowledge(enrollment, messages) {
      if (disposed) throw new Error('cannot acknowledge after orchestration shutdown')
      if (store.readOnly) throw new Error('cannot acknowledge mailbox messages in read-only mode')
      if (messages.length === 0 || enrollment.orchestrationRunId === null) return
      const delivery = pendingDelivery(enrollment)
      if (!delivery || typeof delivery.deliveryId !== 'string') return
      const deliveredIds = new Set(delivery.messages.flatMap((message) => isRecord(message) && typeof message.id === 'string' ? [message.id] : []))
      if ([...deliveredIds].some((id) => !messages.some((message) => message.id === id))) return
      const prepared = prepareCheck(enrollment, delivery.deliveryId)
      const runId = enrollment.orchestrationRunId
      await completeCheck(enrollment, runId, prepared)
    },
    async release(enrollment, dispatchId) {
      if (disposed) throw new Error('cannot release workers after orchestration shutdown')
      if (store.readOnly) throw new Error('cannot release a worker in read-only mode')
      if (enrollment.orchestrationRunId === null || !dispatchId.startsWith('ctx_')) {
        throw new Error('worker release requires the enrollment run and an exact dispatch identity')
      }
      const requestId = deterministicRequestId(`heimdall-worker-release-v1\0${enrollment.watcherId}\0${enrollment.orchestrationRunId}\0${dispatchId}`)
      const previous = store.journal(enrollment.watcherId).find((entry) =>
        entry.kind === RELEASE_JOURNAL_KIND && entry.dispatchId === dispatchId && entry.state === 'released'
      )
      if (previous) return
      const preparedEventId = recordEventId(`worker-release-prepared:${enrollment.watcherId}:${requestId}`)
      const existing = store.journal(enrollment.watcherId).find((entry) => entry.eventId === preparedEventId)
      if (existing) {
        if (existing.kind !== RELEASE_JOURNAL_KIND || existing.runId !== enrollment.orchestrationRunId || existing.dispatchId !== dispatchId || existing.requestId !== requestId) {
          throw new Error('persisted worker release request does not match its stable identity')
        }
      } else {
        store.append(enrollment.watcherId, {
          eventId: preparedEventId,
          atMs: Date.now(),
          class: 'fact',
          origin: 'owner',
          kind: RELEASE_JOURNAL_KIND,
          resolved: false,
          state: 'prepared',
          runId: enrollment.orchestrationRunId,
          dispatchId,
          requestId
        })
      }
      const value = await context.call('quirky.orchestration/serviceWorkerRelease', {
        runId: enrollment.orchestrationRunId,
        dispatchId,
        requestId,
        contractVersion: CONTRACT_VERSION
      })
      if (disposed) throw new Error('worker release completed after the shutdown fence')
      if (!hasMutationReceipt(value, requestId) || !isRecord(value) || value.dispatchId !== dispatchId) {
        throw new Error('worker release returned no matching mutation receipt')
      }
      if (value.processAction === 'unknown' || value.state === 'release_unknown' || value.state === 'release_pending' || value.state === 'unknown') {
        throw new Error(`worker release outcome is unknown${typeof value.lastError === 'string' ? `: ${value.lastError}` : ''}`)
      }
      if (value.state !== 'released' && value.state !== 'retained' && value.alreadySettled !== true) {
        throw new Error(`worker release was not confirmed: ${String(value.state)}`)
      }
      store.append(enrollment.watcherId, {
        eventId: recordEventId(`worker-release-completed:${enrollment.watcherId}:${requestId}`),
        atMs: Date.now(),
        class: 'fact',
        origin: 'owner',
        kind: RELEASE_JOURNAL_KIND,
        resolved: true,
        state: 'released',
        runId: enrollment.orchestrationRunId,
        dispatchId,
        requestId,
        processAction: value.processAction,
        archive: value.archive ?? null
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
  }
}

function preparedRequestId(attempt: Attempt): string | null {
  const requestId = orchestrationRequestIdForAttemptFingerprint(attempt.fingerprint)
  return attempt.requestId === requestId ? requestId : null
}

function validWorkerRequest(request: WorkerRequest): boolean {
  if (typeof request.spec !== 'string' || typeof request.worktree !== 'string' || request.worktree.length === 0) return false
  const stringFields = ['taskId', 'agent', 'taskTitle', 'model', 'effort', 'name', 'repo', 'baseBranch', 'displayName', 'comment', 'retryOfDispatchId'] as const
  for (const key of stringFields) {
    if (request[key] !== undefined && typeof request[key] !== 'string') return false
  }
  if (request.setup !== undefined && request.setup !== 'run' && request.setup !== 'skip' && request.setup !== 'inherit') return false
  if (request.mode !== undefined && request.mode !== 'terminal' && request.mode !== 'structured') return false
  if (request.timeoutMs !== undefined && (typeof request.timeoutMs !== 'number' || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) return false
  if (request.dependencyTaskIds !== undefined && (!Array.isArray(request.dependencyTaskIds) || !request.dependencyTaskIds.every((value) => typeof value === 'string'))) return false
  if (request.parentTaskId !== undefined && typeof request.parentTaskId !== 'string') return false
  return true
}

function workerStartParams(request: WorkerRequest): Record<string, unknown> {
  const params: Record<string, unknown> = { spec: request.spec, worktree: request.worktree }
  const stringFields = ['taskId', 'agent', 'taskTitle', 'model', 'effort', 'name', 'repo', 'baseBranch', 'displayName', 'comment', 'retryOfDispatchId'] as const
  for (const key of stringFields) {
    const value = request[key]
    if (typeof value === 'string') params[key] = value
  }
  if (request.setup !== undefined) params.setup = request.setup
  if (request.mode !== undefined) params.mode = request.mode
  if (request.timeoutMs !== undefined) params.timeoutMs = request.timeoutMs
  if (request.dependencyTaskIds !== undefined) params.dependencyTaskIds = request.dependencyTaskIds
  if (request.parentTaskId !== undefined) params.parentTaskId = request.parentTaskId
  return params
}

function hasMutationReceipt(value: unknown, requestId: string): boolean {
  return isRecord(value) && isRecord(value.mutation) && value.mutation.requestId === requestId && typeof value.mutation.replayed === 'boolean'
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMailboxWakeType(value: unknown): value is (typeof MAILBOX_TYPES)[number] {
  return value === 'worker_done' || value === 'question' || value === 'escalation'
}

function deterministicRequestId(seed: string): string {
  return uuidV8(sha256(seed))
}

function recordEventId(seed: string): string {
  return deterministicRequestId(`heimdall-journal-event-v1\0${seed}`)
}

function uuidV8(digest: Uint8Array): string {
  const bytes = digest.slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sha256(value: string): Uint8Array {
  return createHash('sha256').update(value).digest()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
