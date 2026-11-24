import * as electron from 'electron'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { WorkspaceKey, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  requireLocalRuntimeFileRoute,
  type ResolvedRuntimeFileTarget
} from '../runtime/files/file-target'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { runtimePathsEqual } from '../runtime/runtime-worktree-path-identity'
import { LeaseWorkspaceRemovedError } from './lease-workspace-absence'
import {
  isServerReportedWorkspaceAbsence,
  isWorkspaceAbsenceCandidate
} from './orchestration/placement-absence'
import { LeaseConfigurationError, type LeaseWorkspaceTarget } from './lease-store'
import { composeWorktreeId } from '../../shared/worktree/id'

type RuntimeGitTargetResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
}

type RuntimeFileTargetResolver = {
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

type PowerMonitorLike = {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  off?(event: 'suspend' | 'resume', listener: () => void): unknown
  removeListener?(event: 'suspend' | 'resume', listener: () => void): unknown
}

function isRuntimeGitTargetResolver(value: unknown): value is RuntimeGitTargetResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    'resolveRuntimeGitTarget' in value &&
    typeof value.resolveRuntimeGitTarget === 'function'
  )
}

function isRuntimeFileTargetResolver(value: unknown): value is RuntimeFileTargetResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    'resolveRuntimeFileTarget' in value &&
    typeof value.resolveRuntimeFileTarget === 'function'
  )
}

function isPowerMonitorLike(value: unknown): value is PowerMonitorLike {
  return (
    typeof value === 'object' && value !== null && 'on' in value && typeof value.on === 'function'
  )
}

/** Keeps Electron power and execution-host routing outside the pure kernel loop. */
export class HeimdallKernelHost {
  private powerMonitor: PowerMonitorLike | null = null

  constructor(
    private readonly runtime: QuirkyRuntimeService,
    private readonly findEnrollment: (key: WorkspaceKey) => WatcherEnrollment | null,
    private readonly onSuspend: () => void,
    private readonly onResume: () => void
  ) {}

  async resolveLeaseTarget(key: WorkspaceKey): Promise<LeaseWorkspaceTarget> {
    const enrollment = this.findEnrollment(key)
    if (!enrollment) {
      throw new LeaseConfigurationError(`Lease workspace is no longer enrolled: ${key}`)
    }
    try {
      return await this.resolveEnrolledTarget(enrollment)
    } catch (error) {
      if (
        isWorkspaceAbsenceCandidate(error) &&
        (isServerReportedWorkspaceAbsence(error) ||
          (await this.confirmWorkspaceRemoved(enrollment)))
      ) {
        throw new LeaseWorkspaceRemovedError('workspace-removed')
      }
      throw error
    }
  }

  private async resolveEnrolledTarget(
    enrollment: WatcherEnrollment
  ): Promise<LeaseWorkspaceTarget> {
    const folderWorktreeId =
      enrollment.worktreeId && parseWorkspaceKey(enrollment.worktreeId)?.type === 'folder'
        ? enrollment.worktreeId
        : null
    if (enrollment.worktreeId === null || folderWorktreeId) {
      return this.resolveFolderTarget(enrollment)
    }

    const runtime: unknown = this.runtime
    if (!isRuntimeGitTargetResolver(runtime)) {
      throw new LeaseConfigurationError('Runtime cannot resolve a Heimdall Git target')
    }
    const gitTarget = await runtime.resolveRuntimeGitTarget(enrollment.worktreeId)
    if (
      gitTarget.worktree.id !== enrollment.worktreeId ||
      gitTarget.worktree.path !== enrollment.workspacePath ||
      gitTarget.executionHostId !== enrollment.executionHostId
    ) {
      throw new LeaseConfigurationError('Resolved Git authority changed after Heimdall enrollment')
    }
    requireLocalRuntimeFileRoute(gitTarget)
    return {
      kind: 'git',
      executionHostId: enrollment.executionHostId,
      workspacePath: enrollment.workspacePath,
      watcherId: enrollment.watcherId,
      gitTarget
    }
  }

  private async confirmWorkspaceRemoved(enrollment: WatcherEnrollment): Promise<boolean> {
    const worktreeId =
      enrollment.worktreeId ?? composeWorktreeId(enrollment.repoId, enrollment.workspacePath)
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      return (
        enrollment.executionHostId === LOCAL_EXECUTION_HOST_ID &&
        !this.runtime
          .listFolderWorkspaces()
          .some((workspace) => workspace.id === scope.folderWorkspaceId)
      )
    }
    const repos = this.runtime
      .listRepos()
      .filter(
        (repo) =>
          repo.id === enrollment.repoId &&
          getRepoExecutionHostId(repo) === enrollment.executionHostId
      )
    if (repos.length === 0) {
      return enrollment.executionHostId === LOCAL_EXECUTION_HOST_ID
    }
    if (repos.length !== 1) {
      return false
    }
    const repo = repos[0]
    const folderRepo = isFolderRepo(repo)
    if (enrollment.executionHostId !== LOCAL_EXECUTION_HOST_ID && folderRepo) {
      return false
    }
    const detected = await this.runtime.listDetectedManagedWorktrees(
      `id:${repo.id}`,
      getRepoSshConnectionId(repo) ?? undefined
    )
    return (
      detected.authoritative &&
      !detected.worktrees.some(
        (worktree) =>
          worktree.id === worktreeId ||
          (!folderRepo && runtimePathsEqual(worktree.path, enrollment.workspacePath))
      )
    )
  }

  attachPowerMonitor(): void {
    if (!('powerMonitor' in electron)) {
      return
    }
    const monitor: unknown = electron.powerMonitor
    if (!isPowerMonitorLike(monitor)) {
      return
    }
    this.powerMonitor = monitor
    this.powerMonitor.on('suspend', this.onSuspend)
    this.powerMonitor.on('resume', this.onResume)
  }

  detachPowerMonitor(): void {
    const monitor = this.powerMonitor
    if (!monitor) {
      return
    }
    if (typeof monitor.off === 'function') {
      monitor.off('suspend', this.onSuspend)
      monitor.off('resume', this.onResume)
    } else if (typeof monitor.removeListener === 'function') {
      monitor.removeListener('suspend', this.onSuspend)
      monitor.removeListener('resume', this.onResume)
    }
    this.powerMonitor = null
  }

  private async resolveFolderTarget(enrollment: WatcherEnrollment): Promise<LeaseWorkspaceTarget> {
    const runtime: unknown = this.runtime
    if (!isRuntimeFileTargetResolver(runtime)) {
      throw new LeaseConfigurationError('Runtime cannot resolve a Heimdall folder target')
    }
    const worktreeId =
      enrollment.worktreeId ?? composeWorktreeId(enrollment.repoId, enrollment.workspacePath)
    const fileTarget = await runtime.resolveRuntimeFileTarget(`id:${worktreeId}`)
    if (
      fileTarget.worktree.id !== worktreeId ||
      fileTarget.worktree.repoId !== enrollment.repoId ||
      fileTarget.executionHostId !== enrollment.executionHostId ||
      fileTarget.worktree.path !== enrollment.workspacePath
    ) {
      throw new LeaseConfigurationError(
        'Resolved folder authority changed after Heimdall enrollment'
      )
    }
    requireLocalRuntimeFileRoute(fileTarget)
    return {
      kind: 'folder',
      executionHostId: enrollment.executionHostId,
      workspacePath: enrollment.workspacePath,
      watcherId: enrollment.watcherId
    }
  }
}
