import type { AgentState, Normalized } from '../types'

export type Payload = Record<string, unknown>
type Fields = Normalized['fields']

export function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string at `key`, else undefined. */
export function readString(payload: Payload, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readFirstString(payload: Payload, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(payload, key)
    if (value) return value
  }
  return undefined
}

export function firstDefined(payload: Payload, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key]
  }
  return undefined
}

/**
 * Builds a `Normalized` with the defaults every source shares. Fields set to undefined are
 * dropped so a missing value never overwrites what the row already holds.
 */
export function result(
  eventName: string,
  state: AgentState | null,
  extra: Omit<Partial<Normalized>, 'eventName' | 'state' | 'fields'> & { fields?: Fields } = {},
): Normalized {
  const { fields, ...rest } = extra
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) kept[key] = value
  }
  const flags: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) flags[key] = value
  }
  return { eventName, state, newTurn: false, ...flags, fields: kept as Fields }
}

/** An event that changes no status but tells the caller to drop this session's normalizer memory. */
export function cacheResetResult(eventName: string): Normalized {
  return result(eventName, null, { cacheReset: true })
}

const PROMPT_KEYS = ['prompt', 'user_prompt', 'userPrompt', 'initial_prompt', 'initialPrompt', 'user_message'] as const

function contentBlocksText(blocks: unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block)
    else if (isRecord(block) && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * The prompt a payload carries, trimmed. Plain `message` is status copy for most agents, so it
 * counts only when the caller says this event's message is the prompt.
 */
export function readPrompt(payload: Payload, options: { allowMessage?: boolean } = {}): string | undefined {
  const keys = options.allowMessage ? [...PROMPT_KEYS, 'message'] : PROMPT_KEYS
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (Array.isArray(value) && key !== 'message') {
      const text = contentBlocksText(value)
      if (text.length > 0) return text
    }
  }
  return undefined
}

const COMPACT_CONTINUATION = 'this session is being continued from a previous conversation'
const HARNESS_TURN_PREFIXES = [
  '<system-reminder',
  '<task-notification',
  '<command-name',
  '<command-message',
  '<local-command-',
  '[request interrupted',
  COMPACT_CONTINUATION,
]

/** True for the continuation prompt an agent injects after compaction; it has no matching Stop. */
export function isCompactContinuation(prompt: string | undefined): boolean {
  return prompt !== undefined && prompt.trimStart().toLowerCase().startsWith(COMPACT_CONTINUATION)
}

/** The user's prompt, or undefined when the text is machinery the harness injected as a user turn. */
export function userPrompt(payload: Payload): string | undefined {
  const prompt = readPrompt(payload)
  if (!prompt) return undefined
  const head = prompt.toLowerCase()
  return HARNESS_TURN_PREFIXES.some((prefix) => head.startsWith(prefix)) ? undefined : prompt
}

const INPUT_KEYS = [
  'command',
  'cmd',
  'CommandLine',
  'file_path',
  'filePath',
  'path',
  'TargetFile',
  'AbsolutePath',
  'DirectoryPath',
  'pattern',
  'query',
  'Query',
  'url',
  'Url',
  'code',
  'question',
  'prompt',
  'description',
  'text',
  'target',
  'selector',
  'action',
  'name',
] as const

/** A one-line preview of a tool's input: the string itself, else its most telling string field. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === 'string') return input.length > 0 ? input : undefined
  if (!isRecord(input)) return undefined
  return readFirstString(input, INPUT_KEYS)
}

/** JSON for a tool input that is a question to the user; undefined when it can't be serialized. */
export function questionJson(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  try {
    return JSON.stringify(input)
  } catch {
    return undefined
  }
}

function compactName(toolName: string | undefined): string {
  return (toolName ?? '').replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
}

/** The tool agents use to put a multiple-choice question to the user. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  const name = compactName(toolName)
  return name === 'askuserquestion' || name === 'requestuserinput'
}

/** Droid and Copilot's ask tool, which takes a free-form question. */
export function isAskUserTool(toolName: string | undefined): boolean {
  return compactName(toolName) === 'askuser'
}

/** Text of a tool's result or an assistant reply held in a string, a `{text}` or a content array. */
export function responseText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!isRecord(value)) return undefined
  const direct = readFirstString(value, ['text_result_for_llm', 'textResultForLlm', 'text'])
  if (direct) return direct
  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      if (isRecord(part) && typeof part.text === 'string' && part.text.trim().length > 0) return part.text
    }
  }
  return undefined
}

/**
 * Tool fields for agents that send Claude's `tool_name` / `tool_input` / `tool_use_id`. A tool
 * the agent asks the user through carries its input as the question; the matching result
 * event (`post`) never does, because the question is no longer pending.
 */
export function claudeToolFields(payload: Payload, options: { post?: boolean } = {}): Fields {
  const toolName = readString(payload, 'tool_name')
  const input = payload.tool_input
  return {
    toolName,
    toolInput: summarizeToolInput(input),
    toolUseId: readString(payload, 'tool_use_id'),
    question: !options.post && isAskUserQuestionTool(toolName) ? questionJson(input) : undefined,
  }
}

/** Orca-style snake case, so `UserPromptSubmit`, `user-prompt-submit` and `user_prompt_submit` agree. */
export function snakeCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}
