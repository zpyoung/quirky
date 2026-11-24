import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import { ObjectiveEnrollmentPayloadSchema } from '../../shared/fork-heimdall-objective/contract-types'
import { objectiveLaneForTask } from '../../shared/fork-heimdall-objective/parallel-scheduling'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { inspectHeimdallWorkerTerminal } from '../fork-heimdall/orchestration/worker-dispatch-routing'
import type { ObjectiveStore } from './objective-store'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { composeWorktreeId } from '../../shared/worktree/id'

export type ObjectiveDispatchSessionReuse =
  | { status: 'reusable'; terminalHandle: string }
  | { status: 'gone' }
  | { status: 'unverifiable'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type ObjectiveDispatchSessionIdentity = {
  dispatchId: string | null
  terminalHandle: string | null
  workspaceId: string
}

/**
 * A terminal handle is not reuse authority by itself. This proves the recorded Dispatch still owns
 * the exact process in the exact dispatch worktree, or proves that incarnation exited before a
 * fresh session is allowed to write there.
 */
export async function inspectObjectiveWorkerSession(
  runtime: QuirkyRuntimeService,
  identity: ObjectiveDispatchSessionIdentity
): Promise<ObjectiveDispatchSessionReuse> {
  if (identity.dispatchId === null) {
    return {
      status: 'unverifiable',
      reason: 'The durable dispatch has no identity proving whether a worker process was started.'
    }
  }
  const db = runtime.getOrchestrationDb()
  const worker = db.getWorkerDispatch(identity.dispatchId)
  const dispatch = db.getDispatchContextById(identity.dispatchId)
  const persistedHandle = worker?.agent_terminal_handle ?? dispatch?.assignee_handle
  if (
    worker?.worktree_id !== identity.workspaceId ||
    (identity.terminalHandle !== null && persistedHandle !== identity.terminalHandle)
  ) {
    return {
      status: 'unverifiable',
      reason:
        'The retained worker no longer has the recorded dispatch worktree and terminal identity.'
    }
  }

  const observed = await inspectHeimdallWorkerTerminal(runtime, identity.dispatchId).then(
    (observation) => ({ ok: true as const, observation }),
    (error: unknown) => ({ ok: false as const, error })
  )
  if (!observed.ok) {
    return {
      status: 'unverifiable',
      reason: observed.error instanceof Error ? observed.error.message : String(observed.error)
    }
  }
  const observation = observed.observation
  if (
    identity.terminalHandle !== null &&
    observation.status === 'live' &&
    observation.exact &&
    observation.terminal?.handle === identity.terminalHandle &&
    observation.terminal.worktreeId === identity.workspaceId
  ) {
    return { status: 'reusable', terminalHandle: identity.terminalHandle }
  }
  if (observation.status === 'exited' && observation.exact) {
    return { status: 'gone' }
  }

  if (dispatch?.process_incarnation) {
    try {
      const liveness = await runtime.inspectTerminalProcessIncarnationLiveness(
        dispatch.process_incarnation,
        dispatch.host_scope
      )
      if (liveness === 'exited') {
        return { status: 'gone' }
      }
    } catch (error) {
      return {
        status: 'unverifiable',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }
  return {
    status: 'unverifiable',
    reason:
      observation.reason ??
      `The retained worker session is ${observation.status}; its original process is not proven exited.`
  }
}

export async function inspectObjectiveDispatchSession(
  runtime: QuirkyRuntimeService,
  record: ObjectiveDispatchRecord
): Promise<ObjectiveDispatchSessionReuse> {
  return await inspectObjectiveWorkerSession(runtime, {
    dispatchId: record.dispatchId,
    terminalHandle: record.terminalHandle,
    workspaceId: record.workspaceId
  })
}

/** True only when the dispatch's worker process is proven exited; unverifiable counts as live. */
export async function objectiveDispatchSessionExited(
  runtime: QuirkyRuntimeService,
  record: ObjectiveDispatchRecord
): Promise<boolean> {
  return (await inspectObjectiveDispatchSession(runtime, record)).status === 'gone'
}

function hasLiveRebind(
  objectiveStore: ObjectiveStore,
  record: ObjectiveDispatchRecord,
  ledger: WatcherLedger
): boolean {
  if (record.terminalHandle === null) {
    return false
  }
  const activeFingerprints = new Set(
    getLatestAttempts(ledger)
      .filter((attempt) => attempt.state !== 'settled')
      .map((attempt) => attempt.fingerprint)
  )
  return objectiveStore
    .listDispatches(record.watcherId)
    .some(
      (candidate) =>
        candidate.attemptFingerprint !== record.attemptFingerprint &&
        candidate.workspaceId === record.workspaceId &&
        candidate.terminalHandle === record.terminalHandle &&
        activeFingerprints.has(candidate.attemptFingerprint)
    )
}

export function countObjectiveLaneTerminalNodes(args: {
  ledger: WatcherLedger
  revisionId: string
  laneTaskKeys: readonly string[]
  taskKey: string
  terminalHandle: string
}): number {
  const currentIndex = args.laneTaskKeys.indexOf(args.taskKey)
  if (currentIndex === -1) {
    return 0
  }
  const attempts = getLatestAttempts(args.ledger)
  let count = 0
  for (let index = currentIndex; index >= 0; index -= 1) {
    const taskKey = args.laneTaskKeys[index]
    const matching = attempts
      .filter((attempt) => {
        const action = ObjectiveActionSchema.safeParse(attempt.action)
        return (
          action.success &&
          action.data.kind === 'dispatch-node' &&
          action.data.revisionId === args.revisionId &&
          action.data.taskKey === taskKey &&
          attempt.effect === 'landed'
        )
      })
      .sort((left, right) => right.atMs - left.atMs)[0]
    const result = matching && isRecord(matching.result) ? matching.result : null
    if (result?.terminalHandle !== args.terminalHandle) {
      break
    }
    count += 1
  }
  return count
}
export async function resolveObjectiveSerialLaneTerminal(args: {
  runtime: QuirkyRuntimeService
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  action: Extract<ObjectiveAction, { kind: 'dispatch-node' }>
}): Promise<string | null> {
  if (args.binding.contract.lanesEnabled === false) {
    return null
  }
  const nodes = args.context.snapshot.world.plan.nodes.filter(
    (node) => node.revisionId === args.action.revisionId
  )
  const lane = objectiveLaneForTask(nodes, args.action.taskKey, {
    enabled: true
  })
  const taskIndex = lane?.taskKeys.indexOf(args.action.taskKey) ?? -1
  if (taskIndex <= 0 || !lane) {
    return null
  }
  const previousTaskKey = lane.taskKeys[taskIndex - 1]
  if (nodes.find((node) => node.taskKey === previousTaskKey)?.state !== 'succeeded') {
    return null
  }
  const previous = getLatestAttempts(args.context.ledger)
    .filter((attempt) => {
      const action = ObjectiveActionSchema.safeParse(attempt.action)
      return (
        action.success &&
        action.data.kind === 'dispatch-node' &&
        action.data.revisionId === args.action.revisionId &&
        action.data.taskKey === previousTaskKey
      )
    })
    .sort((left, right) => right.atMs - left.atMs)[0]
  const result = previous && isRecord(previous.result) ? previous.result : null
  if (!previous?.dispatchId) {
    throw new Error('Previous objective lane node has no durable dispatch identity')
  }
  const terminalHandle = typeof result?.terminalHandle === 'string' ? result.terminalHandle : null
  const sessionNodeCount =
    terminalHandle === null
      ? 0
      : countObjectiveLaneTerminalNodes({
          ledger: args.context.ledger,
          revisionId: args.action.revisionId,
          laneTaskKeys: lane.taskKeys,
          taskKey: previousTaskKey,
          terminalHandle
        })
  const session = await inspectObjectiveWorkerSession(args.runtime, {
    dispatchId: previous.dispatchId,
    terminalHandle,
    workspaceId:
      args.binding.enrollment.worktreeId ??
      composeWorktreeId(args.binding.enrollment.repoId, args.binding.enrollment.workspacePath)
  })
  if (session.status === 'unverifiable') {
    throw new Error(`Objective lane session is unverifiable: ${session.reason}`)
  }
  if (session.status === 'reusable' && sessionNodeCount >= 5) {
    throw new Error('Objective lane session reached five nodes but its worker is still live')
  }
  return session.status === 'reusable' ? session.terminalHandle : null
}

function shouldRetainSerialLaneWorker(
  objectiveStore: ObjectiveStore,
  attempt: AttemptEntry,
  ledger: WatcherLedger,
  enrollment: WatcherEnrollment | undefined
): boolean {
  const result = isRecord(attempt.result) ? attempt.result : null
  if (!enrollment || attempt.effect !== 'landed' || typeof result?.terminalHandle !== 'string') {
    return false
  }
  const action = ObjectiveActionSchema.safeParse(attempt.action)
  const contract = ObjectiveEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
  if (
    !action.success ||
    action.data.kind !== 'dispatch-node' ||
    !contract.success ||
    contract.data.lanesEnabled === false
  ) {
    return false
  }
  const dispatchAction = action.data
  const nodes = objectiveStore
    .project(enrollment.watcherId, ledger)
    .nodes.filter((node) => node.revisionId === dispatchAction.revisionId)
  const lane = objectiveLaneForTask(nodes, dispatchAction.taskKey, {
    enabled: true
  })
  const taskIndex = lane?.taskKeys.indexOf(dispatchAction.taskKey) ?? -1
  return (
    taskIndex !== -1 &&
    taskIndex < (lane?.taskKeys.length ?? 0) - 1 &&
    countObjectiveLaneTerminalNodes({
      ledger,
      revisionId: dispatchAction.revisionId,
      laneTaskKeys: lane?.taskKeys ?? [],
      taskKey: dispatchAction.taskKey,
      terminalHandle: result.terminalHandle
    }) < 5
  )
}

/** Kernel retention hook: isolated workers stay warm through apply and lane/conflict continuation. */
export function shouldRetainObjectiveWorker(
  objectiveStore: ObjectiveStore,
  attempt: AttemptEntry,
  ledger: WatcherLedger,
  enrollment?: WatcherEnrollment
): boolean {
  const record = objectiveStore.getDispatch(attempt.fingerprint)
  if (!record) {
    return shouldRetainSerialLaneWorker(objectiveStore, attempt, ledger, enrollment)
  }
  if (
    record.dispatchId === null ||
    record.terminalHandle === null ||
    record.setupState === 'cleaned'
  ) {
    return false
  }
  if (hasLiveRebind(objectiveStore, record, ledger)) {
    return true
  }
  if (
    record.state === 'running' ||
    record.state === 'waiting-to-apply' ||
    record.state === 'applying' ||
    record.state === 'resolving-conflict'
  ) {
    return true
  }
  if (record.state !== 'applied' || record.sessionNodeCount >= 5) {
    return false
  }
  const taskIndex = record.laneTaskKeys.indexOf(record.taskKey)
  return taskIndex !== -1 && taskIndex < record.laneTaskKeys.length - 1
}
