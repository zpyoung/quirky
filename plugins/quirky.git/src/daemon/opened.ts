import type { GitConflictKind, GitOperation } from '@quirky/protocol'

/** A conflicted path the person opened, with the kind it had then. */
export type OpenedConflict = { path: string; kind: GitConflictKind }

type Entry = { operation: GitOperation; head: string | null; paths: Map<string, GitConflictKind> }

/**
 * Per worktree, the conflict paths read through `conflictFile` during the current operation. An
 * entry is tagged with the operation and its head commit, so a different operation starts empty.
 */
export class OpenedConflicts {
  private readonly byWorktree = new Map<string, Entry>()

  /** Notes that `conflict` was opened during the operation identified by `operation` and `head`. */
  record(worktreeId: string, operation: GitOperation, head: string | null, conflict: OpenedConflict): void {
    let entry = this.byWorktree.get(worktreeId)
    if (!entry || entry.operation !== operation || entry.head !== head) {
      entry = { operation, head, paths: new Map() }
      this.byWorktree.set(worktreeId, entry)
    }
    entry.paths.set(conflict.path, conflict.kind)
  }

  /** The paths opened during that exact operation; a record of any other operation is dropped. */
  list(worktreeId: string, operation: GitOperation, head: string | null): OpenedConflict[] {
    const entry = this.byWorktree.get(worktreeId)
    if (!entry) return []
    if (entry.operation !== operation || entry.head !== head) {
      this.byWorktree.delete(worktreeId)
      return []
    }
    return [...entry.paths].map(([path, kind]) => ({ path, kind }))
  }

  clear(worktreeId: string): void {
    this.byWorktree.delete(worktreeId)
  }
}
