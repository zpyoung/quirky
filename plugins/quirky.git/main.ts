import { gitApi, type GitApi } from '@quirky/git'
import type { PluginCaller, PluginContext, Worktree } from '@quirky/protocol'

type WorktreeParams = { worktree?: string }

/** The text a failed git call should show: git's stderr when it has any, else the error message. */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/**
 * Source control for a worktree: status, diff, stage, unstage and commit through `@quirky/git`.
 * The `worktree` param is a selector that `quirky.worktree/resolve` turns into a path, using the
 * caller's session or cwd when it is omitted.
 */
export function activate(context: PluginContext): void {
  async function resolve(params: WorktreeParams, caller: PluginCaller): Promise<Worktree> {
    const identity = caller.role === 'plugin' ? {} : { cwd: caller.cwd, worktreeId: caller.worktreeId }
    return (await context.call('quirky.worktree/resolve', {
      selector: params.worktree ?? 'current',
      ...identity
    })) as Worktree
  }

  async function inWorktree<T>(
    params: WorktreeParams,
    caller: PluginCaller,
    run: (git: GitApi, path: string) => Promise<T>
  ): Promise<{ worktree: Worktree; result: T }> {
    const worktree = await resolve(params, caller)
    try {
      return { worktree, result: await run(gitApi(), worktree.path) }
    } catch (error) {
      throw new Error(gitMessage(error))
    }
  }

  const changed = (worktree: Worktree) => context.emit('changed', { worktreeId: worktree.id })

  context.provide('method:quirky.git/status', async (params: WorktreeParams, caller: PluginCaller) =>
    (await inWorktree(params, caller, (git, path) => git.status(path))).result
  )

  context.provide(
    'method:quirky.git/diff',
    async (params: WorktreeParams & { path: string; staged?: boolean }, caller: PluginCaller) =>
      (await inWorktree(params, caller, (git, cwd) => git.diff(cwd, params.path, params.staged ?? false))).result
  )

  context.provide(
    'method:quirky.git/stage',
    async (params: WorktreeParams & { paths: string[] }, caller: PluginCaller) => {
      const { worktree } = await inWorktree(params, caller, (git, cwd) => git.stage(cwd, params.paths))
      changed(worktree)
      return { ok: true }
    }
  )

  context.provide(
    'method:quirky.git/unstage',
    async (params: WorktreeParams & { paths: string[] }, caller: PluginCaller) => {
      const { worktree } = await inWorktree(params, caller, (git, cwd) => git.unstage(cwd, params.paths))
      changed(worktree)
      return { ok: true }
    }
  )

  context.provide(
    'method:quirky.git/commit',
    async (params: WorktreeParams & { message: string }, caller: PluginCaller) => {
      const { worktree, result: sha } = await inWorktree(params, caller, (git, cwd) => git.commit(cwd, params.message))
      changed(worktree)
      return { sha }
    }
  )
}
