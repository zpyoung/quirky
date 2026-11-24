import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { KernelAction, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type {
  HostedReviewSitterDefinition,
  PrepareConflictResolutionAction,
  PrepareFixAction,
  PublishConflictResolutionAction,
  PublishFixAction
} from '../../shared/fork-hosted-review-sitter/types'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { assertBranchAndHead, verifyPreparedCommit, type PublishAction } from './agent-execution'
import {
  inspectHostedReviewSitterContention,
  type HostedReviewOwnedWorkerIdentity
} from './contention'
import { expectedStateMismatch, tagHostedReviewPreDispatchError } from './provider-action-effect'
import { resolveHostedReviewSitterGitExecution } from './provider-git'

function isPrepareFixAction(action: KernelAction): action is PrepareFixAction {
  return action.kind === 'prepare-fix'
}

function isPrepareConflictResolutionAction(
  action: KernelAction
): action is PrepareConflictResolutionAction {
  return action.kind === 'prepare-conflict-resolution'
}

function preparationForPublication(
  action: PublishAction,
  ledger: WatcherLedger
): {
  action: PrepareFixAction | PrepareConflictResolutionAction
  fingerprint: string
  worker: HostedReviewOwnedWorkerIdentity | undefined
} {
  const entry = ledger.entries
    .toReversed()
    .find(
      (candidate) =>
        candidate.kind === 'attempt' && candidate.attemptId === action.preparationActionId
    )
  if (!entry || entry.kind !== 'attempt') {
    throw new Error('Hosted review publication lost its preparation attempt.')
  }
  const preparation = entry.action
  if (action.kind === 'publish-fix' && isPrepareFixAction(preparation)) {
    return {
      action: preparation,
      fingerprint: entry.fingerprint,
      worker: entry.dispatchId
        ? { attemptId: entry.attemptId, dispatchId: entry.dispatchId }
        : undefined
    }
  }
  if (
    action.kind === 'publish-conflict-resolution' &&
    isPrepareConflictResolutionAction(preparation)
  ) {
    return {
      action: preparation,
      fingerprint: entry.fingerprint,
      worker: entry.dispatchId
        ? { attemptId: entry.attemptId, dispatchId: entry.dispatchId }
        : undefined
    }
  }
  throw new Error('Hosted review publication does not match its preparation attempt.')
}

export async function publishHostedReviewPreparation(
  runtime: QuirkyRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  action: PublishFixAction | PublishConflictResolutionAction,
  ledger: WatcherLedger,
  lease: LeaseGuard,
  preparedEvidence: {
    sourceHeadSha: string
    preparedCommitSha: string
    preparationAttemptFingerprint: string
  } | null
): Promise<ActionOutcome> {
  if (
    action.expectedState.target !== definition.reviewUrl ||
    action.expectedState.before !== action.headSha ||
    !preparedEvidence ||
    preparedEvidence.sourceHeadSha !== action.headSha ||
    preparedEvidence.preparedCommitSha !== action.preparedCommitSha
  ) {
    throw expectedStateMismatch('Hosted review publication expected state no longer matches.')
  }
  const preparation = preparationForPublication(action, ledger)
  if (preparedEvidence.preparationAttemptFingerprint !== preparation.fingerprint) {
    throw expectedStateMismatch('Hosted review publication preparation identity changed.')
  }

  const git = await resolveHostedReviewSitterGitExecution(runtime, store, definition)
  try {
    const contention = await inspectHostedReviewSitterContention(
      runtime,
      store,
      definition,
      preparation.worker
    )
    if (contention.state !== 'clear') {
      throw new Error(`Hosted review publication held by ${contention.state}.`)
    }
    await assertBranchAndHead(git, definition, action.preparedCommitSha)
    const [remoteHeadSha, status] = await Promise.all([git.remoteHeadSha(), git.getStatus()])
    if (remoteHeadSha !== action.headSha) {
      throw expectedStateMismatch(
        `Hosted review head changed from ${action.headSha} to ${remoteHeadSha ?? '<unverifiable>'}.`
      )
    }
    if (status.didHitLimit || status.entries.length > 0) {
      throw new Error('Hosted review publication requires an exactly clean worktree.')
    }
    await verifyPreparedCommit(
      git,
      preparation.action,
      preparation.fingerprint,
      action.preparedCommitSha
    )
    await lease.assertHeld()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'effect' in error &&
      error.effect === 'not-landed'
    ) {
      throw error
    }
    throw tagHostedReviewPreDispatchError(error)
  }

  await git.pushCommit(action.preparedCommitSha, action.expectedState.before, undefined, () =>
    lease.assertHeld()
  )
  return {
    effect: 'landed',
    result: { kind: 'published', resultingHeadSha: action.preparedCommitSha },
    expectedBefore: action.expectedState.before,
    expectedAfter: action.preparedCommitSha
  }
}
