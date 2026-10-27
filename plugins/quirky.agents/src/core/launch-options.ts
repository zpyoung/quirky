import type { Conflict, ExtraArgKind, ExtraArgRule, LaunchCatalog, ModelDecl, OptionDecl, OptionUse } from './types'

type Dict = Record<string, unknown>

const ROOT = 'launchOptions'
const VALUE_TOKEN = '{value}'
const RESERVED_OPTION_IDS = new Set(['model', '__proto__', 'constructor', 'prototype'])
const MAX_OPTION_ID_LENGTH = 64
const MAX_MODEL_ID_LENGTH = 128
const EXTRA_ARG_KINDS: readonly ExtraArgKind[] = ['model', 'effort', 'repeatable']
const COMPOSE_MODELS = ['cursor'] as const

const fail = (path: string, problem: string): never => {
  throw new Error(`${path} ${problem}`)
}

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

function dict(value: unknown, path: string, allowed: readonly string[]): Dict {
  if (!isDict(value)) return fail(path, 'must be an object')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `has an unknown field ${key}`)
  return value
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function text(value: unknown, path: string): string {
  if (!isText(value)) fail(path, 'must be a non-empty string')
  return value as string
}

function optionalText(parent: Dict, key: string, path: string): string | null {
  return parent[key] === undefined ? null : text(parent[key], `${path}.${key}`)
}

function list(value: unknown, path: string, empty: boolean): unknown[] {
  if (!Array.isArray(value)) return fail(path, 'must be a list')
  if (!empty && value.length === 0) fail(path, 'must not be empty')
  return value
}

function textList(value: unknown, path: string, empty: boolean): string[] {
  const items = list(value, path, empty)
  if (!items.every(isText)) fail(path, 'must be a list of non-empty strings')
  return [...(items as string[])]
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function template(value: unknown, path: string): string[] {
  const items = list(value, path, false)
  if (!items.every((item) => typeof item === 'string')) fail(path, 'must be a list of strings')
  const tokens = items as string[]
  const occurrences = tokens.reduce((count, token) => count + token.split(VALUE_TOKEN).length - 1, 0)
  if (occurrences !== 1 || tokens.filter((token) => token.includes(VALUE_TOKEN)).length !== 1) {
    fail(path, `must have exactly one item containing ${VALUE_TOKEN}`)
  }
  return [...tokens]
}

function conflicts(value: unknown, path: string): Conflict[] {
  if (value === undefined) return []
  return list(value, path, true).map((item, index) => {
    const at = `${path}[${index}]`
    const data = dict(item, at, ['flags', 'valuePrefix'])
    const conflict: Conflict = { flags: textList(data.flags, `${at}.flags`, false) }
    if (data.valuePrefix !== undefined) conflict.valuePrefix = text(data.valuePrefix, `${at}.valuePrefix`)
    return conflict
  })
}

function unique(seen: Set<string>, id: string, path: string): void {
  if (seen.has(id)) fail(path, `duplicates ${id}`)
  seen.add(id)
}

function option(value: unknown, path: string, composeModel: boolean, seen: Set<string>): OptionDecl {
  const data = dict(value, path, ['id', 'label', 'type', 'choices', 'flag', 'conflicts', 'composed', 'structured'])
  const id = text(data.id, `${path}.id`)
  if (RESERVED_OPTION_IDS.has(id)) fail(`${path}.id`, `can't be ${id}, which is reserved`)
  if (id.length > MAX_OPTION_ID_LENGTH) fail(`${path}.id`, `must be at most ${MAX_OPTION_ID_LENGTH} characters`)
  unique(seen, id, `${path}.id`)

  const label = text(data.label, `${path}.label`)
  const type = oneOf(data.type, `${path}.type`, ['select', 'boolean'] as const)

  let choices: OptionDecl['choices'] = null
  if (type === 'select') {
    const values = new Set<string>()
    choices = list(data.choices, `${path}.choices`, false).map((item, index) => {
      const at = `${path}.choices[${index}]`
      const choice = dict(item, at, ['value', 'label'])
      const value = text(choice.value, `${at}.value`)
      unique(values, value, `${at}.value`)
      return { value, label: text(choice.label, `${at}.label`) }
    })
  } else if (data.choices !== undefined) {
    fail(`${path}.choices`, 'is only for a select option')
  }

  const flag = data.flag === undefined ? null : template(data.flag, `${path}.flag`)
  if (data.composed !== undefined && data.composed !== true) fail(`${path}.composed`, 'must be true when present')
  const composed = data.composed === true
  if (composed && !composeModel) fail(`${path}.composed`, 'needs composeModel')
  const structured = optionalText(data, 'structured', path)
  if (flag === null && !composed && structured === null) fail(path, 'needs a flag, composed or structured')

  return { id, label, type, choices, flag, conflicts: conflicts(data.conflicts, `${path}.conflicts`), composed, structured }
}

function optionUses(value: unknown, path: string, declared: Map<string, OptionDecl>): OptionUse[] {
  const seen = new Set<string>()
  return list(value, path, true).map((item, index) => {
    const at = `${path}[${index}]`
    const data = dict(item, at, ['id', 'choices'])
    const id = text(data.id, `${at}.id`)
    const decl = declared.get(id)
    if (!decl) return fail(`${at}.id`, `names ${id}, which is not a declared option`)
    unique(seen, id, `${at}.id`)
    if (data.choices === undefined) return { id, choices: null }

    if (decl.choices === null) fail(`${at}.choices`, `is only for a select option, and ${id} is a boolean`)
    const picked = textList(data.choices, `${at}.choices`, false)
    const values = decl.choices!.map((choice) => choice.value)
    const outside = picked.find((choice) => !values.includes(choice))
    if (outside !== undefined) fail(`${at}.choices`, `has ${outside}, which ${id} does not declare`)
    return { id, choices: values.filter((choice) => picked.includes(choice)) }
  })
}

function model(value: unknown, path: string, declared: Map<string, OptionDecl>, seen: Set<string>): ModelDecl {
  const data = dict(value, path, ['id', 'label', 'description', 'options'])
  const id = text(data.id, `${path}.id`)
  if (id.length > MAX_MODEL_ID_LENGTH) fail(`${path}.id`, `must be at most ${MAX_MODEL_ID_LENGTH} characters`)
  unique(seen, id, `${path}.id`)
  return {
    id,
    label: text(data.label, `${path}.label`),
    description: optionalText(data, 'description', path),
    options: data.options === undefined ? [] : optionUses(data.options, `${path}.options`, declared)
  }
}

function extraArgs(value: unknown, path: string): NonNullable<LaunchCatalog['extraArgs']> {
  const data = dict(value, path, ['allowed', 'placeholder'])
  const allowed = list(data.allowed, `${path}.allowed`, false).map((item, index): ExtraArgRule => {
    const at = `${path}.allowed[${index}]`
    const rule = dict(item, at, ['kind', 'flags', 'valuePrefix'])
    const parsed: ExtraArgRule = {
      kind: oneOf(rule.kind, `${at}.kind`, EXTRA_ARG_KINDS),
      flags: textList(rule.flags, `${at}.flags`, false)
    }
    if (rule.valuePrefix !== undefined) parsed.valuePrefix = text(rule.valuePrefix, `${at}.valuePrefix`)
    return parsed
  })
  if (typeof data.placeholder !== 'string') fail(`${path}.placeholder`, 'must be a string')
  return { allowed, placeholder: data.placeholder as string }
}

/**
 * Checks an agent's `launchOptions` block and fills its defaults, returning a catalog that shares
 * nothing with the input. Throws an `Error` whose message starts with `launchOptions` and names
 * the first problem; the entry parser rewraps it so the agent is reported invalid.
 */
export function parseLaunchOptions(value: unknown): LaunchCatalog {
  const data = dict(value, ROOT, ['model', 'options', 'models', 'unlisted', 'unlistedOptions', 'composeModel', 'valueFlags', 'extraArgs'])

  const modelData = dict(data.model, `${ROOT}.model`, ['flag', 'conflicts', 'structured'])
  const modelPath = `${ROOT}.model`
  const modelDecl: LaunchCatalog['model'] = {
    flag: template(modelData.flag, `${modelPath}.flag`),
    conflicts: conflicts(modelData.conflicts, `${modelPath}.conflicts`),
    structured: optionalText(modelData, 'structured', modelPath)
  }

  const composeModel = data.composeModel === undefined ? null : oneOf(data.composeModel, `${ROOT}.composeModel`, COMPOSE_MODELS)

  const optionIds = new Set<string>()
  const options = (data.options === undefined ? [] : list(data.options, `${ROOT}.options`, true)).map((item, index) =>
    option(item, `${ROOT}.options[${index}]`, composeModel !== null, optionIds)
  )
  const declared = new Map(options.map((decl) => [decl.id, decl]))

  const modelIds = new Set<string>()
  const models = (data.models === undefined ? [] : list(data.models, `${ROOT}.models`, true)).map((item, index) =>
    model(item, `${ROOT}.models[${index}]`, declared, modelIds)
  )

  const unlisted =
    data.unlisted === undefined
      ? models.length === 0
        ? 'accept'
        : 'refuse'
      : oneOf(data.unlisted, `${ROOT}.unlisted`, ['accept', 'refuse'] as const)
  const unlistedOptions = data.unlistedOptions === undefined ? [] : optionUses(data.unlistedOptions, `${ROOT}.unlistedOptions`, declared)
  if (unlistedOptions.length > 0 && unlisted === 'refuse') fail(`${ROOT}.unlistedOptions`, 'need unlisted "accept"')

  return {
    model: modelDecl,
    options,
    models,
    unlisted,
    unlistedOptions,
    composeModel,
    valueFlags: data.valueFlags === undefined ? [] : textList(data.valueFlags, `${ROOT}.valueFlags`, true),
    extraArgs: data.extraArgs === undefined ? null : extraArgs(data.extraArgs, `${ROOT}.extraArgs`)
  }
}
