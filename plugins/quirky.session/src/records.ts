import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentKind,
  AgentStatusSummary,
  ExitCause,
  PluginStore,
  PromptDeliveryState,
  LaunchSettings,
  Session,
  SessionBadge,
  SessionLaunch,
  SessionProviderSession,
  SessionStatus,
  StoreMigration
} from '@quirky/protocol'

type Row = {
  id: string
  kind: Session['kind']
  agent: Session['agent']
  worktree_id: string
  cwd: string
  title: string
  status: SessionStatus
  created_at: number
  last_activity_at: number
  exit_code: number | null
  exit_signal: string | null
  exit_cause: ExitCause | null
  restorable: number
  background: number
  launch: string | null
  provider_session: string | null
  prompt_delivery: PromptDeliveryState | null
  resumed_from: string | null
  launch_settings: string | null
  agent_status: string | null
  name: string | null
  unread: Session['unread']
  badges: string | null
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

const badgesOf = (text: string | null): Pick<Session, 'badges'> => {
  const badges = parseJson<Record<string, SessionBadge>>(text)
  return badges ? { badges } : {}
}

const toSession = (row: Row): Session => ({
  id: row.id,
  kind: row.kind,
  agent: row.agent,
  worktreeId: row.worktree_id,
  cwd: row.cwd,
  title: row.title,
  status: row.status,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
  exitCode: row.exit_code,
  exitSignal: row.exit_signal,
  exitCause: row.exit_cause,
  restorable: row.restorable === 1,
  ...(row.background === 1 ? { background: true } : {}),
  launch: parseJson<SessionLaunch>(row.launch),
  providerSession: parseJson<SessionProviderSession>(row.provider_session),
  promptDelivery: row.prompt_delivery,
  launchSettings: parseJson<LaunchSettings>(row.launch_settings),
  resumedFrom: row.resumed_from,
  agentStatus: parseJson<AgentStatusSummary>(row.agent_status),
  name: row.name,
  unread: row.unread,
  ...badgesOf(row.badges)
})

const jsonOrNull = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value))

/** The v1 column set, which is all that exists while migration 1 imports a v1 home. */
const INSERT = `INSERT OR IGNORE INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/** Copies the sessions table of a v1 home, if it has one; a home that never had `repo_id` imports it as null. */
function importV1Sessions(store: PluginStore, home: string): void {
  const path = join(home, 'quirky.db')
  if (!existsSync(path)) return
  const v1 = new Database(path, { readonly: true })
  try {
    if (!v1.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) return
    const rows = v1.query('SELECT * FROM sessions ORDER BY created_at, id').all() as (Row & { repo_id?: string | null })[]
    for (const row of rows) {
      store.run(
        INSERT,
        row.id,
        row.kind,
        row.agent,
        row.worktree_id,
        row.cwd,
        row.title,
        row.status,
        row.created_at,
        row.last_activity_at,
        row.exit_code,
        row.repo_id ?? null
      )
    }
  } finally {
    v1.close()
  }
}

export function sessionMigrations(home: string): StoreMigration[] {
  return [
    (store) => {
      store.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          agent TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          exit_code INTEGER,
          repo_id TEXT
        )
      `)
      importV1Sessions(store, home)
    },
    (store) => {
      store.exec(`
        ALTER TABLE sessions ADD COLUMN launch TEXT;
        ALTER TABLE sessions ADD COLUMN provider_session TEXT;
        ALTER TABLE sessions ADD COLUMN prompt_delivery TEXT;
        ALTER TABLE sessions ADD COLUMN resumed_from TEXT
      `)
    },
    (store) => {
      store.exec('ALTER TABLE sessions ADD COLUMN launch_settings TEXT')
    },
    (store) => {
      store.exec(`
        ALTER TABLE sessions ADD COLUMN exit_signal TEXT;
        ALTER TABLE sessions ADD COLUMN exit_cause TEXT;
        ALTER TABLE sessions ADD COLUMN restorable INTEGER NOT NULL DEFAULT 0
      `)
    },
    (store) => {
      store.exec('ALTER TABLE sessions ADD COLUMN agent_status TEXT')
    },
    (store) => {
      store.exec('ALTER TABLE sessions ADD COLUMN unread TEXT')
    },
    (store) => {
      store.exec('ALTER TABLE sessions ADD COLUMN name TEXT')
    },
    (store) => {
      store.exec('ALTER TABLE sessions ADD COLUMN badges TEXT')
    },
    (store) => {
      store.exec('ALTER TABLE sessions ADD COLUMN background INTEGER NOT NULL DEFAULT 0')
    }
  ]
}

/** The session records in the plugin's store. */
export class SessionRecords {
  constructor(private readonly store: PluginStore) {}

  list(worktreeId?: string): Session[] {
    const rows =
      worktreeId === undefined
        ? this.store.all<Row>('SELECT * FROM sessions ORDER BY created_at, rowid')
        : this.store.all<Row>('SELECT * FROM sessions WHERE worktree_id = ? ORDER BY created_at, rowid', worktreeId)
    return rows.map(toSession)
  }

  get(id: string): Session | null {
    const row = this.store.get<Row>('SELECT * FROM sessions WHERE id = ?', id)
    return row ? toSession(row) : null
  }

  /** Every record holding `name` (already lowercase), in any status, oldest first. */
  byName(name: string): Session[] {
    return this.store.all<Row>('SELECT * FROM sessions WHERE name = ? ORDER BY created_at, rowid', name).map(toSession)
  }

  /** Runs `work` as one store transaction. */
  transaction<T>(work: () => T): T {
    return this.store.transaction(work)
  }

  /** True when some record, in any state, belongs to the worktree ID. */
  hasWorktree(worktreeId: string): boolean {
    return this.store.get('SELECT 1 FROM sessions WHERE worktree_id = ? LIMIT 1', worktreeId) !== null
  }

  /** The repo recorded for a session, which `Session` does not carry. */
  repoIdOf(id: string): string | null {
    return this.store.get<{ repo_id: string | null }>('SELECT repo_id FROM sessions WHERE id = ?', id)?.repo_id ?? null
  }

  insert(session: Session, repoId: string | null): void {
    this.store.run(
      `INSERT OR IGNORE INTO sessions (id, kind, agent, worktree_id, cwd, title, status, created_at, last_activity_at, exit_code, repo_id,
        launch, provider_session, prompt_delivery, resumed_from, launch_settings, exit_signal, exit_cause, restorable, agent_status, name, background)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      repoId,
      jsonOrNull(session.launch),
      jsonOrNull(session.providerSession),
      session.promptDelivery ?? null,
      session.resumedFrom ?? null,
      jsonOrNull(session.launchSettings),
      session.exitSignal,
      session.exitCause,
      session.restorable ? 1 : 0,
      jsonOrNull(session.agentStatus),
      session.name ?? null,
      session.background === true ? 1 : 0
    )
  }

  /**
   * Changes only the fields given (an `undefined` field is left alone), so a write never reverts a
   * column another call changed since the caller read the record. Returns the stored record.
   */
  update(
    id: string,
    fields: {
      status?: SessionStatus
      agent?: AgentKind
      lastActivityAt?: number
      exitCode?: number | null
      exitSignal?: string | null
      exitCause?: ExitCause | null
      restorable?: boolean
      background?: boolean
      launch?: SessionLaunch | null
      providerSession?: SessionProviderSession | null
      promptDelivery?: PromptDeliveryState | null
      launchSettings?: LaunchSettings | null
      agentStatus?: AgentStatusSummary | null
      name?: string | null
      unread?: Session['unread']
      badges?: Record<string, SessionBadge> | null
    }
  ): Session | null {
    const columns: [string, string | number | null][] = []
    if (fields.status !== undefined) columns.push(['status', fields.status])
    if (fields.agent !== undefined) columns.push(['agent', fields.agent])
    if (fields.lastActivityAt !== undefined) columns.push(['last_activity_at', fields.lastActivityAt])
    if (fields.exitCode !== undefined) columns.push(['exit_code', fields.exitCode])
    if (fields.exitSignal !== undefined) columns.push(['exit_signal', fields.exitSignal])
    if (fields.exitCause !== undefined) columns.push(['exit_cause', fields.exitCause])
    if (fields.restorable !== undefined) columns.push(['restorable', fields.restorable ? 1 : 0])
    if (fields.background !== undefined) columns.push(['background', fields.background ? 1 : 0])
    if (fields.launch !== undefined) columns.push(['launch', jsonOrNull(fields.launch)])
    if (fields.providerSession !== undefined) columns.push(['provider_session', jsonOrNull(fields.providerSession)])
    if (fields.promptDelivery !== undefined) columns.push(['prompt_delivery', fields.promptDelivery])
    if (fields.launchSettings !== undefined) columns.push(['launch_settings', jsonOrNull(fields.launchSettings)])
    if (fields.agentStatus !== undefined) columns.push(['agent_status', jsonOrNull(fields.agentStatus)])
    if (fields.name !== undefined) columns.push(['name', fields.name])
    if (fields.unread !== undefined) columns.push(['unread', fields.unread])
    if (fields.badges !== undefined) columns.push(['badges', fields.badges && Object.keys(fields.badges).length > 0 ? JSON.stringify(fields.badges) : null])
    if (columns.length > 0) {
      this.store.run(
        `UPDATE sessions SET ${columns.map(([name]) => `${name} = ?`).join(', ')} WHERE id = ?`,
        ...columns.map(([, value]) => value),
        id
      )
    }
    return this.get(id)
  }

  /** Marks every delivery still pending as not-delivered; returns the IDs changed. */
  sweepPendingDeliveries(): string[] {
    const ids = this.store
      .all<{ id: string }>("SELECT id FROM sessions WHERE prompt_delivery = 'pending' ORDER BY created_at, rowid")
      .map((row) => row.id)
    this.store.run("UPDATE sessions SET prompt_delivery = 'not-delivered' WHERE prompt_delivery = 'pending'")
    return ids
  }

  delete(id: string): void {
    this.store.run('DELETE FROM sessions WHERE id = ?', id)
  }
}
