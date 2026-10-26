import {
  PROMPT_MODES,
  READY_SIGNALS,
  SUBMIT_SIGNALS,
  TRUST_PRESETS,
  type AgentEntry,
  type PromptMode,
  type ReadySignal,
  type SubmitSignal,
  type TrustPreset
} from './types'

export type EntryResult = { ok: true; entry: AgentEntry } | { ok: false; error: string }

const DEFAULT_READY_SIGNAL: ReadySignal = 'render-quiet-after-bracketed-paste'
const DEFAULT_READY_TIMEOUT_MS = 8000
const PLACEHOLDERS = new Set(['{id}', '{transcript}', '{transcriptOrId}'])

const KNOWN_FIELDS = new Set([
  'label',
  'detect',
  'detectAliases',
  'detectRequires',
  'launch',
  'process',
  'env',
  'prompt',
  'promptSeparator',
  'draftFlag',
  'yolo',
  'auto',
  'yoloEnv',
  'stripArgs',
  'resume',
  'fork',
  'resumeStyle',
  'readySignal',
  'submitSignal',
  'readyTimeoutMs',
  'blindPaste',
  'submitRetryMs',
  'lineSettleMs',
  'enterWithPaste',
  'trust',
  'homepage',
  'install',
  'windows'
])

class Invalid extends Error {}

const fail = (message: string): never => {
  throw new Invalid(message)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Checks one `agent` contribution and fills its defaults. `data` is the contribution without its
 * `id`; `id` is the contribution name and `plugin` the plugin whose declaration is in effect.
 * Returns a short sentence naming the first problem, never throws.
 */
export function validateEntry(plugin: string, id: string, data: Record<string, unknown>): EntryResult {
  try {
    return { ok: true, entry: parse(plugin, id, data) }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message }
    throw error
  }
}

function parse(plugin: string, id: string, data: Record<string, unknown>): AgentEntry {
  for (const key of Object.keys(data)) if (!KNOWN_FIELDS.has(key)) fail(`unknown field ${key}`)

  if (data.detect === undefined) fail('detect command is required')
  if (data.label === undefined) fail('label is required')
  if (data.prompt === undefined) fail('prompt mode is required')

  const detect = text(data, 'detect')!
  const label = text(data, 'label')!
  const prompt = oneOf<PromptMode>(data, 'prompt', PROMPT_MODES)!
  const readySignal = oneOf<ReadySignal>(data, 'readySignal', READY_SIGNALS) ?? DEFAULT_READY_SIGNAL
  const resume = template(data, 'resume')
  const fork = template(data, 'fork')
  if (fork && !resume) fail('fork needs resume')
  if (data.windows !== undefined && !isPlainObject(data.windows)) fail('windows must be an object')

  return {
    id,
    plugin,
    label,
    detect,
    detectAliases: textList(data, 'detectAliases') ?? [],
    detectRequires: textList(data, 'detectRequires') ?? [],
    launch: text(data, 'launch') ?? detect,
    process: text(data, 'process') ?? detect,
    env: stringMap(data, 'env') ?? {},
    prompt,
    promptSeparator: literal(data, 'promptSeparator', '--'),
    draftFlag: text(data, 'draftFlag') ?? null,
    yolo: text(data, 'yolo') ?? null,
    auto: text(data, 'auto') ?? null,
    yoloEnv: stringMap(data, 'yoloEnv') ?? null,
    stripArgs: textList(data, 'stripArgs') ?? [],
    resume,
    fork,
    resumeStyle: literal(data, 'resumeStyle', 'claude-splice'),
    readySignal,
    submitSignal: oneOf<SubmitSignal>(data, 'submitSignal', SUBMIT_SIGNALS) ?? readySignal,
    readyTimeoutMs: positiveInteger(data, 'readyTimeoutMs') ?? DEFAULT_READY_TIMEOUT_MS,
    blindPaste: boolean(data, 'blindPaste') ?? true,
    submitRetryMs: positiveInteger(data, 'submitRetryMs') ?? null,
    lineSettleMs: positiveInteger(data, 'lineSettleMs') ?? null,
    enterWithPaste: boolean(data, 'enterWithPaste') ?? false,
    trust: oneOf<TrustPreset>(data, 'trust', TRUST_PRESETS) ?? null,
    homepage: link(data, 'homepage'),
    install: link(data, 'install')
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function text(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (!isText(value)) fail(`${field} must be a non-empty string`)
  return value as string
}

function textList(data: Record<string, unknown>, field: string): string[] | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(isText)) fail(`${field} must be a list of non-empty strings`)
  return [...(value as string[])]
}

function stringMap(data: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (!isPlainObject(value) || !Object.values(value).every((item) => typeof item === 'string')) {
    fail(`${field} must be an object of strings`)
  }
  return { ...(value as Record<string, string>) }
}

function oneOf<T extends string>(data: Record<string, unknown>, field: string, allowed: readonly T[]): T | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function literal<T extends string>(data: Record<string, unknown>, field: string, expected: T): T | null {
  const value = data[field]
  if (value === undefined) return null
  if (value !== expected) fail(`${field} must be "${expected}"`)
  return expected
}

function positiveInteger(data: Record<string, unknown>, field: string): number | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(`${field} must be a positive integer`)
  return value as number
}

function boolean(data: Record<string, unknown>, field: string): boolean | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value as boolean
}

function template(data: Record<string, unknown>, field: string): string[] | null {
  const value = data[field]
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    fail(`${field} must be a non-empty list of strings`)
  }
  for (const item of value as string[]) {
    for (const placeholder of item.match(/\{[^{}]*\}/g) ?? []) {
      if (!PLACEHOLDERS.has(placeholder)) fail(`${field} has an unknown placeholder ${placeholder}`)
    }
  }
  return [...(value as string[])]
}

function link(data: Record<string, unknown>, field: string): string | null {
  const value = data[field]
  if (value === undefined) return null
  if (typeof value !== 'string' || !isWebUrl(value)) fail(`${field} must be an http(s) URL`)
  return value as string
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
