import type { PluginStore } from '@quirky/protocol'

/**
 * The plugin's second store migration: drafts, deadlines, the stored summary and the change
 * counter. Existing rows are numbered 1..n in `(created_at, id)` order, which becomes both their
 * `seq` and their queue order, and the counter starts at n so no value is ever reused.
 */
export function askQueueMigration(store: PluginStore): void {
  store.exec(`
    ALTER TABLE asks ADD COLUMN partial TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE asks ADD COLUMN expires_at INTEGER;
    ALTER TABLE asks ADD COLUMN summary TEXT NOT NULL DEFAULT '';
    ALTER TABLE asks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE asks ADD COLUMN created_seq INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE ask_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
  `)
  const rows = store.all<{ id: string }>('SELECT id FROM asks ORDER BY created_at, id')
  rows.forEach((row, index) => {
    store.run('UPDATE asks SET seq = ?, created_seq = ? WHERE id = ?', index + 1, index + 1, row.id)
  })
  store.run('INSERT INTO ask_seq (id, value) VALUES (1, ?)', rows.length)
}

/** The plugin's third store migration: nullable private ownership for plugin-created asks. */
export function askOwnershipMigration(store: PluginStore): void {
  store.exec('ALTER TABLE asks ADD COLUMN owner_plugin_id TEXT;')
}

/** The plugin's fourth migration: durable registration, exact session authority and handoff state. */
export function askHandoffMigration(store: PluginStore): void {
  store.exec(`
    ALTER TABLE asks ADD COLUMN reason TEXT;
    ALTER TABLE asks ADD COLUMN request_id TEXT;
    ALTER TABLE asks ADD COLUMN handoff_identity TEXT;
    ALTER TABLE asks ADD COLUMN handoff_question_id TEXT;
    ALTER TABLE asks ADD COLUMN owner_identity TEXT;
    CREATE UNIQUE INDEX asks_request_id ON asks(request_id) WHERE request_id IS NOT NULL;
  `)
}
