import { gitApi } from '@quirky/git'
import type { GitChange, GitChangeStatus, GitStatusEntry, Worktree } from '@quirky/protocol'
import type { DaemonEnv } from './env'

/** What the commit message prompt is built from: the staged change of a worktree, or all its uncommitted changes. */
export type StagedContext = {
  /** The checked-out branch, or `(detached)`. */
  branch: string
  /** `git diff --cached --name-status` lines joined by newlines. */
  stagedFiles: string
  patch: string
  /** True when the patch was too large to read and `patch` is empty. */
  patchOmitted: boolean
}

const LETTERS: Record<GitChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'A'
}

/** One `--name-status` line for a changed file: the letter, a tab and the path (old and new for a rename or copy). */
function nameStatusLine(entry: Pick<GitChange, 'path' | 'oldPath' | 'status'>): string {
  const letter = LETTERS[entry.status]
  return entry.oldPath === undefined ? `${letter}\t${entry.path}` : `${letter}\t${entry.oldPath}\t${entry.path}`
}

/** One entry per path, the staged one when a path is partly staged, so a file is listed once. */
function onePerPath(entries: readonly GitStatusEntry[]): GitStatusEntry[] {
  const byPath = new Map<string, GitStatusEntry>()
  for (const entry of entries) {
    const known = byPath.get(entry.path)
    if (!known || (entry.area === 'staged' && known.area !== 'staged')) byPath.set(entry.path, entry)
  }
  return [...byPath.values()]
}

/** The staged change of the worktree, or null when nothing is staged. */
export async function readStagedContext(env: DaemonEnv, worktree: Worktree): Promise<StagedContext | null> {
  const status = await env.readStatus(worktree)
  const staged = status.entries.filter((entry) => entry.area === 'staged').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (staged.length === 0) return null
  const { patch, omitted } = await gitApi().stagedPatch(worktree.path)
  return { branch: status.branch ?? '(detached)', stagedFiles: staged.map(nameStatusLine).join('\n'), patch, patchOmitted: omitted }
}

/**
 * Every uncommitted change of the worktree read against HEAD (an unborn HEAD against nothing):
 * staged, unstaged, deleted and untracked files, each once, with one patch. Null when nothing
 * differs. Nothing is staged or otherwise changed.
 */
export async function readUncommittedContext(env: DaemonEnv, worktree: Worktree): Promise<StagedContext | null> {
  const git = gitApi()
  const status = await env.readStatus(worktree)
  const changes: Pick<GitChange, 'path' | 'oldPath' | 'status'>[] = status.unborn
    ? onePerPath(status.entries)
    : (await env.changeList(worktree, 'HEAD')).changes
  if (changes.length === 0) return null
  const files = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const { patch, omitted } = await git.workingPatch(worktree.path)
  return { branch: status.branch ?? '(detached)', stagedFiles: files.map(nameStatusLine).join('\n'), patch, patchOmitted: omitted }
}
