import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { HEIMDALL_DATABASE_SCHEMA_VERSION, HeimdallDatabase } from './database'

let root: string
const opened: HeimdallDatabase[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-heimdall-database-'))
})

afterEach(() => {
  for (const database of opened) {
    database.close()
  }
  opened.length = 0
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('Heimdall database initialization', () => {
  it('rechecks user_version under the write lock when two first-open callers race', () => {
    const first = new HeimdallDatabase(root)
    const competing = new HeimdallDatabase(root)
    opened.push(first, competing)
    const originalPragma = Database.prototype.pragma
    let raced = false
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      const result = originalPragma.call(this, sql, options)
      if (!raced && sql === 'user_version' && Number(result) === 0) {
        raced = true
        competing.connection()
      }
      return result
    })

    expect(() => first.connection()).not.toThrow()
    expect(raced).toBe(true)
    expect(first.isReadOnly()).toBe(false)
    expect(first.connection().pragma('user_version', { simple: true })).toBe(
      HEIMDALL_DATABASE_SCHEMA_VERSION
    )
  })

  it('latches read-only instead of downgrading a future schema that wins first-open', () => {
    const first = new HeimdallDatabase(root)
    const competing = new HeimdallDatabase(root)
    opened.push(first, competing)
    const futureVersion = HEIMDALL_DATABASE_SCHEMA_VERSION + 1
    const originalPragma = Database.prototype.pragma
    let raced = false
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      const result = originalPragma.call(this, sql, options)
      if (!raced && sql === 'user_version' && Number(result) === 0) {
        raced = true
        competing.connection().pragma(`user_version = ${futureVersion}`)
      }
      return result
    })

    expect(() => first.connection()).not.toThrow()
    expect(raced).toBe(true)
    expect(first.isReadOnly()).toBe(true)
    expect(first.connection().pragma('user_version', { simple: true })).toBe(futureVersion)
    expect(() => first.assertWritable()).toThrow('database is read-only')
    expect(competing.connection().pragma('user_version', { simple: true })).toBe(futureVersion)
  })

  it('migrates version-one enrollments with durable control defaults', () => {
    const databaseDirectory = join(root, 'fork-heimdall')
    mkdirSync(databaseDirectory, { recursive: true })
    const databasePath = join(databaseDirectory, 'heimdall.db')
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE heimdall_enrollment (
        watcher_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        execution_host_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        worktree_id TEXT,
        workspace_path TEXT NOT NULL,
        scheduler_owner TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        capabilities_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        kind_payload_json TEXT NOT NULL,
        coordinator_handle TEXT NOT NULL,
        coordinator_pane_key TEXT NOT NULL,
        orchestration_run_id TEXT,
        created_at_ms INTEGER NOT NULL,
        terminal_at_ms INTEGER
      );
      INSERT INTO heimdall_enrollment VALUES (
        'watcher-legacy', 'hosted-review', 'local::/workspace', 'local', 'repo-1', NULL,
        '/workspace', 'local_host_service', 1, '{}',
        '{"wallClockActiveMs":null,"turns":null}', '{}', 'coordinator', 'pane', NULL, 1, NULL
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new HeimdallDatabase(root)
    opened.push(migrated)
    expect(
      migrated
        .connection()
        .prepare('SELECT paused, command_revision FROM heimdall_enrollment WHERE watcher_id = ?')
        .get('watcher-legacy')
    ).toEqual({ paused: 0, command_revision: 0 })
    expect(migrated.connection().pragma('user_version', { simple: true })).toBe(
      HEIMDALL_DATABASE_SCHEMA_VERSION
    )
  })

  it('migrates version-two enrollments with a null owner default', () => {
    const databaseDirectory = join(root, 'fork-heimdall')
    mkdirSync(databaseDirectory, { recursive: true })
    const databasePath = join(databaseDirectory, 'heimdall.db')
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE heimdall_enrollment (
        watcher_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        execution_host_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        worktree_id TEXT,
        workspace_path TEXT NOT NULL,
        scheduler_owner TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        command_revision INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        kind_payload_json TEXT NOT NULL,
        coordinator_handle TEXT NOT NULL,
        coordinator_pane_key TEXT NOT NULL,
        orchestration_run_id TEXT,
        created_at_ms INTEGER NOT NULL,
        terminal_at_ms INTEGER
      );
      INSERT INTO heimdall_enrollment VALUES (
        'watcher-legacy', 'hosted-review', 'local::/workspace', 'local', 'repo-1', NULL,
        '/workspace', 'local_host_service', 1, 0, 0, '{}',
        '{"wallClockActiveMs":null,"turns":null}', '{}', 'coordinator', 'pane', NULL, 1, NULL
      );
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const migrated = new HeimdallDatabase(root)
    opened.push(migrated)
    expect(
      migrated
        .connection()
        .prepare('SELECT owner_json FROM heimdall_enrollment WHERE watcher_id = ?')
        .get('watcher-legacy')
    ).toEqual({ owner_json: null })
    expect(migrated.connection().pragma('user_version', { simple: true })).toBe(
      HEIMDALL_DATABASE_SCHEMA_VERSION
    )
  })
})
