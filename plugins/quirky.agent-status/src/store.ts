import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, PluginStore, StoreMigration } from '@quirky/protocol'
import type { AgentRow } from './types'

const NOTIFICATIONS_SETTING = 'setting:quirky.agent-status/notifications'

/** Creates v1's tables and stages v1's `notifications` value for `importNotificationsSetting`. */
function firstMigration(home: string): (store: PluginStore) => void {
  return (store) => {
    store.exec(`
      CREATE TABLE hooks (session_id TEXT PRIMARY KEY, last_hook_at INTEGER NOT NULL);
      CREATE TABLE pending_setting (value TEXT NOT NULL);
    `)
    const v1 = readV1Notifications(home)
    if (v1 !== null) store.run('INSERT INTO pending_setting (value) VALUES (?)', v1)
  }
}

/** One row per session, and the per-session OSC 7501 records. The v1 `hooks` table stays but is no longer read. */
const rowsMigration: StoreMigration = `
  CREATE TABLE rows (session_id TEXT PRIMARY KEY, row TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE program_status (session_id TEXT PRIMARY KEY, records TEXT NOT NULL);
`

/** The plugin's migrations in order; a store opened with them holds `RowStore`'s tables. */
export function migrations(home: string): StoreMigration[] {
  return [firstMigration(home), rowsMigration]
}

/** The raw JSON of v1's `notifications` setting, or null when the v1 database or row is absent. */
function readV1Notifications(home: string): string | null {
  const path = join(home, 'quirky.db')
  if (!existsSync(path)) return null
  let db: Database | null = null
  try {
    db = new Database(path, { readonly: true })
    const row = db.query("SELECT value FROM settings WHERE key = 'notifications'").get() as { value: string } | null
    return row?.value ?? null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/** Carries v1's `notifications` value into the setting once; a value that is not a boolean is skipped. */
export async function importNotificationsSetting(context: PluginContext, store: PluginStore): Promise<void> {
  const pending = store.get<{ value: string }>('SELECT value FROM pending_setting')
  if (!pending) return
  try {
    const value: unknown = JSON.parse(pending.value)
    if (typeof value !== 'boolean') {
      context.log(`skipped v1 notifications setting: ${pending.value} is not a boolean`)
    } else {
      const current = (await context.call('setting.get', { id: NOTIFICATIONS_SETTING })) as { stored?: unknown }
      if (current.stored === undefined) await context.call('setting.set', { id: NOTIFICATIONS_SETTING, value })
    }
  } catch (error) {
    context.log(`v1 notifications setting not imported: ${(error as Error).message}`)
    return
  }
  store.run('DELETE FROM pending_setting')
}

export type StoredRow = { row: AgentRow; updatedAt: number }

/** The agent rows, one JSON document per session, and each session's OSC 7501 records. */
export class RowStore {
  constructor(private readonly store: PluginStore) {}

  get(sessionId: string): AgentRow | null {
    const found = this.store.get<{ row: string }>('SELECT row FROM rows WHERE session_id = ?', sessionId)
    return found ? (JSON.parse(found.row) as AgentRow) : null
  }

  put(row: AgentRow, updatedAt: number): void {
    this.store.run(
      'INSERT INTO rows (session_id, row, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET row = excluded.row, updated_at = excluded.updated_at',
      row.sessionId,
      JSON.stringify(row),
      updatedAt
    )
  }

  delete(sessionId: string): void {
    this.store.run('DELETE FROM rows WHERE session_id = ?', sessionId)
  }

  all(): StoredRow[] {
    return this.store
      .all<{ row: string; updated_at: number }>('SELECT row, updated_at FROM rows')
      .map((found) => ({ row: JSON.parse(found.row) as AgentRow, updatedAt: found.updated_at }))
  }

  /** A session's stored OSC 7501 records (see `serializeRecords`), or null when it has none. */
  getRecords(sessionId: string): string | null {
    return this.store.get<{ records: string }>('SELECT records FROM program_status WHERE session_id = ?', sessionId)?.records ?? null
  }

  putRecords(sessionId: string, records: string): void {
    this.store.run(
      'INSERT INTO program_status (session_id, records) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET records = excluded.records',
      sessionId,
      records
    )
  }

  deleteRecords(sessionId: string): void {
    this.store.run('DELETE FROM program_status WHERE session_id = ?', sessionId)
  }

  recordSessions(): string[] {
    return this.store.all<{ session_id: string }>('SELECT session_id FROM program_status').map((found) => found.session_id)
  }
}
