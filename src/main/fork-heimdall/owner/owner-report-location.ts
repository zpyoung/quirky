import type { ExecutionHostId } from '../../../shared/execution-host'
import { requireLocalRuntimeGitRoute } from '../../runtime/runtime-git-command-target'
import { resolveGitDir } from '../../git/source-control/resolve-git-dir'
import { resolveLeasePathFlavor } from '../lease-host-filesystem'
import type { LeaseWorkspaceTarget } from '../lease-store'

export type OwnerReportLocation = {
  executionHostId: ExecutionHostId
  /** The path a report must resolve inside, canonicalized before every read. */
  authorityRoot: string
  directory: string
}

/**
 * Resolves where a watcher's owner writes its intervention reports. Mirrors the lease store's own
 * folder/git split so owner reports land beside the lease directory rather than in the tracked
 * working tree — a git workspace's reports go under the git directory, out of `git status`, for
 * the same reason objective's worker reports do.
 */
export async function resolveOwnerReportLocation(
  target: LeaseWorkspaceTarget
): Promise<OwnerReportLocation> {
  if (target.kind === 'folder') {
    const pathFlavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
    return {
      executionHostId: target.executionHostId,
      authorityRoot: target.workspacePath,
      directory: pathFlavor.join(target.workspacePath, '.quirky', 'heimdall', 'owner-reports')
    }
  }
  if (!target.gitTarget) {
    throw new Error('Git owner report target has no runtime Git target')
  }
  requireLocalRuntimeGitRoute(target.gitTarget)
  const gitDirectory = await resolveGitDir(target.workspacePath, target.gitTarget.localGitOptions)
  if (!gitDirectory) {
    throw new Error('Git did not return an absolute git directory for the owner report location')
  }
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, gitDirectory)
  return {
    executionHostId: target.executionHostId,
    authorityRoot: gitDirectory,
    directory: pathFlavor.join(gitDirectory, 'quirky-heimdall', 'owner-reports')
  }
}
