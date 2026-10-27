import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { VaultRole, VaultSession } from '../../types'
import {
  boundedText,
  createSessionBuilder,
  isRecord,
  MAX_MESSAGE_CHARS,
  numberOrDate,
  readJsonObject,
  string,
  textFromContent,
  throwIfAborted,
  type ParserContext,
  type SessionBuilder
} from './shared'

type TableName = 'session' | 'message' | 'part' | 'session_v2' | 'session_message'
type ConversationRole = 'user' | 'assistant'

type OpenCodeMessage = {
  id: unknown
  role: ConversationRole | null
  timestamp: unknown
  text: string
  tools: string[]
}

const TOKEN_COLUMNS = ['tokens_input', 'tokens_output', 'tokens_reasoning'] as const
const TOOL_ARGUMENT_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'description'] as const
const TEXT_BLOCK_TYPES: Record<string, true | undefined> = {
  text: true,
  input_text: true,
  output_text: true,
  thinking: true,
  reasoning: true
}

function sqliteLocation(context: ParserContext): { dbPath: string; sessionId: string } | null {
  const metadata = context.candidate.metadata ?? {}
  const separator = context.candidate.filePath.lastIndexOf('#')
  const dbPath =
    string(metadata.dbPath) ??
    string(metadata.databasePath) ??
    (separator > 0 ? context.candidate.filePath.slice(0, separator) : null)
  const sessionId =
    string(context.candidate.sessionId) ??
    string(metadata.sessionId) ??
    (separator >= 0 ? context.candidate.filePath.slice(separator + 1) : null)
  return dbPath && sessionId ? { dbPath, sessionId } : null
}

function tableColumns(db: Database, table: TableName): Set<string> {
  const rows: unknown[] = db.query(`PRAGMA table_info("${table}")`).all()
  const columns = new Set<string>()
  for (const value of rows) {
    if (isRecord(value) && typeof value.name === 'string') columns.add(value.name)
  }
  return columns
}

function hasColumns(columns: Set<string>, required: readonly string[]): boolean {
  return required.every((column) => columns.has(column))
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function modelId(value: unknown, allowBareId: boolean): string | null {
  const raw = string(value)
  if (!raw) return null
  if (allowBareId && !raw.startsWith('{')) return raw
  const parsed = jsonRecord(raw)
  return string(parsed?.id) ?? string(parsed?.modelID)
}

function tokenTotal(row: Record<string, unknown>, columns: Set<string>): number | null {
  let total = 0
  let found = false
  for (const column of TOKEN_COLUMNS) {
    if (!columns.has(column)) continue
    found = true
    const value = Number(row[column])
    if (Number.isFinite(value)) total += value
  }
  return found ? total : null
}

function sessionBuilder(
  context: ParserContext,
  sessionId: string,
  row: Record<string, unknown>,
  columns: Set<string>,
  allowBareModelId: boolean
) {
  const builder = createSessionBuilder(context, {
    sessionId,
    title: string(row.title),
    cwd: string(row.directory),
    model: modelId(row.model, allowBareModelId),
    createdAt: numberOrDate(row.time_created),
    updatedAt: numberOrDate(row.time_updated)
  })
  builder.patch({ totalTokens: tokenTotal(row, columns) })
  return builder
}

function querySession(
  db: Database,
  table: 'session' | 'session_v2',
  sessionId: string
): Record<string, unknown> | null {
  const row: unknown = db.query(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(sessionId)
  return isRecord(row) && row.id === sessionId ? row : null
}

function appendText(current: string, value: unknown): string {
  const text = textFromContent(value)
  if (!text || current.length >= MAX_MESSAGE_CHARS) return current
  const separator = current ? '\n' : ''
  const available = MAX_MESSAGE_CHARS - current.length - separator.length
  if (available <= 0) return current
  let end = Math.min(text.length, available)
  if (end < text.length) {
    const last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end--
  }
  return current + separator + text.slice(0, end)
}

function toolCallText(nameValue: unknown, input: unknown): string | null {
  const name = string(nameValue)
  let argument: string | null = null
  if (isRecord(input)) {
    for (const key of TOOL_ARGUMENT_KEYS) {
      const value = string(input[key])
      if (value) {
        argument = value.slice(0, 2000)
        break
      }
    }
  } else {
    argument = string(input)?.slice(0, 2000) ?? null
  }
  if (!name && !argument) return null
  return name && argument ? `${name}: ${argument}` : name ?? argument
}

function openCodeToolText(part: Record<string, unknown>): string | null {
  const state = isRecord(part.state) ? part.state : null
  const call = toolCallText(part.tool, state?.input)
  const outcome = boundedText(string(state?.error) ?? string(state?.output) ?? '')
  return boundedText([call, outcome].filter((value): value is string => Boolean(value)).join('\n'))
}

function openCodeRole(value: unknown): ConversationRole | null {
  return value === 'user' || value === 'assistant' ? value : null
}

function sqliteOrder(
  agent: 'opencode' | 'zcode',
  table: 'message' | 'part',
  alias: 'm' | 'p',
  columns: Set<string>
): string {
  if (agent === 'zcode' && columns.has('sequence')) {
    const tieBreaker = table === 'message' ? 'rowid' : columns.has('id') ? 'id' : 'rowid'
    return `${alias}.sequence IS NULL ASC, ${alias}.sequence ASC, ${alias}.time_created ASC, ${alias}.${tieBreaker} ASC`
  }
  const tieBreaker = table === 'message' ? 'id' : 'rowid'
  return `${alias}.time_created ASC, ${alias}.${tieBreaker} ASC`
}

function zcodeMessageIsVisible(message: Record<string, unknown>): boolean {
  const semantics = isRecord(message.semantics) ? message.semantics : null
  return semantics?.transcriptVisibility !== 'hidden'
}

function flushOpenCodeMessage(
  builder: SessionBuilder,
  message: OpenCodeMessage | null
): void {
  if (!message?.role) return
  builder.message(message.role, message.text || null, message.timestamp)
  for (const text of message.tools) builder.message('tool', text, message.timestamp, false)
}

function parseOpenCodeSqlite(
  context: ParserContext,
  db: Database,
  sessionId: string,
  agent: 'opencode' | 'zcode'
): VaultSession | null {
  const sessionColumns = tableColumns(db, 'session')
  const messageColumns = tableColumns(db, 'message')
  const partColumns = tableColumns(db, 'part')
  if (
    !hasColumns(sessionColumns, ['id', 'time_created', 'time_updated']) ||
    !hasColumns(messageColumns, ['id', 'session_id', 'data', 'time_created']) ||
    !hasColumns(partColumns, ['message_id', 'data', 'time_created'])
  ) {
    return null
  }
  const row = querySession(db, 'session', sessionId)
  if (!row) return null
  const builder = sessionBuilder(context, sessionId, row, sessionColumns, false)
  const sql = `SELECT m.id AS message_id,
                      m.data AS message_data,
                      m.time_created AS message_time,
                      p.data AS part_data
               FROM message AS m
               LEFT JOIN part AS p ON p.message_id = m.id
               WHERE m.session_id = ?
               ORDER BY ${sqliteOrder(agent, 'message', 'm', messageColumns)},
                        ${sqliteOrder(agent, 'part', 'p', partColumns)}`
  const rows = db.query(sql).iterate(sessionId)
  let current: OpenCodeMessage | null = null

  for (const value of rows) {
    throwIfAborted(context.signal)
    if (!isRecord(value)) continue
    if (current === null || current.id !== value.message_id) {
      flushOpenCodeMessage(builder, current)
      const messageData = jsonRecord(value.message_data)
      const visible = agent !== 'zcode' || (messageData !== null && zcodeMessageIsVisible(messageData))
      current = {
        id: value.message_id,
        role: visible ? openCodeRole(messageData?.role) : null,
        timestamp: value.message_time,
        text: '',
        tools: []
      }
    }
    if (!current.role || typeof value.part_data !== 'string') continue
    const part = jsonRecord(value.part_data)
    if (!part) continue
    const type = string(part.type)
    if (type === 'text' || type === 'reasoning') {
      current.text = appendText(current.text, part.text)
    } else if (type === 'tool') {
      const text = openCodeToolText(part)
      if (text) current.tools.push(text)
    }
  }
  flushOpenCodeMessage(builder, current)
  throwIfAborted(context.signal)
  return builder.finish()
}

function v2Role(value: unknown): VaultRole | null {
  return value === 'user' || value === 'assistant' || value === 'tool' ? value : null
}

function opencode2ToolResult(value: unknown): string | null {
  if (typeof value === 'string') return boundedText(value)
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      const text = typeof item === 'string' ? item : isRecord(item) ? string(item.text) : null
      if (text) parts.push(text)
    }
    return boundedText(parts.join('\n'))
  }
  return null
}

function decodeOpenCode2Row(
  builder: SessionBuilder,
  role: VaultRole,
  data: Record<string, unknown>,
  timestamp: unknown
): void {
  const tools: string[] = []
  let text = ''
  const content = Array.isArray(data.content) ? data.content : data.text
  const blocks = Array.isArray(content) ? content : content === null || content === undefined ? [] : [content]
  for (const block of blocks) {
    if (typeof block === 'string') {
      text = appendText(text, block)
      continue
    }
    if (!isRecord(block)) continue
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : null
    if (type === 'tool') {
      const state = isRecord(block.state) ? block.state : null
      const call = toolCallText(block.name, state?.input)
      const result = opencode2ToolResult(state?.content)
      if (call) tools.push(call)
      if (result) tools.push(result)
      continue
    }
    if (type === 'tool_use') {
      const call = toolCallText(block.name, block.input)
      if (call) tools.push(call)
      continue
    }
    if (type === 'tool_result') {
      const result = opencode2ToolResult(block.content)
      if (result) tools.push(result)
      continue
    }
    if (type !== null && !TEXT_BLOCK_TYPES[type]) continue
    const value = typeof block.text === 'string' ? block.text : block.content
    if (typeof value === 'string') text = appendText(text, value)
  }
  if (role === 'user' || role === 'assistant') builder.message(role, text || null, timestamp)
  else if (role === 'tool' && text) builder.message('tool', text, timestamp, false)
  for (const tool of tools) builder.message('tool', tool, timestamp, false)
}

function parseOpenCode2Sqlite(
  context: ParserContext,
  db: Database,
  sessionId: string
): VaultSession | null {
  const sessionColumns = tableColumns(db, 'session_v2')
  const messageColumns = tableColumns(db, 'session_message')
  if (
    !hasColumns(sessionColumns, ['id', 'time_created', 'time_updated']) ||
    !hasColumns(messageColumns, ['session_id', 'type', 'data', 'time_created', 'seq'])
  ) {
    return null
  }
  const row = querySession(db, 'session_v2', sessionId)
  if (!row) return null
  const builder = sessionBuilder(context, sessionId, row, sessionColumns, true)
  const rows = db
    .query(`SELECT type, data, time_created FROM session_message
            WHERE session_id = ? AND type IN ('user', 'assistant', 'tool')
            ORDER BY time_created ASC, seq ASC`)
    .iterate(sessionId)
  for (const value of rows) {
    throwIfAborted(context.signal)
    if (!isRecord(value)) continue
    const role = v2Role(value.type)
    if (!role) continue
    const data = jsonRecord(value.data)
    if (!data) {
      if (role === 'user' || role === 'assistant') builder.message(role, null, value.time_created)
      continue
    }
    decodeOpenCode2Row(builder, role, data, value.time_created)
  }
  throwIfAborted(context.signal)
  return builder.finish()
}
type LegacyMessageFile = { name: string; createdAt: number }

const LEGACY_TOKEN_FIELDS = [
  'input',
  'inputTokens',
  'input_tokens',
  'output',
  'outputTokens',
  'output_tokens',
  'cacheRead',
  'cacheReadTokens',
  'cache_read_input_tokens',
  'cacheWrite',
  'cacheWriteTokens',
  'cache_creation_input_tokens',
  'cached',
  'cachedInputTokens',
  'cached_input_tokens',
  'reasoning',
  'reasoningOutputTokens',
  'reasoning_output_tokens'
] as const

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function legacySessionId(filePath: string): string {
  const fileName = basename(filePath, extname(filePath))
  const match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return match?.[0] ?? fileName
}

async function readLegacyMessage(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonObject(filePath)
  } catch (error) {
    if (isMissingPath(error)) return null
    throw error
  }
}

async function legacyMessageFiles(messageDir: string, signal?: AbortSignal): Promise<LegacyMessageFile[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(messageDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPath(error)) return []
    throw error
  }
  const files: LegacyMessageFile[] = []
  for (const entry of entries) {
    throwIfAborted(signal)
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const message = await readLegacyMessage(join(messageDir, entry.name))
    if (!message) continue
    const time = isRecord(message.time) ? message.time.created : null
    files.push({ name: entry.name, createdAt: numberOrDate(time) ?? Number.POSITIVE_INFINITY })
  }
  return files.sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name))
}

function legacyUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function legacyTokenTotal(value: unknown): number {
  if (!isRecord(value)) return 0
  const explicit =
    legacyUsageNumber(value.total) ||
    legacyUsageNumber(value.totalTokens) ||
    legacyUsageNumber(value.total_tokens)
  if (explicit > 0) return explicit
  let total = 0
  for (const key of LEGACY_TOKEN_FIELDS) total += legacyUsageNumber(value[key])
  return total
}

async function parseLegacyOpenCode(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  if (extname(filePath) !== '.json') return null
  const sessionRoot = dirname(dirname(filePath))
  if (basename(sessionRoot) !== 'session') return null
  const metadata = await readJsonObject(filePath)
  if (!metadata) return null
  const sessionId = string(metadata.id) ?? legacySessionId(filePath)
  if (!sessionId) return null
  const time = isRecord(metadata.time) ? metadata.time : {}
  const builder = createSessionBuilder(context, {
    sessionId,
    title: string(metadata.title),
    cwd: string(metadata.directory),
    createdAt: numberOrDate(time.created),
    updatedAt: numberOrDate(time.updated)
  })
  const messageDir = join(dirname(sessionRoot), 'message', sessionId)
  for (const file of await legacyMessageFiles(messageDir, context.signal)) {
    throwIfAborted(context.signal)
    const message = await readLegacyMessage(join(messageDir, file.name))
    if (!message) continue
    const role = string(message.role)
    if (role !== 'user' && role !== 'assistant') continue
    const messageTime = isRecord(message.time) ? message.time.created : null
    const timestamp = numberOrDate(messageTime)
    if (role === 'user' && !builder.fields.title) {
      const summary = isRecord(message.summary) ? message.summary : null
      const title = string(summary?.title) ?? string(summary?.body)
      if (title) builder.patch({ title })
    }
    const model = (isRecord(message.model) ? string(message.model.modelID) : null) ?? string(message.modelID)
    builder.patch({ model: model ?? undefined, totalTokens: legacyTokenTotal(message.tokens) })
    builder.message(role, textFromContent(message.content), timestamp)
  }
  throwIfAborted(context.signal)
  return builder.finish()
}



export async function parseSqlite(context: ParserContext): Promise<VaultSession | null> {
  throwIfAborted(context.signal)
  const agent = context.candidate.agent
  if (agent !== 'opencode' && agent !== 'opencode2' && agent !== 'zcode') return null
  if (agent === 'opencode' && !context.candidate.filePath.includes('#')) {
    return parseLegacyOpenCode(context)
  }
  const location = sqliteLocation(context)
  if (!location) return null
  const db = new Database(location.dbPath, { readonly: true, create: false })
  try {
    db.exec('PRAGMA query_only = ON')
    throwIfAborted(context.signal)
    if (agent === 'opencode2') return parseOpenCode2Sqlite(context, db, location.sessionId)
    return parseOpenCodeSqlite(context, db, location.sessionId, agent)
  } finally {
    db.close()
  }
}
