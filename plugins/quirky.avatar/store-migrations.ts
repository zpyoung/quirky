import type { StoreMigration } from '@quirky/protocol'

/** The avatar store's schema, built in ordered steps; JSON columns hold arrays and objects as text. */
export const avatarMigrations: StoreMigration[] = [
  `
  CREATE TABLE mandates (
    worktree_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    done_when TEXT NOT NULL,
    done_when_kind TEXT NOT NULL,
    guidelines TEXT NOT NULL,
    level TEXT NOT NULL,
    switches TEXT NOT NULL,
    agent TEXT,
    shared_goal_id TEXT,
    notes TEXT NOT NULL,
    allow_split INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE handoffs (
    worktree_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    session_id TEXT,
    active INTEGER NOT NULL,
    handed_off_at INTEGER NOT NULL,
    taken_back_at INTEGER
  );
  CREATE TABLE shared_goals (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    worktree_ids TEXT NOT NULL,
    merge_order TEXT NOT NULL
  );
  CREATE TABLE journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    worktree_id TEXT,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    delivered_to_brain INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX journal_worktree ON journal(worktree_id, seq);
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    step TEXT
  );
  CREATE INDEX receipts_session_at ON receipts(session_id, at);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE late_answers (
    fingerprint TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE needs_you (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    actions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  );
  CREATE TABLE guesses (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    question TEXT NOT NULL,
    choice TEXT NOT NULL,
    confirmed_at INTEGER,
    redone_at INTEGER,
    commits_since TEXT NOT NULL
  );
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL,
    result TEXT,
    UNIQUE(idempotency_key)
  );
  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    source TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    valid INTEGER,
    reason TEXT,
    thread_id TEXT,
    commit_sha TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE stuck (
    worktree_id TEXT PRIMARY KEY,
    rung INTEGER NOT NULL,
    counters TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE brain_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_tokens INTEGER
  );
  `,

  `
  CREATE TABLE record_cursors (
    session_id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL,
    path TEXT NOT NULL,
    read_offset INTEGER NOT NULL,
    pending TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `
]
