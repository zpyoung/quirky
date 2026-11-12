import type { WorktreeStatus } from '@quirky/protocol'
import type { StockWorktreeOptions } from './control-types'

export type TagColor = 'blue' | 'violet' | 'teal' | 'coral' | 'magenta' | 'mint' | 'sand' | 'rose'
export const TAG_COLORS: readonly TagColor[] = ['blue', 'violet', 'teal', 'coral', 'magenta', 'mint', 'sand', 'rose']

export type Tag = { id: string; name: string; color: TagColor | null }
export type GroupBy = 'section-project' | 'project' | 'status' | 'tag' | 'pull-request' | 'none'
export type SortBy = 'recent' | 'agent-activity' | 'name' | 'project' | 'manual'
export type RowFact = 'pr' | 'last-activity' | 'branch' | 'status'
export type ActivityMarkState = 'running' | 'waiting' | 'error' | 'idle' | 'asleep'

export type ActivityWindow = 'all' | 'live-only' | 'today' | 'week' | 'month' | 'custom'
export type ActivityPreferences = {
  workspaceActivityWindow: ActivityWindow
  workspaceActivityCustomDays: number
  alwaysShowDefaultBranchWorkspace: boolean
  workspaceActivityWindowBeforeLiveOnly: Exclude<ActivityWindow, 'live-only'>
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
  hideAutomationCreated: boolean
}

export type ViewFilter = {
  tagIds: string[]
  sectionIds: string[]
  repoIds: string[]
  statuses: WorktreeStatus[]
  hideCliCreated: boolean
  hideOtherDesktopClients: boolean
  hideDefaultBranch: boolean
  hideDetachedHead: boolean
  hideArchived: boolean
  activity: ActivityPreferences
}
export type ViewDisplay = {
  groupBy: GroupBy
  sortBy: SortBy
  projectOrder: 'manual' | 'recent'
  showAsleep: boolean
  showNested: boolean
}
export type ViewSpec = { filter: ViewFilter; display: ViewDisplay }
export type SavedView = { id: string; name: string; starred: boolean; spec: ViewSpec }
export type ViewsState = { views: SavedView[]; needsYouHidden: boolean; rowFact: RowFact }
export type ViewId = 'all' | 'needs-you' | string

export const ACTIVITY_WINDOWS: readonly ActivityWindow[] = ['all', 'live-only', 'today', 'week', 'month', 'custom']
export const GROUP_BYS: readonly GroupBy[] = ['section-project', 'project', 'status', 'tag', 'pull-request', 'none']
export const SORT_BYS: readonly SortBy[] = ['recent', 'agent-activity', 'name', 'project', 'manual']
export const ROW_FACTS: readonly RowFact[] = ['pr', 'last-activity', 'branch', 'status']
export const WORKTREE_STATUSES: readonly WorktreeStatus[] = ['todo', 'in-progress', 'in-review', 'done']

export const DEFAULT_ACTIVITY_PREFERENCES: ActivityPreferences = {
  workspaceActivityWindow: 'all',
  workspaceActivityCustomDays: 30,
  alwaysShowDefaultBranchWorkspace: true,
  workspaceActivityWindowBeforeLiveOnly: 'all',
  hideCompletedReviewWorkspaces: false,
  hidePassingCheckWorkspaces: false,
  hideAutomationCreated: false
}

export const DEFAULT_VIEWS_STATE: ViewsState = { views: [], needsYouHidden: false, rowFact: 'last-activity' }

/** The All view's spec: the stock options blob read as a view, with the sidebar-extras preferences as its activity filter. */
export function allSpecFromStock(stock: StockWorktreeOptions, activity: ActivityPreferences): ViewSpec {
  return {
    filter: {
      tagIds: [],
      sectionIds: [],
      repoIds: [...stock.filterRepoIds],
      statuses: [],
      hideCliCreated: stock.hideCliCreated,
      hideOtherDesktopClients: stock.hideOtherClients,
      hideDefaultBranch: stock.hideDefaultBranch,
      hideDetachedHead: stock.hideDetached,
      hideArchived: stock.hideArchived,
      activity: { ...activity }
    },
    display: {
      groupBy: stock.groupBy === 'project' ? 'section-project' : stock.groupBy === 'pr' ? 'pull-request' : stock.groupBy,
      sortBy: stock.sortBy,
      projectOrder: stock.projectOrderBy,
      showAsleep: stock.showSleeping,
      showNested: true
    }
  }
}

/**
 * The stock options that carry the All spec's fields, over `base` for what a spec has no field for.
 * Tag grouping has no stock value, so it keeps the base grouping.
 */
export function stockFromAllSpec(spec: ViewSpec, base: StockWorktreeOptions): StockWorktreeOptions {
  const { filter, display } = spec
  const groupBy: StockWorktreeOptions['groupBy'] =
    display.groupBy === 'section-project' || display.groupBy === 'project'
      ? 'project'
      : display.groupBy === 'pull-request'
        ? 'pr'
        : display.groupBy === 'tag'
          ? base.groupBy
          : display.groupBy
  return {
    ...base,
    groupBy,
    sortBy: display.sortBy,
    projectOrderBy: display.projectOrder,
    showSleeping: display.showAsleep,
    hideCliCreated: filter.hideCliCreated,
    hideDefaultBranch: filter.hideDefaultBranch,
    hideDetached: filter.hideDetachedHead,
    hideArchived: filter.hideArchived,
    hideOtherClients: filter.hideOtherDesktopClients,
    filterRepoIds: [...filter.repoIds]
  }
}
