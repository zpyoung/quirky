import { gitApi } from '@quirky/git'
import type { GitCompare, RepoDetails, Worktree } from '@quirky/protocol'
import type { DaemonEnv } from './env'

export type BaseSource = NonNullable<GitCompare['baseSource']>

/**
 * The base ref a worktree is compared and rebased against: its own `baseRef`, else the project's
 * default base, else the repository's detected default. Null when none can be found.
 */
export async function effectiveBase(env: DaemonEnv, worktree: Worktree): Promise<{ base: string; source: BaseSource } | null> {
  if (worktree.baseRef) return { base: worktree.baseRef, source: 'worktree' }
  const details = (await env.context.call('quirky.repo/show', { repo: worktree.repoId })) as RepoDetails
  if (details.settings.defaultBase) return { base: details.settings.defaultBase, source: 'project' }
  const detected = await gitApi().detectDefaultBase(details.repo.path)
  return detected ? { base: detected, source: 'detected' } : null
}

/**
 * The base the branch compare uses. A `base` param wins; with the Default Compare Base setting at
 * "Branch upstream" a worktree without a base of its own compares against its upstream when it has
 * one; otherwise this is `effectiveBase`.
 */
export async function compareBase(
  env: DaemonEnv,
  worktree: Worktree,
  param: string | undefined
): Promise<{ base: string; source: BaseSource } | null> {
  if (param) return { base: param, source: 'param' }
  if (env.context.getSetting('compareBase') === 'branch-upstream' && !worktree.baseRef && worktree.branch) {
    const upstream = await gitApi().effectiveUpstream(worktree.path, worktree.branch, { upstream: null, ahead: 0, behind: 0 })
    if (upstream.name) return { base: upstream.name, source: 'upstream' }
  }
  return effectiveBase(env, worktree)
}
