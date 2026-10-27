import { gitApi } from '@quirky/git'
import { holdCommitFailure } from './ai-fix'
import type { DaemonEnv, Handler } from './env'

/**
 * Commits what is staged; hooks run, and a failing one is reported as `lint` or `hook` with its
 * output. A refused commit is held for AI Fix until a commit succeeds.
 */
export function commit(env: DaemonEnv): Handler {
  return async (params, caller) => {
    if (String(params.message).trim() === '') {
      throw env.context.error('invalid-params', 'Commit message is required')
    }
    const worktree = await env.resolve(params, caller)
    let sha: string
    try {
      sha = await gitApi().commit(worktree.path, params.message)
    } catch (error) {
      const failure = env.errors.commitFailure(error)
      await holdCommitFailure(env, worktree, params.message, failure)
      throw failure
    }
    env.failures.clearCommit(worktree.id)
    env.changed(worktree)
    return { sha }
  }
}
