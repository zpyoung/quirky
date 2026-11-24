import { randomUUID } from 'node:crypto'
import type { GitCapabilityCache } from '../git-capability-cache'
import { isNoWriteFetchHeadUnsupportedError } from '../git-fetch-head-capability'
import { resolveGitRemoteRebaseSource } from '../git-rebase-source'
import { runWithGitWorktreeOperationLock } from '../git-worktree-operation-lock'
export const HOSTED_REVIEW_BRANCH_UPDATE_RPC_TIMEOUT_MS = 135_000
export const HOSTED_REVIEW_COMMIT_PUSH_RPC_TIMEOUT_MS = 60_000

export type HostedReviewCommitPushInput = {
  worktreePath: string
  branch: string
  pushUrl: string
  commitSha: string
  expectedHeadSha: string
}

export type HostedReviewBranchUpdateInput = {
  worktreePath: string
  branch: string
  pushRemote: string
  baseRef: string
  expectedHeadSha: string
  expectedBaseSha: string
  mode: 'merge-base-update' | 'rebase'
}

export type HostedReviewBranchUpdateResult = {
  resultingHeadSha: string
}

export type HostedReviewBranchUpdateGitRunner = (
  args: string[]
) => Promise<{ stdout: string; stderr?: string }>

export const HOSTED_REVIEW_EXPECTED_STATE_MISMATCH_MESSAGE =
  'Hosted review write was rejected because its expected state no longer matched.'

export class HostedReviewExpectedStateMismatchError extends Error {
  readonly effect = 'not-landed' as const
  readonly reason = 'expected-state-mismatch' as const

  constructor(cause: unknown) {
    super(HOSTED_REVIEW_EXPECTED_STATE_MISMATCH_MESSAGE, {
      cause
    })
    this.name = 'HostedReviewExpectedStateMismatchError'
  }
}

export const HOSTED_REVIEW_CONFIRMED_NOT_LANDED_MESSAGE =
  'Hosted review write did not land; its target remains at the expected prior state.'

export class HostedReviewConfirmedNotLandedError extends Error {
  readonly effect = 'not-landed' as const
  readonly reason = 'remote-unchanged-after-push-error' as const

  constructor(cause: unknown) {
    super(HOSTED_REVIEW_CONFIRMED_NOT_LANDED_MESSAGE, { cause })
    this.name = 'HostedReviewConfirmedNotLandedError'
  }
}

function isConditionalPushRejection(error: unknown): boolean {
  const details =
    error && typeof error === 'object'
      ? [
          error instanceof Error ? error.message : '',
          'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
          'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
        ].join('\n')
      : String(error ?? '')
  return /(?:\[rejected\]|stale info|non-fast-forward|fetch first)/i.test(details)
}

function rethrowLeaseLost(error: unknown): void {
  if (error instanceof Error && error.name === 'LeaseLostError') {
    throw error
  }
}

function assertObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`Invalid ${label}.`)
  }
}

export function assertHostedReviewBranchUpdateInput(
  value: unknown
): asserts value is HostedReviewBranchUpdateInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid hosted review branch update request.')
  }
  if (
    !('worktreePath' in value) ||
    typeof value.worktreePath !== 'string' ||
    value.worktreePath.length === 0
  ) {
    throw new Error('Invalid hosted review branch update worktreePath.')
  }
  if (!('branch' in value) || typeof value.branch !== 'string' || value.branch.length === 0) {
    throw new Error('Invalid hosted review branch update branch.')
  }
  if (
    !('pushRemote' in value) ||
    typeof value.pushRemote !== 'string' ||
    value.pushRemote.length === 0
  ) {
    throw new Error('Invalid hosted review branch update pushRemote.')
  }
  if (!('baseRef' in value) || typeof value.baseRef !== 'string' || value.baseRef.length === 0) {
    throw new Error('Invalid hosted review branch update baseRef.')
  }
  if (
    !('expectedHeadSha' in value) ||
    typeof value.expectedHeadSha !== 'string' ||
    value.expectedHeadSha.length === 0
  ) {
    throw new Error('Invalid hosted review branch update expectedHeadSha.')
  }
  if (
    !('expectedBaseSha' in value) ||
    typeof value.expectedBaseSha !== 'string' ||
    value.expectedBaseSha.length === 0
  ) {
    throw new Error('Invalid hosted review branch update expectedBaseSha.')
  }
  if (!('mode' in value) || (value.mode !== 'merge-base-update' && value.mode !== 'rebase')) {
    throw new Error('Invalid hosted review branch update mode.')
  }
}

export function assertHostedReviewCommitPushInput(
  value: unknown
): asserts value is HostedReviewCommitPushInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid hosted review commit push request.')
  }
  if (
    !('worktreePath' in value) ||
    typeof value.worktreePath !== 'string' ||
    value.worktreePath.length === 0
  ) {
    throw new Error('Invalid hosted review commit push worktreePath.')
  }
  if (!('branch' in value) || typeof value.branch !== 'string' || value.branch.length === 0) {
    throw new Error('Invalid hosted review commit push branch.')
  }
  if (!('pushUrl' in value) || typeof value.pushUrl !== 'string' || value.pushUrl.length === 0) {
    throw new Error('Invalid hosted review commit push pushUrl.')
  }
  if (
    !('commitSha' in value) ||
    typeof value.commitSha !== 'string' ||
    value.commitSha.length === 0
  ) {
    throw new Error('Invalid hosted review commit push commitSha.')
  }
  if (
    !('expectedHeadSha' in value) ||
    typeof value.expectedHeadSha !== 'string' ||
    value.expectedHeadSha.length === 0
  ) {
    throw new Error('Invalid hosted review commit push expectedHeadSha.')
  }
  assertObjectId(value.commitSha, 'publication commit SHA')
  assertObjectId(value.expectedHeadSha, 'expected review head SHA')
}

export async function executeHostedReviewCommitPush(
  runGit: HostedReviewBranchUpdateGitRunner,
  input: HostedReviewCommitPushInput,
  onMutationDispatched?: () => void,
  assertLeaseHeld?: () => Promise<void>
): Promise<void> {
  assertHostedReviewCommitPushInput(input)
  await runGit(['check-ref-format', '--branch', input.branch])
  await runGit(['cat-file', '-e', `${input.commitSha}^{commit}`])
  await assertLeaseHeld?.()
  onMutationDispatched?.()
  const remoteRef = `refs/heads/${input.branch}`
  try {
    await runGit([
      'push',
      `--force-with-lease=${remoteRef}:${input.expectedHeadSha}`,
      input.pushUrl,
      `${input.commitSha}:${remoteRef}`
    ])
  } catch (error) {
    throw isConditionalPushRejection(error)
      ? new HostedReviewExpectedStateMismatchError(error)
      : error
  }
}

async function readRemoteBranchHead(
  runGit: HostedReviewBranchUpdateGitRunner,
  remote: string,
  branch: string
): Promise<string | null> {
  const remoteRef = `refs/heads/${branch}`
  const lines = (await runGit(['ls-remote', '--heads', remote, remoteRef])).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  const match = lines.find((line) => line.split(/\s+/)[1] === remoteRef)
  const oid = match?.split(/\s+/)[0]
  return oid && /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null
}

async function hasInProgressRef(
  runGit: HostedReviewBranchUpdateGitRunner,
  ref: 'MERGE_HEAD' | 'REBASE_HEAD'
): Promise<boolean> {
  try {
    return Boolean((await runGit(['rev-parse', '--verify', '--quiet', ref])).stdout.trim())
  } catch {
    return false
  }
}

async function abortIncompleteUpdate(
  runGit: HostedReviewBranchUpdateGitRunner,
  mode: HostedReviewBranchUpdateInput['mode'],
  assertLeaseHeld?: () => Promise<void>
): Promise<void> {
  await assertLeaseHeld?.()
  await runGit(mode === 'rebase' ? ['rebase', '--abort'] : ['merge', '--abort'])
}

async function runUpdateUnlocked(
  runGit: HostedReviewBranchUpdateGitRunner,
  cleanupRunGit: HostedReviewBranchUpdateGitRunner,
  capabilities: GitCapabilityCache,
  input: HostedReviewBranchUpdateInput,
  onMutationDispatched?: () => void,
  assertLeaseHeld?: () => Promise<void>
): Promise<HostedReviewBranchUpdateResult> {
  assertObjectId(input.expectedHeadSha, 'expected review head SHA')
  assertObjectId(input.expectedBaseSha, 'expected base SHA')
  await runGit(['check-ref-format', '--branch', input.branch])

  const branch = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
  if (branch !== input.branch) {
    throw new Error(`Expected review branch ${input.branch}, found ${branch || 'detached HEAD'}.`)
  }
  const headSha = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  if (headSha !== input.expectedHeadSha) {
    throw new HostedReviewExpectedStateMismatchError(
      new Error(`Review head changed from ${input.expectedHeadSha} to ${headSha || 'unknown'}.`)
    )
  }
  if (
    (await hasInProgressRef(runGit, 'MERGE_HEAD')) ||
    (await hasInProgressRef(runGit, 'REBASE_HEAD'))
  ) {
    throw new Error('The review worktree already has a merge or rebase in progress.')
  }
  const status = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=normal'])
  if (status.stdout.length > 0) {
    throw new Error('The review worktree has local changes.')
  }

  const pushRemote = input.pushRemote
  const remoteHead = await readRemoteBranchHead(runGit, pushRemote, input.branch)
  if (remoteHead !== input.expectedHeadSha) {
    throw new HostedReviewExpectedStateMismatchError(
      new Error(
        `Remote review head changed from ${input.expectedHeadSha} to ${remoteHead ?? 'unknown'}.`
      )
    )
  }

  const base = await resolveGitRemoteRebaseSource(runGit, input.baseRef)
  const fetchedBaseRef = `refs/quirky/hosted-review-sitter/${randomUUID()}`
  const fetchArgs = [
    base.remoteName,
    `+refs/heads/${base.branchName}:${fetchedBaseRef}`,
    `+refs/heads/${base.branchName}:refs/remotes/${base.displayName}`
  ]

  let result: HostedReviewBranchUpdateResult
  try {
    onMutationDispatched?.()
    await capabilities.runWithFallback(
      'fetch-no-write-fetch-head',
      async () => {
        await assertLeaseHeld?.()
        return runGit(['fetch', '--no-write-fetch-head', ...fetchArgs])
      },
      async () => {
        await assertLeaseHeld?.()
        return runGit(['fetch', ...fetchArgs])
      },
      isNoWriteFetchHeadUnsupportedError
    )
    const fetchedBaseSha = (await runGit(['rev-parse', '--verify', fetchedBaseRef])).stdout.trim()
    if (fetchedBaseSha !== input.expectedBaseSha) {
      throw new HostedReviewExpectedStateMismatchError(
        new Error(
          `Review base changed from ${input.expectedBaseSha} to ${fetchedBaseSha || 'unknown'}.`
        )
      )
    }

    await assertLeaseHeld?.()
    try {
      await runGit(
        input.mode === 'rebase'
          ? ['rebase', fetchedBaseRef]
          : ['merge', '--no-edit', fetchedBaseRef]
      )
    } catch (error) {
      rethrowLeaseLost(error)
      try {
        await abortIncompleteUpdate(cleanupRunGit, input.mode, assertLeaseHeld)
      } catch (cleanupError) {
        rethrowLeaseLost(cleanupError)
        throw new AggregateError(
          [error, cleanupError],
          'Hosted review branch update failed and Git cleanup also failed.'
        )
      }
      throw error
    }

    const resultingHeadSha = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const remoteRef = `refs/heads/${input.branch}`
    const forceLease = `--force-with-lease=${remoteRef}:${input.expectedHeadSha}`
    try {
      await assertLeaseHeld?.()
      await runGit(['push', forceLease, pushRemote, `${resultingHeadSha}:${remoteRef}`])
    } catch (pushError) {
      rethrowLeaseLost(pushError)
      if (isConditionalPushRejection(pushError)) {
        try {
          await assertLeaseHeld?.()
          await cleanupRunGit(['reset', '--hard', input.expectedHeadSha])
        } catch (cleanupError) {
          rethrowLeaseLost(cleanupError)
          throw new AggregateError(
            [pushError, cleanupError],
            'Hosted review branch update was rejected and the local rewind also failed.'
          )
        }
        throw new HostedReviewExpectedStateMismatchError(pushError)
      }
      // A transport error is resolved only by a fresh read of the owning remote.
      let remoteAfterPush: string | null
      try {
        remoteAfterPush = await readRemoteBranchHead(cleanupRunGit, pushRemote, input.branch)
      } catch (readError) {
        rethrowLeaseLost(readError)
        throw pushError
      }
      if (remoteAfterPush !== resultingHeadSha) {
        if (remoteAfterPush !== input.expectedHeadSha) {
          throw pushError
        }
        try {
          await assertLeaseHeld?.()
          await cleanupRunGit(['reset', '--hard', input.expectedHeadSha])
        } catch (cleanupError) {
          rethrowLeaseLost(cleanupError)
          throw new AggregateError(
            [pushError, cleanupError],
            'Hosted review branch update could not publish and the local rewind also failed.'
          )
        }
        throw new HostedReviewConfirmedNotLandedError(pushError)
      }
    }
    result = { resultingHeadSha }
  } catch (updateError) {
    try {
      await assertLeaseHeld?.()
      await cleanupRunGit(['update-ref', '-d', fetchedBaseRef])
    } catch (cleanupError) {
      rethrowLeaseLost(cleanupError)
      throw new AggregateError(
        [updateError, cleanupError],
        'Hosted review branch update failed and temporary ref cleanup also failed.'
      )
    }
    throw updateError
  }

  try {
    await assertLeaseHeld?.()
    await cleanupRunGit(['update-ref', '-d', fetchedBaseRef])
  } catch (cleanupError) {
    rethrowLeaseLost(cleanupError)
    process.emitWarning(cleanupError instanceof Error ? cleanupError : String(cleanupError), {
      code: 'HOSTED_REVIEW_TEMP_REF_CLEANUP_FAILED'
    })
  }
  return result
}

export function executeHostedReviewBranchUpdate(
  runGit: HostedReviewBranchUpdateGitRunner,
  capabilities: GitCapabilityCache,
  input: HostedReviewBranchUpdateInput,
  signal?: AbortSignal,
  cleanupRunGit: HostedReviewBranchUpdateGitRunner = runGit,
  onMutationDispatched?: () => void,
  assertLeaseHeld?: () => Promise<void>
): Promise<HostedReviewBranchUpdateResult> {
  return runWithGitWorktreeOperationLock(input.worktreePath, signal, () =>
    runUpdateUnlocked(
      runGit,
      cleanupRunGit,
      capabilities,
      input,
      onMutationDispatched,
      assertLeaseHeld
    )
  )
}
