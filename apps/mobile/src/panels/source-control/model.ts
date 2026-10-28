export type ReviewNote = {
  id: string
  path: string
  startLine: number
  line: number
  body: string
  createdAt: number
  updatedAt: number | null
}

export type SentReviewNote = ReviewNote & { sentAt: number; targetSession: string }
export type ReviewState = { reviewedPaths: string[]; sentNotes: SentReviewNote[] }
export type ReviewChange = { path: string; area: 'conflicts' | 'staged' | 'unstaged' | 'untracked' }

export const EMPTY_REVIEW_STATE: ReviewState = { reviewedPaths: [], sentNotes: [] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const uniqueStrings = (values: unknown[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))]

export function normalizeReviewState(value: unknown): ReviewState {
  if (!isRecord(value)) return EMPTY_REVIEW_STATE
  const reviewedPaths = Array.isArray(value.reviewedPaths) ? uniqueStrings(value.reviewedPaths) : []
  const sentNotes: SentReviewNote[] = []
  if (Array.isArray(value.sentNotes)) {
    for (const candidate of value.sentNotes) {
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== 'string' ||
        typeof candidate.path !== 'string' ||
        !Number.isSafeInteger(candidate.startLine) ||
        !Number.isSafeInteger(candidate.line) ||
        typeof candidate.body !== 'string' ||
        typeof candidate.createdAt !== 'number' ||
        !(candidate.updatedAt === null || typeof candidate.updatedAt === 'number') ||
        typeof candidate.sentAt !== 'number' ||
        typeof candidate.targetSession !== 'string'
      ) {
        continue
      }
      sentNotes.push(candidate as unknown as SentReviewNote)
    }
  }
  return { reviewedPaths, sentNotes }
}

export function reviewStorageKey(hostId: string, worktreeId: string): string {
  return `quirky.mobile.review.v1.${encodeURIComponent(hostId)}.${encodeURIComponent(worktreeId)}`
}

export function reviewProgress(filePaths: readonly string[], reviewedPaths: readonly string[]): { total: number; reviewed: number; complete: boolean } {
  const files = new Set(filePaths)
  const reviewed = new Set(reviewedPaths)
  let count = 0
  for (const path of files) if (reviewed.has(path)) count += 1
  return { total: files.size, reviewed: count, complete: files.size > 0 && count === files.size }
}

export function toggleReviewedPath(reviewedPaths: readonly string[], path: string): string[] {
  const next = uniqueStrings([...reviewedPaths])
  const index = next.indexOf(path)
  if (index === -1) next.push(path)
  else next.splice(index, 1)
  return next
}

export function stageableReviewedPaths(reviewedPaths: readonly string[], changes: readonly ReviewChange[]): string[] {
  const reviewed = new Set(reviewedPaths)
  const stageable = new Set<string>()
  for (const change of changes) {
    if (reviewed.has(change.path) && (change.area === 'unstaged' || change.area === 'untracked')) stageable.add(change.path)
  }
  return [...stageable]
}

export function moveDiffIndex(index: number, fileCount: number, direction: -1 | 1): number | null {
  if (fileCount <= 0) return null
  const current = Number.isInteger(index) ? Math.max(0, Math.min(fileCount - 1, index)) : 0
  return Math.max(0, Math.min(fileCount - 1, current + direction))
}

export function recordSentNotes(
  state: ReviewState,
  notes: readonly ReviewNote[],
  sentIds: readonly string[],
  targetSession: string,
  sentAt: number
): ReviewState {
  const sent = new Set(sentIds)
  const alreadySent = new Set(state.sentNotes.map((note) => note.id))
  const additions: SentReviewNote[] = []
  for (const note of notes) {
    if (!sent.has(note.id) || alreadySent.has(note.id)) continue
    alreadySent.add(note.id)
    additions.push({ ...note, sentAt, targetSession })
  }
  return additions.length === 0 ? state : { ...state, sentNotes: [...state.sentNotes, ...additions] }
}

export function clearSentNotes(state: ReviewState): ReviewState {
  return state.sentNotes.length === 0 ? state : { ...state, sentNotes: [] }
}

export type ReviewFileSource = 'conflict' | 'staged' | 'unstaged' | 'branch'
export type ReviewFile = {
  path: string
  oldPath?: string
  status: string
  binary: boolean
  source: ReviewFileSource
  areas: ReviewChange['area'][]
}

type ReviewGitEntry = ReviewChange & { oldPath?: string; status?: string; binary?: boolean }
type ReviewBranchChange = { path: string; oldPath?: string; status?: string; binary?: boolean }

const sourcePriority: Record<ReviewFileSource, number> = { staged: 1, unstaged: 2, conflict: 3, branch: 0 }

export function collectReviewFiles(entries: readonly ReviewGitEntry[], branchChanges: readonly ReviewBranchChange[]): ReviewFile[] {
  const byPath = new Map<string, ReviewFile>()
  for (const entry of entries) {
    const source: ReviewFileSource =
      entry.area === 'conflicts' ? 'conflict' : entry.area === 'staged' ? 'staged' : 'unstaged'
    const previous = byPath.get(entry.path)
    const areas = new Set(previous?.areas)
    areas.add(entry.area)
    const oldPath = entry.oldPath ?? previous?.oldPath
    byPath.set(entry.path, {
      path: entry.path,
      ...(oldPath === undefined ? {} : { oldPath }),
      status: entry.status ?? previous?.status ?? 'modified',
      binary: entry.binary ?? previous?.binary ?? false,
      source: previous && sourcePriority[previous.source] > sourcePriority[source] ? previous.source : source,
      areas: [...areas]
    })
  }
  for (const change of branchChanges) {
    if (byPath.has(change.path)) continue
    byPath.set(change.path, {
      path: change.path,
      ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
      status: change.status ?? 'modified',
      binary: change.binary ?? false,
      source: 'branch',
      areas: []
    })
  }
  return [...byPath.values()]
}
