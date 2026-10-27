import { readdir, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import { HISTORY_AGENTS } from '../agents'
import type {
  Discovery,
  ListRequest,
  ListResult,
  ScanIssue,
  ScanProgress,
  ScannerOptions,
  SourceCandidate,
  VaultMessage,
  VaultScanner,
  VaultSession
} from '../types'
import { parseGraph } from './parsers/graph'
import { parsePrimary } from './parsers/primary'
import { parseSqlite } from './parsers/sqlite'
import { parseDocumentAgent } from './parsers/document-agents'
import { throwIfAborted, type ParserContext } from './parsers/shared'
import { agentSourceRoots, discoverSources, isDeleteSupported, isPathWithin, stableSourceId } from './discovery'

const CACHE_LIMIT = 4096
const MEMORY_CACHE_BYTE_LIMIT = 16 * 1024 * 1024
const DELETABLE_WHOLE_DIRECTORY = new Set(['grok', 'rovo', 'cline'])

type CachedSession = { signature: string; sessionJson: string; byteLength: number; seenAt: number }
type ScanOptions = { sourceHome: string; dataDir: string; env: Record<string, string | undefined>; progress?: (value: ScanProgress) => void }

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : null
}

function scannerIssue(candidate: SourceCandidate, error: unknown): ScanIssue {
  return {
    agent: candidate.agent,
    filePath: candidate.filePath,
    reason: error instanceof Error ? error.message : String(error),
    kind: 'error'
  }
}

class ParseCache {
  private readonly filePath: string
  private db: Database | null = null
  private opening: Promise<Database | null> | null = null
  private readonly rows = new Map<string, CachedSession>()
  private memoryBytes = 0

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'session-parse-cache.sqlite')
  }

  async get(id: string, signature: string): Promise<VaultSession | null> {
    const memory = this.rows.get(id)
    if (memory?.signature === signature) {
      memory.seenAt = Date.now()
      this.remember(id, memory)
      try {
        return JSON.parse(memory.sessionJson) as VaultSession
      } catch {
        this.invalidate(id)
      }
    }
    const db = await this.open()
    if (!db) return null
    try {
      const row = db.query('SELECT signature, session_json FROM sessions WHERE id = ?').get(id) as { signature?: unknown; session_json?: unknown } | null
      if (row?.signature !== signature || typeof row.session_json !== 'string') return null
      const session = JSON.parse(row.session_json) as VaultSession
      if (!session || session.id !== id || session.presence !== 'present') return null
      this.remember(id, { signature, sessionJson: row.session_json, byteLength: row.session_json.length * 2, seenAt: Date.now() })
      return session
    } catch {
      return null
    }
  }

  async set(id: string, signature: string, session: VaultSession, isCurrent: () => boolean): Promise<void> {
    const sessionJson = JSON.stringify(session)
    const entry = { signature, sessionJson, byteLength: sessionJson.length * 2, seenAt: Date.now() }
    this.remember(id, entry)
    const db = await this.open()
    if (!db || !isCurrent()) {
      if (!isCurrent()) this.invalidate(id)
      return
    }
    try {
      db.query('INSERT INTO sessions(id, signature, session_json, seen_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature, session_json=excluded.session_json, seen_at=excluded.seen_at').run(id, signature, sessionJson, entry.seenAt)
      db.query('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY seen_at DESC LIMIT -1 OFFSET ?)').run(CACHE_LIMIT)
    } catch {
      // The parse cache is disposable; source reads remain authoritative.
    }
  }

  invalidate(id: string): void {
    const entry = this.rows.get(id)
    if (entry) {
      this.memoryBytes -= entry.byteLength
      this.rows.delete(id)
    }
    try {
      this.db?.query('DELETE FROM sessions WHERE id = ?').run(id)
    } catch {
      // A broken derived cache cannot prevent source validation or browsing.
    }
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.rows.clear()
    this.memoryBytes = 0
  }

  private remember(id: string, entry: CachedSession): void {
    const previous = this.rows.get(id)
    if (previous) {
      this.memoryBytes -= previous.byteLength
      this.rows.delete(id)
    }
    if (entry.byteLength > MEMORY_CACHE_BYTE_LIMIT) return
    while (this.memoryBytes + entry.byteLength > MEMORY_CACHE_BYTE_LIMIT || this.rows.size >= CACHE_LIMIT) {
      const oldestId = this.rows.keys().next().value
      if (!oldestId) break
      const oldest = this.rows.get(oldestId)
      if (oldest) this.memoryBytes -= oldest.byteLength
      this.rows.delete(oldestId)
    }
    this.rows.set(id, entry)
    this.memoryBytes += entry.byteLength
  }

  private async open(): Promise<Database | null> {
    if (this.db) return this.db
    if (this.opening) return this.opening
    this.opening = (async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true })
        const db = new Database(this.filePath, { create: true })
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, signature TEXT NOT NULL, session_json TEXT NOT NULL, seen_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS sessions_seen_at ON sessions(seen_at)')
        this.db = db
        return db
      } catch {
        return null
      }
    })()
    try {
      return await this.opening
    } finally {
      this.opening = null
    }
  }
}

function cwdMatches(cwd: string | null, scopePaths: readonly string[]): boolean {
  if (!cwd) return false
  const normalizedCwd = resolve(cwd)
  return scopePaths.some((path) => {
    const normalizedScope = resolve(path)
    const rel = relative(normalizedScope, normalizedCwd)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
  })
}

function sessionSort(a: VaultSession, b: VaultSession, sort: ListRequest['sort']): number {
  const left = sort === 'created' ? a.createdAt : a.updatedAt
  const right = sort === 'created' ? b.createdAt : b.updatedAt
  return right - left || a.id.localeCompare(b.id)
}

function parseByAgent(context: ParserContext): Promise<VaultSession | null> {
  switch (context.candidate.agent) {
    case 'claude': case 'qoder': case 'codebuddy': case 'codex': case 'gemini': case 'copilot': case 'cursor':
      return parsePrimary(context)
    case 'rovo': case 'openclaw': case 'pi': case 'omp': case 'prime-agent':
      return parseGraph(context)
    case 'opencode': case 'opencode2': case 'zcode':
      return parseSqlite(context)
    case 'grok': case 'devin': case 'hermes': case 'jcode': case 'kiro': case 'droid': case 'cline': case 'kimi': case 'muse': case 'antigravity':
      return parseDocumentAgent(context)
    default:
      return Promise.resolve(null)
  }
}

async function validateCurrentFile(candidate: SourceCandidate): Promise<boolean> {
  const marker = candidate.filePath.lastIndexOf('#')
  const sourcePath = marker >= 0 ? candidate.filePath.slice(0, marker) : candidate.filePath
  try {
    const [info, rootInfo, sourceReal, rootReal] = await Promise.all([
      lstat(sourcePath),
      lstat(candidate.root),
      realpath(sourcePath),
      realpath(candidate.root)
    ])
    if (!info.isFile() || info.isSymbolicLink() || rootInfo.isSymbolicLink()) return false
    return isPathWithin(rootReal, sourceReal)
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false
    throw error
  }
}

async function observeSubagentFiles(candidate: SourceCandidate): Promise<string[]> {
  if (candidate.agent !== 'claude' && candidate.agent !== 'omp') return []
  const directory = candidate.agent === 'claude'
    ? join(dirname(candidate.filePath), basename(candidate.filePath, extname(candidate.filePath)), 'subagents')
    : join(dirname(candidate.filePath), basename(candidate.filePath, extname(candidate.filePath)))
  let realRoot: string
  try {
    const [dirInfo, rootReal] = await Promise.all([lstat(directory), realpath(candidate.root)])
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return []
    realRoot = rootReal
    const realDirectory = await realpath(directory)
    if (!isPathWithin(realRoot, realDirectory)) return []
  } catch {
    return []
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && extname(entry.name).toLowerCase() === '.jsonl' && (candidate.agent !== 'claude' || entry.name.startsWith('agent-')))
      .map((entry) => join(directory, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function candidateForSubagent(parent: SourceCandidate, filePath: string): Promise<SourceCandidate | null> {
  try {
    const [info, real, realRoot] = await Promise.all([lstat(filePath, { bigint: true }), realpath(filePath), realpath(parent.root)])
    if (!info.isFile() || info.isSymbolicLink() || !isPathWithin(realRoot, real)) return null
    return {
      agent: parent.agent,
      filePath,
      root: parent.root,
      signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      mtimeMs: Number(info.mtimeNs) / 1e6,
      size: Number(info.size),
      codexHome: parent.codexHome,
      sessionId: basename(filePath, extname(filePath)),
      metadata: { subagent: true }
    }
  } catch {
    return null
  }
}

async function validateDeleteTarget(path: string, root: string, kind: 'file' | 'directory'): Promise<string> {
  if (!isPathWithin(root, path) || resolve(path) === resolve(root)) throw new Error('invalid-path')
  let cursor = resolve(path)
  while (isPathWithin(root, cursor)) {
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error('invalid-path')
      if (cursor === resolve(path) && !(kind === 'file' ? info.isFile() : info.isDirectory())) throw new Error('invalid-path')
      const [real, realRoot] = await Promise.all([realpath(cursor), realpath(root)])
      if (!isPathWithin(realRoot, real)) throw new Error('invalid-path')
      return path
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error
    }
    if (cursor === resolve(root)) break
    cursor = dirname(cursor)
  }
  return path
}

function deleteError(message: 'invalid-path' | 'unsupported-agent' | 'synthetic-path' | 'path-outside-known-roots'): Error {
  return new Error(message)
}

export function createScanner(options: ScannerOptions): VaultScanner {
  const normalized: ScanOptions = {
    sourceHome: resolve(options.env.QUIRKY_VAULT_SOURCE_HOME || options.sourceHome),
    dataDir: resolve(options.dataDir),
    env: options.env,
    progress: options.progress
  }
  const cache = new ParseCache(normalized.dataDir)
  const knownCandidates = new Map<string, SourceCandidate>()
  const invalidated = new Set<string>()
  let generation = 0
  let closed = false

  const report = (value: ScanProgress) => normalized.progress?.(value)

  async function discover(signal?: AbortSignal): Promise<Discovery> {
    if (closed) throw new Error('scanner-closed')
    throwIfAborted(signal)
    report({ phase: 'discovering', scannedFiles: 0, parsedFiles: 0 })
    const startedAt = generation
    const discovery = await discoverSources(normalized, signal)
    for (const candidate of discovery.candidates) {
      const id = stableSourceId(candidate)
      knownCandidates.set(id, candidate)
      if (startedAt === generation) invalidated.delete(id)
    }
    return discovery
  }

  async function parseCandidate(candidate: SourceCandidate, onMessage?: (message: VaultMessage) => void, signal?: AbortSignal, expectedGeneration = generation, subagent = false, capturePrompts = !onMessage): Promise<VaultSession | null> {
    if (closed) throw new Error('scanner-closed')
    throwIfAborted(signal)
    const id = stableSourceId(candidate)
    if (invalidated.has(id)) return null
    if (!await validateCurrentFile(candidate)) return null
    if (!onMessage && !capturePrompts) {
      const cached = await cache.get(id, candidate.signature)
      if (cached) {
        if (expectedGeneration !== generation && invalidated.has(id)) return null
        return cached
      }
    }
    const parsed = await parseByAgent({
      candidate,
      sourceHome: normalized.sourceHome,
      env: normalized.env,
      onMessage,
      capturePrompts,
      signal
    })
    throwIfAborted(signal)
    if (!parsed) return null
    parsed.id = id
    parsed.filePath = candidate.filePath
    parsed.codexHome = candidate.codexHome
    parsed.presence = 'present'
    if (!subagent && (candidate.agent === 'claude' || candidate.agent === 'omp')) {
      parsed.subagentTranscriptCount = (await observeSubagentFiles(candidate)).length
    }
    if (subagent) parsed.subagent = true
    if (expectedGeneration === generation && !invalidated.has(id) && !onMessage && !capturePrompts) {
      await cache.set(id, candidate.signature, parsed, () => expectedGeneration === generation && !invalidated.has(id))
    }
    if (expectedGeneration !== generation && invalidated.has(id)) return null
    return parsed
  }

  async function currentCandidateById(id: string, signal?: AbortSignal): Promise<SourceCandidate | null> {
    const discovery = await discover(signal)
    return discovery.candidates.find((candidate) => stableSourceId(candidate) === id) ?? null
  }

  return {
    discover,
    async parse(candidate, onMessage, signal) {
      const generationAtStart = generation
      const current = await currentCandidateById(stableSourceId(candidate), signal)
      if (!current) return null
      return parseCandidate(current, onMessage, signal, generationAtStart)
    },
    async list(request, signal) {
      const generationAtStart = generation
      throwIfAborted(signal)
      const scopePaths = request.scopePaths
      if (scopePaths && scopePaths.length > 64) throw new Error('too-many-scope-paths')
      report({ phase: 'discovering', scannedFiles: 0, parsedFiles: 0 })
      if (closed) throw new Error('scanner-closed')
      const discovery = await discoverSources(normalized, signal)
      const candidates = discovery.candidates
      for (const candidate of candidates) {
        const id = stableSourceId(candidate)
        knownCandidates.set(id, candidate)
        if (generationAtStart === generation) invalidated.delete(id)
      }
      const selectedAgents = request.agents === undefined ? new Set<string>(HISTORY_AGENTS) : new Set(request.agents)
      const selected = candidates.filter((candidate) => selectedAgents.has(candidate.agent))
      report({ phase: 'reading', scannedFiles: candidates.length, parsedFiles: 0 })
      const parsedSessions: VaultSession[] = []
      let parsedFiles = 0
      const issues = [...discovery.issues]
      for (const candidate of selected) {
        throwIfAborted(signal)
        report({ phase: 'reading', scannedFiles: candidates.length, parsedFiles, current: candidate.filePath })
        try {
          const session = await parseCandidate(candidate, undefined, signal, generationAtStart, false, false)
          parsedFiles++
          if (!session) continue
          if (request.hideEmpty && session.messageCount === 0 && session.queuedMessageCount === 0 && session.subagentTranscriptCount === 0) continue
          if (scopePaths !== undefined && (scopePaths.length === 0 || !cwdMatches(session.cwd, scopePaths))) continue
          parsedSessions.push(session)
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error
          issues.push(scannerIssue(candidate, error))
        }
      }
      const availableSessions = parsedSessions.filter((session) => !invalidated.has(session.id))
      availableSessions.sort((left, right) => sessionSort(left, right, request.sort))
      const total = availableSessions.length
      const limit = request.unlimited ? total : Number.isInteger(request.limit) && (request.limit ?? 0) > 0 ? request.limit! : 1000
      const sessions = availableSessions.slice(0, limit)
      report({ phase: 'complete', scannedFiles: candidates.length, parsedFiles })
      return {
        sessions,
        issues,
        scannedFiles: candidates.length,
        scannedAt: Date.now(),
        hasMore: total > limit,
        total
      }
    },
    async get(id) {
      const generationAtStart = generation
      const candidate = await currentCandidateById(id)
      if (!candidate) return null
      return parseCandidate(candidate, undefined, undefined, generationAtStart, false, false)
    },
    async firstPrompt(id) {
      const generationAtStart = generation
      const candidate = await currentCandidateById(id)
      if (!candidate) return null
      const session = await parseCandidate(candidate, undefined, undefined, generationAtStart)
      return session?.firstUserPrompt ?? null
    },
    async subagents(id) {
      const parent = await currentCandidateById(id)
      if (!parent || (parent.agent !== 'claude' && parent.agent !== 'omp')) return []
      const paths = await observeSubagentFiles(parent)
      const sessions: VaultSession[] = []
      for (const filePath of paths) {
        const candidate = await candidateForSubagent(parent, filePath)
        if (!candidate) continue
        const session = await parseCandidate(candidate, undefined, undefined, generation, true, false)
        if (session) sessions.push(session)
      }
      return sessions
    },
    async deleteTargets(id) {
      const candidate = knownCandidates.get(id)
      if (!candidate) throw deleteError('invalid-path')
      if (!isDeleteSupported(candidate.agent)) throw deleteError('unsupported-agent')
      if (candidate.filePath.includes('#')) throw deleteError('synthetic-path')
      const path = resolve(candidate.filePath)
      const roots = agentSourceRoots(normalized, candidate.agent).map((root) => resolve(root))
      const root = roots.find((value) => isPathWithin(value, path))
      if (!root) throw deleteError('path-outside-known-roots')
      const targets: { path: string; root: string; kind: 'file' | 'directory' }[] = []
      if (DELETABLE_WHOLE_DIRECTORY.has(candidate.agent)) {
        targets.push({ path: dirname(path), root, kind: 'directory' })
      } else if (candidate.agent === 'claude') {
        const sessionId = basename(path, extname(path))
        const sessionDirectory = join(dirname(path), sessionId)
        const sessionEnvRoot = join(dirname(root), 'session-env')
        targets.push({ path: sessionDirectory, root, kind: 'directory' })
        targets.push({ path: join(sessionEnvRoot, sessionId), root: sessionEnvRoot, kind: 'directory' })
        targets.push({ path, root, kind: 'file' })
      } else {
        targets.push({ path, root, kind: 'file' })
      }
      const validated: string[] = []
      for (const target of targets) validated.push(await validateDeleteTarget(target.path, target.root, target.kind))
      return validated
    },
    invalidate(id) {
      generation++
      invalidated.add(id)
      cache.invalidate(id)
    },
    close() {
      closed = true
      cache.close()
      knownCandidates.clear()
      invalidated.clear()
    }
  }
}
