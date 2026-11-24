import { recordSessionScanIssue } from './session-scan-issues'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
import type { SessionFileCandidate } from './session-scanner-types'
import type { OpenCodeSqliteCaptureValue } from './session-scanner-opencode-sqlite-worker-protocol'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import { findForeignSqliteReaderEntry } from '../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import { noteAiVaultScanDatabases, openAiVaultScanSource } from './ai-vault-scan-progress'

// Why: resolve the built worker entry + own the process-wide shared client so
// the client class stays free of Electron (require'd lazily here) and the
// scanner call sites depend only on the two routing functions below.

// The shared foreign SQLite reader worker runs OpenCode reads too.
export function resolveOpenCodeSqliteWorkerEntryPath(
  runtimeDir = __dirname,
  pathExists: (path: string) => boolean = existsSync
): string {
  return findForeignSqliteReaderEntry(runtimeDir, pathExists)
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveOpenCodeSqliteWorkerEntryPath()
  // Why: a missing built entry must throw synchronously so the client can fail
  // closed before it waits on a worker that can never post a result.
  if (!existsSync(workerPath)) {
    throw new Error(`OpenCode SQLite worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: OpenCodeSqliteWorkerClient | null = null

function getSharedClient(): OpenCodeSqliteWorkerClient {
  sharedClient ??= new OpenCodeSqliteWorkerClient({
    workerFactory: defaultWorkerFactory
  })
  return sharedClient
}

type SqliteParseArgs = Omit<Parameters<OpenCodeSqliteWorkerClient['parse']>[0], 'agent'>
type SqliteCaptureArgs = Omit<Parameters<OpenCodeSqliteWorkerClient['capture']>[0], 'agent'>

type SqliteListArgs = Omit<Parameters<OpenCodeSqliteWorkerClient['list']>[0], 'agent'>

/**
 * List OpenCode SQLite session candidates through the shared worker client.
 * @param args.dbPaths - Absolute paths to opencode.db files to scan.
 * @param args.limit - Maximum number of sessions to return per database.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns Synthetic candidates sorted by effective recency.
 */
export function listOpenCodeSqliteSessionsViaWorker(
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> {
  return listForHost(args)
}

/**
 * List opencode2 session candidates (v2 channel-scoped DB schema) through the
 * shared worker client.
 */
export function listOpenCode2SqliteSessionsViaWorker(
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> {
  return listForHost({ ...args, agent: 'opencode2' })
}

export function listZcodeSqliteSessionsViaWorker(
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> {
  return listForHost({ ...args, agent: 'zcode' })
}

/**
 * Parse one OpenCode SQLite session through the shared worker client.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - Primary key in the `session` table.
 * @param args.platform - Platform used for resume-command generation.
 * @returns The parsed session, or `null` when it does not exist.
 */
export function parseOpenCodeSqliteSessionViaWorker(
  args: SqliteParseArgs
): Promise<AiVaultSession | null> {
  return parseForHost(args)
}

export function parseOpenCode2SqliteSessionViaWorker(
  args: SqliteParseArgs
): Promise<AiVaultSession | null> {
  return parseForHost({ ...args, agent: 'opencode2' })
}

export function parseZcodeSqliteSessionViaWorker(
  args: SqliteParseArgs
): Promise<AiVaultSession | null> {
  return parseForHost({ ...args, agent: 'zcode' })
}

/**
 * Read one OpenCode SQLite session and its whole transcript through the shared
 * worker client.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - Primary key in the `session` table.
 * @param args.platform - Platform used for resume-command generation.
 * @returns The session and every message it holds.
 */
export function captureOpenCodeSqliteSessionViaWorker(
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost(args)
}

export function captureOpenCode2SqliteSessionViaWorker(
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost({ ...args, agent: 'opencode2' })
}

export function captureZcodeSqliteSessionViaWorker(
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost({ ...args, agent: 'zcode' })
}

async function listForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['list']>[0]
): Promise<SessionFileCandidate[]> {
  const agent = args.agent ?? 'opencode'
  const scoped = Boolean(args.scopePaths?.length)
  const issues: AiVaultScanIssue[] = []
  const closeSource =
    !scoped && args.dbPaths.length > 0 ? openAiVaultScanSource(args.signal, agent) : null
  try {
    const candidates = await listCandidatesForHost({ ...args, issues })
    // A database counts once it holds this agent's sessions: OpenCode 1 and 2 share one file.
    const dbPaths = candidates.map((c) => splitOpenCodeSqliteCandidate(c.file.path, agent)?.dbPath)
    if (!scoped) {
      noteAiVaultScanDatabases(args.signal, agent, new Set(dbPaths.filter(Boolean)).size)
    }
    return candidates
  } finally {
    for (const issue of issues) {
      if (
        !args.issues.some(
          (existing) =>
            existing.agent === issue.agent &&
            existing.path === issue.path &&
            existing.kind === issue.kind &&
            existing.message === issue.message &&
            existing.executionHostId === issue.executionHostId
        )
      ) {
        recordSessionScanIssue(args.issues, issue)
      }
    }
    closeSource?.()
  }
}

async function listCandidatesForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['list']>[0]
): Promise<SessionFileCandidate[]> {
  throwIfSignalAborted(args.signal)
  const candidates = await getSharedClient().list(args)
  throwIfSignalAborted(args.signal)
  return candidates.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
}

async function parseForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['parse']>[0]
): Promise<AiVaultSession | null> {
  return getSharedClient().parse(args)
}

async function captureForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['capture']>[0]
): Promise<OpenCodeSqliteCaptureValue> {
  return getSharedClient().capture(args)
}

export async function readOpenCodeTranscriptPageViaWorker(
  args: {
    dbPath: string
    sessionId: string
    limit: number
    beforeMessageRowId?: number
    agent?: 'zcode'
  },
  signal?: AbortSignal
) {
  const client = getSharedClient()
  const value = await client.readNativeChat(
    {
      ...args,
      limit: openCodeTranscriptPageLimit(args.limit),
      dbPath: args.dbPath,
      kind: 'native-page'
    },
    signal
  )
  if (value !== null && !('items' in value)) {
    throw new Error('Invalid OpenCode transcript page')
  }
  return value
}

export async function readOpenCodeTranscriptSignalViaWorker(
  args: {
    dbPath: string
    sessionId: string
    agent?: 'zcode'
  },
  signal?: AbortSignal
) {
  const client = getSharedClient()
  const value = await client.readNativeChat(
    { ...args, dbPath: args.dbPath, kind: 'native-signal' },
    signal
  )
  if (value !== null && !('messageCount' in value)) {
    throw new Error('Invalid OpenCode transcript signal')
  }
  return value
}
