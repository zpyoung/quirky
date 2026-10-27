import type { GitConflictKind, GitDiffSource } from '@quirky/protocol'

export const DIFF_VIEW_ID = 'view:quirky.git/diff'
export const PANEL_ID = 'panel:quirky.git/source-control'
export const SESSIONS_VIEW_ID = 'view:quirky.session/worktree'

/** The conflicts a review captured and when, so the review survives showing one of its files. */
export type ReviewSnapshot = { entries: Array<{ path: string; kind: GitConflictKind }>; capturedAt: number }

/**
 * What the `diff` view is opened with. `file` shows one file's diff from `source`; `combined` lists
 * a section's files (`area`, or `commit` for one commit); `conflicts` is the conflict review and
 * `conflict-file` one conflicted file. `worktree` keeps the panel on the same worktree.
 */
export type DiffViewInput = {
  worktree: string
  mode: 'file' | 'combined' | 'conflicts' | 'conflict-file'
  source?: GitDiffSource
  path?: string
  oldPath?: string
  area?: 'staged' | 'unstaged' | 'untracked' | 'branch' | 'all'
  commit?: string
  title?: string
  /** The note whose card a `file` view scrolls into view once its diff has loaded. */
  noteId?: string
  /** The review a `conflicts` view resumes, or the one a `conflict-file` view returns to on close. */
  review?: ReviewSnapshot
}
