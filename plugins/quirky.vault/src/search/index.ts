import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import type { Discovery, SearchOptions, SearchPolicy, SearchRequest, SearchResponse, SearchStatus, SourceCandidate, VaultMessage, VaultScanner, VaultSearch, VaultSession } from '../types'
import { HISTORY_AGENTS } from '../agents'
import { join } from 'node:path'
import { ensureQuerySchema, extendContentHash, indexedMessageRows, readGeneration, searchIndex } from './engine'
import type { SearchContentHash, SearchSourceRecord } from './engine'
import { sqliteSourcePath } from '../scanner/parsers/sqlite'

/*
 * MIT License
 * Copyright (c) 2026 Lovecast Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const SCHEMA_VERSION = 3
const RECONCILE_INTERVAL_MS = 20_000
const PASS_BUDGET_MS = RECONCILE_INTERVAL_MS / 4
const FULL_SWEEP_EVERY_CYCLES = 15
const RECENT_PER_AGENT_ROOT = 12
const MISSING_FILES_PER_PASS = 512
const ORPHANS_PER_PASS = 256
const WRITE_BATCH_CHARS = 1_000_000
const FILE_NAME = 'session-search.sqlite'
const SQLITE_SUFFIXES = ['', '-wal', '-shm'] as const

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  codex_home TEXT,
  title TEXT NOT NULL,
  cwd TEXT,
  cwd_key TEXT,
  branch TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  content_hash_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS sessions_cwd_key ON sessions(cwd_key);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  agent TEXT NOT NULL,
  dev INTEGER,
  ino INTEGER,
  signature TEXT NOT NULL DEFAULT '',
  mtime_ms REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  session_row_id INTEGER,
  state TEXT NOT NULL DEFAULT 'current' CHECK(state IN ('current','due','failed')),
  fail_count INTEGER NOT NULL DEFAULT 0,
  failed_signature TEXT,
  pending_signature TEXT,
  pending_mtime_ms REAL,
  pending_size_bytes INTEGER,
  last_seen_scan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime_ms);
CREATE INDEX IF NOT EXISTS files_session ON files(session_row_id);
CREATE INDEX IF NOT EXISTS files_root ON files(root);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts REAL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_row_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers,
  tokenize="unicode61 tokenchars '_.-/+'", detail=full
);
CREATE TRIGGER IF NOT EXISTS sessions_insert_generation AFTER INSERT ON sessions BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation';
END;
CREATE TRIGGER IF NOT EXISTS sessions_update_generation AFTER UPDATE ON sessions BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation';
END;
CREATE TRIGGER IF NOT EXISTS sessions_delete_generation AFTER DELETE ON sessions BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation';
END;
`

type FileRow = {
  path: string
  root: string
  agent: string
  dev: number | null
  ino: number | null
  signature: string
  mtime_ms: number
  size_bytes: number
  session_row_id: number | null
  state: 'current' | 'due' | 'failed'
  fail_count: number
  failed_signature: string | null
  pending_signature: string | null
  pending_mtime_ms: number | null
  pending_size_bytes: number | null
}

type RootState = { presence: 'present' | 'missing' | 'unverifiable'; reason?: string }
type SearchPhase = SearchStatus['phase']
type WriteMessage = { role: VaultMessage['role']; text: string; timestamp: number | null; identifiers: string }
type Stats = { filesIndexed: number; filesDue: number; filesFailed: number; messagesIndexed: number; generation: number; sessionsByAgent: Record<string, number> }

export function createSearch(options: SearchOptions): VaultSearch {
  const databasePath = join(options.dataDir, FILE_NAME)
  let policy: SearchPolicy = { enabled: false, historyDays: null }
  let database: Database | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let reconcileTask: Promise<void> | null = null
  let activeController: AbortController | null = null
  let fullRequested = false
  let closed = false
  let wasApplied = false
  let cycle = 0
  let owed = false
  let lastReconcileAt: number | null = null
  let lastSweepCompletedAt: number | null = null
  let degradedRoots: SearchStatus['degradedRoots'] = []
  let knownCandidatePaths = new Set<string>()
  let rootStates = new Map<string, RootState>()
  let applyQueue: Promise<void> = Promise.resolve()

  const readStatus = (): SearchStatus => {
    const stats = database ? readStats(database) : emptyStats()
    let phase: SearchPhase
    if (closed || (!policy.enabled && wasApplied)) phase = 'closed'
    else if (!policy.enabled) phase = 'idle'
    else if (degradedRoots.length > 0 || stats.filesFailed > 0) phase = 'degraded'
    else if (stats.filesDue > 0 || owed || lastSweepCompletedAt === null || reconcileTask !== null) phase = 'indexing'
    else phase = 'current'
    return {
      enabled: policy.enabled,
      phase,
      ...stats,
      degradedRoots: degradedRoots.map(item => ({ ...item })),
      lastReconcileAt,
      lastSweepCompletedAt,
      supportedAgents: [...HISTORY_AGENTS]
    }
  }

  const publish = (): void => {
    try { options.progress?.(readStatus()) } catch { /* Progress observers cannot fail index work. */ }
  }

  const retentionCutoff = (): number | null =>
    policy.historyDays === null ? null : Date.now() - policy.historyDays * 86_400_000


  const ensureDatabase = (): Database => {
    if (database) return database
    mkdirSync(options.dataDir, { recursive: true })
    database = openDatabase(databasePath)
    return database
  }

  const stopTimer = (): void => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  const cancelReconcile = async (): Promise<void> => {
    fullRequested = false
    activeController?.abort()
    try { await reconcileTask } catch { /* The pass records its degraded state before rejection. */ }
  }

  const applyImpl = async (next: SearchPolicy): Promise<void> => {
    if (closed) throw new Error('Search service is closed')
    if (next.historyDays !== null && (!Number.isInteger(next.historyDays) || next.historyDays < 1 || next.historyDays > 3650)) {
      throw new TypeError('historyDays must be null or an integer from 1 to 3650')
    }
    stopTimer()
    policy = { enabled: false, historyDays: next.historyDays }
    await cancelReconcile()
    closeDatabase()
    wasApplied = true
    policy = { enabled: next.enabled, historyDays: next.historyDays }
    if (!policy.enabled) {
      publish()
      return
    }
    try {
      const db = ensureDatabase()
      ensureQuerySchema(db)
      timer = setInterval(() => { void reconcile().catch(() => undefined) }, RECONCILE_INTERVAL_MS)
      void reconcile({ full: true }).catch(() => undefined)
      publish()
    } catch (error) {
      degradedRoots = [{ reason: 'Search index could not be opened' }]
      publish()
      throw error
    }
  }

  const enqueueApply = (next: SearchPolicy): Promise<void> => {
    const operation = applyQueue.then(() => applyImpl(next))
    applyQueue = operation.catch(() => undefined)
    return operation
  }

  const runPass = async (full: boolean): Promise<void> => {
    const db = database
    if (!policy.enabled || !db || closed) return
    const started = performance.now()
    const controller = new AbortController()
    activeController = controller
    lastReconcileAt = Date.now()
    publish()
    let completedFull = false
    try {
      const discovery = await options.scanner.discover(controller.signal)
      const rootInfo = updateRootState(db, discovery, rootStates)
      rootStates = rootInfo.states
      degradedRoots = rootInfo.degraded
      knownCandidatePaths = new Set(discovery.candidates.map(candidate => candidate.filePath))
      const scanId = allocateScanId(db)
      const cutoff = retentionCutoff()
      const eligible: SourceCandidate[] = []
      for (const candidate of discovery.candidates) {
        if (controller.signal.aborted) break
        if (cutoff !== null && candidate.mtimeMs < cutoff) {
          removeIndexedFile(db, candidate.filePath)
          continue
        }
        markFileSeen(db, candidate.filePath, scanId)
        const row = findFile(db, candidate.filePath)
        if (row?.state === 'failed' && row.fail_count >= 3 && row.failed_signature === candidate.signature) continue
        if (row?.state === 'current' && row.signature === candidate.signature && identityUnchanged(row, candidate)) continue
        markFileDue(db, candidate, scanId)
        eligible.push(candidate)
      }
      const allowed = full ? eligible : recentCandidates(eligible, RECENT_PER_AGENT_ROOT)
      if (!full && allowed.length < eligible.length) owed = true
      for (const candidate of allowed) {
        if (controller.signal.aborted || performance.now() - started >= PASS_BUDGET_MS) break
        await indexCandidate(db, options.scanner, candidate, controller)
        publish()
      }
      if (controller.signal.aborted || performance.now() - started >= PASS_BUDGET_MS) {
        owed = true
      } else {
        const missingRemain = removeProvenMissing(db, discovery, rootInfo.verifiableRoots, scanId, MISSING_FILES_PER_PASS)
        const retentionRemain = purgeRetention(db, cutoff)
        drainOrphans(db, ORPHANS_PER_PASS)
        completedFull = full && allowed.length === eligible.length && !missingRemain && !retentionRemain && !controller.signal.aborted
        owed = hasPendingWork(db) || missingRemain || retentionRemain
      }
      if (completedFull) lastSweepCompletedAt = Date.now()
    } catch (error) {
      if (!controller.signal.aborted) {
        degradedRoots = [...degradedRoots.filter(root => root.root !== undefined), { reason: 'Source discovery or reconciliation failed' }]
        owed = true
      }
    } finally {
      if (activeController === controller) activeController = null
      publish()
    }
  }

  const reconcile = (reconcileOptions: { full?: boolean; signal?: AbortSignal } = {}): Promise<void> => {
    if (reconcileOptions.signal?.aborted) return Promise.reject(abortError())
    if (closed || !policy.enabled || !database) return Promise.resolve()
    if (reconcileOptions.full) fullRequested = true
    if (reconcileTask === null) {
      reconcileTask = (async () => {
        try {
          let runs = 0
          do {
            const explicitFull = fullRequested
            fullRequested = false
            cycle += 1
            const full = explicitFull || owed || cycle % FULL_SWEEP_EVERY_CYCLES === 0
            await runPass(full)
            runs += 1
          } while (fullRequested && policy.enabled && !closed && runs < 2)
        } finally {
          reconcileTask = null
          if (fullRequested && policy.enabled && !closed) void reconcile({ full: true }).catch(() => undefined)
        }
      })()
    }
    return waitForCaller(reconcileTask, reconcileOptions.signal)
  }

  const search = async (request: SearchRequest): Promise<SearchResponse> => {
    if (!policy.enabled) return { kind: 'unavailable', reason: 'disabled' }
    if (request.host !== undefined && request.host !== 'local' && request.host !== 'all') return { kind: 'unavailable', reason: 'no-service' }
    if (!database) return { kind: 'unavailable', reason: 'not-ready' }
    let freshnessIncomplete = false
    if (request.freshness === 'wait-until-current') {
      const task = reconcile({ full: true })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const { promise: deadlinePromise, resolve } = Promise.withResolvers<boolean>()
      timeout = setTimeout(() => resolve(false), 5000)
      const settled = await Promise.race([task.then(() => true, () => true), deadlinePromise])
      clearTimeout(timeout)
      freshnessIncomplete = !settled || readStatus().phase !== 'current'
    }
    if (!policy.enabled) return { kind: 'unavailable', reason: 'disabled' }
    if (!database) return { kind: 'unavailable', reason: 'not-ready' }
    const response = searchIndex(database, request, retentionCutoff(), record => sourcePresence(record))
    if (response.kind === 'results' && freshnessIncomplete) response.truncated.freshness = true
    return response
  }

  const sourcePresence = (record: SearchSourceRecord): 'present' | 'missing' | 'unverifiable' => {
    const root = rootStates.get(record.source_root)
    const logicalSourceMissing = record.file_path !== record.candidate_path && !knownCandidatePaths.has(record.candidate_path)
    if (logicalSourceMissing && root?.presence !== 'missing' && root?.presence !== 'unverifiable') return 'missing'
    try {
      const stat = lstatSync(record.file_path)
      return stat.isSymbolicLink() || !stat.isFile() ? 'unverifiable' : 'present'
    } catch (error) {
      if (root && root.presence !== 'present') return 'unverifiable'
      if (logicalSourceMissing) return 'missing'
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return 'missing'
      return 'unverifiable'
    }
  }

  const clear = async (): Promise<void> => {
    if (closed) throw new Error('Search service is closed')
    if (policy.enabled) throw new Error('Search must be disabled before clearing its index')
    stopTimer()
    await cancelReconcile()
    closeDatabase()
    removeDatabaseFiles(databasePath)
    degradedRoots = []
    lastSweepCompletedAt = null
    lastReconcileAt = null
    owed = false
    publish()
  }

  const remove = (id: string): void => {
    if (!database || !id) return
    const row = database.prepare('SELECT id FROM sessions WHERE vault_id = ?').get(id) as { id: number } | null
    if (!row) return
    database.transaction(() => {
      database!.prepare('DELETE FROM files WHERE session_row_id = ?').run(row.id)
      database!.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
    })()
    owed = true
    publish()
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    policy = { ...policy, enabled: false }
    stopTimer()
    activeController?.abort()
    try { await reconcileTask } catch { /* The connection still closes after the owned pass drains. */ }
    reconcileTask = null
    closeDatabase()
    publish()
  }

  function closeDatabase(): void {
    const old = database
    database = null
    if (old) old.close()
  }

  return {
    apply: enqueueApply,
    search,
    status: readStatus,
    reconcile,
    clear,
    remove,
    close
  }

}

function openDatabase(path: string): Database {
  let db: Database | null = new Database(path, { create: true })
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: number }
    if (version?.user_version !== SCHEMA_VERSION) {
      db.close()
      db = null
      removeDatabaseFiles(path)
      db = new Database(path, { create: true })
    }
    const connection = db
    connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_size_limit = 8388608;')
    connection.exec(SCHEMA_SQL)
    connection.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('index_generation', '0')").run()
    connection.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('index_incarnation', ?)").run(randomUUID())
    connection.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('next_scan', '0')").run()
    connection.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('next_stage', '0')").run()
    connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    ensureQuerySchema(connection)
    cleanStagingRows(connection)
    return connection
  } catch (error) {
    db?.close()
    throw error
  }
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of SQLITE_SUFFIXES) rmSync(`${path}${suffix}`, { force: true })
}

function readStats(db: Database): Stats {
  const counts = db.prepare(`SELECT
    (SELECT count(*) FROM files WHERE state = 'current' AND session_row_id IS NOT NULL) AS filesIndexed,
    (SELECT count(*) FROM files WHERE state = 'due' OR (state = 'failed' AND fail_count < 3)) AS filesDue,
    (SELECT count(*) FROM files WHERE state = 'failed') AS filesFailed,
    (SELECT count(*) FROM messages m JOIN sessions s ON s.id = m.session_row_id) AS messagesIndexed`).get() as {
      filesIndexed: number; filesDue: number; filesFailed: number; messagesIndexed: number
    }
  const sessionsByAgent: Record<string, number> = {}
  const rows = db.prepare('SELECT agent, count(*) AS count FROM sessions GROUP BY agent ORDER BY agent').all() as { agent: string; count: number }[]
  for (const row of rows) sessionsByAgent[row.agent] = row.count
  return { ...counts, sessionsByAgent, generation: readGeneration(db) }
}

function emptyStats(): Stats {
  return { filesIndexed: 0, filesDue: 0, filesFailed: 0, messagesIndexed: 0, generation: 0, sessionsByAgent: {} }
}

function updateRootState(
  db: Database,
  discovery: Discovery,
  previous: Map<string, RootState>
): { states: Map<string, RootState>; degraded: SearchStatus['degradedRoots']; verifiableRoots: Set<string> } {
  const states = new Map<string, RootState>()
  const degraded = new Map<string | undefined, string>()
  const indexedByRoot = new Map<string, number>()
  for (const row of db.prepare('SELECT root, count(*) AS count FROM files GROUP BY root').all() as { root: string; count: number }[]) {
    indexedByRoot.set(row.root, row.count)
  }
  const candidateCounts = new Map<string, number>()
  for (const candidate of discovery.candidates) candidateCounts.set(candidate.root, (candidateCounts.get(candidate.root) ?? 0) + 1)
  const rootErrors = new Set(discovery.issues.filter(issue => issue.root).map(issue => issue.root!))
  const verifiableRoots = new Set<string>()
  for (const root of discovery.roots) {
    const oldCount = indexedByRoot.get(root.path) ?? 0
    const emptyPreviouslyPopulated = root.presence === 'present' && oldCount > 0 && (candidateCounts.get(root.path) ?? 0) === 0
    const hasRootError = rootErrors.has(root.path)
    const state: RootState = emptyPreviouslyPopulated
      ? { presence: 'unverifiable', reason: 'Root is empty after previously containing indexed sources' }
      : root.presence === 'present' && hasRootError
        ? { presence: 'unverifiable', reason: discovery.issues.find(issue => issue.root === root.path)?.reason ?? 'Source root could not be completely checked' }
        : { presence: root.presence, ...(root.reason ? { reason: root.reason } : {}) }
    states.set(root.path, state)
    if (state.presence === 'present') verifiableRoots.add(root.path)
    if (state.presence !== 'present') degraded.set(root.path, state.reason ?? `Source root is ${state.presence}`)
  }
  for (const issue of discovery.issues) {
    if (!issue.root && !issue.filePath && issue.kind !== 'notice') continue
    const candidate = issue.filePath ? discovery.candidates.find(item => item.filePath === issue.filePath) : null
    const indexed = issue.filePath ? findFile(db, issue.filePath) : null
    const root = issue.root ?? candidate?.root ?? indexed?.root
    const reason = issue.reason || 'Source could not be checked'
    if (root && issue.root) {
      if (states.get(root)?.presence === 'present') states.set(root, { presence: 'unverifiable', reason })
      verifiableRoots.delete(root)
    }
    degraded.set(root ?? issue.filePath, reason)
  }
  for (const [root, state] of previous) {
    if (!states.has(root)) {
      states.set(root, { presence: 'unverifiable', reason: state.reason ?? 'Source root was not reported by discovery' })
      degraded.set(root, state.reason ?? 'Source root was not reported by discovery')
    }
  }
  return { states, degraded: [...degraded].map(([root, reason]) => ({ ...(root ? { root } : {}), reason })), verifiableRoots }
}

function findFile(db: Database, path: string): FileRow | null {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | null
}

function allocateScanId(db: Database): number {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'next_scan'").run()
  const row = db.prepare("SELECT CAST(value AS INTEGER) AS value FROM meta WHERE key = 'next_scan'").get() as { value: number }
  return row.value
}

function markFileSeen(db: Database, path: string, scanId: number): void {
  db.prepare('UPDATE files SET last_seen_scan = ? WHERE path = ?').run(scanId, path)
}

function markFileDue(db: Database, candidate: SourceCandidate, scanId: number): void {
  const current = findFile(db, candidate.filePath)
  const info = safeFileIdentity(sqliteSourcePath(candidate))
  if (!current) {
    db.prepare(`INSERT INTO files(path, root, agent, dev, ino, state, pending_signature, pending_mtime_ms, pending_size_bytes, last_seen_scan)
      VALUES (?, ?, ?, ?, ?, 'due', ?, ?, ?, ?)`)
      .run(candidate.filePath, candidate.root, candidate.agent, info.dev, info.ino, candidate.signature, candidate.mtimeMs, candidate.size, scanId)
    return
  }
  const changedSignature = current.failed_signature !== null && current.failed_signature !== candidate.signature
  db.prepare(`UPDATE files SET root = ?, agent = ?, dev = ?, ino = ?, state = 'due',
    pending_signature = ?, pending_mtime_ms = ?, pending_size_bytes = ?, last_seen_scan = ?,
    fail_count = ?, failed_signature = ? WHERE path = ?`)
    .run(candidate.root, candidate.agent, info.dev, info.ino, candidate.signature, candidate.mtimeMs, candidate.size, scanId,
      changedSignature ? 0 : current.fail_count, changedSignature ? null : current.failed_signature, candidate.filePath)
}
function identityUnchanged(row: FileRow, candidate: SourceCandidate): boolean {
  const identity = safeFileIdentity(sqliteSourcePath(candidate))
  return (identity.dev === null || row.dev === null || identity.dev === row.dev) &&
    (identity.ino === null || row.ino === null || identity.ino === row.ino) &&
    candidate.size >= row.size_bytes
}

function safeFileIdentity(path: string): { dev: number | null; ino: number | null } {
  try {
    const stat = lstatSync(path)
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return { dev: null, ino: null }
  }
}

function recentCandidates(candidates: SourceCandidate[], limit: number): SourceCandidate[] {
  const grouped = new Map<string, SourceCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.agent}\0${candidate.root}`
    const group = grouped.get(key)
    if (group) group.push(candidate)
    else grouped.set(key, [candidate])
  }
  const result: SourceCandidate[] = []
  for (const group of grouped.values()) {
    group.sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath))
    result.push(...group.slice(0, limit))
  }
  return result
}

async function indexCandidate(db: Database, scanner: VaultScanner, candidate: SourceCandidate, controller: AbortController): Promise<void> {
  const stageId = allocateStageId(db)
  let hash: SearchContentHash = { hash: null, count: 0 }
  let pending: WriteMessage[] = []
  let pendingChars = 0
  let seenMessages = 0
  const flush = (): void => {
    if (pending.length === 0) return
    const rows = pending
    pending = []
    pendingChars = 0
    db.transaction(() => {
      const insertMessage = db.prepare('INSERT INTO messages(session_row_id, role, ts) VALUES (?, ?, ?)')
      const insertFts = db.prepare('INSERT INTO messages_fts(rowid, user_text, assistant_text, tool_text, identifiers) VALUES (?, ?, ?, ?, ?)')
      for (const row of rows) {
        const inserted = insertMessage.run(stageId, row.role, row.timestamp)
        const rowid = Number(inserted.lastInsertRowid)
        insertFts.run(rowid, row.role === 'user' ? row.text : '', row.role === 'assistant' ? row.text : '', row.role === 'tool' ? row.text : '', row.identifiers)
      }
      bumpGeneration(db)
    })()
  }
  const onMessage = (message: VaultMessage): void => {
    if (controller.signal.aborted) return
    if (!message || !['user', 'assistant', 'tool', 'system'].includes(message.role) || typeof message.text !== 'string') return
    if (seenMessages < 8) hash = extendContentHash(hash, message.role, message.text)
    seenMessages += 1
    const normalized: VaultMessage = {
      role: message.role,
      text: message.text,
      timestamp: typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : null
    }
    for (const row of indexedMessageRows(normalized)) {
      pending.push(row)
      pendingChars += row.text.length
      if (pendingChars >= WRITE_BATCH_CHARS) flush()
    }
  }
  try {
    const session = await scanner.parse(candidate, onMessage, controller.signal)
    if (controller.signal.aborted) {
      discardStage(db, stageId)
      return
    }
    flush()
    if (!session) throw new Error('Transcript did not produce a session record')
    publishStage(db, candidate, stageId, session, hash, seenMessages)
  } catch {
    discardStage(db, stageId)
    if (!controller.signal.aborted) recordFailure(db, candidate)
  }
}

function allocateStageId(db: Database): number {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'next_stage'").run()
  const row = db.prepare("SELECT CAST(value AS INTEGER) AS value FROM meta WHERE key = 'next_stage'").get() as { value: number }
  return -row.value
}


function publishStage(
  db: Database,
  candidate: SourceCandidate,
  stageId: number,
  session: VaultSession,
  hash: SearchContentHash,
  callbackMessages: number
): void {
  const info = safeFileIdentity(sqliteSourcePath(candidate))
  db.transaction(() => {
    const oldFile = db.prepare('SELECT session_row_id FROM files WHERE path = ?').get(candidate.filePath) as { session_row_id: number | null } | null
    const oldIdentity = db.prepare('SELECT id FROM sessions WHERE vault_id = ?').get(session.id) as { id: number } | null
    const oldRows = new Set<number>()
    if (oldFile?.session_row_id !== null && oldFile?.session_row_id !== undefined) oldRows.add(oldFile.session_row_id)
    if (oldIdentity) oldRows.add(oldIdentity.id)
    for (const oldId of oldRows) {
      db.prepare('DELETE FROM files WHERE session_row_id = ? AND path <> ?').run(oldId, candidate.filePath)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId)
    }
    const inserted = db.prepare(`INSERT INTO sessions(
      vault_id, agent, session_id, file_path, codex_home, title, cwd, cwd_key, branch,
      created_at, updated_at, message_count, content_hash, content_hash_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        session.id, session.agent || candidate.agent, session.sessionId, session.filePath || candidate.filePath,
        session.codexHome, session.title || session.sessionId, session.cwd, pathKey(session.cwd), session.branch,
        finiteTime(session.createdAt), finiteTime(session.updatedAt), Math.max(0, Math.trunc(session.messageCount || callbackMessages)),
        hash.hash, hash.count
      )
    const sessionId = Number(inserted.lastInsertRowid)
    db.prepare('UPDATE messages SET session_row_id = ? WHERE session_row_id = ?').run(sessionId, stageId)
    db.prepare(`INSERT INTO files(path, root, agent, dev, ino, signature, mtime_ms, size_bytes, session_row_id, state,
        fail_count, failed_signature, pending_signature, pending_mtime_ms, pending_size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', 0, NULL, NULL, NULL, NULL)
      ON CONFLICT(path) DO UPDATE SET root=excluded.root, agent=excluded.agent, dev=excluded.dev, ino=excluded.ino,
        signature=excluded.signature, mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes,
        session_row_id=excluded.session_row_id, state='current', fail_count=0, failed_signature=NULL,
        pending_signature=NULL, pending_mtime_ms=NULL, pending_size_bytes=NULL`)
      .run(candidate.filePath, candidate.root, candidate.agent, info.dev, info.ino, candidate.signature,
        candidate.mtimeMs, candidate.size, sessionId)
  })()
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function pathKey(cwd: string | null): string | null {
  if (!cwd) return null
  const nfc = cwd.normalize('NFC')
  const windows = /^[A-Za-z]:[\\/]/.test(nfc) || nfc.startsWith('\\\\') || nfc.startsWith('//')
  let normalized = windows ? nfc.replace(/\\/g, '/').replace(/\/{2,}/g, '/') : nfc.replace(/\/{2,}/g, '/')
  if (nfc.startsWith('\\\\') || nfc.startsWith('//')) normalized = `//${normalized.replace(/^\/+/, '')}`
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '')
  const wsl = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (wsl) return `//wsl/${wsl[1]!.toLowerCase()}${wsl[2] ?? ''}`
  return windows ? normalized.toLowerCase() : normalized
}

function bumpGeneration(db: Database): void {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation'").run()
}

function discardStage(db: Database, stageId: number): void {
  drainSessionMessages(db, stageId, ORPHANS_PER_PASS)
}

function drainSessionMessages(db: Database, sessionId: number, limit: number): number {
  const ids = db.prepare('SELECT id FROM messages WHERE session_row_id = ? LIMIT ?').all(sessionId, limit) as { id: number }[]
  if (ids.length > 0) deleteMessageRows(db, ids)
  return ids.length
}

function deleteMessageRows(db: Database, ids: { id: number }[]): void {
  db.transaction(() => {
    const deleteFts = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
    const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?')
    for (const row of ids) { deleteFts.run(row.id); deleteMessage.run(row.id) }
    bumpGeneration(db)
  })()
}

function cleanStagingRows(db: Database): void {
  const staged = db.prepare('SELECT id FROM messages WHERE session_row_id < 0 LIMIT ?').all(ORPHANS_PER_PASS) as { id: number }[]
  if (staged.length > 0) deleteMessageRows(db, staged)
}

function recordFailure(db: Database, candidate: SourceCandidate): void {
  const row = findFile(db, candidate.filePath)
  const count = row?.failed_signature === candidate.signature ? row.fail_count + 1 : 1
  db.prepare(`INSERT INTO files(path, root, agent, signature, mtime_ms, size_bytes, state, fail_count, failed_signature,
      pending_signature, pending_mtime_ms, pending_size_bytes)
    VALUES (?, ?, ?, '', 0, 0, 'failed', ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET root=excluded.root, agent=excluded.agent, state='failed', fail_count=?,
      failed_signature=?, pending_signature=excluded.pending_signature, pending_mtime_ms=excluded.pending_mtime_ms,
      pending_size_bytes=excluded.pending_size_bytes`)
    .run(candidate.filePath, candidate.root, candidate.agent, count, candidate.signature, candidate.signature,
      candidate.mtimeMs, candidate.size, count, candidate.signature)
}

function removeIndexedFile(db: Database, path: string): void {
  const row = db.prepare('SELECT session_row_id FROM files WHERE path = ?').get(path) as { session_row_id: number | null } | null
  if (!row) return
  db.transaction(() => {
    db.prepare('DELETE FROM files WHERE path = ?').run(path)
    if (row.session_row_id !== null) db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_row_id)
  })()
}

function removeProvenMissing(
  db: Database,
  discovery: Discovery,
  verifiableRoots: Set<string>,
  scanId: number,
  limit: number
): boolean {
  if (verifiableRoots.size === 0) return false
  for (const issue of discovery.issues) {
    if (issue.filePath) markFileSeen(db, issue.filePath, scanId)
  }
  const roots = [...verifiableRoots]
  const unseen = db.prepare(`SELECT path FROM files
    WHERE root IN (${roots.map(() => '?').join(',')}) AND last_seen_scan <> ?
    ORDER BY path LIMIT ?`).all(...roots, scanId, limit + 1) as { path: string }[]
  for (const row of unseen.slice(0, limit)) removeIndexedFile(db, row.path)
  return unseen.length > limit
}

function purgeRetention(db: Database, cutoff: number | null): boolean {
  if (cutoff === null) return false
  const expired = db.prepare('SELECT path FROM files WHERE mtime_ms < ? ORDER BY mtime_ms LIMIT ?').all(cutoff, ORPHANS_PER_PASS + 1) as { path: string }[]
  for (const row of expired.slice(0, ORPHANS_PER_PASS)) removeIndexedFile(db, row.path)
  return expired.length > ORPHANS_PER_PASS
}

function drainOrphans(db: Database, limit: number): void {
  const rows = db.prepare(`SELECT m.id FROM messages m LEFT JOIN sessions s ON s.id=m.session_row_id
    WHERE m.session_row_id < 0 OR s.id IS NULL ORDER BY m.id LIMIT ?`).all(limit) as { id: number }[]
  if (rows.length > 0) deleteMessageRows(db, rows)
}

function hasPendingWork(db: Database): boolean {
  const row = db.prepare(`SELECT
    (SELECT count(*) FROM files WHERE state = 'due' OR (state = 'failed' AND fail_count < 3)) AS files,
    (SELECT count(*) FROM messages m LEFT JOIN sessions s ON s.id=m.session_row_id WHERE s.id IS NULL) AS orphans`).get() as { files: number; orphans: number }
  return row.files > 0 || row.orphans > 0
}

function waitForCaller(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  const { promise: wait, resolve, reject } = Promise.withResolvers<void>()
  const onAbort = () => {
    signal.removeEventListener('abort', onAbort)
    reject(abortError())
  }
  signal.addEventListener('abort', onAbort, { once: true })
  promise.then(
    () => { signal.removeEventListener('abort', onAbort); resolve() },
    error => { signal.removeEventListener('abort', onAbort); reject(error) }
  )
  return wait
}

function abortError(): Error {
  const error = new Error('Search reconciliation cancelled')
  error.name = 'AbortError'
  return error
}
