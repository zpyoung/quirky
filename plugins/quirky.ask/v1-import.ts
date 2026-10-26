import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginStore } from '@quirky/protocol'

/** The `asks` table, with the columns v1's kernel store used. */
export const ASKS_TABLE = `CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  session_id TEXT,
  worktree_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  answers TEXT NOT NULL,
  skipped TEXT NOT NULL
)`

type V1Ask = {
  id: string
  spec: string
  session_id: string | null
  worktree_id: string | null
  created_at: number
  status: string
  answers: string
  skipped: string
}

/**
 * The plugin's first store migration: creates the `asks` table, then copies every row of
 * `<home>/quirky.db`'s `asks` table when that file and table exist. The kernel never drops the v1
 * table, so the copy runs once and only the migration version stops a second import.
 */
export function v1AsksMigration(home: string): (store: PluginStore) => void {
  return (store) => {
    store.exec(ASKS_TABLE)
    const path = join(home, 'quirky.db')
    if (!existsSync(path)) return
    const v1 = new Database(path, { readonly: true })
    try {
      const hasTable = v1.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asks'").get()
      if (!hasTable) return
      for (const row of v1.query('SELECT * FROM asks').all() as V1Ask[]) {
        store.run(
          'INSERT OR IGNORE INTO asks (id, spec, session_id, worktree_id, created_at, status, answers, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          row.id,
          row.spec,
          row.session_id,
          row.worktree_id,
          row.created_at,
          row.status,
          row.answers,
          row.skipped
        )
      }
    } finally {
      v1.close()
    }
  }
}
