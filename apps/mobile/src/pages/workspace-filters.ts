import type { Worktree, WorkspaceOriginView, WorkspaceSleepState } from '@quirky/protocol'
import type { WorkspacePreferences } from './storage'

/** Unknown provenance and partial sleep must remain visible and recoverable. */
export function matchesWorkspaceFilters(
  worktree: Pick<Worktree, 'id' | 'isMain' | 'createdBy' | 'branch'>,
  filters: WorkspacePreferences['filters'],
  origin: WorkspaceOriginView | undefined,
  sleep: WorkspaceSleepState['state'] | undefined
): boolean {
  if (filters.hideDefaultBranch && worktree.isMain) return false
  if (filters.exceptDefaultBranch && worktree.isMain) return true
  if (filters.hideSleeping && sleep === 'asleep') return false
  if (filters.hideAutomationCreated && origin?.automation === true) return false
  if (filters.hideOtherClient && origin?.otherClient === true) return false
  if (filters.hideCliCreated && worktree.createdBy === 'cli') return false
  return !(filters.hideDetachedHead && worktree.branch === null)
}
