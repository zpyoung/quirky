import { RpcErrorCode, type PluginStore } from '@quirky/protocol'
import type { DaemonEnv, Handler } from './env'
import { formatNotes as formatPrompt } from './notes-format'
import { containedPath } from './paths'

/** A diff note: text pinned to a line range of one path in one worktree. */
export type Note = {
  id: string
  worktreeId: string
  path: string
  startLine: number
  line: number
  body: string
  createdAt: number
  updatedAt: number | null
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

/** The worktree a call names and the notes in its path scope; a path need not exist on disk. */
async function scoped(env: DaemonEnv, params: Record<string, any>, caller: Parameters<Handler>[1]) {
  const worktree = await env.resolve(params, caller)
  const path = params.path === undefined ? undefined : (await containedPath(worktree.path, params.path)).rel
  return { worktree, path }
}

/** Announces `notesChanged` so every window showing the worktree reads its notes again. */
export function announce(env: DaemonEnv, worktreeId: string): void {
  env.context.emit('notesChanged', { worktreeId })
}

/** Lists a worktree's notes; a worktree that no longer exists has its notes dropped here. */
export function notes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    try {
      const { worktree, path } = await scoped(env, params, caller)
      return { notes: env.notes.list(worktree.id, path) }
    } catch (error) {
      if ((error as { code?: number } | null)?.code === RpcErrorCode.NotFound && typeof params.worktree === 'string') {
        env.notes.clear(params.worktree.replace(/^id:/, ''))
      }
      throw error
    }
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

/** Replaces a note's text and stamps `updatedAt`. */
export function editNote(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const body = validBody(env, params.body)
    const worktree = await env.resolve(params, caller)
    if (env.notes.get(worktree.id, params.id) === null) throw noSuchNote(env, params.id)
    env.notes.setBody(params.id, body, Date.now())
    announce(env, worktree.id)
    return { note: env.notes.get(worktree.id, params.id)! }
  }
}

/** Deletes one note, even while a send holds it; the send then reports it as already gone. */
export function deleteNote(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const worktree = await env.resolve(params, caller)
    if (env.notes.get(worktree.id, params.id) === null) throw noSuchNote(env, params.id)
    env.notes.remove(params.id)
    announce(env, worktree.id)
    return { ok: true }
  }
}

/** Deletes every note of the worktree, or of one path. */
export function clearNotes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const { worktree, path } = await scoped(env, params, caller)
    const cleared = env.notes.clear(worktree.id, path)
    announce(env, worktree.id)
    return { cleared }
  }
}

/** The question asked before `clearNotes`: how many notes go, from one path or the whole worktree. */
export function describeClearNotes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const { worktree, path } = await scoped(env, params, caller)
    const count = plural(env.notes.list(worktree.id, path).length)
    return path === undefined ? `Clear ${count} from this workspace?` : `Clear ${count} from ${path}?`
  }
}

/** The prompt for the given notes (or a path's, or all), exactly as a send would paste it. */
export function formatNotes(env: DaemonEnv): Handler {
  return async (params, caller) => {
    const { worktree, path } = await scoped(env, params, caller)
    let picked = env.notes.list(worktree.id, path)
    if (params.ids !== undefined) {
      const wanted = new Set<string>(params.ids)
      for (const id of wanted) if (env.notes.get(worktree.id, id) === null) throw noSuchNote(env, id)
      picked = picked.filter((note) => wanted.has(note.id))
    }
    return { text: formatPrompt(picked), count: picked.length }
  }
}
