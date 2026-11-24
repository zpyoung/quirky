import type { OrchestrationDb } from '../orchestration-db'

const QUIRKY_SESSION_ID_COLUMNS = [
  ['runs', 'coordinator_quirky_session_id', 'TEXT'],
  ['runs', 'coordinator_quirky_session_id_generation', 'INTEGER'],
  ['dispatch_contexts', 'assignee_quirky_session_id', 'TEXT'],
  ['dispatch_contexts', 'creator_quirky_session_id', 'TEXT']
] as const

/**
 * Quirky session id columns (bare ids, see quirky-session-address) on a Run's coordinator and a
 * Dispatch's assignee and creator: the Quirky session id the agent is addressed by, when it has one
 * (today only structured sessions); for a `/clear`ed chat, its lineage root's, not the live one.
 * Existing structured-worker rows get their id from `backfillStructuredWorkerQuirkySessionIds`, which
 * runs after migrate on every open. A coordinator's id carries the consumer generation it was
 * written at and counts only at that generation. The triggers that remember a coordinator's session
 * address are `createRunCoordinatorAddressTriggers`, recreated on every open after migrate.
 *
 * Dev databases stamped v42 by earlier builds hold `*_principal` or `*_actor` columns instead. They
 * are unsupported: the version-skew probe finds a column missing and replays the chain, which adds
 * these columns and leaves the stale ones unread.
 */
export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  // Guarded because createTables runs first on every open and already gives a fresh database these.
  for (const [table, column, type] of QUIRKY_SESSION_ID_COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
  // A Run lookup that ORs a pane-leaf match with an Quirky session id match scans every Run without this index.
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_coordinator_quirky_session_id
      ON runs(coordinator_quirky_session_id) WHERE coordinator_quirky_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_quirky_session_id
      ON dispatch_contexts(assignee_quirky_session_id) WHERE assignee_quirky_session_id IS NOT NULL;
  `)
}
