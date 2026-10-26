import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginStore, Session, SessionStatus, StoreMigration } from '@quirky/protocol'

type Row = {
  id: string
  kind: Session['kind']
  agent: Session['agent']
  worktree_id: string
  cwd: string
  title: string
  status: SessionStatus
  created_at: number
  last_activity_at: number
  exit_code: number | null
}

const toSession = (row: Row): Session => ({
  id: row.id,
  kind: row.kind,
  agent: row.agent,
  worktreeId: row.worktree_id,
  cwd: row.cwd,
  title: row.title,
  status: row.status,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
  exitCode: row.exit_code
})

const INSERT = `INSERT OR IGNORE INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/** Copies the sessions table of a v1 home, if it has one; a home that never had `repo_id` imports it as null. */
function importV1Sessions(store: PluginStore, home: string): void {
  const path = join(home, 'quirky.db')
  if (!existsSync(path)) return
  const v1 = new Database(path, { readonly: true })
  try {
    if (!v1.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) return
    const rows = v1.query('SELECT * FROM sessions ORDER BY created_at, id').all() as (Row & { repo_id?: string | null })[]
    for (const row of rows) {
      store.run(
        INSERT,
        row.id,
        row.kind,
        row.agent,
        row.worktree_id,
        row.cwd,
        row.title,
        row.status,
        row.created_at,
        row.last_activity_at,
        row.exit_code,
        row.repo_id ?? null
      )
    }
  } finally {
    v1.close()
  }
}

export function sessionMigrations(home: string): StoreMigration[] {
  return [
    (store) => {
      store.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          agent TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          exit_code INTEGER,
          repo_id TEXT
        )
      `)
      importV1Sessions(store, home)
    }
  ]
}

/** The session records in the plugin's store. */
export class SessionRecords {
  constructor(private readonly store: PluginStore) {}

  list(worktreeId?: string): Session[] {
    const rows =
      worktreeId === undefined
        ? this.store.all<Row>('SELECT * FROM sessions ORDER BY created_at, rowid')
        : this.store.all<Row>('SELECT * FROM sessions WHERE worktree_id = ? ORDER BY created_at, rowid', worktreeId)
    return rows.map(toSession)
  }

  get(id: string): Session | null {
    const row = this.store.get<Row>('SELECT * FROM sessions WHERE id = ?', id)
    return row ? toSession(row) : null
  }

  /** True when some record, in any state, belongs to the worktree ID. */
  hasWorktree(worktreeId: string): boolean {
    return this.store.get('SELECT 1 FROM sessions WHERE worktree_id = ? LIMIT 1', worktreeId) !== null
  }

  insert(session: Session, repoId: string): void {
    this.store.run(
      INSERT,
      session.id,
      session.kind,
      session.agent,
      session.worktreeId,
      session.cwd,
      session.title,
      session.status,
      session.createdAt,
      session.lastActivityAt,
      session.exitCode,
      repoId
    )
  }

  update(id: string, fields: { status?: SessionStatus; lastActivityAt?: number; exitCode?: number | null }): Session | null {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current, ...fields }
    this.store.run(
      'UPDATE sessions SET status = ?, last_activity_at = ?, exit_code = ? WHERE id = ?',
      next.status,
      next.lastActivityAt,
      next.exitCode,
      id
    )
    return next
  }

  delete(id: string): void {
    this.store.run('DELETE FROM sessions WHERE id = ?', id)
  }
}
