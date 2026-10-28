import type { Worktree, WorkspaceOriginView } from '@quirky/protocol'
import type { WorkspacePreferences } from './storage'

type FilterWorktree = Pick<Worktree, 'id' | 'isMain' | 'createdBy' | 'branch'> & { sleeping?: boolean }

/** Unknown provenance and partial session recovery remain visible; only parked worktrees are hidden. */
export function matchesWorkspaceFilters(
  worktree: FilterWorktree,
  filters: WorkspacePreferences['filters'],
  origin: WorkspaceOriginView | undefined
): boolean {
  if (filters.hideDefaultBranch && worktree.isMain) return false
  if (filters.exceptDefaultBranch && worktree.isMain) return true
  if (filters.hideSleeping && worktree.sleeping === true) return false
  if (filters.hideAutomationCreated && origin?.automation === true) return false
  if (filters.hideOtherClient && origin?.otherClient === true) return false
  if (filters.hideCliCreated && worktree.createdBy === 'cli') return false
  return !(filters.hideDetachedHead && worktree.branch === null)
}
