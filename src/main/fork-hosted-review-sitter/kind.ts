import type { WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  HostedReviewEnrollmentCandidateSchema,
  actionWritesWorktree,
  decideHostedReview,
  describeHostedReviewSnapshot,
  hostedReviewContentIdentity,
  hostedReviewPreflight,
  HOSTED_REVIEW_STOP_PREDICATES,
  paceHostedReview,
  type HostedReviewEnrollmentPayload,
  type HostedReviewSitterAction,
  type HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { readHostedReviewPreparedCommit } from './agent-execution'
import {
  inspectHostedReviewSitterContention,
  type HostedReviewOwnedWorkerIdentity
} from './contention'
import {
  authorizeHostedReviewSitterDefinition,
  hostedReviewDefinitionFromEnrollment
} from './definition'
import { enrollmentPayloadSchema, parseHostedReviewEnrollmentPayload } from './definition-store'
import { createHostedReviewOwnerAdapter } from './owner-adapter'
import { createHostedReviewSitterProvider, resolveHostedReviewSitterGitExecution } from './provider'
import {
  executeHostedReviewSitterAction,
  hostedReviewAttemptExpectation,
  resolveHostedReviewSitterOutcome
} from './service-action-executor'

export type HostedReviewKind = WatcherKind<
  HostedReviewWorld,
  HostedReviewSitterAction,
  HostedReviewEnrollmentPayload
>

export type HostedReviewKernelRegistration = {
  registerKind(kind: HostedReviewKind): void
}

function ownedWorkerForAction(
  action: HostedReviewSitterAction,
  ledger: WatcherLedger
): HostedReviewOwnedWorkerIdentity | undefined {
  if (action.kind !== 'publish-fix' && action.kind !== 'publish-conflict-resolution') {
    return undefined
  }
  const preparationKind =
    action.kind === 'publish-fix' ? 'prepare-fix' : 'prepare-conflict-resolution'
  const attempt = ledger.entries
    .toReversed()
    .find(
      (entry) =>
        entry.kind === 'attempt' &&
        entry.attemptId === action.preparationActionId &&
        entry.action.kind === preparationKind
    )
  return attempt?.kind === 'attempt' && attempt.dispatchId
    ? { attemptId: attempt.attemptId, dispatchId: attempt.dispatchId }
    : undefined
}
export function createHostedReviewKind(
  runtime: QuirkyRuntimeService,
  store: Store,
  storageAuthority: 'desktop' | 'runtime' = 'desktop'
): HostedReviewKind {
  const provider = createHostedReviewSitterProvider(runtime, store)
  return {
    id: 'hosted-review',
    displayName: 'Hosted review',
    enrollmentPayloadSchema,
    enrollmentInputSchema: HostedReviewEnrollmentCandidateSchema,
    authorizeEnrollment: (input) =>
      authorizeHostedReviewSitterDefinition(runtime, store, input, storageAuthority),
    describeEnrollment(enrollment) {
      const payload = parseHostedReviewEnrollmentPayload(enrollment.kindPayload)
      return payload
        ? `${payload.provider === 'github' ? 'Pull request' : 'Merge request'} #${payload.reviewNumber}`
        : `Hosted review in ${enrollment.workspacePath}`
    },
    async read(enrollment: WatcherEnrollment, options): Promise<Snapshot<HostedReviewWorld>> {
      const definition = hostedReviewDefinitionFromEnrollment(enrollment)
      const review = await provider.read(definition, options)
      if (
        review.provider !== definition.provider ||
        review.reviewNumber !== definition.reviewNumber ||
        review.url !== definition.reviewUrl
      ) {
        throw new Error('Hosted review provider identity changed')
      }
      const git = await resolveHostedReviewSitterGitExecution(runtime, store, definition)
      const preparedCommit = await readHostedReviewPreparedCommit(git, review.headSha)
      return {
        freshness: options.fresh ? 'live' : 'cached',
        contentIdentity: hostedReviewContentIdentity(review),
        observedAtMs: Date.now(),
        world: { review, definition, preparedCommit }
      }
    },
    describeSnapshot(snapshot) {
      return { ...describeHostedReviewSnapshot(snapshot) }
    },
    decide: decideHostedReview,
    attemptExpectation: hostedReviewAttemptExpectation,
    async preflight(action, snapshot, ledger) {
      const contention = actionWritesWorktree(action, snapshot.world.definition)
        ? await inspectHostedReviewSitterContention(
            runtime,
            store,
            snapshot.world.definition,
            ownedWorkerForAction(action, ledger)
          )
        : { state: 'clear' as const }
      return hostedReviewPreflight(action, snapshot, contention)
    },
    execute: (action, context) =>
      executeHostedReviewSitterAction(runtime, store, provider, action, context),
    async resolveOutcome(attempt, snapshot, _ledger, lease) {
      const actionKind = attempt.action.kind
      if (
        actionKind !== 'publish-fix' &&
        actionKind !== 'publish-conflict-resolution' &&
        actionKind !== 'update-branch'
      ) {
        return { effect: await resolveHostedReviewSitterOutcome(attempt, snapshot) }
      }
      try {
        const git = await resolveHostedReviewSitterGitExecution(
          runtime,
          store,
          snapshot.world.definition
        )
        return {
          effect: await resolveHostedReviewSitterOutcome(attempt, snapshot, git, () =>
            lease.assertHeld()
          )
        }
      } catch {
        return { effect: 'indeterminate' }
      }
    },
    stopPredicates: HOSTED_REVIEW_STOP_PREDICATES,
    pacing: { pace: paceHostedReview },
    owner: createHostedReviewOwnerAdapter()
  }
}

export function registerHostedReviewKind(
  kernel: HostedReviewKernelRegistration,
  runtime: QuirkyRuntimeService,
  store: Store,
  storageAuthority: 'desktop' | 'runtime' = 'desktop'
): void {
  kernel.registerKind(createHostedReviewKind(runtime, store, storageAuthority))
}
