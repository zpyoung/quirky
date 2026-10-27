import { gitApi } from '@quirky/git'
import type { DaemonEnv, Handler } from './env'

/** Commits what is staged; hooks run, and a failing one is reported as `lint` or `hook` with its output. */
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
      throw env.errors.commitFailure(error)
    }
    env.changed(worktree)
    return { sha }
  }
}
