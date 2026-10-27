import { gitApi } from '@quirky/git'
import { KeyedQueue } from './queue'

/** What to clean up after a worktree's folder is gone. */
export type BranchCleanup = {
  repoPath: string
  branch: string
  /** True for a branch the person chose to reuse; it is never touched. */
  keepBranch: boolean
  /** The ref the branch was cut from, when known. */
  baseRef: string | null
}

/**
 * `deleted`: the branch is gone (or was). `skipped`: it is deliberately kept. `kept`: git could not
 * show it is merged, so it stays and the caller reports it with the head to delete it at.
 */
export type BranchOutcome = { status: 'deleted' } | { status: 'skipped' } | { status: 'kept'; name: string; head: string }

export type DeleteAtOutcome = { deleted: true } | { deleted: false; head: string | null }

/**
 * Deletes the branch of a removed worktree only when git can show its changes are merged, and
 * never deletes a branch it has not shown to be at the expected commit. Work on one repository is
 * serialised so concurrent removes do not race each other's prune and branch deletes.
 */
export class BranchCleaner {
  constructor(private readonly queue: KeyedQueue = new KeyedQueue()) {}

  /**
   * `git branch -d` first (after a prune when git still thinks the branch is checked out). If it
   * refuses as unmerged, the branch is still deleted when merging it into the recorded base, its
   * upstream or the default base would change nothing (a squash or rebase merge), by an update
   * that fails if the branch moved meanwhile. Otherwise the branch is kept.
   */
  cleanUp(input: BranchCleanup): Promise<BranchOutcome> {
    return this.queue.run(input.repoPath, () => cleanUp(input))
  }

  /** Deletes `branch` only while it points at `head`; otherwise reports where it points now. */
  deleteAt(repoPath: string, branch: string, head: string): Promise<DeleteAtOutcome> {
    return this.queue.run(repoPath, async () => {
      const git = gitApi()
      if (await git.deleteRefIfAt(repoPath, branch, head)) return { deleted: true }
      return { deleted: false, head: await git.branchHead(repoPath, branch) }
    })
  }
}

async function cleanUp(input: BranchCleanup): Promise<BranchOutcome> {
  if (input.keepBranch) return { status: 'skipped' }
  const git = gitApi()
  const { repoPath, branch } = input
  const head = await git.branchHead(repoPath, branch)
  if (head === null) return { status: 'deleted' }

  let attempt = await git.deleteBranchSafe(repoPath, branch)
  if (!attempt.deleted && attempt.reason === 'checked-out') {
    await git.prune(repoPath)
    attempt = await git.deleteBranchSafe(repoPath, branch)
  }
  if (attempt.deleted) return { status: 'deleted' }

  if (attempt.reason === 'not-merged' && (await mergedIntoATarget(input))) {
    if (await git.deleteRefIfAt(repoPath, branch, head)) return { status: 'deleted' }
    const now = await git.branchHead(repoPath, branch)
    return now === null ? { status: 'deleted' } : { status: 'kept', name: branch, head: now }
  }
  return { status: 'kept', name: branch, head }
}

/** Whether the branch's changes are already in its recorded base, its upstream or the default base; no fetch is made. */
async function mergedIntoATarget(input: BranchCleanup): Promise<boolean> {
  const git = gitApi()
  const candidates = [input.baseRef, await git.upstreamOf(input.repoPath, input.branch), await git.detectDefaultBase(input.repoPath)]
  const targets = [...new Set(candidates.filter((target): target is string => target !== null && target !== '' && target !== input.branch))]
  for (const target of targets) {
    if (await git.mergedByTree(input.repoPath, input.branch, target)) return true
  }
  return false
}
