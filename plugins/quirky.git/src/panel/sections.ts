import type { GitArea, GitStatusEntry } from '@quirky/protocol'

/** The area of a status row, which is also what its action buttons depend on. */
export type SectionId = GitArea

/** Which discard a row offers: "Discard changes", "Restore file" or "Delete untracked file". */
export type DiscardKind = 'discard' | 'restore' | 'delete'

export const ROW_ACTION_LABELS = {
  stage: 'Stage',
  unstage: 'Unstage',
  discard: 'Discard changes',
  restore: 'Restore file',
  delete: 'Delete untracked file'
} as const

/** Facts about the working copy the panel knows and the status does not. */
export type ActionContext = {
  /**
   * Paths of unresolved conflicts whose working copy no longer holds conflict markers (or no
   * longer exists). Only these can be staged, because staging clears git's unmerged record.
   */
  markersGone?: ReadonlySet<string>
  /** Paths the text conflict editor cannot open, which must remain stageable without its named actions. */
  unreadableConflicts?: ReadonlySet<string>
}

/** The actions a row offers; `discard` names which kind, or null for none. */
export type EntryActions = { stage: boolean; unstage: boolean; discard: DiscardKind | null }

const NONE: EntryActions = { stage: false, unstage: false, discard: null }

/**
 * Orca's per-row eligibility with logic SC-13 applied. Submodule rows are read-only. Staged rows
 * can only be unstaged (discarding staged work is the section's "Discard all"). A conflict
 * resolved locally is already staged, so it offers nothing. Readable modify/delete conflicts
 * require their named Keep file or Accept deletion actions.
 */
export function entryActions(entry: GitStatusEntry, context: ActionContext = {}): EntryActions {
  if (entry.submodule) return NONE
  switch (entry.area) {
    case 'conflicts':
      return (context.unreadableConflicts?.has(entry.path) ||
        (entry.conflict?.kind !== 'deleted_by_us' && entry.conflict?.kind !== 'deleted_by_them')) &&
        entry.conflict?.state === 'unresolved' &&
        context.markersGone?.has(entry.path)
        ? { stage: true, unstage: false, discard: null }
        : NONE
    case 'staged':
      return { stage: false, unstage: true, discard: null }
    case 'unstaged':
      return { stage: true, unstage: false, discard: entry.status === 'deleted' ? 'restore' : 'discard' }
    case 'untracked':
      return { stage: true, unstage: false, discard: 'delete' }
  }
}

/** Whether Stage is offered for the row. */
export const isStageable = (entry: GitStatusEntry, context: ActionContext = {}): boolean =>
  entryActions(entry, context).stage

const discardAllEligible = (e: GitStatusEntry): boolean =>
  !e.submodule && e.area !== 'conflicts'

/** What a bulk or folder action sends: `discard` is per-row eligibility, `discard-all` also takes staged rows. */
export type PathAction = 'stage' | 'unstage' | 'discard' | 'discard-all'

/**
 * The paths to send for `action` over `entries`, skipping ineligible rows. A staged rename
 * contributes its old path as well for unstage and discard-all, so both halves move together.
 */
export function actionPaths(
  entries: readonly GitStatusEntry[],
  action: PathAction,
  context: ActionContext = {}
): string[] {
  const paths: string[] = []
  for (const e of entries) {
    const actions = entryActions(e, context)
    const ok =
      action === 'discard-all' ? discardAllEligible(e) : action === 'discard' ? actions.discard !== null : actions[action]
    if (!ok) continue
    paths.push(e.path)
    if (e.oldPath && e.area === 'staged' && action !== 'stage') paths.push(e.oldPath)
  }
  return paths
}

/** The count and tooltip for the panel toggle's badge. */
export type UncommittedBadge = { count: number; title: string }

/**
 * The uncommitted-change badge, or null when there is nothing to show. A row resolved locally
 * whose path has another row is a duplicate of it and not counted. `capped` adds a plus to the
 * title because the real total is higher.
 */
export function uncommittedBadge(entries: readonly GitStatusEntry[], capped: boolean): UncommittedBadge | null {
  const elsewhere = new Set(entries.filter((e) => e.area !== 'conflicts').map((e) => e.path))
  const count = entries.filter((e) => !(e.conflict?.state === 'resolved_locally' && elsewhere.has(e.path))).length
  if (count === 0) return null
  const amount = capped ? `${count}+` : String(count)
  return { count, title: `Source Control — ${amount} uncommitted ${count === 1 && !capped ? 'change' : 'changes'}` }
}
