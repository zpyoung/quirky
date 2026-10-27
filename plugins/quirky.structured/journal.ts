import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginStore, StoreMigration, StructuredMessage, StructuredRole } from '@quirky/protocol'

type Row = { session_id: string; seq: number; role: StructuredRole; text: string; data: string | null; at: number }

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS structured_messages (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    data TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`

const INSERT_ROW = 'INSERT INTO structured_messages (session_id, seq, role, text, data, at) VALUES (?, ?, ?, ?, ?, ?)'
const IMPORT_ROW = INSERT_ROW.replace('INSERT', 'INSERT OR IGNORE')

/** Creates the journal table, then copies a v1 home's `structured_messages` rows when that table exists. */
function createAndImportV1(home: string): StoreMigration {
  return (store) => {
    store.exec(CREATE_TABLE)
    const v1Path = join(home, 'quirky.db')
    if (!existsSync(v1Path)) return
    const v1 = new Database(v1Path, { readonly: true })
    try {
      const hasTable = v1.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'structured_messages'").get()
      if (!hasTable) return
      const rows = v1.query('SELECT session_id, seq, role, text, data, at FROM structured_messages').all() as Row[]
      store.transaction(() => {
        for (const row of rows) store.run(IMPORT_ROW, row.session_id, row.seq, row.role, row.text, row.data, row.at)
      })
    } finally {
      v1.close()
    }
  }
}

/** The migrations of the plugin's store, for `context.openStore`. */
export function journalMigrations(home: string): StoreMigration[] {
  return [createAndImportV1(home)]
}

/** The structured sessions' message journal. */
export class Journal {
  constructor(private readonly store: PluginStore) {}

  /** Stores a message under the next `seq` of its session. */
  append(input: { sessionId: string; role: StructuredRole; text: string; data?: unknown; at: number }): StructuredMessage {
    const seq = this.store.transaction(() => {
      const row = this.store.get<{ next: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM structured_messages WHERE session_id = ?',
        input.sessionId
      )!
      this.store.run(
        INSERT_ROW,
        input.sessionId,
        row.next,
        input.role,
        input.text,
        input.data === undefined ? null : JSON.stringify(input.data),
        input.at
      )
      return row.next
    })
    const message: StructuredMessage = { sessionId: input.sessionId, seq, role: input.role, text: input.text, at: input.at }
    if (input.data !== undefined) message.data = input.data
    return message
  }

  /** The session's messages with `seq` above `afterSeq`, oldest first. */
  list(sessionId: string, afterSeq = 0): StructuredMessage[] {
    const rows = this.store.all<Row>(
      'SELECT session_id, seq, role, text, data, at FROM structured_messages WHERE session_id = ? AND seq > ? ORDER BY seq',
      sessionId,
      afterSeq
    )
    return rows.map((row) => {
      const message: StructuredMessage = { sessionId: row.session_id, seq: row.seq, role: row.role, text: row.text, at: row.at }
      if (row.data !== null) message.data = JSON.parse(row.data)
      return message
    })
  }

  /** Drops the session's journal. */
  remove(sessionId: string): void {
    this.store.run('DELETE FROM structured_messages WHERE session_id = ?', sessionId)
  }
}
