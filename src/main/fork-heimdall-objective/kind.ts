import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import {
  judgmentHandoffHold,
  judgmentPreflightHold
} from '../../shared/fork-heimdall/judgment/objective-judgment-policy'
import { collectObjectiveJudgmentQuestions } from '../../shared/fork-heimdall/judgment/objective-question-collection'
import { getActingJudgment } from '../../shared/fork-heimdall/judgment/registry'
import type { HandoffAdapter, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PacingTier } from '../../shared/fork-heimdall/pacing'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentRequestSchema } from '../../shared/fork-heimdall-objective/contract-types'
import {
  highestReachedRung,
  reachedRungs,
  stopRungForBar
} from '../../shared/fork-heimdall-objective/landing-ladder'
import { deriveHandoffInput } from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import {
  decideObjective,
  type ObjectiveDecisionOutcome
} from '../../shared/fork-heimdall-objective/decision'
import { objectiveNoAction } from '../../shared/fork-heimdall-objective/decision-context'
import {
  ObjectiveWorldSchema,
  type ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { paceObjective } from '../../shared/fork-heimdall-objective/pacing'
import { OBJECTIVE_STOP_PREDICATES } from '../../shared/fork-heimdall-objective/stop-policy'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { JudgmentAuthority, JudgmentService } from '../fork-heimdall/judgment/service'
import { readObjectiveJudgmentReports } from '../fork-heimdall/judgment/report-projection'
import { createObjectiveActionExecutor } from './action-executor'
import { reconcileAmendedObjectiveDispatches } from './amendment-dispatch-reconciliation'
import { createObjectiveConcurrencyPolicy } from './objective-concurrency'
import { objectiveDispatchSessionExited, shouldRetainObjectiveWorker } from './dispatch-session'
import {
  cleanupAppliedObjectiveDispatches,
  inspectObjectiveDispatchWorkspace,
  purgeObjectiveDispatchWorktrees,
  reconcileObjectiveDispatchWorktrees
} from './dispatch-worktree'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { defaultObjectiveForgeAccess, type ObjectiveForgeAccess } from './objective-forge-access'
import {
  assertObjectiveEnrollmentHasUsablePlan,
  authorizeObjectiveEnrollment,
  objectiveContractFromEnrollment
} from './definition'
import {
  bindObjectiveSnapshot,
  requireObjectiveSnapshotBinding,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { readObjectiveLandingContext } from './landing-snapshot'
import { HostedReviewLandingPayloadSchema } from './objective-store-data'
import { createObjectiveOwnerAdapter } from './owner-adapter'
import type { ObjectiveStore } from './objective-store'
import { createObjectiveSubmissionAdapter } from './report-submission-preflight'
import { resolveObjectiveWorkspaceTarget } from './workspace-target'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'

export type ObjectiveKind = WatcherKind<ObjectiveWorld, ObjectiveAction, ObjectiveEnrollmentPayload>
const PLAN_OFF_WITHOUT_USABLE_PLAN = 'plan-off-without-usable-plan'

export function decideObjectiveForEnrollment(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  enrollment: WatcherEnrollment
): ObjectiveDecisionOutcome {
  const decision = decideObjective(snapshot, ledger, enrollment.owner !== undefined)
  const requiresPlan =
    decision.action?.capability === 'plan' ||
    (decision.action === null &&
      'considered' in decision &&
      decision.considered.some((considered) => considered.phase === 'plan'))
  if (enrollment.capabilities.plan !== 'off' || !requiresPlan) {
    return decision
  }
  return objectiveNoAction('plan', PLAN_OFF_WITHOUT_USABLE_PLAN)
}

export function paceObjectiveForEnrollment(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  decision: ObjectiveDecisionOutcome
): PacingTier {
  return decision.action === null &&
    'reason' in decision &&
    decision.reason === PLAN_OFF_WITHOUT_USABLE_PLAN
    ? 'idle'
    : paceObjective(snapshot, ledger)
}

function checkTargetAvailable(target: ObjectiveWorkspaceTarget): boolean {
  return (
    target.executionHostId === 'local' && target.gitTarget?.localGitOptions?.wslDistro === undefined
  )
}

function judgmentAuthority(
  storageAuthority: 'desktop' | 'runtime',
  target: ObjectiveWorkspaceTarget
): JudgmentAuthority {
  if (storageAuthority !== 'desktop') {
    return 'remote-storage-authority'
  }
  return target.executionHostId !== 'local' ||
    target.gitTarget?.localGitOptions?.wslDistro !== undefined
    ? 'remote-execution-host'
    : 'local-desktop'
}

function objectivePreflight(args: {
  action: ObjectiveAction
  snapshot: Snapshot<ObjectiveWorld>
  ledger: WatcherLedger
  enrollment: WatcherEnrollment
  target: ObjectiveWorkspaceTarget
}): GateVerdict {
  const action = args.action
  const conflictContinuation =
    action.kind === 'dispatch-node' &&
    args.snapshot.world.parallel?.dispatches.some(
      (dispatch) =>
        dispatch.state === 'resolving-conflict' &&
        dispatch.revisionId === action.revisionId &&
        dispatch.taskKey === action.taskKey
    )
  if (
    args.action.kind.startsWith('dispatch-') &&
    !conflictContinuation &&
    deriveBudgetState(args.ledger, args.enrollment.budget).exhausted
  ) {
    return { verdict: 'hold', reason: 'budget-bucket-exhausted' }
  }
  if (args.action.kind === 'run-check' && !checkTargetAvailable(args.target)) {
    return { verdict: 'hold', reason: 'check-target-unavailable' }
  }
  if (args.action.kind === 'record-landing') {
    const revisionId = args.action.revisionId
    const verified = args.snapshot.world.plan.nodes
      .filter((node) => node.revisionId === revisionId)
      .flatMap((node) => node.criteria)
      .filter((criterion) => criterion.shellCheckable)
      .every(
        (criterion) =>
          criterion.lastCheck?.contentIdentity === args.snapshot.contentIdentity &&
          criterion.lastCheck.exitCode === 0 &&
          !criterion.lastCheck.timedOut
      )
    if (!verified) {
      return { verdict: 'hold', reason: 'criteria-unverified' }
    }
  }
  const judgmentHold = judgmentPreflightHold(args.snapshot.world, args.action)
  return judgmentHold ? { verdict: 'hold', reason: judgmentHold } : { verdict: 'allow' }
}

function objectivePhase(snapshot: Snapshot<ObjectiveWorld>): string {
  const reached = reachedRungs(snapshot.world.plan.landing, snapshot.contentIdentity)
  const currentLanding = highestReachedRung(snapshot.world.plan.landing, snapshot.contentIdentity)
  if (reached.has(stopRungForBar(snapshot.world.contract.landingBar))) {
    return 'landed'
  }
  if (currentLanding !== null) {
    return 'landing'
  }
  const revision = snapshot.world.plan.revisions.find((entry) => entry.status === 'approved')
  if (!revision) {
    return 'planning'
  }
  const nodes = snapshot.world.plan.nodes.filter((node) => node.revisionId === revision.id)
  if (nodes.some((node) => node.state !== 'succeeded' && node.state !== 'replanned')) {
    return 'implementation'
  }
  const checksCurrent = nodes
    .flatMap((node) => node.criteria)
    .filter((criterion) => criterion.shellCheckable)
    .every((criterion) => criterion.lastCheck?.contentIdentity === snapshot.contentIdentity)
  return checksCurrent ? 'review' : 'checks'
}

function objectiveHandoffAdapter(
  objectiveStore: ObjectiveStore,
  latestWorlds: Map<string, ObjectiveWorld>
): HandoffAdapter<ObjectiveWorld> {
  return {
    derive(enrollment, fired, ledger) {
      const contract = objectiveContractFromEnrollment(enrollment)
      if (stopRungForBar(contract.landingBar) !== 'hosted-review') {
        return { kind: 'none', reason: 'bar-below-hosted-review' }
      }
      if (!fired.detail) {
        return { kind: 'none', reason: 'hosted-review-row-missing' }
      }
      const landing = HostedReviewLandingPayloadSchema.safeParse(
        objectiveStore.landingRow(enrollment.watcherId, 'hosted-review', fired.detail)
      )
      if (!landing.success) {
        return { kind: 'none', reason: 'hosted-review-row-missing' }
      }
      const judgmentHold = latestWorlds.get(enrollment.watcherId)
      if (judgmentHold) {
        const reason = judgmentHandoffHold(judgmentHold)
        if (reason) {
          return { kind: 'none', reason }
        }
      }
      return {
        kind: 'enroll',
        input: deriveHandoffInput({
          enrollment,
          contract,
          landing: landing.data,
          budgetState: deriveBudgetState(ledger, enrollment.budget)
        }),
        reason: 'bar-reached'
      }
    }
  }
}

export function createObjectiveKind(args: {
  runtime: QuirkyRuntimeService
  store: Store
  objectiveStore: ObjectiveStore
  storageAuthority?: 'desktop' | 'runtime'
  judgmentService?: JudgmentService
  forge?: ObjectiveForgeAccess
}): ObjectiveKind {
  const snapshotBindings = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>()
  const snapshotDecisions = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveDecisionOutcome>()
  const latestWorlds = new Map<string, ObjectiveWorld>()
  const latestEnrollments = new Map<string, WatcherEnrollment>()
  const storageAuthority = args.storageAuthority ?? 'desktop'
  const forge = args.forge ?? defaultObjectiveForgeAccess
  const executor = createObjectiveActionExecutor({
    runtime: args.runtime,
    store: args.store,
    objectiveStore: args.objectiveStore,
    snapshotBindings,
    forge
  })
  const concurrency = createObjectiveConcurrencyPolicy({
    objectiveStore: args.objectiveStore,
    snapshotBindings,
    retainWorker: (attempt, ledger) =>
      shouldRetainObjectiveWorker(
        args.objectiveStore,
        attempt,
        ledger,
        latestEnrollments.get(attempt.watcherId)
      ),
    cleanupWorkspaces: (_ledger, context) =>
      cleanupAppliedObjectiveDispatches({
        runtime: args.runtime,
        objectiveStore: args.objectiveStore,
        watcherId: context.enrollment.watcherId,
        lease: context.lease,
        workerReleaseConfirmed: context.workerReleaseConfirmed,
        workerSessionExited: (owner) => objectiveDispatchSessionExited(args.runtime, owner),
        inspectWorkspace: (record) =>
          inspectObjectiveDispatchWorkspace(args.runtime, context.enrollment, record)
      }),
    async reconcile(snapshot, ledger, context) {
      await reconcileAmendedObjectiveDispatches({
        ledger,
        objectiveStore: args.objectiveStore,
        lease: context.lease,
        stopWorker: context.stopWorker
      })
      if (args.objectiveStore.listDispatches(context.enrollment.watcherId).length > 0) {
        await context.lease.assertHeld()
        await reconcileObjectiveDispatchWorktrees({
          runtime: args.runtime,
          binding: requireObjectiveSnapshotBinding(snapshotBindings, snapshot),
          objectiveStore: args.objectiveStore,
          lease: context.lease,
          workerReleaseConfirmed: context.workerReleaseConfirmed,
          workerSessionExited: (owner) => objectiveDispatchSessionExited(args.runtime, owner),
          inspectWorkspace: (record) =>
            inspectObjectiveDispatchWorkspace(args.runtime, context.enrollment, record)
        })
      }
    }
  })
  return {
    id: 'objective',
    displayName: 'Objective',
    enrollmentPayloadSchema: ObjectiveEnrollmentRequestSchema,
    authorizeEnrollment: (input, scope) =>
      authorizeObjectiveEnrollment(args.runtime, args.store, input, storageAuthority, forge, scope),
    validateEnrollment(candidate, existing) {
      assertObjectiveEnrollmentHasUsablePlan(
        candidate,
        existing,
        existing?.kind === 'objective' && args.objectiveStore.hasUsablePlan(existing.watcherId)
      )
    },
    async purge(watcherId) {
      await purgeObjectiveDispatchWorktrees({
        runtime: args.runtime,
        watcherId,
        objectiveStore: args.objectiveStore
      })
      latestWorlds.delete(watcherId)
      latestEnrollments.delete(watcherId)
      args.objectiveStore.purge(watcherId)
    },
    describeEnrollment(enrollment) {
      const text = objectiveContractFromEnrollment(enrollment).objectiveText
      return text.length > 96 ? `${text.slice(0, 93)}...` : text
    },
    async read(enrollment, options): Promise<Snapshot<ObjectiveWorld>> {
      const contract = objectiveContractFromEnrollment(enrollment)
      const target = await resolveObjectiveWorkspaceTarget(args.runtime, enrollment)
      if (target.kind !== contract.workspaceKind) {
        throw new Error('Objective workspace kind changed after enrollment')
      }
      const contentIdentity = await computeWorkspaceContentIdentity(target)
      const projection = args.objectiveStore.project(
        enrollment.watcherId,
        undefined,
        contentIdentity
      )
      const landingContext = await readObjectiveLandingContext({
        target,
        projection,
        contentIdentity,
        repoKey: enrollment.repoId,
        landingBar: contract.landingBar,
        forge
      })
      let world = ObjectiveWorldSchema.parse({
        contract,
        workspaceKind: target.kind,
        plan: projection,
        reports: [],
        budget: enrollment.budget,
        capabilities: enrollment.capabilities,
        landingContext,
        parallel: args.objectiveStore.parallelProjection(enrollment.watcherId, contract)
      })
      if (args.judgmentService) {
        const authority = judgmentAuthority(storageAuthority, target)
        const judgmentLedger = args.judgmentService.readLedger(enrollment.watcherId)
        if (args.judgmentService.canCollectReportEvidence(authority)) {
          const judgmentReports = await readObjectiveJudgmentReports({
            world,
            ledger: judgmentLedger,
            target,
            enrollment
          })
          world = ObjectiveWorldSchema.parse({ ...world, judgmentReports })
        }
        const requests = collectObjectiveJudgmentQuestions(world, judgmentLedger)
        const judgment = await args.judgmentService.evaluate({
          watcherId: enrollment.watcherId,
          contentIdentity,
          world,
          requests,
          authority
        })
        world = ObjectiveWorldSchema.parse({ ...world, judgment })
      }
      latestWorlds.set(enrollment.watcherId, world)
      latestEnrollments.set(enrollment.watcherId, enrollment)
      const snapshot: Snapshot<ObjectiveWorld> = {
        freshness: options.fresh ? 'live' : 'cached',
        contentIdentity,
        observedAtMs: Date.now(),
        world
      }
      return bindObjectiveSnapshot(snapshotBindings, snapshot, { enrollment, contract, target })
    },
    describeSnapshot(snapshot) {
      const revision = snapshot.world.plan.revisions
        .filter((entry) => entry.status === 'approved')
        .sort((left, right) => right.number - left.number)[0]
      const nodes = revision
        ? snapshot.world.plan.nodes.filter((node) => node.revisionId === revision.id)
        : []
      const judgment = snapshot.world.judgment
      const judgmentAnswers = Object.values(judgment?.answers ?? {})
      const judgmentAuthoritative = judgmentAnswers.filter(
        (recorded) =>
          judgment &&
          getActingJudgment(judgment, recorded.questionId, recorded.subjectId) !== undefined
      ).length
      return {
        contentIdentity: snapshot.contentIdentity.slice(0, 12),
        revision: revision?.number ?? null,
        nodesDone: nodes.filter((node) => node.state === 'succeeded').length,
        nodesTotal: nodes.length,
        phase: objectivePhase(snapshot),
        runningCount: snapshot.world.parallel?.runningCount ?? 0,
        effectiveMaxConcurrency: snapshot.world.parallel?.effectiveMaxConcurrency ?? 1,
        parallelNote: snapshot.world.parallel?.note ?? null,
        branch: snapshot.world.landingContext.branch,
        judgmentStatus: judgment?.status ?? null,
        judgmentAnswerCount: judgmentAnswers.length,
        judgmentShadowHeld: judgmentAnswers.filter((answer) => answer.mode === 'shadow').length,
        judgmentActing: judgmentAnswers.filter((answer) => answer.mode === 'acting').length,
        judgmentAuthoritative,
        judgmentHeld: judgmentAnswers.length - judgmentAuthoritative,
        judgmentReason: judgment?.reason ?? null,
        judgmentNotices: judgment?.notices ?? []
      }
    },
    decide(snapshot, ledger) {
      const decision = decideObjectiveForEnrollment(
        snapshot,
        ledger,
        requireObjectiveSnapshotBinding(snapshotBindings, snapshot).enrollment
      )
      snapshotDecisions.set(snapshot, decision)
      return decision
    },
    async preflight(action, snapshot, ledger, context) {
      const binding = requireObjectiveSnapshotBinding(snapshotBindings, snapshot)
      return objectivePreflight({
        action,
        snapshot,
        ledger,
        enrollment: context.enrollment,
        target: binding.target
      })
    },
    execute: executor.execute,
    resolveOutcome: executor.resolveOutcome,
    concurrency,
    stopPredicates: OBJECTIVE_STOP_PREDICATES,
    pacing: {
      pace(snapshot, ledger) {
        const decision =
          snapshotDecisions.get(snapshot) ??
          decideObjectiveForEnrollment(
            snapshot,
            ledger,
            requireObjectiveSnapshotBinding(snapshotBindings, snapshot).enrollment
          )
        snapshotDecisions.delete(snapshot)
        return paceObjectiveForEnrollment(snapshot, ledger, decision)
      }
    },
    planner: {},
    handoff: objectiveHandoffAdapter(args.objectiveStore, latestWorlds),
    submission: createObjectiveSubmissionAdapter({
      runtime: args.runtime,
      objectiveStore: args.objectiveStore
    }),
    owner: createObjectiveOwnerAdapter(),
    debug: {
      pointers: () => [
        {
          role: 'kind-database',
          host: 'kernel',
          path: args.objectiveStore.databasePath(),
          status: 'resolved'
        }
      ]
    }
  }
}
