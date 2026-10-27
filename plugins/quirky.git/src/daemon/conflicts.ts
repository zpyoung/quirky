import { gitApi } from '@quirky/git'
import type { GitOperation } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'
import { containedPath } from './paths'

/**
 * A conflicted file's working text and hash. Opening it is what lets it show as resolved locally
 * later, unless `peek` is set, which reads it without leaving that trace.
 */
export function conflictFile(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const { rel } = await containedPath(worktree.path, params.path)
    const { content, hash } = await gitApi().readConflictFile(worktree.path, rel)
    const status = await env.readStatus(worktree)
    const entry = status.entries.find((candidate) => candidate.area === 'conflicts' && candidate.path === rel)
    if (!entry?.conflict) throw env.context.error('not-found', `${rel} is not in conflict.`)
    if (params.peek !== true) {
      env.opened.record(worktree.id, status.operation, await gitApi().operationHead(worktree.path), {
        path: rel,
        kind: entry.conflict.kind
      })
    }
    return { path: rel, kind: entry.conflict.kind, state: entry.conflict.state, content, hash, operation: status.operation }
  }
}

/** Finishes the merge, rebase or cherry-pick in progress once no conflict is unresolved. */
export function continueOperation(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return env.lock.withLock(worktree.id, 'continue', async () => {
      const status = await env.readStatus(worktree)
      if (status.operation === 'none') {
        throw env.errors.reasoned('conflict', 'nothing-to-continue', 'Nothing to continue.')
      }
      if (status.entries.some((entry) => entry.conflict?.state === 'unresolved')) {
        throw env.errors.reasoned('conflict', 'unresolved', 'Resolve every conflict before continuing.')
      }
      let finished: boolean
      try {
        ;({ finished } = await gitApi().continueOperation(worktree.path, status.operation))
      } catch (error) {
        throw env.errors.commitFailure(error)
      }
      const operation = await gitApi().detectOperation(worktree.path)
      if (operation === 'none') env.opened.clear(worktree.id)
      env.changed(worktree)
      return { finished, operation }
    })
  }
}

const abortable = (operation: GitOperation): operation is 'merge' | 'rebase' => operation === 'merge' || operation === 'rebase'

/** The question asked before `abort`; refuses at once when there is nothing to abort. */
export function describeAbort(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    const operation = await gitApi().detectOperation(worktree.path)
    if (!abortable(operation)) throw env.errors.reasoned('invalid-params', 'not-allowed', 'Nothing to abort.')
    return `Abort ${operation}? This cancels the ${operation} in progress and can discard conflict resolutions made during this ${operation}.`
  }
}

/** Cancels the merge or rebase in progress. */
export function abort(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    return env.lock.withLock(worktree.id, 'abort', async () => {
      const operation = await gitApi().detectOperation(worktree.path)
      if (!abortable(operation)) throw env.errors.reasoned('invalid-params', 'not-allowed', 'Nothing to abort.')
      await gitApi().abortOperation(worktree.path, operation)
      env.opened.clear(worktree.id)
      env.changed(worktree)
      return { ok: true }
    })
  }
}
