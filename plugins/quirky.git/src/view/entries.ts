import type { GitChange, GitChangeStatus, GitCompare, GitDiffSource, GitStatus } from '@quirky/protocol'
import type { DiffViewInput } from '../shared/view-input'

/** Sections with more changed lines than this wait for a click on "Load diff". */
export const AUTO_LOAD_MAX_LINES = 10_000

/** The sections shown first load at once, without waiting to scroll into view. */
export const EAGER_SECTIONS = 6

/** One file's section in a combined diff. */
export type SectionEntry = {
  /** Unique within the view: a path can appear staged and unstaged. */
  key: string
  path: string
  oldPath?: string
  source: GitDiffSource
  status: GitChangeStatus
  added: number | null
  removed: number | null
  binary: boolean
  submodule: boolean
  /** The full commit id of a commit diff. */
  commit?: string
}

export type Area = NonNullable<DiffViewInput['area']>

const keyOf = (source: GitDiffSource, path: string): string => `${source}:${path}`

/** Why a section waits for a click: it is known to be large, or its size is not known. */
export function loadMode(entry: SectionEntry): 'auto' | 'large' | 'unknown' {
  if (entry.binary || entry.submodule) return 'auto'
  if (entry.added === null || entry.removed === null) return 'unknown'
  return entry.added + entry.removed > AUTO_LOAD_MAX_LINES ? 'large' : 'auto'
}

/**
 * The sections for the uncommitted `areas` of a status, in the order given, plus how many
 * unresolved conflicts were left out because a two-way diff cannot show them.
 */
export function statusSections(
  status: Pick<GitStatus, 'entries'>,
  areas: ReadonlyArray<'staged' | 'unstaged' | 'untracked'>
): { entries: SectionEntry[]; excluded: number } {
  const entries: SectionEntry[] = []
  for (const area of areas) {
    const source: GitDiffSource = area === 'staged' ? 'staged' : 'unstaged'
    for (const row of status.entries.filter((entry) => entry.area === area)) {
      entries.push({
        key: keyOf(source, row.path),
        path: row.path,
        ...(row.oldPath ? { oldPath: row.oldPath } : {}),
        source,
        status: row.status,
        added: row.added ?? null,
        removed: row.removed ?? null,
        binary: row.binary === true,
        submodule: row.submodule !== undefined
      })
    }
  }
  const excluded = status.entries.filter((e) => e.area === 'conflicts' && e.conflict?.state === 'unresolved').length
  return { entries, excluded }
}

/** Sections for changes between two commits: the branch compare, or one commit's files. */
export function changeSections(changes: readonly GitChange[], source: 'branch' | 'commit', commit?: string): SectionEntry[] {
  return changes.map((change) => ({
    key: keyOf(source, change.path),
    path: change.path,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    source,
    status: change.status,
    added: change.added,
    removed: change.removed,
    binary: change.binary,
    submodule: false,
    ...(commit ? { commit } : {})
  }))
}

/** The uncommitted areas a combined diff of `area` covers. */
export function uncommittedAreas(area: Area): Array<'staged' | 'unstaged' | 'untracked'> {
  switch (area) {
    case 'staged':
      return ['staged']
    case 'untracked':
      return ['untracked']
    case 'all':
      return ['staged', 'unstaged', 'untracked']
    case 'unstaged':
      return ['unstaged']
    case 'branch':
      return []
  }
}

/** The heading of a combined diff. */
export function combinedTitle(input: DiffViewInput, compare: Pick<GitCompare, 'base'> | null, commit: string | null): string {
  if (input.commit) return input.title ?? `Commit ${(commit ?? input.commit).slice(0, 7)}`
  switch (input.area ?? 'unstaged') {
    case 'branch':
      return compare?.base ? `Branch Changes (${compare.base})` : (input.title ?? 'Branch Changes')
    case 'staged':
      return input.title ?? 'Staged Changes'
    case 'untracked':
      return input.title ?? 'Untracked Files'
    case 'all':
      return input.title ?? 'All Changes'
    case 'unstaged':
      return input.title ?? 'Changes'
  }
}

/** A signature that changes when a section's file did, so a refresh knows which sections to reload. */
export function entrySignature(entry: SectionEntry): string {
  return [entry.key, entry.oldPath ?? '', entry.status, entry.added, entry.removed, entry.binary].join('|')
}
