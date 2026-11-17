import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type { ViewPlacement, ViewRecord, ViewSpec } from './catalog'

/** The `views` table: one row per view the agent opened, kept after it is closed. */
export const viewsMigration: StoreMigration = `
  CREATE TABLE views (
    view_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    placement TEXT NOT NULL,
    moved_by_user INTEGER NOT NULL DEFAULT 0,
    updates INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX views_session ON views(session_id, created_at);
`

type Row = {
  view_id: string
  session_id: string
  title: string
  spec_json: string
  placement: string
  moved_by_user: number
  updates: number
  created_at: string
  updated_at: string
  closed: number
}

function recordOf(row: Row): ViewRecord {
  return {
    viewId: row.view_id,
    sessionId: row.session_id,
    title: row.title,
    spec: JSON.parse(row.spec_json) as ViewSpec,
    placement: row.placement === 'pane' ? 'pane' : 'inline',
    movedByUser: row.moved_by_user === 1,
    updates: row.updates,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closed: row.closed === 1
  }
}

/** Typed access to the `views` table over the plugin's store. */
export class ViewStore {
  constructor(private readonly store: PluginStore) {}

  insert(record: ViewRecord): void {
    this.store.run(
      `INSERT INTO views (view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.viewId,
      record.sessionId,
      record.title,
      JSON.stringify(record.spec),
      record.placement,
      record.movedByUser ? 1 : 0,
      record.updates,
      record.createdAt,
      record.updatedAt,
      record.closed ? 1 : 0
    )
  }

  get(viewId: string): ViewRecord | null {
    const row = this.store.get<Row>('SELECT * FROM views WHERE view_id = ?', viewId)
    return row ? recordOf(row) : null
  }

  /** Every view of the session in the order it was opened, closed ones included. */
  listBySession(sessionId: string): ViewRecord[] {
    return this.store.all<Row>('SELECT * FROM views WHERE session_id = ? ORDER BY created_at, rowid', sessionId).map(recordOf)
  }

  /** Replaces the content, counts the update and returns the new record. */
  replaceSpec(viewId: string, spec: ViewSpec, at: string): ViewRecord | null {
    this.store.run('UPDATE views SET title = ?, spec_json = ?, updates = updates + 1, updated_at = ? WHERE view_id = ?', spec.title, JSON.stringify(spec), at, viewId)
    return this.get(viewId)
  }

  /** Records the user's choice of placement, which later updates keep. */
  moveByUser(viewId: string, placement: ViewPlacement): ViewRecord | null {
    this.store.run('UPDATE views SET placement = ?, moved_by_user = 1 WHERE view_id = ?', placement, viewId)
    return this.get(viewId)
  }

  close(viewId: string): ViewRecord | null {
    this.store.run('UPDATE views SET closed = 1 WHERE view_id = ?', viewId)
    return this.get(viewId)
  }
}
