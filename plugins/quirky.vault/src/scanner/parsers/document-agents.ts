import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Database } from 'bun:sqlite'
import type { VaultRole, VaultSession } from '../../types'
import {
  MAX_JSONL_RECORD_BYTES,
  MAX_MESSAGE_CHARS,
  boundedText,
  createSessionBuilder,
  isRecord,
  normalizeTitle,
  numberOrDate,
  readJsonObject,
  readJsonl,
  stableSessionId,
  string,
  textFromContent,
  throwIfAborted,
  type ParserContext,
  type SessionBuilder
} from './shared'

const ANTIGRAVITY_INDEX_MAX_BYTES = 4 * 1024 * 1024
const ANTIGRAVITY_MAX_HISTORY_ENTRIES = 10_000
const DOCUMENT_RECORD_TOO_LARGE = Symbol('document-record-too-large')
type DocumentRecordBudget = { bytes: number; exceeded: boolean; previousHighSurrogate: boolean }

/** Dispatch source-format parsers while keeping every transcript fold incremental. */
export async function parseDocumentAgent(context: ParserContext): Promise<VaultSession | null> {
  switch (context.candidate.agent) {
    case 'antigravity':
      return parseAntigravity(context)
    case 'grok':
      return parseGrok(context)
    case 'hermes':
      return parseHermes(context)
    case 'droid':
      return parseDroid(context)
    case 'cline':
      return parseCline(context)
    case 'devin':
      return parseDevin(context)
    case 'kimi':
      return parseKimi(context)
    case 'muse':
      return parseMuse(context)
    case 'jcode':
      return parseJcode(context)
    case 'kiro':
      return parseKiro(context)
    default:
      return null
  }
}

function sourceFileId(filePath: string): string {
  const name = basename(filePath, extname(filePath))
  return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? name
}

function sourceTitle(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : textFromContent(value)
  const bounded = boundedText(raw)
  const normalized = normalizeTitle(stripHiddenText(bounded ?? '') ?? '')
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  if (lower.startsWith('<instructions>') || /^# agents\.md instructions(?:\W|$)/i.test(normalized)) return null
  if (normalized.length <= 96) return normalized
  let end = 93
  if (normalized.charCodeAt(end - 1) >= 0xd800 && normalized.charCodeAt(end - 1) <= 0xdbff) end--
  return `${normalized.slice(0, end)}...`
}

function stripHiddenText(value: string): string | null {
  let text = value
  for (const tag of ['system-reminder', 'codex_internal_context', 'goal_context']) {
    const opener = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i')
    const closer = new RegExp(`</${tag}\\s*>`, 'i')
    for (;;) {
      const open = opener.exec(text)
      if (!open || open.index === undefined) break
      const close = closer.exec(text.slice(open.index + open[0].length))
      text = close
        ? `${text.slice(0, open.index)} ${text.slice(open.index + open[0].length + close.index + close[0].length)}`
        : text.slice(0, open.index)
    }
  }
  return text
}

function noteTimestamp(builder: SessionBuilder, value: unknown): void {
  const timestamp = numberOrDate(value)
  if (timestamp === null) return
  const createdAt = builder.fields.createdAt
  const updatedAt = builder.fields.updatedAt
  builder.patch({
    createdAt: createdAt === null ? timestamp : Math.min(createdAt, timestamp),
    updatedAt: updatedAt === null ? timestamp : Math.max(updatedAt, timestamp)
  })
}

function metadataPath(context: ParserContext, key: string, fallback: string): string {
  return string(context.candidate.metadata?.[key]) ?? fallback
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> | null {
  let current: unknown = value
  for (const key of keys) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return isRecord(current) ? current : null
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR'))
}

async function readOptionalObject(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    throwIfAborted(signal)
    const record = await readJsonObject(filePath, maxBytes)
    throwIfAborted(signal)
    return record
  } catch (error) {
    throwIfAborted(signal)
    if (isMissingPathError(error)) return null
    return null
  }
}

async function foldOptionalJsonl(
  filePath: string,
  signal: AbortSignal | undefined,
  consume: (record: Record<string, unknown>) => void,
  tolerateReadFailure = false
): Promise<void> {
  try {
    for await (const record of readJsonl(filePath, signal)) consume(record)
  } catch (error) {
    throwIfAborted(signal)
    if (!tolerateReadFailure && !isMissingPathError(error)) throw error
  }
}

function finish(builder: SessionBuilder, titleFallback?: unknown): VaultSession {
  if (builder.fields.title === null) {
    const title = builder.firstPromptTitle ?? sourceTitle(titleFallback)
    builder.patch({ title: title ?? `${builder.context.candidate.agent} ${builder.fields.sessionId.slice(0, 8)}` })
  }
  return builder.finish()
}

function antigravitySessionId(filePath: string): string | null {
  const parts = filePath.split(/[\\/]+/).filter(Boolean)
  const last = parts.at(-1)
  if ((last !== 'transcript.jsonl' && last !== 'transcript_full.jsonl') ||
      parts.at(-2) !== 'logs' || parts.at(-3) !== '.system_generated') return null
  return parts.at(-4) ?? null
}

function antigravityRequest(content: unknown): string | null {
  const text = string(content)
  if (!text) return null
  const opener = '<USER_REQUEST>'
  const start = text.indexOf(opener)
  if (start < 0) return text
  const bodyStart = start + opener.length
  const end = text.indexOf('</USER_REQUEST>', bodyStart)
  return string(end < 0 ? text.slice(bodyStart) : text.slice(bodyStart, end))
}

type AntigravityHistoryIndex = {
  byId: Map<string, string | null>
  byPrompt: Map<string, { timestamp: number; workspace: string }[]>
}

function addUniqueWorkspace(map: Map<string, string | null>, id: string, path: string | null): void {
  if (!id || id.length > 512 || (path !== null && (!path || path.length > 4096))) return
  if (map.has(id) && map.get(id) !== path) map.set(id, null)
  else if (!map.has(id)) map.set(id, path)
}

function antigravityPromptHash(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  const prompt = sourceTitle(value)
  if (!prompt || prompt.endsWith('...')) return null
  return createHash('sha256').update(prompt).digest('hex')
}

async function readAntigravityHistoryIndex(
  historyPath: string,
  signal?: AbortSignal
): Promise<AntigravityHistoryIndex> {
  const index: AntigravityHistoryIndex = { byId: new Map(), byPrompt: new Map() }
  let fileSize: number
  try {
    throwIfAborted(signal)
    fileSize = (await stat(historyPath)).size
  } catch {
    throwIfAborted(signal)
    return index
  }
  if (fileSize > ANTIGRAVITY_INDEX_MAX_BYTES) return index
  let readCount = 0
  await foldOptionalJsonl(historyPath, signal, (record) => {
    if (++readCount > ANTIGRAVITY_MAX_HISTORY_ENTRIES) return
    const workspace = string(record.workspace)
    const timestamp = numberOrDate(record.timestamp)
    const id = string(record.conversationId)
    if (!workspace || workspace.length > 4096 || timestamp === null) return
    if (id) addUniqueWorkspace(index.byId, id, workspace)
    const hash = antigravityPromptHash(record.display)
    if (hash) {
      const entries = index.byPrompt.get(hash) ?? []
      entries.push({ timestamp, workspace })
      index.byPrompt.set(hash, entries)
    }
  }, true)
  return index
}

async function antigravityCacheWorkspaces(historyPath: string, signal?: AbortSignal): Promise<Map<string, string | null>> {
  const cache = join(dirname(historyPath), 'cache')
  const [metadata, projects, lastConversations] = await Promise.all([
    readOptionalObject(join(cache, 'conversation_metadata.json'), ANTIGRAVITY_INDEX_MAX_BYTES, signal),
    readOptionalObject(join(cache, 'projects.json'), ANTIGRAVITY_INDEX_MAX_BYTES, signal),
    readOptionalObject(join(cache, 'last_conversations.json'), ANTIGRAVITY_INDEX_MAX_BYTES, signal)
  ])
  const projectPaths = new Map<string, string | null>()
  if (projects) {
    for (const [key, value] of Object.entries(projects).slice(0, ANTIGRAVITY_MAX_HISTORY_ENTRIES)) {
      if (typeof value !== 'string') continue
      if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(key)) addUniqueWorkspace(projectPaths, value, key)
      else if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(value)) addUniqueWorkspace(projectPaths, key, value)
    }
  }
  const byId = new Map<string, string | null>()
  if (lastConversations) {
    for (const [path, id] of Object.entries(lastConversations).slice(0, ANTIGRAVITY_MAX_HISTORY_ENTRIES)) {
      if (typeof id === 'string' && /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path)) addUniqueWorkspace(byId, id, path)
    }
  }
  const conversations = isRecord(metadata?.conversations) ? metadata.conversations : null
  if (conversations) {
    for (const [id, value] of Object.entries(conversations).slice(0, ANTIGRAVITY_MAX_HISTORY_ENTRIES)) {
      const projectId = nestedRecord(value, 'summary')?.ProjectID
      if (typeof projectId !== 'string' || !projectPaths.has(projectId)) continue
      addUniqueWorkspace(byId, id, projectPaths.get(projectId) ?? null)
    }
  }
  return byId
}

async function antigravityWorkspace(
  context: ParserContext,
  sessionId: string,
  opening: { hash: string; timestamp: number } | null
): Promise<string | null> {
  const fallback = context.candidate.root
    ? join(dirname(context.candidate.root), 'history.jsonl')
    : join(context.sourceHome, '.gemini', 'antigravity-cli', 'history.jsonl')
  const historyPath = metadataPath(context, 'antigravityHistoryPath', fallback)
  const index = await readAntigravityHistoryIndex(historyPath, context.signal)
  const cache = await antigravityCacheWorkspaces(historyPath, context.signal)
  for (const [id, path] of cache) addUniqueWorkspace(index.byId, id, path)
  if (index.byId.has(sessionId)) return index.byId.get(sessionId) ?? null
  if (!opening) return null
  const matches = (index.byPrompt.get(opening.hash) ?? []).filter((entry) =>
    Math.abs(entry.timestamp - opening.timestamp) <= 2_000
  )
  return matches.length === 1 ? matches[0]?.workspace ?? null : null
}

async function parseAntigravity(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const sessionId = antigravitySessionId(filePath) ?? sourceFileId(filePath)
  const builder = createSessionBuilder(context, { sessionId, totalTokens: 0 })
  let opening: { hash: string; timestamp: number } | null = null
  for await (const record of readJsonl(filePath, context.signal)) {
    noteTimestamp(builder, record.created_at)
    const source = string(record.source)
    const type = string(record.type)
    const content = string(record.content)
    if ((source === 'USER_EXPLICIT' || source === 'USER') && (type === 'USER_INPUT' || type === 'REQUEST')) {
      const request = antigravityRequest(content)
      if (!request) continue
      const timestamp = numberOrDate(record.created_at)
      if (opening === null) {
        const hash = antigravityPromptHash(request)
        opening = hash && timestamp !== null ? { hash, timestamp } : null
        // A non-hashable opening request still closes the fallback window.
        if (!hash || timestamp === null) opening = { hash: '', timestamp: 0 }
      }
      if (builder.fields.title === null) builder.patch({ title: sourceTitle(request) })
      builder.message('user', request, record.created_at)
    } else if (source === 'MODEL' && type === 'PLANNER_RESPONSE' && content) {
      builder.message('assistant', content, record.created_at)
    }
  }
  if (!builder.fields.cwd) {
    const prompt = opening?.hash ? opening : null
    const cwd = await antigravityWorkspace(context, builder.fields.sessionId, prompt)
    if (cwd) builder.patch({ cwd })
  }
  return finish(builder)
}

function grokString(value: string): string {
  const lower = value.toLowerCase()
  const start = lower.indexOf('<user_query>')
  if (start < 0) return value
  const bodyStart = start + '<user_query>'.length
  const end = lower.indexOf('</user_query>', bodyStart)
  return (end < 0 ? value.slice(bodyStart) : value.slice(bodyStart, end)).trim()
}

function flattenGrokUserContent(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') parts.push(item)
    else if (isRecord(item) && (typeof item.type !== 'string' || item.type === 'text') && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.length ? parts.join('\n') : null
}

function isGrokBootstrapText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized.startsWith('<user_info>')) return false
  const close = normalized.indexOf('</user_info>')
  if (close < 0) return !normalized.includes('<user_query>')
  const rest = normalized.slice(close + '</user_info>'.length).trim()
  return !rest || (rest.startsWith('<git_status>') && rest.endsWith('</git_status>'))
}

function grokUserRequest(value: unknown): string | null {
  const raw = flattenGrokUserContent(value)
  if (!raw || isGrokBootstrapText(raw)) return null
  const unwrapped = grokString(raw).trim()
  if (!unwrapped || isGrokBootstrapText(unwrapped)) return null
  const lower = unwrapped.toLowerCase()
  if ((lower.startsWith('<user_info>') || lower.startsWith('<user_info ')) && !lower.includes('<user_query>')) return null
  return unwrapped
}

function grokAssistantText(value: unknown): string | null {
  if (typeof value === 'string') return boundedText(grokString(value))
  return textFromContent(value)
}

async function parseGrok(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const summary = await readJsonObject(filePath)
  if (!summary) return null
  const info = isRecord(summary.info) ? summary.info : null
  const sessionId = string(info?.id) ?? basename(dirname(filePath))
  const builder = createSessionBuilder(context, {
    sessionId: stableSessionId(context.candidate, sessionId),
    title: sourceTitle(summary.generated_title) ?? sourceTitle(summary.session_summary),
    cwd: string(info?.cwd),
    branch: string(summary.head_branch),
    model: string(summary.current_model_id),
    totalTokens: 0
  })
  noteTimestamp(builder, string(summary.created_at))
  noteTimestamp(builder, string(summary.updated_at))
  noteTimestamp(builder, string(summary.last_active_at))
  const historyPath = metadataPath(context, 'grokHistoryPath', join(dirname(filePath), 'chat_history.jsonl'))
  await foldOptionalJsonl(historyPath, context.signal, (record) => {
    const role = string(record.type)
    if (role === 'user') {
      const request = grokUserRequest(record.content)
      if (request) {
        if (builder.fields.title === null) builder.patch({ title: sourceTitle(request) })
        builder.message('user', request, undefined, false)
      }
    } else if (role === 'assistant') {
      builder.message('assistant', grokAssistantText(record.content), undefined, false)
    }
  }, true)
  builder.messageCount = numeric(summary.num_chat_messages) || numeric(summary.num_messages)
  return finish(builder)
}


async function parseHermes(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const builder = createSessionBuilder(context, { sessionId: sourceFileId(filePath), totalTokens: 0 })
  let record: Record<string, unknown> | null
  try {
    record = await foldJsonDocument({
      filePath,
      arrayKey: 'messages',
      fields: ['session_id', 'model', 'cwd', 'session_start', 'last_updated', 'message_count'],
      signal: context.signal,
      consume: (value) => {
        if (!isRecord(value)) return
        const role = string(value.role)
        if (role !== 'user' && role !== 'assistant') return
        const text = textFromContent(value.content)
        if (role === 'user' && builder.fields.title === null) builder.patch({ title: sourceTitle(value.content) })
        builder.message(role, text)
      }
    })
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!record) return null
  builder.fields.sessionId = string(record.session_id) ?? builder.fields.sessionId
  builder.patch({ model: string(record.model), cwd: string(record.cwd) })
  noteTimestamp(builder, string(record.session_start))
  noteTimestamp(builder, string(record.last_updated))
  if (builder.messageCount === 0) builder.messageCount = numeric(record.message_count)
  return finish(builder)
}

function droidMessageText(record: Record<string, unknown>): string | null {
  const message = isRecord(record.message) ? record.message : null
  return string(record.text) ?? textFromContent(message?.content)
}

function tokenTotal(value: unknown): number {
  if (!isRecord(value)) return 0
  const explicit = numeric(value.total) || numeric(value.totalTokens) || numeric(value.total_tokens)
  if (explicit > 0) return explicit
  return [
    value.input, value.inputTokens, value.input_tokens, value.output, value.outputTokens,
    value.output_tokens, value.cacheRead, value.cacheReadTokens, value.cache_read_input_tokens,
    value.cacheWrite, value.cacheWriteTokens, value.cache_creation_input_tokens,
    value.cached, value.cachedInputTokens, value.cached_input_tokens, value.reasoning,
    value.reasoningOutputTokens, value.reasoning_output_tokens
  ].reduce<number>((total, item) => total + numeric(item), 0)
}

async function parseDroid(context: ParserContext): Promise<VaultSession | null> {
  const builder = createSessionBuilder(context, { sessionId: sourceFileId(context.candidate.filePath), totalTokens: 0 })
  for await (const record of readJsonl(context.candidate.filePath, context.signal)) {
    noteTimestamp(builder, record.timestamp)
    if (record.type === 'session_start') {
      builder.patch({
        sessionId: string(record.id) ?? builder.fields.sessionId,
        title: sourceTitle(record.title),
        cwd: string(record.cwd) ?? builder.fields.cwd
      })
      continue
    }
    if (record.type === 'system') {
      builder.patch({ cwd: string(record.cwd), model: string(record.model) })
    }
    builder.patch({ sessionId: string(record.session_id) ?? string(record.sessionId) ?? builder.fields.sessionId })
    if (record.type === 'message') {
      const message = isRecord(record.message) ? record.message : null
      const role = string(record.role) ?? string(message?.role)
      if (role !== 'user' && role !== 'assistant') continue
      const text = droidMessageText(record)
      if (role === 'user' && builder.fields.title === null) builder.patch({ title: sourceTitle(text) })
      builder.message(role, text, record.timestamp)
    } else if (record.type === 'completion') {
      builder.patch({ totalTokens: tokenTotal(record.usage) })
      builder.message('assistant', string(record.finalText), record.timestamp)
    }
  }
  return finish(builder)
}

async function parseCline(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const metadata = await readJsonObject(filePath)
  if (!metadata) return null
  const pathParts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const sessionId = string(metadata.session_id) ?? pathParts.at(-2) ?? sourceFileId(filePath)
  const builder = createSessionBuilder(context, {
    sessionId: stableSessionId(context.candidate, sessionId),
    cwd: string(metadata.cwd) ?? string(metadata.workspace_root),
    model: string(metadata.model),
    totalTokens: 0
  })
  noteTimestamp(builder, metadata.started_at)
  const messagesPath = metadataPath(context, 'clineMessagesPath', `${filePath.slice(0, -'.json'.length)}.messages.json`)
  try {
    const messages = await foldJsonDocument({
      filePath: messagesPath,
      arrayKey: 'messages',
      fields: ['updated_at'],
      signal: context.signal,
      consume: (value) => {
        if (!isRecord(value)) return
        const role = value.role
        if (role !== 'user' && role !== 'assistant') return
        noteTimestamp(builder, value.ts)
        if (role === 'user' && builder.fields.title === null) builder.patch({ title: sourceTitle(value.content) })
        if (role === 'assistant' && !builder.fields.model) {
          const modelInfo = isRecord(value.modelInfo) ? value.modelInfo : null
          builder.patch({ model: string(modelInfo?.id) })
        }
        builder.message(role, textFromContent(value.content), value.ts)
      }
    })
    if (messages) noteTimestamp(builder, messages.updated_at)
  } catch (error) {
    if (!isMissingPathError(error) && !(error instanceof SyntaxError)) throw error
  }
  return finish(builder, metadata.prompt)
}

function devinStepText(step: Record<string, unknown>): string | null {
  if (string(step.message)) return string(step.message)
  const message = isRecord(step.message) ? step.message : null
  if (message) return textFromContent(message.content) ?? string(message.content)
  return textFromContent(step.message) ?? string(step.text)
}

function firstDevinMetricValue(
  sources: readonly (Record<string, unknown> | null)[],
  keys: readonly string[]
): number {
  for (const source of sources) {
    if (!source) continue
    for (const key of keys) {
      const raw = source[key]
      const value = numeric(raw)
      if (value > 0 || (value === 0 && typeof raw === 'number' && Number.isFinite(raw))) return value
    }
  }
  return 0
}

function devinStepTokens(
  metadata: Record<string, unknown> | null,
  metrics: Record<string, unknown> | null,
  stepMetrics: Record<string, unknown> | null
): number {
  const sources = [metadata, metrics, stepMetrics]
  return firstDevinMetricValue(sources, ['total_input_tokens', 'input_tokens', 'prompt_tokens']) +
    firstDevinMetricValue(sources, ['output_tokens', 'completion_tokens']) +
    firstDevinMetricValue(sources, ['cache_read_tokens', 'cache_read_input_tokens']) +
    firstDevinMetricValue(sources, ['cache_creation_tokens', 'cache_creation_input_tokens'])
}

function consumeDevinStep(builder: SessionBuilder, value: unknown): void {
  if (!isRecord(value)) return
  const metadata = isRecord(value.metadata) ? value.metadata : null
  noteTimestamp(builder, string(value.timestamp) ?? string(metadata?.created_at))
  const metrics = isRecord(metadata?.metrics) ? metadata.metrics : null
  const extra = isRecord(value.extra) ? value.extra : null
  if (!builder.fields.model) {
    builder.patch({
      model: string(value.model_name) ?? string(extra?.generation_model) ??
        string(metadata?.generation_model) ?? string(metrics?.generation_model)
    })
  }
  builder.patch({ totalTokens: devinStepTokens(metadata, metrics, isRecord(value.metrics) ? value.metrics : null) })
  const source = string(value.source)
  const isSystem = source === 'system'
  const isUser = !isSystem && (source === 'user' || metadata?.is_user_input === true)
  if (isUser) {
    const text = devinStepText(value) ?? textFromContent(value.content) ?? string(value.text)
    if (builder.fields.title === null) builder.patch({ title: sourceTitle(text) })
    builder.message('user', text)
  } else if (!isSystem && (source === 'agent' || string(value.role) === 'assistant' || Boolean(value.tool_calls))) {
    builder.message('assistant', devinStepText(value) ?? textFromContent(value.content))
  }
}

type DevinDbRow = {
  workingDirectory: string | null
  title: string | null
  model: string | null
  createdAt: number | null
  updatedAt: number | null
  hidden: boolean
}

function readDevinDbRow(dbPath: string, sessionId: string): DevinDbRow | null {
  let database: Database | null = null
  try {
    database = new Database(dbPath, { readonly: true, create: false })
    database.exec('PRAGMA query_only = ON')
    const columns = new Set<string>()
    for (const raw of database.query('PRAGMA table_info(sessions)').all() as unknown[]) {
      if (isRecord(raw) && typeof raw.name === 'string') columns.add(raw.name)
    }
    if (!columns.has('id')) return null
    const optional = ['working_directory', 'title', 'model', 'created_at', 'last_activity_at', 'hidden']
      .filter((column) => columns.has(column))
    const rows = database.query(`SELECT id${optional.map((column) => `, ${column}`).join('')} FROM sessions WHERE id = ?`).all(sessionId) as unknown[]
    let selected: DevinDbRow | null = null
    for (const raw of rows) {
      if (!isRecord(raw) || string(raw.id) !== sessionId) continue
      const seconds = (value: unknown): number | null => {
        const n = numeric(value)
        return n > 0 ? Math.round(n * 1000) : null
      }
      selected = {
        workingDirectory: string(raw.working_directory),
        title: string(raw.title),
        model: string(raw.model),
        createdAt: seconds(raw.created_at),
        updatedAt: seconds(raw.last_activity_at),
        hidden: numeric(raw.hidden) !== 0
      }
    }
    return selected
  } catch {
    return null
  } finally {
    database?.close()
  }
}

async function parseDevin(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const builder = createSessionBuilder(context, { sessionId: sourceFileId(filePath), totalTokens: 0 })
  let record: Record<string, unknown> | null
  try {
    record = await foldJsonDocument({
      filePath,
      arrayKey: 'steps',
      fields: ['session_id', 'sessionId', 'generation_model', 'working_directory'],
      objectFields: { agent: ['model_name', 'model'] },
      signal: context.signal,
      consume: (value) => consumeDevinStep(builder, value)
    })
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!record) return null
  const sessionId = string(record.session_id) ?? string(record.sessionId) ?? sourceFileId(filePath)
  builder.fields.sessionId = stableSessionId(context.candidate, sessionId)
  const agent = isRecord(record.agent) ? record.agent : null
  builder.patch({
    model: string(agent?.model_name) ?? string(agent?.model) ?? string(record.generation_model) ?? builder.fields.model,
    cwd: string(record.working_directory)
  })
  const fallbackDb = join(dirname(dirname(filePath)), 'sessions.db') ||
    join(context.sourceHome, '.local', 'share', 'devin', 'cli', 'sessions.db')
  const dbPath = metadataPath(context, 'devinSessionsDbPath', fallbackDb)
  const row = readDevinDbRow(dbPath, builder.fields.sessionId)
  if (row?.hidden) return null
  if (row) {
    if (!builder.fields.title) builder.patch({ title: sourceTitle(row.title) })
    builder.patch({ cwd: builder.fields.cwd ?? row.workingDirectory })
    if (builder.fields.createdAt === null) builder.patch({ createdAt: row.createdAt })
    if (builder.fields.updatedAt === null) builder.patch({ updatedAt: row.updatedAt })
    if (!builder.fields.model) builder.patch({ model: row.model })
  }
  return finish(builder)
}

function kimiSessionId(filePath: string): string {
  return basename(dirname(filePath))
}

function kimiIndexPath(filePath: string): string {
  return join(dirname(dirname(dirname(dirname(filePath)))), 'session_index.jsonl')
}

function kimiWirePath(filePath: string, state: Record<string, unknown>): string {
  const agents = isRecord(state.agents) ? state.agents : null
  let primaryId = 'main'
  if (agents) {
    for (const [id, value] of Object.entries(agents)) {
      if (isRecord(value) && value.type === 'main' && value.parentAgentId == null) {
        primaryId = id
        break
      }
    }
  }
  return join(dirname(filePath), 'agents', primaryId, 'wire.jsonl')
}

async function kimiWorkDir(indexPath: string, sessionId: string, signal?: AbortSignal): Promise<string | null> {
  let workDir: string | null = null
  await foldOptionalJsonl(indexPath, signal, (record) => {
    if (string(record.sessionId) === sessionId) workDir = string(record.workDir)
  }, true)
  return workDir
}

function kimiUsage(value: unknown, scope: unknown): number {
  if (scope === 'session' || !isRecord(value)) return 0
  return numeric(value.inputOther) + numeric(value.output) + numeric(value.inputCacheRead) + numeric(value.inputCacheCreation)
}

async function parseKimi(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const state = await readJsonObject(filePath)
  if (!state) return null
  const sessionId = kimiSessionId(filePath)
  const builder = createSessionBuilder(context, {
    sessionId: stableSessionId(context.candidate, sessionId),
    title: sourceTitle(state.title),
    totalTokens: 0
  })
  const indexPath = metadataPath(context, 'kimiSessionIndexPath', kimiIndexPath(filePath))
  builder.patch({ cwd: await kimiWorkDir(indexPath, builder.fields.sessionId, context.signal) })
  noteTimestamp(builder, string(state.createdAt))
  noteTimestamp(builder, string(state.updatedAt))
  const fallbackTitle = sourceTitle(state.lastPrompt)
  const wirePath = metadataPath(context, 'kimiWirePath', kimiWirePath(filePath, state))
  let pendingAssistant = ''
  const flushAssistant = (): void => {
    const text = pendingAssistant
    pendingAssistant = ''
    if (text.trim()) builder.message('assistant', text)
  }
  await foldOptionalJsonl(wirePath, context.signal, (record) => {
    switch (record.type) {
      case 'config.update':
        builder.patch({ model: string(record.modelAlias) ?? builder.fields.model })
        break
      case 'usage.record':
        builder.patch({ model: string(record.model) ?? builder.fields.model, totalTokens: kimiUsage(record.usage, record.usageScope) })
        break
      case 'context.append_message': {
        const message = isRecord(record.message) ? record.message : null
        if (!message || message.role !== 'user' || nestedRecord(message, 'origin')?.kind !== 'user') break
        if (builder.fields.title === null) builder.patch({ title: sourceTitle(message.content) })
        builder.message('user', textFromContent(message.content))
        break
      }
      case 'context.append_loop_event': {
        const event = isRecord(record.event) ? record.event : null
        if (event?.type === 'content.part') {
          const part = isRecord(event.part) ? event.part : null
          if (part?.type === 'text' && typeof part.text === 'string' && pendingAssistant.length < MAX_MESSAGE_CHARS) {
            const remaining = MAX_MESSAGE_CHARS - pendingAssistant.length
            let chunk = part.text.slice(0, remaining)
            const last = chunk.charCodeAt(chunk.length - 1)
            if (chunk.length < part.text.length && last >= 0xd800 && last <= 0xdbff) chunk = chunk.slice(0, -1)
            pendingAssistant += chunk
          }
        } else if (event?.type === 'step.end') flushAssistant()
        break
      }
      default:
        break
    }
  }, true)
  flushAssistant()
  return finish(builder, fallbackTitle)
}

function museTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1e14) return Math.floor(value / 1000)
  const timestamp = numberOrDate(value)
  return timestamp !== null && timestamp > 0 ? timestamp : null
}

function museRecords(envelope: Record<string, unknown>): Record<string, unknown>[] {
  if (envelope.retained_marker === 'omitted_live_only') return []
  if (!Array.isArray(envelope.children)) return [envelope]
  const records: Record<string, unknown>[] = []
  for (const child of envelope.children) {
    const raw = isRecord(child) ? child.record_json : null
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (isRecord(parsed) && parsed.retained_marker !== 'omitted_live_only') records.push(parsed)
    } catch {
      // An invalid child is isolated from the other retained records in its frame.
    }
  }
  return records
}

function museFirstText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const block of value) {
    const text = isRecord(block) ? string(block.text) : null
    if (text) return text
  }
  return null
}

function museUserIntent(payload: Record<string, unknown>): string | null {
  const refill = museFirstText(payload.refill_blocks)
  if (refill) return refill
  if (Array.isArray(payload.model_messages)) {
    for (const message of payload.model_messages) {
      const text = museFirstText(isRecord(message) ? message.content : null)
      if (text) return text
    }
  }
  return null
}

async function parseMuse(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const sessionId = basename(dirname(filePath))
  const builder = createSessionBuilder(context, { sessionId: stableSessionId(context.candidate, sessionId), totalTokens: 0 })
  let dedupeText: string | null = null
  let dedupeTime: number | null = null
  const userTurn = (text: string | null, timestamp: number | null, dedupeStarted: boolean): void => {
    if (!text) return
    if (dedupeStarted && dedupeText === text && dedupeTime !== null && timestamp !== null && Math.abs(timestamp - dedupeTime) < 60_000) return
    dedupeText = text
    dedupeTime = timestamp
    if (builder.fields.title === null) builder.patch({ title: sourceTitle(text) })
    builder.message('user', text, timestamp)
  }
  for await (const envelope of readJsonl(filePath, context.signal)) {
    for (const record of museRecords(envelope)) {
      const timestamp = museTimestamp(record.recorded_at)
      if (timestamp !== null) noteTimestamp(builder, timestamp)
      const payload = isRecord(record.payload) ? record.payload : null
      if (!payload) continue
      switch (record.payload_type) {
        case 'runtime.session.metadata':
          builder.patch({ cwd: string(nestedRecord(payload, 'record')?.workspace_root) ?? builder.fields.cwd })
          break
        case 'runtime.session.route_facts':
          builder.patch({ cwd: string(nestedRecord(payload, 'record')?.cwd) ?? builder.fields.cwd })
          break
        case 'session.workspace_branch.observed':
          builder.patch({ branch: string(nestedRecord(payload, 'record', 'reference')?.name) ?? builder.fields.branch })
          break
        case 'run.model.configured':
          builder.patch({ model: string(nestedRecord(payload, 'record')?.model_id) ?? builder.fields.model })
          break
        case 'runtime.user_intent.accepted':
          userTurn(museUserIntent(payload), timestamp, false)
          break
        case 'runtime.session': {
          const event = isRecord(payload.event) ? payload.event : null
          if (event?.kind === 'started') userTurn(string(event.prompt), timestamp, true)
          else if (event?.kind === 'assistant_message_committed') {
            const text = string(event.text)
            if (text) builder.message('assistant', text, timestamp)
          }
          else if (event?.kind === 'model_completed') {
            const usage = isRecord(event.usage) ? event.usage : null
            builder.patch({
              totalTokens: numeric(usage?.input_tokens) + numeric(usage?.output_tokens),
              model: string(event.model) ?? builder.fields.model
            })
          }
          break
        }
        default:
          break
      }
    }
  }
  return finish(builder)
}

function jcodeInjectedContext(message: Record<string, unknown>): boolean {
  const content = normalizeTitle(stripHiddenText(textFromContent(message.content) ?? '') ?? '') ?? ''
  return content.startsWith('[Scheduled task]') || content.startsWith('<system-reminder>')
}

async function parseJcode(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const builder = createSessionBuilder(context, { sessionId: sourceFileId(filePath), totalTokens: 0 })
  let record: Record<string, unknown> | null
  try {
    record = await foldJsonDocument({
      filePath,
      arrayKey: 'messages',
      fields: ['id', 'session_id', 'model', 'custom_title', 'title', 'working_dir', 'working_directory', 'created_at', 'updated_at'],
      signal: context.signal,
      consume: (value) => {
        if (!isRecord(value) || jcodeInjectedContext(value)) return
        noteTimestamp(builder, value.timestamp)
        const rawRole = string(value.role)
        const role: VaultRole = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' ? rawRole : 'system'
        if (role === 'user' && builder.fields.title === null) builder.patch({ title: sourceTitle(value.content) })
        const usage = isRecord(value.token_usage) ? value.token_usage : null
        builder.patch({ totalTokens: numeric(usage?.input_tokens) + numeric(usage?.output_tokens) })
        builder.message(role, textFromContent(value.content), value.timestamp)
      }
    })
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!record) return null
  builder.fields.sessionId = stableSessionId(context.candidate, string(record.id) ?? string(record.session_id) ?? sourceFileId(filePath))
  builder.patch({
    model: string(record.model),
    title: sourceTitle(record.custom_title) ?? sourceTitle(record.title),
    cwd: string(record.working_dir) ?? string(record.working_directory)
  })
  noteTimestamp(builder, record.created_at)
  noteTimestamp(builder, record.updated_at)
  return finish(builder)
}

function kiroContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return textFromContent(content)
  const pieces: string[] = []
  for (const raw of content) {
    if (!isRecord(raw)) continue
    const data = raw.data
    if (raw.kind === 'text' && typeof data === 'string' && data) pieces.push(data)
    else if (raw.kind === 'json') {
      const json = JSON.stringify(data)
      if (json !== undefined) pieces.push(json)
    } else if (raw.kind === 'toolResult' && isRecord(data)) {
      const text = kiroContentText(data.content)
      if (text) pieces.push(text)
    }
  }
  return boundedText(pieces.join(' '))
}

function kiroTranscriptMessage(builder: SessionBuilder, record: Record<string, unknown>): void {
  const data = isRecord(record.data) ? record.data : null
  if (!data) return
  const text = kiroContentText(data.content)
  if (record.kind === 'Prompt') {
    const timestamp = nestedRecord(data, 'meta')?.timestamp
    noteTimestamp(builder, timestamp)
    builder.message('user', text, timestamp)
  } else if (record.kind === 'AssistantMessage') {
    builder.message('assistant', text)
  } else if (record.kind === 'ToolResults') {
    builder.message('tool', text, undefined, false)
  }
}

async function parseKiro(context: ParserContext): Promise<VaultSession | null> {
  const filePath = context.candidate.filePath
  const metadata = await readJsonObject(filePath)
  if (!metadata || string(metadata.parent_session_id)) return null
  const sessionId = basename(filePath, '.json')
  const builder = createSessionBuilder(context, {
    sessionId: stableSessionId(context.candidate, sessionId),
    title: sourceTitle(metadata.title) ?? `${context.candidate.agent} ${sessionId.slice(0, 8)}`,
    cwd: string(metadata.cwd),
    model: string(nestedRecord(metadata, 'session_state', 'rts_model_state', 'model_info')?.model_id),
    totalTokens: 0
  })
  noteTimestamp(builder, metadata.created_at)
  noteTimestamp(builder, metadata.updated_at)
  const transcriptPath = metadataPath(context, 'kiroTranscriptPath', `${filePath}l`)
  try {
    await foldOptionalJsonl(transcriptPath, context.signal, (record) => kiroTranscriptMessage(builder, record))
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  return finish(builder)
}

class JsonStreamReader {
  private readonly stream: ReturnType<typeof createReadStream>
  private readonly iterator: AsyncIterator<Buffer | string>
  private readonly decoder = new StringDecoder('utf8')
  private readonly signal?: AbortSignal
  private readonly abort = (): void => {
    this.stream.destroy(this.signal?.reason instanceof Error ? this.signal.reason : new Error('Scan cancelled'))
  }
  private buffer = ''
  private offset = 0
  private ended = false

  constructor(filePath: string, signal?: AbortSignal) {
    this.stream = createReadStream(filePath, { highWaterMark: 64 * 1024 })
    this.iterator = this.stream[Symbol.asyncIterator]()
    this.signal = signal
    signal?.addEventListener('abort', this.abort, { once: true })
  }

  async peek(): Promise<string | null> {
    throwIfAborted(this.signal)
    while (this.offset >= this.buffer.length && !this.ended) {
      this.buffer = ''
      this.offset = 0
      const next = await this.iterator.next()
      if (next.done) {
        this.buffer = this.decoder.end()
        if (!this.buffer) this.ended = true
        break
      }
      const raw = next.value
      const decoded = this.decoder.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
      if (decoded) this.buffer = decoded
    }
    return this.offset < this.buffer.length ? this.buffer[this.offset] ?? null : null
  }

  async take(budget?: DocumentRecordBudget): Promise<string> {
    const char = await this.peek()
    if (char === null) throw new SyntaxError('Unexpected end of JSON document')
    this.offset++
    if (budget) {
      const code = char.charCodeAt(0)
      if (code >= 0xd800 && code <= 0xdbff) {
        budget.bytes += 4
        budget.previousHighSurrogate = true
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        if (!budget.previousHighSurrogate) budget.bytes += 3
        budget.previousHighSurrogate = false
      } else {
        budget.previousHighSurrogate = false
        budget.bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
      }
      if (budget.bytes > MAX_JSONL_RECORD_BYTES) budget.exceeded = true
    }
    return char
  }
  remaining(): number {
    return this.buffer.length - this.offset
  }

  charAt(relativeIndex: number): string | null {
    return this.buffer[this.offset + relativeIndex] ?? null
  }

  takeRange(length: number, budget?: DocumentRecordBudget): string {
    if (length <= 0 || length > this.remaining()) throw new SyntaxError('Invalid JSON stream range')
    const value = this.buffer.slice(this.offset, this.offset + length)
    this.offset += length
    if (budget) {
      budget.bytes += Buffer.byteLength(value)
      budget.previousHighSurrogate = false
      if (budget.bytes > MAX_JSONL_RECORD_BYTES) budget.exceeded = true
    }
    return value
  }

  close(): void {
    this.signal?.removeEventListener('abort', this.abort)
    this.stream.destroy()
  }
}

function newBudget(): DocumentRecordBudget {
  return { bytes: 0, exceeded: false, previousHighSurrogate: false }
}

async function skipWhitespace(reader: JsonStreamReader, budget?: DocumentRecordBudget): Promise<void> {
  for (;;) {
    const char = await reader.peek()
    if (char === null || !' \t\r\n'.includes(char)) return
    await reader.take(budget)
  }
}

async function expectChar(reader: JsonStreamReader, expected: string, budget?: DocumentRecordBudget): Promise<void> {
  if ((await reader.take(budget)) !== expected) throw new SyntaxError(`Expected ${expected} in JSON document`)
}

async function readJsonString(
  reader: JsonStreamReader,
  budget: DocumentRecordBudget | undefined,
  retain: boolean
): Promise<{ value: string; truncated: boolean }> {
  await expectChar(reader, '"', budget)
  const chunks: string[] = []
  let part = ''
  let length = 0
  let truncated = false
  const append = (value: string): void => {
    length += value.length
    if (!retain || (budget?.exceeded ?? false) || length > MAX_JSONL_RECORD_BYTES) {
      truncated = true
      return
    }
    part += value
    if (part.length >= 1024) {
      chunks.push(part)
      part = ''
    }
  }
  for (;;) {
    const char = await reader.peek()
    if (char === null) throw new SyntaxError('Unexpected end of JSON string')
    if (char === '"') {
      await reader.take(budget)
      break
    }
    if (char !== '\\') {
      if (char.charCodeAt(0) < 0x20) throw new SyntaxError('Unescaped control character in JSON document')
      let length = 0
      while (length < reader.remaining()) {
        const next = reader.charAt(length)
        if (next === null || next === '"' || next === '\\' || next.charCodeAt(0) < 0x20) break
        length++
      }
      if (length === 0) throw new SyntaxError('Invalid string content in JSON document')
      append(reader.takeRange(length, budget))
      continue
    }
    await reader.take(budget)
    const escape = await reader.take(budget)
    let value: string
    switch (escape) {
      case '"': value = '"'; break
      case '\\': value = '\\'; break
      case '/': value = '/'; break
      case 'b': value = '\b'; break
      case 'f': value = '\f'; break
      case 'n': value = '\n'; break
      case 'r': value = '\r'; break
      case 't': value = '\t'; break
      case 'u': {
        let hex = ''
        for (let index = 0; index < 4; index++) hex += await reader.take(budget)
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new SyntaxError('Invalid Unicode escape in JSON document')
        value = String.fromCharCode(Number.parseInt(hex, 16))
        break
      }
      default: throw new SyntaxError('Invalid escape in JSON document')
    }
    append(value)
  }
  if (part) chunks.push(part)
  let text = retain && !truncated ? chunks.join('') : ''
  if (text.length > MAX_JSONL_RECORD_BYTES) {
    text = text.slice(0, MAX_JSONL_RECORD_BYTES)
    truncated = true
  }
  if (text.length && text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) {
    text = text.slice(0, -1)
  }
  return { value: text, truncated }
}

async function parseJsonValue(
  reader: JsonStreamReader,
  budget?: DocumentRecordBudget,
  retain = true,
  depth = 0
): Promise<unknown | typeof DOCUMENT_RECORD_TOO_LARGE> {
  if (depth > 256) throw new SyntaxError('JSON document nesting exceeds 256 levels')
  await skipWhitespace(reader, budget)
  const next = await reader.peek()
  if (next === null) throw new SyntaxError('Unexpected end of JSON document')
  if (next === '"') {
    const parsed = await readJsonString(reader, budget, retain && !(budget?.exceeded ?? false))
    return budget?.exceeded ? DOCUMENT_RECORD_TOO_LARGE : retain ? parsed.value : DOCUMENT_RECORD_TOO_LARGE
  }
  if (next === '{') return parseJsonObjectValue(reader, budget, retain, depth + 1)
  if (next === '[') return parseJsonArrayValue(reader, budget, retain, depth + 1)
  if (next === 't' || next === 'f' || next === 'n') {
    const literal = next === 't' ? 'true' : next === 'f' ? 'false' : 'null'
    for (const char of literal) await expectChar(reader, char, budget)
    if (budget?.exceeded) return DOCUMENT_RECORD_TOO_LARGE
    if (!retain) return DOCUMENT_RECORD_TOO_LARGE
    return literal === 'true' ? true : literal === 'false' ? false : null
  }
  if (next === '-' || (next >= '0' && next <= '9')) {
    let raw = ''
    let tooLong = false
    const takeNumberChar = async (): Promise<string> => {
      const char = await reader.take(budget)
      if (retain && raw.length < MAX_JSONL_RECORD_BYTES) raw += char
      else if (retain) tooLong = true
      return char
    }
    let char = await reader.peek()
    if (char === '-') {
      await takeNumberChar()
      char = await reader.peek()
    }
    if (char === '0') {
      await takeNumberChar()
      const following = await reader.peek()
      if (following !== null && following >= '0' && following <= '9') throw new SyntaxError('Invalid number in JSON document')
    } else if (char !== null && char >= '1' && char <= '9') {
      await takeNumberChar()
      for (;;) {
        const digit = await reader.peek()
        if (digit === null || digit < '0' || digit > '9') break
        await takeNumberChar()
      }
    } else {
      throw new SyntaxError('Invalid number in JSON document')
    }
    if (await reader.peek() === '.') {
      await takeNumberChar()
      char = await reader.peek()
      if (char === null || char < '0' || char > '9') throw new SyntaxError('Invalid number in JSON document')
      do {
        await takeNumberChar()
        char = await reader.peek()
      } while (char !== null && char >= '0' && char <= '9')
    }
    char = await reader.peek()
    if (char === 'e' || char === 'E') {
      await takeNumberChar()
      char = await reader.peek()
      if (char === '+' || char === '-') {
        await takeNumberChar()
        char = await reader.peek()
      }
      if (char === null || char < '0' || char > '9') throw new SyntaxError('Invalid number in JSON document')
      do {
        await takeNumberChar()
        char = await reader.peek()
      } while (char !== null && char >= '0' && char <= '9')
    }
    if (char !== null && char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n' && char !== ',' && char !== ']' && char !== '}') {
      throw new SyntaxError('Invalid number in JSON document')
    }
    if (budget?.exceeded || tooLong || !retain) return DOCUMENT_RECORD_TOO_LARGE
    return Number(raw)
  }
  throw new SyntaxError('Invalid value in JSON document')
}

async function parseJsonObjectValue(
  reader: JsonStreamReader,
  budget: DocumentRecordBudget | undefined,
  retain: boolean,
  depth: number
): Promise<unknown | typeof DOCUMENT_RECORD_TOO_LARGE> {
  await expectChar(reader, '{', budget)
  const object: Record<string, unknown> = Object.create(null)
  await skipWhitespace(reader, budget)
  if (await reader.peek() === '}') {
    await reader.take(budget)
    return budget?.exceeded || !retain ? DOCUMENT_RECORD_TOO_LARGE : object
  }
  for (;;) {
    await skipWhitespace(reader, budget)
    if (await reader.peek() !== '"') throw new SyntaxError('Expected object key in JSON document')
    const key = await readJsonString(reader, budget, retain && !(budget?.exceeded ?? false))
    await skipWhitespace(reader, budget)
    await expectChar(reader, ':', budget)
    const keepChild = retain && !(budget?.exceeded ?? false)
    const value = await parseJsonValue(reader, budget, keepChild, depth + 1)
    if (keepChild && !key.truncated && !budget?.exceeded && value !== DOCUMENT_RECORD_TOO_LARGE) object[key.value] = value
    await skipWhitespace(reader, budget)
    const delimiter = await reader.take(budget)
    if (delimiter === '}') break
    if (delimiter !== ',') throw new SyntaxError('Expected comma in JSON object')
  }
  return budget?.exceeded || !retain ? DOCUMENT_RECORD_TOO_LARGE : object
}

async function parseJsonArrayValue(
  reader: JsonStreamReader,
  budget: DocumentRecordBudget | undefined,
  retain: boolean,
  depth: number
): Promise<unknown | typeof DOCUMENT_RECORD_TOO_LARGE> {
  await expectChar(reader, '[', budget)
  const values: unknown[] = []
  await skipWhitespace(reader, budget)
  if (await reader.peek() === ']') {
    await reader.take(budget)
    return budget?.exceeded || !retain ? DOCUMENT_RECORD_TOO_LARGE : values
  }
  for (;;) {
    const keepChild = retain && !(budget?.exceeded ?? false)
    const value = await parseJsonValue(reader, budget, keepChild, depth + 1)
    if (keepChild && !budget?.exceeded && value !== DOCUMENT_RECORD_TOO_LARGE) values.push(value)
    await skipWhitespace(reader, budget)
    const delimiter = await reader.take(budget)
    if (delimiter === ']') break
    if (delimiter !== ',') throw new SyntaxError('Expected comma in JSON array')
  }
  return budget?.exceeded || !retain ? DOCUMENT_RECORD_TOO_LARGE : values
}

async function parseSelectedObject(
  reader: JsonStreamReader,
  keys: ReadonlySet<string>,
  budget: DocumentRecordBudget
): Promise<Record<string, unknown> | typeof DOCUMENT_RECORD_TOO_LARGE> {
  await expectChar(reader, '{', budget)
  const object: Record<string, unknown> = Object.create(null)
  await skipWhitespace(reader, budget)
  if (await reader.peek() === '}') {
    await reader.take(budget)
    return budget.exceeded ? DOCUMENT_RECORD_TOO_LARGE : object
  }
  for (;;) {
    await skipWhitespace(reader, budget)
    if (await reader.peek() !== '"') throw new SyntaxError('Expected object key in JSON document')
    const key = await readJsonString(reader, budget, !budget.exceeded)
    await skipWhitespace(reader, budget)
    await expectChar(reader, ':', budget)
    const selected = !key.truncated && keys.has(key.value) && !budget.exceeded
    const value = await parseJsonValue(reader, budget, selected, 1)
    if (selected && !budget.exceeded && value !== DOCUMENT_RECORD_TOO_LARGE) object[key.value] = value
    await skipWhitespace(reader, budget)
    const delimiter = await reader.take(budget)
    if (delimiter === '}') break
    if (delimiter !== ',') throw new SyntaxError('Expected comma in JSON object')
  }
  return budget.exceeded ? DOCUMENT_RECORD_TOO_LARGE : object
}

async function foldDocumentArray(
  reader: JsonStreamReader,
  consume: (value: unknown) => void,
  signal?: AbortSignal
): Promise<void> {
  await expectChar(reader, '[')
  await skipWhitespace(reader)
  if (await reader.peek() === ']') {
    await reader.take()
    return
  }
  for (;;) {
    throwIfAborted(signal)
    const budget = newBudget()
    const value = await parseJsonValue(reader, budget, true)
    if (!budget.exceeded && value !== DOCUMENT_RECORD_TOO_LARGE) consume(value)
    await skipWhitespace(reader)
    const delimiter = await reader.take()
    if (delimiter === ']') return
    if (delimiter !== ',') throw new SyntaxError('Expected comma in document array')
  }
}

async function foldJsonDocument(args: {
  filePath: string
  arrayKey: string
  fields: readonly string[]
  objectFields?: Readonly<Record<string, readonly string[]>>
  signal?: AbortSignal
  consume: (value: unknown) => void
}): Promise<Record<string, unknown> | null> {
  const reader = new JsonStreamReader(args.filePath, args.signal)
  try {
    await skipWhitespace(reader)
    if (await reader.peek() !== '{') {
      await parseJsonValue(reader, undefined, false)
      await skipWhitespace(reader)
      if (await reader.peek() !== null) throw new SyntaxError('Trailing JSON document data')
      return null
    }
    await reader.take()
    const record: Record<string, unknown> = Object.create(null)
    const fieldSet = new Set(args.fields)
    const objectFields = new Map(Object.entries(args.objectFields ?? {}).map(([key, values]) => [key, new Set(values)]))
    await skipWhitespace(reader)
    if (await reader.peek() !== '}') {
      for (;;) {
        await skipWhitespace(reader)
        if (await reader.peek() !== '"') throw new SyntaxError('Expected root object key in JSON document')
        const key = await readJsonString(reader, undefined, true)
        await skipWhitespace(reader)
        await expectChar(reader, ':')
        await skipWhitespace(reader)
        if (!key.truncated && key.value === args.arrayKey && await reader.peek() === '[') {
          await foldDocumentArray(reader, args.consume, args.signal)
        } else if (!key.truncated && fieldSet.has(key.value)) {
          const budget = newBudget()
          const nestedKeys = objectFields.get(key.value)
          let value: unknown
          if (nestedKeys && await reader.peek() === '{') value = await parseSelectedObject(reader, nestedKeys, budget)
          else value = await parseJsonValue(reader, budget, true)
          if (!budget.exceeded && value !== DOCUMENT_RECORD_TOO_LARGE) record[key.value] = value
        } else {
          await parseJsonValue(reader, undefined, false)
        }
        await skipWhitespace(reader)
        const delimiter = await reader.take()
        if (delimiter === '}') break
        if (delimiter !== ',') throw new SyntaxError('Expected comma in root JSON object')
      }
    } else {
      await reader.take()
    }
    await skipWhitespace(reader)
    if (await reader.peek() !== null) throw new SyntaxError('Trailing JSON document data')
    return record
  } finally {
    reader.close()
  }
}
