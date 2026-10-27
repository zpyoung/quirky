import type { StoreMigration } from '@quirky/protocol'

/**
 * The plugin store's schema, append-only. `notes` holds diff notes by worktree; `recipes` holds
 * the saved AI recipes (scope is `global` or a repo ID).
 */
export const migrations: StoreMigration[] = [
  `CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    line INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );
  CREATE INDEX notes_by_worktree ON notes (worktree_id, path, line)`,
  `CREATE TABLE recipes (
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    agent TEXT,
    args TEXT,
    template TEXT,
    PRIMARY KEY (scope, action)
  )`
]
