import type { ActionOutcome, EffectCertainty } from '../../shared/fork-heimdall/effect-certainty'
import { resolveByExpectedState } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, KernelAction } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import { hostedReviewAttemptFingerprint } from '../../shared/fork-hosted-review-sitter/action-identity'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterActionResult,
  HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter/types'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import {
  buildHostedReviewWorkerDispatch,
  type HostedReviewWorkerDispatch
} from './agent-preparation'
import { publishHostedReviewPreparation } from './agent-publication'
import { tagHostedReviewPreDispatchError } from './provider-action-effect'
import type { HostedReviewSitterGitExecution, HostedReviewSitterProviderAdapter } from './provider'

const HOSTED_REVIEW_ACTION_KINDS: Record<HostedReviewSitterAction['kind'], true> = {
  'rerun-check': true,
  'prepare-fix': true,
  'publish-fix': true,
  'prepare-conflict-resolution': true,
  'publish-conflict-resolution': true,
  'update-branch': true,
  merge: true,
  enqueue: true
}

function isHostedReviewSitterAction(action: KernelAction): action is HostedReviewSitterAction {
  return Object.hasOwn(HOSTED_REVIEW_ACTION_KINDS, action.kind)
}

export function hostedReviewAttemptExpectation(
  action: HostedReviewSitterAction
): { expectedBefore: string; expectedAfter: string } | undefined {
  switch (action.kind) {
    case 'rerun-check':
      return {
        expectedBefore: action.expectedState.before,
        expectedAfter: `rerun-observed:${action.evidenceKey}`
      }
    case 'publish-fix':
    case 'publish-conflict-resolution':
      return {
        expectedBefore: action.expectedState.before,
        expectedAfter: action.preparedCommitSha
      }
    case 'update-branch':
      return {
        expectedBefore: action.expectedState.before,
        expectedAfter: `updated:${action.headSha}:${action.baseSha}`
      }
    case 'merge':
      return {
        expectedBefore: action.expectedState.before,
        expectedAfter: `merged:${action.headSha}`
      }
    case 'enqueue':
      return {
        expectedBefore: action.expectedState.before,
        expectedAfter: `enqueued:${action.headSha}`
      }
    case 'prepare-fix':
    case 'prepare-conflict-resolution':
      return undefined
  }
}

function providerExpectedAfter(
  action: HostedReviewSitterAction,
  result: HostedReviewSitterActionResult
): string {
  if (result.kind === 'published') {
    return result.resultingHeadSha
  }
  switch (action.kind) {
    case 'rerun-check':
      return `rerun-observed:${action.evidenceKey}`
    case 'merge':
      return `merged:${action.headSha}`
    case 'enqueue':
      return `enqueued:${action.headSha}`
    case 'prepare-fix':
    case 'publish-fix':
    case 'prepare-conflict-resolution':
    case 'publish-conflict-resolution':
    case 'update-branch':
      return action.headSha
  }
}

export async function executeHostedReviewSitterAction(
  runtime: QuirkyRuntimeService,
  store: Store,
  provider: HostedReviewSitterProviderAdapter,
  action: HostedReviewSitterAction,
  context: ExecuteContext<HostedReviewWorld>
): Promise<ActionOutcome> {
  const definition = context.snapshot.world.definition
  if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
    const fingerprint = hostedReviewAttemptFingerprint(action)
    let request: HostedReviewWorkerDispatch
    try {
      request = buildHostedReviewWorkerDispatch(store, definition, action, fingerprint)
      await context.lease.assertHeld()
    } catch (error) {
      throw tagHostedReviewPreDispatchError(error)
    }
    const dispatched = await context.dispatchWorker(request)
    switch (dispatched.status) {
      case 'dispatched':
        return {
          effect: 'landed',
          result: { kind: 'worker-dispatched', dispatchId: dispatched.dispatchId }
        }
      case 'refused':
        return {
          effect: 'not-landed',
          reason: `${dispatched.reason}: ${dispatched.detail}`
        }
      case 'indeterminate':
        return {
          effect: 'indeterminate',
          reason: `Worker dispatch outcome is indeterminate: ${dispatched.requestId}`
        }
    }
  }

  if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
    return publishHostedReviewPreparation(
      runtime,
      store,
      definition,
      action,
      context.ledger,
      context.lease,
      context.snapshot.world.preparedCommit
    )
  }

  await context.lease.assertHeld()
  const result = await provider.execute(definition, action, () => context.lease.assertHeld())
  return {
    effect: 'landed',
    result,
    expectedBefore: action.expectedState.before,
    expectedAfter: providerExpectedAfter(action, result)
  }
}

function observedStateForPreparation(
  attempt: AttemptEntry,
  snapshot: LiveSnapshot<HostedReviewWorld>
): string {
  return snapshot.world.preparedCommit?.preparationAttemptFingerprint === attempt.fingerprint
    ? attempt.fingerprint
    : 'worker-dispatch-unresolved'
}

function observedStateForLiveAction(
  action: Extract<HostedReviewSitterAction, { kind: 'rerun-check' | 'merge' | 'enqueue' }>,
  snapshot: LiveSnapshot<HostedReviewWorld>
): string {
  const review = snapshot.world.review
  switch (action.kind) {
    case 'rerun-check': {
      if (review.headSha !== action.headSha) {
        return `moved:${review.headSha}`
      }
      const old = new Set(action.observationIds)
      const current = review.checks.filter((check) => action.checkIds.includes(check.checkId))
      if (
        current.some((check) => check.headSha === action.headSha && !old.has(check.observationId))
      ) {
        return `rerun-observed:${action.evidenceKey}`
      }
      return current.length === action.checkIds.length &&
        current.every(
          (check) =>
            check.headSha === action.headSha &&
            check.state === 'failed' &&
            old.has(check.observationId)
        )
        ? action.expectedState.before
        : `check-state-moved:${action.evidenceKey}`
    }
    case 'merge':
      if (review.lifecycle === 'merged' && review.headSha === action.headSha) {
        return `merged:${action.headSha}`
      }
      return review.lifecycle === 'open' && review.headSha === action.headSha
        ? action.expectedState.before
        : `${review.lifecycle}:${review.headSha}`
    case 'enqueue':
      if (review.queue.membership === 'enqueued' && review.headSha === action.headSha) {
        return `enqueued:${action.headSha}`
      }
      return review.queue.membership === 'not-enqueued' && review.headSha === action.headSha
        ? action.expectedState.before
        : `${review.queue.membership}:${review.headSha}`
  }
}

async function resolveGitBackedOutcome(
  action: Extract<
    HostedReviewSitterAction,
    { kind: 'publish-fix' | 'publish-conflict-resolution' | 'update-branch' }
  >,
  git: HostedReviewSitterGitExecution,
  assertLeaseHeld?: () => Promise<void>
): Promise<EffectCertainty> {
  let remoteHead: string | null
  try {
    remoteHead = await git.remoteHeadSha()
  } catch {
    return 'indeterminate'
  }
  if (remoteHead === action.expectedState.before) {
    return 'not-landed'
  }
  if (action.kind !== 'update-branch') {
    return remoteHead === action.preparedCommitSha ? 'landed' : 'indeterminate'
  }
  if (!remoteHead) {
    return 'indeterminate'
  }
  try {
    if ((await git.currentHeadSha()) === remoteHead) {
      return 'landed'
    }
    if (action.mode !== 'merge-base-update') {
      return 'indeterminate'
    }
    const parents = await git.commitParents(remoteHead, undefined, assertLeaseHeld)
    return parents?.length === 2 && parents[0] === action.headSha && parents[1] === action.baseSha
      ? 'landed'
      : 'indeterminate'
  } catch {
    return 'indeterminate'
  }
}

export async function resolveHostedReviewSitterOutcome(
  attempt: AttemptEntry,
  snapshot: LiveSnapshot<HostedReviewWorld>,
  git?: HostedReviewSitterGitExecution,
  assertLeaseHeld?: () => Promise<void>
): Promise<EffectCertainty> {
  if (!isHostedReviewSitterAction(attempt.action)) {
    return 'indeterminate'
  }
  const action = attempt.action
  if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
    return resolveByExpectedState(
      observedStateForPreparation(attempt, snapshot),
      'worker-dispatch-definitely-not-landed',
      attempt.fingerprint
    )
  }
  const expectation = hostedReviewAttemptExpectation(action)
  if (!expectation) {
    return 'indeterminate'
  }
  if (
    (attempt.expectedBefore !== undefined &&
      attempt.expectedBefore !== expectation.expectedBefore) ||
    (attempt.expectedAfter !== undefined && attempt.expectedAfter !== expectation.expectedAfter)
  ) {
    return 'indeterminate'
  }
  if (
    action.kind === 'publish-fix' ||
    action.kind === 'publish-conflict-resolution' ||
    action.kind === 'update-branch'
  ) {
    return git ? resolveGitBackedOutcome(action, git, assertLeaseHeld) : 'indeterminate'
  }
  const observed = observedStateForLiveAction(action, snapshot)
  if (observed === (attempt.expectedAfter ?? expectation.expectedAfter)) {
    return 'landed'
  }
  return action.kind === 'merge' && observed === expectation.expectedBefore
    ? 'not-landed'
    : 'indeterminate'
}
