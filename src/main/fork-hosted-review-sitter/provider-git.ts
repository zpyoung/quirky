import { z } from 'zod'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { Store } from '../persistence'
import {
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { GitCapabilityCache } from '../../shared/git-capability-cache'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import {
  executeHostedReviewBranchUpdate,
  executeHostedReviewCommitPush,
  type HostedReviewBranchUpdateInput,
  type HostedReviewBranchUpdateResult
} from '../../shared/fork-hosted-review-sitter/git-branch-update'
import {
  createHostedReviewSitterMutationTracker,
  tagHostedReviewPreDispatchError
} from './provider-action-effect'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from '../../shared/git-merge-tree-capability'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import {
  requireLocalRuntimeGitRoute,
  type RuntimeGitTarget
} from '../runtime/runtime-git-command-target'
import { runtimePathsEqual } from '../runtime/runtime-worktree-path-identity'
import { resolveWorktreeHostRouting } from '../runtime/worktree-launch-host-repo'
import { getLocalGitCapabilityCache } from '../git/git-capability-state'
import { gitExecFileAsync } from '../git/runner'
import { getStatus, bulkStageFiles, commitChanges } from '../git/status'
import { resolveHostedReviewSitterPushTarget } from './provider-push-target'

export type HostedReviewSitterExecutionContext = {
  executionHostId: ExecutionHostId
  connectionId: string | null
  localGitOptions: LocalProjectWorktreeGitOptions
}

export type HostedReviewSitterGitExecution = {
  exec(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }>
  getStatus(signal?: AbortSignal): Promise<GitStatusResult>
  worktreeIsClean(signal?: AbortSignal): Promise<boolean>
  stageFiles(paths: string[], signal?: AbortSignal): Promise<void>
  commit(message: string, signal?: AbortSignal): Promise<{ success: boolean; error?: string }>
  reviewPushTarget(signal?: AbortSignal): Promise<GitPushTarget | null>
  pushCommit(
    commitSha: string,
    expectedHeadSha: string,
    signal?: AbortSignal,
    assertLeaseHeld?: () => Promise<void>
  ): Promise<void>
  currentHeadSha(signal?: AbortSignal): Promise<string>
  remoteHeadSha(signal?: AbortSignal): Promise<string | null>
  commitParents(
    commitSha: string,
    signal?: AbortSignal,
    assertLeaseHeld?: () => Promise<void>
  ): Promise<string[] | null>
  remoteRefForBranch(
    branch: string,
    expectedSha: string,
    signal?: AbortSignal
  ): Promise<string | null>
  updateBranch(
    input: Omit<HostedReviewBranchUpdateInput, 'worktreePath' | 'pushRemote'>,
    signal?: AbortSignal,
    onMutationDispatched?: () => void,
    assertLeaseHeld?: () => Promise<void>
  ): Promise<HostedReviewBranchUpdateResult>
  simulateConflicts(
    headSha: string,
    baseSha: string,
    signal?: AbortSignal
  ): Promise<'none' | 'present' | 'unknown'>
} & HostedReviewSitterExecutionContext

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  if (signal.reason instanceof Error) {
    throw signal.reason
  }
  const error = new Error('Hosted review operation aborted.')
  error.name = 'AbortError'
  throw error
}

function parseRemoteHead(stdout: string, branch: string): string | null {
  const ref = `refs/heads/${branch}`
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().split(/\s+/)[1] === ref)
  const sha = line?.trim().split(/\s+/)[0]
  return sha && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
}

const GitErrorOutputSchema = z.object({
  stdout: z.string().optional().catch(undefined),
  stderr: z.string().optional().catch(undefined)
})

function getErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object') {
    return ''
  }
  const output = GitErrorOutputSchema.safeParse(error)
  return output.success ? (output.data[key] ?? '') : ''
}

async function loadConflicts(
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  capabilities: GitCapabilityCache,
  headSha: string,
  baseSha: string
): Promise<'none' | 'present'> {
  const mergeBase = (await runGit(['merge-base', headSha, baseSha])).stdout.trim()
  const modern = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    '--merge-base',
    mergeBase,
    headSha,
    baseSha
  ]
  const legacy = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    headSha,
    baseSha
  ]
  const execute = async (args: string[]): Promise<'none' | 'present'> => {
    try {
      const result = await runGit(args)
      return result.stdout.includes('\0') && result.stdout.split('\0').slice(1).some(Boolean)
        ? 'present'
        : 'none'
    } catch (error) {
      if (isUnsupportedMergeTreeWriteTreeError(error)) {
        throw error
      }
      const stdout = getErrorOutput(error, 'stdout')
      if (!stdout) {
        throw error
      }
      return stdout.includes('\0') && stdout.split('\0').slice(1).some(Boolean) ? 'present' : 'none'
    }
  }
  return capabilities.runWithFallback(
    'merge-tree-write-tree',
    () =>
      capabilities.runWithFallback(
        'merge-tree-merge-base',
        () => execute(modern),
        () => execute(legacy),
        isUnsupportedMergeTreeMergeBaseError
      ),
    async () => {
      throw new Error('Git merge-tree --write-tree is unavailable on this execution host.')
    },
    isUnsupportedMergeTreeWriteTreeError
  )
}

export async function resolveHostedReviewSitterGitExecution(
  runtime: QuirkyRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition
): Promise<HostedReviewSitterGitExecution> {
  const candidateRepo = store.getRepo(definition.repoId)
  if (!candidateRepo) {
    throw new Error(`Hosted review sitter repository ${definition.repoId} is not registered.`)
  }
  const worktree = await runtime.showManagedWorktree(`id:${definition.worktreeId}`)
  const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
  if (routing.kind !== 'resolved' || !routing.repo) {
    throw new Error('Hosted review sitter Git execution host is not authoritatively resolved.')
  }
  const executionHostId = routing.hostId
  const repo = routing.repo
  if (
    worktree.id !== definition.worktreeId ||
    worktree.repoId !== definition.repoId ||
    !runtimePathsEqual(worktree.git.path, definition.repoPath) ||
    repo.id !== definition.repoId
  ) {
    throw new Error('Hosted review sitter Git target does not match its authorized enrollment.')
  }
  const localGitOptions =
    executionHostId === LOCAL_EXECUTION_HOST_ID
      ? getLocalProjectWorktreeGitOptions(store, repo)
      : {}
  const target: RuntimeGitTarget = { worktree, repo, executionHostId, localGitOptions }
  requireLocalRuntimeGitRoute(target)
  const connectionId = getSshTargetIdForExecutionHost(executionHostId)
  const exec = async (
    args: string[],
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> => {
    throwIfAborted(signal)
    return gitExecFileAsync(args, {
      cwd: definition.repoPath,
      ...localGitOptions,
      ...(signal ? { signal } : {})
    })
  }
  const getHostedStatus = async (signal?: AbortSignal): Promise<GitStatusResult> => {
    throwIfAborted(signal)
    return getStatus(definition.repoPath, {
      ...localGitOptions,
      sharedLinkPaths: repo.symlinkPaths,
      ...(signal ? { signal } : {})
    })
  }
  const reviewPushTarget = (signal?: AbortSignal): Promise<GitPushTarget | null> =>
    resolveHostedReviewSitterPushTarget(definition, { connectionId, localGitOptions, exec }, signal)

  return {
    executionHostId,
    connectionId,
    localGitOptions,
    exec,
    getStatus: getHostedStatus,
    worktreeIsClean: async (signal) => {
      const status = await getHostedStatus(signal)
      return !status.didHitLimit && status.entries.length === 0
    },
    stageFiles: async (paths, signal) => {
      throwIfAborted(signal)
      return bulkStageFiles(definition.repoPath, paths, { ...localGitOptions, signal })
    },
    commit: async (message, signal) => {
      throwIfAborted(signal)
      return commitChanges(definition.repoPath, message, { ...localGitOptions, signal })
    },
    reviewPushTarget,
    pushCommit: async (commitSha, expectedHeadSha, signal, assertLeaseHeld) => {
      const tracker = createHostedReviewSitterMutationTracker()
      try {
        throwIfAborted(signal)
        const pushTarget = await reviewPushTarget(signal)
        if (!pushTarget?.remoteUrl) {
          throw new Error('The hosted review source repository push target is unverifiable.')
        }
        throwIfAborted(signal)
        const input = {
          worktreePath: definition.repoPath,
          branch: pushTarget.branchName,
          pushUrl: pushTarget.remoteUrl,
          commitSha,
          expectedHeadSha
        }
        await assertLeaseHeld?.()
        await executeHostedReviewCommitPush(
          (args) => exec(args, signal),
          input,
          () => tracker.markDispatched(),
          assertLeaseHeld
        )
      } catch (error) {
        if (!tracker.dispatched) {
          throw tagHostedReviewPreDispatchError(error)
        }
        throw error
      }
    },
    currentHeadSha: async (signal) =>
      (await exec(['rev-parse', '--verify', 'HEAD'], signal)).stdout.trim(),
    remoteHeadSha: async (signal) => {
      const pushTarget = await reviewPushTarget(signal)
      if (!pushTarget) {
        return null
      }
      if (!pushTarget.remoteUrl) {
        return null
      }
      const result = await exec(
        ['ls-remote', '--heads', pushTarget.remoteUrl, `refs/heads/${pushTarget.branchName}`],
        signal
      )
      return parseRemoteHead(result.stdout, pushTarget.branchName)
    },
    commitParents: async (commitSha, signal, assertLeaseHeld) => {
      const readParents = async (): Promise<string[] | null> => {
        const [commit, ...parents] = (
          await exec(['rev-list', '--parents', '-n', '1', commitSha], signal)
        ).stdout
          .trim()
          .split(/\s+/)
        return commit === commitSha ? parents : null
      }
      try {
        return await readParents()
      } catch {
        const pushTarget = await reviewPushTarget(signal)
        await assertLeaseHeld?.()
        if (!pushTarget?.remoteUrl) {
          return null
        }
        await exec(
          [
            'fetch',
            '--quiet',
            '--no-tags',
            '--',
            pushTarget.remoteUrl,
            `refs/heads/${pushTarget.branchName}`
          ],
          signal
        )
        return readParents()
      }
    },
    remoteRefForBranch: async (branch, expectedSha, signal) => {
      await exec(['check-ref-format', '--branch', branch], signal)
      const remotes = (await exec(['remote'], signal)).stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
      for (const remote of remotes) {
        const result = await exec(['ls-remote', '--heads', remote, `refs/heads/${branch}`], signal)
        if (parseRemoteHead(result.stdout, branch) === expectedSha) {
          return `${remote}/${branch}`
        }
      }
      return null
    },
    updateBranch: async (input, signal, onMutationDispatched, assertLeaseHeld) => {
      throwIfAborted(signal)
      const pushTarget = await reviewPushTarget(signal)
      if (!pushTarget?.remoteUrl || pushTarget.branchName !== input.branch) {
        throw new Error('The hosted review source repository push target is unverifiable.')
      }
      const completeInput = {
        ...input,
        worktreePath: definition.repoPath,
        pushRemote: pushTarget.remoteUrl
      }
      const capabilities = getLocalGitCapabilityCache({
        cwd: definition.repoPath,
        wslDistro: localGitOptions.wslDistro
      })
      await assertLeaseHeld?.()
      return executeHostedReviewBranchUpdate(
        (args) => exec(args, signal),
        capabilities,
        completeInput,
        signal,
        (args) =>
          gitExecFileAsync(args, {
            cwd: definition.repoPath,
            ...localGitOptions,
            timeout: 30_000
          }),
        onMutationDispatched,
        assertLeaseHeld
      )
    },
    simulateConflicts: async (headSha, baseSha, signal) => {
      throwIfAborted(signal)
      const capabilities = getLocalGitCapabilityCache({
        cwd: definition.repoPath,
        wslDistro: localGitOptions.wslDistro
      })
      return loadConflicts((args) => exec(args, signal), capabilities, headSha, baseSha).catch(
        () => 'unknown'
      )
    }
  }
}
