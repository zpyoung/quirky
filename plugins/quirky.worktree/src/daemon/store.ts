import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GitHubWorktreeLink, PluginContext, PluginStore, ProjectGroup, Worktree, WorktreeAutomationProvenance, WorktreeCreatedBy, WorktreePushTarget, WorktreeStatus } from '@quirky/protocol'
import type { WorktreeReference } from '../parity-types'
import type { WorktreeControl } from '../control-types'

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
  project_group_id: string | null
  last_activity_at: number
  instance_id: string
  created_root: string | null
  linked_pr: string | null
  linked_issue: string | null
  push_target: string | null
  manual_order: number
  sleeping: number
  sleep_changed_at: number
  cleanup_ignored_fingerprint: string | null
  cleanup_ignored_at: number | null
  references_json: string
  archived_at: number | null
  automation_provenance?: string | null
}


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
    },
    (store) => {
      store.exec(`
        ALTER TABLE worktrees ADD COLUMN project_group_id TEXT;
        ALTER TABLE worktrees ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN instance_id TEXT NOT NULL DEFAULT '';
      `)
    },
    (store) => {
      store.exec(`
        ALTER TABLE worktrees ADD COLUMN linked_pr TEXT;
        ALTER TABLE worktrees ADD COLUMN linked_issue TEXT;
        ALTER TABLE worktrees ADD COLUMN push_target TEXT;
      `)
    },
    (store) => {
      store.exec(`
        ALTER TABLE worktrees ADD COLUMN manual_order INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN sleeping INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN sleep_changed_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE worktrees ADD COLUMN cleanup_ignored_fingerprint TEXT;
        ALTER TABLE worktrees ADD COLUMN cleanup_ignored_at INTEGER;
        ALTER TABLE worktrees ADD COLUMN automation_provenance TEXT;
      `)
    },
    (store) => {
      store.exec(`
        CREATE TABLE worktree_origins (
          worktree_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          creator_kind TEXT NOT NULL CHECK (creator_kind IN ('plugin', 'paired-device', 'client')),
          creator_id TEXT,
          creator_role TEXT NOT NULL,
          PRIMARY KEY (worktree_id, instance_id)
        );
      `)
    },
    (store) => {
      store.exec(`
        ALTER TABLE worktrees ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE worktrees ADD COLUMN archived_at INTEGER;
        CREATE TABLE project_preferences (
          repo_id TEXT PRIMARY KEY,
          external_visibility TEXT,
          external_inbox_suppressed INTEGER NOT NULL DEFAULT 0,
          icon TEXT,
          color TEXT,
          tracker_project TEXT
        );
      `)
    },
    (store) => {
      store.exec("ALTER TABLE project_preferences ADD COLUMN shared_directories TEXT NOT NULL DEFAULT '[]'")
    },
    (store) => {
      store.exec(`
        CREATE TABLE prepared_worktrees (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          root_path TEXT NOT NULL,
          base_ref TEXT NOT NULL,
          base_oid TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX prepared_worktrees_by_expiry ON prepared_worktrees(created_at);
      `)
    }
  ])
}
export type WorktreeOriginCreator = {
  creatorKind: 'plugin' | 'paired-device' | 'client'
  creatorId: string | null
  creatorRole: string
}

/** Stores kernel-derived provenance against the exact filesystem instance, never just its path-derived ID. */
export function recordWorktreeOrigin(store: PluginStore, worktreeId: string, instanceId: string, creator: WorktreeOriginCreator): void {
  store.run(
    `INSERT INTO worktree_origins (worktree_id, instance_id, creator_kind, creator_id, creator_role)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
       creator_kind = excluded.creator_kind,
       creator_id = excluded.creator_id,
       creator_role = excluded.creator_role`,
    worktreeId,
    instanceId,
    creator.creatorKind,
    creator.creatorId,
    creator.creatorRole
  )
}

export function forgetWorktreeOrigins(store: PluginStore, worktreeId: string): void {
  store.run('DELETE FROM worktree_origins WHERE worktree_id = ?', worktreeId)
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
  linkedPR?: GitHubWorktreeLink | null
  linkedIssue?: GitHubWorktreeLink | null
  pushTarget?: WorktreePushTarget | null
  projectGroupId?: string | null
  lastActivityAt?: number
  instanceId?: string
  manualOrder?: number
  automationProvenance?: WorktreeAutomationProvenance | null
}

/** Inserts a row, or fills a v1 row (ID and repo only) with the given values; never overwrites a row that has them. */
export function insertRow(store: PluginStore, row: NewRow): WorktreeRow {
  store.run(
    `INSERT INTO worktrees (id, repo_id, kind, path, name, display_name, comment, parent_id, created_at, created_by, base_ref, keep_branch, birthtime, group_id, created_root, project_group_id, last_activity_at, instance_id, linked_pr, linked_issue, push_target, manual_order, automation_provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repo_id = excluded.repo_id,
       kind = excluded.kind,
       path = excluded.path,
       created_at = COALESCE(worktrees.created_at, excluded.created_at),
       birthtime = COALESCE(worktrees.birthtime, excluded.birthtime),
       last_activity_at = MAX(worktrees.last_activity_at, excluded.last_activity_at),
       instance_id = CASE
         WHEN worktrees.instance_id = '' OR worktrees.instance_id LIKE 'unverified:%' THEN excluded.instance_id
         ELSE worktrees.instance_id
       END`,
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
    row.createdRoot ?? null,
    row.projectGroupId ?? null,
    row.lastActivityAt ?? 0,
    row.instanceId ?? `unverified:${crypto.randomUUID()}`,
    row.linkedPR == null ? null : JSON.stringify(row.linkedPR),
    row.linkedIssue == null ? null : JSON.stringify(row.linkedIssue),
    row.pushTarget == null ? null : JSON.stringify(row.pushTarget),
    row.manualOrder ?? -row.createdAt,
    row.automationProvenance == null ? null : JSON.stringify(row.automationProvenance)
  )
  return rowOf(store, row.id)!
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function storedJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}
function storedReferences(value: string | null): WorktreeReference[] {
  const decoded = storedJson(value)
  if (!Array.isArray(decoded)) return []
  return decoded.flatMap((item) => {
    const record = recordOf(item)
    if (
      typeof record?.id !== 'string' || record.id === '' ||
      typeof record.url !== 'string' ||
      typeof record.label !== 'string' ||
      typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
    ) return []
    try {
      const url = new URL(record.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
    } catch {
      return []
    }
    return [{ id: record.id, url: record.url, label: record.label, createdAt: record.createdAt }]
  })
}

function storedLink(value: string | null): GitHubWorktreeLink | null {
  const record = recordOf(storedJson(value))
  const repository = recordOf(record?.repository)
  if (
    record?.provider !== 'github' ||
    (record.kind !== 'issue' && record.kind !== 'pullRequest') ||
    typeof record.number !== 'number' || !Number.isSafeInteger(record.number) || record.number < 1 ||
    typeof record.title !== 'string' || typeof record.url !== 'string' ||
    typeof repository?.host !== 'string' || typeof repository.owner !== 'string' || typeof repository.repo !== 'string'
  ) return null
  return {
    provider: 'github',
    kind: record.kind,
    number: record.number,
    title: record.title,
    url: record.url,
    repository: { host: repository.host, owner: repository.owner, repo: repository.repo }
  }
}

function storedPushTarget(value: string | null): WorktreePushTarget | null {
  const record = recordOf(storedJson(value))
  if (
    typeof record?.remoteName !== 'string' || typeof record.branchName !== 'string' ||
    typeof record.maintainerCanModify !== 'boolean'
  ) return null
  return { remoteName: record.remoteName, branchName: record.branchName, maintainerCanModify: record.maintainerCanModify }
}

function storedAutomationProvenance(value: string | null | undefined): WorktreeAutomationProvenance | null {
  const record = recordOf(value == null ? null : storedJson(value))
  if (
    record === null || Object.keys(record).length !== 7 ||
    record.kind !== 'created-by-automation' ||
    typeof record.automationId !== 'string' || record.automationId.length === 0 ||
    typeof record.automationName !== 'string' ||
    typeof record.runId !== 'string' || record.runId.length === 0 ||
    typeof record.runTitle !== 'string' ||
    typeof record.projectId !== 'string' || record.projectId.length === 0 ||
    record.hostId !== 'local'
  ) return null
  return {
    kind: 'created-by-automation',
    automationId: record.automationId,
    automationName: record.automationName,
    runId: record.runId,
    runTitle: record.runTitle,
    projectId: record.projectId,
    hostId: 'local'
  }
}

/** The metadata half of a `Worktree`, read from its row. */
export function metadataOf(row: WorktreeRow): Pick<
  Worktree,
  'displayName' | 'comment' | 'status' | 'pinned' | 'unread' | 'parentId' | 'createdAt' | 'createdBy' | 'baseRef' | 'keepBranch' | 'projectGroupId' | 'lastActivityAt' | 'instanceId' | 'linkedPR' | 'linkedIssue' | 'pushTarget' | 'automationProvenance'
> & Pick<WorktreeControl, 'manualOrder' | 'sleeping' | 'sleepChangedAt' | 'references' | 'archivedAt' | 'cleanupContext'> {
  const linkedPR = storedLink(row.linked_pr)
  const linkedIssue = storedLink(row.linked_issue)
  const pushTarget = storedPushTarget(row.push_target)
  const automationProvenance = storedAutomationProvenance(row.automation_provenance)
  const references = storedReferences(row.references_json)
  const archivedAt = row.archived_at
  return {
    displayName: row.display_name,
    comment: row.comment,
    status: row.status ? row.status as WorktreeStatus : 'in-progress',
    pinned: row.pinned !== 0,
    unread: row.unread !== 0,
    parentId: row.parent_id,
    createdAt: row.created_at ?? 0,
    createdBy: (['window', 'cli', 'api'] as const).find((by) => by === row.created_by) ?? 'external',
    baseRef: row.base_ref,
    keepBranch: row.keep_branch !== 0,
    projectGroupId: row.project_group_id,
    lastActivityAt: row.last_activity_at,
    instanceId: row.instance_id || `unverified:${row.id}`,
    ...(linkedPR === null ? {} : { linkedPR }),
    ...(linkedIssue === null ? {} : { linkedIssue }),
    ...(pushTarget === null ? {} : { pushTarget }),
    manualOrder: row.manual_order,
    sleeping: row.sleeping !== 0,
    sleepChangedAt: row.sleep_changed_at === 0 ? null : row.sleep_changed_at,
    references,
    archivedAt,
    cleanupContext: { archivedAt, volatile: null, remoteConnected: null },
    ...(automationProvenance === null ? {} : { automationProvenance })
  }
}
