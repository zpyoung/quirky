import { gitApi } from '@quirky/git'
import type { DaemonEnv, Handler } from './env'

/** Up to `limit` commits from HEAD, newest first. */
export function history(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return gitApi().history(worktree.path, params.limit)
  }
}

/** The files a commit changed against its first parent (a root commit against nothing). */
export function commitFiles(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const oid = await gitApi().resolveCommit(worktree.path, params.commit)
    if (oid === null) throw env.context.error('invalid-params', `Unknown commit ${params.commit}`)
    return gitApi().commitFiles(worktree.path, oid)
  }
}
