import {
  PROMPT_MODES,
  READY_SIGNALS,
  SUBMIT_SIGNALS,
  TRUST_PRESETS,
  type AgentEntry,
  type LaunchCatalog,
  type OneShotSpec,
  type PromptMode,
  type ReadySignal,
  type SubmitSignal,
  type TrustPreset,
  type ModelDiscoverySpec
} from './types'
import { parseLaunchOptions } from './launch-options'
import { parseOneShot } from './one-shot-spec'

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
  'launchOptions',
  'modelDiscovery',
  'windows',
  'oneShot'
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
  const launchCatalog = data.launchOptions === undefined ? null : launchOptions(data.launchOptions)
  const discovery = data.modelDiscovery === undefined ? null : modelDiscovery(id, data.modelDiscovery)
  if (discovery !== null && launchCatalog === null) fail('modelDiscovery requires launchOptions')

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
    homepage: text(data, 'homepage') ?? null,
    install: text(data, 'install') ?? null,
    trust: oneOf<TrustPreset>(data, 'trust', TRUST_PRESETS) ?? null,
    launchOptions: launchCatalog,
    modelDiscovery: discovery,
    oneShot: data.oneShot === undefined ? null : oneShot(data.oneShot)
  }
}

function modelDiscovery(id: string, value: unknown): ModelDiscoverySpec {
  const data = isPlainObject(value) ? value : fail('modelDiscovery must be an object')
  for (const key of Object.keys(data)) {
    if (key !== 'args' && key !== 'timeoutMs' && key !== 'format' && key !== 'protocol') {
      fail(`modelDiscovery has an unknown field ${key}`)
    }
  }
  const timeoutMs = typeof data.timeoutMs === 'number' ? data.timeoutMs : fail('modelDiscovery.timeoutMs must be an integer from 1 to 10000')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    fail('modelDiscovery.timeoutMs must be an integer from 1 to 10000')
  }
  if (data.protocol === 'codex-app-server') {
    if (id !== 'codex') fail('modelDiscovery protocol codex-app-server is only valid for codex')
    if (Object.hasOwn(data, 'args') || Object.hasOwn(data, 'format')) {
      fail('modelDiscovery protocol codex-app-server does not accept args or format')
    }
    return { protocol: 'codex-app-server', timeoutMs }
  }
  if (data.protocol === 'anthropic-models') {
    if (id !== 'claude') fail('modelDiscovery protocol anthropic-models is only valid for claude')
    if (Object.hasOwn(data, 'args') || Object.hasOwn(data, 'format')) {
      fail('modelDiscovery protocol anthropic-models does not accept args or format')
    }
    return { protocol: 'anthropic-models', timeoutMs }
  }
  if (data.protocol === 'gemini-models') {
    if (id !== 'gemini') fail('modelDiscovery protocol gemini-models is only valid for gemini')
    if (Object.hasOwn(data, 'args') || Object.hasOwn(data, 'format')) {
      fail('modelDiscovery protocol gemini-models does not accept args or format')
    }
    return { protocol: 'gemini-models', timeoutMs }
  }
  if (data.protocol === 'pi-rpc') {
    if (id !== 'pi') fail('modelDiscovery protocol pi-rpc is only valid for pi')
    if (Object.hasOwn(data, 'args') || Object.hasOwn(data, 'format')) {
      fail('modelDiscovery protocol pi-rpc does not accept args or format')
    }
    return { protocol: 'pi-rpc', timeoutMs }
  }
  if (data.protocol !== undefined && data.protocol !== 'argv-json') {
    fail('modelDiscovery.protocol must be one of: argv-json, codex-app-server, anthropic-models, gemini-models, pi-rpc')
  }
  const args: unknown[] = Array.isArray(data.args) ? data.args : fail('modelDiscovery.args must be a list of 1 to 32 non-empty arguments of at most 512 characters')
  if (args.length === 0 || args.length > 32) fail('modelDiscovery.args must be a list of 1 to 32 non-empty arguments of at most 512 characters')
  const parsedArgs = args.map((item): string => {
    const argument = typeof item === 'string' ? item : fail('modelDiscovery.args must be a list of 1 to 32 non-empty arguments of at most 512 characters')
    if (argument.trim() === '' || argument.length > 512 || /[\u0000-\u001f\u007f]/.test(argument)) {
      fail('modelDiscovery.args must be a list of 1 to 32 non-empty arguments of at most 512 characters')
    }
    return argument
  })
  const format = data.format === 'json' ? data.format : fail('modelDiscovery.format must be one of: json')
  return { args: parsedArgs, timeoutMs, format, ...(data.protocol === 'argv-json' ? { protocol: 'argv-json' as const } : {}) }
}

function oneShot(value: unknown): OneShotSpec {
  try {
    return parseOneShot(value)
  } catch (error) {
    if (error instanceof Error) return fail(error.message)
    throw error
  }
}

function launchOptions(value: unknown): LaunchCatalog {
  try {
    return parseLaunchOptions(value)
  } catch (error) {
    if (error instanceof Error) return fail(error.message)
    throw error
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
