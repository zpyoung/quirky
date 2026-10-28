import { Database } from 'bun:sqlite'
import type { DistroManifest } from '@quirky/protocol'

type Row = Record<string, any>

/** What a recorded request produced: its result, or the error it failed with. */
export type RequestOutcome = { result: unknown } | { error: { code: number; message: string; data?: unknown } }

/** One recorded call, kept so a repeat with the same request ID returns the first outcome. */
export interface RequestRow {
  requestId: string
  digest: string
  outcome: RequestOutcome
  createdAt: number
}

/** A confirm ask issued for one destructive call; `used` flips once when the confirmation runs it. */
export interface ConfirmationRow {
  askId: string
  method: string
  digest: string
  used: boolean
  createdAt: number
}

/** The installed distro: its manifest and the IDs of the plugins it installed. */
export interface DistroRow {
  id: string
  manifest: DistroManifest
  plugins: string[]
  installedAt: number
}

export interface JobRun {
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'ok' | 'failed' | 'timed-out'
  error?: string
}

export interface RuntimeAuthorityRow {
  sessionId: string
  tokenHash: string
  runtimeEpoch: string
  processIncarnation: string
  ptyHostPid: number | null
  ptyPid: number | null
  ptyCreatedAt: number | null
}

/**
 * SQLite persistence for settings, UI state, requests, confirmations, distro data and hashed runtime authority.
 * The tables v1 wrote (repos, sessions, asks and the rest) stay readable for the legacy importer.
 */
export class Store {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        exit_code INTEGER
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        spec TEXT NOT NULL,
        session_id TEXT,
        worktree_id TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        answers TEXT NOT NULL,
        skipped TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS structured_messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        data TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setting_values (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ui_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS disabled_ids (id TEXT PRIMARY KEY, disabled_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
        status TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS request_log (
        request_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS confirmations (
        ask_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        digest TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_authorities (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        runtime_epoch TEXT NOT NULL,
        process_incarnation TEXT NOT NULL,
        pty_host_pid INTEGER,
        pty_pid INTEGER,
        pty_created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS distro (
        id TEXT PRIMARY KEY,
        manifest TEXT NOT NULL,
        plugins TEXT NOT NULL,
        installed_at INTEGER NOT NULL
      );
    `)
    const sessionColumns = this.db.query('PRAGMA table_info(sessions)').all() as Row[]
    if (!sessionColumns.some((column) => column.name === 'repo_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN repo_id TEXT')
    }
  }

  close(): void {
    this.db.close()
  }

  getRuntimeAuthority(sessionId: string): RuntimeAuthorityRow | null {
    const row = this.db.query('SELECT * FROM runtime_authorities WHERE session_id = ?').get(sessionId) as Row | null
    return row ? runtimeAuthorityOf(row) : null
  }

  listRuntimeAuthorities(): RuntimeAuthorityRow[] {
    return (this.db.query('SELECT * FROM runtime_authorities').all() as Row[]).map(runtimeAuthorityOf)
  }

  putRuntimeAuthority(authority: RuntimeAuthorityRow): void {
    this.db
      .query(
        `INSERT INTO runtime_authorities (
          session_id, token_hash, runtime_epoch, process_incarnation, pty_host_pid, pty_pid, pty_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          token_hash = excluded.token_hash,
          runtime_epoch = excluded.runtime_epoch,
          process_incarnation = excluded.process_incarnation,
          pty_host_pid = excluded.pty_host_pid,
          pty_pid = excluded.pty_pid,
          pty_created_at = excluded.pty_created_at`
      )
      .run(
        authority.sessionId,
        authority.tokenHash,
        authority.runtimeEpoch,
        authority.processIncarnation,
        authority.ptyHostPid,
        authority.ptyPid,
        authority.ptyCreatedAt
      )
  }

  deleteRuntimeAuthority(sessionId: string): void {
    this.db.query('DELETE FROM runtime_authorities WHERE session_id = ?').run(sessionId)
  }

  /** The v1 `settings` table as stored: key to decoded value; empty once v1 never wrote any. */
  legacySettings(): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const row of this.db.query('SELECT key, value FROM settings').all() as Row[]) {
      try {
        values[row.key] = JSON.parse(row.value)
      } catch {
        continue
      }
    }
    return values
  }

  /** The stored value of the plugin setting `id`, or null when none is stored. */
  getSettingValue(id: string): { value: unknown } | null {
    const row = this.db.query('SELECT value FROM setting_values WHERE id = ?').get(id) as Row | null
    return row ? { value: JSON.parse(row.value) } : null
  }

  /** Stores `value` as the plugin setting `id`, replacing any earlier value. */
  setSettingValue(id: string, value: unknown): void {
    this.db
      .query(
        'INSERT INTO setting_values (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      )
      .run(id, JSON.stringify(value), Date.now())
  }

  /** Drops the stored value of the plugin setting `id`; a no-op when none is stored. */
  deleteSettingValue(id: string): void {
    this.db.query('DELETE FROM setting_values WHERE id = ?').run(id)
  }

  /** The window state stored under `key` (such as the chosen theme), or null when none is stored. */
  getUiState(key: string): unknown | null {
    const row = this.db.query('SELECT value FROM ui_state WHERE key = ?').get(key) as Row | null
    return row ? JSON.parse(row.value) : null
  }

  /** Stores `value` as the window state under `key`, replacing any earlier value. */
  setUiState(key: string, value: unknown): void {
    this.db
      .query('INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  /** IDs of contributions and plugins the user has disabled, sorted ascending. */
  listDisabledIds(): string[] {
    return (this.db.query('SELECT id FROM disabled_ids ORDER BY id').all() as Row[]).map((row) => row.id)
  }

  /** Marks `id` disabled (keeping the original timestamp if it already is) or clears it. */
  setDisabledId(id: string, disabled: boolean): void {
    if (disabled) {
      this.db.query('INSERT OR IGNORE INTO disabled_ids (id, disabled_at) VALUES (?, ?)').run(id, Date.now())
    } else {
      this.db.query('DELETE FROM disabled_ids WHERE id = ?').run(id)
    }
  }

  /** The last recorded run of each job, keyed by job id. */
  listJobRuns(): Map<string, JobRun> {
    const runs = new Map<string, JobRun>()
    for (const row of this.db.query('SELECT * FROM job_runs').all() as Row[]) {
      runs.set(row.id, {
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        ...(row.error === null ? {} : { error: row.error })
      })
    }
    return runs
  }

  /** Records a job as running from `at`, replacing any previous run of the same id. */
  recordJobStart(id: string, at: number): void {
    this.db
      .query(
        `INSERT INTO job_runs (id, started_at, finished_at, status, error) VALUES (?, ?, NULL, 'running', NULL)
         ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, status = 'running', error = NULL`
      )
      .run(id, at)
  }

  recordJobFinish(id: string, at: number, status: 'ok' | 'failed' | 'timed-out', error?: string): void {
    this.db
      .query('UPDATE job_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?')
      .run(at, status, error ?? null, id)
  }

  /** The recorded call with this request ID, or null. */
  getRequest(requestId: string): RequestRow | null {
    const row = this.db.query('SELECT * FROM request_log WHERE request_id = ?').get(requestId) as Row | null
    return row
      ? { requestId: row.request_id, digest: row.digest, outcome: JSON.parse(row.outcome), createdAt: row.created_at }
      : null
  }

  /** Records a call's outcome under its request ID, replacing any earlier record. */
  putRequest(request: RequestRow): void {
    this.db
      .query(
        `INSERT INTO request_log (request_id, digest, outcome, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET digest = excluded.digest, outcome = excluded.outcome, created_at = excluded.created_at`
      )
      .run(request.requestId, request.digest, JSON.stringify(request.outcome), request.createdAt)
  }

  /** Deletes records created before the epoch-millisecond cutoff `olderThanMs`; returns how many. */
  pruneRequests(olderThanMs: number): number {
    return this.db.query('DELETE FROM request_log WHERE created_at < ?').run(olderThanMs).changes
  }

  getConfirmation(askId: string): ConfirmationRow | null {
    const row = this.db.query('SELECT * FROM confirmations WHERE ask_id = ?').get(askId) as Row | null
    return row ? toConfirmation(row) : null
  }

  /** Records a confirm ask for a destructive call, replacing any earlier row for the same ask. */
  putConfirmation(confirmation: ConfirmationRow): void {
    this.db
      .query(
        `INSERT INTO confirmations (ask_id, method, digest, used, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ask_id) DO UPDATE SET method = excluded.method, digest = excluded.digest, used = excluded.used, created_at = excluded.created_at`
      )
      .run(confirmation.askId, confirmation.method, confirmation.digest, confirmation.used ? 1 : 0, confirmation.createdAt)
  }

  /** Marks the confirmation used; false when it is missing or already used, so only one caller wins. */
  markConfirmationUsed(askId: string): boolean {
    return this.db.query('UPDATE confirmations SET used = 1 WHERE ask_id = ? AND used = 0').run(askId).changes > 0
  }

  /** Deletes confirmations created before the epoch-millisecond cutoff `olderThanMs`; returns how many. */
  pruneConfirmations(olderThanMs: number): number {
    return this.db.query('DELETE FROM confirmations WHERE created_at < ?').run(olderThanMs).changes
  }

  /** The installed distro, or null; at most one is installed at a time. */
  getDistro(): DistroRow | null {
    const row = this.db.query('SELECT * FROM distro ORDER BY installed_at, id LIMIT 1').get() as Row | null
    return row
      ? {
          id: row.id,
          manifest: JSON.parse(row.manifest),
          plugins: JSON.parse(row.plugins),
          installedAt: row.installed_at
        }
      : null
  }

  putDistro(distro: DistroRow): void {
    this.db
      .query(
        `INSERT INTO distro (id, manifest, plugins, installed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, plugins = excluded.plugins, installed_at = excluded.installed_at`
      )
      .run(distro.id, JSON.stringify(distro.manifest), JSON.stringify(distro.plugins), distro.installedAt)
  }

  deleteDistro(id: string): void {
    this.db.query('DELETE FROM distro WHERE id = ?').run(id)
  }

  /** Stamps the real finish time on a run that was marked timed-out earlier; other statuses are untouched. */
  recordJobSettled(id: string, at: number): void {
    this.db.query("UPDATE job_runs SET finished_at = ? WHERE id = ? AND status = 'timed-out'").run(at, id)
  }
}

function toConfirmation(row: Row): ConfirmationRow {
  return { askId: row.ask_id, method: row.method, digest: row.digest, used: row.used === 1, createdAt: row.created_at }
}

function runtimeAuthorityOf(row: Row): RuntimeAuthorityRow {
  return {
    sessionId: row.session_id,
    tokenHash: row.token_hash,
    runtimeEpoch: row.runtime_epoch,
    processIncarnation: row.process_incarnation,
    ptyHostPid: row.pty_host_pid,
    ptyPid: row.pty_pid,
    ptyCreatedAt: row.pty_created_at
  }
}
