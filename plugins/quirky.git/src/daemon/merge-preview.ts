import { gitApi } from '@quirky/git'
import type { DaemonEnv, Handler } from './env'

/** A hosting review can inspect available commit objects, never invoke an actual checkout merge. */
export function mergePreview(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const base: unknown = params.base
    const head: unknown = params.head
    if (typeof base !== 'string' || typeof head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw env.errors.reasoned('invalid-params', 'invalid-commit', 'Merge preview requires complete base and head commit IDs.')
    const worktree = await env.resolve(params, caller)
    return gitApi().mergePreview(worktree.path, base, head)
  }
}
