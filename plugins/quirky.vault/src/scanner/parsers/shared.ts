import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { SourceCandidate, VaultSession, VaultMessage, VaultRole } from '../../types'

export const MAX_JSONL_RECORD_BYTES = 10 * 1024 * 1024
export const MAX_MESSAGE_CHARS = 256 * 1024
const PREVIEW_LIMIT = 5

export type ParserContext = {
  candidate: SourceCandidate
  sourceHome: string
  env: Record<string, string | undefined>
  onMessage?: (message: VaultMessage) => void
  capturePrompts?: boolean
  signal?: AbortSignal
}

export type SessionFields = {
  sessionId: string
  title: string | null
  cwd: string | null
  branch: string | null
  model: string | null
  createdAt: number | null
  updatedAt: number | null
  totalTokens: number | null
  queuedMessageCount: number
  subagentTranscriptCount: number
}

export class SessionBuilder {
  readonly fields: SessionFields
  readonly context: ParserContext
  readonly preview: VaultMessage[] = []
  messageCount = 0
  firstUserPrompt: string | undefined
  lastUserPrompt: string | undefined
  firstPromptTitle: string | null = null

  constructor(context: ParserContext, fields: Partial<SessionFields> = {}) {
    this.context = context
    const metadata = context.candidate.metadata ?? {}
    const sessionId = string(fields.sessionId) ?? context.candidate.sessionId ?? basename(context.candidate.filePath).replace(extname(context.candidate.filePath), '')
    this.fields = {
      sessionId,
      title: fields.title ?? string(metadata.title) ?? null,
      cwd: fields.cwd ?? string(metadata.cwd) ?? null,
      branch: fields.branch ?? string(metadata.branch) ?? null,
      model: fields.model ?? string(metadata.model) ?? null,
      createdAt: fields.createdAt ?? numberOrDate(metadata.createdAt),
      updatedAt: fields.updatedAt ?? numberOrDate(metadata.updatedAt),
      totalTokens: fields.totalTokens ?? null,
      queuedMessageCount: fields.queuedMessageCount ?? 0,
      subagentTranscriptCount: fields.subagentTranscriptCount ?? 0
    }
  }

  patch(fields: Partial<SessionFields>): void {
    for (const [key, value] of Object.entries(fields) as [keyof SessionFields, SessionFields[keyof SessionFields]][]) {
      if (value === undefined || value === null || value === '') continue
      if (key === 'totalTokens' && typeof value === 'number') {
        this.fields.totalTokens = (this.fields.totalTokens ?? 0) + value
      } else if (key === 'queuedMessageCount' || key === 'subagentTranscriptCount') {
        this.fields[key] = Number(value) || 0
      } else {
        this.fields[key] = value as never
      }
    }
  }

  message(role: VaultRole, value: unknown, timestamp?: unknown, count = true): void {
    const text = boundedText(value)
    if (count) this.messageCount++
    const time = numberOrDate(timestamp)
    if (time !== null) {
      this.fields.createdAt = this.fields.createdAt === null ? time : Math.min(this.fields.createdAt, time)
      this.fields.updatedAt = this.fields.updatedAt === null ? time : Math.max(this.fields.updatedAt, time)
    }
    if (!text) return
    if (role === 'user') {
      this.firstPromptTitle ??= normalizeTitle(text)
      if (this.context.capturePrompts !== false) {
        this.firstUserPrompt ??= text
        this.lastUserPrompt = text
      }
    }
    this.context.onMessage?.({ role, text, timestamp: time })
    const previewText = normalizePreviewText(text, role)
    if (!previewText) return
    const previewMessage = { role, text: previewText, timestamp: time }
    if (this.preview.length === PREVIEW_LIMIT) this.preview.shift()
    this.preview.push(previewMessage)
  }

  finish(options: { titleFallback?: string | null; subagent?: boolean } = {}): VaultSession {
    const candidate = this.context.candidate
    const title = normalizeTitle(this.fields.title) || normalizeTitle(options.titleFallback) || this.firstPromptTitle || `${candidate.agent} ${this.fields.sessionId.slice(0, 8)}`
    const modifiedAt = Math.round(candidate.mtimeMs)
    const createdAt = this.fields.createdAt ?? modifiedAt
    const updatedAt = this.fields.updatedAt ?? modifiedAt
    return {
      id: '',
      agent: candidate.agent,
      sessionId: this.fields.sessionId,
      title,
      cwd: this.fields.cwd,
      branch: this.fields.branch,
      model: this.fields.model,
      filePath: candidate.filePath,
      codexHome: candidate.codexHome,
      createdAt,
      updatedAt,
      modifiedAt,
      messageCount: this.messageCount,
      totalTokens: this.fields.totalTokens,
      previewMessages: [...this.preview],
      ...(this.firstUserPrompt ? { firstUserPrompt: this.firstUserPrompt } : {}),
      ...(this.lastUserPrompt ? { lastUserPrompt: this.lastUserPrompt } : {}),
      queuedMessageCount: this.fields.queuedMessageCount,
      subagentTranscriptCount: this.fields.subagentTranscriptCount,
      ...(options.subagent ? { subagent: true } : {}),
      presence: 'present'
    }
  }
}

export function createSessionBuilder(context: ParserContext, fields: Partial<SessionFields> = {}): SessionBuilder {
  return new SessionBuilder(context, fields)
}

export async function* readJsonl(path: string, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  throwIfAborted(signal)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!(await handle.stat()).isFile()) {
    await handle.close()
    return
  }
  const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true })
  const chunks: Buffer[] = []
  let size = 0
  let oversized = false
  const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Scan cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for await (const raw of stream) {
      if (signal?.aborted) throw signal.reason ?? new Error('Scan cancelled')
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(start, end)
        if (!oversized) {
          size += part.length
          if (size > MAX_JSONL_RECORD_BYTES) {
            oversized = true
            chunks.length = 0
          } else if (part.length > 0) {
            chunks.push(part)
          }
        }
        if (newline < 0) break
        if (!oversized) {
          let line = Buffer.concat(chunks, size)
          if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
          if (line.length > 0) {
            try {
              const value: unknown = JSON.parse(line.toString('utf8'))
              if (isRecord(value)) yield value
            } catch {
              // A malformed record is isolated from valid records before and after it.
            }
          }
        }
        chunks.length = 0
        size = 0
        oversized = false
        start = newline + 1
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    stream.destroy()
  }
}

export async function readJsonObject(path: string, maxBytes = MAX_JSONL_RECORD_BYTES): Promise<Record<string, unknown> | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) return null
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) return null
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      return isRecord(value) ? value : null
    } catch {
      return null
    }
  } finally {
    await handle.close()
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function numberOrDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function boundedText(value: unknown): string | null {
  let text: string | null = null
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  if (text === null) return null
  if (text.length > MAX_MESSAGE_CHARS) {
    let end = MAX_MESSAGE_CHARS
    const last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end--
    text = text.slice(0, end)
  }
  return text.trim() ? text : null
}

export function normalizeTitle(value: unknown): string | null {
  return normalizeDisplayText(value, 96)
}

export function normalizePreviewText(value: string, _role?: VaultRole): string | null {
  return normalizeDisplayText(value, 220)
}

function normalizeDisplayText(value: unknown, limit: number): string | null {
  const bounded = boundedText(value)
  if (!bounded) return null
  let text = stripHiddenContext(bounded).replace(/\s+/gu, ' ').trim()
  if (!text || isSuppressedContextPrefix(text)) return null
  if (text.length > limit) text = `${safeSlice(text, limit - 3)}...`
  return text
}

function stripHiddenContext(value: string): string {
  let text = value
  for (const [name, closeTag] of [
    ['system-reminder', '</system-reminder>'],
    ['codex_internal_context', '</codex_internal_context>'],
    ['goal_context', '</goal_context>']
  ]) {
    const opening = new RegExp(`<${name}(?=[\\s>])`, 'i')
    for (;;) {
      const match = opening.exec(text)
      if (!match) break
      const openEnd = text.indexOf('>', match.index)
      if (openEnd < 0 || openEnd - match.index > 512) {
        text = text.slice(0, match.index)
        break
      }
      const closeStart = text.toLowerCase().indexOf(closeTag, openEnd + 1)
      if (closeStart < 0 || closeStart - openEnd > MAX_MESSAGE_CHARS) {
        text = text.slice(0, match.index)
        break
      }
      text = `${text.slice(0, match.index)} ${text.slice(closeStart + closeTag.length)}`
    }
  }
  return text
}

function isSuppressedContextPrefix(text: string): boolean {
  const normalized = text.toLowerCase()
  const agentPrefix = '# agents.md instructions'
  if (normalized.startsWith(agentPrefix)) {
    const next = normalized.charCodeAt(agentPrefix.length)
    return Number.isNaN(next) || !/[a-z0-9_]/i.test(String.fromCharCode(next))
  }
  return normalized.startsWith('<instructions>')
}

function safeSlice(value: string, limit: number): string {
  let end = Math.min(value.length, limit)
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return value.slice(0, end)
}

export function textFromContent(value: unknown): string | null {
  if (typeof value === 'string') return boundedText(value)
  if (Array.isArray(value)) {
    const pieces: string[] = []
    let length = 0
    for (const item of value) {
      let text: string | null = typeof item === 'string' ? item : null
      if (isRecord(item)) {
        text = typeof item.text === 'string' ? item.text : typeof item.data === 'string' ? item.data : typeof item.content === 'string' ? item.content : null
      }
      if (!text) continue
      const separator = pieces.length ? 1 : 0
      const available = MAX_MESSAGE_CHARS + 1 - length - separator
      if (available <= 0) break
      const prefix = safeSlice(text, available)
      pieces.push(prefix)
      length += separator + prefix.length
      if (prefix.length < text.length) break
    }
    return boundedText(pieces.join('\n'))
  }
  if (isRecord(value)) return textFromContent(value.text ?? value.content ?? value.parts ?? value.data)
  return null
}

export function stableSessionId(candidate: SourceCandidate, sessionId?: string | null): string {
  return sessionId ?? candidate.sessionId ?? basename(candidate.filePath).replace(extname(candidate.filePath), '')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Scan cancelled')
}
