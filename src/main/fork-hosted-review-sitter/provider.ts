import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { Store } from '../persistence'
import type {
  HostedReviewSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import {
  resolveHostedReviewSitterGitExecution,
  throwIfAborted,
  type HostedReviewSitterGitExecution
} from './provider-git'
import { executeGitHubSitterAction, readGitHubSitterSnapshot } from './provider-github'
import { executeGitLabSitterAction, readGitLabSitterSnapshot } from './provider-gitlab'
import {
  createHostedReviewSitterMutationTracker,
  expectedStateMismatch,
  tagHostedReviewPreDispatchError
} from './provider-action-effect'

export type HostedReviewSitterProviderAdapter = {
  read(
    definition: HostedReviewSitterDefinition,
    options: { fresh: boolean }
  ): Promise<HostedReviewSnapshot>
  execute(
    definition: HostedReviewSitterDefinition,
    action: HostedReviewSitterAction,
    assertLeaseHeld: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<HostedReviewSitterActionResult>
}

const PROVIDER_ACTIONS: Partial<Record<HostedReviewSitterAction['kind'], true>> = {
  'rerun-check': true,
  'update-branch': true,
  merge: true,
  enqueue: true
}

function assertProviderAction(
  action: HostedReviewSitterAction
): asserts action is Extract<
  HostedReviewSitterAction,
  { kind: 'rerun-check' | 'update-branch' | 'merge' | 'enqueue' }
> {
  if (PROVIDER_ACTIONS[action.kind] !== true) {
    throw new Error(`Hosted review sitter action ${action.kind} belongs to the agent actuator.`)
  }
}

function expectedTarget(
  definition: HostedReviewSitterDefinition,
  action: Extract<
    HostedReviewSitterAction,
    { kind: 'rerun-check' | 'update-branch' | 'merge' | 'enqueue' }
  >
): string {
  switch (action.kind) {
    case 'rerun-check':
      return `${definition.reviewUrl}#check:${action.checkKey}`
    case 'update-branch':
      return `refs/heads/${definition.branch}`
    case 'merge':
    case 'enqueue':
      return definition.reviewUrl
  }
}
function assertConditionalExpectedState(
  definition: HostedReviewSitterDefinition,
  action: Extract<
    HostedReviewSitterAction,
    { kind: 'rerun-check' | 'update-branch' | 'merge' | 'enqueue' }
  >
): void {
  if (
    action.expectedState.before !== action.headSha ||
    action.expectedState.target !== expectedTarget(definition, action)
  ) {
    throw expectedStateMismatch(
      `Hosted review sitter action ${action.kind} lacks its exact expected state.`
    )
  }
}

export function createHostedReviewSitterProvider(
  runtime: QuirkyRuntimeService,
  store: Store
): HostedReviewSitterProviderAdapter {
  return {
    read: async (definition, options) => {
      const git = await resolveHostedReviewSitterGitExecution(runtime, store, definition)
      switch (definition.provider) {
        case 'github':
          return readGitHubSitterSnapshot(definition, git, options)
        case 'gitlab':
          return readGitLabSitterSnapshot(definition, git, options)
      }
    },
    execute: async (definition, action, assertLeaseHeld, signal) => {
      const tracker = createHostedReviewSitterMutationTracker()
      try {
        throwIfAborted(signal)
        assertProviderAction(action)
        assertConditionalExpectedState(definition, action)
        const git = await resolveHostedReviewSitterGitExecution(runtime, store, definition)
        switch (definition.provider) {
          case 'github':
            return await executeGitHubSitterAction(
              definition,
              action,
              git,
              signal,
              tracker,
              assertLeaseHeld
            )
          case 'gitlab':
            return await executeGitLabSitterAction(
              definition,
              action,
              git,
              signal,
              tracker,
              assertLeaseHeld
            )
        }
      } catch (error) {
        throw tracker.dispatched ? error : tagHostedReviewPreDispatchError(error)
      }
    }
  }
}

export { resolveHostedReviewSitterGitExecution }
export type { HostedReviewSitterGitExecution }
