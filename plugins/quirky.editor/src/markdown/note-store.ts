import type { EditorServices } from '../types'

export type MarkdownReviewNote = {
  id: string
  bufferId: string
  worktreeId: string
  filePath: string
  source: 'markdown'
  selectedText?: string
  startLine?: number
  endLine?: number
  lineNumber: number
  body: string
  createdAt: number
  updatedAt?: number
  sentAt?: number
  side: 'modified'
}

export type StoredNote = { id: string; buffer_id: string; payload: string }
type MarkdownNoteHold = { worktreeId: string; noteIds: Set<string> }
const markdownNoteHolds = new Map<string, MarkdownNoteHold>()
const markdownHeldNotes = new Map<string, string>()

function heldNoteKey(worktreeId: string, noteId: string): string {
  return `${worktreeId}\0${noteId}`
}

export function isMarkdownReviewNote(value: unknown): value is MarkdownReviewNote {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const note = value as Record<string, unknown>
  const positiveInteger = (item: unknown): item is number =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= 1
  const optionalString = (key: string) => !(key in note) || typeof note[key] === 'string'
  const optionalNumber = (key: string) => !(key in note) || (typeof note[key] === 'number' && Number.isFinite(note[key]))
  const optionalLine = (key: string) => !(key in note) || positiveInteger(note[key])
  return typeof note.id === 'string' && typeof note.bufferId === 'string' &&
    typeof note.worktreeId === 'string' && typeof note.filePath === 'string' &&
    note.source === 'markdown' && positiveInteger(note.lineNumber) &&
    typeof note.body === 'string' && typeof note.createdAt === 'number' && Number.isFinite(note.createdAt) &&
    note.side === 'modified' && optionalString('selectedText') && optionalLine('startLine') &&
    optionalLine('endLine') && optionalNumber('updatedAt') && optionalNumber('sentAt')
}

export function parseNote(host: EditorServices, row: StoredNote): MarkdownReviewNote {
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch {
    throw host.context.error('conflict', 'A saved Markdown review note could not be read.')
  }
  if (!isMarkdownReviewNote(value) || value.id !== row.id || value.bufferId !== row.buffer_id) {
    throw host.context.error('conflict', 'A saved Markdown review note has invalid persisted fields.')
  }
  return value
}

function snapshotKey(note: MarkdownReviewNote): string {
  return JSON.stringify(Object.entries(note).sort(([left], [right]) => left.localeCompare(right)))
}

export function sameSnapshot(left: MarkdownReviewNote, right: MarkdownReviewNote): boolean {
  return snapshotKey(left) === snapshotKey(right)
}

function noteMatchesStore(host: EditorServices, snapshot: MarkdownReviewNote): boolean {
  const row = host.store.get<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes WHERE id = ?', snapshot.id)
  if (!row || row.buffer_id !== snapshot.bufferId) return false
  return sameSnapshot(parseNote(host, row), snapshot)
}

export function reserveSnapshots(host: EditorServices, worktreeId: string, holdId: string, snapshots: MarkdownReviewNote[]) {
  if (markdownNoteHolds.has(holdId)) throw host.context.error('conflict', 'The Markdown note hold is already active.')
  const reservedNoteIds: string[] = []
  const unavailableNoteIds: string[] = []
  const noteIds = new Set<string>()
  for (const snapshot of snapshots) {
    if (noteIds.has(snapshot.id)) throw host.context.error('invalid-params', 'A Markdown note can appear only once in a hold.')
    noteIds.add(snapshot.id)
    if (snapshot.worktreeId !== worktreeId) throw host.context.error('invalid-params', 'A Markdown note snapshot belongs to another worktree.')
    const key = heldNoteKey(worktreeId, snapshot.id)
    if (markdownHeldNotes.has(key) || !noteMatchesStore(host, snapshot)) {
      unavailableNoteIds.push(snapshot.id)
      continue
    }
    reservedNoteIds.push(snapshot.id)
  }
  if (reservedNoteIds.length > 0) {
    markdownNoteHolds.set(holdId, { worktreeId, noteIds: new Set(reservedNoteIds) })
    for (const noteId of reservedNoteIds) markdownHeldNotes.set(heldNoteKey(worktreeId, noteId), holdId)
  }
  return { reservedNoteIds, unavailableNoteIds }
}

export function releaseSnapshots(worktreeId: string, holdId: string): string[] {
  const hold = markdownNoteHolds.get(holdId)
  if (!hold || hold.worktreeId !== worktreeId) return []
  markdownNoteHolds.delete(holdId)
  const releasedNoteIds = [...hold.noteIds]
  for (const noteId of releasedNoteIds) {
    const key = heldNoteKey(worktreeId, noteId)
    if (markdownHeldNotes.get(key) === holdId) markdownHeldNotes.delete(key)
  }
  return releasedNoteIds
}

export function isHeldBy(worktreeId: string, noteId: string, holdId: string): boolean {
  return markdownHeldNotes.get(heldNoteKey(worktreeId, noteId)) === holdId
}

export function sortedNotes(notes: MarkdownReviewNote[]): MarkdownReviewNote[] {
  return notes.sort((left, right) =>
    left.filePath.localeCompare(right.filePath) ||
    (left.startLine ?? left.lineNumber) - (right.startLine ?? right.lineNumber) ||
    (left.endLine ?? left.lineNumber) - (right.endLine ?? right.lineNumber) ||
    left.createdAt - right.createdAt
  )
}

export function readMarkdownNotes(
  host: EditorServices,
  predicate?: (note: MarkdownReviewNote) => boolean
): MarkdownReviewNote[] {
  const rows = host.store.all<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes')
  const notes = rows.map((row) => parseNote(host, row))
  return sortedNotes(predicate ? notes.filter(predicate) : notes)
}
