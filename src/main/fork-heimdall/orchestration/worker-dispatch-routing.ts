import type { OrchestrationDb } from '../../runtime/orchestration/db'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import { inspectWorkerTerminal } from '../../runtime/rpc/methods/orchestration/worker/worker-observation'
import type {
  DispatchResult,
  DispatchWorkerInput
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { composeWorktreeId } from '../../../shared/worktree/id'

export function workerStartParams(input: DispatchWorkerInput) {
  const reuseTerminal = input.reuseTerminal?.trim()
  return {
    spec: input.spec,
    from: input.enrollment.coordinatorIdentity.handle,
    worktree: `id:${input.workspaceId ?? workspaceRuntimeId(input.enrollment)}`,
    ...(reuseTerminal
      ? { terminal: reuseTerminal }
      : {
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {})
        }),
    ...(input.deps ? { deps: JSON.stringify(input.deps) } : {}),
    ...(input.taskKey ? { taskTitle: input.taskKey } : {})
  }
}

export function dispatchResultWithTerminal(
  db: OrchestrationDb,
  result: DispatchResult
): DispatchResult {
  if (result.status !== 'dispatched') {
    return result
  }
  const terminalHandle =
    db.getWorkerDispatch(result.dispatchId)?.agent_terminal_handle ??
    db.getDispatchContextById(result.dispatchId)?.assignee_handle
  return typeof terminalHandle === 'string' && terminalHandle.trim()
    ? { ...result, terminalHandle }
    : result
}
export async function inspectHeimdallWorkerTerminal(
  runtime: QuirkyRuntimeService,
  dispatchId: string
) {
  return await inspectWorkerTerminal(runtime, runtime.getOrchestrationDb(), dispatchId)
}

export function workspaceRuntimeId(enrollment: WatcherEnrollment): string {
  return enrollment.worktreeId ?? composeWorktreeId(enrollment.repoId, enrollment.workspacePath)
}
