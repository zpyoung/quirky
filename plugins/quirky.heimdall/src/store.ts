import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginContext, PluginStore, StoreValue } from '@quirky/protocol'
import type { Enrollment, JournalAppend, JournalEntry, KernelStore, KindRegistration, TerminalSummary, TickTrace } from './contracts'

const VERSION = 1
const RING = 50
type ReadOnlyStore = PluginStore & { close(): void }
const migration = `
CREATE TABLE enrollments (
  watcher_id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace_key TEXT NOT NULL,
  workspace_path TEXT NOT NULL, execution_host_id TEXT NOT NULL, scheduler_owner TEXT NOT NULL,
  terminal_at_ms REAL, enrollment_json TEXT NOT NULL, kind_payload_json TEXT NOT NULL
);
CREATE UNIQUE INDEX one_live_workspace ON enrollments(workspace_key) WHERE terminal_at_ms IS NULL;
CREATE TABLE counters (
  watcher_id TEXT PRIMARY KEY REFERENCES enrollments(watcher_id) ON DELETE CASCADE,
  journal_seq INTEGER NOT NULL DEFAULT 0, trace_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE journal (
  watcher_id TEXT NOT NULL REFERENCES enrollments(watcher_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, at_ms REAL NOT NULL,
  class TEXT NOT NULL CHECK(class IN ('fact','observation')), kind TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('owner','client')), resolved INTEGER NOT NULL,
  entry_json TEXT NOT NULL, PRIMARY KEY(watcher_id,seq)
);
CREATE UNIQUE INDEX one_attempt_resolution ON journal(watcher_id,json_extract(entry_json,'$.attemptId')) WHERE kind='attempt-resolved';
CREATE UNIQUE INDEX one_terminal ON journal(watcher_id) WHERE kind='terminal';
CREATE TABLE tick_traces (
  watcher_id TEXT NOT NULL REFERENCES enrollments(watcher_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, pinned INTEGER NOT NULL, trace_json TEXT NOT NULL, PRIMARY KEY(watcher_id,seq)
);
CREATE TABLE terminal_summaries (
  watcher_id TEXT PRIMARY KEY REFERENCES enrollments(watcher_id) ON DELETE CASCADE, summary_json TEXT NOT NULL
);
CREATE TABLE kind_registrations (kind TEXT PRIMARY KEY, descriptor_json TEXT NOT NULL);
`
type EnrollmentRow = {
  watcher_id: string; kind: string; workspace_key: string; workspace_path: string
  execution_host_id: string; scheduler_owner: string; terminal_at_ms: number | null
  enrollment_json: string; kind_payload_json: string
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  return record(value) && Object.values(value).every(jsonValue)
}
function ownerValid(value: unknown): boolean {
  return value === undefined || value === null || (record(value) && value.agent === 'claude' &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.effort === undefined || typeof value.effort === 'string'))
}
function enrollmentValid(value: unknown): value is Enrollment {
  if (!record(value) || !record(value.budget) || !record(value.capabilities) || !record(value.coordinator)) return false
  const budget = value.budget
  return ['watcherId','kind','workspaceKey','workspacePath','executionHostId','schedulerOwner'].every((key) => text(value[key])) &&
    typeof value.enabled === 'boolean' && typeof value.paused === 'boolean' &&
    Number.isInteger(value.commandRevision) && (value.commandRevision as number) >= 0 &&
    text(value.coordinator.handle) && text(value.coordinator.paneKey) &&
    (value.orchestrationRunId === null || text(value.orchestrationRunId)) && finite(value.createdAtMs) &&
    (value.terminalAtMs === null || finite(value.terminalAtMs)) &&
    (value.parkReason === null || typeof value.parkReason === 'string') &&
    (value.haltReason === null || typeof value.haltReason === 'string') &&
    Object.values(value.capabilities).every((mode) => mode === 'off' || mode === 'gated' || mode === 'on') &&
    ['wallClockActiveMs','turns'].every((key) => budget[key] === null || (finite(budget[key]) && budget[key] >= 0)) &&
    ownerValid(value.owner) && (value.ownerInterventionCapability === undefined || ['off','gated','on'].includes(String(value.ownerInterventionCapability))) &&
    jsonValue(value.kindPayload)
}
function encode(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Heimdall cannot persist an undefined value')
  return encoded
}
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  if (!record(left) || !record(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}
function decodeEnrollment(row: EnrollmentRow): Enrollment {
  let body: unknown
  let failure: string | undefined
  try {
    body = JSON.parse(row.enrollment_json)
    const payload: unknown = JSON.parse(row.kind_payload_json)
    if (!jsonValue(payload)) throw new Error('kind payload is not finite JSON')
    if (!record(body)) throw new Error('enrollment is not an object')
    body = { ...body, kindPayload: payload }
    if (!enrollmentValid(body)) throw new Error('enrollment fields are malformed')
    if (body.watcherId !== row.watcher_id || body.kind !== row.kind || body.workspaceKey !== row.workspace_key ||
      body.executionHostId !== row.execution_host_id || body.schedulerOwner !== row.scheduler_owner ||
      body.workspacePath !== row.workspace_path || body.terminalAtMs !== row.terminal_at_ms) throw new Error('enrollment index and payload disagree')
    return body
  } catch (error) { failure = error instanceof Error ? error.message : String(error) }
  // Preserve indexed identity for inspection; malformed data never becomes executable authority.
  return {
    watcherId: row.watcher_id, kind: row.kind, workspaceKey: row.workspace_key, workspacePath: row.workspace_path,
    executionHostId: row.execution_host_id, schedulerOwner: row.scheduler_owner, kindPayload: null,
    enabled: false, paused: false, commandRevision: 0, capabilities: {},
    budget: { wallClockActiveMs: null, turns: null }, coordinator: { handle: 'malformed', paneKey: 'malformed' },
    orchestrationRunId: null, createdAtMs: 0, terminalAtMs: row.terminal_at_ms,
    parkReason: null, haltReason: 'invalid-kind-payload', malformed: failure
  }
}
function journalValue(raw: string): JournalEntry {
  const value: unknown = JSON.parse(raw)
  if (!record(value) || !Number.isInteger(value.seq) || !text(value.eventId) || !text(value.watcherId) || !finite(value.atMs) ||
    !text(value.kind) || !['fact','observation'].includes(String(value.class)) ||
    !['owner','client'].includes(String(value.origin)) || typeof value.resolved !== 'boolean') throw new Error('Malformed Heimdall journal entry')
  // All public identity fields have been checked; kind-owned fields remain opaque JSON.
  return value as unknown as JournalEntry
}
function attemptRetention(entries: JournalEntry[]): { known: boolean; pending: Set<string> } {
  const latest = new Map<string, JournalEntry>()
  const resolved = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === 'attempt' && text(entry.attemptId)) latest.set(entry.attemptId, entry)
    if (entry.kind === 'attempt-resolved' && text(entry.attemptId) &&
      (entry.effect === 'landed' || entry.effect === 'not-landed')) resolved.add(entry.attemptId)
  }
  const pending = new Set<string>()
  for (const [id, entry] of latest) {
    if (!resolved.has(id) && (entry.state !== 'settled' || entry.effect === 'indeterminate')) pending.add(id)
  }
  return { known: latest.size > 0, pending }
}

function futureHandle(path: string): ReadOnlyStore | null {
  if (!existsSync(path)) return null
  const db = new Database(path, { readonly: true })
  const row: unknown = db.query('PRAGMA user_version').get()
  if (!record(row) || !finite(row.user_version)) { db.close(); throw new Error('Cannot read Heimdall schema version') }
  const version = row.user_version
  if (version <= VERSION) { db.close(); return null }
  return {
    version,
    get<T>(sql: string, ...params: StoreValue[]) {
      return (db.query(sql).get(...(params as never[])) as T | null) ?? null
    },
    all<T>(sql: string, ...params: StoreValue[]) {
      return db.query(sql).all(...(params as never[])) as T[]
    },
    run() { throw new Error('Heimdall storage is read-only') },
    exec() { throw new Error('Heimdall storage is read-only') },
    transaction() { throw new Error('Heimdall storage is read-only') },
    // A native read-only connection has an explicit lifetime, unlike the public context-owned handle.
    close: () => db.close()
  }
}

export function createKernelStore(context: PluginContext): KernelStore {
  const path = join(context.dataDir, 'store.db')
  // The public store checks version after setting WAL: inspect first to leave future files untouched.
  const future = futureHandle(path)
  const readOnly = future !== null
  if (!readOnly) { mkdirSync(context.dataDir, { recursive: true, mode: 0o700 }); chmodSync(context.dataDir, 0o700) }
  const db = future ?? context.openStore([migration])
  if (!readOnly) db.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  let closed = false
  function live(write = false): void {
    if (closed) throw new Error('Heimdall storage is closed')
    if (write && readOnly) throw new Error('Heimdall storage is read-only')
  }
  function journal(id: string): JournalEntry[] {
    live()
    return db.all<{ entry_json: string }>('SELECT entry_json FROM journal WHERE watcher_id=? ORDER BY seq', id).map((row) => journalValue(row.entry_json))
  }
  function get(id: string): Enrollment | null {
    live()
    const row = db.get<EnrollmentRow>('SELECT * FROM enrollments WHERE watcher_id=?', id)
    return row ? decodeEnrollment(row) : null
  }
  function append(id: string, entry: JournalAppend): JournalEntry {
    live(true)
    if (!text(entry.kind) || !['fact','observation'].includes(entry.class) || !['owner','client'].includes(entry.origin) ||
      typeof entry.resolved !== 'boolean' || (entry.origin === 'client' && entry.kind !== 'client-observation')) throw new Error('Invalid Heimdall journal append')
    if (entry.kind === 'attempt' && (!text(entry.attemptId) || !text(entry.fingerprint) || !record(entry.action) ||
      !['attempted','running','settled'].includes(String(entry.state)) ||
      (entry.state === 'settled' && !['landed','not-landed','indeterminate'].includes(String(entry.effect))))) throw new Error('Invalid write-ahead attempt')
    if (entry.kind === 'attempt-resolved' && (!text(entry.attemptId) || !['landed','not-landed'].includes(String(entry.effect)))) throw new Error('Invalid attempt resolution')
    const eventId = entry.eventId ?? randomUUID()
    const atMs = entry.atMs ?? Date.now()
    if (!text(eventId) || !finite(atMs)) throw new Error('Invalid Heimdall journal identity')
    return db.transaction(() => {
      const existing = db.get<{ watcher_id: string; entry_json: string }>('SELECT watcher_id,entry_json FROM journal WHERE event_id=?', eventId)
      if (existing) {
        const saved = journalValue(existing.entry_json)
        const candidate: unknown = JSON.parse(encode({ ...entry, eventId, atMs: entry.atMs ?? saved.atMs, watcherId: id, seq: saved.seq }))
        if (existing.watcher_id !== id || !equalJson(saved, candidate)) throw new Error(`Heimdall journal event ${eventId} does not match its original body`)
        return saved
      }
      if (!db.get('SELECT watcher_id FROM enrollments WHERE watcher_id=?', id)) throw new Error('Watcher not found')
      if (entry.kind === 'attempt-resolved' && !text(entry.attemptId)) throw new Error('Attempt resolution needs an attempt identity')
      db.run('UPDATE counters SET journal_seq=journal_seq+1 WHERE watcher_id=?', id)
      const counter = db.get<{ journal_seq: number }>('SELECT journal_seq FROM counters WHERE watcher_id=?', id)
      if (!counter) throw new Error('Missing Heimdall sequence state')
      const value: JournalEntry = { ...entry, seq: counter.journal_seq, eventId, watcherId: id, atMs }
      const body = encode(value)
      db.run('INSERT INTO journal(watcher_id,seq,event_id,at_ms,class,kind,origin,resolved,entry_json) VALUES(?,?,?,?,?,?,?,?,?)',
        id, value.seq, eventId, atMs, entry.class, entry.kind, entry.origin, entry.resolved ? 1 : 0, body)
      return value
    })
  }
  const store: KernelStore = {
    readOnly,
    get,
    list() { live(); return db.all<EnrollmentRow>('SELECT * FROM enrollments ORDER BY watcher_id').map(decodeEnrollment) },
    live(key) { live(); const row = db.get<EnrollmentRow>('SELECT * FROM enrollments WHERE workspace_key=? AND terminal_at_ms IS NULL', key); return row ? decodeEnrollment(row) : null },
    save(enrollment) {
      live(true)
      const body = encode(enrollment)
      if (!enrollmentValid(enrollment)) throw new Error('Cannot persist malformed enrollment fields')
      db.transaction(() => {
        db.run(`INSERT INTO enrollments(watcher_id,kind,workspace_key,workspace_path,execution_host_id,scheduler_owner,terminal_at_ms,enrollment_json,kind_payload_json)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(watcher_id) DO UPDATE SET kind=excluded.kind,workspace_key=excluded.workspace_key,
          workspace_path=excluded.workspace_path,execution_host_id=excluded.execution_host_id,scheduler_owner=excluded.scheduler_owner,
          terminal_at_ms=excluded.terminal_at_ms,enrollment_json=excluded.enrollment_json,kind_payload_json=excluded.kind_payload_json`,
          enrollment.watcherId,enrollment.kind,enrollment.workspaceKey,enrollment.workspacePath,enrollment.executionHostId,enrollment.schedulerOwner,
          enrollment.terminalAtMs,body,encode(enrollment.kindPayload))
        db.run('INSERT OR IGNORE INTO counters(watcher_id) VALUES(?)', enrollment.watcherId)
      })
    },
    transaction(work) { live(true); return db.transaction(work) },
    journal,
    append,
    nextTraceSeq(id) {
      live(true)
      return db.transaction(() => {
        db.run('UPDATE counters SET trace_seq=trace_seq+1 WHERE watcher_id=?', id)
        const row = db.get<{ trace_seq: number }>('SELECT trace_seq FROM counters WHERE watcher_id=?', id)
        if (!row) throw new Error('Watcher not found')
        return row.trace_seq
      })
    },
    traces(id) {
      live()
      return db.all<{ trace_json: string }>('SELECT trace_json FROM tick_traces WHERE watcher_id=? ORDER BY seq', id).map((row) => {
        const value: unknown = JSON.parse(row.trace_json)
        if (!record(value) || !Number.isInteger(value.seq) || value.watcherId !== id || typeof value.pinned !== 'boolean' || !Array.isArray(value.declined)) throw new Error('Malformed Heimdall tick trace')
        return value as unknown as TickTrace
      })
    },
    trace(id, trace) {
      live(true)
      if (trace.watcherId !== id || !Number.isInteger(trace.seq) || trace.seq < 1) throw new Error('Invalid Heimdall tick trace identity')
      const body = encode(trace)
      db.transaction(() => {
        db.run('INSERT INTO tick_traces(watcher_id,seq,pinned,trace_json) VALUES(?,?,?,?) ON CONFLICT(watcher_id,seq) DO UPDATE SET pinned=excluded.pinned,trace_json=excluded.trace_json', id,trace.seq,trace.pinned ? 1 : 0,body)
        db.run('UPDATE counters SET trace_seq=MAX(trace_seq,?) WHERE watcher_id=?',trace.seq,id)
      })
    },
    retain(id) {
      live(true)
      db.transaction(() => {
        const attempts = attemptRetention(journal(id))
        if (attempts.known && attempts.pending.size === 0) {
          db.run("UPDATE tick_traces SET pinned=0,trace_json=json_set(trace_json,'$.pinned',json('false')) WHERE watcher_id=? AND pinned=1", id)
        }
        db.run(`DELETE FROM journal WHERE watcher_id=? AND class='observation' AND resolved=1 AND seq NOT IN
          (SELECT seq FROM journal WHERE watcher_id=? AND class='observation' AND resolved=1 ORDER BY seq DESC LIMIT ?)`, id,id,RING)
        db.run(`DELETE FROM tick_traces WHERE watcher_id=? AND pinned=0 AND seq NOT IN
          (SELECT seq FROM tick_traces WHERE watcher_id=? AND pinned=0 ORDER BY seq DESC LIMIT ?)`,id,id,RING)
      })
    },
    terminal(enrollment, summary) {
      live(true)
      if (summary.watcherId !== enrollment.watcherId || enrollment.terminalAtMs === null) throw new Error('Invalid terminal summary identity')
      db.transaction(() => {
        store.save(enrollment)
        const entries = journal(enrollment.watcherId)
        if (!entries.some((entry) => entry.kind === 'terminal')) append(enrollment.watcherId, {
          kind:'terminal',class:'fact',origin:'owner',resolved:true,atMs:summary.atMs,state:summary.state,reason:summary.reason
        })
        db.run('INSERT INTO terminal_summaries(watcher_id,summary_json) VALUES(?,?) ON CONFLICT(watcher_id) DO UPDATE SET summary_json=excluded.summary_json',enrollment.watcherId,encode(summary))
        const { pending } = attemptRetention(entries)
        for (const entry of entries) {
          const keep = entry.kind === 'terminal' || (entry.class === 'observation' && !entry.resolved) ||
            (entry.kind === 'attempt' && text(entry.attemptId) && pending.has(entry.attemptId))
          if (!keep) db.run('DELETE FROM journal WHERE watcher_id=? AND seq=?',enrollment.watcherId,entry.seq)
        }
        db.run('DELETE FROM tick_traces WHERE watcher_id=?',enrollment.watcherId)
      })
    },
    summary(id) {
      live()
      const row = db.get<{ summary_json: string }>('SELECT summary_json FROM terminal_summaries WHERE watcher_id=?',id)
      if (!row) return null
      const value: unknown = JSON.parse(row.summary_json)
      if (!record(value) || value.watcherId !== id || !text(value.state) || !text(value.reason) || !record(value.budget)) throw new Error('Malformed terminal summary')
      return value as unknown as TerminalSummary
    },
    registrations() {
      live()
      return db.all<{ descriptor_json: string }>('SELECT descriptor_json FROM kind_registrations ORDER BY kind').flatMap((row) => {
        try {
          const value: unknown = JSON.parse(row.descriptor_json)
          if (!record(value) || !text(value.id) || !record(value.hooks)) throw new Error('Malformed kind descriptor')
          return [value as unknown as KindRegistration]
        } catch (error) { context.log(`Heimdall kind registration is malformed: ${String(error)}`); return [] }
      })
    },
    saveRegistration(descriptor) {
      live(true)
      db.run('INSERT INTO kind_registrations(kind,descriptor_json) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET descriptor_json=excluded.descriptor_json',descriptor.id,encode(descriptor))
    },
    remove(id) { live(true); db.transaction(() => { db.run('DELETE FROM enrollments WHERE watcher_id=?',id) }) },
    close() {
      if (closed) return
      closed = true
      future?.close()
    }
  }
  return store
}
