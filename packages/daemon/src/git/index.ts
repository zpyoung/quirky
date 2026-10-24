/**
 * Git operations for the daemon, done by spawning the `git` binary (no git library), the same
 * approach Orca uses. Every function throws `GitError` with git's stderr on a non-zero exit.
 */
import type { GitDiff, GitStatus } from '@quirky/protocol'

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export type GitWorktreeInfo = {
  path: string
  branch: string | null
  head: string
  isMain: boolean
}

/** The repository toplevel containing `path`; throws GitError when it isn't inside a repo. */
export async function resolveRepoRoot(path: string): Promise<string> {
  throw new Error('not implemented')
}

/** Every worktree of the repo at `repoPath`, main worktree first (`git worktree list --porcelain`). */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  throw new Error('not implemented')
}

/** `git worktree add -b <branch> <path> <baseRef>`; baseRef defaults to HEAD. Creates parent dirs. */
export async function addWorktree(
  repoPath: string,
  path: string,
  branch: string,
  baseRef?: string
): Promise<void> {
  throw new Error('not implemented')
}

export async function removeWorktree(repoPath: string, path: string, force: boolean): Promise<void> {
  throw new Error('not implemented')
}

export async function status(cwd: string): Promise<GitStatus> {
  throw new Error('not implemented')
}

/** See `GitDiff` for which sides `staged` selects. Files over 2 MB or with NUL bytes are binary. */
export async function diff(cwd: string, path: string, staged: boolean): Promise<GitDiff> {
  throw new Error('not implemented')
}

export async function stage(cwd: string, paths: string[]): Promise<void> {
  throw new Error('not implemented')
}

/** Works in a repo with no commits yet (falls back to `git rm --cached`). */
export async function unstage(cwd: string, paths: string[]): Promise<void> {
  throw new Error('not implemented')
}

/** Commits what is staged and returns the new commit's full sha. */
export async function commit(cwd: string, message: string): Promise<string> {
  throw new Error('not implemented')
}
