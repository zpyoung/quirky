import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  objectiveActionNaturalKey,
  type ObjectiveAction,
  type ObjectiveActionNaturalKey
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { runCriterionCheck } from './check-runner'
import { computeWorkspaceContentIdentity } from './content-identity'
import { objectiveResultDigest, type ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'
import { ingestObjectiveNodeReport } from './local-node-report-action'
import { ingestObjectivePlanReport } from './local-plan-report-action'
import { ingestObjectivePlanReviewReport } from './local-plan-review-report-action'
import { ingestObjectiveVerdictReport } from './local-verdict-report-action'
import {
  acceptOwnerReport,
  amendOwnerPlan,
  skipOwnerCheck,
  skipOwnerReview
} from './owner-override-executor'
import { executeObjectiveApplyNode } from './merge-train-action-executor'
import { executeApplyPlanPatch } from './plan-patch-action'

type LocalAction = Exclude<
  ObjectiveAction,
  {
    kind: `dispatch-${string}` | 'commit-local-branch' | 'push-ref' | 'open-hosted-review'
  }
>

function invalid(reason: string, detail?: string): ActionOutcome {
  return {
    effect: 'not-landed',
    reason,
    ...(detail === undefined ? {} : { result: { detail } })
  }
}

function naturalKey(action: LocalAction): ObjectiveActionNaturalKey {
  const key = objectiveActionNaturalKey(action)
  if (!key) {
    throw new Error(`Objective local action ${action.kind} has no natural key`)
  }
  return key
}

async function runCheck(args: {
  action: Extract<LocalAction, { kind: 'run-check' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const criterion = args.objectiveStore.getCriterion(args.action.criterionId)
  if (!criterion || !criterion.shellCheckable || criterion.checkCommand !== args.action.command) {
    return invalid('criterion-check-mismatch')
  }
  await args.context.lease.assertHeld()
  const preIdentity = await computeWorkspaceContentIdentity(args.binding.target)
  if (preIdentity !== args.action.contentIdentity) {
    return { effect: 'not-landed', reason: 'check-evidence-stale' }
  }
  args.objectiveStore.startCheckAttempt({
    watcherId: args.binding.enrollment.watcherId,
    criterionId: criterion.id,
    contentIdentity: args.action.contentIdentity,
    executionHostId: args.binding.target.executionHostId,
    command: args.action.command,
    epoch: args.context.lease.epoch,
    startedAtMs: Date.now()
  })
  const check = await runCriterionCheck({
    command: args.action.command,
    target: args.binding.target
  })
  await args.context.lease.assertHeld()
  const postIdentity = await computeWorkspaceContentIdentity(args.binding.target)
  if (postIdentity !== args.action.contentIdentity) {
    args.objectiveStore.abandonCheckAttempt({
      criterionId: criterion.id,
      contentIdentity: args.action.contentIdentity
    })
    return { effect: 'not-landed', reason: 'check-evidence-stale' }
  }
  args.objectiveStore.completeCheckAttempt({
    criterionId: criterion.id,
    contentIdentity: args.action.contentIdentity,
    exitCode: check.exitCode,
    timedOut: check.timedOut,
    stdoutTail: check.stdoutTail,
    stderrTail: check.stderrTail,
    completedAtMs: check.completedAtMs
  })
  return {
    effect: 'landed',
    result: {
      kind: 'check-recorded',
      naturalKey: naturalKey(args.action),
      digest: objectiveResultDigest(check),
      exitCode: check.exitCode,
      timedOut: check.timedOut
    }
  }
}

async function runGate(args: {
  action: Extract<LocalAction, { kind: 'run-gate' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const gate = args.binding.contract.gates?.find(
    (candidate) => candidate.name === args.action.gateName
  )
  if (
    !gate ||
    gate.command !== args.action.command ||
    gate.timeoutSeconds !== args.action.timeoutSeconds
  ) {
    return invalid('gate-declaration-mismatch')
  }
  await args.context.lease.assertHeld()
  const preIdentity = await computeWorkspaceContentIdentity(args.binding.target)
  if (preIdentity !== args.action.contentIdentity) {
    return { effect: 'not-landed', reason: 'check-evidence-stale' }
  }
  args.objectiveStore.startGateAttempt({
    watcherId: args.binding.enrollment.watcherId,
    gateName: args.action.gateName,
    contentIdentity: args.action.contentIdentity,
    executionHostId: args.binding.target.executionHostId,
    command: args.action.command,
    epoch: args.context.lease.epoch,
    startedAtMs: Date.now()
  })
  const check = await runCriterionCheck({
    command: args.action.command,
    target: args.binding.target,
    timeoutSeconds: args.action.timeoutSeconds
  })
  await args.context.lease.assertHeld()
  const postIdentity = await computeWorkspaceContentIdentity(args.binding.target)
  if (postIdentity !== args.action.contentIdentity) {
    args.objectiveStore.abandonGateAttempt({
      watcherId: args.binding.enrollment.watcherId,
      gateName: args.action.gateName,
      contentIdentity: args.action.contentIdentity
    })
    return { effect: 'not-landed', reason: 'check-evidence-stale' }
  }
  args.objectiveStore.completeGateAttempt({
    watcherId: args.binding.enrollment.watcherId,
    gateName: args.action.gateName,
    contentIdentity: args.action.contentIdentity,
    exitCode: check.exitCode,
    timedOut: check.timedOut,
    stdoutTail: check.stdoutTail,
    stderrTail: check.stderrTail,
    completedAtMs: check.completedAtMs
  })
  return {
    effect: 'landed',
    result: {
      kind: 'check-recorded',
      naturalKey: naturalKey(args.action),
      digest: objectiveResultDigest(check),
      exitCode: check.exitCode,
      timedOut: check.timedOut
    }
  }
}

function landingEvidenceIsCurrent(args: {
  action: Extract<LocalAction, { kind: 'record-landing' }>
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
}): boolean {
  const projection = args.objectiveStore.project(
    args.binding.enrollment.watcherId,
    undefined,
    args.action.contentIdentity
  )
  const activeRevision = projection.revisions.some(
    (revision) => revision.id === args.action.revisionId && revision.status === 'approved'
  )
  if (!activeRevision) {
    return false
  }
  const nodes = projection.nodes.filter((node) => node.revisionId === args.action.revisionId)
  if (nodes.length === 0 || nodes.some((node) => node.state !== 'succeeded')) {
    return false
  }
  const checksPass = nodes
    .flatMap((node) => node.criteria)
    .filter((criterion) => criterion.shellCheckable)
    .every(
      (criterion) =>
        criterion.lastCheck?.contentIdentity === args.action.contentIdentity &&
        criterion.lastCheck.exitCode === 0 &&
        !criterion.lastCheck.timedOut
    )
  if (!checksPass) {
    return false
  }
  const approved = (role: 'reviewer' | 'integrator'): boolean =>
    projection.verdicts.some(
      (verdict) =>
        verdict.revisionId === args.action.revisionId &&
        verdict.role === role &&
        verdict.verdict === 'approve' &&
        verdict.contentIdentity === args.action.contentIdentity
    )
  return (
    args.binding.contract.tier === 'express' ||
    (approved('reviewer') && (args.binding.contract.tier === 'standard' || approved('integrator')))
  )
}

export async function executeObjectiveLocalAction(args: {
  action: LocalAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  runtime?: QuirkyRuntimeService
}): Promise<ActionOutcome> {
  if (args.action.kind === 'ingest-plan') {
    return ingestObjectivePlanReport({ ...args, action: args.action })
  }
  if (args.action.kind === 'activate-plan') {
    await args.context.lease.assertHeld()
    const stored = args.objectiveStore.activatePlan({
      watcherId: args.binding.enrollment.watcherId,
      revisionId: args.action.revisionId,
      digest: args.action.digest,
      approvedAtMs: Date.now()
    })
    return {
      effect: 'landed',
      result: {
        kind: 'plan-activated',
        naturalKey: naturalKey(args.action),
        digest: stored.digest
      }
    }
  }
  if (args.action.kind === 'ingest-report') {
    return ingestObjectiveNodeReport({ ...args, action: args.action })
  }
  if (args.action.kind === 'apply-node') {
    return executeObjectiveApplyNode({ ...args, action: args.action })
  }
  if (args.action.kind === 'run-check') {
    return runCheck({ ...args, action: args.action })
  }
  if (args.action.kind === 'run-gate') {
    return runGate({ ...args, action: args.action })
  }
  if (args.action.kind === 'ingest-verdict') {
    return ingestObjectiveVerdictReport({ ...args, action: args.action })
  }
  if (args.action.kind === 'ingest-plan-review') {
    return ingestObjectivePlanReviewReport({ ...args, action: args.action })
  }
  if (args.action.kind === 'accept-report') {
    return acceptOwnerReport({ ...args, action: args.action })
  }
  if (args.action.kind === 'amend-plan') {
    return amendOwnerPlan({ ...args, action: args.action })
  }
  if (args.action.kind === 'skip-review') {
    return skipOwnerReview({ ...args, action: args.action })
  }
  if (args.action.kind === 'skip-check') {
    return skipOwnerCheck({ ...args, action: args.action })
  }
  if (args.action.kind === 'apply-plan-patch') {
    return executeApplyPlanPatch({ ...args, action: args.action })
  }
  await args.context.lease.assertHeld()
  if (
    !landingEvidenceIsCurrent({
      action: args.action,
      binding: args.binding,
      objectiveStore: args.objectiveStore
    })
  ) {
    return invalid('landing-evidence-stale')
  }
  const currentIdentity = await computeWorkspaceContentIdentity(args.binding.target)
  if (
    currentIdentity !== args.action.contentIdentity ||
    currentIdentity !== args.context.snapshot.contentIdentity
  ) {
    return invalid('landing-evidence-stale')
  }
  await args.context.lease.assertHeld()
  const stored = args.objectiveStore.recordLanding({
    watcherId: args.binding.enrollment.watcherId,
    rung: args.action.rung,
    contentIdentity: args.action.contentIdentity,
    attemptFingerprint: makeAttemptFingerprint(
      args.action.contentIdentity,
      args.action.kind,
      args.action.evidenceKey
    ),
    payload: { revisionId: args.action.revisionId },
    epoch: args.context.lease.epoch,
    createdAtMs: Date.now()
  })
  return {
    effect: 'landed',
    result: {
      kind: 'landing-recorded',
      naturalKey: naturalKey(args.action),
      digest: objectiveResultDigest(stored)
    }
  }
}
