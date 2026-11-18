import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import type { PluginStore, QueuedMessage } from '@quirky/protocol'

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** The queue's table, created by the plugin store's migrations. */
export const CREATE_QUEUE_TABLE = `
  CREATE TABLE IF NOT EXISTS structured_queue (
    slot INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    images TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS structured_queue_session ON structured_queue(session_id, slot)
`

type Row = { slot: number; id: string; session_id: string; text: string; images: string | null; at: string }

/** A message removed from the queue and the place it held, so a failed send can put it back. */
export type TakenMessage = { message: QueuedMessage; slot: number }

const toMessage = (row: Row): QueuedMessage => ({
  id: row.id,
  text: row.text,
  ...(row.images === null ? {} : { images: JSON.parse(row.images) as string[] }),
  at: row.at
})

/** Per-session FIFO of messages waiting for the agent to be idle, persisted in the plugin store. */
export class MessageQueue {
  constructor(private readonly store: PluginStore) {}

  list(sessionId: string): QueuedMessage[] {
    return this.store
      .all<Row>('SELECT slot, id, session_id, text, images, at FROM structured_queue WHERE session_id = ? ORDER BY slot', sessionId)
      .map(toMessage)
  }

  add(sessionId: string, input: { text: string; images?: string[] }, now: number): QueuedMessage {
    const message: QueuedMessage = {
      id: randomUUID(),
      text: input.text,
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      at: new Date(now).toISOString()
    }
    this.store.run(
      'INSERT INTO structured_queue (id, session_id, text, images, at) VALUES (?, ?, ?, ?, ?)',
      message.id,
      sessionId,
      message.text,
      message.images ? JSON.stringify(message.images) : null,
      message.at
    )
    return message
  }

  /** Changes a queued message's text; false when the id is not in the session's queue. */
  edit(sessionId: string, id: string, text: string): boolean {
    return this.store.run('UPDATE structured_queue SET text = ? WHERE session_id = ? AND id = ?', text, sessionId, id).changes > 0
  }

  /** Removes a queued message and returns it with its place; null when the id is not in the session's queue. */
  take(sessionId: string, id: string): TakenMessage | null {
    return this.store.transaction(() => {
      const row = this.store.get<Row>(
        'SELECT slot, id, session_id, text, images, at FROM structured_queue WHERE session_id = ? AND id = ?',
        sessionId,
        id
      )
      if (!row) return null
      this.store.run('DELETE FROM structured_queue WHERE slot = ?', row.slot)
      return { message: toMessage(row), slot: row.slot }
    })
  }

  /** Puts a taken message back in the place it held. */
  restore(sessionId: string, taken: TakenMessage): void {
    this.store.run(
      'INSERT OR IGNORE INTO structured_queue (slot, id, session_id, text, images, at) VALUES (?, ?, ?, ?, ?, ?)',
      taken.slot,
      taken.message.id,
      sessionId,
      taken.message.text,
      taken.message.images ? JSON.stringify(taken.message.images) : null,
      taken.message.at
    )
  }

  /**
   * Puts the session's queue in the order of `ids`, which must be exactly its queued ids.
   * Returns false when `ids` is not a permutation; ids, text and images are untouched.
   */
  reorder(sessionId: string, ids: string[]): boolean {
    return this.store.transaction(() => {
      const rows = this.store.all<Row>(
        'SELECT slot, id, session_id, text, images, at FROM structured_queue WHERE session_id = ? ORDER BY slot',
        sessionId
      )
      const byId = new Map(rows.map((row) => [row.id, row]))
      if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) return false
      // the slots are reused as a set so a message taken for sending still restores into its gap
      const slots = rows.map((row) => row.slot)
      this.store.run('DELETE FROM structured_queue WHERE session_id = ?', sessionId)
      ids.forEach((id, index) => {
        const row = byId.get(id)!
        this.store.run(
          'INSERT INTO structured_queue (slot, id, session_id, text, images, at) VALUES (?, ?, ?, ?, ?, ?)',
          slots[index],
          row.id,
          sessionId,
          row.text,
          row.images,
          row.at
        )
      })
      return true
    })
  }

  /** Moves every queued message of one session to another, keeping their order. */
  moveSession(from: string, to: string): void {
    this.store.run('UPDATE structured_queue SET session_id = ? WHERE session_id = ?', to, from)
  }

  clear(sessionId: string): void {
    this.store.run('DELETE FROM structured_queue WHERE session_id = ?', sessionId)
  }
}

/** The problem with an attached image path, or null when it is an absolute path to an image file within the size limit. */
export function imagePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !isAbsolute(path)) return 'image paths must be absolute'
  if (!IMAGE_EXTENSIONS.includes(extname(path).toLowerCase() as (typeof IMAGE_EXTENSIONS)[number])) {
    return `image ${path} must be a png, jpg, jpeg, gif or webp file`
  }
  try {
    if (!existsSync(path)) return `image ${path} does not exist`
    const stats = statSync(path)
    if (!stats.isFile()) return `image ${path} is not a regular file`
    if (stats.size > MAX_IMAGE_BYTES) return `image ${path} is larger than 20 MB`
  } catch {
    return `image ${path} cannot be read`
  }
  return null
}
