import { gitApi, RemoteError, type ExactPushTarget } from '@quirky/git'
import type { GitBusyOp, Worktree } from '@quirky/protocol'
import { holdPushFailure } from './ai-fix'
import { effectiveBase } from './base'
import type { DaemonEnv, Handler } from './env'
import { pushTarget as resolvePushTarget, requirePushTarget, type ValidatedPushTarget } from './push-target'

type PushPurpose = 'review' | 'creation'

function pushPurpose(env: DaemonEnv, value: unknown): PushPurpose | undefined {
  if (value === undefined) return undefined
  if (value !== 'review' && value !== 'creation') {
    throw env.context.error('invalid-params', 'purpose must be review or creation.')
  }
  return value
}

function exactTarget(target: ValidatedPushTarget): ExactPushTarget {
  return {
    remote: target.remote,
    dest: target.branch,
    localBranch: target.localBranch,
    localHead: target.localHead,
    pushUrl: target.pushUrl,
    pushUrlFingerprint: target.pushUrlFingerprint
  }
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/** The operations that publish commits, so a hook failure of one is held for AI Fix and a success clears it. */
const PUSHING: readonly GitBusyOp[] = ['push', 'force-push', 'sync']

/**
 * Runs a remote operation under the worktree's lock and announces the change once the lock is
 * free. A pull, sync or rebase that stopped on conflicts changed the tree, so it announces too.
 * A push, force push or sync that a hook refused is held for AI Fix until one of them succeeds.
 * Logs `<op> <worktreeId> ok|<reason> <ms>`.
 */
async function remoteOperation<T>(env: DaemonEnv, worktree: Worktree, op: GitBusyOp, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  let outcome = 'ok'
  try {
    const result = await env.lock.withLock(worktree.id, op, run)
    if (PUSHING.includes(op)) env.failures.clearPush(worktree.id)
    env.changed(worktree)
    return result
  } catch (error) {
    const translated = env.errors.translate(error)
    outcome = (translated as { data?: { reason?: string } } | null)?.data?.reason ?? 'failed'
    if (outcome === 'conflicts') env.changed(worktree)
    if (PUSHING.includes(op)) await holdPushFailure(env, worktree, translated)
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
    throw env.context.error('invalid-params', 'expected must be a full 40- or 64-character commit id.')
  }
  return expected
}

/** Pushes HEAD to its configured target, or to a fresh validated GitHub target for review/creation. */
export function push(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const purpose = pushPurpose(env, params.purpose)
    return remoteOperation(env, worktree, 'push', async () => {
      if (purpose === undefined) return gitApi().push(worktree.path)
      const target = await requirePushTarget(env, worktree, caller, purpose)
      return gitApi().push(worktree.path, { target: exactTarget(target) })
    })
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
    const purpose = pushPurpose(env, params.purpose)
    return remoteOperation(env, worktree, 'force-push', async () => {
      const git = gitApi()
      if (purpose === undefined) {
        const { remote, dest } = await git.pushTarget(worktree.path, await currentBranch(worktree))
        const lease = expected ?? (await git.remoteTrackingSha(worktree.path, remote, dest))
        return git.push(worktree.path, { lease: { expected: lease } })
      }

      const target = await requirePushTarget(env, worktree, caller, purpose)
      if (purpose === 'review' && expected !== undefined && expected !== target.headOid) {
        throw env.errors.reasoned('conflict', 'stale-target', 'The pull-request head changed since force-push confirmation. Confirm again.')
      }
      const lease = expected ?? target.headOid ?? (await git.remoteTrackingSha(worktree.path, target.remote, target.branch))
      return git.push(worktree.path, { lease: { expected: lease }, target: exactTarget(target) })
    })
  }
}

/** The question asked before a force push. */
export function describeForcePush(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    expectedParam(env, params.expected)
    const purpose = pushPurpose(env, params.purpose)
    if (purpose !== undefined) {
      const target = await requirePushTarget(env, worktree, caller, purpose)
      return `Force push ${target.localBranch} to ${target.remote}/${target.branch}${target.fork ? ' (fork)' : ''}? This replaces the remote branch with your local commits.`
    }
    const branch = await currentBranch(worktree)
    const { remote } = await gitApi().pushTarget(worktree.path, branch)
    return `Force push ${branch} to ${remote}? This replaces the remote branch with your local commits.`
  }
}

export function pushTarget(env: DaemonEnv): Handler {
  return resolvePushTarget(env)
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
