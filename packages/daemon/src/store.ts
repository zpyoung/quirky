import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Ask,
  AskEnvelope,
  AskSpec,
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

/** SQLite persistence for repos, sessions, asks, structured messages and settings. */
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
}

function toRepo(row: Row): Repo {
  return { id: row.id, name: row.name, path: row.path, addedAt: row.added_at }
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
