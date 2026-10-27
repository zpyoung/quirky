import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, PluginStore, ProjectGroup, ProjectSettings, Repo } from '@quirky/protocol'

export type RepoRow = {
  id: string
  name: string
  path: string
  added_at: number
  kind: string
  display_name: string | null
  group_id: string | null
  settings: string
}

export type GroupRow = {
  id: string
  name: string
  parent_path: string | null
  collapsed: number
  sort_order: number
  created_from: string
  created_at: number
}

export type HookKind = 'setup' | 'archive' | 'issue'

/** What a project has when nothing has been set; the store keeps only the differences. */
export const DEFAULT_SETTINGS: ProjectSettings = {
  defaultBase: null,
  worktreeLocation: null,
  setupPolicy: 'ask',
  agentStartup: null,
  commandSource: null,
  setupScript: '',
  issueCommand: '',
  archiveScript: ''
}

export const toRepo = (row: RepoRow): Repo => ({
  id: row.id,
  name: row.name,
  path: row.path,
  addedAt: row.added_at,
  kind: row.kind === 'folder' ? 'folder' : 'git',
  displayName: row.display_name,
  groupId: row.group_id
})

export const toGroup = (row: GroupRow, repoIds: string[]): ProjectGroup => ({
  id: row.id,
  name: row.name,
  parentPath: row.parent_path,
  collapsed: row.collapsed !== 0,
  order: row.sort_order,
  createdFrom: row.created_from === 'folder-scan' ? 'folder-scan' : 'manual',
  repoIds
})

/** The settings a row's JSON describes; missing or unreadable fields take their defaults. */
export function settingsFromJson(json: string): ProjectSettings {
  let stored: Partial<ProjectSettings> = {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) stored = parsed as Partial<ProjectSettings>
  } catch {
    // an unreadable column falls back to the defaults
  }
  return { ...DEFAULT_SETTINGS, ...stored }
}

/** The JSON to store for `settings`: only the fields that differ from the defaults. */
export function settingsToJson(settings: ProjectSettings): string {
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ProjectSettings)[]) {
    if (settings[key] !== DEFAULT_SETTINGS[key]) changed[key] = settings[key]
  }
  return JSON.stringify(changed)
}

/** Rows of `table` in the v1 `<home>/quirky.db`, or none when it is missing or unreadable. */
function readV1Rows<T>(home: string, table: string, log: (message: string) => void): T[] {
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
export function createStore(context: PluginContext): PluginStore {
  return context.openStore([
    (store) => {
      store.exec(`
        CREATE TABLE repos (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          added_at INTEGER NOT NULL
        )
      `)
      for (const row of readV1Rows<RepoRow>(context.home, 'repos', context.log)) {
        store.run('INSERT OR IGNORE INTO repos (id, name, path, added_at) VALUES (?, ?, ?, ?)', row.id, row.name, row.path, row.added_at)
      }
    },
    (store) => {
      store.exec(`
        ALTER TABLE repos ADD COLUMN kind TEXT NOT NULL DEFAULT 'git';
        ALTER TABLE repos ADD COLUMN display_name TEXT;
        ALTER TABLE repos ADD COLUMN group_id TEXT;
        ALTER TABLE repos ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
        CREATE TABLE groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_path TEXT,
          collapsed INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          created_from TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE trusted_hooks (
          repo_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          hash TEXT NOT NULL,
          PRIMARY KEY (repo_id, kind)
        );
      `)
    }
  ])
}
