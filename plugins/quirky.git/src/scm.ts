import type { GitBusyOp, GitOperation, UiLayout } from '@quirky/protocol'
import type { SectionId } from './panel/sections'

/** The worktree selected for the current window, or null when none is selected. */
export function worktreeOf(layout: UiLayout): string | null {
  return layout.worktree ?? null
}

/** What the Source Control panel reports to `ui.state`; sections list counts, not rows. */
export type ScmReport = {
  worktree: string | null
  branch: string | null
  base: string | null
  ahead: number
  behind: number
  operation: GitOperation
  busy: GitBusyOp | null
  capped: boolean
  sections: Array<{ id: SectionId | 'branch'; count: number }>
  primary: { label: string; enabled: boolean; title: string } | null
  selection: string[]
  filter: string
  viewMode: 'list' | 'tree'
  historyOpen: boolean
}

/** The report of a panel with no worktree to show. */
export const EMPTY_REPORT: ScmReport = {
  worktree: null,
  branch: null,
  base: null,
  ahead: 0,
  behind: 0,
  operation: 'none',
  busy: null,
  capped: false,
  sections: [],
  primary: null,
  selection: [],
  filter: '',
  viewMode: 'list',
  historyOpen: false
}
