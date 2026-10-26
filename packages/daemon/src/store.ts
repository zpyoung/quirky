import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Ask,
  AskEnvelope,
  AskSpec,
  DistroManifest,
  Repo,
  Session,
  SessionStatus,
  Settings,
  StructuredMessage,
  StructuredRole
} from '@quirky/protocol'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export function defaultSettings(): Settings {
  return {
    worktreesRoot: join(homedir(), 'quirky', 'workspaces'),
    terminalScrollback: 2000,
    notifications: true
  }
}

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

/** SQLite persistence for repos, sessions, asks, structured messages, settings, plugin setting values, UI state, disabled IDs and job runs. */
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

  listRepos(): Repo[] {
    return (this.db.query('SELECT * FROM repos ORDER BY added_at, id').all() as Row[]).map(toRepo)
  }

  getRepo(id: string): Repo | null {
    const row = this.db.query('SELECT * FROM repos WHERE id = ?').get(id) as Row | null
    return row ? toRepo(row) : null
  }

  getRepoByPath(path: string): Repo | null {
    const row = this.db.query('SELECT * FROM repos WHERE path = ?').get(path) as Row | null
    return row ? toRepo(row) : null
  }

  insertRepo(repo: Repo): void {
    this.db
      .query('INSERT INTO repos (id, name, path, added_at) VALUES (?, ?, ?, ?)')
      .run(repo.id, repo.name, repo.path, repo.addedAt)
  }

  deleteRepo(id: string): void {
    this.db.query('DELETE FROM repos WHERE id = ?').run(id)
    this.db.query('DELETE FROM worktrees WHERE repo_id = ?').run(id)
  }

  /** Remembers which repo each worktree id belongs to, so ownership never depends on git later. */
  recordWorktrees(repoId: string, worktreeIds: string[]): void {
    const upsert = this.db.query(
      'INSERT INTO worktrees (id, repo_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id'
    )
    this.db.transaction(() => {
      for (const id of worktreeIds) upsert.run(id, repoId)
    })()
  }

  /**
   * Sessions owned by a repo: those created for it, plus rows that predate recorded ownership
   * whose worktree id is recorded for the repo or listed in `legacyWorktreeIds`.
   */
  listSessionsForRepo(repoId: string, legacyWorktreeIds: string[] = []): Session[] {
    const legacy = new Set(legacyWorktreeIds)
    const recorded = new Set(
      (this.db.query('SELECT id FROM worktrees WHERE repo_id = ?').all(repoId) as Row[]).map((row) => row.id)
    )
    const rows = this.db.query('SELECT * FROM sessions ORDER BY created_at, id').all() as Row[]
    return rows
      .filter((row) =>
        row.repo_id === null
          ? recorded.has(row.worktree_id) || legacy.has(row.worktree_id)
          : row.repo_id === repoId
      )
      .map(toSession)
  }

  listSessions(worktreeId?: string): Session[] {
    const rows = worktreeId
      ? this.db.query('SELECT * FROM sessions WHERE worktree_id = ? ORDER BY created_at, id').all(worktreeId)
      : this.db.query('SELECT * FROM sessions ORDER BY created_at, id').all()
    return (rows as Row[]).map(toSession)
  }

  getSession(id: string): Session | null {
    const row = this.db.query('SELECT * FROM sessions WHERE id = ?').get(id) as Row | null
    return row ? toSession(row) : null
  }

  insertSession(session: Session, repoId: string | null = null): void {
    this.db
      .query(
        `INSERT INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.kind,
        session.agent,
        session.worktreeId,
        session.cwd,
        session.title,
        session.status,
        session.createdAt,
        session.lastActivityAt,
        session.exitCode,
        repoId
      )
  }

  updateSession(
    id: string,
    fields: { status?: SessionStatus; lastActivityAt?: number; exitCode?: number | null }
  ): Session | null {
    const current = this.getSession(id)
    if (!current) return null
    const next = { ...current, ...fields }
    this.db
      .query('UPDATE sessions SET status = ?, last_activity_at = ?, exit_code = ? WHERE id = ?')
      .run(next.status, next.lastActivityAt, next.exitCode, id)
    return next
  }

  deleteSession(id: string): void {
    this.db.query('DELETE FROM sessions WHERE id = ?').run(id)
    this.db.query('DELETE FROM structured_messages WHERE session_id = ?').run(id)
  }

  insertAsk(ask: Ask): void {
    this.db
      .query(
        `INSERT INTO asks (id, spec, session_id, worktree_id, created_at, status, answers, skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ask.id,
        JSON.stringify(ask.spec),
        ask.sessionId,
        ask.worktreeId,
        ask.createdAt,
        ask.envelope.status,
        JSON.stringify(ask.envelope.answers),
        JSON.stringify(ask.envelope.skipped)
      )
  }

  getAsk(id: string): Ask | null {
    const row = this.db.query('SELECT * FROM asks WHERE id = ?').get(id) as Row | null
    return row ? toAsk(row) : null
  }

  listAsks(pendingOnly: boolean): Ask[] {
    const rows = pendingOnly
      ? this.db.query("SELECT * FROM asks WHERE status = 'pending' ORDER BY created_at, id").all()
      : this.db.query('SELECT * FROM asks ORDER BY created_at, id').all()
    return (rows as Row[]).map(toAsk)
  }

  updateAskEnvelope(envelope: AskEnvelope): void {
    this.db
      .query('UPDATE asks SET status = ?, answers = ?, skipped = ? WHERE id = ?')
      .run(envelope.status, JSON.stringify(envelope.answers), JSON.stringify(envelope.skipped), envelope.askId)
  }

  appendMessage(input: {
    sessionId: string
    role: StructuredRole
    text: string
    data?: unknown
    at: number
  }): StructuredMessage {
    const insert = this.db.transaction(() => {
      const row = this.db
        .query('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM structured_messages WHERE session_id = ?')
        .get(input.sessionId) as { next: number }
      this.db
        .query(
          'INSERT INTO structured_messages (session_id, seq, role, text, data, at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          input.sessionId,
          row.next,
          input.role,
          input.text,
          input.data === undefined ? null : JSON.stringify(input.data),
          input.at
        )
      return row.next
    })
    const seq = insert()
    const message: StructuredMessage = {
      sessionId: input.sessionId,
      seq,
      role: input.role,
      text: input.text,
      at: input.at
    }
    if (input.data !== undefined) message.data = input.data
    return message
  }

  listMessages(sessionId: string, afterSeq = 0): StructuredMessage[] {
    const rows = this.db
      .query('SELECT * FROM structured_messages WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, afterSeq) as Row[]
    return rows.map((row) => {
        const message: StructuredMessage = {
          sessionId: row.session_id,
          seq: row.seq,
          role: row.role,
          text: row.text,
          at: row.at
        }
        if (row.data !== null) message.data = JSON.parse(row.data)
        return message
      })
  }

  getSettings(): Settings {
    const settings: Record<string, unknown> = { ...defaultSettings() }
    for (const row of this.db.query('SELECT key, value FROM settings').all() as Row[]) {
      settings[row.key] = JSON.parse(row.value)
    }
    return settings as Settings
  }

  setSettings(values: Partial<Settings>): Settings {
    const upsert = this.db.query(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) upsert.run(key, JSON.stringify(value))
    }
    return this.getSettings()
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

function toRepo(row: Row): Repo {
  return { id: row.id, name: row.name, path: row.path, addedAt: row.added_at }
}

function toConfirmation(row: Row): ConfirmationRow {
  return { askId: row.ask_id, method: row.method, digest: row.digest, used: row.used === 1, createdAt: row.created_at }
}

function toSession(row: Row): Session {
  return {
    id: row.id,
    kind: row.kind,
    agent: row.agent,
    worktreeId: row.worktree_id,
    cwd: row.cwd,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    exitCode: row.exit_code
  }
}

function toAsk(row: Row): Ask {
  const spec = JSON.parse(row.spec) as AskSpec
  return {
    id: row.id,
    spec,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
    envelope: {
      status: row.status,
      askId: row.id,
      answers: JSON.parse(row.answers),
      skipped: JSON.parse(row.skipped)
    }
  }
}
