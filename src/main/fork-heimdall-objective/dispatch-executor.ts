import { z } from 'zod'
import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  judgmentRoutedAgent,
  objectiveRoutingSubject
} from '../../shared/fork-heimdall/judgment/objective-judgment-policy'
import {
  activeObjectiveRevision,
  requireObjectiveOriginalDispatchFingerprint
} from '../../shared/fork-heimdall-objective/decision-context'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import {
  ObjectivePlanTaskSchema,
  assertPlannerTaskWithinDispatchSnapshotCap,
  type ImplementerReport,
  type ObjectivePlan,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type {
  ObjectiveNodeProjection,
  ObjectiveNodeState,
  ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { deriveObjectiveBudgetBucket } from '../../shared/fork-heimdall-objective/pacing'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  buildObjectiveRolePrompt,
  resolveObjectiveRoleAgent,
  type ObjectiveConflictContext,
  type ObjectiveFailureContext
} from './role-prompts'
import { captureObjectiveWorkspaceBaseline } from './observed-workspace-changes'
import { buildObjectivePlannerDispatchSpec } from './dispatch-planner-spec'
import { planReviewRoutingScope, preparePlanReviewDispatchSpec } from './plan-review-input'
import { issueObjectiveReportPath } from './report-ingestion'
import type { RepairPlanContext } from './repair-plan-context'
import type { ObjectiveStore } from './objective-store'
import { objectiveResultDigest, type ObjectiveSnapshotBinding } from './execution-context'
import {
  ObjectiveEnrolledWorkspaceDirtyError,
  prepareObjectiveDispatchWorkspace,
  type PreparedObjectiveDispatchWorkspace
} from './dispatch-worktree'
import { resolveObjectiveSerialLaneTerminal } from './dispatch-session'
import { deriveObjectiveFailureContext } from './dispatch-failure-context'
import { deriveObjectiveRepairContext } from './dispatch-repair-context'
import { dispatchObjectiveWorker, saveDispatchFailure } from './dispatch-worker-launch'

type DispatchAction = Extract<ObjectiveAction, { kind: `dispatch-${string}` }>

type DispatchSpec = {
  role: 'planner' | 'implementer' | 'reviewer' | 'integrator'
  spec: string
  taskKey?: string
  deps?: string[]
}

function derivePlanProgress(
  objectiveStore: ObjectiveStore,
  watcherId: string,
  ledger: ExecuteContext<ObjectiveWorld>['ledger'],
  activeRevisionId: string | undefined
): readonly { taskKey: string; state: ObjectiveNodeState }[] | undefined {
  if (activeRevisionId === undefined) {
    return undefined
  }
  const nodes = objectiveStore
    .project(watcherId, ledger)
    .nodes.filter((node) => node.revisionId === activeRevisionId)
  return nodes.length > 0
    ? nodes.map((node) => ({ taskKey: node.taskKey, state: node.state }))
    : undefined
}

function requirePlan(objectiveStore: ObjectiveStore, revisionId: string): ObjectivePlan {
  const plan = objectiveStore.getPlan(revisionId)
  if (!plan) {
    throw new Error(`Objective plan revision ${revisionId} is unavailable`)
  }
  return plan
}

function requireOrchestrationTaskId(node: ObjectiveNodeProjection): string {
  if (node.orchestrationTaskId === null) {
    throw new Error(`Objective node ${node.taskKey} has no orchestration task id`)
  }
  return node.orchestrationTaskId
}

function completedNodeDependencies(
  objectiveStore: ObjectiveStore,
  watcherId: string,
  revisionId: string,
  ledger: ExecuteContext<ObjectiveWorld>['ledger']
): string[] {
  const nodes = objectiveStore
    .project(watcherId, ledger)
    .nodes.filter((node) => node.revisionId === revisionId)
  return nodes.map((node) => requireOrchestrationTaskId(node))
}

function buildDispatchSpec(args: {
  action: Exclude<DispatchAction, { kind: 'dispatch-plan-review' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  reportPath: string
  failureContext?: ObjectiveFailureContext
  planProgress?: readonly { taskKey: string; state: ObjectiveNodeState }[]
  conflictContext?: ObjectiveConflictContext
  dispatchedNode?: ObjectivePlanTask
  repairContext?: RepairPlanContext
}): DispatchSpec {
  const {
    action,
    binding,
    context,
    objectiveStore,
    reportPath,
    failureContext,
    conflictContext,
    planProgress,
    repairContext
  } = args
  const budgetBucket = deriveObjectiveBudgetBucket(context.ledger, binding.enrollment.budget)
  const effectiveMaxConcurrency = context.snapshot.world.parallel?.effectiveMaxConcurrency ?? 1
  const lanesEnabled = binding.contract.lanesEnabled !== false
  if (action.kind === 'dispatch-planner') {
    return buildObjectivePlannerDispatchSpec({
      action,
      binding,
      context,
      objectiveStore,
      reportPath,
      budgetBucket,
      effectiveMaxConcurrency,
      lanesEnabled,
      ...(failureContext === undefined ? {} : { failureContext }),
      ...(planProgress === undefined ? {} : { planProgress }),
      ...(repairContext === undefined ? {} : { repairContext })
    })
  }
  const plan = requirePlan(objectiveStore, action.revisionId)
  if (action.kind === 'dispatch-node') {
    const node = args.dispatchedNode ?? objectiveStore.getTask(action.revisionId, action.taskKey)
    if (!node) {
      throw new Error(`Objective task ${action.taskKey} is unavailable`)
    }
    return {
      role: 'implementer',
      taskKey: action.taskKey,
      deps: [...action.depsOrchestrationIds],
      spec: buildObjectiveRolePrompt({
        role: 'implementer',
        contract: binding.contract,
        plan,
        node,
        reportPath,
        budgetBucket,
        effectiveMaxConcurrency,
        lanesEnabled,
        ...(conflictContext === undefined ? {} : { conflictContext })
      })
    }
  }
  const role = action.kind === 'dispatch-reviewer' ? 'reviewer' : 'integrator'
  return {
    role,
    taskKey: `objective-${role}-${action.revisionId}`,
    deps: completedNodeDependencies(
      objectiveStore,
      binding.enrollment.watcherId,
      action.revisionId,
      context.ledger
    ),
    spec: buildObjectiveRolePrompt({
      role,
      contract: binding.contract,
      plan,
      reportPath,
      budgetBucket,
      effectiveMaxConcurrency,
      lanesEnabled
    })
  }
}

function hasDispatchReport(
  record: ObjectiveDispatchRecord
): record is ObjectiveDispatchRecord & { dispatchId: string; report: ImplementerReport } {
  return record.dispatchId !== null && record.report !== null
}

function dispatchWithReport(
  records: readonly ObjectiveDispatchRecord[],
  dispatchId: string
): ObjectiveDispatchRecord & { dispatchId: string; report: ImplementerReport } {
  const record = records.find((candidate) => candidate.dispatchId === dispatchId)
  if (!record || !hasDispatchReport(record)) {
    throw new Error(`Conflict context for objective Dispatch ${dispatchId} is unavailable`)
  }
  return record
}

function resolvingDispatchWithReport(
  records: readonly ObjectiveDispatchRecord[],
  retry: ObjectiveDispatchRecord
): ObjectiveDispatchRecord & { dispatchId: string; report: ImplementerReport } {
  const matches = records.filter(
    (candidate) =>
      candidate.attemptFingerprint !== retry.attemptFingerprint &&
      candidate.workspaceId === retry.workspaceId &&
      candidate.taskKey === retry.taskKey &&
      candidate.state === 'resolving-conflict' &&
      candidate.dispatchId !== null &&
      candidate.report !== null
  )
  const record = matches.sort((left, right) => right.createdAtMs - left.createdAtMs)[0]
  if (!record || !hasDispatchReport(record)) {
    throw new Error(
      `Resolving conflict Dispatch for objective task ${retry.taskKey} is unavailable`
    )
  }
  return record
}

function dispatchConflictContext(
  objectiveStore: ObjectiveStore,
  prepared: PreparedObjectiveDispatchWorkspace | null
): ObjectiveConflictContext | undefined {
  const record = prepared?.record
  if (!record || record.state !== 'resolving-conflict') {
    return undefined
  }
  if (record.conflictPaths.length === 0 || record.conflictingDispatchIds.length === 0) {
    throw new Error('Conflict resolution dispatch is missing conflicting paths or Dispatches')
  }
  const records = objectiveStore.listDispatches(record.watcherId)
  const resolving = resolvingDispatchWithReport(records, record)
  return {
    enrolledHead: record.baseCommit,
    paths: record.conflictPaths,
    resolving: {
      dispatchId: resolving.dispatchId,
      task: resolving.task,
      report: resolving.report
    },
    conflicting: record.conflictingDispatchIds.map((dispatchId) => {
      const conflicting = dispatchWithReport(records, dispatchId)
      return {
        dispatchId,
        task: conflicting.task,
        report: conflicting.report
      }
    })
  }
}

export async function executeObjectiveDispatch(args: {
  action: DispatchAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  runtime: QuirkyRuntimeService
  store: Store
}): Promise<ActionOutcome> {
  const fingerprint = makeAttemptFingerprint(
    args.action.contentIdentity,
    args.action.kind,
    args.action.evidenceKey
  )
  await args.context.lease.assertHeld()
  let reportPath: string
  let request: DispatchSpec
  let agent: string
  let prepared: PreparedObjectiveDispatchWorkspace | null = null
  let serialReuseTerminal: string | null = null
  let target = args.binding.target
  try {
    let dispatchedNode: ObjectivePlanTask | undefined
    if (args.action.kind === 'dispatch-node') {
      const storedNode = args.objectiveStore.getTask(args.action.revisionId, args.action.taskKey)
      if (!storedNode) {
        throw new Error(`Objective task ${args.action.taskKey} is unavailable`)
      }
      const planTaskDigest = objectiveResultDigest(ObjectivePlanTaskSchema.parse(storedNode))
      dispatchedNode = args.action.ownerAmendedSpec
        ? { ...storedNode, spec: args.action.ownerAmendedSpec }
        : storedNode
      // an owner amend/retry can grow the merged node past the cap even when its own spec field fits
      try {
        assertPlannerTaskWithinDispatchSnapshotCap(dispatchedNode)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { effect: 'not-landed', failureClass: 'criteria', reason }
      }
      prepared = await prepareObjectiveDispatchWorkspace({
        runtime: args.runtime,
        binding: args.binding,
        context: args.context,
        objectiveStore: args.objectiveStore,
        action: args.action,
        attemptFingerprint: fingerprint,
        task: dispatchedNode,
        planTaskDigest
      })
      if (prepared) {
        target = prepared.target
      } else {
        serialReuseTerminal = await resolveObjectiveSerialLaneTerminal({
          runtime: args.runtime,
          binding: args.binding,
          context: args.context,
          action: args.action
        })
      }
    }

    reportPath = await issueObjectiveReportPath(target, fingerprint)
    if (prepared) {
      const record = { ...prepared.record, reportPath }
      await args.context.lease.assertHeld()
      args.objectiveStore.saveDispatch(record)
      prepared = { ...prepared, record }
    }
    const activeRevisionId =
      args.action.kind === 'dispatch-planner'
        ? activeObjectiveRevision(args.context.snapshot.world)?.id
        : undefined
    const failureContext =
      args.action.kind === 'dispatch-planner'
        ? await deriveObjectiveFailureContext({
            action: args.action,
            binding: args.binding,
            ledger: args.context.ledger,
            objectiveStore: args.objectiveStore,
            activeRevisionId
          })
        : undefined
    const planProgress =
      args.action.kind === 'dispatch-planner'
        ? derivePlanProgress(
            args.objectiveStore,
            args.binding.enrollment.watcherId,
            args.context.ledger,
            activeRevisionId
          )
        : undefined
    const repairContext =
      args.action.kind === 'dispatch-planner' &&
      args.action.plannerMode === 'repair' &&
      args.action.repairRevisionId !== undefined
        ? deriveObjectiveRepairContext(
            args.objectiveStore,
            args.binding.enrollment.watcherId,
            args.context.ledger,
            args.context.snapshot.world,
            args.action.repairRevisionId
          )
        : undefined
    request =
      args.action.kind === 'dispatch-plan-review'
        ? await preparePlanReviewDispatchSpec({
            action: args.action,
            binding: args.binding,
            objectiveStore: args.objectiveStore,
            world: args.context.snapshot.world,
            ledger: args.context.ledger,
            workspaceTarget: target,
            reportPath
          })
        : buildDispatchSpec({
            ...args,
            action: args.action,
            reportPath,
            failureContext,
            planProgress,
            repairContext,
            dispatchedNode,
            conflictContext: dispatchConflictContext(args.objectiveStore, prepared)
          })
    const routingScope =
      args.action.kind === 'dispatch-planner'
        ? (activeRevisionId ?? 'initial')
        : args.action.kind === 'dispatch-node'
          ? args.action.taskKey
          : args.action.kind === 'dispatch-plan-review'
            ? planReviewRoutingScope(args.action.target)
            : args.action.revisionId
    agent =
      args.action.kind === 'dispatch-node' && args.action.ownerAgent
        ? args.action.ownerAgent
        : resolveObjectiveRoleAgent(
            args.store,
            args.binding.contract,
            request.role,
            judgmentRoutedAgent(
              args.context.snapshot.world,
              objectiveRoutingSubject(request.role, routingScope)
            )
          )
    if (args.action.kind === 'dispatch-node' || args.action.kind === 'dispatch-integrator') {
      const baselineFingerprint = prepared
        ? fingerprint
        : args.action.kind === 'dispatch-node' && args.action.retryOf !== undefined
          ? requireObjectiveOriginalDispatchFingerprint(args.context.ledger, args.action.retryOf)
          : fingerprint
      await captureObjectiveWorkspaceBaseline(
        target,
        baselineFingerprint,
        prepared?.record.state === 'resolving-conflict' ? args.binding.target : target
      )
    }
  } catch (error) {
    if (error instanceof ObjectiveEnrolledWorkspaceDirtyError) {
      return {
        effect: 'not-landed',
        reason: 'objective-train-paused',
        result: error.result
      }
    }
    await saveDispatchFailure(args.objectiveStore, prepared, args.context)
    return {
      effect: 'not-landed',
      // a Zod validation failure (e.g. saving an oversized dispatch task snapshot) is deterministic
      // and won't clear on retry, unlike an infra failure
      failureClass: error instanceof z.ZodError ? 'criteria' : 'infra',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  return dispatchObjectiveWorker({
    context: args.context,
    objectiveStore: args.objectiveStore,
    request,
    agent,
    contract: args.binding.contract,
    prepared,
    serialReuseTerminal,
    reportPath
  })
}
