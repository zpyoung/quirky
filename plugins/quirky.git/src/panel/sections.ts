import type { GitArea, GitStatusEntry } from '@quirky/protocol'

/** The "Source Control Group Order" setting: how Changes, Staged Changes and Untracked Files are ordered. */
export type GroupOrder = 'changes-first' | 'staged-first' | 'untracked-first'

/** The uncommitted sections; a section id is the `area` of the rows in it. */
export type SectionId = GitArea

/** One section of the panel: its heading, and its rows already sorted for display. */
export type Section = {
  id: SectionId
  /** Heading as written; the window uppercases it with CSS. */
  heading: string
  count: number
  entries: GitStatusEntry[]
}

export const SECTION_HEADINGS: Readonly<Record<SectionId, string>> = {
  conflicts: 'Conflicts',
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files'
}

const ORDER: Readonly<Record<GroupOrder, readonly SectionId[]>> = {
  'changes-first': ['conflicts', 'unstaged', 'staged', 'untracked'],
  'staged-first': ['conflicts', 'staged', 'unstaged', 'untracked'],
  'untracked-first': ['conflicts', 'untracked', 'unstaged', 'staged']
}

const collator = new Intl.Collator('en', { numeric: true })

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const conflictRank = (e: GitStatusEntry): number =>
  e.conflict?.state === 'unresolved' ? 0 : e.conflict?.state === 'resolved_locally' ? 1 : 2

/** Orca's row order: unresolved conflicts, resolved locally, then the rest; ties by natural file name, then path. */
export function compareEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  return (
    conflictRank(a) - conflictRank(b) ||
    collator.compare(baseName(a.path), baseName(b.path)) ||
    collator.compare(a.path, b.path)
  )
}

/**
 * Groups status rows into the sections the panel shows. Conflicts always come first, the rest
 * follow `order`, and empty sections are left out. A path both staged and changed is in two
 * sections. The input is not modified.
 */
export function groupSections(entries: readonly GitStatusEntry[], order: GroupOrder): Section[] {
  const sections: Section[] = []
  for (const id of ORDER[order] ?? ORDER['changes-first']) {
    const rows = entries.filter((e) => e.area === id).sort(compareEntries)
    if (rows.length > 0) sections.push({ id, heading: SECTION_HEADINGS[id], count: rows.length, entries: rows })
  }
  return sections
}

/** Which hover button a row's discard action is: "Discard changes", "Restore file" or "Delete untracked file". */
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
}

/** The hover buttons a row shows; `discard` names which one, or null for none. */
export type EntryActions = { stage: boolean; unstage: boolean; discard: DiscardKind | null }

const NONE: EntryActions = { stage: false, unstage: false, discard: null }

/**
 * Orca's per-row eligibility with logic SC-13 applied. Submodule rows are read-only. Staged rows
 * can only be unstaged (discarding staged work is the section's "Discard all"). A conflict
 * resolved locally is already staged, so it offers nothing. Modify/delete conflicts require
 * their named Keep file or Accept deletion actions.
 */
export function entryActions(entry: GitStatusEntry, context: ActionContext = {}): EntryActions {
  if (entry.submodule) return NONE
  switch (entry.area) {
    case 'conflicts':
      return entry.conflict?.kind !== 'deleted_by_us' &&
        entry.conflict?.kind !== 'deleted_by_them' &&
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

/** The section header buttons of SC-14; every field is hidden (false/null) while the filter is active. */
export type SectionButtons = {
  discardAll: { label: 'Discard all' | 'Delete all untracked' } | null
  stageAll: boolean
  unstageAll: boolean
  /** Opens the combined diff of the section, or the conflict review for conflicts. */
  viewAll: boolean
}

export type SectionButtonOptions = ActionContext & {
  /** The status stopped at its entry limit: Stage all is withheld for untracked files. */
  capped?: boolean
  filtering?: boolean
}

export function sectionButtons(section: Section, options: SectionButtonOptions = {}): SectionButtons {
  if (options.filtering) return { discardAll: null, stageAll: false, unstageAll: false, viewAll: false }
  const rows = section.entries
  const discardable = rows.some((e) => discardAllEligible(e))
  return {
    discardAll: discardable ? { label: section.id === 'untracked' ? 'Delete all untracked' : 'Discard all' } : null,
    stageAll: !(section.id === 'untracked' && options.capped) && rows.some((e) => isStageable(e, options)),
    unstageAll: rows.some((e) => entryActions(e).unstage),
    viewAll: true
  }
}

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
