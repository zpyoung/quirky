import { createReadStream } from 'node:fs'
import { TextDecoder } from 'node:util'
import { isRecord } from './json'

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_PATH_LENGTH = 32_768
const MAX_SESSION_ID_LENGTH = 512
const CONTEXT_WINDOW = 200_000
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

const TOKEN_FIELDS = [
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cacheWrite', 'cache_creation_input_tokens'],
  ['cacheRead', 'cache_read_input_tokens']
] as const

type TokenField = (typeof TOKEN_FIELDS)[number][0]
type TokenUsage = Partial<Record<TokenField, number>>

type AssistantTurn = {
  usage?: TokenUsage
  model?: string
  cwd?: string
  gitBranch?: string
}

export type ClaudeUsageScanResult = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
  turnCount: number
  model?: string
  cwd?: string
  gitBranch?: string
  context?: { used: number; remaining: number; window: number; estimated: true }
}

class TranscriptScanError extends Error {}

function scanError(message: string): TranscriptScanError {
  return new TranscriptScanError(message.slice(0, 500))
}


function validString(value: unknown, maxLength = MAX_LINE_BYTES): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_CHARACTERS.test(value)) return undefined
  return value
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function sumTokens(usage: TokenUsage): number | undefined {
  let total = 0
  let found = false
  for (const [field] of TOKEN_FIELDS) {
    const value = usage[field]
    if (value === undefined) continue
    const next = total + value
    if (!Number.isSafeInteger(next)) return undefined
    total = next
    found = true
  }
  return found ? total : undefined
}

function readUsageUpdate(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage: TokenUsage = {}
  let found = false
  for (const [field, sourceField] of TOKEN_FIELDS) {
    const count = tokenCount(value[sourceField])
    if (count === undefined) continue
    usage[field] = count
    found = true
  }
  return found ? usage : undefined
}

function parseLine(line: Buffer, lineNumber: number): Record<string, unknown> | undefined {
  if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
  if (line.length === 0) return undefined

  let text: string
  try {
    text = UTF8_DECODER.decode(line)
  } catch {
    throw scanError(`Malformed transcript line ${lineNumber}: invalid UTF-8`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw scanError(`Malformed transcript line ${lineNumber}${detail}`)
  }
  if (!isRecord(parsed)) throw scanError(`Malformed transcript line ${lineNumber}: expected a JSON object`)
  return parsed
}

/** Stream a Claude JSONL transcript into bounded, session-correlated assistant usage totals. */
export async function scanClaudeUsage(
  path: string,
  expectedSessionId: string,
  options?: { maxBytes?: number }
): Promise<ClaudeUsageScanResult> {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(path)) {
    throw scanError(`Invalid transcript path: expected a non-empty path no longer than ${MAX_PATH_LENGTH} characters`)
  }
  if (typeof expectedSessionId !== 'string' || expectedSessionId.length === 0 || expectedSessionId.length > MAX_SESSION_ID_LENGTH || CONTROL_CHARACTERS.test(expectedSessionId)) {
    throw scanError(`Invalid Claude provider session ID: expected 1-${MAX_SESSION_ID_LENGTH} characters without controls`)
  }

  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw scanError('Invalid transcript maximum size: maxBytes must be a positive safe integer')
  const maxLineBytes = Math.min(maxBytes, MAX_LINE_BYTES)
  const turns = new Map<string, AssistantTurn>()
  const overflowed = new Set<TokenField>()
  const totals: TokenUsage = {}
  let bytesRead = 0
  let lineNumber = 0
  let lineLength = 0
  let lineParts: Buffer[] = []

  const consumeLine = () => {
    lineNumber += 1
    const line = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineLength)
    lineParts = []
    lineLength = 0
    const entry = parseLine(line, lineNumber)
    if (!entry || entry.sessionId !== expectedSessionId || entry.isSidechain === true || entry.type !== 'assistant') return

    const message = isRecord(entry.message) ? entry.message : undefined
    if (!message || message.role !== 'assistant') return
    const messageId = validString(message.id, MAX_SESSION_ID_LENGTH)
    if (!messageId) return

    let turn = turns.get(messageId)
    if (!turn) {
      turn = {}
      turns.set(messageId, turn)
    }

    const model = validString(message.model)
    const cwd = validString(entry.cwd, MAX_PATH_LENGTH)
    const gitBranch = validString(entry.gitBranch)
    if (model !== undefined) turn.model = model
    if (cwd !== undefined) turn.cwd = cwd
    if (gitBranch !== undefined) turn.gitBranch = gitBranch

    const update = readUsageUpdate(message.usage)
    if (update) {
      turn.usage ??= {}
      for (const [field] of TOKEN_FIELDS) {
        const count = update[field]
        if (count !== undefined) turn.usage[field] = count
      }
    }
  }

  const appendLinePart = (part: Buffer) => {
    if (part.length === 0) return
    if (lineLength + part.length > maxLineBytes) {
      throw scanError(`Transcript line exceeds maximum size of ${maxLineBytes} bytes`)
    }
    lineParts.push(part)
    lineLength += part.length
  }

  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesRead += bytes.length
      if (bytesRead > maxBytes) throw scanError(`Transcript exceeds maximum size of ${maxBytes} bytes`)

      let start = 0
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0x0a) continue
        appendLinePart(bytes.subarray(start, index))
        consumeLine()
        start = index + 1
      }
      appendLinePart(bytes.subarray(start))
    }
  } catch (error) {
    if (error instanceof TranscriptScanError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw scanError(`Unable to read transcript: ${detail}`)
  }

  if (lineParts.length > 0) consumeLine()

  let latestContext: number | undefined
  let latestTurn: AssistantTurn | undefined
  for (const turn of turns.values()) {
    latestTurn = turn
    if (turn.usage) {
      const context = sumTokens(turn.usage)
      if (context !== undefined) latestContext = context
    }
    if (!turn.usage) continue

    for (const [field] of TOKEN_FIELDS) {
      const count = turn.usage[field]
      if (count === undefined || overflowed.has(field)) continue
      const total = (totals[field] ?? 0) + count
      if (!Number.isSafeInteger(total)) {
        delete totals[field]
        overflowed.add(field)
      } else {
        totals[field] = total
      }
    }
  }

  const result: ClaudeUsageScanResult = { turnCount: turns.size }
  for (const [field] of TOKEN_FIELDS) {
    const total = totals[field]
    if (total !== undefined) result[field] = total
  }
  const total = sumTokens(totals)
  if (total !== undefined) result.total = total

  if (latestTurn?.model !== undefined) result.model = latestTurn.model
  if (latestTurn?.cwd !== undefined) result.cwd = latestTurn.cwd
  if (latestTurn?.gitBranch !== undefined) result.gitBranch = latestTurn.gitBranch

  if (latestContext !== undefined) {
    result.context = {
      used: latestContext,
      remaining: Math.max(0, CONTEXT_WINDOW - latestContext),
      window: CONTEXT_WINDOW,
      estimated: true
    }
  }
  return result
}
