import { gitApi } from '@quirky/git'
import type { GitStatusEntry, Worktree } from '@quirky/protocol'
import type { DaemonEnv } from './env'

/** What the commit message prompt is built from: the staged change of a worktree. */
export type StagedContext = {
  /** The checked-out branch, or `(detached)`. */
  branch: string
  /** `git diff --cached --name-status` lines joined by newlines. */
  stagedFiles: string
  patch: string
  /** True when the patch was too large to read and `patch` is empty. */
  patchOmitted: boolean
}

const LETTERS: Record<GitStatusEntry['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'A'
}

/** One `--name-status` line for a staged entry: the letter, a tab and the path (old and new for a rename or copy). */
function nameStatusLine(entry: GitStatusEntry): string {
  const letter = LETTERS[entry.status]
  return entry.oldPath === undefined ? `${letter}\t${entry.path}` : `${letter}\t${entry.oldPath}\t${entry.path}`
}

/** The staged change of the worktree, or null when nothing is staged. */
export async function readStagedContext(env: DaemonEnv, worktree: Worktree): Promise<StagedContext | null> {
  const status = await env.readStatus(worktree)
  const staged = status.entries.filter((entry) => entry.area === 'staged').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (staged.length === 0) return null
  const { patch, omitted } = await gitApi().stagedPatch(worktree.path)
  return { branch: status.branch ?? '(detached)', stagedFiles: staged.map(nameStatusLine).join('\n'), patch, patchOmitted: omitted }
}
