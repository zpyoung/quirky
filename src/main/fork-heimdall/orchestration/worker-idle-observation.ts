import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import type { OrchestrationDb, RunRow } from '../../runtime/orchestration/db'
import { redactWorkerTerminalLines } from '../../runtime/orchestration/worker-terminal-redaction'
import {
  inspectWorkerTerminal,
  projectFleetWorker
} from '../../runtime/rpc/methods/orchestration/worker/worker-observation'
import { readExactWorkerOutput } from '../../runtime/rpc/methods/orchestration/worker/worker-output'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { clipWorkerLastMessage } from '../../../shared/fork-heimdall/owner/worker-last-message'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { WorkerIdleObservation, WorkerLastMessage } from './orchestration-contract'

const LAST_MESSAGE_TRANSCRIPT_LIMIT = 12
const LAST_MESSAGE_TERMINAL_LINES = 40

function unavailable(reason: string): WorkerIdleObservation {
  return { status: 'unavailable', reason }
}

/** Adapter entry point: a lost coordinator seat propagates; any other failure is `unavailable`. */
export async function observeEnrolledWorkerIdle(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment,
  dispatchId: string,
  resolveRun: (runId: string) => RunRow
): Promise<WorkerIdleObservation> {
  if (!enrollment.orchestrationRunId) {
    return unavailable('watcher has no orchestration Run')
  }
  const run = resolveRun(enrollment.orchestrationRunId)
  try {
    return await observeWorkerIdle(runtime, runtime.getOrchestrationDb(), run, dispatchId)
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Observes whether one of this Run's workers sits idle at its prompt, and if so what it last said.
 * Idleness needs the exact process, a live fleet verdict from this host, and an agent status of
 * waiting or done; everything else is `active` or `unavailable`, never inferred idle.
 */
export async function observeWorkerIdle(
  runtime: QuirkyRuntimeService,
  db: OrchestrationDb,
  run: RunRow,
  dispatchId: string
): Promise<WorkerIdleObservation> {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || dispatch.run_id !== run.id) {
    return unavailable(`Dispatch ${dispatchId} does not belong to Run ${run.id}`)
  }
  if (db.getFederatedDispatch(dispatchId)) {
    return unavailable('federated worker')
  }
  const worker = db.getWorkerDispatch(dispatchId)
  const handle = worker?.agent_terminal_handle ?? dispatch.assignee_handle
  if (!handle || isStructuredWorkerHandle(handle)) {
    return unavailable(handle ? 'structured worker' : 'worker has no terminal')
  }
  const terminal = await inspectWorkerTerminal(runtime, db, dispatchId)
  if (!terminal.exact || terminal.status !== 'live') {
    return unavailable(`worker terminal is ${terminal.status}`)
  }
  const fleet = projectFleetWorker(runtime, db, dispatchId)
  if (!fleet || fleet.liveness.verdict !== 'live') {
    return unavailable('agent status is not live')
  }
  if (fleet.host.kind !== 'local') {
    return unavailable('remote worker')
  }
  const activity = fleet.stage.activity
  if (activity !== 'waiting' && activity !== 'done') {
    return { status: 'active' }
  }
  const lastMessage = await readLastMessage(runtime, {
    dispatchId,
    handle,
    workerState: worker?.state ?? 'unsupervised',
    attachedAt: worker?.created_at ?? dispatch.dispatched_at ?? dispatch.created_at
  })
  const after = await inspectWorkerTerminal(runtime, db, dispatchId)
  if (!after.exact || after.status !== 'live') {
    return unavailable('worker changed while its output was read')
  }
  return { status: 'idle', activity, idleSinceMs: fleet.liveness.observedAt, lastMessage }
}

async function readLastMessage(
  runtime: QuirkyRuntimeService,
  args: { dispatchId: string; handle: string; workerState: string; attachedAt: string }
): Promise<WorkerLastMessage | null> {
  let output: OrchestrationWorkerReadResult
  try {
    output = await readExactWorkerOutput({
      runtime,
      dispatchId: args.dispatchId,
      terminalHandle: args.handle,
      workerState: args.workerState,
      terminalStatus: 'running',
      terminalLiveness: 'live',
      attachedAt: args.attachedAt,
      source: 'auto',
      limit: LAST_MESSAGE_TRANSCRIPT_LIMIT
    })
  } catch {
    return null
  }
  const text = lastMessageText(output)
  if (!text) {
    return null
  }
  // idempotent on already-redacted transcript text; the terminal fallback may carry raw lines
  const redacted = redactWorkerTerminalLines([text]).lines[0] ?? ''
  return redacted.trim() ? clipWorkerLastMessage(redacted) : null
}

function lastMessageText(output: OrchestrationWorkerReadResult): string | null {
  if (output.source === 'transcript') {
    const message = output.transcript.messages.findLast(
      (candidate) =>
        candidate.role === 'assistant' && candidate.blocks.some((block) => block.type === 'text')
    )
    return message
      ? message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      : null
  }
  const lines = [
    ...output.terminal.tail,
    ...(output.terminal.draft ? [output.terminal.draft] : [])
  ].slice(-LAST_MESSAGE_TERMINAL_LINES)
  return lines.length > 0 ? lines.join('\n') : null
}
