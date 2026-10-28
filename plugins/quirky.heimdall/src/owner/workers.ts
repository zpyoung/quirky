import type { PluginContext } from '@quirky/protocol'
import type { ExecuteResult, KernelStore, KernelWorkerObservation } from '../contracts'
import type { OwnerEnrollment, OwnerIntervention } from './contracts'

type WorkerIntervention = Extract<OwnerIntervention, { dispatchId: string }>
interface OwnedQuestion { messageId: string; dispatchId: string; status: string; body?: string }
export interface OwnedRunSnapshot { run: { id: string }; workers: KernelWorkerObservation[]; questions: OwnedQuestion[] }

/** Authentication is performed by the orchestration service using this plugin's caller identity. */
export async function readOwnedRun(context: PluginContext, enrollment: OwnerEnrollment): Promise<OwnedRunSnapshot | null> {
  if (!enrollment.orchestrationRunId) return null
  const result = await context.call('quirky.orchestration/serviceRunShow', { runId: enrollment.orchestrationRunId }) as OwnedRunSnapshot
  if (!result || result.run?.id !== enrollment.orchestrationRunId || !Array.isArray(result.workers) || !Array.isArray(result.questions)) {
    throw new Error('invalid owned-run projection')
  }
  return result
}

/** Called only after the kernel durably records an allowed owner action attempt. */
export async function executeWorkerIntervention(
  context: PluginContext, store: KernelStore, enrollment: OwnerEnrollment,
  intervention: WorkerIntervention, attemptId: string,
): Promise<ExecuteResult> {
  const snapshot = await readOwnedRun(context, enrollment)
  const worker = snapshot?.workers.find(value => value.dispatchId === intervention.dispatchId)
  const dispatched = store.journal(enrollment.watcherId).some(entry => entry.kind === 'attempt' && entry.dispatchId === intervention.dispatchId)
  if (!worker || !dispatched) return { effect: 'not-landed', reason: 'worker-not-owned' }
  const common = { runId: enrollment.orchestrationRunId!, requestId: attemptId, contractVersion: 1 }
  if (intervention.kind === 'stop-worker') {
    if (worker.state === 'unverifiable' || !worker.sessionId || !worker.processIncarnation) return { effect: 'not-landed', reason: 'worker-unverifiable' }
    const result = await context.call('quirky.orchestration/serviceWorkerStop', {
      ...common, dispatchId: worker.dispatchId,
      expectedIdentity: { sessionId: worker.sessionId, processIncarnation: worker.processIncarnation },
    }) as { dispatchId: string; processAction: string; state: string; alreadySettled?: boolean; lastError?: string; warning?: string }
    if (result.dispatchId !== worker.dispatchId) return { effect: 'indeterminate', reason: result.lastError ?? result.warning ?? 'worker-stop-dispatch-mismatch' }
    if (result.processAction === 'unknown' || result.state === 'stop_unknown') return { effect: 'indeterminate', reason: result.lastError ?? result.warning ?? 'worker-stop-unknown' }
    if (result.processAction !== 'closed_agent_terminal' && !(result.alreadySettled && ['stopped', 'succeeded', 'failed'].includes(result.state))) {
      return { effect: 'not-landed', reason: result.lastError ?? result.warning ?? 'worker-stop-refused' }
    }
    return { effect: 'landed', reason: 'worker-stopped' }
  }
  if (intervention.kind === 'answer-worker') {
    const question = snapshot!.questions.find(value => value.messageId === intervention.messageId && value.dispatchId === intervention.dispatchId && value.status === 'pending')
    if (!question) return { effect: 'not-landed', reason: 'question-not-owned' }
    const result = await context.call('quirky.orchestration/serviceReply', { ...common, messageId: intervention.messageId, body: intervention.body }) as { kind: string }
    return result.kind === 'question_answer'
      ? { effect: 'landed', reason: 'worker-answered' }
      : { effect: 'not-landed', reason: 'question-not-pending' }
  }
  const result = await context.call('quirky.orchestration/serviceSend', { ...common, dispatchId: worker.dispatchId, body: intervention.body }) as { kind: string }
  return result.kind === 'message'
    ? { effect: 'landed', reason: 'worker-message-sent' }
    : { effect: 'indeterminate', reason: 'worker-message-unknown' }
}
