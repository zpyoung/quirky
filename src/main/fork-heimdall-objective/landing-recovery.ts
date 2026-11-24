import {
  resolveByExpectedState,
  type EffectCertainty
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry } from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type {
  CommitLocalBranchAction,
  ObjectiveAction,
  OpenHostedReviewAction,
  PushRefAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import { computeWorkspaceContentIdentity, objectiveGitCommandForTarget } from './content-identity'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { objectiveForgeContext, type ObjectiveForgeAccess } from './objective-forge-access'
import {
  objectiveRemoteRefState,
  readObjectiveAttachedBranch,
  readObjectiveHeadSha,
  readObjectiveRemoteBranchHead
} from './landing-git-state'
import { objectiveDirtyPathsByTerritory } from './landing-territory'
import type { ObjectiveStore } from './objective-store'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'
import type { RecordLandingArgs } from './objective-store-data'

const ATTEMPT_TRAILER = 'Quirky-Heimdall-Attempt'

type LandingAction = CommitLocalBranchAction | PushRefAction | OpenHostedReviewAction

type RecoveryProbeArgs<TAction extends LandingAction> = {
  action: TAction
  attempt: AttemptEntry
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  forge: ObjectiveForgeAccess
  lease: LeaseGuard
}
export type CommittedLocalBranchObservation =
  | {
      effect: 'landed'
      branch: string
      commitSha: string
      treeOid: string
      contentIdentity: string
      worktreeContentDigest: string
      insideTerritoryPaths: string[]
      outsideTerritoryPaths: string[]
    }
  | {
      effect: 'not-landed'
      insideTerritoryPaths: string[]
      outsideTerritoryPaths: string[]
    }
  | {
      effect: 'indeterminate'
      insideTerritoryPaths: string[]
      outsideTerritoryPaths: string[]
    }

function messageHasAttemptTrailer(message: string, expected: string): boolean {
  const trailer = `${ATTEMPT_TRAILER}: ${expected}`
  const lines = message.replace(/\r\n/gu, '\n').trimEnd().split('\n')
  return (
    lines.filter((line) => line.startsWith(`${ATTEMPT_TRAILER}: `)).length === 1 &&
    lines.at(-1) === trailer
  )
}

export function hostedReviewIsLive(review: HostedReviewInfo | null): review is HostedReviewInfo {
  return review !== null && (review.state === 'open' || review.state === 'draft')
}

export function hostedReviewMatchesAction(
  review: HostedReviewInfo | null,
  action: OpenHostedReviewAction
): review is HostedReviewInfo {
  return hostedReviewIsLive(review) && review.headSha === action.headSha
}

async function recordRecoveryLanding(
  args: RecoveryProbeArgs<LandingAction>,
  contentIdentity: string,
  payload: RecordLandingArgs['payload']
): Promise<void> {
  if (
    args.objectiveStore.hasLanding(
      args.binding.enrollment.watcherId,
      args.action.rung,
      contentIdentity
    )
  ) {
    return
  }
  await args.lease.assertHeld()
  args.objectiveStore.recordLanding({
    watcherId: args.binding.enrollment.watcherId,
    rung: args.action.rung,
    contentIdentity,
    attemptFingerprint: args.attempt.fingerprint,
    payload,
    epoch: args.lease.epoch,
    createdAtMs: Date.now()
  })
}

export async function observeCommittedLocalBranch(
  action: CommitLocalBranchAction,
  binding: ObjectiveSnapshotBinding
): Promise<CommittedLocalBranchObservation> {
  const runGit = objectiveGitCommandForTarget(binding.target)
  const [branch, headSha, message, ancestry, status] = await Promise.all([
    readObjectiveAttachedBranch(runGit),
    readObjectiveHeadSha(runGit),
    runGit(['log', '-1', '--format=%B']).then((result) => result.stdout),
    runGit(['rev-list', '--parents', '-n', '1', 'HEAD']).then((result) =>
      result.stdout.trim().split(/\s+/u)
    ),
    runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--']).then(
      (result) => result.stdout
    )
  ])
  const paths = objectiveDirtyPathsByTerritory(status, binding)
  if (!messageHasAttemptTrailer(message, action.attemptTrailer)) {
    return {
      effect: headSha === action.headSha ? 'not-landed' : 'indeterminate',
      insideTerritoryPaths: paths.inside,
      outsideTerritoryPaths: paths.outside
    }
  }
  if (
    branch !== action.branch ||
    !headSha ||
    ancestry.length !== 2 ||
    ancestry[0] !== headSha ||
    ancestry[1] !== action.headSha
  ) {
    return {
      effect: 'indeterminate',
      insideTerritoryPaths: paths.inside,
      outsideTerritoryPaths: paths.outside
    }
  }
  const [treeOid, contentIdentity, worktreeContentDigest] = await Promise.all([
    runGit(['rev-parse', '--verify', 'HEAD^{tree}']).then((result) => result.stdout.trim()),
    computeWorkspaceContentIdentity(binding.target),
    computeObjectiveWorktreeContentDigest(binding.target)
  ])
  return {
    effect: 'landed',
    branch,
    commitSha: headSha,
    treeOid,
    contentIdentity,
    worktreeContentDigest,
    insideTerritoryPaths: paths.inside,
    outsideTerritoryPaths: paths.outside
  }
}

export async function probeCommittedLocalBranch(
  args: RecoveryProbeArgs<CommitLocalBranchAction>
): Promise<EffectCertainty> {
  const observation = await observeCommittedLocalBranch(args.action, args.binding)
  if (observation.effect !== 'landed') {
    return observation.effect
  }
  if (observation.worktreeContentDigest !== args.action.worktreeContentDigest) {
    return 'landed'
  }
  await recordRecoveryLanding(args, observation.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.fromContentIdentity,
    commitSha: observation.commitSha,
    treeOid: observation.treeOid,
    branch: observation.branch
  })
  return 'landed'
}

export async function probePushedRef(
  args: RecoveryProbeArgs<PushRefAction>
): Promise<EffectCertainty> {
  const runGit = objectiveGitCommandForTarget(args.binding.target)
  const observed = await readObjectiveRemoteBranchHead(
    runGit,
    args.action.remote,
    args.action.branch
  )
  const effect = resolveByExpectedState(
    objectiveRemoteRefState(observed),
    args.action.expectedState.before,
    args.action.commitSha
  )
  if (effect === 'landed') {
    await recordRecoveryLanding(args, args.action.contentIdentity, {
      revisionId: args.action.revisionId,
      fromContentIdentity: args.action.contentIdentity,
      remote: args.action.remote,
      branch: args.action.branch,
      commitSha: args.action.commitSha,
      remoteSha: observed
    })
  }
  return effect
}

export async function probeHostedReview(
  args: RecoveryProbeArgs<OpenHostedReviewAction>
): Promise<EffectCertainty> {
  const context = objectiveForgeContext(args.binding.target)
  const provider = await args.forge.getProvider(context)
  if (!provider || provider.id !== args.action.provider) {
    return 'indeterminate'
  }
  const review = await provider.getReviewForBranch({
    ...context,
    branch: args.action.branch,
    githubCurrentHeadOid: args.action.headSha
  })
  if (!hostedReviewIsLive(review)) {
    return 'not-landed'
  }
  if (!hostedReviewMatchesAction(review, args.action)) {
    return 'indeterminate'
  }
  await recordRecoveryLanding(args, args.action.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.contentIdentity,
    provider: args.action.provider,
    reviewNumber: review.number,
    reviewUrl: review.url,
    branch: args.action.branch,
    headSha: args.action.headSha,
    base: args.action.base
  })
  return 'landed'
}

export async function resolveLandingOutcome(args: {
  attempt: AttemptEntry
  action: Extract<
    ObjectiveAction,
    { kind: 'commit-local-branch' | 'push-ref' | 'open-hosted-review' }
  >
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  forge: ObjectiveForgeAccess
  lease: LeaseGuard
}): Promise<EffectCertainty> {
  try {
    if (args.action.kind === 'commit-local-branch') {
      return await probeCommittedLocalBranch({ ...args, action: args.action })
    }
    if (args.action.kind === 'push-ref') {
      return await probePushedRef({ ...args, action: args.action })
    }
    return await probeHostedReview({ ...args, action: args.action })
  } catch {
    return 'indeterminate'
  }
}
