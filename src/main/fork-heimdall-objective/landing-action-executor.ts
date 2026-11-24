import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE } from '../../shared/fork-heimdall/objective-git-exec-shapes'
import {
  objectiveActionNaturalKey,
  type CommitLocalBranchAction,
  type OpenHostedReviewAction,
  type PushRefAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { renderReviewBody } from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import { reachedRungs } from '../../shared/fork-heimdall-objective/landing-ladder'
import { computeWorkspaceContentIdentity, objectiveGitCommandForTarget } from './content-identity'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { objectiveForgeContext, type ObjectiveForgeAccess } from './objective-forge-access'
import {
  objectiveRemoteRefSha,
  objectiveRemoteRefState,
  readObjectiveAttachedBranch,
  readObjectiveHeadSha,
  readObjectiveRemoteBranchHead,
  resolveObjectivePushTarget
} from './landing-git-state'
import {
  hostedReviewIsLive,
  hostedReviewMatchesAction,
  observeCommittedLocalBranch,
  type CommittedLocalBranchObservation
} from './landing-recovery'
import { objectiveDirtyPathsByTerritory } from './landing-territory'
import type { ObjectiveStore } from './objective-store'
import type { RecordLandingArgs } from './objective-store-data'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'

const ATTEMPT_TRAILER = 'Quirky-Heimdall-Attempt'

type LandingExecutorArgs<TAction> = {
  action: TAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  forge: ObjectiveForgeAccess
}

function invalid(reason: string, result?: unknown): ActionOutcome {
  return { effect: 'not-landed', reason, ...(result === undefined ? {} : { result }) }
}

function indeterminate(reason: string, result?: unknown): ActionOutcome {
  return { effect: 'indeterminate', reason, ...(result === undefined ? {} : { result }) }
}

function errorOutput(error: unknown): { message: string; stdout: string; stderr: string } {
  if (!error || typeof error !== 'object') {
    return { message: String(error), stdout: '', stderr: '' }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
    stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  }
}
function porcelainPushWasRejected(error: unknown, remoteRef: string): boolean {
  const output = errorOutput(error)
  return [output.message, output.stdout, output.stderr].some((text) =>
    text.split(/\r?\n/u).some((line) => {
      const [flag, refspec, summary] = line.split('\t')
      return (
        flag?.trim() === '!' &&
        refspec?.endsWith(`:${remoteRef}`) === true &&
        /^\[(?:remote )?rejected\](?: \(.+\))?$/u.test(summary ?? '')
      )
    })
  )
}

function commitHookRejected(error: unknown): boolean {
  const output = errorOutput(error)
  return /(?:pre-commit|prepare-commit-msg|commit-msg|hook declined|hook failed)/iu.test(
    `${output.message}\n${output.stderr}`
  )
}

function actionFingerprint(action: {
  contentIdentity: string
  kind: string
  evidenceKey: string
}): string {
  return makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
}

function revisionTitle(binding: ObjectiveSnapshotBinding): string {
  return binding.contract.objectiveText.split(/\r?\n/u)[0]!.trim()
}

async function assertCurrentIdentity(
  action: { contentIdentity: string },
  binding: ObjectiveSnapshotBinding,
  context: ExecuteContext<ObjectiveWorld>
): Promise<boolean> {
  const identity = await computeWorkspaceContentIdentity(binding.target)
  return identity === action.contentIdentity && identity === context.snapshot.contentIdentity
}

function recordLanding(
  args: LandingExecutorArgs<CommitLocalBranchAction | PushRefAction | OpenHostedReviewAction>,
  contentIdentity: string,
  payload: RecordLandingArgs['payload']
) {
  return args.objectiveStore.recordLanding({
    watcherId: args.binding.enrollment.watcherId,
    rung: args.action.rung,
    contentIdentity,
    attemptFingerprint: actionFingerprint(args.action),
    payload,
    epoch: args.context.lease.epoch,
    createdAtMs: Date.now()
  })
}

export async function executeCommitLocalBranch(
  args: LandingExecutorArgs<CommitLocalBranchAction>
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  if (!(await assertCurrentIdentity(args.action, args.binding, args.context))) {
    return invalid('landing-evidence-stale')
  }
  if (
    (await computeObjectiveWorktreeContentDigest(args.binding.target)) !==
    args.action.worktreeContentDigest
  ) {
    return invalid('landing-evidence-stale')
  }
  const runGit = objectiveGitCommandForTarget(args.binding.target)
  const [branch, headSha] = await Promise.all([
    readObjectiveAttachedBranch(runGit),
    readObjectiveHeadSha(runGit)
  ])
  if (branch !== args.action.branch || headSha !== args.action.headSha) {
    return invalid('branch-not-attached')
  }
  const status = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--'])
  const paths = objectiveDirtyPathsByTerritory(status.stdout, args.binding)
  if (paths.inside.length === 0) {
    const parallelRun = (args.context.snapshot.world.parallel?.dispatches.length ?? 0) > 0
    if (!parallelRun || paths.outside.length > 0) {
      return invalid('nothing-to-commit', { outsideTerritoryPaths: paths.outside.slice(0, 256) })
    }
    const treeOid = (await runGit(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    await args.context.lease.assertHeld()
    recordLanding(args, args.action.contentIdentity, {
      revisionId: args.action.revisionId,
      fromContentIdentity: args.action.fromContentIdentity,
      commitSha: headSha,
      treeOid,
      branch
    })
    return {
      effect: 'landed',
      result: {
        kind: 'commit-recorded',
        naturalKey: objectiveActionNaturalKey(args.action),
        commitSha: headSha,
        contentIdentity: args.action.contentIdentity,
        outsideTerritoryPaths: []
      }
    }
  }
  await args.context.lease.assertHeld()
  for (let index = 0; index < paths.inside.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    await runGit([
      'add',
      '--',
      ...paths.inside
        .slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
        .map((path) => `:(literal)${path}`)
    ])
  }
  await args.context.lease.assertHeld()
  const message = `${revisionTitle(args.binding)}\n\n${ATTEMPT_TRAILER}: ${args.action.attemptTrailer}`
  let commitError: unknown
  try {
    await runGit([
      'commit',
      '-m',
      message,
      '--',
      ...paths.inside.map((path) => `:(literal)${path}`)
    ])
  } catch (error) {
    commitError = error
  }
  await args.context.lease.assertHeld()
  let observation: CommittedLocalBranchObservation
  try {
    observation = await observeCommittedLocalBranch(args.action, args.binding)
  } catch (error) {
    return indeterminate('commit-probe-failed', {
      commit: commitError ? errorOutput(commitError) : 'completed',
      probe: errorOutput(error)
    })
  }
  await args.context.lease.assertHeld()
  const outsideTerritoryPaths = observation.outsideTerritoryPaths.slice(0, 256)
  if (observation.effect === 'not-landed') {
    if (!commitError) {
      return indeterminate('commit-state-indeterminate', { outsideTerritoryPaths })
    }
    return invalid(commitHookRejected(commitError) ? 'commit-hook-failed' : 'commit-not-landed', {
      ...errorOutput(commitError),
      outsideTerritoryPaths
    })
  }
  if (observation.effect === 'indeterminate') {
    return indeterminate('commit-state-indeterminate', {
      ...(commitError ? errorOutput(commitError) : {}),
      outsideTerritoryPaths
    })
  }
  if (observation.worktreeContentDigest !== args.action.worktreeContentDigest) {
    return {
      effect: 'landed',
      result: {
        kind: 'commit-attribution-skipped',
        reason: 'worktree-content-changed',
        commitSha: observation.commitSha,
        observedContentIdentity: observation.contentIdentity,
        outsideTerritoryPaths
      }
    }
  }
  recordLanding(args, observation.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.fromContentIdentity,
    commitSha: observation.commitSha,
    treeOid: observation.treeOid,
    branch: observation.branch
  })
  return {
    effect: 'landed',
    result: {
      kind: 'commit-recorded',
      naturalKey: objectiveActionNaturalKey(args.action),
      commitSha: observation.commitSha,
      contentIdentity: observation.contentIdentity,
      outsideTerritoryPaths
    }
  }
}

export async function executePushRef(
  args: LandingExecutorArgs<PushRefAction>
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  if (!(await assertCurrentIdentity(args.action, args.binding, args.context))) {
    return invalid('landing-evidence-stale')
  }
  const runGit = objectiveGitCommandForTarget(args.binding.target)
  const localBranch = await readObjectiveAttachedBranch(runGit)
  if (!localBranch) {
    return invalid('branch-not-attached')
  }
  const headSha = await readObjectiveHeadSha(runGit)
  if (headSha !== args.action.commitSha) {
    return invalid('landing-evidence-stale')
  }
  let target: Awaited<ReturnType<typeof resolveObjectivePushTarget>>
  try {
    target = await resolveObjectivePushTarget(runGit, localBranch)
  } catch (error) {
    return indeterminate('push-probe-failed', errorOutput(error))
  }
  if (!target || target.remote !== args.action.remote || target.branch !== args.action.branch) {
    return invalid('push-target-changed')
  }
  if (target.remoteSha !== args.action.expectedState.before) {
    return invalid('expected-state-moved')
  }
  await runGit(['check-ref-format', '--branch', args.action.branch])
  await runGit(['cat-file', '-e', `${args.action.commitSha}^{commit}`])
  await args.context.lease.assertHeld()
  const remoteRef = `refs/heads/${args.action.branch}`
  const expectedBeforeSha = objectiveRemoteRefSha(args.action.expectedState.before)
  let pushError: unknown
  try {
    await runGit([
      'push',
      '--porcelain',
      `--force-with-lease=${remoteRef}:${expectedBeforeSha}`,
      args.action.remote,
      `${args.action.commitSha}:${remoteRef}`
    ])
  } catch (error) {
    pushError = error
  }
  await args.context.lease.assertHeld()
  let observed: string
  try {
    observed = await readObjectiveRemoteBranchHead(runGit, args.action.remote, args.action.branch)
  } catch (error) {
    return indeterminate('push-probe-failed', {
      push: pushError ? errorOutput(pushError) : 'completed',
      probe: errorOutput(error)
    })
  }
  await args.context.lease.assertHeld()
  const observedState = objectiveRemoteRefState(observed)
  if (observed === args.action.commitSha) {
    recordLanding(args, args.action.contentIdentity, {
      revisionId: args.action.revisionId,
      fromContentIdentity: args.action.contentIdentity,
      remote: args.action.remote,
      branch: args.action.branch,
      commitSha: args.action.commitSha,
      remoteSha: observed
    })
    return {
      effect: 'landed',
      expectedBefore: args.action.expectedState.before,
      expectedAfter: args.action.commitSha,
      result: {
        kind: 'push-recorded',
        naturalKey: objectiveActionNaturalKey(args.action),
        remoteSha: observed
      }
    }
  }
  if (pushError && porcelainPushWasRejected(pushError, remoteRef)) {
    return invalid(
      observedState === args.action.expectedState.before ? 'push-not-landed' : 'remote-moved',
      errorOutput(pushError)
    )
  }
  if (observedState === args.action.expectedState.before) {
    return invalid('push-not-landed', pushError ? errorOutput(pushError) : undefined)
  }
  return indeterminate('push-state-indeterminate', {
    observed: observedState,
    ...(pushError ? errorOutput(pushError) : {})
  })
}

async function recordMatchingReview(
  args: LandingExecutorArgs<OpenHostedReviewAction>,
  review: { number: number; url: string }
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  recordLanding(args, args.action.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.contentIdentity,
    provider: args.action.provider,
    reviewNumber: review.number,
    reviewUrl: review.url,
    branch: args.action.branch,
    headSha: args.action.headSha,
    base: args.action.base
  })
  return {
    effect: 'landed',
    expectedBefore: args.action.expectedState.before,
    expectedAfter: review.url,
    result: {
      kind: 'review-recorded',
      naturalKey: objectiveActionNaturalKey(args.action),
      reviewNumber: review.number,
      reviewUrl: review.url
    }
  }
}

export async function executeOpenHostedReview(
  args: LandingExecutorArgs<OpenHostedReviewAction>
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  if (!(await assertCurrentIdentity(args.action, args.binding, args.context))) {
    return invalid('landing-evidence-stale')
  }
  if (
    !reachedRungs(args.context.snapshot.world.plan.landing, args.action.contentIdentity).has(
      'pushed-ref'
    )
  ) {
    return invalid('landing-evidence-stale')
  }
  const context = objectiveForgeContext(args.binding.target)
  let provider: Awaited<ReturnType<ObjectiveForgeAccess['getProvider']>>
  try {
    provider = await args.forge.getProvider(context)
  } catch (error) {
    return indeterminate('forge-probe-failed', errorOutput(error))
  }
  if (!provider || provider.id !== args.action.provider) {
    return invalid('forge-changed')
  }
  const createReview = provider.createReview?.bind(provider)
  if (!provider.supportsReviewCreation || !createReview) {
    return invalid('forge-cannot-create')
  }
  const reviewInput = {
    ...context,
    branch: args.action.branch,
    githubCurrentHeadOid: args.action.headSha
  }
  let existing: HostedReviewInfo | null
  try {
    existing = await provider.getReviewForBranch(reviewInput)
  } catch (error) {
    return indeterminate('hosted-review-probe-failed', errorOutput(error))
  }
  if (hostedReviewMatchesAction(existing, args.action)) {
    return recordMatchingReview(args, existing)
  }
  if (existing && hostedReviewIsLive(existing)) {
    return indeterminate('hosted-review-state-moved')
  }
  try {
    if (!(await args.forge.isAuthenticated(provider.id, context))) {
      return invalid('auth_required')
    }
  } catch (error) {
    return indeterminate('forge-auth-probe-failed', errorOutput(error))
  }
  const plan = args.objectiveStore.getPlan(args.action.revisionId)
  if (!plan) {
    return invalid('landing-plan-missing')
  }
  await args.context.lease.assertHeld()
  let result: Awaited<ReturnType<typeof createReview>> | undefined
  let creationError: unknown
  try {
    result = await createReview(
      context.repoPath,
      {
        provider: provider.id,
        base: args.action.base,
        head: args.action.branch,
        title: revisionTitle(args.binding),
        body: renderReviewBody(args.binding.contract, plan),
        draft: false,
        worktreePath: context.repoPath,
        useTemplate: true
      },
      context.executionHostId,
      context
    )
  } catch (error) {
    creationError = error
  }
  await args.context.lease.assertHeld()
  args.forge.invalidate(context)
  let authoritative: HostedReviewInfo | null
  try {
    authoritative = await provider.getReviewForBranch(reviewInput)
  } catch (error) {
    return indeterminate('hosted-review-probe-failed', {
      create: creationError ? errorOutput(creationError) : result,
      probe: errorOutput(error)
    })
  }
  if (hostedReviewMatchesAction(authoritative, args.action)) {
    return recordMatchingReview(args, authoritative)
  }
  if (authoritative && hostedReviewIsLive(authoritative)) {
    return indeterminate('hosted-review-state-moved')
  }
  if (creationError) {
    return indeterminate('hosted-review-create-failed', errorOutput(creationError))
  }
  if (!result) {
    return indeterminate('hosted-review-create-unverifiable')
  }
  if (
    !result.ok &&
    result.code !== 'already_exists' &&
    (result.code === 'validation' ||
      result.code === 'push_failed' ||
      result.code === 'unsupported_provider' ||
      result.code === 'auth_required')
  ) {
    return invalid(result.code, result)
  }
  if (!result.ok && result.code !== 'already_exists') {
    return indeterminate(result.code, result)
  }
  return indeterminate('hosted-review-create-unverifiable', result)
}
