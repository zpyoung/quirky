import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { runtimePathsEqual } from '../runtime/runtime-worktree-path-identity'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalListResult
} from '../../shared/runtime-terminal-contracts'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { getRepoHostedReviewExecutionHostId } from '../source-control/hosted-review-execution-host'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  HostedReviewSitterContention,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import { resolveHostedReviewSitterGitExecution } from './provider-git'

const CONTENTION_TERMINAL_LIMIT = 1_000

/**
 * Whether a worktree-scoped listing actually covered the host the sitter runs on.
 *
 * Not `hostScopeCensusIsComplete`: it gates on `omittedHostIds`, which a worktree-scoped listing
 * fills with every other host the runtime knows of, so any configured SSH target reads as a gap.
 * A scoped listing owes coverage for exactly one host — the one the sitter also dials for git — so
 * requiring that id in `hostIds` still refuses an uncovered remote worktree.
 */
function listingCoversExecutionHost(
  listing: Pick<RuntimeTerminalListResult, 'truncated' | 'hostScope'>,
  executionHostId: ExecutionHostId
): boolean {
  return !listing.truncated && (listing.hostScope?.hostIds.includes(executionHostId) ?? false)
}

export type HostedReviewOwnedWorkerIdentity = {
  attemptId: string
  dispatchId: string
}

function ownedWorkerTerminalHandle(
  runtime: QuirkyRuntimeService,
  definition: HostedReviewSitterDefinition,
  identity: HostedReviewOwnedWorkerIdentity | undefined
): string | null {
  if (!identity) {
    return null
  }
  const resource = runtime
    .getOrchestrationDb()
    .getWorkerTerminalResourceByOwner(identity.dispatchId)
  return resource?.origin_dispatch_id === identity.dispatchId &&
    resource.owner_dispatch_id === identity.dispatchId &&
    resource.worktree_id === definition.worktreeId &&
    resource.ownership_state === 'owned'
    ? resource.terminal_handle
    : null
}

function isProvenExitCause(cause: TerminalExitCause | undefined): boolean {
  return cause?.kind === 'operator_close' || cause?.kind === 'signaled' || cause?.kind === 'exited'
}

/**
 * Reads contention only from the execution host that owns the explicit workspace. An empty or
 * incomplete host answer is unknown, never proof that a terminal or agent disappeared.
 */
export async function inspectHostedReviewSitterContention(
  runtime: QuirkyRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  ownWorker?: HostedReviewOwnedWorkerIdentity,
  requirements: {
    requireOwnSession?: boolean
    requireOwnIdle?: boolean
    allowDirtyAfterOwnedSessionStopped?: boolean
    reportOwnLiveSession?: boolean
  } = {}
): Promise<HostedReviewSitterContention> {
  if (!definition.repoId || !definition.worktreeId || !definition.repoPath) {
    return { state: 'unverifiable', reason: 'explicit-repository-context-required' }
  }
  const repo = store.getRepo(definition.repoId)
  if (!repo) {
    return { state: 'unverifiable', reason: 'repository-context-missing' }
  }
  const executionHostId = getRepoHostedReviewExecutionHostId(repo)
  try {
    const workspace = await runtime.showManagedWorktree(`id:${definition.worktreeId}`)
    if (
      workspace.repoId !== definition.repoId ||
      !runtimePathsEqual(workspace.git.path, definition.repoPath)
    ) {
      return { state: 'unverifiable', reason: 'repository-workspace-context-mismatch' }
    }
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `workspace-context-unverifiable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  let listing: RuntimeTerminalListResult
  try {
    listing = await runtime.listTerminals(
      `id:${definition.worktreeId}`,
      CONTENTION_TERMINAL_LIMIT,
      {
        requireFreshPtyLiveness: true
      }
    )
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `terminal-host-unreachable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!listingCoversExecutionHost(listing, executionHostId)) {
    return { state: 'unverifiable', reason: 'terminal-host-census-incomplete' }
  }

  const ownTerminalHandle = ownedWorkerTerminalHandle(runtime, definition, ownWorker)
  let matchingOwnAgentActive = false
  let matchingOwnAgentIdle = false
  let matchingOwnAgentExited = false
  let matchingOwnSessionObserved = false
  let matchingOwnTerminalLive = false
  for (const terminal of listing.terminals) {
    const isOwnTerminal = terminal.handle === ownTerminalHandle
    if (isProvenExitCause(terminal.exitCause)) {
      if (isOwnTerminal) {
        matchingOwnSessionObserved = true
        matchingOwnAgentExited = true
      }
      continue
    }
    if (terminal.exitCause?.kind === 'unknown' || !terminal.connected) {
      return { state: 'unverifiable', reason: 'terminal-process-liveness-unverifiable' }
    }
    if (isOwnTerminal) {
      matchingOwnTerminalLive = true
    }

    let agentStatus: RuntimeTerminalAgentStatus
    try {
      agentStatus = await runtime.getTerminalAgentStatus(terminal.handle)
    } catch (error) {
      return {
        state: 'unverifiable',
        reason: `agent-status-unverifiable: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    // The fresh host probe positively observed that the foreground is no longer an agent.
    // `agentIdentity` is launch/history metadata and must not overrule that current evidence.
    if (!agentStatus.isRunningAgent) {
      continue
    }
    if (agentStatus.status === 'idle') {
      if (isOwnTerminal) {
        matchingOwnSessionObserved = true
        matchingOwnAgentIdle = true
        continue
      }
      return { state: 'foreign-agent', sessionId: terminal.handle }
    }
    if (agentStatus.status === null) {
      return { state: 'unverifiable', reason: 'agent-activity-unverifiable' }
    }
    if (isOwnTerminal) {
      matchingOwnSessionObserved = true
      matchingOwnAgentActive = true
      continue
    }
    return { state: 'foreign-agent', sessionId: terminal.handle }
  }
  if (requirements.allowDirtyAfterOwnedSessionStopped && matchingOwnTerminalLive) {
    return { state: 'unverifiable', reason: 'owned-agent-terminal-still-live-after-stop' }
  }
  if (requirements.requireOwnSession && !matchingOwnSessionObserved) {
    return { state: 'unverifiable', reason: 'owned-agent-session-unverifiable' }
  }
  if (requirements.requireOwnIdle && !matchingOwnAgentIdle) {
    return { state: 'unverifiable', reason: 'owned-agent-completion-unverifiable' }
  }

  let clean: boolean
  try {
    const git = await resolveHostedReviewSitterGitExecution(runtime, store, definition)
    clean = await git.worktreeIsClean()
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `working-tree-unverifiable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!clean) {
    if (ownWorker && matchingOwnAgentActive) {
      return { state: 'sitter-fix-agent', actionId: ownWorker.attemptId }
    }
    if (ownWorker && matchingOwnAgentIdle && requirements.requireOwnIdle) {
      return { state: 'sitter-fix-agent', actionId: ownWorker.attemptId }
    }
    if (ownWorker && requirements.allowDirtyAfterOwnedSessionStopped) {
      return { state: 'sitter-fix-agent', actionId: ownWorker.attemptId }
    }
    if (ownWorker && (matchingOwnAgentIdle || matchingOwnAgentExited)) {
      return {
        state: 'abandoned-sitter-fix',
        actionId: ownWorker.attemptId,
        reason: 'owned-sitter-agent-finished-or-exited-with-uncommitted-changes'
      }
    }
    return { state: 'dirty', reason: 'local-changes' }
  }
  if (
    ownWorker &&
    (matchingOwnAgentActive || (requirements.reportOwnLiveSession && matchingOwnTerminalLive))
  ) {
    return { state: 'sitter-fix-agent', actionId: ownWorker.attemptId }
  }
  return { state: 'clear' }
}
