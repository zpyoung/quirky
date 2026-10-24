import type { GitFileStatus } from '@quirky/protocol'

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
