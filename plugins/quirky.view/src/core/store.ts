import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type { Refused, StoredViewRecord, ViewPlacement, ViewSpec } from './contract'

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

/**
 * Version history. `views` keeps the latest spec, so a list stays one table read; every version,
 * the latest included, also has a `view_versions` row. A view that existed before this migration
 * gets one row, as version 1, from its current spec. `render_reported_version` is the newest version
 * whose render failure the agent was told about, so a restart does not tell it twice.
 */
export const viewVersionsMigration: StoreMigration = `
  CREATE TABLE view_versions (
    view_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (view_id, version)
  );
  ALTER TABLE views ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE views ADD COLUMN refused_json TEXT;
  ALTER TABLE views ADD COLUMN render_reported_version INTEGER NOT NULL DEFAULT 0;
  INSERT INTO view_versions (view_id, version, spec_json, created_at)
    SELECT view_id, 1, spec_json,
      COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', updated_at), 4, 3) AS INTEGER), 0)
    FROM views;
`

type Row = {
  view_id: string
  session_id: string
  title: string
  spec_json: string
  placement: string
  moved_by_user: number
  created_at: string
  updated_at: string
  closed: number
  version: number
  refused_json: string | null
}

function recordOf(row: Row): StoredViewRecord {
  return {
    viewId: row.view_id,
    sessionId: row.session_id,
    title: row.title,
    spec: JSON.parse(row.spec_json) as ViewSpec,
    placement: row.placement === 'pane' ? 'pane' : 'inline',
    movedByUser: row.moved_by_user === 1,
    updates: row.version - 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closed: row.closed === 1,
    version: row.version,
    latestVersion: row.version,
    refused: row.refused_json === null ? null : (JSON.parse(row.refused_json) as Refused)
  }
}

/** Typed access to the `views` and `view_versions` tables over the plugin's store. */
export class ViewStore {
  constructor(private readonly store: PluginStore) {}

  /** Stores a new view and its version 1. */
  insert(record: StoredViewRecord): void {
    const spec = JSON.stringify(record.spec)
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO views (view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed, version, refused_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, NULL)`,
        record.viewId,
        record.sessionId,
        record.title,
        spec,
        record.placement,
        record.movedByUser ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.closed ? 1 : 0
      )
      this.store.run('INSERT INTO view_versions (view_id, version, spec_json, created_at) VALUES (?, 1, ?, ?)', record.viewId, spec, Date.parse(record.createdAt))
    })
  }

  /** The view as of its latest version. */
  get(viewId: string): StoredViewRecord | null {
    const row = this.store.get<Row>('SELECT * FROM views WHERE view_id = ?', viewId)
    return row ? recordOf(row) : null
  }

  /** The view as it was at `version`: that version's spec, title and time, with everything else as it is now. */
  getVersion(viewId: string, version: number): StoredViewRecord | null {
    const latest = this.get(viewId)
    if (!latest) return null
    if (version === latest.version) return latest
    const row = this.store.get<{ spec_json: string; created_at: number }>('SELECT spec_json, created_at FROM view_versions WHERE view_id = ? AND version = ?', viewId, version)
    if (!row) return null
    const spec = JSON.parse(row.spec_json) as ViewSpec
    return { ...latest, spec, title: spec.title, version, updatedAt: new Date(row.created_at).toISOString() }
  }

  /** Every view of the session in the order it was opened, closed ones included. */
  listBySession(sessionId: string): StoredViewRecord[] {
    return this.store.all<Row>('SELECT * FROM views WHERE session_id = ? ORDER BY created_at, rowid', sessionId).map(recordOf)
  }

  /** Makes `spec` the next version, clears the refused state and returns the new record. */
  appendVersion(viewId: string, spec: ViewSpec, at: Date): StoredViewRecord {
    const json = JSON.stringify(spec)
    return this.store.transaction(() => {
      const next = this.get(viewId)!.version + 1
      this.store.run(
        'UPDATE views SET title = ?, spec_json = ?, version = ?, updates = ?, updated_at = ?, refused_json = NULL WHERE view_id = ?',
        spec.title,
        json,
        next,
        next - 1,
        at.toISOString(),
        viewId
      )
      this.store.run('INSERT INTO view_versions (view_id, version, spec_json, created_at) VALUES (?, ?, ?, ?)', viewId, next, json, at.getTime())
      return this.get(viewId)!
    })
  }

  /** Records the newest refusal, or clears it with null. */
  setRefused(viewId: string, refused: Refused | null): StoredViewRecord | null {
    this.store.run('UPDATE views SET refused_json = ? WHERE view_id = ?', refused === null ? null : JSON.stringify(refused), viewId)
    return this.get(viewId)
  }

  /**
   * Claims the render-failure report for `version`: true the first time, false for every later call
   * on the same version. Kept apart from the refused state, which a refused update overwrites.
   */
  claimRenderReport(viewId: string, version: number): boolean {
    return this.store.run('UPDATE views SET render_reported_version = ? WHERE view_id = ? AND render_reported_version < ?', version, viewId, version).changes > 0
  }

  /** Records the user's choice of placement, which later updates keep. */
  moveByUser(viewId: string, placement: ViewPlacement): StoredViewRecord | null {
    this.store.run('UPDATE views SET placement = ?, moved_by_user = 1 WHERE view_id = ?', placement, viewId)
    return this.get(viewId)
  }

  close(viewId: string): StoredViewRecord | null {
    this.store.run('UPDATE views SET closed = 1 WHERE view_id = ?', viewId)
    return this.get(viewId)
  }
}
