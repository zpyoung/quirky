export type StockWorktreeOptions = {
  groupBy: 'project' | 'status' | 'none'
  sortBy: 'recent' | 'name' | 'manual'
  compact: boolean
  showBranch: boolean
  showComment: boolean
  showSleeping: boolean
}
export type WorktreeSleepState = { worktreeId: string; sleeping: boolean; changedAt: number }
export type CleanupBlocker = { code: string; detail: string }
export type CleanupCandidate = {
  worktreeId: string
  name: string
  ignored: boolean
  eligible: boolean
  blockers: CleanupBlocker[]
}
export type CleanupRemovalResult = { worktreeId: string; removed: boolean; error?: string }
