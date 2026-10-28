import { createHash } from 'node:crypto'
import { RpcErrorCode, validateValue, type PluginContext, type Schema } from '@quirky/protocol'
import type { Enrollment, Inspection, KernelStore, Runner } from './contracts'
import type { CommandResult, KernelControlHost, WatcherWorker, WorkerIdentity } from './control-contracts'

interface ServiceWorkerView { dispatchId: string; sessionId: string | null; processIncarnation: string | null; state: 'live' | 'exited' | 'unverifiable'; lastContactAtMs: number | null }
interface ServiceQuestionView { messageId: string; dispatchId: string; body: string; status: 'pending' | 'answered' | 'closed' }
interface ServiceRunView { run: { id: string }; workers: ServiceWorkerView[]; questions: ServiceQuestionView[] }
const runViewSchema: Schema = {
  type: 'object', additionalProperties: true, required: ['run', 'workers', 'questions'], properties: {
    run: { type: 'object', additionalProperties: true, required: ['id'], properties: { id: { type: 'string' } } },
    workers: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['dispatchId', 'sessionId', 'processIncarnation', 'state', 'lastContactAtMs'], properties: {
      dispatchId: { type: 'string' }, sessionId: {}, processIncarnation: {}, lastContactAtMs: {}, state: { type: 'string', enum: ['live', 'exited', 'unverifiable'] }
    } } },
    questions: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['messageId', 'dispatchId', 'body', 'status'], properties: {
      messageId: { type: 'string' }, dispatchId: { type: 'string' }, body: { type: 'string' }, status: { type: 'string', enum: ['pending', 'answered', 'closed'] }
    } } }
  }
}
const questionReplySchema: Schema = {
  type: 'object', additionalProperties: true, required: ['kind', 'messageId', 'duplicate'],
  properties: { kind: { type: 'string' }, messageId: { type: 'string' }, duplicate: { type: 'boolean' } }
}
const workerStopSchema: Schema = {
  type: 'object', additionalProperties: true, required: ['dispatchId', 'state', 'processAction'],
  properties: {
    dispatchId: { type: 'string' }, state: { type: 'string' }, processAction: { type: 'string' },
    alreadySettled: { type: 'boolean' }, lastError: { type: 'string' }, warning: { type: 'string' }
  }
}
function parseResponse<T>(schema: Schema, value: unknown): T {
  const failure = validateValue(schema, value, 'owner service response')
  if (failure) throw new Error(failure)
  // Runtime schema validation establishes this RPC boundary shape.
  return value as T
}
function parseRunView(value: unknown): ServiceRunView {
  const view = parseResponse<ServiceRunView>(runViewSchema, value)
  // The flat schema subset needs explicit checks for string-or-null fields.
  for (const worker of view.workers) {
    if (worker.sessionId !== null && typeof worker.sessionId !== 'string') throw new Error('Invalid worker session identity')
    if (worker.processIncarnation !== null && typeof worker.processIncarnation !== 'string') throw new Error('Invalid worker process identity')
    if (worker.lastContactAtMs !== null && (typeof worker.lastContactAtMs !== 'number' || !Number.isFinite(worker.lastContactAtMs))) throw new Error('Invalid worker contact timestamp')
  }
  return view
}
export interface OperatorKernel {
  store: KernelStore
  inspect(watcherId: string): Inspection | null | Promise<Inspection | null>
  runner(watcherId: string): Runner | undefined
  changed(watcherId: string): void
  reconcile(watcherId: string): void | Promise<void>
  /** Removes the stopped runner from the registry without awaiting the current control operation. */
  forgetRunner(watcherId: string): void
  answerOwnerEscalation?(enrollment: Enrollment, escalationId: string, body: string): Promise<CommandResult>
}

const refused = (detail: string): CommandResult => ({ kind: 'refused', reason: 'worker-unverifiable', detail })
const applied = (): CommandResult => ({ kind: 'applied', appliedAtMs: Date.now() })
function requestId(enrollment: Enrollment, kind: string, identity: unknown): string {
  const h = createHash('sha256').update(JSON.stringify(['heimdall-control-v1', enrollment.watcherId, enrollment.commandRevision, kind, identity])).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
function authorityFailure(error: unknown): CommandResult {
  const message = error instanceof Error ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (code === RpcErrorCode.NotFound) return refused(message)
  if (code === RpcErrorCode.MethodNotFound) return { kind: 'refused', reason: 'unsupported-capability', detail: message }
  if (code === RpcErrorCode.Conflict) return { kind: 'refused', reason: 'owner-conflict', detail: message }
  if (code === RpcErrorCode.InvalidParams) return { kind: 'refused', reason: 'invalid-command', detail: message }
  return { kind: 'indeterminate', detail: message }
}

/** The adapter uses public orchestration owner-service RPC; fleet reads never consume its mailbox. */
export function createControlHost(context: PluginContext, kernel: OperatorKernel): KernelControlHost {
  async function show(enrollment: Enrollment): Promise<ServiceRunView | null> {
    if (!enrollment.orchestrationRunId) return null
    const view = parseRunView(await context.call('quirky.orchestration/serviceRunShow', { runId: enrollment.orchestrationRunId }))
    if (view.run.id !== enrollment.orchestrationRunId) throw new Error('Owner service returned a different watcher run')
    return view
  }
  return {
    context, store: kernel.store,
    inspect: id => kernel.inspect(id),
    withControl(id, drain, operation) {
      const runner = kernel.runner(id)
      if (runner) {
        if (!runner.withControl) return Promise.reject(new Error('Watcher runner does not support fenced controls'))
        return runner.withControl(operation, drain)
      }
      // A dormant/terminal watcher has no tick to drain. The plane still serializes its mutations.
      return operation()
    },
    changed: id => kernel.changed(id),
    reconcile: id => kernel.reconcile(id),
    remove(id) {
      const runner = kernel.runner(id)
      runner?.suspend()
      if (!kernel.store.remove) throw new Error('Watcher store does not support atomic deletion')
      kernel.store.remove(id)
      kernel.forgetRunner(id)
    },
    async workers(enrollment): Promise<WatcherWorker[]> {
      const view = await show(enrollment)
      if (!view) return []
      return view.workers.map(worker => {
        const question = view.questions.find(item => item.dispatchId === worker.dispatchId && item.status === 'pending')
        return {
          identity: {
            dispatchId: worker.dispatchId,
            ...(worker.sessionId ? { sessionId: worker.sessionId } : {}),
            ...(worker.processIncarnation ? { processIncarnation: worker.processIncarnation } : {})
          },
          state: worker.state,
          ...(worker.lastContactAtMs !== null ? { lastContactAtMs: worker.lastContactAtMs } : {}),
          ...(question ? { question: { messageId: question.messageId, body: question.body, answered: false } } : {})
        }
      })
    },
    async answerQuestion(enrollment, messageId, body) {
      try {
        const view = await show(enrollment)
        const question = view?.questions.find(item => item.messageId === messageId)
        if (!question) return refused('The exact worker question cannot be verified in this watcher run')
        if (question.status !== 'pending') return { kind: 'refused', reason: 'question-already-answered', detail: 'The worker question is already answered or closed' }
        const worker = view?.workers.find(item => item.dispatchId === question.dispatchId)
        if (!worker || worker.state !== 'live' || !worker.sessionId || !worker.processIncarnation) return refused('The exact worker question owner is not live and verifiable')
        const result = parseResponse<{ kind: string; messageId: string; duplicate: boolean }>(questionReplySchema,
          await context.call('quirky.orchestration/serviceReply', {
            runId: enrollment.orchestrationRunId, messageId, body, requestId: requestId(enrollment, 'answer-question', [messageId, body]), contractVersion: 1
          }))
        if (result.kind !== 'question_answer' || result.messageId !== messageId) return { kind: 'indeterminate', detail: 'Owner service did not confirm an answer to the exact question' }
        if (result.duplicate) return { kind: 'refused', reason: 'question-already-answered', detail: 'The worker question is already answered' }
        return applied()
      } catch (error) { return authorityFailure(error) }
    },
    async answerEscalation(enrollment, escalationId, body) {
      if (enrollment.parkReason?.toString() === 'owner-escalation' || ('owner' in enrollment && enrollment.owner)) {
        if (!kernel.answerOwnerEscalation) return { kind: 'refused', reason: 'unsupported-capability', detail: 'The owner controller is not available to answer this escalation' }
        return kernel.answerOwnerEscalation(enrollment, escalationId, body)
      }
      // Non-owner escalations are local journal entities; the plane validates and resolves the exact revision.
      return applied()
    },
    async stopWorker(enrollment, identity: WorkerIdentity) {
      if (!identity.sessionId || !identity.processIncarnation) return refused('An exact session and process incarnation are required to stop a worker')
      try {
        const view = await show(enrollment)
        const worker = view?.workers.find(item => item.dispatchId === identity.dispatchId)
        if (!worker || worker.sessionId !== identity.sessionId || worker.processIncarnation !== identity.processIncarnation || worker.state === 'unverifiable') return refused('The exact worker process is no longer verifiable')
        const result = parseResponse<{ dispatchId: string; state: string; processAction: string; alreadySettled?: boolean; lastError?: string; warning?: string }>(workerStopSchema,
          await context.call('quirky.orchestration/serviceWorkerStop', {
            runId: enrollment.orchestrationRunId, dispatchId: identity.dispatchId,
            expectedIdentity: { sessionId: identity.sessionId, processIncarnation: identity.processIncarnation },
            requestId: requestId(enrollment, 'stop-worker', identity), contractVersion: 1
          }))
        if (result.dispatchId !== identity.dispatchId) return { kind: 'indeterminate', detail: 'Owner service did not confirm the exact worker stop' }
        if (result.processAction === 'unknown' || result.state === 'stop_unknown') return { kind: 'indeterminate', detail: result.lastError ?? result.warning ?? 'Worker stop outcome is unknown' }
        if (result.processAction === 'closed_agent_terminal' || (result.alreadySettled && ['stopped', 'succeeded', 'failed'].includes(result.state))) return applied()
        return refused(result.warning ?? result.lastError ?? 'The worker owner refused to stop this process')
      } catch (error) { return authorityFailure(error) }
    }
  }
}
