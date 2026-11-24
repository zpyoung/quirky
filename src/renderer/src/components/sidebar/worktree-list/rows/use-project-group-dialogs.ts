import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectProjectGroupRemovalTargets } from '@/store/slices/project-group-removal-targets'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { LedgerRemovalPreview } from '../../../../../../shared/ledger'
import { requestLedger } from '@/runtime/runtime-ledger-client'
import { isLedgerRemovalConflict } from '@/store/repos/ledger-removal-conflict'

export type ProjectGroupNameDialogState =
  | { type: 'create-from-repo'; repo: Repo }
  // hostId is the group row's owner host, so the mutation is not routed to whichever host has focus.
  | { type: 'rename'; groupId: string; currentName: string; hostId?: ExecutionHostId }

export type ProjectGroupDeleteDialogState = {
  groupId: string
  groupName: string
  removeContainedProjects: boolean
  hostId?: ExecutionHostId
  ledgerPreview: LedgerRemovalPreview[]
  ledgerPreviewLoading: boolean
  ledgerPreviewError: string | null
}

export type ProjectGroupDialogs = ReturnType<typeof useProjectGroupDialogs>

function reportProjectGroupDeleteFailures(result: {
  status: string
  failedProjectRemovals: readonly unknown[]
  requestedProjectIds: readonly unknown[]
}): void {
  // Why: a missing group is already the desired end state, so only a real delete failure warrants a toast.
  if (result.status === 'group-delete-failed') {
    toast.error(
      translate('auto.components.sidebar.WorktreeList.groupDeleteFailed', 'Failed to delete group'),
      {
        description: translate(
          'auto.components.sidebar.WorktreeList.groupDeleteFailedDesc',
          'Something went wrong while deleting the group. No projects were removed.'
        )
      }
    )
    return
  }
  if (result.status === 'deleted-group' && result.failedProjectRemovals.length > 0) {
    const requestedCount = result.requestedProjectIds.length
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeList.b667b59632',
        'Some projects could not be removed from Quirky'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeList.f94466bc39',
          '{{value0}} of {{value1}} contained project{{value2}} remained after deleting the group.',
          {
            value0: result.failedProjectRemovals.length,
            value1: requestedCount,
            value2: requestedCount === 1 ? '' : 's'
          }
        )
      }
    )
  }
}

// Create/rename/delete flows for project groups, including the contained-project fan-out.
export function useProjectGroupDialogs(args: {
  repos: readonly Repo[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
}) {
  const { repos, repoMap, projectGroups } = args
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const [nameDialog, setNameDialog] = useState<ProjectGroupNameDialogState | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<ProjectGroupDeleteDialogState | null>(null)
  const [ledgerPreviewGeneration, setLedgerPreviewGeneration] = useState(0)

  const handleCreateGroupFromRepo = useCallback((repo: Repo) => {
    setNameDialog({ type: 'create-from-repo', repo })
  }, [])

  const handleMoveProjectToGroup = useCallback(
    (repo: Repo, groupId: string) => {
      if (repo.projectGroupId === groupId) {
        return
      }
      void moveProjectToGroup(repo, groupId)
    },
    [moveProjectToGroup]
  )

  const handleRemoveProjectFromGroup = useCallback(
    (repo: Repo) => {
      void moveProjectToGroup(repo, null)
    },
    [moveProjectToGroup]
  )

  const handleRenameProjectGroup = useCallback(
    (groupId: string, currentName: string, hostId?: ExecutionHostId) => {
      setNameDialog({ type: 'rename', groupId, currentName, hostId })
    },
    []
  )

  const handleSubmitProjectGroupName = useCallback(
    async (name: string) => {
      if (!nameDialog) {
        return
      }
      if (nameDialog.type === 'create-from-repo') {
        const group = await createProjectGroup(name, getRepoExecutionHostId(nameDialog.repo))
        if (group) {
          await moveProjectToGroup(nameDialog.repo, group.id)
        }
        return
      }
      const renamed = await updateProjectGroup(
        nameDialog.groupId,
        { name },
        { hostId: nameDialog.hostId }
      )
      if (!renamed) {
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.groupRenameFailed',
            'Failed to rename group'
          ),
          {
            description: translate(
              'auto.components.sidebar.WorktreeList.groupRenameFailedDesc',
              // Why: a falsy result also covers RPC timeout/disconnect, so the copy must not assert the host refused.
              "Quirky could not confirm the new name with the group's host. Recheck the group after reconnecting."
            )
          }
        )
      }
    },
    [createProjectGroup, moveProjectToGroup, nameDialog, updateProjectGroup]
  )

  const deleteTargets = useMemo(() => {
    if (!deleteDialog) {
      return null
    }
    return selectProjectGroupRemovalTargets(
      projectGroups,
      repos,
      deleteDialog.groupId,
      deleteDialog.hostId
    )
  }, [deleteDialog, projectGroups, repos])
  const deleteProjectCount = deleteTargets?.projectIds.length ?? 0
  const deleteProjectNames = useMemo(
    () =>
      (deleteTargets?.projectIds ?? []).map(
        (projectId) => repoMap.get(projectId)?.displayName ?? projectId
      ),
    [deleteTargets, repoMap]
  )
  const removeContainedProjects =
    deleteProjectCount > 0 && deleteDialog?.removeContainedProjects === true

  const handleDeleteProjectGroup = useCallback(
    (groupId: string, groupName: string, hostId?: ExecutionHostId) => {
      setDeleteDialog({
        groupId,
        groupName,
        removeContainedProjects: false,
        hostId,
        ledgerPreview: [],
        ledgerPreviewLoading: true,
        ledgerPreviewError: null
      })
    },
    []
  )

  const ledgerPreviewGroupId = deleteDialog?.groupId
  const ledgerPreviewHostId = deleteDialog?.hostId
  const ledgerPreviewRemoveProjects = deleteDialog?.removeContainedProjects
  useEffect(() => {
    if (!ledgerPreviewGroupId) {
      return
    }
    let cancelled = false
    const parsedHost = ledgerPreviewHostId ? parseExecutionHostId(ledgerPreviewHostId) : null
    setDeleteDialog((current) =>
      current ? { ...current, ledgerPreviewLoading: true, ledgerPreviewError: null } : current
    )
    void requestLedger(
      {
        operation: 'removal-preview',
        removal: {
          projectGroupId: ledgerPreviewGroupId,
          removeContainedProjects: ledgerPreviewRemoveProjects
        }
      },
      parsedHost?.kind === 'runtime' ? parsedHost.environmentId : undefined
    )
      .then((response) => {
        if (cancelled) {
          return
        }
        setDeleteDialog((current) =>
          current
            ? {
                ...current,
                ledgerPreview: response.removalPreview ?? [],
                ledgerPreviewLoading: false,
                ledgerPreviewError: null
              }
            : current
        )
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setDeleteDialog((current) =>
          current
            ? {
                ...current,
                ledgerPreviewLoading: false,
                ledgerPreviewError:
                  error instanceof Error ? error.message : 'Ledger preview unavailable'
              }
            : current
        )
      })
    return () => {
      cancelled = true
    }
  }, [
    ledgerPreviewGeneration,
    ledgerPreviewGroupId,
    ledgerPreviewHostId,
    ledgerPreviewRemoveProjects
  ])

  const handleConfirmDeleteProjectGroup = useCallback(async () => {
    if (!deleteDialog) {
      return
    }
    try {
      reportProjectGroupDeleteFailures(
        await deleteProjectGroupWithContainedProjects(deleteDialog.groupId, {
          removeContainedProjects,
          hostId: deleteDialog.hostId,
          // Why: the guard asserts the preview the user saw, so a preview that never loaded has
          // nothing to assert and must not be sent as an empty expectation.
          ...(deleteDialog.ledgerPreviewLoading || deleteDialog.ledgerPreviewError
            ? {}
            : {
                expectedLedgers: deleteDialog.ledgerPreview.map(({ ledgerId, revision }) => ({
                  ledgerId,
                  revision
                }))
              })
        })
      )
    } catch (error) {
      if (isLedgerRemovalConflict(error)) {
        setDeleteDialog((current) =>
          current
            ? {
                ...current,
                ledgerPreview: [],
                ledgerPreviewLoading: true,
                ledgerPreviewError: null
              }
            : current
        )
        setLedgerPreviewGeneration((generation) => generation + 1)
      } else {
        setDeleteDialog(null)
      }
      // Why: the dialog closes itself when onConfirm resolves, so a conflict must reach it as a
      // rejection or the retry preview it just refreshed is thrown away unseen.
      throw error
    }
    // Why: deleting contained projects can unmount this dialog before its close handler runs, so the parent owns cleanup.
    setDeleteDialog(null)
  }, [deleteProjectGroupWithContainedProjects, removeContainedProjects, deleteDialog])

  return {
    nameDialog,
    setNameDialog,
    deleteDialog,
    setDeleteDialog,
    deleteProjectCount,
    deleteProjectNames,
    removeContainedProjects,
    handleCreateGroupFromRepo,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRenameProjectGroup,
    handleSubmitProjectGroupName,
    handleDeleteProjectGroup,
    handleConfirmDeleteProjectGroup
  }
}
