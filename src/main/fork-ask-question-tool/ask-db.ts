import { chmodSync, existsSync } from 'node:fs'
import Database from '../sqlite/sync-database'
import {
  isTerminalAskStatus,
  type PersistedAskStatus
} from '../../shared/fork-ask-question-tool/ask-answer-envelope'

const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000
const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1000

// ECMAScript's own Date range limit; ms past this makes `new Date(...).toISOString()` throw RangeError.
const MAX_DATE_MS = 8_640_000_000_000_000

const CREATE_ASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS asks (
  ask_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  pane_key TEXT,
  worktree_id TEXT,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  partial_json TEXT,
  answers_json TEXT,
  timeout_ms INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  seq INTEGER NOT NULL,
  handoff_run_id TEXT,
  handoff_dispatch_id TEXT,
  handoff_asker TEXT,
  handoff_question_id TEXT
)`

// Why: a single persisted counter (rather than MAX(seq) FROM asks) keeps seq monotonic
// even after the 24h purge deletes the rows that held the highest values so far.
const CREATE_SEQ_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ask_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
)`

export type AskOrigin = 'cli' | 'handoff'

/** Hand-off identity for an ask created on the orchestration worker->coordinator path (C7). */
export type AskHandoffIdentity = {
  runId: string
  dispatchId: string
  askerHandle: string
  /** Orchestration question id once created; null means "not yet created" across restarts. */
  questionId: string | null
}

export type RegisterAskParams = {
  askId: string
  requestId: string
  paneKey: string | null
  worktreeId: string | null
  origin: AskOrigin
  specJson: string
  /** Opt-in automation deadline as requested; null means no timeout expiry. */
  timeoutMs: number | null
  handoff: AskHandoffIdentity | null
}

export type AskRow = {
  ask_id: string
  request_id: string
  pane_key: string | null
  worktree_id: string | null
  origin: AskOrigin
  status: PersistedAskStatus
  spec_json: string
  partial_json: string | null
  answers_json: string | null
  timeout_ms: number | null
  expires_at: string | null
  created_at: string
  resolved_at: string | null
  seq: number
  handoff_run_id: string | null
  handoff_dispatch_id: string | null
  handoff_asker: string | null
  handoff_question_id: string | null
}

export type RegisterAskResult = { row: AskRow; created: boolean }

export type CommitAskResultParams = {
  status: Exclude<PersistedAskStatus, 'registered'>
  answersJson: string | null
}

function hardenAskDatabaseFiles(dbPath: (string & {}) | ':memory:'): void {
  if (dbPath === ':memory:' || process.platform === 'win32') {
    // Why: Windows already restricts userData to the current user; POSIX mode bits are inert there.
    return
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(path)) {
        chmodSync(path, 0o600)
      }
    } catch {
      // Why: best-effort — a mount that rejects chmod (SSHFS, some network shares) must not fail DB startup.
    }
  }
}

/**
 * Durable store for the `quirky ask` question registry, in its own SQLite file — never shared with
 * or migrated from `OrchestrationDb`. Mirrors its lazy-construction and file-hardening precedent;
 * callers decide the path and when to instantiate.
 */
export class AskDb {
  private readonly db: Database.Database
  private purgeTimer: NodeJS.Timeout | null = null

  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(CREATE_ASKS_TABLE_SQL)
    this.db.exec(CREATE_SEQ_TABLE_SQL)
    this.db.exec('INSERT OR IGNORE INTO ask_seq (id, value) VALUES (1, 0)')
    hardenAskDatabaseFiles(dbPath)
  }

  /**
   * Runs the 24h retention purge immediately, then on `intervalMs`; `close()` and
   * `stopPeriodicPurge()` both stop it. Unref'd so a live sweep never keeps the process open.
   */
  startPeriodicPurge(intervalMs: number = DEFAULT_PURGE_INTERVAL_MS): void {
    this.stopPeriodicPurge()
    this.purgeStaleTerminalRows()
    this.purgeTimer = setInterval(() => this.purgeStaleTerminalRows(), intervalMs)
    this.purgeTimer.unref()
  }

  stopPeriodicPurge(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer)
      this.purgeTimer = null
    }
  }

  close(): void {
    this.stopPeriodicPurge()
    this.db.close()
  }

  /** The store's true head seq — every row committed so far, including ones a 24h purge has since deleted. */
  currentSeq(): number {
    const row = this.db.prepare('SELECT value FROM ask_seq WHERE id = 1').get() as { value: number }
    return row.value
  }

  private nextSeq(): number {
    const row = this.db
      .prepare('UPDATE ask_seq SET value = value + 1 WHERE id = 1 RETURNING value')
      .get() as { value: number }
    return row.value
  }

  private requireAsk(askId: string): AskRow {
    const row = this.getAsk(askId)
    if (!row) {
      throw new Error(`ask ${askId} was not found`)
    }
    return row
  }

  /**
   * Idempotent on `params.requestId`: a replay of an already-registered request returns the
   * existing row (`created: false`) rather than inserting a second one. Atomic — never a
   * caller-side select-then-insert race.
   */
  registerAsk(
    params: RegisterAskParams,
    createdAt: string = new Date().toISOString()
  ): RegisterAskResult {
    const seq = this.nextSeq()
    // C2: registry methods never throw for domain outcomes, so an absurd timeoutMs (e.g. MAX_SAFE_INTEGER)
    // is clamped to the latest representable deadline rather than overflowing Date and throwing, or
    // silently becoming "no deadline" (null).
    // a hand-off's deadline is enforced by its wait against timeout_ms, never the registry's expiry timer.
    const expiresAt =
      params.timeoutMs === null || params.handoff
        ? null
        : new Date(Math.min(Date.parse(createdAt) + params.timeoutMs, MAX_DATE_MS)).toISOString()
    const handoff = params.handoff
    const result = this.db
      .prepare(
        `INSERT INTO asks (
           ask_id, request_id, pane_key, worktree_id, origin, status, spec_json,
           timeout_ms, expires_at, created_at, seq,
           handoff_run_id, handoff_dispatch_id, handoff_asker, handoff_question_id
         ) VALUES (?, ?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING`
      )
      .run(
        params.askId,
        params.requestId,
        params.paneKey,
        params.worktreeId,
        params.origin,
        params.specJson,
        params.timeoutMs,
        expiresAt,
        createdAt,
        seq,
        handoff?.runId ?? null,
        handoff?.dispatchId ?? null,
        handoff?.askerHandle ?? null,
        handoff?.questionId ?? null
      )
    const row = this.db.prepare('SELECT * FROM asks WHERE request_id = ?').get(params.requestId) as
      | AskRow
      | undefined
    if (!row) {
      throw new Error(`ask insert for request ${params.requestId} did not produce a row`)
    }
    return { row, created: Number(result.changes) === 1 }
  }

  getAsk(askId: string): AskRow | undefined {
    return this.db.prepare('SELECT * FROM asks WHERE ask_id = ?').get(askId) as AskRow | undefined
  }

  /**
   * Every ask still awaiting a terminal transition, in registration order (not `seq`, which
   * every draft update bumps). Filters on `isTerminalAskStatus`
   * rather than `resolved_at IS NULL` — the registry, not this store, is the authority on what
   * counts as terminal, and duplicating that definition here would silently diverge if a future
   * status ever resolved without stamping `resolved_at`.
   *
   * A pending ask registered before this process's AskRegistry existed — most importantly one
   * still pending across a host restart — has no other way back into memory: this is what makes
   * the C8 reload case return the card instead of losing it.
   */
  listPending(): AskRow[] {
    const query = this.db.prepare('SELECT * FROM asks ORDER BY created_at ASC, rowid ASC')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the asks table columns are exactly AskRow's fields.
    const rows = query.all() as AskRow[]
    return rows.filter((row) => !isTerminalAskStatus(row.status))
  }

  /**
   * Every row touched since `seq`, oldest first, terminal statuses included — a reconnecting
   * `ask.subscribe` with a still-valid watermark needs the transitions it missed, and a transition
   * *to* terminal is exactly what `listPending` excludes by design.
   */
  listSinceSeq(seq: number): AskRow[] {
    return this.db.prepare('SELECT * FROM asks WHERE seq > ? ORDER BY seq ASC').all(seq) as AskRow[]
  }

  updatePartial(askId: string, partialJson: string | null): AskRow {
    const seq = this.nextSeq()
    this.db
      .prepare('UPDATE asks SET partial_json = ?, seq = ? WHERE ask_id = ?')
      .run(partialJson, seq, askId)
    return this.requireAsk(askId)
  }

  /** Stamps a fresh seq on a queued ask that just reached the head of its pane, so clients past its register seq still accept the event. */
  touchSeq(askId: string): AskRow {
    const seq = this.nextSeq()
    this.db.prepare('UPDATE asks SET seq = ? WHERE ask_id = ?').run(seq, askId)
    return this.requireAsk(askId)
  }

  /** Records a terminal transition. One emitting predicate per status is enforced by the registry, not here. */
  commitAskResult(
    askId: string,
    params: CommitAskResultParams,
    resolvedAt: string = new Date().toISOString()
  ): AskRow {
    const seq = this.nextSeq()
    this.db
      .prepare(
        'UPDATE asks SET status = ?, answers_json = ?, resolved_at = ?, seq = ? WHERE ask_id = ?'
      )
      .run(params.status, params.answersJson, resolvedAt, seq, askId)
    return this.requireAsk(askId)
  }

  /** Persists the orchestration question id once C7 creates it, so a restart never creates a second one. */
  setHandoffQuestionId(askId: string, questionId: string): AskRow {
    const seq = this.nextSeq()
    this.db
      .prepare('UPDATE asks SET handoff_question_id = ?, seq = ? WHERE ask_id = ?')
      .run(questionId, seq, askId)
    return this.requireAsk(askId)
  }

  /** Deletes resolved rows older than 24h; pending rows (`resolved_at IS NULL`) are never purged by age. */
  purgeStaleTerminalRows(now: string = new Date().toISOString()): number {
    const cutoff = new Date(Date.parse(now) - TERMINAL_RETENTION_MS).toISOString()
    const result = this.db
      .prepare('DELETE FROM asks WHERE resolved_at IS NOT NULL AND resolved_at < ?')
      .run(cutoff)
    return Number(result.changes)
  }
}
