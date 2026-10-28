import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { VaultSession } from '../../types'
import {
  createSessionBuilder,
  isRecord,
  numberOrDate,
  readJsonl,
  readJsonObject,
  stableSessionId,
  string,
  textFromContent,
  throwIfAborted,
  type ParserContext,
  type SessionBuilder
} from './shared'

type MessageGraphAgent = 'openclaw' | 'pi' | 'omp' | 'prime-agent'
type OmpTranscriptTitle = { title: string; source: 'user' | 'auto'; updatedAt: number | null }
type GraphRole = 'user' | 'assistant'

export async function parseGraph(context: ParserContext): Promise<VaultSession | null> {
  switch (context.candidate.agent) {
    case 'rovo':
      return parseRovo(context)
    case 'openclaw':
    case 'pi':
    case 'omp':
    case 'prime-agent':
      return parseMessageGraph(context, context.candidate.agent)
    default:
      return null
  }
}

async function parseRovo(context: ParserContext): Promise<VaultSession | null> {
  throwIfAborted(context.signal)
  const metadata = await readJsonObject(context.candidate.filePath)
  throwIfAborted(context.signal)
  if (!metadata) return null

  const builder = createSessionBuilder(context, {
    sessionId: basename(dirname(context.candidate.filePath)),
    title: firstString(metadata, ['title', 'name', 'summary']),
    cwd: rovoSessionCwd(metadata),
    totalTokens: 0
  })
  updateTimeline(builder, firstString(metadata, ['created_at', 'createdAt']))
  updateTimeline(builder, firstString(metadata, ['updated_at', 'updatedAt']))

  let sessionContext: Record<string, unknown> | null = null
  try {
    sessionContext = await readJsonObject(join(dirname(context.candidate.filePath), 'session_context.json'))
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  throwIfAborted(context.signal)
  if (sessionContext) consumeRovoContext(builder, sessionContext)
  return builder.finish()
}

function rovoSessionCwd(metadata: Record<string, unknown>): string | null {
  return firstString(metadata, [
    'workspace_path',
    'workspacePath',
    'workspace',
    'cwd',
    'working_directory',
    'workingDirectory',
    'project_path',
    'projectPath'
  ])
}

function consumeRovoContext(builder: SessionBuilder, context: Record<string, unknown>): void {
  if (Array.isArray(context.messages)) {
    for (const value of context.messages) {
      if (!isRecord(value)) continue
      const role = string(value.role)
      if (role !== 'user' && role !== 'assistant') continue
      const text = textFromContent(value.content)
      updateTimeline(builder, string(value.timestamp))
      if (role === 'user' && !builder.fields.title) builder.patch({ title: text })
      builder.message(role, text, value.timestamp)
    }
  }

  if (Array.isArray(context.message_history)) {
    for (const value of context.message_history) {
      if (!isRecord(value)) continue
      updateTimeline(builder, string(value.timestamp))
      const role = string(value.role) ?? rovoRoleFromKind(value.kind)
      if (role !== 'user' && role !== 'assistant') continue
      const text = rovoPartsText(value.parts, role)
      if (text === null) continue
      if (role === 'user' && !builder.fields.title) builder.patch({ title: text })
      builder.message(role, text, value.timestamp)
    }
  }
}

function rovoRoleFromKind(value: unknown): GraphRole | null {
  if (value === 'request') return 'user'
  if (value === 'response') return 'assistant'
  return null
}

function rovoPartsText(value: unknown, role: GraphRole): string | null {
  if (!Array.isArray(value)) return null
  const parts: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const kind = string(item.part_kind)
    if (role === 'user' && kind !== 'user-prompt' && kind !== 'text') continue
    if (role === 'assistant' && kind !== 'text') continue
    const text = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : null
    if (text !== null) parts.push(text)
  }
  return parts.length ? textFromContent(parts.join(' ')) : null
}

async function parseMessageGraph(context: ParserContext, agent: MessageGraphAgent): Promise<VaultSession> {
  throwIfAborted(context.signal)
  const builder = createSessionBuilder(context, {
    sessionId: stableSessionId(context.candidate),
    totalTokens: 0
  })
  let ompTitle: OmpTranscriptTitle | null = null

  for await (const record of readJsonl(context.candidate.filePath, context.signal)) {
    updateTimeline(builder, record.timestamp)
    if (agent === 'omp') {
      ompTitle = foldOmpTranscriptTitle(ompTitle, record)
      if (ompTitle) builder.patch({ title: ompTitle.title })
    }

    if (record.type === 'session') {
      builder.patch({
        sessionId: string(record.id) ?? builder.fields.sessionId,
        cwd: string(record.cwd) ?? builder.fields.cwd
      })
      continue
    }
    if (record.type === 'model_change') {
      builder.patch({ model: string(record.modelId) ?? string(record.model) ?? builder.fields.model })
      continue
    }
    if (record.type !== 'message' || !isRecord(record.message)) continue

    const message = record.message
    const role = string(message.role)
    if (role !== 'user' && role !== 'assistant') continue
    const text = textFromContent(message.content)
    if (role === 'user') {
      if (agent !== 'omp' && !builder.fields.title) builder.patch({ title: text })
    } else {
      const model = string(message.model)
      if (model) builder.patch({ model })
      builder.patch({ totalTokens: tokenTotal(message.usage) })
    }
    builder.message(role, text, record.timestamp)
  }

  if (agent === 'omp') {
    builder.patch({ subagentTranscriptCount: await countOmpSubagentTranscripts(context.candidate.filePath) })
  }
  return builder.finish()
}

function foldOmpTranscriptTitle(
  current: OmpTranscriptTitle | null,
  record: Record<string, unknown>
): OmpTranscriptTitle | null {
  const legacy = record.type === 'session_info'
  if (!legacy && record.type !== 'session' && record.type !== 'title_change' && record.type !== 'title') {
    return current
  }
  if (record.type === 'title' && record.v !== 1) return current

  const title = string(legacy ? record.name : record.title)
  if (!title) return current
  const rawSource = legacy ? 'user' : record.source ?? record.titleSource
  if (rawSource !== undefined && rawSource !== 'user' && rawSource !== 'auto') return current
  const source = rawSource === 'user' ? 'user' : 'auto'
  if (current?.source === 'user' && source !== 'user') return current

  const updatedAt = numberOrDate(record.type === 'title' ? record.updatedAt : record.timestamp)
  if (
    current?.source === source &&
    current.updatedAt !== null &&
    updatedAt !== null &&
    updatedAt < current.updatedAt
  ) {
    return current
  }
  return { title, source, updatedAt }
}

async function countOmpSubagentTranscripts(filePath: string): Promise<number> {
  const artifactDir = join(dirname(filePath), basename(filePath, extname(filePath)))
  try {
    const entries = await readdir(artifactDir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl').length
  } catch {
    return 0
  }
}

function updateTimeline(builder: SessionBuilder, value: unknown): void {
  const timestamp = numberOrDate(value)
  if (timestamp === null || timestamp <= 0) return
  const { createdAt, updatedAt } = builder.fields
  builder.patch({
    createdAt: createdAt === null ? timestamp : Math.min(createdAt, timestamp),
    updatedAt: updatedAt === null ? timestamp : Math.max(updatedAt, timestamp)
  })
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = string(record[key])
    if (value) return value
  }
  return null
}

function tokenTotal(value: unknown): number {
  if (!isRecord(value)) return 0
  const explicitTotal = numberValue(value.total) || numberValue(value.totalTokens) || numberValue(value.total_tokens)
  if (explicitTotal > 0) return explicitTotal
  return [
    value.input,
    value.inputTokens,
    value.input_tokens,
    value.output,
    value.outputTokens,
    value.output_tokens,
    value.cacheRead,
    value.cacheReadTokens,
    value.cache_read_input_tokens,
    value.cacheWrite,
    value.cacheWriteTokens,
    value.cache_creation_input_tokens,
    value.cached,
    value.cachedInputTokens,
    value.cached_input_tokens,
    value.reasoning,
    value.reasoningOutputTokens,
    value.reasoning_output_tokens
  ].reduce<number>((total, item) => total + numberValue(item), 0)
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isMissingFile(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT'
}
