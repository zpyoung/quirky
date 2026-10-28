import { randomUUID } from 'node:crypto'
import type { PluginStore, StoreMigration } from '@quirky/protocol'
import type { IterationDetail, LoopSnapshot, LoopState, PauseReason } from './types'

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS loops (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    workspace_kind TEXT NOT NULL,
    agent TEXT NOT NULL,
    preset TEXT NOT NULL,
    config_json TEXT NOT NULL,
    model TEXT,
    options_json TEXT,
    state TEXT NOT NULL,
    pause_reason TEXT,
    pause_detail TEXT,
    session_id TEXT,
    iterations_completed INTEGER NOT NULL,
    active_ms REAL NOT NULL,
    cost_usd REAL,
    phase TEXT,
    next_iteration_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    ended_at REAL,
    notes_path TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    journal_cursor INTEGER NOT NULL DEFAULT 0,
    pause_requested INTEGER NOT NULL DEFAULT 0,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    stop_now INTEGER NOT NULL DEFAULT 0,
    needs_resume INTEGER NOT NULL DEFAULT 0,
    resume_native INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS loops_worktree_updated ON loops(worktree_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS loop_iterations (
    loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    detail_json TEXT NOT NULL,
    PRIMARY KEY(loop_id, n, attempt)
  );
  CREATE INDEX IF NOT EXISTS loop_iterations_recent ON loop_iterations(loop_id, n DESC, attempt DESC);
  CREATE TABLE IF NOT EXISTS loop_steer_notes (
    id TEXT PRIMARY KEY,
    loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at REAL NOT NULL,
    consumed_by_iteration INTEGER
  );
  CREATE INDEX IF NOT EXISTS loop_steer_pending ON loop_steer_notes(loop_id, consumed_by_iteration, created_at);
  CREATE TABLE IF NOT EXISTS loop_owned_messages (
    loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY(loop_id, session_id, seq)
  );
`

export function loopMigrations(): StoreMigration[] {
  return [CREATE_SCHEMA]
}

type LoopRow = {
  id: string; name: string; slug: string; worktree_id: string; cwd: string; workspace_kind: 'git' | 'folder';
  agent: LoopSnapshot['agent']; preset: 'until-done'; config_json: string; model: string | null; options_json: string | null;
  state: LoopState; pause_reason: PauseReason | null; pause_detail: string | null; session_id: string | null;
  iterations_completed: number; active_ms: number; cost_usd: number | null; phase: LoopSnapshot['phase'];
  next_iteration_at: number | null; created_at: number; updated_at: number; ended_at: number | null;
  notes_path: string; warnings_json: string; journal_cursor: number; pause_requested: number; stop_requested: number;
  stop_now: number; needs_resume: number; resume_native: number;
}

type IterationRow = { detail_json: string }
type SteerRow = { id: string; body: string; created_at: number; consumed_by_iteration: number | null }

const OUTPUT_LIMIT = 16_384
const CHECK_LIMIT = 4_000
const RECENT_LIMIT = 50
const ENDED_ATTEMPT_LIMIT = 200
const OWNED_MESSAGE_LIMIT = 300

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function safeJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    throw new Error(`Stored loop ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function boundedAttempt(detail: IterationDetail): IterationDetail {
  return {
    ...detail,
    outputTail: tail(detail.outputTail, OUTPUT_LIMIT),
    check: detail.check === null ? null : {
      ...detail.check,
      stdoutTail: tail(detail.check.stdoutTail, CHECK_LIMIT),
      stderrTail: tail(detail.check.stderrTail, CHECK_LIMIT)
    }
  }
}

function encodeLoop(snapshot: LoopSnapshot): Omit<LoopRow, 'journal_cursor' | 'pause_requested' | 'stop_requested' | 'stop_now' | 'needs_resume' | 'resume_native'> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    slug: snapshot.slug,
    worktree_id: snapshot.worktreeId,
    cwd: snapshot.cwd,
    workspace_kind: snapshot.workspaceKind,
    agent: snapshot.agent,
    preset: snapshot.preset,
    config_json: JSON.stringify(snapshot.config),
    model: snapshot.model ?? null,
    options_json: snapshot.options === undefined ? null : JSON.stringify(snapshot.options),
    state: snapshot.state,
    pause_reason: snapshot.pauseReason,
    pause_detail: snapshot.pauseDetail,
    session_id: snapshot.sessionId,
    iterations_completed: snapshot.iterationsCompleted,
    active_ms: snapshot.activeMs,
    cost_usd: snapshot.costUsd,
    phase: snapshot.phase,
    next_iteration_at: snapshot.nextIterationAt,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
    ended_at: snapshot.endedAt,
    notes_path: snapshot.notesPath,
    warnings_json: JSON.stringify(snapshot.warnings)
  }
}

function writeLoop(store: PluginStore, snapshot: LoopSnapshot): void {
  const row = encodeLoop(snapshot)
  store.run(
    `INSERT INTO loops (
      id, name, slug, worktree_id, cwd, workspace_kind, agent, preset, config_json, model, options_json,
      state, pause_reason, pause_detail, session_id, iterations_completed, active_ms, cost_usd, phase,
      next_iteration_at, created_at, updated_at, ended_at, notes_path, warnings_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, slug = excluded.slug, worktree_id = excluded.worktree_id, cwd = excluded.cwd,
      workspace_kind = excluded.workspace_kind, agent = excluded.agent, preset = excluded.preset,
      config_json = excluded.config_json, model = excluded.model, options_json = excluded.options_json,
      state = excluded.state, pause_reason = excluded.pause_reason, pause_detail = excluded.pause_detail,
      session_id = excluded.session_id,
      journal_cursor = CASE WHEN loops.session_id IS NOT excluded.session_id THEN 0 ELSE loops.journal_cursor END,
      iterations_completed = excluded.iterations_completed, active_ms = excluded.active_ms,
      cost_usd = excluded.cost_usd, phase = excluded.phase,
      next_iteration_at = excluded.next_iteration_at, updated_at = excluded.updated_at,
      ended_at = excluded.ended_at, notes_path = excluded.notes_path, warnings_json = excluded.warnings_json`,
    row.id, row.name, row.slug, row.worktree_id, row.cwd, row.workspace_kind, row.agent, row.preset,
    row.config_json, row.model, row.options_json, row.state, row.pause_reason, row.pause_detail,
    row.session_id, row.iterations_completed, row.active_ms, row.cost_usd, row.phase, row.next_iteration_at,
    row.created_at, row.updated_at, row.ended_at, row.notes_path, row.warnings_json
  )
}

function writeAttempt(store: PluginStore, detail: IterationDetail): void {
  const bounded = boundedAttempt(detail)
  store.run(
    `INSERT INTO loop_iterations (loop_id, n, attempt, detail_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(loop_id, n, attempt) DO UPDATE SET detail_json = excluded.detail_json`,
    bounded.loopId,
    bounded.n,
    bounded.attempt,
    JSON.stringify(bounded)
  )
}

function loopFromRow(row: LoopRow, recentIterations: IterationDetail[]): LoopSnapshot {
  const snapshot: LoopSnapshot = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    worktreeId: row.worktree_id,
    cwd: row.cwd,
    workspaceKind: row.workspace_kind,
    agent: row.agent,
    preset: row.preset,
    config: safeJson(row.config_json, 'configuration'),
    state: row.state,
    pauseReason: row.pause_reason,
    pauseDetail: row.pause_detail,
    sessionId: row.session_id,
    iterationsCompleted: row.iterations_completed,
    activeMs: row.active_ms,
    costUsd: row.cost_usd,
    phase: row.phase,
    nextIterationAt: row.next_iteration_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    notesPath: row.notes_path,
    warnings: safeJson(row.warnings_json, 'warnings'),
    recentIterations
  }
  if (row.model !== null) snapshot.model = row.model
  if (row.options_json !== null) snapshot.options = safeJson(row.options_json, 'launch options')
  return snapshot
}

export type SteerNote = { id: string; body: string; createdAt: number; consumedByIteration?: number }
export type LoopRequests = { pause: boolean; stop: boolean; stopNow: boolean; needsResume: boolean; resumeNative: boolean }

function writeRequests(store: PluginStore, loopId: string, requests: LoopRequests): void {
  store.run(
    'UPDATE loops SET pause_requested = ?, stop_requested = ?, stop_now = ?, needs_resume = ?, resume_native = ? WHERE id = ?',
    Number(requests.pause), Number(requests.stop), Number(requests.stopNow), Number(requests.needsResume), Number(requests.resumeNative), loopId
  )
}
export class LoopStore {
  readonly readOnly: boolean

  constructor(private readonly store: PluginStore) {
    this.readOnly = 'readOnly' in store && store.readOnly === true
  }

  private requireWritable(): void {
    if (this.readOnly) throw new Error('Loop store is read-only')
  }

  private recent(loopId: string, limit: number): IterationDetail[] {
    const rows = this.store.all<IterationRow>(
      `SELECT detail_json FROM loop_iterations
       WHERE loop_id = ? AND json_extract(detail_json, '$.endedAt') IS NOT NULL
       ORDER BY n DESC, attempt DESC LIMIT ?`,
      loopId,
      limit
    )
    return rows.reverse().map((row) => safeJson<IterationDetail>(row.detail_json, 'iteration'))
  }

  saveLoop(snapshot: LoopSnapshot, requests?: LoopRequests): void {
    this.requireWritable()
    this.store.transaction(() => {
      writeLoop(this.store, snapshot)
      if (requests) writeRequests(this.store, snapshot.id, requests)
    })
  }

  saveLoopAndAttempt(snapshot: LoopSnapshot, detail: IterationDetail, requests?: LoopRequests): void {
    this.requireWritable()
    this.store.transaction(() => {
      writeAttempt(this.store, detail)
      writeLoop(this.store, snapshot)
      if (requests) writeRequests(this.store, snapshot.id, requests)
    })
  }

  saveAttempt(detail: IterationDetail): void {
    this.requireWritable()
    this.store.transaction(() => writeAttempt(this.store, detail))
  }

  getLoop(loopId: string): LoopSnapshot | null {
    const row = this.store.get<LoopRow>('SELECT * FROM loops WHERE id = ?', loopId)
    return row === null ? null : loopFromRow(row, this.recent(loopId, RECENT_LIMIT))
  }

  listLoops(worktreeId?: string): LoopSnapshot[] {
    const rows = worktreeId === undefined
      ? this.store.all<LoopRow>('SELECT * FROM loops ORDER BY updated_at DESC, created_at DESC')
      : this.store.all<LoopRow>('SELECT * FROM loops WHERE worktree_id = ? ORDER BY updated_at DESC, created_at DESC', worktreeId)
    return rows.map((row) => loopFromRow(row, this.recent(row.id, RECENT_LIMIT)))
  }

  iterations(loopId: string, limit = ENDED_ATTEMPT_LIMIT): IterationDetail[] {
    return this.recent(loopId, Math.max(1, Math.min(1000, Math.floor(limit))))
  }

  latestAttempt(loopId: string): IterationDetail | null {
    const row = this.store.get<IterationRow>(
      'SELECT detail_json FROM loop_iterations WHERE loop_id = ? ORDER BY n DESC, attempt DESC LIMIT 1',
      loopId
    )
    return row === null ? null : safeJson<IterationDetail>(row.detail_json, 'iteration')
  }

  unfinishedAttempt(loopId: string): IterationDetail | null {
    const detail = this.latestAttempt(loopId)
    return detail !== null && (detail.endedAt === null || detail.endReason === null) ? detail : null
  }
  saveRequests(loopId: string, requests: LoopRequests): void {
    this.requireWritable()
    writeRequests(this.store, loopId, requests)
  }

  requests(loopId: string): LoopRequests {
    const row = this.store.get<{
      pause_requested: number; stop_requested: number; stop_now: number; needs_resume: number; resume_native: number
    }>('SELECT pause_requested, stop_requested, stop_now, needs_resume, resume_native FROM loops WHERE id = ?', loopId)
    return row === null
      ? { pause: false, stop: false, stopNow: false, needsResume: false, resumeNative: false }
      : {
          pause: row.pause_requested === 1,
          stop: row.stop_requested === 1,
          stopNow: row.stop_now === 1,
          needsResume: row.needs_resume === 1,
          resumeNative: row.resume_native === 1
        }
  }

  journalCursor(loopId: string, sessionId: string): number {
    const row = this.store.get<{ journal_cursor: number; session_id: string | null }>(
      'SELECT journal_cursor, session_id FROM loops WHERE id = ?', loopId
    )
    return row?.session_id === sessionId ? row.journal_cursor : 0
  }
  saveJournalCursor(loopId: string, sessionId: string, seq: number): void {
    this.requireWritable()
    this.store.run(
      'UPDATE loops SET journal_cursor = MAX(journal_cursor, ?) WHERE id = ? AND session_id = ?',
      seq,
      loopId,
      sessionId
    )
  }
  markOwnedMessage(loopId: string, sessionId: string, seq: number): void {
    this.requireWritable()
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO loop_owned_messages (loop_id, session_id, seq) VALUES (?, ?, ?)', loopId, sessionId, seq)
      this.store.run(
        'DELETE FROM loop_owned_messages WHERE loop_id = ? AND session_id = ? AND seq <= ?',
        loopId,
        sessionId,
        seq - OWNED_MESSAGE_LIMIT
      )
    })
  }

  forgetOwnedMessages(loopId: string, sessionId: string): void {
    this.requireWritable()
    this.store.run('DELETE FROM loop_owned_messages WHERE loop_id = ? AND session_id = ?', loopId, sessionId)
  }

  isOwnedMessage(loopId: string, sessionId: string, seq: number): boolean {
    return this.store.get('SELECT 1 FROM loop_owned_messages WHERE loop_id = ? AND session_id = ? AND seq = ?', loopId, sessionId, seq) !== null
  }

  addSteerNote(loopId: string, body: string, createdAt: number): string {
    this.requireWritable()
    const id = randomUUID()
    this.store.run('INSERT INTO loop_steer_notes (id, loop_id, body, created_at) VALUES (?, ?, ?, ?)', id, loopId, body, createdAt)
    return id
  }

  steerNotes(loopId: string, includeConsumed = false): SteerNote[] {
    const rows = includeConsumed
      ? this.store.all<SteerRow>('SELECT id, body, created_at, consumed_by_iteration FROM loop_steer_notes WHERE loop_id = ? ORDER BY created_at, id', loopId)
      : this.store.all<SteerRow>('SELECT id, body, created_at, consumed_by_iteration FROM loop_steer_notes WHERE loop_id = ? AND consumed_by_iteration IS NULL ORDER BY created_at, id', loopId)
    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      ...(row.consumed_by_iteration === null ? {} : { consumedByIteration: row.consumed_by_iteration })
    }))
  }

  consumeSteerNotes(loopId: string, ids: string[], iteration: number): void {
    this.requireWritable()
    if (ids.length === 0) return
    this.store.transaction(() => {
      for (const id of ids) this.store.run(
        'UPDATE loop_steer_notes SET consumed_by_iteration = ? WHERE loop_id = ? AND id = ? AND consumed_by_iteration IS NULL',
        iteration,
        loopId,
        id
      )
    })
  }

  pruneEndedAttempts(): void {
    this.requireWritable()
    const ended = this.store.all<{ id: string }>("SELECT id FROM loops WHERE state IN ('completed', 'stopped')")
    this.store.transaction(() => {
      for (const { id } of ended) {
        this.store.run(
          `DELETE FROM loop_iterations WHERE loop_id = ? AND rowid NOT IN (
            SELECT rowid FROM loop_iterations WHERE loop_id = ? ORDER BY n DESC, attempt DESC LIMIT ?
          )`,
          id,
          id,
          ENDED_ATTEMPT_LIMIT
        )
        this.store.run('DELETE FROM loop_owned_messages WHERE loop_id = ?', id)
      }
    })
  }

}
