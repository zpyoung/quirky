import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import {
  requireLocalRuntimeFileRoute,
  type ResolvedRuntimeFileTarget
} from '../runtime/files/file-target'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { composeWorktreeId } from '../../shared/worktree/id'

type ObjectiveRuntimeResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

function assertResolvedAuthority(
  enrollment: WatcherEnrollment,
  target: { executionHostId: string; worktree: { path: string; repoId: string } }
): void {
  if (
    target.executionHostId !== enrollment.executionHostId ||
    target.worktree.path !== enrollment.workspacePath ||
    target.worktree.repoId !== enrollment.repoId
  ) {
    throw new Error('Resolved objective workspace authority changed after enrollment')
  }
}

/** Resolves the workspace on its execution host; an unreachable/remote-runtime target fails closed. */
export async function resolveObjectiveWorkspaceTarget(
  runtime: QuirkyRuntimeService,
  enrollment: WatcherEnrollment
): Promise<ObjectiveWorkspaceTarget> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeGitTarget/resolveRuntimeFileTarget are installed on QuirkyRuntimeService's prototype at construction but aren't part of its exported command-surface type, which only lists IPC-facing methods.
  const resolver = runtime as unknown as ObjectiveRuntimeResolver
  const folderWorktreeId =
    enrollment.worktreeId && parseWorkspaceKey(enrollment.worktreeId)?.type === 'folder'
      ? enrollment.worktreeId
      : null
  if (enrollment.worktreeId === null || folderWorktreeId) {
    const selector =
      folderWorktreeId ?? composeWorktreeId(enrollment.repoId, enrollment.workspacePath)
    const target = await resolver.resolveRuntimeFileTarget(`id:${selector}`)
    assertResolvedAuthority(enrollment, target)
    if (folderWorktreeId && target.worktree.id !== folderWorktreeId) {
      throw new Error('Resolved objective folder workspace identity changed after enrollment')
    }
    requireLocalRuntimeFileRoute(target)
    return {
      kind: 'folder',
      executionHostId: enrollment.executionHostId,
      workspacePath: enrollment.workspacePath
    }
  }

  const target = await resolver.resolveRuntimeGitTarget(`id:${enrollment.worktreeId}`)
  assertResolvedAuthority(enrollment, target)
  if (target.worktree.id !== enrollment.worktreeId) {
    throw new Error('Resolved objective Git worktree identity changed after enrollment')
  }
  requireLocalRuntimeFileRoute(target)
  return {
    kind: 'git',
    executionHostId: enrollment.executionHostId,
    workspacePath: enrollment.workspacePath,
    gitTarget: target
  }
}
