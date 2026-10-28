import { RpcErrorCode, type PluginStore, type Worktree } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'
import { formatNotes as formatPrompt } from './notes-format'
import { containedPath } from './paths'
import { listMarkdownNotes, settleMarkdownNotes, type MarkdownNoteSnapshot, type MarkdownShelfNote } from './note-bridge'

/** The common shelf shape for diff notes and editor-owned Markdown notes. */
export type Note = {
  id: string
  worktreeId: string
  path: string
  startLine: number
  line: number
  body: string
  createdAt: number
  updatedAt: number | null
  source?: 'markdown'
  markdownSnapshot?: MarkdownNoteSnapshot
}
type NoteRow = {
  id: string
  worktree_id: string
  path: string
  start_line: number
  line: number
  body: string
  created_at: number
  updated_at: number | null
}

const toNote = (row: NoteRow): Note => ({
  id: row.id,
  worktreeId: row.worktree_id,
  path: row.path,
  startLine: row.start_line,
  line: row.line,
  body: row.body,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const sameNote = (a: Note, b: Note): boolean =>
  a.id === b.id && a.body === b.body && a.path === b.path && a.startLine === b.startLine && a.line === b.line

/** The `notes` table: every read and write of stored diff notes goes through here. */
export class NotesStore {
  constructor(private readonly store: PluginStore) {}

  /** A worktree's notes sorted by path, line, start line and creation time; only `path` when given. */
  list(worktreeId: string, path?: string): Note[] {
    const rows =
      path === undefined
        ? this.store.all<NoteRow>('SELECT * FROM notes WHERE worktree_id = ? ORDER BY path, line, start_line, created_at', worktreeId)
        : this.store.all<NoteRow>(
            'SELECT * FROM notes WHERE worktree_id = ? AND path = ? ORDER BY path, line, start_line, created_at',
            worktreeId,
            path
          )
    return rows.map(toNote)
  }

  get(worktreeId: string, id: string): Note | null {
    const row = this.store.get<NoteRow>('SELECT * FROM notes WHERE worktree_id = ? AND id = ?', worktreeId, id)
    return row ? toNote(row) : null
  }

  insert(note: Note): void {
    this.store.run(
      'INSERT INTO notes (id, worktree_id, path, start_line, line, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      note.id,
      note.worktreeId,
      note.path,
      note.startLine,
      note.line,
      note.body,
      note.createdAt,
      note.updatedAt
    )
  }

  setBody(id: string, body: string, updatedAt: number): void {
    this.store.run('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?', body, updatedAt, id)
  }

  remove(id: string): void {
    this.store.run('DELETE FROM notes WHERE id = ?', id)
  }

  /** Deletes a worktree's notes, or only those of `path`; returns how many went. */
  clear(worktreeId: string, path?: string): number {
    const { changes } =
      path === undefined
        ? this.store.run('DELETE FROM notes WHERE worktree_id = ?', worktreeId)
        : this.store.run('DELETE FROM notes WHERE worktree_id = ? AND path = ?', worktreeId, path)
    return changes
  }

  /**
   * Finishes a send: deletes each of `picked` whose stored row still equals what was sent. A note
   * that was edited meanwhile stays and is `kept`; one that is already gone counts as `sent`.
   */
  settle(worktreeId: string, picked: readonly Note[]): { sent: string[]; kept: string[] } {
    return this.store.transaction(() => {
      const sent: string[] = []
      const kept: string[] = []
      for (const snapshot of picked) {
        const current = this.get(worktreeId, snapshot.id)
        if (current === null) sent.push(snapshot.id)
        else if (sameNote(current, snapshot)) {
          this.remove(snapshot.id)
          sent.push(snapshot.id)
        } else kept.push(snapshot.id)
      }
      return { sent, kept }
    })
  }
}

/** The notes that running sends have taken, per worktree, so no other send takes them. */
export class NoteHolds {
  private readonly held = new Map<string, Set<string>>()

  has(worktreeId: string, noteId: string): boolean {
    return this.held.get(worktreeId)?.has(noteId) ?? false
  }

  add(worktreeId: string, ids: readonly string[]): void {
    const set = this.held.get(worktreeId) ?? new Set<string>()
    for (const id of ids) set.add(id)
    this.held.set(worktreeId, set)
  }

  release(worktreeId: string, ids: readonly string[]): void {
    const set = this.held.get(worktreeId)
    if (!set) return
    for (const id of ids) set.delete(id)
    if (set.size === 0) this.held.delete(worktreeId)
  }
}

const MAX_BODY_BYTES = 65_536
const LINES_MESSAGE = 'Lines must be whole numbers from 1, with the start at or before the end.'

const plural = (count: number): string => `${count} ${count === 1 ? 'note' : 'notes'}`

function validLines(env: DaemonEnv, params: Record<string, any>): { startLine: number; line: number } {
  const { line } = params
  const startLine = params.startLine ?? line
  const whole = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1
  if (!whole(line) || !whole(startLine) || startLine > line) throw env.errors.reasoned('invalid-params', 'invalid-lines', LINES_MESSAGE)
  return { startLine, line }
}

function validBody(env: DaemonEnv, body: unknown): string {
  const trimmed = String(body).trim()
  if (trimmed === '') throw env.errors.reasoned('invalid-params', 'empty-note', 'Note is empty.')
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_BODY_BYTES) {
    throw env.errors.reasoned('invalid-params', 'too-large', 'Comment is too large to submit safely.')
  }
  return trimmed
}

const noSuchNote = (env: DaemonEnv, id: string): Error => env.errors.reasoned('not-found', 'no-note', `There is no note ${id} in this worktree.`)

type NoteScope = { worktree: Worktree; path: string | undefined }

/** The worktree a call names and the notes in its path scope; a path need not exist on disk. */
async function scoped(env: DaemonEnv, params: Record<string, any>, caller: Parameters<Handler>[1]): Promise<NoteScope> {
  const worktree = await env.resolve(params, caller)
  const path = params.path === undefined ? undefined : (await containedPath(worktree.path, params.path)).rel
  return { worktree, path }
}
export async function listMixedNotes(env: DaemonEnv, worktree: Worktree, path?: string): Promise<Note[]> {
  const markdownNotes = await listMarkdownNotes(env, worktree, path)
  return [...env.notes.list(worktree.id, path), ...markdownNotes].sort((left, right) =>
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
    left.line - right.line ||
    left.startLine - right.startLine ||
    left.createdAt - right.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}
function markdownNoteResult(note: MarkdownShelfNote): Note {
  return {
    id: note.id,
    worktreeId: note.worktreeId,
    path: note.path,
    startLine: note.startLine,
    line: note.line,
    body: note.body,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  }
}

async function findMarkdownNote(env: DaemonEnv, worktree: Worktree, id: string): Promise<MarkdownShelfNote | null> {
  if (!id.startsWith('markdown:')) return null
  return (await listMarkdownNotes(env, worktree)).find((note) => note.id === id) ?? null
}

async function openMarkdownNoteBuffer(env: DaemonEnv, worktree: Worktree, note: MarkdownShelfNote): Promise<string> {
  const opened = await env.context.call('quirky.editor/open', {
    worktree: `id:${worktree.id}`,
    path: note.path,
    mode: 'source',
    line: note.startLine,
    focus: false
  })
  if (opened === null || typeof opened !== 'object' || Array.isArray(opened) || !('id' in opened) || typeof opened.id !== 'string') {
    throw new Error('quirky.editor/open returned no Markdown buffer ID.')
  }
  return opened.id
}

/** Announces `notesChanged` so every window showing the worktree reads its notes again. */
export function announce(env: DaemonEnv, worktreeId: string): void {
  env.context.emit('notesChanged', { worktreeId })
}

/** Lists a worktree's notes; a worktree that no longer exists has its notes dropped here. */
export function notes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    let scope: NoteScope
    try {
      scope = await scoped(env, params, caller)
    } catch (error) {
      if ((error as { code?: number } | null)?.code === RpcErrorCode.NotFound && typeof params.worktree === 'string') {
        env.notes.clear(params.worktree.replace(/^id:/, ''))
      }
      throw error
    }
    return { notes: await listMixedNotes(env, scope.worktree, scope.path) }
  }
}

/** Stores a note on lines of the modified side of a path; refuses bad lines, blank or oversize text and paths outside the worktree. */
export function addNote(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const lines = validLines(env, params)
    const body = validBody(env, params.body)
    const { worktree, path } = await scoped(env, params, caller)
    const note: Note = { id: `note_${crypto.randomUUID()}`, worktreeId: worktree.id, path: path!, ...lines, body, createdAt: Date.now(), updatedAt: null }
    env.notes.insert(note)
    announce(env, worktree.id)
    return { note }
  }
}

/** Replaces a Git note's text, or routes a Markdown note edit to its owning editor API. */
export function editNote(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const body = validBody(env, params.body)
    if (typeof params.id !== 'string') throw env.errors.reasoned('invalid-params', 'missing-id', 'Note ID is required.')
    const worktree = await env.resolve(params, caller)
    const existing = env.notes.get(worktree.id, params.id)
    if (existing !== null) {
      env.notes.setBody(params.id, body, Date.now())
      announce(env, worktree.id)
      return { note: env.notes.get(worktree.id, params.id)! }
    }
    const markdown = await findMarkdownNote(env, worktree, params.id)
    if (!markdown) throw noSuchNote(env, params.id)
    const bufferId = await openMarkdownNoteBuffer(env, worktree, markdown)
    await env.context.call('quirky.editor/notes', {
      action: 'edit',
      bufferId,
      noteId: markdown.markdownSnapshot.id,
      text: body
    })
    const updated = await findMarkdownNote(env, worktree, params.id)
    if (!updated) throw env.errors.reasoned('conflict', 'markdown-note-changed', 'Markdown note could not be read after editing.')
    announce(env, worktree.id)
    return { note: markdownNoteResult(updated) }
  }
}
/** Deletes one note, even while a send holds it; the send then reports it as already gone. */
export function deleteNote(env: DaemonEnv): Handler {
  return async (params, caller) => {
    if (typeof params.id !== 'string') throw env.errors.reasoned('invalid-params', 'missing-id', 'Note ID is required.')
    const worktree = await env.resolve(params, caller)
    if (env.notes.get(worktree.id, params.id) !== null) {
      env.notes.remove(params.id)
      announce(env, worktree.id)
      return { ok: true }
    }
    const markdown = await findMarkdownNote(env, worktree, params.id)
    if (!markdown) throw noSuchNote(env, params.id)
    const settlement = await settleMarkdownNotes(env, worktree, undefined, [markdown])
    if (settlement.sent.includes(markdown.id)) {
      announce(env, worktree.id)
      return { ok: true }
    }
    if (await findMarkdownNote(env, worktree, params.id)) {
      throw env.errors.reasoned('conflict', 'markdown-note-changed', 'Markdown note changed before it could be deleted.')
    }
    throw noSuchNote(env, params.id)
  }
}


/** Deletes every note of the worktree, or of one path. */
export function clearNotes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const { worktree, path } = await scoped(env, params, caller)
    const markdownNotes = await listMarkdownNotes(env, worktree, path)
    const settled = await settleMarkdownNotes(env, worktree, undefined, markdownNotes)
    const cleared = env.notes.clear(worktree.id, path) + settled.sent.length
    announce(env, worktree.id)
    return { cleared }
  }
}
/** The question asked before `clearNotes`: how many notes go, from one path or the whole worktree. */
export function describeClearNotes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const { worktree, path } = await scoped(env, params, caller)
    const count = plural((await listMixedNotes(env, worktree, path)).length)
    return path === undefined ? `Clear ${count} from this workspace?` : `Clear ${count} from ${path}?`
  }
}

/** The prompt for the given notes (or a path's, or all), exactly as a send would paste it. */
export function formatNotes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const { worktree, path } = await scoped(env, params, caller)
    const visible = await listMixedNotes(env, worktree, path)
    let picked = visible
    if (params.ids !== undefined) {
      if (!Array.isArray(params.ids) || params.ids.some((id: unknown) => typeof id !== 'string')) {
        throw env.errors.reasoned('invalid-params', 'invalid-note-ids', 'ids must be an array of note IDs.')
      }
      const wanted = new Set<string>(params.ids)
      const all = path === undefined ? visible : await listMixedNotes(env, worktree)
      for (const id of wanted) if (!all.some((note) => note.id === id)) throw noSuchNote(env, id)
      picked = visible.filter((note) => wanted.has(note.id))
    }
    return { text: formatPrompt(picked), count: picked.length }
  }
}
