import type { GitBusyOp } from '@quirky/protocol'
import type { Errors } from './errors'

const LABELS: Record<GitBusyOp, string> = {
  push: 'push',
  'force-push': 'force push',
  switch: 'branch switch',
  pull: 'pull',
  'fast-forward': 'fast-forward',
  fetch: 'fetch',
  sync: 'sync',
  rebase: 'rebase',
  continue: 'continue',
  abort: 'abort'
}

/** One in-memory lock per worktree id, held for the duration of a remote, continue or abort call. */
export type WorktreeLock = {
  /**
   * Runs `run` holding the worktree's lock and releases it afterwards, whatever happens. Rejects at
   * once with `conflict`/`busy` ("A <held op> is already running in this worktree.") when it is held.
   */
  withLock<T>(worktreeId: string, op: GitBusyOp, run: () => Promise<T>): Promise<T>
  /** The operation holding the worktree's lock, or null. */
  heldBy(worktreeId: string): GitBusyOp | null
}

export function createLock(errors: Pick<Errors, 'reasoned'>): WorktreeLock {
  const held = new Map<string, GitBusyOp>()
  return {
    async withLock(worktreeId, op, run) {
      const current = held.get(worktreeId)
      if (current) {
        throw errors.reasoned('conflict', 'busy', `A ${LABELS[current]} is already running in this worktree.`)
      }
      held.set(worktreeId, op)
      try {
        return await run()
      } finally {
        held.delete(worktreeId)
      }
    },
    heldBy: (worktreeId) => held.get(worktreeId) ?? null
  }
}
