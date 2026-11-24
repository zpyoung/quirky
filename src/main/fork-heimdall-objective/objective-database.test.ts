import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { OBJECTIVE_DATABASE_SCHEMA_VERSION, ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { allRows } from './objective-store-queries'

const WATCHER_ID = 'watcher-objective-1'
let root: string
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-objective-database-'))
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
  rmSync(root, { recursive: true, force: true })
})

describe('Objective database initialization', () => {
  it('creates only the current objective tables with durable connection settings and POSIX hardening', () => {
    const disk = new ObjectiveDatabase(root)
    opened.push(disk)
    const connection = disk.connection()
    const tables = allRows<{ name: string }>(
      connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
    )
    // sorted so a future table only needs adding here, not placed correctly against SQLite's
    // own ORDER BY name collation (which sorts review_verdict before revision_amendment)
    expect(tables.map(({ name }) => name)).toEqual(
      [
        'acceptance_criterion',
        'check_attempt',
        'gate_attempt',
        'landing_evidence',
        'objective_dispatch',
        'objective_parallel_state',
        'plan_node',
        'plan_patch',
        'plan_review',
        'plan_revision',
        'revision_amendment',
        'review_verdict'
      ].sort()
    )
    expect(connection.pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION
    )
    expect(connection.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(connection.pragma('busy_timeout', { simple: true })).toBe(5_000)
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(connection.pragma('synchronous', { simple: true })).toBe(2)
    if (process.platform !== 'win32') {
      expect(statSync(disk.databasePath()).mode & 0o777).toBe(0o600)
    }
  })

  it('opens a future schema read-only without downgrading it', () => {
    const path = join(root, 'fork-heimdall-objective', 'objective.db')
    mkdirSync(join(root, 'fork-heimdall-objective'), { recursive: true })
    const future = new Database(path)
    future.pragma(`user_version = ${OBJECTIVE_DATABASE_SCHEMA_VERSION + 1}`)
    future.close()
    const disk = new ObjectiveDatabase(root)
    opened.push(disk)
    const futureStore = new ObjectiveStore(disk)

    expect(disk.isReadOnly()).toBe(true)
    expect(disk.connection().pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION + 1
    )
    expect(() => futureStore.purge(WATCHER_ID)).toThrow(/read-only/)
  })

  it('migrates a v1 database to the current schema without losing data', () => {
    const path = join(root, 'fork-heimdall-objective', 'objective.db')
    mkdirSync(join(root, 'fork-heimdall-objective'), { recursive: true })
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE plan_revision (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
        payload_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_by_dispatch_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        approved_at_ms INTEGER,
        UNIQUE (watcher_id, revision_number)
      );
      CREATE TABLE plan_node (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        deps_json TEXT NOT NULL,
        orchestration_task_id TEXT,
        dispatch_id TEXT,
        dispatched_at_ms INTEGER,
        UNIQUE (revision_id, task_key)
      );
      CREATE TABLE acceptance_criterion (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        task_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        body TEXT NOT NULL,
        shell_checkable INTEGER NOT NULL CHECK (shell_checkable IN (0, 1)),
        check_command TEXT,
        UNIQUE (revision_id, task_key, ordinal)
      );
      CREATE TABLE check_attempt (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL REFERENCES acceptance_criterion(id),
        content_identity TEXT NOT NULL,
        execution_host_id TEXT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER,
        timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
        stdout_tail TEXT NOT NULL,
        stderr_tail TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        UNIQUE (criterion_id, content_identity)
      );
      INSERT INTO plan_revision VALUES (
        'revision-legacy', 'watcher-legacy', 1, 'approved', '{"plan":[]}', 'digest-legacy',
        'planner-legacy', 1, 1
      );
      INSERT INTO plan_node VALUES (
        'node-legacy', 'watcher-legacy', 'revision-legacy', 'task-legacy', 'Legacy title',
        'Legacy spec', '[]', NULL, NULL, NULL
      );
      INSERT INTO acceptance_criterion VALUES (
        'criterion-legacy', 'watcher-legacy', 'revision-legacy', 'task-legacy', 0,
        'Legacy criterion', 1, 'true'
      );
      INSERT INTO check_attempt VALUES (
        'check-legacy', 'watcher-legacy', 'criterion-legacy', 'content-legacy', 'local',
        'true', 0, 0, '', '', 1, 1, 2
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new ObjectiveDatabase(root)
    opened.push(migrated)
    const connection = migrated.connection()
    expect(
      connection.prepare('SELECT amended_at_ms FROM plan_node WHERE id = ?').get('node-legacy')
    ).toEqual({ amended_at_ms: null })
    expect(
      connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revision_amendment'"
        )
        .get()
    ).toBeDefined()
    expect(
      connection.prepare('SELECT owner_skip FROM check_attempt WHERE id = ?').get('check-legacy')
    ).toEqual({ owner_skip: 0 })
    expect(connection.pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION
    )
  })

  it('migrates a v4 database to v5 preserving existing rows', () => {
    const path = join(root, 'fork-heimdall-objective', 'objective.db')
    mkdirSync(join(root, 'fork-heimdall-objective'), { recursive: true })
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE plan_revision (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
        payload_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_by_dispatch_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        approved_at_ms INTEGER,
        UNIQUE (watcher_id, revision_number)
      );
      CREATE UNIQUE INDEX objective_plan_revision_draft
        ON plan_revision (watcher_id)
        WHERE status = 'draft';
      CREATE TABLE plan_node (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        deps_json TEXT NOT NULL,
        orchestration_task_id TEXT,
        dispatch_id TEXT,
        dispatched_at_ms INTEGER,
        amended_at_ms INTEGER,
        ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
        UNIQUE (revision_id, task_key)
      );
      CREATE TABLE acceptance_criterion (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        task_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        body TEXT NOT NULL,
        shell_checkable INTEGER NOT NULL CHECK (shell_checkable IN (0, 1)),
        check_command TEXT,
        UNIQUE (revision_id, task_key, ordinal)
      );
      CREATE TABLE check_attempt (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        criterion_id TEXT NOT NULL REFERENCES acceptance_criterion(id),
        content_identity TEXT NOT NULL,
        execution_host_id TEXT NOT NULL,
        command TEXT NOT NULL,
        exit_code INTEGER,
        timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
        stdout_tail TEXT NOT NULL,
        stderr_tail TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        owner_skip INTEGER NOT NULL DEFAULT 0 CHECK (owner_skip IN (0, 1)),
        UNIQUE (criterion_id, content_identity)
      );
      CREATE TABLE review_verdict (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        dispatch_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('reviewer', 'integrator')),
        content_identity TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'block')),
        criteria_results_json TEXT NOT NULL,
        report_digest TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (dispatch_id)
      );
      CREATE TABLE landing_evidence (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        rung TEXT NOT NULL CHECK (rung IN ('files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', 'merged')),
        content_identity TEXT NOT NULL,
        attempt_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (watcher_id, rung, content_identity)
      );
      CREATE TABLE revision_amendment (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        digest TEXT NOT NULL,
        amended_at_ms INTEGER NOT NULL,
        attestation TEXT NOT NULL,
        touched_task_keys_json TEXT NOT NULL,
        UNIQUE (revision_id, ordinal),
        UNIQUE (revision_id, digest)
      );
      CREATE TABLE objective_dispatch (
        attempt_fingerprint TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        execution_host_id TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES plan_revision(id),
        task_key TEXT NOT NULL,
        plan_task_digest TEXT NOT NULL,
        dispatch_id TEXT,
        workspace_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        lane_task_keys_json TEXT NOT NULL,
        session_node_count INTEGER NOT NULL CHECK (session_node_count BETWEEN 1 AND 5),
        state TEXT NOT NULL CHECK (state IN (
          'running', 'waiting-to-apply', 'applying', 'resolving-conflict',
          'applied', 'failed', 'discarded'
        )),
        commit_sha TEXT,
        applied_commit_sha TEXT,
        report_digest TEXT,
        conflict_paths_json TEXT NOT NULL,
        conflicting_task_keys_json TEXT NOT NULL,
        conflicting_dispatch_ids_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        terminal_handle TEXT,
        setup_state TEXT NOT NULL CHECK (setup_state IN (
          'pending', 'ready', 'cleanup-pending', 'retained', 'cleaned'
        )),
        report_path TEXT,
        report_json TEXT,
        task_json TEXT NOT NULL,
        UNIQUE (watcher_id, dispatch_id)
      );
      CREATE TABLE objective_parallel_state (
        watcher_id TEXT PRIMARY KEY,
        note TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO plan_revision VALUES (
        'revision-v4', 'watcher-v4', 1, 'approved', '{"plan":[]}', 'digest-v4',
        'planner-v4', 1, 1
      );
      INSERT INTO plan_node VALUES (
        'node-v4', 'watcher-v4', 'revision-v4', 'task-v4', 'V4 title',
        'V4 spec', '[]', NULL, NULL, NULL, NULL, 0
      );
      PRAGMA user_version = 4;
    `)
    legacy.close()

    const migrated = new ObjectiveDatabase(root)
    opened.push(migrated)
    const connection = migrated.connection()
    expect(connection.prepare('SELECT title FROM plan_node WHERE id = ?').get('node-v4')).toEqual({
      title: 'V4 title'
    })
    for (const table of ['plan_patch', 'plan_review', 'gate_attempt']) {
      expect(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table)
      ).toBeDefined()
    }
    expect(connection.pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION
    )
  })
})
