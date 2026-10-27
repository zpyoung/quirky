import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, PluginStore, Worktree, WorktreeCreatedBy, WorktreeStatus } from '@quirky/protocol'

/** One `worktrees` row: Quirky's metadata for a workspace, keyed by the workspace ID. */
export type WorktreeRow = {
  id: string
  repo_id: string
  kind: string
  path: string | null
  name: string | null
  display_name: string | null
  comment: string
  status: string
  pinned: number
  unread: number
  parent_id: string | null
  created_at: number | null
  created_by: string
  base_ref: string | null
  keep_branch: number
  birthtime: number | null
  group_id: string | null
  created_root: string | null
}

export const STATUSES: readonly WorktreeStatus[] = ['todo', 'in-progress', 'in-review', 'done']

/** Rows of `table` in the v1 `<home>/quirky.db`, or none when it is missing or unreadable. */
export function readV1Rows<T>(home: string, table: string, log: (message: string) => void): T[] {
  const file = join(home, 'quirky.db')
  if (!existsSync(file)) return []
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true })
    const present = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    return present ? (db.query(`SELECT * FROM ${table}`).all() as T[]) : []
  } catch (error) {
    log(`could not read ${table} from the v1 database: ${error instanceof Error ? error.message : String(error)}`)
    return []
  } finally {
    db?.close()
  }
}

/** Opens the store, applying migrations in order; existing migrations are append-only. */
export function openWorktreeStore(context: PluginContext): PluginStore {
  return context.openStore([
    (store) => {
      store.exec(`
        CREATE TABLE worktrees (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
      for (const row of readV1Rows<{ id: string; repo_id: string }>(context.home, 'worktrees', context.log)) {
        store.run('INSERT OR IGNORE INTO worktrees (id, repo_id) VALUES (?, ?)', row.id, row.repo_id)
      }
    },
    (store) => {
      store.exec(`
        ALTER TABLE worktrees ADD COLUMN kind TEXT NOT NULL DEFAULT 'git';
        ALTER TABLE worktrees ADD COLUMN path TEXT;
        ALTER TABLE worktrees ADD COLUMN name TEXT;
        ALTER TABLE worktrees ADD COLUMN display_name TEXT;
        ALTER TABLE worktrees ADD COLUMN comment TEXT NOT NULL DEFAULT '';
        ALTER TABLE worktrees ADD COLUMN status TEXT NOT NULL DEFAULT 'in-progress';
        ALTER TABLE worktrees ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN parent_id TEXT;
        ALTER TABLE worktrees ADD COLUMN created_at INTEGER;
        ALTER TABLE worktrees ADD COLUMN created_by TEXT NOT NULL DEFAULT 'external';
        ALTER TABLE worktrees ADD COLUMN base_ref TEXT;
        ALTER TABLE worktrees ADD COLUMN keep_branch INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN birthtime INTEGER;
        ALTER TABLE worktrees ADD COLUMN group_id TEXT;
        ALTER TABLE worktrees ADD COLUMN created_root TEXT;
        CREATE TABLE retired_names (
          repo_id TEXT NOT NULL,
          name TEXT NOT NULL,
          PRIMARY KEY (repo_id, name)
        );
      `)
    }
  ])
}

export const rowOf = (store: PluginStore, id: string): WorktreeRow | null => store.get<WorktreeRow>('SELECT * FROM worktrees WHERE id = ?', id)

/** The columns a new row is created with; everything else takes the table default. */
export type NewRow = {
  id: string
  repoId: string
  kind: 'git' | 'folder'
  path: string
  name?: string | null
  createdAt: number
  createdBy: WorktreeCreatedBy
  birthtime?: number | null
  groupId?: string | null
  baseRef?: string | null
  keepBranch?: boolean
  createdRoot?: string | null
  displayName?: string | null
  comment?: string
  parentId?: string | null
}

/** Inserts a row, or fills a v1 row (ID and repo only) with the given values; never overwrites a row that has them. */
export function insertRow(store: PluginStore, row: NewRow): WorktreeRow {
  store.run(
    `INSERT INTO worktrees (id, repo_id, kind, path, name, display_name, comment, parent_id, created_at, created_by, base_ref, keep_branch, birthtime, group_id, created_root)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repo_id = excluded.repo_id,
       kind = excluded.kind,
       path = excluded.path,
       created_at = COALESCE(worktrees.created_at, excluded.created_at),
       birthtime = COALESCE(worktrees.birthtime, excluded.birthtime)`,
    row.id,
    row.repoId,
    row.kind,
    row.path,
    row.name ?? null,
    row.displayName ?? null,
    row.comment ?? '',
    row.parentId ?? null,
    row.createdAt,
    row.createdBy,
    row.baseRef ?? null,
    row.keepBranch ? 1 : 0,
    row.birthtime ?? null,
    row.groupId ?? null,
    row.createdRoot ?? null
  )
  return rowOf(store, row.id)!
}

/** The metadata half of a `Worktree`, read from its row. */
export function metadataOf(row: WorktreeRow): Pick<
  Worktree,
  'displayName' | 'comment' | 'status' | 'pinned' | 'unread' | 'parentId' | 'createdAt' | 'createdBy' | 'baseRef' | 'keepBranch'
> {
  return {
    displayName: row.display_name,
    comment: row.comment,
    status: STATUSES.includes(row.status as WorktreeStatus) ? (row.status as WorktreeStatus) : 'in-progress',
    pinned: row.pinned !== 0,
    unread: row.unread !== 0,
    parentId: row.parent_id,
    createdAt: row.created_at ?? 0,
    createdBy: (['window', 'cli', 'api'] as const).find((by) => by === row.created_by) ?? 'external',
    baseRef: row.base_ref,
    keepBranch: row.keep_branch !== 0
  }
}
