import type { Normalized, NormalizerCache } from '../types'

type Fields = Normalized['fields']

const PROMPT_MAX = 200
const TOOL_INPUT_MAX = 160
const TOOL_NAME_MAX = 60
const MODEL_MAX = 120
const MESSAGE_MAX = 8000
const QUESTION_MAX = 16000

/** The non-empty string at `key`, or undefined. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) return value
  }
  return undefined
}

/** Folds whitespace runs (newlines included) to single spaces and cuts to `max` characters. */
export function clip(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max) : line
}

/** True for the ask-the-user tool across agents: `AskUserQuestion`, `ask_user_question` and Codex's `request_user_input`. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  const name = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
  return name === 'askuserquestion' || name === 'requestuserinput'
}

// tried in order; the first non-empty string wins, so an object input never turns into JSON text
const TOOL_INPUT_KEYS = [
  'command',
  'cmd',
  'code',
  'query',
  'pattern',
  'url',
  'file_path',
  'filePath',
  'path',
  'target',
  'selector',
  'text',
  'action',
  'name',
  'description',
  'prompt',
  'CommandLine',
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'SearchPath',
  'Query',
  'Url',
  'Prompt'
]

/** A one-line readable summary of a tool's input (`npm test` for Bash), or undefined when it has no string worth showing. */
export function toolInputSummary(input: unknown): string | undefined {
  if (typeof input === 'string') return clip(input, TOOL_INPUT_MAX) || undefined
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const text = firstString(input as Record<string, unknown>, TOOL_INPUT_KEYS)
  return text ? clip(text, TOOL_INPUT_MAX) || undefined : undefined
}

/** The JSON of the question the agent asked, kept whole or dropped when too long to stay valid. */
export function questionJson(toolName: string | undefined, input: unknown): string | undefined {
  if (!isAskUserQuestionTool(toolName) || input === undefined || input === null) return undefined
  try {
    const json = JSON.stringify(input)
    return json !== undefined && json.length <= QUESTION_MAX ? json : undefined
  } catch {
    return undefined
  }
}

const PROMPT_KEYS = ['prompt', 'user_prompt', 'userPrompt', 'initial_prompt', 'initialPrompt', 'user_message', 'message']

function blocksText(blocks: unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block)
    else if (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join(' ')
}

/** The prompt a UserPromptSubmit payload carries (a string or a content-block array), one line, or ''. */
export function promptOf(payload: Record<string, unknown>): string {
  for (const key of PROMPT_KEYS) {
    const value = payload[key]
    const text = typeof value === 'string' ? value : Array.isArray(value) && key !== 'message' ? blocksText(value) : ''
    if (text.trim() !== '') return clip(text, PROMPT_MAX)
  }
  return ''
}

/** What a lead keeps between events so a later tool event doesn't blank the prompt or the last tool. */
export type TurnMemory = {
  prompt: string
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  model?: string
}

/** The memory's text fields, in the shape a `Normalized` carries. */
export function turnFields(memory: TurnMemory): Fields {
  const fields: Fields = {}
  if (memory.prompt) fields.prompt = memory.prompt
  if (memory.toolName) fields.toolName = memory.toolName
  if (memory.toolInput) fields.toolInput = memory.toolInput
  if (memory.lastAssistantMessage) fields.lastAssistantMessage = memory.lastAssistantMessage
  if (memory.model) fields.model = memory.model
  return fields
}

/** A new turn starts with no prompt, tool or message; the model survives. */
export function resetTurn(memory: TurnMemory): void {
  memory.prompt = ''
  memory.toolName = undefined
  memory.toolInput = undefined
  memory.lastAssistantMessage = undefined
}

export function rememberModel(memory: TurnMemory, payload: Record<string, unknown>): void {
  const model = readString(payload, 'model')
  if (model) memory.model = clip(model, MODEL_MAX)
}

export function rememberTool(memory: TurnMemory, toolName: string | undefined, input: unknown): void {
  if (!toolName) return
  memory.toolName = clip(toolName, TOOL_NAME_MAX)
  memory.toolInput = toolInputSummary(input)
}

export function rememberMessage(memory: TurnMemory, message: string | undefined): void {
  if (message) memory.lastAssistantMessage = message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX) : message
}

/** The memory kept in `cache` under `key`, created by `make` on first use. */
export function memoryIn<T>(cache: NormalizerCache, key: string, make: () => T): T {
  let value = cache.get(key) as T | undefined
  if (value === undefined) {
    value = make()
    cache.set(key, value)
  }
  return value
}

const MAX_CHILDREN = 64

/** Adds `id` to a bounded set of live child ids, dropping the oldest when full. */
export function addChild(children: Set<string>, id: string): void {
  children.delete(id)
  children.add(id)
  if (children.size > MAX_CHILDREN) children.delete(children.values().next().value as string)
}
