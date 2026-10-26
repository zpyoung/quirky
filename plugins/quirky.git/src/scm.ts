import type { GitFileStatus, GitStatus, UiLayout } from '@quirky/protocol'

export function splitFiles(files: GitFileStatus[]): { staged: GitFileStatus[]; unstaged: GitFileStatus[] } {
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []
  for (const file of files) {
    if (file.untracked) {
      unstaged.push(file)
      continue
    }
    if (file.index !== ' ' && file.index !== '?') staged.push(file)
    if (file.worktree !== ' ' && file.worktree !== '?') unstaged.push(file)
  }
  return { staged, unstaged }
}

/** One letter for a file row: the index letter on the staged side, the worktree letter otherwise. */
export function statusLetter(file: GitFileStatus, staged: boolean): string {
  if (file.untracked) return 'U'
  return staged ? file.index : file.worktree
}

/** The worktree selector the open view was opened with, or null when no view shows a worktree. */
export function worktreeOf(layout: UiLayout): string | null {
  const input = layout.view?.input
  if (typeof input !== 'object' || input === null) return null
  const worktree = (input as { worktree?: unknown }).worktree
  return typeof worktree === 'string' && worktree !== '' ? worktree : null
}

/** What the source-control slot reports to `ui.state`. */
export type ScmReport = { worktree: string | null; branch: string | null; staged: number; unstaged: number }

export function scmReport(worktree: string | null, status: GitStatus | null): ScmReport {
  const { staged, unstaged } = splitFiles(status?.files ?? [])
  return { worktree, branch: status?.branch ?? null, staged: staged.length, unstaged: unstaged.length }
}
