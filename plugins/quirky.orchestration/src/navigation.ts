import type { MethodHandler, PluginContext } from '@quirky/protocol'
import type { DispatchId, TaskId } from './contracts'
import type { FederationEngine } from './federation/contracts'
import type { OrchestrationWorkerCore } from './worker-integration'
import { fail } from './errors'
import { targetIdentity } from './identity'
import { createWorkerStore } from './workers/store'

type AssignmentRecord = {
  assignee_session_id: string | null
  runtime_epoch: string | null
  process_incarnation: string | null
  supervised: number
}

/** Read-only current terminal target, shared by links, rows and operator CLI navigation. */
export function createTaskNavigation(
  context: PluginContext,
  core: Pick<OrchestrationWorkerCore, 'store' | 'getTask'>,
  engine: FederationEngine
): MethodHandler {
  const workers = createWorkerStore(core.store)
  const latest = (taskId: TaskId): DispatchId | null => core.store.get<{ id: DispatchId }>(
    'SELECT id FROM dispatches WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', taskId
  )?.id ?? null
  const assignmentRecord = (dispatchId: DispatchId): AssignmentRecord => {
    const record = core.store.get<AssignmentRecord>(
      'SELECT assignee_session_id, runtime_epoch, process_incarnation, supervised FROM dispatches WHERE id = ?', dispatchId
    )
    if (!record) fail(context, 'dispatch_not_found', 'The Task Dispatch no longer exists', { dispatchId })
    return record
  }
  return async (params) => {
    if (typeof params.taskId !== 'string' || !params.taskId.startsWith('task_')) {
      fail(context, 'invalid_argument', 'taskId must identify a Task')
    }
    const taskId = params.taskId as TaskId
    const task = core.getTask(taskId)
    const dispatchId = latest(taskId)
    if (!dispatchId) fail(context, 'terminal_not_found', 'This Task has no Dispatch terminal to open', { taskId })
    const binding = engine.home(dispatchId)
    if (binding) {
      if (binding.side !== 'home' || binding.homeDispatchId !== dispatchId ||
        binding.homeTaskId !== taskId || binding.homeRunId !== task.runId) {
        fail(context, 'worker_identity_changed', 'The latest remote Dispatch binding no longer matches this Task.', { taskId, dispatchId })
      }
      return {
        kind: 'remote_output',
        taskId,
        dispatchId,
        viewId: 'view:quirky.orchestration/remote-worker-output',
        input: { dispatchId }
      }
    }
    const dispatch = assignmentRecord(dispatchId)
    const sessionId = dispatch.assignee_session_id
    if (!sessionId) fail(context, 'terminal_not_found', 'The latest Dispatch has no assigned terminal', { taskId, dispatchId })
    const identity = await targetIdentity(context, sessionId)
    if (identity.kind !== 'terminal') {
      fail(context, 'terminal_not_found', 'This Dispatch uses a background structured session, not a terminal', { taskId, dispatchId })
    }
    if (identity.runtimeEpoch !== dispatch.runtime_epoch || identity.processIncarnation !== dispatch.process_incarnation) {
      fail(context, 'worker_identity_changed', 'The assigned process changed; no terminal was opened', { taskId, dispatchId })
    }
    // Re-read after the public async identity lookup: retries, reuse and release may have committed meanwhile.
    const current = assignmentRecord(dispatchId)
    const assignment = core.store.get<{ id: string }>(
      'SELECT id FROM dispatches WHERE assignee_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      sessionId
    )
    if (latest(taskId) !== dispatchId || current.assignee_session_id !== sessionId ||
      current.runtime_epoch !== identity.runtimeEpoch || current.process_incarnation !== identity.processIncarnation || assignment?.id !== dispatchId) {
      fail(context, 'worker_identity_changed', 'The latest Task assignment changed; retry navigation', { taskId, dispatchId })
    }
    if (current.supervised) {
      const resource = workers.resource(dispatchId)
      if (!resource || resource.ownerDispatchId !== dispatchId || resource.sessionId !== sessionId ||
        resource.processIncarnation !== identity.processIncarnation || resource.worktreeId !== identity.worktreeId ||
        !['owned', 'user_owned', 'external'].includes(resource.ownershipState) ||
        resource.releaseState === 'released' || resource.releaseState === 'releasing') {
        fail(context, 'terminal_not_found', 'The worker terminal was released or reused; no terminal was opened', { taskId, dispatchId })
      }
    }
    return { taskId, dispatchId, sessionId, worktreeId: identity.worktreeId }
  }
}
