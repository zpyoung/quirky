import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getSelectedNestedRepoPathsInScanOrder } from '@/lib/nested-repo-selected-paths'
import {
  canSubmitNestedRepoImport,
  type NestedRepoRuntimeKind
} from '../../../../shared/nested-repo-attempt'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/add-repo-source'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import type { WorktreeFetchOptions } from '@/store/slices/worktree-helpers'
import { translate } from '@/i18n/i18n'
import { worktreeRefreshOptions } from './add-repo-runtime-owner'
import { completeNestedFolderOpen } from './complete-nested-folder-open'
import { defaultProjectGroupNameForPath } from './add-repo-dialog-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function useAddRepoNestedImportFlow({
  nestedAttemptId,
  nestedScan,
  nestedSelectedPaths,
  nestedRuntimeKind,
  nestedConnectionId,
  nestedGroupName,
  nestedImportScanId,
  nestedRuntimeEnvironmentId,
  activeRuntimeEnvironmentId,
  closeModal,
  fetchWorktrees,
  importNestedRepos,
  getNestedRepoRuntimeKind,
  onGitRepoReady,
  setIsAdding
}: {
  nestedAttemptId: string | null
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedRuntimeKind: NestedRepoRuntimeKind | null
  nestedConnectionId: string | null
  nestedGroupName: string
  nestedImportScanId: string | null
  nestedRuntimeEnvironmentId: string | null
  activeRuntimeEnvironmentId: string | null | undefined
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    runtimeEnvironmentId: string | null
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  getNestedRepoRuntimeKind: (connectionId: string | null) => NestedRepoRuntimeKind
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
}): {
  handleImportNestedRepos: (mode: 'group' | 'separate') => Promise<void>
  handleOpenNestedRootFolder: () => Promise<void>
  resetNestedImportFlow: () => void
} {
  const nestedImportGenRef = useRef(0)
  const resetNestedImportFlow = useCallback((): void => {
    nestedImportGenRef.current++
  }, [])

  const handleImportNestedRepos = useCallback(
    async (mode: 'group' | 'separate'): Promise<void> => {
      const attemptId = nestedAttemptId
      if (
        !nestedScan ||
        !attemptId ||
        !canSubmitNestedRepoImport({
          attemptId,
          selectedCount: nestedSelectedPaths.size
        })
      ) {
        return
      }
      const selectedProjectPaths = getSelectedNestedRepoPathsInScanOrder(
        nestedScan,
        nestedSelectedPaths
      )
      const gen = ++nestedImportGenRef.current
      setIsAdding(true)
      try {
        const result = await importNestedRepos({
          parentPath: nestedScan.selectedPath,
          groupName: nestedGroupName,
          projectPaths: selectedProjectPaths,
          ...(nestedConnectionId ? { connectionId: nestedConnectionId } : {}),
          ...(nestedImportScanId ? { scanId: nestedImportScanId } : {}),
          runtimeEnvironmentId: nestedRuntimeEnvironmentId,
          mode
        })
        if (!result) {
          return
        }
        const importedRepoIds = result.projects
          .map((entry) => entry.projectId)
          .filter((projectId): projectId is string => typeof projectId === 'string')
        const firstRepoId = importedRepoIds[0]
        if (!firstRepoId) {
          const firstFailure = result.projects.find((entry) => entry.status === 'failed')?.error
          if (gen === nestedImportGenRef.current) {
            toast.error(
              translate(
                'auto.components.sidebar.useAddRepoNestedImportFlow.1b33c5f090',
                'No repositories imported'
              ),
              {
                description: firstFailure ?? undefined
              }
            )
          }
          return
        }
        const completionOwner = nestedConnectionId === null ? nestedRuntimeEnvironmentId : undefined
        const completionOwnerOptions = worktreeRefreshOptions(completionOwner, nestedConnectionId)
        for (const projectId of importedRepoIds) {
          await fetchWorktrees(projectId, completionOwnerOptions)
        }
        if (gen !== nestedImportGenRef.current) {
          return
        }
        if (result.failedCount > 0) {
          toast.warning(
            translate(
              'auto.components.sidebar.useAddRepoNestedImportFlow.cbfbc7a797',
              'Some repositories could not be imported'
            ),
            {
              description: translate(
                'auto.components.sidebar.useAddRepoNestedImportFlow.680cac2c82',
                '{{value0}} failed',
                { value0: result.failedCount }
              )
            }
          )
        }
        const repo = useAppStore.getState().repos.find((entry) => entry.id === firstRepoId)
        if (repo) {
          const source: AddRepoExistingWorkspaceSource = nestedConnectionId
            ? 'ssh_remote_path'
            : activeRuntimeEnvironmentId?.trim()
              ? 'runtime_server_path'
              : 'local_folder_picker'
          await onGitRepoReady(repo.id, source, completionOwnerOptions.executionHostId)
        }
      } catch (err) {
        if (gen === nestedImportGenRef.current) {
          toast.error(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (gen === nestedImportGenRef.current) {
          setIsAdding(false)
        }
      }
    },
    [
      activeRuntimeEnvironmentId,
      fetchWorktrees,
      importNestedRepos,
      nestedAttemptId,
      nestedConnectionId,
      nestedGroupName,
      nestedImportScanId,
      nestedRuntimeEnvironmentId,
      nestedRuntimeKind,
      nestedScan,
      nestedSelectedPaths,
      getNestedRepoRuntimeKind,
      onGitRepoReady,
      setIsAdding
    ]
  )
  const handleOpenNestedRootFolder = useCallback(() => {
    if (!nestedScan) {
      return Promise.resolve()
    }
    const generation = ++nestedImportGenRef.current
    // Why: only an edited name overrides host naming, so an untouched prefill still lets the host
    // pick (e.g. the SSH target label for `~`).
    const enteredName = nestedGroupName.trim()
    const displayName =
      enteredName && enteredName !== defaultProjectGroupNameForPath(nestedScan.selectedPath)
        ? enteredName
        : undefined
    return completeNestedFolderOpen({
      scan: nestedScan,
      generation,
      currentGeneration: () => nestedImportGenRef.current,
      connectionId: nestedConnectionId,
      owner: nestedRuntimeEnvironmentId,
      ...(displayName ? { displayName } : {}),
      closeModal,
      setIsAdding
    })
  }, [
    closeModal,
    getNestedRepoRuntimeKind,
    nestedAttemptId,
    nestedConnectionId,
    nestedGroupName,
    nestedRuntimeKind,
    nestedRuntimeEnvironmentId,
    nestedScan,
    nestedSelectedPaths.size,
    setIsAdding
  ])
  return {
    handleImportNestedRepos,
    handleOpenNestedRootFolder,
    resetNestedImportFlow
  }
}
