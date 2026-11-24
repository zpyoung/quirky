import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { inspectWorkerTerminal } from '../../runtime/rpc/methods/orchestration/worker/worker-observation'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { WorkerPromptUndeliverableError } from './orchestration-contract'

export const HEIMDALL_OWNER_REPLY_PREFIX = '[Heimdall owner reply]'

export async function sendEnrolledWorkerPrompt(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment,
  dispatchId: string,
  text: string,
  resolveRun: (runId: string) => RunRow
): Promise<void> {
  if (!enrollment.orchestrationRunId) {
    throw new WorkerPromptUndeliverableError(dispatchId, 'watcher has no orchestration Run')
  }
  const run = resolveRun(enrollment.orchestrationRunId)
  await sendWorkerPrompt(runtime, runtime.getOrchestrationDb(), run, dispatchId, text)
}

/**
 * Types an owner reply into a worker's agent prompt. Mailbox mail is pull-based, so an agent idle
 * at its prompt never reads it; the prompt is the only channel that wakes it. Delivery requires the
 * exact live process on a local PTY; anything else refuses rather than typing into another lane.
 */
export async function sendWorkerPrompt(
  runtime: QuirkyRuntimeService,
  db: OrchestrationDb,
  run: RunRow,
  dispatchId: string,
  text: string
): Promise<void> {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || dispatch.run_id !== run.id) {
    throw new WorkerPromptUndeliverableError(dispatchId, `not a Dispatch of Run ${run.id}`)
  }
  if (db.getFederatedDispatch(dispatchId)) {
    throw new WorkerPromptUndeliverableError(dispatchId, 'federated worker')
  }
  const handle = db.getWorkerDispatch(dispatchId)?.agent_terminal_handle ?? dispatch.assignee_handle
  if (!handle || isStructuredWorkerHandle(handle)) {
    throw new WorkerPromptUndeliverableError(
      dispatchId,
      handle ? 'structured worker' : 'no terminal'
    )
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  if (!observation.exact) {
    throw new WorkerPromptUndeliverableError(dispatchId, 'worker identity changed')
  }
  if (observation.status !== 'live') {
    throw new WorkerPromptUndeliverableError(dispatchId, `worker terminal is ${observation.status}`)
  }
  try {
    await runtime.sendTerminalAgentPrompt(handle, `${HEIMDALL_OWNER_REPLY_PREFIX} ${text.trim()}`, {
      inputKind: 'driving'
    })
  } catch (error) {
    throw new WorkerPromptUndeliverableError(
      dispatchId,
      error instanceof Error ? error.message : String(error)
    )
  }
}
