import type { GitCommit, GitConflictKind, GitDiffSource } from '@quirky/protocol'

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
  commitMessage?: Pick<GitCommit, 'subject' | 'body'>
  title?: string
  /** Replaceable preview by default; permanent opens cannot replace an existing permanent tab. */
  preview?: boolean
  /** Open in a new right-hand group rather than replace the focused group's preview. */
  split?: boolean
  /** Exact existing destination group when the caller supplies one. */
  groupId?: string
  /** Stable terminal hosted-tab identity, present only after the public tab API opens the view. */
  tabId?: string
  /** Markdown diff preview renders only the modified side. */
  display?: 'source' | 'preview'
  /** The note whose card a `file` view scrolls into view once its diff has loaded. */
  noteId?: string
  /** The review a `conflicts` view resumes, or the one a `conflict-file` view returns to on close. */
  review?: ReviewSnapshot
}

/** The stable key for one diff identity; display and placement never change which file is open. */
export function diffViewKey(input: DiffViewInput): string {
  return `git-diff:${JSON.stringify([
    input.worktree,
    input.mode,
    input.source ?? '',
    input.path ?? '',
    input.oldPath ?? '',
    input.area ?? '',
    input.commit ?? ''
  ])}`
}
