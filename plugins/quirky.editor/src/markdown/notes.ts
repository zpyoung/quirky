import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import type { EditorBuffer, EditorServices } from '../types'
import type { PluginCaller, Session } from '@quirky/protocol'
import { MARKDOWN_MAX_NOTE_BODY_BYTES, MARKDOWN_MAX_NOTES_SOURCE_BYTES, MARKDOWN_MAX_NOTE_SELECTION_BYTES, sourceLineAtOffset, splitFrontMatter, utf8Bytes } from './source'
import { makeDiff } from '@sanity/diff-match-patch'
import { serializeMarkdown } from './tiptap'

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

type StoredNote = { id: string; buffer_id: string; payload: string }
type Selection = { from?: number; to?: number; text?: string; startLine?: number; endLine?: number; mode?: 'source' | 'rich' }
type NotePayload = Record<string, unknown> & { action?: string; bufferId?: string; noteId?: string; text?: string; worktree?: string; path?: string; holdId?: string; snapshots?: unknown }
type SendResult = {
  delivery: 'pasted' | 'unconfirmed' | 'not-delivered' | 'command-line'
  deletedNoteIds: string[]
  retainedNoteIds: string[]
  sessionId?: string
  error?: string
}
type MarkdownNoteHold = { worktreeId: string; noteIds: Set<string> }
const markdownNoteHolds = new Map<string, MarkdownNoteHold>()
const markdownHeldNotes = new Map<string, string>()

function heldNoteKey(worktreeId: string, noteId: string): string {
  return `${worktreeId}\0${noteId}`
}

function currentContent(buffer: EditorBuffer): string {
  return buffer.draft !== null ? buffer.draft : buffer.content
}

function isMarkdownReviewNote(value: unknown): value is MarkdownReviewNote {
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

function parseNote(host: EditorServices, row: StoredNote): MarkdownReviewNote {
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

function sameSnapshot(left: MarkdownReviewNote, right: MarkdownReviewNote): boolean {
  return snapshotKey(left) === snapshotKey(right)
}

function noteMatchesStore(host: EditorServices, snapshot: MarkdownReviewNote): boolean {
  const row = host.store.get<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes WHERE id = ?', snapshot.id)
  if (!row || row.buffer_id !== snapshot.bufferId) return false
  return sameSnapshot(parseNote(host, row), snapshot)
}

function reserveSnapshots(host: EditorServices, worktreeId: string, holdId: string, snapshots: MarkdownReviewNote[]) {
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

function releaseSnapshots(worktreeId: string, holdId: string): string[] {
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

function sortedNotes(notes: MarkdownReviewNote[]): MarkdownReviewNote[] {
  return notes.sort((left, right) =>
    left.filePath.localeCompare(right.filePath) ||
    (left.startLine ?? left.lineNumber) - (right.startLine ?? right.lineNumber) ||
    (left.endLine ?? left.lineNumber) - (right.endLine ?? right.lineNumber) ||
    left.createdAt - right.createdAt
  )
}

function noteBuffer(host: EditorServices, params: NotePayload): EditorBuffer {
  if (typeof params.bufferId !== 'string' || params.bufferId === '') throw host.context.error('invalid-params', 'bufferId is required.')
  const buffer = host.get(params.bufferId)
  if (buffer.kind !== 'markdown') throw host.context.error('invalid-params', 'Review notes are available only for Markdown files.')
  if (utf8Bytes(currentContent(buffer)) > MARKDOWN_MAX_NOTES_SOURCE_BYTES) {
    throw host.context.error('invalid-params', 'Review notes are unavailable for Markdown files larger than the 8 MiB note limit.')
  }
  return buffer
}

function writableBuffer(host: EditorServices, params: NotePayload): EditorBuffer {
  const buffer = noteBuffer(host, params)
  if (buffer.readOnly) throw host.context.error('invalid-params', 'Review notes cannot be changed for a read-only Markdown file.')
  return buffer
}

function readNotes(host: EditorServices, buffer: EditorBuffer): MarkdownReviewNote[] {
  const rows = host.store.all<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes')
  return sortedNotes(rows.map((row) => parseNote(host, row)).filter((note) =>
    note.worktreeId === buffer.worktreeId && note.filePath === buffer.relativePath
  ))
}

function storedPayload(note: MarkdownReviewNote): string {
  return JSON.stringify(note)
}

function escapeComment(body: string): string {
  return body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

function excerptLines(note: MarkdownReviewNote, source: string): string[] {
  if (note.selectedText !== undefined) return note.selectedText.split(/\r?\n/)
  const lines = source.split(/\r?\n/)
  const start = Math.max(1, note.startLine ?? note.lineNumber)
  const end = Math.max(start, note.endLine ?? note.lineNumber)
  return lines.slice(start - 1, end)
}

export function formatMarkdownReviewNotes(notes: MarkdownReviewNote[], sourceByPath: ReadonlyMap<string, string>): string {
  const groups: string[] = []
  let currentPath: string | null = null
  let currentLines: string[] = []
  const flush = () => {
    if (currentPath !== null) groups.push(`File: ${currentPath}\nSource: markdown\n\n${currentLines.join('\n\n')}`)
  }
  for (const note of sortedNotes([...notes])) {
    if (note.filePath !== currentPath) {
      flush()
      currentPath = note.filePath
      currentLines = []
    }
    const startLine = note.startLine ?? note.lineNumber
    const endLine = note.endLine ?? note.lineNumber
    const span = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`
    const excerpt = excerptLines(note, sourceByPath.get(note.filePath) ?? '').map((line) => `> ${line}`)
    if (excerpt.length > 8) excerpt.splice(4, excerpt.length - 8, '> ...')
    currentLines.push(`${span}\nExcerpt:\n${excerpt.join('\n')}\nUser comment: "${escapeComment(note.body)}"`)
  }
  flush()
  return groups.join('\n\n')
}

function sourceOffsetsFromCanonical(source: string, canonical: string, offsets: [number, number]): [number, number] {
  if (source === canonical) return offsets
  const targets = [...new Set(offsets)].sort((left, right) => left - right)
  const mapped = new Map<number, number>()
  const diffs = makeDiff(canonical, source, { checkLines: true, timeout: 0.01 })
  let targetIndex = 0
  let canonicalOffset = 0
  let sourceOffset = 0
  for (const [operation, text] of diffs) {
    if (operation === 1) {
      sourceOffset += text.length
      continue
    }
    if (operation === -1) {
      while (targetIndex < targets.length && targets[targetIndex]! < canonicalOffset + text.length) {
        mapped.set(targets[targetIndex]!, sourceOffset)
        targetIndex += 1
      }
      canonicalOffset += text.length
      continue
    }
    while (targetIndex < targets.length && targets[targetIndex]! < canonicalOffset + text.length) {
      mapped.set(targets[targetIndex]!, sourceOffset + targets[targetIndex]! - canonicalOffset)
      targetIndex += 1
    }
    canonicalOffset += text.length
    sourceOffset += text.length
  }
  while (targetIndex < targets.length) {
    mapped.set(targets[targetIndex]!, sourceOffset)
    targetIndex += 1
  }
  return [mapped.get(offsets[0])!, mapped.get(offsets[1])!]
}

function selectedRange(host: EditorServices, buffer: EditorBuffer, value: unknown): { selectedText: string; startLine: number; endLine: number; lineNumber: number } {
  if (!value || typeof value !== 'object') throw host.context.error('invalid-params', 'selection with source offsets or rich text/line span is required.')
  const selection = value as Selection
  const source = currentContent(buffer)
  const frontMatter = splitFrontMatter(source)
  const rich = selection.mode !== 'source'
  const selectedSource = rich ? frontMatter.body : source
  let from: number
  let to: number
  let excerpt: string
  if (Number.isInteger(selection.from) && Number.isInteger(selection.to)) {
    const selectedFrom = selection.from!
    const selectedTo = selection.to!
    if (rich) {
      const canonical = serializeMarkdown(selectedSource)
      if (canonical === null || selectedFrom < 0 || selectedTo <= selectedFrom || selectedTo > canonical.length) {
        throw host.context.error('invalid-params', 'Selection must be a non-empty rich Markdown range inside the current document.')
      }
      const [sourceFrom, sourceTo] = sourceOffsetsFromCanonical(selectedSource, canonical, [selectedFrom, selectedTo])
      from = sourceFrom
      to = sourceTo
      excerpt = canonical.slice(selectedFrom, selectedTo)
    } else {
      from = selectedFrom
      to = selectedTo
      if (from < 0 || to <= from || to > selectedSource.length) throw host.context.error('invalid-params', 'Selection must be a non-empty source range inside the current Markdown document.')
      excerpt = selectedSource.slice(from, to)
    }
  } else if (rich && typeof selection.text === 'string' && Number.isInteger(selection.startLine) && Number.isInteger(selection.endLine)) {
    const normalized = selectedSource.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    const startLine = selection.startLine!
    const endLine = selection.endLine!
    if (startLine < 1 || endLine < startLine || endLine > lines.length) throw host.context.error('invalid-params', 'Rich selection line span is outside the Markdown document.')
    const starts = [0]
    for (let i = 0; i < normalized.length; i += 1) if (normalized.charCodeAt(i) === 10) starts.push(i + 1)
    const normalizedFrom = starts[startLine - 1]!
    const normalizedTo = endLine < starts.length ? starts[endLine]! - 1 : normalized.length
    const text = selection.text.replace(/\r\n/g, '\n')
    const matchAt = normalized.indexOf(text, normalizedFrom)
    if (text === '' || matchAt < normalizedFrom || matchAt + text.length > normalizedTo) {
      throw host.context.error('invalid-params', 'Selected rich text does not match the document lines.')
    }
    const originalOffset = (normalizedOffset: number) => {
      let sourceOffset = 0
      let current = 0
      while (current < normalizedOffset && sourceOffset < selectedSource.length) {
        if (selectedSource[sourceOffset] === '\r' && selectedSource[sourceOffset + 1] === '\n') sourceOffset += 1
        sourceOffset += 1
        current += 1
      }
      return sourceOffset
    }
    from = originalOffset(matchAt)
    to = originalOffset(matchAt + text.length)
    excerpt = selection.text
  } else {
    throw host.context.error('invalid-params', 'selection with source offsets or rich text/line span is required.')
  }
  if (utf8Bytes(excerpt) > MARKDOWN_MAX_NOTE_SELECTION_BYTES) {
    throw host.context.error('invalid-params', 'Selected excerpt is too large to submit safely.')
  }
  const startLine = (rich ? frontMatter.lineCount : 0) + sourceLineAtOffset(selectedSource, from)
  const endOffset = Math.max(from, to - 1)
  const endLine = (rich ? frontMatter.lineCount : 0) + sourceLineAtOffset(selectedSource, endOffset)
  return { selectedText: excerpt, startLine, endLine, lineNumber: endLine }
}

function requireText(host: EditorServices, params: NotePayload): string {
  if (typeof params.text !== 'string' || params.text.trim() === '') throw host.context.error('invalid-params', 'Note text is required.')
  if (utf8Bytes(params.text) > MARKDOWN_MAX_NOTE_BODY_BYTES) throw host.context.error('invalid-params', 'Comment is too large to submit safely.')
  return params.text
}

function noteIdsForSend(notes: MarkdownReviewNote[], params: NotePayload): MarkdownReviewNote[] {
  if (params.noteIds === undefined) return notes
  if (!Array.isArray(params.noteIds) || params.noteIds.some((id) => typeof id !== 'string')) return []
  const requested = new Set(params.noteIds as string[])
  return notes.filter((note) => requested.has(note.id))
}

function saveNote(host: EditorServices, note: MarkdownReviewNote): void {
  host.store.run(
    'INSERT INTO editor_notes (id, buffer_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET buffer_id = excluded.buffer_id, payload = excluded.payload',
    note.id,
    note.bufferId,
    storedPayload(note)
  )
  host.emit()
}

function deleteSnapshot(host: EditorServices, snapshot: MarkdownReviewNote[]): string[] {
  const deleted = host.store.transaction(() => {
    const ids: string[] = []
    for (const note of snapshot) {
      const row = host.store.get<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes WHERE id = ?', note.id)
      if (!row || row.buffer_id !== note.bufferId || !sameSnapshot(parseNote(host, row), note)) continue
      const result = host.store.run(
        'DELETE FROM editor_notes WHERE id = ? AND buffer_id = ? AND payload = ?',
        note.id,
        note.bufferId,
        row.payload
      )
      if (result.changes > 0) ids.push(note.id)
    }
    return ids
  })
  if (deleted.length > 0) host.emit()
  return deleted
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sendNotes(host: EditorServices, buffer: EditorBuffer, snapshot: MarkdownReviewNote[], params: NotePayload): Promise<SendResult> {
  if (snapshot.length === 0) return { delivery: 'not-delivered', deletedNoteIds: [], retainedNoteIds: [], error: 'No Markdown review notes are available to send.' }
  const holdId = randomUUID()
  const reservation = reserveSnapshots(host, buffer.worktreeId, holdId, snapshot)
  const reservedIds = new Set(reservation.reservedNoteIds)
  const selected = snapshot.filter((note) => reservedIds.has(note.id))
  if (selected.length === 0) {
    return {
      delivery: 'not-delivered',
      deletedNoteIds: [],
      retainedNoteIds: snapshot.map((note) => note.id),
      error: 'The selected Markdown notes are already being sent or have changed.'
    }
  }
  const unavailable = reservation.unavailableNoteIds
  const prompt = formatMarkdownReviewNotes(selected, new Map([[buffer.relativePath, currentContent(buffer)]]))
  const target = params.target
  let outcome: SendResult['delivery'] = 'not-delivered'
  let sessionId: string | undefined
  try {
    try {
      if (target === 'existing') {
        if (typeof params.sessionId !== 'string' || params.sessionId === '') throw new Error('Choose a running agent session.')
        const session = await host.context.call('quirky.session/get', { session: params.sessionId }) as Session
        if (session.kind !== 'terminal' || session.status === 'exited') throw new Error(`Agent session ${params.sessionId} is not running.`)
        if (typeof params.agent === 'string' && params.agent !== session.agent) throw new Error('The selected agent does not own this session.')
        const result = await host.context.call('quirky.agents/deliver', {
          sessionId: session.id,
          agent: session.agent,
          text: prompt,
          submit: true
        }) as { delivery?: string }
        outcome = result.delivery === 'pasted' ? 'pasted' : result.delivery === 'unconfirmed' ? 'unconfirmed' : 'not-delivered'
        sessionId = session.id
      } else if (target === 'new') {
        if (typeof params.agent !== 'string' || params.agent === '') throw new Error('Choose an agent to launch.')
        const session = await host.context.call('quirky.session/create', {
          worktree: `id:${buffer.worktreeId}`,
          agent: params.agent,
          prompt,
          submitPrompt: true,
          waitForPrompt: true
        }) as Session
        sessionId = session.id
        if (session.promptDelivery === 'command-line') outcome = 'command-line'
        else if (session.promptDelivery === 'pasted') outcome = 'pasted'
        else if (session.promptDelivery === 'unconfirmed') outcome = 'unconfirmed'
      } else {
        throw new Error('target must be existing or new.')
      }
    } catch (error) {
      return {
        delivery: 'not-delivered',
        deletedNoteIds: [],
        retainedNoteIds: snapshot.map((note) => note.id),
        error: errorMessage(error),
        ...(sessionId ? { sessionId } : {})
      }
    }
    const confirmed = outcome === 'pasted' || outcome === 'command-line'
    const deletedNoteIds = confirmed ? deleteSnapshot(host, selected) : []
    const deleted = new Set(deletedNoteIds)
    return {
      delivery: outcome,
      deletedNoteIds,
      retainedNoteIds: [...unavailable, ...selected.filter((note) => !deleted.has(note.id)).map((note) => note.id)],
      ...(sessionId ? { sessionId } : {}),
      ...(!confirmed ? { error: outcome === 'unconfirmed' ? 'The agent did not confirm readiness; notes were retained.' : 'The agent did not accept the notes; they were retained.' } : {})
    }
  } finally {
    releaseSnapshots(buffer.worktreeId, holdId)
  }
}

export function createMarkdownNotesMethod(host: EditorServices): (params: Record<string, unknown>, caller: PluginCaller) => Promise<unknown> {
  return async (rawParams, _caller) => {
    const params = rawParams as NotePayload
    const buffer = noteBuffer(host, params)
    if (params.action === 'list') {
      const result = readNotes(host, buffer)
      return { notes: result, count: result.length }
    }
    if (params.action === 'add') {
      const editable = writableBuffer(host, params)
      const range = selectedRange(host, editable, params.selection)
      const body = requireText(host, params)
      const now = Date.now()
      const note: MarkdownReviewNote = {
        id: randomUUID(),
        bufferId: editable.id,
        worktreeId: editable.worktreeId,
        filePath: editable.relativePath,
        source: 'markdown',
        selectedText: range.selectedText,
        startLine: range.startLine,
        endLine: range.endLine,
        lineNumber: range.lineNumber,
        body,
        createdAt: now,
        side: 'modified'
      }
      saveNote(host, note)
      return { note }
    }
    if (params.action === 'edit') {
      const editable = writableBuffer(host, params)
      if (typeof params.noteId !== 'string') throw host.context.error('invalid-params', 'noteId is required.')
      const note = readNotes(host, editable).find((item) => item.id === params.noteId)
      if (!note) throw host.context.error('not-found', `Markdown note ${params.noteId} was not found.`)
      const updated = { ...note, bufferId: editable.id, body: requireText(host, params), updatedAt: Date.now() }
      saveNote(host, updated)
      return { note: updated }
    }
    if (params.action === 'delete') {
      const editable = writableBuffer(host, params)
      if (typeof params.noteId !== 'string') throw host.context.error('invalid-params', 'noteId is required.')
      const note = readNotes(host, editable).find((item) => item.id === params.noteId)
      if (!note) throw host.context.error('not-found', `Markdown note ${params.noteId} was not found.`)
      const row = host.store.get<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes WHERE id = ?', note.id)
      if (!row || row.buffer_id !== note.bufferId || !sameSnapshot(parseNote(host, row), note)) {
        throw host.context.error('not-found', `Markdown note ${params.noteId} was not found.`)
      }
      const result = host.store.run(
        'DELETE FROM editor_notes WHERE id = ? AND buffer_id = ? AND payload = ?',
        note.id,
        note.bufferId,
        row.payload
      )
      if (result.changes === 0) throw host.context.error('not-found', `Markdown note ${params.noteId} was not found.`)
      host.emit()
      return { deleted: true, noteId: params.noteId }
    }
    if (params.action === 'copy') {
      const available = readNotes(host, buffer)
      const selected = noteIdsForSend(available, params)
      const text = formatMarkdownReviewNotes(selected, new Map([[buffer.relativePath, currentContent(buffer)]]))
      return { text, count: selected.length, noteIds: selected.map((note) => note.id) }
    }
    if (params.action === 'send') {
      const available = readNotes(host, buffer)
      const snapshot = noteIdsForSend(available, params)
      return sendNotes(host, buffer, snapshot, params)
    }
    throw host.context.error('invalid-params', 'notes action must be list, add, edit, delete, copy or send.')
  }
}
type WorkspaceNoteScope = { worktreeId: string; path?: string }

async function workspaceNoteScope(host: EditorServices, params: NotePayload, caller: PluginCaller): Promise<WorkspaceNoteScope> {
  if (params.worktree !== undefined && typeof params.worktree !== 'string') {
    throw host.context.error('invalid-params', 'worktree must be a string.')
  }
  const worktree = await host.resolve(params.worktree, caller)
  if (params.path === undefined) return { worktreeId: worktree.id }
  if (typeof params.path !== 'string' || isAbsolute(params.path)) {
    throw host.context.error('invalid-params', 'path must be a worktree-relative path.')
  }
  const absolute = await host.path(worktree.id, params.path, { create: true })
  const path = relative(worktree.path, absolute)
  if (path === '' || path === '.' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw host.context.error('invalid-params', 'path must name a file inside the worktree.')
  }
  return { worktreeId: worktree.id, path }
}

function workspaceSnapshotList(host: EditorServices, value: unknown, scope: WorkspaceNoteScope): MarkdownReviewNote[] {
  if (!Array.isArray(value)) throw host.context.error('invalid-params', 'snapshots must be an array of Markdown review notes.')
  const snapshots: MarkdownReviewNote[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isMarkdownReviewNote(item)) throw host.context.error('invalid-params', 'snapshots must contain complete persisted Markdown review notes.')
    if (item.worktreeId !== scope.worktreeId) throw host.context.error('invalid-params', 'A Markdown note snapshot belongs to another worktree.')
    if (scope.path !== undefined && item.filePath !== scope.path) throw host.context.error('invalid-params', 'A Markdown note snapshot is outside the requested path.')
    if (ids.has(item.id)) throw host.context.error('invalid-params', 'A Markdown note snapshot can appear only once.')
    ids.add(item.id)
    snapshots.push(item)
  }
  return snapshots
}

function workspaceNotesFor(host: EditorServices, scope: WorkspaceNoteScope): MarkdownReviewNote[] {
  const rows = host.store.all<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes')
  return sortedNotes(rows.map((row) => parseNote(host, row)).filter((note) =>
    note.worktreeId === scope.worktreeId && (scope.path === undefined || note.filePath === scope.path)
  ))
}

function settleWorkspaceSnapshots(
  host: EditorServices,
  scope: WorkspaceNoteScope,
  snapshots: MarkdownReviewNote[],
  holdId?: string
): { deletedNoteIds: string[]; retainedNoteIds: string[] } {
  const result = host.store.transaction(() => {
    const deletedNoteIds: string[] = []
    const retainedNoteIds: string[] = []
    for (const snapshot of snapshots) {
      const row = host.store.get<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes WHERE id = ?', snapshot.id)
      if (!row) {
        retainedNoteIds.push(snapshot.id)
        continue
      }
      const current = parseNote(host, row)
      const key = heldNoteKey(scope.worktreeId, snapshot.id)
      if (row.buffer_id !== snapshot.bufferId || current.worktreeId !== scope.worktreeId ||
        (scope.path !== undefined && current.filePath !== scope.path) ||
        !sameSnapshot(current, snapshot) ||
        (holdId !== undefined && markdownHeldNotes.get(key) !== holdId)) {
        retainedNoteIds.push(snapshot.id)
        continue
      }
      const deletion = host.store.run(
        'DELETE FROM editor_notes WHERE id = ? AND buffer_id = ? AND payload = ?',
        snapshot.id,
        snapshot.bufferId,
        row.payload
      )
      if (deletion.changes > 0) deletedNoteIds.push(snapshot.id)
      else retainedNoteIds.push(snapshot.id)
    }
    return { deletedNoteIds, retainedNoteIds }
  })
  if (result.deletedNoteIds.length > 0) host.emit()
  return result
}

export function createWorkspaceNotesMethod(host: EditorServices): (params: Record<string, unknown>, caller: PluginCaller) => Promise<unknown> {
  return async (rawParams, caller) => {
    const params = rawParams as NotePayload
    if (params.action !== 'list' && params.action !== 'reserve' && params.action !== 'release' && params.action !== 'settle') {
      throw host.context.error('invalid-params', 'workspaceNotes action must be list, reserve, release or settle.')
    }
    const scope = await workspaceNoteScope(host, params, caller)
    if (params.action === 'list') return { notes: workspaceNotesFor(host, scope) }
    if (params.action === 'release') {
      if (typeof params.holdId !== 'string' || params.holdId === '') throw host.context.error('invalid-params', 'holdId is required.')
      return { releasedNoteIds: releaseSnapshots(scope.worktreeId, params.holdId) }
    }
    const snapshots = workspaceSnapshotList(host, params.snapshots, scope)
    if (params.action === 'reserve') {
      if (typeof params.holdId !== 'string' || params.holdId === '') throw host.context.error('invalid-params', 'holdId is required.')
      return reserveSnapshots(host, scope.worktreeId, params.holdId, snapshots)
    }
    if (params.holdId !== undefined && (typeof params.holdId !== 'string' || params.holdId === '')) {
      throw host.context.error('invalid-params', 'holdId must be a non-empty string.')
    }
    return settleWorkspaceSnapshots(host, scope, snapshots, params.holdId)
  }
}
