import { Database } from 'bun:sqlite'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { DockQuestion } from '../types'

type RecordValue = Record<string, unknown>

type TranscriptEvent =
  | { kind: 'call'; id: string | null; name: string; input: unknown; at: number | null }
  | { kind: 'result'; id: string | null; at: number | null }
  | { kind: 'user'; text: string; at: number | null }

type ContextUsage = { used: number; limit: number } | null

export type TranscriptSnapshot = {
  events: TranscriptEvent[]
  model: string | null
  effort: string | null
  context: ContextUsage
  modifiedAt: number | null
  source: string | null
  notice: string | null
}

const EMPTY: TranscriptSnapshot = {
  events: [],
  model: null,
  effort: null,
  context: null,
  modifiedAt: null,
  source: null,
  notice: null
}

const MAX_JSONL_BYTES = 2 * 1024 * 1024
const MAX_JSONL_RECORDS = 4_000
const MAX_DB_ROWS = 2_000
const MAX_DB_ROW_BYTES = 1024 * 1024
const MAX_SCAN_ENTRIES = 2_000
const MAX_SCAN_DEPTH = 5
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/

const asRecord = (value: unknown): RecordValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordValue) : null

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value)
    if (text) return text
  }
  return null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const chunks: string[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (record?.type === 'text' && typeof record.text === 'string') chunks.push(record.text)
    else if (typeof record?.text === 'string') chunks.push(record.text)
  }
  return chunks.join('\n').slice(0, 200_000)
}

function contextUsage(value: unknown): ContextUsage {
  const record = asRecord(value)
  if (!record) return null
  const used = numberValue(record.used ?? record.input_tokens ?? record.inputTokens ?? record.total_tokens ?? record.totalTokens)
  const limit = numberValue(record.limit ?? record.context_window ?? record.contextWindow ?? record.contextWindowTokens)
  return used !== null && limit !== null && limit > 0 ? { used: Math.min(used, limit), limit } : null
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function rootContainsRegularFile(root: string, path: string): Promise<boolean> {
  if (!isInside(root, path) || !(await isRegularFile(path))) return false
  try {
    const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(path))])
    return isInside(realRoot, realParent)
  } catch {
    return false
  }
}


async function findFiles(
  root: string,
  accept: (path: string, name: string) => boolean,
  options: { maxDepth?: number; maxEntries?: number } = {}
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? MAX_SCAN_DEPTH
  const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES
  const found: string[] = []
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < maxEntries && found.length < 32) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > maxEntries) break
      const candidate = join(current.path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) {
        if (accept(candidate, entry.name) && (await rootContainsRegularFile(root, candidate))) found.push(candidate)
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ path: candidate, depth: current.depth + 1 })
      }
      if (found.length >= 32) break
    }
  }
  return found
}

function userHome(): string {
  return process.env.HOME?.trim() || homedir()
}

async function claudeTranscript(sessionId: string): Promise<string | null> {
  if (!ID_RE.test(sessionId)) return null
  const configuredHome = process.env.CLAUDE_CONFIG_DIR?.trim()
  const projectsRoots = [
    ...(configuredHome && isAbsolute(configuredHome) ? [join(resolve(configuredHome), 'projects')] : []),
    join(userHome(), '.claude', 'projects')
  ]
  for (const root of new Set(projectsRoots)) {
    const candidates = await findFiles(root, (_path, name) => name === `${sessionId}.jsonl`, { maxDepth: 2 })
    if (candidates[0]) return candidates[0]
  }
  return null
}

async function codexTranscript(sessionId: string): Promise<string | null> {
  if (!ID_RE.test(sessionId)) return null
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : join(userHome(), '.codex')
  const root = join(codexHome, 'sessions')
  const candidates = await findFiles(root, (_path, name) => name.endsWith('.jsonl') && name.includes(sessionId))
  return candidates[0] ?? null
}

async function grokTranscript(session: Session, sessionId: string): Promise<string | null> {
  if (!ID_RE.test(sessionId)) return null
  const configuredHome = process.env.GROK_HOME?.trim()
  const grokHome = configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : join(userHome(), '.grok')
  const root = join(grokHome, 'sessions')
  const cwdComponent = encodeURIComponent(session.cwd)
  const exact = join(root, cwdComponent, sessionId, 'chat_history.jsonl')
  if (await rootContainsRegularFile(root, exact)) return exact
  const candidates = await findFiles(
    root,
    (path, name) => name === 'chat_history.jsonl' && path.split(sep).includes(sessionId),
    { maxDepth: 3, maxEntries: MAX_SCAN_ENTRIES }
  )
  return candidates[0] ?? null
}

function normalizeAgentRoot(value: string): string {
  const cleaned = resolve(value.trim())
  const leaf = basename(cleaned).toLowerCase()
  if (leaf === 'sessions') return cleaned
  if (leaf === 'agent') return join(cleaned, 'sessions')
  if (leaf === '.omp') return join(cleaned, 'agent', 'sessions')
  return join(cleaned, 'sessions')
}

function ompRoots(): string[] {
  const home = userHome()
  const explicit = process.env.OMP_SESSIONS_DIR?.trim()
  const codingAgentDir = process.env.OMP_CODING_AGENT_DIR?.trim()
  const config = process.env.PI_CONFIG_DIR?.trim() || '.omp'
  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim()
  const profileSuffix = profile && profile !== 'default' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)
    ? join('profiles', profile)
    : ''
  const agentOverride = process.env.PI_CODING_AGENT_DIR?.trim()
  const roots = [
    ...(explicit ? [resolve(explicit)] : []),
    ...(codingAgentDir ? [normalizeAgentRoot(codingAgentDir)] : []),
    ...(agentOverride ? [join(resolve(agentOverride), 'sessions')] : []),
    ...(profileSuffix ? [join(home, config, profileSuffix, 'agent', 'sessions')] : []),
    ...(process.env.XDG_DATA_HOME ? [join(process.env.XDG_DATA_HOME, 'omp', profileSuffix, 'sessions')] : []),
    join(home, config, profileSuffix, 'agent', 'sessions')
  ]
  return [...new Set(roots)]
}

async function ompTranscript(sessionId: string): Promise<string | null> {
  if (!ID_RE.test(sessionId)) return null
  for (const root of ompRoots()) {
    const matches = await findFiles(root, (_path, name) => name.endsWith('.jsonl') && name.includes(sessionId))
    if (matches[0]) return matches[0]
  }
  return null
}

function openCodeDatabaseCandidates(agent: string): string[] {
  const home = userHome()
  if (agent === 'zcode') return [join(home, '.zcode', 'cli', 'db', 'db.sqlite')]
  const configured = process.env.OPENCODE_DB?.trim()
  if (configured === ':memory:') return []
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
  const dataDir = join(dataHome, 'opencode')
  const primary = configured
    ? (isAbsolute(configured) ? configured : join(dataDir, configured))
    : join(dataDir, 'opencode.db')
  return [primary]
}

async function findOpenCodeDatabase(sessionId: string, agent: string): Promise<string | null> {
  const candidates = openCodeDatabaseCandidates(agent)
  if (agent !== 'zcode') {
    const dataDir = dirname(candidates[0] ?? '')
    const others = await findFiles(
      dataDir,
      (_path, name) => /\.(?:db|sqlite|sqlite3)$/i.test(name),
      { maxDepth: 4, maxEntries: 500, }
    )
    candidates.push(...others)
  }
  for (const path of [...new Set(candidates)].slice(0, 32)) {
    if (!(await isRegularFile(path))) continue
    try {
      const db = new Database(path, { readonly: true, create: false })
      try {
        if (databaseHasSession(db, agent, sessionId)) return path
      } finally {
        db.close()
      }
    } catch {
      continue
    }
  }
  return null
}

function tableExists(db: Database, table: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null
}

function databaseHasSession(db: Database, agent: string, sessionId: string): boolean {
  try {
    if (tableExists(db, 'session_v2') && tableExists(db, 'session_message')) {
      return db.prepare('SELECT 1 AS found FROM session_v2 WHERE id = ?').get(sessionId) != null
    }
    if (tableExists(db, 'session')) {
      return db.prepare('SELECT 1 AS found FROM session WHERE id = ?').get(sessionId) != null
    }
  } catch {
    return false
  }
  return false
}

async function readBoundedJsonl(path: string): Promise<{ rows: RecordValue[]; modifiedAt: number; malformed: boolean }> {
  if (!(await isRegularFile(path))) throw new Error('transcript path is not a regular file')
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('transcript path is not a regular file')
    const readLength = Math.min(info.size, MAX_JSONL_BYTES)
    const offset = Math.max(0, info.size - readLength)
    const bytes = Buffer.alloc(readLength)
    if (readLength > 0) await file.read(bytes, 0, readLength, offset)
    let text = bytes.toString('utf8')
    if (offset > 0) {
      const newline = text.indexOf('\n')
      text = newline < 0 ? '' : text.slice(newline + 1)
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-MAX_JSONL_RECORDS)
    const rows: RecordValue[] = []
    let malformed = false
    for (const line of lines) {
      try {
        const record = asRecord(JSON.parse(line) as unknown)
        if (record) rows.push(record)
        else malformed = true
      } catch {
        malformed = true
      }
    }
    return { rows, modifiedAt: info.mtimeMs, malformed }
  } finally {
    await file.close()
  }
}

function boundedValue(value: unknown): string | null {
  const result = stringValue(value)
  return result ? result.slice(0, 200_000) : null
}

function addCall(events: TranscriptEvent[], id: unknown, name: unknown, input: unknown, at: number | null): void {
  const toolName = stringValue(name)
  if (!toolName) return
  events.push({ kind: 'call', id: stringValue(id), name: toolName, input, at })
}

function addResult(events: TranscriptEvent[], id: unknown, at: number | null): void {
  events.push({ kind: 'result', id: stringValue(id), at })
}

function addUser(events: TranscriptEvent[], value: unknown, at: number | null): void {
  const text = textOf(value).trim()
  if (text) events.push({ kind: 'user', text: text.slice(0, 200_000), at })
}

function readClaudeRows(rows: RecordValue[]): TranscriptSnapshot {
  const result = { ...EMPTY, events: [] as TranscriptEvent[] }
  for (const row of rows) {
    const at = timestamp(row.timestamp)
    const message = asRecord(row.message)
    if (row.type === 'assistant') {
      const model = firstString(message?.model, row.model)
      const effort = firstString(message?.effort, asRecord(message?.output_config)?.effort, row.effort)
      if (model) result.model = model
      if (effort) result.effort = effort
      result.context = contextUsage(message?.usage ?? row.usage) ?? result.context
      if (Array.isArray(message?.content)) {
        for (const blockValue of message.content) {
          const block = asRecord(blockValue)
          if (block?.type === 'tool_use') addCall(result.events, block.id, block.name, block.input, at)
        }
      }
    } else if (row.type === 'user') {
      let hasToolResult = false
      if (Array.isArray(message?.content)) {
        for (const blockValue of message.content) {
          const block = asRecord(blockValue)
          if (block?.type === 'tool_result') {
            hasToolResult = true
            addResult(result.events, block.tool_use_id ?? block.toolUseId, at)
          }
        }
      }
      if (!hasToolResult) addUser(result.events, message?.content ?? row.content, at)
    }
  }
  return result
}

function readCodexRows(rows: RecordValue[]): TranscriptSnapshot {
  const result = { ...EMPTY, events: [] as TranscriptEvent[] }
  for (const row of rows) {
    const payload = asRecord(row.payload)
    const at = timestamp(row.timestamp ?? payload?.timestamp)
    if (row.type === 'turn_context') {
      const model = firstString(payload?.model, payload?.model_id, row.model)
      const effort = firstString(payload?.reasoning_effort, payload?.effort, row.reasoning_effort)
      if (model) result.model = model
      if (effort) result.effort = effort
      result.context = contextUsage(payload?.usage ?? row.usage) ?? result.context
    } else if (row.type === 'response_item' && payload) {
      if (payload.type === 'function_call') {
        addCall(result.events, payload.call_id, payload.name, payload.arguments ?? payload.input, at)
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        addResult(result.events, payload.call_id, at)
      } else if (payload.type === 'message' && payload.role === 'user') {
        addUser(result.events, payload.content, at)
      }
    } else if (row.type === 'event_msg' && payload) {
      if (payload.type === 'user_message') addUser(result.events, payload.message, at)
      else if (payload.type === 'turn_context') {
        const model = firstString(payload.model, payload.model_id)
        const effort = firstString(payload.reasoning_effort, payload.effort)
        if (model) result.model = model
        if (effort) result.effort = effort
      }
    }
  }
  return result
}

function readGrokRows(rows: RecordValue[]): TranscriptSnapshot {
  const result = { ...EMPTY, events: [] as TranscriptEvent[] }
  for (const row of rows) {
    const at = timestamp(row.timestamp)
    if (row.type === 'assistant') {
      const model = firstString(row.model, row.model_name)
      const effort = firstString(row.reasoning_effort, row.effort)
      if (model) result.model = model
      if (effort) result.effort = effort
      result.context = contextUsage(row.usage ?? row.context) ?? result.context
      if (Array.isArray(row.tool_calls)) {
        for (const value of row.tool_calls) {
          const call = asRecord(value)
          if (call) addCall(result.events, call.id ?? call.call_id, call.name ?? call.tool, call.arguments ?? call.input, at)
        }
      }
    } else if (row.type === 'user') {
      if (!isGrokBootstrapContext(row)) addUser(result.events, row.content, at)
    } else if (row.type === 'backend_tool_call' || row.type === 'tool_call') {
      const kind = asRecord(row.kind)
      addCall(result.events, row.call_id ?? row.tool_call_id ?? row.id, kind?.tool_type ?? row.name ?? row.tool, kind ?? row.arguments ?? row.input, at)
    } else if (row.type === 'tool_result') {
      addResult(result.events, row.tool_call_id ?? row.call_id ?? row.id, at)
    }
  }
  return result
}

const GROK_BOOTSTRAP_SECTIONS = ['git_status', 'rules']

function isGrokBootstrapContext(row: RecordValue): boolean {
  if (typeof row.synthetic_reason === 'string' && row.synthetic_reason.trim() !== '') return true
  const content = row.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && content.length === 1 && asRecord(content[0])?.type === 'text'
      ? stringValue(asRecord(content[0])?.text)
      : null
  if (!text) return false
  const normalized = text.trim().toLowerCase()
  if (!normalized.startsWith('<user_info>')) return false
  const userInfoEnd = normalized.indexOf('</user_info>')
  if (userInfoEnd < 0) return false
  let remainder = normalized.slice(userInfoEnd + '</user_info>'.length).trim()
  while (remainder.length > 0) {
    const section = GROK_BOOTSTRAP_SECTIONS.find((name) => remainder.startsWith(`<${name}>`))
    const sectionEnd = section ? remainder.indexOf(`</${section}>`) : -1
    if (!section || sectionEnd < 0) return false
    remainder = remainder.slice(sectionEnd + `</${section}>`.length).trim()
  }
  return true
}

function readOmpRows(rows: RecordValue[]): TranscriptSnapshot {
  const result = { ...EMPTY, events: [] as TranscriptEvent[] }
  for (const row of rows) {
    if (row.type !== 'message') continue
    const message = asRecord(row.message)
    if (!message) continue
    const at = timestamp(row.timestamp)
    const role = stringValue(message.role)
    if (role === 'user') addUser(result.events, message.content, at)
    else if (role === 'toolResult') addResult(result.events, message.toolCallId ?? message.tool_call_id ?? message.id ?? row.toolCallId, at)
    else if (role === 'assistant' && Array.isArray(message.content)) {
      const model = firstString(message.model, row.model)
      const effort = firstString(message.effort, message.reasoning_effort, row.effort)
      if (model) result.model = model
      if (effort) result.effort = effort
      result.context = contextUsage(message.usage ?? row.usage) ?? result.context
      for (const value of message.content) {
        const block = asRecord(value)
        if (block?.type === 'toolCall') {
          addCall(result.events, block.id ?? block.toolCallId, block.name, block.arguments ?? block.input, at)
        }
      }
    }
  }
  return result
}

function isQuestionTool(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'askuserquestion' || normalized === 'requestuserinput' || normalized === 'question'
}

function processOpenCodePart(events: TranscriptEvent[], raw: unknown, at: number | null): void {
  const part = asRecord(parseJson(raw))
  if (!part || part.type !== 'tool') return
  const state = asRecord(part.state)
  if (!state) return
  const callId = firstString(part.callID, part.callId, part.call_id, part.id)
  const status = firstString(state.status)?.toLowerCase()
  const name = firstString(part.tool, part.name)
  const outputExists = state.output !== undefined && state.output !== null
  const errorExists = state.error !== undefined && state.error !== null
  if (status === 'completed' || status === 'complete' || status === 'error' || status === 'failed' || outputExists || errorExists) {
    if (callId) addResult(events, callId, at)
    return
  }
  const input = parseJson(state.input)
  if (name && isQuestionTool(name) && input !== null && input !== undefined &&
    (status === 'input' || status === 'running' || status === 'pending' || status === undefined)) {
    addCall(events, callId, name, input, at)
  }
}

function updateOpenCodeMeta(result: TranscriptSnapshot, record: RecordValue, at: number | null): void {
  const model = firstString(record.modelID, record.modelId, record.model, asRecord(record.model)?.id)
  const effort = firstString(record.reasoningEffort, record.reasoning_effort, record.effort)
  if (model) result.model = model
  if (effort) result.effort = effort
  const usage = asRecord(record.tokens) ?? asRecord(record.usage)
  if (usage) {
    const input = numberValue(usage.input ?? usage.inputTokens)
    const output = numberValue(usage.output ?? usage.outputTokens)
    const limit = numberValue(usage.limit ?? usage.contextWindow ?? usage.contextWindowTokens)
    if (input !== null && limit !== null && limit > 0) result.context = { used: Math.min(input + (output ?? 0), limit), limit }
  }
  void at
}

function parseOpenCodeMessageData(
  result: TranscriptSnapshot,
  row: RecordValue,
  hidden: boolean
): void {
  if (hidden) return
  const data = asRecord(parseJson(row.data))
  if (!data) return
  const at = timestamp(row.time_created ?? row.time_updated)
  const rowType = firstString(row.type, data.role)
  updateOpenCodeMeta(result, data, at)
  if (rowType === 'user' || data.role === 'user') addUser(result.events, data.content ?? data.text, at)
  const content = Array.isArray(data.content) ? data.content : []
  for (const value of content) {
    const part = asRecord(value)
    if (part?.type === 'tool') processOpenCodePart(result.events, part, at)
    else if (part?.type === 'text' && (rowType === 'user' || data.role === 'user')) addUser(result.events, part.text, at)
  }
}

function readOpenCodeDatabase(path: string, sessionId: string, agent: string, modifiedAt: number): TranscriptSnapshot {
  const db = new Database(path, { readonly: true, create: false })
  const result = { ...EMPTY, events: [] as TranscriptEvent[], source: path, modifiedAt }
  try {
    if (tableExists(db, 'session_v2') && tableExists(db, 'session_message')) {
      const rows = db.prepare(`SELECT id, session_id, type, seq, CASE WHEN length(CAST(data AS BLOB)) <= ${MAX_DB_ROW_BYTES} THEN data ELSE NULL END AS data, time_created, time_updated FROM session_message WHERE session_id = ? ORDER BY seq ASC LIMIT ?`).all(sessionId, MAX_DB_ROWS) as RecordValue[]
      for (const row of rows) {
        if (typeof row.data !== 'string') continue
        const parsed = asRecord(parseJson(row.data))
        if (!parsed) continue
        const type = firstString(row.type, parsed.type, parsed.role)
        if (type === 'tool' || parsed.type === 'tool') processOpenCodePart(result.events, parsed, timestamp(row.time_created ?? row.time_updated))
        else parseOpenCodeMessageData(result, { ...row, type }, false)
      }
      return result
    }
    if (!tableExists(db, 'session') || !tableExists(db, 'message') || !tableExists(db, 'part')) return result
    const messages = db.prepare(`SELECT id, session_id, time_created, time_updated, CASE WHEN length(CAST(data AS BLOB)) <= ${MAX_DB_ROW_BYTES} THEN data ELSE NULL END AS data FROM message WHERE session_id = ? ORDER BY rowid ASC LIMIT ?`).all(sessionId, MAX_DB_ROWS) as RecordValue[]
    const parts = db.prepare(`SELECT id, session_id, message_id, time_updated, CASE WHEN length(CAST(data AS BLOB)) <= ${MAX_DB_ROW_BYTES} THEN data ELSE NULL END AS data FROM part WHERE session_id = ? ORDER BY rowid ASC LIMIT ?`).all(sessionId, MAX_DB_ROWS) as RecordValue[]
    const partsByMessage = new Map<string, RecordValue[]>()
    for (const part of parts) {
      if (typeof part.message_id !== 'string' || typeof part.data !== 'string') continue
      const related = partsByMessage.get(part.message_id) ?? []
      related.push(part)
      partsByMessage.set(part.message_id, related)
    }
    for (const message of messages) {
      if (typeof message.data !== 'string') continue
      const body = asRecord(parseJson(message.data))
      if (agent === 'zcode' && asRecord(body?.semantics)?.transcriptVisibility === 'hidden') continue
      parseOpenCodeMessageData(result, message, false)
      if (typeof message.id !== 'string') continue
      for (const part of partsByMessage.get(message.id) ?? []) {
        processOpenCodePart(result.events, part.data, timestamp(part.time_updated))
      }
    }
    return result
  } finally {
    db.close()
  }
}

function decoder(agent: string, rows: RecordValue[]): TranscriptSnapshot {
  if (agent === 'claude' || agent === 'openclaude') return readClaudeRows(rows)
  if (agent === 'codex') return readCodexRows(rows)
  if (agent === 'grok') return readGrokRows(rows)
  return readOmpRows(rows)
}

async function hookTranscriptPath(session: Session, agent: string, providerId: string): Promise<string | null> {
  const path = session.providerSession?.transcriptPath?.trim()
  if (!path || !path.endsWith('.jsonl') || session.providerSession?.id !== providerId) return null
  if (agent === 'grok') return null
  return (await isRegularFile(path)) ? path : null
}

async function jsonlPath(session: Session, providerId: string): Promise<string | null> {
  const agent = session.agent
  const hook = await hookTranscriptPath(session, agent, providerId)
  if (hook) return hook
  if (agent === 'claude' || agent === 'openclaude') return claudeTranscript(providerId)
  if (agent === 'codex') return codexTranscript(providerId)
  if (agent === 'grok') return grokTranscript(session, providerId)
  if (agent === 'omp') return ompTranscript(providerId)
  return null
}

export async function readProviderTranscript(session: Session, providerId: string | null): Promise<TranscriptSnapshot> {
  if (!providerId || !ID_RE.test(providerId)) return EMPTY
  try {
    if (session.agent === 'opencode' || session.agent === 'opencode2' || session.agent === 'zcode') {
      const dbPath = await findOpenCodeDatabase(providerId, session.agent)
      if (!dbPath) return { ...EMPTY, notice: 'Provider transcript database is not available.' }
      const info = await lstat(dbPath)
      if (!info.isFile() || info.isSymbolicLink()) return { ...EMPTY, notice: 'Provider transcript database is not a regular file.' }
      return readOpenCodeDatabase(dbPath, providerId, session.agent, info.mtimeMs)
    }
    const path = await jsonlPath(session, providerId)
    if (!path) return EMPTY
    const data = await readBoundedJsonl(path)
    const result = decoder(session.agent, data.rows)
    return {
      ...result,
      source: path,
      modifiedAt: data.modifiedAt,
      notice: data.malformed ? 'Some provider transcript records could not be read.' : null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...EMPTY, notice: `Provider transcript is unavailable: ${message.slice(0, 180)}` }
  }
}

export function newestPendingQuestionCall(
  transcript: TranscriptSnapshot,
  questionParser: (name: string, input: unknown, callId: string | null, at: number | null) => DockQuestion | null
): DockQuestion | null {
  const pending: { id: string | null; question: DockQuestion }[] = []
  for (const event of transcript.events) {
    if (event.kind === 'user') {
      pending.length = 0
      continue
    }
    if (event.kind === 'call') {
      const question = questionParser(event.name, event.input, event.id, event.at)
      if (question) pending.push({ id: event.id, question })
      continue
    }
    if (event.kind === 'result') {
      if (event.id) {
        const index = pending.findIndex((entry) => entry.id === event.id)
        if (index >= 0) pending.splice(index, 1)
      }
    }
  }
  return pending.at(-1)?.question ?? null
}

export function transcriptPrompts(transcript: TranscriptSnapshot): string[] {
  return transcript.events.flatMap((event) => event.kind === 'user' ? [event.text] : []).slice(-200)
}

export function transcriptObserved(
  transcript: TranscriptSnapshot,
  text: string,
  since: number
): boolean {
  return transcript.events.some((event) => event.kind === 'user' && event.text === text && event.at !== null && event.at >= since)
}

export function isRecognizedQuestionTool(name: string): boolean {
  return isQuestionTool(name)
}
