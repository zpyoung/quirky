import { gitApi } from '@quirky/git'
import type { GitCompare, Worktree } from '@quirky/protocol'
import { compareBase } from './base'
import type { DaemonEnv, Handler } from './env'

const NO_BASE = 'No base ref could be found for this repository.'

/** The compare of `worktree` against `base` (or its compare base); no base at all is an `invalid-base` result. */
export async function readCompare(env: DaemonEnv, worktree: Worktree, base?: string): Promise<GitCompare> {
  const picked = await compareBase(env, worktree, base?.trim() || undefined)
  if (!picked) {
    return {
      status: 'invalid-base',
      base: null,
      baseSource: null,
      message: NO_BASE,
      baseOid: null,
      headOid: null,
      mergeBase: null,
      ahead: 0,
      behind: 0,
      entries: [],
      added: 0,
      removed: 0
    }
  }
  return { ...(await gitApi().compare(worktree.path, picked.base)), baseSource: picked.source }
}

/** What the branch committed since its merge base with the base; a compare that cannot run is a result, not an error. */
export function compare(env: DaemonEnv): Handler {
  return async (params, caller) => readCompare(env, await env.resolve(params, caller), params.base)
}

/**
 * Saves the base ref on the worktree when it has one of its own, else on the project, so that
 * every worktree without its own base follows it. `clear` removes the saved base instead.
 */
export function setBase(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const given = params.base !== undefined
    const clear = params.clear === true
    if (given === clear) throw env.context.error('invalid-params', 'Pass exactly one of base or clear.')
    const base: string | null = clear ? null : String(params.base).trim()
    if (base === '') throw env.context.error('invalid-params', 'base must not be empty.')
    if (base !== null && (await gitApi().resolveCommit(worktree.path, base)) === null) {
      throw env.errors.reasoned('invalid-params', 'invalid-base', `Base ref ${base} could not be resolved in this repository.`)
    }
    const own = worktree.baseRef !== null
    if (own) await env.context.call('quirky.worktree/set', { worktree: worktree.id, baseRef: base })
    else await env.context.call('quirky.repo/set', { repo: worktree.repoId, defaultBase: base ?? '' })
    env.changed(worktree)
    return { target: own ? 'worktree' : 'project', base }
  }
}

/** Local and remote branches whose name contains `query`, for the base picker. */
export function branches(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return gitApi().listBranches(worktree.path, params.query)
  }
}
