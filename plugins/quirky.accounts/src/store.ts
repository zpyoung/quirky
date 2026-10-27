import type { PluginStore, StoreMigration } from '@quirky/protocol'
import { DEFAULT_PREFERENCES, type AccountRecord, type AccountSessionRecord, type ManagedProvider, type Preferences } from './types'

type AccountRow = {
  id: string
  provider: ManagedProvider
  label: string
  email: string | null
  organization: string | null
  created_at: number
  updated_at: number
  last_authenticated_at: number | null
  needs_sign_in: number
  active: number
  home: string
  identity_key: string | null
  auth_kind: AccountRecord['authKind']
}

type SessionRow = {
  session_id: string
  provider: ManagedProvider
  account_id: string | null
  account_label: string
  source: AccountSessionRecord['source']
  home: string
  selection_revision: number
  worktree_id: string
  cwd: string
  agent: string
  busy: number
  kept: number
  error: string | null
}

export const migrations: StoreMigration[] = [
  `CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    label TEXT NOT NULL,
    email TEXT,
    organization TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_authenticated_at INTEGER,
    needs_sign_in INTEGER NOT NULL DEFAULT 0,
    home TEXT NOT NULL,
    identity_key TEXT,
    auth_kind TEXT NOT NULL DEFAULT 'unknown'
  );
  CREATE INDEX accounts_provider_updated ON accounts(provider, updated_at DESC);
  CREATE TABLE active_accounts (
    provider TEXT PRIMARY KEY CHECK (provider IN ('claude', 'codex')),
    account_id TEXT
  );
  CREATE TABLE preferences (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    value TEXT NOT NULL
  );
  CREATE TABLE account_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE account_sessions (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
    account_id TEXT,
    account_label TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('managed', 'default', 'custom')),
    home TEXT NOT NULL,
    selection_revision INTEGER NOT NULL,
    worktree_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    agent TEXT NOT NULL,
    busy INTEGER NOT NULL DEFAULT 0,
    kept INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX account_sessions_provider ON account_sessions(provider, session_id);
  CREATE TABLE restart_intentions (
    session_id TEXT PRIMARY KEY,
    target_id TEXT,
    selection_revision INTEGER NOT NULL
  );
  CREATE TABLE usage_snapshots (
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(provider, account_id)
  );
  CREATE TABLE reset_credit_ledger (
    idempotency_key TEXT PRIMARY KEY,
    account_id TEXT,
    account_revision INTEGER NOT NULL,
    offer_revision TEXT NOT NULL,
    state TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO account_state(key, value) VALUES ('revision', '0');
  INSERT OR IGNORE INTO preferences(singleton, value) VALUES (1, '{"mode":"compact","direction":"used","hidden":false,"visibleProviders":["claude","codex","gemini","antigravity","opencode-go","kimi","minimax","grok","cursor","zcode"],"density":"normal","claudeSwitchPolicy":"ask","skipCodexResetConfirm":false}');`
]

export function accountFromRow(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    email: row.email,
    organization: row.organization,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAuthenticatedAt: row.last_authenticated_at,
    needsSignIn: row.needs_sign_in === 1,
    active: row.active === 1,
    home: row.home,
    identityKey: row.identity_key,
    authKind: row.auth_kind
  }
}

export function getAccount(store: PluginStore, id: string): AccountRecord | null {
  const row = store.get<AccountRow>(`
    SELECT a.*, CASE WHEN s.account_id = a.id THEN 1 ELSE 0 END AS active
    FROM accounts a LEFT JOIN active_accounts s ON s.provider = a.provider
    WHERE a.id = ?`, id)
  return row === null ? null : accountFromRow(row)
}

export function listAccountRecords(store: PluginStore, provider?: ManagedProvider): AccountRecord[] {
  const where = provider === undefined ? '' : 'WHERE a.provider = ?'
  const rows = provider === undefined
    ? store.all<AccountRow>(`
        SELECT a.*, CASE WHEN s.account_id = a.id THEN 1 ELSE 0 END AS active
        FROM accounts a LEFT JOIN active_accounts s ON s.provider = a.provider
        ORDER BY a.updated_at DESC, a.id`)
    : store.all<AccountRow>(`
        SELECT a.*, CASE WHEN s.account_id = a.id THEN 1 ELSE 0 END AS active
        FROM accounts a LEFT JOIN active_accounts s ON s.provider = a.provider
        ${where} ORDER BY a.updated_at DESC, a.id`, provider)
  return rows.map(accountFromRow)
}

export function getActiveAccountId(store: PluginStore, provider: ManagedProvider): string | null {
  return store.get<{ account_id: string | null }>('SELECT account_id FROM active_accounts WHERE provider = ?', provider)?.account_id ?? null
}

export function getRevision(store: PluginStore): number {
  const text = store.get<{ value: string }>("SELECT value FROM account_state WHERE key = 'revision'")?.value
  const value = Number(text ?? '0')
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function incrementRevision(store: PluginStore): number {
  const next = getRevision(store) + 1
  store.run("UPDATE account_state SET value = ? WHERE key = 'revision'", String(next))
  return next
}

export function readPreferences(store: PluginStore): Preferences {
  const text = store.get<{ value: string }>('SELECT value FROM preferences WHERE singleton = 1')?.value
  if (!text) return { ...DEFAULT_PREFERENCES, visibleProviders: [...DEFAULT_PREFERENCES.visibleProviders] }
  try {
    const value: unknown = JSON.parse(text)
    if (!isPreferences(value)) return { ...DEFAULT_PREFERENCES, visibleProviders: [...DEFAULT_PREFERENCES.visibleProviders] }
    return { ...value, visibleProviders: [...value.visibleProviders] }
  } catch {
    return { ...DEFAULT_PREFERENCES, visibleProviders: [...DEFAULT_PREFERENCES.visibleProviders] }
  }
}

export function writePreferences(store: PluginStore, preferences: Preferences): void {
  store.run('UPDATE preferences SET value = ? WHERE singleton = 1', JSON.stringify(preferences))
}

export function sessionFromRow(row: SessionRow): AccountSessionRecord {
  return {
    sessionId: row.session_id,
    provider: row.provider,
    accountId: row.account_id,
    accountLabel: row.account_label,
    source: row.source,
    home: row.home,
    selectionRevision: row.selection_revision,
    worktreeId: row.worktree_id,
    cwd: row.cwd,
    agent: row.agent,
    busy: row.busy === 1,
    kept: row.kept === 1,
    error: row.error
  }
}

export function getSessionRecord(store: PluginStore, sessionId: string): AccountSessionRecord | null {
  const row = store.get<SessionRow>('SELECT * FROM account_sessions WHERE session_id = ?', sessionId)
  return row === null ? null : sessionFromRow(row)
}

export function listSessionRecords(store: PluginStore, provider?: ManagedProvider): AccountSessionRecord[] {
  const rows = provider === undefined
    ? store.all<SessionRow>('SELECT * FROM account_sessions ORDER BY session_id')
    : store.all<SessionRow>('SELECT * FROM account_sessions WHERE provider = ? ORDER BY session_id', provider)
  return rows.map(sessionFromRow)
}

function isPreferences(value: unknown): value is Preferences {
  if (!isRecord(value)) return false
  return (
    (value.mode === 'compact' || value.mode === 'detailed') &&
    (value.direction === 'used' || value.direction === 'remaining') &&
    typeof value.hidden === 'boolean' &&
    Array.isArray(value.visibleProviders) && value.visibleProviders.every((provider) => typeof provider === 'string') &&
    (value.density === 'normal' || value.density === 'icons') &&
    (value.claudeSwitchPolicy === 'ask' || value.claudeSwitchPolicy === 'always' || value.claudeSwitchPolicy === 'never') &&
    typeof value.skipCodexResetConfirm === 'boolean'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
