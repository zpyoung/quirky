import type {
  ActionOutcome,
  EffectCertainty,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ActionExecutor, LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import { executeObjectiveDispatch } from './dispatch-executor'
import { resolveObjectiveDispatchOutcome } from './dispatch-outcome-resolver'
import { requireObjectiveSnapshotBinding, type ObjectiveSnapshotBinding } from './execution-context'
import { executeObjectiveLocalAction } from './local-action-executor'
import {
  executeCommitLocalBranch,
  executeOpenHostedReview,
  executePushRef
} from './landing-action-executor'
import { recoverObjectiveApplyNode } from './merge-train-action-executor'
import { resolveLandingOutcome } from './landing-recovery'
import type { ObjectiveStore } from './objective-store'

type ObjectiveExecutorDependencies = {
  store: Store
  objectiveStore: ObjectiveStore
  snapshotBindings: WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>
  forge: ObjectiveForgeAccess
  runtime: QuirkyRuntimeService
}

type StoreLocalAction = Exclude<
  ObjectiveAction,
  {
    kind: `dispatch-${string}` | 'commit-local-branch' | 'push-ref' | 'open-hosted-review'
  }
>

function isDispatchAction(
  action: ObjectiveAction
): action is Extract<ObjectiveAction, { kind: `dispatch-${string}` }> {
  return action.kind.startsWith('dispatch-')
}

function localActionOutcome(
  action: StoreLocalAction,
  binding: ObjectiveSnapshotBinding,
  objectiveStore: ObjectiveStore
): EffectCertainty {
  const watcherId = binding.enrollment.watcherId
  switch (action.kind) {
    case 'ingest-plan': {
      const revision = objectiveStore.planForDispatch(watcherId, action.dispatchId)
      return revision?.revisionNumber === action.revisionNumber ? 'landed' : 'not-landed'
    }
    case 'activate-plan':
      return objectiveStore.isPlanActivated(watcherId, action.revisionId, action.digest)
        ? 'landed'
        : 'not-landed'
    case 'ingest-report': {
      const node = objectiveStore.nodeForDispatch(watcherId, action.dispatchId)
      if (node?.revisionId === action.revisionId && node.taskKey === action.taskKey) {
        return 'landed'
      }
      const dispatch = objectiveStore.dispatchForId(watcherId, action.dispatchId)
      return dispatch?.revisionId === action.revisionId &&
        dispatch.taskKey === action.taskKey &&
        (dispatch.state === 'waiting-to-apply' ||
          dispatch.state === 'applying' ||
          dispatch.state === 'applied')
        ? 'landed'
        : 'not-landed'
    }
    case 'apply-node': {
      const dispatch = objectiveStore.dispatchForId(watcherId, action.dispatchId)
      return dispatch?.state === 'applied'
        ? 'landed'
        : dispatch?.state === 'applying'
          ? 'indeterminate'
          : 'not-landed'
    }
    case 'run-check': {
      const check = objectiveStore.getCheckAttempt(action.criterionId, action.contentIdentity)
      if (check === null) {
        return 'not-landed'
      }
      return check.completedAtMs !== null ? 'landed' : 'indeterminate'
    }
    case 'run-gate': {
      const attempt = objectiveStore.getGateAttempt(
        watcherId,
        action.gateName,
        action.contentIdentity
      )
      if (attempt === null) {
        return 'not-landed'
      }
      return attempt.completedAtMs !== null ? 'landed' : 'indeterminate'
    }
    case 'ingest-verdict':
      return objectiveStore.hasVerdict(action.dispatchId) ? 'landed' : 'not-landed'
    case 'ingest-plan-review':
      return objectiveStore
        .listPlanReviews(watcherId)
        .some((review) => review.dispatchId === action.dispatchId)
        ? 'landed'
        : 'not-landed'
    case 'record-landing':
      return objectiveStore.hasLanding(watcherId, action.rung, action.contentIdentity)
        ? 'landed'
        : 'not-landed'
    case 'accept-report': {
      const node = objectiveStore.nodeForDispatch(watcherId, action.dispatchId)
      if (node?.revisionId === action.revisionId && node.taskKey === action.taskKey) {
        return 'landed'
      }
      const dispatch = objectiveStore.dispatchForId(watcherId, action.dispatchId)
      return dispatch?.revisionId === action.revisionId &&
        dispatch.taskKey === action.taskKey &&
        (dispatch.state === 'waiting-to-apply' ||
          dispatch.state === 'applying' ||
          dispatch.state === 'applied')
        ? 'landed'
        : 'not-landed'
    }
    case 'amend-plan':
      return objectiveStore.hasAmendment(action.revisionId, action.patch.digest)
        ? 'landed'
        : 'not-landed'
    case 'skip-review':
      return objectiveStore.hasVerdict(action.dispatchId) ? 'landed' : 'not-landed'
    case 'skip-check': {
      const check = objectiveStore.getCheckAttempt(action.criterionId, action.contentIdentity)
      if (check === null) {
        return 'not-landed'
      }
      if (check.completedAtMs === null) {
        return 'indeterminate'
      }
      return check.ownerSkip ? 'landed' : 'not-landed'
    }
    case 'apply-plan-patch': {
      const patch = objectiveStore.getPlanPatch(action.patchId)
      if (!patch || patch.status === 'pending') {
        return 'not-landed'
      }
      return 'landed'
    }
  }
}

export function createObjectiveActionExecutor(
  dependencies: ObjectiveExecutorDependencies
): ActionExecutor<ObjectiveWorld, ObjectiveAction> {
  const landingDependencies = {
    objectiveStore: dependencies.objectiveStore,
    forge: dependencies.forge
  }
  return {
    execute(action, context): Promise<ActionOutcome> {
      const binding = requireObjectiveSnapshotBinding(
        dependencies.snapshotBindings,
        context.snapshot
      )
      if (isDispatchAction(action)) {
        return executeObjectiveDispatch({
          action,
          binding,
          context,
          objectiveStore: dependencies.objectiveStore,
          store: dependencies.store,
          runtime: dependencies.runtime
        })
      }
      if (action.kind === 'commit-local-branch') {
        return executeCommitLocalBranch({ action, binding, context, ...landingDependencies })
      }
      if (action.kind === 'push-ref') {
        return executePushRef({ action, binding, context, ...landingDependencies })
      }
      if (action.kind === 'open-hosted-review') {
        return executeOpenHostedReview({ action, binding, context, ...landingDependencies })
      }
      return executeObjectiveLocalAction({
        action,
        binding,
        context,
        objectiveStore: dependencies.objectiveStore,
        runtime: dependencies.runtime
      })
    },
    resolveOutcome(
      attempt: AttemptEntry,
      fresh: LiveSnapshot<ObjectiveWorld>,
      ledger: WatcherLedger,
      lease: LeaseGuard
    ): EffectCertaintyResolution | Promise<EffectCertaintyResolution> {
      const binding = requireObjectiveSnapshotBinding(dependencies.snapshotBindings, fresh)
      const parsed = ObjectiveActionSchema.safeParse(attempt.action)
      if (
        !parsed.success ||
        attempt.fingerprint !==
          makeAttemptFingerprint(
            parsed.data.contentIdentity,
            parsed.data.kind,
            parsed.data.evidenceKey
          )
      ) {
        return { effect: 'indeterminate' }
      }
      if (
        parsed.data.kind === 'commit-local-branch' ||
        parsed.data.kind === 'push-ref' ||
        parsed.data.kind === 'open-hosted-review'
      ) {
        return resolveLandingOutcome({
          attempt,
          action: parsed.data,
          binding,
          ...landingDependencies,
          lease
        }).then((effect) => ({ effect }))
      }
      if (parsed.data.kind === 'apply-node') {
        return recoverObjectiveApplyNode({
          action: parsed.data,
          binding,
          ledger,
          lease,
          objectiveStore: dependencies.objectiveStore
        }).then((effect) => ({ effect }))
      }
      if (!isDispatchAction(parsed.data)) {
        return {
          effect: localActionOutcome(parsed.data, binding, dependencies.objectiveStore)
        }
      }
      return resolveObjectiveDispatchOutcome({
        attempt,
        action: parsed.data,
        runtime: dependencies.runtime,
        lease,
        ledger,
        binding,
        world: fresh.world,
        objectiveStore: dependencies.objectiveStore
      })
    }
  }
}
