import type { GitStatusEntry, ReviewFile } from '@quirky/protocol'
import { statusLetter } from './format'

type StatusFacts = {
  entry: GitStatusEntry
  rank: number
  conflict: GitStatusEntry['conflict']
  staged: boolean
  added: number
  addedKnown: boolean
  removed: number
  removedKnown: boolean
  binary: boolean
  submodule: GitStatusEntry['submodule']
}

const AREA_RANK: Readonly<Record<GitStatusEntry['area'], number>> = {
  staged: 0,
  conflicts: 1,
  unstaged: 2,
  untracked: 3
}

function sameConflict(a: ReviewFile['conflict'], b: ReviewFile['conflict']): boolean {
  return a?.kind === b?.kind && a?.state === b?.state
}

/** Projects live conflict rows while retaining review metadata for known files. */
export function withStatusConflicts(files: readonly ReviewFile[], entries: readonly GitStatusEntry[]): readonly ReviewFile[] {
  const hasReviewConflicts = files.some((file) => file.conflict !== undefined)
  const hasLiveConflicts = entries.some((entry) => entry.area === 'conflicts' && entry.conflict !== undefined)
  if (!hasReviewConflicts && !hasLiveConflicts) return files

  const byPath = new Map<string, StatusFacts>()
  for (const entry of entries) {
    const rank = AREA_RANK[entry.area]
    const known = byPath.get(entry.path)
    if (known === undefined) {
      byPath.set(entry.path, {
        entry,
        rank,
        conflict: entry.area === 'conflicts' ? entry.conflict : undefined,
        staged: entry.area === 'staged',
        added: entry.added ?? 0,
        addedKnown: entry.added !== undefined,
        removed: entry.removed ?? 0,
        removedKnown: entry.removed !== undefined,
        binary: entry.binary === true,
        submodule: entry.submodule
      })
      continue
    }

    if (rank < known.rank) {
      known.entry = entry
      known.rank = rank
    }
    if (known.conflict === undefined && entry.area === 'conflicts') known.conflict = entry.conflict
    if (entry.area === 'staged') known.staged = true
    if (entry.added === undefined) known.addedKnown = false
    else known.added += entry.added
    if (entry.removed === undefined) known.removedKnown = false
    else known.removed += entry.removed
    known.binary ||= entry.binary === true
    if (known.submodule === undefined) known.submodule = entry.submodule
  }

  let projected: ReviewFile[] | undefined
  const paths = new Set<string>()
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!
    paths.add(file.path)
    const facts = byPath.get(file.path)
    const liveConflict = facts?.conflict
    if (file.conflict === undefined && liveConflict === undefined) continue

    const conflict = sameConflict(file.conflict, liveConflict) ? file.conflict : liveConflict
    const uncommitted = facts !== undefined
    const staged = facts?.staged ?? false
    if (sameConflict(file.conflict, liveConflict) && file.uncommitted === uncommitted && file.staged === staged) continue

    projected ??= files.slice()
    const updated: ReviewFile = { ...file, uncommitted, staged }
    if (conflict === undefined) delete updated.conflict
    else updated.conflict = conflict
    projected[i] = updated
  }

  for (const facts of byPath.values()) {
    if (facts.conflict === undefined || paths.has(facts.entry.path)) continue
    projected ??= files.slice()
    paths.add(facts.entry.path)
    projected.push({
      path: facts.entry.path,
      ...(facts.entry.oldPath !== undefined ? { oldPath: facts.entry.oldPath } : {}),
      status: statusLetter(facts.entry.status) as ReviewFile['status'],
      added: facts.addedKnown ? facts.added : null,
      removed: facts.removedKnown ? facts.removed : null,
      binary: facts.binary,
      uncommitted: true,
      staged: facts.staged,
      conflict: facts.conflict,
      mark: 'none',
      notes: 0,
      ...(facts.submodule !== undefined ? { submodule: facts.submodule } : {})
    })
  }

  return projected ?? files
}
