import type { AppState } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export function getWorkspacePath(state: AppState, worktreeId: string): string | null {
  const parsed = parseWorkspaceKey(worktreeId)
  return parsed?.type === 'folder'
    ? (state.folderWorkspaces.find((workspace) => workspace.id === parsed.folderWorkspaceId)
        ?.folderPath ?? null)
    : (getWorktreeMapFromState(state).get(worktreeId)?.path ?? null)
}

export function buildPaneIdentityEnv(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string
): Record<string, string> {
  const parsed = parseWorkspaceKey(worktreeId)
  const folderWorkspace =
    parsed?.type === 'folder'
      ? state.folderWorkspaces.find((workspace) => workspace.id === parsed.folderWorkspaceId)
      : null
  return {
    QUIRKY_WORKSPACE_ID: worktreeId,
    ...(folderWorkspace
      ? {
          QUIRKY_PROJECT_GROUP_ID: folderWorkspace.projectGroupId,
          QUIRKY_WORKSPACE_ROOT: folderWorkspace.folderPath
        }
      : {}),
    QUIRKY_PANE_KEY: makePaneKey(tabId, leafId),
    QUIRKY_TAB_ID: tabId,
    QUIRKY_WORKTREE_ID: worktreeId
  }
}
