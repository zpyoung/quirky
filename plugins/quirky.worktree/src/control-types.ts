import type { Worktree } from '@quirky/protocol'
export type StockWorktreeOptions = {
  groupBy: 'project' | 'status' | 'none'
  sortBy: 'recent' | 'name' | 'manual'
  compact: boolean
  showBranch: boolean
  showComment: boolean
  showSleeping: boolean
}
export const DEFAULT_STOCK_OPTIONS: StockWorktreeOptions = {
  groupBy: 'project',
  sortBy: 'recent',
  compact: false,
  showBranch: true,
  showComment: true,
  showSleeping: true
}

export function isStockWorktreeOptions(value: unknown): value is StockWorktreeOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const options = value as Record<string, unknown>
  return (options.groupBy === 'project' || options.groupBy === 'status' || options.groupBy === 'none') &&
    (options.sortBy === 'recent' || options.sortBy === 'name' || options.sortBy === 'manual') &&
    typeof options.compact === 'boolean' &&
    typeof options.showBranch === 'boolean' &&
    typeof options.showComment === 'boolean' &&
    typeof options.showSleeping === 'boolean'
}
export type WorktreeControl = Worktree & {
  manualOrder: number
  sleeping: boolean
  sleepChangedAt: number | null
}
export type WorktreeSleepPreviewRow = {
  worktreeId: string
  name: string
  sleeping: boolean
  allowed: boolean
  blockers: CleanupBlocker[]
}
export type WorktreeSleepPreview = { worktrees: WorktreeSleepPreviewRow[] }
export type CleanupReason = 'idle-clean'
export type CleanupPreview = { generatedAt: number; candidates: CleanupCandidate[] }
export type WorktreeSleepState = { worktreeId: string; sleeping: boolean; changedAt: number }
export type CleanupBlocker = { code: string; detail: string }
export type CleanupCandidate = {
  worktreeId: string
  name: string
  fingerprint: string
  reason: CleanupReason
  ignored: boolean
  eligible: boolean
  blockers: CleanupBlocker[]
}
export type CleanupSelection = { worktreeId: string; fingerprint: string }
export type CleanupRemovalResult = { worktreeId: string; removed: boolean; error?: string }
