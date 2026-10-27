import { gitApi, RemoteError } from '@quirky/git'
import type { GitBusyOp, Worktree } from '@quirky/protocol'
import { effectiveBase } from './base'
import type { DaemonEnv, Handler } from './env'

const FULL_SHA = /^[0-9a-f]{40}$/i

/**
 * Runs a remote operation under the worktree's lock and announces the change once the lock is
 * free. A pull, sync or rebase that stopped on conflicts changed the tree, so it announces too.
 * Logs `<op> <worktreeId> ok|<reason> <ms>`.
 */
async function remoteOperation<T>(env: DaemonEnv, worktree: Worktree, op: GitBusyOp, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  let outcome = 'ok'
  try {
    const result = await env.lock.withLock(worktree.id, op, run)
    env.changed(worktree)
    return result
  } catch (error) {
    const translated = env.errors.translate(error)
    outcome = (translated as { data?: { reason?: string } } | null)?.data?.reason ?? 'failed'
    if (outcome === 'conflicts') env.changed(worktree)
    throw translated
  } finally {
    env.context.log(`${op} ${worktree.id} ${outcome} ${Date.now() - started}`)
  }
}

/** The checked-out branch; a detached HEAD is refused the way every remote operation refuses it. */
async function currentBranch(worktree: Worktree): Promise<string> {
  const { current } = await gitApi().listBranches(worktree.path)
  if (!current) throw new RemoteError('detached', 'Check out a branch first.')
  return current
}

/** The `expected` param of a force push: a full commit id, or undefined to lease on the remote-tracking ref. */
function expectedParam(env: DaemonEnv, expected: unknown): string | undefined {
  if (expected === undefined) return undefined
  if (typeof expected !== 'string' || !FULL_SHA.test(expected)) {
    throw env.context.error('invalid-params', 'expected must be a full 40-character commit id.')
  }
  return expected
}

/** Pushes HEAD to its push target, publishing the branch and setting the upstream. */
export function push(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return remoteOperation(env, worktree, 'push', () => gitApi().push(worktree.path))
  }
}

/**
 * Replaces the remote branch with HEAD only if it is still at `expected` (default: where the last
 * fetch left the remote-tracking ref, read without fetching), so a commit pushed since survives.
 */
export function forcePush(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const expected = expectedParam(env, params.expected)
    return remoteOperation(env, worktree, 'force-push', async () => {
      const git = gitApi()
      const { remote, dest } = await git.pushTarget(worktree.path, await currentBranch(worktree))
      const lease = expected ?? (await git.remoteTrackingSha(worktree.path, remote, dest))
      return git.push(worktree.path, { lease: { expected: lease } })
    })
  }
}

/** The question asked before `forcePush`. */
export function describeForcePush(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    expectedParam(env, params.expected)
    const branch = await currentBranch(worktree)
    const { remote } = await gitApi().pushTarget(worktree.path, branch)
    return `Force push ${branch} to ${remote}? This replaces the remote branch with your local commits.`
  }
}

/** Pulls the upstream into the current branch; divergent branches are merged. */
export function pull(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return remoteOperation(env, worktree, 'pull', async () => {
      await gitApi().pull(worktree.path)
      return { ok: true }
    })
  }
}

/** Brings the branch level with its upstream only when that is a fast-forward. */
export function fastForward(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return remoteOperation(env, worktree, 'fast-forward', async () => {
      await gitApi().fastForward(worktree.path)
      return { ok: true }
    })
  }
}

/** Fetches every remote and prunes remote-tracking refs the remote deleted. */
export function fetchRemote(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return remoteOperation(env, worktree, 'fetch', async () => {
      await gitApi().fetch(worktree.path)
      return { ok: true }
    })
  }
}

/**
 * Fetch, then bring the branch and its upstream together: a branch whose behind commits are all
 * rebased copies of its own is force-pushed with a lease on the upstream commit just read;
 * otherwise it pulls when behind and pushes when ahead. Resolves with the steps that ran.
 */
export function sync(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return remoteOperation(env, worktree, 'sync', async () => {
      const git = gitApi()
      const steps: string[] = []
      const upstreamStatus = async () => {
        const upstream = await git.effectiveUpstream(worktree.path, await currentBranch(worktree), { upstream: null, ahead: 0, behind: 0 })
        if (!upstream.hasUpstream) throw new RemoteError('no-upstream', 'Branch has no upstream. Publish the branch first.')
        return upstream
      }

      await git.fetch(worktree.path)
      steps.push('fetch')
      let upstream = await upstreamStatus()
      if (upstream.ahead > 0 && upstream.behind > 0 && upstream.behindPatchEquivalent && upstream.sha !== null) {
        await git.push(worktree.path, { lease: { expected: upstream.sha } })
        steps.push('force-push')
        return { steps }
      }
      if (upstream.behind > 0) {
        await git.pull(worktree.path)
        steps.push('pull')
        upstream = await upstreamStatus()
      }
      if (upstream.ahead > 0) {
        await git.push(worktree.path)
        steps.push('push')
      }
      return { steps }
    })
  }
}

/** Fetches the remote base branch and rebases onto it; the base is the param or the effective base, never the upstream. */
export function rebaseFromBase(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return remoteOperation(env, worktree, 'rebase', async () => {
      const base = params.base?.trim() || (await effectiveBase(env, worktree))?.base
      if (!base) throw new RemoteError('invalid-base', 'Rebase needs a remote base branch (like origin/main).')
      await gitApi().rebaseFromBase(worktree.path, base)
      return { ok: true, base }
    })
  }
}
