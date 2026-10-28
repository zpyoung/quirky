import type { Worktree } from '@quirky/protocol'
import type { ExternalVisibility, WorktreeCleanupContext, WorktreeReference } from './parity-types'

export type WorktreeCardProperty = 'branch' | 'notes' | 'pullRequest' | 'issue' | 'automation' | 'activity'
export type StockWorktreeOptions = {
  groupBy: 'project' | 'status' | 'none' | 'pr'
  sortBy: 'recent' | 'name' | 'manual' | 'agent-activity' | 'project'
  projectOrderBy: 'manual' | 'recent'
  compact: boolean
  showBranch: boolean
  showComment: boolean
  showSleeping: boolean
  hideCliCreated: boolean
  hideDefaultBranch: boolean
  hideDetached: boolean
  hideArchived: boolean
  hideOtherClients: boolean
  filterRepoIds: string[]
  showProperties: WorktreeCardProperty[]
  externalVisibilityDefault: Exclude<ExternalVisibility, 'inherit'>
}

export const DEFAULT_STOCK_OPTIONS: StockWorktreeOptions = {
  groupBy: 'project',
  sortBy: 'recent',
  projectOrderBy: 'manual',
  compact: false,
  showBranch: true,
  showComment: true,
  showSleeping: true,
  hideCliCreated: false,
  hideDefaultBranch: false,
  hideDetached: false,
  hideArchived: true,
  hideOtherClients: false,
  filterRepoIds: [],
  showProperties: ['branch', 'notes', 'pullRequest', 'issue', 'automation', 'activity'],
  externalVisibilityDefault: 'hide'
}

export function isStockWorktreeOptions(value: unknown): value is StockWorktreeOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const options = value as Record<string, unknown>
  const stringArray = (input: unknown): input is string[] => Array.isArray(input) && input.every((item) => typeof item === 'string')
  const properties: readonly WorktreeCardProperty[] = ['branch', 'notes', 'pullRequest', 'issue', 'automation', 'activity']
  return (options.groupBy === 'project' || options.groupBy === 'status' || options.groupBy === 'none' || options.groupBy === 'pr') &&
    (options.sortBy === 'recent' || options.sortBy === 'name' || options.sortBy === 'manual' || options.sortBy === 'agent-activity' || options.sortBy === 'project') &&
    (options.projectOrderBy === 'manual' || options.projectOrderBy === 'recent') &&
    typeof options.compact === 'boolean' &&
    typeof options.showBranch === 'boolean' &&
    typeof options.showComment === 'boolean' &&
    typeof options.showSleeping === 'boolean' &&
    typeof options.hideCliCreated === 'boolean' &&
    typeof options.hideDefaultBranch === 'boolean' &&
    typeof options.hideDetached === 'boolean' &&
    typeof options.hideArchived === 'boolean' &&
    typeof options.hideOtherClients === 'boolean' &&
    stringArray(options.filterRepoIds) &&
    Array.isArray(options.showProperties) && options.showProperties.every((property) => properties.includes(property as WorktreeCardProperty)) &&
    (options.externalVisibilityDefault === 'show' || options.externalVisibilityDefault === 'hide')
}

export type WorktreeControl = Worktree & {
  manualOrder: number
  sleeping: boolean
  sleepChangedAt: number | null
  references: WorktreeReference[]
  archivedAt: number | null
  cleanupContext: WorktreeCleanupContext
  externalVisible: boolean
  externalVisibility: Exclude<ExternalVisibility, 'inherit'>
  externalInboxSuppressed: boolean
}

export type WorktreeSleepPreviewRow = {
  worktreeId: string
  name: string
  sleeping: boolean
  allowed: boolean
  blockers: CleanupBlocker[]
}
export type WorktreeSleepPreview = { worktrees: WorktreeSleepPreviewRow[] }
export type CleanupReason = 'idle-clean' | 'archived-7day'
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
