import type { OneShotArg, OneShotModel, OneShotSpec } from './types'

type Dict = Record<string, unknown>

const ROOT = 'oneShot'
const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g
const KNOWN_PLACEHOLDERS = new Set(['model', 'thinking', 'prompt'])
const CONDITION = /^(model|thinking|thinking=\S+)$/
const DEFAULT_SINGLETON_OPTIONS = [['--model']]

const fail = (path: string, problem: string): never => {
  throw new Error(`${path} ${problem}`)
}

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function dict(value: unknown, path: string, allowed: readonly string[]): Dict {
  if (!isDict(value)) return fail(path, 'must be an object')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `has an unknown field ${key}`)
  return value
}

function text(value: unknown, path: string): string {
  if (!isText(value)) fail(path, 'must be a non-empty string')
  return value as string
}

function list(value: unknown, path: string, empty: boolean): unknown[] {
  if (!Array.isArray(value)) return fail(path, 'must be a list')
  if (!empty && value.length === 0) fail(path, 'must not be empty')
  return value
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

/** The placeholders `token` names; throws for one outside `{model}`, `{thinking}` and `{prompt}`. */
function placeholders(token: string, path: string): string[] {
  const found = [...token.matchAll(PLACEHOLDER)].map((match) => match[1]!)
  const unknown = found.find((name) => !KNOWN_PLACEHOLDERS.has(name))
  if (unknown !== undefined) fail(path, `has an unknown placeholder {${unknown}}`)
  return found
}

type Template = { args: OneShotArg[]; usesPrompt: boolean; usesBareModel: boolean }

function template(value: unknown, path: string): Template {
  const items = list(value, path, false)
  const result: Template = { args: [], usesPrompt: false, usesBareModel: false }
  items.forEach((item, index) => {
    const at = `${path}[${index}]`
    if (typeof item === 'string') {
      if (item === '') fail(at, 'must not be empty')
      for (const name of placeholders(item, at)) {
        if (name === 'thinking') fail(at, 'uses {thinking} outside a thinking group')
        if (name === 'prompt') result.usesPrompt = true
        if (name === 'model') result.usesBareModel = true
      }
      result.args.push(item)
      return
    }
    const group = dict(item, at, ['when', 'args'])
    const when = text(group.when, `${at}.when`)
    if (!CONDITION.test(when)) fail(`${at}.when`, 'must be model, thinking or thinking=<level>')
    const tokens = list(group.args, `${at}.args`, false)
    if (!tokens.every((token) => typeof token === 'string' && token !== '')) fail(`${at}.args`, 'must be a list of non-empty strings')
    for (const token of tokens as string[]) {
      for (const name of placeholders(token, `${at}.args`)) {
        if (name === 'thinking' && !when.startsWith('thinking')) fail(`${at}.args`, 'uses {thinking} outside a thinking group')
        if (name === 'prompt') result.usesPrompt = true
      }
    }
    result.args.push({ when, args: [...(tokens as string[])] })
  })
  return result
}

function models(value: unknown, path: string): OneShotModel[] {
  if (value === undefined) return []
  const seen = new Set<string>()
  return list(value, path, true).map((item, index) => {
    const at = `${path}[${index}]`
    const data = dict(item, at, ['id', 'label', 'thinking'])
    const id = text(data.id, `${at}.id`)
    if (seen.has(id)) fail(`${at}.id`, `duplicates ${id}`)
    seen.add(id)
    return { id, label: text(data.label, `${at}.label`), thinking: data.thinking === undefined ? null : text(data.thinking, `${at}.thinking`) }
  })
}

function singletonOptions(value: unknown, path: string): string[][] {
  if (value === undefined) return DEFAULT_SINGLETON_OPTIONS.map((group) => [...group])
  return list(value, path, true).map((group, index) => {
    const items = list(group, `${path}[${index}]`, false)
    if (!items.every(isText)) fail(`${path}[${index}]`, 'must be a list of non-empty strings')
    return [...(items as string[])]
  })
}

/**
 * Checks an agent's `oneShot` block and fills its defaults, returning a spec that shares nothing
 * with the input. Throws an `Error` whose message starts with `oneShot` and names the first
 * problem; the entry parser rewraps it so the agent is reported invalid.
 */
export function parseOneShot(value: unknown): OneShotSpec {
  const data = dict(value, ROOT, ['args', 'command', 'prompt', 'output', 'singletonOptions', 'models', 'defaultModel', 'background'])
  const argv = template(data.args, `${ROOT}.args`)
  const prompt = oneOf(data.prompt, `${ROOT}.prompt`, ['stdin', 'argv'] as const)
  if (prompt === 'argv' && !argv.usesPrompt) fail(`${ROOT}.args`, 'needs a {prompt} placeholder for argv delivery')
  if (prompt === 'stdin' && argv.usesPrompt) fail(`${ROOT}.args`, 'can only use {prompt} with argv delivery')

  const modelList = models(data.models, `${ROOT}.models`)
  let defaultModel: string | null = modelList[0]?.id ?? null
  if (data.defaultModel !== undefined) {
    defaultModel = text(data.defaultModel, `${ROOT}.defaultModel`)
    if (!modelList.some((model) => model.id === defaultModel)) fail(`${ROOT}.defaultModel`, `names ${defaultModel}, which is not in models`)
  }
  if (argv.usesBareModel && defaultModel === null) fail(`${ROOT}.args`, 'uses {model} but no model is declared')

  return {
    args: argv.args,
    command: data.command === undefined ? null : text(data.command, `${ROOT}.command`),
    prompt,
    output: data.output === undefined ? 'text' : oneOf(data.output, `${ROOT}.output`, ['text', 'opencode-json'] as const),
    singletonOptions: singletonOptions(data.singletonOptions, `${ROOT}.singletonOptions`),
    models: modelList,
    defaultModel,
    background: data.background === undefined ? null : oneOf(data.background, `${ROOT}.background`, ['claude'] as const)
  }
}
