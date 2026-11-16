import { GitError, gitApi } from '@quirky/git'
import type { Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'

/** Fails with `invalid-params` ("unknown tree <oid>") for the first of `oids` that is not a tree of the worktree's repository. */
export async function requireTrees(env: DaemonEnv, worktree: Worktree, oids: readonly unknown[]): Promise<void> {
  for (const oid of oids) {
    if (typeof oid !== 'string' || !(await gitApi().treeExists(worktree.path, oid))) {
      throw env.errors.reasoned('invalid-params', 'unknown-tree', `unknown tree ${String(oid)}`)
    }
  }
}

/**
 * Records the whole working tree, untracked files included and ignored ones left out, as a tree
 * object and returns its oid, so a later `treeChanges` can say what changed in between. The real
 * index, HEAD and refs stay as they were.
 */
export function snapshotTree(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    try {
      return { tree: await gitApi().snapshotTree(worktree.path) }
    } catch (error) {
      if (error instanceof GitError && error.message === 'not a git work tree') {
        throw env.errors.reasoned('invalid-params', 'not-a-work-tree', 'not a git work tree')
      }
      throw error
    }
  }
}

/** The files that differ between two snapshot trees, with line counts and renames, in the shape of the branch compare's file list. */
export function treeChanges(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    await requireTrees(env, worktree, [params.from, params.to])
    return { changes: await gitApi().changeList(worktree.path, params.from, params.to) }
  }
}
